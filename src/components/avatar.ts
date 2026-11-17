/**
 * Avatar stickers v1 — manual trait picker (nightshift, §4).
 *
 * No AI, no photo, no server: the user picks traits and the avatar is
 * composed locally from SVG shape layers (pure string functions, no
 * network, nothing leaves the device). The composed avatar is rendered
 * as a data-URI SVG and sent through the EXISTING sticker path
 * (`stickerImage` on the message, ChatScreen renders it as an <img>),
 * so old clients still see the emoji fallback in `stickerEmoji`.
 *
 * Traits are stored in localStorage (`dt_avatar_traits`) — local-only
 * by design. A future phase can sync them to the user doc; v1 does not
 * touch the backend (no .env, no server work in this wave).
 *
 * Pure functions deserving first tests (no test runner in the repo):
 * `avatarSvg`, `avatarDataUrl`, `buildAvatarStickers`, `parseAvatarTraits`.
 */

import type { StickerDef } from './stickerPack';

// ── Trait types (narrow unions, not strings) ───────────────────────────────

export type SkinTone = 'fair' | 'light' | 'medium' | 'tan' | 'deep';
export type FaceShape = 'round' | 'oval' | 'square';
export type HairStyle = 'short' | 'curly' | 'long' | 'buzz' | 'bun' | 'bald';
export type HairColour = 'black' | 'brown' | 'blonde' | 'red' | 'grey';
export type EyeColour = 'brown' | 'black' | 'blue' | 'green' | 'hazel';
export type BrowStyle = 'natural' | 'thick' | 'arched';
export type OutfitColour = 'green' | 'blue' | 'red' | 'purple' | 'yellow' | 'grey';
export type Accessory = 'none' | 'glasses' | 'sunglasses' | 'earrings';
export type AvatarExpression =
  | 'happy'
  | 'laughing'
  | 'love'
  | 'wink'
  | 'cool'
  | 'party'
  | 'sad'
  | 'surprised';

export interface AvatarTraits {
  skinTone: SkinTone;
  faceShape: FaceShape;
  hairStyle: HairStyle;
  hairColour: HairColour;
  eyeColour: EyeColour;
  browStyle: BrowStyle;
  outfitColour: OutfitColour;
  accessory: Accessory;
}

export const DEFAULT_AVATAR_TRAITS: AvatarTraits = {
  skinTone: 'medium',
  faceShape: 'round',
  hairStyle: 'short',
  hairColour: 'black',
  eyeColour: 'brown',
  browStyle: 'natural',
  outfitColour: 'green',
  accessory: 'none',
};

// ── Labelled option lists (a11y: every option has a text label, never
//    colour-only — skin tones are named, not just swatches) ────────────────

export const SKIN_TONES: { value: SkinTone; label: string; colour: string }[] = [
  { value: 'fair', label: 'Fair', colour: '#ffe0bd' },
  { value: 'light', label: 'Light', colour: '#f1c27d' },
  { value: 'medium', label: 'Medium', colour: '#e0ac69' },
  { value: 'tan', label: 'Tan', colour: '#c68642' },
  { value: 'deep', label: 'Deep', colour: '#8d5524' },
];

export const FACE_SHAPES: { value: FaceShape; label: string }[] = [
  { value: 'round', label: 'Round' },
  { value: 'oval', label: 'Oval' },
  { value: 'square', label: 'Square' },
];

export const HAIR_STYLES: { value: HairStyle; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'curly', label: 'Curly' },
  { value: 'long', label: 'Long' },
  { value: 'buzz', label: 'Buzz' },
  { value: 'bun', label: 'Bun' },
  { value: 'bald', label: 'Bald' },
];

export const HAIR_COLOURS: { value: HairColour; label: string; colour: string }[] = [
  { value: 'black', label: 'Black', colour: '#1f1a17' },
  { value: 'brown', label: 'Brown', colour: '#6b4226' },
  { value: 'blonde', label: 'Blonde', colour: '#e8c268' },
  { value: 'red', label: 'Red', colour: '#a34a28' },
  { value: 'grey', label: 'Grey', colour: '#9a9a9a' },
];

export const EYE_COLOURS: { value: EyeColour; label: string; colour: string }[] = [
  { value: 'brown', label: 'Brown', colour: '#5b3a1e' },
  { value: 'black', label: 'Black', colour: '#1a1a1a' },
  { value: 'blue', label: 'Blue', colour: '#3b7dd8' },
  { value: 'green', label: 'Green', colour: '#3d8b4f' },
  { value: 'hazel', label: 'Hazel', colour: '#7a6a2f' },
];

export const BROW_STYLES: { value: BrowStyle; label: string }[] = [
  { value: 'natural', label: 'Natural' },
  { value: 'thick', label: 'Thick' },
  { value: 'arched', label: 'Arched' },
];

export const OUTFIT_COLOURS: { value: OutfitColour; label: string; colour: string }[] = [
  { value: 'green', label: 'Green', colour: '#075e54' },
  { value: 'blue', label: 'Blue', colour: '#2563eb' },
  { value: 'red', label: 'Red', colour: '#dc2626' },
  { value: 'purple', label: 'Purple', colour: '#7c3aed' },
  { value: 'yellow', label: 'Yellow', colour: '#d97706' },
  { value: 'grey', label: 'Grey', colour: '#64748b' },
];

export const ACCESSORIES: { value: Accessory; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'glasses', label: 'Glasses' },
  { value: 'sunglasses', label: 'Sunglasses' },
  { value: 'earrings', label: 'Earrings' },
];

// ── Persistence (local-only) ───────────────────────────────────────────────

export const AVATAR_TRAITS_KEY = 'dt_avatar_traits';

export function loadAvatarTraits(): AvatarTraits | null {
  try {
    const raw = localStorage.getItem(AVATAR_TRAITS_KEY);
    if (!raw) return null;
    return parseAvatarTraits(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveAvatarTraits(traits: AvatarTraits): void {
  try {
    localStorage.setItem(AVATAR_TRAITS_KEY, JSON.stringify(traits));
  } catch {
    // Private mode / full storage: the avatar is best-effort, never fatal.
  }
}

export function deleteAvatarTraits(): void {
  try {
    localStorage.removeItem(AVATAR_TRAITS_KEY);
  } catch {
    // Best-effort only.
  }
}

/** Validate unknown input into traits; unknown/invalid values fall back
 *  to the default for that field (never throws, never trusts the store). */
export function parseAvatarTraits(input: unknown): AvatarTraits | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  return {
    skinTone: pick(o.skinTone, SKIN_TONES.map((s) => s.value), DEFAULT_AVATAR_TRAITS.skinTone),
    faceShape: pick(o.faceShape, FACE_SHAPES.map((s) => s.value), DEFAULT_AVATAR_TRAITS.faceShape),
    hairStyle: pick(o.hairStyle, HAIR_STYLES.map((s) => s.value), DEFAULT_AVATAR_TRAITS.hairStyle),
    hairColour: pick(o.hairColour, HAIR_COLOURS.map((s) => s.value), DEFAULT_AVATAR_TRAITS.hairColour),
    eyeColour: pick(o.eyeColour, EYE_COLOURS.map((s) => s.value), DEFAULT_AVATAR_TRAITS.eyeColour),
    browStyle: pick(o.browStyle, BROW_STYLES.map((s) => s.value), DEFAULT_AVATAR_TRAITS.browStyle),
    outfitColour: pick(o.outfitColour, OUTFIT_COLOURS.map((s) => s.value), DEFAULT_AVATAR_TRAITS.outfitColour),
    accessory: pick(o.accessory, ACCESSORIES.map((s) => s.value), DEFAULT_AVATAR_TRAITS.accessory),
  };
}

// ── SVG composition (pure, cheap string building) ──────────────────────────

const SKIN: Record<SkinTone, string> = {
  fair: '#ffe0bd',
  light: '#f1c27d',
  medium: '#e0ac69',
  tan: '#c68642',
  deep: '#8d5524',
};
const HAIR: Record<HairColour, string> = {
  black: '#1f1a17',
  brown: '#6b4226',
  blonde: '#e8c268',
  red: '#a34a28',
  grey: '#9a9a9a',
};
const EYE: Record<EyeColour, string> = {
  brown: '#5b3a1e',
  black: '#1a1a1a',
  blue: '#3b7dd8',
  green: '#3d8b4f',
  hazel: '#7a6a2f',
};
const OUTFIT: Record<OutfitColour, string> = {
  green: '#075e54',
  blue: '#2563eb',
  red: '#dc2626',
  purple: '#7c3aed',
  yellow: '#d97706',
  grey: '#64748b',
};

function facePath(shape: FaceShape, skin: string): string {
  if (shape === 'oval') return `<ellipse cx="60" cy="58" rx="30" ry="37" fill="${skin}"/>`;
  if (shape === 'square')
    return `<rect x="30" y="22" width="60" height="72" rx="14" fill="${skin}"/>`;
  return `<circle cx="60" cy="58" r="33" fill="${skin}"/>`;
}

function hairLayer(style: HairStyle, colour: string): string {
  switch (style) {
    case 'bald':
      return '';
    case 'buzz':
      return `<path d="M30 52 Q28 22 60 20 Q92 22 90 52 Q82 30 60 30 Q38 30 30 52Z" fill="${colour}"/>`;
    case 'curly':
      return `<g fill="${colour}"><circle cx="36" cy="32" r="9"/><circle cx="48" cy="24" r="10"/><circle cx="62" cy="22" r="10"/><circle cx="76" cy="26" r="9"/><circle cx="86" cy="36" r="8"/><circle cx="32" cy="44" r="7"/><circle cx="88" cy="46" r="7"/></g>`;
    case 'long':
      return `<path d="M28 58 Q24 18 60 16 Q96 18 92 58 L92 96 Q88 100 84 96 L84 56 Q84 30 60 30 Q36 30 36 56 L36 96 Q32 100 28 96Z" fill="${colour}"/>`;
    case 'bun':
      return `<path d="M30 52 Q28 22 60 20 Q92 22 90 52 Q82 30 60 30 Q38 30 30 52Z" fill="${colour}"/><circle cx="60" cy="16" r="9" fill="${colour}"/>`;
    case 'short':
    default:
      return `<path d="M29 54 Q26 20 60 18 Q94 20 91 54 Q86 32 60 32 Q34 32 29 54Z" fill="${colour}"/>`;
  }
}

function browLayer(style: BrowStyle, colour: string): string {
  const w = style === 'thick' ? 3.4 : 2.2;
  // Every path must start with a moveto — a path starting with Q renders
  // nothing (Ponytail review of this diff: arched brows were invisible).
  const arch = style === 'arched' ? 'M40 54 Q46 48 52 52' : 'M40 52 L52 51';
  const arch2 = style === 'arched' ? 'M68 52 Q74 48 80 54' : 'M80 52 L68 51';
  return `<g stroke="${colour}" stroke-width="${w}" stroke-linecap="round" fill="none"><path d="${arch}"/><path d="${arch2}"/></g>`;
}

function eyeLayer(expr: AvatarExpression, eye: string): string {
  const happy = expr === 'happy' || expr === 'laughing' || expr === 'love';
  const wink = expr === 'wink';
  const cool = expr === 'cool';
  if (cool) {
    return `<g stroke="#1a1a1a" stroke-width="2.5" fill="none"><path d="M38 58 L52 58"/><path d="M68 58 L82 58"/></g>`;
  }
  if (happy) {
    return `<g stroke="${eye}" stroke-width="2.4" stroke-linecap="round" fill="none"><path d="M39 60 Q46 53 53 60"/><path d="M67 60 Q74 53 81 60"/></g>`;
  }
  if (wink) {
    return `<circle cx="46" cy="59" r="4" fill="${eye}"/><path d="M67 60 Q74 54 81 60" stroke="${eye}" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
  }
  if (expr === 'sad') {
    return `<g fill="${eye}"><circle cx="46" cy="60" r="3.6"/><circle cx="74" cy="60" r="3.6"/></g><g stroke="#7c2d12" stroke-width="1.8" stroke-linecap="round" fill="none"><path d="M40 48 Q46 45 52 48"/><path d="M68 48 Q74 45 80 48"/></g>`;
  }
  // Default open eyes (party / surprised / love handled by mouth + cheeks).
  return `<g fill="${eye}"><circle cx="46" cy="59" r="4"/><circle cx="74" cy="59" r="4"/><circle cx="47.5" cy="57.5" r="1.3" fill="#fff"/><circle cx="75.5" cy="57.5" r="1.3" fill="#fff"/></g>`;
}

function mouthLayer(expr: AvatarExpression): string {
  switch (expr) {
    case 'laughing':
      return `<path d="M48 72 Q60 86 72 72 Q60 78 48 72Z" fill="#7c2d12"/><path d="M52 73 Q60 79 68 73" stroke="#fff" stroke-width="1.6" fill="none"/>`;
    case 'love':
      return `<path d="M50 74 Q60 82 70 74" stroke="#7c2d12" stroke-width="2.4" stroke-linecap="round" fill="none"/><text x="60" y="70" font-size="11" text-anchor="middle">❤</text>`;
    case 'wink':
      return `<path d="M50 74 Q60 81 70 74" stroke="#7c2d12" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
    case 'cool':
      return `<path d="M50 75 Q60 79 70 75" stroke="#7c2d12" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
    case 'party':
      return `<circle cx="60" cy="77" r="5" fill="#7c2d12"/><path d="M44 34 L48 26 M76 34 L72 26" stroke="#d97706" stroke-width="2" stroke-linecap="round"/>`;
    case 'sad':
      return `<path d="M50 80 Q60 73 70 80" stroke="#7c2d12" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
    case 'surprised':
      return `<ellipse cx="60" cy="77" rx="5" ry="6.5" fill="#7c2d12"/>`;
    case 'happy':
    default:
      return `<path d="M50 72 Q60 81 70 72" stroke="#7c2d12" stroke-width="2.4" stroke-linecap="round" fill="none"/>`;
  }
}

function accessoryLayer(acc: Accessory): string {
  switch (acc) {
    case 'glasses':
      return `<g stroke="#1f2937" stroke-width="2" fill="rgba(255,255,255,0.25)"><circle cx="46" cy="59" r="9"/><circle cx="74" cy="59" r="9"/><path d="M55 59 L65 59 M37 58 L30 56 M83 58 L90 56" fill="none"/></g>`;
    case 'sunglasses':
      return `<g fill="#111827"><rect x="35" y="52" width="22" height="12" rx="5"/><rect x="63" y="52" width="22" height="12" rx="5"/><rect x="55" y="56" width="10" height="3"/></g>`;
    case 'earrings':
      return `<g fill="#f59e0b"><circle cx="29" cy="70" r="2.6"/><circle cx="91" cy="70" r="2.6"/></g>`;
    case 'none':
    default:
      return '';
  }
}

/** Compose the avatar as a standalone SVG string (120×120). Pure. */
export function avatarSvg(traits: AvatarTraits, expression: AvatarExpression = 'happy'): string {
  const skin = SKIN[traits.skinTone];
  const hair = HAIR[traits.hairColour];
  const eye = EYE[traits.eyeColour];
  const outfit = OUTFIT[traits.outfitColour];
  const cheeks =
    expression === 'happy' || expression === 'laughing' || expression === 'love'
      ? `<g fill="#f472b6" opacity="0.45"><circle cx="38" cy="68" r="4.5"/><circle cx="82" cy="68" r="4.5"/></g>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">` +
    `<rect width="120" height="120" rx="24" fill="#dcfce7"/>` +
    // Outfit (shoulders)
    `<path d="M18 120 Q22 98 60 96 Q98 98 102 120Z" fill="${outfit}"/>` +
    // Neck + ears
    `<rect x="53" y="86" width="14" height="14" rx="4" fill="${skin}"/>` +
    `<circle cx="29" cy="60" r="5" fill="${skin}"/><circle cx="91" cy="60" r="5" fill="${skin}"/>` +
    facePath(traits.faceShape, skin) +
    hairLayer(traits.hairStyle, hair) +
    browLayer(traits.browStyle, hair) +
    eyeLayer(expression, eye) +
    cheeks +
    mouthLayer(expression) +
    accessoryLayer(traits.accessory) +
    `</svg>`;
}

/** Data-URI for the avatar SVG (safe to use as an <img> src). */
export function avatarDataUrl(traits: AvatarTraits, expression: AvatarExpression = 'happy'): string {
  return `data:image/svg+xml,${encodeURIComponent(avatarSvg(traits, expression))}`;
}

/**
 * Rasterise an avatar SVG data-URI to a PNG File (WA verify settings-1,
 * row 9). The avatar is an SVG string, but `uploadProfilePicture` only
 * accepts JPG/PNG/WEBP/GIF — and the app treats ANY `data:` photoURL as
 * "no photo" — so "Use as profile photo" must go through the same
 * PNG-file upload path as the photo cropper. The SVG is generated
 * locally from fixed trait enums (no user markup, no external refs), so
 * drawing it to canvas cannot taint it. Rejects when the image or the
 * canvas conversion fails; the caller shows the error toast.
 */
export function svgDataUrlToPngFile(dataUrl: string, size = 512): Promise<File> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Could not create image')); return; }
        ctx.drawImage(img, 0, 0, size, size);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Could not create image')); return; }
          resolve(new File([blob], 'avatar.png', { type: 'image/png' }));
        }, 'image/png');
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Could not create image'));
      }
    };
    img.onerror = () => reject(new Error('Could not read avatar image'));
    img.src = dataUrl;
  });
}

// ── Avatar sticker pack (built from traits) ────────────────────────────────

export const AVATAR_PACK_NAME = 'Avatar';

const EXPRESSIONS: { expr: AvatarExpression; label: string; art: string; bg: string }[] = [
  { expr: 'happy', label: 'Happy', art: '😊', bg: 'from-emerald-300 to-teal-600' },
  { expr: 'laughing', label: 'Laughing', art: '😂', bg: 'from-yellow-300 to-amber-500' },
  { expr: 'love', label: 'Love', art: '😍', bg: 'from-pink-300 to-rose-400' },
  { expr: 'wink', label: 'Wink', art: '😉', bg: 'from-sky-300 to-blue-500' },
  { expr: 'cool', label: 'Cool', art: '😎', bg: 'from-cyan-300 to-sky-600' },
  { expr: 'party', label: 'Party', art: '🥳', bg: 'from-fuchsia-400 to-purple-600' },
  { expr: 'sad', label: 'Sad', art: '😢', bg: 'from-slate-300 to-slate-500' },
  { expr: 'surprised', label: 'Surprised', art: '😲', bg: 'from-violet-300 to-purple-500' },
];

/** Build the 8-expression Avatar pack from saved traits. Pure. */
export function buildAvatarStickers(traits: AvatarTraits): StickerDef[] {
  return EXPRESSIONS.map((e) => ({
    id: `avatar-${e.expr}`,
    art: e.art,
    label: `Avatar ${e.label}`,
    bg: e.bg,
    pack: AVATAR_PACK_NAME,
    image: avatarDataUrl(traits, e.expr),
  }));
}
