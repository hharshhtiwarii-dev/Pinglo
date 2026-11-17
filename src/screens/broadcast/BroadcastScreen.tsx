import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Megaphone, Pencil, Plus, Search, Send, Trash2, Users, X, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot, auth, db } from '../../aws';
import { loadGatedContactsDetailed, getAllowedContactUids, KNOWN_CONVS_CHANGED_EVENT } from '../../services/contacts';
import { isLockedPartnerCached } from '../../services/lockedChats';
import { navigationManager } from '../../services/navigation';
import { avatarFallback } from '../../utils/avatar';
import {
  loadBroadcastLists,
  createBroadcastList,
  updateBroadcastList,
  deleteBroadcastList,
  sendBroadcast,
  MAX_BROADCAST_NAME_LEN,
  MAX_BROADCAST_RECIPIENTS,
  type BroadcastList,
  type BroadcastSendResult,
} from '../../services/broadcast';

/**
 * Broadcast lists (Phase 4, Agent B).
 *
 * Create a named list of recipients, then send one message that is
 * delivered as a separate 1:1 DM to each recipient — no group chat is
 * created. Sending is per-recipient (see services/broadcast.ts): the
 * result screen reports exactly who got it, who failed, and who was
 * skipped because they are blocked.
 *
 * ROUTE TO ADD in App.tsx (App.tsx is owned by another agent — do not
 * edit it here):
 *   import BroadcastScreen from './screens/broadcast/BroadcastScreen';
 *   <Route path="/broadcast" element={user ? <BroadcastScreen /> : <Navigate to="/login" />} />
 * Entry point: ChatListScreen ⋮ menu → "Broadcast lists" (this worker).
 */

export default function BroadcastScreen() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const [lists, setLists] = useState<BroadcastList[]>([]);
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<any[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingList, setEditingList] = useState<BroadcastList | null>(null);
  const [newName, setNewName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [contactQ, setContactQ] = useState('');
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [lastResult, setLastResult] = useState<BroadcastSendResult | null>(null);
  // 100M-H19: the send result (incl. the "Retry failed" button) vanished
  // on leaving /broadcast — lastResult was per-mount state. Persist the
  // outcome per list in localStorage (small: uids + error strings) so it
  // survives leaving the screen, a reload, and the hours until "waiting
  // for encryption setup" resolves. The composer text is persisted with
  // it — retry re-sends the same text, and without it the Retry button
  // would be disabled after a return (handleSend only clears the composer
  // on a full success). A fully-sent result has nothing to retry, so it
  // is cleared instead of persisted.
  const persistedResultKey = (uid: string, listId: string) => `dt_broadcast_last_result_v1:${uid}:${listId}`;
  const persistResult = (listId: string, result: BroadcastSendResult, msgText: string) => {
    if (!currentUser) return;
    try {
      const key = persistedResultKey(currentUser.uid, listId);
      if (result.failed.length === 0 && result.pendingSetup.length === 0) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, JSON.stringify({ result, message: msgText, sentAt: Date.now() }));
      }
    } catch {
      // Storage full/blocked: the in-memory result still shows this mount.
    }
  };
  // Restore the persisted outcome whenever the active list changes (and
  // clear it when no list is active). The composer text is restored only
  // when it is empty, so text typed for another list is never clobbered.
  useEffect(() => {
    if (!currentUser) return;
    if (!activeListId) { setLastResult(null); return; }
    try {
      const raw = localStorage.getItem(persistedResultKey(currentUser.uid, activeListId));
      if (!raw) { setLastResult(null); return; }
      const parsed = JSON.parse(raw) as { result?: BroadcastSendResult; message?: string };
      if (!parsed?.result) { setLastResult(null); return; }
      setLastResult(parsed.result);
      if (parsed.message) setMessage(prev => (prev.trim() ? prev : parsed.message));
    } catch {
      setLastResult(null);
    }
  }, [activeListId, currentUser]);
  // 100M-H19: when returning with an UNRESOLVED send outcome (failed /
  // pending-setup), reopen the list that owns it — otherwise the persisted
  // result would sit behind a collapsed row and the return trip would
  // still show no result and no Retry button. Runs once, on the first
  // lists load; collapsing the list by hand never re-expands it.
  const restoredActiveRef = useRef(false);
  useEffect(() => {
    if (restoredActiveRef.current || loading || !currentUser || lists.length === 0 || activeListId) return;
    restoredActiveRef.current = true;
    for (const l of lists) {
      try {
        const raw = localStorage.getItem(persistedResultKey(currentUser.uid, l.id));
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { result?: BroadcastSendResult };
        if (parsed?.result && (parsed.result.failed.length > 0 || parsed.result.pendingSetup.length > 0)) {
          setActiveListId(l.id);
          break;
        }
      } catch { /* ignore */ }
    }
  }, [lists, loading, currentUser, activeListId]);
  const [confirmDelete, setConfirmDelete] = useState<BroadcastList | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  // 100M-D6 (W14h): same class as D5 — the toast's auto-clear timer id, so
  // a second toast fired before the first one's timer expires is cleared
  // by ITS OWN timer, not the first one's (which cut it short).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToastMsg = (msg: string) => {
    // 100M-D6: clear the previous toast's timer first — without this the
    // first toast's 3 s timer cleared the second toast ~1 s after it fired.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  };

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    loadBroadcastLists(currentUser.uid)
      .then(l => { if (!cancelled) setLists(l); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentUser]);

  // W28: gated contacts — saved contacts + proven DM partners only.
  // No whole-users subscription anymore. Existing lists keep working:
  // their members are passed as extraUids so nameFor() still resolves
  // people the user already chose, without widening the picker.
  // Re-runs when the chats collection changes or lists land, but profile
  // reads only re-fire when the uid SET changes.
  const gatedUidsKeyRef = useRef('');
  const gatedLoadedRef = useRef(false);
  // 100M-C1: a partial load (some allowed uid had no profile doc yet)
  // must not latch — the next trigger retries. Throttled so a profile
  // that never arrives doesn't re-read on every chats snapshot.
  const gatedRetryAtRef = useRef(0);
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const run = async (force = false) => {
      try {
        const memberUids = lists.flatMap(l => (l as any).recipientIds || []);
        const uids = [...new Set([...getAllowedContactUids(currentUser.uid), ...memberUids])].sort();
        const key = uids.join(',');
        if (!force && key === gatedUidsKeyRef.current && gatedLoadedRef.current) return;
        if (!force && !gatedLoadedRef.current && gatedRetryAtRef.current && Date.now() - gatedRetryAtRef.current < 15000) return;
        const { list, unresolvedUids } = await loadGatedContactsDetailed(currentUser.uid, memberUids);
        if (cancelled) return;
        if (unresolvedUids.length === 0) {
          gatedUidsKeyRef.current = key;
          gatedLoadedRef.current = true;
        } else {
          gatedLoadedRef.current = false;
          gatedRetryAtRef.current = Date.now();
        }
        setContacts(list);
      } catch {
        /* offline: keep the previous list */
      }
    };
    void run();
    const unsubChats = onSnapshot(collection(db, 'chats'), () => { void run(); });
    // W28 R5: re-run when background discovery memos a new conversation
    // (localStorage write — no chats snapshot fires for it). 100M-C1:
    // force the re-read — the uid SET may be unchanged while a profile
    // arrived after the first (partial) load.
    const onKnownConvs = () => { void run(true); };
    window.addEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
    return () => {
      cancelled = true;
      window.removeEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
      try { unsubChats(); } catch (err) { console.warn("[BroadcastScreen] BroadcastScreen: unsubChats() failed", err); }
    };
  }, [currentUser, lists]);

  useEffect(() => {
    if (showCreate) {
      return navigationManager.pushHandler(() => {
        closeSheet();
        return true;
      });
    }
  }, [showCreate]);

  const activeList = lists.find(l => l.id === activeListId) || null;

  const filteredContacts = useMemo(() => {
    const q = contactQ.trim().toLowerCase();
    return contacts.filter(c => {
      // Phase 5 (L-17): locked contacts are never broadcast recipients.
      if (isLockedPartnerCached(c.uid || c.id)) return false;
      if (!q) return true;
      return (c.displayName || '').toLowerCase().includes(q) ||
        (c.username || '').toLowerCase().includes(q);
    });
  }, [contacts, contactQ]);

  const nameFor = (uid: string) => {
    const c = contacts.find(x => (x.uid || x.id) === uid);
    return c?.displayName || c?.username || 'User';
  };

  // W18b: edit an existing list in the same sheet used for creating.
  const openCreate = () => {
    setEditingList(null);
    setNewName('');
    setSelected([]);
    setContactQ('');
    setShowCreate(true);
  };
  const openEdit = (list: BroadcastList) => {
    setEditingList(list);
    setNewName(list.name);
    setSelected([...list.recipientIds]);
    setContactQ('');
    setShowCreate(true);
  };
  const closeSheet = () => {
    setShowCreate(false);
    setEditingList(null);
  };

  const handleCreate = async () => {
    if (!currentUser) return;
    setBusy(true);
    try {
      if (editingList) {
        const updated = await updateBroadcastList(currentUser.uid, editingList.id, { name: newName, recipientIds: selected });
        if (updated) setLists(prev => prev.map(l => (l.id === updated.id ? updated : l)));
        showToastMsg('Broadcast list updated ✓');
      } else {
        const list = await createBroadcastList(currentUser.uid, newName, selected);
        setLists(prev => [list, ...prev]);
        setActiveListId(list.id);
        showToastMsg('Broadcast list created ✓');
      }
      setNewName('');
      setSelected([]);
      setContactQ('');
      closeSheet();
    } catch (e: any) {
      showToastMsg(e?.message || 'Could not save broadcast list');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!currentUser || !confirmDelete) return;
    setBusy(true);
    try {
      await deleteBroadcastList(currentUser.uid, confirmDelete.id);
      // 100M-H19: a deleted list takes its persisted send outcome with it.
      try { localStorage.removeItem(persistedResultKey(currentUser.uid, confirmDelete.id)); } catch { /* ignore */ }
      setLists(prev => prev.filter(l => l.id !== confirmDelete.id));
      if (activeListId === confirmDelete.id) setActiveListId(null);
      showToastMsg('Broadcast list deleted');
    } catch {
      showToastMsg('Could not delete broadcast list');
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const handleSend = async (onlyTo?: string[]) => {
    if (!activeList) return;
    setSending(true);
    setLastResult(null);
    try {
      const targetList = onlyTo ? { ...activeList, recipientIds: onlyTo } : activeList;
      const result = await sendBroadcast(targetList, message);
      setLastResult(result);
      // 100M-H19: persist the outcome (+ the text, for retry) per list.
      persistResult(activeList.id, result, message);
      if (result.failed.length === 0 && result.skippedBlocked.length === 0 && result.pendingSetup.length === 0) {
        showToastMsg(`Sent to ${result.sent.length} recipient${result.sent.length === 1 ? '' : 's'} ✓`);
        setMessage('');
      } else if (result.sent.length > 0) {
        showToastMsg(`Sent to ${result.sent.length}, ${result.failed.length} failed, ${result.skippedBlocked.length} skipped (blocked), ${result.pendingSetup.length} waiting for encryption setup`);
      } else {
        showToastMsg('Broadcast could not be sent — see the result below');
      }
    } catch (e: any) {
      showToastMsg(e?.message || 'Could not send broadcast');
    } finally {
      setSending(false);
    }
  };

  // W18b (P0-8): re-send the same message to recipients whose first attempt
  // failed or is waiting for encryption setup. The composer text is kept
  // (handleSend only clears it on a full success), so retry sends the same
  // text to just those people.
  const handleRetryFailed = () => {
    if (!activeList || !lastResult) return;
    const retryUids = [...new Set([...lastResult.failed.map(f => f.uid), ...lastResult.pendingSetup])];
    if (retryUids.length === 0) return;
    void handleSend(retryUids);
  };

  return (
    <div className="flex h-full flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary relative">
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-2 px-4 py-3">
          <button onClick={() => navigate(-1)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Megaphone className="h-5 w-5 text-primary-green" />
          <h1 className="text-xl font-bold flex-1">Broadcast lists</h1>
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green transition-colors"
          >
            <Plus className="h-4 w-4" /> New list
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24 px-4 py-4 space-y-4">
        <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
          A broadcast sends your message as a separate private DM to each person on the list — no group chat is created, and recipients don&apos;t see each other.
        </p>

        {loading ? (
          <div className="space-y-3" aria-label="Loading broadcast lists">
            {[0, 1].map(i => (
              <div key={i} className="h-16 rounded-2xl bg-gray-200 dark:bg-input-dark animate-pulse" />
            ))}
          </div>
        ) : lists.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 dark:text-text-secondary text-center">
            <Megaphone className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium">No broadcast lists yet</p>
            <p className="text-sm max-w-xs">Create a list, pick the people, and send one message to all of them as private DMs.</p>
            <button
              onClick={openCreate}
              className="mt-2 px-4 py-2.5 rounded-xl bg-green-cta text-white text-sm font-semibold hover:bg-dark-green transition-colors"
            >
              Create your first list
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {lists.map(list => {
              const active = list.id === activeListId;
              return (
                <div
                  key={list.id}
                  onClick={() => { setActiveListId(active ? null : list.id); /* 100M-H19: the restore effect above loads that list's persisted result (or clears it) */ }}
                  className={`rounded-2xl border p-4 cursor-pointer transition-colors ${
                    active
                      ? 'border-primary-green bg-primary-green/5'
                      : 'border-gray-200 dark:border-white/10 bg-panel-light dark:bg-panel-dark hover:bg-gray-50 dark:hover:bg-panel-dark/70'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="h-11 w-11 rounded-full bg-primary-green/10 flex items-center justify-center flex-shrink-0">
                      <Megaphone className="h-5 w-5 text-primary-green" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate">{list.name}</p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {list.recipientIds.length} recipient{list.recipientIds.length === 1 ? '' : 's'}
                        {' • '}
                        {list.recipientIds.slice(0, 3).map(nameFor).join(', ')}
                        {list.recipientIds.length > 3 && ` +${list.recipientIds.length - 3} more`}
                      </p>
                    </div>
                    <button
                      onClick={e => { e.stopPropagation(); openEdit(list); }}
                      className="p-2 rounded-full text-gray-500 hover:bg-gray-100 dark:hover:bg-input-dark transition-colors"
                      aria-label={`Edit ${list.name}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setConfirmDelete(list); }}
                      className="p-2 rounded-full text-red-500 hover:bg-red-500/10 transition-colors"
                      aria-label={`Delete ${list.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {active && (
                    <div className="mt-4 space-y-3" onClick={e => e.stopPropagation()}>
                      <textarea
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        placeholder={`Message ${list.recipientIds.length} people…`}
                        rows={3}
                        maxLength={5000}
                        aria-label="Broadcast message"
                        className="w-full bg-gray-50 dark:bg-input-dark rounded-xl px-4 py-3 text-sm text-gray-900 dark:text-text-primary resize-none outline-none focus:ring-2 focus:ring-primary-green"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-400">{message.length}/5000</span>
                        <button
                          onClick={() => handleSend()}
                          disabled={!message.trim() || sending}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-green-cta text-white text-sm font-semibold hover:bg-dark-green transition-all disabled:opacity-40"
                        >
                          <Send className="h-4 w-4" />
                          {sending ? 'Sending…' : `Send to ${list.recipientIds.length}`}
                        </button>
                      </div>
                      {lastResult && (
                        <div className="rounded-xl bg-gray-50 dark:bg-input-dark/60 p-3 text-xs space-y-1" role="status">
                          <p className="font-semibold text-sm">
                            {lastResult.sent.length} sent
                            {lastResult.failed.length > 0 && ` · ${lastResult.failed.length} failed`}
                            {lastResult.skippedBlocked.length > 0 && ` · ${lastResult.skippedBlocked.length} skipped (blocked)`}
                            {lastResult.pendingSetup.length > 0 && ` · ${lastResult.pendingSetup.length} waiting for encryption setup`}
                          </p>
                          {lastResult.failed.length > 0 && (
                            <p className="text-danger-red">
                              Failed: {lastResult.failed.map(f => nameFor(f.uid)).join(', ')}
                            </p>
                          )}
                          {lastResult.skippedBlocked.length > 0 && (
                            <p className="text-gray-500 dark:text-text-secondary">
                              Skipped (you blocked them): {lastResult.skippedBlocked.map(nameFor).join(', ')}
                            </p>
                          )}
                          {lastResult.pendingSetup.length > 0 && (
                            <p className="text-gray-500 dark:text-text-secondary">
                              Waiting for encryption setup: {lastResult.pendingSetup.map(nameFor).join(', ')} — they&apos;ll receive it once they open the app.
                            </p>
                          )}
                          {lastResult.sent.length > 0 && (
                            <p className="text-gray-500 dark:text-text-secondary">
                              Sent to: {lastResult.sent.map(nameFor).join(', ')}
                            </p>
                          )}
                          {(lastResult.failed.length > 0 || lastResult.pendingSetup.length > 0) && (
                            <button
                              onClick={handleRetryFailed}
                              disabled={sending || !message.trim()}
                              className="mt-1 px-3 py-2 rounded-xl bg-green-cta text-white text-xs font-semibold hover:bg-dark-green transition-all disabled:opacity-40"
                            >
                              {sending ? 'Retrying…' : `Retry failed (${lastResult.failed.length + lastResult.pendingSetup.length})`}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create list sheet */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end" onClick={closeSheet} role="dialog" aria-modal="true" aria-label={editingList ? 'Edit broadcast list' : 'New broadcast list'}>
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">{editingList ? 'Edit broadcast list' : 'New broadcast list'}</h3>
              <button onClick={closeSheet} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="List name, e.g. Family"
              maxLength={MAX_BROADCAST_NAME_LEN}
              aria-label="Broadcast list name"
              className="w-full bg-gray-50 dark:bg-input-dark rounded-xl px-4 py-3 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
            />
            <div className="flex items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2">
              <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <input
                value={contactQ}
                onChange={e => setContactQ(e.target.value)}
                placeholder="Search contacts..."
                aria-label="Search contacts"
                className="flex-1 bg-transparent text-sm text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-400"
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-text-secondary">
              {selected.length} / {MAX_BROADCAST_RECIPIENTS} selected
              {selected.length >= MAX_BROADCAST_RECIPIENTS && ' — list is full (max 256 recipients)'}
            </p>
            <div className="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 -mx-1 px-1">
              {filteredContacts.length === 0 ? (
                <p className="text-sm text-center text-gray-400 py-8">No contacts found. Chat with someone first, or add them in Contacts, and they will appear here.</p>
              ) : (
                filteredContacts.map(c => {
                  const uid = c.uid || c.id;
                  const name = c.displayName || c.username || 'User';
                  const isSelected = selected.includes(uid);
                  return (
                    <div
                      key={uid}
                      onClick={() => setSelected(prev => {
                        if (prev.includes(uid)) return prev.filter(id => id !== uid);
                        if (prev.length >= MAX_BROADCAST_RECIPIENTS) {
                          showToastMsg(`A broadcast list holds at most ${MAX_BROADCAST_RECIPIENTS} recipients`);
                          return prev;
                        }
                        return [...prev, uid];
                      })}
                      className="flex items-center gap-3 py-2.5 cursor-pointer"
                      role="checkbox"
                      aria-checked={isSelected}
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(prev => { if (prev.includes(uid)) return prev.filter(id => id !== uid); if (prev.length >= MAX_BROADCAST_RECIPIENTS) { showToastMsg(`A broadcast list holds at most ${MAX_BROADCAST_RECIPIENTS} recipients`); return prev; } return [...prev, uid]; }); } }}
                    >
                      <img src={c.photoURL || avatarFallback(name, uid)} alt="" className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
                      <span className="flex-1 text-sm font-medium truncate">{name}</span>
                      <span className={`h-5 w-5 rounded-full flex items-center justify-center border ${isSelected ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400'}`}>
                        {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || selected.length === 0 || busy}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green disabled:opacity-40 transition-all"
            >
              {busy ? 'Saving…' : editingList ? `Save changes (${selected.length})` : `Create list (${selected.length})`}
            </button>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setConfirmDelete(null)} role="dialog" aria-modal="true" aria-label="Delete broadcast list">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete “{confirmDelete.name}”?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">The list is removed. Chats and messages you already sent are not affected.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button onClick={handleDelete} disabled={busy} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all disabled:opacity-50">
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
