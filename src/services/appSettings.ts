/**
 * App-wide settings preferences (Phase 4, Worker C): notification tones,
 * font size, and data-usage / auto-download prefs. All persisted in
 * localStorage (per-device prefs, not synced to the user doc — a tone or
 * font size is a device preference, like the theme).
 *
 * NOTIFICATION TONES: there was no tone system in the codebase — the only
 * WebAudio sound was the call ringtone in callService.ts. Tones here are
 * small named WebAudio beep patterns (oscillator, no audio files), so
 * preview works offline on web and Android WebView. `playNotificationTone()`
 * is exported for the push-notification path to call; it is NOT yet wired
 * into pushNotifications.ts (not owned by Worker C) — see PATCH notes.
 *
 * FONT SIZE: applied by setting the root element's font-size (Tailwind
 * utilities are rem-based, so the whole app scales). `applyFontSize()`
 * must also run at startup — main.tsx is not owned by Worker C, so the
 * coordinator must add one line there (see PATCH notes); Settings applies
 * it live on change and on mount.
 *
 * DATA USAGE: prefs only. Enforcement point is the media rendering in
 * ChatScreen.tsx (not owned by Worker C): it should call
 * `shouldAutoDownload('photo' | 'video')` before rendering an <img>/<video>
 * with its remote URL, and render a tap-to-download placeholder instead
 * when it returns false. 'wifi' cannot be reliably detected on web
 * (navigator.connection is best-effort and often absent); on the Android
 * app it is a best-effort hint only — documented, not faked.
 */

export type FontSize = 'small' | 'medium' | 'large';
export type AutoDownloadMode = 'wifi' | 'always' | 'never';

const TONE_KEY = 'pinglo_notification_tone';
const FONT_KEY = 'pinglo_font_size';
const DATA_USAGE_KEY = 'pinglo_data_usage';

export interface NotificationTone {
  id: string;
  label: string;
  /** [frequencyHz, durationMs] notes played in sequence. Empty = silent. */
  notes: [number, number][];
}

export const NOTIFICATION_TONES: NotificationTone[] = [
  { id: 'default', label: 'Default', notes: [[880, 180]] },
  { id: 'chime', label: 'Chime', notes: [[880, 150], [1318, 250]] },
  { id: 'ding', label: 'Ding', notes: [[1318, 120]] },
  { id: 'pop', label: 'Pop', notes: [[440, 90], [880, 160]] },
  { id: 'silent', label: 'Silent', notes: [] },
];

export function getNotificationTone(): string {
  try {
    const v = localStorage.getItem(TONE_KEY);
    if (NOTIFICATION_TONES.some((t) => t.id === v)) return v as string;
  } catch (err) {
    console.warn("[appSettings] getNotificationTone: const v = localStorage.getItem(TONE_KEY) f...", err);
  }
  return 'default';
}

export function setNotificationTone(id: string): void {
  try {
    localStorage.setItem(TONE_KEY, id);
  } catch (err) {
    console.warn("[appSettings] setNotificationTone: localStorage.setItem(TONE_KEY, id) failed", err);
  }
}

/** Play a tone by id (or the saved tone when no id is given). No-op when silent/unavailable. */
export function playNotificationTone(id?: string): void {
  try {
    const tone = NOTIFICATION_TONES.find((t) => t.id === (id || getNotificationTone()));
    if (!tone || tone.notes.length === 0) return;
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC();
    let at = ctx.currentTime;
    for (const [freq, ms] of tone.notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + ms / 1000 + 0.05);
      at += ms / 1000 + 0.03;
    }
    // Free the context shortly after the last note.
    const totalMs = tone.notes.reduce((s, [, ms]) => s + ms + 30, 0) + 300;
    setTimeout(() => ctx.close().catch((err) => console.warn("[appSettings] playNotificationTone: close(...) failed", err)), totalMs);
  } catch (err) {
    console.warn("[appSettings] playNotificationTone: const tone = NOTIFICATION_TONES.find((t) ...", err);
  }
}

const FONT_PX: Record<FontSize, number> = { small: 14, medium: 16, large: 18 };

export function getFontSize(): FontSize {
  try {
    const v = localStorage.getItem(FONT_KEY);
    if (v === 'small' || v === 'medium' || v === 'large') return v;
  } catch (err) {
    console.warn("[appSettings] getFontSize: const v = localStorage.getItem(FONT_KEY) failed; u...", err);
  }
  return 'medium';
}

/** Applies the font size live (root font-size; Tailwind rem utilities scale with it).
 *  Message-body text does NOT use rem — it uses .dt-msg-text, which reads
 *  --dt-msg-font-size set here from FONT_PX (index.css); keep the two in sync. */
export function applyFontSize(size?: FontSize): void {
  const s = size || getFontSize();
  try {
    document.documentElement.style.fontSize = `${FONT_PX[s]}px`;
    document.documentElement.dataset.dtFontSize = s;
    localStorage.setItem(FONT_KEY, s);
  } catch (err) {
    console.warn("[appSettings] applyFontSize: document.documentElement.style.fontSize = `${FON...", err);
  }
}

export interface DataUsagePrefs {
  photos: AutoDownloadMode;
  videos: AutoDownloadMode;
  documents: AutoDownloadMode;
  /** WA parity (audit e #41): Audio row alongside Photos/Videos/Documents. */
  audio: AutoDownloadMode;
}

export function getDataUsagePrefs(): DataUsagePrefs {
  try {
    const raw = localStorage.getItem(DATA_USAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const mode = (v: unknown): AutoDownloadMode => (v === 'always' || v === 'never' || v === 'wifi' ? v : 'wifi');
      return { photos: mode(p.photos), videos: mode(p.videos), documents: mode(p.documents), audio: mode(p.audio) };
    }
  } catch (err) {
    console.warn("[appSettings] getDataUsagePrefs: const raw = localStorage.getItem(DATA_USAGE_...", err);
  }
  return { photos: 'wifi', videos: 'wifi', documents: 'wifi', audio: 'wifi' };
}

export function setDataUsagePrefs(prefs: DataUsagePrefs): void {
  try {
    localStorage.setItem(DATA_USAGE_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn("[appSettings] setDataUsagePrefs: localStorage.setItem(DATA_USAGE_KEY, JSON.st...", err);
  }
}

/**
 * Best-effort "on Wi-Fi?" check. navigator.connection is not available in
 * all browsers/WebViews and never reliably reports Wi-Fi vs cellular on
 * web, so 'wifi' mode treats an unknown connection as Wi-Fi (downloads)
 * rather than blocking media the user expects. Returns true when the
 * connection is known to be cellular/metered.
 */
export function isCellularConnection(): boolean {
  try {
    const conn = (navigator as any).connection;
    if (!conn) return false;
    const type = String(conn.type || '').toLowerCase();
    if (type === 'cellular') return true;
    if (conn.saveData) return true;
    return false;
  } catch {
    return false;
  }
}

/** Should media of this kind auto-download right now? Enforcement point: ChatScreen media rendering. */
export function shouldAutoDownload(kind: 'photo' | 'video' | 'document' | 'audio'): boolean {
  const prefs = getDataUsagePrefs();
  const mode = kind === 'photo' ? prefs.photos : kind === 'video' ? prefs.videos : kind === 'audio' ? prefs.audio : prefs.documents;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return !isCellularConnection(); // 'wifi'
}

// ── WA parity (audit e top-10): auto-download quality, link previews,
// block-unknown-messages, keep-chats-archived ─────────────────────────
// All four are per-device localStorage prefs. Enforcement points:
//  - auto-download quality: the media download path (ChatScreen) —
//    per media type (Wave-2 Media A12): HD downloads the original,
//    Standard downloads the compressed variant; the download path reads
//    it via shouldDownloadHd('photo' | 'video') below. No server
//    involvement. Audio/documents have no HD variant (HD is a
//    photo/video concept in WA too), so they carry no HD choice.
//  - link previews: ChatScreen / SavedMessages gate LinkPreviewCard.
//  - block unknown messages: the push-notification watcher skips senders
//    who are not saved contacts and have no proven DM conversation
//    (contacts.ts getAllowedContactUids). Messages still arrive in the
//    chat list — full server-side blocking needs backend rules.
//  - keep chats archived: ChatListScreen — when ON (default, today's
//    behaviour) archived chats stay in the Archived view even with new
//    messages; when OFF, an archived chat with unread messages resurfaces
//    in the main list until read.

export type AutoDownloadQuality = 'standard' | 'hd';
const AUTO_DOWNLOAD_QUALITY_KEY = 'dt_auto_download_quality';
const LINK_PREVIEWS_KEY = 'dt_link_previews';
const BLOCK_UNKNOWN_MESSAGES_KEY = 'dt_block_unknown_messages';
const KEEP_CHATS_ARCHIVED_KEY = 'dt_keep_chats_archived';

/**
 * Wave-2 Media A12 — per-type HD auto-download choice. WA: "Photos will
 * be automatically downloaded in HD quality, but videos will not." /
 * "Photos and videos will be automatically downloaded in HD quality." /
 * "You can choose which photos or videos to download in HD quality."
 * Default matches WA's: photos HD, videos not.
 */
export interface HdAutoDownloadPrefs {
  photos: boolean;
  videos: boolean;
}

const HD_AUTO_DOWNLOAD_KEY = 'dt_hd_auto_download';

export const DEFAULT_HD_AUTO_DOWNLOAD: HdAutoDownloadPrefs = { photos: true, videos: false };

export function getHdAutoDownloadPrefs(): HdAutoDownloadPrefs {
  try {
    const raw = localStorage.getItem(HD_AUTO_DOWNLOAD_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return { photos: p.photos === true, videos: p.videos === true };
    }
    // One-time migration from the old single global quality toggle
    // (Wave-1 audit e #42): 'hd' meant both types HD; 'standard' showed
    // the photos-HD-only sentence in Settings, so it maps to photos-only.
    const legacy = localStorage.getItem(AUTO_DOWNLOAD_QUALITY_KEY);
    if (legacy === 'hd') return { photos: true, videos: true };
    if (legacy === 'standard') return { photos: true, videos: false };
  } catch (err) {
    console.warn('[appSettings] getHdAutoDownloadPrefs: read failed', err);
  }
  return { ...DEFAULT_HD_AUTO_DOWNLOAD };
}

export function setHdAutoDownloadPrefs(prefs: HdAutoDownloadPrefs): void {
  try {
    localStorage.setItem(HD_AUTO_DOWNLOAD_KEY, JSON.stringify({ photos: !!prefs.photos, videos: !!prefs.videos }));
  } catch (err) {
    console.warn('[appSettings] setHdAutoDownloadPrefs: write failed', err);
  }
}

/**
 * Should media of this kind auto-download in HD? Per-type (Wave-2 Media
 * A12). No-arg form answers "is HD on for any type" for callers that
 * only need a global answer.
 */
export function shouldDownloadHd(kind?: 'photo' | 'video'): boolean {
  const prefs = getHdAutoDownloadPrefs();
  if (kind === 'photo') return prefs.photos;
  if (kind === 'video') return prefs.videos;
  return prefs.photos || prefs.videos;
}

/**
 * Legacy single global quality (Wave-1 audit e #42), kept as a thin
 * wrapper over the per-type prefs so older callers keep working:
 * 'hd' = both types HD, 'standard' = photos HD only.
 */
export function getAutoDownloadQuality(): AutoDownloadQuality {
  const prefs = getHdAutoDownloadPrefs();
  return prefs.photos && prefs.videos ? 'hd' : 'standard';
}

export function setAutoDownloadQuality(q: AutoDownloadQuality): void {
  setHdAutoDownloadPrefs(q === 'hd' ? { photos: true, videos: true } : { photos: true, videos: false });
}

export function getLinkPreviewsEnabled(): boolean {
  try {
    return localStorage.getItem(LINK_PREVIEWS_KEY) !== '0';
  } catch (err) {
    console.warn('[appSettings] getLinkPreviewsEnabled: read failed', err);
  }
  return true;
}

export function setLinkPreviewsEnabled(on: boolean): void {
  try {
    localStorage.setItem(LINK_PREVIEWS_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn('[appSettings] setLinkPreviewsEnabled: write failed', err);
  }
}

export function getBlockUnknownMessages(): boolean {
  try {
    return localStorage.getItem(BLOCK_UNKNOWN_MESSAGES_KEY) === '1';
  } catch (err) {
    console.warn('[appSettings] getBlockUnknownMessages: read failed', err);
  }
  return false;
}

export function setBlockUnknownMessages(on: boolean): void {
  try {
    localStorage.setItem(BLOCK_UNKNOWN_MESSAGES_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn('[appSettings] setBlockUnknownMessages: write failed', err);
  }
}

// Wave-2 C3 (Settings #16b — security notifications): alerts when a
// contact's security code (E2EE identity key) changes, e.g. after they
// reinstall or switch phones. WA shows these by default; the toggle
// lives in Settings → Account. Default ON: an unset key means enabled,
// only an explicit '0' turns alerts off.
const SECURITY_NOTIFICATIONS_KEY = 'dt_security_notifications';

export function getSecurityNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(SECURITY_NOTIFICATIONS_KEY) !== '0';
  } catch (err) {
    console.warn('[appSettings] getSecurityNotificationsEnabled: read failed', err);
  }
  return true;
}

export function setSecurityNotificationsEnabled(on: boolean): void {
  try {
    localStorage.setItem(SECURITY_NOTIFICATIONS_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn('[appSettings] setSecurityNotificationsEnabled: write failed', err);
  }
}

export function getKeepChatsArchived(): boolean {
  try {
    return localStorage.getItem(KEEP_CHATS_ARCHIVED_KEY) !== '0';
  } catch (err) {
    console.warn('[appSettings] getKeepChatsArchived: read failed', err);
  }
  return true;
}

export function setKeepChatsArchived(on: boolean): void {
  try {
    localStorage.setItem(KEEP_CHATS_ARCHIVED_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn('[appSettings] setKeepChatsArchived: write failed', err);
  }
}

// ── Chats settings (Theme fix, WhatsApp Web parity) ─────────────────────
// Media upload quality, spell check, replace-text-with-emoji and
// Enter-is-send. All are device prefs (localStorage) enforced by ChatScreen
// / the upload path — they never leave the device.

export type MediaUploadQuality = 'auto' | 'best' | 'data-saver';
const UPLOAD_QUALITY_KEY = 'dt_media_upload_quality';
const SPELL_CHECK_KEY = 'dt_spell_check';
const REPLACE_EMOJI_KEY = 'dt_replace_emoji';
const ENTER_IS_SEND_KEY = 'dt_enter_is_send';
const DEFAULT_DISAPPEARING_KEY = 'dt_default_disappearing';

export function getMediaUploadQuality(): MediaUploadQuality {
  try {
    const v = localStorage.getItem(UPLOAD_QUALITY_KEY);
    if (v === 'best' || v === 'data-saver') return v;
  } catch (err) {
    console.warn("[appSettings] getMediaUploadQuality: const v = localStorage.getItem(UPLOAD_QU...", err);
  }
  return 'auto';
}

export function setMediaUploadQuality(q: MediaUploadQuality): void {
  try {
    localStorage.setItem(UPLOAD_QUALITY_KEY, q);
  } catch (err) {
    console.warn("[appSettings] setMediaUploadQuality: localStorage.setItem(UPLOAD_QUALITY_KEY,...", err);
  }
}

/** JPEG compression used by the S3 image path (storage.ts). */
export function getUploadCompression(): { maxDimension: number; quality: number } {
  const q = getMediaUploadQuality();
  if (q === 'best') return { maxDimension: 2560, quality: 0.95 };
  if (q === 'data-saver') return { maxDimension: 1024, quality: 0.6 };
  return { maxDimension: 1600, quality: 0.82 }; // Auto
}

export function getSpellCheck(): boolean {
  try {
    return localStorage.getItem(SPELL_CHECK_KEY) !== '0';
  } catch (err) {
    console.warn("[appSettings] getSpellCheck: return localStorage.getItem(SPELL_CHECK_KEY) !==...", err);
  }
  return true;
}

export function setSpellCheck(on: boolean): void {
  try {
    localStorage.setItem(SPELL_CHECK_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn("[appSettings] setSpellCheck: localStorage.setItem(SPELL_CHECK_KEY, on ? '1' :...", err);
  }
}

export function getReplaceEmoji(): boolean {
  try {
    return localStorage.getItem(REPLACE_EMOJI_KEY) !== '0';
  } catch (err) {
    console.warn("[appSettings] getReplaceEmoji: return localStorage.getItem(REPLACE_EMOJI_KEY)...", err);
  }
  return true;
}

export function setReplaceEmoji(on: boolean): void {
  try {
    localStorage.setItem(REPLACE_EMOJI_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn("[appSettings] setReplaceEmoji: localStorage.setItem(REPLACE_EMOJI_KEY, on ? '...", err);
  }
}

export function getEnterIsSend(): boolean {
  try {
    return localStorage.getItem(ENTER_IS_SEND_KEY) !== '0';
  } catch (err) {
    console.warn("[appSettings] getEnterIsSend: return localStorage.getItem(ENTER_IS_SEND_KEY) ...", err);
  }
  return true;
}

export function setEnterIsSend(on: boolean): void {
  try {
    localStorage.setItem(ENTER_IS_SEND_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn("[appSettings] setEnterIsSend: localStorage.setItem(ENTER_IS_SEND_KEY, on ? '1...", err);
  }
}

/** Default disappearing-messages timer for NEW chats (seconds; 0 = off). */
export function getDefaultDisappearing(): number {
  try {
    const v = Number(localStorage.getItem(DEFAULT_DISAPPEARING_KEY));
    if (v === 86400 || v === 604800 || v === 7776000) return v;
  } catch (err) {
    console.warn("[appSettings] getDefaultDisappearing: const v = Number(localStorage.getItem(D...", err);
  }
  return 0;
}

export function setDefaultDisappearing(seconds: number): void {
  try {
    localStorage.setItem(DEFAULT_DISAPPEARING_KEY, String(seconds));
  } catch (err) {
    console.warn("[appSettings] setDefaultDisappearing: localStorage.setItem(DEFAULT_DISAPPEARI...", err);
  }
}

// ── Notification prefs (Theme fix, WhatsApp parity) ─────────────────────
// Group tone, vibrate, popup banner and message preview. The in-app banner
// is NotificationBanner; the system Notification is used when the tab is
// hidden. Closed-app delivery still needs the server sender (see PATCH).

export type VibrateMode = 'off' | 'default' | 'short' | 'long';
export type PopupMode = 'off' | 'screen-off' | 'always';

export interface NotificationPrefs {
  groupTone: string;
  vibrate: VibrateMode;
  popup: PopupMode;
  showPreview: boolean;
  /** WA parity (audit e #53): "Play sounds for incoming messages". */
  incomingSound: boolean;
  /** WA parity (audit e #53): "Play sounds for outgoing messages". */
  outgoingSound: boolean;
  /** WA parity (audit e #59): "Show reaction notifications". */
  showReactionNotifications: boolean;
  /** WA-verify-5 #55: WhatsApp has a separate "Show notifications for
   * incoming calls" toggle — DT's master "Show notifications" used to
   * gate messages and calls together, so calls could not be silenced
   * without silencing messages (or vice versa). Default true. */
  callNotifications: boolean;
}

const NOTIF_PREFS_KEY = 'dt_notif_prefs';

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(NOTIF_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        groupTone: typeof p.groupTone === 'string' ? p.groupTone : 'default',
        vibrate: p.vibrate === 'off' || p.vibrate === 'short' || p.vibrate === 'long' ? p.vibrate : 'default',
        popup: p.popup === 'off' || p.popup === 'screen-off' ? p.popup : 'always',
        showPreview: p.showPreview !== false,
        // WA parity (audit e #53/#59): all three default ON so existing
        // installs keep today's behaviour (sounds played, reactions
        // notified); only an explicit `false` turns one off.
        incomingSound: p.incomingSound !== false,
        outgoingSound: p.outgoingSound !== false,
        showReactionNotifications: p.showReactionNotifications !== false,
        callNotifications: p.callNotifications !== false,
      };
    }
  } catch (err) {
    console.warn("[appSettings] getNotificationPrefs: const raw = localStorage.getItem(NOTIF_PR...", err);
  }
  return { groupTone: 'default', vibrate: 'default', popup: 'always', showPreview: true, callNotifications: true, incomingSound: true, outgoingSound: true, showReactionNotifications: true };
}

/**
 * WA parity (audit e #53): the short "sent" sound for a message this
 * user just sent. No outgoing sound existed before — incoming tones were
 * the only playback — so this is the playback point the outgoing toggle
 * gates. A short single 'pop' (not the notification tone): WA's outgoing
 * sound is distinct from the incoming one, and the notification tone
 * stays the incoming sound. No-op when the outgoing toggle is off, when
 * quiet hours are active, or when audio is unavailable. Callers: the
 * text-send path (ChatScreen sendTextNow — covers handleSend and the
 * flood-guard queue). Media / voice-note sends do not play it yet.
 */
export function playOutgoingMessageTone(): void {
  try {
    if (!getNotificationPrefs().outgoingSound) return;
    if (isQuietHoursActive()) return;
    playNotificationTone('pop');
  } catch (err) {
    console.warn('[appSettings] playOutgoingMessageTone failed', err);
  }
}

export function setNotificationPrefs(patch: Partial<NotificationPrefs>): void {
  try {
    localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify({ ...getNotificationPrefs(), ...patch }));
  } catch (err) {
    console.warn("[appSettings] setNotificationPrefs: localStorage.setItem(NOTIF_PREFS_KEY, JSO...", err);
  }
}

/** Vibrate (Android WebView / supported browsers) per the vibrate setting. */
export function vibrateForNotification(): void {
  try {
    const mode = getNotificationPrefs().vibrate;
    if (mode === 'off' || !('vibrate' in navigator)) return;
    if (mode === 'short') navigator.vibrate(80);
    else if (mode === 'long') navigator.vibrate([400, 100, 400]);
    else navigator.vibrate(200);
  } catch (err) {
    console.warn("[appSettings] vibrateForNotification: const mode = getNotificationPrefs().vib...", err);
  }
}

// ── Report 3 #65 — quiet hours + per-chat tones ─────────────────────────
// The report found: tones are synthesized sine beeps with no per-chat tone
// (only global message + group tone), no per-chat notification settings
// from the chat screen, and no quiet-hours / DND schedule for messages.
// This adds the per-device pref layer and the enforcement points:
// pushNotifications skips the tone + vibration while quiet hours are
// active (the banner still shows — nothing is lost) and plays the
// per-chat tone when one is set for the conversation.
// HONEST GAPS (no UI yet — SettingsScreen / ChatScreen are owned by other
// batches): there is still no Settings UI to set quiet hours, no chat
// screen UI to pick a per-chat tone, and the tones themselves are still
// the synthesized WebAudio beeps (real notification sound files + native
// sound support are a separate asset/native job).
export interface QuietHours {
  enabled: boolean;
  /** "HH:MM" 24h local time; the range may wrap past midnight. */
  start: string;
  end: string;
}

const QUIET_HOURS_KEY = 'pinglo_quiet_hours';
const CHAT_TONES_KEY = 'pinglo_chat_tones';

export function getQuietHours(): QuietHours {
  try {
    const raw = localStorage.getItem(QUIET_HOURS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const hhmm = (v: unknown, fallback: string): string =>
        typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
      return {
        enabled: p.enabled === true,
        start: hhmm(p.start, '22:00'),
        end: hhmm(p.end, '08:00'),
      };
    }
  } catch (err) {
    console.warn("[appSettings] getQuietHours: failed to read quiet-hours prefs", err);
  }
  return { enabled: false, start: '22:00', end: '08:00' };
}

export function setQuietHours(patch: Partial<QuietHours>): void {
  try {
    localStorage.setItem(QUIET_HOURS_KEY, JSON.stringify({ ...getQuietHours(), ...patch }));
  } catch (err) {
    console.warn("[appSettings] setQuietHours: failed to save quiet-hours prefs", err);
  }
}

/** True when quiet hours are enabled and `at` (default now) falls inside the range. */
export function isQuietHoursActive(at?: Date): boolean {
  const q = getQuietHours();
  if (!q.enabled) return false;
  const now = at || new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const toMins = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMins(q.start);
  const end = toMins(q.end);
  if (start === end) return false; // empty range
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end; // wraps past midnight
}

/** Per-chat notification tone id (conversationId → tone id), or '' when none is set. */
export function getChatTone(conversationId?: string): string {
  if (!conversationId) return '';
  try {
    const raw = localStorage.getItem(CHAT_TONES_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      const id = typeof map?.[conversationId] === 'string' ? map[conversationId] : '';
      if (id && NOTIFICATION_TONES.some((t) => t.id === id)) return id;
    }
  } catch (err) {
    console.warn("[appSettings] getChatTone: failed to read per-chat tones", err);
  }
  return '';
}

export function setChatTone(conversationId: string, toneId: string): void {
  if (!conversationId) return;
  try {
    const raw = localStorage.getItem(CHAT_TONES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (!toneId || !NOTIFICATION_TONES.some((t) => t.id === toneId)) {
      delete map[conversationId];
    } else {
      map[conversationId] = toneId;
    }
    localStorage.setItem(CHAT_TONES_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn("[appSettings] setChatTone: failed to save per-chat tone", err);
  }
}

// ── Proxy (nightshift, setting UI only — v1) ─────────────────────────────
// The proxy address is stored per-device in localStorage. NOTHING in the
// app reads this config to route traffic yet: Pinglo talks to AppSync
// over HTTPS and WebRTC (TURN/STUN), and routing through a
// user-supplied proxy is backend/native work. The Settings screen says
// this plainly — a stored proxy that silently did nothing would be a
// privacy defect, not a feature. No password field exists in v1 on
// purpose: credentials must never be stored beside a proxy address in
// localStorage (security-reviewer: no credential storage in this store).
// When transport lands, its wiring point is App.tsx (AppSync client)
// + callService.ts (calls must refuse/fail honestly while proxied).

export type ProxyType = 'off' | 'http' | 'socks5';

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
}

const PROXY_KEY = 'pinglo_proxy_v1';

export const PROXY_OFF: ProxyConfig = { type: 'off', host: '', port: 0 };

/**
 * Pure: returns an error string for an invalid config, or null when the
 * config is usable. 'off' is always valid. Host must be a domain or IP
 * (letters, digits, dots, hyphens); schemes such as `javascript:` or
 * `data:` and URL paths are rejected. Port must be 1–65535.
 */
export function validateProxyConfig(cfg: ProxyConfig): string | null {
  if (cfg.type === 'off') return null;
  const host = cfg.host.trim();
  if (!host) return 'Enter a proxy host.';
  if (host.length > 253) return 'That host name is too long.';
  const ipParts = host.split('.');
  if (ipParts.length === 4 && ipParts.every((p) => /^\d{1,3}$/.test(p))) {
    if (ipParts.some((p) => Number(p) > 255)) return 'Enter a valid IP address.';
  } else if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
    return 'Enter a valid host name or IP address.';
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    return 'Enter a port between 1 and 65535.';
  }
  return null;
}

export function getProxyConfig(): ProxyConfig {
  try {
    const raw = localStorage.getItem(PROXY_KEY);
    if (!raw) return { ...PROXY_OFF };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...PROXY_OFF };
    const p = parsed as Partial<ProxyConfig>;
    const cfg: ProxyConfig = {
      type: p.type === 'http' || p.type === 'socks5' ? p.type : 'off',
      host: typeof p.host === 'string' ? p.host : '',
      port: typeof p.port === 'number' ? p.port : 0,
    };
    if (cfg.type === 'off') return { ...PROXY_OFF };
    // Never hand back a stored config that fails validation.
    if (validateProxyConfig(cfg) !== null) return { ...PROXY_OFF };
    return cfg;
  } catch (err) {
    console.warn('[appSettings] getProxyConfig: read failed', err);
    return { ...PROXY_OFF };
  }
}

export function setProxyConfig(cfg: ProxyConfig): void {
  try {
    if (cfg.type === 'off') {
      localStorage.removeItem(PROXY_KEY);
      return;
    }
    if (validateProxyConfig(cfg) !== null) return;
    localStorage.setItem(PROXY_KEY, JSON.stringify({ type: cfg.type, host: cfg.host.trim(), port: cfg.port }));
  } catch (err) {
    console.warn('[appSettings] setProxyConfig: write failed', err);
  }
}
