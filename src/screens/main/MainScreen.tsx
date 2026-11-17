import { useState, useEffect, lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import { MessageSquare, CircleDashed, Users, Phone } from 'lucide-react';
import ChatListScreen from '../chats/ChatListScreen';
// B1 (W13 NEXT R6): the three non-default tabs used to be static imports,
// so MainScreen's chunk carried StatusScreen (1,606 lines) +
// CommunitiesScreen + CallsScreen AND their transitive chunks
// (GroupInfoModal, QRCodeModal, VoiceNotePlayer, groupAdmin,
// storageUsage) — all downloaded before main-usable even though only the
// Chats tab is visible (slow-3G baseline: 329,800 B over 13 files,
// main-usable 9,348 ms). Lazy-load them: the chunk fetches on first
// activation (or on the idle prefetch below), never before first paint.
// ChatListScreen stays static — it is the default tab.
const StatusScreen = lazy(() => import('../status/StatusScreen'));
const CommunitiesScreen = lazy(() => import('../communities/CommunitiesScreen'));
const CallsScreen = lazy(() => import('../calls/CallsScreen'));
import { navigationManager } from '../../services/navigation';
import { useLanguage, type TranslationKey } from '../../services/language';
import ListSkeleton from '../../components/ListSkeleton';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { auth, collection, db, onSnapshot, query, where } from '../../aws';
import { loadHiddenChatIds } from '../../services/lockedChats';
import { dedupCallHistory, callDocTs, isMissedCallFor } from '../calls/callHistory';

// Scoped fallback for a tab whose chunk failed to load: the boundary
// auto-reloads on chunk errors (same recovery as the lazy routes — the
// in-page retries cannot clear a poisoned module map, only a reload can;
// see #248). Non-chunk errors stay on this screen with a manual Reload.
function TabLoadError({ autoReloading, onBackToChats }: { autoReloading: boolean; onBackToChats: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-medium">This tab couldn&apos;t be opened</p>
      <p className="text-xs text-gray-500 dark:text-text-secondary">
        {autoReloading ? 'Retrying automatically…' : 'Your chats are safe — go back or reload.'}
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-green-cta text-white rounded-xl text-sm font-semibold"
        >
          Reload app
        </button>
        <button
          type="button"
          onClick={onBackToChats}
          className="px-4 py-2 bg-gray-100 dark:bg-panel-dark rounded-xl text-sm font-semibold"
        >
          Back to Chats
        </button>
      </div>
    </div>
  );
}

export default function MainScreen() {
  const [activeTab, setActiveTab] = useState('chats');
  // B1: mount-on-first-activation. The old code mounted all four tabs at
  // once in hidden divs (keep-alive) — which is WHY the lazy chunks above
  // would still download at boot: React.lazy fetches on first render, even
  // hidden. So a tab renders only once it has been activated; after that it
  // stays mounted (hidden div) exactly as before, so tab state still
  // survives switching. 'chats' is always activated (default tab).
  const [activatedTabs, setActivatedTabs] = useState<Set<string>>(() => new Set(['chats']));
  // Phase 4: main nav labels follow the language setting (en/hi).
  const { t } = useLanguage();
  const currentUser = auth.currentUser;

  // W12d (100-more C1): missed-call badge on the Calls tab (WhatsApp
  // shows one). Same missed definition as CallsScreen's Missed filter:
  // status 'missed', or callee-side 'declined'/'busy' (stored status
  // stays, only the view counts them — W12b/W12c). Locked partners are
  // excluded, same as the history (Phase 5 L-19). The badge counts
  // missed calls newer than the last time the user looked at the Calls
  // tab; opening the tab marks everything seen (persisted per user so
  // a reload does not resurrect the badge).
  const [calls, setCalls] = useState<any[]>([]);
  const [lockedIds, setLockedIds] = useState<string[]>([]);
  const [callsSeenAt, setCallsSeenAt] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(`pinglo_calls_seen_${auth.currentUser?.uid || ''}`) || 0);
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    if (!currentUser) return;
    void loadHiddenChatIds(currentUser.uid).then(setLockedIds);
  }, [currentUser]);
  useEffect(() => {
    if (!currentUser) return;
    // Same two-sided query as CallsScreen: the rules only allow reading
    // calls you are part of, so no full-collection scan.
    const byId: Record<string, Record<string, any>> = { caller: {}, receiver: {} };
    const publish = () => {
      const all = [...Object.values(byId.caller), ...Object.values(byId.receiver)];
      setCalls(Array.from(new Map(all.map((c: any) => [c.id, c])).values()));
    };
    const listen = (field: 'callerId' | 'receiverId', key: 'caller' | 'receiver') =>
      onSnapshot(query(collection(db, 'calls'), where(field, '==', currentUser.uid)), (snap) => {
        byId[key] = Object.fromEntries(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
        publish();
      });
    const unsubs = [listen('callerId', 'caller'), listen('receiverId', 'receiver')];
    return () => {
      unsubs.forEach((u) => {
        try {
          u();
        } catch {
          /* already gone */
        }
      });
    };
  }, [currentUser]);
  useEffect(() => {
    if (activeTab !== 'calls' || !currentUser) return;
    // Looking at the list marks everything seen — including a missed
    // call that lands while the tab is open.
    const now = Date.now();
    setCallsSeenAt(now);
    try {
      localStorage.setItem(`pinglo_calls_seen_${currentUser.uid}`, String(now));
    } catch {
      /* private mode: the in-memory value still clears the badge */
    }
  }, [activeTab, calls, currentUser]);
  // WA-verify-calls-4 (rows 56/57): the badge used to count RAW `calls`
  // docs with a bare `status === 'missed'` — no dedup, no viewer check.
  // Every call is written twice, and the CALLEE's 'missed' doc lands in
  // the CALLER's snapshot too (its callerId is the caller), so my own
  // outgoing unanswered ring counted as a missed call for ME. Count
  // deduped calls through the one shared missed rule instead — the same
  // view CallsScreen's Missed tab uses, so the tab count and the badge
  // can never disagree again.
  const missedBadgeCount =
    activeTab === 'calls'
      ? 0
      : dedupCallHistory(calls, currentUser?.uid).filter((c: any) => {
          if (!isMissedCallFor(c, currentUser?.uid)) return false;
          const other = c.callerId === currentUser?.uid ? c.receiverId : c.callerId;
          if (lockedIds.includes(other)) return false;
          return callDocTs(c) > callsSeenAt;
        }).length;

  const goToTab = (id: string) => {
    setActivatedTabs((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setActiveTab(id);
  };

  useEffect(() => {
    if (activeTab !== 'chats') {
      return navigationManager.pushHandler(() => {
        setActiveTab('chats');
        return true;
      });
    }
  }, [activeTab]);

  // REPORT-3 #253 — cross-tab link: StatusScreen's "Find channels"
  // dispatches `pinglo:switch-tab` (same CustomEvent pattern
  // language.ts / appLock.ts use) because activeTab is local state here
  // and there is no route per tab. Only the four real tab ids switch.
  useEffect(() => {
    const onSwitchTab = (e: Event) => {
      const tab = (e as CustomEvent<string>).detail;
      if (tab === 'chats' || tab === 'updates' || tab === 'communities' || tab === 'calls') goToTab(tab);
    };
    window.addEventListener('pinglo:switch-tab', onSwitchTab);
    return () => window.removeEventListener('pinglo:switch-tab', onSwitchTab);
  }, []);

  // REPORT-3 #136 (W13 NEXT R3): warm the ChatScreen chunk while the user
  // is idle on the chat list. The probe measured the chunk fetch at
  // 1.5–3.1s of a 2.2–4.3s chat open (65–80% of the open time) — the
  // render/data half is only ~0.5–0.8s. Prefetching on idle makes the
  // first chat open pay ~0 fetch time; the chunk is then cached for the
  // session. Vite/Rollup dedupes this dynamic import with the route's
  // lazy() import (same module → same chunk), so the open itself fetches
  // nothing extra. Skipped on save-data / 2G so it never burns a
  // metered connection for a screen the user may never open.
  useEffect(() => {
    let cancelled = false;
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData || conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') return;
    const prefetch = () => {
      if (cancelled) return;
      void import('../chat/ChatScreen').catch(() => { /* the open fetches it on demand */ });
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }).requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric(prefetch, { timeout: 5000 });
      return () => { cancelled = true; (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id); };
    }
    const timer = setTimeout(prefetch, 2500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  // B1: same idle-prefetch pattern for the three lazy tabs, so the first
  // tab switch after the user has sat on the chat list is instant on a
  // decent connection. Fires only after mount (never before first paint),
  // same skip rule as #136. Vite dedupes these dynamic imports with the
  // lazy() imports above (same module → same chunk).
  useEffect(() => {
    let cancelled = false;
    const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData || conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') return;
    const prefetchTabs = () => {
      if (cancelled) return;
      void import('../status/StatusScreen').catch(() => { /* the tab fetches it on demand */ });
      void import('../communities/CommunitiesScreen').catch(() => { /* the tab fetches it on demand */ });
      void import('../calls/CallsScreen').catch(() => { /* the tab fetches it on demand */ });
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }).requestIdleCallback;
    if (typeof ric === 'function') {
      const id = ric(prefetchTabs, { timeout: 5000 });
      return () => { cancelled = true; (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback?.(id); };
    }
    const timer = setTimeout(prefetchTabs, 2500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const tabs: { id: string; label: TranslationKey; icon: typeof MessageSquare }[] = [
    { id: 'chats', label: 'chats', icon: MessageSquare },
    { id: 'updates', label: 'updates', icon: CircleDashed },
    { id: 'communities', label: 'communities', icon: Users },
    { id: 'calls', label: 'calls', icon: Phone },
  ];

  // B1: a lazy tab renders inside its own ErrorBoundary + Suspense so a
  // chunk failure on first switch shows a scoped fallback (with Reload /
  // Back to Chats) instead of blanking the whole app at the root boundary.
  const lazyTab = (Screen: LazyExoticComponent<ComponentType>) => (
    <ErrorBoundary
      fallback={(s: { error: Error | null; autoReloading: boolean }) => (
        <TabLoadError autoReloading={s.autoReloading} onBackToChats={() => goToTab('chats')} />
      )}
    >
      <Suspense fallback={<ListSkeleton rows={5} />}>
        <Screen />
      </Suspense>
    </ErrorBoundary>
  );

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark overflow-hidden">
      {/* Tab content */}
      <div className="flex-1 overflow-hidden relative">
        <div className={`h-full w-full ${activeTab === 'chats' ? 'block' : 'hidden'}`}>
          <ChatListScreen />
        </div>
        {activatedTabs.has('updates') && (
          <div className={`h-full w-full ${activeTab === 'updates' ? 'block' : 'hidden'}`}>
            {lazyTab(StatusScreen)}
          </div>
        )}
        {activatedTabs.has('communities') && (
          <div className={`h-full w-full ${activeTab === 'communities' ? 'block' : 'hidden'}`}>
            {lazyTab(CommunitiesScreen)}
          </div>
        )}
        {activatedTabs.has('calls') && (
          <div className={`h-full w-full ${activeTab === 'calls' ? 'block' : 'hidden'}`}>
            {lazyTab(CallsScreen)}
          </div>
        )}
      </div>

      {/* Bottom nav bar */}
      <div className="flex justify-around border-t border-gray-200 dark:border-white/10 bg-panel-light dark:bg-panel-dark flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {tabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const showMissedBadge = tab.id === 'calls' && missedBadgeCount > 0;
          return (
            <button
              key={tab.id}
              aria-label={showMissedBadge ? `${t(tab.label)} (${missedBadgeCount} missed)` : t(tab.label)}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => goToTab(tab.id)}
              className={`flex flex-col items-center justify-center flex-1 py-2 transition-colors ${
                isActive ? 'text-primary-green' : 'text-gray-500 dark:text-text-secondary'
              }`}
            >
              <div className={`relative rounded-full px-4 py-1 transition-colors ${isActive ? 'bg-primary-green/15' : ''}`}>
                <Icon className="h-5 w-5" />
                {showMissedBadge && (
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center"
                  >
                    {missedBadgeCount > 99 ? '99+' : missedBadgeCount}
                  </span>
                )}
              </div>
              <span className={`mt-0.5 text-[11px] font-medium ${isActive ? 'font-semibold' : ''}`}>{t(tab.label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
