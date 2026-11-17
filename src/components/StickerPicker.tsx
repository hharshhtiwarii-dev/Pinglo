/**
 * Feature 3 — StickerPicker (Stickers + GIFs).
 *
 * Drop-in panel for ChatScreen, rendered in the same spot as the emoji
 * picker (above the input row). No new dependencies, no assets to download.
 *
 * - Stickers tab: built-in local packs grouped by category, with search
 *   + recents. Works fully offline. The "Fluent 3D" pack (W30j, REPORT-3
 *   #216) is real bundled WebP art (Microsoft Fluent Emoji, MIT); the
 *   older packs are emoji art on CSS gradients, kept as fallback.
 * - Animated sticker packs (Messaging Group, Worker W4): two bundled
 *   animated packs — "Party Time" and "Love & Hugs". HONEST NOTE: these
 *   are CSS-animated emoji stickers, NOT real animated WebP / Lottie
 *   files. No animated WebP assets are bundled and no new dependency was
 *   added — the animation is a CSS keyframe (bounce / wiggle / heartbeat
 *   …) applied to the emoji, so it plays everywhere with zero downloads
 *   and the sent message still renders on old clients (they just see the
 *   static emoji). The animation name is stored on the message as
 *   `stickerAnimation`, so ChatScreen replays the same motion in the
 *   bubble. Animated packs can be added/removed; the choice is persisted
 *   in localStorage (`dt_animated_sticker_packs`).
 * - GIFs tab: Giphy search + trending (REPORT-3 #203, FIX-REPORT-3
 *   §18). Key from app config (`VITE_GIPHY_API_KEY`); no demo-key
 *   fallback, no Tenor (shut down June 30, 2026), no Klipy fallback.
 *   Results are cached in IndexedDB (trending 1h, searches 24h,
 *   cache-first) by `services/giphy.ts`, so reopening the picker costs
 *   ~0 API calls. Without a key the tab shows an honest error and the
 *   paste-a-link box still works. Category tabs (WA G3): Trending,
 *   Haha, Sad, Love, Reactions, Sports, TV — the WA Web GIF-panel
 *   sections; Trending loads the trending endpoint, each other tab is
 *   a Giphy search for that word (same cache-first search path).
 * - GIFs are sent as normal image messages (mediaType 'image'), so the
 *   existing image rendering, lightbox and Media gallery already handle
 *   them. Stickers are sent via `onSelectSticker` and rendered large from
 *   the emoji stored on the message (see PATCH.md).
 * - Sticker details (WA S10): long-press a sticker opens a "Sticker
 *   details" sheet (pack info, View sticker pack, Copy sticker image,
 *   Send, favourite toggle); the "In this pack" preview grid previews 8
 *   and expands to the whole pack on "Show all"; a sticker whose bundled
 *   Send, favourite toggle); a sticker whose bundled image fails to load
 *   shows the emoji fallback + a Retry pill ("Sticker couldn't load,
 *   retry available"). A plain tap still sends immediately.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Link2, ImagePlay, Sticker as StickerIcon, Plus, Check, Star, Scissors, Copy, Info, RotateCcw, Send } from 'lucide-react';
import {
  ALL_STICKERS,
  STICKER_PACKS,
  FAVOURITES_LIMIT_MESSAGE,
  MY_STICKERS_PACK,
  extractEmojis,
  loadCustomStickers,
  loadFavouriteStickers,
  loadRecentGifs,
  loadRecentStickerIds,
  removeCustomSticker,
  rememberGif,
  rememberSticker,
  saveCustomSticker,
  searchStickersByEmoji,
  stickerEmojiTags,
  toggleFavouriteSticker,
  type FavouriteSticker,
  type GifDef,
  type PickerTab,
  type StickerDef,
} from './stickerPack';
import { searchGiphyGifs, trendingGiphyGifs } from '../services/giphy';
import AvatarCreator from './AvatarCreator';
import { AVATAR_PACK_NAME, buildAvatarStickers, loadAvatarTraits } from './avatar';

export type { GifDef, StickerDef, PickerTab };

// ── Animated stickers (CSS keyframes, no new dependency) ────────────────────

/** Animation applied to an animated sticker, in the picker and in the bubble. */
export type StickerAnimation =
  | 'bounce'
  | 'wiggle'
  | 'pulse'
  | 'spin'
  | 'float'
  | 'shake'
  | 'heartbeat'
  | 'none';

/** A sticker that carries an animation. `animation` is optional so plain
 *  StickerDef values from stickerPack.ts stay assignable. */
export interface AnimatedStickerDef extends StickerDef {
  animation?: StickerAnimation;
}

const STICKER_KEYFRAMES = `
@keyframes sticker-bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
@keyframes sticker-wiggle { 0%,100% { transform: rotate(-10deg); } 50% { transform: rotate(10deg); } }
@keyframes sticker-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.18); } }
@keyframes sticker-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes sticker-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
@keyframes sticker-shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }
@keyframes sticker-heartbeat { 0%,100% { transform: scale(1); } 20% { transform: scale(1.25); } 40% { transform: scale(1); } 60% { transform: scale(1.18); } }
`;

const ANIMATION_CSS: Record<Exclude<StickerAnimation, 'none'>, string> = {
  bounce: 'sticker-bounce 0.9s ease-in-out infinite',
  wiggle: 'sticker-wiggle 0.9s ease-in-out infinite',
  pulse: 'sticker-pulse 1.1s ease-in-out infinite',
  spin: 'sticker-spin 2.4s linear infinite',
  float: 'sticker-float 1.6s ease-in-out infinite',
  shake: 'sticker-shake 0.7s ease-in-out infinite',
  heartbeat: 'sticker-heartbeat 1.2s ease-in-out infinite',
};

/**
 * Inline style that replays a sticker's animation (used by ChatScreen for
 * the message bubble). Returns undefined for plain / unknown values, so
 * old messages and old clients render the static emoji.
 */
export function stickerAnimationStyle(anim?: string | null): React.CSSProperties | undefined {
  if (!anim || anim === 'none') return undefined;
  const css = ANIMATION_CSS[anim as Exclude<StickerAnimation, 'none'>];
  if (!css) return undefined;
  return { animation: css, display: 'inline-block' };
}

/** The two bundled animated packs. */
export const ANIMATED_STICKER_PACKS: {
  name: string;
  icon: string;
  description: string;
  stickers: AnimatedStickerDef[];
}[] = [
  {
    name: 'Party Time',
    icon: '🎉',
    description: 'Bouncy celebration stickers',
    stickers: [
      { id: 'anim-party-tada', art: '🎉', label: 'Party popper', bg: 'from-pink-400 to-rose-500', pack: 'Party Time', animation: 'bounce' },
      { id: 'anim-party-face', art: '🥳', label: 'Partying face', bg: 'from-yellow-300 to-amber-500', pack: 'Party Time', animation: 'wiggle' },
      { id: 'anim-party-balloon', art: '🎈', label: 'Balloon', bg: 'from-sky-300 to-blue-500', pack: 'Party Time', animation: 'float' },
      { id: 'anim-party-confetti', art: '🎊', label: 'Confetti ball', bg: 'from-fuchsia-400 to-purple-500', pack: 'Party Time', animation: 'shake' },
      { id: 'anim-party-champagne', art: '🍾', label: 'Champagne', bg: 'from-lime-300 to-green-500', pack: 'Party Time', animation: 'bounce' },
      { id: 'anim-party-gift', art: '🎁', label: 'Gift', bg: 'from-red-400 to-rose-500', pack: 'Party Time', animation: 'wiggle' },
      { id: 'anim-party-fireworks', art: '🎆', label: 'Fireworks', bg: 'from-indigo-400 to-violet-600', pack: 'Party Time', animation: 'pulse' },
      { id: 'anim-party-disco', art: '🪩', label: 'Disco ball', bg: 'from-cyan-300 to-sky-500', pack: 'Party Time', animation: 'spin' },
    ],
  },
  {
    name: 'Love & Hugs',
    icon: '❤️',
    description: 'Hearts that beat, float and hug',
    stickers: [
      { id: 'anim-love-heart', art: '❤️', label: 'Red heart', bg: 'from-red-400 to-rose-600', pack: 'Love & Hugs', animation: 'heartbeat' },
      { id: 'anim-love-eyes', art: '😍', label: 'Heart eyes', bg: 'from-pink-300 to-rose-400', pack: 'Love & Hugs', animation: 'pulse' },
      { id: 'anim-love-kiss', art: '💋', label: 'Kiss', bg: 'from-rose-400 to-red-500', pack: 'Love & Hugs', animation: 'wiggle' },
      { id: 'anim-love-hug', art: '🥰', label: 'Smiling face with hearts', bg: 'from-amber-300 to-orange-400', pack: 'Love & Hugs', animation: 'bounce' },
      { id: 'anim-love-sparkle', art: '💖', label: 'Sparkling heart', bg: 'from-pink-400 to-fuchsia-500', pack: 'Love & Hugs', animation: 'pulse' },
      { id: 'anim-love-blowkiss', art: '😘', label: 'Blowing a kiss', bg: 'from-orange-300 to-amber-500', pack: 'Love & Hugs', animation: 'float' },
      { id: 'anim-love-twohearts', art: '💕', label: 'Two hearts', bg: 'from-rose-300 to-pink-500', pack: 'Love & Hugs', animation: 'heartbeat' },
      { id: 'anim-love-hugging', art: '🫂', label: 'People hugging', bg: 'from-sky-300 to-indigo-400', pack: 'Love & Hugs', animation: 'wiggle' },
    ],
  },
];

/** id -> animation, for resolving recents / static lookups. */
const ANIM_BY_ID: Record<string, StickerAnimation> = Object.fromEntries(
  ANIMATED_STICKER_PACKS.flatMap((p) => p.stickers.map((s) => [s.id, s.animation || 'none'] as const)),
);

// ── Animated-pack add/remove (persisted in localStorage) ────────────────────

const ENABLED_PACKS_KEY = 'dt_animated_sticker_packs';

/** Names of the animated packs the user has enabled (default: all). */
export function loadEnabledAnimatedPacks(): string[] {
  try {
    const raw = localStorage.getItem(ENABLED_PACKS_KEY);
    if (!raw) return ANIMATED_STICKER_PACKS.map((p) => p.name);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ANIMATED_STICKER_PACKS.map((p) => p.name);
    const known = ANIMATED_STICKER_PACKS.map((p) => p.name);
    return known.filter((n) => (parsed as unknown[]).includes(n));
  } catch {
    return ANIMATED_STICKER_PACKS.map((p) => p.name);
  }
}

function saveEnabledAnimatedPacks(names: string[]): void {
  try {
    localStorage.setItem(ENABLED_PACKS_KEY, JSON.stringify(names));
  } catch {
    // Private mode / full storage: pack choice is best-effort, never fatal.
  }
}

// Animated recents live in their own key: stickerPack.ts `loadRecentStickers`
// only resolves ids from its own static packs, so animated recents are
// stored here as full defs and merged in below.
const ANIMATED_RECENTS_KEY = 'dt_animated_sticker_recents';
const MAX_ANIMATED_RECENTS = 12;

function loadAnimatedRecents(): AnimatedStickerDef[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ANIMATED_RECENTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return (parsed as AnimatedStickerDef[]).filter(
      (s) => s && typeof s.id === 'string' && typeof s.art === 'string' && ANIM_BY_ID[s.id],
    ).slice(0, MAX_ANIMATED_RECENTS);
  } catch {
    return [];
  }
}

function rememberAnimatedSticker(s: AnimatedStickerDef): void {
  try {
    const list = [s, ...loadAnimatedRecents().filter((x) => x.id !== s.id)].slice(0, MAX_ANIMATED_RECENTS);
    localStorage.setItem(ANIMATED_RECENTS_KEY, JSON.stringify(list));
  } catch {
    // Best-effort only.
  }
}

/** Create-sticker background removal (WA "Create sticker", local-only):
 *  flood-fill from the border, removing pixels close to the corner colour
 *  (the photo's background). Honest limit: this is a colour-distance
 *  cutout, not ML segmentation — busy backgrounds cut out messily, and
 *  the user sees the result in the picker before sending. */
export function removeStickerBackground(img: HTMLImageElement, maxDim = 512): string {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  // Background colour = average of the four corners.
  const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
  const bg = [0, 1, 2].map((c) => corners.reduce((s, p) => s + p[c], 0) / 4);
  const close = (p: number[]) => {
    const d = Math.sqrt(p.reduce((s, v, i) => s + (v - bg[i]) ** 2, 0));
    return d < 48;
  };
  // BFS from every border pixel; only connected near-background pixels go
  // transparent, so a same-coloured patch inside the subject survives.
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const idx = y * w + x;
    if (seen[idx]) return;
    seen[idx] = 1;
    if (close(at(x, y))) queue.push(idx);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  for (let qi = 0; qi < queue.length; qi++) {
    const idx = queue[qi];
    const x = idx % w;
    const y = Math.floor(idx / w);
    px[idx * 4 + 3] = 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL('image/png');
}

interface StickerPickerProps {
  onSelectSticker: (sticker: AnimatedStickerDef) => void;
  onSelectGif: (gif: GifDef) => void;
  onClose: () => void;
  /** Which tab to open on. Defaults to 'stickers'. */
  initialTab?: PickerTab;
  /** WA Wave-2 (DM #25 / Media E10): controlled tab — when provided, the
   *  tab is owned by the host (CombinedPicker) instead of internal state. */
  controlledTab?: PickerTab;
  onTabChange?: (tab: PickerTab) => void;
  /** Render only the tab content (no outer panel wrapper, no own tab bar
   *  / close button) so CombinedPicker can host the tab. */
  bare?: boolean;
  /** Wave-2 E9 (WA onShowMore): pre-fill the search box, e.g. with the
   *  last typed emoji so the picker opens on its matches. */
  initialQuery?: string;
}

// GIF categories (WA G3 — verified in the WA Web client, bundle
// YhqvEmhKlF9.js): `WAWebGifPanelGifCategories` lists TRENDING, HAHA,
// SAD, LOVE, REACTIONS, SPORTS, TV; `WAWebGifPanelGifSections` orders
// them as the panel tabs (Favourites is a section but is filtered out
// of the panel tab list, and DT has no GIF favourites — recents only —
// so it is not a tab here either). Tab labels are WA's exact BTDS
// strings: "Trending", "Haha", "Sad", "Love", "Reactions", "Sports",
// "TV". Behaviour in WA: Trending loads the Giphy trending endpoint;
// every other section is a Giphy search for that word
// (`searchGiphy` builds `/v1/gifs/search?q=<section>`), so each
// category reuses the existing cache-first search path (24 h cache).
// E5 review: module-level (was recreated on every render inside the
// component); the effect below depends only on `gifCategory`.
const GIF_CATEGORIES = [
  { id: 'TRENDING', label: 'Trending', query: null },
  { id: 'HAHA', label: 'Haha', query: 'haha' },
  { id: 'SAD', label: 'Sad', query: 'sad' },
  { id: 'LOVE', label: 'Love', query: 'love' },
  { id: 'REACTIONS', label: 'Reactions', query: 'reactions' },
  { id: 'SPORTS', label: 'Sports', query: 'sports' },
  { id: 'TV', label: 'TV', query: 'tv' },
] as const;
type GifCategoryId = (typeof GIF_CATEGORIES)[number]['id'];

export default function StickerPicker({
  onSelectSticker,
  onSelectGif,
  onClose,
  initialTab = 'stickers',
  controlledTab,
  onTabChange,
  bare = false,
  initialQuery = '',
}: StickerPickerProps) {
  const [internalTab, setInternalTab] = useState<PickerTab>(initialTab);
  // Controlled mode (CombinedPicker) wins when provided; otherwise the
  // picker owns its tab exactly as before.
  const tab = controlledTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;

  // Keep the open tab in sync when the caller re-opens on a different tab
  // (e.g. attach menu → GIFs). `key={...}` remounting is avoided: with the
  // React 19 types here, `key` is not accepted on custom components.
  // Controlled mode: the host owns the tab, so there is nothing to sync.
  useEffect(() => {
    if (controlledTab === undefined) setInternalTab(initialTab);
  }, [initialTab, controlledTab]);
  const [category, setCategory] = useState<string>('All');
  const [query, setQuery] = useState(initialQuery);

  // Wave-2 E9: same sync as the tab — a re-open with a new initial query
  // (suggestion row → "more") re-filters the picker.
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  // WA parity S10: sticker / pack details view.
  const [detailsSticker, setDetailsSticker] = useState<AnimatedStickerDef | null>(null);
  const [copyNote, setCopyNote] = useState('');
  // WA pack detail view shows the WHOLE pack; the sheet previews 8 and
  // expands to all on "Show all". Reset on every sticker switch.
  const [detailsShowAll, setDetailsShowAll] = useState(false);
  useEffect(() => { setDetailsShowAll(false); }, [detailsSticker?.id]);
  // Image-backed stickers whose bundled art failed to load (WA: "Sticker
  // couldn't load, retry available") — ids, plus a per-id retry counter
  // that remounts the <img> so the browser tries again.
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());
  const [retryTick, setRetryTick] = useState<Record<string, number>>({});
  const markStickerImageFailed = (id: string) => {
    setFailedImages((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const retryStickerImage = (id: string) => {
    setFailedImages((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setRetryTick((prev) => ({ ...prev, [id]: (prev[id] || 0) + 1 }));
  };
  // Long-press (500 ms, finger still) opens the details sheet; a plain
  // tap still sends immediately. Shared refs: one tile is pressed at a time.
  const lpTimerRef = useRef<number | null>(null);
  const lpFiredRef = useRef(false);
  const lpFiredAtRef = useRef(0);
  const lpStartRef = useRef<{ x: number; y: number } | null>(null);
  const clearLongPress = () => {
    if (lpTimerRef.current !== null) {
      window.clearTimeout(lpTimerRef.current);
      lpTimerRef.current = null;
    }
    lpStartRef.current = null;
  };
  useEffect(() => clearLongPress, []);

  // WA parity S3: sticker favourites (localStorage, cap 100 — WA limit
  // message shown when the cap is hit). `favTick` re-reads after a toggle.
  const [favTick, setFavTick] = useState(0);
  const [favNote, setFavNote] = useState('');
  const favourites = useMemo(() => loadFavouriteStickers(), [favTick]);
  const toggleFav = (s: AnimatedStickerDef) => {
    const res = toggleFavouriteSticker(s as FavouriteSticker);
    setFavNote(res === 'limit' ? FAVOURITES_LIMIT_MESSAGE : res === 'added' ? 'Added to favourites ✓' : 'Removed from favourites');
    setFavTick((t) => t + 1);
  };

  // WA parity S5: create a sticker from a photo (local "My Stickers" pack).
  const [customTick, setCustomTick] = useState(0);
  const [createNote, setCreateNote] = useState('');
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const customStickers = useMemo(() => loadCustomStickers(), [customTick]);
  const onCreateStickerFile = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const cutout = removeStickerBackground(img);
        saveCustomSticker({
          id: `custom-${Date.now()}`,
          art: '✂️',
          label: 'My sticker',
          bg: 'from-violet-300 to-purple-500',
          pack: MY_STICKERS_PACK,
          image: cutout,
        });
        setCustomTick((t) => t + 1);
        setCategory(MY_STICKERS_PACK);
        setCreateNote('Sticker saved to My Stickers ✓');
      } catch {
        setCreateNote('Could not make a sticker from this photo — try another one.');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setCreateNote('Could not load this photo — try another one.');
    };
    img.src = url;
  };

  // Avatar pack (nightshift §4): built from locally saved traits.
  const [avatarTraits, setAvatarTraits] = useState(() => loadAvatarTraits());
  const [showCreator, setShowCreator] = useState(false);
  const avatarStickers = useMemo(
    () => (avatarTraits ? buildAvatarStickers(avatarTraits) : []),
    [avatarTraits],
  );

  // Animated packs the user has enabled (add/remove persisted).
  const [enabledPacks, setEnabledPacks] = useState<string[]>(() => loadEnabledAnimatedPacks());
  const togglePack = (name: string) => {
    const next = enabledPacks.includes(name)
      ? enabledPacks.filter((n) => n !== name)
      : [...enabledPacks, name];
    saveEnabledAnimatedPacks(next);
    // Removing the pack you're browsing falls back to All.
    if (!next.includes(name) && category === name) setCategory('All');
    setEnabledPacks(next);
  };

  // Phase 3: Escape closes the details sheet first, then the picker.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (detailsSticker) { setDetailsSticker(null); return; }
      onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose, detailsSticker]);

  // GIF state
  const [gifs, setGifs] = useState<GifDef[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState('');
  const [gifCategory, setGifCategory] = useState<GifCategoryId>('TRENDING');
  // Honest note when the grid is served from cache (stale / offline /
  // key missing / hourly limit) — empty on a fresh network load.
  const [gifNote, setGifNote] = useState('');
  const [gifQuery, setGifQuery] = useState('');
  const [gifUrlInput, setGifUrlInput] = useState('');
  const [gifUrlError, setGifUrlError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  // All stickers on offer: the static packs plus the enabled animated packs.
  const animatedStickers = useMemo(
    () =>
      ANIMATED_STICKER_PACKS.filter((p) => enabledPacks.includes(p.name)).flatMap(
        (p) => p.stickers,
      ),
    [enabledPacks],
  );
  const allStickers = useMemo<AnimatedStickerDef[]>(
    () => [...ALL_STICKERS, ...animatedStickers, ...avatarStickers, ...customStickers],
    [animatedStickers, avatarStickers, customStickers],
  );
  const packNames = useMemo(
    () => [...STICKER_PACKS.map((p) => p.name), ...enabledPacks, AVATAR_PACK_NAME, MY_STICKERS_PACK],
    [enabledPacks],
  );

  const recentStickers = useMemo(() => {
    // WA parity S2 / S6: resolve recent ids against ALL stickers on offer
    // (static packs + avatar + My Stickers), not just the static packs —
    // loadRecentStickers() only knows static ids, so a sent custom/avatar
    // sticker was remembered but never shown in Recents. (media-2's S6
    // fix did the same via extra packs passed to loadRecentStickers;
    // this byId form subsumes it — one source of truth, allStickers.)
    const byId = new Map(allStickers.map((s) => [s.id, s]));
    const base: AnimatedStickerDef[] = loadRecentStickerIds()
      .map((id) => byId.get(id))
      .filter((s): s is AnimatedStickerDef => !!s);
    const anim = loadAnimatedRecents();
    const seen = new Set(base.map((s) => s.id));
    return [...base, ...anim.filter((s) => !seen.has(s.id))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, category, enabledPacks, allStickers]);
  const recentGifs = useMemo(() => loadRecentGifs(), [tab]);

  // GIF preview failures (user-test V6 fix): ids of GIFs whose preview
  // image failed to load. Failed tiles stay in the grid as grey "GIF"
  // placeholders instead of being removed from the DOM, so a grid of
  // failed previews never looks empty. Reset whenever a new GIF list
  // arrives (new previews, new chance to load).
  const [failedGifPreviews, setFailedGifPreviews] = useState<Set<string>>(new Set());
  const [failedRecentPreviews, setFailedRecentPreviews] = useState<Set<string>>(new Set());
  useEffect(() => {
    setFailedGifPreviews(new Set());
  }, [gifs]);
  useEffect(() => {
    setFailedRecentPreviews(new Set());
  }, [recentGifs]);

  const markGifPreviewFailed = (id: string) => {
    setFailedGifPreviews((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  const markRecentPreviewFailed = (id: string) => {
    setFailedRecentPreviews((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  // ── Stickers: filter by category + search ──
  // Wave-2 S11: search is search-by-emoji — an emoji query matches the
  // sticker's emoji tags (exact-art first); a word query matches label /
  // pack as before. See stickerPack.ts `searchStickersByEmoji`.
  const queryEmojis = useMemo(() => extractEmojis(query), [query]);
  const visibleStickers = useMemo(() => {
    const list = category === 'All' ? allStickers : allStickers.filter((s) => s.pack === category);
    if (!query.trim()) return list;
    return searchStickersByEmoji(query, list);
  }, [category, query, allStickers]);

  // ── GIFs: selected category on open / tab tap, debounced search while typing ──
  // Giphy only (FIX-REPORT-3 §18): cache-first via services/giphy.ts —
  // a warm cache renders with zero API calls; without a key the tab shows
  // an honest error instead of falling back to a dead demo key.
  // A free-text search owns the grid while it is non-empty; clearing it
  // restores the selected category (same split as WA's panel, where the
  // tab sets the section and the search box is a separate input).
  useEffect(() => {
    if (tab !== 'gifs') return;
    if (gifQuery.trim()) return; // free-text search owns the grid
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGifLoading(true);
    setGifError('');
    setGifNote('');
    const cat = GIF_CATEGORIES.find((c) => c.id === gifCategory);
    const req = cat?.query
      ? searchGiphyGifs(cat.query, ctrl.signal)
      : trendingGiphyGifs(ctrl.signal);
    req
      .then((res) => {
        if (!ctrl.signal.aborted) {
          setGifs(res.gifs);
          setGifNote(res.note || '');
        }
      })
      .catch((err) => {
        if (!ctrl.signal.aborted) setGifError(err?.message || 'Could not load GIFs.');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setGifLoading(false);
      });
    return () => ctrl.abort();
    // GIF_CATEGORIES is a module-stable literal list; gifCategory is the
    // only part that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, gifCategory, gifQuery]);

  useEffect(() => {
    if (tab !== 'gifs') return;
    const q = gifQuery.trim();
    if (!q) return; // empty query keeps the trending grid
    const t = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setGifLoading(true);
      setGifError('');
      setGifNote('');
      searchGiphyGifs(q, ctrl.signal)
        .then((res) => {
          if (!ctrl.signal.aborted) {
            setGifs(res.gifs);
            setGifNote(res.note || '');
          }
        })
        .catch((err) => {
          if (!ctrl.signal.aborted) setGifError(err?.message || 'GIF search failed.');
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setGifLoading(false);
        });
    }, 400);
    return () => clearTimeout(t);
  }, [gifQuery, tab]);

  // ── Send handlers (remember recents, then hand off to ChatScreen) ──
  const pickSticker = (s: AnimatedStickerDef) => {
    rememberSticker(s.id);
    if (s.animation && s.animation !== 'none') rememberAnimatedSticker(s);
    // #218: light haptic tick on send actions (guarded; desktop ignores it).
    try { navigator.vibrate?.(10); } catch { /* intentionally ignored */}
    onSelectSticker(s);
  };

  // Plain render helper (not a sub-component: with the React 19 types in
  // this project, `key` is not accepted on custom components).
  // Animated stickers preview live: the emoji itself animates on the tile.
  // W30j (#216): stickers with bundled real art (`s.image`) render the
  // image; emoji-only packs still render the emoji glyph as before.
  const renderStickerTile = (s: AnimatedStickerDef) => {
    const anim = s.animation || ANIM_BY_ID[s.id] || 'none';
    const fav = favourites.some((f) => f.id === s.id);
    const isCustom = s.pack === MY_STICKERS_PACK;
    // Wave-2 S11 (WA "Sticker with: {emojis}"): the sticker's emoji tags
    // are shown on hover (title) and to screen readers (aria-label).
    const tags = stickerEmojiTags(s);
    const tagsText = `Sticker with: ${tags.join(' ')}`;
    // WA parity S10: an image-backed sticker whose art failed to load
    // shows the emoji fallback + a Retry pill (WA: "Sticker couldn't
    // load, retry available") instead of a broken tile.
    const imgFailed = !!s.image && failedImages.has(s.id);
    return (
      <div
        key={s.id}
        className="relative"
        data-sticker-failed={imgFailed ? s.id : undefined}
        onContextMenu={(e) => { e.preventDefault(); if (Date.now() - lpFiredAtRef.current < 800) return; toggleFav(s); }}
        // WA parity S10: long-press (500 ms, finger still) opens the
        // sticker details sheet; a plain tap still sends immediately.
        onPointerDown={(e) => {
          lpStartRef.current = { x: e.clientX, y: e.clientY };
          lpFiredRef.current = false;
          clearLongPress();
          lpTimerRef.current = window.setTimeout(() => {
            lpFiredRef.current = true;
            lpFiredAtRef.current = Date.now();
            try { navigator.vibrate?.(15); } catch { /* intentionally ignored */ }
            setCopyNote('');
            setDetailsSticker(s);
          }, 500);
        }}
        onPointerMove={(e) => {
          const start = lpStartRef.current;
          if (start && (Math.abs(e.clientX - start.x) > 12 || Math.abs(e.clientY - start.y) > 12)) clearLongPress();
        }}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
      >
        <button
          onClick={() => {
            // A long-press just opened the details sheet — don't also send.
            if (lpFiredRef.current) { lpFiredRef.current = false; return; }
            pickSticker(s);
          }}
          title={`${s.label}${anim !== 'none' ? ' (animated)' : ''} — ${tagsText} — long-press for details`}
          aria-label={`Send sticker: ${s.label}, ${tagsText}${anim !== 'none' ? ' (animated)' : ''} — long-press for details`}
          className={`aspect-square w-full rounded-2xl bg-gradient-to-br ${s.bg} flex items-center justify-center text-3xl hover:scale-110 active:scale-95 transition-transform shadow-sm relative`}
        >
          {s.image && !imgFailed ? (
            <img
              key={`${s.id}-r${retryTick[s.id] || 0}`}
              src={s.image}
              alt={s.label}
              draggable={false}
              loading="lazy"
              onError={() => markStickerImageFailed(s.id)}
              className="h-10 w-10 object-contain drop-shadow-sm pointer-events-none"
            />
          ) : (
            <span className="drop-shadow-sm" style={stickerAnimationStyle(anim)}>
              {s.art}
            </span>
          )}
          {anim !== 'none' && (
            <span className="absolute bottom-1 right-1 text-[8px] font-bold bg-black/40 text-white rounded px-1 py-px leading-none">
              ▶
            </span>
          )}
        </button>
        {imgFailed && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); retryStickerImage(s.id); }}
            aria-label={`Retry loading sticker: ${s.label}`}
            title="Sticker couldn't load — tap to retry"
            data-sticker-retry={s.id}
            className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-black/60 text-white text-[9px] font-semibold shadow"
          >
            <RotateCcw className="h-3 w-3" /> Retry
          </button>
        )}
        {/* Favourite toggle (WA: long-press → Add to favourites; the star
            button is the same action, clickable in the picker). */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleFav(s); }}
          aria-label={fav ? `Remove from favourites: ${s.label}` : `Add to favourites: ${s.label}`}
          aria-pressed={fav}
          title={fav ? 'Remove from favourites' : 'Add to favourites (or long-press the sticker)'}
          className={`absolute -top-1 -right-1 h-6 w-6 rounded-full flex items-center justify-center shadow ${fav ? 'bg-amber-400 text-white' : 'bg-white/90 dark:bg-black/60 text-gray-400 hover:text-amber-400'}`}
        >
          <Star className={`h-3.5 w-3.5 ${fav ? 'fill-current' : ''}`} />
        </button>
        {isCustom && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeCustomSticker(s.id); setCustomTick((t) => t + 1); }}
            aria-label={`Delete my sticker: ${s.label}`}
            title="Delete this sticker"
            className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-white/90 dark:bg-black/60 text-gray-400 hover:text-red-500 flex items-center justify-center shadow text-[10px] font-bold"
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // ── WA parity S10: sticker details helpers ──
  /** Pack info for the details sheet: sticker count, kind, description. */
  const packMeta = (packName: string) => {
    const count = allStickers.filter((x) => x.pack === packName).length;
    const anim = ANIMATED_STICKER_PACKS.find((p) => p.name === packName);
    if (anim) return { count, kind: 'Animated pack', description: anim.description };
    if (packName === AVATAR_PACK_NAME) return { count, kind: 'Avatar pack', description: 'Stickers made from your avatar.' };
    if (packName === MY_STICKERS_PACK) return { count, kind: 'My Stickers', description: 'Stickers you made from photos.' };
    const hasArt = allStickers.some((x) => x.pack === packName && x.image);
    return {
      count,
      kind: hasArt ? 'Real-art pack' : 'Emoji pack',
      description: hasArt ? 'Bundled sticker art — works offline.' : 'Emoji stickers — works offline.',
    };
  };

  /** WA "Copy sticker image": image stickers copy as an image via the
   *  Clipboard API; emoji-only stickers copy their glyph as text. If the
   *  browser blocks the image write, fall back to copying the image URL
   *  (or the glyph) as text and say so honestly instead of failing
   *  silently. */
  const copyStickerImage = async (s: AnimatedStickerDef) => {
    setCopyNote('');
    try {
      if (s.image) {
        const res = await fetch(s.image);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const type = blob.type || 'image/png';
        await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
        setCopyNote('Sticker image copied ✓');
        return;
      }
      await navigator.clipboard.writeText(s.art);
      setCopyNote('Sticker copied ✓');
    } catch {
      try {
        await navigator.clipboard.writeText(s.image || s.art);
        setCopyNote(s.image
          ? 'Image copy was blocked — copied the sticker link instead.'
          : "Couldn't copy the image — copied the sticker instead.");
      } catch {
        setCopyNote("Couldn't copy this sticker — clipboard access was blocked.");
      }
    }
  };

  /** WA "View sticker pack": filter the picker to this sticker's pack.
   *  A disabled animated pack is re-enabled first so the grid isn't empty. */
  const viewStickerPack = (s: AnimatedStickerDef) => {
    if (ANIMATED_STICKER_PACKS.some((p) => p.name === s.pack) && !enabledPacks.includes(s.pack)) {
      togglePack(s.pack);
    }
    setCategory(s.pack);
    setDetailsSticker(null);
  };

  // Tapping a category clears any free-text search (WA: the tab sets
  // the section / search text) and loads that category's GIFs.
  const pickGifCategory = (id: GifCategoryId) => {
    setGifQuery('');
    setGifCategory(id);
  };

  const pickGif = (g: GifDef) => {
    // WA parity Media G6: the provider attribution rides along so a
    // re-sent recent keeps it (see stickerPack.ts `rememberGif`).
    rememberGif(g.url, g.attribution);
    try { navigator.vibrate?.(10); } catch { /* intentionally ignored */}
    onSelectGif(g);
  };

  // Plain render helper (not a sub-component: see renderStickerTile above).
  // A failed preview renders a grey "GIF" placeholder tile instead of
  // removing the tile from the DOM — the tile stays clickable, so the GIF
  // can still be sent if its full-size URL loads.
  const renderGifTile = (g: GifDef, previewFailed: boolean, onPreviewError: () => void) => (
    <button
      key={g.id}
      onClick={() => pickGif(g)}
      className="aspect-[4/3] rounded-xl overflow-hidden bg-gray-100 dark:bg-input-dark hover:opacity-90 transition-opacity"
      title={g.title}
    >
      {previewFailed ? (
        <span className="flex h-full w-full items-center justify-center bg-gray-200 dark:bg-white/10 text-xs font-semibold text-gray-400">
          GIF
        </span>
      ) : (
        <img
          src={g.previewUrl}
          alt={g.title}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={onPreviewError}
        />
      )}
    </button>
  );

  const sendGifByLink = () => {
    const url = gifUrlInput.trim();
    if (!/^https?:\/\/.+/i.test(url)) {
      setGifUrlError('Paste a full https:// link to a GIF or image.');
      return;
    }
    setGifUrlError('');
    setGifUrlInput('');
    pickGif({ id: `link-${Date.now()}`, url, previewUrl: url, title: 'GIF' });
  };

  const gifGridEmpty = !gifLoading && !gifError && gifs.length === 0;
  // The API returned GIFs, but every preview failed to load — the grid
  // is full of placeholder tiles, so say so instead of looking empty.
  const allGifPreviewsFailed =
    !gifLoading && !gifError && gifs.length > 0 && gifs.every((g) => failedGifPreviews.has(g.id));

  const body = (
    <>
      {/* Keyframes for the animated sticker packs (no new dependency). */}
      <style>{STICKER_KEYFRAMES}</style>
      {/* Tab bar — hidden in bare mode: the CombinedPicker host renders
          the shared Emoji / GIF / Sticker tab bar (and close button). */}
      {!bare && (
      <div className="flex items-center gap-1 px-3 pt-2">
        {(
          [
            { id: 'stickers', label: 'Stickers', icon: <StickerIcon className="h-4 w-4" /> },
            { id: 'gifs', label: 'GIFs', icon: <ImagePlay className="h-4 w-4" /> },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              tab === t.id
                ? 'bg-green-cta text-white'
                : 'text-gray-500 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-input-dark'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
        <button
          onClick={onClose}
          aria-label="Close sticker picker"
          className="ml-auto p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-input-dark"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      )}

      {tab === 'stickers' ? (
        <div className="p-3 pt-2">
          {/* Search */}
          <div className="flex items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5 mb-2">
            <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search stickers…"
              className="flex-1 bg-transparent text-sm outline-none text-gray-900 dark:text-text-primary placeholder:text-gray-400"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-gray-400">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Wave-2 S11: an emoji search shows the matched emoji as the
              WA "Sticker with: {emojis}" line above the results. */}
          {queryEmojis.length > 0 && visibleStickers.length > 0 && (
            <p data-sticker-emoji-match className="text-[11px] text-gray-400 px-1 pb-2">
              Sticker with: {queryEmojis.join(' ')}
            </p>
          )}

          {/* Categories (static packs + enabled animated packs, ✨-marked) */}
          <div className="flex gap-1.5 overflow-x-auto pb-2">
            {['All', ...packNames].map((name) => {
              const isAnimated = enabledPacks.includes(name);
              return (
                <button
                  key={name}
                  onClick={() => setCategory(name)}
                  className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    category === name
                      ? 'bg-primary-green/15 text-primary-green'
                      : 'bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary'
                  }`}
                >
                  {isAnimated ? `✨ ${name}` : name}
                </button>
              );
            })}
          </div>

          {/* Avatar — create / edit entry (nightshift §4). */}
          <button
            type="button"
            onClick={() => setShowCreator(true)}
            className="w-full flex items-center gap-2 px-3 py-2 mb-2 rounded-2xl bg-gray-100 dark:bg-input-dark text-left"
            aria-label={avatarTraits ? 'Edit your avatar' : 'Create your avatar'}
          >
            {avatarTraits ? (
              <img
                src={avatarStickers[0]?.image}
                alt=""
                className="h-9 w-9 rounded-xl flex-shrink-0"
                draggable={false}
              />
            ) : (
              <span className="h-9 w-9 rounded-xl bg-primary-green/15 text-primary-green flex items-center justify-center text-lg font-bold flex-shrink-0">
                +
              </span>
            )}
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-semibold text-gray-900 dark:text-text-primary">
                {avatarTraits ? 'Your avatar' : 'Create your avatar'}
              </span>
              <span className="block text-[11px] text-gray-400 truncate">
                {avatarTraits ? 'Tap to edit your traits' : 'Pick your traits and get your own sticker pack'}
              </span>
            </span>
            <span className="text-xs font-semibold text-primary-green flex-shrink-0">
              {avatarTraits ? 'Edit' : 'Create'}
            </span>
          </button>

          {/* Create sticker from a photo (WA S5) — cutout-lite, local pack. */}
          <button
            type="button"
            onClick={() => createInputRef.current?.click()}
            className="w-full flex items-center gap-2 px-3 py-2 mb-2 rounded-2xl bg-gray-100 dark:bg-input-dark text-left"
            aria-label="Create sticker from a photo"
          >
            <span className="h-9 w-9 rounded-xl bg-primary-green/15 text-primary-green flex items-center justify-center flex-shrink-0">
              <Scissors className="h-4 w-4" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-semibold text-gray-900 dark:text-text-primary">Create sticker</span>
              <span className="block text-[11px] text-gray-400 truncate">Cut a photo into a sticker for My Stickers</span>
            </span>
            <span className="text-xs font-semibold text-primary-green flex-shrink-0">New</span>
          </button>
          <input
            ref={createInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label="Choose a photo to turn into a sticker"
            onChange={(e) => { onCreateStickerFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          {createNote && (
            <p className="text-[11px] text-primary-green px-1 pb-2">{createNote}</p>
          )}
          {favNote && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 px-1 pb-2">{favNote}</p>
          )}

          {/* Favourites (WA S3) — top section, long-press / star to add. */}
          {!query.trim() && category === 'All' && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                Favourites {favourites.length > 0 && `· ${favourites.length}`}
              </p>
              {favourites.length === 0 ? (
                <p className="text-xs text-gray-400 pb-2">You haven&apos;t favorited any stickers yet — tap the star on a sticker to add it.</p>
              ) : (
                <div className="grid grid-cols-6 gap-2 mb-3">
                  {favourites.map((s) => renderStickerTile(s as AnimatedStickerDef))}
                </div>
              )}
            </>
          )}

          {/* Recents */}
          {recentStickers.length > 0 && !query.trim() && category === 'All' && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                Recent
              </p>
              <div className="grid grid-cols-6 gap-2 mb-3">
                {recentStickers.map((s) => renderStickerTile(s))}
              </div>
            </>
          )}

          {/* Grid */}
          {category === AVATAR_PACK_NAME && !avatarTraits ? (
            <div className="text-center py-6">
              <p className="text-xs text-gray-400 mb-3">
                You have not created an avatar yet.
              </p>
              <button
                onClick={() => setShowCreator(true)}
                className="px-4 py-2 min-h-[44px] rounded-full bg-green-cta text-white text-xs font-semibold"
              >
                Create your avatar
              </button>
            </div>
          ) : visibleStickers.length === 0 ? (
            <p className="text-center text-xs text-gray-400 py-6">
              No stickers match “{query}”. Try another word.
            </p>
          ) : (
            <div className="grid grid-cols-6 gap-2 max-h-44 overflow-y-auto">
              {visibleStickers.map((s) => renderStickerTile(s))}
            </div>
          )}

          {/* Animated packs — add / remove (persisted in localStorage). */}
          <div className="mt-3 pt-2 border-t border-gray-100 dark:border-white/5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
              Animated packs
            </p>
            <div className="space-y-1.5">
              {ANIMATED_STICKER_PACKS.map((p) => {
                const enabled = enabledPacks.includes(p.name);
                return (
                  <div key={p.name} className="flex items-center gap-2">
                    <span className="text-xl w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 dark:bg-input-dark flex-shrink-0">
                      <span style={stickerAnimationStyle(p.stickers[0]?.animation)}>
                        {p.icon}
                      </span>
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-900 dark:text-text-primary truncate">
                        {p.name} <span className="font-normal text-gray-400">· {p.stickers.length} stickers</span>
                      </p>
                      <p className="text-[11px] text-gray-400 truncate">{p.description}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => togglePack(p.name)}
                      aria-pressed={enabled}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold flex-shrink-0 transition-colors ${
                        enabled
                          ? 'bg-primary-green/15 text-primary-green'
                          : 'bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary'
                      }`}
                    >
                      {enabled ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                      {enabled ? 'Added' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 mt-1.5">
              Animated stickers are CSS-animated emoji — they play without
              downloads and still show as a static emoji on older clients.
            </p>
          </div>
        </div>
      ) : (
        <div className="p-3 pt-2">
          {/* GIF search — Giphy only (FIX-REPORT-3 §18), cache-first. */}
          <>
            <div className="flex items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5 mb-2">
              <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <input
                value={gifQuery}
                onChange={(e) => setGifQuery(e.target.value)}
                placeholder="Search GIFs… (powered by Giphy)"
                className="flex-1 bg-transparent text-sm outline-none text-gray-900 dark:text-text-primary placeholder:text-gray-400"
              />
              {gifQuery && (
                <button onClick={() => setGifQuery('')} className="text-gray-400">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {/* GIF categories (WA G3) — same chip style as the sticker
                category row above. */}
            <div
              className="flex gap-1.5 overflow-x-auto pb-2"
              role="tablist"
              aria-label="GIF categories"
            >
              {GIF_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  role="tab"
                  aria-selected={gifCategory === c.id}
                  onClick={() => pickGifCategory(c.id)}
                  className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    gifCategory === c.id
                      ? 'bg-primary-green/15 text-primary-green'
                      : 'bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {gifNote && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 px-1 pb-2">
                {gifNote}
              </p>
            )}
            {gifLoading && <p className="text-center text-xs text-gray-400 py-6">Loading GIFs…</p>}
            {gifError && (
              <p className="text-center text-xs text-red-400 py-6">
                {gifError} Try again, or use a sticker instead.
              </p>
            )}
            {gifGridEmpty && (
              <p className="text-center text-xs text-gray-400 py-6">
                {gifQuery.trim()
                  ? `No GIFs found for “${gifQuery}”. Try another word.`
                  : 'No GIFs available right now. Try again later.'}
              </p>
            )}
            {allGifPreviewsFailed && (
              <p className="text-center text-xs text-gray-400 py-6">
                GIF previews couldn&apos;t load. Check your connection, or try a search.
              </p>
            )}
            <div className="grid grid-cols-3 gap-2 max-h-44 overflow-y-auto">
              {gifs.map((g) =>
                renderGifTile(g, failedGifPreviews.has(g.id), () => markGifPreviewFailed(g.id)),
              )}
            </div>
          </>

          {/* Paste-a-GIF-link — works with or without a key */}
          <div className="flex items-center gap-2 mt-2">
            <div className="flex flex-1 items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5">
              <Link2 className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <input
                value={gifUrlInput}
                onChange={(e) => setGifUrlInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendGifByLink();
                }}
                placeholder="Paste a GIF link… https://"
                className="flex-1 bg-transparent text-sm outline-none text-gray-900 dark:text-text-primary placeholder:text-gray-400 min-w-0"
              />
            </div>
            <button
              onClick={sendGifByLink}
              disabled={!gifUrlInput.trim()}
              className="px-3 py-1.5 rounded-full bg-green-cta text-white text-xs font-semibold disabled:opacity-40"
            >
              Send
            </button>
          </div>
          {gifUrlError && <p className="text-[11px] text-red-400 mt-1 px-1">{gifUrlError}</p>}

          {/* Recent GIFs */}
          {recentGifs.length > 0 && (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1.5">
                Recent GIFs
              </p>
              <div className="grid grid-cols-3 gap-2 max-h-28 overflow-y-auto">
                {recentGifs.map((g) =>
                  renderGifTile(g, failedRecentPreviews.has(g.id), () => markRecentPreviewFailed(g.id)),
                )}
              </div>
            </>
          )}
        </div>
      )}
      {/* ── WA parity S10: sticker details sheet ── */}
      {detailsSticker && (() => {
        const s = detailsSticker;
        const meta = packMeta(s.pack);
        const imgFailed = !!s.image && failedImages.has(s.id);
        const fav = favourites.some((f) => f.id === s.id);
        return (
          <div
            data-sticker-details
            role="dialog"
            aria-modal="true"
            aria-label="Sticker details"
            className="fixed inset-0 z-50 flex items-end justify-center"
          >
            <button
              aria-label="Close sticker details"
              onClick={() => setDetailsSticker(null)}
              className="absolute inset-0 bg-black/50"
            />
            <div className="relative w-full max-w-md rounded-t-3xl bg-white dark:bg-panel-dark p-4 pb-6 shadow-xl max-h-[85vh] overflow-y-auto">
              <div className="flex items-center gap-2 mb-3">
                <h2 className="flex-1 text-base font-semibold text-gray-900 dark:text-text-primary">Sticker details</h2>
                <button
                  onClick={() => setDetailsSticker(null)}
                  aria-label="Close sticker details"
                  className="p-1.5 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-input-dark"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {/* Preview */}
              <div className={`mx-auto mb-3 flex h-28 w-28 items-center justify-center rounded-3xl bg-gradient-to-br ${s.bg} text-6xl shadow-sm`}>
                {s.image && !imgFailed ? (
                  <img
                    key={`details-${s.id}-r${retryTick[s.id] || 0}`}
                    src={s.image}
                    alt={s.label}
                    draggable={false}
                    onError={() => markStickerImageFailed(s.id)}
                    className="h-20 w-20 object-contain drop-shadow-sm"
                  />
                ) : (
                  <span style={stickerAnimationStyle(s.animation || ANIM_BY_ID[s.id] || 'none')}>
                    {s.art}
                  </span>
                )}
              </div>
              {imgFailed && (
                <p className="text-center text-xs text-amber-600 dark:text-amber-400 mb-2">
                  Sticker couldn&apos;t load, retry available.
                  <button
                    type="button"
                    onClick={() => retryStickerImage(s.id)}
                    aria-label={`Retry loading sticker: ${s.label}`}
                    className="ml-2 font-semibold underline"
                  >
                    Retry
                  </button>
                </p>
              )}
              <p className="text-center text-sm font-semibold text-gray-900 dark:text-text-primary">{s.label}</p>
              <p className="text-center text-xs text-gray-400 mb-3">
                {meta.kind}{s.animation && s.animation !== 'none' ? ' · Animated' : ''}
              </p>
              {/* Sticker pack info */}
              <div className="rounded-2xl bg-gray-100 dark:bg-input-dark p-3 mb-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5 flex items-center gap-1">
                  <Info className="h-3.5 w-3.5" /> Sticker pack info
                </p>
                <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">{s.pack}</p>
                <p className="text-xs text-gray-400">
                  {meta.count} sticker{meta.count === 1 ? '' : 's'} · {meta.description}
                </p>
                <button
                  type="button"
                  onClick={() => viewStickerPack(s)}
                  aria-label="View sticker pack"
                  className="mt-2 text-xs font-semibold text-primary-green"
                >
                  View sticker pack →
                </button>
              </div>
              {/* WA pack detail view: preview grid of the same pack —
                  tapping a thumbnail switches the details to that sticker. */}
              {(() => {
                const packStickers = allStickers.filter((x) => x.pack === s.pack);
                const shown = detailsShowAll ? packStickers : packStickers.slice(0, 8);
                if (packStickers.length < 2) return null;
                return (
                  <div className="mb-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
                      In this pack · {meta.count} sticker{meta.count === 1 ? '' : 's'}
                    </p>
                    <div className="grid grid-cols-4 gap-1.5">
                      {shown.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => { setCopyNote(''); setDetailsSticker(p); }}
                          aria-label={`View details: ${p.label}`}
                          title={p.label}
                          className={`aspect-square rounded-2xl bg-gradient-to-br ${p.bg} flex items-center justify-center text-2xl shadow-sm ${
                            p.id === s.id ? 'ring-2 ring-primary-green' : ''
                          }`}
                        >
                          {p.image && !failedImages.has(p.id) ? (
                            <img src={p.image} alt={p.label} draggable={false} loading="lazy" className="h-8 w-8 object-contain drop-shadow-sm pointer-events-none" />
                          ) : (
                            <span style={stickerAnimationStyle(p.animation || ANIM_BY_ID[p.id] || 'none')}>{p.art}</span>
                          )}
                        </button>
                      ))}
                    </div>
                    {packStickers.length > 8 && (
                      <button
                        type="button"
                        onClick={() => setDetailsShowAll((v) => !v)}
                        aria-expanded={detailsShowAll}
                        aria-label={detailsShowAll ? 'Show fewer stickers in this pack' : `Show all ${packStickers.length} stickers in this pack`}
                        className="mt-1.5 w-full text-center text-xs font-semibold text-primary-green py-1.5 min-h-[32px]"
                      >
                        {detailsShowAll ? 'Show less' : `Show all ${packStickers.length} stickers`}
                      </button>
                    )}
                  </div>
                );
              })()}
              {/* WA pack detail view: add / remove the pack. Only the
                  animated packs are toggleable (persisted in localStorage,
                  same as the pack list below the grid); built-in packs are
                  bundled and always available. */}
              {ANIMATED_STICKER_PACKS.some((p) => p.name === s.pack) ? (
                <button
                  type="button"
                  onClick={() => togglePack(s.pack)}
                  aria-pressed={enabledPacks.includes(s.pack)}
                  aria-label={enabledPacks.includes(s.pack) ? `Remove pack: ${s.pack}` : `Add pack: ${s.pack}`}
                  className="w-full flex items-center justify-center gap-2 rounded-full bg-gray-100 dark:bg-input-dark py-2.5 text-sm font-semibold text-gray-900 dark:text-text-primary min-h-[44px] mb-2"
                >
                  {enabledPacks.includes(s.pack) ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  {enabledPacks.includes(s.pack) ? 'Remove pack' : 'Add pack'}
                </button>
              ) : (
                <p className="text-center text-[11px] text-gray-400 mb-2">Built-in pack — always available in Pinglo.</p>
              )}
              {/* Actions */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => { pickSticker(s); setDetailsSticker(null); }}
                  aria-label="Send sticker"
                  className="w-full flex items-center justify-center gap-2 rounded-full bg-green-cta py-2.5 text-sm font-semibold text-white min-h-[44px]"
                >
                  <Send className="h-4 w-4" /> Send sticker
                </button>
                <button
                  type="button"
                  onClick={() => void copyStickerImage(s)}
                  aria-label="Copy sticker image"
                  className="w-full flex items-center justify-center gap-2 rounded-full bg-gray-100 dark:bg-input-dark py-2.5 text-sm font-semibold text-gray-900 dark:text-text-primary min-h-[44px]"
                >
                  <Copy className="h-4 w-4" /> Copy sticker image
                </button>
                <button
                  type="button"
                  onClick={() => toggleFav(s)}
                  aria-pressed={fav}
                  aria-label={fav ? `Remove from favourites: ${s.label}` : `Add to favourites: ${s.label}`}
                  className="w-full flex items-center justify-center gap-2 rounded-full bg-gray-100 dark:bg-input-dark py-2.5 text-sm font-semibold text-gray-900 dark:text-text-primary min-h-[44px]"
                >
                  <Star className={`h-4 w-4 ${fav ? 'fill-amber-400 text-amber-400' : ''}`} />
                  {fav ? 'Remove from favourites' : 'Add to favourites'}
                </button>
              </div>
              {copyNote && (
                <p className="text-center text-[11px] text-primary-green mt-2">{copyNote}</p>
              )}
            </div>
          </div>
        );
      })()}
      {showCreator && (
        <AvatarCreator
          onClose={() => setShowCreator(false)}
          onSaved={() => setAvatarTraits(loadAvatarTraits())}
        />
      )}
    </>
  );

  if (bare) return body;
  return (
    <div
      data-sticker-picker
      className="bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5 max-h-[320px] overflow-y-auto"
    >
      {body}
    </div>
  );
}
