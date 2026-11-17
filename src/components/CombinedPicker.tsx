/**
 * WA Wave-2 — DM #25 + Media E10: ONE combined panel
 * "Emojis, GIFs, Stickers".
 *
 * WA value: a single entry point (the composer's emoji button,
 * aria-label="Emojis, GIFs, Stickers") opening one panel with three tabs —
 * "Emoji panel", "GIF panel", "Sticker panel". DT used to have two
 * separate pickers: EmojiPicker (emoji button) and StickerPicker
 * (stickers + GIFs, from the attach menu / sticker button). Same content
 * was reachable, from different entry points.
 *
 * This component hosts the existing pickers as tab content (their `bare`
 * modes — no own wrapper / tab bar), so no picker behaviour changes:
 * emoji search + recents + skin tone, sticker packs + favourites +
 * create-sticker + avatar, and the GIF tab's existing key-gated Giphy
 * flow (GIF *search* itself is #77 / #203, .env-deferred — untouched
 * here; without a key the GIF tab shows the same honest error as today).
 *
 * WA parity (reviewer gaps): ALL tab panels stay mounted and are only
 * hidden (`hidden` attribute) when inactive, so Emoji→GIF→Emoji keeps
 * the emoji category/search and the sticker/GIF category/search instead
 * of remounting and resetting. Tabs and panels are linked with
 * `aria-controls` / `aria-labelledby` (WAI-ARIA tabs pattern). */
import React, { useEffect, useRef, useState } from 'react';
import { Smile, ImagePlay, Sticker as StickerIcon, X } from 'lucide-react';
import EmojiPicker from './EmojiPicker';
import StickerPicker, { type AnimatedStickerDef, type GifDef, type PickerTab } from './StickerPicker';

export type CombinedTab = 'emoji' | PickerTab;

const TABS: { id: CombinedTab; label: string; ariaLabel: string; icon: React.ReactNode }[] = [
  { id: 'emoji', label: 'Emoji', ariaLabel: 'Emoji panel', icon: <Smile className="h-4 w-4" /> },
  { id: 'gifs', label: 'GIFs', ariaLabel: 'GIF panel', icon: <ImagePlay className="h-4 w-4" /> },
  { id: 'stickers', label: 'Stickers', ariaLabel: 'Sticker panel', icon: <StickerIcon className="h-4 w-4" /> },
];

interface CombinedPickerProps {
  onSelectEmoji: (emoji: string) => void;
  onSelectSticker: (sticker: AnimatedStickerDef) => void;
  onSelectGif: (gif: GifDef) => void;
  onClose: () => void;
  /** Which tab to open on. Defaults to 'emoji'. */
  initialTab?: CombinedTab;
  /** Controlled tab (ChatScreen owns it so the emoji button can tell
   *  which tab is open). When omitted, the panel owns its tab. */
  tab?: CombinedTab;
  onTabChange?: (tab: CombinedTab) => void;
  /** Wave-2 E9 (WA onShowMore): pre-fill the Stickers tab search box,
   *  e.g. with the last typed emoji. */
  initialStickerQuery?: string;
}

export default function CombinedPicker({
  onSelectEmoji,
  onSelectSticker,
  onSelectGif,
  onClose,
  initialTab = 'emoji',
  tab: controlledTab,
  onTabChange,
  initialStickerQuery,
}: CombinedPickerProps) {
  const [internalTab, setInternalTab] = useState<CombinedTab>(initialTab);
  // Controlled mode (ChatScreen) wins when provided; otherwise the panel
  // owns its tab exactly as the old pickers did.
  const tab = controlledTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;

  // WA Wave-2 A3 reviewer gap (a11y): full WAI-ARIA tabs keyboard
  // pattern — roving tabindex (only the selected tab is in the Tab
  // order) + ArrowLeft/ArrowRight/Home/End move selection and focus.
  // Automatic activation: moving focus also selects the tab, so the
  // panel content follows the keyboard like WhatsApp's picker tabs.
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusTab = (index: number) => {
    const next = TABS[index];
    if (!next) return;
    setTab(next.id);
    tabRefs.current[index]?.focus();
  };
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); focusTab((index + 1) % TABS.length); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusTab((index - 1 + TABS.length) % TABS.length); }
    else if (e.key === 'Home') { e.preventDefault(); focusTab(0); }
    else if (e.key === 'End') { e.preventDefault(); focusTab(TABS.length - 1); }
  };

  // Keep the open tab in sync when the caller re-opens on a different
  // tab (e.g. attach menu → GIFs) while the panel stays mounted.
  // Controlled mode: the host owns the tab, so there is nothing to sync.
  useEffect(() => {
    if (controlledTab === undefined) setInternalTab(initialTab);
  }, [initialTab, controlledTab]);

  return (
    <div
      data-combined-picker
      className="bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5 max-h-[320px] overflow-y-auto"
    >
      {/* Shared tab bar — one panel, three tabs (WA: Emoji / GIF / Sticker). */}
      <div className="flex items-center gap-1 px-3 pt-2" role="tablist" aria-label="Emojis, GIFs, Stickers" aria-orientation="horizontal">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => { tabRefs.current[i] = el; }}
            id={`combined-tab-${t.id}`}
            role="tab"
            aria-label={t.ariaLabel}
            aria-selected={tab === t.id}
            aria-controls={`combined-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            onClick={() => setTab(t.id)}
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
          aria-label="Close picker"
          className="ml-auto p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-input-dark"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* All panels stay mounted — inactive ones are only hidden — so
          switching tabs never remounts a picker and never resets its
          category / search / scroll state (WA keeps tab state).
          StickerPicker only knows 'stickers' | 'gifs': while the emoji
          tab is active it is parked on 'stickers' (hidden), so its GIF
          trending effect stays idle until the GIF tab is selected. */}
      <div
        role="tabpanel"
        id="combined-panel-emoji"
        aria-labelledby="combined-tab-emoji"
        hidden={tab !== 'emoji'}
      >
        <EmojiPicker bare onSelect={onSelectEmoji} onClose={onClose} />
      </div>
      <div
        role="tabpanel"
        id="combined-panel-gifs"
        aria-labelledby="combined-tab-gifs"
        hidden={tab !== 'gifs'}
      >
        {/* GIF content lives in StickerPicker; it is hidden, not unmounted,
            while the GIF tab is inactive, so its search stays put. Its
            trending load is cache-first + budget-guarded (services/giphy),
            so mounting it while hidden costs ~0 API calls. */}
        <StickerPicker
          bare
          controlledTab="gifs"
          onSelectSticker={onSelectSticker}
          onSelectGif={onSelectGif}
          onClose={onClose}
        />
      </div>
      <div
        role="tabpanel"
        id="combined-panel-stickers"
        aria-labelledby="combined-tab-stickers"
        hidden={tab !== 'stickers'}
      >
        <StickerPicker
          bare
          controlledTab="stickers"
          initialQuery={initialStickerQuery}
          onSelectSticker={onSelectSticker}
          onSelectGif={onSelectGif}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
