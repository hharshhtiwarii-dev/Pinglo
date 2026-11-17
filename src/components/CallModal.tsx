import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PhoneOff, PhoneIncoming, Mic, MicOff, Video, VideoOff, Camera, Volume2, Signal, RefreshCw, WifiOff, Monitor, MonitorOff, BellOff, UserPlus, Bluetooth, Headphones, ChevronDown, Maximize2, Minimize2, MessageCircle, Send, X, Clock, Hash, Smile } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { useNavigate } from 'react-router-dom';
import { callService, ActiveCallData, CALL_VIDEO_FILTERS, CALL_REACTION_EMOJIS } from '../services/callService';
import { applyWebSinkId, type AudioDevice } from '../services/audioRoute';
import { navigationManager } from '../services/navigation';
import DefaultAvatar from './DefaultAvatar';

/**
 * WebRTC connection state, when the caller can supply it. callService
 * exposes pc state via the diagnostics trail (ActiveCallData.failedStep
 * + callDiagnostics, frozen into the ended state) and a real ICE
 * restart in the service; App.tsx passes nothing today, so the modal
 * derives a best-effort state from `callData.status` (outgoing =
 * connecting, connected = connected) and shows the "Reconnecting…" UI
 * whenever a disconnected/failed state is passed in.
 */
export type CallConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

interface CallModalProps {
  callData: ActiveCallData;
  /** Optional live connection state (from the service's RTCPeerConnection). */
  connectionState?: CallConnectionState;
}

const fmtDuration = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

interface ControlProps {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

// Round call control. "active" = white background (state on), like the reference design.
function Control({ label, icon, active = false, disabled = false, onClick }: ControlProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={`h-16 w-16 rounded-full flex items-center justify-center transition-[background-color,transform] active:scale-90 ${
          disabled
            ? 'bg-white/5 text-white/25 cursor-not-allowed'
            : active
            ? 'bg-white text-black'
            : 'bg-white/10 text-white hover:bg-white/20'
        }`}
      >
        {icon}
      </button>
      <span className={`text-xs font-medium ${disabled ? 'text-white/25' : 'text-white/80'}`}>{label}</span>
    </div>
  );
}

/** Report 3 #9/#10 — label for the current call-audio output. */
function audioOutputLabel(device?: AudioDevice | null): string {
  if (!device) return 'Speaker';
  switch (device.kind) {
    case 'earpiece':
      return 'Earpiece';
    case 'speaker':
      return 'Speaker';
    case 'bluetooth':
      return 'Bluetooth';
    case 'wired':
      return 'Headset';
    default:
      return device.name || 'Audio';
  }
}

function audioOutputIcon(device?: AudioDevice | null): React.ReactNode {
  if (!device) return <Volume2 className="h-6 w-6" />;
  switch (device.kind) {
    case 'bluetooth':
      return <Bluetooth className="h-6 w-6" />;
    case 'wired':
      return <Headphones className="h-6 w-6" />;
    default:
      return <Volume2 className="h-6 w-6" />;
  }
}

export default function CallModal({ callData, connectionState }: CallModalProps) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  // FIX #2 (one-way video): callback ref for the remote video element.
  // The remote <video> mounts only when remoteVideoLive flips true,
  // which can happen without any attach-effect dep changing (same
  // stream object) — a callback ref sets srcObject on mount regardless,
  // so a future render-path change cannot reintroduce the black video.
  // It keeps remoteVideoRef.current in sync for the frozen-frame and
  // sink-id effects that read it. The two <video> elements (main +
  // PiP) are mutually exclusive by `swapped`, so they share this ref.
  const setRemoteVideoRef = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el && callData.remoteStream) {
      el.srcObject = callData.remoteStream;
    }
  }, [callData.remoteStream]);
  const [hint, setHint] = useState('');
  // #8 — "Copy diagnostics" feedback on the ended screen.
  const [diagCopied, setDiagCopied] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  // W12d (100-more C2): decline with a quick message (WhatsApp's
  // "Reply with message"). The sheet offers three quick replies + a
  // custom line; choosing one declines the call and sends the text to
  // the caller. messageStatus holds the send result for the ended
  // screen (the auto-dismiss is held so it stays readable).
  const [showMessageSheet, setShowMessageSheet] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageStatus, setMessageStatus] = useState<'sent' | 'queued' | 'failed' | 'encryption-not-ready' | null>(null);
  // 100M-H13 — "Remind me": decline now, get reminded to call back.
  // reminderStatus is the ended-screen confirmation (same pattern as
  // messageStatus above); the sheet offers 1 h / 3 h.
  const [showRemindSheet, setShowRemindSheet] = useState(false);
  const [reminderStatus, setReminderStatus] = useState<string | null>(null);
  const navigate = useNavigate();
  // Audit #24 — focus is lost when the call ends: App keeps CallModal
  // mounted and it just returns null on `idle`, so an unmount cleanup
  // would never fire. Track the idle transition instead: remember the
  // element that had focus when a call became active, and return focus
  // to it when the modal goes back to idle (End / dismiss). If that
  // element is gone, fall back to the app's main landmark.
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const prevCallStatusRef = useRef(callData.status);
  const restoreModalFocus = () => {
    const target = focusReturnRef.current;
    focusReturnRef.current = null;
    if (target && document.contains(target)) {
      target.focus();
      return;
    }
    const main = document.querySelector('main');
    if (main instanceof HTMLElement) {
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
      main.focus();
    }
  };
  useEffect(() => {
    const prev = prevCallStatusRef.current;
    if (prev === 'idle' && callData.status !== 'idle') {
      focusReturnRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (prev !== 'idle' && callData.status === 'idle') {
      restoreModalFocus();
    }
    prevCallStatusRef.current = callData.status;
  }, [callData.status]);
  // Belt and braces: if the modal itself unmounts mid-call, still
  // return focus instead of stranding it on <body>.
  useEffect(() => () => restoreModalFocus(), []);
  const sendDeclineMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sendingMessage) return;
    setSendingMessage(true);
    setShowMessageSheet(false);
    const res = await callService.declineWithMessage(trimmed);
    setSendingMessage(false);
    setMessageStatus(res);
    callService.holdEndedScreen();
  };
  // 100M-H13 — decline now, remind later. holdEndedScreen() keeps the
  // ended screen up so the confirmation is readable (a clean end
  // otherwise dismisses in 600 ms — too fast to see it).
  const handleRemindMe = (minutes: number) => {
    setShowRemindSheet(false);
    callService.remindMeLater(minutes);
    setReminderStatus(
      minutes >= 180
        ? 'Reminder set — we\u2019ll remind you in 3 hours'
        : 'Reminder set — we\u2019ll remind you in 1 hour',
    );
    callService.holdEndedScreen();
  };
  // Wave-2 B1 (WA audit Calls #26) — peer-visible video filters.
  // The 5 filters are the same list as before, but the selection now
  // lives in callService, not in modal-local state: the service bakes
  // the filter into the OUTGOING track (canvas-processed stream via
  // replaceTrack), so the peer sees it. The local preview keeps the
  // same CSS value so the preview shows what the peer sees, and the
  // caption says so honestly. Background blur is deliberately NOT
  // offered: without a segmentation model there is no honest way to
  // blur only the background — a CSS backdrop-filter would blur the
  // whole preview, not the background.
  // callData.videoFilter is the service's mirrored state (emit on
  // every change), so the pills can never disagree with the track.
  const videoFilter = callData.videoFilter ?? 'none';
  const activeFilterCss = CALL_VIDEO_FILTERS.find(f => f.id === videoFilter)?.css || '';

  // HERMES UI cleanup: the audio-device / mic pills and the video-filter
  // pills no longer live on the main call screen (WhatsApp shows a single
  // Audio button and no filter row). They open from a sheet / toggle
  // instead — the routing and filter logic themselves are untouched.
  const [showAudioSheet, setShowAudioSheet] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  // WA audit #37 — keypad / DTMF sheet (IVR, banking). Standard
  // telephone 3×4 layout; the exact WA phone keypad layout still needs
  // a real-device check (audit #37). lastDtmf is the on-screen echo of
  // the last tone sent (DTMF itself is silent locally).
  const [showKeypad, setShowKeypad] = useState(false);
  const [lastDtmf, setLastDtmf] = useState<string | null>(null);

  // WA audit #27 — call reactions (emoji reactions in a call). The
  // picker is a bottom sheet like the keypad's; sent and received
  // reactions float up the call screen as big emoji. firstSeen is the
  // LOCAL arrival time — the sender's `at` clock can skew, so the
  // float lifetime runs from when this client first saw the reaction,
  // not from when it was sent. The tick runs only while a float is
  // live, so it expires off-screen.
  const [showReactions, setShowReactions] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const reactionSeenAtRef = useRef(new Map<string, number>());
  const callReactions = callData.callReactions ?? [];
  useEffect(() => {
    const seen = reactionSeenAtRef.current;
    const live = new Set(callReactions.map((r) => r.id));
    for (const r of callReactions) {
      if (!seen.has(r.id)) seen.set(r.id, Date.now());
    }
    // Prune ids from ended/trimmed calls so the map never grows.
    for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
  }, [callReactions]);
  const freshReactions = callReactions.filter(
    (r) => nowMs - (reactionSeenAtRef.current.get(r.id) ?? r.at) < 4000,
  );
  useEffect(() => {
    if (freshReactions.length === 0) return;
    const t = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [freshReactions.length]);
  // Deterministic horizontal slot per reaction id, so simultaneous
  // floats spread across the screen instead of stacking in one column.
  const reactionLeft = (id: string) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
    return 18 + (h % 60); // 18–78%
  };

  // Report 3 #99–#102 / #105 / #111 — call-layout state. The self-view
  // PiP is always the small view (never full-screen, #99); it can be
  // dragged to any corner and tapped to swap with the main view (#101);
  // the call can be minimised to a floating bubble (#102); the remote
  // video can be Fill/Fit (#105); a frozen remote frame is flagged
  // (#111). All of this is modal-local UI state — the call itself
  // (streams, peer connection) is untouched by any of it.
  const PIP_W = 112;
  const PIP_H = 160;
  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);
  const [pipDragging, setPipDragging] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [videoFit, setVideoFit] = useState<'cover' | 'contain'>('cover');
  const [remoteFrozen, setRemoteFrozen] = useState(false);
  // Report 3 #107 — remote screen-share label. When the other side
  // shares their screen, the shared screen arrives as their remote
  // video track, so the picture is already right (full-screen remote
  // video) but nothing said WHAT it was. A display-capture track
  // carries displaySurface ('monitor'/'window'/'browser') in its
  // settings; a camera track never does. Best-effort only: the label
  // appears when the property is present, so a browser that does not
  // report it just shows no label — never a wrong one.
  const [remoteSharingScreen, setRemoteSharingScreen] = useState(false);
  const pipDragRef = useRef<{
    pointerId: number; startX: number; startY: number;
    origX: number; origY: number; curX: number; curY: number; moved: boolean;
  } | null>(null);
  const lastRemoteTimeRef = useRef(-1);
  const frozenStrikesRef = useRef(0);

  // Effective connection state: the service-provided value wins; otherwise
  // derive it from the call status (ringing = still connecting).
  const effectiveConnection: CallConnectionState =
    connectionState ??
    (callData.status === 'connected'
      ? 'connected'
      : callData.status === 'outgoing' || callData.status === 'connecting'
      ? 'connecting'
      : 'new');
  // Worker C: the signal path can be down while ringing/connecting too
  // (App maps quality 'reconnecting' -> connectionState 'disconnected').
  // The old code only showed the pill once connected, so a dead signal
  // path during ringing looked like an endlessly ringing phone.
  // Report 3 #244 — gated to LIVE calls only (see below): before
  // connect there is no call to "drop", and the subscription check
  // behind this flag is true whenever no live subscription exists yet
  // (always, in mock/offline), so every unanswered ring showed
  // "Your network dropped" although nothing had dropped.
  const isReconnecting =
    callData.status === 'connected' && effectiveConnection === 'disconnected';
  const isConnecting = effectiveConnection === 'connecting' || effectiveConnection === 'new';

  // Report 3 #107 — while screen-sharing the local preview shows the
  // shared screen (what the other side sees), not the parked camera.
  const effectiveLocalStream =
    callData.isScreenSharing && callData.screenStream ? callData.screenStream : callData.localStream;

  // Report 3 #99/#100 — layout truth: the remote side is ALWAYS the big
  // view (avatar while ringing, video once connected, avatar again when
  // their camera is off); the self-view is ALWAYS the small PiP. The
  // old code made the self-view full-screen until connect (#99) and
  // showed a black video element when the remote camera was off (#100).
  // remoteVideoLive reads the actual remote track (live + unmuted) and
  // the service's remoteVideoEnabled flag, which the service updates
  // from the track's mute/unmute/ended events.
  // FIX #2 (one-way video): this block lives up here (not below the
  // attach effects) so the remote-attach effect can list remoteVideoLive
  // in its deps — it must re-run when the remote video element mounts.
  const remoteVideoLive =
    !!callData.remoteStream &&
    callData.remoteStream.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted) &&
    callData.remoteVideoEnabled !== false;
  // A swap only makes sense when there is a local picture to promote.
  const effectiveSwapped = swapped && !!effectiveLocalStream;
  const showRemoteVideoMain =
    callData.type === 'video' && callData.status === 'connected' && remoteVideoLive && !effectiveSwapped;
  const showRemoteVideoPip = callData.type === 'video' && effectiveSwapped && remoteVideoLive;

  // Attach local media stream (camera, or the shared screen while sharing).
  // Re-attaches when the layout moves the element (swap / minimise /
  // restore), because moving the <video> between containers remounts it
  // and a remounted element starts with no srcObject.
  useEffect(() => {
    if (localVideoRef.current && effectiveLocalStream) {
      localVideoRef.current.srcObject = effectiveLocalStream;
    }
  }, [effectiveLocalStream, callData.status, callData.isVideoEnabled, swapped, minimised]);

  // Attach remote media stream (video element for video calls, audio element always)
  // FIX #2 (one-way video): remoteVideoLive is a dep — the remote
  // <video> mounts only when it flips true, and the stream object
  // identity does not change when the video track arrives, so without
  // this dep the effect never re-runs after the element mounts and
  // srcObject stays null (black screen). The setRemoteVideoRef
  // callback below is the second line of defence (sets srcObject on
  // mount regardless of effect timing).
  useEffect(() => {
    if (remoteVideoRef.current && callData.remoteStream) {
      remoteVideoRef.current.srcObject = callData.remoteStream;
    }
    if (remoteAudioRef.current && callData.remoteStream) {
      const audio = remoteAudioRef.current;
      audio.srcObject = callData.remoteStream;
      // Worker C: play() here runs outside the accept-tap gesture, so
      // autoplay policy can reject it and the call goes silent with no
      // error. Retry on the next tap anywhere (a real user gesture).
      audio.play().catch(() => {
        const retry = () => {
          audio.play().catch(() => {});
        };
        window.addEventListener('pointerdown', retry, { once: true });
      });
    }
  }, [callData.remoteStream, callData.status, swapped, minimised, remoteVideoLive]);

  // Report 3 #101/#102 — a new peer (or a finished call) resets the
  // layout: PiP back to its default corner, views un-swapped, call
  // restored to full-screen, fit back to Fill.
  useEffect(() => {
    setPipPos(null);
    setSwapped(false);
    setVideoFit('cover');
    // W12d (100-more C2): a new peer resets the decline-message state
    // so a previous call's result never shows on the next call.
    setShowMessageSheet(false);
    setCustomMessage('');
    setSendingMessage(false);
    setMessageStatus(null);
    // 100M-H13 — a new peer resets the remind-me state too.
    setShowRemindSheet(false);
    setReminderStatus(null);
  }, [callData.remoteUserId]);
  useEffect(() => {
    if (callData.status === 'idle' || callData.status === 'ended') {
      setPipPos(null);
      setSwapped(false);
      setMinimised(false);
      setBubblePos(null);
      setRemoteFrozen(false);
      setRemoteSharingScreen(false);
    }
  }, [callData.status]);

  // Report 3 #18 — web audio-output routing: when the selected output
  // changes, apply setSinkId to the remote audio (and video) elements.
  // On native Android this is a no-op — the AudioManager communication
  // device is the route there. A failure surfaces as a hint, never a
  // silent no-op.
  const currentOutputId = callData.currentAudioDevice?.id;
  useEffect(() => {
    if (Capacitor.isNativePlatform()) return;
    if (!callData.remoteStream || !currentOutputId) return;
    const targets = [remoteAudioRef.current, remoteVideoRef.current].filter(
      (el): el is HTMLMediaElement => el !== null,
    );
    targets.forEach((el) => {
      void applyWebSinkId(el, currentOutputId).then((res) => {
        if (!res.ok) setHint(res.error || 'Could not switch the audio output.');
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOutputId]);

  // Report 3 #112/#117 (W30c, user decision 2026-11-15: "shrinking ho,
  // call kate na") — Android / browser back during a call MINIMISES it
  // to the floating bubble instead of ending it. Only an incoming call
  // is still declined by back (a decline is a decision, not a
  // minimise). The ended screen consumes back with no action (it
  // auto-dismisses on its own timer). While already minimised, back
  // falls through (returns false) so the user can navigate the app
  // normally with the call bubble on top; the handler is re-registered
  // whenever `minimised` toggles, so restoring the full call re-arms
  // back-to-minimise. The call itself (streams, peer connection,
  // foreground service) is untouched by any of this — only End ends it.
  useEffect(() => {
    if (callData.status === 'idle') return;
    return navigationManager.pushHandler(() => {
      if (callData.status === 'incoming') {
        callService.declineCall();
        return true;
      }
      if (callData.status === 'ended') {
        return true;
      }
      if (minimised) {
        return false;
      }
      setMinimised(true);
      return true;
    });
  }, [callData.status, minimised]);

  // 100M-H11 — hint line persistence. The old effect cleared EVERY
  // hint after a flat 2.5 s, so a real error ("Switch camera needs an
  // active video call") was gone before anyone could read it (measured
  // 2451 ms live). Now: error-type hints stay 8 s, informational hints
  // 5 s, and tapping the line dismisses it at once — a hint lives until
  // the next action replaces it, its time runs out, or the user taps
  // it away. Nothing here auto-clears below 5 s any more.
  const HINT_ERROR_RE = /could not|couldn't|failed|denied|unavailable|not supported|needs |wait for|try again/i;
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(''), HINT_ERROR_RE.test(hint) ? 8000 : 5000);
    return () => clearTimeout(t);
  }, [hint]);

  // Report 3 #101 — PiP drag + tap-to-swap. Pointer events (mouse and
  // touch, via pointer capture): a press that moves >8px drags the PiP;
  // a press that stays put is a tap and swaps the views. On release a
  // drag snaps to the nearest corner; the PiP stays inside the screen
  // and above the bottom controls.
  const pipDefaultPos = () => ({ x: Math.max(8, window.innerWidth - 16 - PIP_W), y: 144 });
  const pipBounds = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      minX: 8,
      maxX: Math.max(8, vw - PIP_W - 8),
      minY: 120,
      maxY: Math.max(120, vh - PIP_H - 250),
    };
  };
  const onPipPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = pipPos ?? pipDefaultPos();
    if (!pipPos) setPipPos(start);
    pipDragRef.current = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      origX: start.x, origY: start.y, curX: start.x, curY: start.y, moved: false,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
  };
  const onPipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = pipDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > 8) { d.moved = true; setPipDragging(true); }
    if (!d.moved) return;
    const b = pipBounds();
    const x = Math.min(b.maxX, Math.max(b.minX, d.origX + dx));
    const y = Math.min(b.maxY, Math.max(b.minY, d.origY + dy));
    d.curX = x; d.curY = y;
    setPipPos({ x, y });
  };
  const endPipDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = pipDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    pipDragRef.current = null;
    setPipDragging(false);
    if (!d.moved) {
      if (!cancelled) setSwapped((v) => !v);
      return;
    }
    // Snap to the nearest corner (top/bottom × left/right).
    const b = pipBounds();
    const topY = 144;
    setPipPos({
      x: d.curX + PIP_W / 2 < window.innerWidth / 2 ? b.minX : b.maxX,
      y: Math.abs(d.curY - topY) <= Math.abs(d.curY - b.maxY) ? topY : b.maxY,
    });
  };

  // W30l — the minimised call bubble is draggable anywhere on screen
  // (voice and video share this render). Same pointer-capture pattern
  // as the #101 PiP, but the bubble stays where it is dropped — no
  // corner snap, the user asked to put it anywhere. A press that does
  // not move is a tap: the buttons work as before. A drag suppresses
  // the click that would otherwise fire on pointerup over a button
  // (bubbleDraggedRef) — without that, dragging from the avatar/name
  // area would restore the call on release. The position lives only
  // for the duration of the call: restore/minimise cycles keep it,
  // idle/ended clears it (see the reset effect below).
  const BUBBLE_MARGIN = 8;
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number } | null>(null);
  const [, setBubbleDragging] = useState(false);
  const bubbleDragRef = useRef<{
    pointerId: number; startX: number; startY: number;
    origX: number; origY: number; curX: number; curY: number;
    w: number; h: number; moved: boolean;
  } | null>(null);
  // Set on pointerup after a real drag so the click that follows a
  // drag over a button is ignored; cleared on the next pointerdown.
  const bubbleDraggedRef = useRef(false);
  const bubbleDefaultPos = (): { x: number; y: number } => {
    const r = bubbleRef.current?.getBoundingClientRect();
    if (r) return { x: r.left, y: r.top };
    return { x: Math.max(8, window.innerWidth - 248), y: Math.max(16, window.innerHeight - 96 - 56) };
  };
  const bubbleBounds = (w: number, h: number) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      minX: BUBBLE_MARGIN,
      maxX: Math.max(BUBBLE_MARGIN, vw - w - BUBBLE_MARGIN),
      minY: 16,
      maxY: Math.max(16, vh - h - BUBBLE_MARGIN),
    };
  };
  const onBubblePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    bubbleDraggedRef.current = false;
    const start = bubblePos ?? bubbleDefaultPos();
    const r = bubbleRef.current?.getBoundingClientRect();
    const w = r?.width ?? 240;
    const h = r?.height ?? 56;
    if (!bubblePos) setBubblePos(start);
    bubbleDragRef.current = {
      pointerId: e.pointerId, startX: e.clientX, startY: e.clientY,
      origX: start.x, origY: start.y, curX: start.x, curY: start.y,
      w, h, moved: false,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
  };
  const onBubblePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = bubbleDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > 8) { d.moved = true; setBubbleDragging(true); }
    if (!d.moved) return;
    const b = bubbleBounds(d.w, d.h);
    const x = Math.min(b.maxX, Math.max(b.minX, d.origX + dx));
    const y = Math.min(b.maxY, Math.max(b.minY, d.origY + dy));
    d.curX = x; d.curY = y;
    setBubblePos({ x, y });
  };
  const endBubbleDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = bubbleDragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    bubbleDragRef.current = null;
    setBubbleDragging(false);
    if (!d.moved) return;
    // A drag: stay where dropped (no snap). Suppress the click that
    // fires on pointerup over whichever button the press started on.
    // The flag auto-clears after 500 ms so a LATER tap — e.g. a
    // keyboard/assistive click with no preceding pointerdown — is never
    // swallowed by a stale drag (r1: the flag stayed set and ate the
    // next Return tap). A fresh pointerdown also clears it.
    if (!cancelled) {
      bubbleDraggedRef.current = true;
      window.setTimeout(() => { bubbleDraggedRef.current = false; }, 500);
    }
    setBubblePos({ x: d.curX, y: d.curY });
  };
  // Click after a drag must not restore/end the call.
  const bubbleTapGuard = () => {
    if (!bubbleDraggedRef.current) return false;
    bubbleDraggedRef.current = false;
    return true;
  };

  // Report 3 #111 — frozen-frame detection: a remote video element whose
  // currentTime stops advancing while it is playing has stopped
  // receiving frames (frozen last frame). Two consecutive 2 s stalls
  // (~4 s) raise the indicator; any advance clears it. A genuinely
  // still scene still advances currentTime, so it does not false-fire.
  useEffect(() => {
    setRemoteFrozen(false);
    setRemoteSharingScreen(false);
    frozenStrikesRef.current = 0;
    lastRemoteTimeRef.current = -1;
    if (callData.status !== 'connected' || callData.type !== 'video' || !callData.remoteStream || !remoteVideoLive) return;
    const t = setInterval(() => {
      // Report 3 #107 — re-check the remote track every 2 s: replaceTrack
      // on the far side does not fire ontrack here, so a one-time check
      // would miss a screen share started mid-call (or one just stopped).
      const rt = callData.remoteStream?.getVideoTracks()[0];
      const sharing = !!(rt && rt.getSettings().displaySurface);
      setRemoteSharingScreen((prev) => (prev === sharing ? prev : sharing));
      const v = remoteVideoRef.current;
      if (!v || v.readyState < 2 || v.paused || v.ended || v.videoWidth === 0) {
        frozenStrikesRef.current = 0;
        setRemoteFrozen(false);
        return;
      }
      if (lastRemoteTimeRef.current >= 0 && Math.abs(v.currentTime - lastRemoteTimeRef.current) < 0.001) {
        frozenStrikesRef.current += 1;
        if (frozenStrikesRef.current >= 2) setRemoteFrozen(true);
      } else {
        frozenStrikesRef.current = 0;
        setRemoteFrozen(false);
      }
      lastRemoteTimeRef.current = v.currentTime;
    }, 2000);
    return () => clearInterval(t);
  }, [callData.status, callData.type, callData.remoteStream, remoteVideoLive, swapped, minimised]);

  // WA audit #60 — the chat-list ongoing-call row bumps restoreToken via
  // callService.requestRestore(); un-minimise so the full call returns.
  const restoreTokenRef = useRef(callData.restoreToken ?? 0);
  useEffect(() => {
    const token = callData.restoreToken ?? 0;
    if (token !== restoreTokenRef.current) {
      restoreTokenRef.current = token;
      setMinimised(false);
    }
  }, [callData.restoreToken]);

  // WA audit #6/#10 — permission / support explainer modal. Renders
  // even from 'idle': the service sets permissionNotice when a dial
  // cannot proceed at all (no getUserMedia, denied mic), so there is
  // no live call screen to host it. Dismissing returns to whatever was
  // underneath (chat list, or the ended screen when the notice rode in
  // on a media failure).
  if (callData.permissionNotice) {
    const notice = callData.permissionNotice;
    return (
      <div className="fixed inset-0 z-[1001] flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="Calling unavailable">
        <button type="button" aria-label="Close" onClick={() => callService.dismissPermissionNotice()} className="absolute inset-0 bg-black/60" />
        <div className="relative w-full max-w-sm rounded-t-3xl sm:rounded-3xl bg-panel-light dark:bg-panel-dark px-5 pt-3 pb-6 shadow-2xl" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}>
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-white/20" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary">
            {notice.kind === 'unsupported' ? "Calls aren't supported here" : 'Microphone permission denied'}
          </h3>
          <p className="mt-2 text-sm text-gray-600 dark:text-text-secondary leading-relaxed">{notice.detail}</p>
          {notice.kind === 'mic-denied' && (
            <p className="mt-2 text-sm text-gray-600 dark:text-text-secondary leading-relaxed">
              Your camera is unaffected — only the microphone blocks the call.
            </p>
          )}
          <button
            type="button"
            onClick={() => callService.dismissPermissionNotice()}
            className="mt-4 w-full rounded-full bg-green-cta px-6 py-3 text-sm font-semibold text-white active:scale-95 transition-transform"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  if (callData.status === 'idle') return null;

  const isIncoming = callData.status === 'incoming';
  const isConnected = callData.status === 'connected';
  const isOutgoing = callData.status === 'outgoing';
  const isConnectingCall = callData.status === 'connecting';
  const isEnded = callData.status === 'ended';
  const isVideo = callData.type === 'video';

  const statusText = isIncoming
    ? 'Incoming call'
    : isOutgoing
    ? 'Ringing…'
    : isConnectingCall
    ? 'Connecting…'
    : isConnected
    ? fmtDuration(callData.duration)
    : 'Call ended';

  // Incoming: accept / decline only
  if (isIncoming) {
    return (
      <div className="fixed inset-0 z-[999] bg-bg-dark text-white w-full h-full max-w-full overflow-hidden flex flex-col items-center justify-between select-none animate-fade-in">
        {/* UI-army #7: the old fixed `pt-16` put the name/label under the
            status bar on notched phones. Same safe-area padding as the
            outgoing header below. */}
        <div
          className="flex flex-col items-center text-center px-6"
          style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 40px)' }}
        >
          <p className="text-sm text-white/60">{isVideo ? 'Incoming video call' : 'Incoming voice call'}</p>
          <h2 className="text-3xl font-semibold mt-2">{callData.remoteName || 'User'}</h2>
        </div>

        {/* Worker C: ringing pulse around the avatar (the outgoing screen
            already had one; the incoming screen was static). */}
        <div className="relative flex items-center justify-center">
          <div className="absolute w-60 h-60 rounded-full bg-emerald-500/10 animate-pulse" />
          <DefaultAvatar
            photoURL={callData.remoteAvatar}
            name={callData.remoteName || 'User'}
            seed={callData.remoteName || 'User'}
            size={176}
            className="relative bg-white/5 ring-1 ring-white/10"
            alt={callData.remoteName}
          />
        </div>

        {/* W12d (100-more C2): decline with a quick message — the sheet
            offers three quick replies + a custom line. Choosing one
            declines the call and sends the text to the caller. */}
        {showMessageSheet && (
          <div className="w-full px-6 pb-2" role="dialog" aria-label="Reply with a message">
            <div className="rounded-2xl bg-white/10 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white/90">Reply with a message</span>
                <button
                  type="button"
                  onClick={() => setShowMessageSheet(false)}
                  aria-label="Close message options"
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full text-white/70 hover:bg-white/10 active:scale-90 transition-transform"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {["Can't talk right now", "I'll call you back", "I'm in a meeting"].map((reply) => (
                  <button
                    key={reply}
                    type="button"
                    disabled={sendingMessage}
                    onClick={() => void sendDeclineMessage(reply)}
                    className="w-full text-left px-3 py-2 rounded-xl bg-white/5 text-sm text-white/90 hover:bg-white/15 active:scale-[0.98] transition-[background-color,transform] disabled:opacity-50"
                  >
                    {reply}
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="text"
                  value={customMessage}
                  maxLength={500}
                  onChange={(e) => setCustomMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendDeclineMessage(customMessage);
                  }}
                  placeholder="Type a message…"
                  aria-label="Custom decline message"
                  className="flex-1 min-w-0 px-3 py-2 rounded-full bg-white/5 text-sm text-white placeholder:text-white/40 outline-none focus:ring-1 focus:ring-white/40"
                />
                <button
                  type="button"
                  onClick={() => void sendDeclineMessage(customMessage)}
                  disabled={!customMessage.trim() || sendingMessage}
                  aria-label="Send message"
                  className="p-2.5 rounded-full bg-primary-green text-on-primary-green active:scale-90 transition-transform disabled:opacity-40"
                >
                  <Send className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 100M-H13 — "Remind me": decline now, be reminded to call
            back. The reminder is per-device (this phone only, while
            the app is running) — the sheet says so. */}
        {showRemindSheet && (
          <div className="w-full px-6 pb-2" role="dialog" aria-label="Remind me about this call">
            <div className="rounded-2xl bg-white/10 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white/90">Remind me to call back</span>
                <button
                  type="button"
                  onClick={() => setShowRemindSheet(false)}
                  aria-label="Close remind options"
                  className="p-1 rounded-full text-white/70 hover:bg-white/10 active:scale-90 transition-transform"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                {[
                  { label: 'In 1 hour', minutes: 60 },
                  { label: 'In 3 hours', minutes: 180 },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => handleRemindMe(opt.minutes)}
                    className="w-full text-left px-3 py-2 rounded-xl bg-white/5 text-sm text-white/90 hover:bg-white/15 active:scale-[0.98] transition"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-white/50">
                The call is declined now. We&apos;ll remind you on this device — the app needs to be running for the reminder to appear.
              </p>
            </div>
          </div>
        )}

        <div
          className="w-full flex flex-col items-center gap-4 px-10"
          style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 40px)' }}
        >
          {/* 100M-H13 — the ring is silenced but the call is still
              ringing for the caller: say so, so Silence never reads
              as a decline. */}
          {callData.ringSilenced && (
            <span className="flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-white/70">
              <BellOff className="h-3.5 w-3.5" />
              Ringing silenced — you can still answer
            </span>
          )}
          {/* 100M-H13 — silence without declining, and remind-me: the
              two things the incoming screen was missing. Smaller than
              the main row — they are secondary to Decline/Message/
              Accept, not replacements for them. */}
          <div className="flex items-center justify-center gap-10">
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => callService.silenceIncomingCall()}
                disabled={callData.ringSilenced}
                aria-label="Silence"
                aria-pressed={!!callData.ringSilenced}
                className="p-4 rounded-full bg-white/10 text-white active:scale-90 transition-transform disabled:opacity-40"
              >
                <BellOff className="h-6 w-6" />
              </button>
              <span className="text-xs text-white/80">{callData.ringSilenced ? 'Silenced' : 'Silence'}</span>
            </div>
            <div className="flex flex-col items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRemindSheet((v) => !v)}
                aria-label="Remind me"
                aria-expanded={showRemindSheet}
                className="p-4 rounded-full bg-white/10 text-white active:scale-90 transition-transform"
              >
                <Clock className="h-6 w-6" />
              </button>
              <span className="text-xs text-white/80">Remind me</span>
            </div>
          </div>
          <div className="w-full flex items-center justify-around">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => callService.declineCall()}
              aria-label="Decline"
              className="h-20 w-20 rounded-full bg-danger-red text-white flex items-center justify-center active:scale-90 transition-transform"
            >
              <PhoneOff className="h-7 w-7" />
            </button>
            <span className="text-xs text-white/80">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => setShowMessageSheet((v) => !v)}
              aria-label="Message"
              aria-expanded={showMessageSheet}
              className="h-20 w-20 rounded-full bg-white/10 text-white flex items-center justify-center active:scale-90 transition-transform"
            >
              <MessageCircle className="h-7 w-7" />
            </button>
            <span className="text-xs text-white/80">Message</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => callService.acceptCall()}
              aria-label="Accept"
              className="h-20 w-20 rounded-full bg-primary-green text-on-primary-green flex items-center justify-center active:scale-90 transition-transform"
            >
              {isVideo ? <Video className="h-7 w-7" /> : <PhoneIncoming className="h-7 w-7" />}
            </button>
            <span className="text-xs text-white/80">Accept</span>
          </div>
          </div>
        </div>
      </div>
    );
  }

  // Report 3 #102 — minimised call: the full-screen overlay is replaced
  // by a floating bubble over the app, so the user can keep chatting
  // mid-call. The remote <audio> element stays mounted (hidden) so the
  // call audio keeps playing while minimised. Tapping the bubble (or the
  // expand button) restores full-screen; the red button ends the call.
  // Back also minimises instead of ending (W30c #112/#117) — the only
  // back path that ends anything is declining an incoming call.
  // W30l — the bubble is draggable anywhere on screen (voice and video
  // share this render): pointer drag moves it, clamped inside the
  // viewport; a press that stays put is a tap, and a drag never fires
  // the button it started on (bubbleTapGuard).
  if (minimised && !isEnded) {
    return (
      <div
        ref={bubbleRef}
        onPointerDown={onBubblePointerDown}
        onPointerMove={onBubblePointerMove}
        onPointerUp={(e) => endBubbleDrag(e, false)}
        onPointerCancel={(e) => endBubbleDrag(e, true)}
        role="button"
        aria-label={callData.waitingCall ? `Call bubble — ${callData.waitingCall.remoteName || 'Someone'} is waiting, tap to return to the call` : 'Call bubble — drag to move, tap to return to the call'}
        style={bubblePos ? { left: bubblePos.x, top: bubblePos.y } : undefined}
        className={`fixed z-[1000] flex items-center gap-1.5 rounded-full bg-input-dark border border-white/20 shadow-2xl pl-1.5 pr-1.5 py-1.5 max-w-[calc(100vw-2rem)] text-white animate-fade-in select-none touch-none cursor-grab active:cursor-grabbing ${
          bubblePos ? '' : 'bottom-24 right-4'
        }`}
      >
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
        <button
          type="button"
          onClick={() => { if (bubbleTapGuard()) return; setMinimised(false); }}
          aria-label="Return to call"
          className="flex items-center gap-2 min-w-0"
        >
          <DefaultAvatar
            photoURL={callData.remoteAvatar}
            name={callData.remoteName || 'User'}
            seed={callData.remoteName || 'User'}
            size={40}
            className="bg-white/5 ring-1 ring-white/10 flex-shrink-0"
            alt={callData.remoteName}
          />
          <span className="flex flex-col items-start min-w-0 text-left">
            <span className="text-sm font-semibold truncate max-w-[110px]">{callData.remoteName || 'User'}</span>
            {/* WA audit #12 — a parked waiting call was invisible while
                minimised (one short beep only): the bubble kept showing
                the current call, so the 45 s waiting window could expire
                unnoticed. Surface it here; tapping the bubble restores
                the full screen, where the End & accept / Decline card is. */}
            <span className={`text-[11px] tabular-nums ${callData.waitingCall ? 'text-amber-300 font-medium' : 'text-white/60'}`}>
              {callData.waitingCall
                ? `Call waiting: ${callData.waitingCall.remoteName || 'Someone'}`
                : statusText}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => { if (bubbleTapGuard()) return; setMinimised(false); }}
          aria-label="Expand call"
          className="p-2 rounded-full hover:bg-white/10 text-white/80 active:scale-90 transition-transform"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => { if (bubbleTapGuard()) return; callService.endCall(true); }}
          aria-label="End call"
          className="p-2.5 rounded-full bg-danger-red text-white active:scale-90 transition-transform"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // Outgoing / connected / ended
  return (
    <div className="fixed inset-0 z-[999] bg-bg-dark text-white w-full h-full max-w-full overflow-hidden flex flex-col justify-between select-none animate-fade-in">
      {/* Remote audio always plays; remote video only for connected video calls */}
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* WA audit #27 — floating call reactions. Sent reactions are
          appended locally by sendCallReaction, received ones arrive via
          onOwnSignal; both float up the screen for ~4 s from local
          arrival. pointer-events-none so a float never eats a control
          tap; aria-hidden (decorative — the picker button already
          announces the send). Not shown on the ended screen. */}
      <style>{`@keyframes dt-call-reaction-float { 0% { transform: translateY(0) scale(0.6); opacity: 0; } 12% { transform: translateY(-24px) scale(1.15); opacity: 1; } 100% { transform: translateY(-320px) scale(1); opacity: 0; } }`}</style>
      {freshReactions.length > 0 && !isEnded && (
        <div className="absolute inset-0 z-40 pointer-events-none overflow-hidden" aria-hidden="true">
          {freshReactions.map((r, idx) => (
            <span
              key={r.id}
              data-reaction-id={r.id}
              data-reaction-emoji={r.emoji}
              className="absolute text-[44px] leading-none"
              style={{
                left: `${reactionLeft(r.id)}%`,
                bottom: `${26 + (idx % 3) * 8}%`,
                animation: 'dt-call-reaction-float 3.5s ease-out forwards',
                textShadow: '0 2px 12px rgba(0,0,0,0.6)',
              }}
            >
              {r.emoji}
            </span>
          ))}
        </div>
      )}

      {/* Report 3 #99/#100/#106 — the remote side is the big view. The
          video mounts only while connected AND a live remote video track
          exists (otherwise the avatar below shows — no black element);
          it is muted because remote audio already comes through the
          dedicated <audio> element above (#106: unmuted video + a
          separate audio element was a duplicate path and an
          autoplay-policy risk for the picture). */}
      {showRemoteVideoMain && (
        <video
          ref={setRemoteVideoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full z-0 ${videoFit === 'contain' ? 'object-contain bg-black' : 'object-cover'}`}
        />
      )}

      {/* Report 3 #99/#101 — swapped: the local picture becomes the big
          view and the remote side moves into the PiP. */}
      {isVideo && effectiveSwapped && (
        <div className="absolute inset-0 z-0 bg-black">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{ filter: callData.isScreenSharing ? undefined : activeFilterCss || undefined }}
            className={`w-full h-full object-cover ${callData.isVideoEnabled ? 'block' : 'hidden'}`}
          />
          {!callData.isVideoEnabled && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-input-dark text-white/60 gap-2">
              <VideoOff className="h-10 w-10" />
              <span>Camera off</span>
            </div>
          )}
        </div>
      )}

      {/* Report 3 #105 — Fill/Fit for the remote video (a landscape
          remote stream on a portrait phone was cropped with no
          alternative). Shown whenever the remote video is on screen. */}
      {(showRemoteVideoMain || showRemoteVideoPip) && (
        <button
          type="button"
          onClick={() => setVideoFit((f) => (f === 'cover' ? 'contain' : 'cover'))}
          aria-label={videoFit === 'cover' ? 'Fit video to screen' : 'Fill screen with video'}
          className="absolute left-4 top-36 z-30 flex items-center gap-1 rounded-full bg-black/50 border border-white/20 px-2.5 py-2 text-[11px] font-medium text-white/80 hover:bg-black/70 active:scale-95 transition-transform"
        >
          {videoFit === 'cover' ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
          {videoFit === 'cover' ? 'Fit' : 'Fill'}
        </button>
      )}

      {/* Local preview / PiP for video calls — Report 3 #99: ALWAYS the
          small 112×160 view (the old code made it full-screen until
          connect, which is the inverted layout the user reported).
          Report 3 #101: draggable (pointer events, snaps to corners)
          and tappable (tap swaps it with the main view). Report 3 #107:
          while screen-sharing it previews the shared screen. */}
      {isVideo && callData.localStream && (
        <div
          onPointerDown={onPipPointerDown}
          onPointerMove={onPipPointerMove}
          onPointerUp={(e) => endPipDrag(e, false)}
          onPointerCancel={(e) => endPipDrag(e, true)}
          role="button"
          aria-label="Self view — drag to move, tap to swap with the other side"
          className={`absolute z-30 overflow-hidden shadow-2xl bg-black w-28 h-40 rounded-2xl border border-white/20 cursor-grab active:cursor-grabbing ${
            pipPos ? '' : 'top-36 right-4'
          }`}
          style={{
            touchAction: 'none',
            ...(pipPos
              ? { left: pipPos.x, top: pipPos.y, transition: pipDragging ? 'none' : 'left 0.2s ease, top 0.2s ease' }
              : {}),
          }}
        >
          {effectiveSwapped ? (
            showRemoteVideoPip ? (
              <video
                ref={setRemoteVideoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full ${videoFit === 'contain' ? 'object-contain bg-black' : 'object-cover'}`}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center bg-input-dark gap-1.5 p-1">
                <DefaultAvatar
                  photoURL={callData.remoteAvatar}
                  name={callData.remoteName || 'User'}
                  seed={callData.remoteName || 'User'}
                  size={64}
                  className="bg-white/5 ring-1 ring-white/10"
                  alt={callData.remoteName}
                />
                {isConnected && <span className="text-[10px] text-white/60">Camera off</span>}
              </div>
            )
          ) : (
            <>
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={{ filter: callData.isScreenSharing ? undefined : activeFilterCss || undefined }}
                className={`w-full h-full object-cover ${callData.isVideoEnabled ? 'block' : 'hidden'}`}
              />
              {!callData.isVideoEnabled && (
                <div className="w-full h-full flex flex-col items-center justify-center bg-input-dark text-white/60 text-xs gap-1">
                  <VideoOff className="h-6 w-6" />
                  <span>Camera off</span>
                </div>
              )}
              {callData.isScreenSharing && (
                <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white/80 whitespace-nowrap">
                  Sharing
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Header: name and status, like the reference layout */}
      <div
        className="relative z-30 flex flex-col items-center text-center px-6 flex-shrink-0"
        style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 40px)' }}
      >
        {/* Report 3 #102 — minimise affordance (chevron): shrinks the
            call to a floating bubble so the user can keep chatting.
            Ending stays on the red End button only — back minimises
            instead (W30c #112/#117). */}
        {!isEnded && (
          <button
            type="button"
            onClick={() => setMinimised(true)}
            aria-label="Minimise call"
            className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 active:scale-90 transition-transform"
            style={{ top: 'max(env(safe-area-inset-top, 0px), 40px)' }}
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        )}
        <h2 className="text-2xl font-semibold drop-shadow">{callData.remoteName || 'User'}</h2>
        <p className="text-sm text-white/60 mt-1 tabular-nums">{statusText}</p>
        {/* Report 3 #114 — the camera failed, so this video call is
            audio-only: say so on screen (the notice is set by
            callService when getCallMedia falls back), and tapping the
            camera button retries it. Hidden once the call ends. */}
        {!isEnded && callData.videoNotice && (
          <span className="mt-2 flex items-center gap-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-200">
            <VideoOff className="h-3.5 w-3.5" />
            {callData.videoNotice}
          </span>
        )}
        {/* Worker C: why the call ended (permission denied, couldn't
            connect, busy…) — previously the screen just said "Call ended". */}
        {isEnded && callData.callError && (
          <p className="text-sm text-red-300 mt-2 max-w-xs leading-snug">{callData.callError}</p>
        )}
        {/* 100M-H4: why a clean end that never connected ended
            (Declined / No answer / Cancelled / Busy / Missed call).
            Neutral style, NOT the red error style above — this is not
            a failure. Suppressed when callError is set (a real failure
            already names the cause). Brighter than the muted status
            line above: this is the new information. aria-live so a
            screen reader announces the outcome when the ended screen
            appears (WCAG 4.1.3). */}
        {isEnded && !callData.callError && callData.endReasonText && (
          <p aria-live="polite" className="text-sm text-white/80 mt-2 max-w-xs leading-snug">{callData.endReasonText}</p>
        )}
        {/* #4/#8 — which step failed, in plain words, plus the step-wise
            diagnostics (TURN? relay candidate? ICE state?) with a copy
            action, so the next "call didn't connect" report carries the
            actual cause instead of a paraphrase. */}
        {isEnded && callData.failedStep && (
          <p className="text-xs text-amber-300/90 mt-1.5">Failed step: {callData.failedStep}</p>
        )}
        {isEnded && callData.callDiagnostics && (
          <div className="mt-2 w-full max-w-xs text-left">
            <button
              type="button"
              onClick={() => setDiagOpen((v) => !v)}
              aria-expanded={diagOpen}
              className="text-xs font-medium text-white/70 underline underline-offset-2 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              {diagOpen ? 'Hide call diagnostics' : 'Show call diagnostics'}
            </button>
            {diagOpen && (
              <>
                <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 p-2 text-[10px] leading-relaxed text-white/70">
                  {callData.callDiagnostics}
                </pre>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await callService.copyDiagnostics();
                    if (ok) {
                      setDiagCopied(true);
                      setTimeout(() => setDiagCopied(false), 2000);
                    } else {
                      setHint('Could not copy diagnostics');
                    }
                  }}
                  className="mt-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/20 active:scale-95 transition-transform"
                >
                  {diagCopied ? 'Diagnostics copied ✓' : 'Copy diagnostics'}
                </button>
              </>
            )}
          </div>
        )}
        {callData.isScreenSharing && isConnected && (
          <span className="mt-2 flex items-center gap-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 px-3 py-1 text-xs font-medium text-emerald-300">
            <Monitor className="h-3.5 w-3.5" />
            Sharing your screen
          </span>
        )}

        {/* Connection / quality indicator */}
        <div className="mt-2 flex items-center justify-center" aria-live="polite">
          {isReconnecting ? (
            <span className="flex items-center gap-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-300">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Reconnecting…
            </span>
          ) : effectiveConnection === 'failed' ? (
            <span className="flex items-center gap-1.5 rounded-full bg-danger-red/20 border border-danger-red/40 px-3 py-1 text-xs font-medium text-red-300">
              <WifiOff className="h-3.5 w-3.5" />
              Connection lost — trying to reconnect…
            </span>
          ) : isConnected ? (
            // WA audit #32/#7 — the pill is now a grade, not a binary:
            // getStats (RTT / jitter / loss) drives 'good' vs 'poor'
            // while connected; 'reconnecting' still owns the amber
            // spinner above.
            callData.connectionQuality === 'poor' ? (
              <span className="flex items-center gap-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-300">
                <Signal className="h-3.5 w-3.5" />
                Poor connection
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70">
                <Signal className="h-3.5 w-3.5 text-emerald-400" />
                Connected
              </span>
            )
          ) : // Report 3 #250 — one state at a time: while the status
          // line already says "Ringing…" (outgoing) or "Connecting…"
          // (connecting) the pill must not repeat it underneath. The
          // pill only adds anything when the status line says something
          // else — e.g. a connected call whose ICE layer drops back to
          // connecting (timer up top, "Connecting…" pill below).
          isConnecting && !isEnded && !isOutgoing && !isConnectingCall ? (
            <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs text-white/70">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Connecting…
            </span>
          ) : null}
        </div>
        {/* Report 3 #111 — frozen remote video: the picture stopped
            advancing even though the call is still connected. */}
        {remoteFrozen && isConnected && isVideo && (
          <span className="mt-2 flex items-center gap-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-300">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Video frozen — waiting for video…
          </span>
        )}
        {/* Report 3 #107 — the other side is sharing their screen: the
            picture is their screen, so say so instead of leaving the
            user guessing why the "camera" shows a desktop. */}
        {remoteSharingScreen && isConnected && isVideo && (
          <span className="mt-2 flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-white/70">
            <Monitor className="h-3.5 w-3.5" />
            {callData.remoteName || 'User'} is sharing their screen
          </span>
        )}
        {isReconnecting && (
          <p className="text-[11px] text-white/70 mt-1.5 max-w-xs">
            Your network dropped — the call will resume automatically when the connection recovers.
          </p>
        )}
        {/* ROADMAP-2 #13: DND indicator — visible in the call UI so the
            user can see why new calls are not ringing. The switch itself
            lives in Settings → Notifications → Calls. */}
        {callData.isDndOn && !isEnded && (
          <span className="mt-2 flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-white/70">
            <BellOff className="h-3.5 w-3.5" />
            Do Not Disturb on — new calls won&apos;t ring
          </span>
        )}
        {/* Report 3 #103 — the camera failed, so this "video" call is
            audio-only. Say so plainly; the old code ran the call on
            silently and mounted a black remote video element. */}
        {callData.isAudioOnly && isVideo && !isEnded && (
          <span className="mt-2 flex items-center gap-1.5 rounded-full bg-white/10 border border-white/15 px-3 py-1 text-xs font-medium text-white/70">
            <VideoOff className="h-3.5 w-3.5" />
            Camera unavailable — audio only
          </span>
        )}
        {/* ROADMAP-2 #13: call waiting. A second caller is parked in
            callData.waitingCall while this call is live. "End & accept"
            ends this call and answers the waiting one; "Decline" sends
            them to busy. "Add to call" is deliberately DISABLED, not
            faked: merging a 1:1 call into a group call needs the
            group-call infrastructure (ROADMAP-2 #4) that does not exist
            yet — the note below says so in the UI. */}
        {callData.waitingCall && !isEnded && (
          <div className="mt-3 w-full max-w-xs rounded-2xl bg-white/10 border border-white/20 p-3 text-left">
            <p className="text-xs font-semibold text-white/90">Call waiting</p>
            <p className="text-sm text-white/80 mt-0.5">
              {callData.waitingCall.remoteName || 'Someone'} is calling…
            </p>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => void callService.acceptWaitingCall()}
                className="flex-1 rounded-full bg-primary-green px-3 py-2 text-xs font-semibold text-on-primary-green active:scale-95 transition-transform"
              >
                End &amp; accept
              </button>
              <button
                type="button"
                onClick={() => callService.declineWaitingCall()}
                className="flex-1 rounded-full bg-white/10 px-3 py-2 text-xs font-semibold text-white/80 hover:bg-white/20 active:scale-95 transition-transform"
              >
                Decline
              </button>
              <button
                type="button"
                disabled
                title="Adding someone to this call needs group calls, which are not available yet"
                aria-label="Add to call (not available yet)"
                className="flex items-center gap-1 rounded-full bg-white/5 px-3 py-2 text-xs font-medium text-white/30 cursor-not-allowed"
              >
                <UserPlus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>
            <p className="text-[11px] text-white/70 mt-2 leading-snug">
              Adding them to this call needs group calls — not available yet. Ending this call rings them back as a normal call.
            </p>
          </div>
        )}
      </div>

      {/* Avatar (voice calls, or video calls that are not connected yet,
          or — Report 3 #100 — a connected video call whose remote side
          has no live video: camera off / no camera / track never
          arrived. The old code showed a black/frozen full-screen video
          in that state with no avatar, no name, no message.) */}
      {!effectiveSwapped && (!isVideo || !isConnected || !remoteVideoLive) && (
        <div className="relative z-20 my-auto flex flex-col items-center justify-center">
          <div className="relative flex items-center justify-center">
            {(isOutgoing) && (
              <div className="absolute w-52 h-52 rounded-full bg-emerald-500/10 animate-pulse" />
            )}
            <DefaultAvatar
              photoURL={callData.remoteAvatar}
              name={callData.remoteName || 'User'}
              seed={callData.remoteName || 'User'}
              size={160}
              className="relative bg-white/5 ring-1 ring-white/10"
              alt={callData.remoteName}
            />
          </div>
          {isVideo && isConnected && !remoteVideoLive && (
            <p className="mt-4 text-sm text-white/60">Camera off</p>
          )}
        </div>
      )}

      {/* Hint line for actions the phone cannot do from the browser.
          100M-H11: tapping it dismisses it — it is never stuck on
          screen, and it is never yanked away unread either. */}
      <div
        className="relative z-30 h-6 text-center text-xs text-white/70 px-6 cursor-pointer"
        onClick={() => setHint('')}
        role={hint ? 'button' : undefined}
        aria-label={hint ? 'Dismiss hint' : undefined}
        title={hint ? 'Tap to dismiss' : undefined}
      >{hint}</div>

      {!isEnded && callData.audioRouteError && (
        <p className="relative z-30 px-6 pb-1 text-center text-[11px] leading-snug text-amber-300/90">
          {callData.audioRouteError}
        </p>
      )}

      {/* HERMES UI cleanup — video filters for the local preview.
          The filter pills no longer sit on the main call screen; a
          single Filter button opens them. Hidden while screen-sharing
          (the preview is the shared screen then, not the camera).
          Wave-2 B1: the filter is baked into the OUTGOING track by
          callService (canvas-processed stream), so the peer sees it —
          the preview CSS is the same value, so the preview shows what
          the peer sees. The caption says so plainly. */}
      {isVideo && callData.localStream && !callData.isScreenSharing && (
        <div className="relative z-30 flex flex-col items-center gap-1 px-6 pb-1">
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
            aria-label="Video filters"
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${videoFilter !== 'none' ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/20'}`}
          >
            Filter{videoFilter !== 'none' ? `: ${CALL_VIDEO_FILTERS.find(f => f.id === videoFilter)?.label}` : ''}
          </button>
          {showFilters && (
            <>
              <div className="flex items-center justify-center gap-2" role="group" aria-label="Video filters">
                {CALL_VIDEO_FILTERS.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => void callService.setVideoFilter(f.id)}
                    aria-pressed={videoFilter === f.id}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${videoFilter === f.id ? 'bg-white text-black' : 'bg-white/10 text-white/80 hover:bg-white/20'}`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-white/50">
                {callData.videoFilterNotice ??
                  (videoFilter !== 'none'
                    ? 'The other side sees this filter too'
                    : 'Applies to the video the other side sees')}
              </p>
            </>
          )}
        </div>
      )}

      {/* Controls */}
      <div
        className="relative z-30 w-full max-w-sm mx-auto px-8 pt-4"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 32px)' }}
      >
        {/* Worker C: ended state — the old screen showed the live control
            grid (mute/video/end) over a dead call and a bare "Call ended".
            Now: the failure reason (above) + Call Back (the service keeps
            the remote peer in the ended state for this) + Close. The
            screen still auto-dismisses (3 s clean, 5 s failed). */}
        {isEnded ? (
          <div className="flex flex-col items-center gap-3 pb-2">
            {/* W12d (100-more C2): the decline-with-message result. The
                auto-dismiss was held so this stays readable; 'failed' /
                'encryption-not-ready' offer Open chat — the message can
                be typed there once the keys are exchanged. */}
            {messageStatus === 'sent' && (
              <p className="text-sm text-emerald-300">Message sent ✓</p>
            )}
            {/* 100M-H13 — the remind-me confirmation, same spot as the
                decline-message result. */}
            {reminderStatus && (
              <p className="text-sm text-emerald-300 text-center px-4">{reminderStatus}</p>
            )}
            {messageStatus === 'queued' && (
              <p className="text-sm text-amber-300 text-center px-4">
                Message queued — it will send when you&apos;re back online.
              </p>
            )}
            {(messageStatus === 'failed' || messageStatus === 'encryption-not-ready') && (
              <div className="flex flex-col items-center gap-2 px-4 text-center">
                <p className="text-sm text-amber-300">
                  {messageStatus === 'encryption-not-ready'
                    ? `Message couldn't be sent yet — encryption isn't set up until ${callData.remoteName || 'they'} open your chat.`
                    : "Couldn't send the message."}
                </p>
                {callData.remoteUserId ? (
                  <button
                    type="button"
                    onClick={() => {
                      callService.dismissEnded();
                      navigate(`/chat/${callData.remoteUserId}`);
                    }}
                    className="rounded-full bg-white/10 px-5 py-2 text-sm font-medium text-white hover:bg-white/20 active:scale-95 transition-transform"
                  >
                    Open chat
                  </button>
                ) : null}
              </div>
            )}
            {callData.remoteUserId ? (
              <button
                type="button"
                onClick={() => {
                  // 100M-H12 — the ended screen is reachable while another
                  // call is live (waiting-call swap); a bailed-out redial
                  // says so in the hint line instead of doing nothing.
                  void callService
                    .startCall({
                      targetUserId: callData.remoteUserId,
                      targetUserName: callData.remoteName || 'User',
                      targetUserAvatar: callData.remoteAvatar,
                      type: callData.type,
                    })
                    .then((res) => {
                      if (res === 'already-in-call') setHint("You're already in a call");
                    });
                }}
                className="flex items-center gap-2 rounded-full bg-green-cta px-6 py-3 text-sm font-semibold text-white hover:bg-dark-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:scale-95 transition-transform"
              >
                <PhoneIncoming className="h-5 w-5" /> Call back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => callService.dismissEnded()}
              className="rounded-full px-6 py-2 min-h-[44px] text-sm font-medium text-white/70 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:scale-95 transition-transform"
            >
              Close
            </button>
          </div>
        ) : (
        <div className="grid grid-cols-3 gap-y-6 justify-items-center items-center">
          {/* HERMES UI cleanup — a single Audio button (WhatsApp-style).
              It opens the audio sheet (outputs + microphones) instead of
              cycling outputs and instead of the device/mic pills that
              used to crowd the main screen. Routing itself is untouched. */}
          <Control
            label="Audio"
            icon={audioOutputIcon(callData.currentAudioDevice)}
            active={!!callData.currentAudioDevice && callData.currentAudioDevice.kind !== 'earpiece'}
            onClick={() => setShowAudioSheet(true)}
          />
          {/* 100M-H9 — voice → video upgrade: this button is NOT
              disabled on voice calls any more. Tapping it acquires the
              camera and flips the call to video (toggleVideo +
              markVideoUpgraded in the service); a failed camera leaves
              the call on voice and says so in the hint line instead of
              looking like a dead button. */}
          <Control
            label={isVideo ? (callData.isVideoEnabled ? 'Camera on' : 'Camera off') : 'Video'}
            icon={isVideo && callData.isVideoEnabled ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
            active={isVideo && !callData.isVideoEnabled}
            onClick={async () => {
              const wasVideo = isVideo;
              const ok = await callService.toggleVideo();
              if (!wasVideo) {
                setHint(ok ? 'Switched to video call' : 'Camera unavailable — staying on voice call');
              }
            }}
          />
          <Control
            label={callData.isMuted ? 'Unmute' : 'Mute'}
            icon={callData.isMuted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
            active={callData.isMuted}
            onClick={() => callService.toggleMute()}
          />

          {isVideo ? (
            <Control
              // Report 3 #104 — the label says what tapping DOES
              // (flip to the other camera), not which camera is live.
              label={callData.facingMode === 'user' ? 'Flip to back' : 'Flip to front'}
              icon={<Camera className="h-6 w-6" />}
              onClick={async () => {
                if (callData.isScreenSharing) {
                  setHint('Stop screen sharing to switch camera');
                  return;
                }
                setHint('Switching camera…');
                const res = await callService.switchCamera();
                if (res === 'failed') setHint('Could not switch camera — try again');
                else if (res === 'sharing') setHint('Stop screen sharing to switch camera');
                else if (res === 'busy') setHint('Already switching camera…');
                else if (res === 'not-in-call') setHint('Switch camera needs an active video call');
                else setHint('');
              }}
            />
          ) : (
            <div />
          )}

          {/* End call — WhatsApp makes this the largest control in the
              grid (the primary action), with a label like the rest. */}
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => callService.endCall(true)}
              aria-label="End call"
              className="h-20 w-20 rounded-full bg-danger-red text-white flex items-center justify-center active:scale-90 transition-transform"
            >
              <PhoneOff className="h-8 w-8" />
            </button>
            <span className="text-xs font-medium text-white/80">End</span>
          </div>
          {/* Phase 4 — screen share (video calls only, while connected). Shares
              via getDisplayMedia; the remote side needs a client that renders
              remote video (any current Pinglo client does). Cancelling the
              share picker is a no-op — the call keeps going. */}
          {isVideo && isConnected ? (
            <Control
              label={callData.isScreenSharing ? 'Stop share' : 'Share screen'}
              icon={callData.isScreenSharing ? <MonitorOff className="h-6 w-6" /> : <Monitor className="h-6 w-6" />}
              active={callData.isScreenSharing}
              onClick={async () => {
                if (callData.isScreenSharing) {
                  await callService.stopScreenShare();
                  setHint('Screen sharing stopped — camera restored');
                  return;
                }
                const result = await callService.startScreenShare();
                if (result === 'cancelled') setHint('Screen share cancelled');
                else if (result === 'unsupported') setHint('Screen sharing is not supported on this device/browser');
                else if (result === 'failed') setHint("Couldn't start screen sharing — try again");
                else if (result === 'not-in-call') setHint('Wait for the call to connect first');
                else setHint('Sharing your screen — the other side sees it as your video');
              }}
            />
          ) : (
            <div />
          )}
        </div>
        )}
      </div>

      {/* WA audit #27 — Reactions entry point, beside the keypad pill:
          the 3-column grid is WhatsApp's layout and reactions are an
          in-call extra like the keypad. Shown while connected OR
          connecting — sendCallReaction accepts both (the signal doc
          exists from the ring on, and a headless ICE can never reach
          'connected', so the connecting window is the only live call a
          probe can hold). The keypad pill stays connected-only: DTMF
          needs a live audio sender. */}
      {!isEnded && (isConnected || isConnectingCall) && (
        <div className="relative z-30 w-full max-w-sm mx-auto px-8 flex justify-center gap-2 pb-1">
          <button
            type="button"
            onClick={() => setShowReactions(true)}
            aria-label="Reactions"
            aria-expanded={showReactions}
            className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/20 active:scale-95 transition-transform"
          >
            <Smile className="h-4 w-4" /> Reactions
          </button>
          {isConnected && (
            <button
              type="button"
              onClick={() => { setLastDtmf(null); setShowKeypad(true); }}
              aria-label="Keypad"
              aria-expanded={showKeypad}
              className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white/80 hover:bg-white/20 active:scale-95 transition-transform"
            >
              <Hash className="h-4 w-4" /> Keypad
            </button>
          )}
        </div>
      )}

      {/* HERMES UI cleanup — Audio sheet (WhatsApp-style). The single
          Audio button opens this bottom sheet listing the available
          outputs and microphones. Selecting one routes audio via the
          existing callService methods and closes the sheet. */}
      {showAudioSheet && !isEnded && (
        <div className="absolute inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Audio devices">
          <button
            type="button"
            aria-label="Close audio devices"
            onClick={() => setShowAudioSheet(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative w-full max-w-sm rounded-t-3xl bg-panel-light dark:bg-panel-dark px-5 pt-3 pb-6 shadow-2xl" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-white/20" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary mb-1">Audio</h3>
            {(callData.audioDevices?.length ?? 0) > 0 && (
              <div className="mt-2">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-text-secondary mb-1">Output</p>
                {callData.audioDevices!.map((d) => {
                  const isCurrent = callData.currentAudioDevice?.id === d.id;
                  const label = d.kind === 'bluetooth' || d.kind === 'wired'
                    ? (d.name || audioOutputLabel(d))
                    : audioOutputLabel(d);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={async () => {
                        const res = await callService.setAudioOutput(d.id);
                        if (!res.ok) setHint(res.error || 'Could not change the audio output.');
                        else setShowAudioSheet(false);
                      }}
                      aria-pressed={isCurrent}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-input-dark"
                    >
                      <span className="text-gray-900 dark:text-text-primary">{label}</span>
                      {isCurrent && <span className="text-primary-green font-semibold">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {(callData.audioInputs?.length ?? 0) > 0 && (
              <div className="mt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-text-secondary mb-1">Microphone</p>
                {callData.audioInputs!.map((d, i) => {
                  const isCurrent = callData.audioInputDeviceId
                    ? callData.audioInputDeviceId === d.id
                    : i === 0;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={async () => {
                        const res = await callService.setAudioInputDevice(d.id);
                        if (!res.ok) setHint(res.error || 'Could not switch the microphone.');
                        else setShowAudioSheet(false);
                      }}
                      aria-pressed={isCurrent}
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-input-dark"
                    >
                      <span className="text-gray-900 dark:text-text-primary">{d.name || `Microphone ${i + 1}`}</span>
                      {isCurrent && <span className="text-primary-green font-semibold">✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {(callData.audioDevices?.length ?? 0) === 0 && (callData.audioInputs?.length ?? 0) === 0 && (
              <p className="mt-2 text-sm text-gray-500 dark:text-text-secondary">No audio devices found.</p>
            )}
          </div>
        </div>
      )}

      {/* WA audit #37 — keypad / DTMF sheet. Standard telephone 3×4
          grid (the exact WA phone keypad layout still needs a
          real-device check). Each tap sends one DTMF tone via
          callService.sendDtmf (RTCDTMFSender); a tone that cannot be
          sent says so in the hint line instead of failing silently. */}
      {showKeypad && !isEnded && (
        <div className="absolute inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Keypad">
          <button
            type="button"
            aria-label="Close keypad"
            onClick={() => setShowKeypad(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative w-full max-w-sm rounded-t-3xl bg-panel-light dark:bg-panel-dark px-5 pt-3 pb-6 shadow-2xl" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-white/20" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary">Keypad</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-3">
              {lastDtmf ? `Sent ${lastDtmf}` : 'Tap a key to send its tone (for automated menus).'}
            </p>
            <div className="grid grid-cols-3 gap-3">
              {([
                ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
                ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
                ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
                ['*', ''], ['0', '+'], ['#', ''],
              ] as [string, string][]).map(([digit, sub]) => (
                <button
                  key={digit}
                  type="button"
                  aria-label={`Keypad ${digit}`}
                  onClick={() => {
                    if (callService.sendDtmf(digit)) setLastDtmf(digit);
                    else setHint('DTMF is not available on this call');
                  }}
                  className="flex flex-col items-center justify-center rounded-2xl bg-gray-100 dark:bg-input-dark py-3 active:scale-95 transition-transform"
                >
                  <span className="text-xl font-semibold text-gray-900 dark:text-text-primary">{digit}</span>
                  {sub ? <span className="text-[10px] tracking-[0.2em] text-gray-500 dark:text-text-secondary">{sub}</span> : <span className="text-[10px]">&nbsp;</span>}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowKeypad(false)}
              className="mt-4 w-full rounded-full bg-gray-100 dark:bg-input-dark px-6 py-2.5 text-sm font-medium text-gray-900 dark:text-text-primary active:scale-95 transition-transform"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* WA audit #27 — reactions picker sheet (same bottom-sheet
          pattern as the keypad). Tapping an emoji sends it at once —
          sendCallReaction appends it locally first, so it floats
          immediately, then signals it over the existing callsig doc —
          and closes the sheet. A send that cannot go out says so in
          the hint line instead of pretending it went. */}
      {showReactions && !isEnded && (
        <div className="absolute inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Reactions">
          <button
            type="button"
            aria-label="Close reactions"
            onClick={() => setShowReactions(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative w-full max-w-sm rounded-t-3xl bg-panel-light dark:bg-panel-dark px-5 pt-3 pb-6 shadow-2xl" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)' }}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300 dark:bg-white/20" />
            <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary">Reactions</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-3">
              Tap an emoji — it floats on your screen and the other side&apos;s.
            </p>
            <div className="grid grid-cols-6 gap-2" role="group" aria-label="Call reactions">
              {CALL_REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`Send ${emoji} reaction`}
                  onClick={() => {
                    setShowReactions(false);
                    if (!callService.sendCallReaction(emoji)) setHint('Reactions are not available on this call');
                  }}
                  className="flex items-center justify-center rounded-2xl bg-gray-100 dark:bg-input-dark py-3 text-3xl active:scale-90 transition-transform"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
