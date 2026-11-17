/**
 * Feature 3 — Stickers + GIF picker: local data + Giphy search.
 *
 * REAL STICKER ART (REPORT-3 #216, W30j): the first pack, "Fluent 3D",
 * is real bundled image art — Microsoft Fluent Emoji 3D renders,
 * downloaded from https://github.com/microsoft/fluentui-emoji and
 * converted to WebP (20 stickers, ~113 KB total, public/stickers/
 * fluent-3d/). Licence: MIT — Copyright (c) Microsoft Corporation; the
 * full licence text is bundled at public/stickers/fluent-3d/LICENSE.txt.
 * The images are served from `public/` (Vite copies them to dist/ and
 * Capacitor ships them in the APK), so they work fully offline and cost
 * nothing in the JS entry bundle — they are NOT imported into any chunk.
 * Each real-art sticker also keeps its emoji in `art` as the fallback:
 * old clients (and text export / search) still see the emoji, and the
 * message stores both `stickerImage` (bundled path) and `stickerEmoji`.
 *
 * The older packs below stay as they were (emoji art on CSS gradients)
 * — they are the fallback for clients without the new pack.
 *
 * GIFs: Giphy only (REPORT-3 #203, FIX-REPORT-3 §18) — see
 * `services/giphy.ts` (key from `VITE_GIPHY_API_KEY`, IndexedDB cache,
 * no demo-key fallback). Tenor is NOT a provider here: Google shut the
 * Tenor GIF API down on June 30, 2026, so the old Tenor client was
 * removed entirely. Without a Giphy key the GIF tab shows an honest
 * error and the picker falls back to the local sticker pack + paste-a-link.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface StickerDef {
  /** Stable id, stored on the message as `stickerId`. */
  id: string;
  /** The emoji art itself, stored on the message as `stickerEmoji`. */
  art: string;
  /** Human label, stored on the message as `stickerLabel` (also the `text`
   *  fallback, so search / export / old clients still show something). */
  label: string;
  /** Tailwind gradient classes for the picker tile. */
  bg: string;
  /** Pack / category name. */
  pack: string;
  /** Bundled real-art image (public/stickers/…), stored on the message as
   *  `stickerImage`. Absent for the legacy emoji-only packs — the picker
   *  and the bubble fall back to `art` when there is no image. */
  image?: string;
  /** Wave-2 S11 (WA "Sticker with: {emojis}"): emoji tags carried by the
   *  sticker, used for search-by-emoji in the picker and for sticker
   *  suggestions while typing (E9). The sticker's own `art` is always
   *  the first tag. Stickers without this field (avatar / custom /
   *  animated packs built elsewhere) fall back to `[art]` via
   *  `stickerEmojiTags()` — never empty. */
  emojis?: string[];
}

export interface GifDef {
  id: string;
  /** Full-size GIF url — sent as the message `mediaUrl` (mediaType 'image',
   *  so the existing image rendering + lightbox + Media gallery just work).
   *  The bubble renders a GIF message as a looping video with a GIF badge
   *  (Wave-2 A5, DM #78): a <video> when `mp4Url` is present, the .gif
   *  itself (which animates + loops natively) otherwise. */
  url: string;
  /** MP4 variant of the GIF (Giphy `original_mp4`), when the provider
   *  returned one — used as the looping-video source for the bubble. */
  mp4Url?: string;
  /** Small preview url for the picker grid. */
  previewUrl: string;
  title: string;
  /** WA parity Media G6: provider attribution (WA `VideoMessage$Attribution`,
   *  e.g. `'GIPHY'`) — stored on the sent message as `gifAttribution` and
   *  rendered on the GIF bubble. Absent for pasted-link GIFs, whose
   *  provider is unknown (never invented). */
  attribution?: string;
}

export type PickerTab = 'stickers' | 'gifs';

// ── Local sticker pack ─────────────────────────────────────────────────────

export const STICKER_PACKS: { name: string; stickers: StickerDef[] }[] = [
  {
    // W30j (#216): REAL sticker art — Microsoft Fluent Emoji 3D (MIT),
    // bundled as WebP in public/stickers/fluent-3d/. Listed first so the
    // picker shows real art at the top. `art` stays as the emoji fallback
    // for old clients, text export and search.
    name: 'Fluent 3D',
    stickers: [
      { id: 'fluent-lol', art: '😂', label: 'LOL', emojis: ['😂', '🤣', '😆'], bg: 'from-yellow-300 to-amber-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-lol.webp' },
      { id: 'fluent-rolling', art: '🤣', label: 'Rolling', emojis: ['🤣', '😂', '😆'], bg: 'from-amber-300 to-orange-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-rolling.webp' },
      { id: 'fluent-crying', art: '😭', label: 'Crying', emojis: ['😭', '😢', '😿'], bg: 'from-sky-300 to-blue-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-crying.webp' },
      { id: 'fluent-angry', art: '😡', label: 'Angry', emojis: ['😡', '🤬', '😤'], bg: 'from-red-400 to-rose-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-angry.webp' },
      { id: 'fluent-shocked', art: '😱', label: 'Shocked', emojis: ['😱', '😮', '😲'], bg: 'from-violet-300 to-purple-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-shocked.webp' },
      { id: 'fluent-thinking', art: '🤔', label: 'Hmm…', emojis: ['🤔', '🧐', '🤨'], bg: 'from-slate-300 to-slate-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-thinking.webp' },
      { id: 'fluent-heart-eyes', art: '😍', label: 'Heart eyes', emojis: ['😍', '🥰', '😘'], bg: 'from-pink-300 to-rose-400', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-heart-eyes.webp' },
      { id: 'fluent-kiss', art: '😘', label: 'Kiss', emojis: ['😘', '😍', '💋'], bg: 'from-pink-400 to-fuchsia-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-kiss.webp' },
      { id: 'fluent-party', art: '🥳', label: 'Party!', emojis: ['🥳', '🎉', '🎊'], bg: 'from-yellow-300 to-pink-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-party.webp' },
      { id: 'fluent-cool', art: '😎', label: 'Cool', emojis: ['😎', '😏', '🕶️'], bg: 'from-cyan-300 to-sky-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-cool.webp' },
      { id: 'fluent-love', art: '❤️', label: 'Love', emojis: ['❤️', '💕', '💖'], bg: 'from-rose-400 to-red-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-love.webp' },
      { id: 'fluent-fire', art: '🔥', label: 'Fire', emojis: ['🔥', '🥵', '💯'], bg: 'from-orange-400 to-red-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-fire.webp' },
      { id: 'fluent-tada', art: '🎉', label: 'Party popper', emojis: ['🎉', '🎊', '🥳'], bg: 'from-fuchsia-400 to-purple-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-tada.webp' },
      { id: 'fluent-victory', art: '✌️', label: 'Victory', emojis: ['✌️', '🏆', '🥇'], bg: 'from-emerald-300 to-teal-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-victory.webp' },
      { id: 'fluent-clap', art: '👏', label: 'Clap', emojis: ['👏', '🙌', '👍'], bg: 'from-amber-300 to-yellow-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-clap.webp' },
      { id: 'fluent-namaste', art: '🙏', label: 'Namaste', emojis: ['🙏', '🪔', '🛕'], bg: 'from-amber-300 to-yellow-600', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-namaste.webp' },
      { id: 'fluent-doggo', art: '🐶', label: 'Doggo', emojis: ['🐶', '🐕', '🦮'], bg: 'from-amber-200 to-orange-400', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-doggo.webp' },
      { id: 'fluent-kitty', art: '🐱', label: 'Kitty', emojis: ['🐱', '🐈', '😻'], bg: 'from-orange-200 to-amber-400', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-kitty.webp' },
      { id: 'fluent-panda', art: '🐼', label: 'Panda', emojis: ['🐼', '🐻', '🎋'], bg: 'from-gray-200 to-slate-400', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-panda.webp' },
      { id: 'fluent-rocket', art: '🚀', label: 'Rocket', emojis: ['🚀', '🛸', '🌟'], bg: 'from-indigo-300 to-violet-500', pack: 'Fluent 3D', image: '/stickers/fluent-3d/fluent-rocket.webp' },
    ],
  },
  {
    name: 'Reactions',
    stickers: [
      { id: 'lol', art: '😂', label: 'LOL', emojis: ['😂', '🤣'], bg: 'from-yellow-300 to-amber-500', pack: 'Reactions' },
      { id: 'rolling', art: '🤣', label: 'Rolling', emojis: ['🤣', '😂'], bg: 'from-amber-300 to-orange-500', pack: 'Reactions' },
      { id: 'crying', art: '😭', label: 'Crying', emojis: ['😭', '😢'], bg: 'from-sky-300 to-blue-500', pack: 'Reactions' },
      { id: 'angry', art: '😡', label: 'Angry', emojis: ['😡', '🤬'], bg: 'from-red-400 to-rose-600', pack: 'Reactions' },
      { id: 'shocked', art: '😱', label: 'Shocked', emojis: ['😱', '😲'], bg: 'from-violet-300 to-purple-500', pack: 'Reactions' },
      { id: 'thinking', art: '🤔', label: 'Hmm…', emojis: ['🤔', '🧐'], bg: 'from-slate-300 to-slate-500', pack: 'Reactions' },
      { id: 'sleepy', art: '😴', label: 'Sleepy', emojis: ['😴', '🥱', '😪'], bg: 'from-indigo-300 to-indigo-500', pack: 'Reactions' },
      { id: 'whatever', art: '🙄', label: 'Whatever', emojis: ['🙄', '😒', '🙃'], bg: 'from-gray-300 to-gray-500', pack: 'Reactions' },
    ],
  },
  {
    name: 'Love & Fun',
    stickers: [
      { id: 'love', art: '❤️', label: 'Love', emojis: ['❤️', '💕'], bg: 'from-rose-400 to-red-600', pack: 'Love & Fun' },
      { id: 'blushing', art: '🥰', label: 'Blushing', emojis: ['🥰', '😍'], bg: 'from-pink-300 to-rose-500', pack: 'Love & Fun' },
      { id: 'kiss', art: '😘', label: 'Kiss', emojis: ['😘', '💋'], bg: 'from-pink-400 to-fuchsia-600', pack: 'Love & Fun' },
      { id: 'party', art: '🎉', label: 'Party!', emojis: ['🎉', '🎊'], bg: 'from-fuchsia-400 to-purple-600', pack: 'Love & Fun' },
      { id: 'celebrate', art: '🥳', label: 'Celebrate', emojis: ['🥳', '🎉'], bg: 'from-yellow-300 to-pink-500', pack: 'Love & Fun' },
      { id: 'fire', art: '🔥', label: 'Fire', emojis: ['🔥', '💯'], bg: 'from-orange-400 to-red-600', pack: 'Love & Fun' },
      { id: 'hundred', art: '💯', label: '100', emojis: ['💯', '🔥', '👏'], bg: 'from-emerald-300 to-teal-600', pack: 'Love & Fun' },
      { id: 'cool', art: '😎', label: 'Cool', emojis: ['😎', '😏'], bg: 'from-cyan-300 to-sky-600', pack: 'Love & Fun' },
    ],
  },
  {
    name: 'Desi',
    stickers: [
      { id: 'namaste', art: '🙏', label: 'Namaste', emojis: ['🙏', '🪔'], bg: 'from-amber-300 to-yellow-600', pack: 'Desi' },
      { id: 'cricket', art: '🏏', label: 'Cricket!', emojis: ['🏏', '🏆', '🏟️'], bg: 'from-green-300 to-emerald-600', pack: 'Desi' },
      { id: 'chai', art: '☕', label: 'Chai Time', emojis: ['☕', '🫖', '🍵'], bg: 'from-orange-300 to-amber-600', pack: 'Desi' },
      { id: 'movie', art: '🎬', label: 'Movie Night', emojis: ['🎬', '🍿', '🎥'], bg: 'from-slate-400 to-zinc-600', pack: 'Desi' },
      { id: 'strong', art: '💪', label: 'Strong', emojis: ['💪', '🏋️', '🔥'], bg: 'from-lime-300 to-green-600', pack: 'Desi' },
      { id: 'dev-bhai', art: '😎', label: 'Dev Bhai', emojis: ['😎', '💻', '👨‍💻'], bg: 'from-emerald-300 to-green-600', pack: 'Dev Bhai' },
      { id: 'shaadi', art: '🎊', label: 'Shaadi Vibes', emojis: ['🎊', '💍', '🎉'], bg: 'from-pink-300 to-rose-600', pack: 'Desi' },
      { id: 'festival', art: '🪔', label: 'Festival', emojis: ['🪔', '🎆', '🙏'], bg: 'from-yellow-300 to-orange-600', pack: 'Desi' },
    ],
  },
  {
    name: 'Animals & Cute',
    stickers: [
      { id: 'doggo', art: '🐶', label: 'Doggo', emojis: ['🐶', '🐕'], bg: 'from-amber-200 to-orange-400', pack: 'Animals & Cute' },
      { id: 'kitty', art: '🐱', label: 'Kitty', emojis: ['🐱', '🐈'], bg: 'from-orange-200 to-amber-400', pack: 'Animals & Cute' },
      { id: 'lion', art: '🦁', label: 'Lion', emojis: ['🦁', '👑'], bg: 'from-yellow-300 to-amber-600', pack: 'Animals & Cute' },
      { id: 'panda', art: '🐼', label: 'Panda', emojis: ['🐼', '🐻'], bg: 'from-gray-200 to-slate-400', pack: 'Animals & Cute' },
      { id: 'unicorn', art: '🦄', label: 'Unicorn', emojis: ['🦄', '🌈'], bg: 'from-pink-300 to-violet-500', pack: 'Animals & Cute' },
      { id: 'frog', art: '🐸', label: 'Frog', emojis: ['🐸', '💚'], bg: 'from-lime-300 to-green-500', pack: 'Animals & Cute' },
      { id: 'monkey', art: '🐵', label: 'Monkey', emojis: ['🐵', '🙈'], bg: 'from-amber-300 to-yellow-600', pack: 'Animals & Cute' },
      { id: 'fox', art: '🦊', label: 'Fox', emojis: ['🦊', '🧡'], bg: 'from-orange-300 to-red-500', pack: 'Animals & Cute' },
    ],
  },
];

/** Flat list of every sticker (handy for search / recents lookup). */
export const ALL_STICKERS: StickerDef[] = STICKER_PACKS.flatMap((p) => p.stickers);

export const findSticker = (id: string): StickerDef | undefined =>
  ALL_STICKERS.find((s) => s.id === id);

// ── Emoji tags (Wave-2 S11/E9: WA "Sticker with: {emojis}") ───────────────
// Stickers carry emoji tags used for search-by-emoji in the picker and for
// sticker suggestions while typing. The tag data lives on the bundled packs
// above (`emojis`); stickers built elsewhere (avatar / custom / animated
// packs) have no `emojis` field and fall back to their own `art`.

/** Strip U+FE0F variation selectors so '❤️' and '❤' compare equal. */
export function normalizeEmoji(e: string): string {
  return e.replace(/\uFE0F/g, '');
}

/** Emoji tags for a sticker — its `emojis` field, or `[art]` as fallback.
 *  Never empty: the sticker's own art is always a tag. */
export function stickerEmojiTags(s: StickerDef): string[] {
  return s.emojis && s.emojis.length > 0 ? s.emojis : [s.art];
}

/** Emoji graphemes in a string, in order, deduped. `Intl.Segmenter` when
 *  available (correct for ZWJ sequences like 👨‍💻); a pictograph regex
 *  fallback otherwise (splits ZWJ sequences, still matches their parts). */
export function extractEmojis(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (g: string) => {
    if (!seen.has(g)) { seen.add(g); out.push(g); }
  };
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of seg.segment(text)) {
      if (/\p{Extended_Pictographic}/u.test(segment)) push(segment);
    }
    return out;
  } catch {
    for (const m of text.matchAll(/\p{Extended_Pictographic}/gu)) push(m[0]);
    return out;
  }
}

/**
 * Search stickers by emoji or by word. An emoji query (e.g. '😂') matches
 * stickers whose tags contain it (exact-art matches first); a text query
 * matches label / pack, as the picker did before. Empty query returns
 * the list unchanged.
 */
export function searchStickersByEmoji(query: string, stickers: StickerDef[] = ALL_STICKERS): StickerDef[] {
  const q = query.trim();
  if (!q) return stickers;
  const queryEmojis = extractEmojis(q).map(normalizeEmoji);
  if (queryEmojis.length > 0) {
    const scored: { s: StickerDef; score: number }[] = [];
    for (const s of stickers) {
      const tags = stickerEmojiTags(s).map(normalizeEmoji);
      if (!queryEmojis.some((e) => tags.includes(e))) continue;
      // Exact-art match outranks a tag-only match.
      const artMatch = queryEmojis.includes(normalizeEmoji(s.art));
      scored.push({ s, score: artMatch ? 2 : 1 });
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.score - a.score);
      return scored.map((x) => x.s);
    }
    // Emoji query with no tag hit: fall through to the text match below
    // (a label could still contain the query as text) rather than an
    // empty grid.
  }
  const lower = q.toLowerCase();
  return stickers.filter(
    (s) => s.label.toLowerCase().includes(lower) || s.pack.toLowerCase().includes(lower),
  );
}

/**
 * Sticker suggestions for typed text (WA `WAWebStickerSuggestion`): the
 * emoji in the text — most weight on the LAST emoji typed — suggest the
 * matching stickers, exact-art matches first. No emoji in the text, no
 * suggestions. Deduplicated by id, capped at `limit` (WA shows a short
 * row, not the whole pack).
 */
export function suggestStickersForText(
  text: string,
  stickers: StickerDef[] = ALL_STICKERS,
  limit = 6,
): StickerDef[] {
  const emojis = extractEmojis(text).map(normalizeEmoji);
  if (emojis.length === 0) return [];
  const scored: { s: StickerDef; score: number }[] = [];
  const seen = new Set<string>();
  for (const s of stickers) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const tags = stickerEmojiTags(s).map(normalizeEmoji);
    // Latest matching emoji wins: its index in the typed text.
    let best = -1;
    for (let i = 0; i < emojis.length; i++) {
      if (tags.includes(emojis[i])) best = i;
    }
    if (best < 0) continue;
    const artMatch = normalizeEmoji(s.art) === emojis[best];
    scored.push({ s, score: best * 10 + (artMatch ? 5 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}

// ── Recents (localStorage, same pattern as `dtwall` / `dtscheduled`) ───────

const RECENT_STICKERS_KEY = 'dt_recent_stickers';
const RECENT_GIFS_KEY = 'dt_recent_gifs';
const MAX_RECENTS = 12;

function loadRecentIds(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecentIds(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids.slice(0, MAX_RECENTS)));
  } catch {
    // Storage full / unavailable (private mode): recents are best-effort only.
  }
}

/** Resolve remembered recent ids against the bundled packs plus any
 *  dynamically built stickers (avatar pack, My Stickers) the caller
 *  passes in — those ids are NOT in ALL_STICKERS, so without the extra
 *  lookup a sent avatar/custom sticker could never appear in Recents
 *  (wa-verify-media-2 S6: `rememberSticker('avatar-happy')` wrote an id
 *  `loadRecentStickers()` then dropped as unresolvable). */
export function loadRecentStickers(extraLookups: StickerDef[] = []): StickerDef[] {
  const pool = [...ALL_STICKERS, ...extraLookups];
  return loadRecentIds(RECENT_STICKERS_KEY)
    .map((id) => pool.find((s) => s.id === id))
    .filter((s): s is StickerDef => !!s);
}

// WA parity S2: the raw recent ids, so callers can resolve them against
// every sticker on offer (static packs + avatar + My Stickers).
// loadRecentStickers() above only resolves static-pack ids via
// findSticker, so a sent custom/avatar sticker was remembered but never
// shown in Recents.
export function loadRecentStickerIds(): string[] {
  return loadRecentIds(RECENT_STICKERS_KEY);
}

export function rememberSticker(id: string) {
  saveRecentIds(RECENT_STICKERS_KEY, [id, ...loadRecentIds(RECENT_STICKERS_KEY).filter((x) => x !== id)]);
}

export function loadRecentGifs(): GifDef[] {
  return loadRecentIds(RECENT_GIFS_KEY).map((entry) => {
    // WA parity Media G6: recents store `url[\tattribution]` so a re-sent
    // recent keeps its provider attribution. Plain URLs (pre-G6 entries)
    // parse with no attribution — never invented.
    const tab = entry.indexOf('\t');
    const url = tab === -1 ? entry : entry.slice(0, tab);
    const attribution = tab === -1 ? undefined : entry.slice(tab + 1) || undefined;
    return {
      id: `recent-${url}`,
      url,
      previewUrl: url,
      title: 'Recent GIF',
      ...(attribution ? { attribution } : {}),
    };
  });
}

export function rememberGif(url: string, attribution?: string) {
  const entry = attribution ? `${url}\t${attribution}` : url;
  saveRecentIds(RECENT_GIFS_KEY, [entry, ...loadRecentIds(RECENT_GIFS_KEY).filter((x) => x !== entry && x.split('\t')[0] !== url)]);
}

// ── Favourites (WA parity §1b S3, local-only) ───────────────────────────────
// WhatsApp: "Add to favourites" / "Remove from favourites" / "You haven't
// favorited any stickers yet" / "You can't add more than {favorites_limit}
// favourites". Favourites store the full def (not just the id) so animated
// and user-created stickers favourite exactly like bundled ones.
export const FAVOURITE_STICKERS_KEY = 'dt_sticker_favourites';
export const MAX_FAVOURITE_STICKERS = 100;
export const FAVOURITES_LIMIT_MESSAGE = `You can't add more than ${MAX_FAVOURITE_STICKERS} favourites`;

export type FavouriteSticker = StickerDef & { animation?: string };

export function loadFavouriteStickers(): FavouriteSticker[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(FAVOURITE_STICKERS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return (parsed as FavouriteSticker[]).filter(
      (s) => s && typeof s.id === 'string' && typeof s.art === 'string',
    ).slice(0, MAX_FAVOURITE_STICKERS);
  } catch {
    return [];
  }
}

function saveFavouriteStickers(list: FavouriteSticker[]): void {
  try {
    localStorage.setItem(FAVOURITE_STICKERS_KEY, JSON.stringify(list.slice(0, MAX_FAVOURITE_STICKERS)));
  } catch {
    // Best-effort only.
  }
}

export function isFavouriteSticker(id: string): boolean {
  return loadFavouriteStickers().some((s) => s.id === id);
}

/** Toggle a favourite. Returns 'added' | 'removed' | 'limit' (cap hit). */
export function toggleFavouriteSticker(s: FavouriteSticker): 'added' | 'removed' | 'limit' {
  const list = loadFavouriteStickers();
  if (list.some((x) => x.id === s.id)) {
    saveFavouriteStickers(list.filter((x) => x.id !== s.id));
    return 'removed';
  }
  if (list.length >= MAX_FAVOURITE_STICKERS) return 'limit';
  saveFavouriteStickers([s, ...list]);
  return 'added';
}

// ── Create sticker from photo (WA parity §1b S5, local-only) ───────────────
// User-made stickers live in their own pack ("My Stickers") as full defs;
// the image is a data: PNG (background-removed, ≤512 px) so it needs no
// server, no upload, and renders through the existing stickerImage path.
export const MY_STICKERS_PACK = 'My Stickers';
export const CUSTOM_STICKERS_KEY = 'dt_custom_stickers';

export function loadCustomStickers(): StickerDef[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CUSTOM_STICKERS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return (parsed as StickerDef[]).filter(
      (s) => s && typeof s.id === 'string' && typeof s.image === 'string',
    );
  } catch {
    return [];
  }
}

export function saveCustomSticker(s: StickerDef): void {
  try {
    const list = [s, ...loadCustomStickers().filter((x) => x.id !== s.id)];
    localStorage.setItem(CUSTOM_STICKERS_KEY, JSON.stringify(list));
  } catch {
    // Storage full (data: URLs are big) — the sticker simply isn't kept.
  }
}

export function removeCustomSticker(id: string): void {
  try {
    localStorage.setItem(
      CUSTOM_STICKERS_KEY,
      JSON.stringify(loadCustomStickers().filter((x) => x.id !== id)),
    );
  } catch {
    // Best-effort only.
  }
}
