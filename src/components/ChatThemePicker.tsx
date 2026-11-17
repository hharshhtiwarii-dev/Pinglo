import React, { useMemo, useRef, useState } from 'react';
import { Check, X, Sun, Moon, Monitor, Image as ImageIcon, Trash2, RotateCcw, Palette } from 'lucide-react';
import {
  CHAT_THEME_PRESETS,
  buildCustomTheme,
  getAppTheme,
  getChatThemeFor,
  getChatThemeState,
  getPerChatTheme,
  patternDataUri,
  resolveTheme,
  savePerChatTheme,
  WALLPAPER_COLOURS,
  WA_WALLPAPERS,
  type AppThemeMode,
  type ChatThemeDef,
  type ChatThemeState,
  type PerChatTheme,
} from '../services/chatTheme';

/**
 * WhatsApp-style Default chat theme customiser (Theme fix, 2026-11-13).
 * Replicates every control on WhatsApp's Default chat theme screen:
 *  - 15 preset themes (+ Custom), each with a mini preview
 *  - Custom colours: sent bubble, received bubble, chat background, header,
 *    bubble text, tick colour — free choice via colour picker + hex
 *  - Wallpaper: theme default, solid colours, own photo, remove
 *  - Wallpaper brightness slider (how light / dark the wallpaper looks)
 *  - Live preview (sample chat) that updates with every change
 *  - App theme: Light / Dark / System default (global mode only)
 *  - Per-chat mode: the same picker for one chat, with "Use default theme"
 *
 * Used inline in Settings (global) and as a modal from ChatScreen (per-chat).
 */

export interface CustomPicks {
  sent: string;
  recv: string;
  bg: string;
  header: string;
  text: string;
  tick: string;
}

function picksFromDef(def: ChatThemeDef): CustomPicks {
  return {
    sent: def.sentLight,
    recv: def.recvLight,
    bg: def.bgLight,
    header: def.header,
    text: def.textLight,
    tick: def.tick,
  };
}

function isHex(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v);
}

/** Two small read ticks in the given colour (preview only). */
function PreviewTicks({ color }: { color: string }) {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" className="inline-block shrink-0 align-middle" aria-hidden="true">
      <path d="M1 5.5 L4.5 9 L11 2" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 5.5 L8.5 9 L15 2" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ColourRow({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-2">
      <span className="text-[13px] text-gray-800 dark:text-text-primary flex-1 min-w-0">{label}</span>
      <span className="flex items-center gap-2 flex-shrink-0">
        <input
          type="text"
          value={value}
          aria-label={`${label} hex colour`}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (isHex(v)) onChange(v.toUpperCase());
            else if (/^#[0-9a-f]{0,6}$/i.test(v)) onChange(v);
          }}
          className="w-[88px] rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-input-dark px-1.5 py-1.5 text-[11px] font-mono text-gray-800 dark:text-text-primary uppercase"
        />
        <input
          type="color"
          value={isHex(value) ? value : '#075E54'}
          aria-label={`${label} colour picker`}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-9 w-9 cursor-pointer rounded-lg border border-gray-200 dark:border-white/10 bg-transparent p-0.5"
        />
      </span>
    </div>
  );
}

interface PickerProps {
  mode: 'global' | 'perChat';
  chatId?: string;
  /** Global: called with the saved state. Per-chat: called with the saved per-chat override. */
  onSaveGlobal?: (state: ChatThemeState) => void;
  onSavePerChat?: (per: PerChatTheme) => void;
  /** Global: lets the parent keep its dark-mode toggle in sync. */
  onAppThemeChange?: (mode: AppThemeMode) => void;
  onClose?: () => void;
}

export function ChatThemePicker({ mode, chatId, onSaveGlobal, onSavePerChat, onAppThemeChange, onClose }: PickerProps) {
  const globalState = useMemo(() => getChatThemeState(), []);
  const perChatInitial = useMemo(() => (chatId ? getPerChatTheme(chatId) : { useDefault: true }), [chatId]);
  const resolvedGlobal = useMemo(() => resolveTheme(globalState), [globalState]);

  const [presetId, setPresetId] = useState<string>(
    mode === 'perChat'
      ? perChatInitial.useDefault
        ? globalState.presetId
        : perChatInitial.presetId || globalState.presetId
      : globalState.presetId,
  );
  const [picks, setPicks] = useState<CustomPicks>(() =>
    picksFromDef(
      mode === 'perChat' && !perChatInitial.useDefault && perChatInitial.custom
        ? perChatInitial.custom
        : globalState.presetId === 'custom' && globalState.custom
          ? globalState.custom
          : resolvedGlobal,
    ),
  );
  const [wallpaperImg, setWallpaperImg] = useState<string | null>(
    mode === 'perChat'
      ? perChatInitial.wallpaperImg !== undefined
        ? perChatInitial.wallpaperImg
        : globalState.wallpaperImg || null
      : globalState.wallpaperImg || null,
  );
  const [wallpaperColor, setWallpaperColor] = useState<string | null>(
    mode === 'perChat'
      ? perChatInitial.wallpaperColor !== undefined
        ? perChatInitial.wallpaperColor
        : globalState.wallpaperColor || null
      : globalState.wallpaperColor || null,
  );
  const [wallpaperDim, setWallpaperDim] = useState<number>(
    mode === 'perChat'
      ? perChatInitial.wallpaperDim !== undefined
        ? perChatInitial.wallpaperDim
        : globalState.wallpaperDim
      : globalState.wallpaperDim,
  );
  // True when the chosen wallpaper is a small repeating tile (WA dark
  // pattern). Own photos and the full-size WA doodles stretch to cover.
  const [wallpaperTile, setWallpaperTile] = useState<boolean>(
    mode === 'perChat'
      ? perChatInitial.wallpaperTile !== undefined
        ? perChatInitial.wallpaperTile
        : globalState.wallpaperTile === true
      : globalState.wallpaperTile === true,
  );
  const [appTheme, setAppTheme] = useState<AppThemeMode>(() => getAppTheme());
  const [previewDark, setPreviewDark] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // The theme the preview (and Save) uses right now.
  const draftDef: ChatThemeDef = useMemo(() => {
    if (presetId === 'custom') return buildCustomTheme(picks);
    return CHAT_THEME_PRESETS.find((p) => p.id === presetId) || resolvedGlobal;
  }, [presetId, picks, resolvedGlobal]);

  const pickPreset = (id: string) => setPresetId(id);

  const editPick = (key: keyof CustomPicks, value: string) => {
    // Any hand-picked colour turns the draft into a Custom theme seeded
    // from the currently selected preset, so nothing else is lost.
    setPicks((prev) => ({ ...prev, [key]: value }));
    setPresetId('custom');
  };

  const handlePhoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError('');
    if (!file.type.startsWith('image/')) {
      setPhotoError('Please choose an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoError('Wallpaper image must be smaller than 5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const url = ev.target?.result as string;
        setWallpaperImg(url);
        setWallpaperColor(null);
        setWallpaperTile(false);
      } catch {
        setPhotoError('Image is too large to store. Try a smaller one.');
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    if (mode === 'global') {
      const state: ChatThemeState = {
        presetId,
        custom: presetId === 'custom' ? buildCustomTheme(picks) : undefined,
        wallpaperImg,
        wallpaperColor,
        wallpaperDim,
        wallpaperTile,
        appTheme,
      };
      onSaveGlobal?.(state);
    } else {
      const per: PerChatTheme = {
        useDefault: false,
        presetId,
        custom: presetId === 'custom' ? buildCustomTheme(picks) : undefined,
        wallpaperImg,
        wallpaperColor,
        wallpaperDim,
        wallpaperTile,
      };
      onSavePerChat?.(per);
    }
  };

  const handleUseDefault = () => {
    if (mode === 'perChat') onSavePerChat?.({ useDefault: true });
  };

  const handleReset = () => {
    setPresetId('default');
    setPicks(picksFromDef(CHAT_THEME_PRESETS[0]));
    setWallpaperImg(null);
    setWallpaperColor(null);
    setWallpaperDim(100);
    setWallpaperTile(false);
  };

  const previewBg = wallpaperColor || (previewDark ? draftDef.bg : draftDef.bgLight);
  const previewSentBg = previewDark ? draftDef.sent : draftDef.sentLight;
  const previewRecvBg = previewDark ? draftDef.recv : draftDef.recvLight;
  const previewText = previewDark ? draftDef.text : draftDef.textLight;
  const previewPattern = draftDef.variant === 'pattern' && !wallpaperImg && !wallpaperColor;

  return (
    <div className="space-y-6 px-5 py-4">
      {/* ── App theme (global only): Light / Dark / System default ── */}
      {mode === 'global' && (
        <section>
          <h3 className="text-base font-semibold mb-1">App theme</h3>
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">Light, dark, or follow your device.</p>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'light', label: 'Light', icon: <Sun className="h-4 w-4" /> },
                { id: 'dark', label: 'Dark', icon: <Moon className="h-4 w-4" /> },
                { id: 'system', label: 'System default', icon: <Monitor className="h-4 w-4" /> },
              ] as { id: AppThemeMode; label: string; icon: React.ReactNode }[]
            ).map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  setAppTheme(o.id);
                  onAppThemeChange?.(o.id);
                }}
                aria-pressed={appTheme === o.id}
                // Side-by-side fix (Item 7c): the "System default" icon
                // used to overlap its label at 390px — the svg could
                // shrink and the long label + ✓ squeezed into ~110px.
                // Icon and ✓ are now shrink-0, the label wraps cleanly
                // on two lines instead of colliding with the icon.
                className={`flex items-center justify-center gap-1 px-1 py-2.5 rounded-xl border text-[13px] font-medium transition-all ${
                  appTheme === o.id
                    ? 'border-primary-green bg-primary-green/10 text-primary-green'
                    : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'
                }`}
              >
                <span className="shrink-0">{o.icon}</span>
                <span className="leading-tight text-center">{o.label}</span>
                {appTheme === o.id && <span className="shrink-0">✓</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Live preview ── */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-base font-semibold">Preview</h3>
          <button
            type="button"
            onClick={() => setPreviewDark((d) => !d)}
            className="text-xs font-medium text-primary-green border border-primary-green/30 bg-primary-green/10 rounded-full px-3 py-1.5"
          >
            {previewDark ? '🌙 Dark preview' : '☀️ Light preview'} — tap to switch
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-text-secondary mb-2">
          Try out themes! Select one to preview. Only you see your chat themes.
        </p>
        <div
          className="relative overflow-hidden rounded-2xl p-3"
          style={{
            backgroundColor: previewBg,
            backgroundImage: wallpaperImg
              ? `url(${wallpaperImg})`
              : previewPattern
                ? `url(${patternDataUri(previewDark)})`
                : undefined,
            backgroundSize: wallpaperImg ? (wallpaperTile ? 'auto' : 'cover') : '220px',
            backgroundRepeat: wallpaperImg && wallpaperTile ? 'repeat' : undefined,
            backgroundPosition: 'center',
            filter: `brightness(${wallpaperDim}%)`,
          }}
        >
          <div className="mx-auto w-fit rounded-lg bg-white/80 dark:bg-black/40 px-3 py-1 text-[11px] text-gray-600 dark:text-gray-200 shadow-sm mb-2">
            Today
          </div>
          <div className="flex flex-col gap-1.5">
            <div
              className="self-start max-w-[75%] rounded-lg rounded-tl-sm px-3 py-2 shadow-sm text-sm"
              style={{ backgroundColor: previewRecvBg, color: previewText }}
            >
              Hey! Kaise ho? 👋
              <span className="float-right ml-2 mt-1 text-[10px] opacity-60">2:41 PM</span>
            </div>
            <div
              className="self-end max-w-[75%] rounded-lg rounded-tr-sm px-3 py-2 shadow-sm text-sm"
              style={{ backgroundColor: previewSentBg, color: previewText }}
            >
              Main theek hoon! Ye theme kaisi lag rahi hai?
              <span className="float-right ml-2 mt-1 flex items-center gap-1 text-[10px] opacity-70">
                2:42 PM <PreviewTicks color={draftDef.tick} />
              </span>
            </div>
            <div
              className="self-start max-w-[75%] rounded-lg rounded-tl-sm px-3 py-2 shadow-sm text-sm"
              style={{ backgroundColor: previewRecvBg, color: previewText }}
            >
              Bilkul WhatsApp jaisi! 👍
              <span className="float-right ml-2 mt-1 text-[10px] opacity-60">2:43 PM</span>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-gray-500 dark:text-gray-300">
            Selecting a theme replaces your default chat theme.
          </p>
        </div>
      </section>

      {/* ── Presets: all 15 WhatsApp themes + Custom ── */}
      <section>
        <h3 className="text-base font-semibold mb-1">Default chat theme</h3>
        <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">Pick a theme, or make your own with Custom.</p>
        <div className="grid grid-cols-3 gap-3">
          {CHAT_THEME_PRESETS.map((t) => {
            const selected = presetId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => pickPreset(t.id)}
                aria-pressed={selected}
                className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border transition-all ${
                  selected
                    ? 'border-primary-green ring-2 ring-primary-green/40'
                    : 'border-gray-200 dark:border-white/10 hover:border-primary-green'
                }`}
              >
                <div
                  className="w-full h-16 rounded-lg overflow-hidden relative"
                  style={{
                    backgroundColor: t.bgLight,
                    backgroundImage: t.variant === 'pattern' ? `url(${patternDataUri(false)})` : undefined,
                    backgroundSize: '220px',
                  }}
                >
                  <div className="flex flex-col gap-1 p-2">
                    <div className="self-end h-4 w-12 rounded-full rounded-tr-none" style={{ background: t.sentLight }} />
                    <div className="self-start h-4 w-10 rounded-full rounded-tl-none" style={{ background: t.recvLight }} />
                  </div>
                  {selected && (
                    <span className="absolute top-1 right-1 h-5 w-5 rounded-full bg-green-cta text-white flex items-center justify-center">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-700 dark:text-text-primary font-medium text-center leading-tight">
                  {t.name}
                  <span className="block text-[10px] text-gray-400 dark:text-text-secondary font-normal">
                    {t.variant === 'pattern' ? 'Patterned wallpaper' : 'Minimal'}
                  </span>
                </span>
              </button>
            );
          })}
          {/* Custom tile */}
          <button
            type="button"
            onClick={() => setPresetId('custom')}
            aria-pressed={presetId === 'custom'}
            className={`flex flex-col items-center gap-1.5 p-2.5 rounded-xl border transition-all ${
              presetId === 'custom'
                ? 'border-primary-green ring-2 ring-primary-green/40'
                : 'border-gray-200 dark:border-white/10 hover:border-primary-green'
            }`}
          >
            <div
              className="w-full h-16 rounded-lg overflow-hidden relative flex items-center justify-center"
              style={{ background: 'conic-gradient(#DCF8C6, #D3E3FD, #EDE7F6, #FFE8D6, #D2F1EC, #DCF8C6)' }}
            >
              <Palette className="h-6 w-6 text-gray-700/70" />
              {presetId === 'custom' && (
                <span className="absolute top-1 right-1 h-5 w-5 rounded-full bg-green-cta text-white flex items-center justify-center">
                  <Check className="h-3 w-3" />
                </span>
              )}
            </div>
            <span className="text-xs text-gray-700 dark:text-text-primary font-medium text-center leading-tight">
              Custom
              <span className="block text-[10px] text-gray-400 dark:text-text-secondary font-normal">Your own colours</span>
            </span>
          </button>
        </div>
      </section>

      {/* ── Custom colours: free choice, live preview ── */}
      {presetId === 'custom' && (
        <section className="rounded-2xl border border-primary-green/30 bg-primary-green/5 dark:bg-primary-green/10 p-4">
          <h3 className="text-base font-semibold mb-1">Customise colours</h3>
          <p className="text-xs text-gray-500 dark:text-text-secondary mb-2">
            Pick any colours you like — the preview above updates as you change them.
          </p>
          <div className="divide-y divide-gray-200/70 dark:divide-white/5">
            <ColourRow label="Sent bubble colour" value={picks.sent} onChange={(v) => editPick('sent', v)} />
            <ColourRow label="Received bubble colour" value={picks.recv} onChange={(v) => editPick('recv', v)} />
            <ColourRow label="Chat background colour" value={picks.bg} onChange={(v) => editPick('bg', v)} />
            <ColourRow label="Header colour" value={picks.header} onChange={(v) => editPick('header', v)} />
            <ColourRow label="Bubble text colour" value={picks.text} onChange={(v) => editPick('text', v)} />
            <ColourRow label="Tick colour" value={picks.tick} onChange={(v) => editPick('tick', v)} />
          </div>
        </section>
      )}

      {/* ── Wallpaper: choice + brightness slider ── */}
      <section>
        <h3 className="text-base font-semibold mb-1">Wallpaper</h3>
        <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">
          {mode === 'perChat' ? 'Wallpaper for this chat only.' : 'Wallpaper for all chats (a chat can override it).'}
        </p>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePhoto} />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setWallpaperImg(null);
              setWallpaperColor(null);
              setWallpaperTile(false);
              setPhotoError('');
            }}
            className={`px-3 py-2 rounded-full border text-xs font-medium ${
              !wallpaperImg && !wallpaperColor
                ? 'border-primary-green bg-primary-green/10 text-primary-green'
                : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'
            }`}
          >
            Theme default{!wallpaperImg && !wallpaperColor ? ' ✓' : ''}
          </button>
          {/* WA wallpapers (audit e): classic WhatsApp doodle art bundled
              with the app — pick one instead of a solid colour or photo. */}
          {WA_WALLPAPERS.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-label={`Wallpaper ${w.label}`}
              aria-pressed={wallpaperImg === w.src}
              onClick={() => {
                setWallpaperImg(w.src);
                setWallpaperColor(null);
                setWallpaperTile(w.tile === true);
                setPhotoError('');
              }}
              className={`relative h-9 w-14 overflow-hidden rounded-full border-2 ${
                wallpaperImg === w.src ? 'border-primary-green ring-2 ring-primary-green/40' : 'border-white/60 dark:border-white/10'
              }`}
              title={w.label}
            >
              <img src={w.src} alt="" className="h-full w-full object-cover" />
              {wallpaperImg === w.src && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-xs font-bold text-white">✓</span>
              )}
            </button>
          ))}
          {WALLPAPER_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Solid wallpaper ${c}`}
              onClick={() => {
                setWallpaperColor(c);
                setWallpaperImg(null);
                setWallpaperTile(false);
              }}
              className={`h-9 w-9 rounded-full border-2 ${
                wallpaperColor === c ? 'border-primary-green ring-2 ring-primary-green/40' : 'border-white/60 dark:border-white/10'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-gray-200 dark:border-white/10 text-xs font-medium text-gray-700 dark:text-text-primary"
          >
            <ImageIcon className="h-4 w-4" /> Choose photo
          </button>
          {(wallpaperImg || wallpaperColor) && (
            <button
              type="button"
              onClick={() => {
                setWallpaperImg(null);
                setWallpaperColor(null);
                setWallpaperTile(false);
              }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full border border-gray-200 dark:border-white/10 text-xs font-medium text-gray-700 dark:text-text-primary"
            >
              <Trash2 className="h-4 w-4" /> Remove
            </button>
          )}
        </div>
        {wallpaperImg && (
          <div className="mt-3">
            <img src={wallpaperImg} alt="Chosen wallpaper" className="h-24 w-full rounded-xl object-cover" />
          </div>
        )}
        {photoError && <p className="text-xs text-danger-red mt-2">{photoError}</p>}

        {/* Brightness slider — exactly like WhatsApp's wallpaper brightness. */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <label htmlFor="wallpaper-brightness" className="text-sm font-medium text-gray-800 dark:text-text-primary">
              Wallpaper brightness
            </label>
            <span className="text-sm font-semibold text-primary-green">{wallpaperDim}%</span>
          </div>
          <input
            id="wallpaper-brightness"
            type="range"
            min={0}
            max={100}
            value={wallpaperDim}
            onChange={(e) => setWallpaperDim(Number(e.target.value))}
            className="w-full accent-[#25D366] mt-1"
          />
          <div className="flex justify-between text-[11px] text-gray-400 dark:text-text-secondary">
            <span>Dark</span>
            <span>Bright</span>
          </div>
          <p className="text-xs text-gray-400 dark:text-text-secondary mt-1">
            Dim the wallpaper so messages stay easy to read.
          </p>
        </div>
      </section>

      {/* ── Actions ── */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={handleReset}
          className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/10 text-sm font-medium text-gray-700 dark:text-text-primary"
        >
          <RotateCcw className="h-4 w-4" /> Reset
        </button>
        {mode === 'perChat' && (
          <button
            type="button"
            onClick={handleUseDefault}
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/10 text-sm font-medium text-gray-700 dark:text-text-primary"
          >
            Use default theme
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/10 text-sm font-medium text-gray-700 dark:text-text-primary"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          className="flex-1 px-4 py-2.5 rounded-xl bg-green-cta text-white text-sm font-semibold hover:bg-dark-green transition-colors"
        >
          Save theme
        </button>
      </div>
    </div>
  );
}

/** Modal wrapper for use from ChatScreen (per-chat theme). */
export function ChatThemePickerModal({
  chatId,
  onClose,
  onSaved,
}: {
  chatId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const look = useMemo(() => getChatThemeFor(chatId), [chatId]);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Chat theme and wallpaper"
    >
      <div
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-panel-dark shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-text-primary">Chat theme &amp; wallpaper</h2>
          <button type="button" onClick={onClose} aria-label="Close theme picker" className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
            <X className="h-5 w-5 text-gray-500 dark:text-text-secondary" />
          </button>
        </div>
        <ChatThemePicker
          mode="perChat"
          chatId={chatId}
          onSavePerChat={(per) => {
            // Persist the per-chat theme, then close (was missing: the
            // picker only hands the value back, it does not save it).
            savePerChatTheme(chatId, per);
            onSaved();
            onClose();
          }}
          onClose={onClose}
        />
        {look.isCustom && (
          <p className="text-xs text-gray-400 dark:text-text-secondary mt-3">
            This chat uses its own theme. Tap “Use default theme” to go back to the global theme.
          </p>
        )}
      </div>
    </div>
  );
}
