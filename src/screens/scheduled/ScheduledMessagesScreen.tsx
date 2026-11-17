import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CalendarClock, Clock, Pencil, RefreshCw, Trash2, X, MessageSquare, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../../aws';
import { isLockedPartnerCached, isLockedConversation, loadHiddenChatIds } from '../../services/lockedChats';
import { scheduledMessages, type ScheduledMessage } from '../../services/scheduledMessages';

/**
 * Global scheduled-messages list (Phase 3, Agent B).
 *
 * Lists every scheduled message across all chats (the service's
 * getAll/subscribe), with edit (text + time), reschedule, retry-failed and
 * cancel. The service has no update API, so an edit is cancel + schedule
 * (same conversation, new id) — the old item disappears and the new one
 * takes its place.
 *
 * ROUTE TO ADD in App.tsx (this screen is not wired up — App.tsx is owned
 * by another agent in Phase 3):
 *   import ScheduledMessagesScreen from './screens/scheduled/ScheduledMessagesScreen';
 *   <Route path="/scheduled" element={user ? <ScheduledMessagesScreen /> : <Navigate to="/login" />} />
 *
 * LIMITATION (pre-existing, service-level): nothing is sent while the app
 * is closed — there is no backend worker. See scheduledMessages.ts.
 */

const toInputValue = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatSendAt = (ms: number) => {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  if (isTomorrow) return `Tomorrow, ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Scheduled',
  sending: 'Sending…',
  failed: 'Failed',
  sent: 'Sent',
  cancelled: 'Cancelled',
};

export default function ScheduledMessagesScreen() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editTime, setEditTime] = useState('');
  const [pendingCancel, setPendingCancel] = useState<ScheduledMessage | null>(null);
  // 100M-S3: the lock list must be known before any scheduled text
  // renders — the old label read the sync cache at render time but this
  // screen never loaded it, so on a cold mount a locked item's text
  // showed until something else populated the cache. Same fail-closed
  // gate as the chat list (RC3): skeleton until the locks are known.
  const [locksLoaded, setLocksLoaded] = useState(false);

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  useEffect(() => {
    const unsub = scheduledMessages.subscribe((list) => {
      setItems(list);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (currentUser) {
      loadHiddenChatIds(currentUser.uid).catch(() => {}).finally(() => { if (!cancelled) setLocksLoaded(true); });
    } else {
      setLocksLoaded(true);
    }
    return () => { cancelled = true; };
  }, [currentUser?.uid]);

  /** 100M-S3: an item is locked when EITHER id shape names a locked
      partner — chatId is the route param (partner uid OR conv id) and
      conversationId is always the canonical conv id. The old label
      checked only isLockedPartnerCached(chatId), so a conv-id item
      rendered its text in full. Same combo as SavedMessagesScreen
      (100M-S1): direct check for plain-uid origins, derivation for
      conv-id ones. */
  const isLockedItem = (item: ScheduledMessage): boolean => {
    const uid = currentUser?.uid || '';
    if (!uid) return false;
    return [item.chatId, item.conversationId]
      .filter(Boolean)
      .some((id) => isLockedPartnerCached(id) || isLockedConversation(id, uid));
  };

  // Escape closes the edit sheet / cancel confirm.
  useEffect(() => {
    if (!editingId && !pendingCancel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setEditingId(null);
      setPendingCancel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingId, pendingCancel]);

  const visible = useMemo(
    () => items.filter((i) => i.status !== 'sent' && i.status !== 'cancelled'),
    [items],
  );
  const failedCount = visible.filter((i) => i.status === 'failed').length;

  const openChat = (item: ScheduledMessage) => {
    navigate(`/chat/${item.chatId}${item.isCommunity ? '?type=community' : ''}`);
  };

  const startEdit = (item: ScheduledMessage) => {
    // 100M-S4: the editor used to prefill the full text of a 🔒-masked
    // item. Editing a locked item requires unlocking the chat first —
    // never open the editor with locked text in it.
    if (isLockedItem(item)) {
      showToastMsg('This chat is locked — unlock it to edit this message.');
      return;
    }
    setEditingId(item.id);
    setEditText(item.text);
    setEditTime(toInputValue(item.sendAt));
  };

  const saveEdit = async (item: ScheduledMessage) => {
    const sendAt = new Date(editTime).getTime();
    if (!editText.trim()) {
      showToastMsg('Message text cannot be empty.');
      return;
    }
    if (!Number.isFinite(sendAt) || sendAt <= Date.now() + 5000) {
      showToastMsg('Pick a future time (at least a few seconds from now).');
      return;
    }
    setBusyId(item.id);
    try {
      await scheduledMessages.cancel(item.id);
      await scheduledMessages.schedule({
        conversationId: item.conversationId,
        chatId: item.chatId,
        isCommunity: item.isCommunity,
        text: editText.trim(),
        sendAt,
      });
      setEditingId(null);
      showToastMsg('Scheduled message updated ✓');
    } catch (e: any) {
      showToastMsg(e?.message || 'Could not update the scheduled message.');
    } finally {
      setBusyId(null);
    }
  };

  const retryFailed = async (item: ScheduledMessage) => {
    // The service stops retrying after 3 attempts; a manual retry
    // re-queues the message for one minute from now.
    setBusyId(item.id);
    try {
      await scheduledMessages.cancel(item.id);
      await scheduledMessages.schedule({
        conversationId: item.conversationId,
        chatId: item.chatId,
        isCommunity: item.isCommunity,
        text: item.text,
        sendAt: Date.now() + 60_000,
      });
      showToastMsg('Retrying in about a minute ✓');
    } catch (e: any) {
      showToastMsg(e?.message || 'Could not retry. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  const confirmCancel = async () => {
    if (!pendingCancel) return;
    const item = pendingCancel;
    setPendingCancel(null);
    setBusyId(item.id);
    try {
      await scheduledMessages.cancel(item.id);
      showToastMsg('Scheduled message cancelled');
    } catch {
      showToastMsg('Could not cancel. Try again.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary">
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Back">
            <ArrowLeft className="h-6 w-6" />
          </button>
          <div className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-primary-green" />
            <h1 className="text-xl font-semibold">Scheduled Messages</h1>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed px-1">
          Messages scheduled from any chat, in one place. They send automatically while the app is open — nothing sends while the app is fully closed.
          {failedCount > 0 && (
            <span className="text-amber-600 dark:text-amber-400 font-medium"> {failedCount} failed — retry or cancel {failedCount === 1 ? 'it' : 'them'} below.</span>
          )}
        </p>

        {loading || !locksLoaded ? (
          <div className="space-y-3" aria-label="Loading scheduled messages">
            {[0, 1, 2].map(i => (
              <div key={i} className="bg-panel-light dark:bg-panel-dark rounded-xl p-4 animate-pulse">
                <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-input-dark mb-2" />
                <div className="h-3 w-4/5 rounded bg-gray-200 dark:bg-input-dark" />
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-gray-400 dark:text-text-secondary">
            <CalendarClock className="h-16 w-16 opacity-20" />
            <p className="text-base font-medium">No scheduled messages</p>
            <p className="text-sm text-center max-w-xs">
              Schedule a message from any chat (long-press the send button or the schedule option) and it will show up here.
            </p>
          </div>
        ) : (
          visible.map(item => {
            const isFailed = item.status === 'failed';
            const isEditing = editingId === item.id;
            const overdue = !isFailed && item.sendAt < Date.now();
            return (
              <div
                key={item.id}
                className={`bg-panel-light dark:bg-panel-dark rounded-xl p-4 shadow-sm border ${isFailed ? 'border-amber-500/40' : 'border-gray-200 dark:border-white/5'}`}
              >
                <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${isFailed ? 'bg-amber-500/15 text-amber-600' : item.status === 'sending' ? 'bg-primary-green/15 text-primary-green' : 'bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary'}`}>
                    {STATUS_LABEL[item.status] || item.status}
                  </span>
                  {item.localOnly && (
                    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-600">This device only</span>
                  )}
                  <span className="text-xs text-gray-400 ml-auto flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" /> {formatSendAt(item.sendAt)}
                  </span>
                </div>

                {isFailed && item.lastError && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5 mb-2">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                    <span>Failed after {item.attempts || 3} attempts: {item.lastError}</span>
                  </p>
                )}
                {overdue && (
                  <p className="text-xs text-gray-400 mb-2">Due — will send as soon as the app processes the queue.</p>
                )}

                {isEditing ? (
                  <div className="space-y-3 mt-1">
                    <textarea
                      value={editText}
                      onChange={e => setEditText(e.target.value)}
                      rows={3}
                      maxLength={5000}
                      aria-label="Edit scheduled message"
                      className="w-full bg-gray-50 dark:bg-input-dark rounded-xl px-3 py-2 text-sm text-gray-900 dark:text-text-primary resize-none outline-none focus:ring-2 focus:ring-primary-green"
                    />
                    <label className="block">
                      <span className="text-xs text-gray-500 dark:text-text-secondary">Send at</span>
                      <input
                        type="datetime-local"
                        value={editTime}
                        onChange={e => setEditTime(e.target.value)}
                        aria-label="Reschedule time"
                        className="w-full mt-1 bg-gray-50 dark:bg-input-dark rounded-xl px-3 py-2 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                      />
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveEdit(item)}
                        disabled={busyId === item.id}
                        className="flex-1 py-2.5 bg-green-cta text-white rounded-xl text-sm font-semibold hover:bg-dark-green disabled:opacity-50 transition-all"
                      >
                        {busyId === item.id ? 'Saving…' : 'Save changes'}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="p-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary"
                        aria-label="Cancel editing"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Phase 5 (L-16): a scheduled message to a locked chat
                        shows no text here — only a generic label. The
                        locked set is the sync cache (populated at sign-in). */}
                    <p className="text-[14px] text-gray-900 dark:text-text-primary leading-snug whitespace-pre-wrap break-words">
                      {isLockedItem(item) ? '🔒 Message to a locked chat' : item.text}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                      To: {item.senderName && item.chatId === currentUser?.uid ? 'Saved Messages' : item.chatId ? `chat ${item.chatId.slice(0, 12)}…` : 'chat'}
                      {item.isCommunity ? ' (group/channel)' : ''}
                    </p>
                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                      <button
                        onClick={() => startEdit(item)}
                        disabled={busyId === item.id}
                        className="flex items-center gap-1 text-xs font-semibold text-primary-green bg-primary-green/10 px-3 py-1.5 rounded-full hover:bg-primary-green/20 disabled:opacity-50"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit / Reschedule
                      </button>
                      {isFailed && (
                        <button
                          onClick={() => retryFailed(item)}
                          disabled={busyId === item.id}
                          className="flex items-center gap-1 text-xs font-semibold text-amber-600 bg-amber-500/10 px-3 py-1.5 rounded-full hover:bg-amber-500/20 disabled:opacity-50"
                        >
                          <RefreshCw className="h-3.5 w-3.5" /> Retry
                        </button>
                      )}
                      <button
                        onClick={() => openChat(item)}
                        className="flex items-center gap-1 text-xs font-semibold text-gray-600 dark:text-text-secondary bg-gray-100 dark:bg-input-dark px-3 py-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-panel-dark"
                      >
                        <MessageSquare className="h-3.5 w-3.5" /> Open chat
                      </button>
                      <button
                        onClick={() => setPendingCancel(item)}
                        disabled={busyId === item.id}
                        className="flex items-center gap-1 text-xs font-semibold text-danger-red bg-danger-red/10 px-3 py-1.5 rounded-full hover:bg-danger-red/20 disabled:opacity-50 ml-auto"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* Cancel confirm */}
      {pendingCancel && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingCancel(null)} role="dialog" aria-modal="true" aria-label="Cancel scheduled message">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Cancel this scheduled message?</h3>
            {/* 100M-S4 (same class as the Edit bypass): the confirm used to
                quote the full text of a 🔒-masked item — mask it here too. */}
            <p className="text-sm text-gray-500 dark:text-text-secondary line-clamp-3">“{isLockedItem(pendingCancel) ? '🔒 Message to a locked chat' : pendingCancel.text}”</p>
            <div className="flex gap-3">
              <button onClick={() => setPendingCancel(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Keep it</button>
              <button onClick={confirmCancel} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all">Cancel message</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
