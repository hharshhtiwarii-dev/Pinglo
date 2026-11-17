import { updateDoc, getDoc, doc, db, onSnapshot } from '../aws';

/**
 * Presence: online status and last seen.
 *
 * - While the app is visible, a heartbeat refreshes users/{uid}.online.
 *   `online` is a plain boolean — the short-lived heartbeat field — and
 *   carries NO timestamp.
 * - `lastSeen` is a SEPARATE field, written only when the owner's
 *   last-seen privacy allows it (see write() below and saveSession in
 *   aws/auth.ts). When privacy is 'nobody', no lastSeen is ever written,
 *   so nobody can read "when were you last here" from the doc.
 * - When the app goes to the background or is closed, the user is marked
 *   offline immediately (visibilitychange / pagehide). beforeunload is
 *   unreliable in the Android WebView, so it is not relied on.
 * - A user counts as online only if the `online` flag is set AND the
 *   last heartbeat is recent. A user whose last-seen privacy is
 *   'nobody' is NEVER shown online: WhatsApp's "Last seen and online"
 *   setting hides both, so no viewer may see "Online now" / a green
 *   dot / "Active Now" for them — see isOnline() (W28b/F1).
 *
 * AUDIT-2 C2 (Phase 2, Worker 3A) — heartbeat fan-out:
 * - The heartbeat write lands on MY OWN user doc, so its fan-out is
 *   decided by how many clients subscribe to the whole `users`
 *   collection — this module cannot address the write to specific
 *   watchers (that needs server-side filtering, BACKEND-PLAN.md §16).
 *   What it CAN do client-side is write half as often when nobody is
 *   plausibly watching live: 30 s while a conversation is open (a peer
 *   may be looking at my presence right now), 60 s otherwise (chat
 *   list / settings — presence dots there tolerate a minute of
 *   staleness). 60 s stays inside ONLINE_WINDOW_MS (90 s), so the
 *   online flag never flickers; the tradeoff is a coarser lastSeen
 *   (up to 60 s old) and a killed app leaving a stale `online: true`
 *   for up to ~30 s longer than before. realtimeSync drives the
 *   audience: joinConversation()/leaveConversation() (already called
 *   by ChatScreen) feed setPresenceAudience()/setPresenceOpenChats().
 * - subscribeToUsers() (below) is the scoped replacement for the
 *   whole-`users`-collection subscriptions in the 7 screens: one
 *   per-doc subscription per visible/relevant user, refcounted and
 *   shared across callers. No screen is converted in this worker
 *   (screens are outside its files — exact per-screen edits are listed
 *   in PATCH-3A.md §6); the helper exists so the conversion is a
 *   drop-in. Honest limit: with today's database.ts each doc
 *   subscription still ensures the `users` collection (full fetch +
 *   3 s poll), so the saving today is callback fan-out / re-renders —
 *   a heartbeat for user X no longer invokes a listener that only
 *   cares about user Y. The transfer saving needs the database.ts
 *   scoped-query helper (PATCH-3A.md §6).
 */

export type PrivacyLevel = 'everyone' | 'contacts' | 'nobody';

export function normalizePrivacyLevel(v: unknown): PrivacyLevel {
  return v === 'contacts' || v === 'nobody' ? v : 'everyone';
}

/**
 * Privacy (Phase 4, Worker C) — last-seen + profile-photo visibility.
 *
 * - Stored on the user doc as `lastSeenPrivacy` / `profilePhotoPrivacy`
 *   ('everyone' | 'contacts' | 'nobody', default 'everyone').
 * - HONEST LIMIT: this is CLIENT-SIDE enforcement only. The user doc is
 *   readable by any signed-in user (see the Round 3 audit), so a hostile
 *   client can still read `lastSeen` / `photoURL` directly from the
 *   database. Real enforcement needs server-side rules (AppSync resolver
 *   / field-level auth) — that is a backend task, not done here.
 * - REPORT-3 #77 (W10): 'contacts' IS a real choice now. The app has a
 *   saved-contacts graph (contacts.ts): `users/{uid}.contacts` is an
 *   array of { uid?, name, phone?, addedAt } on the owner's own user
 *   doc, so `target.contacts` tells whether a viewer is one of the
 *   owner's saved contacts. The gate below reads it (fail-closed: an
 *   absent / unparsable list means "not a contact"). Callers that
 *   already know the answer can pass `viewerIsContact` explicitly.
 *   (AUDIT-2 A7's "no contact graph" claim is superseded — the graph
 *   arrived with the Master-gaps Contacts screen.)
 */
export function isViewerContact(
  target: any,
  viewerUid?: string | null,
  viewerIsContact = false,
): boolean {
  if (viewerIsContact) return true;
  if (!viewerUid) return false;
  if (target?.uid && String(target.uid) === String(viewerUid)) return true; // own doc
  const list = target?.contacts;
  if (!Array.isArray(list)) return false;
  return list.some((c: any) => c && typeof c.uid === 'string' && c.uid === viewerUid);
}

export function canSeeLastSeen(target: any, viewerUid?: string | null, viewerIsContact = false): boolean {
  const level = normalizePrivacyLevel(target?.lastSeenPrivacy);
  if (level === 'nobody') return false;
  if (level === 'contacts') return isViewerContact(target, viewerUid, viewerIsContact);
  return true;
}

export function canSeePhoto(target: any, viewerUid?: string | null, viewerIsContact = false): boolean {
  const level = normalizePrivacyLevel(target?.profilePhotoPrivacy);
  if (level === 'nobody') return false;
  if (level === 'contacts') return isViewerContact(target, viewerUid, viewerIsContact);
  return true;
}

/**
 * About + Status privacy (Theme fix) — same client-side-only model as
 * last-seen / photo above. Stored on the user doc as `aboutPrivacy` /
 * `statusPrivacy` ('everyone' | 'contacts' | 'nobody'). The Status screen
 * also has a per-status audience picker; the Settings value is the DEFAULT
 * for new statuses (see getDefaultStatusPrivacy below).
 */
export function canSeeAbout(target: any, viewerUid?: string | null, viewerIsContact = false): boolean {
  const level = normalizePrivacyLevel(target?.aboutPrivacy);
  if (level === 'nobody') return false;
  if (level === 'contacts') return isViewerContact(target, viewerUid, viewerIsContact);
  return true;
}

export function canSeeStatus(target: any, viewerUid?: string | null, viewerIsContact = false): boolean {
  const level = normalizePrivacyLevel(target?.statusPrivacy);
  if (level === 'nobody') return false;
  if (level === 'contacts') return isViewerContact(target, viewerUid, viewerIsContact);
  return true;
}

export type StatusPrivacyDefault = 'everyone' | 'contacts' | 'exclude' | 'onlyShare' | 'nobody';
const DEFAULT_STATUS_PRIVACY_KEY = 'dt_status_default_privacy';
const DEFAULT_STATUS_EXCLUDE_KEY = 'dt_status_default_exclude';
const DEFAULT_STATUS_ALLOW_KEY = 'dt_status_default_allow';

export function getDefaultStatusPrivacy(): StatusPrivacyDefault {
  try {
    const v = localStorage.getItem(DEFAULT_STATUS_PRIVACY_KEY);
    if (v === 'contacts' || v === 'exclude' || v === 'onlyShare' || v === 'nobody') return v;
  } catch { /* intentionally ignored */}
  return 'everyone';
}

export function setDefaultStatusPrivacy(v: StatusPrivacyDefault): void {
  try {
    localStorage.setItem(DEFAULT_STATUS_PRIVACY_KEY, v);
  } catch { /* intentionally ignored */}
}

/**
 * Default "Everyone except…" list for new statuses (uids). The per-status
 * sheet in StatusScreen edits this same list when the default audience is
 * 'exclude'; Settings only picks the audience, the sheet picks the people.
 */
export function getDefaultStatusExclude(): string[] {
  try {
    const raw = localStorage.getItem(DEFAULT_STATUS_EXCLUDE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter((x): x is string => typeof x === 'string');
    }
  } catch { /* intentionally ignored */}
  return [];
}

export function setDefaultStatusExclude(uids: string[]): void {
  try {
    localStorage.setItem(DEFAULT_STATUS_EXCLUDE_KEY, JSON.stringify((uids || []).filter(Boolean)));
  } catch { /* intentionally ignored */}
}

/**
 * Default "Only share with…" allow-list for new statuses (uids).
 * WA parity (audit e #23, Wave-2 C4): the mirror of the exclude list —
 * the per-status sheet in StatusScreen edits this same list when the
 * default audience is 'onlyShare', and Settings picks the people too.
 * The post-time snapshot goes into `privacyAllow` on the status doc
 * (same field Close Friends uses); the snapshot filter fails closed
 * when the snapshot is missing.
 */
export function getDefaultStatusAllow(): string[] {
  try {
    const raw = localStorage.getItem(DEFAULT_STATUS_ALLOW_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter((x): x is string => typeof x === 'string');
    }
  } catch { /* intentionally ignored */}
  return [];
}

export function setDefaultStatusAllow(uids: string[]): void {
  try {
    localStorage.setItem(DEFAULT_STATUS_ALLOW_KEY, JSON.stringify((uids || []).filter(Boolean)));
  } catch { /* intentionally ignored */}
}

// ── WA parity (audit e #20): online visibility ──────────────────────────
// "Who can see when I'm online: Everyone / Same as last seen". Stored on
// the user doc as `onlinePrivacy` ('everyone' | 'same-as-last-seen',
// default 'everyone') with a module-level cache like lastSeenPrivacy.
// Same honest limit as last seen: client-side display gating only — the
// `online` heartbeat flag is still on the readable user doc, so real
// enforcement needs server-side rules (backend items #19/#21/#22).
export type OnlinePrivacy = 'everyone' | 'same-as-last-seen';

export function normalizeOnlinePrivacy(v: unknown): OnlinePrivacy {
  return v === 'same-as-last-seen' ? 'same-as-last-seen' : 'everyone';
}

/** Cached online privacy of the signed-in user (read once per session). */
let myOnlinePrivacy: OnlinePrivacy = 'everyone';

/** Update the cached online privacy without restarting presence. */
export function setMyOnlinePrivacy(level: OnlinePrivacy): void {
  myOnlinePrivacy = normalizeOnlinePrivacy(level);
}

export function getMyOnlinePrivacy(): OnlinePrivacy {
  return myOnlinePrivacy;
}

/**
 * Whether `viewerUid` may see `target` as online. 'everyone' = anyone.
 * 'same-as-last-seen' = only viewers who may also see the last-seen time
 * (so "Same as last seen" + last-seen Nobody hides online entirely).
 */
export function canSeeOnline(target: any, viewerUid?: string | null, viewerIsContact = false): boolean {
  if (normalizeOnlinePrivacy(target?.onlinePrivacy) !== 'same-as-last-seen') return true;
  return canSeeLastSeen(target, viewerUid, viewerIsContact);
}

// ── WA parity (audit e #25): groups privacy ─────────────────────────────
// "Who can add me to groups: Everyone / My contacts". Stored on the user
// doc as `groupsPrivacy` ('everyone' | 'contacts', default 'everyone').
// Client-side only: GroupInfoModal checks the target's setting before
// adding; a hostile client can still add directly — real enforcement
// needs server-side rules (backend items #19/#21/#22).
export type GroupsPrivacy = 'everyone' | 'contacts';

export function normalizeGroupsPrivacy(v: unknown): GroupsPrivacy {
  return v === 'contacts' ? 'contacts' : 'everyone';
}

/** Whether `viewerUid` may add `target` to a group. */
export function canAddMeToGroups(target: any, viewerUid?: string | null, viewerIsContact = false): boolean {
  if (normalizeGroupsPrivacy(target?.groupsPrivacy) !== 'contacts') return true;
  return isViewerContact(target, viewerUid, viewerIsContact);
}

/** Photo URL a viewer is allowed to see; '' means "show initials fallback". */
export function photoURLForViewer(target: any, viewerUid?: string | null, viewerIsContact = false): string {
  if (!target) return '';
  if (target.uid && viewerUid && target.uid === viewerUid) return target.photoURL || target.avatar || '';
  return canSeePhoto(target, viewerUid, viewerIsContact) ? target.photoURL || target.avatar || '' : '';
}

// ── AUDIT-2 C2: adaptive heartbeat ──────────────────────────────────
/** Fast beat while a conversation is open (someone may be watching live). */
export const PRESENCE_HEARTBEAT_FAST_MS = 30_000;
/**
 * Idle beat (chat list / settings only). Must stay comfortably below
 * ONLINE_WINDOW_MS or the online flag flickers; 60 s leaves 30 s of
 * margin for timer drift/throttling. Tradeoff (see header): lastSeen up
 * to 60 s stale, stale-`online: true` after a killed app up to ~30 s
 * longer than the 30 s beat. Halves heartbeat writes (and therefore
 * `users`-collection broadcast events) whenever no chat is open.
 */
export const PRESENCE_HEARTBEAT_IDLE_MS = 60_000;
export const ONLINE_WINDOW_MS = 90_000;
/** Minimum gap between two *immediate* (non-timer) beats — guards visibility/audience flapping. */
const MIN_BEAT_GAP_MS = 5_000;

let stopFn: (() => void) | null = null;
/** Cached last-seen privacy of the signed-in user (read once per session). */
let myLastSeenPrivacy: PrivacyLevel = 'everyone';
/**
 * L6: the heartbeat used to do a getDoc (profile-exists check) on EVERY
 * 30 s beat. Cache the result after the first successful read — a profile
 * is not going to disappear mid-session; reset on sign-out (stopPresence).
 */
let profileExists: boolean | null = null;

/** Uids whose presence is being watched live right now (open DM partners). */
let presencePeers = new Set<string>();
/** Number of conversations currently open (DM or group). */
let openChatCount = 0;
/** Heartbeat timer + beat implementation, hoisted so audience changes can re-arm it. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let beatFn: (() => void) | null = null;
let presenceRunning = false;
/** Interval the live timer was armed with (diagnostics / probes). */
let currentIntervalMs = PRESENCE_HEARTBEAT_IDLE_MS;
/** Beats issued (initial + timer + immediate) — diagnostics / probes. */
let beatsWritten = 0;
let lastBeatAt = 0;

/** Fast interval while anyone may be watching live, idle interval otherwise. */
export function currentHeartbeatMs(): number {
  return presencePeers.size > 0 || openChatCount > 0 ? PRESENCE_HEARTBEAT_FAST_MS : PRESENCE_HEARTBEAT_IDLE_MS;
}

function armHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (!presenceRunning || !beatFn) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  currentIntervalMs = currentHeartbeatMs();
  heartbeatTimer = setInterval(() => beatFn?.(), currentIntervalMs);
}

function stopHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** Immediate beat, rate-limited so visibility/audience flapping cannot spam writes. */
function maybeImmediateBeat(): void {
  if (!beatFn) return;
  if (Date.now() - lastBeatAt < MIN_BEAT_GAP_MS) return;
  beatFn();
}

/**
 * Set the user ids whose presence is being watched live (open DM
 * partners, fed by realtimeSync.join/leaveConversation). Switching
 * between fast/idle re-arms the timer; switching to fast also beats
 * immediately (rate-limited) so presence is fresh the moment a chat
 * opens instead of up to 60 s later.
 */
export function setPresenceAudience(peerIds: string[]): void {
  const before = currentHeartbeatMs();
  presencePeers = new Set(
    (peerIds || []).map((p) => String(p || '').trim()).filter(Boolean),
  );
  const after = currentHeartbeatMs();
  if (presenceRunning && before !== after) {
    armHeartbeatTimer();
    if (after < before) maybeImmediateBeat();
  }
}

/** Set how many conversations are currently open (DM or group). Same re-arm rules as setPresenceAudience. */
export function setPresenceOpenChats(n: number): void {
  const before = currentHeartbeatMs();
  openChatCount = Math.max(0, Math.floor(n) || 0);
  const after = currentHeartbeatMs();
  if (presenceRunning && before !== after) {
    armHeartbeatTimer();
    if (after < before) maybeImmediateBeat();
  }
}

/** Counts for probes — interval, audience, beats issued, scoped user-doc subs. */
export interface PresenceDiagnostics {
  running: boolean;
  intervalMs: number;
  fastMs: number;
  idleMs: number;
  activePeers: string[];
  openChats: number;
  beatsWritten: number;
  lastBeatAt: number;
  timerArmed: boolean;
  subscribedUserDocs: number;
}

export function getPresenceDiagnostics(): PresenceDiagnostics {
  return {
    running: presenceRunning,
    intervalMs: currentIntervalMs,
    fastMs: PRESENCE_HEARTBEAT_FAST_MS,
    idleMs: PRESENCE_HEARTBEAT_IDLE_MS,
    activePeers: [...presencePeers],
    openChats: openChatCount,
    beatsWritten,
    lastBeatAt,
    timerArmed: heartbeatTimer !== null,
    subscribedUserDocs: userDocEntries.size,
  };
}

// ── Scoped `users` subscriptions (AUDIT-2 C2) ────────────────────────
type UserDocCb = (uid: string, data: any | null) => void;
interface UserDocEntry {
  listeners: Set<UserDocCb>;
  unsub: (() => void) | null;
}
const userDocEntries = new Map<string, UserDocEntry>();

/**
 * Subscribe to ONLY the given users' docs — the scoped replacement for
 * `onSnapshot(collection(db, 'users'))` (whole collection, 7 screens).
 * One underlying per-doc subscription per uid, refcounted and shared
 * across callers: subscribing to the same uid twice adds no second
 * subscription. The callback receives (uid, data) with data === null
 * when the doc is absent / not loaded yet. The returned unsubscribe
 * removes this caller; the underlying doc subscription is torn down
 * when its last caller leaves. See the header for the honest limit
 * (database.ts still ensures the whole `users` collection today).
 */
export function subscribeToUsers(userIds: string[], cb: UserDocCb): () => void {
  const ids = [...new Set((userIds || []).map((u) => String(u || '').trim()).filter(Boolean))];
  for (const uid of ids) {
    let entry = userDocEntries.get(uid);
    if (!entry) {
      entry = { listeners: new Set(), unsub: null };
      userDocEntries.set(uid, entry);
      entry.unsub = onSnapshot(doc(db, 'users', uid), (snap: any) => {
        const cur = userDocEntries.get(uid);
        if (!cur) return;
        let data: any | null = null;
        try {
          if (snap?.exists?.()) data = snap.data();
        } catch { /* intentionally ignored */}
        for (const l of [...cur.listeners]) {
          try {
            l(uid, data);
          } catch { /* intentionally ignored */}
        }
      });
    }
    entry.listeners.add(cb);
  }
  return () => {
    for (const uid of ids) {
      const entry = userDocEntries.get(uid);
      if (!entry) continue;
      entry.listeners.delete(cb);
      if (entry.listeners.size === 0) {
        try {
          entry.unsub?.();
        } catch { /* intentionally ignored */}
        userDocEntries.delete(uid);
      }
    }
  };
}

function write(uid: string, online: boolean) {
  const doUpdate = () => {
    // Phase 4: when last-seen privacy is 'nobody', stop publishing
    // lastSeen (we still publish online/offline — hiding that too would
    // need the backend to withhold the whole doc).
    const updates: Record<string, unknown> = {
      online,
      status: online ? 'online' : 'offline',
    };
    if (myLastSeenPrivacy !== 'nobody') updates.lastSeen = Date.now();
    return updateDoc(doc(db, 'users', uid), updates);
  };
  // Only touch an existing profile. Creating one here would leave a nameless
  // "ghost" user that other people cannot see or find in their chat list.
  if (profileExists === true) {
    doUpdate().catch(() => {});
    return;
  }
  getDoc(doc(db, 'users', uid))
    .then((snap: any) => {
      if (!snap.exists()) return;
      profileExists = true;
      return doUpdate();
    })
    .catch(() => {});
}

/** Start presence tracking for the signed-in user. Safe to call repeatedly. */
export function startPresence(uid: string): () => void {
  if (stopFn) return stopFn;

  // Phase 4: read the user's own last-seen privacy once so the heartbeat
  // can stop publishing lastSeen when it is 'nobody'. WA parity (audit e
  // #20): also cache the online-visibility choice the same way.
  getDoc(doc(db, 'users', uid))
    .then((snap: any) => {
      if (snap.exists()) {
        myLastSeenPrivacy = normalizePrivacyLevel(snap.data()?.lastSeenPrivacy);
        myOnlinePrivacy = normalizeOnlinePrivacy(snap.data()?.onlinePrivacy);
      }
    })
    .catch(() => {});

  presenceRunning = true;
  const beat = () => {
    lastBeatAt = Date.now();
    beatsWritten += 1;
    write(uid, true);
  };
  const goOffline = () => write(uid, false);
  beatFn = beat;
  // L6: PAUSE the heartbeat while backgrounded instead of letting a
  // timer keep firing (the old code only skipped the write inside
  // the tick). No user-doc rewrite, no heartbeat event for every other
  // client subscribed to the whole `users` collection, while hidden.
  // The timer is torn down on hide and re-armed on foreground, with an
  // immediate beat so "online" resumes without waiting up to a full
  // interval.
  const onVisibility = () => {
    if (document.hidden) {
      stopHeartbeatTimer();
      goOffline();
    } else {
      maybeImmediateBeat();
      armHeartbeatTimer();
    }
  };

  if (!document.hidden) beat();
  else write(uid, false);
  armHeartbeatTimer();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', goOffline);

  stopFn = () => {
    stopHeartbeatTimer();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', goOffline);
    goOffline();
    profileExists = null;
    presenceRunning = false;
    beatFn = null;
    presencePeers = new Set();
    openChatCount = 0;
    stopFn = null;
  };
  return stopFn;
}

/** Stop presence tracking (called on sign out). */
export function stopPresence() {
  stopFn?.();
}

/** Update the cached privacy without restarting presence (Settings calls this after saving). */
export function setMyLastSeenPrivacy(level: PrivacyLevel): void {
  myLastSeenPrivacy = normalizePrivacyLevel(level);
}

/** Whether a user should be shown as online right now (display-side only).
 * AUDIT-2 A7 split: `online` is the heartbeat boolean (no timestamp).
 * Freshness is checked against `lastSeen`. Privacy-'nobody' users are
 * NEVER shown online: WhatsApp's "Last seen and online" setting hides
 * both, so a viewer must not see "Online now" / a green dot / "Active
 * Now" for someone who set Last seen to Nobody — even though their
 * `online` heartbeat flag is still true and no lastSeen is ever written
 * for them (so the 90 s freshness window cannot apply). An earlier
 * version returned true here, on the mistaken belief that WhatsApp
 * still shows "online" when last-seen is hidden; W28b/F1 corrected it.
 * The heartbeat write itself is unchanged — this gates display only.
 * WA parity (audit e #20): when the target set online visibility to
 * "Same as last seen", only viewers who may see their last-seen time
 * may see them online (viewerUid unknown = fail-closed). */
export function isOnline(u: any, now: number = Date.now(), viewerUid?: string | null): boolean {
  if (!u || !u.online) return false;
  if (normalizePrivacyLevel(u?.lastSeenPrivacy) === 'nobody') return false;
  if (!canSeeOnline(u, viewerUid)) return false;
  const seen = Number(u.lastSeen) || 0;
  return now - seen < ONLINE_WINDOW_MS;
}

/** Human-friendly last seen text, e.g. "last seen today at 14:05".
 *  `viewerUid` (optional): when the target hides last-seen from this
 *  viewer, no timestamp is revealed — just "last seen recently". */
export function lastSeenText(u: any, now: number = Date.now(), viewerUid?: string | null): string {
  if (!canSeeLastSeen(u, viewerUid)) return 'last seen recently';
  if (isOnline(u, now, viewerUid)) return 'online';
  const seen = Number(u?.lastSeen) || 0;
  if (!seen) return 'last seen recently';

  const d = new Date(seen);
  const today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  if (seen >= startOfToday) return `last seen today at ${time}`;
  if (seen >= startOfYesterday) return `last seen yesterday at ${time}`;
  const date = d.toLocaleDateString([], { day: '2-digit', month: 'short' });
  return `last seen ${date} at ${time}`;
}
