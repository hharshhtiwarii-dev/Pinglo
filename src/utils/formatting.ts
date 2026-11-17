/**
 * Text formatting — WhatsApp-style markup (Messaging Group, Worker M1).
 *
 * Markup (stored in the message text itself, exactly like WhatsApp, so
 * old clients / exports / search keep working — no schema change):
 *   *bold*            -> bold
 *   _italic_          -> italic
 *   ~strikethrough~   -> strikethrough
 *   ```monospace```   -> monospace (triple backtick)
 *
 * Rules (WhatsApp-compatible):
 * - A marker pair only formats when the content between the markers is
 *   non-empty and touches the markers (`* bold *` stays literal, `**`
 *   stays literal). A single-char span may not cross a line break
 *   (WhatsApp keeps styled spans on one line); a monospace block may.
 * - The opening marker must sit at the start of the text or right after
 *   a char that is not a letter, digit or `/`. This keeps
 *   `hello_world`, `a*b`, `file~name`, `2*3*4` and markers inside URL
 *   paths (`https://x.com/a/*b*`) literal. Anything else — whitespace,
 *   punctuation, emoji, another marker — may precede an opener.
 * - The closing marker needs no following context: WhatsApp honours a
 *   pair that opens and closes cleanly, so `*re*action` bolds `re` and
 *   `*bold*_italic_*` formats both spans.
 * - Pairs nest in mirrored order, like WhatsApp: `*_both_*` is bold +
 *   italic, `~*both*~` is strike + bold. A nested pair that never
 *   closes leaves its markers literal; a valid pair still formats even
 *   when an enclosing pair never closes (e.g. the italic in
 *   `*a _b* c_` still renders).
 * - Monospace wins over everything inside it: content between triple
 *   backticks is never parsed for bold/italic/strike. A monospace span
 *   inside a bold span renders bold + mono.
 * - Inside its own span, a marker char is always the closing marker
 *   (or literal text when the close is invalid, e.g. trailing space),
 *   never a nested opener of the same kind.
 * - Unmatched markers are left as literal text — nothing is ever lost.
 *
 * Rendering is React-safe: the parser returns plain data, never HTML, so
 * FormattedText never needs dangerouslySetInnerHTML.
 */

export type FormatKind = 'bold' | 'italic' | 'strike' | 'mono';

export type SegmentType = 'plain' | FormatKind;

export interface TextSegment {
  type: SegmentType;
  text: string;
  /**
   * Every format applying to this span, outermost first. Plain spans
   * have []. Nested markup combines: `*_both_*` -> type 'bold',
   * formats ['bold', 'italic']. Renderers style from `formats`
   * (falling back to [type]) so nested spans render fully.
   */
  formats?: FormatKind[];
}

/** Opening/closing marker per format kind. */
export const FORMAT_MARKERS: Record<FormatKind, string> = {
  bold: '*',
  italic: '_',
  strike: '~',
  mono: '```',
};

/**
 * A marker may open a span when it sits at the start of the text or
 * right after a char that is not a letter, digit or `/`. Letters/digits
 * keep `hello_world`, `a*b`, `file~name`, `2*3*4` literal; `/` keeps
 * markers inside URL paths (`https://x.com/a/*b*`) literal. Whitespace,
 * punctuation, emoji and other markers may precede an opener — which is
 * what lets nested pairs (`*_both_*`) and adjacent pairs
 * (`*a*_b_*`) open. `\p{L}` / `\p{N}` cover non-ASCII letters/digits
 * too (e.g. `café*bold*` stays literal).
 */
const OPEN_BEFORE = /[^\p{L}\p{N}/]/u;

/** Single-char marker -> kind. Backtick is handled by the mono branch. */
const SINGLE_MARKERS: Record<string, FormatKind> = {
  '*': 'bold',
  '_': 'italic',
  '~': 'strike',
};

/** A parsed segment plus the offsets of its content in the source text. */
interface ParsedSegment {
  type: SegmentType;
  text: string;
  formats: FormatKind[];
  /** Start offset of the content (markers excluded). */
  start: number;
  /** End offset of the content (markers excluded). */
  end: number;
}

function canOpenAt(text: string, i: number): boolean {
  return i === 0 || OPEN_BEFORE.test(text[i - 1]);
}

/**
 * Parse `text[start..]` until the end of the string or the `stopMarker`
 * that closes the enclosing span (`null` at the top level). `formats`
 * is the set of formats already active from enclosing spans, and
 * `contentStart` is where this span's content begins (used to validate
 * a closing marker: the marks must touch the words).
 *
 * A nested span that never closes is discarded and its opener treated
 * as literal text; scanning then resumes just after the opener, so a
 * valid pair further along still formats. Worst case is O(n^2) on
 * pathological runs of unmatched openers, bounded in practice by the
 * 5,000-char message limit and a max nesting depth of 3 kinds.
 *
 * Performance note: without help, runs of unmatched openers (e.g.
 * `*a *a *a ...`) backtrack exponentially — every opener speculatively
 * re-parses the rest of the string. Two guards keep this linear-ish:
 * failed parses are memoised per (start, stopMarker) — whether a span
 * closes depends only on the text, never on the enclosing formats —
 * and nesting depth is capped (genuine nesting is at most 3 kinds, so
 * deeper attempts are treated as literal text instead of recursing).
 * `memo` records (start, stopMarker) pairs already proven unclosable;
 * `depth` counts speculative nesting.
 */
const MAX_NESTING_DEPTH = 64;

function parseRange(
  text: string,
  start: number,
  stopMarker: string | null,
  contentStart: number,
  formats: FormatKind[],
  memo: Map<string, true>,
  depth: number,
): { segments: ParsedSegment[]; end: number; closed: boolean } {
  // Already proven unclosable from here with this stop marker: the
  // caller discards unclosed results, so empty segments are enough.
  const memoKey = `${start}|${stopMarker ?? ''}`;
  if (memo.has(memoKey)) {
    return { segments: [], end: text.length, closed: false };
  }
  const segments: ParsedSegment[] = [];
  let plainStart = start;
  let i = start;

  const flushPlain = (upto: number) => {
    if (upto > plainStart) {
      segments.push({
        type: formats.length > 0 ? formats[0] : 'plain',
        text: text.slice(plainStart, upto),
        formats: [...formats],
        start: plainStart,
        end: upto,
      });
    }
  };

  while (i < text.length) {
    // 1. The stop marker closes this span — but only when the marks
    // touch the words: non-empty content, no edge whitespace, and no
    // line break inside a single-char span. Otherwise the marker is
    // literal text and scanning continues (a later marker may close).
    if (stopMarker !== null && text.startsWith(stopMarker, i)) {
      const content = text.slice(contentStart, i);
      if (
        content.length > 0 &&
        !/^\s/.test(content) &&
        !/\s$/.test(content) &&
        !/[\r\n]/.test(content)
      ) {
        flushPlain(i);
        return { segments, end: i + stopMarker.length, closed: true };
      }
    }

    // 2. Monospace — its content is literal, never re-parsed. If the
    // first closing ``` fails (empty / edge whitespace), try later
    // ones; with no valid close the backticks stay literal. Unlike
    // single-char spans, a monospace block may cross line breaks.
    if (text.startsWith('```', i) && canOpenAt(text, i)) {
      let close = text.indexOf('```', i + 3);
      let done = false;
      while (close !== -1) {
        const inner = text.slice(i + 3, close);
        if (inner.length > 0 && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          flushPlain(i);
          segments.push({
            // type is the outermost format, like everywhere else:
            // mono inside bold is type 'bold' with formats ['bold','mono'].
            type: formats.length > 0 ? formats[0] : 'mono',
            text: inner,
            formats: [...formats, 'mono'],
            start: i + 3,
            end: close,
          });
          i = close + 3;
          plainStart = i;
          done = true;
          break;
        }
        close = text.indexOf('```', close + 1);
      }
      if (done) continue;
    }

    // 3. Single-char markers: try a nested span of another kind. The
    // same kind can never nest — inside a bold span, `*` is always the
    // closing marker (handled by step 1 above). Past the depth cap the
    // opener is literal text instead of another speculative recursion.
    const ch = text[i];
    const kind = SINGLE_MARKERS[ch];
    if (kind && canOpenAt(text, i) && depth < MAX_NESTING_DEPTH) {
      const nextFormats = formats.includes(kind) ? formats : [...formats, kind];
      const inner = parseRange(text, i + 1, ch, i + 1, nextFormats, memo, depth + 1);
      if (inner.closed) {
        flushPlain(i);
        segments.push(...inner.segments);
        i = inner.end;
        plainStart = i;
        continue;
      }
      // Unclosed: the opener is literal; keep scanning from just
      // after it (its inner content is re-scanned by this loop).
    }

    i += 1;
  }
  flushPlain(text.length);
  memo.set(memoKey, true);
  return { segments, end: text.length, closed: false };
}

/**
 * Merge adjacent segments carrying the same formats. Adjacent equal
 * segments only arise where nested markers were consumed (e.g.
 * `*a**b*` -> bold "ab"), so merging never joins two unrelated spans.
 * Offsets stay in source-text coordinates (gaps are consumed markers),
 * which is what isSelectionFormatted relies on.
 */
function mergeAdjacent(segments: ParsedSegment[]): ParsedSegment[] {
  const merged: ParsedSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.formats.length === seg.formats.length &&
      last.formats.every((f, idx) => f === seg.formats[idx])
    ) {
      last.text += seg.text;
      last.end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/** Full parse with offsets; shared by parseFormattedText and isSelectionFormatted. */
function parseInternal(text: string): ParsedSegment[] {
  if (text.length === 0) return [];
  return mergeAdjacent(parseRange(text, 0, null, 0, [], new Map(), 0).segments);
}

/**
 * Parse WhatsApp-style markup into segments. Adjacent plain runs are
 * merged, so `parseFormattedText('hi')` returns exactly one segment.
 * Empty input returns [].
 */
export function parseFormattedText(text: string): TextSegment[] {
  return parseInternal(text).map(({ type, text: t, formats }) => ({
    type,
    text: t,
    formats: [...formats],
  }));
}

/** Plain text back — strips every formatting marker, keeps the words. */
export function stripFormatting(text: string): string {
  return parseFormattedText(text)
    .map((s) => s.text)
    .join('');
}

/** True when the text contains at least one formatted span. */
export function hasFormatting(text: string): boolean {
  return parseFormattedText(text).some((s) => s.type !== 'plain');
}

export interface ApplyFormatResult {
  /** The new full text. */
  text: string;
  /** Caret/selection to restore in the textarea after the change. */
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Toggle a format on the given selection — the pure helper behind
 * FormatToolbar. `start`/`end` are the textarea's selectionStart/End
 * (a reversed pair is normalised).
 *
 * - No selection: inserts an empty marker pair (`**`) and puts the caret
 *   between the markers, so the user types inside the format.
 * - Selection: wraps it (`hello` -> `*hello*`). If the selection is
 *   already wrapped (markers directly outside it, or the selection
 *   itself starts+ends with the markers), the markers are removed
 *   instead — tapping B twice toggles bold off.
 * - The returned selection always covers the (un)wrapped text, so the
 *   toolbar button's active state stays in sync.
 */
export function applyFormat(
  text: string,
  start: number,
  end: number,
  kind: FormatKind,
): ApplyFormatResult {
  const marker = FORMAT_MARKERS[kind];
  const mLen = marker.length;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const s = Math.max(0, Math.min(lo, text.length));
  const e = Math.max(s, Math.min(hi, text.length));

  // Empty selection -> insert a pair and park the caret inside it.
  if (s === e) {
    const next = text.slice(0, s) + marker + marker + text.slice(s);
    return { text: next, selectionStart: s + mLen, selectionEnd: s + mLen };
  }

  // Already wrapped from the outside?  *|hello|*  ->  hello
  if (s >= mLen && e + mLen <= text.length &&
      text.slice(s - mLen, s) === marker &&
      text.slice(e, e + mLen) === marker) {
    const next = text.slice(0, s - mLen) + text.slice(s, e) + text.slice(e + mLen);
    return { text: next, selectionStart: s - mLen, selectionEnd: e - mLen };
  }

  // Selection itself carries the markers?  |*hello*|  ->  hello
  const selected = text.slice(s, e);
  if (selected.startsWith(marker) && selected.endsWith(marker) &&
      selected.length >= mLen * 2) {
    const inner = selected.slice(mLen, selected.length - mLen);
    const next = text.slice(0, s) + inner + text.slice(e);
    return { text: next, selectionStart: s, selectionEnd: s + inner.length };
  }

  // Otherwise wrap the selection.
  const next = text.slice(0, s) + marker + selected + marker + text.slice(e);
  return { text: next, selectionStart: s + mLen, selectionEnd: e + mLen };
}

/**
 * Is the given selection currently formatted with `kind`? Used by
 * FormatToolbar to highlight the active B / I / S / Mono button.
 * True when the selection (or caret) lies inside a parsed span of that
 * kind — including a caret in the middle of `*hello*` or a partial
 * selection inside it — or when markers sit directly around it
 * (covers a selection that includes the markers, and a caret parked
 * between an empty pair such as `**`).
 */
export function isSelectionFormatted(
  text: string,
  start: number,
  end: number,
  kind: FormatKind,
): boolean {
  const marker = FORMAT_MARKERS[kind];
  const mLen = marker.length;
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const s = Math.max(0, Math.min(lo, text.length));
  const e = Math.max(s, Math.min(hi, text.length));

  // Selection (or caret) inside a parsed span of this kind.
  const insideSpan = parseInternal(text).some(
    (seg) =>
      seg.formats.includes(kind) &&
      (s === e
        ? seg.start <= s && s <= seg.end
        : seg.start <= s && e <= seg.end),
  );
  if (insideSpan) return true;

  if (s === e) {
    // Caret inside an existing pair counts as active.
    return (
      s >= mLen &&
      e + mLen <= text.length &&
      text.slice(s - mLen, s) === marker &&
      text.slice(e, e + mLen) === marker
    );
  }
  const outsideWrapped =
    s >= mLen &&
    e + mLen <= text.length &&
    text.slice(s - mLen, s) === marker &&
    text.slice(e, e + mLen) === marker;
  const selected = text.slice(s, e);
  const insideWrapped =
    selected.startsWith(marker) &&
    selected.endsWith(marker) &&
    selected.length >= mLen * 2;
  return outsideWrapped || insideWrapped;
}
