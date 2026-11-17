import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { EMOJI_KEYWORDS } from './emojiKeywords';

/**
 * Full emoji picker (Theme fix, 2026-11-13).
 *
 * WhatsApp-style: categories with tabs, search across all emojis, and a
 * Recents row (localStorage). Replaces the old 30-emoji strip in ChatScreen.
 * Tapping an emoji inserts it and keeps the picker open (like WhatsApp);
 * the close button or the emoji button dismisses it.
 */

const RECENTS_KEY = 'dt_emoji_recents';
const MAX_RECENTS = 24;

// WA parity (media verify E1): WhatsApp's picker tabs are icons, not text
// labels. Pills keep the text (accessible + unambiguous) with the category
// icon in front, matching WA's icon-tab look.
export const CATEGORY_ICONS: Record<string, string> = {
  Smileys: '😀',
  Gestures: '👋',
  People: '👩',
  Animals: '🐶',
  Food: '🍕',
  Activities: '⚽',
  Travel: '✈️',
  Objects: '💡',
  Symbols: '🔣',
  Flags: '🏳️',
};

// ── WA parity (media audit §1a E4): skin-tone picker ────────────────────────
// WhatsApp has a dedicated multi-skin-tone picker; DT shipped hand/people
// emoji in default yellow only. Tones are Fitzpatrick modifiers applied to
// the first person/hand code point of a toneable emoji (ZWJ sequences keep
// working: 👩‍⚕️ + 🏽 → 👩🏽‍⚕️). The choice persists in localStorage next to
// recents and is applied to every toneable emoji the picker shows/picks.
export const SKIN_TONE_KEY = 'dt_emoji_skin_tone';
export const SKIN_TONES: { id: string; modifier: string; label: string }[] = [
  { id: 'default', modifier: '', label: 'Default (yellow)' },
  { id: 'light', modifier: '🏻', label: 'Light skin tone' },
  { id: 'medium-light', modifier: '🏼', label: 'Medium-light skin tone' },
  { id: 'medium', modifier: '🏽', label: 'Medium skin tone' },
  { id: 'medium-dark', modifier: '🏾', label: 'Medium-dark skin tone' },
  { id: 'dark', modifier: '🏿', label: 'Dark skin tone' },
];

export function loadSkinTone(): string {
  try {
    const v = localStorage.getItem(SKIN_TONE_KEY) || '';
    return SKIN_TONES.some((t) => t.modifier === v) ? v : '';
  } catch {
    return '';
  }
}

export function saveSkinTone(modifier: string): void {
  try {
    localStorage.setItem(SKIN_TONE_KEY, modifier);
  } catch { /* intentionally ignored */ }
}

/** Emoji that take no skin tone (eyes, mouth, brain, blood, …). Everything
 *  else in the Gestures / People categories is toneable. */
const NO_TONE = new Set(['👀', '👁️', '👅', '👄', '💋', '🩸', '🧠', '🫀', '🫁', '🦷', '🦴']);

export function isToneableEmoji(e: string): boolean {
  if (NO_TONE.has(e)) return false;
  return EMOJI_CATEGORIES.slice(1, 3).some((c) => c.emojis.includes(e));
}

const TONE_MODIFIERS = ['🏻', '🏼', '🏽', '🏾', '🏿'];

/** Apply a Fitzpatrick modifier to a toneable emoji; non-toneable emoji
 *  and emoji that already carry a tone pass through unchanged. */
export function applySkinTone(e: string, modifier: string): string {
  if (!modifier || !isToneableEmoji(e)) return e;
  const first = e.split('\u200d')[0].replace(/\uFE0F/g, '');
  if (TONE_MODIFIERS.some((m) => first.includes(m))) return e;
  const tonedFirst = `${first}${modifier}`;
  return e.replace(/^[^\u200d]+/, tonedFirst);
}

export const EMOJI_CATEGORIES: { name: string; emojis: string[] }[] = [
  {
    name: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '🥹', '🥲', '😢', '😭', '😤', '😡', '😠', '🤬', '🤯', '😳', '🥵', '🥶', '🫠', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🫢', '🫣', '🤫', '🤥', '😶', '🫥', '😐', '🫤', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '🫡', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾'],
  },
  {
    name: 'Gestures',
    emojis: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🫰', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '👏', '🙌', '👐', '🤲', '🫶', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄', '💋', '🩸'],
  },
  {
    name: 'People',
    emojis: ['👶', '👧', '🧒', '👦', '👩', '🧑', '👨', '👩‍🦱', '👨‍🦱', '👩‍🦰', '👨‍🦰', '👱‍♀️', '👱', '👩‍🦳', '👨‍🦳', '🧔', '👵', '👴', '👲', '👳‍♀️', '👳', '👮‍♀️', '👮', '👷‍♀️', '👷', '💂', '🕵️', '👩‍⚕️', '👨‍⚕️', '👩‍🌾', '👨‍🌾', '👩‍🍳', '👨‍🍳', '👩‍🎓', '👨‍🎓', '👩‍🎤', '👨‍🎤', '👩‍🏫', '👨‍🏫', '👩‍💻', '👨‍💻', '👩‍💼', '👨‍💼', '👩‍🔧', '👨‍🔧', '👩‍🔬', '👨‍🔬', '👩‍🎨', '👨‍🎨', '👩‍🚀', '👨‍🚀', '👩‍🚒', '👨‍🚒', '💃', '🕺', '🧖', '🧗', '🤺', '🏇', '⛷️', '🏂', '🏌️', '🏄', '🚣', '🚵', '🤽', '🏊', '⛹️', '🏋️', '🚴', '🤸', '🤼', '🤾', '🤹', '🧘'],
  },
  {
    name: 'Animals',
    emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🦝', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🦟', '🦗', '🕷️', '🐢', '🐍', '🦎', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐈', '🐈‍⬛', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇'],
  },
  {
    name: 'Food',
    emojis: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯', '🥛', '🍼', '☕', '🫖', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🥃', '🍸', '🍹', '🧉', '🍾'],
  },
  {
    name: 'Activities',
    emojis: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '🤺', '🏇', '🧘', '🎪', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎲', '♠️', '♥️', '♦️', '♣️', '♟️', '🧩', '🎯', '🎳', '🎮', '🕹️', '🎰', '🧸', '🎁', '🎀', '🪄', '🪅', '🎊', '🎉', '🎈'],
  },
  {
    name: 'Travel',
    emojis: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🪝', '⛽', '🚧', '🚦', '🚥', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛️', '⛪', '🕌', '🛕', '🕍', '⛩️', '🕋'],
  },
  {
    name: 'Objects',
    emojis: ['⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🪝', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈', '⚗️', '🔭', '🔬', '🕳️', '💊', '💉', '🩸', '🩹', '🩺', '🧬', '🦠', '🧫', '🧪', '🌡️', '🧹', '🪠', '🧺', '🧻', '🚽', '🚰', '🚿', '🛁', '🛀', '🧼', '🪒', '🧽', '🪣', '🧴', '🛎️', '🔑', '🗝️', '🚪', '🪑', '🛋️', '🛏️', '🧸', '🪆', '🖼️', '🪞', '🪟', '🛍️', '🛒', '🎁', '🎈', '🎏', '🎀', '🪄', '🪅', '🎊', '🎉', '🎎', '🏮', '🎐', '🧧', '✉️', '📩', '📨', '📧', '💌', '📥', '📤', '📦', '🏷️', '📪', '📫', '📬', '📭', '📮', '✏️', '✒️', '🖋️', '🖊️', '🖌️', '🖍️', '📝', '💼', '📁', '📂', '🗂️', '📅', '📆', '🗒️', '🗓️', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇️', '📏', '📐', '✂️', '🗃️', '🗄️', '🗑️', '🔒', '🔓', '🔏', '🔐'],
  },
  {
    name: 'Symbols',
    emojis: ['❤️', '❤️‍🔥', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '🩷', '🩵', '🩶', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☯️', '✡️', '🔯', '🕎', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '⛔', '📛', '🚫', '❌', '⭕', '🛑', '💯', '💢', '💥', '🔥', '💫', '✨', '💦', '💨', '🕳️', '💬', '🗨️', '🗯️', '💭', '💤', '💮', '♨️', '💈', '🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔', '🕠', '🕕', '🕡', '🕖', '🕢', '🕗', '🕣', '🕘', '🕤', '🕙', '🕥', '🕚', '🕦'],
  },
  {
    name: 'Flags',
    emojis: ['🇮🇳', '🇺🇸', '🇬🇧', '🇨🇦', '🇦🇺', '🇩🇪', '🇫🇷', '🇯🇵', '🇰🇷', '🇨🇳', '🇧🇷', '🇿🇦', '🇦🇪', '🇸🇦', '🇳🇵', '🇵🇰', '🇧🇩', '🇱🇰', '🇹🇭', '🇮🇩', '🇻🇳', '🇵🇭', '🇲🇾', '🇸🇬', '🇳🇿', '🇲🇽', '🇪🇸', '🇮🇹', '🇳🇱', '🇸🇪', '🇳🇴', '🇩🇰', '🇫🇮', '🇵🇱', '🇹🇷', '🇮🇱', '🇪🇬', '🇳🇬', '🇰🇪', '🇺🇦', '🇷🇺'],
  },
];

function loadRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string').slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(e: string): void {
  try {
    const list = [e, ...loadRecents().filter((x) => x !== e)].slice(0, MAX_RECENTS);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch { /* intentionally ignored */}
}

export default function EmojiPicker({
  onSelect,
  onClose,
  bare = false,
}: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** WA Wave-2 (DM #25 / Media E10): render only the inner content (no
   *  outer panel wrapper) so CombinedPicker can host the emoji tab. */
  bare?: boolean;
}) {
  const [category, setCategory] = useState('Smileys');
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [skinTone, setSkinTone] = useState<string>(() => loadSkinTone());

  const chooseTone = (modifier: string) => {
    setSkinTone(modifier);
    saveSkinTone(modifier);
  };

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    // W24b (100-more F1): search matches emoji names/keywords, not just
    // the glyph or category. Multi-word queries match when every word
    // hits the keywords (or category). Keys strip U+FE0F, as does the
    // lookup, so "❤️" matches the "❤" keyword entry.
    const words = q.split(/\s+/).filter(Boolean);
    const all = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => ({ e, c: c.name })));
    return all
      .filter(({ e, c }) => {
        if (e === q) return true;
        const hay = `${EMOJI_KEYWORDS[e.replace(/\uFE0F/g, '')] || ''} ${c}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .map(({ e }) => e);
  }, [query]);

  const pick = (e: string) => {
    const toned = applySkinTone(e, skinTone);
    rememberEmoji(toned);
    setRecents(loadRecents());
    onSelect(toned);
  };

  // The grid shows toneable emoji in the chosen skin tone (WhatsApp does
  // the same); recents already store the toned glyph that was picked.
  const shown = (results !== null ? results : EMOJI_CATEGORIES.find((c) => c.name === category)?.emojis || []).map((e) => applySkinTone(e, skinTone));

  const body = (
    <>
      {/* Search */}
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="flex flex-1 items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji"
            className="flex-1 bg-transparent text-sm outline-none text-gray-900 dark:text-text-primary placeholder:text-gray-400"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="text-gray-400">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button onClick={onClose} aria-label="Close emoji picker" className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Skin-tone picker (WA parity E4): tap a tone — hand/people emoji
          in the grid below (and every pick) use it until changed. */}
      <div data-skin-tone-picker className="flex items-center gap-1.5 px-3 pt-2" role="group" aria-label="Skin tone">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mr-1">Skin tone</span>
        {SKIN_TONES.map((t) => (
          <button
            key={t.id}
            onClick={() => chooseTone(t.modifier)}
            aria-label={t.label}
            aria-pressed={skinTone === t.modifier}
            title={t.label}
            className={`text-xl leading-none p-1 rounded-full transition-transform hover:scale-125 ${skinTone === t.modifier ? 'bg-primary-green/15 ring-2 ring-primary-green' : ''}`}
          >
            {`👋${t.modifier}`}
          </button>
        ))}
      </div>

      {/* Category tabs */}
      {!query && (
        <div className="flex gap-1 px-3 pt-2 overflow-x-auto scrollbar-hide">
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.name}
              onClick={() => setCategory(c.name)}
              aria-pressed={category === c.name}
              className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                category === c.name
                  ? 'bg-primary-green/15 text-primary-green'
                  : 'bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary'
              }`}
            >
              <span aria-hidden="true">{CATEGORY_ICONS[c.name] || '😀'}</span> {c.name}
            </button>
          ))}
        </div>
      )}

      {/* Recents */}
      {!query && recents.length > 0 && (
        <div className="px-3 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Recent</p>
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-1">
            {recents.map((e) => (
              <button key={e} onClick={() => pick(e)} className="text-2xl hover:scale-125 transition-transform flex-shrink-0" aria-label={`Emoji ${e}`}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Grid */}
      <div className="px-3 py-2 max-h-44 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="text-center text-xs text-gray-400 py-6">No emoji found.</p>
        ) : (
          <div className="grid grid-cols-8 gap-1">
            {shown.map((e) => (
              <button
                key={e}
                onClick={() => pick(e)}
                className="text-2xl leading-none p-1 hover:scale-125 hover:bg-gray-100 dark:hover:bg-input-dark rounded-lg transition-transform"
                aria-label={`Emoji ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );

  if (bare) return body;
  return (
    <div
      data-emoji-picker
      className="bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5 max-h-[320px] overflow-y-auto"
    >
      {body}
    </div>
  );
}
