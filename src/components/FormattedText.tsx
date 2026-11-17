/**
 * FormattedText — renders WhatsApp-style markup as styled React spans
 * (Messaging Group, Worker M1).
 *
 * Parses the text with `parseFormattedText` (src/utils/formatting.ts) and
 * renders each segment with Tailwind classes. React-safe: the parser
 * returns plain data, never HTML, so no dangerouslySetInnerHTML.
 *
 * Nested formats combine: `*_both_*` parses to one segment with
 * formats ['bold', 'italic'], and the classes for both are applied.
 *
 * Deliberately does NOT handle links / @mentions / #hashtags — those stay
 * with ChatScreen's `renderRichText`, which calls this component for its
 * plain parts (see PATCH.md integration snippet). That keeps one owner
 * per concern and avoids double-parsing URLs.
 */

import React, { memo, useMemo } from 'react';
import { parseFormattedText, type FormatKind, type TextSegment } from '../utils/formatting';

interface FormattedTextProps {
  /** Raw message text, markup included (e.g. `*bold* and _italic_`). */
  text: string;
  /** Extra classes on the wrapping span. */
  className?: string;
}

/** Tailwind classes per format kind. Mono keeps WhatsApp's code look. */
const SEGMENT_CLASS: Record<FormatKind, string> = {
  bold: 'font-bold',
  italic: 'italic',
  strike: 'line-through',
  mono: 'font-mono text-[13px] bg-black/10 dark:bg-white/15 rounded px-1 py-px break-all',
};

/**
 * All classes for a segment: its combined `formats` when present
 * (nested spans), otherwise its single type. Plain segments get none.
 */
function classFor(seg: TextSegment): string {
  const kinds =
    seg.formats && seg.formats.length > 0
      ? seg.formats
      : seg.type === 'plain'
        ? []
        : [seg.type as FormatKind];
  return kinds.map((k) => SEGMENT_CLASS[k]).join(' ');
}

// Typing-freeze fix (Report 3 #20): memoized — the bubble list used to
// re-parse EVERY bubble's markup on every keystroke (parseFormattedText
// ran in render, per bubble, per keystroke). Props are plain strings, so
// memo + a memoized parse make a re-rendered bubble nearly free.
function FormattedTextInner({ text, className }: FormattedTextProps) {
  const segments = useMemo(() => (text ? parseFormattedText(text) : []), [text]);
  if (!text) return null;
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.type === 'plain' ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className={classFor(seg)}>
            {seg.text}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * WA parity (media audit §1a E5): a message that is ONLY 1–3 emoji renders
 * large in the bubble, like WhatsApp. Returns the Tailwind text-size class
 * (or null when the text is not emoji-only). Markup, links and mixed text
 * never qualify; variation selectors / ZWJ sequences count as one emoji.
 */
export function emojiOnlySize(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;
  // Grapheme clusters (Intl.Segmenter when available) so ZWJ sequences
  // (👩‍⚕️) and VS16 hearts (❤️) count as ONE emoji, not several glyphs.
  let glyphs: string[];
  try {
    const seg = new (Intl as any).Segmenter('en', { granularity: 'grapheme' });
    glyphs = Array.from(seg.segment(t), (s: any) => s.segment);
  } catch {
    glyphs = Array.from(t);
  }
  if (glyphs.length < 1 || glyphs.length > 3) return null;
  // Every cluster must be (or contain) an emoji pictograph; plain letters,
  // digits and punctuation disqualify the message.
  const ok = glyphs.every((g) => /\p{Extended_Pictographic}/u.test(g));
  if (!ok) return null;
  return glyphs.length === 1 ? 'text-[40px] leading-[1.15]' : glyphs.length === 2 ? 'text-[32px] leading-[1.15]' : 'text-[28px] leading-[1.2]';
}

export function isEmojiOnly(text: string): boolean {
  return emojiOnlySize(text) !== null;
}

const FormattedText = memo(FormattedTextInner);
export default FormattedText;
