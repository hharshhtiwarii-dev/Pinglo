/**
 * NotificationBanner — in-app foreground notifications (Phase 2).
 *
 * - Shows a dismissible toast stack (max 3) for new-message / incoming-call
 *   events emitted by src/services/pushNotifications.ts while the app is open.
 * - Tapping a message toast navigates to that chat (unless already there).
 * - If browser notifications are still undecided ('default') and the user has
 *   notifications enabled, shows a one-time slim prompt to enable them.
 *   Dismissing the prompt is remembered in localStorage.
 *
 * Mount once inside <BrowserRouter> (App.tsx) — it needs useNavigate.
 * No-ops on its own when notifications are disabled.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, MessageCircle, Phone, X } from 'lucide-react';
import { auth } from '../aws';
import { callService } from '../services/callService';
import {
  getNotificationPermission,
  isNotificationsEnabled,
  isPromptDismissed,
  dismissPermissionPrompt,
  isWebNotificationSupported,
  requestPermissionAndRegister,
  subscribePushEvents,
  getDmConversationId,
  NOTIF_PREFS_CHANGED_EVENT,
  type PushNotificationEvent,
} from '../services/pushNotifications';

interface Toast extends PushNotificationEvent {
  key: string;
}

// Report 3 #49 — the permission prompt used to show on the login screen:
// the banner mounts unconditionally in the App shell and the prompt effect
// had no signed-in check. WhatsApp asks after registration, so the prompt
// is now gated on `signedIn` (App passes !!user). Toasts are unaffected —
// they can only arrive after sign-in anyway (the watcher starts then).
export default function NotificationBanner({ signedIn }: { signedIn?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [showPrompt, setShowPrompt] = useState(false);
  // WA parity top-10 #10: when permission is DENIED (not just undecided),
  // show a persistent, non-nagging in-list banner with a path back to
  // enable notifications — previously a user who denied got silence and
  // no way back from the list. Dismissal is remembered separately from
  // the undecided prompt's dismissal.
  const [showDeniedPrompt, setShowDeniedPrompt] = useState(false);
  const DENIED_DISMISSED_KEY = 'pinglo_notif_denied_dismissed';
  const isDeniedDismissed = () => {
    try { return localStorage.getItem(DENIED_DISMISSED_KEY) === '1'; } catch { return false; }
  };

  // REPORT-3 #70 + #49/#63 (merged): the "Turn on notifications?" prompt
  // must not nag on every screen — never inside Settings / Vault /
  // locked-chats, and never before sign-in (the banner mounts in the App
  // shell). It re-evaluates when the notifications toggle flips
  // (NOTIF_PREFS_CHANGED_EVENT), when sign-in state changes, and when the
  // route changes. Real event toasts are unaffected — only the permission
  // prompt is suppressed here.
  const promptSuppressedHere =
    location.pathname.startsWith('/settings') ||
    location.pathname.startsWith('/vault') ||
    location.pathname.startsWith('/locked-chats');

  // Permission prompt: web only, signed in, undecided permission, not
  // dismissed before.
  useEffect(() => {
    const evaluatePrompt = () => {
      if (promptSuppressedHere) {
        setShowPrompt(false);
        setShowDeniedPrompt(false);
        return;
      }
      if (!signedIn) {
        setShowPrompt(false);
        setShowDeniedPrompt(false);
        return;
      }
      if (!isWebNotificationSupported()) return;
      if (!isNotificationsEnabled()) {
        setShowPrompt(false);
        setShowDeniedPrompt(false);
        return;
      }
      if (getNotificationPermission() === 'denied') {
        // Denied (not undecided): the one-time Enable prompt can never
        // fire again — show the persistent denied banner instead, unless
        // the user already dismissed it. Never show both at once.
        setShowPrompt(false);
        setShowDeniedPrompt(!isDeniedDismissed());
        return;
      }
      setShowDeniedPrompt(false);
      if (isPromptDismissed()) return;
      if (getNotificationPermission() === 'default') setShowPrompt(true);
      else setShowPrompt(false);
    };
    evaluatePrompt();
    const onPrefsChanged = () => evaluatePrompt();
    window.addEventListener(NOTIF_PREFS_CHANGED_EVENT, onPrefsChanged);
    return () => window.removeEventListener(NOTIF_PREFS_CHANGED_EVENT, onPrefsChanged);
  }, [signedIn, promptSuppressedHere]);

  useEffect(() => {
    const unsub = subscribePushEvents((ev) => {
      // Don't toast for the chat the user is already looking at.
      if (
        ev.kind === 'message' &&
        ev.conversationId &&
        window.location.pathname === `/chat/${ev.conversationId}`
      ) {
        return;
      }
      // Report 3 #123 — an incoming-call toast while a call is live is
      // untappable decoration: the CallModal is a full-screen z-[999]
      // overlay above this banner, so the tap can never reach the
      // toast — and the modal already IS the incoming-call UI. Suppress
      // the duplicate instead of showing a dead toast. Missed-call
      // toasts are unaffected (the call is over by then, status
      // 'ended'/'idle') and keep the tap-to-call-back behaviour (#60).
      if (ev.kind === 'call') {
        const st = callService.getStatus();
        if (st !== 'idle' && st !== 'ended') return;
      }
      const toast: Toast = { ...ev, key: ev.eventId || `${ev.kind}-${ev.timestamp}-${Math.random()}` };
      setToasts((prev) => {
        if (prev.some((t) => t.key === toast.key)) return prev;
        return [toast, ...prev].slice(0, 3);
      });
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.key !== toast.key));
      }, 5000);
    });
    return unsub;
  }, []);

  const handleEnable = async () => {
    const uid = auth.currentUser?.uid;
    if (uid) await requestPermissionAndRegister(uid).catch(() => {});
    setShowPrompt(false);
  };

  // Report 3 #60 — tapping a call toast used to do nothing:
  // handleToastClick only navigated for kind === 'message'. A call toast
  // now opens the caller's chat (conversationId is set by
  // notifyIncomingCall / notifyMissedCall; otherwise the DM id is derived
  // from the sender id) so the user can call back; with no sender at all
  // (locked-call generic toast) it falls back to /main.
  const handleToastClick = (t: Toast) => {
    setToasts((prev) => prev.filter((x) => x.key !== t.key));
    if (t.kind === 'message' && t.conversationId) {
      navigate(`/chat/${t.conversationId}`);
      return;
    }
    if (t.kind === 'call') {
      if (t.conversationId) {
        navigate(`/chat/${t.conversationId}`);
        return;
      }
      const myUid = auth.currentUser?.uid;
      if (t.senderId && myUid) {
        navigate(`/chat/${getDmConversationId(myUid, t.senderId)}`);
        return;
      }
      navigate('/main');
    }
  };

  // R3 (Worker E, overnight round 2, 2026-11-14): this banner used to be a
  // FIXED overlay at top-72px, so the permission prompt (which stays until
  // dismissed) covered the top content rows — on the Updates tab the "My
  // status" row (y112-176) sat under the banner (y72-166) and
  // elementFromPoint returned the banner <p>, swallowing the tap. Moving
  // it below the header fixed the header buttons but not the content.
  // The banner is now IN-FLOW: it renders as the first child of the app
  // shell (App.tsx) and reserves its own height in the layout, so no
  // content can ever slide under it — header, status row, chat list and
  // composer all shift down by exactly the banner's height while it is
  // present, and reclaim the space when it is dismissed. It renders null
  // when there is nothing to show, so it takes zero height then.
  // Screens keep their h-screen roots; App.tsx overrides those to
  // height:100% of the remaining shell space (see .app-routes rule).
  if (!showPrompt && !showDeniedPrompt && toasts.length === 0) return null;
  return (
    <div className="w-full flex-shrink-0 flex flex-col items-center gap-2 px-3 py-2 bg-bg-light dark:bg-bg-dark">
      {showDeniedPrompt && (
        <div className="flex w-full max-w-md items-center gap-3 rounded-2xl bg-panel-light dark:bg-panel-dark px-4 py-3 shadow-xl border border-gray-200 dark:border-white/10">
          <Bell className="h-5 w-5 flex-shrink-0 text-primary-green" />
          <p className="flex-1 text-sm text-gray-900 dark:text-text-primary">
            Notifications are off — turn them on in your browser settings to get message alerts.
          </p>
          <button
            onClick={() => navigate('/settings')}
            className="rounded-full bg-green-cta px-3 py-1.5 text-xs font-bold text-white hover:bg-dark-green"
          >
            Settings
          </button>
          <button
            onClick={() => {
              try { localStorage.setItem(DENIED_DISMISSED_KEY, '1'); } catch { /* best-effort */ }
              setShowDeniedPrompt(false);
            }}
            aria-label="Dismiss"
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
          >
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
      )}
      {showPrompt && (
        <div className="flex w-full max-w-md items-center gap-3 rounded-2xl bg-panel-light dark:bg-panel-dark px-4 py-3 shadow-xl border border-gray-200 dark:border-white/10">
          <Bell className="h-5 w-5 flex-shrink-0 text-primary-green" />
          <p className="flex-1 text-sm text-gray-900 dark:text-text-primary">
            Turn on notifications to know when messages arrive?
          </p>
          <button
            onClick={handleEnable}
            className="rounded-full bg-green-cta px-3 py-1.5 text-xs font-bold text-white hover:bg-dark-green"
          >
            Enable
          </button>
          <button
            onClick={() => {
              dismissPermissionPrompt();
              setShowPrompt(false);
            }}
            aria-label="Dismiss"
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
          >
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
      )}

      {toasts.map((t) => (
        <button
          key={t.key}
          onClick={() => handleToastClick(t)}
          className="flex w-full max-w-md items-start gap-3 rounded-2xl bg-panel-light dark:bg-panel-dark px-4 py-3 text-left shadow-xl border border-gray-200 dark:border-white/10 animate-[slideDown_0.2s_ease-out]"
        >
          <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary-green/15 text-primary-green">
            {t.kind === 'call' ? <Phone className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-gray-900 dark:text-text-primary">
              {t.title}
            </span>
            <span className="block truncate text-sm text-gray-500 dark:text-text-secondary">{t.body}</span>
          </span>
          <span
            role="button"
            tabIndex={0}
            aria-label="Dismiss notification"
            onClick={(e) => {
              e.stopPropagation();
              setToasts((prev) => prev.filter((x) => x.key !== t.key));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setToasts((prev) => prev.filter((x) => x.key !== t.key));
              }
            }}
            className="flex-shrink-0 mt-1 rounded-full p-0.5 hover:bg-gray-100 dark:hover:bg-input-dark cursor-pointer"
          >
            <X className="h-4 w-4 text-gray-400" />
          </span>
        </button>
      ))}
      <style>{`@keyframes slideDown{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}
