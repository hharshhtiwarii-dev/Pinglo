import { useState, useRef, useEffect, useMemo } from 'react';
import { Search, MoreVertical, Lock, Plus, Sparkles, X, Star, BookmarkCheck, Users, Moon, Sun, Pin, BellOff, MailOpen, Trash2, Archive, ArchiveRestore, Folder, FolderPlus, MessageSquare, Crown, Megaphone, Contact, Settings, Check, Ban, Info, Eraser, ArrowLeft, Phone } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { collection, query, where, onSnapshot, doc, updateDoc, addDoc, auth, onAuthStateChanged, db, isAwsConfigured, arrayUnion, arrayRemove, setClearedAt } from '../../aws';
import { isMutedPref, mutePrefForDuration, unmutePref, muteUntilLabel, MUTE_DURATIONS } from '../../services/chatMute';
import { filterExpiredMessages } from '../../utils/disappearingMessages';
import { sweepExpiredMessages } from '../../utils/expirySweeper';
import NewGroupModal from '../../components/NewGroupModal';
import FolderManagerModal from '../../components/FolderManagerModal';
import {
  ARCHIVED_FILTER, folderFilter, folderIdFromFilter, folderById,
  makeFolder, sanitizeFolderName, countArchived, countInFolder,
  loadLocalFolders, saveLocalFolders, loadLocalChatPrefs, saveLocalChatPrefs,
  mergePrefs, mergeFolders,
} from '../../services/archiveFolders';
import type { ChatFolder } from '../../services/archiveFolders';
import { navigationManager } from '../../services/navigation';
import { useLanguage } from '../../services/language';
import { getCachedHiddenChatIds, tryLoadHiddenChatIds, verifySecretCode } from '../../services/lockedChats';
import { isAdminUser } from '../../services/adminService';
import { realtimeSync, getConversationId, cleanId } from '../../services/realtimeSync';
import { KNOWN_CONVS_CHANGED_EVENT } from '../../services/contacts';
import { processKeyExchangeDocs } from '../../services/e2eeChat';
import { getLocalReadAt, markChatReadLocally, pickSeenUpTo, mergeSeenUpTo, readReceiptsEnabled, countUnreadMessages, effectiveMessageStatus, seenUpToForUser } from '../../services/readReceipts';
import { startPresence, isOnline } from '../../services/presence';
import { getKeepChatsArchived } from '../../services/appSettings';
import DefaultAvatar from '../../components/DefaultAvatar';
import StatusRing from '../../components/StatusRing';
import ListSkeleton from '../../components/ListSkeleton';
import MessageTicks from '../../components/MessageTicks';
import { callService, type ActiveCallData } from '../../services/callService';

// ── AUDIT-2 C3: lazy per-user message collections ────────────────────────
// Before, getChatPreview / hasConversation / chatMessageMatch called
// db.getCollectionDocs(`chats/<convId>/messages`) for EVERY registered
// user on every render + every 3 s preview check — and getCollectionDocs
// calls db.ensure(), which opens one AppSync onDocChanged subscription
// per collection. 1000 users = 1000 simultaneous full-history fetches +
// 1000 subscriptions (AppSync default limit: 100/connection).
// Now a message collection is loaded/subscribed ONLY when its chat is
// actually visible (top rows + rows scrolled into view), discovery of
// which users even HAVE a conversation runs in the background at a
// bounded concurrency, and proven conversations are memoised in
// localStorage so a returning user never re-probes them. Collections for
// off-screen chats leave the active set (LRU, cap below); the eviction
// calls db.releaseCollection() (AUDIT-2 C5 / W2C), which drops this
// screen's listener, its 3 s poll AND the underlying AppSync
// subscription — before that API existed the subscription lived on for
// the session. A server-side per-user conversation index
// (BACKEND-PLAN.md §16) is the full fix: without it the client must
// still probe each unknown user once to learn whether a conversation
// exists at all.
/** Max live message collections held for visible rows (<< AppSync 100/connection).
 * A 390x844 viewport shows ~9 chat rows + ~3 more inside the observer's
 * 200 px prefetch margin, so 12 covers one screenful without evicting a
 * row the user is looking at. */
const MAX_ACTIVE_MESSAGE_COLLECTIONS = 12;
/** Max background discovery probes in flight at once. */
const DISCOVERY_CONCURRENCY = 4;
/** G4 Pass 2: max deep-search collection loads in flight at once.
 * Lower than discovery (2 vs 4) — search is user-triggered per query,
 * discovery is once-per-user. */
const SEARCH_DEEP_CONCURRENCY = 2;

/** WhatsApp-style relative day for a chat-list timestamp (FIX 3a).
 * Today → clock time ("10:30"), yesterday → "Yesterday", within the
 * last 7 days → weekday short name ("Mon"), older → d/m/yyyy
 * ("8/11/2026" — WA renders day and month WITHOUT leading zeros; the
 * WA Web SSR DOM shows "8/11/2026", "27/9/2026", never "08/11/2026").
 * Pure function; the row renders from the raw timestamp (timeTs) so a
 * preview cached today still reads "Yesterday" tomorrow. */
export function formatChatListTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
  const t = d.getTime();
  if (t >= startOfToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (t >= startOfYesterday) return 'Yesterday';
  if (t >= startOfWeek) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  // WA parity chatlist-1 row 4: older dates are unpadded d/m/yyyy
  // ("8/11/2026"), matching WA Web's rendered list DOM.
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}
/** G4 Pass 2: max unloaded collections scanned per debounced query.
 * The cap is what keeps this from becoming the C3 storm: a query never
 * fans out to every conversation, only to the first N candidates. */
const SEARCH_DEEP_MAX_COLLECTIONS = 30;
/** Previously-empty users are re-probed this often (round-robin, small batches). */
const DISCOVERY_RESCAN_INTERVAL_MS = 30000;
const DISCOVERY_RESCAN_BATCH = 4;
/** Cap on the localStorage memo of proven conversation ids. */
const KNOWN_CONVS_MEMO_MAX = 500;

/** WA audit #60 — mm:ss live-call duration for the ongoing-call row. */
function fmtLiveCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function ChatListScreen() {
  const stopPresenceRef = useRef<(() => void) | null>(null);
  // L6: signature of the last `users` snapshot actually applied (see usersUnsub below).
  const prevUsersSigRef = useRef<string | null>(null);
  // L2: refs so the change-detecting preview check below always sees the
  // latest list/prefs without re-creating its interval on every render.
  const chatsRef = useRef<any[]>([]);
  const chatPrefsRef = useRef<Record<string, any>>({});
  const hiddenChatIdsRef = useRef<string[]>([]);
  const previewFnRef = useRef<(chat: any) => any>(() => ({ text: '', time: '', unread: 0, sortTs: 0, activityTs: 0, isMine: false, lastStatus: '' }));
  const prevPreviewSigRef = useRef<string | null>(null);
  // C3: lazy message collections (see the header comment above).
  // knownConvIds — convIds proven to hold ≥1 message (state so discovery
  // findings re-render the list); activeSubs — live db.subscribe handles
  // for visible rows, LRU-ordered by lastUse; probed — convIds already
  // discovery-probed this session; discoveryQueue — pending probes.
  const [knownConvIds, setKnownConvIds] = useState<Set<string>>(() => new Set());
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  // Report 3 #223/#233 (W5b): pending-kx conversations — a peer's
  // key-announce exists but no real message yet. Same pattern as the
  // known-conv memo (state so discovery findings re-render the list +
  // ref for the probe paths + localStorage memo per account). A pending
  // row is kept until a real message arrives or the user deletes the
  // chat — never auto-expired (D4). `pendingKxAtRef` holds the latest
  // kx `sentAt` per conv, so the pending row sorts near the top without
  // inheriting presence timestamps.
  const [pendingKxConvIds, setPendingKxConvIds] = useState<Set<string>>(() => new Set());
  const pendingKxRef = useRef<Set<string>>(new Set());
  const pendingKxAtRef = useRef<Map<string, number>>(new Map());
  // Report 3 #226/#234 (W5b): true while any active collection has
  // listeners but no live subscription (poll-only) — drives the
  // "Reconnecting…" pill under the app bar. Never shown in mock mode.
  const [dbReconnecting, setDbReconnecting] = useState(false);
  const myUidRef = useRef<string>('');
  const activeSubsRef = useRef(new Map<string, { unsub: () => void; lastUsed: number; lastVisibleAt: number; visibleNow: boolean }>());
  // FIX 3c: typing indicator on the chat-list row. typingSubsRef holds
  // one realtimeSync typing subscription per ACTIVE conversation (same
  // lifecycle as the message collection: subscribed on activation,
  // released on eviction / unmount). typingByChat is React state so a
  // typing event re-renders the row with a green "typing…" preview.
  // DMs subscribe to the peer's typing doc (doc mode, cheap); groups
  // have no single partner so they share the hub's one collection sub.
  const typingSubsRef = useRef(new Map<string, () => void>());
  const [typingByChat, setTypingByChat] = useState<Record<string, boolean>>({});
  const probedRef = useRef<Set<string>>(new Set());
  const discoveryQueueRef = useRef<string[]>([]);
  const discoveryInFlightRef = useRef(0);
  const discoveryTimerRef = useRef<any>(null);
  // G4 Pass 2: chatId -> matching message text found in an UNLOADED
  // collection by the background deep search (state so hits re-render
  // the list as they arrive); run token so a new keystroke cancels the
  // previous query's scan (same cancel pattern as the #23 memo).
  const [deepSearchHits, setDeepSearchHits] = useState<Map<string, string>>(new Map());
  // WA-verify row 30: true while a deep-search run still has collections
  // in flight — the "Nothing found" empty state waits for this, so it
  // cannot flash before a late Pass-2 hit arrives.
  const [deepSearchPending, setDeepSearchPending] = useState(false);
  const deepSearchRunRef = useRef(0);
  const rescanCursorRef = useRef(0);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const rowElsRef = useRef(new Map<string, HTMLElement>());
  const previewCheckRef = useRef<(() => void) | null>(null);
  // W13 NEXT R8 (B2): coalesced delivery-time preview check. A
  // subscription delivery used to call the preview check immediately —
  // a full signature diff over all 200 chats + a re-render whenever the
  // signature changed. During the /main settle tail, discovery
  // activations + subscription deliveries arrive in bursts, so one burst
  // ran dozens of full diffs and re-renders. The version bump + the kx
  // runner in the subscribe callback stay immediate (P0-8 ack must not
  // wait); only the preview diff is deferred, at most once per 300 ms.
  // The 3 s interval check below stays as the backstop.
  const previewCheckTimerRef = useRef<number | null>(null);
  const schedulePreviewCheck = () => {
    if (previewCheckTimerRef.current !== null) return;
    previewCheckTimerRef.current = window.setTimeout(() => {
      previewCheckTimerRef.current = null;
      previewCheckRef.current?.();
    }, 300);
  };
  // W13 (#127/#131): STABLE preview cache — the idle-loop fix (see
  // cachePreviewFromMsgs below). Keyed by conversation id; holds only
  // message-derived fields (draft text is localStorage, applied on top
  // at read time, never cached). chatMetaRef keeps the latest chat-meta
  // state for the cache helper (probes run outside the render pass).
  type CachedPreview = { text: string; time: string; unread: number; sortTs: number; activityTs: number; isMine: boolean; lastStatus: string; timeTs?: number };
  const previewCacheRef = useRef(new Map<string, CachedPreview>());
  const chatMetaRef = useRef<Record<string, any>>({});
  // W13 (#127 settled): per-version memo for the ACTIVE branch. The 3 s
  // preview check calls getChatPreview for all 203 chats; for the ~12
  // active collections that rebuilt + decrypt-memoed every doc per
  // check (~30% idle CPU, the residual settled longtasks). The memo
  // returns the cached computation unless the collection delivered new
  // data (version bumped in the subscribe callback below) or its read
  // watermark changed (meta object identity). Draft text is applied
  // outside the memo, so it is always fresh. The stable previewCacheRef
  // above is a different layer (survives eviction); this memo is purely
  // a CPU shortcut for the active path.
  const previewVersionRef = useRef(new Map<string, number>());
  // §1b (audit #32, Wave-2 C4): the chat list is the only place that
  // sees messages of chats the user never opens — and the ChatScreen
  // sweeper only runs while a chat is open. Without this, an expired
  // message in an unopened chat lingers in the local cache / IndexedDB
  // (and on the server) indefinitely: hidden from the preview by the
  // filter, but never actually deleted. The throttle below bounds it
  // to one sweep attempt per conversation per 5 min, and the sweeper
  // itself caps at 50 deletes per run; kept messages and messages with
  // no timestamp are never swept (same rules as ChatScreen).
  const expirySweepLastRef = useRef(new Map<string, number>());
  const expirySweepRunningRef = useRef(new Set<string>());
  const maybeSweepExpired = (convId: string) => {
    try {
      const timer = typeof chatMetaRef.current[convId]?.disappearAfter === 'number'
        ? chatMetaRef.current[convId].disappearAfter
        : 0;
      if (!timer || timer <= 0) return;
      const now = Date.now();
      if (now - (expirySweepLastRef.current.get(convId) || 0) < 300_000) return;
      if (expirySweepRunningRef.current.has(convId)) return;
      const msgs = db.getCollectionDocs(`chats/${convId}/messages`) as any[] | undefined;
      if (!msgs || msgs.length === 0) return;
      expirySweepLastRef.current.set(convId, now);
      expirySweepRunningRef.current.add(convId);
      void sweepExpiredMessages(convId, msgs, timer, now).finally(() => {
        expirySweepRunningRef.current.delete(convId);
      });
    } catch { /* best-effort enforcement: never break the list */ }
  };
  const previewMemoRef = useRef(new Map<string, { version: number; meta: any; preview: CachedPreview }>());
  const [filter, setFilter] = useState('All');
  // WA audit #60 — ongoing-call row at the top of the chat list
  // (WhatsApp's ROW_CALL_ONGOING): a live call is visible here, not
  // just as the minimised bubble. Duration ticks via the service's
  // 1 s duration timer, which re-emits on every tick. Hidden while
  // searching / filtering (same rule as the Saved Messages row) and
  // for incoming calls (the full-screen incoming UI covers those).
  const [liveCall, setLiveCall] = useState<ActiveCallData | null>(null);
  useEffect(() => {
    const unsub = callService.subscribe((data) => {
      setLiveCall(
        data.status === 'outgoing' || data.status === 'connecting' || data.status === 'connected'
          ? data
          : null,
      );
    });
    return () => unsub();
  }, []);
  const [showMenu, setShowMenu] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  // WA parity top-10 #3 (multi-select): selection mode, keyed by pref key
  // (partner uid for DMs, cleanId(groupId) for groups — same key as chatPrefs).
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedIdsRef = useRef<Set<string>>(new Set());
  // WA parity top-10 #1 (mute durations): which chat the duration picker
  // is open for (pref key), null when the picker is closed.
  const [mutePickerFor, setMutePickerFor] = useState<string | null>(null);
  // WA parity top-10 #7 (Clear chat from the list): confirm state.
  const [pendingClearChat, setPendingClearChat] = useState<any>(null);
  // Multi-select batch delete confirm: pref keys awaiting confirm.
  const [pendingBatchDelete, setPendingBatchDelete] = useState<string[] | null>(null);
  // Blocked ids of the signed-in user (users/{uid}.blockedUsers), live from
  // the my-doc snapshot — drives the Block/Unblock menu label.
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Feature 5: custom chat folders (users/{uid}.chatFolders, localStorage fallback)
  const [chatFolders, setChatFolders] = useState<ChatFolder[]>([]);
  const [showFolderManager, setShowFolderManager] = useState(false);
  const [chats, setChats] = useState<any[]>([]);
  // #152: my groups, from the `communities` collection (members only).
  // Kept separate from `chats` (users) — the discovery effect and the
  // New Group picker read users; every list consumer reads allChats.
  const [groups, setGroups] = useState<any[]>([]);
  const prevGroupsSigRef = useRef<string | null>(null);
  // WA audit (d) S8 — status ring on chat-list avatars. One statuses
  // subscription (same expiry + privacy filter StatusScreen uses, so a
  // ring never appears for a status I cannot see): uid → { viewed flags
  // per status, closeFriends }. Only DM rows get a ring — groups have no
  // single status poster. Sig-diffed so unrelated status churn (a
  // reaction, a new view) never re-renders the list.
  const [statusRingByUid, setStatusRingByUid] = useState<Record<string, { viewed: boolean[]; closeFriends: boolean }>>({});
  const prevStatusRingSigRef = useRef<string | null>(null);
  // AUDIT-2 C5: chat docs (`chats` collection, one small metadata doc
  // per conversation) carry the read/delivery watermarks
  // (`seenUpTo` / `deliveredUpTo`) that getChatPreview derives the
  // last-message tick + unread badge from. Keyed by conversation id.
  const [chatMeta, setChatMeta] = useState<Record<string, any>>({});
  const prevChatMetaSigRef = useRef('');
  // RC3: seed the filter from the last known locked list (previous
  // session, this device) so the first paint already hides locked chats.
  // `hiddenLoaded` starts true ONLY when a cached list exists — a fresh
  // device with no cache keeps the list gated until a real load resolves.
  const [hiddenChatIds, setHiddenChatIds] = useState<string[]>(() => getCachedHiddenChatIds() ?? []);
  // Phase 5: do not render ANY chat row until the locked list is known —
  // otherwise locked chats flash in the main list on every cold start (L-03).
  const [hiddenLoaded, setHiddenLoaded] = useState<boolean>(() => getCachedHiddenChatIds() !== null);
  // Per-chat settings of the current user: { [partnerId]: { pinned, muted, markedUnread, deletedAt } }
  const [chatPrefs, setChatPrefs] = useState<Record<string, any>>({});
  const [menuChat, setMenuChat] = useState<any>(null);
  // WA #44: viewport rect of the row the long-press / right-click menu
  // was opened from — the popup anchors to it (phone WA), instead of a
  // full-width bottom sheet.
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; bottom: number; left: number; right: number } | null>(null);
  const pressTimer = useRef<any>(null);
  const longPressFired = useRef(false);
  // WA #44 (E1 gap): timestamp of the last touch long-press that opened
  // the row popup — a WebView `contextmenu` firing right after it must
  // not ALSO fire the right-click path on top of the popup. Same guard
  // as ChatScreen's touchLongPressAtRef (reaction picker, R2).
  const touchLongPressAtRef = useRef(0);
  // G3: pin-cap toast timer — ref + clearTimeout (ChatScreen's correct
  // pattern), not the stale-timer shape the groups finder flagged (P-A2).
  const toastTimer = useRef<NodeJS.Timeout | null>(null);
  const [myUsername, setMyUsername] = useState('');
  const [myAvatar, setMyAvatar] = useState('');
  // Item 12 (Master-gaps Cluster B): my read-receipts pref, live from my
  // user doc (the onSnapshot below). Default ON. OFF caps the ticks on my
  // outgoing messages at delivered (grey) in the chat list too.
  const [readReceipts, setReadReceipts] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  // #23: debounced search — the raw query drives the input box so it
  // stays responsive; the debounced one drives the list filter and the
  // per-chat message-text scan below, so neither runs per keystroke.
  const [searchQueryDebounced, setSearchQueryDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchQueryDebounced(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const secretCodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secretCodeSeqRef = useRef(0);
  // Phase 4 (integration): hashtag tap in a chat navigates here with ?q=#tag —
  // prefill the search so all chats are searched for the tag. The search
  // bar is persistent (WA parity top-10 #5), so there is no showSearch
  // mode to open any more — the query just lands in the bar.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      setSearchQuery(q);
      setSearchParams({}, { replace: true });
    }
    // Only run on mount / param change — do not loop on setSearchParams.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  // Phase 3 (Agent A): loading skeleton + delete-chat confirm (no window.confirm)
  const [isLoadingChats, setIsLoadingChats] = useState(true);
  const [pendingDeleteChat, setPendingDeleteChat] = useState<any>(null);
  // G3: pin-cap toast.
  const [toast, setToast] = useState('');
  const showToastMsg = (msg: string, durationMs = 2500) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), durationMs);
  };
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  const navigate = useNavigate();
  const { t: tr } = useLanguage();

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);
    if (nextDark) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
    if (Capacitor.isNativePlatform()) {
      StatusBar.setStyle({ style: nextDark ? Style.Dark : Style.Light }).catch((err) => console.warn("[ChatListScreen] ChatListScreen: setItem(...) failed", err));
      StatusBar.setBackgroundColor({ color: nextDark ? '#111B21' : '#075E54' }).catch((err) => console.warn("[ChatListScreen] ChatListScreen: setItem(...) failed", err));
    }
  };

  // Phase 5: the invisible 3-tap vault trigger is REMOVED (L-32). The only
  // way to reveal the Locked Chats folder is the secret code typed in the
  // search bar (handleSearchChange below) — WhatsApp behaviour.
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    let myUnsub: (() => void) | null = null;
    let usersUnsub: (() => void) | null = null;
    let chatsUnsub: (() => void) | null = null;
    let groupsUnsub: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (!user) {
        // C3: a sign-out (or a different account signing in next) must not
        // reuse the previous account's conversation memo or live collections.
        for (const [cid, e] of activeSubsRef.current) { try { e.unsub(); } catch (err) { /* already gone */ console.warn("[ChatListScreen] ChatListScreen: e.unsub() failed", err); } try { db.releaseCollection(`chats/${cid}/messages`); } catch (err) { console.warn("[ChatListScreen] sign-out releaseCollection failed", err); } }
        activeSubsRef.current.clear();
        setChatMeta({});
        setGroups([]);
        prevGroupsSigRef.current = null;
        prevChatMetaSigRef.current = '';
        knownConvIdsRef.current = new Set();
        setKnownConvIds(new Set());
        pendingKxRef.current = new Set();
        pendingKxAtRef.current = new Map();
        setPendingKxConvIds(new Set());
        probedRef.current = new Set();
        discoveryQueueRef.current = [];
        myUidRef.current = '';
        return;
      }
      // C3: restore the memo of proven conversations for this account, so
      // a returning user never re-probes users they already chatted with.
      myUidRef.current = user.uid;
      loadKnownConvsMemo(user.uid);
      // Report 3 #223/#233 (W5b): same for pending-kx rows.
      loadPendingKxMemo(user.uid);

      // Presence: heartbeat while visible, offline when backgrounded or closed
      stopPresenceRef.current?.();
      stopPresenceRef.current = startPresence(user.uid);

      if (myUnsub) myUnsub();
      if (usersUnsub) usersUnsub();
      if (chatsUnsub) chatsUnsub();
      if (groupsUnsub) groupsUnsub();

      // #152 — groups in the Chats tab: subscribe to `communities` and keep
      // only the groups I am a member of (non-member groups stay out of the
      // Chats list — they are discoverable from the Communities tab). The
      // row is a normal list row (isGroup: true), so the existing
      // hasConversation / Groups-filter / long-press-menu paths — including
      // mute (#192) — treat it like any other chat. Sig-diffed like the
      // users snapshot so unrelated doc churn never re-renders the list.
      // Channels are included too: in this app a channel is a chat you read
      // (opened from Communities as /chat/<id>?type=community).
      groupsUnsub = onSnapshot(collection(db, 'communities'), (snap) => {
        const mine = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter((g: any) => Array.isArray(g.members) && g.members.includes(user.uid))
          .map((g: any) => ({ ...g, isGroup: true }));
        const sig = mine.map((g: any) => [g.id, g.name || '', g.emoji || '', g.photoURL || '', g.description || '', Array.isArray(g.members) ? g.members.length : 0, typeof g.timestamp === 'number' ? g.timestamp : ''].join('|')).join('\n');
        if (sig === prevGroupsSigRef.current) return;
        prevGroupsSigRef.current = sig;
        setGroups(mine);
      });

      // AUDIT-2 C5: the chat docs carry the read/delivery watermarks
      // (`seenUpTo` / `deliveredUpTo`) that getChatPreview derives the
      // last-message tick + unread badge from. One whole-collection
      // subscription on small metadata docs (one per conversation) —
      // not per-user message collections. Sig-diffed on the watermark
      // fields only, so other churn on chat docs never re-renders the
      // list.
      chatsUnsub = onSnapshot(collection(db, 'chats'), (snap) => {
        const next: Record<string, any> = {};
        for (const d of snap.docs) {
          const data = d.data() as any;
          // §1b: the disappearing-message timer rides along so the
          // preview can hide expired messages (cachePreviewFromMsgs)
          // instead of leaking their text in the list.
          next[d.id] = { seenUpTo: data?.seenUpTo || {}, deliveredUpTo: data?.deliveredUpTo || {}, disappearAfter: typeof data?.disappearAfter === 'number' ? data.disappearAfter : 0 };
        }
        const sig = Object.keys(next).sort().map((k) => `${k}:${JSON.stringify(next[k].seenUpTo)}:${JSON.stringify(next[k].deliveredUpTo)}:${next[k].disappearAfter}`).join('\n');
        if (sig === prevChatMetaSigRef.current) return;
        prevChatMetaSigRef.current = sig;
        setChatMeta(next);
      });

      // My data
      myUnsub = onSnapshot(doc(db, 'users', user.uid), snap => {
        if (snap.exists()) {
          const d = snap.data();
          // Phase 5: canonical source is the private locked doc (migrates
          // the legacy public field and deletes it — see lockedChats.ts).
          // RC3: strict loader — a failed load must NOT resolve
          // hiddenLoaded with an empty list (the old code did exactly
          // that, flashing locked chats in the main list).
          void tryLoadHiddenChatIds(user.uid).then(({ ok, ids }) => {
            if (!ok) return;
            setHiddenChatIds(ids);
            setHiddenLoaded(true);
          });
          // Firestore wins per chat; local prefs fill gaps (e.g. archived offline).
          setChatPrefs(mergePrefs(d.chatPrefs || {}, loadLocalChatPrefs(user.uid)));
          setBlockedIds(Array.isArray((d as any).blockedUsers) ? (d as any).blockedUsers.map(String) : []);
          setChatFolders(mergeFolders(d.chatFolders || [], loadLocalFolders(user.uid)));
          setMyUsername(d.displayName || d.username || '');
          setMyAvatar(d.photoURL || '');
          setReadReceipts(readReceiptsEnabled(d));
        }
      });

      // All other users (real-time, filtering out empty or ghost records).
      // No server-side filter: the user id is the document id, and the filter below removes the current user.
      // Worker B (phone-issues fix): this subscription still feeds the
      // client cache — it is needed for chat partners' names / photos /
      // presence — but the RENDERED list below is conversations only (see
      // hasConversation): a user with no messages never appears as a row,
      // so a newly-joined user is no longer visible to everyone. The
      // subscription itself still delivers the whole collection to the
      // client; closing that needs a backend resolver rule (see PATCH-B).
      const q = collection(db, 'users');
      usersUnsub = onSnapshot(q, snap => {
        const valid = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(u => 
            u.id && 
            cleanId(u.id) !== cleanId(user.uid) && 
            (u.displayName || u.username || u.email) &&
            u.displayName !== 'Unknown' &&
            u.username !== 'Unknown'
          );
        // L6: a presence heartbeat rewrites every online user's doc every
        // 30 s, and the DB layer re-delivers the whole `users` collection
        // on each of them. Only re-render when something the list actually
        // shows changed (identity / photo). `lastSeen` alone is
        // deliberately excluded: it moves every heartbeat, and sorting by
        // a ticking lastSeen would reorder the list every 30 s. Online
        // state is excluded too (WA #16): the list shows no presence, so
        // a presence flip must not re-render it.
        // (Server-side filtering is impossible here — the AppSync
        // subscription has no filter; database.ts is owned by Worker A.)
        const sig = valid.map(u => [u.id, u.displayName || '', u.username || '', u.email || '', u.photoURL || ''].join('|')).join('\n');
        if (sig === prevUsersSigRef.current) {
          setIsLoadingChats(false);
          return;
        }
        prevUsersSigRef.current = sig;
        setChats(valid);
        setIsLoadingChats(false);
      });
    });

    return () => {
      unsubAuth();
      if (myUnsub) myUnsub();
      if (usersUnsub) usersUnsub();
      if (chatsUnsub) chatsUnsub();
      if (groupsUnsub) groupsUnsub();
      stopPresenceRef.current?.();
      stopPresenceRef.current = null;
    };
  }, []);

  // ── Back Navigation Handlers for Modals ──
  // WA audit (d) S8 — status-ring data for chat-list avatars (see the
  // statusRingByUid state above). Runs on the signed-in user only.
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const ts = (s: any) => (s.timestamp?.toMillis ? s.timestamp.toMillis() : Number(s.timestamp) || 0);
    return onSnapshot(collection(db, 'statuses'), (snap) => {
      try {
        const byUid: Record<string, { viewed: boolean[]; closeFriends: boolean }> = {};
        for (const d of snap.docs) {
          const s = d.data() as any;
          if (!s?.userId || s.userId === uid) continue;
          if ((Date.now() - ts(s)) >= ONE_DAY_MS) continue;
          const privacy = s.privacy || 'everyone';
          if (privacy === 'nobody') continue;
          if (privacy === 'exclude' && (s.privacyExclude || []).includes(uid)) continue;
          if ((privacy === 'contacts' || privacy === 'closeFriends') && Array.isArray(s.privacyAllow) && !s.privacyAllow.includes(uid)) continue;
          if (privacy === 'closeFriends' && !Array.isArray(s.privacyAllow)) continue;
          const entry = byUid[s.userId] || (byUid[s.userId] = { viewed: [], closeFriends: false });
          entry.viewed.push((s.viewers || []).includes(uid));
          if (privacy === 'closeFriends') entry.closeFriends = true;
        }
        const sig = Object.keys(byUid).sort().map(k => `${k}:${byUid[k].viewed.join(',')}:${byUid[k].closeFriends ? 'cf' : ''}`).join('\n');
        if (sig === prevStatusRingSigRef.current) return;
        prevStatusRingSigRef.current = sig;
        setStatusRingByUid(byUid);
      } catch {
        /* a bad snapshot leaves the previous rings in place */
      }
    });
  }, []);

  useEffect(() => {
    if (showNewGroup) {
      return navigationManager.pushHandler(() => {
        setShowNewGroup(false);
        return true;
      });
    }
  }, [showNewGroup]);

  useEffect(() => {
    if (showMenu) {
      return navigationManager.pushHandler(() => {
        setShowMenu(false);
        return true;
      });
    }
  }, [showMenu]);

  useEffect(() => {
    if (showFolderManager) {
      return navigationManager.pushHandler(() => {
        setShowFolderManager(false);
        return true;
      });
    }
  }, [showFolderManager]);

  // Multi-select: the back button exits selection mode instead of leaving
  // the screen (WhatsApp behaviour).
  useEffect(() => {
    if (selectionMode) {
      return navigationManager.pushHandler(() => {
        exitSelection();
        return true;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMode]);

  // Phase 3: Escape closes menus / search; skeleton never sticks forever.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuChat(null); setMenuAnchor(null); setShowMenu(false); setMutePickerFor(null);
      if (selectionMode) exitSelection();
      else if (searchQuery) setSearchQuery('');
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [selectionMode, searchQuery]);
  // Side-by-side fix (Item 2): the skeleton must never stick forever.
  // The users snapshot usually clears isLoadingChats, but hiddenLoaded
  // only flips inside the my-doc snapshot — in mock / no-backend mode
  // that snapshot may never arrive, so the skeleton showed forever and
  // pushed the "No chats yet" empty state below the fold.
  // RC3 (fail closed): the old fallback declared `hiddenLoaded=true`
  // after 5 s even when the load never resolved — with an empty list, so
  // locked chats stayed visible. There is no blind resolve any more:
  // the fallback ATTEMPTS a real load and only resolves on success; on
  // failure it retries every 5 s. Until a real load (or a cached list)
  // resolves, rows stay gated and the skeleton shows.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      if (cancelled) return;
      void tryLoadHiddenChatIds().then(({ ok, ids }) => {
        if (cancelled) return;
        if (ok) {
          setHiddenChatIds(ids);
          setHiddenLoaded(true);
          setIsLoadingChats(false);
          return;
        }
        timer = setTimeout(attempt, 5000);
      });
    };
    timer = setTimeout(() => {
      setIsLoadingChats(false);
      attempt();
    }, 5000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Phase 5 — secret-code reveal (WhatsApp behaviour). Typing the exact
  // secret code in search navigates to /locked-chats and clears the query,
  // so the code itself never stays visible in the search box. Any other
  // query searches normally. The code is checked against its salted hash
  // only (lockedChats.ts) — it is never stored in plaintext/localStorage.
  // #23/#45 (RC45): the old handler awaited verifySecretCode (a Firestore
  // getDoc + hash) on EVERY keystroke. Now the input updates instantly
  // and the secret-code check fires once, 300ms after typing stops, only
  // for queries of 4+ chars (verifySecretCode rejects shorter ones
  // anyway). A sequence guard drops stale checks.
  useEffect(() => () => {
    if (secretCodeTimerRef.current) clearTimeout(secretCodeTimerRef.current);
  }, []);
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (secretCodeTimerRef.current) clearTimeout(secretCodeTimerRef.current);
    const clean = value.trim();
    if (clean.length < 4) return;
    secretCodeTimerRef.current = setTimeout(() => {
      const seq = ++secretCodeSeqRef.current;
      void verifySecretCode(clean).then((ok) => {
        // Stale check: a newer keystroke has already scheduled (or run)
        // its own verification — ignore this one.
        if (seq !== secretCodeSeqRef.current) return;
        if (ok) {
          setSearchQuery('');
          navigate('/locked-chats');
        }
      }).catch((err) => {
        /* no code set / offline: plain search continues */
        console.warn("[ChatListScreen] handleSearchChange: if (await verifySecretCode(value)) { failed", err);
      });
    }, 300);
  };

  const [tick, setTick] = useState(0);
  useEffect(() => {
    // L2: the old unconditional 3 s setTick forced a full re-render AND a
    // getCollectionDocs call per chat (full doc-map copy + fingerprint
    // stringify per message) every 3 s. The tick IS load-bearing — this
    // screen holds no subscription on any messages collection, so without
    // any check a new message would not update previews until the next
    // users snapshot (presence heartbeat, ~30 s) or a navigation. So the
    // 3 s CHECK stays, but it only re-renders when a preview actually
    // changed; identical checks do no React work. Paused while the app is
    // backgrounded, and re-checked immediately on return to foreground.
    // (Dropping the per-message decrypt cost inside getCollectionDocs
    // itself needs database.ts — Worker A owns that file.)
    const check = () => {
      if (document.hidden) return;
      try {
        const sig = chatsRef.current
          .filter((c) => !hiddenChatIdsRef.current.includes(c.uid) && !hiddenChatIdsRef.current.includes(c.id))
          .map((c) => {
            const p = previewFnRef.current(c);
            return [c.id, p.text, p.time, p.unread, p.sortTs, p.lastStatus, p.isMine ? '1' : '0'].join('|');
          })
          .join('\n');
        if (sig !== prevPreviewSigRef.current) {
          prevPreviewSigRef.current = sig;
          setTick((t) => t + 1);
        }
      } catch (err) {
        // Preview read is best-effort; the next check retries.
        console.warn("[ChatListScreen] check: const sig = chatsRef.current failed", err);
      }
      // Report 3 #226/#234 (W5b): same 3 s cadence, no new timer —
      // any ACTIVE collection without a live subscription means the
      // list is poll-only. Mock mode never shows the pill (there are no
      // subscriptions to lose; the demo banner in App.tsx is the signal).
      try {
        const rec = isAwsConfigured() && [...activeSubsRef.current.keys()].some((cid) => {
          try { return db.isReconnecting(`chats/${cid}/messages`); } catch { return false; }
        });
        setDbReconnecting((prev) => (prev === rec ? prev : rec));
      } catch { /* best-effort indicator */ }
    };
    const timer = setInterval(check, 3000);
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener('visibilitychange', onVisible);
    // C3: the live-collection callbacks below reuse this same diffing
    // check, so a realtime event re-renders only when a preview changed.
    previewCheckRef.current = check;
    check();
    return () => {
      previewCheckRef.current = null;
      clearInterval(timer);
      // W13 NEXT R8 (B2): drop a pending coalesced check on unmount.
      if (previewCheckTimerRef.current !== null) {
        clearTimeout(previewCheckTimerRef.current);
        previewCheckTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // ── C3: lazy per-user message collections ─────────────────────────────
  // #152: group message collections are keyed by cleanId(groupId)
  // (ChatScreen: conversationId = cleanId(chatId) for communities), NOT by
  // the sorted-uid DM id. Every convId derivation on this screen branches
  // on isGroup — getConversationId(uid, groupId) would point at a
  // collection that never exists, so group previews/unread/search would
  // silently stay empty.
  const convIdForChat = (chat: any): string | null => {
    if (!auth.currentUser) return null;
    return chat.isGroup ? cleanId(chat.id) : getConversationId(auth.currentUser.uid, chat.id);
  };

  // #192: per-chat prefs (mute/pin/archive/…) are keyed by partner uid for
  // DMs. For groups the key must be the CONVERSATION id — cleanId(groupId)
  // — because the notification watcher skips muted chats by conversation
  // id (pushNotifications.ts: `mutedChats.has(convId)`), and a raw group
  // id (mixed-case Firestore auto-id) never equals its cleaned form.
  // Every chatPrefs lookup/write for a row goes through this helper.
  const prefKeyForChat = (chat: any): string => (chat?.isGroup ? cleanId(chat.id) : chat.id);

  // #152: the rendered list is DMs + my groups. `chats` stays users-only
  // (the discovery effect and the picker read it); every list consumer
  // below reads allChats.
  const allChats = useMemo(() => [...chats, ...groups], [chats, groups]);

  // Read a message collection ONLY if this screen already loaded /
  // subscribed it (visible row). Never triggers a load from the render
  // path — loading happens in the activation/discovery effects only.
  // (db.getCollectionDocs on an already-loaded collection is a no-op
  // ensure; on an unloaded one it would start a full fetch + subscription,
  // which is exactly the C3 storm this gates off.)
  const getLoadedMessages = (convId: string): any[] => {
    const entry = activeSubsRef.current.get(convId);
    if (!entry) return [];
    entry.lastUsed = Date.now();
    try {
      return db.getCollectionDocs(`chats/${convId}/messages`) || [];
    } catch {
      return [];
    }
  };

  // W13 (#127/#131): STABLE preview cache — the idle-loop fix.
  // getChatPreview used to derive sortTs from the last message when a
  // collection was active and from lastSeen when it was not, while the
  // list sorted by that sortTs. Activation flipped sortTs, the sort
  // reordered rows, the observer + LRU evicted a different set, previews
  // flipped back — a feedback loop (~7 fps idle, 24k DOM mutations/10s,
  // REPORT-3 #127). This helper computes the message-derived preview
  // ONCE per data change and stores it; an evicted chat keeps its last
  // known preview (stable sort key + stable text) instead of falling
  // back to lastSeen. Fresh values overwrite the cache
  // whenever the collection is active again, and the background
  // discovery probe seeds it, so every row shows its real last message
  // once probed (#131) without keeping 203 live subscriptions.
  // The last message is found with one O(n) scan (the old code sorted
  // a copy of the whole array on every call); countUnreadMessages only
  // iterates, so it takes the messages unsorted.
  // Item 12 / AUDIT-2 B15 / C5 (same rules as the old inline code):
  // the badge honours the local-only "read up to" stamp (receipts OFF),
  // counts only receiver-side receipt stamps (never the sender clock),
  // and honours my own read watermark; the tick derives from the peer's
  // watermark (new clients never write per-message 'seen').
  const cachePreviewFromMsgs = (convId: string, msgs: any[], fallbackTs = 0, isGroup = false): CachedPreview | null => {
    if (!msgs || msgs.length === 0 || !auth.currentUser) return null;
    // §1b: an expired message must never leak its text into the list
    // preview (or count as unread). The sweeper deletes expired docs
    // when the chat is opened and when its collection activates here in
    // the list (maybeSweepExpired, throttled) — but a sweep is
    // best-effort and throttled, so the filter below still stands as
    // the guarantee: an expired doc that has not been swept yet is
    // never shown. When every message is expired the list falls through
    // to the no-message branch, which also clears the stale cached preview.
    const meta0 = chatMetaRef.current[convId];
    const liveMsgs = filterExpiredMessages(msgs, typeof meta0?.disappearAfter === 'number' ? meta0.disappearAfter : 0);
    if (liveMsgs.length === 0) return null;
    let lastMsg = liveMsgs[0];
    for (const m of liveMsgs) { if ((Number(m.timestamp) || 0) > (Number(lastMsg.timestamp) || 0)) lastMsg = m; }
    const meta = chatMetaRef.current[convId];
    const localReadAt = getLocalReadAt(auth.currentUser.uid, convId);
    const unreadCount = countUnreadMessages(liveMsgs, auth.currentUser.uid, localReadAt, seenUpToForUser(meta?.seenUpTo, auth.currentUser.uid));
    const MEDIA_LABELS: Record<string, string> = { image: 'Photo', video: 'Video', audio: 'Audio', file: 'File', voice: 'Voice message' };
    let text = lastMsg.text || (lastMsg.mediaType ? (MEDIA_LABELS[lastMsg.mediaType] || (lastMsg.mediaType.charAt(0).toUpperCase() + lastMsg.mediaType.slice(1))) : 'Message');
    if (lastMsg.isDeleted || lastMsg.deleted) text = 'This message was deleted';
    // WA #13 (wa72-m2): the sender-written text is NOT the WA label for
    // two cases — stickers carry "😍 Heart eyes" (WA shows "Sticker")
    // and view-once photo/video carry the generic "View Once" (WA shows
    // "View once photo" / "View once video", and "Opened" once viewed).
    // Voice view-once already writes the right text, so it is untouched.
    else if (lastMsg.type === 'sticker') text = 'Sticker';
    else if (lastMsg.isViewOnce) {
      if (lastMsg.viewed) text = 'Opened';
      else if (lastMsg.mediaType === 'video') text = 'View once video';
      else if (lastMsg.mediaType === 'image') text = 'View once photo';
    }
    const isMineMsg = cleanId(lastMsg.senderId) === cleanId(auth.currentUser?.uid);
    // FIX 3b: group rows prefix the last message with the sender's first
    // name ("Alice: Hey"), so a group preview says who wrote it. Only
    // for others' messages — my own messages already carry the tick.
    // senderName is written on every message doc by ChatScreen.
    if (isGroup && !isMineMsg) {
      const senderFirst = (typeof lastMsg.senderName === 'string' ? lastMsg.senderName.trim() : '').split(/\s+/)[0];
      if (senderFirst) text = `${senderFirst}: ${text}`;
    }
    // FIX 3a: relative-day timestamp (today → clock, yesterday →
    // "Yesterday", <7d → weekday, else dd/mm/yyyy). timeTs keeps the
    // raw timestamp so the row re-renders the label fresh at render
    // time instead of showing a stale cached "10:30" tomorrow.
    const lastTs = Number(lastMsg.timestamp) || 0;
    const timeStr = formatChatListTime(lastTs);
    const cached: CachedPreview = {
      text,
      time: timeStr,
      timeTs: lastTs,
      unread: unreadCount,
      lastStatus: effectiveMessageStatus(lastMsg, meta?.seenUpTo, meta?.deliveredUpTo, auth.currentUser.uid),
      sortTs: lastTs || fallbackTs,
      // Only real messages count as activity. Presence (lastSeen) updates
      // every 30s and must not bring a deleted chat back.
      activityTs: lastTs || 0,
      isMine: isMineMsg,
    };
    previewCacheRef.current.set(convId, cached);
    return cached;
  };

  // Subscribe to one visible chat's message collection. Eviction is LRU
  // by LAST-VISIBLE time (not last read — every rendered row is read on
  // every render, on-screen or not, so read time cannot tell them apart).
  // The victim is the stalest OFF-SCREEN collection; an on-screen row is
  // evicted only when every active collection is on screen. Callers that
  // merely fill free slots (top-rows bootstrap) pass evict: false, so a
  // below-fold row can never push a visible row out.
  // AUDIT-2 C5 / W2C: the eviction calls db.releaseCollection(), which
  // drops this screen's listener, its 3 s poll AND the underlying
  // AppSync subscription. The cached docs are kept (re-activation
  // re-renders instantly from cache); only the live subscription goes.
  // Report 3 #223 (W5b): ack/announce writer for the shared kx runner.
  // Reads the live uid at call time (the imported `auth` object's
  // `currentUser` is a live getter), never a captured render value, so
  // a probe in flight across a sign-out cannot ack as the old user.
  const writeKxDoc = async (cid: string, payload: any) => {
    const me = auth.currentUser?.uid;
    if (!me) return;
    await addDoc(collection(db, 'chats', cid, 'messages'), {
      ...payload, timestamp: Date.now(), senderId: me,
    });
  };

  // FIX 3c helpers: subscribe/unsubscribe one conversation's typing.
  // Idempotent — a second subscribe for the same convId is a no-op.
  // Best-effort: a failed subscribe just hides the indicator.
  const subscribeTyping = (convId: string) => {
    if (typingSubsRef.current.has(convId)) return;
    const myUid = auth.currentUser?.uid || '';
    if (!myUid) return;
    const chatForConv = chatsRef.current.find((c: any) => {
      try { return convIdForChat(c) === convId; } catch { return false; }
    });
    const partnerId = chatForConv && !(chatForConv as any).isGroup ? (chatForConv as any).id : undefined;
    try {
      const unsub = realtimeSync.onTypingChange(convId, (typing: boolean) => {
        setTypingByChat((prev) => {
          if (prev[convId] === typing) return prev;
          return { ...prev, [convId]: typing };
        });
      }, partnerId);
      typingSubsRef.current.set(convId, unsub);
    } catch { /* typing is best-effort */ }
  };

  const unsubscribeTyping = (convId: string) => {
    const unsub = typingSubsRef.current.get(convId);
    if (unsub) {
      try { unsub(); } catch { /* already gone */ }
      typingSubsRef.current.delete(convId);
    }
    setTypingByChat((prev) => {
      if (!(convId in prev)) return prev;
      const next = { ...prev };
      delete next[convId];
      return next;
    });
  };

  // FIX 3c: release every typing subscription on unmount.
  useEffect(() => {
    return () => {
      for (const unsub of typingSubsRef.current.values()) {
        try { unsub(); } catch { /* already gone */ }
      }
      typingSubsRef.current.clear();
    };
  }, []);

  const activateCollection = (convId: string, opts?: { evict?: boolean }): boolean => {
    const existing = activeSubsRef.current.get(convId);
    if (existing) {
      existing.lastUsed = Date.now();
      existing.lastVisibleAt = Date.now();
      existing.visibleNow = true;
      subscribeTyping(convId);
      return true;
    }
    if (!auth.currentUser) return false;
    if (activeSubsRef.current.size >= MAX_ACTIVE_MESSAGE_COLLECTIONS) {
      if (!opts?.evict) return false;
      let victimId: string | null = null;
      let victimTs = Infinity;
      for (const [id, e] of activeSubsRef.current) {
        // Off-screen collections are evictable first; among them (or when
        // all are visible) the stalest-visible goes.
        const score = e.visibleNow ? e.lastVisibleAt + 1e12 : e.lastVisibleAt;
        if (score < victimTs) { victimTs = score; victimId = id; }
      }
      if (victimId) {
        try { activeSubsRef.current.get(victimId)?.unsub(); } catch (err) { /* already gone */ console.warn("[ChatListScreen] activateCollection: activeSubsRef.current.get(victimId)?.uns...", err); }
        // AUDIT-2 C5 / W2C: release the AppSync subscription too — the
        // unsubscribe above only drops this screen's listener.
        try { db.releaseCollection(`chats/${victimId}/messages`); } catch (e) { console.warn(`[ChatList] releaseCollection failed for ${victimId}:`, e); }
        activeSubsRef.current.delete(victimId);
        // FIX 3c: the evicted row's typing subscription goes with it.
        unsubscribeTyping(victimId);
      }
    }
    try {
      // db.subscribe ensures the collection (deduped by database.ts) and
      // delivers live updates; the callback reuses the diffing preview
      // check, so an event that changes no preview costs no React work.
      // Report 3 #223/#232 (W5b): the same callback also runs the shared
      // kx runner for this collection — a peer's announce is stored and
      // acked while the user just looks at the list, without opening the
      // chat. Groups never run it (no E2EE by design). A real message
      // arriving here also graduates a pending row to a normal row.
      const myUid = auth.currentUser?.uid || '';
      const chatForConv = chatsRef.current.find((c: any) => {
        try { return myUid && getConversationId(myUid, c.id) === convId; } catch { return false; }
      });
      const isGroupConv = Boolean((chatForConv as any)?.isGroup);
      const unsub = db.subscribe(`chats/${convId}/messages`, () => {
        // W13 (#127 settled): new data for this collection — invalidate
        // the active-branch preview memo so the next check recomputes.
        previewVersionRef.current.set(convId, (previewVersionRef.current.get(convId) || 0) + 1);
        // §1b (audit #32, Wave-2 C4): a live delivery may carry messages
        // that are already past the timer — sweep them here (throttled)
        // so a chat the user never opens still gets its expired
        // messages actually deleted, not just filtered from the preview.
        maybeSweepExpired(convId);
        // W13 NEXT R8 (B2): coalesced — a burst of deliveries runs one
        // diff per 300 ms, not one per delivery (see schedulePreviewCheck).
        schedulePreviewCheck();
        if (myUid) {
          if (pendingKxRef.current.has(convId)) {
            try {
              if ((db.getCollectionDocs(`chats/${convId}/messages`)?.length || 0) > 0) clearPendingKxConv(convId);
            } catch { /* best-effort graduation */ }
          }
          void processKeyExchangeDocs(convId, db.getKeyExchangeDocs(`chats/${convId}/messages`), myUid, writeKxDoc, { isGroup: isGroupConv });
        }
      });
      activeSubsRef.current.set(convId, { unsub, lastUsed: Date.now(), lastVisibleAt: Date.now(), visibleNow: true });
      // FIX 3c: typing follows the message collection's lifecycle.
      subscribeTyping(convId);
      // Immediate pass on the cached docs (the subscribe callback only
      // fires on the next event); dedup makes the double pass cheap.
      if (myUid) void processKeyExchangeDocs(convId, db.getKeyExchangeDocs(`chats/${convId}/messages`), myUid, writeKxDoc, { isGroup: isGroupConv });
      // §1b (audit #32, Wave-2 C4): same sweep for docs already cached
      // when the collection activates — the callback above only fires
      // on the next delivery, and an unopened chat may get no delivery.
      maybeSweepExpired(convId);
      return true;
    } catch {
      return false;
    }
  };

  // IntersectionObserver bookkeeping: a row leaving the viewport stops
  // counting as visible (it ages out and becomes the next eviction
  // victim); a row entering is marked visible immediately.
  const markRowVisibility = (convId: string, visible: boolean) => {
    const e = activeSubsRef.current.get(convId);
    if (!e) return;
    e.visibleNow = visible;
    if (visible) e.lastVisibleAt = Date.now();
  };

  // LocalStorage memo of proven conversations (per account). Best-effort:
  // a missing/corrupt memo just means re-discovery, never a crash.
  const loadKnownConvsMemo = (uid: string) => {
    try {
      const arr = JSON.parse(localStorage.getItem(`pinglo_known_convs_${uid}`) || '[]');
      if (Array.isArray(arr)) {
        knownConvIdsRef.current = new Set(arr.slice(0, KNOWN_CONVS_MEMO_MAX));
        setKnownConvIds(new Set(knownConvIdsRef.current));
      }
    } catch (err) {
      /* memo is best-effort */
      console.warn("[ChatListScreen] loadKnownConvsMemo: const arr = JSON.parse(localStorage.getI...", err);
    }
  };
  const markKnownConv = (convId: string) => {
    if (knownConvIdsRef.current.has(convId)) return;
    knownConvIdsRef.current.add(convId);
    setKnownConvIds(new Set(knownConvIdsRef.current));
    try {
      const uid = myUidRef.current;
      if (uid) {
        localStorage.setItem(
          `pinglo_known_convs_${uid}`,
          JSON.stringify([...knownConvIdsRef.current].slice(0, KNOWN_CONVS_MEMO_MAX)),
        );
      }
    } catch (err) {
      /* memo is best-effort */
      console.warn("[ChatListScreen] markKnownConv: const uid = myUidRef.current failed", err);
    }
    // W28 R5: the gated pickers (Calls/Status/Broadcast/Admin/ChatScreen)
    // load contacts once on mount and refresh on chats changes — but this
    // memo is a localStorage write, which fires neither. Notify them so a
    // partner discovered after mount appears without a chats change or
    // remount. (markKnownConv early-returns for already-known convs, so
    // this fires at most once per conversation per session.)
    try { window.dispatchEvent(new Event(KNOWN_CONVS_CHANGED_EVENT)); } catch { /* intentionally ignored */}
  };

  // Report 3 #223/#233 (W5b): localStorage memo of pending-kx
  // conversations (per account), same pattern as the known-conv memo.
  // A missing/corrupt memo just means re-discovery, never a crash.
  const persistPendingKxMemo = () => {
    try {
      const uid = myUidRef.current;
      if (!uid) return;
      const obj: Record<string, number> = {};
      for (const [cid, at] of pendingKxAtRef.current) obj[cid] = at;
      localStorage.setItem(`pinglo_pending_kx_${uid}`, JSON.stringify(obj));
    } catch (err) {
      /* memo is best-effort */
      console.warn('[ChatListScreen] persistPendingKxMemo failed', err);
    }
  };
  const loadPendingKxMemo = (uid: string) => {
    try {
      const obj = JSON.parse(localStorage.getItem(`pinglo_pending_kx_${uid}`) || '{}');
      if (obj && typeof obj === 'object') {
        const ids = Object.keys(obj).slice(0, KNOWN_CONVS_MEMO_MAX);
        pendingKxRef.current = new Set(ids);
        pendingKxAtRef.current = new Map(ids.map((id) => [id, Number((obj as any)[id]) || 0]));
        setPendingKxConvIds(new Set(pendingKxRef.current));
      }
    } catch (err) {
      /* memo is best-effort */
      console.warn('[ChatListScreen] loadPendingKxMemo failed', err);
    }
  };
  // Only a PEER's kx doc creates a row — my own un-acked announce alone
  // must not create a row on my own list. Records the latest kx sentAt
  // for sorting (see getChatPreview's pending branch).
  const markPendingKxConv = (convId: string, kxDocs: any[]) => {
    const myUid = myUidRef.current;
    if (!Array.isArray(kxDocs) || !kxDocs.some((d: any) => d && d.senderId && d.senderId !== myUid)) return;
    let latest = pendingKxAtRef.current.get(convId) || 0;
    for (const d of kxDocs) {
      const at = Number(d?.sentAt) || Number(d?.timestamp) || 0;
      if (at > latest) latest = at;
    }
    const changed = !pendingKxRef.current.has(convId) || (pendingKxAtRef.current.get(convId) || 0) !== latest;
    pendingKxRef.current.add(convId);
    pendingKxAtRef.current.set(convId, latest);
    if (changed) {
      setPendingKxConvIds(new Set(pendingKxRef.current));
      persistPendingKxMemo();
    }
  };
  const clearPendingKxConv = (convId: string) => {
    if (!pendingKxRef.current.has(convId)) return;
    pendingKxRef.current.delete(convId);
    pendingKxAtRef.current.delete(convId);
    setPendingKxConvIds(new Set(pendingKxRef.current));
    persistPendingKxMemo();
  };

  // One background probe: load this user's message collection once and
  // record whether a conversation exists. Bounded by pumpDiscovery below.
  const probeCollection = async (convId: string): Promise<void> => {
    if (probedRef.current.has(convId) || knownConvIdsRef.current.has(convId)) return;
    probedRef.current.add(convId);
    discoveryInFlightRef.current += 1;
    try {
      await db.ensure(`chats/${convId}/messages`);
      const msgs = db.getCollectionDocs(`chats/${convId}/messages`);
      const kxDocs = db.getKeyExchangeDocs(`chats/${convId}/messages`);
      if ((msgs?.length || 0) > 0) {
        markKnownConv(convId);
        clearPendingKxConv(convId);
        // W13 (#131): seed the stable preview cache from the probe —
        // the row shows its real last message without waiting for a
        // scroll-into-view activation (and without a live subscription).
        // Pass isGroup so a probed group preview carries the sender
        // prefix too (FIX 3b); unknown convs get no prefix.
        const probeChat = chatsRef.current.find((c: any) => {
          try { return convIdForChat(c) === convId; } catch { return false; }
        });
        cachePreviewFromMsgs(convId, msgs, 0, Boolean((probeChat as any)?.isGroup));
      } else if (kxDocs.length > 0) {
        // Report 3 #223/#233 (W5b): announce-only collection — a pending
        // row for B, and the shared runner stores the peer key + writes
        // B's ack without B opening the chat. No new polling loop: the
        // probe already loaded this collection; the kx pass is a filter
        // over docs already in memory.
        markPendingKxConv(convId, kxDocs);
      }
      if (kxDocs.length > 0 && auth.currentUser?.uid) {
        void processKeyExchangeDocs(convId, kxDocs, auth.currentUser.uid, writeKxDoc);
      }
    } catch (err) {
      // Offline / load failed: stays "probed" so one failing user cannot
      // spin the queue; the 30 s rescan retries empties.
      console.warn("[ChatListScreen] probeCollection: await db.ensure(`chats/${convId}/messages`)...", err);
    } finally {
      discoveryInFlightRef.current -= 1;
    }
  };
  const pumpDiscovery = () => {
    while (
      discoveryInFlightRef.current < DISCOVERY_CONCURRENCY &&
      discoveryQueueRef.current.length > 0
    ) {
      const convId = discoveryQueueRef.current.shift();
      if (!convId) break;
      void probeCollection(convId).finally(() => pumpDiscovery());
    }
  };

  // C3 discovery: enqueue every not-yet-known user for a background probe
  // (bounded concurrency above — never N-at-once), and slowly re-probe
  // previously-empty users round-robin so a first message from a silent
  // user still surfaces. Without a server-side conversation index
  // (BACKEND-PLAN.md §16) there is no cheaper way to learn that a first
  // message exists — the win is bounding, prioritising and memoising,
  // not pretending the probe can disappear entirely.
  useEffect(() => {
    if (!auth.currentUser) return;
    for (const c of chats) {
      if (hiddenChatIds.includes(c.uid) || hiddenChatIds.includes(c.id)) continue;
      if (c.isGroup) continue;
      const convId = getConversationId(auth.currentUser.uid, c.id);
      if (knownConvIdsRef.current.has(convId) || probedRef.current.has(convId)) continue;
      if (discoveryQueueRef.current.includes(convId)) continue;
      // Chats with explicit prefs already render without discovery.
      const prefs = chatPrefs[c.id];
      if (prefs && (prefs.pinned || prefs.archived || prefs.folderId || prefs.markedUnread)) continue;
      discoveryQueueRef.current.push(convId);
    }
    pumpDiscovery();
    if (!discoveryTimerRef.current) {
      discoveryTimerRef.current = setInterval(() => {
        const empties = [...probedRef.current].filter((id) => !knownConvIdsRef.current.has(id));
        if (!empties.length) return;
        for (let i = 0; i < DISCOVERY_RESCAN_BATCH; i++) {
          const id = empties[(rescanCursorRef.current + i) % empties.length];
          if (!id || discoveryQueueRef.current.includes(id)) continue;
          probedRef.current.delete(id);
          discoveryQueueRef.current.push(id);
        }
        rescanCursorRef.current = (rescanCursorRef.current + DISCOVERY_RESCAN_BATCH) % empties.length;
        pumpDiscovery();
      }, DISCOVERY_RESCAN_INTERVAL_MS);
    }
    // No cleanup here: this effect re-runs when the user list changes, but
    // the rescan timer is owned for the screen's lifetime (unmount effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, hiddenChatIds, chatPrefs]);

  // C3 unmount: stop the rescan timer and drop every live collection
  // subscription this screen opened — including the underlying AppSync
  // subscription (AUDIT-2 C5 / W2C: db.releaseCollection).
  useEffect(() => () => {
    if (discoveryTimerRef.current) {
      clearInterval(discoveryTimerRef.current);
      discoveryTimerRef.current = null;
    }
    for (const [cid, e] of activeSubsRef.current) {
      try { e.unsub(); } catch (err) { /* already gone */ console.warn("[ChatListScreen] pumpDiscovery: e.unsub() failed", err); }
      try { db.releaseCollection(`chats/${cid}/messages`); } catch (err) { console.warn("[ChatListScreen] unmount releaseCollection failed", err); }
    }
    activeSubsRef.current.clear();
  }, []);

  const getContactName = (chat: any) => {
    // #152: a group row shows the group name, not a user fallback.
    if (chat.isGroup) return (chat.name || '').trim() || 'Group';
    const raw = chat.displayName?.trim() || chat.username?.trim();
    if (raw && raw !== 'Unknown') return raw;
    if (chat.email) return chat.email.split('@')[0];
    return 'DT User';
  };

  // WA-verify row 27: one name-match predicate for search, shared by the
  // list filter, the deep-search name skip and the snippet memo so they
  // can never disagree. A display name must NOT hide the username: a
  // contact displayed as "Example Contact" still matches "exampleuser",
  // and the email matches too (as before).
  const matchesName = (chat: any, q: string): boolean => {
    if (getContactName(chat).toLowerCase().includes(q)) return true;
    if ((chat.username || '').toLowerCase().includes(q)) return true;
    if ((chat.email || '').toLowerCase().includes(q)) return true;
    return false;
  };

  // Group creation timestamp in ms (number, Firestore Timestamp, or
  // toMillis()) — 0 when unknown, so a group with no messages yet sorts
  // by its creation time instead of landing at the very bottom.
  const groupTimestampMs = (chat: any): number => {
    const ts: any = chat.timestamp;
    if (typeof ts === 'number') return ts;
    if (ts && typeof ts.seconds === 'number') return ts.seconds * 1000;
    if (ts && typeof ts.toMillis === 'function') {
      try { return ts.toMillis(); } catch { return 0; }
    }
    return 0;
  };

  const getChatPreview = (chat: any) => {
    if (!auth.currentUser) return { text: 'No messages yet', time: '', unread: 0, sortTs: 0, activityTs: 0, isMine: false, lastStatus: '', isDraft: false, draftText: '' };
    // Phase 5 (L-04): a locked chat must never contribute a preview, a
    // time or an unread count to ANY list, even if a caller forgets to
    // filter first. Generic text, zero unread, no timestamp.
    if (hiddenChatIds.includes(chat.uid) || hiddenChatIds.includes(chat.id)) {
      return { text: 'Message', time: '', unread: 0, sortTs: 0, activityTs: 0, isMine: false, lastStatus: '', isDraft: false, draftText: '' };
    }
    const convId = chat.isGroup ? cleanId(chat.id) : getConversationId(auth.currentUser.uid, chat.id);
    // #28: an unsent draft replaces the last-message preview (WhatsApp
    // shows a green "Draft: <text>" line). The key must match ChatScreen's
    // `dt_draft_<conversationId>` — groups use cleanId(chat.id), DMs the
    // sorted-uid conversation id. Drafts in locked chats never reach here
    // (hidden check above returns first), so no draft text can leak.
    const draftConvId = chat.isGroup ? cleanId(chat.id) : convId;
    let draftText: string;
    try { draftText = (localStorage.getItem(`dt_draft_${draftConvId}`) || '').trim(); } catch { draftText = ''; }
    // W13 (#127/#131): an EVICTED chat serves its cached message-derived
    // preview — a stable sort key + stable text, never the bio fallback.
    // This is what breaks the feedback loop: activation no longer flips
    // sortTs/text, so the sort cannot reorder rows, so the observer +
    // LRU cannot evict a different set on the next pass. Reading the
    // cache also skips getLoadedMessages here, which rebuilt + ran the
    // E2EE decrypt-memo over every doc on each 3 s check (~30% idle CPU).
    // Draft text is localStorage, applied on top of the cached preview.
    const isActive = activeSubsRef.current.has(convId);
    if (!isActive) {
      const cached = previewCacheRef.current.get(convId);
      if (cached) {
        // §1b: a preview cached while its last message was live must not
        // outlive that message's expiry while the row is evicted.
        const timerEv = typeof chatMetaRef.current[convId]?.disappearAfter === 'number' ? chatMetaRef.current[convId].disappearAfter : 0;
        if (timerEv > 0 && cached.sortTs > 0 && Date.now() - cached.sortTs >= timerEv) {
          previewCacheRef.current.delete(convId);
        } else {
          return { ...cached, text: draftText || cached.text, isDraft: draftText.length > 0, draftText };
        }
      }
    }
    // C3: preview reads ONLY an already-active (visible) collection —
    // never starts a load for an off-screen user. Unloaded chats show
    // the no-message fallback until discovery/activation loads them
    // (the probe seeds the cache for them — see probeCollection).
    const msgs = getLoadedMessages(convId);
    if (!msgs || msgs.length === 0) {
      // Report 3 #223/#233 (W5b): honest pending row — a peer's
      // key-announce exists but no real message yet. No preview text
      // from any message (there is none), no time, no unread badge, no
      // tick. Sorts by the latest kx sentAt (never by presence), and
      // counts as activity only at that timestamp, so the deleted-chat
      // rule below still hides a chat deleted after the kx doc.
      const pendingAt = pendingKxAtRef.current.get(convId);
      if (pendingKxConvIds.has(convId) && pendingAt) {
        return {
          text: 'Setting up encryption…',
          time: '',
          unread: 0,
          sortTs: pendingAt,
          activityTs: pendingAt,
          isMine: false,
          lastStatus: '',
          isDraft: false,
          draftText: '',
        };
      }
      // W13: an active-but-empty collection means every message was
      // deleted — drop any stale cached preview so a deleted chat
      // cannot keep showing its old last message.
      if (isActive) { previewCacheRef.current.delete(convId); previewMemoRef.current.delete(convId); }
      return {
        // #152: a group with no messages yet shows its description (or
        // "No messages yet"); a DM with no messages yet shows the same
        // neutral text (WA #16 — never a DM bio / "Hey there!" fallback,
        // never an "Online" presence line).
        text: draftText || (chat.isGroup ? (chat.description || tr('noMessagesYet')) : tr('noMessagesYet')),
        time: '',
        unread: 0,
        sortTs: chat.isGroup ? groupTimestampMs(chat) : (Number(chat.lastSeen) || 0),
        activityTs: 0,
        isMine: false,
        lastStatus: '',
        isDraft: draftText.length > 0,
        draftText,
      };
    }
    // W13 (#127 settled): memoised active branch — recompute only when
    // the collection delivered new data or its read watermark changed;
    // otherwise the 3 s check would rebuild + decrypt-memo every doc
    // of every active collection (the residual settled longtasks).
    const version = previewVersionRef.current.get(convId) || 0;
    const metaNow = chatMetaRef.current[convId];
    const memo = previewMemoRef.current.get(convId);
    // §1b: a memoised preview goes stale when its last message expires
    // by passage of time (no new delivery bumps the version). The
    // recompute below re-filters and falls back to no-message text.
    const timerMemo = typeof metaNow?.disappearAfter === 'number' ? metaNow.disappearAfter : 0;
    const memoExpired = timerMemo > 0 && memo && memo.preview.sortTs > 0 && Date.now() - memo.preview.sortTs >= timerMemo;
    if (memo && memo.version === version && memo.meta === metaNow && !memoExpired) {
      return { ...memo.preview, text: draftText || memo.preview.text, isDraft: draftText.length > 0, draftText };
    }
    // W13: the message branch now goes through the cache helper (one
    // O(n) last-message scan + unread count, then cached). It returns
    // null only when there is no user, which cannot happen here.
    const cached = cachePreviewFromMsgs(convId, msgs, Number(chat.lastSeen) || 0, Boolean(chat.isGroup));
    if (!cached) {
      return {
        // WA #16: no-message fallback is the neutral text — never the
        // peer's bio / "Hey there!" and never an "Online" presence line.
        text: draftText || 'No messages yet',
        time: '',
        unread: 0,
        sortTs: Number(chat.lastSeen) || 0,
        activityTs: 0,
        isMine: false,
        lastStatus: '',
        isDraft: draftText.length > 0,
        draftText,
      };
    }
    previewMemoRef.current.set(convId, { version, meta: metaNow, preview: cached });
    return { ...cached, text: draftText || cached.text, isDraft: draftText.length > 0, draftText };
  };

  // L2: keep the "latest" refs fresh for the change-detecting preview
  // check above (assigned during render so the mount-time check already
  // uses the real preview function, not the stub).
  // #152: the preview check iterates DMs + groups (allChats), so a new
  // group message refreshes the list within the 3 s check.
  chatsRef.current = allChats;
  chatPrefsRef.current = chatPrefs;
  hiddenChatIdsRef.current = hiddenChatIds;
  chatMetaRef.current = chatMeta;
  previewFnRef.current = getChatPreview;

  // Phase 3: search message text across all chats (local cache, same source
  // getChatPreview already reads). Returns the first matching message text.
  // WA-verify row 28: media captions are searchable text too — a photo
  // captioned "birthday party" matches "birthday". The caption is an
  // encrypted text field on the doc, same as `text` (e2eeChat.ts), and
  // getCollectionDocs already returns it decrypted, so both passes can
  // match it. Returns whichever field matched, so the snippet shows the
  // matching text.
  const chatMessageMatch = (chat: any, q: string): string | null => {
    if (!auth.currentUser) return null;
    // Phase 5 (L-05): locked chats are excluded from search-all-chats even
    // if the list filter above is ever bypassed.
    if (hiddenChatIds.includes(chat.uid) || hiddenChatIds.includes(chat.id)) return null;
    try {
      // #193: group messages are searchable too — same collection id the
      // preview uses (cleanId for groups, sorted-uid id for DMs).
      const convId = chat.isGroup ? cleanId(chat.id) : getConversationId(auth.currentUser.uid, chat.id);
      // C3: message-text search covers active (loaded) collections only —
      // searching every user's full history on each keystroke was the C3
      // storm in miniature. Names still match for every user. This is
      // Pass 1 (instant, loaded-first); unloaded collections are covered
      // by the G4 Pass 2 background deep search below, not here.
      const msgs = getLoadedMessages(convId);
      const hit = msgs.find((m: any) => {
        if (m.deleted) return false;
        return (m.text || '').toLowerCase().includes(q) || (m.caption || '').toLowerCase().includes(q);
      });
      if (!hit) return null;
      return (hit.text || '').toLowerCase().includes(q) ? (hit.text as string) : (hit.caption as string);
    } catch { return null; }
  };

  // G4 Pass 2 — background deep search over UNLOADED collections
  // (Diagram D2 in nightshift-find-chat.md). Pass 1 above answers
  // instantly from loaded collections; this pass then scans the
  // remaining conversations that can render (hasConversation) in the
  // background and merges hits into deepSearchHits, which the filter
  // and the snippet memo below read. Bounds (the C3 storm guard):
  // runs once per DEBOUNCED query, never per keystroke; at most
  // SEARCH_DEEP_MAX_COLLECTIONS collections per query, at most
  // SEARCH_DEEP_CONCURRENCY loads in flight; a new keystroke bumps
  // the run token and every in-flight worker discards its result.
  // Load path: db.ensure() — the same call the discovery probe uses —
  // restores from the IDB cache first (mock: disk only, no network),
  // so this reads local cache, never a server search (there is no
  // server-side message search; a new AppSync query is backend work,
  // noted as the optional later step). One failing collection is
  // swallowed so it cannot kill the scan.
  useEffect(() => {
    const q = searchQueryDebounced.trim().toLowerCase();
    const runId = ++deepSearchRunRef.current;
    setDeepSearchHits(new Map());
    setDeepSearchPending(false);
    if (!q || !auth.currentUser) return;
    const candidates: { chat: any; convId: string }[] = [];
    for (const c of allChats) {
      if (hiddenChatIds.includes(c.uid) || hiddenChatIds.includes(c.id)) continue;
      // Name match and Pass 1 (loaded) match already render — skip them.
      if (matchesName(c, q)) continue;
      if (chatMessageMatch(c, q) !== null) continue;
      const convId = convIdForChat(c);
      if (!convId) continue;
      if (activeSubsRef.current.has(convId)) continue;
      if (!hasConversation(c)) continue;
      candidates.push({ chat: c, convId });
    }
    if (!candidates.length) return;
    // WA-verify row 28: the 30-collection cap is a C3 storm guard, so
    // spend it on the most recent chats first. The cap is applied AFTER
    // this sort (not while collecting): capping first in snapshot order
    // used to drop the most recent chat when it was 31st in the list.
    // Sort key is the cached preview's sortTs (last-message time; falls
    // back to presence/creation time for chats with no messages yet).
    candidates.sort((a, b) => {
      let sa = 0; let sb = 0;
      try { sa = previewFnRef.current(a.chat)?.sortTs || 0; } catch { sa = 0; }
      try { sb = previewFnRef.current(b.chat)?.sortTs || 0; } catch { sb = 0; }
      return sb - sa;
    });
    candidates.splice(SEARCH_DEEP_MAX_COLLECTIONS);
    setDeepSearchPending(true);
    let next = 0;
    let inFlight = 0;
    let stopped = false;
    const finishIfDone = () => {
      if (next >= candidates.length && inFlight === 0 && deepSearchRunRef.current === runId) {
        setDeepSearchPending(false);
      }
    };
    const pump = () => {
      if (stopped || deepSearchRunRef.current !== runId) return;
      while (inFlight < SEARCH_DEEP_CONCURRENCY && next < candidates.length) {
        const { chat, convId } = candidates[next++];
        inFlight += 1;
        void (async () => {
          try {
            await db.ensure(`chats/${convId}/messages`);
            if (deepSearchRunRef.current !== runId) return;
            const msgs = db.getCollectionDocs(`chats/${convId}/messages`) || [];
            // WA-verify row 28: captions match here too (same rule as
            // Pass 1 above); the snippet is whichever field matched.
            const hit = msgs.find((m: any) => {
              if (m.deleted) return false;
              return (m.text || '').toLowerCase().includes(q) || (m.caption || '').toLowerCase().includes(q);
            });
            if (hit && deepSearchRunRef.current === runId) {
              const hitText = (hit.text || '').toLowerCase().includes(q) ? (hit.text as string) : (hit.caption as string);
              setDeepSearchHits((prev) => {
                if (prev.get(chat.id) === hitText) return prev;
                const nextMap = new Map(prev);
                nextMap.set(chat.id, hitText);
                return nextMap;
              });
            }
          } catch { /* one failing collection must not kill the scan */ }
          finally {
            inFlight -= 1;
            if (!stopped) { finishIfDone(); pump(); }
          }
        })();
      }
      finishIfDone();
    };
    pump();
    return () => { stopped = true; setDeepSearchPending(false); };
    // Query-driven only: candidates are fixed at query time; a new
    // keystroke (new debounced query) re-runs with a fresh run token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQueryDebounced]);

  // Worker B (phone-issues fix): the chat list is CONVERSATIONS, not a
  // user directory. A row is shown only when there is an actual
  // conversation (at least one cached message in chats/<convId>/messages),
  // a group, or an explicit per-chat setting (pinned / archived / folder /
  // marked-unread) that proves the user deliberately kept this chat. A
  // newly-joined user with no messages never appears — previously every
  // registered user was rendered as a chat row, so everyone saw every
  // new user.
  // C3: this must NOT load a collection to answer the question — the old
  // getCollectionDocs call here ensured + subscribed one collection per
  // user on every render. A row appears when the conversation is PROVEN
  // (background discovery found messages, memoised in localStorage) or
  // its collection is already active; undiscovered users appear once the
  // bounded background discovery finds their messages.
  const hasConversation = (chat: any): boolean => {
    if (!auth.currentUser) return false;
    if (chat.isGroup) return true;
    const prefs = chatPrefs[chat.id];
    if (prefs && (prefs.pinned || prefs.archived || prefs.folderId || prefs.markedUnread)) return true;
    try {
      const convId = chat.isGroup ? cleanId(chat.id) : getConversationId(auth.currentUser.uid, chat.id);
      if (knownConvIds.has(convId)) return true;
      // Report 3 #233 (W5b): a peer's key-announce alone proves a
      // conversation-in-setup — the row shows "Setting up encryption…"
      // (see getChatPreview), not a fake message.
      if (pendingKxConvIds.has(convId)) return true;
      if (activeSubsRef.current.has(convId)) {
        const msgs = db.getCollectionDocs(`chats/${convId}/messages`);
        return (msgs?.length || 0) > 0;
      }
      return false;
    } catch {
      return false;
    }
  };

  // #23: memoized — the old inline chain re-ran hasConversation +
  // getChatPreview + a per-chat message-text scan (chatMessageMatch)
  // on EVERY render, including every search keystroke. It now
  // recomputes only when its inputs change; `tick` is the 3s
  // preview-change signal, so a new message still refreshes the list.
  const filteredChats = useMemo(() => {
    // W13 NEXT R8 (B2): one preview computation per chat per run. The
    // sort comparator used to call getChatPreview per comparison (~1,500
    // calls for 200 chats) and the filters called it again per chat.
    const previewByChat = new Map<any, any>();
    const pv = (c: any) => {
      let p = previewByChat.get(c);
      if (!p) { p = getChatPreview(c); previewByChat.set(c, p); }
      return p;
    };
    return allChats
    .filter(c => !hiddenChatIds.includes(c.uid) && !hiddenChatIds.includes(c.id))
    // Worker B: no conversation, no row (see hasConversation above).
    .filter(c => hasConversation(c))
    // A deleted chat comes back only when a message newer than the deletion arrives.
    // C3: while its collection is not loaded yet there is no activityTs to
    // compare — keep the row (it activates, loads, and re-hides on the
    // next pass if nothing new arrived) rather than hiding a conversation
    // that may legitimately have come back. Transient cost: a deleted chat
    // can flash once with a fallback preview while its collection loads.
    .filter(c => {
      const deletedAt = chatPrefs[prefKeyForChat(c)]?.deletedAt;
      if (!deletedAt) return true;
      const convId = convIdForChat(c);
      if (!convId || !activeSubsRef.current.has(convId)) return true;
      return pv(c).activityTs > deletedAt;
    })
    .filter(c => {
      const archived = Boolean(chatPrefs[prefKeyForChat(c)]?.archived);
      // Archived chats live only in the Archived view (WhatsApp behaviour)
      // — EXCEPT while searching: search is global, so archived hits show
      // too (WA parity top-10 #6), marked with an "Archived" badge.
      if (filter === ARCHIVED_FILTER) return archived;
      if (archived) {
        // Search-first (A): search is global, so archived hits show too
        // (WA parity top-10 #6), marked with an "Archived" badge.
        if (searchQueryDebounced.trim().length > 0) return true;
        // Keep-archived (E, audit e #48): "Keep chats archived" ON (default)
        // keeps archived chats hidden even with new messages. OFF lets an
        // archived chat with unread messages resurface in All / Unread until read.
        if (!getKeepChatsArchived() && pv(c).unread > 0) return filter === 'All' || filter === 'Unread';
        return false;
      }
      const folderId = folderIdFromFilter(filter);
      if (folderId) return chatPrefs[prefKeyForChat(c)]?.folderId === folderId;
      if (filter === 'Unread') {
        const preview = pv(c);
        // WA parity top-10 #4: a manually marked-unread chat (green dot,
        // zero real unread) belongs under Unread too.
        return preview.unread > 0 || Boolean(chatPrefs[prefKeyForChat(c)]?.markedUnread);
      }
      if (filter === 'Favorites') return Boolean(chatPrefs[prefKeyForChat(c)]?.favorite);
      if (filter === 'Groups') return Boolean(c.isGroup);
      return true;
    })
    .filter(c => {
      if (!searchQueryDebounced.trim()) return true;
      const q = searchQueryDebounced.toLowerCase();
      // WA-verify row 27: matchesName (display name + username + email)
      // — a display name must not hide the username.
      if (matchesName(c, q)) return true;
      // Phase 3: also match message text across chats, not just names.
      // G4 Pass 2: a background deep-search hit in an unloaded
      // collection counts the same as a Pass 1 loaded hit.
      return chatMessageMatch(c, q) !== null || deepSearchHits.has(c.id);
    })
    .sort((a, b) => {
      // Pinned chats first, then the newest activity
      const pa = chatPrefs[prefKeyForChat(a)]?.pinned ? 1 : 0;
      const pb = chatPrefs[prefKeyForChat(b)]?.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return pv(b).sortTs - pv(a).sortTs;
    });
  }, [allChats, hiddenChatIds, chatPrefs, filter, searchQueryDebounced, knownConvIds, pendingKxConvIds, tick, deepSearchHits]);

  // #23: the row render below used to call chatMessageMatch (a scan of
  // that chat's loaded messages) for EVERY visible row on EVERY render.
  // Now the scan runs once per debounced query, over the filtered list.
  const searchSnippets = useMemo(() => {
    const map = new Map<string, string | null>();
    const q = searchQueryDebounced.trim().toLowerCase();
    if (!q) return map;
    for (const c of filteredChats) {
      // WA-verify row 27: a name/username/email match shows the normal
      // preview, never a message snippet (matchesName, same as the filter).
      if (matchesName(c, q)) { map.set(c.id, null); continue; }
      // G4 Pass 2: fall back to the background deep-search hit when
      // Pass 1 (loaded collections) found nothing in this chat.
      map.set(c.id, chatMessageMatch(c, q) ?? deepSearchHits.get(c.id) ?? null);
    }
    return map;
  }, [filteredChats, searchQueryDebounced, hiddenChatIds, deepSearchHits]);

  // Worker B: badge counts and the group-member picker are computed over
  // conversation partners only — never over every registered user.
  // Phase 5 (L-03): badge counts exclude locked chats — a count that moves
  // when a locked chat is archived would leak its existence.
  const conversationPartners = useMemo(() => allChats.filter(
    (c) => !hiddenChatIds.includes(c.uid) && !hiddenChatIds.includes(c.id) && hasConversation(c)
  ), [allChats, hiddenChatIds, chatPrefs, knownConvIds, pendingKxConvIds, tick]);
  // #175: the New Group picker lists EVERY registered user, not just people
  // with a DM conversation (Group Info's add-members picker already did).
  const allUsersForPicker = useMemo(() => chats.filter(
    (c) => !hiddenChatIds.includes(c.uid) && !hiddenChatIds.includes(c.id)
  ), [chats, hiddenChatIds]);
  // #192: folder/archive counts look prefs up by pref key — for groups that
  // is cleanId(groupId), not the raw doc id.
  const visibleChatIds = conversationPartners.map((c) => prefKeyForChat(c));
  const archivedCount = countArchived(chatPrefs, visibleChatIds);
  const folderCounts: Record<string, number> = Object.fromEntries(
    chatFolders.map(f => [f.id, countInFolder(chatPrefs, visibleChatIds, f.id)]),
  );

  // W13 (#145): windowed rendering — the list renders only the rows in
  // (or near) the viewport instead of all 203. Rows are uniform height
  // (measured 83 px across 21 sampled rows in the REPORT-3 probe) and
  // the header above them is the Saved Messages pinned row (72 px, only
  // when filter is All and there is no search) + the 1 px divider. Both
  // heights are measured from the DOM after first paint; the fallbacks
  // are the measured values, so the window is right even before the
  // first measurement.
  const OVERSCAN_ROWS = 8;
  const FALLBACK_ROW_H = 83;
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(844);
  const [measuredRowH, setMeasuredRowH] = useState<number | null>(null);
  const [measuredHeaderH, setMeasuredHeaderH] = useState<number | null>(null);
  const scrollRafRef = useRef(0);
  const pinnedRowRef = useRef<HTMLDivElement | null>(null);
  // W13 (#145): the row-visibility observer lives in a ref so it is
  // created once — rows observe/unobserve themselves in their ref
  // callback as the window slides, instead of the effect tearing the
  // observer down and rebuilding it on every scroll step.
  const ioRef = useRef<IntersectionObserver | null>(null);
  const rowH = measuredRowH ?? FALLBACK_ROW_H;
  const fallbackHeaderH = (!searchQuery ? 1 : 0) + (!searchQuery && filter === 'All' ? 72 : 0);
  const headerH = measuredHeaderH ?? fallbackHeaderH;
  const winStart = Math.max(0, Math.floor((scrollTop - headerH) / rowH) - OVERSCAN_ROWS);
  const winEnd = Math.min(filteredChats.length, Math.ceil((scrollTop - headerH + viewportH) / rowH) + OVERSCAN_ROWS);
  const visibleChats = filteredChats.slice(winStart, winEnd);

  // C3 activation: fill free slots with the top rows of the current list
  // (most recent first — the rows the user actually sees). Never evicts:
  // a below-fold row must not push a visible row out; rows further down
  // activate when scrolled into view (observer below). Runs on the list
  // signature, not on every render. (Placed here, after filteredChats exists.)
  const listSig = filteredChats.map((c) => c.id).join(',');
  useEffect(() => {
    if (!auth.currentUser) return;
    for (const c of filteredChats) {
      const convId = convIdForChat(c);
      if (!convId) continue;
      if (activeSubsRef.current.has(convId)) continue;
      // evict: false — stop at the cap instead of churning visible rows.
      if (!activateCollection(convId)) break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSig]);

  // C3: rows scrolled into view (200 px prefetch margin) subscribe their
  // collection — evicting the stalest OFF-SCREEN one when the cap is
  // full — and rows scrolled away stop counting as visible, so they age
  // out first. This is what makes the cap converge instead of churn.
  useEffect(() => {
    const root = listContainerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const convId = (entry.target as HTMLElement).dataset.convId;
          if (!convId) continue;
          if (entry.isIntersecting) {
            markRowVisibility(convId, true);
            activateCollection(convId, { evict: true });
          } else {
            markRowVisibility(convId, false);
          }
        }
      },
      { root, rootMargin: '200px' },
    );
    ioRef.current = io;
    for (const el of rowElsRef.current.values()) io.observe(el);
    return () => { io.disconnect(); ioRef.current = null; };
    // W13 (#145): no winStart/winEnd dep — the observer is created once
    // and rows observe/unobserve themselves via their ref callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSig]);

  // W13 (#145): scroll tracking for the render window — rAF-throttled
  // so a scroll step costs one state update, not one per scroll event.
  const onListScroll = () => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      const el = listContainerRef.current;
      if (!el) return;
      setScrollTop(el.scrollTop);
      setViewportH(el.clientHeight);
    });
  };
  // W13 (#145): measure the real row + header heights after paint, and
  // reset the scroll position when the filter/search changes (new set).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const firstRow = rowElsRef.current.values().next().value as HTMLElement | undefined;
      if (firstRow && firstRow.offsetHeight > 0) setMeasuredRowH(firstRow.offsetHeight);
      const el = listContainerRef.current;
      if (el) setViewportH(el.clientHeight);
      const pinnedH = pinnedRowRef.current?.offsetHeight ?? 0;
      setMeasuredHeaderH(pinnedH + (!searchQuery ? 1 : 0));
    });
    return () => cancelAnimationFrame(raf);
  }, [filteredChats.length, filter, searchQuery]);
  useEffect(() => {
    const el = listContainerRef.current;
    if (el) { el.scrollTop = 0; setScrollTop(0); setViewportH(el.clientHeight); }
  }, [filter, searchQueryDebounced]);

  // ── WA parity (row 38): "Mark as read" clears a REAL unread badge ──
  // Before, the menu action only flipped the manual `markedUnread` flag,
  // so a chat with real unread offered only "Mark as unread" (a visual
  // no-op — the count badge takes precedence over the dot) and no list
  // action could clear the badge without opening the chat. WhatsApp's
  // "Mark as read" clears the badge from the list, so this mirrors
  // ChatScreen's read-receipt effect (ChatScreen.tsx:2046-2090):
  //  (1) stamp the local-only "read up to now" marker (both receipts
  //      modes) — this is what the badge reads on this device;
  //  (2) when the collection is loaded, advance the seenUpTo /
  //      deliveredUpTo watermark on the chat doc — `seen` only when
  //      read receipts are ON, `delivered` always — so the peer gets
  //      the read receipt and legacy unstamped messages clear too.
  // The server write is best-effort: the local stamp already cleared
  // the badge, so an offline failure leaves nothing visibly wrong.
  // (3) drop the memoised preview + bump tick: getChatPreview memoises
  // on collection version + chat-meta identity, so a local-only stamp
  // would otherwise leave the badge stale until the next delivery.
  // Unloaded collections: only the local stamp applies (no messages in
  // hand to pick a watermark from); the badge clears when the collection
  // next loads and the preview recomputes.
  const markChatReadFromList = (chat: any) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const convId = convIdForChat(chat);
    if (!convId) return;
    markChatReadLocally(uid, convId);
    try {
      const msgs = getLoadedMessages(convId);
      const pick = pickSeenUpTo(msgs, uid);
      if (pick) {
        const meta = chatMetaRef.current[convId] || {};
        const me = cleanId(uid);
        const storedSeen = seenUpToForUser(meta.seenUpTo, me) ?? null;
        const storedDelivered = seenUpToForUser(meta.deliveredUpTo, me) ?? null;
        const targetSeen = readReceipts ? mergeSeenUpTo(storedSeen, pick) : null;
        const targetDelivered = mergeSeenUpTo(storedDelivered, pick);
        const updates: Record<string, any> = {};
        if (targetSeen && (!storedSeen || targetSeen !== storedSeen)) updates[`seenUpTo.${me}`] = targetSeen;
        if (targetDelivered && (!storedDelivered || targetDelivered !== storedDelivered)) updates[`deliveredUpTo.${me}`] = targetDelivered;
        if (Object.keys(updates).length > 0) {
          void updateDoc(doc(db, 'chats', convId), updates).catch(() => { /* offline: local stamp already cleared the badge */ });
        }
      }
    } catch { /* watermark is best-effort; the local stamp is the badge */ }
    previewMemoRef.current.delete(convId);
    previewCacheRef.current.delete(convId);
    setTick((t) => t + 1);
  };

  // Save one setting of a chat for the current user
  const savePref = async (chatId: string, patch: Record<string, any>) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const next = { ...(chatPrefs[chatId] || {}), ...patch };
    setChatPrefs(prev => ({ ...prev, [chatId]: next }));
    try {
      await updateDoc(doc(db, 'users', uid), { [`chatPrefs.${chatId}`]: next });
    } catch {
      // Offline / hybrid local mode: keep it locally instead of losing it.
      // It merges back under the server value on the next snapshot (Step 3).
      saveLocalChatPrefs(uid, { ...chatPrefs, [chatId]: next });
    }
  };

  // ── WA parity top-10 #3 (multi-select) ──────────────────────────────
  // Selection is keyed by pref key (partner uid / cleanId(groupId)).
  const setSelected = (next: Set<string>) => {
    selectedIdsRef.current = next;
    setSelectedIds(next);
  };
  const exitSelection = () => {
    setSelected(new Set<string>());
    setSelectionMode(false);
  };
  const enterSelection = (key: string) => {
    setSelected(new Set<string>([key]));
    setSelectionMode(true);
  };
  const toggleSelect = (key: string) => {
    const next = new Set<string>(selectedIdsRef.current);
    if (next.has(key)) next.delete(key); else next.add(key);
    if (next.size === 0) { setSelected(next); setSelectionMode(false); }
    else setSelected(next);
  };
  // Batch actions — every one reuses the single-chat savePref writes, so
  // batch Archive / Mute / Delete / Pin / Mark read / Favourites behave
  // exactly like their long-press equivalents.
  const batchApply = (patch: Record<string, any> | ((key: string) => Record<string, any>)) => {
    for (const key of selectedIdsRef.current) {
      const p = typeof patch === 'function' ? patch(key) : patch;
      if (p) void savePref(key, p);
    }
  };
  const batchPin = () => {
    const pinnedCount = Object.values(chatPrefs).filter((pr: any) => pr?.pinned).length;
    let room = 3 - pinnedCount; // WhatsApp caps pins at 3 (G3).
    let pinned = 0;
    let skipped = 0;
    for (const key of selectedIdsRef.current) {
      if (chatPrefs[key]?.pinned) { void savePref(key, { pinned: false }); continue; }
      if (room > 0) { void savePref(key, { pinned: true }); room -= 1; pinned += 1; }
      else skipped += 1;
    }
    if (skipped > 0) showToastMsg(`Pinned ${pinned} chat${pinned === 1 ? '' : 's'} — you can pin up to 3 chats.`);
    else if (pinned > 0) showToastMsg(`Pinned ${pinned} chat${pinned === 1 ? '' : 's'}.`);
    exitSelection();
  };
  const batchMuteAlways = () => {
    batchApply(mutePrefForDuration(null));
    showToastMsg(`Muted ${selectedIdsRef.current.size} chat${selectedIdsRef.current.size === 1 ? '' : 's'}.`);
    exitSelection();
  };
  const batchMarkRead = () => {
    // WA parity (row 38): batch Mark read clears real unread too, not
    // just the manual flag — same helper as the single-chat menu item.
    for (const key of selectedIdsRef.current) {
      void savePref(key, { markedUnread: false });
      const chat = allChats.find((c: any) => prefKeyForChat(c) === key);
      if (chat) markChatReadFromList(chat);
    }
    exitSelection();
  };
  const batchFavourite = () => {
    const allFav = [...selectedIdsRef.current].every((key) => chatPrefs[key]?.favorite);
    batchApply({ favorite: !allFav });
    showToastMsg(allFav ? 'Removed from favourites.' : 'Added to favourites.');
    exitSelection();
  };

  // ── WA parity top-10 #2 (Block from the long-press menu) ─────────────
  // Same `blockedUsers` field + arrayUnion/arrayRemove write as
  // ChatScreen.toggleBlockUser. Groups cannot be blocked (same rule).
  const toggleBlockChat = async (chat: any) => {
    if (chat.isGroup) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const partnerId = chat.id;
    const isBlocked = blockedIds.includes(partnerId);
    setBlockedIds((prev) => (isBlocked ? prev.filter((id) => id !== partnerId) : [...prev, partnerId]));
    try {
      await updateDoc(doc(db, 'users', uid), {
        blockedUsers: isBlocked ? arrayRemove(partnerId) : arrayUnion(partnerId),
      });
      showToastMsg(isBlocked ? `Unblocked ${getContactName(chat)}.` : `Blocked ${getContactName(chat)}.`);
    } catch (e) {
      setBlockedIds((prev) => (isBlocked ? [...prev, partnerId] : prev.filter((id) => id !== partnerId)));
      console.warn('[ChatListScreen] block/unblock failed:', e);
      showToastMsg('Could not update block. Try again.');
    }
  };

  // ── WA parity top-10 #7 (Clear chat from the list) ───────────────────
  // Same setClearedAt write as ChatScreen.doClearChat — hides messages
  // sent before now for me only.
  const doClearChatFromList = async (chat: any) => {
    const uid = auth.currentUser?.uid;
    const convId = convIdForChat(chat);
    if (!uid || !convId) return;
    setPendingClearChat(null);
    try {
      await setClearedAt(uid, convId, Date.now());
      showToastMsg('Chat cleared');
    } catch (e) {
      console.warn('[ChatListScreen] clear chat failed:', e);
      showToastMsg('Could not clear chat. Try again.');
    }
  };

  // ── WA parity verify chatlist-5, row 40 (Delete chat) ───────────────
  // WA's Delete chat removes the message history for me: a chat that
  // comes back on a new message starts fresh. DT's deletedAt only hid
  // the row, so the FULL pre-delete history resurrected with it. Stamp
  // clearedAt (the same per-user write Clear chat uses — ChatScreen
  // filters timestamp <= clearedAt out of the rendered list) and drop
  // the unsent draft, so delete behaves like WA's. Best-effort: a
  // failed clear only warns; the deletedAt hide below is never blocked.
  const clearHistoryForDelete = (chat: any) => {
    const uid = auth.currentUser?.uid;
    const convId = convIdForChat(chat);
    if (!uid || !convId) return;
    void setClearedAt(uid, convId, Date.now()).catch((e) => {
      console.warn('[ChatListScreen] delete chat clear failed:', e);
    });
    try { localStorage.removeItem(`dt_draft_${convId}`); } catch { /* ignore */ }
  };

  const doDeleteChat = (chat: any) => {
    clearHistoryForDelete(chat);
    setPendingDeleteChat(null);
    savePref(prefKeyForChat(chat), { deletedAt: Date.now() });
  };

  const doDeleteChats = (keys: string[]) => {
    for (const key of keys) {
      const chat = allChats.find((c) => prefKeyForChat(c) === key);
      if (chat) clearHistoryForDelete(chat);
      void savePref(key, { deletedAt: Date.now() });
    }
    setPendingBatchDelete(null);
    exitSelection();
  };

  // ── Feature 5: folders ──
  const saveFolders = async (next: ChatFolder[]) => {
    const uid = auth.currentUser?.uid;
    setChatFolders(next);
    if (!uid) return;
    try {
      await updateDoc(doc(db, 'users', uid), { chatFolders: next });
    } catch {
      saveLocalFolders(uid, next); // offline: local copy is the source of truth
    }
  };

  const createFolder = (name: string, color: string) => {
    const result = sanitizeFolderName(name, chatFolders);
    if ('error' in result) return;
    saveFolders([...chatFolders, makeFolder(result.name, color)]);
  };

  const renameFolder = (folderId: string, name: string) => {
    const result = sanitizeFolderName(name, chatFolders, folderId);
    if ('error' in result) return;
    saveFolders(chatFolders.map(f => (f.id === folderId ? { ...f, name: result.name } : f)));
  };

  const deleteFolder = async (folderId: string) => {
    const uid = auth.currentUser?.uid;
    const nextFolders = chatFolders.filter(f => f.id !== folderId);
    setChatFolders(nextFolders);
    if (folderIdFromFilter(filter) === folderId) setFilter('All');
    // Clear the folder from every chat that had it, in a single user-doc write.
    const updates: Record<string, any> = { chatFolders: nextFolders };
    const nextPrefs: Record<string, any> = { ...chatPrefs };
    for (const [chatId, p] of Object.entries(chatPrefs)) {
      if ((p as any)?.folderId === folderId) {
        const cleared = { ...(p as any), folderId: null };
        nextPrefs[chatId] = cleared;
        updates[`chatPrefs.${chatId}`] = cleared;
      }
    }
    setChatPrefs(nextPrefs);
    if (!uid) return;
    try {
      await updateDoc(doc(db, 'users', uid), updates);
    } catch {
      saveLocalFolders(uid, nextFolders);
      saveLocalChatPrefs(uid, nextPrefs);
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary relative">

      {/* App Bar — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-header-green dark:bg-panel-dark shadow-sm relative flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3 relative">
          <>
            <h1 className="text-2xl font-bold text-white dark:text-primary-green tracking-tight">Pinglo</h1>
            <div className="flex items-center gap-2">
              <button
                aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                onClick={toggleTheme}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark text-white/85 dark:text-text-secondary transition-colors"
                title={isDark ? "Light Mode" : "Dark Mode"}
              >
                {isDark ? <Sun className="h-5 w-5 text-yellow-400" /> : <Moon className="h-5 w-5" />}
              </button>
              {/* WA parity top-10 #5: search lives in a persistent bar below
                  the header — this button just focuses it. */}
              <button aria-label="Search chats" onClick={() => searchInputRef.current?.focus()} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark text-white/85 dark:text-text-secondary">
                <Search className="h-5 w-5" />
              </button>
              <button aria-label="More options" aria-expanded={showMenu} onClick={() => setShowMenu(s => !s)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark text-white/85 dark:text-text-secondary">
                <MoreVertical className="h-5 w-5" />
              </button>
              <DefaultAvatar
                photoURL={myAvatar || ''}
                name={auth.currentUser?.displayName || 'You'}
                seed={auth.currentUser?.uid}
                size={32}
                className="cursor-pointer ring-2 ring-white/60 dark:ring-primary-green/40"
                alt="Me"
                onClick={() => navigate('/settings')}
              />
              {/* Phase 5: invisible 3-tap vault trigger removed (L-32). */}
            </div>

            {/* Dropdown */}
            {showMenu && (
              <div ref={menuRef} className="absolute right-4 top-14 w-52 rounded-xl bg-panel-light dark:bg-panel-dark shadow-2xl ring-1 ring-black/10 dark:ring-white/10 z-50 overflow-hidden">
                <div className="py-1">
                  {[
                    ...(isAdminUser(auth.currentUser) ? [{ label: 'Admin Dashboard', icon: <Crown className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/admin'); } }] : []),
                    { label: isDark ? 'Light Mode' : 'Dark Mode', icon: isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />, action: () => { toggleTheme(); setShowMenu(false); } },
                    { label: 'New Group', icon: <Users className="h-5 w-5" />, action: () => { setShowNewGroup(true); setShowMenu(false); } },
                    { label: 'Broadcast lists', icon: <Megaphone className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/broadcast'); } },
                    { label: 'Find by username', icon: <Search className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/search'); } },
                    { label: 'Contacts', icon: <Contact className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/contacts'); } },
                    { label: 'Starred Messages', icon: <Star className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/starred'); } },
                    { label: 'Saved Messages', icon: <BookmarkCheck className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/saved'); } },
                    { label: 'Settings', icon: <Settings className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/settings'); } },
                    { label: 'Select chats', icon: <Check className="h-5 w-5" />, action: () => { setShowMenu(false); setSelectionMode(true); } },
                  ].map(item => (
                    <button key={item.label} onClick={item.action} className="flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-input-dark">
                      {item.icon}
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        </div>
      </div>

      {/* WA parity top-10 #5: persistent search bar at the top of the list
          ("Search or start a new chat") — no extra tap before searching.
          The secret-code locked-chats reveal still runs through
          handleSearchChange, unchanged. */}
      <div className="px-4 pt-2 pb-1 flex-shrink-0 bg-bg-light dark:bg-bg-dark">
        <div className="flex items-center gap-2 bg-white dark:bg-input-dark rounded-full px-4 py-2 shadow-sm ring-1 ring-black/5 dark:ring-white/10">
          <Search className="h-4 w-4 text-gray-500 dark:text-text-secondary flex-shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={e => void handleSearchChange(e.target.value)}
            placeholder={tr('searchOrStartChat')}
            aria-label="Search chats and messages"
            className="flex-1 bg-transparent text-sm outline-none text-gray-900 dark:text-text-primary placeholder:text-gray-500 dark:placeholder:text-text-secondary min-w-0"
          />
          {searchQuery && (
            <button aria-label="Clear search" onClick={() => setSearchQuery('')} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-panel-dark flex-shrink-0">
              <X className="h-4 w-4 text-gray-500" />
            </button>
          )}
        </div>
      </div>

      {/* WA parity top-10 #3 (multi-select): batch toolbar. Replaces the
          filter chips while selection mode is on. */}
      {selectionMode && (
        <div className="flex items-center gap-1 px-2 py-2 flex-shrink-0 bg-bg-light dark:bg-bg-dark border-b border-black/10 dark:border-white/10" role="toolbar" aria-label="Selected chats actions">
          <button aria-label="Cancel selection" onClick={exitSelection} className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
            <X className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold mr-1 whitespace-nowrap" data-testid="selection-count">{selectedIds.size} selected</span>
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide flex-1">
            {[
              { label: 'Archive', icon: <Archive className="h-4 w-4" />, run: () => { batchApply({ archived: true }); exitSelection(); } },
              { label: 'Mute', icon: <BellOff className="h-4 w-4" />, run: batchMuteAlways },
              { label: 'Delete', icon: <Trash2 className="h-4 w-4" />, run: () => setPendingBatchDelete([...selectedIdsRef.current]) },
              { label: 'Pin', icon: <Pin className="h-4 w-4" />, run: batchPin },
              { label: 'Mark read', icon: <MailOpen className="h-4 w-4" />, run: batchMarkRead },
              { label: tr('favourites'), icon: <Star className="h-4 w-4" />, run: batchFavourite },
            ].map((a) => (
              <button key={a.label} onClick={a.run} className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap bg-gray-200 dark:bg-input-dark text-gray-700 dark:text-text-primary hover:bg-gray-300 dark:hover:bg-panel-dark">
                {a.icon} {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Report 3 #226/#234 (W5b): subscription lost, poll-only — a delay
          indicator, never a loss indicator. Hidden in mock mode (the
          state is never set there). */}
      {dbReconnecting && (
        <div role="status" className="flex-shrink-0 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-xs font-medium text-center px-4 py-1.5">
          Reconnecting… — new messages may be delayed
        </div>
      )}

      {/* Filter chips — WA parity top-10 #9: selected chip #D9FDD3 light /
          #103529 dark with dark-green text (WDS), and "Favourites" (en_GB).
          The internal filter value stays 'Favorites' — only the label changes. */}
      {filter === ARCHIVED_FILTER ? (
        <div className="flex items-center gap-2 px-4 py-2 flex-shrink-0 border-b border-black/10 dark:border-white/10">
          <button aria-label="Back to all chats" onClick={() => setFilter('All')} className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Archive className="h-5 w-5 text-gray-500" />
          <h2 className="text-lg font-semibold flex-1">{tr('archived')}</h2>
          <span className="text-sm text-gray-500 dark:text-text-secondary">{archivedCount} chat{archivedCount === 1 ? '' : 's'}</span>
        </div>
      ) : (
      <div className="flex gap-2 overflow-x-auto px-4 py-2 scrollbar-hide flex-shrink-0">
        {(['All', 'Unread', 'Favorites', 'Groups'] as const).map(f => {
          const label = f === 'Favorites' ? tr('favourites') : f === 'Unread' ? tr('unread') : f === 'Groups' ? tr('groups') : f === 'All' ? tr('all') : f;
          return (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
              filter === f ? 'bg-[#D9FDD3] dark:bg-[#103529] text-[#15603E] dark:text-[#D9FDD3] shadow-sm' : 'bg-gray-200 dark:bg-input-dark text-gray-600 dark:text-text-secondary'
            }`}
          >
            {label}
          </button>
          );
        })}
        <button
          onClick={() => setFilter(ARCHIVED_FILTER)}
          className={`rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 ${
            filter === ARCHIVED_FILTER ? 'bg-[#D9FDD3] dark:bg-[#103529] text-[#15603E] dark:text-[#D9FDD3] shadow-sm' : 'bg-gray-200 dark:bg-input-dark text-gray-600 dark:text-text-secondary'
          }`}
        >
          <Archive className="h-3.5 w-3.5" /> {tr('archived')}
          {archivedCount > 0 && (
            <span className="bg-green-cta text-white text-[11px] font-bold px-1.5 rounded-full min-w-[18px] text-center">{archivedCount}</span>
          )}
        </button>
        {chatFolders.map(folder => (
          <button
            key={folder.id}
            onClick={() => setFilter(folderFilter(folder.id))}
            className={`rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1.5 ${
              filter === folderFilter(folder.id) ? 'bg-[#D9FDD3] dark:bg-[#103529] text-[#15603E] dark:text-[#D9FDD3] shadow-sm' : 'bg-gray-200 dark:bg-input-dark text-gray-600 dark:text-text-secondary'
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: folder.color || 'var(--color-primary-green)' }} />
            {folder.name}
          </button>
        ))}
        <button
          onClick={() => setShowFolderManager(true)}
          className="rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-1 bg-gray-200 dark:bg-input-dark text-gray-600 dark:text-text-secondary"
          title="Manage folders"
        >
          <FolderPlus className="h-4 w-4" /> Folders
        </button>
      </div>
      )}

      {/* Chat list */}
      <div ref={listContainerRef} onScroll={onListScroll} data-total-rows={filteredChats.length} className="flex-1 overflow-y-auto pb-24">
        {/* WA audit #60 — ongoing-call row (ROW_CALL_ONGOING): the live
            call sits at the top of the chat list with a live duration.
            Tap returns to the call (un-minimises CallModal via
            requestRestore). The bubble still exists; this is the
            chat-list affordance it was missing. */}
        {liveCall && !searchQuery && filter === 'All' && (
          <div onClick={() => callService.requestRestore()} role="button" aria-label="Return to call" className="flex items-center px-4 py-3 cursor-pointer bg-green-cta/10 hover:bg-green-cta/15 border-b border-gray-100 dark:border-white/5">
            <div className="h-12 w-12 rounded-full bg-green-cta flex items-center justify-center text-white flex-shrink-0">
              <Phone className="h-6 w-6" />
            </div>
            <div className="ml-4 flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900 dark:text-text-primary truncate">{liveCall.remoteName || 'User'}</h3>
              <p className="text-sm text-green-cta tabular-nums">
                {liveCall.status === 'connected'
                  ? `${liveCall.type === 'video' ? 'Video call' : 'Voice call'} • ${fmtLiveCallDuration(liveCall.duration)}`
                  : liveCall.status === 'outgoing' ? 'Ringing…' : 'Connecting…'}
              </p>
            </div>
            <span className="text-xs font-semibold text-green-cta flex-shrink-0">Return to call</span>
          </div>
        )}
        {/* Saved Messages quick entry — Telegram-style pinned row: always
            FIRST, above the loading skeleton, so it never sits below the
            list while chats load. Hidden during search / non-All filters
            (existing behaviour). */}
        {!searchQuery && filter === 'All' && (
          <div ref={pinnedRowRef} onClick={() => navigate('/saved')} className="flex items-center px-4 py-3 cursor-pointer hover:bg-gray-100 dark:hover:bg-panel-dark/50 border-b border-gray-100 dark:border-white/5">
            <div className="h-12 w-12 rounded-full bg-gradient-to-br from-primary-green to-[#128C7E] flex items-center justify-center text-white flex-shrink-0">
              <BookmarkCheck className="h-6 w-6" />
            </div>
            <div className="ml-4 flex-1 min-w-0">
              <h3 className="font-semibold text-gray-900 dark:text-text-primary">Saved Messages</h3>
              <p className="text-sm text-gray-500 dark:text-text-secondary">Your personal cloud space</p>
            </div>
          </div>
        )}

        {/* Phase 3: loading skeleton while the first snapshot arrives.
            RC3: rows are gated on hiddenLoaded (see below), so the skeleton
            must also show while the locked list is unknown even when chats
            have already arrived — otherwise the list area sits blank. */}
        {((isLoadingChats && chats.length === 0) || !hiddenLoaded) && <ListSkeleton rows={6} />}


        {/* Divider */}
        {!searchQuery && <div className="h-px bg-gray-200 dark:bg-white/5 mx-4" />}

        {/* Search empty state */}
        {searchQuery && filteredChats.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-500 dark:text-text-secondary">
            <Search className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium">Nothing found</p>
            <p className="text-sm">No contact or message matches "{searchQuery}"</p>
            <button
              onClick={() => navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`)}
              className="mt-1 px-4 py-2 bg-green-cta text-white rounded-xl text-sm font-medium hover:bg-dark-green transition-colors"
            >
              Search by username instead
            </button>
          </div>
        )}

        {/* Archived / folder empty states */}
        {/* Archived / folder empty states — only once loading is done,
            so they never stack under the skeleton. */}
        {!searchQuery && !isLoadingChats && hiddenLoaded && filteredChats.length === 0 && filter === ARCHIVED_FILTER && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-500 dark:text-text-secondary px-6 text-center">
            <Archive className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium">No archived chats</p>
            <p className="text-sm">Long-press a chat, then tap “Archive” to hide it here.</p>
          </div>
        )}
        {!searchQuery && !isLoadingChats && hiddenLoaded && filteredChats.length === 0 && folderIdFromFilter(filter) && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-500 dark:text-text-secondary px-6 text-center">
            <Folder className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium">No chats in this folder yet</p>
            <p className="text-sm">Long-press a chat → “Move to folder” to add it here.</p>
          </div>
        )}

        {/* General empty state (new users / Unread / Favorites / Groups).
            Gated on loading being done: previously it rendered underneath
            the forever-skeleton, so "No chats yet" never appeared. */}
        {!searchQuery && !isLoadingChats && hiddenLoaded && filteredChats.length === 0 && !folderIdFromFilter(filter) && filter !== ARCHIVED_FILTER && (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-500 dark:text-text-secondary px-6 text-center">
            <MessageSquare className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium">{filter === 'All' ? tr('noChatsYet') : tr('noFilteredChats')}</p>
            <p className="text-sm">{filter === 'All' ? tr('startChattingHint') : tr('chatsWillShowHint')}</p>
          </div>
        )}

        {/* User chats — real-time from Firestore.
            RC3: rows render ONLY once hiddenLoaded — the filter above keys
            off hiddenChatIds, which starts empty on a fresh device, so
            rendering before the load would flash locked chats. */}
        {/* W13 (#145): windowed list — spacers stand in for the rows
            above/below the rendered window so the scrollbar stays true. */}
        {hiddenLoaded && winStart > 0 && <div style={{ height: winStart * rowH }} aria-hidden="true" />}
        {hiddenLoaded && visibleChats.map(chat => {
          const preview = getChatPreview(chat);
          const contactName = getContactName(chat);
          // Phase 3: when the search hit is in message text, show that snippet.
          const searchSnippet = searchQueryDebounced.trim()
            ? searchSnippets.get(chat.id) ?? null
            : null;
          const folder = folderById(chatFolders, chatPrefs[prefKeyForChat(chat)]?.folderId);
          // C3: the observer activates this row's collection when it
          // scrolls into view (data-conv-id carries the collection id).
          // #152: groups use cleanId(groupId) (convIdForChat), not the DM id.
          const rowConvId = convIdForChat(chat) || '';
          // FIX 3a: render-time label from the raw timestamp, so a
          // preview cached today reads "Yesterday" tomorrow.
          const timeLabel = preview.timeTs ? formatChatListTime(preview.timeTs) : preview.time;
          // FIX 3c: a typing peer replaces the preview with green
          // "typing…" (WhatsApp behaviour); the tick is hidden with it.
          const isTyping = !!typingByChat[rowConvId];
          return (
            <div
              key={chat.id}
              data-conv-id={rowConvId}
              ref={(el) => {
                if (el) { rowElsRef.current.set(chat.id, el); ioRef.current?.observe(el); }
                else { const prev = rowElsRef.current.get(chat.id); if (prev) ioRef.current?.unobserve(prev); rowElsRef.current.delete(chat.id); }
              }}
              onClick={() => {
                if (longPressFired.current) { longPressFired.current = false; return; }
                // Multi-select: a tap toggles the row instead of opening it.
                if (selectionMode) { toggleSelect(prefKeyForChat(chat)); return; }
                // G5: opening a chat clears a manually-set "mark as unread"
                // dot — WhatsApp clears it the moment you open the chat.
                // savePref is optimistic (local state first, then the
                // server write), so the dot is gone before the round-trip.
                if (chatPrefs[prefKeyForChat(chat)]?.markedUnread) {
                  savePref(prefKeyForChat(chat), { markedUnread: false });
                }
                // #152: a group row opens the group chat (?type=community),
                // not a DM to the group id.
                navigate(chat.isGroup ? `/chat/${chat.id}?type=community` : `/chat/${chat.id}`);
              }}
              onPointerDown={(e) => {
                longPressFired.current = false;
                clearTimeout(pressTimer.current);
                // WA #44: on a touch phone a 500 ms hold opens the anchored
                // popup menu for this row — the right-click path below is
                // desktop-only, so without this the popup was unreachable
                // on touch (E1 gap: the timer only entered selection mode
                // and never set the anchor). Multi-select stays reachable:
                // a hold while already in selection mode toggles the row,
                // the popup has a "Select chats" entry, and the header
                // ⋮ menu has "Select chats" too (same split as ChatScreen:
                // touch hold → reaction picker, desktop right-click → menu).
                const rowEl = e.currentTarget as HTMLElement;
                const isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
                pressTimer.current = setTimeout(() => {
                  longPressFired.current = true;
                  if (selectionMode) { toggleSelect(prefKeyForChat(chat)); return; }
                  if (isTouch) {
                    touchLongPressAtRef.current = Date.now();
                    try { navigator.vibrate?.(10); } catch { /* ignore */ }
                    const r = rowEl.getBoundingClientRect();
                    setMenuAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
                    setMenuChat(chat);
                    return;
                  }
                  enterSelection(prefKeyForChat(chat));
                }, 500);
              }}
              onPointerUp={() => clearTimeout(pressTimer.current)}
              onPointerLeave={() => clearTimeout(pressTimer.current)}
              onPointerCancel={() => clearTimeout(pressTimer.current)}
              onContextMenu={(e) => {
                e.preventDefault();
                // WA #44 (E1 gap, ChatScreen R2 pattern): a WebView
                // `contextmenu` fires right after a touch long-press — it
                // must not re-run the right-click path on top of the popup
                // the hold just opened (or toggle-select a row the hold
                // already put in selection mode).
                if (Date.now() - touchLongPressAtRef.current < 1000) return;
                if (selectionMode) toggleSelect(prefKeyForChat(chat)); else { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenuAnchor({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }); setMenuChat(chat); }
              }}
              className="flex items-center px-4 py-3 cursor-pointer hover:bg-[rgba(194,189,184,0.15)] dark:hover:bg-panel-dark/50 active:bg-gray-200 dark:active:bg-input-dark transition-colors select-none"
            >
              {/* Multi-select checkmark (WA parity top-10 #3). */}
              {selectionMode && (
                <button
                  aria-label={selectedIds.has(prefKeyForChat(chat)) ? `Deselect ${contactName}` : `Select ${contactName}`}
                  onClick={(e) => { e.stopPropagation(); toggleSelect(prefKeyForChat(chat)); }}
                  className={`h-6 w-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 mr-3 ${
                    selectedIds.has(prefKeyForChat(chat)) ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400 dark:border-text-secondary bg-transparent'
                  }`}
                >
                  {selectedIds.has(prefKeyForChat(chat)) && <Check className="h-4 w-4" />}
                </button>
              )}
              {/* #154: a group row shows its photo, else its chosen emoji —
                  never grey initials for a group that has an identity. */}
              {chat.isGroup && !chat.photoURL ? (
                <div className="h-[49px] w-[49px] rounded-full bg-header-green/10 dark:bg-sent-bubble/25 flex items-center justify-center text-2xl flex-shrink-0" aria-hidden="true">
                  {chat.emoji || '👥'}
                </div>
              ) : !chat.isGroup && statusRingByUid[chat.id] ? (
                // WA audit (d) S8 — ring around the DM avatar of a contact
                // with status updates (green unviewed, grey seen, purple
                // Close Friends). Face stays 49px like unringed rows (the
                // list already uses WA's 49px); the 57px ring sits outside.
                <StatusRing size={57} viewed={statusRingByUid[chat.id].viewed} closeFriends={statusRingByUid[chat.id].closeFriends}>
                  <DefaultAvatar
                    photoURL={chat.photoURL}
                    name={contactName}
                    seed={chat.id}
                    size={49}
                  />
                </StatusRing>
              ) : (
                <DefaultAvatar
                  photoURL={chat.photoURL}
                  name={contactName}
                  seed={chat.id}
                  size={49}
                />
              )}
              <div className="ml-3 flex-1 border-b border-black/10 dark:border-white/10 pb-3 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold text-[17px] text-gray-900 dark:text-text-primary truncate flex items-center gap-1 min-w-0">
                    <span className="truncate">{contactName}</span>
                    {chat.isGroup && <Users className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />}
                    {chatPrefs[prefKeyForChat(chat)]?.pinned && <Pin className="h-3 w-3 text-gray-500 flex-shrink-0" />}
                    {isMutedPref(chatPrefs[prefKeyForChat(chat)]) && <BellOff className="h-3 w-3 text-gray-500 flex-shrink-0" />}
                    {chatPrefs[prefKeyForChat(chat)]?.favorite && <Star className="h-3 w-3 text-gray-500 flex-shrink-0" />}
                    {chatPrefs[prefKeyForChat(chat)]?.archived && <Archive className="h-3 w-3 text-gray-500 flex-shrink-0" />}
                    {/* WA parity top-10 #6: search hits in archived chats
                        carry an "Archived" marker. */}
                    {searchQueryDebounced.trim() && chatPrefs[prefKeyForChat(chat)]?.archived && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-input-dark text-gray-500 dark:text-text-secondary flex-shrink-0">{tr('archived')}</span>
                    )}
                    {folder && filter !== folderFilter(folder.id) && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-input-dark text-gray-500 dark:text-text-secondary flex-shrink-0 max-w-[90px] truncate">
                        {folder.name}
                      </span>
                    )}
                  </h3>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* WA #16: no presence in the list — the time slot
                        shows the message time only, never "Online". */}
                    {timeLabel ? (
                      <span className={`text-[11px] ${preview.unread > 0 ? 'text-primary-green font-semibold' : 'text-gray-500 dark:text-text-secondary'}`}>
                        {timeLabel}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <p className={`text-[13px] truncate flex-1 ${preview.unread > 0 ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-500 dark:text-text-secondary'}`}>
                    {preview.isMine && !isTyping && !searchSnippet && !preview.isDraft && preview.lastStatus && (
                      <span className="mr-1 inline-flex shrink-0"><MessageTicks status={!readReceipts && !chat.isGroup && preview.lastStatus === 'seen' ? 'delivered' : preview.lastStatus} /></span>
                    )}
                    {isTyping ? <span className="text-[#008069] dark:text-primary-green font-medium">typing…</span> : searchSnippet ? <span className="text-primary-green">{searchSnippet}</span> : preview.isDraft ? <span className="text-primary-green font-medium">Draft: {preview.draftText}</span> : preview.text}
                  </p>
                  {preview.unread > 0 ? (
                    <span className="bg-green-cta text-white text-[11px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center flex-shrink-0">
                      {preview.unread}
                    </span>
                  ) : chatPrefs[prefKeyForChat(chat)]?.markedUnread ? (
                    <span className="bg-primary-green h-3 w-3 rounded-full flex-shrink-0" role="img" aria-label="Marked as unread" />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
        {hiddenLoaded && winEnd < filteredChats.length && <div style={{ height: (filteredChats.length - winEnd) * rowH }} aria-hidden="true" />}
      </div>

      {/* Chat actions (long-press or right-click on a chat) */}
      {menuChat && (() => {
        // #192: the long-press menu (incl. Mute) works for group rows too —
        // prefs are read/written under the conversation id for groups.
        const p = chatPrefs[prefKeyForChat(menuChat)] || {};
        const menuKey = prefKeyForChat(menuChat);
        const close = () => { setMenuChat(null); setMenuAnchor(null); setMutePickerFor(null); };
        // WA #44: small popup menu anchored to the pressed row (phone WA
        // pattern), not a full-width bottom sheet. Prefers below the row;
        // opens above it when there is not enough room below; always
        // clamped inside the viewport, scrollable when the action list
        // (mute picker / folders) is taller than the space. Dimmer is
        // WA's rgb(0,0,0,.32), not bg-black/50.
        const MENU_W = 280;
        const vw = typeof window !== 'undefined' ? window.innerWidth : 390;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 844;
        const menuLeft = menuAnchor
          ? Math.max(8, Math.min(menuAnchor.left + 8, vw - MENU_W - 8))
          : 16;
        // (menuTop is computed below, after `actions` — it needs the real
        // item count; a fixed height guess cut the menu off past the
        // viewport edge.)
        const mutedNow = isMutedPref(p);
        // WA parity (row 38): "Mark as read" is offered whenever the
        // chat actually has unread — real count badge OR manual dot —
        // not only when the manual flag is set.
        const menuHasUnread = (getChatPreview(menuChat)?.unread || 0) > 0 || Boolean(p.markedUnread);
        const actions = [
          // WA #44: touch long-press now opens this popup instead of
          // entering selection mode, so the popup itself must offer the
          // way in (same as ChatScreen's context menu "Select" entry).
          {
            label: 'Select chats', icon: <Check className="h-5 w-5" />,
            run: () => { enterSelection(prefKeyForChat(menuChat)); },
          },
          {
            label: p.pinned ? 'Unpin chat' : 'Pin chat', icon: <Pin className="h-5 w-5" />,
            run: () => {
              if (!p.pinned) {
                // G3: WhatsApp caps pins at 3 — refuse a 4th pin with a toast.
                const pinnedCount = Object.values(chatPrefs).filter((pr: any) => pr?.pinned).length;
                if (pinnedCount >= 3) {
                  showToastMsg('You can pin up to 3 chats. Unpin one to pin another.');
                  return;
                }
              }
              savePref(prefKeyForChat(menuChat), { pinned: !p.pinned });
            },
          },
          // WA parity top-10 #1: Mute opens a duration picker (8 hours /
          // 1 week / Always) instead of a bare boolean toggle; a live mute
          // shows its remaining duration and offers Unmute.
          {
            label: mutedNow ? 'Unmute' : 'Mute notifications', icon: <BellOff className="h-5 w-5" />,
            sub: mutedNow ? muteUntilLabel(p) ?? undefined : undefined,
            run: () => { if (mutedNow) savePref(menuKey, unmutePref()); else setMutePickerFor(menuKey); },
            keepOpen: !mutedNow,
          },
          // UI-army #6: the Favourites filter used to read `c.favorite`,
          // which nothing ever set — the chip could never match. The
          // flag lives in chatPrefs like pin/mute, set from here.
          { label: p.favorite ? 'Remove from favourites' : 'Add to favourites', icon: <Star className="h-5 w-5" />, run: () => savePref(prefKeyForChat(menuChat), { favorite: !p.favorite }) },
          // WA parity (row 38): Mark as read clears the REAL unread badge
          // (local stamp + seen/delivered watermark), not just the manual
          // flag; Mark as unread sets the manual dot.
          { label: menuHasUnread ? 'Mark as read' : 'Mark as unread', icon: <MailOpen className="h-5 w-5" />, run: () => {
            if (menuHasUnread) { void savePref(prefKeyForChat(menuChat), { markedUnread: false }); markChatReadFromList(menuChat); }
            else void savePref(prefKeyForChat(menuChat), { markedUnread: true });
          } },
          {
            label: p.archived ? 'Unarchive chat' : 'Archive chat',
            icon: p.archived ? <ArchiveRestore className="h-5 w-5" /> : <Archive className="h-5 w-5" />,
            run: () => savePref(prefKeyForChat(menuChat), { archived: !p.archived }),
          },
          // WA parity top-10 #7: View contact / group info + Clear chat,
          // both already exist inside the chat — exposed here so the user
          // never has to open the chat to reach them. The info action
          // opens the chat with ?info=1, which ChatScreen turns into its
          // profile / group-info modal.
          {
            label: menuChat.isGroup ? 'View group info' : 'View contact', icon: <Info className="h-5 w-5" />,
            run: () => navigate(menuChat.isGroup ? `/chat/${menuChat.id}?type=community&info=1` : `/chat/${menuChat.id}?info=1`),
          },
          {
            label: 'Clear chat', icon: <Eraser className="h-5 w-5" />,
            run: () => { setPendingClearChat(menuChat); },
          },
          // WA parity top-10 #2: Block from the list menu (DMs only —
          // groups cannot be blocked, same rule as ChatScreen).
          ...(!menuChat.isGroup ? [{
            label: blockedIds.includes(menuChat.id) ? 'Unblock' : 'Block', icon: <Ban className="h-5 w-5" />, danger: true,
            run: () => { void toggleBlockChat(menuChat); },
          }] : []),
          {
            label: 'Delete chat', icon: <Trash2 className="h-5 w-5" />, danger: true,
            run: () => { setPendingDeleteChat(menuChat); },
          },
        ];
        // WA #44: vertical placement uses the REAL content height, not a
        // fixed 320px guess — 11 actions already measure ~590px (the
        // 70vh cap), so the old guess left the menu bottom cut off past
        // the viewport edge (headless probe: bottom 1080 on an 844
        // viewport). Prefer below the row; open above it when it does
        // not fit below; clamp so the whole (scrollable) menu stays
        // inside the viewport.
        const estH = Math.min(
          vh * 0.7,
          53 + actions.length * 48 + (chatFolders.length === 0 ? 100 : 76 + chatFolders.length * 40),
        );
        let menuTop = menuAnchor ? menuAnchor.bottom + 6 : 120;
        if (menuAnchor && menuTop + estH > vh) menuTop = Math.max(8, menuAnchor.top - estH - 6);
        menuTop = Math.max(8, Math.min(menuTop, vh - estH - 8));
        return (
          <div className="fixed inset-0 z-50" style={{ backgroundColor: 'rgba(0,0,0,0.32)' }} onClick={() => {
            // WA #44: the compatibility mouse click the browser fires on
            // finger lift after a touch long-press lands on this dimmer
            // (the press point sits above the menu) and would instantly
            // close the popup the hold just opened — ignore clicks in
            // the first second after a touch long-press (same 1 s window
            // as the contextmenu guard above).
            if (Date.now() - touchLongPressAtRef.current < 1000) return;
            close();
          }}>
            <div
              role="menu"
              aria-label={`Actions for ${getContactName(menuChat)}`}
              className="absolute w-[280px] max-w-[calc(100vw-16px)] max-h-[70vh] overflow-y-auto bg-panel-light dark:bg-panel-dark rounded-lg shadow-xl p-2"
              style={{ top: menuTop, left: menuLeft }}
              onClick={e => e.stopPropagation()}
              onClickCapture={(e) => {
                // WA #44: same ghost-click guard as the dimmer — after a
                // touch long-press the menu can flip ABOVE the row, so the
                // lift click lands on a menu item instead of the dimmer
                // and would fire it (e.g. Block). Swallow every click in
                // the first second after the hold.
                if (Date.now() - touchLongPressAtRef.current < 1000) e.stopPropagation();
              }}
            >
              <p className="px-3 py-2 text-sm font-semibold truncate text-gray-900 dark:text-text-primary">{getContactName(menuChat)}</p>
              {mutePickerFor === menuKey ? (
                <div role="dialog" aria-label="Mute duration">
                  <p className="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-text-secondary">Mute notifications for…</p>
                  {MUTE_DURATIONS.map((d) => (
                    <button
                      key={d.label}
                      onClick={() => {
                        savePref(menuKey, mutePrefForDuration(d.ms));
                        showToastMsg(d.ms == null ? `Muted ${getContactName(menuChat)} (Always).` : `Muted ${getContactName(menuChat)} for ${d.label.toLowerCase()}.`);
                        close();
                      }}
                      className="flex items-center gap-3 w-full px-3 py-3 rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left text-gray-900 dark:text-text-primary"
                    >
                      <BellOff className="h-5 w-5" /> {d.label}
                    </button>
                  ))}
                  <button
                    onClick={() => setMutePickerFor(null)}
                    className="flex items-center gap-3 w-full px-3 py-3 rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left text-primary-green font-medium"
                  >
                    <X className="h-5 w-5" /> Cancel
                  </button>
                </div>
              ) : (
              <>
              {actions.map(item => (
                <button
                  key={item.label}
                  onClick={() => { if ((item as any).keepOpen) { item.run(); return; } close(); item.run(); }}
                  className={`flex items-center gap-3 w-full px-3 py-3 rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left ${(item as any).danger ? 'text-red-500' : 'text-gray-900 dark:text-text-primary'}`}
                >
                  {item.icon}
                  <span className="flex-1">{item.label}{(item as any).sub ? <span className="block text-xs text-gray-500 dark:text-text-secondary">{(item as any).sub}</span> : null}</span>
                </button>
              ))}
              </>)}
              {mutePickerFor !== menuKey && (
              <div className="border-t border-gray-100 dark:border-white/10 mt-1 pt-2">
                <p className="px-3 py-1 text-xs font-semibold text-gray-500 dark:text-text-secondary">Move to folder</p>
                {chatFolders.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-gray-500 dark:text-text-secondary">No folders yet — tap “Manage folders…” below to create one.</p>
                ) : (
                  chatFolders.map(folder => {
                    const active = chatPrefs[prefKeyForChat(menuChat)]?.folderId === folder.id;
                    return (
                      <button
                        key={folder.id}
                        onClick={() => { close(); savePref(prefKeyForChat(menuChat), { folderId: folder.id }); }}
                        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left text-gray-900 dark:text-text-primary"
                      >
                        <span className="h-3 w-3 rounded-full flex-shrink-0" style={{ backgroundColor: folder.color || 'var(--color-primary-green)' }} />
                        <span className="flex-1 truncate">{folder.name}</span>
                        {active && <span className="text-primary-green text-xs font-semibold">✓ Current</span>}
                      </button>
                    );
                  })
                )}
                {chatPrefs[prefKeyForChat(menuChat)]?.folderId && (
                  <button
                    onClick={() => { close(); savePref(prefKeyForChat(menuChat), { folderId: null }); }}
                    className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left text-gray-900 dark:text-text-primary"
                  >
                    <Folder className="h-5 w-5" /> Remove from folder
                  </button>
                )}
                <button
                  onClick={() => { close(); setShowFolderManager(true); }}
                  className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left text-primary-green font-medium"
                >
                  <FolderPlus className="h-5 w-5" /> Manage folders…
                </button>
              </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Phase 3: delete-chat confirm modal (replaces window.confirm) */}
      {pendingDeleteChat && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end justify-center" onClick={() => setPendingDeleteChat(null)}>
          <div className="w-full max-w-md bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm delete chat">
            <h3 className="font-bold text-base">Delete chat with {getContactName(pendingDeleteChat)}?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Its message history will be cleared for you and it will be removed from your list. It comes back when a new message arrives.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setPendingDeleteChat(null)} className="flex-1 py-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-medium hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={() => doDeleteChat(pendingDeleteChat)} className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* WA parity top-10 #7: clear-chat confirm (list menu → same
          setClearedAt write as inside the chat). */}
      {pendingClearChat && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end justify-center" onClick={() => setPendingClearChat(null)}>
          <div className="w-full max-w-md bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm clear chat">
            <h3 className="font-bold text-base">Clear chat with {getContactName(pendingClearChat)}?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">All messages in this chat will be cleared for you. New messages will still arrive.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setPendingClearChat(null)} className="flex-1 py-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-medium hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={() => void doClearChatFromList(pendingClearChat)} className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors">Clear chat</button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-select batch delete confirm. */}
      {pendingBatchDelete && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end justify-center" onClick={() => setPendingBatchDelete(null)}>
          <div className="w-full max-w-md bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm delete selected chats">
            <h3 className="font-bold text-base">Delete {pendingBatchDelete.length} chat{pendingBatchDelete.length === 1 ? '' : 's'}?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Their message history will be cleared for you and they will be removed from your list. A chat comes back when a new message arrives.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setPendingBatchDelete(null)} className="flex-1 py-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-medium hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={() => doDeleteChats(pendingBatchDelete)} className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold hover:bg-red-600 transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* FABs */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-3">
        <button
          onClick={() => navigate('/dev')}
          className="h-12 w-12 flex items-center justify-center rounded-2xl bg-green-cta text-white shadow-lg hover:bg-dark-green active:scale-95 transition"
          title="DEV AI"
          aria-label="Dev AI"
        >
          <Sparkles className="h-6 w-6" />
        </button>
        <button
          onClick={() => navigate('/contacts')}
          className="h-14 w-14 flex items-center justify-center rounded-full bg-green-cta text-white shadow-lg hover:bg-dark-green active:scale-95 transition"
          title="New chat"
          aria-label="New chat"
        >
          <Plus className="h-6 w-6" />
        </button>
      </div>

      <FolderManagerModal
        isOpen={showFolderManager}
        onClose={() => setShowFolderManager(false)}
        folders={chatFolders}
        counts={folderCounts}
        onCreate={createFolder}
        onRename={renameFolder}
        onDelete={deleteFolder}
        onOpenFolder={(id) => setFilter(folderFilter(id))}
      />

      {/* WhatsApp / Telegram Style New Group Modal */}
      <NewGroupModal
        isOpen={showNewGroup}
        onClose={() => setShowNewGroup(false)}
        availableUsers={allUsersForPicker}
        onGroupCreated={(id) => navigate(`/chat/${id}?type=community`)}
      />

      {/* G3: pin-cap toast */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
