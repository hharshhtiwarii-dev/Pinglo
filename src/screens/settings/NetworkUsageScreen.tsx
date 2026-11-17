import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowDownToLine, ArrowUpFromLine, FileText, Image as ImageIcon,
  MessageSquare, Mic, Phone, RefreshCw, Trash2, Video,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth, collection, db, onSnapshot, query, where } from '../../aws';
import { dedupCallHistory } from '../calls/callHistory';
import { formatBytes } from '../../services/storageUsage';
import {
  getNetworkUsage, resetNetworkUsage,
  NETWORK_USAGE_CATEGORIES, NETWORK_USAGE_CATEGORY_LABELS,
  totalBytes, totalCount,
  type NetworkUsage, type NetworkUsageCategory,
} from '../../services/networkUsage';

const CATEGORY_ICON: Record<NetworkUsageCategory, any> = {
  text: MessageSquare,
  image: ImageIcon,
  video: Video,
  audio: Mic,
  document: FileText,
};

export default function NetworkUsageScreen({ onBack }: { onBack?: () => void } = {}) {
  const navigate = useNavigate();
  const [usage, setUsage] = useState<NetworkUsage>(() => getNetworkUsage());
  const [toast, setToast] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  // WA parity (audit #61, Wave-2 C4): calls row from call history —
  // count + total connected duration. Call DATA bytes are not measured
  // (needs RTC stats — see networkUsage.ts header), so the row says so
  // honestly instead of showing a fake 0. Reads only my own calls
  // (same two-sided caller/receiver queries as CallsScreen; Firestore
  // rules only allow calls I am part of).
  const [callStats, setCallStats] = useState<{ count: number; totalDurationSec: number }>({ count: 0, totalDurationSec: 0 });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const byId: Record<string, Record<string, any>> = { caller: {}, receiver: {} };
    const publish = () => {
      const all = [...Object.values(byId.caller), ...Object.values(byId.receiver)];
      const unique = Array.from(new Map(all.map((c: any) => [c.id, c])).values());
      // Caller doc + callee doc are two docs for one call — dedup on
      // call identity (shared helper from CallsScreen), or one call
      // would count twice.
      const deduped = dedupCallHistory(unique, uid);
      const totalDurationSec = deduped.reduce((sum: number, c: any) => sum + (Number(c.duration) || 0), 0);
      setCallStats({ count: deduped.length, totalDurationSec });
    };
    const listen = (field: 'callerId' | 'receiverId', key: 'caller' | 'receiver') =>
      onSnapshot(query(collection(db, 'calls'), where(field, '==', uid)), (snap: any) => {
        byId[key] = Object.fromEntries(snap.docs.map((d: any) => [d.id, { id: d.id, ...d.data() }]));
        publish();
      });
    const unsubA = listen('callerId', 'caller');
    const unsubB = listen('receiverId', 'receiver');
    return () => { unsubA(); unsubB(); };
  }, []);

  const refresh = () => setUsage(getNetworkUsage());

  useEffect(() => {
    refresh();
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToastMsg = (msg: string) => {
    // House pattern (SettingsScreen, 100M-D5): clear the previous toast's
    // timer first, or it clears the newer toast early.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  };

  const handleReset = () => {
    resetNetworkUsage();
    setUsage(getNetworkUsage());
    setConfirmReset(false);
    showToastMsg('Network usage reset');
  };

  const goBack = () => {
    if (onBack) onBack();
    else navigate('/settings');
  };

  const sentBytes = totalBytes(usage, 'sent');
  const receivedBytes = totalBytes(usage, 'received');

  /** Total connected call time as h:mm:ss (duration on a calls doc is seconds). */
  const formatCallTotal = (totalSec: number): string => {
    const s = Math.floor(totalSec) || 0;
    if (s <= 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  };

  return (
    <div className="min-h-screen bg-[#f0f2f5] dark:bg-background-dark">
      <header className="sticky top-0 z-10 bg-green-cta text-white shadow">
        <div className="flex items-center gap-2 px-2 py-3">
          <button
            onClick={goBack}
            aria-label="Back to settings"
            className="p-2 rounded-full hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-medium">Network usage</h1>
          <div className="flex-1" />
          <button
            onClick={refresh}
            aria-label="Refresh network usage"
            className="p-2 rounded-full hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"
          >
            <RefreshCw className="h-5 w-5" />
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Data sent and received on this device. Counts are stored only on
          this device and are never uploaded.
        </p>

        <div className="grid grid-cols-2 gap-3 mt-4">
          <div className="bg-white dark:bg-panel-dark rounded-lg p-4 shadow-sm">
            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
              <ArrowUpFromLine className="h-5 w-5 text-primary-green" aria-hidden="true" />
              <span className="text-sm">Sent</span>
            </div>
            <p className="text-2xl font-semibold mt-2 text-gray-900 dark:text-text-primary" aria-label={`Sent ${formatBytes(sentBytes)}`}>
              {formatBytes(sentBytes)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {totalCount(usage, 'sent')} items sent
            </p>
          </div>
          <div className="bg-white dark:bg-panel-dark rounded-lg p-4 shadow-sm">
            <div className="flex items-center gap-2 text-gray-600 dark:text-gray-300">
              <ArrowDownToLine className="h-5 w-5 text-primary-green" aria-hidden="true" />
              <span className="text-sm">Received</span>
            </div>
            <p className="text-2xl font-semibold mt-2 text-gray-900 dark:text-text-primary" aria-label={`Received ${formatBytes(receivedBytes)}`}>
              {formatBytes(receivedBytes)}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {totalCount(usage, 'received')} items received
            </p>
          </div>
        </div>

        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200 mt-6 mb-2">
          Breakdown by type
        </h2>
        <div className="bg-white dark:bg-panel-dark rounded-lg shadow-sm divide-y divide-gray-100 dark:divide-white/5">
          {NETWORK_USAGE_CATEGORIES.map((cat) => {
            const Icon = CATEGORY_ICON[cat];
            const sent = usage.sent[cat];
            const received = usage.received[cat];
            return (
              <div key={cat} className="flex items-center gap-3 px-4 py-3">
                <Icon className="h-5 w-5 text-primary-green flex-shrink-0" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] text-gray-900 dark:text-text-primary">
                    {NETWORK_USAGE_CATEGORY_LABELS[cat]}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {sent.count} sent, {received.count} received
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm text-gray-900 dark:text-text-primary">
                    {formatBytes(sent.bytes)} sent
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatBytes(received.bytes)} received
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {/* WA parity (audit #61, Wave-2 C4): the calls row. Count + total
            connected duration come from call history; call data bytes are
            NOT measured (no RTC-stats hookup yet), so the row says so
            instead of showing a fake byte count. Call bytes are also not
            folded into the Sent/Received totals above. */}
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200 mt-6 mb-2">
          Calls
        </h2>
        <div className="bg-white dark:bg-panel-dark rounded-lg shadow-sm">
          <div className="flex items-center gap-3 px-4 py-3">
            <Phone className="h-5 w-5 text-primary-green flex-shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-[15px] text-gray-900 dark:text-text-primary">
                Calls
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {callStats.count === 0
                  ? 'No calls yet'
                  : `${callStats.count} call${callStats.count === 1 ? '' : 's'} · ${formatCallTotal(callStats.totalDurationSec)} total talk time`}
              </p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm text-gray-900 dark:text-text-primary">
                Data not measured
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                count + duration only
              </p>
            </div>
          </div>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
          Received photos, videos, audio and documents show a message count
          only. Their bytes are not counted yet, because the app has no way
          to measure a download it did not start. Calls show count and total
          talk time from your call history; their data bytes are not
          measured yet.
        </p>

        <div className="mt-6">
          {confirmReset ? (
            <div
              className="bg-white dark:bg-panel-dark rounded-lg p-4 shadow-sm"
              role="alertdialog"
              aria-label="Reset network usage"
            >
              <p className="text-[15px] text-gray-900 dark:text-text-primary">
                Reset all network usage counters on this device?
              </p>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={handleReset}
                  className="px-4 py-2 rounded-full bg-danger-red text-white text-sm hover:opacity-90 focus-visible:outline-2 focus-visible:outline-primary-green"
                >
                  Reset counters
                </button>
                <button
                  onClick={() => setConfirmReset(false)}
                  className="px-4 py-2 rounded-full bg-gray-200 dark:bg-white/10 text-sm text-gray-900 dark:text-text-primary hover:bg-gray-300 dark:hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-primary-green"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmReset(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-white dark:bg-panel-dark shadow-sm text-sm text-danger-red hover:bg-gray-50 dark:hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-primary-green"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Reset statistics
            </button>
          )}
        </div>
      </main>

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-full shadow-lg z-50"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
