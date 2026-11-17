/**
 * WebRTC calling engine for Pinglo — AWS only.
 *
 * - Signalling (offer / answer / hang-up) is stored in the `callsig` collection of
 *   our own AWS database (AppSync + DynamoDB). No third-party signalling server.
 * - Media is peer-to-peer RTCPeerConnection. ICE uses our own STUN/TURN server
 *   (EC2 coturn) and short-lived TURN credentials from the `turnCredentials` query.
 *   No Google / public STUN servers are used.
 * - Non-trickle ICE: each side waits for candidate gathering to finish and sends one
 *   complete SDP, so only a single signalling write is needed per direction.
 * - Global incoming call ringing with Web Audio tone & haptics.
 * - In-call controls: mute, camera flip, video toggle.
 * - Call history is logged to the `calls` collection.
 */

import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  db,
  auth,
} from '../aws';
import { fetchTurnServers, getLastTurnError } from './turn';
import {
  audioRouteStart,
  audioRouteStop,
  audioRouteGetDevices,
  audioRouteSetDevice,
  audioRouteEnsureBluetoothPermission,
  audioRouteOnChange,
  applyWebSinkIdToContext,
  getWebAudioInputs,
  getStoredWebOutputId,
  type AudioDevice,
  type AudioRouteResult,
} from './audioRoute';
// ROADMAP-2 #13 — "known caller" for silence-unknown-callers: a saved
// contact (contacts.ts, cache-first) or someone with a conversation
// (realtimeSync getConversationId + the known-convs memo ChatListScreen
// maintains). Neither module imports callService, so no cycle.
// 100M-C8 (W12f) — call ringtone reuses the notification tone list from
// appSettings (same WebAudio note system as the message/group tones).
// appSettings imports nothing from callService, so no cycle; main.tsx
// already imports appSettings, so this adds nothing to the first-load
// bundle (unlike the shareSend/storage chain fixed by W13 R8).
import { NOTIFICATION_TONES } from './appSettings';
import { loadSavedContactsCached, isContactSaved, loadBlockedIdsCached, getBlockedIdsLocal } from './contacts';
import { getConversationId } from './realtimeSync';
import { ensureKeyAnnounce } from './e2eeChat';
import { addCallReminder } from './callReminders';
// W13 NEXT R8 (B1 regression): NO static import of './shareSend' here.
// shareSend imports ../aws/storage → aws-amplify/storage, and App.tsx
// statically imports callService — so a static import pulled the whole
// vendor-amplify-storage chunk (17 KB transfer) into the first-load
// bundle (W12d b4bd701 added it; first-load jsBytes 272,233 → 296,008).
// declineWithMessage() is the only user of sendSharedText and runs on a
// rare user gesture (decline-with-message), so it dynamic-imports
// shareSend at the call site instead; the storage chunk then loads only
// when a call is actually declined with a message.

/**
 * AUDIT-2 B18 — foreground-service bridge. The native side is the
 * CallForeground Capacitor plugin (CallForegroundPlugin.java, registered
 * in MainActivity) driving CallForegroundService (declared in
 * AndroidManifest.xml with foregroundServiceType="microphone"). On the
 * web there is no native plugin: registerPlugin() resolves the call with
 * an error, which these helpers swallow — the browser keeps its own
 * call-audio behaviour and nothing in the call flow can fail over it.
 * Started when a call becomes active (outgoing dial in startCall,
 * accepted incoming in acceptCall), stopped in endCall() — every end
 * path funnels through endCall, including failures and timeouts.
 * Deliberately NOT started for a merely-ringing incoming call: the user
 * has not accepted anything yet, and a foreground service (persistent
 * notification + mic type) for an unanswered ring would be intrusive.
 * Background incoming-call ringing still depends on the OS keeping the
 * WebView alive — the service starts on accept.
 */
interface CallForegroundPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}
const CallForeground = registerPlugin<CallForegroundPlugin>('CallForeground');
/**
 * #6 — foreground-service start/stop now REPORT their failure instead
 * of swallowing it: returns the error message, or null on success.
 * On web there is no native plugin, so this is a no-op (null) — the
 * "not implemented on web" rejection is expected, not a failure, and
 * must not pollute diagnostics. Callers record a non-null result in
 * the call diagnostics; a failed start never kills the call itself
 * (the service only holds the mic foreground type — media runs in the
 * WebView), it is surfaced, not fatal.
 */
async function callForegroundStart(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  // Report 3 #118 — a failed start used to be one shot and swallowed.
  // Retry once after a short pause (the plugin can lose a race with
  // the activity coming to the foreground); a failure still never
  // kills the call — callers record it in diagnostics.
  let lastMsg: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await CallForeground.start();
      return null;
    } catch (err) {
      lastMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[callService] callForegroundStart failed (attempt ${attempt + 1}/2):`, err);
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return lastMsg;
}
async function callForegroundStop(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    await CallForeground.stop();
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[callService] callForegroundStop failed:', err);
    return msg;
  }
}

export type CallType = 'audio' | 'video';
/**
 * 100M-H12 — what startCall() did, so callers can say so instead of
 * looking like a dead button. 'already-in-call' is the one the UI
 * must surface ("You're already in a call"); 'starting' is a rapid
 * double-tap; 'self' is the never-call-yourself backstop; 'cancelled'
 * is a dial abandoned mid-setup (ended while gathering); 'failed' is
 * a dial that died in media/TURN/offer/signalling (the ended screen
 * already explains that one). Callers that ignore the value behave
 * exactly as before.
 */
export type StartCallResult = 'started' | 'already-in-call' | 'starting' | 'self' | 'cancelled' | 'failed';
/**
 * Worker C: 'connecting' is the callee state after sending the answer and
 * before ICE reports `connected`. The old code jumped straight to
 * 'connected' on accept, so a call that never connected showed a ticking
 * timer with black video / silence until `failed` ended it.
 */
export type CallStatus = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected' | 'ended';
/** Peer-connection health surfaced to the UI (Phase 3): 'good' | 'poor' | 'reconnecting' | 'unknown'. */
export type ConnectionQuality = 'good' | 'poor' | 'reconnecting' | 'unknown';

/**
 * Wave-2 B1 (WA audit Calls #26) — peer-visible video filters.
 * The same 5 filters the UI already offered as a local-preview-only
 * CSS effect. The CSS value is applied twice, identically: once as
 * the CSS `filter` on the local preview `<video>` (so the preview
 * shows what the peer sees) and once as `CanvasRenderingContext2D.filter`
 * while drawing the camera frames onto a canvas whose
 * `captureStream()` track is what the peer connection actually sends
 * (via `replaceTrack`). Background blur stays OUT — no segmentation
 * model exists in either client, so there is no honest blur to offer.
 */
export type CallVideoFilter = 'none' | 'bw' | 'warm' | 'cool' | 'vivid';
export const CALL_VIDEO_FILTERS: { id: CallVideoFilter; label: string; css: string }[] = [
  { id: 'none', label: 'None', css: '' },
  { id: 'bw', label: 'B&W', css: 'grayscale(1)' },
  { id: 'warm', label: 'Warm', css: 'sepia(0.35) saturate(1.4)' },
  { id: 'cool', label: 'Cool', css: 'saturate(1.15) hue-rotate(-15deg) brightness(1.05)' },
  { id: 'vivid', label: 'Vivid', css: 'saturate(1.8) contrast(1.12)' },
];
/**
 * Wave-2 B1 retry-7 gap (2) — derived from CALL_VIDEO_FILTERS, the
 * single source of truth for filter CSS. A hand-maintained second copy
 * of the same values drifted silently; the canvas pipeline reads this
 * map, the preview reads the list, both resolve to the same string.
 */
export const CALL_VIDEO_FILTER_CSS: Record<CallVideoFilter, string> = Object.fromEntries(
  CALL_VIDEO_FILTERS.map((f) => [f.id, f.css]),
) as Record<CallVideoFilter, string>;

/**
 * Wave-2 B1 retry-7 gap (1) — the filter canvas MUST keep the source
 * aspect. Sizing it as `width=min(w,1280), height=min(h,720)` with a
 * stretch `drawImage` squashed a portrait frame (720x1280) into a
 * 720x720 canvas for the peer while the local preview stayed correct.
 * Cap the LONG edge at 1280 and scale the other edge proportionally:
 * 720x1280 stays 720x1280, 1920x1080 becomes 1280x720, 1280x720 is
 * untouched. Unknown/zero dims fall back to 1280x720.
 */
export function fitFilteredCanvasSize(width: number, height: number): { width: number; height: number } {
  const w = width > 0 ? width : 1280;
  const h = height > 0 ? height : 720;
  const scale = Math.min(1, 1280 / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
/** Why a call ended, for the call-history record (missed vs declined vs busy vs unanswered). */
export type CallEndReason = 'completed' | 'missed' | 'declined' | 'busy' | 'unanswered' | 'cancelled' | 'failed' | 'acceptedElsewhere';

/**
 * WA audit #27 — call reactions (emoji reactions in a call).
 * The fixed set offered in the call UI (WA's call-control action
 * SHOW_CALL_REACTIONS → label "Reactions"). Signalled over the
 * existing `callsig` doc — one `reaction_<id>` field per reaction —
 * so no new backend service is needed. A per-reaction field (rather
 * than appending to a shared `reactions` array) keeps simultaneous
 * sends from both sides from overwriting each other: updateDoc
 * merges fields, so each side's write lands independently.
 */
export const CALL_REACTION_EMOJIS = ['❤️', '😂', '👍', '🎉', '👏', '🔥'] as const;
export type CallReactionEmoji = (typeof CALL_REACTION_EMOJIS)[number];
export interface CallReaction {
  /** Unique per reaction (`r_<ms>_<random>`); also the signal-field suffix. */
  id: string;
  emoji: string;
  /** Sender uid — the UI floats every reaction the same way; the field is for dedup/debug. */
  from: string;
  /** Date.now() at send time; the UI floats reactions younger than ~3 s. */
  at: number;
}

// ── ROADMAP-2 #13 — call waiting / DND / silence unknown callers ───────
// Prefs are per-device (localStorage), like the other call-adjacent prefs
// in appSettings.ts — a DND switch is a device preference, not a user-doc
// field, and the server cannot enforce it anyway (no server call rules
// exist yet; see BACKEND-PLAN.md).
export interface CallPrefs {
  /** When on, incoming calls never ring and never show the incoming screen. */
  doNotDisturb: boolean;
  /** When on, only known callers ring (see isKnownCaller). */
  silenceUnknownCallers: boolean;
  /** 100M-C8 (W12f) — incoming-call ringtone id from NOTIFICATION_TONES ('default' = classic 440/480 Hz telephone ring, 'silent' = no sound). */
  ringtone: string;
  /** 100M-C8 (W12f) — vibrate (haptics) on incoming calls. */
  vibrate: boolean;
  /**
   * WA audit #41 — "Protect IP address in calls": force relay-only ICE
   * (TURN) so the peer never sees a host/srflx candidate. WA's honest
   * copy applies here too: this will reduce call quality. Off by
   * default; per-device (localStorage), like the other call prefs.
   */
  protectIpAddress: boolean;
}

const DND_KEY = 'dt_call_dnd';
const SILENCE_UNKNOWN_KEY = 'dt_call_silence_unknown';
const RINGTONE_KEY = 'dt_call_ringtone';
const VIBRATE_KEY = 'dt_call_vibrate';
const PROTECT_IP_KEY = 'dt_call_protect_ip';

export function getCallPrefs(): CallPrefs {
  try {
    const rawRingtone = localStorage.getItem(RINGTONE_KEY);
    return {
      doNotDisturb: localStorage.getItem(DND_KEY) === '1',
      silenceUnknownCallers: localStorage.getItem(SILENCE_UNKNOWN_KEY) === '1',
      ringtone: NOTIFICATION_TONES.some((t) => t.id === rawRingtone) ? (rawRingtone as string) : 'default',
      vibrate: localStorage.getItem(VIBRATE_KEY) !== '0',
      protectIpAddress: localStorage.getItem(PROTECT_IP_KEY) === '1',
    };
  } catch {
    return { doNotDisturb: false, silenceUnknownCallers: false, ringtone: 'default', vibrate: true, protectIpAddress: false };
  }
}

export function setCallPrefs(patch: Partial<CallPrefs>): CallPrefs {
  const next = { ...getCallPrefs(), ...patch };
  try {
    localStorage.setItem(DND_KEY, next.doNotDisturb ? '1' : '0');
    localStorage.setItem(SILENCE_UNKNOWN_KEY, next.silenceUnknownCallers ? '1' : '0');
    localStorage.setItem(RINGTONE_KEY, next.ringtone);
    localStorage.setItem(VIBRATE_KEY, next.vibrate ? '1' : '0');
    localStorage.setItem(PROTECT_IP_KEY, next.protectIpAddress ? '1' : '0');
  } catch (err) {
    console.warn('[callService] setCallPrefs: could not persist call prefs', err);
  }
  return next;
}

/**
 * "Known" caller for silence-unknown-callers: a saved contact, someone
 * with a proven conversation, or someone previously called. All reads are
 * cache-only (never a network fetch, never a user enumeration) so the
 * check is instant and works offline.
 *
 * Honest false-negative: a real conversation partner whose chat has
 * never been opened on THIS device (cold known-convs memo, unloaded
 * message cache) reads as unknown and is silenced — but the call is
 * still recorded as missed, so the user can call back. The Settings copy
 * says this plainly.
 */
export function isKnownCaller(callerId: string, myUid?: string): boolean {
  const me = myUid || auth.currentUser?.uid || '';
  if (!callerId || !me) return false;
  if (callerId === me) return true;
  try {
    if (isContactSaved(loadSavedContactsCached(me), callerId)) return true;
  } catch { /* fall through */ }
  try {
    const convId = getConversationId(me, callerId);
    const raw = localStorage.getItem(`pinglo_known_convs_${me}`);
    if (raw) {
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr) && (arr as unknown[]).includes(convId)) return true;
    }
    const msgs = (db as any)?.getCollectionDocs?.(`chats/${convId}/messages`);
    if (Array.isArray(msgs) && msgs.length > 0) return true;
  } catch { /* fall through */ }
  // Report 3 #113 (C6) — the memo + message cache above are cold for a
  // conversation the user has never opened on THIS device, even though
  // the chat row itself is cached (chat list discovery). A cached chat
  // doc for the conversation — or a participants list naming the caller —
  // is the same proof, cache-only, no network.
  try {
    const convId = getConversationId(me, callerId);
    const chats = (db as any)?.getCollectionDocs?.('chats');
    if (Array.isArray(chats)) {
      if (chats.some((c: any) => c?.id === convId)) return true;
      if (chats.some((c: any) => Array.isArray(c?.participants) && (c.participants as unknown[]).includes(callerId))) return true;
    }
  } catch { /* fall through */ }
  try {
    const calls = (db as any)?.getCollectionDocs?.('calls');
    if (Array.isArray(calls) && calls.some((c: any) => c?.callerId === callerId || c?.receiverId === callerId)) return true;
  } catch { /* fall through */ }
  return false;
}

/** Pure routing decision for an incoming signal — unit-tested by the R1B probe. */
export type IncomingCallDecision = 'ring' | 'silence-dnd' | 'silence-unknown' | 'waiting' | 'busy' | 'blocked';

export function decideIncomingCall(
  prefs: CallPrefs,
  known: boolean,
  busy: boolean,
  waitingOccupied: boolean,
  blocked = false,
): IncomingCallDecision {
  // WA audit #9 — a blocked caller never rings, whatever else is set.
  // Blocked beats DND: DND still posts a "Missed call" pill into the
  // chat thread, blocked must not (see handleIncomingSignal).
  if (blocked) return 'blocked';
  if (prefs.doNotDisturb) return 'silence-dnd';
  if (prefs.silenceUnknownCallers && !known) return 'silence-unknown';
  if (!busy) return 'ring';
  return waitingOccupied ? 'busy' : 'waiting';
}

/**
 * A second incoming call parked while another call is live. Only ONE
 * waiting slot exists: a third caller gets the old 'busy' behaviour.
 * The SDP offer is captured at park time so the call can still be
 * answered after the current call ends.
 */
export interface WaitingCall {
  signalId: string;
  remoteUserId: string;
  remoteName: string;
  remoteAvatar: string;
  type: CallType;
  offer: string;
  receivedAt: number;
}

export interface ActiveCallData {
  status: CallStatus;
  type: CallType;
  remoteUserId: string;
  remoteName: string;
  remoteAvatar?: string;
  isIncoming: boolean;
  duration: number;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  isVideoEnabled: boolean;
  facingMode: 'user' | 'environment';
  isSpeaker: boolean;
  /** Phase 4 — true while the local screen (not camera) is being sent. */
  isScreenSharing: boolean;
  /**
   * Wave-2 B1 (WA audit Calls #26) — the video filter currently applied
   * to the OUTGOING track (canvas-processed, so the peer sees it), not
   * just to the local preview. 'none' = raw camera. Mirrors the
   * service's private videoFilterId; the UI reads this, never its own
   * copy, so the two can never disagree.
   */
  videoFilter?: CallVideoFilter;
  /** Wave-2 B1 — why the last setVideoFilter() call refused, if it did. */
  videoFilterNotice?: string | null;
  /**
   * Report 3 #107 — the shared-screen stream while screen-sharing, so
   * the call UI can preview what the other side sees. Null otherwise.
   */
  screenStream?: MediaStream | null;
  /**
   * Report 3 #100 — true while a live remote video track is present
   * (a video track arrived and is neither muted nor ended). False when
   * the remote side has no camera, turned it off, or sent audio only —
   * the UI then shows their avatar instead of a black video element.
   * False until the first remote track arrives.
   */
  remoteVideoEnabled?: boolean;
  /**
   * Report 3 #103 — true when this video call has no camera at all
   * (capture failed, audio-only fallback). The UI says so plainly
   * instead of silently running a "video" call with no picture.
   */
  isAudioOnly?: boolean;
  /** Phase 3 — live connection health for the call UI. */
  connectionQuality: ConnectionQuality;
  /**
   * WA audit #6/#10 — a pre-call permission / support problem the UI
   * must explain instead of failing onto the ended screen: 'unsupported'
   * = this device/browser cannot call at all (no getUserMedia /
   * RTCPeerConnection), 'mic-denied' = the microphone permission is
   * denied (the camera is best-effort and never produces this). Set by
   * the service before a dial/accept that cannot proceed, or carried
   * into the ended state by endCall from a media failure. CallModal
   * renders the explainer modal whenever this is set, even from 'idle'.
   */
  permissionNotice?: { kind: 'unsupported' | 'mic-denied'; detail: string } | null;
  /**
   * WA audit #27 — reactions received (and sent) on this call, newest
   * last, capped at 12. CallModal floats each one as an emoji over
   * the call screen while it is fresh (< ~3 s old). Replaced with a
   * fresh activeCall literal on every new call, so nothing leaks
   * across calls.
   */
  callReactions?: CallReaction[];
  /**
   * WA audit #60 — bumped by requestRestore() when the chat-list
   * ongoing-call row is tapped; CallModal watches it and un-minimises.
   */
  restoreToken?: number;
  /**
   * Worker C: why the last call ended, in the user's words, when it ended
   * badly (permission denied, couldn't connect, busy…). Shown on the
   * ended screen with a Call Back button. Null for clean ends.
   * Optional so older literals (App.tsx initial state) keep compiling.
   */
  callError?: string | null;
  /**
   * 100M-H4: why the last call ended, in plain words, for clean ends
   * that never connected ('Declined' / 'No answer' / 'Cancelled' /
   * 'Busy' / 'Missed call'). callError covers real failures only, so
   * without this the ended screen just said "Call ended". Null for
   * connected calls that end normally and for failures (callError
   * covers those). Shown on the ended screen in a neutral style —
   * this is not an error.
   */
  endReasonText?: string | null;
  /**
   * #4/#8 — which step failed, in a stable machine-readable id
   * ('turn-fetch' | 'ice-connect-timeout' | 'ice-failed' |
   * 'apply-answer' | 'start-signalling' | 'start-offer' |
   * 'answer-signalling' | 'answer-offer' | 'ring-timeout-after-answer'
   * | 'call-dropped' | null). Shown on the ended screen next to the
   * message so the user — and the log — knows what actually failed.
   */
  failedStep?: string | null;
  /**
   * #8 — step-wise call diagnostics as short text (TURN present?
   * relay candidate gathered? ICE state? which step failed?). Filled
   * in by endCall; CallModal shows it on the ended screen with a
   * "Copy diagnostics" action.
   */
  callDiagnostics?: string | null;
  /**
   * ROADMAP-2 #13 — a second incoming call parked while this one is
   * live (null when none). CallModal renders the waiting banner from it.
   */
  waitingCall?: WaitingCall | null;
  /** ROADMAP-2 #13 — true when DND is on, so CallModal can show the indicator. */
  isDndOn?: boolean;
  /**
   * 100M-H13 — true once the user tapped Silence on an incoming call:
   * the ringtone + haptics are off but the call is still ringing for
   * the caller and can still be answered. False on every new incoming
   * call (showIncomingCall resets it).
   */
  ringSilenced?: boolean;
  /**
   * Report 3 #114 — transient, user-facing note about the camera when a
   * video call runs audio-only because the camera failed ("Camera
   * unavailable — continuing audio-only") or a mid-call camera
   * re-enable failed. CallModal shows it as a hint. Null when there is
   * nothing to say. Optional so older literals keep compiling.
   */
  videoNotice?: string | null;
  /**
   * Report 3 #9/#10/#15/#18 — the REAL call-audio outputs and the one
   * actually active (native read-back, or the web setSinkId choice).
   * `audioDevices` is [] until the first refresh; `audioRouteError` is
   * a plain-English reason when routing failed or Bluetooth is
   * unavailable, null when routing is fine.
   */
  audioDevices?: AudioDevice[];
  currentAudioDevice?: AudioDevice | null;
  audioRouteError?: string | null;
  /** True when BLUETOOTH_CONNECT was denied (Android 12+) — the OS hides Bluetooth headsets. */
  bluetoothDenied?: boolean;
  /** Mic input chosen for this call (web deviceId; on native the mic follows the communication device). */
  audioInputDeviceId?: string | null;
  /**
   * Report 3 #19 (W24) — the mic inputs enumerateDevices can see, for
   * the mic picker in CallModal. [] until the first refresh; labels
   * are '' until mic permission is granted, so entries may read
   * "Microphone 1/2" at first and gain real names after.
   */
  audioInputs?: AudioDevice[];
}

type CallChangeListener = (call: ActiveCallData) => void;

const SIG_COL = 'callsig';
// Deployer's own coturn server (STUN is served by the same process as TURN).
// Configure it via VITE_TURN_SERVER_URL; unset means no STUN URL is configured.
const OWN_STUN_URL: string = (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURN_SERVER_URL) || '';
const RING_TIMEOUT_MS = 45_000;
// Ignore ringing signals whose timestamp is far from now (stale or clock-skewed).
// Worker C: was 90 s — real phones drift by minutes, so a live call was
// silently dropped when the caller's clock ran >90 s from the callee's.
// 300 s still suppresses leaked `ringing` docs (a caller crash leaves one
// behind; the caller deletes its doc 60 s after endCall, the callee now
// does too — see endCall), which are hours/days old by the time they
// could re-ring on a reload.
//
// AUDIT-2 B18 (verified, Worker 2B): the window is a client-side
// mitigation, NOT server time. `createdAt` on the signal doc is stamped
// by the CALLER with Date.now() (startCall), and database.ts's
// serverTimestamp() is literally Date.now() (triaged) — there is no
// server-stamped time anywhere in the signalling path, so a caller whose
// clock is >300 s off still has its signals dropped. The drop is now at
// least LOUD (console.warn in onSignalSnapshot, with the skew in
// seconds) instead of silent. True server time needs a backend change —
// an AppSync resolver stamping createdAt with $util.time.now() (or a
// server-time endpoint the clients sync their offset against) — recorded
// for BACKEND-PLAN.md; do not pretend the client can fix it.
const INCOMING_MAX_SKEW_MS = 300_000;
/**
 * W24 — stale-`ringing` sweeper (Report 3 #6 residual / #125).
 *
 * W3's fix only cleans `ringing` docs whose |skew| is already >= 300 s.
 * A doc whose caller crashed/killed the app stays `ringing` FOREVER, and
 * while it is inside the 300 s window it is re-delivered on every reload:
 * it re-rings a dead call and parks the callee as busy (activeCall
 * 'incoming'), so the NEXT genuine call gets a 'busy' write — the caller
 * sees "line busy" for a call that never existed.
 *
 * The doc's own age cannot tell a ghost from a live call — the caller's
 * clock may be minutes off — but elapsed time on THIS clock can: the
 * caller arms its 45 s ring timeout BEFORE the doc is written
 * (startCall: armRingTimeout, then setDoc), so a `ringing` doc this
 * device first saw >= 60 s ago (45 s ring + 15 s grace) is provably past
 * the caller's ring whether or not the clocks agree. First sight is
 * persisted in localStorage so a reload cannot re-ring the same ghost:
 * the second delivery expires it instead of ringing it. The 300 s skew
 * window itself is NOT changed.
 *
 * Never expires: our own active call (callId), a parked waiting call, or
 * a call carried past endCall (pendingPromote) — those are live by
 * definition and have their own expiry (armWaitingTimeout /
 * maybePromoteWaiting's receivedAt check, same elapsed-time principle).
 * Future-dated docs are safe to expire by this rule too: firstSeen is
 * measured on the callee's clock, not the caller's stamped createdAt.
 */
const STALE_RINGING_GHOST_MS = RING_TIMEOUT_MS + 15_000; // 60 s
/** W24 — how often the sweeper re-checks ringing docs seen earlier (no new snapshot arrives for a doc nobody touches). */
const STALE_RINGING_SWEEP_MS = 30_000;
/** W24 — persisted first-sight map (signalId -> { at, historyRecorded }). */
const RINGING_FIRST_SEEN_KEY = 'pinglo.ringingFirstSeen.v1';
const RINGING_FIRST_SEEN_MAX = 100;
/** W24 — first-sight entries older than this are pruned (a doc that old is a ghost by every rule, and W3's >=300 s branch handles it anyway). */
const RINGING_FIRST_SEEN_TTL_MS = 10 * 60_000;
// Worker C: was 4 s. TURN allocation on a mobile network can take longer;
// sending the offer without a relay candidate guarantees failure on
// symmetric NATs. Gathering still resolves early on 'complete'.
const ICE_GATHER_TIMEOUT_MS = 6_000;
/** Worker C: give up if ICE never reports `connected` after the answer. */
const CONNECT_TIMEOUT_MS = 25_000;
/**
 * Worker C: how long a `disconnected` peer connection may recover on its own.
 * Report 3 #110 — was 10 s: WhatsApp keeps trying noticeably longer and
 * degrades quality first, so a transient mobile-data blip ended the call
 * here while it would have recovered there. 20 s + the bitrate cap in
 * setConnectionQuality give a real drop time to recover before the call
 * is ended honestly.
 */
const DROP_TIMEOUT_MS = 20_000;
/** Worker C: TURN credentials live 12 h (backend) — refresh well inside that. */
const TURN_REFRESH_MS = 30 * 60_000;
const DEFAULT_CONNECT_FAILED =
  "Couldn't connect. Check your connection and try again.";
/**
 * 100M-H4: user-facing reason text for a clean end that never
 * connected. 'failed' / 'completed' are deliberately absent — a
 * failed end is covered by callError, and a connected call that ends
 * normally gets no reason line.
 */
const END_REASON_TEXT: Partial<Record<CallEndReason, string>> = {
  declined: 'Declined',
  unanswered: 'No answer',
  busy: 'Busy',
  missed: 'Missed call',
  cancelled: 'Cancelled',
  // WA audit #8 — the call was picked up on another device/session
  // (CallLogResult.AcceptedElsewhere). The signal branch that sets
  // this lives in onOwnSignal ('answered-elsewhere'); no DT client
  // writes that status yet (multi-device is design-only), so today
  // this renders only when a peer that does writes it.
  acceptedElsewhere: 'Answered elsewhere',
};

/**
 * #4 — every failure step gets its OWN message. The old code reused
 * DEFAULT_CONNECT_FAILED for the ICE timeout, a fast pc 'failed', a
 * setRemoteDescription throw and the ring-timeout backstop, so the
 * ended screen could never say what actually failed. Each constant
 * below is used at exactly one failure site (see the site comments).
 */
const ERR_ICE_TIMEOUT =
  "Couldn't connect — the call timed out while connecting (ICE never connected). Check your connection and try again.";
const ERR_ICE_TIMEOUT_NO_TURN =
  "Couldn't connect — the call timed out while connecting and the call relay (TURN) is unreachable. Check your connection and try again.";
const ERR_ICE_FAILED =
  "Couldn't connect — the connection failed while connecting (ICE failed). Check your connection and try again.";
const ERR_ANSWER_APPLY =
  "Couldn't connect — the other side answered, but the call answer couldn't be applied. Try again.";
const ERR_OFFER_FAILED =
  "Couldn't start the call — the call offer couldn't be created on this device. Try again.";
const ERR_ANSWER_CREATE =
  "Couldn't answer the call — the call answer couldn't be created on this device. Try again.";
const ERR_SIGNAL_WRITE =
  "Couldn't reach the server to place the call. Check your connection and try again.";
const ERR_ANSWER_WRITE =
  "Couldn't answer the call — the server couldn't be reached. Check your connection and try again.";
const ERR_RING_TIMEOUT_AFTER_ANSWER =
  "Couldn't connect — the other side answered, but the connection never established (timed out after answering). Check your connection and try again.";
const ERR_CALL_DROPPED =
  'Call dropped — the network connection was lost.';
/** #5 — shown immediately at dial/accept time when the TURN fetch failed. */
const ERR_TURN_FETCH =
  "Couldn't reach the call server (TURN relay). Check your connection and try again.";
/** #7 — bounded ICE-restart retries per call attempt. */
const MAX_ICE_RESTARTS = 2;

/** #8 — one step of a call's diagnostics trail (kept in memory only, per call). */
export interface CallDiagnosticsStep {
  step: string;
  at: number;
  detail?: string;
}

/** #8 — step-wise call diagnostics, built live and frozen into ActiveCallData on end. */
export interface CallDiagnostics {
  callId: string | null;
  role: 'caller' | 'callee' | null;
  startedAt: number;
  turnAvailable: boolean;
  turnFetchFailed: boolean;
  turnError: string | null;
  relayCandidate: boolean;
  hostCandidate: boolean;
  srflxCandidate: boolean;
  iceConnectionState: string;
  connectionState: string;
  iceRestarts: number;
  failedStep: string | null;
  failedReason: string | null;
  foregroundServiceError: string | null;
  steps: CallDiagnosticsStep[];
}

const newCallId = (): string => {
  const c: any = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // AUDIT-2 D4: the Math.random() fallback is gone. Call IDs must be
  // unguessable; on a WebView too old for crypto.randomUUID() (pre
  // Chrome 92) the call fails with an honest error instead of minting a
  // weak ID.
  throw new Error('Secure call IDs need crypto.randomUUID() — this browser/WebView is too old to place a call.');
};

// ── 100M-C8 (W12f) — call ringtone ──────────────────────────────────
// One ring cycle for the chosen tone, rendered on the given context so
// the ringtone-sink routing (#13) still applies. Shared by startRinging
// (the live incoming ring) and previewCallRingtone (the Settings picker),
// so the preview plays exactly what an incoming call will play.
// - 'default' (or an unknown id) = the classic 440/480 Hz telephone
//   dual-tone the app always played — existing behaviour, unchanged.
// - 'silent' = no sound at all (vibration is a separate pref).
// - any other NOTIFICATION_TONES id = that tone's note sequence.
// Returns the cycle length in ms (for preview cleanup timing).
export function playCallRingCycle(ctx: AudioContext, ringtoneId: string, isIncoming: boolean): number {
  if (ringtoneId === 'silent') return 0;
  const now = ctx.currentTime;
  if (ringtoneId === 'default' || !NOTIFICATION_TONES.some((t) => t.id === ringtoneId)) {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    // 440Hz + 480Hz classic telephone frequency
    osc1.frequency.value = isIncoming ? 440 : 400;
    osc2.frequency.value = isIncoming ? 480 : 450;
    const dur = isIncoming ? 1.5 : 1.0;
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + dur);
    osc2.stop(now + dur);
    return dur * 1000;
  }
  const tone = NOTIFICATION_TONES.find((t) => t.id === ringtoneId)!;
  let at = now;
  for (const [freq, ms] of tone.notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + ms / 1000 + 0.05);
    at += ms / 1000 + 0.03;
  }
  return tone.notes.reduce((s, [, ms]) => s + ms + 30, 0);
}

class CallService {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private listeners: Set<CallChangeListener> = new Set();

  private activeCall: ActiveCallData = {
    status: 'idle',
    type: 'audio',
    remoteUserId: '',
    remoteName: '',
    remoteAvatar: '',
    isIncoming: false,
    duration: 0,
    localStream: null,
    remoteStream: null,
    isMuted: false,
    isVideoEnabled: true,
    facingMode: 'user',
    isSpeaker: false,
    isScreenSharing: false,
    videoFilter: 'none',
    videoFilterNotice: null,
    connectionQuality: 'unknown',
    callError: null,
  };

  private durationTimer: any = null;
  // WA audit #7 — getStats quality sampler (2 s while connected).
  private qualityTimer: any = null;
  // WA audit #6/#10 — a permission problem raised by a dial/accept that
  // died on media, carried into the ended state by endCall (which
  // replaces the activeCall literal and would otherwise wipe it).
  private pendingPermissionNotice: { kind: 'unsupported' | 'mic-denied'; detail: string } | null = null;
  private audioCtx: AudioContext | null = null;
  private ringInterval: any = null;
  private hapticInterval: any = null;
  private initializedUserId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private isSwitchingCamera: boolean = false;
  private ringTimeout: any = null;
  // Worker C — see the individual fixes below.
  private connectTimeout: any = null;
  private dropTimer: any = null;
  private signalHealthTimer: any = null;
  private turnFetchedAt = 0;
  private turnFetchPromise: Promise<void> | null = null;
  private turnAvailable = false;
  private starting = false;
  private accepting = false;
  private failDetail: string | null = null;
  private failedStep: string | null = null;
  // #8 — diagnostics trail for the current call attempt (reset per call).
  private diagSteps: CallDiagnosticsStep[] = [];
  private diagStartedAt = 0;
  private diagTurnFetchFailed = false;
  private diagTurnError: string | null = null;
  private diagRelayCandidate = false;
  private diagHostCandidate = false;
  private diagSrflxCandidate = false;
  private diagIceState = '';
  private diagForegroundError: string | null = null;
  // #7 — ICE restart state (reset per call attempt).
  private iceRestartAttempts = 0;
  private iceRestartInProgress = false;
  private lastAnswerSdp: string | null = null;
  private lastReofferSdp: string | null = null;
  private videoCaptureFailed = false;
  /** Report 3 #100 — the remote video track currently being watched for
   * mute/unmute/ended (null when the remote side sends no video). */
  private remoteVideoTrack: MediaStreamTrack | null = null;
  // Report 3 #114 — guards renegotiateVideo() against concurrent runs
  // (a toggle tap + the on-connect reconcile firing together).
  private videoRenegotiating = false;
  private seenMissed: Set<string> = new Set();
  // ROADMAP-2 #13 — call waiting state. `waiting` is the parked second
  // call; `pendingPromote` is a parked call carried past endCall so it
  // can ring as a normal incoming call once the current call dismisses.
  // `swappingToWaiting` stops endCall's dismiss timer from wiping the
  // state while acceptWaitingCall() is mid-swap (see acceptWaitingCall).
  private waiting: WaitingCall | null = null;
  private pendingPromote: WaitingCall | null = null;
  private waitingTimeout: any = null;
  private swappingToWaiting = false;

  // Signalling state
  private sigUnsub: (() => void) | null = null;
  private iceServers: RTCIceServer[] = OWN_STUN_URL ? [{ urls: OWN_STUN_URL }] : [];
  private callId: string | null = null;          // callsig doc id of the current call
  private role: 'caller' | 'callee' | null = null;
  private pendingOffer: string | null = null;    // callee: SDP offer waiting for accept
  private answerApplied = false;                 // caller: remote answer applied once
  private remoteEnded = false;                   // other side already ended the call
  private seenIncoming: Set<string> = new Set();
  /**
   * WA audit #27 — reaction ids already rendered, so a snapshot
   * re-delivery (or the echo of my own send) never floats the same
   * emoji twice. Ids are unique per reaction, so the set is safe
   * across calls; it is capped instead of cleared per call.
   */
  private seenReactionIds: Set<string> = new Set();
  // W24 — stale-`ringing` sweeper state. `ringingFirstSeen` is the
  // persisted first-sight map (signalId -> { at, historyRecorded }); it is
  // deliberately NOT cleared by cleanup() — a reload must still know
  // the ghost was already seen. `lastRingingDocs` is the per-session
  // cache of `ringing` docs addressed to us (refreshed by every
  // snapshot, cleared by cleanup) that the periodic sweep re-checks.
  private ringingFirstSeen: Map<string, { at: number; historyRecorded: boolean }> = new Map();
  private lastRingingDocs: Map<string, any> = new Map();
  private sweepTimer: any = null;

  // H2 (reload restore) — ids of my own outgoing `ringing` docs this
  // session already attempted to resume, so a re-delivered snapshot
  // never re-runs the resume (and a failed resume never loops).
  // `restoringCall` guards the async resume itself against re-entry.
  private restoreAttemptedIds = new Set<string>();
  private restoringCall = false;

  // Firestore id of the call record written for the current outgoing call.
  private callDocId: string | null = null;
  // 100M-H1 — the startCall history addDoc is fire-and-forget: while it
  // is in flight, endCall must not late-write a second doc. The slot
  // belongs to one call (callId is crypto.randomUUID, unique per call);
  // endCall stashes the final status on it and the .then applies it to
  // the doc when the write lands (or the .catch creates it if it failed).
  private historyWrite: {
    callId: string;
    finalPatch: { status: CallEndReason; duration: number; endedAt: number } | null;
  } | null = null;
  // 100M-H1 — endCall can re-enter synchronously: writing 'ended' to the
  // signal doc notifies our own subscription, and onOwnSignal calls
  // endCall again while the outer call is still finalising (activeCall
  // is still 'outgoing'/'incoming'). The history finalise must run
  // exactly once per signalled call; sigId is unique per call, so no
  // reset is ever needed.
  private historyFinalisedFor: string | null = null;
  // W12d (100-more C2): a decline-with-message send is in flight — the
  // ended screen's auto-dismiss timer re-arms while this is true, so
  // the modal is still mounted when the send result arrives.
  private declineMessagePending = false;
  // W12d (100-more C2): handle for the ended-screen auto-dismiss timer,
  // so holdEndedScreen() can cancel it once the decline-message result
  // is on screen.
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  // Phase 3 — reconnect + end reason.
  private reconnectAttempted = false;
  // Phase 4 — screen share state (see startScreenShare).
  private screenStream: MediaStream | null = null;
  // Wave-2 B1 — canvas filter pipeline state (see setVideoFilter).
  // The raw camera track is NEVER stopped while a filter is on: the
  // hidden video element plays it, the canvas draws it filtered, and
  // the canvas captureStream track is what the peer receives. Turning
  // the filter off swaps the raw track back in via replaceTrack.
  private videoFilterId: CallVideoFilter = 'none';
  private filterCanvas: HTMLCanvasElement | null = null;
  private filterCtx: CanvasRenderingContext2D | null = null;
  private filterVideo: HTMLVideoElement | null = null;
  private filterStream: MediaStream | null = null;
  private filterSourceTrack: MediaStreamTrack | null = null;
  private filterRaf: number | null = null;
  private filterStarting = false;
  private cameraVideoTrack: MediaStreamTrack | null = null;
  private endReason: CallEndReason = 'cancelled';
  private remoteEndStatus: string | null = null;
  private qualityListeners: Set<(q: ConnectionQuality) => void> = new Set();
  private offlineHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  /** Report 3 #119 — grace timer for a transient offline blip (see ensureOfflineListener). */
  private offlineTimer: any = null;
  // Report 3 #115 — beforeunload/pagehide guard (see ensureUnloadGuard).
  private unloadHandler: ((e: BeforeUnloadEvent) => void) | null = null;
  private pagehideHandler: (() => void) | null = null;
  // Report 3 #113 (C8) — consecutive signal-health ticks with the
  // subscription down (see startSignalHealthCheck).
  private signalDownTicks = 0;
  // Report 3 #11/#12 — audio routing state. `audioRouteStarted` keeps
  // ensureAudioRoute() idempotent (dial/accept start it; `connected`
  // only refreshes the device list). The native listener + the web
  // devicechange listener are both removed in endCall().
  private audioRouteStarted = false;
  private removeAudioRouteListener: (() => void) | null = null;
  private webDeviceChangeHandler: (() => void) | null = null;
  /** Mic input the user explicitly picked (applies from the next getMedia). */
  private preferredAudioInputId: string | null = null;
  /** Web output device id chosen for this call (setSinkId target). */
  private selectedWebOutputId: string | null = null;
  /** Output the user explicitly picked in the call UI; null = auto-route (headset wins). */
  private userPickedOutputId: string | null = null;

  constructor() {
    // No global listeners here: the offline handler is attached per-call
    // (see ensureOfflineListener) and removed in endCall/dispose, so a
    // finished call can never leak a listener into the next one.
  }

  /** Phase 3 — subscribe to connection-quality changes (in addition to subscribe()). */
  public onConnectionQuality(cb: (q: ConnectionQuality) => void): () => void {
    this.qualityListeners.add(cb);
    cb(this.activeCall.connectionQuality);
    return () => {
      this.qualityListeners.delete(cb);
    };
  }

  private setConnectionQuality(q: ConnectionQuality) {
    if (this.activeCall.connectionQuality === q) return;
    this.activeCall.connectionQuality = q;
    this.qualityListeners.forEach((cb) => {
      try {
        cb(q);
      } catch (err) {
        console.warn("[callService] callForegroundStop: cb(q) failed", err);
      }
    });
    this.emit();
    // Report 3 #110 — degrade the outgoing video while the connection
    // is poor/reconnecting (single 720p capture held until the drop
    // timeout is what made every blip fatal). Capping the sender to
    // ~250 kbps gives the call a chance to survive on a weak link;
    // the cap is lifted when the connection recovers.
    void this.applyVideoBitrateCap(q === 'poor' || q === 'reconnecting');
  }

  /**
   * Report 3 #110 — best-effort adaptive bitrate: cap (or un-cap) the
   * outgoing video sender. Never fails the call: any sender without a
   * video track, or a browser that rejects setParameters, just keeps
   * its current rate.
   */
  private async applyVideoBitrateCap(capped: boolean) {
    try {
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      const target = capped ? 250_000 : undefined;
      if (params.encodings[0].maxBitrate === target) return;
      params.encodings[0].maxBitrate = target;
      await sender.setParameters(params);
      this.recordDiag(capped ? 'bitrate-capped' : 'bitrate-restored', capped ? '250 kbps' : 'uncapped');
    } catch (err) {
      console.warn('[callService] applyVideoBitrateCap failed (keeping current rate):', err);
    }
  }

  private ensureOfflineListener() {
    if (this.offlineHandler || typeof window === 'undefined') return;
    // Report 3 #119 — the old handler ended a connected call on ANY
    // `offline` event, so a 1 s Wi-Fi↔mobile handover blip killed a
    // live call while ICE `disconnected` got a 10 s recovery window.
    // Now the call gets the same 10 s (DROP_TIMEOUT_MS): only if the
    // device is STILL offline when the timer fires does the call end.
    // `online` inside the window cancels it and restores the quality.
    this.offlineHandler = () => {
      if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended') return;
      console.warn('Network offline during call — waiting 10s for recovery before ending');
      this.setConnectionQuality('reconnecting');
      clearTimeout(this.offlineTimer);
      this.offlineTimer = setTimeout(() => {
        this.offlineTimer = null;
        if (
          typeof navigator !== 'undefined' && navigator.onLine === false &&
          this.activeCall.status !== 'idle' && this.activeCall.status !== 'ended'
        ) {
          console.warn('Still offline after 10s — ending call');
          this.endReason = 'failed';
          this.setFail('call-dropped', ERR_CALL_DROPPED);
          this.endCall(true);
        }
      }, DROP_TIMEOUT_MS);
    };
    this.onlineHandler = () => {
      if (this.offlineTimer) {
        clearTimeout(this.offlineTimer);
        this.offlineTimer = null;
      }
      if (
        this.activeCall.status !== 'idle' && this.activeCall.status !== 'ended' &&
        this.activeCall.connectionQuality === 'reconnecting'
      ) {
        this.setConnectionQuality('unknown');
      }
    };
    window.addEventListener('offline', this.offlineHandler);
    window.addEventListener('online', this.onlineHandler);
  }

  private removeOfflineListener() {
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    if (typeof window !== 'undefined') {
      if (this.offlineHandler) window.removeEventListener('offline', this.offlineHandler);
      if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
    }
    this.offlineHandler = null;
    this.onlineHandler = null;
  }

  // ── Report 3 #115 — beforeunload/pagehide guard ────────────────────
  // The old code had no unload guard at all: reloading/closing the tab
  // mid-call killed the call with no `ended` write, so the remote side
  // kept ringing until the 45 s timeout. While a call is live, a
  // beforeunload handler writes `ended` best-effort (and asks the
  // browser to confirm leaving, on web) and pagehide writes it for a
  // close the confirm cannot catch. Installed at dial / ring / accept,
  // removed in endCall/cleanup — never active outside a call.
  private ensureUnloadGuard() {
    if (typeof window === 'undefined' || this.unloadHandler) return;
    this.unloadHandler = (e: BeforeUnloadEvent) => {
      if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended' ||
          this.activeCall.status === 'outgoing' || this.activeCall.status === 'connecting') return;
      this.writeEndedBestEffort();
      e.preventDefault();
      (e as any).returnValue = '';
    };
    this.pagehideHandler = () => {
      if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended' ||
          this.activeCall.status === 'outgoing' || this.activeCall.status === 'connecting') return;
      this.writeEndedBestEffort();
    };
    window.addEventListener('beforeunload', this.unloadHandler);
    window.addEventListener('pagehide', this.pagehideHandler);
  }

  private removeUnloadGuard() {
    if (typeof window === 'undefined') return;
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    if (this.pagehideHandler) {
      window.removeEventListener('pagehide', this.pagehideHandler);
      this.pagehideHandler = null;
    }
  }

  /** Fire-and-forget `ended` write for the unload path — never throws, never awaits. */
  private writeEndedBestEffort() {
    const sigId = this.callId;
    if (!sigId || this.remoteEnded) return;
    updateDoc(doc(db, SIG_COL, sigId) as any, { status: 'ended' }).catch(() => {});
  }

  /** Current call status for UI that must not duplicate the call screen (see #123). */
  public getStatus(): CallStatus {
    return this.activeCall.status;
  }

  /** Remove all listeners owned by this service (call on app teardown / logout). */
  public dispose() {
    this.removeOfflineListener();
    this.cleanup();
  }

  // Concurrent callers share one in-flight init, so startCall can await a ready signal channel
  public init(userId: string): Promise<void> {
    if (this.initPromise && this.initializedUserId === userId) return this.initPromise;
    this.initPromise = this.doInit(userId);
    return this.initPromise;
  }

  private async doInit(userId: string) {
    // Report 3 #113 (C9) — never tear down a live call's signalling
    // subscription on a re-init (auth state re-fire). init() already
    // dedups same-uid calls, so this is a backstop for any future
    // caller: a live call keeps its subscription and its seen sets.
    // An account SWITCH (different uid) still tears down — the call
    // belongs to the old account.
    const callLive =
      this.activeCall.status === 'outgoing' ||
      this.activeCall.status === 'incoming' ||
      this.activeCall.status === 'connecting' ||
      this.activeCall.status === 'connected';
    if (callLive && this.initializedUserId === userId && this.sigUnsub) return;
    this.cleanup();
    this.initializedUserId = userId;

    // Worker C: subscribe FIRST, then fetch TURN. The old order awaited
    // the TURN fetch before subscribing, so a slow/hung credential
    // request delayed the signalling subscription and incoming calls
    // never rang. TURN is refreshed again before each call anyway
    // (ensureTurnServers), so subscribing early loses nothing.
    this.subscribeSignals(userId);

    // W24 — stale-`ringing` sweeper: load first-sight state before the
    // first snapshot can deliver a ghost, then start the periodic sweep.
    this.loadRingingFirstSeen();
    this.startStaleRingingSweep();

    await this.ensureTurnServers(true);
    if (this.initializedUserId !== userId) return; // account changed while fetching
  }

  /**
   * Report 3 #113 (C8) — (re-)subscribe to the `callsig` collection.
   * The health check (startSignalHealthCheck) calls this when the
   * subscription has been down through a whole ring: re-establishing
   * the socket is the only client-side recovery when the 45 s ring
   * would otherwise outlast a dead subscription. Re-subscribing never
   * touches the peer connection or local media.
   */
  private subscribeSignals(userId: string) {
    if (this.sigUnsub) {
      try {
        this.sigUnsub();
      } catch (err) {
        console.warn('[callService] subscribeSignals: previous unsubscribe failed', err);
      }
      this.sigUnsub = null;
    }
    try {
      // Listen for calls addressed to us (and for updates to our own outgoing calls)
      this.sigUnsub = onSnapshot(collection(db, SIG_COL) as any, (snap: any) => {
        if (this.initializedUserId !== userId) return;
        this.onSignalSnapshot(userId, snap);
      });
    } catch (e) {
      console.warn('Could not start call signalling:', e);
    }
  }

  /**
   * Worker C: TURN credentials are short-lived (12 h backend) but were
   * fetched exactly once, at login. A user signed in for >12 h, or one
   * whose login-time fetch failed, kept STUN-only (or expired) servers
   * forever — the classic phone-to-phone failure on mobile NATs. Refresh
   * before each call; concurrent callers share one in-flight fetch.
   */
  private ensureTurnServers(force = false): Promise<void> {
    if (!force && Date.now() - this.turnFetchedAt < TURN_REFRESH_MS && this.iceServers.length > 1) {
      return Promise.resolve();
    }
    if (this.turnFetchPromise) return this.turnFetchPromise;
    const userId = this.initializedUserId;
    this.turnFetchPromise = (async () => {
      try {
        const turnServers = await fetchTurnServers();
        if (userId !== null && this.initializedUserId !== userId) return;
        this.iceServers = OWN_STUN_URL ? [{ urls: OWN_STUN_URL }, ...turnServers] : [...turnServers];
        this.turnAvailable = turnServers.length > 0;
        this.turnFetchedAt = Date.now();
        // #5: record whether the fetch actually failed (vs. no-backend
        // local mode, where getLastTurnError() is null and STUN-only is
        // expected). Callers at dial/accept time fail fast on this.
        const fetchErr = getLastTurnError();
        this.diagTurnFetchFailed = !this.turnAvailable && fetchErr !== null;
        this.diagTurnError = fetchErr;
        if (!this.turnAvailable) {
          if (fetchErr) {
            console.warn('Call: TURN relay fetch failed — calls will fail across mobile NATs (STUN only):', fetchErr);
            this.recordDiag('turn-fetch-failed', fetchErr);
          } else {
            console.warn('Call: no TURN relay available — calls may fail across mobile NATs (STUN only).');
            this.recordDiag('turn-fetch-empty', 'no TURN servers (no backend in local mode, or empty response)');
          }
        } else {
          this.recordDiag('turn-fetch-ok', `${turnServers.length} TURN server entry(ies)`);
        }
      } catch (e) {
        console.warn('Call: TURN refresh failed, keeping previous ICE servers:', e);
        this.diagTurnFetchFailed = true;
        this.diagTurnError = e instanceof Error ? e.message : String(e);
        this.recordDiag('turn-fetch-failed', this.diagTurnError);
      } finally {
        this.turnFetchPromise = null;
      }
    })();
    return this.turnFetchPromise;
  }

  /** Worker C: stop the timers that belong to one call attempt. */
  private clearCallTimers() {
    clearTimeout(this.ringTimeout);
    this.ringTimeout = null;
    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
    clearTimeout(this.dropTimer);
    this.dropTimer = null;
    // Report 3 #119 — an offline grace timer must not outlive the call.
    clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
    this.signalDownTicks = 0;
    this.stopSignalHealthCheck();
  }

  // ── #8 — step-wise call diagnostics ────────────────────────────────
  /** Reset the diagnostics trail + ICE-restart state for a new call attempt. */
  private resetDiagnostics(role: 'caller' | 'callee') {
    this.diagSteps = [];
    this.diagStartedAt = Date.now();
    this.diagTurnFetchFailed = false;
    this.diagTurnError = null;
    this.diagRelayCandidate = false;
    this.diagHostCandidate = false;
    this.diagSrflxCandidate = false;
    this.diagIceState = '';
    this.diagForegroundError = null;
    this.iceRestartAttempts = 0;
    this.iceRestartInProgress = false;
    this.lastAnswerSdp = null;
    this.lastReofferSdp = null;
    this.failedStep = null;
    this.recordDiag('call-start', role);
  }

  /** Append one step to the diagnostics trail (in-memory only). */
  private recordDiag(step: string, detail?: string) {
    this.diagSteps.push({ step, at: Date.now(), detail });
    if (this.diagSteps.length > 60) this.diagSteps.shift();
  }

  /** Set the failure (message + stable step id) in one place — #4. */
  private setFail(step: string, message: string) {
    this.failedStep = step;
    this.failDetail = message;
    this.recordDiag(`failed:${step}`, message);
  }

  /** Structured diagnostics for the current call attempt. */
  public getDiagnostics(): CallDiagnostics {
    return {
      callId: this.callId,
      role: this.role,
      startedAt: this.diagStartedAt,
      turnAvailable: this.turnAvailable,
      turnFetchFailed: this.diagTurnFetchFailed,
      turnError: this.diagTurnError,
      relayCandidate: this.diagRelayCandidate,
      hostCandidate: this.diagHostCandidate,
      srflxCandidate: this.diagSrflxCandidate,
      iceConnectionState: this.diagIceState || this.pc?.iceConnectionState || '',
      connectionState: this.pc?.connectionState || this.activeCall.status,
      iceRestarts: this.iceRestartAttempts,
      failedStep: this.failedStep,
      failedReason: this.failDetail,
      foregroundServiceError: this.diagForegroundError,
      steps: [...this.diagSteps],
    };
  }

  /**
   * #8 — diagnostics text frozen at endCall time. Takes the call id /
   * role as parameters because endCall clears them before building the
   * ended state; everything else comes from the diagnostics trail.
   */
  private buildDiagnosticsText(
    callId: string | null,
    role: 'caller' | 'callee' | null,
    failedStep: string | null,
    failedReason: string | null,
  ): string {
    const started = this.diagStartedAt ? new Date(this.diagStartedAt).toISOString() : 'n/a';
    const lines = [
      'Pinglo call diagnostics',
      `Started: ${started}`,
      `Role: ${role || 'n/a'} | Type: ${this.activeCall.type} | Peer: ${this.activeCall.remoteName || this.activeCall.remoteUserId || 'n/a'} | Call: ${(callId || 'n/a').slice(0, 8)}`,
      `Failed step: ${failedStep || 'none'}`,
      `Error: ${failedReason || 'none'}`,
      `TURN: ${this.turnAvailable ? 'available' : 'missing'}${this.diagTurnFetchFailed ? ` (fetch failed: ${this.diagTurnError || 'unknown'})` : ''}`,
      `Candidates gathered: host=${this.diagHostCandidate ? 'yes' : 'no'} srflx=${this.diagSrflxCandidate ? 'yes' : 'no'} relay=${this.diagRelayCandidate ? 'yes' : 'no'}`,
      `ICE state: ${this.diagIceState || 'n/a'} | Connection: ${this.activeCall.status}`,
      `ICE restarts: ${this.iceRestartAttempts}/${MAX_ICE_RESTARTS}`,
      `Foreground service: ${this.diagForegroundError ? `failed to start (${this.diagForegroundError})` : 'ok / n/a'}`,
      'Steps:',
      ...this.diagSteps.map((s) => `  ${new Date(s.at).toISOString().slice(11, 19)} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`),
    ];
    return lines.join('\n');
  }

  /** Short exportable text summary of the diagnostics (ended screen + copy). */
  public getDiagnosticsText(): string {
    // After endCall the ended state carries the frozen text (call id /
    // role / pc are already cleared on the service) — prefer it.
    if (this.activeCall.callDiagnostics) return this.activeCall.callDiagnostics;
    const d = this.getDiagnostics();
    const started = d.startedAt ? new Date(d.startedAt).toISOString() : 'n/a';
    const lines = [
      'Pinglo call diagnostics',
      `Started: ${started}`,
      `Role: ${d.role || 'n/a'} | Type: ${this.activeCall.type} | Peer: ${this.activeCall.remoteName || this.activeCall.remoteUserId || 'n/a'}`,
      `Failed step: ${d.failedStep || 'none'}`,
      `Error: ${d.failedReason || 'none'}`,
      `TURN: ${d.turnAvailable ? 'available' : 'missing'}${d.turnFetchFailed ? ` (fetch failed: ${d.turnError || 'unknown'})` : ''}`,
      `Candidates gathered: host=${d.hostCandidate ? 'yes' : 'no'} srflx=${d.srflxCandidate ? 'yes' : 'no'} relay=${d.relayCandidate ? 'yes' : 'no'}`,
      `ICE state: ${d.iceConnectionState || 'n/a'} | Connection: ${d.connectionState}`,
      `ICE restarts: ${d.iceRestarts}/${MAX_ICE_RESTARTS}`,
      `Foreground service: ${d.foregroundServiceError ? `failed to start (${d.foregroundServiceError})` : 'ok / n/a'}`,
      'Steps:',
      ...d.steps.map((s) => `  ${new Date(s.at).toISOString().slice(11, 19)} ${s.step}${s.detail ? ` — ${s.detail}` : ''}`),
    ];
    return lines.join('\n');
  }

  /** #8 — copy the diagnostics summary to the clipboard (ended screen action). */
  public async copyDiagnostics(): Promise<boolean> {
    const text = this.getDiagnosticsText();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn('[callService] copyDiagnostics: clipboard.writeText failed', err);
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      console.warn('[callService] copyDiagnostics: fallback copy failed', err);
      return false;
    }
  }

  // ── #7 — real ICE restart ──────────────────────────────────────────
  /**
   * Real ICE restart (non-trickle renegotiation). Creates a fresh offer
   * with iceRestart:true, re-gathers candidates on the existing peer
   * connection, and sends the new offer to the peer through the
   * signalling doc (`status: 'reoffer'`). The peer answers it via
   * handleReoffer() and the new answer is applied by onOwnSignal.
   * Bounded to MAX_ICE_RESTARTS attempts per call.
   *
   * Honest limit: this re-gathers on the EXISTING peer connection, so
   * it reuses the ICE servers snapshotted at createPeer() time — a
   * fresh TURN fetch cannot swap servers into a live pc. If the TURN
   * credentials themselves expired mid-call, only a fresh dial (Call
   * Back) with a new pc picks them up.
   */
  private async tryIceRestart(reason: string): Promise<boolean> {
    const pc = this.pc;
    const callId = this.callId;
    if (!pc || !callId) return false;
    if (this.iceRestartInProgress) return false;
    if (this.iceRestartAttempts >= MAX_ICE_RESTARTS) {
      this.recordDiag('ice-restart-exhausted', `no retries left (${reason})`);
      return false;
    }
    if (this.activeCall.status !== 'outgoing' && this.activeCall.status !== 'connecting' && this.activeCall.status !== 'connected') return false;
    if (pc.signalingState === 'closed') return false;
    this.iceRestartInProgress = true;
    this.iceRestartAttempts += 1;
    this.recordDiag('ice-restart-attempt', `${reason} (attempt ${this.iceRestartAttempts}/${MAX_ICE_RESTARTS})`);
    try {
      const offer = await pc.createOffer({ iceRestart: true } as RTCOfferOptions);
      await pc.setLocalDescription(offer);
      await this.waitForIce(pc);
      if (this.pc !== pc || this.callId !== callId) return false;
      await updateDoc(doc(db, SIG_COL, callId) as any, {
        offer: pc.localDescription?.sdp || '',
        status: 'reoffer',
        reofferBy: this.role,
        reofferAt: Date.now(),
      });
      // Give the renegotiated ICE a fresh window to connect.
      this.armConnectTimeout();
      this.recordDiag('ice-restart-sent', 'reoffer written, waiting for new answer');
      return true;
    } catch (e) {
      console.warn('ICE restart failed:', e);
      this.recordDiag('ice-restart-failed', e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      this.iceRestartInProgress = false;
    }
  }

  /**
   * Peer side of an ICE restart: a `reoffer` arrived on our own signal
   * doc. Apply the new offer, answer it, and write the answer back so
   * the initiator can apply it. Runs for either role — whichever side
   * initiated the restart, the other side lands here.
   */
  private async handleReoffer(s: any): Promise<void> {
    const pc = this.pc;
    const callId = this.callId;
    if (!pc || !callId || !s.offer || s.offer === this.lastReofferSdp) return;
    // Never answer our own reoffer: the initiator sees its own write
    // echoed back on the same doc (reofferBy names the initiator, and
    // the SDP equals our current local description).
    if (s.reofferBy && s.reofferBy === this.role) return;
    if (pc.localDescription?.sdp === s.offer) return;
    if (pc.signalingState === 'closed') return;
    this.lastReofferSdp = s.offer;
    this.recordDiag('ice-restart-received', 'applying peer reoffer');
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: s.offer });
      // 100M-H9 — peer-side of a voice → video upgrade: the other side
      // just re-offered with a video m-line. Flip our type so the UI
      // renders their incoming video (showRemoteVideoMain keys off
      // `type`); our own camera stays off until WE tap Video — the
      // flip only says the call is a video call now, not that our
      // camera is on.
      if (s.offer.includes('m=video') && this.activeCall.type === 'audio') {
        this.activeCall.type = 'video';
        this.activeCall.isAudioOnly = false;
        this.recordDiag('peer-upgraded-to-video', 'peer re-offer carries video — call is video now');
        this.emit();
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIce(pc);
      if (this.pc !== pc || this.callId !== callId) return;
      await updateDoc(doc(db, SIG_COL, callId) as any, {
        answer: pc.localDescription?.sdp || '',
        status: 'answered',
      });
      this.lastAnswerSdp = pc.localDescription?.sdp || null;
      this.armConnectTimeout();
      this.recordDiag('ice-restart-answered', 'new answer written');
    } catch (e) {
      console.warn('Could not answer ICE restart offer:', e);
      this.recordDiag('ice-restart-answer-failed', e instanceof Error ? e.message : String(e));
    }
  }

  /** Give up if ICE never connects after the answer was exchanged. */
  private armConnectTimeout() {
    clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => {
      void (async () => {
        if (this.activeCall.status === 'outgoing' || this.activeCall.status === 'connecting') {
          // #7: don't give up at the first timeout — try a real ICE
          // restart (bounded retries) before ending the call.
          if (await this.tryIceRestart('connect-timeout')) return;
          console.warn('Call connect timeout — ICE never connected');
          this.endReason = 'failed';
          // #4: TURN-unreachable vs plain ICE timeout are different
          // failures with different fixes — say which one it was.
          this.setFail(
            'ice-connect-timeout',
            this.turnAvailable ? ERR_ICE_TIMEOUT : ERR_ICE_TIMEOUT_NO_TURN,
          );
          this.endCall(true);
        }
      })();
    }, CONNECT_TIMEOUT_MS);
  }

  /**
   * Worker C: while ringing/connecting, the AppSync subscription is the
   * only thing that can deliver the other side's answer/end. The shared
   * DB layer already polls every 3 s and re-subscribes on `online` /
   * foreground (reaction/late-message fix), but the call UI never showed
   * that the signal path was down. Surface it as 'reconnecting' quality
   * (CallModal renders the pill) while the call is not yet connected.
   */
  private startSignalHealthCheck() {
    if (this.signalHealthTimer) return;
    this.signalHealthTimer = setInterval(() => {
      // Report 3 #244 — "Reconnecting…" is a LIVE-call signal only.
      // Before connect there is no call to drop: db.isReconnecting()
      // is true whenever no live subscription exists yet, which in
      // mock/offline mode is always — so every unanswered ring showed
      // "Your network dropped" ~4 s in although nothing had dropped.
      // Gate the pill to connected calls; pre-connect the status line
      // (Ringing…/Connecting…) is the whole story. The down-check
      // itself still runs pre-connect: #113 (C8) needs it to
      // re-subscribe a dead socket mid-ring — the early return that
      // used to sit here made the C8 resubscribe below unreachable.
      if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended') return;
      const isLive = this.activeCall.status === 'connected';
      if (!isLive && this.activeCall.connectionQuality === 'reconnecting') this.setConnectionQuality('unknown');
      try {
        const down = (db as any)?.isReconnecting?.(SIG_COL) === true;
        if (down) {
          if (isLive) this.setConnectionQuality('reconnecting');
          // Report 3 #113 (C8) — a subscription dead for the whole 45 s
          // ring means the callee hears nothing and the caller never
          // learns why. After ~9 s down mid-ring/connect, re-establish
          // the subscription instead of waiting the ring out on a dead
          // socket. Only while ringing/connecting; a connected call's
          // media no longer depends on the signal socket.
          this.signalDownTicks += 1;
          if (
            this.signalDownTicks >= 3 &&
            this.initializedUserId &&
            (this.activeCall.status === 'outgoing' ||
              this.activeCall.status === 'incoming' ||
              this.activeCall.status === 'connecting')
          ) {
            this.signalDownTicks = 0;
            this.recordDiag('signal-resubscribe', 'callsig subscription down — re-subscribing');
            this.subscribeSignals(this.initializedUserId);
          }
        } else {
          this.signalDownTicks = 0;
          if (this.activeCall.connectionQuality === 'reconnecting') this.setConnectionQuality('unknown');
        }
      } catch (err) {
        console.warn("[callService] startSignalHealthCheck: const down = (db as any)?.isReconnectin...", err);
      }
    }, 3000);
  }

  private stopSignalHealthCheck() {
    if (this.signalHealthTimer) {
      clearInterval(this.signalHealthTimer);
      this.signalHealthTimer = null;
    }
  }

  public subscribe(cb: CallChangeListener): () => void {
    this.listeners.add(cb);
    cb(this.activeCall);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    this.listeners.forEach((cb) => {
      try {
        cb({ ...this.activeCall });
      } catch (e) {
        console.error('Call listener error:', e);
      }
    });
  }

  // ── Ringtone & Sound Generation using Web Audio API ──
  private startRinging(isIncoming: boolean) {
    this.stopRinging();
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      this.audioCtx = new AudioContextClass();
      // Report 3 #116 — an AudioContext created outside a user gesture
      // starts `suspended` under Android WebView / Chrome autoplay
      // policy, so an incoming call could show the full-screen UI with
      // NO audible ring. Resume it on creation and again on every tone,
      // and on the next user gesture (the incoming screen itself is
      // tapped to answer/decline, which is a gesture).
      void this.audioCtx.resume().catch(() => {});
      if (this.audioCtx.state === 'suspended') {
        console.warn('[callService] ringtone AudioContext suspended (autoplay policy) — will resume on next gesture');
      }
      if (!this.ringResumeHandler) {
        this.ringResumeHandler = () => {
          if (this.audioCtx && this.audioCtx.state === 'suspended') {
            void this.audioCtx.resume().catch(() => {});
          }
        };
        window.addEventListener('pointerdown', this.ringResumeHandler);
        window.addEventListener('keydown', this.ringResumeHandler);
      }
      // Report 3 #13 — the ringtone must come out of the same device as
      // the call, not the browser default. On native the mode is already
      // MODE_IN_COMMUNICATION (ensureAudioRoute runs before ringing);
      // on the web the sink is applied to this context.
      void this.applyRingtoneSink();

      // 100M-C8 (W12f) — the ring uses the chosen call ringtone; the
      // outgoing dial tone is unchanged (the picker is for incoming
      // calls only, like WhatsApp's call ringtone setting).
      const prefs = getCallPrefs();
      const playTone = () => {
        if (!this.audioCtx) return;
        // #116 — a context suspended after creation (autoplay policy)
        // stays silent until resumed; retry on every tone.
        if (this.audioCtx.state === 'suspended') {
          void this.audioCtx.resume().catch(() => {});
        }
        playCallRingCycle(this.audioCtx, isIncoming ? prefs.ringtone : 'default', isIncoming);
      };

      playTone();
      this.ringInterval = setInterval(playTone, isIncoming ? 2500 : 3500);

      if (isIncoming && prefs.vibrate) {
        this.hapticInterval = setInterval(() => {
          Haptics.impact({ style: ImpactStyle.Heavy }).catch((err) => console.warn("[callService] playTone: impact(...) failed", err));
        }, 1200);
      }
    } catch (err) {
      console.warn("[callService] playTone: const AudioContextClass = window.AudioContext || (win...", err);
    }
  }

  private ringResumeHandler: (() => void) | null = null;

  private stopRinging() {
    if (this.ringInterval) clearInterval(this.ringInterval);
    if (this.hapticInterval) clearInterval(this.hapticInterval);
    this.ringInterval = null;
    this.hapticInterval = null;
    // Report 3 #116 — the gesture-resume listener belongs to the ring.
    if (this.ringResumeHandler && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.ringResumeHandler);
      window.removeEventListener('keydown', this.ringResumeHandler);
      this.ringResumeHandler = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch((err) => console.warn("[callService] stopRinging: close(...) failed", err));
      this.audioCtx = null;
    }
  }

  /**
   * 100M-C8 (W12f) — preview one incoming-ring cycle for a tone id
   * (Settings picker). Plays exactly what an incoming call would play
   * for that tone (same playCallRingCycle), on a throwaway context.
   * No-op for 'silent'. No id = the currently saved call ringtone.
   */
  previewCallRingtone(id?: string): void {
    const ringtoneId = id ?? getCallPrefs().ringtone;
    if (ringtoneId === 'silent') return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx: AudioContext = new AudioContextClass();
      void ctx.resume().catch(() => {});
      const ms = playCallRingCycle(ctx, ringtoneId, true);
      setTimeout(() => ctx.close().catch((err) => console.warn('[callService] previewCallRingtone: close(...) failed', err)), ms + 300);
    } catch (err) {
      console.warn('[callService] previewCallRingtone failed', err);
    }
  }

  // ── Call audio routing (Report 3 #9–#19) ──────────────────────────
  // The old code started routing only at `connected` (callService:710)
  // and pinned the earpiece there, so a headset that rang audibly went
  // silent at connect and could never be selected. Routing now starts
  // at dial / accept / incoming-ring, auto-routes to a connected
  // headset, and re-routes when devices change mid-call.

  /**
   * Start call-audio routing for this call (#11): request
   * BLUETOOTH_CONNECT first (#14), then MODE_IN_COMMUNICATION +
   * auto-route (headset > wired > earpiece). Idempotent — later calls
   * only refresh the device list. Never fails the call: when routing
   * cannot start, the reason is recorded on `audioRouteError` and the
   * call continues on the platform default.
   */
  private async ensureAudioRoute(): Promise<void> {
    if (this.audioRouteStarted) {
      await this.refreshAudioDevices();
      return;
    }
    if (Capacitor.isNativePlatform()) {
      try {
        const perm = await audioRouteEnsureBluetoothPermission();
        const denied = !perm.granted && !perm.notNeeded;
        this.activeCall.bluetoothDenied = denied;
        if (denied) {
          this.activeCall.audioRouteError =
            'Bluetooth permission denied — your headset will not appear as an output. Allow Bluetooth in Settings → Apps → Pinglo → Permissions, then try again.';
        }
      } catch (err) {
        console.warn('[callService] Bluetooth permission check failed:', err);
      }
      const res = await audioRouteStart();
      this.audioRouteStarted = res.ok;
      if (!res.ok) {
        this.activeCall.audioRouteError = res.error || 'Could not start call audio routing.';
        console.warn('[callService] audioRouteStart failed:', res.error);
      } else {
        if (res.device) this.activeCall.currentAudioDevice = res.device;
        if (res.bluetoothDenied) this.activeCall.bluetoothDenied = true;
        if (!this.activeCall.bluetoothDenied) this.activeCall.audioRouteError = null;
        this.syncSpeakerFlag();
      }
      if (!this.removeAudioRouteListener) {
        try {
          this.removeAudioRouteListener = await audioRouteOnChange((e) => {
            // Native mid-call device change (#12): the plugin already
            // re-routed; mirror the real device into the UI state.
            if (e.device) this.activeCall.currentAudioDevice = e.device;
            if (typeof e.bluetoothDenied === 'boolean') this.activeCall.bluetoothDenied = e.bluetoothDenied;
            this.syncSpeakerFlag();
            void this.refreshAudioDevices();
            this.emit();
          });
        } catch (err) {
          console.warn('[callService] audio route change listener failed:', err);
        }
      }
    } else {
      // Web (#18): no native plugin — list outputs, restore the stored
      // choice, and listen for headsets appearing mid-call.
      this.selectedWebOutputId = getStoredWebOutputId();
      this.audioRouteStarted = true;
      if (!this.webDeviceChangeHandler) {
        this.webDeviceChangeHandler = () => {
          void this.handleWebDeviceChange();
        };
        try {
          navigator.mediaDevices?.addEventListener('devicechange', this.webDeviceChangeHandler);
        } catch (err) {
          console.warn('[callService] devicechange listener failed:', err);
        }
      }
    }
    await this.refreshAudioDevices();
    // The ringtone may already be playing (incoming ring): route it
    // through the same output as the call (#13).
    void this.applyRingtoneSink();
  }

  /** Keep `isSpeaker` honest: it reflects the real device, not the last button pressed. */
  private syncSpeakerFlag() {
    this.activeCall.isSpeaker = this.activeCall.currentAudioDevice?.kind === 'speaker';
  }

  /** Refresh the output list + current device from the platform and push it to the UI. */
  private async refreshAudioDevices(): Promise<AudioDevice[]> {
    // D3 (#262): snapshot the list before the refresh so the UI can be
    // told when it actually changed (emit at the end of this function).
    const prevIds = (this.activeCall.audioDevices ?? []).map((d) => d.id).join(',');
    const prevInputIds = (this.activeCall.audioInputs ?? []).map((d) => d.id).join(',');
    const prevCurrentId = this.activeCall.currentAudioDevice?.id ?? null;
    try {
      const res = await audioRouteGetDevices();
      if (res.ok) {
        this.activeCall.audioDevices = res.devices ?? [];
        if (res.device) {
          this.activeCall.currentAudioDevice = res.device;
          this.syncSpeakerFlag();
        }
        if (typeof res.bluetoothDenied === 'boolean') this.activeCall.bluetoothDenied = res.bluetoothDenied;
        if (!Capacitor.isNativePlatform()) {
          // Web has no "current" device from the platform: the current
          // output is the stored/selected one, else the default.
          const chosen = (this.selectedWebOutputId
            ? (res.devices ?? []).find((d) => d.id === this.selectedWebOutputId)
            : undefined) ?? (res.devices ?? [])[0] ?? null;
          this.activeCall.currentAudioDevice = chosen;
        }
        // #19 (W24): refresh the mic-input list alongside the outputs
        // so the mic picker stays current (unplug/re-plug, labels
        // appearing after mic permission). Best-effort: a failed
        // enumeration keeps the previous list, never the call.
        try {
          const inputs = await getWebAudioInputs();
          if (inputs.length > 0) this.activeCall.audioInputs = inputs;
        } catch (err) {
          console.warn('[callService] refreshAudioDevices: mic list failed:', err);
        }
        // D3 (#262): the old code never emitted here, so an unplugged
        // headset stayed listed (and clickable) until some other event
        // re-rendered. Emit when the output list, the input list, or
        // the current device changed.
        const nextIds = (this.activeCall.audioDevices ?? []).map((d) => d.id).join(',');
        const nextInputIds = (this.activeCall.audioInputs ?? []).map((d) => d.id).join(',');
        const nextCurrentId = this.activeCall.currentAudioDevice?.id ?? null;
        if (nextIds !== prevIds || nextInputIds !== prevInputIds || nextCurrentId !== prevCurrentId) this.emit();
        return res.devices ?? [];
      }
      if (!this.activeCall.audioRouteError) this.activeCall.audioRouteError = res.error ?? null;
      return this.activeCall.audioDevices ?? [];
    } catch (err) {
      console.warn('[callService] refreshAudioDevices failed:', err);
      return this.activeCall.audioDevices ?? [];
    }
  }

  /** Web mid-call device change (#12): a newly appeared headset output takes over unless the user picked one. */
  private async handleWebDeviceChange(): Promise<void> {
    if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended') return;
    // D2 (#261): snapshot the list BEFORE the refresh — a device that
    // was not there before is "newly appeared". The old code found a
    // headset by /bluetooth/i on the NAME, but the web layer reports
    // every non-default output as kind 'unknown' and real headsets are
    // named "Pixel Buds Pro", not "Bluetooth …", so that test could
    // never match one and the takeover branch was dead.
    const prevDevices = this.activeCall.audioDevices ?? [];
    const devices = await this.refreshAudioDevices();
    if (this.userPickedOutputId) return; // explicit pick wins — never yank it
    const current = this.activeCall.currentAudioDevice;
    const onDefault = !current || current.id === 'default' || current.id === devices[0]?.id;
    const appeared = devices.filter(
      (d) => d.id !== 'default' && !prevDevices.some((p) => p.id === d.id),
    );
    // Any newly-appeared non-default output takes over while we are on
    // the default output. Deliberately NOT persisted: this is a live
    // routing change, not an explicit pick — the next call starts on
    // the stored choice or the default, as before.
    if (onDefault && appeared.length > 0) {
      const next = appeared[0];
      this.selectedWebOutputId = next.id;
      this.activeCall.currentAudioDevice = next;
      this.syncSpeakerFlag();
      void this.applyRingtoneSink();
      this.emit();
      return;
    }
    // The current output vanished (unplugged headset): fall back to the
    // default output instead of going silent.
    const currentGone = this.activeCall.currentAudioDevice
      && !devices.some((d) => d.id === this.activeCall.currentAudioDevice?.id);
    if (currentGone) {
      this.selectedWebOutputId = null;
      this.activeCall.currentAudioDevice = devices[0] ?? null;
      this.syncSpeakerFlag();
      this.emit();
    }
  }

  /** Route the ringtone through the same output as the call (#13). */
  private async applyRingtoneSink(): Promise<void> {
    if (!this.audioCtx) return;
    if (Capacitor.isNativePlatform()) {
      // Native: MODE_IN_COMMUNICATION (set by ensureAudioRoute before
      // ringing) already puts WebView audio on the communication device.
      return;
    }
    if (!this.selectedWebOutputId) return;
    const res = await applyWebSinkIdToContext(this.audioCtx, this.selectedWebOutputId);
    if (!res.ok) console.warn('[callService] ringtone sink failed:', res.error);
  }

  /** Cycle through the ACTUAL available outputs (#9/#10): earpiece → speaker → headset(s) → … */
  public async cycleAudioOutput(): Promise<AudioRouteResult> {
    const devices = await this.refreshAudioDevices();
    if (devices.length === 0) {
      const msg = 'No audio outputs found.';
      this.activeCall.audioRouteError = msg;
      this.emit();
      return { ok: false, error: msg };
    }
    const order: AudioDevice[] = [
      ...devices.filter((d) => d.kind === 'earpiece'),
      ...devices.filter((d) => d.kind === 'speaker'),
      ...devices.filter((d) => d.kind === 'bluetooth'),
      ...devices.filter((d) => d.kind === 'wired'),
      ...devices.filter((d) => d.kind === 'unknown'),
    ];
    const currentId = this.activeCall.currentAudioDevice?.id;
    const idx = order.findIndex((d) => d.id === currentId);
    const next = order[(idx + 1) % order.length];
    return this.setAudioOutput(next.id);
  }

  /** Route to one explicit output from `audioDevices` (UI picker). */
  public async setAudioOutput(deviceId: string): Promise<AudioRouteResult> {
    const res = await audioRouteSetDevice(deviceId);
    if (res.ok) {
      this.userPickedOutputId = deviceId;
      if (!Capacitor.isNativePlatform()) this.selectedWebOutputId = deviceId;
      // D1 (#260): on web the platform result carries kind 'unknown'
      // and name '' (setWebAudioOutput has no label to report), and the
      // old code preferred it over the picked entry — so the control
      // label degraded to "Audio" after any pick/cycle while the chips
      // stayed right. Prefer the picked entry from the enumerated list
      // (real name/kind); the platform result is only the fallback
      // when the entry is no longer in the list. Native keeps the
      // plugin's read-back, which already carries the real device.
      if (!Capacitor.isNativePlatform()) {
        const picked = (this.activeCall.audioDevices ?? []).find((d) => d.id === deviceId);
        if (picked) this.activeCall.currentAudioDevice = picked;
        else if (res.device) this.activeCall.currentAudioDevice = res.device;
      } else if (res.device) {
        this.activeCall.currentAudioDevice = res.device;
      }
      this.syncSpeakerFlag();
      this.activeCall.audioRouteError = null;
      void this.applyRingtoneSink();
      this.emit();
    } else {
      this.activeCall.audioRouteError = res.error || 'Could not change the audio output.';
      console.warn('[callService] setAudioOutput failed:', res.error);
      this.emit();
    }
    return res;
  }

  /**
   * #19 (W24) — pick a mic input (CallModal mic picker). The choice is
   * remembered for the next call (getMedia applies it) AND, when this
   * call already holds a mic track, takes effect live: the track is
   * re-acquired from the new device and swapped into the local stream
   * and the peer sender, so the pick is audible in THIS call, not just
   * the next one. While ringing (no mic track yet) the preference
   * alone is enough — getMedia applies it at accept/dial. A failed
   * live switch keeps the old mic and the call continues; the
   * preference stays set and getMedia's own fallback covers the next
   * call.
   */
  public async setAudioInputDevice(deviceId: string | null): Promise<{ ok: boolean; error?: string }> {
    this.preferredAudioInputId = deviceId;
    this.activeCall.audioInputDeviceId = deviceId;
    if (this.localStream?.getAudioTracks().length) {
      const res = await this.switchLiveMic(deviceId);
      this.emit();
      return res;
    }
    this.emit();
    return { ok: true };
  }

  /**
   * #19 (W24) — swap the live mic track to another input mid-call.
   * Re-acquires audio from the new device, replaces the track on the
   * peer sender (when a peer connection exists) and in the local
   * stream, then stops the old track. Any failure leaves the old mic
   * in place — a mic switch must never kill the call.
   */
  private async switchLiveMic(deviceId: string | null): Promise<{ ok: boolean; error?: string }> {
    const oldTrack = this.localStream?.getAudioTracks()[0];
    if (!oldTrack) return { ok: false, error: 'No microphone track to switch.' };
    const audioBase = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      const stream = await this.gum({
        audio: deviceId ? { ...audioBase, deviceId: { exact: deviceId } } : audioBase,
        video: false,
      });
      const newTrack = stream.getAudioTracks()[0];
      if (!newTrack) {
        stream.getTracks().forEach((t) => t.stop());
        return { ok: false, error: 'The selected microphone produced no audio.' };
      }
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender) {
        try {
          await sender.replaceTrack(newTrack);
        } catch (e) {
          console.warn('[callService] live mic switch: replaceTrack failed, keeping local swap:', e);
        }
      }
      this.localStream?.removeTrack(oldTrack);
      oldTrack.stop();
      this.localStream?.addTrack(newTrack);
      this.activeCall.localStream = this.localStream;
      this.activeCall.audioInputDeviceId = deviceId;
      return { ok: true };
    } catch (err) {
      console.warn('[callService] live mic switch failed:', err);
      return { ok: false, error: err instanceof Error ? err.message : 'Could not switch microphone.' };
    }
  }

  /**
   * #19 (W24) — the mic that belongs to the current output, if one is
   * visible. The old code matched /bluetooth/i on the mic NAME — the
   * same dead test as D2 (#261): real headset mics are named
   * "Pixel Buds Pro", not "Bluetooth …". A headset exposes the SAME
   * label for its input and its output, so match the input label
   * against the current output's name instead. No regex, no kind
   * needed (web inputs are all kind 'unknown').
   */
  private async findHeadsetMic(): Promise<AudioDevice | null> {
    try {
      const inputs = await getWebAudioInputs();
      const outName = (this.activeCall.currentAudioDevice?.name || '').trim();
      if (!outName) return null;
      return (
        inputs.find((d) => (d.name || '').trim() === outName) ??
        inputs.find((d) => {
          const n = (d.name || '').trim();
          return n.length > 0 && (n.startsWith(outName) || outName.startsWith(n));
        }) ??
        null
      );
    } catch {
      return null;
    }
  }

  // ── Hardware Media Acquisition ──
  // Worker C: the old code let ANY getUserMedia failure kill the whole
  // call with a generic alert(). Two fixes: (1) a video call whose
  // CAMERA fails (missing/broken camera, over-constrained device) now
  // falls back to audio-only and still connects, with the camera shown
  // off — WhatsApp behaviour — instead of failing the call; (2) failures
  // are classified so the ended screen can tell the user what to do
  // (permission → Settings path) instead of "check permission".
  // RETEST-1: getUserMedia can hang forever — observed headless under host
  // pressure, and it happens on real phones with a wedged camera service
  // too. A hung request left the call UI dead with no feedback and
  // `starting` stuck true, blocking every later call until reload. Race
  // it against a 12s timeout so it fails honestly into the ended screen
  // (failDetail) instead. If the real request resolves after we gave up,
  // its tracks are stopped so it can't hold the mic/camera open.
  private async gum(constraints: MediaStreamConstraints, timeoutMs = 12_000): Promise<MediaStream> {
    let timedOut = false;
    const req = navigator.mediaDevices.getUserMedia(constraints);
    void req.then((s) => { if (timedOut) s.getTracks().forEach((t) => t.stop()); }).catch((err) => console.warn("[callService] stopRinging: stop(...) failed", err));
    let timer: any;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const e: any = new Error('Media request timed out');
        e.name = 'AbortError';
        reject(e);
      }, timeoutMs);
    });
    try {
      return await Promise.race([req, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async getMedia(type: CallType, facingMode: 'user' | 'environment'): Promise<MediaStream> {
    this.videoCaptureFailed = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      const e: any = new Error('Media devices unavailable');
      e.code = 'unavailable';
      throw e;
    }
    // Report 3 #19 — mic-input selection. On native Android the mic
    // follows the communication device automatically (a Bluetooth
    // headset's mic is used once the headset is the routed device), so
    // no deviceId is needed there. On the web the mic must be picked
    // explicitly: an explicitly chosen input wins, otherwise the mic
    // matching the current output's name is preferred (re-acquired
    // below, once labels exist).
    const audioBase = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    const audioConstraints: MediaTrackConstraints = this.preferredAudioInputId
      ? { ...audioBase, deviceId: { exact: this.preferredAudioInputId } }
      : audioBase;
    this.activeCall.audioInputDeviceId = this.preferredAudioInputId;
    const constraints: MediaStreamConstraints = {
      audio: audioConstraints,
      video: type === 'video' ? {
        facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      } : false,
    };

    let stream: MediaStream;
    try {
      stream = await this.gum(constraints);
    } catch (err: any) {
      // The explicitly chosen mic is gone (unplugged headset): retry
      // once on the default mic instead of killing the call.
      // `failure` tracks the error to surface: the fallback error when
      // the retry also fails, else the original (no-ex-assign forbids
      // reassigning the catch parameter itself).
      let failure: any = err;
      if (this.preferredAudioInputId
        && (failure?.name === 'NotFoundError' || failure?.name === 'OverconstrainedError')) {
        console.warn('Call: chosen microphone unavailable, falling back to the default mic');
        this.activeCall.audioInputDeviceId = null;
        try {
          return await this.gum({ audio: audioBase, video: constraints.video });
        } catch (e2: any) {
          failure = e2;
        }
      }
      // Permission denied covers mic+camera: retrying audio-only would
      // fail the same way, so surface it immediately.
      if (failure?.name === 'NotAllowedError' || failure?.name === 'SecurityError') throw failure;
      if (type === 'video' && (failure?.name === 'NotFoundError' || failure?.name === 'OverconstrainedError' || failure?.name === 'NotReadableError')) {
        const audioOnly = await this.gum({ audio: constraints.audio, video: false });
        this.videoCaptureFailed = true;
        console.warn('Call: camera unavailable, continuing as audio-only:', failure?.name);
        return audioOnly;
      }
      throw failure;
    }

    // Web only: labels are empty until mic permission is granted, so a
    // headset mic can only be found AFTER the first capture. If one
    // is now visible and we are not already on it, re-acquire the mic
    // from it (same video constraints) so the headset mic is actually
    // used — otherwise the call would use the phone mic while the
    // headset plays the audio.
    if (!Capacitor.isNativePlatform() && !this.preferredAudioInputId) {
      const btMic = await this.findHeadsetMic();
      const currentId = stream.getAudioTracks()[0]?.getSettings?.().deviceId;
      if (btMic && currentId !== btMic.id) {
        try {
          const btStream = await this.gum({
            audio: { ...audioBase, deviceId: { exact: btMic.id } },
            video: constraints.video,
          });
          stream.getTracks().forEach((t) => t.stop());
          stream = btStream;
          this.activeCall.audioInputDeviceId = btMic.id;
          console.warn('Call: using headset microphone:', btMic.name || btMic.id);
        } catch (e) {
          console.warn('Call: headset microphone re-acquire failed, keeping the default mic:', e);
        }
      }
    }
    return stream;
  }

  /**
   * Report 3 #114 (P0-6) + #126 — mic-first, camera best-effort media.
   *
   * The old startCall/accept paths called getMedia(type) once, which
   * requests camera+mic together for video: a denied/missing/wedged
   * camera threw NotAllowedError BEFORE the `callsig` doc was written,
   * so the callee got literally nothing — no ring, no banner, no
   * missed call — and on accept the same failure killed a call the
   * callee had already answered. The microphone is the essential leg:
   * if it fails, the call fails honestly with a permission message.
   * The camera is best-effort: any failure (denied, missing, wedged —
   * capped at 6 s so a hung camera service cannot stall the dial)
   * continues the call audio-only with videoCaptureFailed set, and the
   * UI shows the camera off — WhatsApp behaviour — instead of killing
   * a call that does not exist yet.
   */
  private async getCallMedia(type: CallType, facingMode: 'user' | 'environment'): Promise<MediaStream> {
    this.videoCaptureFailed = false;
    const stream = await this.getMedia('audio', facingMode);
    if (type === 'audio') return stream;
    try {
      const videoOnly = await this.gum(
        {
          video: {
            facingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        6_000,
      );
      videoOnly.getVideoTracks().forEach((t) => stream.addTrack(t));
      return stream;
    } catch (err: any) {
      this.videoCaptureFailed = true;
      console.warn('Call: camera unavailable, continuing as audio-only:', err?.name || err);
      this.recordDiag('camera-unavailable', `video call continuing audio-only (${err?.name || 'unknown error'})`);
      return stream;
    }
  }

  /** User-facing text for a getUserMedia failure (no alert() — see endCall/callError). */
  private mediaErrorMessage(err: any): string {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone/camera permission denied. Allow it in Settings → Apps → Pinglo → Permissions, then try again.';
    }
    if (name === 'NotFoundError') {
      return 'No microphone or camera was found on this device.';
    }
    if (name === 'NotReadableError') {
      return 'The microphone/camera is busy in another app. Close it and try again.';
    }
    if (name === 'OverconstrainedError') {
      return "This device's camera can't meet the call requirements. Try a voice call instead.";
    }
    if (name === 'AbortError' && /timed out/i.test(err?.message || '')) {
      return 'Microphone/camera took too long to respond. Try again.';
    }
    return "Couldn't access the microphone/camera. Check permissions and try again.";
  }

  // ── Peer connection helpers ──
  private createPeer(): RTCPeerConnection {
    // Report 3 #100 — a new peer connection starts with no remote video
    // state; drop the previous call's track listeners with it.
    this.detachRemoteVideoTrack();
    this.activeCall.remoteVideoEnabled = false;
    // WA audit #41 — "Protect IP address in calls": relay-only ICE
    // (TURN) when the user switched it on in Settings → Calls. The
    // TURN servers come from ensureTurnServers (same as always); with
    // no relay available a relay-only call fails at ICE instead of
    // leaking a host candidate — that is the point of the toggle.
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(getCallPrefs().protectIpAddress ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
    });
    this.pc = pc;

    pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.remoteStream = stream;
      this.activeCall.remoteStream = stream;
      // Report 3 #100 — a video track arriving (or going mute/ended)
      // is what tells the UI whether the remote side has a live picture.
      this.refreshRemoteVideoState(stream);
      this.emit();
    };

    // #8 — record which candidate types were actually gathered: a call
    // that only ever gathered host candidates never had a relay path,
    // which is the single most useful fact in a connect failure.
    pc.onicecandidate = (e) => {
      if (this.pc !== pc || !e.candidate) return;
      const c = e.candidate.candidate || '';
      if (c.includes(' typ relay ')) {
        if (!this.diagRelayCandidate) this.recordDiag('ice-candidate-relay', 'relay candidate gathered');
        this.diagRelayCandidate = true;
      } else if (c.includes(' typ srflx ')) {
        if (!this.diagSrflxCandidate) this.recordDiag('ice-candidate-srflx', 'server-reflexive candidate gathered');
        this.diagSrflxCandidate = true;
      } else if (c.includes(' typ host ')) {
        if (!this.diagHostCandidate) this.recordDiag('ice-candidate-host', 'host candidate gathered');
        this.diagHostCandidate = true;
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this.diagIceState = pc.iceConnectionState;
      this.recordDiag(`ice-state:${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const st = pc.connectionState;
      this.recordDiag(`connection-state:${st}`);
      if (st === 'connected') {
        this.reconnectAttempted = false;
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
        clearTimeout(this.dropTimer);
        this.dropTimer = null;
        this.setConnectionQuality('good');
        // WA audit #7 — grade the live call from getStats (see
        // startQualitySampler), on the same 2 s cadence as the
        // frozen-video check.
        this.startQualitySampler();
        if (this.activeCall.status !== 'connected') {
          this.stopRinging();
          this.activeCall.status = 'connected';
          // Report 3 #114 — reconcile a camera re-enabled mid-ring: if
          // the callee answered the pre-video offer, the video m-line
          // was never negotiated and the peer would never receive video.
          void this.reconcileVideoOnConnect();
          // Report 3 #11 — routing already started at dial/accept; this
          // only refreshes the device list (idempotent). The old code
          // called audioRouteStart() here and pinned the earpiece.
          void this.ensureAudioRoute();
          this.startDurationTimer();
          this.emit();
        }
      } else if (st === 'connecting') {
        // Transient: only downgrade the quality, don't end the call.
        this.setConnectionQuality('poor');
      } else if (st === 'disconnected') {
        // Worker C: the old code called pc.restartIce() here. In this
        // non-trickle design that is a no-op — new candidates are only
        // delivered to the peer via a fresh offer/answer, which nothing
        // ever sent, so the "reconnect" could never work. The truth is
        // simpler: a transient blip recovers on its own (ICE checks
        // resume on the existing candidates when the network returns),
        // and a real drop does not. So wait up to DROP_TIMEOUT_MS for
        // the ICE layer to recover, then end honestly instead of
        // showing "Reconnecting…" forever.
        this.setConnectionQuality('reconnecting');
        if (!this.dropTimer) {
          this.dropTimer = setTimeout(() => {
            void (async () => {
              this.dropTimer = null;
              if (this.pc === pc && pc.connectionState === 'disconnected') {
                // #7: a dropped-but-once-connected call gets an ICE
                // restart attempt before it is ended honestly.
                if (await this.tryIceRestart('disconnected')) return;
                console.warn('Call dropped — peer connection stayed disconnected');
                this.endReason = 'failed';
                this.setFail('call-dropped', ERR_CALL_DROPPED);
                this.endCall(true);
              }
            })();
          }, DROP_TIMEOUT_MS);
        }
      } else if (st === 'failed') {
        // #7: 'failed' used to end the call immediately. Try a bounded
        // ICE restart first — the network may have recovered, or the
        // first candidate pair may simply have been the wrong one.
        void (async () => {
          if (await this.tryIceRestart('connection-failed')) return;
          console.warn('Peer connection failed - ending call');
          this.endReason = 'failed';
          // #4: fast ICE failure is a different step from the 25 s
          // timeout — it gets its own message and step id.
          this.setFail('ice-failed', ERR_ICE_FAILED);
          this.endCall(true);
        })();
      }
    };

    return pc;
  }

  /**
   * Report 3 #100 — remote-video-off detection. The remote video track
   * fires 'mute' when the other side turns their camera off (their
   * client sets the track disabled, which stops frames arriving here)
   * and 'ended' when it goes away; no video track at all means the
   * remote side is audio-only (camera failed / no camera). Any of those
   * sets remoteVideoEnabled=false so the UI shows their avatar + name
   * instead of a black/frozen full-screen video. 'unmute' brings the
   * picture back. Recomputed on every ontrack (audio can arrive before
   * video) and only emits when the value actually changes.
   */
  private onRemoteVideoTrackState = () => {
    if (this.remoteStream) this.refreshRemoteVideoState(this.remoteStream);
  };

  private refreshRemoteVideoState(stream: MediaStream) {
    const track = stream.getVideoTracks()[0] ?? null;
    if (track !== this.remoteVideoTrack) {
      this.detachRemoteVideoTrack();
      this.remoteVideoTrack = track;
      if (track) {
        track.addEventListener('mute', this.onRemoteVideoTrackState);
        track.addEventListener('unmute', this.onRemoteVideoTrackState);
        track.addEventListener('ended', this.onRemoteVideoTrackState);
      }
    }
    const live = !!track && track.readyState === 'live' && !track.muted;
    if (this.activeCall.remoteVideoEnabled !== live) {
      this.activeCall.remoteVideoEnabled = live;
      this.emit();
    }
  }

  private detachRemoteVideoTrack() {
    if (this.remoteVideoTrack) {
      this.remoteVideoTrack.removeEventListener('mute', this.onRemoteVideoTrackState);
      this.remoteVideoTrack.removeEventListener('unmute', this.onRemoteVideoTrackState);
      this.remoteVideoTrack.removeEventListener('ended', this.onRemoteVideoTrackState);
      this.remoteVideoTrack = null;
    }
  }

  // Non-trickle ICE: resolve once candidate gathering is complete (or after a short timeout)
  private waitForIce(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let timer: any = null;
      const finish = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        if (timer) clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      timer = setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  // ── W24 stale-`ringing` sweeper ────────────────────────────────────
  /** Load the persisted first-sight map (best-effort; a missing/corrupt entry just means the ghost may ring once more). */
  private loadRingingFirstSeen(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(RINGING_FIRST_SEEN_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { at?: number; historyRecorded?: boolean }>;
      if (!parsed || typeof parsed !== 'object') return;
      const now = Date.now();
      for (const [id, v] of Object.entries(parsed)) {
        if (!v || typeof v.at !== 'number') continue;
        if (now - v.at > RINGING_FIRST_SEEN_TTL_MS) continue;
        if (!this.ringingFirstSeen.has(id)) {
          this.ringingFirstSeen.set(id, { at: v.at, historyRecorded: v.historyRecorded === true });
        }
      }
      // Bound the map: drop the oldest entries past the cap.
      if (this.ringingFirstSeen.size > RINGING_FIRST_SEEN_MAX) {
        const sorted = Array.from(this.ringingFirstSeen.entries()).sort((a, b) => a[1].at - b[1].at);
        for (let i = 0; i < sorted.length - RINGING_FIRST_SEEN_MAX; i++) {
          this.ringingFirstSeen.delete(sorted[i][0]);
        }
      }
    } catch (err) {
      console.warn('[callService] stale ringing sweeper: could not read first-seen map', err);
    }
  }

  /** Persist the first-sight map (best-effort; entries past the TTL are dropped from storage, not from memory). */
  private saveRingingFirstSeen(): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const now = Date.now();
      const out: Record<string, { at: number; historyRecorded: boolean }> = {};
      this.ringingFirstSeen.forEach((v, id) => {
        if (now - v.at <= RINGING_FIRST_SEEN_TTL_MS) out[id] = v;
      });
      localStorage.setItem(RINGING_FIRST_SEEN_KEY, JSON.stringify(out));
    } catch (err) {
      console.warn('[callService] stale ringing sweeper: could not persist first-seen map', err);
    }
  }

  /** Record first sight of a `ringing` doc addressed to us (once per doc id). */
  private noteRingingFirstSeen(id: string): void {
    if (this.ringingFirstSeen.has(id)) return;
    this.ringingFirstSeen.set(id, { at: Date.now(), historyRecorded: false });
    if (this.ringingFirstSeen.size > RINGING_FIRST_SEEN_MAX) {
      let oldestId: string | null = null;
      let oldestAt = Infinity;
      this.ringingFirstSeen.forEach((v, k) => {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestId = k;
        }
      });
      if (oldestId !== null) this.ringingFirstSeen.delete(oldestId);
    }
    this.saveRingingFirstSeen();
  }

  /**
   * W24 — mark a signal doc as "a call-history record was already
   * written for it". The in-memory seenMissed/seenIncoming sets do not
   * survive a reload, so without this a doc re-delivered after reload
   * records the same missed/declined call a second time (found by the
   * W24 sweep probe: one missed call became 3 records). The mark is
   * optimistic — the write itself is best-effort, same as the
   * in-memory sets W3 used — and only ever suppresses a DUPLICATE
   * record for the same signal id, never a first one.
   */
  private markRingingHistoryRecorded(id: string): void {
    const entry = this.ringingFirstSeen.get(id);
    if (!entry || entry.historyRecorded) return;
    entry.historyRecorded = true;
    this.saveRingingFirstSeen();
  }

  /**
   * Is this `ringing` doc a ghost? True only when this device first saw
   * it >= STALE_RINGING_GHOST_MS ago — elapsed real time on the callee's
   * own clock, so caller clock skew cannot fake it (see the constant
   * comment). Our own active call, a parked waiting call and a carried
   * promote are never ghosts.
   */
  private isGhostRinging(id: string): boolean {
    if (id === this.callId) return false;
    if (this.waiting?.signalId === id || this.pendingPromote?.signalId === id) return false;
    const entry = this.ringingFirstSeen.get(id);
    if (!entry) return false;
    return Date.now() - entry.at >= STALE_RINGING_GHOST_MS;
  }

  /**
   * Expire one ghost `ringing` doc: delete it so it can never re-ring or
   * park anyone as busy again, and record the missed call ONCE (skipped
   * when this session already saw it ring — the normal ring-timeout /
   * endCall path owns that record then — or when a previous session
   * already recorded it). Best-effort throughout: a failed delete or
   * record never affects any live call.
   */
  private expireGhostRinging(id: string, s: any): void {
    const entry = this.ringingFirstSeen.get(id);
    if (!entry) return;
    console.warn(
      `[callService] stale ringing sweeper: expiring ghost ringing doc ${id} (first seen ${Math.round((Date.now() - entry.at) / 1000)}s ago — past the caller's ${RING_TIMEOUT_MS / 1000}s ring timeout)`,
    );
    if (!this.seenMissed.has(id) && !this.seenIncoming.has(id) && !entry.historyRecorded && id !== this.callId) {
      this.seenMissed.add(id);
      entry.historyRecorded = true;
      this.saveRingingFirstSeen();
      this.recordCalleeCall(s, 'missed', 0, id);
    }
    this.recordDiag('stale-ringing-swept', `ghost ringing doc ${id} expired after ${Math.round((Date.now() - entry.at) / 1000)}s`);
    deleteDoc(doc(db, SIG_COL, id) as any).catch((err) =>
      console.warn('[callService] stale ringing sweeper: deleteDoc failed', err),
    );
    this.lastRingingDocs.delete(id);
  }

  /**
   * Periodic sweep: re-check the `ringing` docs this session has seen.
   * A ghost produces no further snapshot (nobody touches the doc), so
   * the snapshot path alone never revisits it — the timer expires it
   * STALE_RINGING_GHOST_MS after first sight even if the app stays open
   * and nothing else changes. Docs that ring normally are ended by
   * their own ring timeout long before this fires; the timer is the
   * backstop for offer-less / DND-silenced / otherwise un-ringable docs.
   */
  private startStaleRingingSweep(): void {
    this.stopStaleRingingSweep();
    if (typeof window === 'undefined') return;
    this.sweepTimer = setInterval(() => {
      try {
        this.lastRingingDocs.forEach((s, id) => {
          if (this.isGhostRinging(id)) this.expireGhostRinging(id, s);
        });
      } catch (err) {
        console.warn('[callService] stale ringing sweep failed:', err);
      }
    }, STALE_RINGING_SWEEP_MS);
  }

  private stopStaleRingingSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ── Signalling (AWS `callsig` collection) ──
  private onSignalSnapshot(uid: string, snap: any) {
    const now = Date.now();
    for (const d of snap?.docs || []) {
      const id: string = d.id;
      const s: any = typeof d.data === 'function' ? d.data() : null;
      if (!id || !s) continue;

      // Report 3 #113 (C5) + #125 — clock skew is ONE-SIDED now.
      // `age` is positive when the doc is genuinely old. The old code
      // used |now - createdAt|, so a caller whose clock runs a few
      // minutes FAST had live calls dropped AND recorded as missed
      // (the call vanished without a trace, and the callee got a missed
      // record for a call that was still ringing). Now: only a doc
      // that is genuinely OLD (>=300 s past) is dropped, recorded as
      // missed once, and deleted if still `ringing`. A future-dated
      // doc is a live call from a fast-clock caller — it rings (the
      // ringing branch below accepts up to 1 h into the future; beyond
      // that the clock is broken, not fast, and the doc is ignored).
      // A `ringing` doc with NO createdAt at all can never ring (the
      // ringing branch needs a timestamp) and can never be recovered —
      // startCall always writes createdAt, so it is dead weight: delete
      // it so it can never ghost-ring or park the callee as busy.
      const sigAge = s.createdAt ? now - Number(s.createdAt) : Number.POSITIVE_INFINITY;
      if (s.calleeId === uid && s.status === 'ringing' && !s.createdAt) {
        console.warn(`Ignoring call signal ${id} (ringing): no createdAt — deleting dead doc`);
        deleteDoc(doc(db, SIG_COL, id) as any).catch((err) =>
          console.warn('[callService] stale ringing cleanup: deleteDoc failed', err),
        );
      }
      if (
        s.calleeId === uid &&
        (s.status === 'ringing' || s.status === 'ended') &&
        s.createdAt &&
        sigAge >= INCOMING_MAX_SKEW_MS
      ) {
        console.warn(
          `Ignoring call signal ${id} (${s.status}): timestamp skew ${Math.round(sigAge / 1000)}s exceeds the ${INCOMING_MAX_SKEW_MS / 1000}s window — caller/callee clock differs.`,
        );
        // W24: also skip when a previous session already recorded this
        // signal (persisted mark — the in-memory sets above do not
        // survive a reload, and this branch re-fires on re-delivery).
        if (!this.seenMissed.has(id) && !this.seenIncoming.has(id) && id !== this.callId && !this.ringingFirstSeen.get(id)?.historyRecorded) {
          this.seenMissed.add(id);
          this.recordCalleeCall(s, 'missed', 0, id);
          this.recordDiag('stale-signal-cleaned', `${s.status} doc ${id} skew ${Math.round((now - Number(s.createdAt)) / 1000)}s — missed call recorded`);
        }
        if (s.status === 'ringing') {
          deleteDoc(doc(db, SIG_COL, id) as any).catch((err) =>
            console.warn('[callService] stale ringing cleanup: deleteDoc failed', err),
          );
        }
      }

      // W24 stale-`ringing` sweeper — first-sight bookkeeping + ghost
      // expiry, BEFORE the ring branch: a ghost re-delivered on reload
      // must expire here, not ring again and park the callee as busy.
      // First sight is recorded for every `ringing` doc addressed to
      // us (offer or not — an offer-less doc is even more likely a
      // crashed-caller leftover); the cache feeds the periodic sweep.
      // Docs already past the 300 s window are W3's branch above, not
      // this one — except a doc with no createdAt at all, which W3's
      // branch cannot judge and this one can (firstSeen needs no stamp).
      if (
        s.calleeId === uid &&
        s.status === 'ringing' &&
        (!s.createdAt || Math.abs(now - Number(s.createdAt)) < INCOMING_MAX_SKEW_MS)
      ) {
        this.noteRingingFirstSeen(id);
        this.lastRingingDocs.set(id, s);
        if (this.isGhostRinging(id)) {
          this.expireGhostRinging(id, s);
          continue;
        }
      } else if (s.status !== 'ringing') {
        this.lastRingingDocs.delete(id);
      }

      // Report 3 #114 — refresh the pending offer while the call is
      // still unanswered: the caller may re-enable their camera mid-ring,
      // which rewrites the ringing offer with the video m-line in it.
      // Accept uses pendingOffer, snapshotted at ring time — without this
      // the accept would use the stale audio-only offer and the video
      // would never flow.
      if (
        s.calleeId === uid &&
        s.status === 'ringing' &&
        id === this.callId &&
        this.role === 'callee' &&
        !this.pc &&
        s.offer &&
        s.offer !== this.pendingOffer
      ) {
        this.pendingOffer = s.offer;
        // 100M-H9 — the caller upgraded to video mid-ring (rewrote the
        // ringing offer with a video m-line). The incoming screen must
        // say "Incoming video call" and Accept must acquire the camera,
        // so flip the type now, before the user answers.
        if (s.offer.includes('m=video') && this.activeCall.type === 'audio') {
          this.activeCall.type = 'video';
          this.activeCall.isVideoEnabled = true;
          this.activeCall.isAudioOnly = false;
          this.emit();
        }
      }

      // #113 (C5): a live call from a fast-clock caller rings. Past
      // side unchanged (<300 s old); future side accepted up to 1 h
      // ahead (a phone minutes fast), never beyond (broken clock).
      if (
        s.calleeId === uid &&
        s.status === 'ringing' &&
        s.offer &&
        !this.seenIncoming.has(id) &&
        s.createdAt &&
        sigAge < INCOMING_MAX_SKEW_MS &&
        sigAge > -3_600_000
      ) {
        this.seenIncoming.add(id);
        if (this.seenIncoming.size > 100) this.seenIncoming.clear();
        this.handleIncomingSignal(id, s);
      }

      // Worker C — missed-call recovery: the callee only gets a missed
      // record when it actually SAW the ringing doc. If the subscription
      // was dead for the whole 45 s ring (backgrounded app, dead socket)
      // and only recovers in time to see the caller's `ended` write
      // (the doc lives 60 s past endCall), record the missed call now —
      // once — instead of the call vanishing without a trace. Docs the
      // callee did see are in seenIncoming and skip this branch, so a
      // normal decline/miss is never double-recorded. W24: the
      // persisted mark covers the reload case too — a doc whose miss
      // was already recorded by the ring-timeout/endCall path in a
      // previous session must not record a second time here.
      // #113 (C5): same one-sided window as the ringing branch — an
      // `ended` write from a fast-clock caller still recovers the
      // missed call instead of vanishing.
      if (
        s.calleeId === uid &&
        s.status === 'ended' &&
        !this.seenIncoming.has(id) &&
        !this.seenMissed.has(id) &&
        id !== this.callId &&
        !this.ringingFirstSeen.get(id)?.historyRecorded &&
        s.createdAt &&
        sigAge < INCOMING_MAX_SKEW_MS &&
        sigAge > -3_600_000
      ) {
        this.seenMissed.add(id);
        this.recordCalleeCall(s, 'missed', 0, id);
      }

      // ROADMAP-2 #13: a parked waiting call the caller hangs up on is
      // cleared (recorded once as missed) instead of lingering on screen
      // until its timer fires. Same for a call carried past endCall
      // (pendingPromote) — no ringing a dead call.
      if (
        (this.waiting?.signalId === id || this.pendingPromote?.signalId === id) &&
        (s.status === 'ended' || s.status === 'declined')
      ) {
        const parked = this.waiting;
        this.waiting = null;
        this.pendingPromote = null;
        this.clearWaitingTimeout();
        if (parked) {
          this.activeCall.waitingCall = null;
          this.recordCalleeCall(
            { callerId: parked.remoteUserId, callerName: parked.remoteName, callerAvatar: parked.remoteAvatar, type: parked.type },
            'missed',
            0,
            parked.signalId,
          );
          this.emit();
        }
      }

      // H2 — reload restore: a still-ringing outgoing call of MINE,
      // seen while I have no live call (fresh boot after a reload, or
      // any full document navigation such as a cross-document back),
      // is resumed so the reload does not silently kill the ring. Only
      // unanswered `ringing` docs qualify: a doc that already carries
      // an answer was connected before the reload, and re-dialling it
      // would corrupt the live call. `callerId` is '' in mock/offline
      // mode (auth.currentUser is null there) — in that mode the local
      // app is the only signal writer, so an empty callerId plus a
      // callee that is not me is still mine. One attempt per doc per
      // session (restoreAttemptedIds); the resume itself is async and
      // guarded by `restoringCall`.
      if (
        s.status === 'ringing' &&
        !s.answer &&
        (s.callerId === uid || s.callerId === '' || s.callerId == null) &&
        s.calleeId && s.calleeId !== uid &&
        !this.callId &&
        this.activeCall.status === 'idle' &&
        !this.restoringCall &&
        !this.restoreAttemptedIds.has(id)
      ) {
        this.restoreAttemptedIds.add(id);
        void this.resumeOutgoingCall(id, s, uid);
      }

      if (this.callId && id === this.callId) {
        this.onOwnSignal(s);
      }
    }
  }

  // Updates to the call we are currently part of
  private onOwnSignal(s: any) {
    // WA audit #27 — a reaction the other side sent on this call.
    // Each reaction is its own `reaction_<id>` field on the signal
    // doc (see sendCallReaction); a `reactions` array is accepted
    // too, for forward-compat with any client that writes one.
    // Accepted whenever the call is live (callId set — guaranteed by
    // the subscription guard that routes snapshots here — and status
    // not idle/ended), NOT only while connected/connecting. The old
    // gate lost reactions in the connect race: this branch runs
    // BEFORE the answer branch below, so a reaction arriving in the
    // same snapshot as the answer was parsed while local status was
    // still 'outgoing' (caller) and silently dropped — and likewise
    // for any reaction landing while local status still lags the peer
    // ('incoming'/'outgoing'/'ringing'). The peer can only send while
    // connected/connecting, so a reaction on a live callId means the
    // call is live at the peer even if our status has not caught up
    // yet. Runs before the status branches so a reaction arriving on
    // the same snapshot as a hang-up is still accepted into state
    // (CallModal hides floats on the ended screen). Dedupe via
    // seenReactionIds + cap 12 below. Headless note: peer-to-peer
    // delivery of this branch cannot be verified in this VM (no
    // second live client); the write side + local render are proven
    // in the probe, this parse is code-verified and needs a real
    // two-phone check.
    if (this.callId && this.activeCall.status !== 'idle' && this.activeCall.status !== 'ended') {
      const incoming: CallReaction[] = [];
      for (const key of Object.keys(s || {})) {
        if (key.startsWith('reaction_') && s[key] && typeof s[key] === 'object') incoming.push(s[key]);
      }
      if (Array.isArray((s as any)?.reactions)) incoming.push(...(s as any).reactions);
      let added = false;
      for (const r of incoming) {
        if (!r || typeof r.id !== 'string' || !r.id || typeof r.emoji !== 'string') continue;
        if (!(CALL_REACTION_EMOJIS as readonly string[]).includes(r.emoji)) continue;
        if (this.seenReactionIds.has(r.id)) continue;
        this.seenReactionIds.add(r.id);
        if (this.seenReactionIds.size > 200) {
          const first = this.seenReactionIds.values().next().value;
          if (first) this.seenReactionIds.delete(first);
        }
        const list = this.activeCall.callReactions ?? (this.activeCall.callReactions = []);
        list.push({ id: r.id, emoji: r.emoji, from: typeof r.from === 'string' ? r.from : '', at: typeof r.at === 'number' ? r.at : Date.now() });
        while (list.length > 12) list.shift();
        added = true;
      }
      if (added) this.emit();
    }

    // #7 — peer-initiated ICE restart: a `reoffer` on our own doc means
    // the other side restarted ICE and needs a fresh answer from us.
    // Either role can land here (whoever did NOT initiate the restart).
    if (s.status === 'reoffer' && s.offer) {
      void this.handleReoffer(s);
    }

    // #7 — a NEW answer after an ICE restart (re-offer/answer round).
    // The old code only ever applied the first answer (answerApplied
    // guard + have-local-offer state); a restart answer was ignored, so
    // a restart could never complete. Track the last applied SDP so a
    // repeated snapshot delivery does not re-apply the same answer.
    if (this.role === 'caller' && s.answer && s.answer !== this.lastAnswerSdp && this.pc && (this.pc.signalingState === 'have-local-offer' || this.pc.signalingState === 'stable')) {
      this.lastAnswerSdp = s.answer;
      const firstAnswer = !this.answerApplied;
      this.answerApplied = true;
      // Worker C: the callee answered, but ICE may still never connect
      // (relay unreachable, NAT). The old code left the caller in
      // 'outgoing' until the 45 s ring timeout — as 'unanswered'. Bound
      // it with the connect timeout instead, so it ends as 'failed'.
      this.armConnectTimeout();
      this.recordDiag(firstAnswer ? 'answer-applied' : 'restart-answer-applied');
      this.pc.setRemoteDescription({ type: 'answer', sdp: s.answer }).catch((e) => {
        console.warn('Could not apply call answer:', e);
        this.endReason = 'failed';
        // #4: applying the answer is its own step, not a generic
        // "couldn't connect".
        this.setFail('apply-answer', ERR_ANSWER_APPLY);
        this.endCall(true);
      });
    }

    // Report 3 #121 — the callee silenced the call (DND / unknown
    // caller): the old code wrote nothing back, so the caller heard
    // 45 s of dead ringing for a phone that would never answer. The
    // callee now writes status 'silenced' (see handleIncomingSignal);
    // the caller ends fast with the real reason instead of 'unanswered'.
    if (s.status === 'silenced') {
      this.remoteEnded = true;
      this.remoteEndStatus = 'silenced';
      this.endReason = 'unanswered';
      this.setFail(
        'silenced',
        s.silencedReason === 'dnd'
          ? 'This user has Do Not Disturb on — your call was silenced.'
          : 'This user silences calls from unknown numbers — your call was silenced.',
      );
      this.endCall(this.role === 'caller');
      return;
    }

    // WA audit #8 — the call was answered on another device/session
    // (CallLogResult.AcceptedElsewhere → "Answered elsewhere"). The
    // ended screen renders END_REASON_TEXT.acceptedElsewhere; the
    // history row keeps the 'acceptedElsewhere' status (see endCall).
    if (s.status === 'answered-elsewhere') {
      this.remoteEnded = true;
      this.remoteEndStatus = 'answered-elsewhere';
      this.endReason = 'acceptedElsewhere';
      this.endCall(this.role === 'caller');
      return;
    }

    // WA audit #9 — the callee has me blocked: they never rang, and
    // the block must NOT leak to the caller. End as plain 'unanswered'
    // (no failDetail, no busy/declined text) — exactly what the caller
    // would see if the phone had simply never picked up.
    if (s.status === 'blocked') {
      this.remoteEnded = true;
      this.remoteEndStatus = 'blocked';
      this.endReason = 'unanswered';
      this.endCall(this.role === 'caller');
      return;
    }

    // Report 3 #126 — the callee tapped Accept and then the call died
    // (e.g. their microphone was denied): the old code left the caller
    // staring at 'ended'/'cancelled' with no reason. The callee now
    // writes status 'failed' + failReason (see acceptCallWith); the
    // caller ends as 'failed' with the callee's reason on screen.
    if (s.status === 'failed' && this.role === 'caller') {
      this.remoteEnded = true;
      this.remoteEndStatus = 'failed';
      this.endReason = 'failed';
      this.setFail(
        'answer-media',
        typeof s.failReason === 'string' && s.failReason
          ? s.failReason
          : "The other side couldn't answer — their microphone/camera was unavailable.",
      );
      this.endCall(true);
      return;
    }

    if (s.status === 'busy') {
      this.remoteEnded = true;
      this.remoteEndStatus = 'busy';
      this.endReason = 'busy';
      // Worker C: was a blocking alert() — it froze the UI while the
      // call was tearing down, and on Android WebView it is a native
      // dialog over the call screen. The reason is now shown on the
      // ended screen (callError) with a Call Back button.
      // #4: 'busy' is its own step, not a connect failure.
      this.failedStep = 'busy';
      this.failDetail = 'This user is busy on another call right now.';
      this.endCall(true);
      return;
    }

    if (s.status === 'ended' || s.status === 'declined') {
      this.remoteEnded = true;
      this.remoteEndStatus = s.status;
      this.endReason = s.status === 'declined' ? 'declined' : 'cancelled';
      this.endCall(this.role === 'caller');
    }
  }

  // ── Outgoing Call ──

  /**
   * H2 — resume a still-ringing OUTGOING call after a full document
   * navigation (reload, or a cross-document back). In-app route
   * changes (Back / history.back()) already survive: CallModal is
   * mounted at App level outside <Routes> and the service is a
   * singleton, so nothing unmounts. A reload is different — the whole
   * JS context is gone (peer connection, media, activeCall), and on a
   * fresh boot callId is null, so onOwnSignal never fires for my own
   * doc and nothing restores the UI. The signal doc is the source of
   * truth: it survives the reload because the unload guard never
   * writes `ended` for an outgoing call, and it still says `ringing`.
   *
   * The resume re-runs the outgoing setup with the SAME doc id —
   * fresh media + TURN + peer + offer — and rewrites the offer on the
   * doc (the same two patterns the codebase already uses:
   * rewriteRingingOffer while unanswered, the `reoffer` path if the
   * callee answered mid-resume). The doc's ORIGINAL createdAt is
   * preserved and the ring timeout is re-armed with the REMAINING
   * time, so the 45 s ring window does not extend. No second history
   * row is written: the original dial's row is adopted as callDocId
   * when found, so ending the resumed call finalises it.
   *
   * Only unanswered `ringing` docs are resumed. A doc that already
   * carries an answer was CONNECTED before the reload, and
   * re-dialling it would corrupt the live call — that case is left
   * alone (known limit). If the resume itself fails (mic denied,
   * TURN/ICE failure), the call ends honestly so the callee gets an
   * `ended` signal instead of ringing to the timeout.
   */
  private async resumeOutgoingCall(id: string, s: any, uid: string): Promise<void> {
    if (this.restoringCall || this.callId || this.activeCall.status !== 'idle') return;
    const createdAt = Number(s.createdAt) || 0;
    const age = Date.now() - createdAt;
    // Stale (ring window already over) or clock-skewed docs are not
    // resumed — the callee's own ring timeout will end them.
    if (!createdAt || age < 0 || age >= RING_TIMEOUT_MS) return;
    const remaining = RING_TIMEOUT_MS - age;
    this.restoringCall = true;
    this.starting = true;
    this.resetDiagnostics('caller');
    const callId = id;
    try {
      this.ensureUnloadGuard();
      this.role = 'caller';
      this.callId = callId;
      this.answerApplied = false;
      this.remoteEnded = false;
      this.endReason = 'cancelled';
      this.failDetail = null;
      this.reconnectAttempted = false;
      const type: CallType = s.type === 'video' ? 'video' : 'audio';
      // The signal doc carries no callee name. Resolve it from the users
      // collection, falling back to the history row the original dial
      // wrote (it carries receiverName/receiverAvatar). Both collections
      // may still be loading at boot, so the lookups are re-run after
      // the media/ICE rebuild below and anything missing is patched.
      const historyDoc = this.findOutgoingHistoryDoc(uid, s.calleeId, createdAt);
      this.callDocId = historyDoc?.id || null;
      const peer = this.lookupUser(s.calleeId);
      this.activeCall = {
        status: 'outgoing',
        type,
        remoteUserId: s.calleeId,
        remoteName: peer?.displayName || peer?.username || historyDoc?.receiverName || 'User',
        remoteAvatar: peer?.photoURL || historyDoc?.receiverAvatar || '',
        isIncoming: false,
        duration: 0,
        localStream: null,
        remoteStream: null,
        isMuted: false,
        isVideoEnabled: type === 'video',
        facingMode: 'user',
        isSpeaker: false,
        isScreenSharing: false,
        connectionQuality: 'unknown',
        callError: null,
        failedStep: null,
        callDiagnostics: null,
        waitingCall: null,
        isDndOn: getCallPrefs().doNotDisturb,
      };
      this.emit();
      const stream = await this.getCallMedia(type, 'user');
      await this.ensureTurnServers();
      this.ensureOfflineListener();
      this.activeCall = {
        ...this.activeCall,
        localStream: stream,
        isVideoEnabled: type === 'video' && !this.videoCaptureFailed,
        isAudioOnly: type === 'video' && this.videoCaptureFailed,
        screenStream: null,
        remoteVideoEnabled: false,
        videoNotice: null,
      };
      this.localStream = stream;
      this.emit();
      await this.ensureAudioRoute();
      this.startRinging(false);
      // Re-arm with the REMAINING ring time (min 5 s so the resume
      // itself gets a chance to finish before the timeout fires).
      this.armRingTimeout(Math.max(5_000, remaining));
      this.startSignalHealthCheck();
      const pc = this.createPeer();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIce(pc);
      if (this.callId !== callId || this.pc !== pc) return;
      // The users/calls collections may still have been loading when
      // the resume started — re-run the lookups now (seconds later)
      // and patch anything that was missing, so the restored call
      // shows the peer's real name and ends against the original
      // history row instead of writing a second one.
      if (!this.callDocId) {
        const hd = this.findOutgoingHistoryDoc(uid, s.calleeId, createdAt);
        if (hd) this.callDocId = hd.id;
      }
      if (this.activeCall.remoteName === 'User' || !this.activeCall.remoteAvatar) {
        const p2 = this.lookupUser(s.calleeId);
        const hd2 = this.findOutgoingHistoryDoc(uid, s.calleeId, createdAt);
        const name = p2?.displayName || p2?.username || hd2?.receiverName;
        const av = p2?.photoURL || hd2?.receiverAvatar;
        if (name || av) {
          if (name) this.activeCall.remoteName = name;
          if (av) this.activeCall.remoteAvatar = av;
          this.emit();
        }
      }
      // Re-read the doc: if the callee answered while we rebuilt, keep
      // their answer and send the new offer as a `reoffer` (the
      // callee's ICE-restart path answers it). Otherwise a plain offer
      // refresh — status stays `ringing`, exactly like
      // rewriteRingingOffer. The stale answer must not be applied to
      // the new pc, so it is recorded as already-seen first.
      const current = this.readSignalDoc(id);
      const hasAnswer = !!current?.answer;
      if (hasAnswer) this.lastAnswerSdp = current.answer;
      await updateDoc(doc(db, SIG_COL, callId) as any, {
        offer: pc.localDescription?.sdp || '',
        ...(hasAnswer
          ? { status: 'reoffer', reofferBy: 'caller', reofferAt: Date.now() }
          : {}),
      });
      this.recordDiag(
        'call-resumed-after-reload',
        `outgoing ${type} to ${s.calleeId} resumed, ${Math.round(remaining / 1000)}s ring left${hasAnswer ? ' (callee answered mid-resume — reoffer sent)' : ''}`,
      );
      console.warn(`[callService] resumed outgoing call ${callId} after reload (${Math.round(remaining / 1000)}s ring left)`);
    } catch (err) {
      console.warn('[callService] resumeOutgoingCall failed, ending call:', err);
      // The ring is not recoverable — end it honestly so the callee
      // gets an `ended` signal instead of ringing to the timeout.
      if (this.callId === callId) {
        this.endReason = 'failed';
        this.setFail('resume-failed', 'Could not resume the call after the page reloaded.');
        this.endCall(true);
      }
    } finally {
      this.starting = false;
      this.restoringCall = false;
    }
  }

  /** Read one signal doc from the local collection (best-effort). */
  private readSignalDoc(id: string): any | null {
    try {
      const docs = (db as any)?.getCollectionDocs?.('callsig');
      if (Array.isArray(docs)) return docs.find((d: any) => d?.id === id) || null;
    } catch { /* fall through */ }
    return null;
  }

  /** Look up a user's display name/avatar from the local users collection (best-effort). */
  private lookupUser(userId: string): { displayName?: string; username?: string; photoURL?: string } | null {
    try {
      const docs = (db as any)?.getCollectionDocs?.('users');
      if (Array.isArray(docs)) return docs.find((d: any) => d?.id === userId) || null;
    } catch { /* fall through */ }
    return null;
  }

  /**
   * Find the `calls` history row the original dial wrote (caller → peer,
   * status `outgoing`, timestamp within ±15 s of the signal doc's
   * createdAt — both were written at dial time), so the resumed call's
   * end finalises that row instead of writing a second one. Returns the
   * doc, or null when no match is found (endCall then late-writes a
   * final row, leaving one stale `outgoing` row — the pre-existing W12d
   * fallback, not a new duplicate class).
   */
  private findOutgoingHistoryDoc(myUid: string, peerId: string, createdAt: number): any | null {
    try {
      const docs = (db as any)?.getCollectionDocs?.('calls');
      if (!Array.isArray(docs)) return null;
      let best: { doc: any; dt: number } | null = null;
      for (const d of docs) {
        if (!d || d.callerId !== myUid || d.receiverId !== peerId || d.status !== 'outgoing') continue;
        const ts = d.timestamp;
        const ms = typeof ts === 'number' ? ts : typeof ts?.toMillis === 'function' ? ts.toMillis() : Number(ts) || 0;
        if (!ms) continue;
        const dt = Math.abs(ms - createdAt);
        if (dt <= 15_000 && (!best || dt < best.dt)) best = { doc: d, dt };
      }
      return best?.doc || null;
    } catch {
      return null;
    }
  }

  public async startCall(params: {
    targetUserId: string;
    targetUserName: string;
    targetUserAvatar?: string;
    type: CallType;
  }): Promise<StartCallResult> {
    // 100M-H12 — the old code returned void here with no feedback at
    // all: tapping Call from another chat mid-call looked like a dead
    // button. The result tells the caller why nothing started.
    if (this.activeCall.status !== 'idle' && this.activeCall.status !== 'ended') return 'already-in-call';
    // Worker C: the status guard above only flips AFTER getUserMedia
    // resolves, so two rapid taps both passed it and created two peer
    // connections racing over one callId. This flag flips synchronously.
    if (this.starting) return 'starting';
    // RETEST-1: never start a call to yourself — it used to proceed
    // (signalling to self, then a silent 25s timeout with no UI at all).
    // The ChatScreen header already hides the buttons for self-DMs; this
    // is the backstop for any other caller (e.g. a deep link).
    if (auth.currentUser?.uid && params.targetUserId === auth.currentUser.uid) return 'self';
    this.starting = true;

    if (auth.currentUser) await this.init(auth.currentUser.uid);

    const { targetUserId, targetUserName, targetUserAvatar, type } = params;
    const callId = newCallId();
    // Report 3 #120 — the dialling state is emitted before media, so
    // callId is assigned early. This flag is the only thing that may
    // tell endCall a signalling doc actually exists (see the catch).
    let signalDocWritten = false;
    // #4 — which step the dial is in, so the catch can name it instead
    // of blaming the server for every failure.
    let step: 'media' | 'turn' | 'offer' | 'signalling' = 'media';
    // #8 — reset the diagnostics trail BEFORE the TURN fetch, so the
    // fetch result recorded by ensureTurnServers() survives into the
    // call's diagnostics (resetting after it would wipe the flags).
    this.resetDiagnostics('caller');

    try {
      // WA audit #6/#10 — pre-call support + mic-permission check,
      // before any dialling state is shown: a device that cannot call
      // (or a denied mic) gets the explainer modal instead of a dead
      // dialling screen or a bare ended-screen error. No signal doc is
      // written, no history row — the call never started.
      const support = await this.checkCallSupport();
      if (support !== 'ok') {
        this.starting = false;
        this.setPermissionNotice(support);
        return 'failed';
      }
      // Report 3 #120 — the old code only emit()ted AFTER getMedia +
      // TURN refresh, so a slow camera (up to 12 s) + up to 6 s ICE
      // gather left ~18 s of dead UI after tapping Call. Show the
      // dialling state synchronously, before any async work: the peer
      // is named, the UI says "Ringing…" immediately, and the later
      // media/ICE steps fill the stream in.
      // Report 3 #115 — the unload guard lives for the whole attempt.
      this.ensureUnloadGuard();
      this.role = 'caller';
      this.callId = callId;
      this.answerApplied = false;
      this.remoteEnded = false;
      this.endReason = 'cancelled';
      this.failDetail = null;
      this.reconnectAttempted = false;
      this.activeCall = {
        status: 'outgoing',
        type,
        remoteUserId: targetUserId,
        remoteName: targetUserName,
        remoteAvatar: targetUserAvatar,
        isIncoming: false,
        duration: 0,
        localStream: null,
        remoteStream: null,
        isMuted: false,
        isVideoEnabled: type === 'video',
        facingMode: 'user',
        isSpeaker: false,
        isScreenSharing: false,
        connectionQuality: 'unknown',
        callError: null,
        failedStep: null,
        callDiagnostics: null,
        waitingCall: null,
        isDndOn: getCallPrefs().doNotDisturb,
      };
      this.emit();

      // Report 3 #114 (P0-6) — mic-first, camera best-effort: a denied
      // camera must never kill the call before the signalling doc is
      // written (see getCallMedia). The mic is still essential — if it
      // fails, the catch below ends honestly with a permission message
      // and no doc is written (there is no call without a mic).
      const stream = await this.getCallMedia(type, 'user');
      // Worker C: fresh TURN before building the peer — the login-time
      // credentials may be hours old or entirely missing (see
      // ensureTurnServers). createPeer() snapshots this.iceServers.
      step = 'turn';
      await this.ensureTurnServers();
      this.ensureOfflineListener();

      // 100M-H5: fast End during dial — endCall already ran while
      // media/TURN were resolving (callId nulled). Without this guard
      // the assignment below resurrects the ended call to 'outgoing':
      // the ended screen flashes ~250 ms, then a ghost ringing screen
      // with no signal doc rings until the 45 s timeout. Abort this
      // attempt; endCall already finalised it.
      if (this.callId !== callId) return;

      this.activeCall = {
        status: 'outgoing',
        type,
        remoteUserId: targetUserId,
        remoteName: targetUserName,
        remoteAvatar: targetUserAvatar,
        isIncoming: false,
        duration: 0,
        localStream: stream,
        remoteStream: null,
        isMuted: false,
        // Worker C: audio-only fallback in getMedia() means a 'video'
        // call can legitimately have no camera — show it off, don't
        // claim video is live.
        isVideoEnabled: type === 'video' && !this.videoCaptureFailed,
        // Report 3 #114 — say so on screen instead of silently dropping
        // the video: the hint tells the caller the call is audio-only
        // because the camera failed (tap the camera button to retry).
        videoNotice:
          type === 'video' && this.videoCaptureFailed
            ? 'Camera unavailable — continuing audio-only'
            : null,
        facingMode: 'user',
        isSpeaker: false,
        isScreenSharing: false,
        screenStream: null,
        remoteVideoEnabled: false,
        // Report 3 #103 — a video call whose camera failed is audio-only;
        // the UI says so instead of silently running a "video" call.
        isAudioOnly: type === 'video' && this.videoCaptureFailed,
        connectionQuality: 'unknown',
        callError: null,
        failedStep: null,
        callDiagnostics: null,
        waitingCall: null,
        isDndOn: getCallPrefs().doNotDisturb,
      };
      this.localStream = stream;
      // AUDIT-2 B18: the call is live from here — mic is open, so keep
      // the process alive if the app is backgrounded mid-call.
      // #6: a failed start is recorded in diagnostics, not swallowed.
      const fgErr = await callForegroundStart();
      if (fgErr) {
        this.diagForegroundError = fgErr;
        this.recordDiag('foreground-service-failed', fgErr);
      }
      this.emit();
      this.starting = false;
      // Report 3 #11 — start audio routing at DIAL, not at connect:
      // the ringtone and the call then use the same route (a headset
      // that rings audibly no longer goes silent at connect), and the
      // Bluetooth permission is requested before the device list is read.
      await this.ensureAudioRoute();
      // #5 — TURN fetch failed AND no relay is available: fail fast
      // with the true reason NOW, instead of ringing STUN-only and
      // dying 25 s later with a generic ICE timeout. (Local/mock mode
      // has no backend, so diagTurnFetchFailed is false there and this
      // never fires — mock calls still ring.)
      if (!this.turnAvailable && this.diagTurnFetchFailed) {
        this.endReason = 'failed';
        this.setFail('turn-fetch', ERR_TURN_FETCH);
        this.endCall(true);
        return 'failed';
      }
      this.startRinging(false);
      this.armRingTimeout();
      this.startSignalHealthCheck();

      step = 'offer';
      const pc = this.createPeer();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIce(pc);
      this.recordDiag('offer-created', `relay candidate gathered: ${this.diagRelayCandidate ? 'yes' : 'no'}`);

      // Cancelled while gathering candidates
      if (this.callId !== callId || this.pc !== pc) return 'cancelled';

      step = 'signalling';
      // Report 3 #113 (C4) — one retry on the signalling write: a single
      // transient write failure used to kill the whole dial and the
      // callee got nothing. Bounded (1 retry, 1 s) and idempotent (same
      // doc id, same content), so a retry after an ambiguous failure
      // cannot duplicate the call. The step stays 'signalling' so the
      // catch still names the failure honestly if both attempts fail.
      let signalWriteError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await setDoc(doc(db, SIG_COL, callId) as any, {
            callerId: auth.currentUser?.uid || '',
            callerName: auth.currentUser?.displayName || auth.currentUser?.username || 'User',
            callerAvatar: auth.currentUser?.photoURL || '',
            calleeId: targetUserId,
            type,
            status: 'ringing',
            offer: pc.localDescription?.sdp || '',
            createdAt: Date.now(),
          });
          signalWriteError = null;
          break;
        } catch (e) {
          signalWriteError = e;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (signalWriteError) throw signalWriteError;
      // Report 3 #120 — the dialling state is emitted before media, so
      // callId is assigned early (see the emit above). endCall must not
      // write 'ended' to a doc that was never created: only once this
      // write has landed is the doc real.
      signalDocWritten = true;

      // Log outgoing call in database
      if (auth.currentUser) {
        // 100M-H1 — the call may have ended while the signal write was
        // in flight (endCall already late-wrote the final record then):
        // the guard above only ran BEFORE the write, so re-check here,
        // or this addDoc creates a second history row.
        if (this.callId !== callId || this.pc !== pc) return;
        const historySlot: {
          callId: string;
          finalPatch: { status: CallEndReason; duration: number; endedAt: number } | null;
        } = { callId, finalPatch: null };
        this.historyWrite = historySlot;
        addDoc(collection(db, 'calls') as any, {
          callerId: auth.currentUser.uid,
          callerName: auth.currentUser.displayName || 'User',
          callerAvatar: auth.currentUser.photoURL || '',
          receiverId: targetUserId,
          receiverName: targetUserName,
          receiverAvatar: targetUserAvatar || '',
          type,
          status: 'outgoing',
          timestamp: serverTimestamp(),
          // Audit H3-1: the signal doc id is this call's exact key — the
          // callee's record stores the same value, so dedupCallHistory
          // merges the pair on the key instead of the 60 s window (a
          // rapid redial is a different signal id, so it stays its own
          // row). The finalPatch updateDoc paths need no key: they patch
          // this doc, they never create a second one.
          signalId: callId,
        } as any)
          .then((ref: any) => {
            const id = ref?.id || null;
            if (!id) {
              if (this.historyWrite === historySlot) this.historyWrite = null;
              return;
            }
            if (historySlot.finalPatch) {
              // The call ended while this write was in flight: endCall
              // stashed the final status instead of late-writing. Apply
              // it to the doc we just created — exactly one history row.
              if (this.historyWrite === historySlot) this.historyWrite = null;
              updateDoc(doc(db, 'calls', id) as any, historySlot.finalPatch).catch((err) =>
                console.warn('[callService] historyWrite: final updateDoc failed', err),
              );
            } else if (this.historyWrite === historySlot && this.callId === callId) {
              this.historyWrite = null;
              this.callDocId = id;
            } else {
              // Defensive: the slot was replaced by a newer call (or the
              // call ended without a stashed final status — unreachable
              // via endCall, which always stashes while a slot is live).
              // Finalise as unanswered so the row never sits open, and
              // never touch callDocId — it belongs to the live call.
              if (this.historyWrite === historySlot) this.historyWrite = null;
              updateDoc(doc(db, 'calls', id) as any, { status: 'unanswered', duration: 0, endedAt: Date.now() }).catch((err) =>
                console.warn('[callService] historyWrite: orphan updateDoc failed', err),
              );
            }
          })
          .catch((err) => {
            if (historySlot.finalPatch) {
              // The write failed AND the call already ended: no doc
              // exists, so create the final record now (the late write
              // endCall skipped because this write was in flight).
              if (this.historyWrite === historySlot) this.historyWrite = null;
              addDoc(collection(db, 'calls') as any, {
                callerId: auth.currentUser.uid,
                callerName: auth.currentUser.displayName || 'User',
                callerAvatar: auth.currentUser.photoURL || '',
                receiverId: targetUserId,
                receiverName: targetUserName,
                receiverAvatar: targetUserAvatar || '',
                type,
                timestamp: serverTimestamp(),
                // Audit H3-1: same exact key as the startCall write above.
                signalId: callId,
                ...historySlot.finalPatch,
              } as any).catch((e) => console.warn('[callService] historyWrite: final addDoc failed', e));
            } else {
              if (this.historyWrite === historySlot) this.historyWrite = null;
              console.warn('[callService] onOwnSignal: addDoc(...) failed', err);
            }
          });
      }
      // 100M-H12 — the dial is live (ringing): the caller started.
      return 'started';
    } catch (err: any) {
      this.starting = false;
      console.error('Failed to start call:', err);
      // Report 3 #120 — callId is assigned before media (early dialling
      // state), but no signalling doc exists until the setDoc lands. If
      // the dial died before that write, clear the id so endCall does
      // not write 'ended' (or schedule a delete) for a doc that never
      // existed — the original invariant, kept.
      if (!signalDocWritten) this.callId = null;
      // #4 — the dial can die before the active call was ever set up
      // (media failure happens before role/callId/activeCall are
      // assigned below). Without this, the ended screen showed a
      // nameless "User" with no Call Back button and diagnostics with
      // no peer — the failure was real but unattributed. Patch the peer
      // in (role only, NOT callId: no signal doc was ever written, so
      // endCall must not write 'ended' to a doc that never existed).
      if (this.activeCall.status === 'idle') {
        this.role = 'caller';
        this.activeCall.remoteUserId = targetUserId;
        this.activeCall.remoteName = targetUserName;
        this.activeCall.remoteAvatar = targetUserAvatar;
        this.activeCall.type = type;
      }
      // Worker C: was alert('Could not start the call…') + endCall.
      // #4 — classify the failure by the step it died in, so the ended
      // screen says what actually happened: a media failure is a
      // permission/device problem, an offer failure is local WebRTC, a
      // signalling-write failure is a server problem. The old code
      // blamed the server for all three.
      this.endReason = 'failed';
      const mediaNames = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError'];
      // WA audit #6 — a denied mic on dial gets the explainer modal on
      // the ended screen (carried via pendingPermissionNotice — endCall
      // copies it into the ended state). Other media failures (no mic
      // found, busy device) keep the existing callError text only.
      if (step === 'media' && (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')) {
        this.pendingPermissionNotice = {
          kind: 'mic-denied',
          detail: 'Microphone permission is denied. Allow it in Settings → Apps → Pinglo → Permissions, then try again.',
        };
      }
      if (mediaNames.includes(err?.name)) {
        this.setFail('start-media', this.mediaErrorMessage(err));
      } else if (step === 'offer') {
        this.setFail('start-offer', ERR_OFFER_FAILED);
      } else if (step === 'turn') {
        this.setFail('turn-fetch', ERR_TURN_FETCH);
      } else {
        this.setFail('start-signalling', ERR_SIGNAL_WRITE);
      }
      this.endCall(true);
      return 'failed';
    }
  }

  /**
   * Phase 3 — missed-call recording for the CALLEE. The old code only ever
   * wrote a `calls` doc for the caller, so a declined/unanswered incoming
   * call was invisible to the receiver. This writes the callee's own
   * record (caller → receiver, status missed/declined/busy/unanswered).
   * Best-effort: a failed write never affects the live call.
   */
  private recordCalleeCall(signal: any, status: CallEndReason, duration = 0, signalId?: string | null, opts?: { skipChatEntry?: boolean }) {
    const me = auth.currentUser;
    if (!me) return;
    const callerId = signal?.callerId || signal?.remoteUserId || '';
    if (!callerId) return;
    // W24 — the record exists now (see markRingingHistoryRecorded): a
    // later reload re-delivering the same signal doc must not record
    // the same call again.
    if (signalId) this.markRingingHistoryRecorded(signalId);
    addDoc(collection(db, 'calls') as any, {
      callerId,
      callerName: signal?.callerName || signal?.remoteName || 'Unknown Caller',
      callerAvatar: signal?.callerAvatar || signal?.remoteAvatar || '',
      receiverId: me.uid,
      receiverName: me.displayName || me.username || 'User',
      receiverAvatar: me.photoURL || '',
      type: signal?.type === 'video' ? 'video' : 'audio',
      status,
      timestamp: serverTimestamp(),
      duration,
      // Audit H3-1: the signal doc id is this call's exact key — the
      // caller's record stores the same value, so dedupCallHistory merges
      // the pair on the key instead of the 60 s window. Every call site
      // passes it; the guard only covers a future caller that does not.
      ...(signalId ? { signalId } : {}),
    } as any).catch((err) => console.warn("[callService] onOwnSignal: addDoc(...) failed", err));
    // 100M-H14 — a missed call leaves a trace INSIDE the chat, not just
    // in the Calls tab: WhatsApp shows "Missed voice call" in the
    // thread. Written as a `type: 'system'` doc (same centred-pill
    // render as the group membership events, same `kept`/`seen` flags
    // so it never inflates unread counts or disappears). The time is
    // baked into the text — the system pill renders no timestamp.
    // Best-effort: a failed write never affects the live call or the
    // history record above.
    // WA audit #9 — a BLOCKED caller's miss is recorded silently: no
    // chat-thread pill (the thread is hidden/blocked; a pill there
    // would surface the blocked caller in the chat list preview).
    if (status === 'missed' && !opts?.skipChatEntry) {
      this.postMissedCallChatEntry(callerId, signal?.type === 'video' ? 'video' : 'audio', signalId);
    }
  }

  /**
   * 100M-H14 — the chat-thread side of a missed call (see
   * recordCalleeCall). One entry per signal doc: the history guard
   * above already dedups reloads, and this set dedups in-session
   * double-records (e.g. the ghost-ringing sweeper + the ring-timeout
   * path firing for the same call). Without a signal id, the key is
   * caller + minute bucket, so a genuine second missed call a minute
   * later still gets its own entry.
   */
  private postedMissedChatEntries = new Set<string>();
  private postMissedCallChatEntry(callerId: string, type: 'audio' | 'video', signalId?: string | null) {
    // 100M-H14 fix (probe 2026-11-17): `auth.currentUser` is null in
    // mock/offline mode, so the entry was silently skipped and no trace
    // ever appeared in the chat — the missed record in Calls still
    // landed, because recordCalleeCall never needed auth. The service's
    // own initializedUserId (set by init() from the App's auth state)
    // is the reliable "me" in every mode.
    const myUid = this.initializedUserId || auth.currentUser?.uid || '';
    if (!myUid || !callerId) return;
    const dedupKey = signalId ? `sig:${signalId}` : `anon:${callerId}:${Math.floor(Date.now() / 60000)}`;
    if (this.postedMissedChatEntries.has(dedupKey)) return;
    this.postedMissedChatEntries.add(dedupKey);
    if (this.postedMissedChatEntries.size > 500) this.postedMissedChatEntries.clear();
    try {
      const conversationId = getConversationId(myUid, callerId);
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      addDoc(collection(db, 'chats', conversationId, 'messages') as any, {
        type: 'system',
        text: `Missed ${type === 'video' ? 'video' : 'voice'} call · ${time}`,
        senderId: 'system',
        senderName: '',
        timestamp: Date.now(),
        status: 'seen',
        kept: true,
        encryption: 'legacy',
      } as any).catch((err) => console.warn('[callService] missed-call chat entry failed (non-fatal):', err));
    } catch (err) {
      console.warn('[callService] missed-call chat entry failed (non-fatal):', err);
    }
  }

  // ── Incoming Call Handler (callee side) ──
  // ROADMAP-2 #13: an incoming signal is routed by decideIncomingCall —
  // DND silences it, silence-unknown-callers silences strangers, a busy
  // line parks the caller as a waiting call (one slot), otherwise it
  // rings. Silenced calls are NEVER shown and NEVER ring, but they are
  // recorded as missed so the user can call back — silencing is not
  // deleting. Report 3 #121: a silenced call DOES write back
  // (status 'silenced' + reason) so the caller ends fast with the real
  // reason instead of 45 s of dead ringing.
  private handleIncomingSignal(id: string, s: any) {
    const prefs = getCallPrefs();
    const callerId: string = s.callerId || '';
    const known = prefs.silenceUnknownCallers ? isKnownCaller(callerId) : true;
    const busy = this.activeCall.status !== 'idle' && this.activeCall.status !== 'ended';
    // WA audit #9 — the Phase 5 blocked list is consulted here, before
    // any ring: a blocked caller never rings, never shows the incoming
    // screen, never gets a chat-thread pill. Two sources, unioned: the
    // cached user doc (same helper contacts.ts uses) AND the
    // localStorage mirror — the doc read is load-order dependent (the
    // users collection restores lazily; at cold boot it can still be
    // empty when the first ring arrives), the mirror is always there.
    // Both read MY OWN data only — no user enumeration.
    const myUid = auth.currentUser?.uid || this.initializedUserId || '';
    const blocked = callerId
      ? new Set([...loadBlockedIdsCached(myUid), ...getBlockedIdsLocal(myUid)]).has(callerId)
      : false;
    const decision = decideIncomingCall(prefs, known, busy, this.waiting !== null, blocked);

    if (decision === 'blocked') {
      console.warn('Call from blocked caller — not ringing');
      if (!this.ringingFirstSeen.get(id)?.historyRecorded) this.recordCalleeCall(s, 'missed', 0, id, { skipChatEntry: true });
      updateDoc(doc(db, SIG_COL, id) as any, { status: 'blocked' }).catch((err) =>
        console.warn('[callService] handleIncomingSignal: blocked write-back failed', err),
      );
      return;
    }
    if (decision === 'silence-dnd') {
      console.warn('Call silenced by Do Not Disturb');
      // W24: a reload re-delivers the same doc — record the miss once.
      if (!this.ringingFirstSeen.get(id)?.historyRecorded) this.recordCalleeCall(s, 'missed', 0, id);
      // Report 3 #121 — the old code recorded the miss and wrote
      // NOTHING back, so the caller heard 45 s of dead ringing for a
      // phone that would never answer. Write 'silenced' so the caller
      // ends fast with the real reason (see onOwnSignal). Best-effort:
      // if the write fails the caller just keeps ringing as before.
      updateDoc(doc(db, SIG_COL, id) as any, { status: 'silenced', silencedReason: 'dnd' }).catch((err) =>
        console.warn('[callService] handleIncomingSignal: silenced write-back failed', err),
      );
      return;
    }
    if (decision === 'silence-unknown') {
      console.warn('Call silenced: unknown caller (not a contact, no conversation)');
      // W24: same once-only guard as DND above.
      if (!this.ringingFirstSeen.get(id)?.historyRecorded) this.recordCalleeCall(s, 'missed', 0, id);
      // #121 — same write-back as DND above.
      updateDoc(doc(db, SIG_COL, id) as any, { status: 'silenced', silencedReason: 'unknown' }).catch((err) =>
        console.warn('[callService] handleIncomingSignal: silenced write-back failed', err),
      );
      return;
    }
    if (decision === 'busy') {
      // Third caller while one is already waiting: the old behaviour.
      console.warn('Call rejected: line busy (a call is already waiting)');
      updateDoc(doc(db, SIG_COL, id) as any, { status: 'busy' }).catch((err) => console.warn("[callService] handleIncomingSignal: updateDoc(...) failed", err));
      // Phase 3: the callee still gets a call-history record (status 'busy').
      // W24: once-only guard, as above.
      if (!this.ringingFirstSeen.get(id)?.historyRecorded) this.recordCalleeCall(s, 'busy', 0, id);
      return;
    }
    if (decision === 'waiting') {
      const callType: CallType = s.type === 'video' ? 'video' : 'audio';
      this.waiting = {
        signalId: id,
        remoteUserId: callerId,
        remoteName: s.callerName || 'Unknown Caller',
        remoteAvatar: s.callerAvatar || '',
        type: callType,
        offer: s.offer || '',
        receivedAt: Date.now(),
      };
      this.activeCall.waitingCall = this.waiting;
      this.emit();
      // One short beep, not the looping ringtone — the current call's
      // audio must not be drowned out. Best-effort: an AudioContext
      // created outside a user gesture may stay suspended until the
      // next tap, so the banner is the reliable signal, not the beep.
      this.playWaitingBeep();
      this.armWaitingTimeout();
      return;
    }

    this.showIncomingCall(id, callerId, s.callerName || 'Unknown Caller', s.callerAvatar || '', s.type === 'video' ? 'video' : 'audio', s.offer || '');
  }

  /** Shared incoming-call setup: normal ring + a parked call promoted after endCall. */
  private showIncomingCall(signalId: string, callerId: string, callerName: string, callerAvatar: string, type: CallType, offer: string) {
    this.role = 'callee';
    this.callId = signalId;
    this.pendingOffer = offer;
    this.remoteEnded = false;
    this.answerApplied = false;
    this.endReason = 'cancelled';
    this.failDetail = null;
    this.reconnectAttempted = false;

    this.activeCall = {
      status: 'incoming',
      type,
      remoteUserId: callerId,
      remoteName: callerName,
      remoteAvatar: callerAvatar,
      isIncoming: true,
      duration: 0,
      localStream: null,
      remoteStream: null,
      isMuted: false,
      isVideoEnabled: type === 'video',
      facingMode: 'user',
      isSpeaker: false,
      isScreenSharing: false,
      screenStream: null,
      // 100M-H13 — a fresh incoming call rings out loud.
      ringSilenced: false,
      remoteVideoEnabled: false,
      isAudioOnly: false,
      connectionQuality: 'unknown',
      callError: null,
      failedStep: null,
      callDiagnostics: null,
      waitingCall: null,
      isDndOn: getCallPrefs().doNotDisturb,
    };
    // #8 — fresh diagnostics trail for this incoming call.
    this.resetDiagnostics('callee');
    // Report 3 #115 — the unload guard lives for the whole attempt,
    // including the ring (a reload mid-ring must end the call for the
    // caller instead of leaving them ringing 45 s).
    this.ensureUnloadGuard();

    this.emit();
    // Report 3 #113 (C2) — the app may be backgrounded when the ring
    // arrives; keep the process alive so the ring (and the answer) can
    // survive instead of being killed with the app. Best-effort and
    // never blocking the ring: on web this is a no-op, on native a
    // failure is recorded in diagnostics (see #118) but the ring goes
    // on — a failed service start must not silence a call.
    void callForegroundStart().then((fgErr) => {
      if (fgErr) {
        this.diagForegroundError = fgErr;
        this.recordDiag('foreground-service-failed', fgErr);
      }
    });
    // Report 3 #11/#13 — route the incoming ring through the call-audio
    // path (MODE_IN_COMMUNICATION + headset if connected) instead of
    // plain media routing, so the ring and the call come from the same
    // device. Fire-and-forget: ringing must not wait on the Bluetooth
    // permission dialog.
    void this.ensureAudioRoute();
    this.startRinging(true);
    this.armRingTimeout();
    this.startSignalHealthCheck();
  }

  /** One short beep + light haptic for a waiting call (never the looping ringtone). */
  private playWaitingBeep() {
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx: AudioContext = new AC();
      // Report 3 #13 — the waiting beep is a ringtone too: same output as the call.
      if (!Capacitor.isNativePlatform() && this.selectedWebOutputId) {
        void applyWebSinkIdToContext(ctx, this.selectedWebOutputId);
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      setTimeout(() => ctx.close().catch((err) => console.warn("[callService] playWaitingBeep: close(...) failed", err)), 600);
      Haptics.impact({ style: ImpactStyle.Light }).catch((err) => console.warn("[callService] playWaitingBeep: impact(...) failed", err));
    } catch (err) {
      console.warn('[callService] playWaitingBeep failed', err);
    }
  }

  private clearWaitingTimeout() {
    if (this.waitingTimeout) clearTimeout(this.waitingTimeout);
    this.waitingTimeout = null;
  }

  /**
   * A parked waiting call expires when the caller's ring would have
   * ended anyway (45 s from the original ring, min 5 s grace), recorded
   * as missed. It never outlives the call it waited on by stealth.
   * Report 3 #122 — the old expiry was silent: the waiting caller kept
   * ringing until their own 45 s timeout and was never told the slot
   * had expired. Now the expiry writes 'busy' back, so the waiting
   * caller ends immediately with the busy reason (see onOwnSignal).
   */
  private armWaitingTimeout() {
    this.clearWaitingTimeout();
    const parked = this.waiting;
    if (!parked) return;
    const remaining = Math.max(5_000, RING_TIMEOUT_MS - (Date.now() - parked.receivedAt));
    this.waitingTimeout = setTimeout(() => {
      this.waitingTimeout = null;
      const expired = this.waiting;
      if (!expired) return;
      this.waiting = null;
      this.activeCall.waitingCall = null;
      updateDoc(doc(db, SIG_COL, expired.signalId) as any, { status: 'busy' }).catch((err) =>
        console.warn('[callService] waiting expiry: busy write-back failed', err),
      );
      this.recordCalleeCall(
        { callerId: expired.remoteUserId, callerName: expired.remoteName, callerAvatar: expired.remoteAvatar, type: expired.type },
        'missed',
        0,
        expired.signalId,
      );
      this.emit();
    }, remaining);
  }

  /**
   * ROADMAP-2 #13 — call waiting, "End & accept". Ends the current call
   * and answers the parked one. This is NOT a hold: true hold (both
   * calls live, first call on hold) needs a second peer connection and
   * a second mic pipeline — the service owns exactly one pc / one
   * localStream. Holding is recorded as blocked on the group-call plan
   * (ROADMAP-2 #4) in PATCH-R1B.md; the UI says so instead of faking it.
   */
  public async acceptWaitingCall() {
    const waiting = this.waiting;
    if (!waiting) return;
    if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended') return;
    if (!waiting.offer) {
      // No SDP to answer with — cannot connect; drop it as missed.
      this.declineWaitingCall();
      return;
    }
    this.waiting = null;
    this.clearWaitingTimeout();
    this.swappingToWaiting = true;
    // endCall() tears down the current call (signalling + history) and
    // leaves 'ended'; acceptCallWith then takes over before the dismiss
    // timer can wipe the state (the timer skips while swapping).
    this.endCall(true);
    this.role = 'callee';
    this.callId = waiting.signalId;
    this.pendingOffer = waiting.offer;
    this.remoteEnded = false;
    this.answerApplied = false;
    // The ended state still names the PREVIOUS caller — re-point it at
    // the waiting caller so 'connecting' shows the right name/type.
    this.activeCall.remoteUserId = waiting.remoteUserId;
    this.activeCall.remoteName = waiting.remoteName;
    this.activeCall.remoteAvatar = waiting.remoteAvatar;
    this.activeCall.type = waiting.type;
    this.activeCall.isIncoming = true;
    // #8 — the swapped-in call gets a fresh diagnostics trail (the
    // previous call's trail was frozen into its ended state by endCall).
    this.resetDiagnostics('callee');
    await this.acceptCallWith(waiting.signalId, waiting.offer);
  }

  /** Decline the parked waiting call: caller sees 'busy', callee gets a 'busy' record. */
  public declineWaitingCall() {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    this.clearWaitingTimeout();
    this.activeCall.waitingCall = null;
    updateDoc(doc(db, SIG_COL, waiting.signalId) as any, { status: 'busy' }).catch((err) => console.warn("[callService] declineWaitingCall: updateDoc(...) failed", err));
    this.recordCalleeCall(
      { callerId: waiting.remoteUserId, callerName: waiting.remoteName, callerAvatar: waiting.remoteAvatar, type: waiting.type },
      'busy',
      0,
      waiting.signalId,
    );
    this.emit();
  }

  /**
   * A parked call carried past endCall: ring it as a normal incoming
   * call once the ended screen dismisses — unless it went stale or the
   * caller already hung up (both checked here and in onSignalSnapshot).
   */
  private maybePromoteWaiting() {
    const waiting = this.pendingPromote;
    this.pendingPromote = null;
    if (!waiting) return;
    if (this.activeCall.status !== 'idle') return;
    if (Date.now() - waiting.receivedAt > RING_TIMEOUT_MS) {
      this.recordCalleeCall(
        { callerId: waiting.remoteUserId, callerName: waiting.remoteName, callerAvatar: waiting.remoteAvatar, type: waiting.type },
        'missed',
        0,
        waiting.signalId,
      );
      return;
    }
    this.showIncomingCall(waiting.signalId, waiting.remoteUserId, waiting.remoteName, waiting.remoteAvatar, waiting.type, waiting.offer);
  }

  // ── Accept Incoming Call ──
  public async acceptCall() {
    if (this.role !== 'callee' || !this.callId || !this.pendingOffer) return;
    await this.acceptCallWith(this.callId, this.pendingOffer);
  }

  /**
   * Shared accept path: normal incoming (acceptCall) + waiting-call swap
   * (acceptWaitingCall, which sets role/callId/pendingOffer first and
   * raises swappingToWaiting). The swap flag is cleared once
   * 'connecting' shows, or on any failure — it must never outlive the
   * attempt, or endCall's dismiss timer would never fire again.
   */
  private async acceptCallWith(callId: string, offerSdp: string) {
    // Worker C: double-tap guard (same race as startCall — the first
    // accept is async and the status guard doesn't flip until later).
    if (this.accepting) return;
    this.accepting = true;
    this.stopRinging();
    this.ensureOfflineListener();
    // Report 3 #115 — the unload guard lives for the whole attempt.
    this.ensureUnloadGuard();
    // Report 3 #120 — show 'connecting' the moment the user taps
    // Accept, not after media + ICE gather + the answer write (up to
    // ~18 s of dead incoming screen before). 'connecting' flips to
    // 'connected' only in onconnectionstatechange.
    if (this.activeCall.status === 'incoming') {
      this.activeCall.status = 'connecting';
      this.emit();
    }
    // #4 — which step the accept is in, so the catch can name it.
    let step: 'media' | 'turn' | 'offer' | 'signalling' = 'media';

    try {
      // 100M-H9 — belt-and-braces for the pre-accept upgrade: if the
      // offer being answered carries a video m-line (the caller
      // upgraded mid-ring and the pendingOffer refresh did not run),
      // Accept must acquire the camera instead of answering audio-only.
      if (offerSdp.includes('m=video') && this.activeCall.type === 'audio') {
        this.activeCall.type = 'video';
        this.activeCall.isAudioOnly = false;
      }
      // Report 3 #126 — mic-first, camera best-effort (see
      // getCallMedia): a denied camera must not kill a call the callee
      // already answered. Only a mic failure ends the accept, and then
      // the caller is told why (see the catch).
      const stream = await this.getCallMedia(this.activeCall.type, this.activeCall.facingMode);
      if (this.callId !== callId) {
        stream.getTracks().forEach((t) => t.stop());
        // ROADMAP-2 #13: the old code returned here with `accepting`
        // still true, blocking every later accept until reload.
        this.accepting = false;
        this.swappingToWaiting = false;
        return;
      }
      // Worker C: fresh TURN before building the peer (login-time creds
      // may be expired — acceptCall previously never refreshed them).
      step = 'turn';
      await this.ensureTurnServers();
      if (this.callId !== callId) {
        stream.getTracks().forEach((t) => t.stop());
        this.accepting = false;
        this.swappingToWaiting = false;
        return;
      }
      this.localStream = stream;
      this.activeCall.localStream = stream;
      this.activeCall.isVideoEnabled = this.activeCall.type === 'video' && !this.videoCaptureFailed;
      // Report 3 #103/#100 — same audio-only + no-remote-video-yet
      // flags as the caller side (acceptCall mutates the incoming
      // literal rather than replacing it).
      this.activeCall.isAudioOnly = this.activeCall.type === 'video' && this.videoCaptureFailed;
      this.activeCall.remoteVideoEnabled = false;
      // Report 3 #114 — same on-screen note as the caller side.
      this.activeCall.videoNotice =
        this.activeCall.type === 'video' && this.videoCaptureFailed
          ? 'Camera unavailable — continuing audio-only'
          : null;
      // AUDIT-2 B18: the user accepted — mic is open, so keep the
      // process alive if the app is backgrounded mid-call.
      // #6: a failed start is recorded in diagnostics, not swallowed.
      const fgErr = await callForegroundStart();
      if (fgErr) {
        this.diagForegroundError = fgErr;
        this.recordDiag('foreground-service-failed', fgErr);
      }
      // Report 3 #11 — start audio routing at ACCEPT, not at connect
      // (same reason as startCall: ringtone and call share one route,
      // headset already connected is used from the start).
      await this.ensureAudioRoute();
      // Worker C: show 'connecting' HERE — as soon as the user has
      // accepted and local media is ready — not after ICE gathering and
      // the answer write. The previous placement (after updateDoc) meant
      // a slow gather (up to 6 s) or a failing write left the user
      // staring at the incoming screen with no feedback after tapping
      // Accept. 'connecting' flips to 'connected' only in
      // onconnectionstatechange; the timeout below bounds a gather /
      // write that never finishes.
      this.activeCall.status = 'connecting';
      this.armConnectTimeout();
      this.emit();
      // ROADMAP-2 #13: the swap is now visibly under way — endCall's
      // dismiss timer may run again (it no-ops on 'connecting' anyway).
      this.swappingToWaiting = false;

      // #5 — same fail-fast as the caller side: a failed TURN fetch
      // with no relay available ends here with the TURN reason instead
      // of connecting STUN-only and dying at the ICE timeout.
      if (!this.turnAvailable && this.diagTurnFetchFailed) {
        this.endReason = 'failed';
        this.setFail('turn-fetch', ERR_TURN_FETCH);
        this.endCall(true);
        return;
      }

      step = 'offer';
      const pc = this.createPeer();
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this.waitForIce(pc);
      this.recordDiag('answer-created', `relay candidate gathered: ${this.diagRelayCandidate ? 'yes' : 'no'}`);

      if (this.callId !== callId || this.pc !== pc) {
        this.accepting = false;
        return;
      }

      step = 'signalling';
      // Report 3 #113 (C4) — same one-retry as the caller-side
      // signalling write: a transient failure on the answer write used
      // to drop a call the callee had already accepted. Bounded (1
      // retry, 1 s), idempotent (same fields), step stays 'signalling'.
      let answerWriteError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await updateDoc(doc(db, SIG_COL, callId) as any, {
            answer: pc.localDescription?.sdp || '',
            status: 'answered',
          });
          answerWriteError = null;
          break;
        } catch (e) {
          answerWriteError = e;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (answerWriteError) throw answerWriteError;
      this.lastAnswerSdp = pc.localDescription?.sdp || null;
      // Accept fully launched; a later tap is a no-op via the status
      // guard in startCall/acceptCall (endCall also clears this flag).
      this.accepting = false;

      clearTimeout(this.ringTimeout);
      this.ringTimeout = null;
      // Worker C: do NOT mark 'connected' here. The old code did, so a
      // call whose ICE never connected showed a ticking timer with no
      // audio/video until 'failed' ended it. 'connecting' flips to
      // 'connected' only in onconnectionstatechange, and the connect
      // timeout above ends it honestly if ICE never makes it.
    } catch (err: any) {
      this.accepting = false;
      this.swappingToWaiting = false;
      console.error('Could not answer call:', err);
      // Worker C: was alert('Camera/Microphone access needed…') +
      // declineCall() (which recorded 'declined' — a lie when the mic
      // was the problem). Record it as failed with the real reason.
      // #4 — same step split as startCall: media vs local answer
      // creation vs the signalling write.
      this.endReason = 'failed';
      const mediaNames = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError'];
      // WA audit #6 — same explainer-modal carry as the dial path
      // (see startCall's catch): a denied mic on accept shows the
      // modal over the ended screen instead of a bare callError.
      if (step === 'media' && (err?.name === 'NotAllowedError' || err?.name === 'SecurityError')) {
        this.pendingPermissionNotice = {
          kind: 'mic-denied',
          detail: 'Microphone permission is denied. Allow it in Settings → Apps → Pinglo → Permissions, then try again.',
        };
      }
      if (mediaNames.includes(err?.name)) {
        this.setFail('answer-media', this.mediaErrorMessage(err));
      } else if (step === 'offer') {
        this.setFail('answer-offer', ERR_ANSWER_CREATE);
      } else if (step === 'turn') {
        this.setFail('turn-fetch', ERR_TURN_FETCH);
      } else {
        this.setFail('answer-signalling', ERR_ANSWER_WRITE);
      }
      // Report 3 #126 — the caller must not see a bare 'ended' for a
      // call the callee answered and then lost to a media failure.
      // Write 'failed' + the reason to the signal doc BEFORE endCall,
      // and mark the remote side as having ended so endCall does not
      // overwrite it with 'ended' (see onOwnSignal 'failed' branch).
      // Best-effort: a failed write leaves the old behaviour (caller
      // sees 'ended'), never a worse one.
      if (mediaNames.includes(err?.name) && this.callId) {
        const sigId = this.callId;
        const reason = this.failDetail || this.mediaErrorMessage(err);
        try {
          await updateDoc(doc(db, SIG_COL, sigId) as any, { status: 'failed', failReason: reason });
          this.remoteEnded = true;
        } catch (writeErr) {
          console.warn('[callService] accept failure write-back failed:', writeErr);
        }
      }
      this.endCall(true);
    }
  }

  // ── Decline Call ──
  public declineCall() {
    this.stopRinging();
    this.endReason = 'declined';
    this.endCall(true);
  }

  /**
   * 100M-H13 — Silence WITHOUT declining. Stops the ringtone + haptics
   * (stopRinging clears both intervals) but leaves the incoming screen
   * up and the call ringing for the caller, so it can still be
   * answered — or become a missed call with a callback entry if it
   * times out. Unlike DND / silence-unknown-callers this is a
   * per-call, in-the-moment choice, not a setting, and it writes
   * nothing back to the caller.
   */
  public silenceIncomingCall() {
    if (this.activeCall.status !== 'incoming') return;
    this.stopRinging();
    this.activeCall.ringSilenced = true;
    this.emit();
  }

  /**
   * 100M-H13 — "Remind me": decline this call now and be reminded to
   * call back in `minutes`. The reminder lives in per-device
   * localStorage (callReminders.ts) and fires as an in-app banner from
   * the pushNotifications watcher tick — no backend, so it only fires
   * on this device while the app is running.
   */
  public remindMeLater(minutes: number) {
    if (this.activeCall.status !== 'incoming') return;
    const me = auth.currentUser;
    if (me) {
      addCallReminder(me.uid, {
        callerId: this.activeCall.remoteUserId,
        callerName: this.activeCall.remoteName || 'User',
        callerAvatar: this.activeCall.remoteAvatar || '',
        type: this.activeCall.type,
        minutes,
      });
    }
    this.declineCall();
  }

  /**
   * W12d (100-more C2): decline an incoming call with a quick message
   * (WhatsApp's "Reply with message"). Declines first (the caller gets
   * a 'declined' record), then sends the text to the caller as a DM via
   * the same send path ChatScreen uses (sendSharedText — same E2EE
   * fail-closed behaviour, same offline-outbox queueing). Returns:
   * - 'sent' — the message is in the chat.
   * - 'queued' — offline; putRaw parked it, it sends on reconnect.
   * - 'encryption-not-ready' — the keys are not exchanged yet (P0-8):
   *   the announce below was sent, but the caller must open the DM to
   *   ack it before any message can encrypt. Never plaintext, never
   *   silently dropped — the caller shows this + an Open chat button.
   * - 'failed' — not an incoming call, empty/overlong text, or an
   *   unexpected error.
   * The ended screen's auto-dismiss re-arms while the send is in
   * flight (declineMessagePending), and the modal calls
   * holdEndedScreen() once the result is displayed, so the user can
   * actually read it.
   */
  public async declineWithMessage(text: string): Promise<'sent' | 'queued' | 'failed' | 'encryption-not-ready'> {
    const me = auth.currentUser;
    const trimmed = (text || '').trim();
    const remoteId = this.activeCall.remoteUserId;
    const remoteName = this.activeCall.remoteName || 'User';
    if (!me || !remoteId || this.activeCall.status !== 'incoming' || !trimmed || trimmed.length > 5000) {
      return 'failed';
    }
    const conversationId = getConversationId(me.uid, remoteId);
    const sender = {
      uid: me.uid,
      displayName: me.displayName || me.username || 'User',
      photoURL: me.photoURL || '',
    };
    this.declineMessagePending = true;
    try {
      this.declineCall();
      // W5b's shared helper (e2eeChat.ts) — same 24h throttles + server-truth
      // check, plus the owner-scoped key lookup (W5c). Best-effort, never throws.
      // kxDocs come from the local cache (same pattern as the call-history reads
      // above); the writer mirrors ChatScreen's send-path writer.
      await ensureKeyAnnounce(
        conversationId,
        me.uid,
        (db as any)?.getCollectionDocs?.(`chats/${conversationId}/messages`) ?? [],
        async (cid, payload) => {
          await addDoc(collection(db, 'chats', cid, 'messages'), {
            ...payload, timestamp: Date.now(), senderId: me.uid,
          });
        },
      );
      const { sendSharedText } = await import('./shareSend');
      const res = await sendSharedText(
        { kind: 'dm', chatId: remoteId, conversationId, name: remoteName },
        sender,
        trimmed,
      );
      if (res === 'sent') return 'sent';
      if (res === 'queued') return 'queued';
      // sendSharedText only returns 'failed' for an encryption failure
      // (input was validated above) — the keys are not exchanged yet.
      return 'encryption-not-ready';
    } catch {
      return 'failed';
    } finally {
      this.declineMessagePending = false;
    }
  }

  /**
   * W12d (100-more C2): cancel the ended screen's auto-dismiss timer
   * (e.g. once the decline-with-message result is on screen, so the
   * user can read it and tap Open chat / Close). The screen then stays
   * until Close or Call Back. A no-op when no timer is armed.
   */
  public holdEndedScreen() {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  // Stop ringing after 45s so an unanswered call can't stay on screen forever
  private armRingTimeout(remainingMs: number = RING_TIMEOUT_MS) {
    clearTimeout(this.ringTimeout);
    this.ringTimeout = setTimeout(() => {
      if (this.activeCall.status === 'outgoing' || this.activeCall.status === 'incoming') {
        console.warn('Call not answered - ending');
        // Worker C: if the answer was already applied, this is not
        // 'unanswered' — ICE never connected (the 25 s connect timeout
        // normally fires first; this is the backstop).
        if (this.answerApplied) {
          this.endReason = 'failed';
          // #4: the backstop after an applied answer is its own step,
          // not the generic connect failure.
          this.setFail('ring-timeout-after-answer', ERR_RING_TIMEOUT_AFTER_ANSWER);
        } else {
          // Callee never answered → 'missed'; caller gave up ringing → 'unanswered'.
          this.endReason = this.activeCall.status === 'incoming' ? 'missed' : 'unanswered';
        }
        this.endCall(true);
      }
    }, remainingMs);
  }

  // ── End Call ──
  // _recordHistory: callers pass true, but the history write lives in
  // the snapshot path — the parameter is kept for the call sites' sake.
  public endCall(_recordHistory: boolean = false) {
    this.clearCallTimers();
    // Report 3 #115 — the unload guard dies with the call.
    this.removeUnloadGuard();
    this.starting = false;
    this.accepting = false;
    // Report 3 #12 — stop listening for device changes: the native
    // listener is unregistered by audioRouteStop(), the web
    // devicechange listener is removed here.
    this.audioRouteStarted = false;
    this.userPickedOutputId = null;
    if (this.removeAudioRouteListener) {
      try {
        this.removeAudioRouteListener();
      } catch (err) {
        console.warn('[callService] removing audio route listener failed:', err);
      }
      this.removeAudioRouteListener = null;
    }
    if (this.webDeviceChangeHandler) {
      try {
        navigator.mediaDevices?.removeEventListener('devicechange', this.webDeviceChangeHandler);
      } catch (err) {
        console.warn('[callService] removing devicechange listener failed:', err);
      }
      this.webDeviceChangeHandler = null;
    }
    // ROADMAP-2 #13: a parked waiting call survives the current call —
    // carry it past the ended screen so it can ring normally once the
    // user is free (maybePromoteWaiting, fired from the dismiss timer).
    // A swap (acceptWaitingCall) already took the waiting call, so there
    // is nothing to carry.
    if (this.waiting && !this.swappingToWaiting) {
      this.pendingPromote = this.waiting;
    }
    this.waiting = null;
    this.clearWaitingTimeout();
    this.stopRinging();
    this.removeOfflineListener();
    this.stopVideoFilterProcessingSync();
    this.videoFilterId = 'none';
    this.stopScreenShareSilently();
    this.stopQualitySampler();
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }

    audioRouteStop();
    // AUDIT-2 B18: every end path funnels through here — stop the
    // foreground service so no stale "Call in progress" notification or
    // mic-type hold survives the call.
    void callForegroundStop();
    if (this.pc) {
      const pc = this.pc;
      this.pc = null; // detach first so close-related events are ignored
      try {
        pc.close();
      } catch (err) {
        console.warn("[callService] armRingTimeout: pc.close() failed", err);
      }
    }

    // Tell the other side the call is over (unless they already told us)
    const sigId = this.callId;
    const role = this.role;
    const otherSideEnded = this.remoteEnded;
    this.callId = null;
    this.role = null;
    this.pendingOffer = null;
    this.answerApplied = false;
    this.remoteEnded = false;
    this.remoteStream = null;

    if (sigId) {
      if (!otherSideEnded) {
        updateDoc(doc(db, SIG_COL, sigId) as any, { status: 'ended' }).catch((err) => console.warn("[callService] armRingTimeout: updateDoc(...) failed", err));
      }
      // The caller owns the signalling doc and removes it once the call is over.
      // Worker C: the CALLEE now does the same. Previously only the caller
      // deleted it, so a caller crash/kill left a `ringing` doc behind
      // forever — every later reload re-checked it against the skew
      // window, and the callee never got a missed call for it.
      if (role === 'caller' || role === 'callee') {
        setTimeout(() => {
          deleteDoc(doc(db, SIG_COL, sigId) as any).catch((err) => console.warn("[callService] armRingTimeout: deleteDoc(...) failed", err));
        }, 60_000);
      }
    }

    const prevCall = { ...this.activeCall };
    const endReason = this.endReason;
    // Worker C: the user-facing reason for a bad end (permission,
    // couldn't connect, busy…). Consumed into the ended state below.
    const failDetail = this.failDetail;
    this.failDetail = null;
    // #4/#8: the failed step id is consumed the same way, and the
    // diagnostics text is frozen here — endCall clears this.callId /
    // this.role / this.pc above, so getDiagnosticsText() must run
    // BEFORE those are cleared… it reads this.callId, so freeze the
    // text from the pre-clear values instead: build it now from the
    // saved step trail plus the failure we are consuming.
    const failedStep = this.failedStep;
    this.failedStep = null;
    // WA audit #6/#10 — consume the pending permission notice into the
    // ended state (same pattern as failDetail above).
    const permissionNotice = this.pendingPermissionNotice;
    this.pendingPermissionNotice = null;
    const diagnosticsText =
      failDetail || endReason === 'failed'
        ? this.buildDiagnosticsText(sigId, role, failedStep, failDetail)
        : null;
    this.endReason = 'cancelled';
    this.remoteEndStatus = null;
    this.reconnectAttempted = false;

    // Finalise the call record.
    // 100M-H1 — endCall can re-enter synchronously: the 'ended' write to
    // the signal doc above notifies our own subscription, and onOwnSignal
    // calls endCall again while this invocation is still finalising
    // (activeCall is still 'outgoing'/'incoming'). Without this guard
    // both invocations finalised — two 'unanswered' rows (W30c r1).
    // sigId is unique per call (crypto.randomUUID), so no reset is ever
    // needed: a later call has a different sigId.
    const finaliseKey = sigId;
    if (finaliseKey === null || this.historyFinalisedFor !== finaliseKey) {
      if (finaliseKey !== null) this.historyFinalisedFor = finaliseKey;
      const callDocId = this.callDocId;
      this.callDocId = null;
      if (!prevCall.isIncoming && prevCall.status !== 'ended') {
        // Outgoing call: completed if it connected, otherwise declined /
        // missed / busy / unanswered (was: always 'missed').
        const wasConnected = prevCall.status === 'connected';
        // Worker C: a failed connection is 'failed', not 'missed' — the
        // callee may never even have rung.
        // Report 3 #243 — the caller ending their own unanswered ring is
        // 'unanswered', not 'missed': "Missed" is the CALLEE's view (they
        // never picked up). The old fall-through filed every caller-side
        // cancel as a red Missed row in the caller's own history and
        // bumped their Missed count. 'cancelled' is the default endReason
        // (set at dial, never changed when the caller hangs up ringing).
        const status: CallEndReason = wasConnected
          ? 'completed'
          : endReason === 'declined' || endReason === 'busy' || endReason === 'unanswered' || endReason === 'failed' || endReason === 'acceptedElsewhere'
            ? endReason
            : endReason === 'cancelled'
              ? 'unanswered'
              : 'missed';
        const patch = {
          status,
          duration: prevCall.duration || 0,
          endedAt: Date.now(),
        };
        if (callDocId) {
          updateDoc(doc(db, 'calls', callDocId) as any, patch).catch((err) => console.warn("[callService] armRingTimeout: updateDoc(...) failed", err));
        } else if (this.historyWrite && this.historyWrite.callId === sigId) {
          // 100M-H1 — the history addDoc from startCall is still in
          // flight: do NOT late-write a second doc. Stash the final
          // status on the slot; its .then applies it to the doc when
          // the write lands (or its .catch creates it if it failed).
          this.historyWrite.finalPatch = patch;
        } else if (
          // W12d (100-more C6): the history doc is only written after the
          // ~8s ICE + signalling sequence in startCall, so a dial
          // cancelled before that left NO history record at all. The dial
          // WAS shown (the synchronous dialling emit sets 'outgoing'), so
          // create the record here with the final status instead of
          // dropping it. 100M-H1: this branch only runs when no history
          // write exists or is in flight for this call — the startCall
          // continuation re-checks callId/pc after the signal write, and
          // an in-flight write takes the stash branch above. A dial that
          // died before any UI ('idle') still writes nothing.
          (prevCall.status === 'outgoing' || prevCall.status === 'connecting' || prevCall.status === 'connected') &&
          auth.currentUser
        ) {
          addDoc(collection(db, 'calls') as any, {
            callerId: auth.currentUser.uid,
            callerName: auth.currentUser.displayName || auth.currentUser.username || 'User',
            callerAvatar: auth.currentUser.photoURL || '',
            receiverId: prevCall.remoteUserId,
            receiverName: prevCall.remoteName || 'User',
            receiverAvatar: prevCall.remoteAvatar || '',
            type: prevCall.type,
            timestamp: serverTimestamp(),
            // Audit H3-1: same exact key (sigId is this call's signal
            // doc id) as the startCall write.
            signalId: sigId,
            ...patch,
          } as any).catch((err) => console.warn("[callService] endCall: late history addDoc failed", err));
        }
      } else if (prevCall.isIncoming && prevCall.status !== 'ended' && prevCall.status !== 'connected') {
        // Phase 3 — incoming call that never connected: the callee gets a
        // missed/declined/unanswered record (previously nothing was written).
        // Worker C: a callee who ACCEPTED ('connecting') and then lost the
        // connection is 'failed', not 'missed' — they did answer.
        const status: CallEndReason =
          endReason === 'declined' ? 'declined' : endReason === 'failed' ? 'failed' : endReason === 'unanswered' ? 'unanswered' : endReason === 'acceptedElsewhere' ? 'acceptedElsewhere' : 'missed';
        // W24: sigId is this call's signal doc — mark it so a reload
        // re-delivering the 'ended' doc cannot record this call twice.
        this.recordCalleeCall(
          {
            callerId: prevCall.remoteUserId,
            callerName: prevCall.remoteName,
            callerAvatar: prevCall.remoteAvatar,
            type: prevCall.type,
          },
          status,
          0,
          sigId,
        );
      } else if (prevCall.isIncoming && prevCall.status === 'connected') {
        // Answered incoming call: record it as completed for the callee too.
        this.recordCalleeCall(
          {
            callerId: prevCall.remoteUserId,
            callerName: prevCall.remoteName,
            callerAvatar: prevCall.remoteAvatar,
            type: prevCall.type,
          },
          'completed',
          prevCall.duration || 0,
          sigId,
        );
      }
    }

    // Report 3 #100 — the ended screen has no remote video anymore.
    this.detachRemoteVideoTrack();

    this.activeCall = {
      status: 'ended',
      // Worker C: keep who the call was with (and its type) in the ended
      // state — the old code blanked all of it, so the ended screen
      // could not offer Call Back and showed a nameless "Call ended".
      type: prevCall.type,
      remoteUserId: prevCall.remoteUserId,
      remoteName: prevCall.remoteName,
      remoteAvatar: prevCall.remoteAvatar,
      isIncoming: prevCall.isIncoming,
      duration: prevCall.duration,
      localStream: null,
      remoteStream: null,
      isMuted: false,
      isVideoEnabled: true,
      facingMode: 'user',
      isSpeaker: false,
      isScreenSharing: false,
      videoFilter: 'none',
      videoFilterNotice: null,
      screenStream: null,
      remoteVideoEnabled: false,
      isAudioOnly: false,
      connectionQuality: 'unknown',
      callError: failDetail || (endReason === 'failed' ? DEFAULT_CONNECT_FAILED : null),
      // WA audit #6/#10 — the permission explainer survives into the
      // ended state so CallModal can show it over the ended screen.
      permissionNotice: permissionNotice ?? prevCall.permissionNotice ?? null,
      // 100M-H4: user-facing reason for a clean end that never
      // connected — declined / no answer / cancelled / busy / missed.
      // A connected call that ends normally gets no reason line (its
      // endReason is still the 'cancelled' default from dial time),
      // and a failed end gets none either (callError covers it).
      endReasonText:
        prevCall.status === 'connected' ? null : (END_REASON_TEXT[endReason] ?? null),
      // #4/#8: the failed step + frozen diagnostics ride into the ended
      // state so the ended screen can name the step and offer a copy.
      failedStep: failedStep || (endReason === 'failed' ? 'failed' : null),
      callDiagnostics: diagnosticsText,
      waitingCall: null,
      // WA audit #27 — a reaction accepted in the same snapshot as
      // the hang-up (parsed before the status branches) survives into
      // the ended state instead of being discarded by this literal;
      // CallModal still hides floats on the ended screen.
      callReactions: prevCall.callReactions ?? [],
      isDndOn: prevCall.isDndOn ?? getCallPrefs().doNotDisturb,
      audioDevices: [],
      currentAudioDevice: null,
      audioRouteError: null,
      bluetoothDenied: false,
      audioInputDeviceId: null,
    };
    this.emit();

    // Worker C: a failed call stays on the ended screen for 5 s so the
    // user can actually read why it failed and tap Call Back; a clean
    // end stays for 3 s so Call Back is reachable (100M-H5: the old
    // 600 ms dismissed the screen before the user could tap it).
    const dismissDelay = failDetail || endReason === 'failed' ? 5000 : 3000;
    // W12d (100-more C2): re-arm while a decline-with-message send is
    // in flight, so the modal is still mounted when the result arrives;
    // holdEndedScreen() cancels the timer once the result is on screen.
    const armDismiss = () => {
      this.dismissTimer = setTimeout(() => {
        if (this.activeCall.status !== 'ended') return;
        // ROADMAP-2 #13: a swap is mid-flight — acceptCallWith owns the
        // transition from here, and the parked call must not promote
        // while the new call is connecting.
        if (this.swappingToWaiting) return;
        if (this.declineMessagePending) {
          armDismiss();
          return;
        }
        this.activeCall.status = 'idle';
        this.emit();
        this.maybePromoteWaiting();
      }, dismissDelay);
    };
    armDismiss();
  }

  /** Worker C: dismiss the ended screen immediately (Close button). */
  public dismissEnded() {
    if (this.activeCall.status !== 'ended') return;
    this.activeCall.status = 'idle';
    this.activeCall.callError = null;
    this.activeCall.endReasonText = null;
    this.activeCall.failedStep = null;
    this.activeCall.callDiagnostics = null;
    this.activeCall.permissionNotice = null;
    this.pendingPermissionNotice = null;
    this.emit();
    // ROADMAP-2 #13: a parked call carried past endCall rings now that
    // the user is free (same as the auto-dismiss path above).
    this.maybePromoteWaiting();
  }

  private startDurationTimer() {
    if (this.durationTimer) clearInterval(this.durationTimer);
    this.activeCall.duration = 0;
    this.durationTimer = setInterval(() => {
      this.activeCall.duration += 1;
      this.emit();
    }, 1000);
  }

  /**
   * WA audit #32/#7 — call-quality grade from RTCPeerConnection.getStats.
   * The old UI was binary (Connected / Reconnecting) and the service
   * already graded 'good'/'poor' from connectionState alone
   * (connecting → poor). This sampler refines the grade while connected:
   * RTT (nominated candidate-pair currentRoundTripTime), jitter and
   * packet loss (inbound-rtp audio) — WA's NetHealthStatus model, same
   * 2 s cadence as the frozen-video check. Thresholds are the usual
   * VoIP ones (RTT > 300 ms, jitter > 100 ms, loss > 5% → poor).
   * Best-effort and silent: a getStats failure never touches the call.
   * Never overrides 'reconnecting' (the connection-state handler owns
   * that) and stops with the call (endCall / dispose).
   */
  private startQualitySampler() {
    this.stopQualitySampler();
    this.qualityTimer = setInterval(() => {
      void this.sampleCallQuality();
    }, 2000);
  }

  private stopQualitySampler() {
    if (this.qualityTimer) {
      clearInterval(this.qualityTimer);
      this.qualityTimer = null;
    }
  }

  private async sampleCallQuality() {
    const pc = this.pc;
    if (!pc || this.activeCall.status !== 'connected') return;
    if (this.activeCall.connectionQuality === 'reconnecting') return;
    try {
      const stats = await pc.getStats();
      let rtt: number | null = null;
      let jitter: number | null = null;
      let lost = 0;
      let received = 0;
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && typeof r.currentRoundTripTime === 'number') {
          rtt = r.currentRoundTripTime;
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          if (typeof r.jitter === 'number') jitter = jitter === null ? r.jitter : Math.max(jitter, r.jitter);
          lost += r.packetsLost || 0;
          received += r.packetsReceived || 0;
        }
      });
      const lossRatio = received + lost > 0 ? lost / (received + lost) : 0;
      const poor = (rtt !== null && rtt > 0.3) || (jitter !== null && jitter > 0.1) || lossRatio > 0.05;
      this.setConnectionQuality(poor ? 'poor' : 'good');
    } catch {
      // Best-effort: stats are advisory, never call-breaking.
    }
  }

  // ── In-Call Hardware Controls ──
  /**
   * WA audit #27 — send an emoji reaction on the live call. The
   * reaction floats on the other side's call screen (and on mine —
   * it is appended locally first, so there is no round-trip wait).
   * Signalled as one `reaction_<id>` field on the existing `callsig`
   * doc, so no new backend service is needed and simultaneous sends
   * from both sides cannot overwrite each other (updateDoc merges).
   * Allowed while 'connected' or 'connecting' (the signal doc exists
   * from the ring on, and headless ICE can never reach 'connected' —
   * the connecting window is the only live call a probe can hold).
   * Returns false when there is no live call or the emoji is not in
   * the set — the picker then says so in the hint line instead of
   * pretending the reaction went out.
   */
  public sendCallReaction(emoji: string): boolean {
    if (!(CALL_REACTION_EMOJIS as readonly string[]).includes(emoji)) return false;
    if (!this.callId) return false;
    if (this.activeCall.status !== 'connected' && this.activeCall.status !== 'connecting') return false;
    const reaction: CallReaction = {
      id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      emoji,
      from: this.initializedUserId || auth.currentUser?.uid || '',
      at: Date.now(),
    };
    this.seenReactionIds.add(reaction.id);
    const list = this.activeCall.callReactions ?? (this.activeCall.callReactions = []);
    list.push(reaction);
    while (list.length > 12) list.shift();
    this.emit();
    updateDoc(doc(db, SIG_COL, this.callId) as any, { [`reaction_${reaction.id}`]: reaction }).catch((err) =>
      console.warn('[callService] sendCallReaction: updateDoc failed', err),
    );
    return true;
  }

  /**
   * WA audit #37 — keypad / DTMF (IVR, banking). Sends one DTMF tone
   * over the local audio sender (RTCDTMFSender.insertDTMF). Returns
   * false when there is no live audio sender (not connected, no mic
   * track, or a browser without DTMF) — the keypad then says so in
   * the hint line instead of pretending the tone went out. The keypad
   * layout itself is the standard telephone 3×4 grid; the exact WA
   * phone keypad layout still needs a real-device check (audit #37).
   */
  public sendDtmf(digit: string): boolean {
    if (!/^[0-9*#]$/.test(digit)) return false;
    const pc = this.pc;
    if (!pc || this.activeCall.status !== 'connected') return false;
    try {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      const dtmf = sender?.dtmf;
      if (!dtmf || typeof dtmf.insertDTMF !== 'function') return false;
      dtmf.insertDTMF(digit, 100, 70);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * WA audit #60 — the chat-list ongoing-call row calls this to bring
   * the minimised call back full-screen. CallModal watches
   * restoreToken and un-minimises; the service itself needs no
   * minimise state (that lives in the modal).
   */
  public requestRestore() {
    if (this.activeCall.status === 'idle' || this.activeCall.status === 'ended') return;
    this.activeCall.restoreToken = (this.activeCall.restoreToken ?? 0) + 1;
    this.emit();
  }

  /** WA audit #6/#10 — close the permission/support explainer modal. */
  public dismissPermissionNotice() {
    this.activeCall.permissionNotice = null;
    this.pendingPermissionNotice = null;
    this.emit();
  }

  private setPermissionNotice(kind: 'unsupported' | 'mic-denied') {
    const detail =
      kind === 'unsupported'
        ? 'Calls are not supported on this device or browser — no microphone or camera access is available.'
        : 'Microphone permission is denied. Allow it in Settings → Apps → Pinglo → Permissions, then try again.';
    this.activeCall.permissionNotice = { kind, detail };
    this.emit();
  }

  /**
   * WA audit #6/#10 — pre-call support + mic-permission check, run
   * before a dial acquires media. 'unsupported' = no getUserMedia /
   * RTCPeerConnection at all (WA's CallsNotSupportedModal case);
   * 'mic-denied' = the Permissions API already knows the mic is
   * denied. Only a hard 'denied' blocks — 'prompt' or an unavailable
   * Permissions API falls through to getUserMedia, whose failure path
   * (ended screen + pendingPermissionNotice) still explains itself.
   * The camera is deliberately NOT checked: it is best-effort and a
   * denied camera must never kill a call (see getCallMedia).
   */
  private async checkCallSupport(): Promise<'ok' | 'unsupported' | 'mic-denied'> {
    if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unsupported';
    try {
      const perms = (navigator as any).permissions;
      if (perms?.query) {
        const mic = await perms.query({ name: 'microphone' });
        if (mic?.state === 'denied') return 'mic-denied';
      }
    } catch {
      // Permissions API unavailable — fall through to getUserMedia.
    }
    return 'ok';
  }

  public toggleMute() {
    const nextMute = !this.activeCall.isMuted;
    this.activeCall.isMuted = nextMute;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((t) => {
        t.enabled = !nextMute;
      });
    }
    this.emit();
  }

  /**
   * Report 3 #9/#10 — the Speaker button now cycles through the ACTUAL
   * available outputs (earpiece → speaker → Bluetooth headset → wired
   * headset → …) instead of only toggling builtin speaker/earpiece.
   * With no headset connected it behaves exactly like the old toggle.
   * Returns true when the route actually changed (errors surface on
   * `audioRouteError` — a failure is no longer reported as success).
   */
  public async toggleSpeaker() {
    const res = await this.cycleAudioOutput();
    return res.ok;
  }

  /**
   * 100M-H9 — voice → video upgrade mid-call. A voice call has no video
   * m-line and no camera track, so the old Video button was hard-disabled
   * (`disabled={!isVideo}` in CallModal) and toggleVideo() could only
   * flip tracks that already existed. Flipping `type` to 'video' once
   * the camera is actually acquired is what makes the upgrade real:
   * CallModal keys its whole video layout (PiP, remote video, Flip,
   * screen-share, filters) off `type`, and reconcileVideoOnConnect +
   * the history write read it too. The flip happens ONLY after the
   * camera track exists (or, on the peer side, after an offer carrying
   * `m=video` is applied) — never optimistically, so a failed camera
   * can never leave a "video" call with no picture.
   */
  private markVideoUpgraded() {
    if (this.activeCall.type === 'video') return;
    this.activeCall.type = 'video';
    this.activeCall.isAudioOnly = false;
    this.recordDiag('voice-upgraded-to-video', 'voice call upgraded to video mid-call');
  }

  /**
   * Wave-2 B1 (WA audit Calls #26) — peer-visible video filters.
   *
   * The old Filter button only set a CSS `filter` on the local preview
   * `<video>`; the peer always received the raw camera track. Now the
   * selected filter is baked into the OUTGOING track: the raw camera
   * track plays in a hidden `<video>`, a rAF loop draws it onto a
   * canvas with `ctx.filter` set to the same CSS value the preview
   * uses, and the canvas `captureStream(30)` track replaces the camera
   * track on the video sender (`replaceTrack` — no renegotiation, the
   * peer just starts receiving filtered frames). Selecting 'none'
   * swaps the raw camera track back in. The raw track is never
   * stopped while filtering, so toggling is instant and lossless.
   *
   * Returns false (with `videoFilterNotice` set for the UI) when there
   * is no live camera track to filter (voice call / camera off /
   * audio-only fallback), while screen-sharing (the shared screen is
   * sent unfiltered — the Filter button is hidden then), or when the
   * browser cannot canvas-process video (`captureStream` / `ctx.filter`
   * missing). The filter choice does NOT persist across calls: a new
   * call starts unfiltered, like WhatsApp's per-call effects.
   */
  public getVideoFilter(): CallVideoFilter {
    return this.videoFilterId;
  }

  public async setVideoFilter(id: CallVideoFilter): Promise<boolean> {
    if (id === this.videoFilterId) return true;
    if (id === 'none') {
      await this.stopVideoFilterProcessing(true);
      this.videoFilterId = 'none';
      this.activeCall.videoFilter = 'none';
      this.activeCall.videoFilterNotice = null;
      this.emit();
      return true;
    }
    if (this.activeCall.isScreenSharing || this.screenStream) {
      this.activeCall.videoFilterNotice = 'Filters are off while sharing your screen';
      this.emit();
      return false;
    }
    if (this.activeCall.type !== 'video') {
      this.activeCall.videoFilterNotice = 'Turn on video to use a filter';
      this.emit();
      return false;
    }
    const source = this.localStream
      ?.getVideoTracks()
      .find((t) => t.readyState === 'live' && t.enabled);
    if (!source) {
      this.activeCall.videoFilterNotice = 'Turn your camera on to use a filter';
      this.emit();
      return false;
    }
    if (!this.pc || this.pc.signalingState === 'closed') {
      this.activeCall.videoFilterNotice = 'No call to apply a filter to yet';
      this.emit();
      return false;
    }
    this.videoFilterId = id;
    this.activeCall.videoFilter = id;
    this.activeCall.videoFilterNotice = null;
    const started = await this.startVideoFilterProcessing();
    if (!started) {
      // Wave-2 B1 retry-7 gap (3): only reset when this tap is still
      // the current choice. A newer tap may have superseded it while
      // the start was in flight (the start bails as superseded) — that
      // tap owns the state now, and resetting here would clobber it
      // with a bogus "can't apply" notice for a failure that never
      // happened. A genuine failure (no canvas support, dead track)
      // still resets honestly, because the id is unchanged.
      if (this.videoFilterId === id) {
        this.videoFilterId = 'none';
        this.activeCall.videoFilter = 'none';
        this.activeCall.videoFilterNotice =
          'This device can’t apply video filters — sending your video unfiltered';
        this.emit();
      }
      return false;
    }
    this.emit();
    return true;
  }

  /** Start (or restart) the canvas pipeline for the current filter. */
  private async startVideoFilterProcessing(): Promise<boolean> {
    // Wave-2 B1 retry-7 gap (3): a start already in flight is NOT a
    // failure. Rapid taps used to hit this guard and return false, so
    // setVideoFilter() reset the choice to 'none' with a "can't apply"
    // notice even though nothing had failed — and the in-flight start
    // could still land, leaving the peer filtered while the UI said
    // 'none'. Wait for the in-flight start to settle, then start with
    // the CURRENT filter id. Only a start that never settles within
    // the bound returns false here.
    if (this.filterStarting) {
      const deadline = Date.now() + 5000;
      while (this.filterStarting && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (this.filterStarting) return false;
    }
    if (this.videoFilterId === 'none') return false;
    // The id this start is for. If the user taps another filter (or
    // 'none') while this start awaits video.play()/replaceTrack, the
    // newer tap owns the state — bail out without touching the sender
    // instead of landing a stale filter after it.
    const id = this.videoFilterId;
    const css = CALL_VIDEO_FILTER_CSS[id];
    const source = this.localStream
      ?.getVideoTracks()
      .find((t) => t.readyState === 'live');
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === 'video');
    if (!source || !sender || !this.pc) return false;
    // Canvas 2D `filter` + captureStream are the whole mechanism — if
    // either is missing there is no honest fallback (a CSS-only preview
    // would lie about what the peer sees), so refuse instead.
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx || !('filter' in ctx) || typeof canvas.captureStream !== 'function') return false;
    this.filterStarting = true;
    try {
      // Stop any previous pipeline first (camera flip / re-acquire /
      // filter change) without restoring the raw track — the new
      // filtered track replaces it below.
      this.stopVideoFilterProcessingSync();
      const settings = source.getSettings();
      // Aspect-preserving size (see fitFilteredCanvasSize): a portrait
      // source keeps its portrait canvas for the peer.
      const sized = fitFilteredCanvasSize(settings.width || 0, settings.height || 0);
      canvas.width = sized.width;
      canvas.height = sized.height;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([source]);
      await video.play().catch(() => undefined);
      if (this.videoFilterId !== id) {
        // Superseded while starting — drop this start's local pieces
        // and let the newer tap's start own the sender.
        try { video.pause(); } catch { /* already stopped */ }
        video.srcObject = null;
        return false;
      }
      const stream = canvas.captureStream(30);
      const filteredTrack = stream.getVideoTracks()[0];
      if (!filteredTrack) {
        try { video.pause(); } catch { /* already stopped */ }
        video.srcObject = null;
        stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
        return false;
      }
      this.filterCanvas = canvas;
      this.filterCtx = ctx;
      this.filterVideo = video;
      this.filterStream = stream;
      this.filterSourceTrack = source;
      // If the camera track dies (toggle-off / end), drop the
      // filter rather than sending a frozen black frame forever.
      // A flip swaps the track out of localStream first, so a track
      // that is no longer the local camera track is NOT a death —
      // switchCamera re-applies the filter to the new track itself.
      const onSourceEnded = () => {
        if (this.filterSourceTrack === source && this.localStream?.getVideoTracks().includes(source)) {
          void this.setVideoFilter('none');
        }
      };
      source.addEventListener('ended', onSourceEnded);
      const draw = () => {
        if (this.filterSourceTrack !== source || !this.filterCtx || !this.filterCanvas) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          // Re-fit only when the source dims actually changed (e.g.
          // rotation); aspect-preserving, so the peer never gets a
          // squashed frame. Resizing clears the canvas — the next
          // frame redraws it immediately.
          const fitted = fitFilteredCanvasSize(video.videoWidth, video.videoHeight);
          if (this.filterCanvas.width !== fitted.width || this.filterCanvas.height !== fitted.height) {
            this.filterCanvas.width = fitted.width;
            this.filterCanvas.height = fitted.height;
          }
          this.filterCtx.filter = css;
          this.filterCtx.drawImage(video, 0, 0, this.filterCanvas.width, this.filterCanvas.height);
        }
        this.filterRaf = requestAnimationFrame(draw);
      };
      this.filterRaf = requestAnimationFrame(draw);
      if (this.videoFilterId !== id) {
        // Superseded between building the pipeline and swapping the
        // track — tear the local pieces down without touching the
        // sender; the newer tap's start replaces the track itself.
        this.stopVideoFilterProcessingSync();
        return false;
      }
      await sender.replaceTrack(filteredTrack);
      this.recordDiag('video-filter-on', `outgoing track filtered: ${this.videoFilterId}`);
      return true;
    } catch (e) {
      console.warn('[callService] video filter failed:', e);
      this.stopVideoFilterProcessingSync();
      return false;
    } finally {
      this.filterStarting = false;
    }
  }

  /** Stop the canvas pipeline; optionally swap the raw camera track back in. */
  private async stopVideoFilterProcessing(restoreRaw: boolean): Promise<void> {
    const source = this.filterSourceTrack;
    this.stopVideoFilterProcessingSync();
    if (restoreRaw && source && source.readyState === 'live' && this.pc) {
      try {
        const sender = this.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && sender.track !== source) await sender.replaceTrack(source);
      } catch (e) {
        console.warn('[callService] video filter restore failed:', e);
      }
    }
  }

  /** Synchronous half of stopVideoFilterProcessing (also used mid-start). */
  private stopVideoFilterProcessingSync(): void {
    if (this.filterRaf !== null) {
      cancelAnimationFrame(this.filterRaf);
      this.filterRaf = null;
    }
    if (this.filterVideo) {
      try { this.filterVideo.pause(); } catch { /* already stopped */ }
      this.filterVideo.srcObject = null;
      this.filterVideo = null;
    }
    if (this.filterStream) {
      this.filterStream.getTracks().forEach((t) => { try { t.stop(); } catch { /* already stopped */ } });
      this.filterStream = null;
    }
    this.filterCanvas = null;
    this.filterCtx = null;
    this.filterSourceTrack = null;
  }

  /**
   * Re-attach the currently selected filter after the camera track was
   * swapped underneath it (camera re-acquire, camera flip, screen-share
   * end). No-op when no filter is selected. If the pipeline cannot
   * restart, the filter is dropped honestly instead of claiming a
   * filter the peer is not receiving.
   */
  private async reapplyVideoFilter(): Promise<void> {
    if (this.videoFilterId === 'none') return;
    if (this.activeCall.isScreenSharing || this.activeCall.status === 'ended' || this.activeCall.status === 'idle') return;
    const started = await this.startVideoFilterProcessing();
    if (!started) {
      this.videoFilterId = 'none';
      this.activeCall.videoFilter = 'none';
      this.activeCall.videoFilterNotice = 'Video filter stopped — sending your video unfiltered';
      this.emit();
    }
  }

  /**
   * Report 3 #114 — turning the camera back ON after it failed at dial
   * (or died mid-call) must actually re-acquire it. The old toggle only
   * flipped `enabled` on the tracks it already had: with zero video
   * tracks (audio-only fallback) it set `isVideoEnabled = true` while
   * sending nothing — the button lied and the peer saw a black tile.
   *
   * Now: no live video track → re-acquire the camera (video-only, 6 s
   * cap, same as getCallMedia) and attach it to the local stream and
   * the peer connection; only then is the camera "on". A failed
   * re-acquire leaves the camera off and says so (videoNotice).
   * The new track reaches the peer via replaceTrack (a video sender
   * already exists), via a plain reoffer (connected/connecting), or —
   * while still ringing — by rewriting the ringing offer, which the
   * callee picks up through the pendingOffer refresh in
   * onSignalSnapshot. Returns true when video ends up on.
   * 100M-H9: on a VOICE call this is the upgrade path — a successful
   * re-acquire also flips `type` to 'video' (see markVideoUpgraded),
   * so the UI switches to the video layout and the peer negotiates
   * the new m-line.
   */
  public async toggleVideo(): Promise<boolean> {
    const nextVideo = !this.activeCall.isVideoEnabled;
    // Turning off: same as before — disable the tracks we have.
    // Wave-2 B1: if a filter is on, the sender holds the filtered
    // track, not the raw one — swap the raw track back in first so
    // the disable below actually stops what the peer receives. The
    // filter choice itself is kept and re-applied on toggle-on.
    if (!nextVideo) {
      await this.stopVideoFilterProcessing(true);
      this.activeCall.isVideoEnabled = false;
      this.activeCall.videoNotice = null;
      if (this.localStream) {
        this.localStream.getVideoTracks().forEach((t) => {
          t.enabled = false;
        });
      }
      this.emit();
      return false;
    }
    // Turning on with a live track: just enable it (old behaviour).
    const liveTrack = this.localStream
      ?.getVideoTracks()
      .find((t) => t.readyState === 'live');
    if (liveTrack) {
      // 100M-H9: a voice call that somehow already holds a live video
      // track (e.g. screen share started it) is a video call now.
      this.markVideoUpgraded();
      this.activeCall.isVideoEnabled = true;
      this.activeCall.videoNotice = null;
      this.localStream?.getVideoTracks().forEach((t) => {
        t.enabled = true;
      });
      // Wave-2 B1: the camera is back — re-attach the kept filter.
      await this.reapplyVideoFilter();
      this.emit();
      return true;
    }
    // No live video track — re-acquire the camera (best-effort).
    if (
      !this.localStream ||
      this.activeCall.status === 'idle' ||
      this.activeCall.status === 'ended'
    ) {
      return false;
    }
    const streamAtStart = this.localStream;
    try {
      const videoOnly = await this.gum(
        {
          video: {
            facingMode: this.activeCall.facingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        6_000,
      );
      // Call ended (or stream swapped) while acquiring — don't leak a track.
      // NOTE: read via getStatus() on purpose — the pre-acquire guard above
      // narrows this.activeCall.status to the four live states, so TS would
      // flag direct 'idle'/'ended' comparisons as unintentional even though
      // the call can genuinely end during the up-to-6 s camera acquisition.
      // A method call returns the full CallStatus union, so no narrowing.
      const statusAfterAcquire = this.getStatus();
      if (
        this.localStream !== streamAtStart ||
        statusAfterAcquire === 'idle' ||
        statusAfterAcquire === 'ended'
      ) {
        videoOnly.getTracks().forEach((t) => t.stop());
        return false;
      }
      const newTrack = videoOnly.getVideoTracks()[0];
      if (!newTrack) {
        videoOnly.getTracks().forEach((t) => t.stop());
        throw new Error('no video track');
      }
      this.localStream.addTrack(newTrack);
      if (this.pc) {
        const videoSender = this.pc
          .getSenders()
          .find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
        } else {
          this.pc.addTrack(newTrack, this.localStream);
          if (
            this.activeCall.status === 'connected' ||
            this.activeCall.status === 'connecting'
          ) {
            // New m-line needs a fresh offer — plain reoffer, NOT an
            // ICE restart (that budget is 2/call and is for ICE recovery).
            await this.renegotiateVideo();
          } else if (this.activeCall.status === 'outgoing') {
            // Unanswered: rewrite the ringing offer in place (status
            // stays 'ringing') so the callee's accept negotiates video.
            await this.rewriteRingingOffer();
          }
        }
      }
      this.videoCaptureFailed = false;
      // 100M-H9: the camera is live — a voice call that just gained a
      // camera is a video call now (UI layout, reconcile, history).
      this.markVideoUpgraded();
      this.activeCall.isVideoEnabled = true;
      this.activeCall.videoNotice = null;
      this.activeCall.localStream = this.localStream;
      // Wave-2 B1: the re-acquired track is raw — re-attach the filter.
      await this.reapplyVideoFilter();
      this.emit();
      return true;
    } catch (err: any) {
      this.videoCaptureFailed = true;
      this.activeCall.isVideoEnabled = false;
      this.activeCall.videoNotice = 'Camera still unavailable — staying audio-only';
      this.recordDiag('camera-reacquire-failed', err?.name || 'unknown error');
      this.emit();
      return false;
    }
  }

  /**
   * Report 3 #114 — plain (non-ICE-restart) renegotiation that adds the
   * video m-line after a camera re-enable. Unlike tryIceRestart it does
   * NOT consume the 2-per-call ICE restart budget and does not re-gather
   * ICE — it only re-offers so the peer negotiates video. The peer
   * answers via the same handleReoffer() path as an ICE restart.
   */
  private async renegotiateVideo(): Promise<boolean> {
    const pc = this.pc;
    const callId = this.callId;
    if (!pc || !callId) return false;
    if (pc.signalingState === 'closed') return false;
    if (
      this.activeCall.status !== 'outgoing' &&
      this.activeCall.status !== 'connecting' &&
      this.activeCall.status !== 'connected'
    ) {
      return false;
    }
    if (this.videoRenegotiating) return false;
    this.videoRenegotiating = true;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIce(pc);
      if (this.pc !== pc || this.callId !== callId) return false;
      await updateDoc(doc(db, SIG_COL, callId) as any, {
        offer: pc.localDescription?.sdp || '',
        status: 'reoffer',
        reofferBy: this.role,
        reofferAt: Date.now(),
      });
      this.recordDiag('video-renoffer-sent', 'camera re-enabled — video m-line renegotiated');
      return true;
    } catch (e) {
      console.warn('Video renegotiation failed:', e);
      this.recordDiag('video-renoffer-failed', e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      this.videoRenegotiating = false;
    }
  }

  /**
   * Report 3 #114 — while the call is still ringing, the offer on the
   * signal doc is the one the callee will accept from, so a camera
   * re-enable rewrites it in place (status stays 'ringing' — a
   * 'reoffer' here would be dropped, the callee has no pc yet). The
   * callee picks the new offer up via the pendingOffer refresh in
   * onSignalSnapshot; if it already accepted the old offer, the
   * on-connect reconcile below renegotiates instead.
   */
  private async rewriteRingingOffer(): Promise<boolean> {
    const pc = this.pc;
    const callId = this.callId;
    if (!pc || !callId) return false;
    if (pc.signalingState === 'closed') return false;
    if (this.activeCall.status !== 'outgoing') return false;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.waitForIce(pc);
      if (this.pc !== pc || this.callId !== callId) return false;
      await updateDoc(doc(db, SIG_COL, callId) as any, {
        offer: pc.localDescription?.sdp || '',
      });
      this.recordDiag('ringing-offer-rewritten', 'camera re-enabled mid-ring — offer now carries video');
      return true;
    } catch (e) {
      console.warn('Ringing offer rewrite failed:', e);
      this.recordDiag('ringing-offer-rewrite-failed', e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /**
   * Report 3 #114 — called once, when the connection flips to
   * 'connected'. Covers the race where the callee accepted the
   * pre-video offer (before the rewritten ringing offer arrived):
   * the pc then has a video sender whose m-line was never negotiated
   * (local SDP has no `m=video`), so the peer would never receive
   * video. Renegotiate once so it flows.
   */
  private async reconcileVideoOnConnect(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.activeCall.type !== 'video') return;
    const liveVideo = this.localStream
      ?.getVideoTracks()
      .some((t) => t.readyState === 'live');
    if (!liveVideo) return;
    if ((pc.localDescription?.sdp || '').includes('m=video')) return;
    const track = this.localStream
      ?.getVideoTracks()
      .find((t) => t.readyState === 'live');
    if (!track) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) pc.addTrack(track, this.localStream as MediaStream);
    await this.renegotiateVideo();
  }

  // ── Phase 4 — Screen share (video calls) ──────────────────────────────
  // Shares the screen via getDisplayMedia and swaps the outgoing video
  // track with replaceTrack (same pattern switchCamera uses), so the peer
  // connection is never renegotiated. The camera track is kept and restored
  // on stop. If the user cancels the browser's share picker, getDisplayMedia
  // rejects with NotAllowedError/AbortError — that is a graceful no-op
  // ('cancelled'), not an error. The remote side needs a compatible client:
  // it just receives a video track, so any client that renders remote video
  // shows the shared screen; older clients that only render a camera feed
  // still show it as the remote video.
  public async startScreenShare(): Promise<'started' | 'cancelled' | 'unsupported' | 'not-in-call' | 'failed'> {
    if (this.activeCall.status !== 'connected' || !this.pc || !this.localStream) {
      return 'not-in-call';
    }
    if (this.screenStream) return 'started'; // already sharing
    const gdm = navigator.mediaDevices?.getDisplayMedia;
    if (typeof gdm !== 'function') return 'unsupported';
    try {
      const screen = await gdm.call(navigator.mediaDevices, { video: true, audio: false });
      const screenTrack = screen.getVideoTracks()[0];
      if (!screenTrack) {
        screen.getTracks().forEach((t) => t.stop());
        return 'cancelled';
      }
      const videoSender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      // Wave-2 B1: the shared screen is sent unfiltered — park the
      // filter pipeline (the choice is kept and re-applied by
      // stopScreenShare); the raw camera track is parked below.
      this.stopVideoFilterProcessingSync();
      // Keep the camera track so stopScreenShare can restore it.
      this.cameraVideoTrack = this.localStream.getVideoTracks()[0] || null;
      if (videoSender) {
        await videoSender.replaceTrack(screenTrack);
      } else {
        // WA audit #25 — audio-only negotiated video call (camera failed
        // at dial/connect): there is no video sender and no `m=video`
        // in the local SDP, so a bare addTrack would never reach the
        // peer — the old code then told the user "the other side sees
        // it as your video" while the peer saw nothing. Renegotiate
        // (same proven path as the camera re-enable in
        // reconcileVideoOnConnect) so the screen track is actually
        // negotiated; if that fails, stop the capture and say so
        // instead of claiming success.
        this.pc.addTrack(screenTrack, screen);
        if (!(await this.renegotiateVideo())) {
          screen.getTracks().forEach((t) => t.stop());
          this.cameraVideoTrack = null;
          return 'failed';
        }
      }
      this.screenStream = screen;
      this.activeCall.isScreenSharing = true;
      // Report 3 #107 — expose the screen stream so the call UI can
      // preview what the other side sees (PiP) instead of the parked
      // camera while sharing.
      this.activeCall.screenStream = screen;
      this.emit();
      // The user stopped sharing from the browser/OS chrome: restore camera.
      screenTrack.addEventListener('ended', () => {
        if (this.screenStream === screen) void this.stopScreenShare();
      });
      return 'started';
    } catch (e: any) {
      // User pressed Cancel in the picker, or the browser blocked it.
      if (e?.name === 'NotAllowedError' || e?.name === 'AbortError' || e?.name === 'NotFoundError') {
        return 'cancelled';
      }
      // WA audit #25 — a real capture failure (e.g. NotReadableError)
      // is not "unsupported": report it honestly so the UI says "try
      // again" instead of "not supported on this device/browser".
      console.warn('Screen share failed:', e);
      return 'failed';
    }
  }

  public async stopScreenShare(): Promise<void> {
    const screen = this.screenStream;
    if (!screen && !this.activeCall.isScreenSharing) return;
    this.screenStream = null;
    try {
      if (this.pc) {
        const videoSender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        const cameraTrack = this.cameraVideoTrack;
        if (videoSender && cameraTrack && cameraTrack.readyState === 'live') {
          await videoSender.replaceTrack(cameraTrack);
        } else if (videoSender) {
          await videoSender.replaceTrack(null);
        }
      }
    } catch (e) {
      console.warn('Could not restore camera track after screen share:', e);
    } finally {
      screen?.getTracks().forEach((t) => t.stop());
      this.cameraVideoTrack = null;
      this.activeCall.isScreenSharing = false;
      this.activeCall.screenStream = null;
      // Wave-2 B1: the camera track is back — re-attach the filter.
      await this.reapplyVideoFilter();
      this.emit();
    }
  }

  /** Stop any screen share without touching the rest of the call (endCall/cleanup). */
  private stopScreenShareSilently() {
    const screen = this.screenStream;
    this.screenStream = null;
    this.cameraVideoTrack = null;
    this.activeCall.isScreenSharing = false;
    this.activeCall.screenStream = null;
    screen?.getTracks().forEach((t) => {
      try { t.stop(); } catch (err) { console.warn("[callService] stopScreenShareSilently: t.stop() failed", err); }
    });
  }

  /**
   * Report 3 #104 — flip camera now REPORTS its result instead of
   * silently doing nothing on failure (the old code only console.warned
   * and the button looked dead). Returns 'sharing' while the camera is
   * parked for screen share, 'not-in-call' outside a video call,
   * 'busy' while a flip is already running, 'failed' when the other
   * camera cannot be opened, 'ok' on success. facingMode is committed
   * only on success — the old code flipped it BEFORE getMedia, so a
   * failed flip left the indicator lying about which camera was live.
   */
  public async switchCamera(): Promise<'ok' | 'failed' | 'sharing' | 'not-in-call' | 'busy'> {
    if (this.screenStream) return 'sharing'; // camera is parked while screen sharing
    if (this.activeCall.type !== 'video' || !this.localStream) return 'not-in-call';
    if (this.isSwitchingCamera) return 'busy';
    this.isSwitchingCamera = true;
    const nextMode = this.activeCall.facingMode === 'user' ? 'environment' : 'user';

    try {
      const newStream = await this.getMedia('video', nextMode);
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (!newVideoTrack) {
        // The other camera could not be opened (getMedia fell back to
        // audio-only) — keep the current camera, report the failure.
        newStream.getTracks().forEach((t) => t.stop());
        return 'failed';
      }

      if (this.pc) {
        const videoSender = this.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(newVideoTrack);
        }
      }

      // The new stream's audio track is never sent (the old mic track
      // keeps running) — stop it instead of leaking a second capture.
      newStream.getAudioTracks().forEach((t) => t.stop());
      this.localStream?.getVideoTracks().forEach((t) => t.stop());
      this.localStream?.getVideoTracks().forEach((t) => this.localStream?.removeTrack(t));
      this.localStream?.addTrack(newVideoTrack);
      this.activeCall.facingMode = nextMode;
      this.activeCall.localStream = this.localStream;
      // Wave-2 B1: the flipped track is raw — re-attach the filter.
      await this.reapplyVideoFilter();
      this.emit();
      return 'ok';
    } catch (err) {
      console.warn('Switch camera error:', err);
      return 'failed';
    } finally {
      this.isSwitchingCamera = false;
    }
  }

  public cleanup() {
    this.stopRinging();
    this.clearCallTimers();
    // W24 — stop the stale-`ringing` sweep with the subscription; the
    // first-sight map itself is NOT cleared (it must survive reloads).
    this.stopStaleRingingSweep();
    this.lastRingingDocs.clear();
    // Report 3 #115 — the unload guard dies with the service.
    this.removeUnloadGuard();
    this.starting = false;
    this.accepting = false;
    // Report 3 #100 — drop the remote-video track listeners with the call.
    this.detachRemoteVideoTrack();
    this.remoteStream = null;
    // ROADMAP-2 #13: drop any parked / carried waiting call with the rest.
    this.waiting = null;
    this.pendingPromote = null;
    this.swappingToWaiting = false;
    this.clearWaitingTimeout();
    this.failDetail = null;
    this.failedStep = null;
    this.stopScreenShareSilently();
    this.stopQualitySampler();
    if (this.durationTimer) clearInterval(this.durationTimer);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      const pc = this.pc;
      this.pc = null;
      try {
        pc.close();
      } catch (err) {
        console.warn("[callService] cleanup: pc.close() failed", err);
      }
    }
    if (this.sigUnsub) {
      try {
        this.sigUnsub();
      } catch (err) {
        console.warn("[callService] cleanup: this.sigUnsub() failed", err);
      }
      this.sigUnsub = null;
    }
    this.callId = null;
    this.role = null;
    this.pendingOffer = null;
    this.seenIncoming.clear();
    this.seenMissed.clear();
    this.initializedUserId = null;
  }
}

export const callService = new CallService();
