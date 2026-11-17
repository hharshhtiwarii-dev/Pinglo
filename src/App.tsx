import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ComponentType } from 'react';
import { Capacitor } from '@capacitor/core';
import { AlertTriangle } from 'lucide-react';
import { StatusBar, Style } from '@capacitor/status-bar';
import { onAuthStateChanged, auth, authManager, initAwsAmplify, resetDbCache, getAwsConfigStatus } from './aws';
import { clearLocalMediaBlobs } from './aws/storage';
import { navigationManager } from './services/navigation';
import { registerDeepLinkListener } from './services/deepLink';
import { checkPendingShare, initShareListener, loadPendingShare } from './services/shareIntent';
import { callService, ActiveCallData } from './services/callService';
import { realtimeSync } from './services/realtimeSync';
import {
  startOfflineQueue,
  onOfflineOpDropped,
  onOfflineOpFailed,
  getFailedOfflineOps,
  discardFailedOfflineOp,
  clearOfflineQueue,
  retryAllFailedOfflineOps,
  flushOfflineQueueAfterAuthRefresh,
} from './services/offlineQueue';
import { scheduledMessages } from './services/scheduledMessages';
import NotificationBanner from './components/NotificationBanner';
import { initPushForUser, stopPushForUser, notifyIncomingCall } from './services/pushNotifications';
import { applyAppTheme, getAppTheme, installAppThemeListener } from './services/chatTheme';
import { type CallConnectionState } from './components/CallModal';
// (CallModal itself is lazy-loaded below, next to the lazy screens —
// see the #132 note there. It cannot live here: lazyWithRetry is defined
// further down, and a const above it would hit the temporal dead zone.)
// Phase 3 — screens are lazy-loaded so the first paint is a small bundle;
// one screen failing to load/render no longer blanks the whole app
// (ErrorBoundary in main.tsx is the second line of defence).

// RETEST-1 (2026-11-14): a screen chunk used to fail PERMANENTLY on one
// transient load failure (flaky network, or an app update mid-session) —
// the route ErrorBoundary caught it, but the user had to tap Reload by
// hand. Retry the import once after a short delay; a genuinely missing
// chunk still throws to the boundary. (Chunk-load failures were the single
// most common failure in headless re-testing under a loaded VM, and they
// happen on real phones on slow mobile data too.)
function lazyWithRetry<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    // RETEST-1: three retries (1s, 2s, 4s — ~7s window). Host/network
    // pressure comes in waves that outlasted the old 2-retry window: a
    // ChatScreen chunk fetch failed 3x in a row during a wave and the
    // ErrorBoundary showed "This chat couldn't be opened" even though the
    // chunk itself was fine. A genuinely missing chunk still throws to
    // the boundary after the last attempt.
    // #207: a STALLED chunk fetch never rejects at all — the dynamic
    // import promise just hangs, so no retry ever fires and the route
    // sits on the loading shell forever (Report-3 saw 6 attempts wedged
    // on the shell for 60–120s). Race every attempt against a 20s
    // timeout so a hung fetch fails fast and the next retry (then the
    // route ErrorBoundary, which offers Back-to-chats / Reload) can run.
    // The import itself cannot be aborted; if it later resolves, the
    // rejected attempt is simply discarded.
    // REPORT-3 #248 (W13 NEXT R4): an import that rejects in <100ms is
    // the browser's CACHED module-map error — proven by probe
    // (probe-w13r4-248.mjs phase 2): after one transient fetch failure,
    // every later import() of the same URL fails in 0ms with ZERO
    // network requests, for the whole life of the page. Re-trying the
    // same URL in-page can therefore never succeed — only a page reload
    // clears the module map. So on an instant chunk-load rejection, skip
    // the remaining retries and throw immediately: the route
    // ErrorBoundary fires within ~1s (instead of after ~7s of futile
    // retries) and its auto-reload is the real recovery. Slow failures
    // (a fetch that stalls and hits the 20s race) still retry — those
    // are genuine stalls, not cached errors, and a later attempt can
    // share the still-in-flight fetch if it recovers.
    let lastErr: unknown = null;
    for (const delay of [0, 1000, 2000, 4000]) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const t0 = Date.now();
      try {
        return await Promise.race([
          importFn(),
          new Promise<{ default: T }>((_resolve, reject) =>
            setTimeout(() => reject(new Error('Chunk load timed out after 20s')), 20_000),
          ),
        ]);
      } catch (e) {
        lastErr = e;
        if (Date.now() - t0 < 100 && isChunkLoadError(e)) break;
      }
    }
    throw lastErr;
  });
}

const LoginScreen = lazyWithRetry(() => import('./screens/auth/LoginScreen'));
const SignupScreen = lazyWithRetry(() => import('./screens/auth/SignupScreen'));
const WelcomeScreen = lazyWithRetry(() => import('./screens/auth/WelcomeScreen'));
import { hasSeenWelcome } from './screens/auth/welcomeState';
const MainScreen = lazyWithRetry(() => import('./screens/main/MainScreen'));
const ChatScreen = lazyWithRetry(() => import('./screens/chat/ChatScreen'));
const DevAIScreen = lazyWithRetry(() => import('./screens/dev/DevAIScreen'));
const LockedChatsFolder = lazyWithRetry(() => import('./screens/hidden/LockedChatsFolder'));
const VaultScreen = lazyWithRetry(() => import('./screens/vault/VaultScreen'));
const SettingsScreen = lazyWithRetry(() => import('./screens/settings/SettingsScreen'));
const StorageUsageScreen = lazyWithRetry(() => import('./screens/settings/StorageUsageScreen'));
const NetworkUsageScreen = lazyWithRetry(() => import('./screens/settings/NetworkUsageScreen'));
const ProxySettingsScreen = lazyWithRetry(() => import('./screens/settings/ProxySettingsScreen'));
const E2EESettings = lazyWithRetry(() => import('./screens/settings/E2EESettings'));
const SavedMessagesScreen = lazyWithRetry(() => import('./screens/saved/SavedMessagesScreen'));
const StarredScreen = lazyWithRetry(() => import('./screens/starred/StarredScreen'));
const AdminDashboardScreen = lazyWithRetry(() => import('./screens/admin/AdminDashboardScreen'));
const CallLinkScreen = lazyWithRetry(() => import('./screens/calls/CallLinkScreen'));
const ScheduledMessagesScreen = lazyWithRetry(() => import('./screens/scheduled/ScheduledMessagesScreen'));
const BroadcastScreen = lazyWithRetry(() => import('./screens/broadcast/BroadcastScreen'));
const SharePickerScreen = lazyWithRetry(() => import('./screens/share/SharePickerScreen'));
const ContactsScreen = lazyWithRetry(() => import('./screens/contacts/ContactsScreen'));
const UserSearchScreen = lazyWithRetry(() => import('./screens/search/UserSearchScreen'));
// REPORT-3 #132 (W13 NEXT R3): CallModal was a static import, so its
// ~1,000 lines shipped in the entry chunk and delayed the first paint —
// even though the modal renders nothing until a call is active.
// Lazy-load it like the screens: the call itself is driven by
// callService, which stays eager so incoming calls still ring; only the
// modal UI arrives a beat later on the first call. Its Suspense boundary
// is inline at the usage site (fallback null) because the modal sits
// outside the routes' Suspense.
const CallModal = lazyWithRetry(() => import('./components/CallModal'));
import { AppLockGate } from './screens/settings/AppLockScreen';
import { ErrorBoundary, isChunkLoadError } from './components/ErrorBoundary';

// Worker A: a render crash inside one chat used to trip the ROOT boundary
// in main.tsx and blank the WHOLE app ("Something went wrong" — what the
// user experiences as "the app crashes while messaging"). The chat route
// gets its own boundary with a recoverable fallback: back to the chat
// list, or reload. Navigating away unmounts the boundary, so a bad chat
// can never trap the user. It also catches a lazy chunk-load failure
// (stale chunk after an app update — a classic post-update crash).
function ChatCrashFallback({ autoReloading = false }: { autoReloading?: boolean } = {}) {
  const navigate = useNavigate();
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#0B141A] gap-4 px-6 text-center">
      <h1 className="text-xl font-bold text-white">This chat couldn't be opened</h1>
      <p className="text-sm text-gray-400">
        {autoReloading
          ? 'Retrying automatically — your chats are safe.'
          : 'Something went wrong showing this chat. Your chats are safe — go back to the list or reload.'}
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => navigate('/main')}
          className="px-4 py-2 rounded-full bg-[#25D366] text-white text-sm font-semibold"
        >
          Back to chats
        </button>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-full bg-gray-700 text-white text-sm"
        >
          Reload app
        </button>
      </div>
    </div>
  );
}

// REPORT-3 #248 (W13 NEXT R4): the scoped fallback for every lazy route
// except /chat (which keeps ChatCrashFallback above). Previously only the
// chat route had its own boundary — a chunk-load failure on any other
// route tripped the ROOT boundary in main.tsx and blanked the whole app
// with "Something went wrong". A per-route boundary keeps the app shell
// alive and shows this recovery screen instead. The boundary still
// auto-reloads on chunk errors (see ErrorBoundary), so this screen is
// usually visible only for a second; Reload is the real recovery.
function ScreenCrashFallback({ autoReloading = false }: { autoReloading?: boolean } = {}) {
  const navigate = useNavigate();
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-[#0B141A] gap-4 px-6 text-center">
      <h1 className="text-xl font-bold text-white">This screen couldn&apos;t be opened</h1>
      <p className="text-sm text-gray-400">
        {autoReloading
          ? 'Retrying automatically — your chats are safe.'
          : 'Something went wrong loading this screen. Your chats are safe — go back or reload.'}
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => navigate('/')}
          className="px-4 py-2 rounded-full bg-[#25D366] text-white text-sm font-semibold"
        >
          Go home
        </button>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-full bg-gray-700 text-white text-sm"
        >
          Reload app
        </button>
      </div>
    </div>
  );
}

// Cluster C (Item 15a): incoming pinglo:// links (Capacitor appUrlOpen)
// + web ?link= fallback. Registered once, inside the Router.
function DeepLinkHandler() {
  const navigate = useNavigate();
  useEffect(() => registerDeepLinkListener((path) => navigate(path)), [navigate]);
  return null;
}

// ROADMAP-2 #8 last mile (Worker R2B): wire the native share target in.
// A share arriving while the app runs fires 'shareReceived' in the
// ShareIntent plugin; a cold-start share waits in the launch intent
// until checkPendingShare() pulls it. Both paths store the payload
// (shareIntent.ts, localStorage `dt_pending_share`) and open the /share
// picker — this supersedes R1B's suggested `navigate('/main')` wiring,
// which would have dropped the user on the chat list with no picker.
// The picker itself reads loadPendingShare(), so a share that arrived
// while signed out still opens after login (the cold-start check below
// looks at the stored share too, not just the plugin).
function ShareIntentHandler({ user }: { user: any }) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location.pathname);
  locationRef.current = location.pathname;
  const goShare = useCallback(() => {
    if (locationRef.current !== '/share') navigate('/share');
  }, [navigate]);
  useEffect(() => {
    // Live share while the app runs. On the web there is no plugin, so
    // this is a no-op and shares simply never arrive.
    const stop = initShareListener(() => goShare());
    return stop;
  }, [goShare]);
  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    void checkPendingShare().then((share) => {
      if (cancelled) return;
      if (share || loadPendingShare()) goShare();
    });
    return () => {
      cancelled = true;
    };
  }, [user?.uid, goShare]);
  return null;
}

function NavigationObserver() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    navigationManager.setNavigator((delta) => navigate(delta), location.pathname);
  }, [navigate, location.pathname]);

  return null;
}

const Splash = () => (
  <div className="flex h-screen flex-col items-center justify-center bg-[#0B141A] gap-4">
    <div className="w-20 h-20 rounded-full bg-[#25D366] flex items-center justify-center shadow-2xl shadow-green-900/50 animate-pulse">
      <svg viewBox="0 0 24 24" fill="white" className="w-10 h-10">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
      </svg>
    </div>
    <div className="text-center">
      <h1 className="text-3xl font-bold text-white tracking-tight">Pinglo</h1>
      <p className="text-sm text-gray-400 mt-1">Dev Bhai ka App 😎</p>
    </div>
    <div className="w-40 h-0.5 bg-gray-800 rounded-full overflow-hidden mt-4">
      <div className="h-full bg-[#25D366] rounded-full animate-[loading_2s_ease_forwards]" style={{animation:'loading 2s ease forwards'}} />
    </div>
    <style>{`@keyframes loading{from{width:0%}to{width:100%}}`}</style>
  </div>
);

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [callData, setCallData] = useState<ActiveCallData>({

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
    connectionQuality: 'unknown',
  });

  // Report 3 #229/#230 (W5b): mock-mode / partial-config status, computed
  // once at startup — build-time .env values cannot change at runtime
  // without a rebuild, so no subscription is needed. Drives the
  // persistent demo/partial banner below.
  const awsConfigStatus = useMemo(() => getAwsConfigStatus(), []);
  // Report 3 #224/#239 (W5b): startup session validation. The first
  // effect kicks the validation off (after initAwsAmplify); the auth
  // listener below awaits it before the splash clears, so /main is
  // unreachable until the restored session is proven real.
  const startupValidationRef = useRef<Promise<string> | null>(null);
  const validationGatedRef = useRef(false);
  const unvalidatedOfflineRef = useRef(false);

  // Report 3 #224/#239 (W5b): forced re-login for a restored session
  // that cannot exist on this build — a mock/demo account on a real
  // build, or a Cognito session the server no longer accepts. Parked
  // offline ops belong to the dead identity and can never send as a
  // Cognito user, so they are dropped (not retried under the next
  // account). The login screen reads `pinglo_forced_relogin` and
  // shows the honest reason (§4.4).
  const forceRelogin = useCallback(async (reason: 'mock-on-real-build' | 'no-cognito-session') => {
    try { localStorage.setItem('pinglo_forced_relogin', reason === 'mock-on-real-build' ? 'mock' : 'expired'); } catch { /* storage unavailable */ }
    try { getFailedOfflineOps().forEach((op) => discardFailedOfflineOp(op.id)); } catch { /* best-effort */ }
    try { clearOfflineQueue(); } catch { /* best-effort */ }
    try { await resetDbCache(); } catch { /* best-effort */ }
    // 100M-H6: the local media blob store dies with the cache too, or one
    // account's voice recordings outlive its session as unreachable orphans.
    try { await clearLocalMediaBlobs(); } catch { /* best-effort */ }
    try { await authManager.signOut(); } catch { /* signOut is best-effort internally */ }
  }, []);

  useEffect(() => {
    initAwsAmplify();

    // Report 3 #224/#239 (W5b): validate the restored session against
    // Cognito before the app routes anywhere. A mock/demo account
    // (usr_…/aws_…) from a pre-.env install must never silently live
    // on a real-config build. The auth listener below awaits this
    // promise before clearing the splash (10 s hard timeout inside
    // the validator; offline → unvalidated, never logged out).
    startupValidationRef.current = authManager.validateRestoredSession();

    if (Capacitor.isNativePlatform()) {
      document.documentElement.classList.add('capacitor-native');
      document.documentElement.style.setProperty('--sat', '0px');
      StatusBar.setOverlaysWebView({ overlay: false }).catch((err) => console.warn("[App] App: StatusBar.setOverlaysWebView({ overlay: false }) failed", err));
    } else {
      document.documentElement.style.setProperty('--sat', '0px');
    }

    // Theme fix: Light / Dark / System default via the chat-theme service
    // (migrates the legacy 'theme' key). System mode follows the device
    // live through a matchMedia listener.
    applyAppTheme(getAppTheme());
    const stopThemeListener = installAppThemeListener((dark) => {
      document.documentElement.classList.toggle('dark', dark);
      if (Capacitor.isNativePlatform()) {
        StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch((err) => console.warn("[App] App: StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }) failed", err));
        StatusBar.setBackgroundColor({ color: dark ? '#111B21' : '#075E54' }).catch((err) => console.warn("[App] App: StatusBar.setBackgroundColor({ color: dark ? '#111B21' : '#075E54'...", err));
      }
    });
    // Listener cleanup runs when the app unmounts (practically never on a
    // single-page app, but correct if the root is ever torn down).
    void stopThemeListener;

    // Set the status bar only after the saved theme is applied. Setting it earlier used
    // the wrong theme for saved-dark users, which left a white bar above the dark app.
    if (Capacitor.isNativePlatform()) {
      const isDarkMode = document.documentElement.classList.contains('dark');
      StatusBar.setStyle({ style: isDarkMode ? Style.Dark : Style.Light }).catch((err) => console.warn("[App] App: StatusBar.setStyle({ style: isDarkMode ? Style.Dark : Style.Light ...", err));
      StatusBar.setBackgroundColor({ color: isDarkMode ? '#111B21' : '#075E54' }).catch((err) => console.warn("[App] App: StatusBar.setBackgroundColor({ color: isDarkMode ? '#111B21' : '#0...", err));
    }
  }, []);

  const lastUidRef = useRef<string | null>(null);
  const prevCallStatusRef = useRef<string>('idle');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      // REPORT-3 #135 (W13 NEXT R3): the old code waited a FIXED 600ms
      // (`setTimeout(..., 600)`) before hiding the splash on EVERY cold
      // start — the probe measured the splash visible for 592–808ms,
      // ~600ms of which was this wait alone. Auth state is already
      // determined when this callback fires, so hide the splash
      // immediately; the route Suspense fallback is the same Splash, so
      // a still-loading screen chunk keeps the splash up anyway.
      const clearLoading = () => setLoading(false);
      if (!validationGatedRef.current) {
        // First emit = the restored session. Do not clear the splash
        // until startup validation settles: a dead session must force
        // re-login BEFORE /main is reachable, never after.
        validationGatedRef.current = true;
        const p = startupValidationRef.current;
        if (p) {
          void p.then((status) => {
            if (status === 'mock-on-real-build' || status === 'no-cognito-session') {
              void forceRelogin(status);
            } else if (status === 'unvalidated-offline') {
              unvalidatedOfflineRef.current = true;
            }
            clearLoading();
          }).catch(() => clearLoading());
        } else {
          clearLoading();
        }
      } else {
        clearLoading();
      }
      if ((u?.uid || null) !== lastUidRef.current) {
        // Different account (or sign-out): drop cached data and subscriptions
        const previousUid = lastUidRef.current;
        lastUidRef.current = u?.uid || null;
        // 4d: stop the global scheduled-message scheduler BEFORE the cache
        // is dropped, or its old per-user subscription would re-ensure itself.
        scheduledMessages.cleanup();
        // Only wipe the IndexedDB cache on a real sign-out / account switch
        // (there was a previous uid). On the first auth restore after a
        // reload lastUidRef is still null — keep the cache so
        // restorePersisted() can show local history until the server fetch
        // refreshes it. Caveat: the cache is per-device, not per-user, so
        // sign-out/switch still wipes it.
        if (previousUid !== null) {
          // #223/#232 (W5b R15): awaited — the flush inside reset() must
          // commit before any later users read merges onto the doc.
          await resetDbCache();
          // 100M-H6: local media blobs die with the cache on account
          // switch, same as the docs that reference them.
          try { await clearLocalMediaBlobs(); } catch { /* best-effort */ }
        }
      }
      if (u?.uid) {
        callService.init(u.uid);
        realtimeSync.init(u.uid, u);
        // L4: flush the offline outbox after (re)sign-in — the closest
        // hook to an auth/token refresh that exists in this repo (there
        // is no Amplify Hub listener; tokens refresh silently).
        void flushOfflineQueueAfterAuthRefresh();
        // Phase 2 push: foreground message watcher + (native only) token
        // registration. Web resolves immediately with no token (no FCM yet).
        initPushForUser(u.uid);
        // 4d: global scheduler — fires while the app is open on any screen.
        scheduledMessages.init(u.uid, u);
      } else {
        stopPushForUser();
      }
    });
    return () => unsubscribe();
  }, []);

  // Report 3 #224/#239 (W5b, D6): a startup validation that could not
  // run offline keeps the cached session and re-validates on the next
  // online event / foreground — a network error at startup must never
  // log the user out.
  useEffect(() => {
    const revalidate = () => {
      if (!unvalidatedOfflineRef.current || !auth.currentUser) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      unvalidatedOfflineRef.current = false;
      void authManager.validateRestoredSession().then((status) => {
        if (status === 'mock-on-real-build' || status === 'no-cognito-session') {
          void forceRelogin(status);
        } else if (status === 'unvalidated-offline') {
          unvalidatedOfflineRef.current = true;
        }
      }).catch(() => { unvalidatedOfflineRef.current = true; });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') revalidate(); };
    window.addEventListener('online', revalidate);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', revalidate);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [forceRelogin]);

  const [callConn, setCallConn] = useState<CallConnectionState | undefined>(undefined);

  // L4: surface failed sends. There is NO app-wide toast system in this
  // codebase (every toast is local to its screen; NotificationBanner only
  // shows push events), so the failed-outbox toast lives here in App —
  // the one component mounted on every screen — with a Retry action.
  // Ops are PARKED in localStorage (offlineQueue.ts), not lost, so Retry
  // re-queues them; dismissing only hides this session's toast.
  const [failedSendToast, setFailedSendToast] = useState<{ count: number; key: number } | null>(null);
  useEffect(() => {
    // Periodic (30 s) + foreground + 'online' flush; idempotent —
    // database.ts also starts it at import, this makes App the owner.
    startOfflineQueue();
    const parked = getFailedOfflineOps();
    if (parked.length > 0) {
      setFailedSendToast({ count: parked.length, key: Date.now() });
    }
    onOfflineOpDropped(() => {
      const failed = getFailedOfflineOps();
      if (failed.length > 0) setFailedSendToast({ count: failed.length, key: Date.now() });
    });
    onOfflineOpFailed((op, error, attemptsLeft) => {
      console.warn(`[App] offline send failed: ${op.kind} ${op.col || ''}/${op.docId || op.id} — ${error} (${attemptsLeft} retr${attemptsLeft === 1 ? 'y' : 'ies'} left before it is parked for manual retry)`);
    });
  }, []);

  useEffect(() => {
    // Phase 3: live connection quality -> CallModal "Reconnecting..." UI.
    const unsub = callService.onConnectionQuality((q) => {
      setCallConn(q === 'reconnecting' ? 'disconnected' : q === 'unknown' ? undefined : 'connected');
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    const unsubCall = callService.subscribe((data) => {
      if (data.status === 'incoming' && data.isIncoming && prevCallStatusRef.current !== 'incoming') {
        // Report 3 #52 — pass my uid so the call toast can carry the DM
        // conversation id (tap → open the chat to call back).
        notifyIncomingCall({ callerName: data.remoteName, callerId: data.remoteUserId, type: data.type, myUid: auth.currentUser?.uid });
      }
      prevCallStatusRef.current = data.status;
      if (data.status === 'idle' || data.status === 'ended') setCallConn(undefined);
      setCallData(data);
    });
    return () => unsubCall();
  }, []);

  if (loading) return <Splash />;

  return (
    <>
      <BrowserRouter>
      {/* R3 (Worker E, overnight round 2): the app shell is a h-dvh flex
          column — NotificationBanner is IN-FLOW as its first child, so it
          reserves its own height and can never cover content (the old
          fixed overlay covered the Updates "My status" row). The routes
          live in a flex-1 min-h-0 wrapper; screens keep their h-screen /
          h-dvh roots, but the .app-routes rule below sizes those roots to
          100% of the remaining shell space instead of 100vh, so bottom
          bars (bottom nav, chat composer) are never pushed below the
          viewport when the banner is present. The wrapper scrolls, so
          min-h-screen roots (Login/Signup, deliberately NOT overridden)
          still scroll instead of clipping. Fixed overlays (AppLockGate,
          CallModal, failed-send toast) are unaffected. */}
      <div className="flex h-dvh flex-col overflow-hidden bg-bg-light dark:bg-bg-dark">
      {/* Phase 5: the lock gate MUST live inside the Router (PinScreen uses
          useNavigate) and must only render when signed in — when signed out
          PinScreen has no user and spins on 'loading' forever (L-20).
          Style: the gate's PIN screen uses the WhatsApp Classic Pro header
          (#075E54 / dark #111B21) via the PinScreen patch P-11. */}
      {user ? <AppLockGate onUnlocked={() => {}} /> : null}
      <NavigationObserver />
      <DeepLinkHandler />
      <ShareIntentHandler user={user} />
      <NotificationBanner signedIn={!!user} />
      {/* Report 3 #229 (W5b): mock-mode / partial-config banner —
          persistent, NOT dismissible, in-flow above NotificationBanner
          so it shows on every screen including Login/Signup. The silent
          failure (messages never leaving this phone) must be impossible
          to miss; a per-session dismiss would re-create it. The banner
          labels mock mode, it does not block it — mock login still works. */}
      {!awsConfigStatus.configured && !awsConfigStatus.partial && (
        <div role="status" className="flex items-start gap-2 bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>You&apos;re in offline demo mode — messages stay on this phone and never reach anyone else.</span>
        </div>
      )}
      {awsConfigStatus.partial && (
        <div role="status" className="flex items-start gap-2 bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>App setup is incomplete — messages can&apos;t sync (missing: {awsConfigStatus.missing.join(', ')}). Ask whoever set up the app to check the configuration.</span>
        </div>
      )}
      {/* L4: failed-send toast — parked offline ops, with a Retry action. */}
      {failedSendToast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-3 bg-gray-800 text-white text-sm px-4 py-2.5 rounded-full shadow-2xl animate-toast max-w-[90vw]">
          <span className="truncate">
            {failedSendToast.count === 1 ? '1 message failed to send' : `${failedSendToast.count} messages failed to send`}
          </span>
          <button
            onClick={() => {
              retryAllFailedOfflineOps();
              setFailedSendToast(null);
            }}
            className="flex-shrink-0 rounded-full bg-green-cta px-3 py-1 text-xs font-bold text-white hover:bg-dark-green"
          >
            Retry
          </button>
          <button
            onClick={() => setFailedSendToast(null)}
            aria-label="Dismiss"
            className="flex-shrink-0 rounded-full hover:bg-white/10 px-1.5 py-0.5 text-gray-300"
          >
            ✕
          </button>
        </div>
      )}
      <Suspense fallback={null}>
        <ErrorBoundary fallback={<></>}><CallModal callData={callData} connectionState={callConn} /></ErrorBoundary>
      </Suspense>
      {/* R3: unlayered <style> beats Tailwind's layered utilities, and the
          two-class selector outranks .h-screen/.h-dvh on specificity too.
          Only DIRECT route children are targeted (Suspense renders no DOM
          node, so the screen root is the direct child); nested h-screen
          roots (modals, fallbacks inside a screen) are untouched. */}
      <style>{`.app-routes > .h-screen, .app-routes > .h-dvh { height: 100%; }`}</style>
      <div className="app-routes flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Suspense fallback={<Splash />}>
      <Routes>
        {/* Report 3 #48 — first launch shows the welcome screen once
            (hasSeenWelcome in localStorage); afterwards `/` goes to
            /login like before. Signed-in users always go to /main. */}
        <Route path="/" element={user ? <Navigate to="/main" /> : hasSeenWelcome() ? <Navigate to="/login" /> : <Navigate to="/welcome" />} />
        <Route path="/welcome" element={!user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><WelcomeScreen /></ErrorBoundary> : <Navigate to="/main" />} />
        <Route path="/login" element={!user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><LoginScreen /></ErrorBoundary> : <Navigate to="/main" />} />
        <Route path="/signup" element={!user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><SignupScreen /></ErrorBoundary> : <Navigate to="/main" />} />
        <Route path="/main/*" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><MainScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/chat/:chatId" element={user ? <ErrorBoundary fallback={(s) => <ChatCrashFallback {...s} />}><ChatScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/share" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><SharePickerScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/locked-chats" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><LockedChatsFolder /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/hidden-chats" element={<Navigate to="/locked-chats" replace />} />
        <Route path="/vault" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><VaultScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/dev" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><DevAIScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/settings" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><SettingsScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/settings/storage" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><StorageUsageScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/settings/network-usage" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><NetworkUsageScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/settings/proxy" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><ProxySettingsScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/settings/e2ee" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><E2EESettings /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/saved" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><SavedMessagesScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/starred" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><StarredScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/scheduled" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><ScheduledMessagesScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/broadcast" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><BroadcastScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/contacts" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><ContactsScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/search" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><UserSearchScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/admin" element={user ? <ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><AdminDashboardScreen /></ErrorBoundary> : <Navigate to="/login" />} />
        <Route path="/call/:hostUid" element={<ErrorBoundary fallback={(s) => <ScreenCrashFallback {...s} />}><CallLinkScreen /></ErrorBoundary>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
      </div>
      </div>
    </BrowserRouter>
    </>
  );
}
