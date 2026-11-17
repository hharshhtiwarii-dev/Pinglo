import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Phone, Video, Search, MoreVertical, Link2, PhoneIncoming, PhoneOutgoing, PhoneMissed, X, Copy, Trash2, RefreshCw, Check, ShieldAlert, Clock, Star, Calendar, Share2 } from 'lucide-react';
import { collection, query, orderBy, onSnapshot, where, auth, db, doc, getDoc, updateDoc, deleteDoc } from '../../aws';
import { useNavigate } from 'react-router-dom';
import { callService } from '../../services/callService';
import { saveScheduledCallMirror } from '../../services/scheduledCallReminder';
import { navigationManager } from '../../services/navigation';
import DefaultAvatar from '../../components/DefaultAvatar';
import ListSkeleton from '../../components/ListSkeleton';
import PostCallNotificationsBanner from '../../components/PostCallNotificationsBanner';
import { loadHiddenChatIds } from '../../services/lockedChats';
import { loadGatedContactsDetailed, getAllowedContactUids, getCallPartnerUids, KNOWN_CONVS_CHANGED_EVENT } from '../../services/contacts';
import { useLanguage } from '../../services/language';
import { groupCallsByDate } from '../../services/callHistoryGroups';

/**
 * Tokenised call link (Phase 3). The link is
 *   https://dtchats.app/call/{uid}?t={token}
 * and the token lives on the user doc as `callLink: { token, expiresAt,
 * revoked }`. CallLinkScreen validates it: an expired or revoked token
 * shows "link expired". Links without `?t=` (shared before Phase 3) still
 * work when the host has never generated a token.
 */
export const CALL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CallLinkState {
  token: string;
  expiresAt: number;
  revoked: boolean;
  /** Cluster C (Item 14a): optional scheduled start + title. */
  scheduledAt?: number | null;
  title?: string;
}

function newCallLinkToken(): string {
  // AUDIT-2 D4: the Math.random() fallback is gone. Without
  // crypto.getRandomValues() this throws an honest error instead of
  // minting a guessable call-link token. Callers treat minting as
  // best-effort (the legacy uid-only link still works) or toast the
  // failure — see the useEffect above and regenerateCallLink.
  const c: any = (globalThis as any).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Secure call-link tokens need crypto.getRandomValues() — this browser/WebView is too old to create a call link.');
  }
  const bytes = new Uint8Array(10);
  c.getRandomValues(bytes);
  return 'call_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

import { dedupCallHistory, callDocTs, isMissedCallFor, isSameCallDoc } from './callHistory';

export default function CallsScreen() {
  const [calls, setCalls] = useState<any[]>([]);
  // 100M-H3 — every raw `calls` doc, before the dedup above. Clear-history
  // must delete all of them: deleting only the displayed (deduped) rows
  // would leave the hidden twin doc behind and the row would reappear.
  const allCallDocsRef = useRef<any[]>([]);
  const [loadingCalls, setLoadingCalls] = useState(true);
  const [searchQ, setSearchQ] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showCallLink, setShowCallLink] = useState(false);
  const [callLinkCopied, setCallLinkCopied] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState('');
  const [callLink, setCallLink] = useState<CallLinkState | null>(null);
  // Cluster C (Item 14a): schedule editor state (synced from callLink below).
  const [schedTitle, setSchedTitle] = useState('');
  const [schedDateTime, setSchedDateTime] = useState('');
  const [schedBusy, setSchedBusy] = useState(false);
  const { t } = useLanguage();
  const [linkBusy, setLinkBusy] = useState(false);
  // New-call contact picker
  const [showNewCall, setShowNewCall] = useState(false);
  const [contacts, setContacts] = useState<any[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactQ, setContactQ] = useState('');
  // Phase 4 — call-history filter tabs.
  const [historyFilter, setHistoryFilter] = useState<'all' | 'missed'>('all');
  // Wave-2 B3, WA audit Calls #74 — post-call notifications upsell:
  // the newest history doc's end time. Caller-side docs carry
  // `endedAt` (written by endCall); callee-side records carry no
  // `endedAt`, but their timestamp is written at the end of the call,
  // so it is the same moment. The banner applies the recency window.
  const recentCallEndedAt = useMemo(() => {
    let latest = 0;
    for (const c of calls) {
      const ended = Number((c as any).endedAt) || callDocTs(c);
      if (ended > latest) latest = ended;
    }
    return latest || null;
  }, [calls]);

  // Side-by-side (Item 3a): Favourites. There is no existing favourites
  // store — ChatListScreen's Favorites filter reads `c.favorite` on the
  // contact doc, but nothing in the app ever writes it. So favourites
  // live here as a uid list on my user doc (`callFavorites`), with a
  // localStorage copy as the offline / mock-mode fallback.
  const [favUids, setFavUids] = useState<string[]>([]);
  const currentUser = auth.currentUser;
  const navigate = useNavigate();
  // Phase 5 (L-19): locked partners are hidden from call history, search
  // and the new-call picker.
  const [lockedIds, setLockedIds] = useState<string[]>([]);
  useEffect(() => {
    if (!currentUser) return;
    void loadHiddenChatIds(currentUser.uid).then(setLockedIds);
  }, [currentUser]);
  const isLockedOther = (c: any) => {
    const other = c.callerId === currentUser?.uid ? c.receiverId : c.callerId;
    return lockedIds.includes(other);
  };

  // Side-by-side (Item 3a): load stored favourites + contacts on mount.
  // Contacts are loaded eagerly (not only when the new-call picker opens)
  // so the Favourites row can show names/avatars.
  useEffect(() => {
    if (!currentUser) return;
    try {
      const local = JSON.parse(localStorage.getItem(`pinglo_call_favorites_${currentUser.uid}`) || '[]');
      if (Array.isArray(local)) setFavUids(local.filter((u: any) => typeof u === 'string'));
    } catch (err) {
      /* no stored favourites yet */
      console.warn("[CallsScreen] CallsScreen: const local = JSON.parse(localStorage.getItem(`dtc...", err);
    }
    void getDoc(doc(db, 'users', currentUser.uid))
      .then((snap) => {
        if (!snap.exists()) return;
        const stored = (snap.data() as any).callFavorites;
        if (Array.isArray(stored)) {
          setFavUids((prev) => Array.from(new Set([...stored.filter((u: any) => typeof u === 'string'), ...prev])));
        }
      })
      .catch((err) => { /* offline / mock mode: localStorage copy stands */ console.warn("[CallsScreen] CallsScreen: getDoc(...) failed", err); });
  }, [currentUser]);

  // W28: gated contacts — saved contacts + proven DM partners + people
  // from my own call records. No whole-users subscription anymore: the
  // new-call picker and the Favourites row only ever see people I have
  // actually talked to or saved. Re-runs when call history lands (call
  // partners join the set) and when the chats collection changes (a new
  // conversation makes its partner callable) — but the profile reads only
  // re-fire when the allowed-uid SET itself changes, so an incoming
  // message does not re-fetch every profile.
  const gatedUidsKeyRef = React.useRef('');
  const gatedLoadedRef = React.useRef(false);
  // 100M-C1: a partial load (some allowed uid had no profile doc yet)
  // must not latch — the next trigger retries. Throttled so a profile
  // that never arrives doesn't re-read on every chats snapshot.
  const gatedRetryAtRef = React.useRef(0);
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const run = async (force = false) => {
      try {
        const uids = [...new Set([
          ...getAllowedContactUids(currentUser.uid),
          ...getCallPartnerUids(currentUser.uid, calls),
        ])].sort();
        const key = uids.join(',');
        if (!force && key === gatedUidsKeyRef.current && gatedLoadedRef.current) return;
        if (!force && !gatedLoadedRef.current && gatedRetryAtRef.current && Date.now() - gatedRetryAtRef.current < 15000) return;
        const { list, unresolvedUids } = await loadGatedContactsDetailed(currentUser.uid, getCallPartnerUids(currentUser.uid, calls));
        if (cancelled) return;
        if (unresolvedUids.length === 0) {
          gatedUidsKeyRef.current = key;
          gatedLoadedRef.current = true;
        } else {
          gatedLoadedRef.current = false;
          gatedRetryAtRef.current = Date.now();
        }
        setContacts(list); setContactsLoaded(true);
      } catch {
        if (!cancelled) setContactsLoaded(true);
      }
    };
    void run();
    const unsubChats = onSnapshot(collection(db, 'chats'), () => { void run(); });
    // W28 R5: re-run when background discovery memos a new conversation —
    // the memo is a localStorage write, so no chats snapshot fires for it
    // and the key guard above would otherwise keep a just-discovered
    // partner out of the picker until the next chats change or remount.
    // 100M-C1: force the re-read — the uid SET may be unchanged while a
    // profile arrived after the first (partial) load.
    const onKnownConvs = () => { void run(true); };
    window.addEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
    return () => {
      cancelled = true;
      window.removeEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
      try { unsubChats(); } catch (err) { console.warn("[CallsScreen] CallsScreen: unsubChats() failed", err); }
    };
  }, [currentUser, calls]);

  const toggleFav = async (uid: string) => {
    if (!currentUser || !uid) return;
    const adding = !favUids.includes(uid);
    const next = adding ? [...favUids, uid] : favUids.filter((u) => u !== uid);
    setFavUids(next);
    try { localStorage.setItem(`pinglo_call_favorites_${currentUser.uid}`, JSON.stringify(next)); } catch (err) { console.warn("[CallsScreen] CallsScreen: localStorage.setItem(`pinglo_call_favorites_${cur...", err); }
    try { await updateDoc(doc(db, 'users', currentUser.uid), { callFavorites: next }); } catch (err) { /* offline: local copy stands */ console.warn("[CallsScreen] CallsScreen: await updateDoc(doc(db, 'users', currentUser.uid),...", err); }
    showToastMsg(adding ? 'Added to Favourites ✓' : 'Removed from Favourites');
  };

  // Favourite contacts for the top row: the users doc first, falling back
  // to the call-history record for name/avatar when the contact doc is
  // not loaded (e.g. a deleted user).
  const favContacts = favUids
    .filter((uid) => !lockedIds.includes(uid))
    .map((uid) => {
      const c = contacts.find((x: any) => (x.uid || x.id) === uid);
      if (c) return { uid, name: c.displayName || c.username || 'User', avatar: c.photoURL || '', contact: c };
      const call = calls.find((cl: any) => cl.callerId === uid || cl.receiverId === uid);
      if (!call) return null;
      const incoming = call.receiverId === currentUser?.uid;
      return {
        uid,
        name: (incoming ? call.callerName : call.receiverName) || 'Unknown',
        avatar: (incoming ? call.callerAvatar : call.receiverAvatar) || '',
        contact: { uid, displayName: (incoming ? call.callerName : call.receiverName) || 'User', photoURL: (incoming ? call.callerAvatar : call.receiverAvatar) || '' },
      };
    })
    .filter(Boolean) as { uid: string; name: string; avatar: string; contact: any }[];

  // 100M-H12/H17 — the already-in-call toast wants 4 s (long enough to
  // read mid-call); every other caller keeps the 3 s default.
  const showToastMsg = (msg: string, ms: number = 3000) => {
    setToast(msg);
    setTimeout(() => setToast(''), ms);
  };

  const callLinkUrl = callLink
    ? `https://dtchats.app/call/${currentUser?.uid}?t=${callLink.token}`
    : `https://dtchats.app/call/${currentUser?.uid}`;

  // Load (or mint) this user's call-link token once.
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', currentUser.uid));
        const stored = snap.exists() ? (snap.data() as any).callLink : null;
        if (cancelled) return;
        const now = Date.now();
        if (stored?.token && !stored.revoked && stored.expiresAt > now) {
          setCallLink({ token: stored.token, expiresAt: stored.expiresAt, revoked: false, scheduledAt: stored.scheduledAt ?? null, title: stored.title ?? '' });
        } else if (stored?.token && !stored.revoked && stored.expiresAt <= now) {
          // Expired token: mint a fresh one so the user always has a working link.
          const fresh: CallLinkState = { token: newCallLinkToken(), expiresAt: now + CALL_LINK_TTL_MS, revoked: false, scheduledAt: stored?.scheduledAt ?? null, title: stored?.title ?? '' };
          await updateDoc(doc(db, 'users', currentUser.uid), { callLink: fresh });
          if (!cancelled) setCallLink(fresh);
        } else if (!stored?.token) {
          const fresh: CallLinkState = { token: newCallLinkToken(), expiresAt: now + CALL_LINK_TTL_MS, revoked: false, scheduledAt: stored?.scheduledAt ?? null, title: stored?.title ?? '' };
          await updateDoc(doc(db, 'users', currentUser.uid), { callLink: fresh });
          if (!cancelled) setCallLink(fresh);
        } else {
          // Revoked: keep the revoked state visible (owner can regenerate).
          setCallLink({ token: stored.token, expiresAt: stored.expiresAt || 0, revoked: true, scheduledAt: stored.scheduledAt ?? null, title: stored.title ?? '' });
        }
      } catch {
        // Token minting is best-effort: the legacy uid-only link still works.
        if (!cancelled) setCallLink(null);
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return;
    // Firestore rules only allow reading calls you are part of, so query
    // each side separately (no full-collection scan) and merge client-side.
    const byId: Record<string, Record<string, any>> = { caller: {}, receiver: {} };
    const publish = () => {
      const all = [...Object.values(byId.caller), ...Object.values(byId.receiver)];
      const unique = Array.from(new Map(all.map((c: any) => [c.id, c])).values());
      // 100M-H3 — the id-dedup above only collapses the same doc seen via
      // both queries; the caller doc + the callee doc are two different
      // docs for one call, so dedup again on call identity.
      allCallDocsRef.current = unique;
      setCalls(dedupCallHistory(unique, currentUser.uid).sort((a: any, b: any) => callDocTs(b) - callDocTs(a)));
      setLoadingCalls(false);
    };
    const listen = (field: 'callerId' | 'receiverId', key: 'caller' | 'receiver') =>
      onSnapshot(query(collection(db, 'calls'), where(field, '==', currentUser.uid)), snap => {
        byId[key] = Object.fromEntries(snap.docs.map(d => [d.id, { id: d.id, ...d.data() }]));
        publish();
      });
    const unsubA = listen('callerId', 'caller');
    const unsubB = listen('receiverId', 'receiver');
    return () => { unsubA(); unsubB(); };
  }, [currentUser]);

  useEffect(() => {
    if (showCallLink) {
      return navigationManager.pushHandler(() => {
        setShowCallLink(false);
        return true;
      });
    }
  }, [showCallLink]);

  useEffect(() => {
    if (showSearch) {
      return navigationManager.pushHandler(() => {
        setShowSearch(false);
        setSearchQ('');
        return true;
      });
    }
  }, [showSearch]);

  useEffect(() => {
    if (showNewCall) {
      return navigationManager.pushHandler(() => {
        setShowNewCall(false);
        return true;
      });
    }
  }, [showNewCall]);

  useEffect(() => {
    if (showMenu) {
      return navigationManager.pushHandler(() => {
        setShowMenu(false);
        return true;
      });
    }
  }, [showMenu]);

  // Escape closes any open sheet/menu on this screen.
  useEffect(() => {
    if (!showCallLink && !showNewCall && !showMenu && !showClearConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowCallLink(false); setShowNewCall(false); setShowMenu(false); setShowClearConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showCallLink, showNewCall, showMenu, showClearConfirm]);

  // W28: the picker-open lazy load is gone — contacts are loaded gated on
  // mount (see the effect above) and refresh when chats/calls change.

  const formatTime = (ts: any) => {
    if (!ts) return 'Just now';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    // WA audit #46 — every row already sits under a Today / Yesterday /
    // date heading, so the time slot always shows the clock time. The
    // old code printed the date here for calls older than 2 days, which
    // duplicated the heading above it and hid the time of day entirely.
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Phase 4 — call duration. Verified: `duration` (seconds) is written on
  // the `calls` doc by callService.endCall for outgoing calls
  // (updateDoc { status, duration, endedAt }) and by recordCalleeCall for
  // the callee's record. Old docs (pre-Phase-3) have no duration field, so
  // nothing is shown for them rather than a fake 0:00. Missed/declined
  // calls never connected, so they have no duration either.
  const formatDuration = (sec: any) => {
    const s = Number(sec) || 0;
    if (s <= 0) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  };

  // Cluster C (Item 14a): keep the schedule editor in sync with the link.
  useEffect(() => {
    if (!callLink) return;
    setSchedTitle(callLink.title || '');
    setSchedDateTime(callLink.scheduledAt ? new Date(callLink.scheduledAt - new Date(callLink.scheduledAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callLink?.token]);

  const schedCountdown = (() => {
    if (!callLink?.scheduledAt) return '';
    const ms = callLink.scheduledAt - Date.now();
    if (ms <= 0) return 'starting now';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `starts in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `starts in ${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `starts in ${d}d ${h % 24}h`;
  })();

  const saveSchedule = async () => {
    if (!currentUser || !callLink || schedBusy) return;
    setSchedBusy(true);
    try {
      const scheduledAt = schedDateTime ? new Date(schedDateTime).getTime() : null;
      if (schedDateTime && (isNaN(scheduledAt as number) || (scheduledAt as number) < Date.now() - 60000)) {
        showToastMsg('Pick a date and time in the future.');
        return;
      }
      const next: CallLinkState = { ...callLink, title: schedTitle.trim(), scheduledAt };
      await updateDoc(doc(db, 'users', currentUser.uid), { callLink: next });
      setCallLink(next);
      // 100M-H15 — mirror the time to this device so the watcher can
      // fire a reminder when it arrives (cleared when the schedule is).
      saveScheduledCallMirror(currentUser.uid, { scheduledAt, title: schedTitle.trim() });
      showToastMsg(scheduledAt ? 'Call scheduled ✓' : 'Schedule cleared');
    } catch {
      showToastMsg('Could not save the schedule. Try again.');
    } finally {
      setSchedBusy(false);
    }
  };

  const copyCallLink = async () => {
    try {
      await navigator.clipboard.writeText(callLinkUrl);
      setCallLinkCopied(true);
      setTimeout(() => setCallLinkCopied(false), 2500);
    } catch {
      showToastMsg('Could not copy link');
    }
  };

  const revokeCallLink = async () => {
    if (!currentUser || !callLink) return;
    setLinkBusy(true);
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { callLink: { ...callLink, revoked: true } });
      setCallLink({ ...callLink, revoked: true });
      showToastMsg('Call link revoked — old links now show “link expired”.');
    } catch {
      showToastMsg('Could not revoke the link. Try again.');
    } finally {
      setLinkBusy(false);
    }
  };

  const regenerateCallLink = async () => {
    if (!currentUser) return;
    setLinkBusy(true);
    try {
      const fresh: CallLinkState = { token: newCallLinkToken(), expiresAt: Date.now() + CALL_LINK_TTL_MS, revoked: false, scheduledAt: callLink?.scheduledAt ?? null, title: callLink?.title ?? '' };
      await updateDoc(doc(db, 'users', currentUser.uid), { callLink: fresh });
      setCallLink(fresh);
      showToastMsg('New call link created ✓');
    } catch {
      showToastMsg('Could not create a new link. Try again.');
    } finally {
      setLinkBusy(false);
    }
  };

  const clearCallHistory = async () => {
    if (!currentUser || calls.length === 0) return;
    setClearing(true);
    try {
      // 100M-H3 — `calls` is deduped for display, so delete every raw doc
      // (including the hidden twin of each call) or the row reappears.
      const docsToDelete = allCallDocsRef.current.length ? allCallDocsRef.current : calls;
      await Promise.all(docsToDelete.map(c => deleteDoc(doc(db, 'calls', c.id)).catch((err) => console.warn("[CallsScreen] clearCallHistory: deleteDoc(...) failed", err))));
      setCalls([]);
      showToastMsg('Call history cleared');
    } catch {
      showToastMsg('Could not clear call history. Try again.');
    } finally {
      setClearing(false);
      setShowClearConfirm(false);
    }
  };

  // 100M-H16 — per-entry delete: long-press a row (or right-click on
  // desktop) opens an action sheet; Delete asks once, then removes
  // just that doc. Clear-all stays in the ⋮ menu, untouched.
  const [actionCall, setActionCall] = useState<any | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState(false);
  const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when a long-press fires, so the click that follows pointerup
  // does not also redial (same guard as the minimised-call bubble).
  const suppressRowClickRef = React.useRef(false);

  const deleteCallEntry = async () => {
    if (!actionCall) return;
    setDeletingEntry(true);
    try {
      // WA-verify-calls-4 (row 55): a call is written twice (caller doc +
      // callee doc, same signalId) — deleting only the displayed doc left
      // the twin behind and the row reappeared on the next snapshot.
      // Delete every raw doc for this call (same rule as dedup), like
      // clear-all already does (100M-H3).
      const twins = allCallDocsRef.current.length
        ? allCallDocsRef.current.filter((c) => isSameCallDoc(c, actionCall))
        : [actionCall];
      const ids = new Set<string>(twins.map((c: any) => c.id as string));
      await Promise.all([...ids].map((id) => deleteDoc(doc(db, 'calls', id)).catch((err) => console.warn("[CallsScreen] deleteCallEntry: deleteDoc(...) failed", err))));
      setCalls((prev) => prev.filter((c) => !ids.has(c.id)));
      showToastMsg('Call deleted');
    } catch {
      showToastMsg('Could not delete this call. Try again.');
    } finally {
      setDeletingEntry(false);
      setShowDeleteConfirm(false);
      setActionCall(null);
    }
  };

  const onRowPointerDown = (e: React.PointerEvent, call: any) => {
    // A press that starts on a button (star / call-back / avatar) is
    // that button's tap, never a long-press.
    if ((e.target as HTMLElement).closest('button')) return;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressRowClickRef.current = true;
      // Safety: a stale flag must never swallow a LATER tap.
      window.setTimeout(() => { suppressRowClickRef.current = false; }, 1000);
      setActionCall(call);
    }, 700);
  };
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // 100M-H17 — tapping a history row redials (WhatsApp behaviour). The
  // chat opens from the avatar or the long-press sheet instead — the
  // old row-tap-to-chat is gone. Shared with the call-back button so
  // both paths behave identically, including the already-in-a-call
  // toast (100M-H12).
  const redialCall = async (call: any, otherName: string, otherAvatar: string) => {
    const targetUid = call.callerId === currentUser?.uid ? call.receiverId : call.callerId;
    if (!targetUid) return;
    // 100M-H17/H12 — guard against dialling while a call is live. The
    // pre-check below catches the common case; the startCall() result
    // check underneath is the belt-and-braces for a call that starts in
    // the gap between the check and the dial (startCall itself returns
    // 'already-in-call' — WA verify calls-2 row 16).
    const st = callService.getStatus();
    if (st !== 'idle' && st !== 'ended') { showToastMsg("You're already in a call", 4000); return; }
    const res = await callService.startCall({
      targetUserId: targetUid,
      targetUserName: otherName || 'User',
      targetUserAvatar: otherAvatar,
      type: call.type === 'video' ? 'video' : 'audio',
    });
    if (res === 'already-in-call') showToastMsg("You're already in a call", 4000);
  };

  const startNewCall = async (contact: any, type: 'audio' | 'video') => {
    const targetUid = contact.uid || contact.id;
    if (!targetUid) return;
    setShowNewCall(false);
    // 100M-H12 — say so when a call is already live instead of closing
    // the picker onto a dead button.
    const res = await callService.startCall({
      targetUserId: targetUid,
      targetUserName: contact.displayName || contact.username || 'User',
      targetUserAvatar: contact.photoURL || '',
      type,
    });
    if (res === 'already-in-call') showToastMsg("You're already in a call", 4000);
  };

  // W12b (100-more #1) — a callee who DECLINES a call never picked up,
  // so for the callee's view it IS a missed call (WhatsApp shows it red
  // in Missed). The stored status stays 'declined' (the truthful record)
  // — pushNotifications deliberately never notifies for declined docs, so
  // the display layer, not the stored status, is what changes. Outgoing
  // declined stays out of Missed per REPORT-3 #243.
  // W12c — same shape for a callee-side 'busy' record (callee was on
  // another call: handleIncomingSignal decision 'busy' / declineWaitingCall
  // record a 'busy' history doc with receiverId = the callee). The callee
  // never picked up, so it is a missed call for their view too. Stored
  // status stays 'busy'; no notification change (busy never notifies).
  // Audit H3-2: the rule itself lives in callHistory.ts (isMissedCallFor)
  // — this is only the viewer-bound wrapper, so the dedup preference and
  // the badge/filter can never disagree again.
  const isMissedCall = (call: any) => isMissedCallFor(call, currentUser?.uid);

  const filtered = calls.filter(c => {
    // Phase 5 (L-19): no locked caller in history, search or missed count.
    if (isLockedOther(c)) return false;
    if (historyFilter === 'missed' && !isMissedCall(c)) return false;
    if (!searchQ) return true;
    const name = c.callerId === currentUser?.uid ? c.receiverName : c.callerName;
    return (name || '').toLowerCase().includes(searchQ.toLowerCase());
  });
  // 100M-H3 — `calls` is already deduped on call identity, so the Missed
  // badge counts calls, not docs (one missed call reads "Missed1").
  const missedCount = calls.filter(c => isMissedCall(c) && !isLockedOther(c)).length;

  // Audit #19 — group the (already newest-first) history by calendar
  // day: Today / Yesterday / date, like WhatsApp.
  const grouped = useMemo(() => groupCallsByDate(filtered), [filtered]);

  const filteredContacts = contacts.filter(c => {
    // Phase 5 (L-19): locked contacts are not callable from the picker.
    if (lockedIds.includes(c.uid || c.id)) return false;
    if (!contactQ.trim()) return true;
    const q = contactQ.trim().toLowerCase();
    return (c.displayName || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q);
  });

  const getCallIcon = (call: any) => {
    const isIncoming = call.receiverId === currentUser?.uid;
    const isMissed = isMissedCall(call);
    if (isMissed) return <PhoneMissed className="h-4 w-4 text-danger-red" />;
    // 100M-H18 — a failed / unanswered call is red too (WhatsApp shows
    // it red, not the same green as a completed call).
    if (call.status === 'failed' || call.status === 'unanswered') return <PhoneOutgoing className="h-4 w-4 text-danger-red" />;
    if (isIncoming) return <PhoneIncoming className="h-4 w-4 text-primary-green" />;
    return <PhoneOutgoing className="h-4 w-4 text-primary-green" />;
  };

  const getCallLabel = (call: any) => {
    const isIncoming = call.receiverId === currentUser?.uid;
    const isMissed = isMissedCall(call);
    const typeLabel = call.type === 'video' ? t('video') : t('voice');
    if (isMissed) return `${t('missed')} ${typeLabel}`;
    // 100M-H18 — failed / unanswered calls used to fall through to a
    // plain "Outgoing Voice", identical to a completed call. They get
    // their own label now (busy/declined were already labelled — W12b/
    // W12c — and are untouched below).
    if (call.status === 'failed') return `${t('couldntConnect')} ${typeLabel}`;
    if (call.status === 'unanswered') return `${t('noAnswer')} ${typeLabel}`;
    // WA audit #8 — answered on another device/session.
    if (call.status === 'acceptedElsewhere') return `${t('answeredElsewhere')} ${typeLabel}`;
    if (isIncoming) return `${t('incoming')} ${typeLabel}`;
    // W12b — caller-side declined: never a "Missed" row per #243, but
    // label it so it is distinguishable from a plain outgoing call.
    // W12c — same for caller-side busy (caller heard "busy").
    if (call.status === 'declined') return `${t('declined')} ${typeLabel}`;
    if (call.status === 'busy') return `${t('busy')} ${typeLabel}`;
    return `${t('outgoing')} ${typeLabel}`;
  };

  return (
    <div className="flex h-full flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary relative">
      {/* Header — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-header-green dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          {showSearch ? (
            <div className="flex items-center w-full gap-2">
              <input
                autoFocus
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                placeholder={t('searchCalls')}
                aria-label="Search calls"
                className="flex-1 bg-white/15 dark:bg-input-dark rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-white/50 text-white dark:text-text-primary placeholder:text-white/80"
              />
              <button onClick={() => { setShowSearch(false); setSearchQ(''); }} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark text-white dark:text-text-primary" aria-label="Close search">
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-white dark:text-text-primary">{t('calls')}</h1>
              <div className="flex items-center gap-2 text-white/85 dark:text-text-secondary">
                <button onClick={() => setShowSearch(true)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark" aria-label="Search calls">
                  <Search className="h-5 w-5" />
                </button>
                <div className="relative">
                  <button onClick={() => setShowMenu(v => !v)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark" aria-label="More options" aria-haspopup="menu" aria-expanded={showMenu}>
                    <MoreVertical className="h-5 w-5" />
                  </button>
                  {showMenu && (
                    <div role="menu" className="absolute right-0 top-11 z-50 w-56 bg-panel-light dark:bg-panel-dark rounded-xl shadow-2xl border border-gray-200 dark:border-white/10 py-1 animate-fade-in">
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowCallLink(true); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-gray-900 dark:text-text-primary"
                      >
                        <Link2 className="h-4 w-4 text-primary-green" /> Create call link
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowNewCall(true); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-gray-900 dark:text-text-primary"
                      >
                        <Phone className="h-4 w-4 text-primary-green" /> {t('newCall')}
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowClearConfirm(true); }}
                        disabled={calls.length === 0}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-danger-red disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" /> {t('clearCallHistory')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* Wave-2 B3, WA audit Calls #74 — post-call notifications
            upsell banner (in-flow, like NotificationBanner: it takes
            its own height, so no row can slide under it). */}
        <PostCallNotificationsBanner recentEndedAt={recentCallEndedAt} />
        {/* Create Call Link */}
        <div className="px-4 py-3 border-b border-gray-100 dark:border-white/5">
          <div
            className="flex items-center cursor-pointer hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-xl p-2 -mx-2 transition-colors"
            onClick={() => setShowCallLink(true)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter') setShowCallLink(true); }}
            aria-label="Create call link"
          >
            <div className="h-12 w-12 rounded-full bg-primary-green/10 border border-primary-green/20 flex items-center justify-center flex-shrink-0">
              <Link2 className="h-6 w-6 text-primary-green" />
            </div>
            <div className="ml-4">
              <h3 className="font-semibold text-gray-900 dark:text-text-primary">{t('createCallLink')}</h3>
              <p className="text-sm text-gray-500 dark:text-text-secondary">{t('shareCallLink')}</p>
            </div>
          </div>
        </div>

        {/* Favourites — WhatsApp-style quick-call row. Tap a favourite
            to start a voice call (video via the small camera button);
            × removes it. Empty state explains how to add one. */}
        <div className="px-4 pt-3 pb-2 border-b border-gray-100 dark:border-white/5">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">{t('favourites')}</h3>
          {favContacts.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-text-secondary pb-1">
              {t('noFavouritesYet')}
            </p>
          ) : (
            <div className="flex gap-3 overflow-x-auto scrollbar-hide pb-1">
              {favContacts.map((fav) => (
                <div key={fav.uid} className="flex flex-col items-center w-[68px] flex-shrink-0">
                  <div className="relative">
                    <button
                      onClick={() => startNewCall(fav.contact, 'audio')}
                      aria-label={`Voice call ${fav.name}`}
                      className="rounded-full hover:opacity-90 active:scale-95 transition-[opacity,transform]"
                    >
                      <DefaultAvatar photoURL={fav.avatar} name={fav.name} seed={fav.uid} size={52} />
                    </button>
                    <button
                      onClick={() => void toggleFav(fav.uid)}
                      aria-label={`Remove ${fav.name} from favourites`}
                      className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-gray-200 dark:bg-input-dark text-gray-500 dark:text-text-secondary flex items-center justify-center shadow-sm"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <span className="text-xs text-gray-700 dark:text-text-primary truncate w-full text-center mt-1">{fav.name}</span>
                  <button
                    onClick={() => startNewCall(fav.contact, 'video')}
                    aria-label={`Video call ${fav.name}`}
                    className="mt-0.5 p-2.5 rounded-full hover:bg-primary-green/10 text-primary-green transition-colors"
                  >
                    <Video className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Phase 4 — All / Missed filter tabs */}
        <div className="flex gap-2 px-4 pt-3 pb-1">
          {([
            { id: 'all', label: t('all'), count: calls.length },
            { id: 'missed', label: t('missed'), count: missedCount },
          ] as const).map(tab => (
            <button
              key={tab.id}
              onClick={() => setHistoryFilter(tab.id)}
              aria-pressed={historyFilter === tab.id}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                historyFilter === tab.id
                  ? 'bg-[#D9FDD3] dark:bg-[#103529] text-[#15603E] dark:text-[#D9FDD3] shadow-sm'
                  : 'bg-gray-200 dark:bg-input-dark text-gray-600 dark:text-text-secondary'
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 text-xs opacity-70">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* Call list — date-grouped (audit #19); the group headings
            replace the old flat "Recent calls" label. */}
        {loadingCalls ? (
          <ListSkeleton rows={3} />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-500 dark:text-text-secondary">
            <Phone className="h-16 w-16 opacity-20" />
            <p className="text-base font-medium">{searchQ ? `No calls matching "${searchQ}"` : historyFilter === 'missed' ? t('noMissedCalls') : t('noRecentCalls')}</p>
            <p className="text-sm text-center max-w-xs">
              {!searchQ && t('startCallHint')}
            </p>
          </div>
        ) : (
          <div>
            {grouped.map((group) => (
              <div key={group.label}>
                <div className="px-4 pt-3 pb-1">
                  <h3 className="text-xs font-semibold text-gray-500 dark:text-text-secondary">{group.label}</h3>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-white/5">
                  {group.calls.map((call) => {
              const isIncoming = call.receiverId === currentUser?.uid;
              const otherName = isIncoming ? call.callerName : call.receiverName;
              const otherAvatar = isIncoming ? call.callerAvatar : call.receiverAvatar;
              const isMissed = isMissedCall(call);
              const otherId = isIncoming ? call.callerId : call.receiverId;

              const isFailedOrUnanswered = call.status === 'failed' || call.status === 'unanswered';
              return (
                <div
                  key={call.id}
                  className="flex items-center px-4 py-3 hover:bg-gray-50 dark:hover:bg-panel-dark/50 cursor-pointer transition-colors"
                  onPointerDown={(e) => onRowPointerDown(e, call)}
                  onPointerUp={clearLongPressTimer}
                  onPointerLeave={clearLongPressTimer}
                  onPointerCancel={clearLongPressTimer}
                  onContextMenu={(e) => { e.preventDefault(); setActionCall(call); }}
                >
                  {/* Avatar — opens the chat (100M-H17: the chat
                      affordance moved here; the row itself redials). */}
                  <button
                    type="button"
                    onClick={() => navigate(`/chat/${otherId}`)}
                    aria-label={`Open chat with ${otherName || 'user'}`}
                    className="rounded-full flex-shrink-0 active:scale-95 transition-transform"
                  >
                    <DefaultAvatar photoURL={otherAvatar} name={otherName || 'Unknown'} seed={otherId} size={48} />
                  </button>

                  {/* Info — tap redials (100M-H17, WhatsApp behaviour). */}
                  <div
                    className="ml-3 flex-1 min-w-0"
                    role="button"
                    tabIndex={0}
                    aria-label={`Call back ${otherName || 'user'}`}
                    onClick={() => {
                      if (suppressRowClickRef.current) { suppressRowClickRef.current = false; return; }
                      void redialCall(call, otherName || 'Unknown', otherAvatar);
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void redialCall(call, otherName || 'Unknown', otherAvatar); }}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className={`font-semibold truncate ${isMissed || isFailedOrUnanswered ? 'text-danger-red' : 'text-gray-900 dark:text-text-primary'}`}>
                        {otherName || 'Unknown'}
                      </h3>
                      <span className={`text-[11px] flex-shrink-0 tabular-nums ${isMissed || isFailedOrUnanswered ? 'text-danger-red font-semibold' : 'text-gray-400 dark:text-text-secondary'}`}>
                        {formatTime(call.timestamp)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {getCallIcon(call)}
                      <span className={`text-sm truncate ${isFailedOrUnanswered ? 'text-danger-red font-medium' : 'text-gray-500 dark:text-text-secondary'}`}>
                        {getCallLabel(call)}{formatDuration(call.duration) ? ` • ${formatDuration(call.duration)}` : ''}
                      </span>
                    </div>
                  </div>

                  {/* Favourite toggle — star on a history row adds/removes
                      the other party from the Favourites row above. */}
                  <button
                    onClick={() => void toggleFav(otherId)}
                    className="p-2.5 rounded-full hover:bg-yellow-400/10 transition-colors flex-shrink-0"
                    aria-label={`${favUids.includes(otherId) ? 'Remove from' : 'Add to'} favourites: ${otherName || 'user'}`}
                    aria-pressed={favUids.includes(otherId)}
                  >
                    <Star className={`h-5 w-5 ${favUids.includes(otherId) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300 dark:text-text-secondary'}`} />
                  </button>

                  {/* Call back button — same redial as tapping the row
                      (100M-H17), including the already-in-a-call toast. */}
                  <button
                    onClick={() => void redialCall(call, otherName || 'Unknown', otherAvatar)}
                    className="p-2.5 rounded-full hover:bg-primary-green/10 text-primary-green transition-colors flex-shrink-0"
                    aria-label={`Call back ${otherName || 'user'}`}
                  >
                    {call.type === 'video'
                      ? <Video className="h-5 w-5" />
                      : <Phone className="h-5 w-5" />}
                  </button>
                </div>
              );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* Call Link Modal */}
      {showCallLink && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end" onClick={() => setShowCallLink(false)} role="dialog" aria-modal="true" aria-label="Your call link">
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-bold">Your call link</h3>
              <button onClick={() => setShowCallLink(false)} className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 flex items-center gap-3">
              <Link2 className="h-5 w-5 text-primary-green flex-shrink-0" />
              <p className="text-sm text-gray-600 dark:text-text-secondary flex-1 truncate font-mono">{callLinkUrl}</p>
            </div>

            {callLink ? (
              callLink.revoked ? (
                <p className="text-sm text-danger-red flex items-center gap-1.5 justify-center">
                  <ShieldAlert className="h-4 w-4" /> This link is revoked — anyone opening it sees “link expired”.
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-text-secondary text-center flex items-center gap-1.5 justify-center">
                  <Clock className="h-4 w-4" /> Link expires {new Date(callLink.expiresAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
                </p>
              )
            ) : (
              <p className="text-sm text-gray-500 dark:text-text-secondary text-center">
                Share this link to let anyone call you — they&apos;ll need to be signed in to Pinglo to join.
              </p>
            )}

            {/* Cluster C (Item 14a): schedule this call link */}
            {callLink && !callLink.revoked && (
              <div className="space-y-2 rounded-xl bg-gray-50 dark:bg-input-dark/60 p-3">
                {/* Report 3 #254 — the heading was CSS-uppercased
                    ("SCHEDULE THIS CALL") while the rest of the sheet is
                    sentence case, and a case-sensitive search for
                    "Schedule this call" missed the section entirely. */}
                <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary tracking-wide">Schedule this call</p>
                {callLink.scheduledAt ? (
                  <p className="text-sm text-primary-green flex items-center gap-1.5">
                    <Calendar className="h-4 w-4 flex-shrink-0" /> {callLink.title ? `${callLink.title} — ` : ''}{t('scheduledFor')} {new Date(callLink.scheduledAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ({schedCountdown})
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-text-secondary">No time set — the link works any time. Set one so people know when to join.</p>
                )}
                <input
                  value={schedTitle}
                  onChange={e => setSchedTitle(e.target.value)}
                  placeholder="Call title (optional)"
                  aria-label="Call title"
                  maxLength={60}
                  className="w-full bg-white dark:bg-panel-dark rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-green"
                />
                <input
                  type="datetime-local"
                  value={schedDateTime}
                  onChange={e => setSchedDateTime(e.target.value)}
                  aria-label="Scheduled date and time"
                  className="w-full bg-white dark:bg-panel-dark rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-green"
                />
                <button
                  onClick={saveSchedule}
                  disabled={schedBusy}
                  className="w-full py-2.5 bg-primary-green/10 text-primary-green rounded-xl text-sm font-semibold hover:bg-primary-green/20 transition-colors disabled:opacity-40"
                >
                  {schedBusy ? 'Saving…' : schedDateTime ? 'Save schedule' : 'Clear schedule'}
                </button>
                {/* 100M-H15 — the reminder fires in-app on this device
                    when the time arrives; a closed app cannot remind. */}
                <p className="text-[11px] text-gray-400 text-center leading-snug">
                  We&apos;ll remind you in the app when it&apos;s time (this device only).
                </p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={copyCallLink}
                disabled={callLink?.revoked}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter] disabled:opacity-40"
              >
                {callLinkCopied ? '✓ Copied!' : <><Copy className="h-4 w-4" /> Copy Link</>}
              </button>
              <button
                onClick={async () => {
                  if (navigator.share) {
                    await navigator.share({ title: 'Join my Pinglo call', url: callLinkUrl });
                  } else {
                    copyCallLink();
                  }
                }}
                disabled={callLink?.revoked}
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors disabled:opacity-40"
              >
                <Share2 className="h-4 w-4" /> Share
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={revokeCallLink}
                disabled={!callLink || callLink.revoked || linkBusy}
                className="flex-1 py-2.5 bg-danger-red/10 text-danger-red rounded-xl font-semibold hover:bg-danger-red/20 transition-colors disabled:opacity-40 text-sm"
              >
                {linkBusy ? 'Working…' : 'Revoke link'}
              </button>
              <button
                onClick={regenerateCallLink}
                disabled={!currentUser || linkBusy}
                className="flex-1 py-2.5 bg-primary-green/10 text-primary-green rounded-xl font-semibold hover:bg-primary-green/20 transition-colors disabled:opacity-40 text-sm"
              >
                {linkBusy ? 'Working…' : 'Regenerate link'}
              </button>
            </div>
            <p className="text-[11px] text-gray-500 text-center leading-relaxed">
              Revoking or regenerating makes every previously shared link stop working.
            </p>
          </div>
        </div>
      )}

      {/* Clear history confirm */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowClearConfirm(false)} role="dialog" aria-modal="true" aria-label="Clear call history">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Clear call history?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              This deletes all {calls.length} call record{calls.length === 1 ? '' : 's'} from your history. This can&apos;t be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowClearConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={clearCallHistory} disabled={clearing} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
                {clearing ? 'Clearing…' : 'Clear all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 100M-H16 — long-press action sheet: open the chat, or delete
          just this entry. (Delete asks once more, below.) */}
      {actionCall && !showDeleteConfirm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end" onClick={() => setActionCall(null)} role="dialog" aria-modal="true" aria-label="Call options">
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-2" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold px-1 pb-1">
              {(actionCall.callerId === currentUser?.uid ? actionCall.receiverName : actionCall.callerName) || 'Unknown'}
            </h3>
            <button
              onClick={() => {
                const otherId = actionCall.callerId === currentUser?.uid ? actionCall.receiverId : actionCall.callerId;
                setActionCall(null);
                navigate(`/chat/${otherId}`);
              }}
              className="w-full text-left px-4 py-3 rounded-xl hover:bg-gray-100 dark:hover:bg-input-dark text-sm font-medium"
            >
              Open chat
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-danger-red/10 text-sm font-medium text-danger-red"
            >
              <Trash2 className="h-4 w-4" /> Delete this call
            </button>
            <button
              onClick={() => setActionCall(null)}
              className="w-full px-4 py-3 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* 100M-H16 — delete ONE entry (not the whole history). */}
      {showDeleteConfirm && actionCall && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => { setShowDeleteConfirm(false); setActionCall(null); }} role="dialog" aria-modal="true" aria-label="Delete this call">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete this call?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              This removes only this entry from your call history. The rest of your history stays. This can&apos;t be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => { setShowDeleteConfirm(false); setActionCall(null); }} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button onClick={deleteCallEntry} disabled={deletingEntry} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all disabled:opacity-50">
                {deletingEntry ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New-call contact picker */}
      {showNewCall && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end" onClick={() => setShowNewCall(false)} role="dialog" aria-modal="true" aria-label="New call">
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-4 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-xl font-bold">New call</h3>
              <button onClick={() => setShowNewCall(false)} className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2">
              <Search className="h-4 w-4 text-gray-500 flex-shrink-0" />
              <input
                autoFocus
                type="text"
                value={contactQ}
                onChange={e => setContactQ(e.target.value)}
                placeholder="Search contacts..."
                aria-label="Search contacts"
                className="flex-1 bg-transparent text-sm text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto -mx-1 px-1">
              {!contactsLoaded ? (
                <div className="space-y-3 py-2" aria-label="Loading contacts">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                      <div className="h-11 w-11 rounded-full bg-gray-200 dark:bg-input-dark" />
                      <div className="h-3 w-2/5 rounded bg-gray-200 dark:bg-input-dark" />
                    </div>
                  ))}
                </div>
              ) : filteredContacts.length === 0 ? (
                <p className="text-sm text-center text-gray-500 py-8">
                  {contactQ ? `No contacts matching "${contactQ}"` : 'No contacts yet — add people by chatting with them first.'}
                </p>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-white/5">
                  {filteredContacts.map(c => {
                    const name = c.displayName || c.username || 'User';
                    return (
                      <div key={c.uid || c.id} className="flex items-center gap-3 py-2.5">
                        <DefaultAvatar photoURL={c.photoURL} name={name} seed={c.uid || c.id} size={44} />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 dark:text-text-primary truncate">{name}</p>
                          {c.username && <p className="text-xs text-gray-500 truncate">@{c.username}</p>}
                        </div>
                        <button
                          onClick={() => startNewCall(c, 'audio')}
                          className="p-2.5 rounded-full hover:bg-primary-green/10 text-primary-green transition-colors"
                          aria-label={`Voice call ${name}`}
                        >
                          <Phone className="h-5 w-5" />
                        </button>
                        <button
                          onClick={() => startNewCall(c, 'video')}
                          className="p-2.5 rounded-full hover:bg-primary-green/10 text-primary-green transition-colors"
                          aria-label={`Video call ${name}`}
                        >
                          <Video className="h-5 w-5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* FAB — new call */}
      <div className="absolute bottom-4 right-4">
        <button
          onClick={() => setShowNewCall(true)}
          className="h-14 w-14 flex items-center justify-center rounded-full bg-primary-green text-on-primary-green shadow-xl hover:brightness-95 active:scale-95 transition-[filter,transform]"
          title="New Call"
          aria-label="New call"
        >
          <Phone className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}
