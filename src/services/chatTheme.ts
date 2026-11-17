/**
 * WhatsApp-style Default chat theme system (Theme fix, 2026-11-13).
 *
 * Replicates WhatsApp Web's Settings > Chats > Default chat theme screen,
 * same-to-same:
 *  - 15 named preset themes (verified against WhatsApp Web's "See all" list),
 *    each in a plain "minimal" variant or a patterned-wallpaper variant.
 *  - A "Custom" theme: the user picks sent-bubble, received-bubble, chat
 *    background, header, bubble-text and tick colours freely (colour picker
 *    + hex), with a live preview and Save that applies app-wide.
 *  - Wallpaper: theme background, solid colours, or the user's own photo,
 *    plus a brightness slider (how light / dark the wallpaper looks) —
 *    the same slider WhatsApp shows when a wallpaper is chosen.
 *  - App theme: Light / Dark / System default (follows the device).
 *  - Per-chat wallpaper/theme: one chat can have its own theme + wallpaper
 *    that overrides the global default.
 *
 * Persistence: one JSON blob in localStorage (`dt_chat_theme_v2`) so the
 * theme survives app restarts; the legacy keys (`dtwall`, `dtsentcol`,
 * `dtrecvcol`, `dttheme`, `dtimg`) are kept in sync for older code paths
 * that still read them. Best-effort user-doc sync is done by the callers
 * (SettingsScreen) — this module itself never touches the network.
 *
 * Colours are applied through CSS variables on documentElement (see
 * index.css: --chat-sent-bubble / --chat-recv-bubble / --chat-bg-resolved /
 * --chat-header / --chat-tick / --chat-text-sent / --chat-text-recv), so a
 * theme change takes effect without re-rendering every screen. Dark-mode
 * values live in the `sent` / `recv` / `bg` / `text` fields; light-mode
 * values in `sentLight` / `recvLight` / `bgLight` / `textLight`.
 */

export type AppThemeMode = 'light' | 'dark' | 'system';

export interface ChatThemeDef {
  id: string;
  name: string;
  /** 'minimal' = plain background, 'pattern' = doodle-pattern wallpaper. */
  variant: 'minimal' | 'pattern';
  /** Dark-mode bubble / background / text colours. */
  sent: string;
  recv: string;
  bg: string;
  text: string;
  /** Light-mode bubble / background / text colours. */
  sentLight: string;
  recvLight: string;
  bgLight: string;
  textLight: string;
  /** App header tint (both modes) and read-tick colour. */
  header: string;
  tick: string;
}

export interface ChatThemeState {
  /** Preset id, or 'custom'. */
  presetId: string;
  custom?: ChatThemeDef;
  /** Own wallpaper photo (data URL) — overrides the theme background. */
  wallpaperImg?: string | null;
  /** Solid wallpaper colour — overrides the theme background colour. */
  wallpaperColor?: string | null;
  /** Wallpaper brightness 0–100 (100 = full brightness). WhatsApp slider. */
  wallpaperDim: number;
  /** True when wallpaperImg is a small repeating tile (not a full photo). */
  wallpaperTile?: boolean;
  appTheme: AppThemeMode;
}

export interface PerChatTheme {
  /** true = follow the global default theme. */
  useDefault: boolean;
  presetId?: string;
  custom?: ChatThemeDef;
  wallpaperImg?: string | null;
  wallpaperColor?: string | null;
  wallpaperDim?: number;
  /** True when wallpaperImg is a small repeating tile (not a full photo). */
  wallpaperTile?: boolean;
}

export interface ResolvedChatLook {
  def: ChatThemeDef;
  /** Own wallpaper photo (data URL) or null. */
  wallpaperImg: string | null;
  /** Solid wallpaper colour override or null (use theme bg). */
  wallpaperColor: string | null;
  /** Wallpaper brightness 0–100. */
  wallpaperDim: number;
  /** True when wallpaperImg is a small repeating tile (render tiled, not stretched). */
  wallpaperTile: boolean;
  /** True when this chat has its own theme (not the global default). */
  isCustom: boolean;
}

const STATE_KEY = 'dt_chat_theme_v2';
const APP_THEME_KEY = 'dt_app_theme';
const LEGACY_THEME_KEY = 'theme';

/** WhatsApp Classic Pro — the app's default theme (Phase 5 style).
    Colours are WhatsApp's current WDS values (client study
    2026-11-17): sent #144D37 / #D9FDD3, received #242626 / #FFFFFF,
    chat bg #161717 / #F5F1EB, primary text #FAFAFA / #0A0A0A. */
export const DEFAULT_THEME: ChatThemeDef = {
  id: 'default',
  name: 'Default',
  variant: 'minimal',
  sent: '#144D37',
  recv: '#242626',
  bg: '#161717',
  text: '#FAFAFA',
  sentLight: '#D9FDD3',
  recvLight: '#FFFFFF',
  bgLight: '#F5F1EB',
  textLight: '#0A0A0A',
  header: '#075E54',
  tick: '#53BDEB',
};

/**
 * The 15 themes from WhatsApp Web's Default chat theme picker
 * (Settings > Chats > Default chat theme > See all). Names match WhatsApp's
 * labels; colours are the closest WhatsApp palette match for each label.
 * Minimal = plain background, Pattern = same colours + doodle wallpaper.
 */
export const CHAT_THEME_PRESETS: ChatThemeDef[] = [
  { ...DEFAULT_THEME, id: 'default', name: 'Default', variant: 'minimal' },
  {
    id: 'blue-minimal', name: 'Blue minimal', variant: 'minimal',
    sent: '#1565C0', recv: '#1A2744', bg: '#0A1628', text: '#E9EDEF',
    sentLight: '#D3E3FD', recvLight: '#FFFFFF', bgLight: '#E3EDF7', textLight: '#111B21',
    header: '#1565C0', tick: '#53BDEB',
  },
  {
    id: 'mono-minimal', name: 'Mono minimal', variant: 'minimal',
    sent: '#3A3A3A', recv: '#242424', bg: '#111111', text: '#E9EDEF',
    sentLight: '#E8E8E8', recvLight: '#FFFFFF', bgLight: '#EFEFEF', textLight: '#111B21',
    header: '#333333', tick: '#53BDEB',
  },
  {
    id: 'sky-blue-minimal', name: 'Sky blue minimal', variant: 'minimal',
    sent: '#1E4E79', recv: '#16283F', bg: '#0B1B2E', text: '#E9EDEF',
    sentLight: '#CFE8FF', recvLight: '#FFFFFF', bgLight: '#DCEBF8', textLight: '#111B21',
    header: '#1E4E79', tick: '#53BDEB',
  },
  {
    id: 'pearl-indigo-minimal', name: 'Pearl indigo minimal', variant: 'minimal',
    sent: '#4A148C', recv: '#2A1050', bg: '#1A0A2E', text: '#E9EDEF',
    sentLight: '#EDE7F6', recvLight: '#FFFFFF', bgLight: '#E9E4F5', textLight: '#111B21',
    header: '#4A148C', tick: '#53BDEB',
  },
  {
    id: 'whatsapp-green', name: 'WhatsApp green', variant: 'minimal',
    sent: '#00A884', recv: '#202C33', bg: '#0B141A', text: '#E9EDEF',
    sentLight: '#D9FDD3', recvLight: '#FFFFFF', bgLight: '#EFE7DC', textLight: '#111B21',
    header: '#00A884', tick: '#53BDEB',
  },
  {
    id: 'pearl-indigo', name: 'Pearl indigo', variant: 'pattern',
    sent: '#4A148C', recv: '#2A1050', bg: '#1A0A2E', text: '#E9EDEF',
    sentLight: '#EDE7F6', recvLight: '#FFFFFF', bgLight: '#E9E4F5', textLight: '#111B21',
    header: '#4A148C', tick: '#53BDEB',
  },
  {
    id: 'tyrian-purple', name: 'Tyrian purple', variant: 'minimal',
    sent: '#6A1B4D', recv: '#2A1020', bg: '#1A0A14', text: '#E9EDEF',
    sentLight: '#F3E5F5', recvLight: '#FFFFFF', bgLight: '#F5E8EF', textLight: '#111B21',
    header: '#6A1B4D', tick: '#53BDEB',
  },
  {
    id: 'sunset-orange', name: 'Sunset orange', variant: 'minimal',
    sent: '#C75B12', recv: '#2A1A10', bg: '#1A120A', text: '#E9EDEF',
    sentLight: '#FFE8D6', recvLight: '#FFFFFF', bgLight: '#FDEBD7', textLight: '#111B21',
    header: '#C75B12', tick: '#53BDEB',
  },
  {
    id: 'merino-teal', name: 'Merino teal', variant: 'minimal',
    sent: '#00796B', recv: '#122624', bg: '#0A1A18', text: '#E9EDEF',
    sentLight: '#D2F1EC', recvLight: '#FFFFFF', bgLight: '#D9EEE9', textLight: '#111B21',
    header: '#00796B', tick: '#53BDEB',
  },
  {
    id: 'royal-blue', name: 'Royal blue', variant: 'minimal',
    sent: '#1A56DB', recv: '#14213D', bg: '#0A1228', text: '#E9EDEF',
    sentLight: '#D6E4FF', recvLight: '#FFFFFF', bgLight: '#DFE9FB', textLight: '#111B21',
    header: '#1A56DB', tick: '#53BDEB',
  },
  {
    id: 'dark-cerulean', name: 'Dark cerulean', variant: 'minimal',
    sent: '#14457B', recv: '#101E2E', bg: '#0A1622', text: '#E9EDEF',
    sentLight: '#D0E4F5', recvLight: '#FFFFFF', bgLight: '#DCEAF5', textLight: '#111B21',
    header: '#14457B', tick: '#53BDEB',
  },
  {
    id: 'charcoal-green', name: 'Charcoal green', variant: 'minimal',
    sent: '#4A5D23', recv: '#1C2413', bg: '#12160B', text: '#E9EDEF',
    sentLight: '#E3EAD9', recvLight: '#FFFFFF', bgLight: '#E7EBDC', textLight: '#111B21',
    header: '#4A5D23', tick: '#53BDEB',
  },
  {
    id: 'persian-plum', name: 'Persian plum', variant: 'minimal',
    sent: '#7D1F3F', recv: '#2A1018', bg: '#180A10', text: '#E9EDEF',
    sentLight: '#F6DEE8', recvLight: '#FFFFFF', bgLight: '#F7E3EA', textLight: '#111B21',
    header: '#7D1F3F', tick: '#53BDEB',
  },
  {
    id: 'dune-mono', name: 'Dune mono', variant: 'minimal',
    sent: '#5D5346', recv: '#262019', bg: '#14100C', text: '#E9EDEF',
    sentLight: '#EDE8E0', recvLight: '#FFFFFF', bgLight: '#EFEAE2', textLight: '#111B21',
    header: '#5D5346', tick: '#53BDEB',
  },
];

export function getPreset(id: string | undefined): ChatThemeDef {
  return CHAT_THEME_PRESETS.find((p) => p.id === id) || DEFAULT_THEME;
}

/** Darken a #rrggbb colour by a factor (0–1). Used to derive dark-mode values from custom light picks. */
export function darken(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Build a full theme def from custom light-mode picks (dark values derived). */
export function buildCustomTheme(picks: {
  sent: string; recv: string; bg: string; header: string; text: string; tick: string;
}): ChatThemeDef {
  return {
    id: 'custom',
    name: 'Custom',
    variant: 'minimal',
    sent: darken(picks.sent, 0.42),
    recv: darken(picks.recv, 0.22),
    bg: darken(picks.bg, 0.12),
    text: '#E9EDEF',
    sentLight: picks.sent,
    recvLight: picks.recv,
    bgLight: picks.bg,
    textLight: picks.text,
    header: picks.header,
    tick: picks.tick,
  };
}

export function defaultState(): ChatThemeState {
  return { presetId: 'default', wallpaperImg: null, wallpaperColor: null, wallpaperDim: 100, wallpaperTile: false, appTheme: 'system' };
}

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

function sanitiseDef(raw: any, fallback: ChatThemeDef): ChatThemeDef {
  if (!raw || typeof raw !== 'object') return fallback;
  const pick = (v: unknown, fb: string) => (isHex(v) ? (v as string) : fb);
  return {
    id: 'custom',
    name: 'Custom',
    variant: raw.variant === 'pattern' ? 'pattern' : 'minimal',
    sent: pick(raw.sent, fallback.sent),
    recv: pick(raw.recv, fallback.recv),
    bg: pick(raw.bg, fallback.bg),
    text: pick(raw.text, fallback.text),
    sentLight: pick(raw.sentLight, fallback.sentLight),
    recvLight: pick(raw.recvLight, fallback.recvLight),
    bgLight: pick(raw.bgLight, fallback.bgLight),
    textLight: pick(raw.textLight, fallback.textLight),
    header: pick(raw.header, fallback.header),
    tick: pick(raw.tick, fallback.tick),
  };
}

export function getChatThemeState(): ChatThemeState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const state: ChatThemeState = {
        presetId: typeof p.presetId === 'string' ? p.presetId : 'default',
        wallpaperImg: typeof p.wallpaperImg === 'string' ? p.wallpaperImg : null,
        wallpaperColor: isHex(p.wallpaperColor) ? p.wallpaperColor : null,
        wallpaperDim: typeof p.wallpaperDim === 'number' ? Math.max(0, Math.min(100, p.wallpaperDim)) : 100,
        wallpaperTile: p.wallpaperTile === true,
        appTheme: p.appTheme === 'light' || p.appTheme === 'dark' || p.appTheme === 'system' ? p.appTheme : 'system',
      };
      if (p.custom) state.custom = sanitiseDef(p.custom, DEFAULT_THEME);
      if (state.presetId !== 'custom' && !CHAT_THEME_PRESETS.some((t) => t.id === state.presetId)) {
        state.presetId = 'default';
      }
      return state;
    }
  } catch (err) {
    console.warn("[chatTheme] getChatThemeState: const raw = localStorage.getItem(STATE_KEY) fa...", err);
  }
  // First run after the theme fix: migrate the legacy preset (if any) so an
  // existing user's theme is not lost.
  try {
    const legacyName = localStorage.getItem('dttheme');
    const legacy = legacyName
      ? CHAT_THEME_PRESETS.find((t) => t.name === legacyName)
      : undefined;
    const s = defaultState();
    if (legacy) s.presetId = legacy.id;
    const img = localStorage.getItem('dtimg');
    if (img) s.wallpaperImg = img;
    const wall = localStorage.getItem('dtwall');
    if (wall && isHex(wall)) s.wallpaperColor = wall;
    return s;
  } catch (err) {
    console.warn("[chatTheme] getChatThemeState: const legacyName = localStorage.getItem('dtthe...", err);
  }
  return defaultState();
}

export function resolveTheme(state: ChatThemeState): ChatThemeDef {
  if (state.presetId === 'custom' && state.custom) return state.custom;
  return getPreset(state.presetId);
}

export function getCurrentThemeName(): string {
  const s = getChatThemeState();
  return resolveTheme(s).name;
}

/** Write the theme's colours into CSS variables (index.css reads them). */
export function applyThemeVars(def: ChatThemeDef): void {
  try {
    const root = document.documentElement.style;
    root.setProperty('--color-sent-bubble', def.sent);
    root.setProperty('--color-recv-bubble', def.recv);
    root.setProperty('--color-sent-bubble-light', def.sentLight);
    root.setProperty('--color-recv-bubble-light', def.recvLight);
    root.setProperty('--color-chat-bg', def.bg);
    root.setProperty('--color-chat-bg-light', def.bgLight);
    root.setProperty('--color-bubble-text', def.text);
    root.setProperty('--color-bubble-text-light', def.textLight);
    root.setProperty('--chat-header', def.header);
    /* --chat-tick is intentionally NOT set here. A single tick colour
       cannot serve both sent bubbles: #53BDEB is 1.86:1 on the light
       sent bubble #DCF8C6, and the readable light value #0284C7 is
       1.95:1 on the dark sent bubble #005C4B. index.css defines the
       tick per colour scheme instead (:root #0284C7 / .dark #53BDEB,
       plus --chat-tick-grey). The theme's `tick` field is still read
       by the ChatThemePicker preview; making a custom tick live again
       needs a mode-aware tick (light + dark) in the theme def. */
  } catch (err) {
    console.warn("[chatTheme] applyThemeVars: const root = document.documentElement.style failed", err);
  }
}

/** Persist + apply a global theme state; keeps legacy keys in sync. */
export function saveChatThemeState(state: ChatThemeState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("[chatTheme] saveChatThemeState: localStorage.setItem(STATE_KEY, JSON.stringif...", err);
  }
  const def = resolveTheme(state);
  applyThemeVars(def);
  try {
    localStorage.setItem('dtwall', def.bg);
    localStorage.setItem('dtsentcol', def.sent);
    localStorage.setItem('dtrecvcol', def.recv);
    localStorage.setItem('dttheme', def.name);
    if (state.wallpaperImg) localStorage.setItem('dtimg', state.wallpaperImg);
    else localStorage.removeItem('dtimg');
  } catch (err) {
    console.warn("[chatTheme] saveChatThemeState: localStorage.setItem('dtwall', def.bg) failed", err);
  }
}

/** Reset everything to the WhatsApp Classic Pro default. */
export function resetChatTheme(): ChatThemeState {
  const s = defaultState();
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem('dtwall');
    localStorage.removeItem('dtimg');
    localStorage.removeItem('dtsentcol');
    localStorage.removeItem('dtrecvcol');
    localStorage.removeItem('dttheme');
  } catch (err) {
    console.warn("[chatTheme] resetChatTheme: localStorage.removeItem(STATE_KEY) failed", err);
  }
  applyThemeVars(DEFAULT_THEME);
  return s;
}

// ── App theme: Light / Dark / System default ──────────────────────────────

export function getAppTheme(): AppThemeMode {
  try {
    const v = localStorage.getItem(APP_THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
    // Migrate the legacy 'theme' key (App.tsx wrote 'dark' / 'light').
    const legacy = localStorage.getItem(LEGACY_THEME_KEY);
    if (legacy === 'dark' || legacy === 'light') return legacy;
    // A theme state saved before this fix may carry appTheme.
    return getChatThemeState().appTheme;
  } catch (err) {
    console.warn("[chatTheme] getAppTheme: const v = localStorage.getItem(APP_THEME_KEY) failed...", err);
  }
  return 'system';
}

export function isSystemDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

export function effectiveDark(mode?: AppThemeMode): boolean {
  const m = mode || getAppTheme();
  if (m === 'dark') return true;
  if (m === 'light') return false;
  return isSystemDark();
}

/** Apply an app-theme mode (toggles the .dark class). Returns effective dark. */
export function applyAppTheme(mode: AppThemeMode): boolean {
  const dark = effectiveDark(mode);
  try {
    localStorage.setItem(APP_THEME_KEY, mode);
    localStorage.setItem(LEGACY_THEME_KEY, dark ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', dark);
  } catch (err) {
    console.warn("[chatTheme] applyAppTheme: localStorage.setItem(APP_THEME_KEY, mode) failed; ...", err);
  }
  return dark;
}

/** Follow device changes while mode is 'system'. Returns an unsubscribe fn. */
export function installAppThemeListener(onChange: (dark: boolean) => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (getAppTheme() === 'system') onChange(mq.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  } catch {
    return () => {};
  }
}

/** Restore both the chat theme and the app theme on startup (main.tsx). */
export function restoreChatTheme(): void {
  const state = getChatThemeState();
  applyThemeVars(resolveTheme(state));
  // 100M-D1: single source of truth for the app theme is `dt_app_theme`
  // (getAppTheme). The old code applied state.appTheme — which stays
  // 'system' unless a theme is Saved after the toggle — clobbering a
  // dark-mode choice made via the Privacy toggle or the theme tab, both
  // of which only write dt_app_theme. getAppTheme() still falls back to
  // state.appTheme for legacy states that carry it.
  applyAppTheme(getAppTheme());
}

// ── Per-chat wallpaper / theme ────────────────────────────────────────────

function perChatKey(chatId: string): string {
  return `dt_chat_wall_${chatId}`;
}

export function getPerChatTheme(chatId: string): PerChatTheme {
  try {
    const raw = localStorage.getItem(perChatKey(chatId));
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        return {
          useDefault: p.useDefault !== false,
          presetId: typeof p.presetId === 'string' ? p.presetId : undefined,
          custom: p.custom ? sanitiseDef(p.custom, DEFAULT_THEME) : undefined,
          wallpaperImg: typeof p.wallpaperImg === 'string' ? p.wallpaperImg : null,
          wallpaperColor: isHex(p.wallpaperColor) ? p.wallpaperColor : null,
          wallpaperDim: typeof p.wallpaperDim === 'number' ? Math.max(0, Math.min(100, p.wallpaperDim)) : undefined,
          wallpaperTile: p.wallpaperTile === true ? true : undefined,
        };
      }
    }
  } catch (err) {
    console.warn("[chatTheme] getPerChatTheme: const raw = localStorage.getItem(perChatKey(chat...", err);
  }
  return { useDefault: true };
}

export function savePerChatTheme(chatId: string, per: PerChatTheme): void {
  try {
    localStorage.setItem(perChatKey(chatId), JSON.stringify(per));
  } catch (err) {
    console.warn("[chatTheme] savePerChatTheme: localStorage.setItem(perChatKey(chatId), JSON.s...", err);
  }
}

export function resetPerChatTheme(chatId: string): void {
  try {
    localStorage.removeItem(perChatKey(chatId));
  } catch (err) {
    console.warn("[chatTheme] resetPerChatTheme: localStorage.removeItem(perChatKey(chatId)) fa...", err);
  }
}

/** Resolve what a chat should actually look like (per-chat override or global). */
export function getChatThemeFor(chatId: string): ResolvedChatLook {
  const global = getChatThemeState();
  const per = getPerChatTheme(chatId);
  if (per.useDefault) {
    return {
      def: resolveTheme(global),
      wallpaperImg: global.wallpaperImg || null,
      wallpaperColor: global.wallpaperColor || null,
      wallpaperDim: global.wallpaperDim,
      wallpaperTile: global.wallpaperTile === true,
      isCustom: false,
    };
  }
  const def = per.presetId === 'custom' && per.custom ? per.custom : getPreset(per.presetId);
  return {
    def,
    wallpaperImg: per.wallpaperImg !== undefined ? per.wallpaperImg : global.wallpaperImg || null,
    wallpaperColor: per.wallpaperColor !== undefined ? per.wallpaperColor : global.wallpaperColor || null,
    wallpaperDim: per.wallpaperDim !== undefined ? per.wallpaperDim : global.wallpaperDim,
    wallpaperTile: per.wallpaperTile !== undefined ? per.wallpaperTile : global.wallpaperTile === true,
    isCustom: true,
  };
}

// ── Per-chat "Light chat theme" toggle (ChatScreen menu) ────────────────
// WA parity (wa-verify-settings-3, rows 38/39/40): the toggle lives in a
// chat's menu, so its pref is per-chat. The old key (`dt_chat_theme`) was
// GLOBAL — toggling "Light chat theme" in one chat stripped the wallpaper
// from every chat. New key is per chat; reads fall back to the legacy
// global key so an existing user's setting is kept.
const LIGHT_THEME_KEY = 'dt_chat_theme';

export function getLightChatTheme(chatId: string): boolean {
  try {
    const per = localStorage.getItem(`${LIGHT_THEME_KEY}_${chatId}`);
    if (per === 'light' || per === 'default') return per === 'light';
    return localStorage.getItem(LIGHT_THEME_KEY) === 'light';
  } catch {
    return false;
  }
}

export function setLightChatTheme(chatId: string, light: boolean): void {
  try {
    localStorage.setItem(`${LIGHT_THEME_KEY}_${chatId}`, light ? 'light' : 'default');
  } catch (err) {
    console.warn('[chatTheme] setLightChatTheme: localStorage write failed', err);
  }
}

// ── Doodle pattern wallpaper (for 'pattern' variants) ─────────────────────

/** Subtle WhatsApp-style doodle pattern as a data URI (tinted per mode). */
export function patternDataUri(dark: boolean): string {
  const stroke = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.045)';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">` +
    `<g fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round">` +
    `<circle cx="30" cy="30" r="12"/><path d="M70 20 q10 12 20 0"/><circle cx="150" cy="40" r="8"/>` +
    `<path d="M180 90 q12 10 24 0"/><rect x="20" y="90" width="18" height="14" rx="7"/>` +
    `<path d="M100 70 l8 8 M108 70 l-8 8"/><circle cx="180" cy="160" r="10"/>` +
    `<path d="M40 160 q10 -12 20 0"/><rect x="110" y="140" width="20" height="14" rx="7"/>` +
    `<circle cx="70" cy="195" r="7"/><path d="M150 195 q10 10 20 0"/></g></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Solid wallpaper colour swatches offered in the picker. */
export const WALLPAPER_COLOURS = ['#EFE7DC', '#DCEBF8', '#FDEBD7', '#E9E4F5', '#D9EEE9', '#F7E3EA', '#0B141A', '#111B21'];

/**
 * WhatsApp wallpaper art bundled with the app (public/wallpapers/, copied
 * from the WhatsApp Web client inventory — classic doodle wallpapers, not
 * brand logos and not user profile photos). `tile` marks the small dark
 * pattern (320×70) that must repeat instead of stretching to cover.
 * NOTE: Meta-drawn art — licensing is the user's call before public launch.
 */
export interface WaWallpaper {
  id: string;
  label: string;
  src: string;
  tile?: boolean;
}

export const WA_WALLPAPERS: WaWallpaper[] = [
  { id: 'wa-doodle-light', label: 'WhatsApp doodle (light)', src: '/wallpapers/wa-doodle-light.webp' },
  { id: 'wa-doodle-orange', label: 'WhatsApp doodle (orange)', src: '/wallpapers/wa-doodle-orange.webp' },
  { id: 'wa-pattern-dark', label: 'WhatsApp pattern (dark)', src: '/wallpapers/wa-pattern-dark.webp', tile: true },
];
