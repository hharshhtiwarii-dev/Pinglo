/**
 * Text-to-emoji replacement for sent messages (WhatsApp "Replace text
 * with emoji"). `applyTextEmojiReplacements` converts emoticons like :)
 * and <3 to emoji at send time, only when the user has the "Replace text
 * with emoji" toggle on in Settings > Chats; `replaceEmoticonBeforeCursor`
 * does the same conversion live, as you type, in the composer (WA: "Emoji
 * will replace specific text as you type").
 *
 * NOTE (2026-11-14, user order): the typing-suggestions strip above the
 * keyboard (word completions + related emojis while typing, `getSuggestions`)
 * was REMOVED entirely — the user asked for it to be gone. This file holds
 * the emoticon replacement only (live as-you-type + send-time safety net).
 * @mention and the emoji picker are untouched.
 */

/** :) :-) :D ;) :P :( :'( <3 and friends -> emoji (WhatsApp "Replace text with emoji").
 *  WA parity (media verify E6): the bare ":)" — the most common emoticon,
 *  promised in the Settings copy — was missing from this map (only ":-)"
 *  was here), as were the dashed ":-(", ";-)", ":-D", ":-P" variants, so
 *  typing ":)" sent literally. Both bare and dashed forms are covered now. */
const EMOTICON_MAP: [RegExp, string][] = [
  [/:-\)/g, '🙂'],
  [/:\)/g, '🙂'],
  [/;\)/g, '😉'],
  [/;-\)/g, '😉'],
  [/:D/g, '😃'],
  [/:-D/g, '😃'],
  [/:P/g, '😛'],
  [/:p/g, '😛'],
  [/:-P/g, '😛'],
  [/:-p/g, '😛'],
  [/:'\(/g, '😢'],
  [/:'-\(/g, '😢'],
  [/:\(/g, '🙁'],
  [/:-\(/g, '🙁'],
  [/:\|/g, '😐'],
  [/:-\|/g, '😐'],
  [/:\*/g, '😘'],
  [/:-[*]/g, '😘'],
  [/:\$|\$:/g, '🤑'],
  [/&lt;3/g, '❤️'],
  [/<3/g, '❤️'],
  [/:-O/g, '😮'],
  [/:O/g, '😮'],
  [/XD/g, '😆'],
  [/:\]/g, '🙂'],
  [/:\[/g, '🙁'],
];

export function applyTextEmojiReplacements(text: string): string {
  let out = text;
  for (const [re, emoji] of EMOTICON_MAP) out = out.replace(re, emoji);
  return out;
}

// ── Live replacement (WA parity E6: "Emoji will replace specific text
//    as you type") ────────────────────────────────────────────────────────
// WhatsApp converts the emoticon in the composer the moment its last
// character is typed; DT only converted at send time, so ":)" sat in the
// input as literal text until Send. The composer calls this on every
// keystroke with the caret position: when an emoticon ends exactly at
// the caret it is swapped for the emoji in place (caret moved past it).
// Pasted / mid-text emoticons are left for the send-time pass above.
const EMOTICON_SUFFIXES: [RegExp, string][] = EMOTICON_MAP.map(
  // Non-capturing group: the `$` must anchor the WHOLE pattern, not just
  // the last alternative (the ":$|$:" entry would otherwise match ":$"
  // anywhere before the caret).
  ([re, emoji]) => [new RegExp(`(?:${re.source})$`), emoji],
);

export function replaceEmoticonBeforeCursor(
  text: string,
  cursor: number,
): { text: string; cursor: number } | null {
  const before = text.slice(0, cursor);
  for (const [re, emoji] of EMOTICON_SUFFIXES) {
    const m = before.match(re);
    if (m && m.index !== undefined) {
      return {
        text: before.slice(0, m.index) + emoji + text.slice(cursor),
        cursor: m.index + emoji.length,
      };
    }
  }
  return null;
}
