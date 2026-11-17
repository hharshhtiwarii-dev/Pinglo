/**
 * AvatarCreator — manual trait picker (Explore surface) + live preview.
 *
 * Opens from the sticker picker ("Create your avatar") and from
 * Settings > Avatar. Pick traits, watch the preview update, Save to
 * create the Avatar pack. No photo, no AI, nothing leaves the device.
 * Delete is permanent: the pack stops working (saved stickers keep
 * their data-URI image, so already-sent messages still render).
 */
import React, { useMemo, useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import {
  ACCESSORIES,
  AVATAR_PACK_NAME,
  BROW_STYLES,
  DEFAULT_AVATAR_TRAITS,
  EYE_COLOURS,
  FACE_SHAPES,
  HAIR_COLOURS,
  HAIR_STYLES,
  OUTFIT_COLOURS,
  SKIN_TONES,
  avatarDataUrl,
  deleteAvatarTraits,
  loadAvatarTraits,
  saveAvatarTraits,
  type Accessory,
  type AvatarTraits,
  type BrowStyle,
  type EyeColour,
  type FaceShape,
  type HairColour,
  type HairStyle,
  type OutfitColour,
  type SkinTone,
} from './avatar';

interface AvatarCreatorProps {
  onClose: () => void;
  /** Called after save/delete so the picker refreshes its pack. */
  onSaved: () => void;
  /**
   * WA verify settings-1, row 9: when set (Settings > Avatar), the
   * creator also offers "Use as profile photo" — WA's avatar IS the
   * profile avatar, DT's was stickers-only. The raw SVG data-URI is
   * passed up; the caller rasterises it (svgDataUrlToPngFile) and
   * uploads it through the normal profile-photo path. Omitted in the
   * sticker picker, where the action makes no sense.
   */
  onUseAsPhoto?: (dataUrl: string) => void;
}

export default function AvatarCreator({ onClose, onSaved, onUseAsPhoto }: AvatarCreatorProps) {
  const [traits, setTraits] = useState<AvatarTraits>(() => loadAvatarTraits() || DEFAULT_AVATAR_TRAITS);
  const [saved, setSaved] = useState(false);
  const previewUrl = useMemo(() => avatarDataUrl(traits, 'happy'), [traits]);

  const set = <K extends keyof AvatarTraits>(key: K, value: AvatarTraits[K]) => {
    setTraits((t) => ({ ...t, [key]: value }));
    setSaved(false);
  };

  const save = () => {
    saveAvatarTraits(traits);
    setSaved(true);
    onSaved();
  };

  const remove = () => {
    deleteAvatarTraits();
    setTraits(DEFAULT_AVATAR_TRAITS);
    setSaved(false);
    onSaved();
  };

  const swatch = (selected: boolean) =>
    `min-h-[44px] min-w-[44px] px-3 py-2 rounded-full text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-primary-green ${
      selected
        ? 'bg-green-cta text-white'
        : 'bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary hover:bg-gray-200 dark:hover:bg-white/10'
    }`;

  // Plain render helper (not a sub-component: `key` is not accepted on
  // custom components with the React 19 types in this project).
  const section = (
    title: string,
    labelledBy: string,
    children: React.ReactNode,
  ) => (
    <div className="mb-4">
      <p id={labelledBy} className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-1.5">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Create your avatar"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[88dvh] overflow-y-auto bg-white dark:bg-panel-dark rounded-t-3xl sm:rounded-3xl p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-bold text-gray-900 dark:text-text-primary">Create your avatar</h2>
          <button
            onClick={onClose}
            aria-label="Close avatar creator"
            className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-input-dark"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Pick your traits. Your avatar stays on this device.
        </p>

        {/* Live preview — the component, not a card-in-card. */}
        <div className="flex flex-col items-center mb-4">
          <img src={previewUrl} alt="Avatar preview" className="h-32 w-32 rounded-3xl" draggable={false} />
          <p className="text-[11px] text-gray-400 mt-1.5">Live preview</p>
        </div>

        {section('Skin tone', 'avatar-skin', SKIN_TONES.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={traits.skinTone === o.value}
            aria-label={`Skin tone: ${o.label}`}
            onClick={() => set('skinTone', o.value as SkinTone)}
            className={swatch(traits.skinTone === o.value)}
          >
            <span
              className="inline-block h-3.5 w-3.5 rounded-full mr-1.5 align-middle border border-black/10"
              style={{ backgroundColor: o.colour }}
            />
            {o.label}
          </button>
        )))}

        {section('Face shape', 'avatar-face', FACE_SHAPES.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.faceShape === o.value} onClick={() => set('faceShape', o.value as FaceShape)} className={swatch(traits.faceShape === o.value)}>
            {o.label}
          </button>
        )))}

        {section('Hair style', 'avatar-hair', HAIR_STYLES.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.hairStyle === o.value} onClick={() => set('hairStyle', o.value as HairStyle)} className={swatch(traits.hairStyle === o.value)}>
            {o.label}
          </button>
        )))}

        {section('Hair colour', 'avatar-hair-colour', HAIR_COLOURS.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.hairColour === o.value} aria-label={`Hair colour: ${o.label}`} onClick={() => set('hairColour', o.value as HairColour)} className={swatch(traits.hairColour === o.value)}>
            <span className="inline-block h-3.5 w-3.5 rounded-full mr-1.5 align-middle border border-black/10" style={{ backgroundColor: o.colour }} />
            {o.label}
          </button>
        )))}

        {section('Eye colour', 'avatar-eyes', EYE_COLOURS.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.eyeColour === o.value} aria-label={`Eye colour: ${o.label}`} onClick={() => set('eyeColour', o.value as EyeColour)} className={swatch(traits.eyeColour === o.value)}>
            <span className="inline-block h-3.5 w-3.5 rounded-full mr-1.5 align-middle border border-black/10" style={{ backgroundColor: o.colour }} />
            {o.label}
          </button>
        )))}

        {section('Eyebrows', 'avatar-brows', BROW_STYLES.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.browStyle === o.value} onClick={() => set('browStyle', o.value as BrowStyle)} className={swatch(traits.browStyle === o.value)}>
            {o.label}
          </button>
        )))}

        {section('Outfit', 'avatar-outfit', OUTFIT_COLOURS.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.outfitColour === o.value} aria-label={`Outfit colour: ${o.label}`} onClick={() => set('outfitColour', o.value as OutfitColour)} className={swatch(traits.outfitColour === o.value)}>
            <span className="inline-block h-3.5 w-3.5 rounded-full mr-1.5 align-middle border border-black/10" style={{ backgroundColor: o.colour }} />
            {o.label}
          </button>
        )))}

        {section('Accessory', 'avatar-accessory', ACCESSORIES.map((o) => (
          <button key={o.value} type="button" aria-pressed={traits.accessory === o.value} onClick={() => set('accessory', o.value as Accessory)} className={swatch(traits.accessory === o.value)}>
            {o.label}
          </button>
        )))}

        {saved && (
          <p role="status" className="text-xs text-primary-green font-semibold mb-2">
            Your stickers are ready. Find them in the {AVATAR_PACK_NAME} pack.
          </p>
        )}

        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={save}
            className="flex-1 min-h-[44px] rounded-full bg-green-cta text-white text-sm font-semibold"
          >
            Save avatar
          </button>
          {onUseAsPhoto && (
            <button
              onClick={() => onUseAsPhoto(previewUrl)}
              aria-label="Use avatar as profile photo"
              className="flex-1 min-h-[44px] rounded-full bg-gray-100 dark:bg-input-dark text-gray-900 dark:text-text-primary text-sm font-semibold"
            >
              Use as profile photo
            </button>
          )}
          <button
            onClick={remove}
            aria-label="Delete avatar"
            title="Delete avatar"
            className="min-h-[44px] min-w-[44px] px-3 rounded-full bg-gray-100 dark:bg-input-dark text-red-500 flex items-center justify-center gap-1 text-xs font-semibold"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          Deleting your avatar is permanent. Your avatar stickers will stop working.
        </p>
      </div>
    </div>
  );
}
