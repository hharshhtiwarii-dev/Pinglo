/**
 * Push notifications — client-side plumbing (Phase 2).
 *
 * What this module DOES:
 *  - Web Notification API: permission request + system notifications while the
 *    app is open but in the background (tab hidden / window unfocused).
 *  - In-app banner/toast events for new messages & incoming calls while the
 *    app is in the foreground (rendered by <NotificationBanner />).
 *  - Native token registration via @capacitor/push-notifications — loaded with
 *    a dynamic `import()` + `@vite-ignore` so the web build still passes when
 *    the plugin is NOT installed. If it is installed, the FCM/APNs token is
 *    saved on the user doc (`users/{uid}.pushToken`).
 *  - A lightweight foreground message watcher: polls the already-cached
 *    message collections (the DB layer refreshes them every ~3s anyway) and
 *    emits an event for each new message from someone else — and for a
 *    peer reaction landing on one of my messages (WA parity, audit e #59;
 *    gated on the "Show reaction notifications" pref).
 *
 * What this module does NOT do (deliberately — see README section in
 * phase2-work/push/PATCH.md): no Firebase credentials, no FCM server key,
 * no AWS SNS / Pinpoint setup, no service worker, no fake server endpoint.
 * Background delivery while the app is fully closed therefore needs that
 * server-side setup; until then notifications work while the app is open.
 */

import { Capacitor } from '@capacitor/core';
import { db, doc, getDoc, updateDoc, addDoc, collection } from '../aws';
import { isGroupChat, processKeyExchangeDocs } from './e2eeChat';
import { takeDueCallReminders } from './callReminders';
import { takeDueScheduledCall } from './scheduledCallReminder';
import { getNotificationPrefs, playNotificationTone, vibrateForNotification, isQuietHoursActive, getChatTone, getBlockUnknownMessages } from './appSettings';
import { isMutedPref } from './chatMute';
import { getAllowedContactUids } from './contacts';
import { partnerIdForConversation } from './realtimeSync';
import {
  LOCKED_CALL_BODY,
  LOCKED_CALL_TITLE,
  LOCKED_NOTIFICATION_BODY,
  LOCKED_NOTIFICATION_TITLE,
  isLockedConversation,
  isLockedPartnerCached,
  refreshLockedCache,
} from './lockedChats';

// NOTE: @capacitor/push-notifications is now installed (Phase 2 fix — the
// dynamic import below failed the Vite build without it), so its real types
// apply and no ambient declaration is needed here.
export type PushPlatform = 'web' | 'android' | 'ios' | '';
export type NotificationKind = 'message' | 'call';

export interface PushNotificationEvent {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Conversation / chat id — used by the banner to navigate on tap. */
  conversationId?: string;
  senderId?: string;
  senderName?: string;
  /** Stable id for de-duplication (message id / call peer id). */
  eventId?: string;
  timestamp: number;
}

export const PUSH_EVENT_NAME = 'pinglo:push-notification';

const ENABLED_KEY = 'pinglo_notifications_enabled';
const PROMPT_DISMISSED_KEY = 'pinglo_notif_prompt_dismissed';
const TOKEN_SAVED_KEY = 'pinglo_push_token_saved';
// Report 3 #61 — the foreground watcher remembers the newest message
// timestamp it has already seen, so messages that arrived while the app
// was closed can be notified on reopen instead of being silently skipped.
const NOTIF_LAST_SEEN_KEY = 'pinglo_notif_last_seen_ts';

/** Dispatched on window whenever the notifications-enabled flag changes (Report 3 #63). */
export const NOTIF_PREFS_CHANGED_EVENT = 'pinglo:notif-prefs-changed';

const cleanId = (id: string): string =>
  (id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');

/**
 * The 1:1 DM conversation id for two uids — same derivation as
 * realtimeSync.getConversationId (sorted, joined), duplicated here so
 * this module (and the banner) does not have to import the realtime
 * relay. Used so a call toast can open the caller's chat (Report 3 #60).
 */
export function getDmConversationId(uidA: string, uidB: string): string {
  return [cleanId(uidA), cleanId(uidB)].sort().join('_');
}

/** Runtime cache of the user's notificationsEnabled preference (user doc is the source of truth). */
let notificationsEnabled = true;
try {
  const stored = localStorage.getItem(ENABLED_KEY);
  if (stored === '0') notificationsEnabled = false;
} catch (err) {
  console.warn("[pushNotifications] cleanId: const stored = localStorage.getItem(ENABLED_KEY)...", err);
}

export function isNotificationsEnabled(): boolean {
  return notificationsEnabled;
}

/** Called by Settings when the user flips the toggle (and by initPushForUser). */
export function setNotificationsEnabled(enabled: boolean): void {
  notificationsEnabled = enabled;
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
  } catch (err) {
    console.warn("[pushNotifications] setNotificationsEnabled: localStorage.setItem(ENABLED_KEY...", err);
  }
  // Report 3 #63 — the banner's permission-prompt effect used to run only
  // on mount, so toggling notifications never re-evaluated the prompt.
  // Notify listeners (NotificationBanner re-runs its prompt check).
  try {
    window.dispatchEvent(new CustomEvent(NOTIF_PREFS_CHANGED_EVENT, { detail: { enabled } }));
  } catch (_) {
    /* non-DOM environment — nothing listens */
  }
}

// ── Web Notification API ────────────────────────────────────────────────

export function isWebNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isWebNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (!isWebNotificationSupported()) return 'unsupported';
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }
  try {
    return await Notification.requestPermission();
  } catch (_) {
    return Notification.permission;
  }
}

export function isPromptDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_DISMISSED_KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function dismissPermissionPrompt(): void {
  try {
    localStorage.setItem(PROMPT_DISMISSED_KEY, '1');
  } catch (err) {
    console.warn("[pushNotifications] dismissPermissionPrompt: localStorage.setItem(PROMPT_DISM...", err);
  }
}

function showSystemNotification(ev: PushNotificationEvent): void {
  if (!isWebNotificationSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(ev.title, {
      body: ev.body,
      tag: ev.eventId || `${ev.kind}-${ev.timestamp}`,
      // WA-verify-5 #58: quiet hours promises silenced tones, but the
      // hidden-tab system notification always sounded (silent: false).
      // Silence it during quiet hours — the notification still shows.
      silent: isQuietHoursActive(),
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch (err) {
        console.warn("[pushNotifications] showSystemNotification: window.focus() failed", err);
      }
      if (ev.conversationId) {
        window.dispatchEvent(
          new CustomEvent(PUSH_EVENT_NAME, { detail: { ...ev, kind: 'message' as const, viaClick: true } }),
        );
      }
      n.close();
    };
  } catch (err) {
    console.warn("[pushNotifications] showSystemNotification: const n = new Notification(ev.tit...", err);
  }
}

// ── In-app event bus (foreground banner) ────────────────────────────────

export function emitPushEvent(ev: PushNotificationEvent): void {
  window.dispatchEvent(new CustomEvent<PushNotificationEvent>(PUSH_EVENT_NAME, { detail: ev }));
}

export function subscribePushEvents(cb: (ev: PushNotificationEvent) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<PushNotificationEvent>).detail);
  window.addEventListener(PUSH_EVENT_NAME, handler);
  return () => window.removeEventListener(PUSH_EVENT_NAME, handler);
}

/**
 * Route one notification: system Notification when the tab is hidden,
 * in-app banner event when the app is visible. No-op when disabled.
 * Theme fix: vibrate follows the vibrate setting, and the popup setting
 * decides whether the in-app banner shows at all ('off' = tone only).
 * WA-verify-5 #57: 'screen-off' used to behave exactly like 'always' —
 * the foreground branch emitted for any popup !== 'off', so the middle
 * option was a no-op. WhatsApp's popup options are Always / When screen
 * off / Never: the middle option shows the popup only when the screen
 * is off, never while using the app. The hidden-tab branch below IS the
 * screen-off case (system Notification), so the foreground banner now
 * fires only for 'always'.
 */
export function notify(ev: PushNotificationEvent): void {
  if (!notificationsEnabled) return;
  // Report 3 #65 — quiet hours silence the vibration (the banner still
  // shows, so nothing is lost, it just does not buzz at night).
  if (!isQuietHoursActive()) {
    try {
      vibrateForNotification();
    } catch (err) {
      console.warn("[pushNotifications] notify: vibrateForNotification() failed", err);
    }
  }
  if (typeof document !== 'undefined' && document.hidden) {
    showSystemNotification(ev);
  } else {
    const popup = getNotificationPrefs().popup;
    if (popup === 'always') emitPushEvent(ev);
  }
}

export function notifyIncomingMessage(opts: {
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  messageId?: string;
  timestamp?: number;
  /** Group chat: plays the group tone instead of the message tone. */
  isGroup?: boolean;
}): void {
  // Theme fix: group chats play the group tone; message preview follows
  // the "Show preview" setting (off = generic "New message").
  // Report 3 #65 — a per-chat tone (appSettings.getChatTone) overrides
  // the group/global tone for that conversation; quiet hours silence the
  // tone (the banner still shows).
  const prefs = getNotificationPrefs();
  // WA parity (audit e #53): "Play sounds for incoming messages" gates
  // the tone. Quiet hours silence it too (banner still shows).
  if (!isQuietHoursActive() && prefs.incomingSound) {
    try {
      const perChatTone = getChatTone(opts.conversationId);
      playNotificationTone(perChatTone || (opts.isGroup ? prefs.groupTone : undefined));
    } catch (err) {
      /* audio unavailable — banner still shows */
      console.warn("[pushNotifications] notifyIncomingMessage: playNotificationTone(...) failed", err);
    }
  }
  const previewText = prefs.showPreview
    ? opts.text.length > 120
      ? `${opts.text.slice(0, 120)}…`
      : opts.text
    : 'New message';
  // Phase 5 (L-06): a locked chat's notification NEVER shows the sender
  // name or message preview — only generic "1 new message". It also
  // carries NO conversationId/senderId, so tapping the banner cannot open
  // (or reveal) the locked chat. The generic eventId still de-duplicates.
  const locked =
    isLockedPartnerCached(opts.senderId) ||
    isLockedConversation(opts.conversationId, '', undefined);
  if (locked) {
    notify({
      kind: 'message',
      title: LOCKED_NOTIFICATION_TITLE,
      body: LOCKED_NOTIFICATION_BODY,
      eventId: `locked-msg-${opts.timestamp || Date.now()}`,
      timestamp: opts.timestamp || Date.now(),
    });
    return;
  }
  notify({
    kind: 'message',
    title: opts.senderName || 'New message',
    body: previewText,
    conversationId: opts.conversationId,
    senderId: opts.senderId,
    senderName: opts.senderName,
    eventId: opts.messageId || `msg-${opts.conversationId}-${opts.timestamp || Date.now()}`,
    timestamp: opts.timestamp || Date.now(),
  });
}

export function notifyIncomingCall(opts: { callerName: string; callerId: string; type?: string; myUid?: string }): void {
  // WA-verify-5 #55: WhatsApp's separate "Show notifications for
  // incoming calls" toggle. The master notifications switch still gates
  // everything via notify(); this pref silences call banners alone.
  // (The live CallModal ring is governed by the call prefs, not this.)
  if (!getNotificationPrefs().callNotifications) return;
  // Phase 5 (L-07): a call from a locked chat never shows who is calling.
  // Generic text only, and no sender id (so the banner cannot navigate to
  // the caller or reveal them). The CallModal itself is still shown by the
  // call service — see the honest limit in §4: the live call UI is a
  // separate surface and must be gated there (P-06 note).
  if (isLockedPartnerCached(opts.callerId)) {
    notify({
      kind: 'call',
      title: LOCKED_CALL_TITLE,
      body: LOCKED_CALL_BODY,
      eventId: `locked-call-${Date.now()}`,
      timestamp: Date.now(),
    });
    return;
  }
  // Report 3 #60 — carry the DM conversation id so tapping the toast
  // opens the caller's chat (to call back). Without myUid it cannot be
  // derived, so the banner falls back to /main.
  notify({
    kind: 'call',
    title: `Incoming ${opts.type === 'video' ? 'video' : 'voice'} call`,
    body: `${opts.callerName || 'Someone'} is calling you`,
    conversationId: opts.myUid ? getDmConversationId(opts.myUid, opts.callerId) : undefined,
    senderId: opts.callerId,
    senderName: opts.callerName,
    eventId: `call-${opts.callerId}`,
    timestamp: Date.now(),
  });
}

/**
 * Report 3 #52 — missed calls never notified: callService records the
 * missed call in history but calls no notify* function anywhere. This
 * emits the WhatsApp-style "Missed voice/video call" toast; tapping it
 * opens the caller's chat so the user can call back (see
 * NotificationBanner.handleToastClick). Locked callers stay generic, no
 * ids, same as the incoming-call path above.
 */
export function notifyMissedCall(opts: { callerName: string; callerId: string; type?: string; myUid?: string; timestamp?: number }): void {
  // WA-verify-5 #55: same call-notifications pref as incoming calls.
  if (!getNotificationPrefs().callNotifications) return;
  if (isLockedPartnerCached(opts.callerId)) {
    notify({
      kind: 'call',
      title: LOCKED_CALL_TITLE,
      body: LOCKED_CALL_BODY,
      eventId: `locked-missed-${opts.callerId}-${opts.timestamp || Date.now()}`,
      timestamp: opts.timestamp || Date.now(),
    });
    return;
  }
  notify({
    kind: 'call',
    title: `Missed ${opts.type === 'video' ? 'video' : 'voice'} call`,
    body: `${opts.callerName || 'Someone'} called you — tap to call back`,
    conversationId: opts.myUid ? getDmConversationId(opts.myUid, opts.callerId) : undefined,
    senderId: opts.callerId,
    senderName: opts.callerName,
    eventId: `missed-${opts.callerId}-${opts.timestamp || Date.now()}`,
    timestamp: opts.timestamp || Date.now(),
  });
}

// ── Push token storage (user doc) ───────────────────────────────────────

export async function savePushToken(
  uid: string,
  token: string,
  platform: PushPlatform,
): Promise<void> {
  await updateDoc(doc(db, 'users', uid), {
    pushToken: token,
    pushPlatform: platform,
    pushTokenUpdatedAt: Date.now(),
  });
  try {
    localStorage.setItem(TOKEN_SAVED_KEY, JSON.stringify({ token, platform, at: Date.now() }));
  } catch (err) {
    console.warn("[pushNotifications] savePushToken: localStorage.setItem(TOKEN_SAVED_KEY, JSON...", err);
  }
}

export async function clearPushToken(uid: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'users', uid), {
      pushToken: '',
      pushPlatform: '',
      pushTokenUpdatedAt: Date.now(),
    });
  } catch (err) {
    console.warn("[pushNotifications] clearPushToken: await updateDoc(doc(db, 'users', uid), { ...", err);
  }
  try {
    localStorage.removeItem(TOKEN_SAVED_KEY);
  } catch (err) {
    console.warn("[pushNotifications] clearPushToken: localStorage.removeItem(TOKEN_SAVED_KEY) ...", err);
  }
}

export function getSavedPushToken(): { token: string; platform: PushPlatform } | null {
  try {
    const raw = localStorage.getItem(TOKEN_SAVED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// ── Native registration (Capacitor PushNotifications, optional dep) ─────

export interface RegisterResult {
  ok: boolean;
  platform: PushPlatform;
  /** 'native-registered' | 'web-no-fcm' | 'permission-denied' | 'plugin-missing' | 'error' */
  reason: string;
}

/**
 * Native only. On Android/iOS with @capacitor/push-notifications installed
 * this requests permission, registers with FCM/APNs and stores the token on
 * the user doc. On web, or without the plugin, it resolves with ok:false and
 * a reason — it never invents a token.
 */
export async function registerPushToken(uid: string): Promise<RegisterResult> {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, platform: 'web', reason: 'web-no-fcm' };
  }
  let PushNotifications: any;
  try {
    // @vite-ignore: the plugin is optional; without it Vite must not fail the build.
    const mod: any = await import(/* @vite-ignore */ '@capacitor/push-notifications');
    PushNotifications = mod.PushNotifications;
  } catch (_) {
    return { ok: false, platform: Capacitor.getPlatform() as PushPlatform, reason: 'plugin-missing' };
  }
  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm?.receive !== 'granted') {
      return { ok: false, platform: Capacitor.getPlatform() as PushPlatform, reason: 'permission-denied' };
    }
    // Phase 3: keep the listener handles so stopPushForUser() can remove
    // them — the old code added 3 listeners on every sign-in and never
    // removed any (duplicate banners + leaked native listeners).
    const regHandle = await PushNotifications.addListener('registration', async (token: { value: string }) => {
      if (token?.value) {
        await savePushToken(uid, token.value, Capacitor.getPlatform() as PushPlatform).catch((err) => console.warn("[pushNotifications] registerPushToken: savePushToken(uid, token.value, Capaci...", err));
      }
    });
    const errHandle = await PushNotifications.addListener('registrationError', (err: any) => {
      console.warn('Push registration error:', err);
    });
    // Foreground push received while the app is open → route through notify().
    const recvHandle = await PushNotifications.addListener('pushNotificationReceived', (n: any) => {
      // Phase 5 (L-08): redact server payloads for locked chats. The
      // payload's conversation id / sender is checked against the sync
      // cache; a locked hit becomes the generic notification. Honest
      // limit: if the server sends a preview for a chat whose lock state
      // is not in the cache yet, it can still show — the server MUST
      // redact locked chats before sending (see §4).
      const convId = String(n?.data?.conversationId || '');
      const senderId = String(n?.data?.senderId || '');
      const locked =
        (convId && isLockedConversation(convId, uid, undefined)) ||
        (senderId && isLockedPartnerCached(senderId));
      if (locked) {
        notify({
          kind: 'message',
          title: LOCKED_NOTIFICATION_TITLE,
          body: LOCKED_NOTIFICATION_BODY,
          timestamp: Date.now(),
        });
        return;
      }
      notify({
        kind: 'message',
        title: n?.title || 'Pinglo',
        body: n?.body || 'New message',
        conversationId: n?.data?.conversationId,
        timestamp: Date.now(),
      });
    });
    pushListenerHandles.push(regHandle, errHandle, recvHandle);
    await PushNotifications.register();
    return { ok: true, platform: Capacitor.getPlatform() as PushPlatform, reason: 'native-registered' };
  } catch (e) {
    console.warn('Push registration failed:', e);
    return { ok: false, platform: Capacitor.getPlatform() as PushPlatform, reason: 'error' };
  }
}

/** Settings "Enable notifications": web permission first, then native token if applicable. */
export async function requestPermissionAndRegister(uid: string): Promise<RegisterResult> {
  const permission = await requestNotificationPermission();
  if (permission === 'denied') {
    return { ok: false, platform: Capacitor.isNativePlatform() ? (Capacitor.getPlatform() as PushPlatform) : 'web', reason: 'permission-denied' };
  }
  return registerPushToken(uid);
}

// ── Foreground message watcher ──────────────────────────────────────────

export interface MessageWatcherHandle {
  stop: () => void;
}

function messagePreview(m: any): string {
  if (m.type === 'location') return `📍 ${m.locationLabel || 'Location'}`;
  if (m.type === 'live-location') return '📍 Live location';
  if (m.type === 'contact') return `👤 ${m.contactName || 'Contact'}`;
  if (m.type === 'sticker') return '🌟 Sticker';
  if (m.text) return String(m.text);
  if (m.mediaType) return `📷 ${m.mediaType}`;
  return 'New message';
}

/**
 * Polls the already-cached message collections and notifies for messages
 * that arrive after this watcher starts (no backlog spam on login).
 * Safe to call once per sign-in; call stop() on sign-out / account switch.
 */
export function startMessageWatcher(
  uid: string,
  opts?: { pollMs?: number },
): MessageWatcherHandle {
  const me = cleanId(uid);
  const pollMs = opts?.pollMs ?? 3000;
  const seenIds = new Set<string>();
  // Report 3 #61 — the old watcher started with lastSeenTs = now, so
  // messages that arrived while the app was closed were never notified
  // on reopen (no backlog). The newest seen timestamp is now persisted:
  // on reopen the watcher resumes from where it left off and notifies
  // for messages received while closed. First run ever (no stored value)
  // still starts at now, so a fresh install is not spammed with old
  // history. The value is written on every tick and on stop().
  let lastSeenTs = Date.now();
  try {
    const stored = Number(localStorage.getItem(NOTIF_LAST_SEEN_KEY) || 0);
    if (stored > 0 && stored <= Date.now()) lastSeenTs = stored;
  } catch (_) {
    /* storage unavailable — start at now */
  }
  const persistLastSeen = () => {
    try {
      localStorage.setItem(NOTIF_LAST_SEEN_KEY, String(lastSeenTs));
    } catch (_) {
      /* best-effort */
    }
  };
  // Report 3 #52 — first-tick seed flag for the missed-call poll (see below).
  let callsBaselineDone = false;
  // WA parity (audit e #59): reactions live ON the message doc, so a peer
  // reacting to my message never creates a new doc — the message loop
  // below would never see it. Remember each message's reactions map; a
  // peer reaction that appears or changes on an already-seen message of
  // MINE is a reaction notification (gated on the pref). Seeded when a
  // message is first seen, so pre-existing reactions never notify.
  const seenReactions = new Map<string, string>();
  const reactionSnapshot = (m: any): string => {
    try { return JSON.stringify(m?.reactions || {}); } catch { return '{}'; }
  };
  const reactorName = (reactorUid: string): string => {
    try {
      const u: any = db.readCachedAny('users', reactorUid);
      return u?.displayName || u?.username || 'Someone';
    } catch { return 'Someone'; }
  };
  let stopped = false;
  // Phase 3 — muted + blocked chats never notify. Refreshed from the user
  // doc at most every 30 s (best-effort; a failed read keeps the old sets).
  let blockedChats = new Set<string>();
  let mutedChats = new Set<string>();
  // WA parity (audit e #30): senders this user knows — saved contacts +
  // proven DM conversations (contacts.ts, sync cache-only). A 1:1 DM from
  // anyone else is "unknown" while the block-unknown pref is on.
  // Seeded synchronously so the first tick never treats everyone as unknown.
  let knownSenders = new Set<string>(getAllowedContactUids(uid));
  // Phase 5 (L-06): locked chats never notify. Refreshed with the same
  // 30 s cadence as blocked/muted below.
  let lockedChats = new Set<string>();
  let filtersRefreshedAt = 0;
  const refreshFilters = async () => {
    if (Date.now() - filtersRefreshedAt < 30_000) return;
    filtersRefreshedAt = Date.now();
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      if (!snap.exists()) return;
      const data = snap.data() || {};
      blockedChats = new Set<string>(
        (Array.isArray(data.blockedUsers) ? data.blockedUsers : []).map((x: any) => String(x)),
      );
      const prefs = data.chatPrefs || {};
      // WA parity top-10 #1: a mute is an expiry (muteEndTimestamp), not
      // a forever boolean — an expired mute must notify again.
      mutedChats = new Set<string>(
        Object.keys(prefs).filter((k) => isMutedPref(prefs[k])),
      );
      knownSenders = new Set<string>(getAllowedContactUids(uid));
      // Phase 5: locked list (private doc, with legacy migration). Store
      // both partner uids and their DM conversation ids for the tick loop.
      await refreshLockedCache(uid);
      const { lockedPartnerIdsCached, lockedConversationIdFor } = await import('./lockedChats');
      lockedChats = new Set<string>();
      for (const partnerId of lockedPartnerIdsCached()) {
        lockedChats.add(partnerId);
        lockedChats.add(lockedConversationIdFor(uid, partnerId));
      }
    } catch (err) {
      console.warn("[pushNotifications] startMessageWatcher: const snap = await getDoc(doc(db, 'u...", err);
    }
  };

  const tick = () => {
    if (stopped) return;
    // Report 3 #223/#232 (W5b): key exchange must progress without
    // anyone opening the chat — process kx docs for every already-loaded
    // channel on this 3 s tick, BEFORE the notifications gate below (a
    // user who turned notifications off still needs their keys
    // exchanged). Silent by construction: kx docs are never notified or
    // previewed, and locked chats are processed for key storage only
    // (keys aren't message content — D3) while the message loop below
    // still skips them entirely. No `ensure()` here: a kx doc in a
    // never-loaded collection stays invisible until the chat-list
    // discovery probe loads it — the watcher is the fast path, not the
    // discovery mechanism. Group/channel collections are skipped (a
    // cached `communities` doc proves it); an unloaded collection is
    // processed, which is harmless — no client ever writes kx docs to a
    // group collection, and the runner ignores non-kx docs.
    try {
      const kxChannels: string[] = db.getAllChatChannels();
      for (const convId of kxChannels) {
        try {
          const communityDoc = db.readCachedAny('communities', convId);
          if (communityDoc !== undefined && communityDoc !== null) continue;
          const kxDocs = db.getKeyExchangeDocs(`chats/${convId}/messages`);
          if (kxDocs.length === 0) continue;
          void processKeyExchangeDocs(convId, kxDocs, uid, async (cid, payload) => {
            await addDoc(collection(db, 'chats', cid, 'messages'), {
              ...payload, timestamp: Date.now(), senderId: uid,
            });
          });
        } catch (err) {
          console.warn('[pushNotifications] key-exchange pass failed for a channel', err);
        }
      }
    } catch (err) {
      console.warn('[pushNotifications] key-exchange tick failed', err);
    }
    if (!notificationsEnabled) return;
    void refreshFilters();
    // 100M-H15 — scheduled call-link reminder: one banner when the
    // saved time arrives (takeDueScheduledCall marks it fired, so it
    // can never double-fire). In-app only, on this device — a closed
    // app fires nothing. No conversationId: tapping the banner opens
    // the app's main screen, where the Calls tab + call link live.
    try {
      const dueSched = takeDueScheduledCall(uid);
      if (dueSched) {
        notify({
          kind: 'call',
          title: 'Scheduled call starting now',
          body: dueSched.title
            ? `"${dueSched.title}" is starting — open Calls to join from your call link`
            : 'Your scheduled call is starting — open Calls to join from your call link',
          eventId: `sched-${dueSched.scheduledAt}`,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.warn("[pushNotifications] startMessageWatcher: scheduled-call check failed", err);
    }
    // Baseline for THIS tick: the message loop below advances lastSeenTs,
    // so the missed-call check must compare against the tick-start value,
    // or a call slightly older than the newest message would be skipped.
    const tickBaseline = lastSeenTs;
    try {
      const channels: string[] = db.getAllChatChannels();
      const fresh: any[] = [];
      for (const convId of channels) {
        // Phase 3: skip muted AND blocked chats entirely.
        if (mutedChats.has(convId) || blockedChats.has(convId)) continue;
        // Phase 5 (L-06): skip locked chats entirely — no sender, no text.
        if (lockedChats.has(convId) || isLockedConversation(convId, uid, lockedChats)) continue;
        const msgs = db.getCollectionDocs(`chats/${convId}/messages`);
        for (const m of msgs) {
          if (!m?.id) continue;
          if (seenIds.has(m.id)) {
            // WA parity (audit e #59): a reaction change on an
            // already-seen message OF MINE. Only additions/changes
            // notify (a removed reaction stays silent); the snapshot
            // updates even when the pref is off, so turning it back on
            // never floods old reactions. Muted/blocked/locked chats
            // never reach here (channel-level skips above).
            if (cleanId(m.senderId) === me && m.reactions && typeof m.reactions === 'object') {
              const snap = reactionSnapshot(m);
              const prev = seenReactions.get(m.id);
              if (prev !== undefined && prev !== snap) {
                let prevMap: Record<string, string> = {};
                try { prevMap = JSON.parse(prev); } catch { prevMap = {}; }
                const prefs = getNotificationPrefs();
                for (const [reactorUid, emoji] of Object.entries(m.reactions as Record<string, string>)) {
                  if (cleanId(reactorUid) === me) continue;
                  if (prevMap[reactorUid] === emoji) continue;
                  if (!prefs.showReactionNotifications) continue;
                  const name = reactorName(reactorUid);
                  notify({
                    kind: 'message',
                    title: `${name} reacted ${emoji}`,
                    body: prefs.showPreview && typeof m.text === 'string' && m.text
                      ? (m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text)
                      : 'to your message',
                    conversationId: convId,
                    senderId: reactorUid,
                    senderName: name,
                    eventId: `react-${m.id}-${cleanId(reactorUid)}-${emoji}`,
                    timestamp: Date.now(),
                  });
                }
              }
              seenReactions.set(m.id, snap);
            }
            continue;
          }
          seenIds.add(m.id);
          // Seed the reactions snapshot so pre-existing reactions on a
          // newly seen message never notify on the next tick.
          if (m.reactions && typeof m.reactions === 'object') seenReactions.set(m.id, reactionSnapshot(m));
          const ts = Number(m.timestamp) || 0;
          if (ts <= lastSeenTs) continue;
          if (cleanId(m.senderId) === me) continue;
          // Blocked sender: never notify. Muted chat: chatPrefs keys are
          // partner uids for 1:1 chats and group ids for groups.
          if (blockedChats.has(String(m.senderId))) continue;
          if (mutedChats.has(String(m.senderId))) continue;
          // WA parity (audit e #30): block unknown account messages — a
          // 1:1 DM from a sender who is not a saved contact and has no
          // proven DM conversation never notifies while the pref is on.
          // Group messages are exempt (the group itself is known), and
          // the message still arrives in the chat list — full server-side
          // blocking needs backend rules.
          if (
            getBlockUnknownMessages() &&
            partnerIdForConversation(convId, uid) === String(m.senderId) &&
            !knownSenders.has(String(m.senderId))
          ) continue;
          // Phase 5 (L-06): the sender is a locked partner (defence in
          // depth — the channel-level check above should already skip it).
          if (lockedChats.has(String(m.senderId))) continue;
          if (m.deleted || m.isDeleted) continue;
          // Phase 3 (integration): silent send — the sender asked for no
          // notification on the other person's device.
          if (m.silent) continue;
          fresh.push({ ...m, __convId: convId, __ts: ts });
        }
      }
      // Bound memory: the id set only needs recent ids.
      if (seenIds.size > 5000) { seenIds.clear(); seenReactions.clear(); }
      fresh.sort((a, b) => a.__ts - b.__ts);
      // Report 3 #61 — backlog cap: a long absence can leave dozens of
      // un-notified messages; the banner only shows 3 at a time and each
      // one plays a tone, so notify at most the 5 most recent. The rest
      // are still in the chat list — lastSeenTs still advances past them.
      const toNotify = fresh.length > 5 ? fresh.slice(-5) : fresh;
      // WA72 settings #54 — the group-tone picker was dead: this watcher
      // is the only real caller of notifyIncomingMessage and it never
      // passed isGroup, so every group message played the DM tone.
      // Resolve each conversation against the cached chats/communities
      // docs (same isGroupChat helper the chat layer uses; no doc = DM,
      // fail-closed). Maps are built only when there is something to
      // notify, so idle ticks pay nothing.
      const communityById = new Map(
        (db.getCollectionDocs('communities') || []).map((d: any) => [String(d.id), d]),
      );
      const chatById = new Map(
        (db.getCollectionDocs('chats') || []).map((d: any) => [String(d.id), d]),
      );
      for (const m of toNotify) {
        notifyIncomingMessage({
          conversationId: m.__convId,
          senderId: m.senderId,
          senderName: m.senderName || 'Someone',
          text: messagePreview(m),
          messageId: m.id,
          timestamp: m.__ts,
          isGroup: isGroupChat(
            m.__convId,
            communityById.get(String(m.__convId)),
            chatById.get(String(m.__convId)),
          ),
        });
      }
      if (fresh.length > 0) {
        lastSeenTs = Math.max(lastSeenTs, ...fresh.map((m) => m.__ts));
        persistLastSeen();
      }

      // Report 3 #52 — missed calls: callService records a callee-side
      // 'missed' doc in the `calls` collection (ring timeout, DND /
      // silence-unknown silencing, stale-signal recovery) but never
      // notifies. Poll that collection on the same tick: any missed doc
      // for me newer than the tick baseline notifies once (de-duped by
      // seenIds, so a doc is never announced twice). Declined / busy /
      // failed docs are NOT missed calls and never notify. A doc with a
      // numeric timestamp compares against the persisted baseline on
      // every tick, so a missed call from while the app was closed
      // notifies on reopen; a doc whose timestamp is unparseable (a
      // real-backend Timestamp object reads as NaN here) is judged by
      // id — silently seeded on the first tick (old or new is
      // unknowable), notified when first seen on any later tick.
      try {
        const callDocs = (db as any)?.getCollectionDocs?.('calls');
        if (Array.isArray(callDocs)) {
          for (const c of callDocs) {
            if (!c?.id || c.status !== 'missed') continue;
            if (cleanId(String(c.receiverId || '')) !== me) continue;
            if (seenIds.has(`call-${c.id}`)) continue;
            seenIds.add(`call-${c.id}`);
            const ts = Number(c.timestamp) || 0;
            if (ts > 0) {
              if (ts <= tickBaseline) continue;
              lastSeenTs = Math.max(lastSeenTs, ts);
            } else if (!callsBaselineDone) {
              continue; // first tick, unparseable ts: seed silently
            }
            notifyMissedCall({
              callerName: c.callerName || 'Someone',
              callerId: String(c.callerId || ''),
              type: c.type === 'video' ? 'video' : 'audio',
              myUid: uid,
              timestamp: ts || Date.now(),
            });
          }
          callsBaselineDone = true;
          persistLastSeen();
        }
      } catch (err) {
        console.warn("[pushNotifications] startMessageWatcher: missed-call poll failed", err);
      }

      // 100M-H13 — "Remind me" call-backs: due reminders fire once as
      // an in-app banner (tap opens the caller's chat to call back).
      // takeDueCallReminders removes each one as it fires, so a
      // reminder can never double-fire across ticks or restarts.
      // In-app only, on this device — a closed app fires nothing.
      try {
        const due = takeDueCallReminders(uid);
        for (const r of due) {
          notify({
            kind: 'call',
            title: `Call back ${r.callerName || 'them'}?`,
            body: `You asked to be reminded about this ${r.type === 'video' ? 'video' : 'voice'} call — tap to open the chat`,
            conversationId: getDmConversationId(uid, r.callerId),
            senderId: r.callerId,
            senderName: r.callerName,
            eventId: `remind-${r.id}`,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.warn("[pushNotifications] startMessageWatcher: call-reminder check failed", err);
      }
    } catch (err) {
      // DB not ready yet (e.g. right after login) — next tick retries.
      console.warn("[pushNotifications] startMessageWatcher: const channels: string[] = db.getAll...", err);
    }
  };

  const timer = setInterval(tick, pollMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      persistLastSeen();
    },
  };
}

// ── Per-user lifecycle (called from App.tsx) ────────────────────────────

let activeWatcher: MessageWatcherHandle | null = null;
let activeUid: string | null = null;
/** Capacitor PushNotifications listener handles (removed in stopPushForUser). */
let pushListenerHandles: Array<{ remove: () => Promise<void> }> = [];

export function initPushForUser(uid: string, opts?: { notificationsEnabled?: boolean }): void {
  if (opts?.notificationsEnabled !== undefined) setNotificationsEnabled(opts.notificationsEnabled);
  if (activeUid === uid && activeWatcher) return;
  stopPushForUser();
  // Phase 5: populate the locked cache before the watcher starts (L-06).
  void refreshLockedCache(uid);
  activeUid = uid;
  activeWatcher = startMessageWatcher(uid);
  // Native token registration is best-effort and silent; web resolves
  // immediately with ok:false / 'web-no-fcm' (no fake token is stored).
  registerPushToken(uid).catch((err) => console.warn("[pushNotifications] initPushForUser: registerPushToken(uid) failed", err));
}

export function stopPushForUser(): void {
  activeWatcher?.stop();
  activeWatcher = null;
  activeUid = null;
  // Phase 3: remove the native listeners registered by registerPushToken.
  const handles = pushListenerHandles;
  pushListenerHandles = [];
  for (const h of handles) {
    try {
      void h.remove().catch((err) => console.warn("[pushNotifications] stopPushForUser: remove(...) failed", err));
    } catch (err) {
      console.warn("[pushNotifications] stopPushForUser: void h.remove() failed", err);
    }
  }
}
