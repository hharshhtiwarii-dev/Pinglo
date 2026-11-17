/**
 * PostCallNotificationsBanner — Wave-2 B3, WA audit Calls #74.
 *
 * WA value: `WAWebPostCallNotificationsUpsellBanner` — a lazy-loaded
 * banner shown after a call, prompting the user to enable call
 * notifications. DT had no post-call upsell / enable-notifications
 * banner anywhere.
 *
 * Behaviour (follows the existing NotificationBanner pattern):
 * - Shows in-flow at the top of the Calls tab, only shortly after a
 *   call ended (10-minute window) AND only when call notifications
 *   cannot currently fire: in-app notifications are enabled but the
 *   browser permission is not 'granted' ('default' → Enable button,
 *   'denied' → Settings button, since a denied permission cannot be
 *   re-requested in-page).
 * - Two triggers feed the same "last call ended" timestamp: the live
 *   callService status transition into 'ended' (the call that just
 *   finished in this session), and the `recentEndedAt` prop from
 *   CallsScreen (the newest history doc's `endedAt`, falling back to
 *   its timestamp — callee-side records carry no `endedAt`, but their
 *   timestamp is written at the end of the call, so it is the same
 *   moment). The history trigger also covers a call that ended while
 *   the Calls tab was not mounted (e.g. a missed call).
 * - Dismissing is remembered per call: the dismissed timestamp is
 *   stored, so the banner stays hidden for that call but re-appears
 *   after a newer call ends. It never nags about an old call.
 * - Hidden while a call is live.
 *
 * Mounted by CallsScreen only (the Calls tab). No-ops when there is no
 * recent call or when notifications can already fire.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, X } from 'lucide-react';
import { auth } from '../aws';
import { callService } from '../services/callService';
import {
  getNotificationPermission,
  isNotificationsEnabled,
  isWebNotificationSupported,
  requestNotificationPermission,
  requestPermissionAndRegister,
  NOTIF_PREFS_CHANGED_EVENT,
} from '../services/pushNotifications';

// The call this banner was dismissed for (its ended-at timestamp). A
// newer call re-shows the banner; the same call never nags twice.
const DISMISSED_KEY = 'pinglo_postcall_upsell_dismissed_for';
// WA shows the upsell right after the call — a banner about a call
// from an hour ago is stale. 10 minutes covers the ended screen +
// navigating back to the Calls tab, without lingering.
const RECENT_WINDOW_MS = 10 * 60 * 1000;

function readDismissedFor(): number {
  try {
    return Number(localStorage.getItem(DISMISSED_KEY) || '0') || 0;
  } catch {
    return 0;
  }
}

export default function PostCallNotificationsBanner({
  recentEndedAt,
}: {
  /** Newest history doc's ended-at (endedAt, else timestamp), or null. */
  recentEndedAt: number | null;
}) {
  const navigate = useNavigate();
  const [liveEndedAt, setLiveEndedAt] = useState<number | null>(null);
  const [callLive, setCallLive] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<number>(readDismissedFor);
  const [enabling, setEnabling] = useState(false);
  // Re-evaluate the recency window as time passes (a banner shown at
  // minute 9 must disappear at minute 10 without a reload).
  const [, setTick] = useState(0);
  const prevStatusRef = useRef<string | null>(null);

  // Live trigger: the callService status transition into 'ended'.
  useEffect(() => {
    const unsub = callService.subscribe((call) => {
      const prev = prevStatusRef.current;
      prevStatusRef.current = call.status;
      setCallLive(
        call.status === 'outgoing' ||
          call.status === 'incoming' ||
          call.status === 'connecting' ||
          call.status === 'connected',
      );
      if (prev !== null && prev !== 'ended' && call.status === 'ended') {
        setLiveEndedAt(Date.now());
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setTick((v) => v + 1), 30_000);
    const onPrefsChanged = () => setTick((v) => v + 1);
    window.addEventListener(NOTIF_PREFS_CHANGED_EVENT, onPrefsChanged);
    return () => {
      window.clearInterval(t);
      window.removeEventListener(NOTIF_PREFS_CHANGED_EVENT, onPrefsChanged);
    };
  }, []);

  const endedAt = Math.max(liveEndedAt ?? 0, recentEndedAt ?? 0);
  const isRecent = endedAt > 0 && Date.now() - endedAt <= RECENT_WINDOW_MS;
  const permission = isWebNotificationSupported()
    ? getNotificationPermission()
    : 'unsupported';
  const show =
    !callLive &&
    isRecent &&
    endedAt > dismissedFor &&
    isWebNotificationSupported() &&
    isNotificationsEnabled() &&
    permission !== 'granted' &&
    permission !== 'unsupported';

  const handleEnable = async () => {
    if (enabling) return;
    setEnabling(true);
    try {
      const uid = auth.currentUser?.uid;
      if (uid) {
        await requestPermissionAndRegister(uid).catch(() => {});
      } else {
        // Mock/offline mode has no signed-in uid yet — the browser
        // permission is still the thing being asked for.
        await requestNotificationPermission().catch(() => {});
      }
    } finally {
      setEnabling(false);
      // Permission is now 'granted' (or still 'default' if the user
      // dismissed the prompt) — re-render re-evaluates `show`.
      setTick((v) => v + 1);
    }
  };

  const handleDismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(endedAt));
    } catch {
      /* best-effort */
    }
    setDismissedFor(endedAt);
  };

  if (!show) return null;
  const denied = permission === 'denied';
  return (
    <div
      data-testid="post-call-notif-upsell"
      aria-label="Call notifications banner"
      className="mx-4 mt-3 flex items-center gap-3 rounded-2xl bg-panel-light dark:bg-panel-dark px-4 py-3 shadow-xl border border-gray-200 dark:border-white/10"
    >
      <Bell className="h-5 w-5 flex-shrink-0 text-primary-green" />
      <p className="flex-1 text-sm text-gray-900 dark:text-text-primary">
        {denied
          ? 'Call notifications are off — turn them on in your browser settings so you don\u2019t miss calls.'
          : 'Never miss a call — turn on notifications to get alerted when someone calls you.'}
      </p>
      {denied ? (
        <button
          onClick={() => navigate('/settings')}
          className="rounded-full bg-green-cta px-3 py-1.5 text-xs font-bold text-white hover:bg-dark-green"
        >
          Settings
        </button>
      ) : (
        <button
          onClick={() => void handleEnable()}
          disabled={enabling}
          className="rounded-full bg-green-cta px-3 py-1.5 text-xs font-bold text-white hover:bg-dark-green disabled:opacity-50"
        >
          Enable
        </button>
      )}
      <button
        onClick={handleDismiss}
        aria-label="Dismiss call notifications banner"
        className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
      >
        <X className="h-4 w-4 text-gray-500" />
      </button>
    </div>
  );
}
