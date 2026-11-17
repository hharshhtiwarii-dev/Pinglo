import { useState, useEffect, Fragment } from 'react';
import { ArrowLeft, Star, StarOff, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot, deleteDoc, doc, auth, db } from '../../aws';
import { isLockedPartnerCached, loadHiddenChatIds } from '../../services/lockedChats';
import { partnerIdForConversation } from '../../services/realtimeSync';

export default function StarredScreen() {
  const navigate = useNavigate();
  const [starred, setStarred] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [unstarringId, setUnstarringId] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.currentUser) return;
    // Phase 5 (L-09): starred messages from a locked chat never render.
    // The starred doc carries chatId/conversationId (ChatScreen starMsg);
    // the partner is the non-self side of the conversation id.
    // 100M-S2 (same race as SavedMessagesScreen): the lock list must be
    // loaded BEFORE the first snapshot is filtered — the old
    // fire-and-forget load let the snapshot win on a slow mount and the
    // stale render never self-healed. Awaiting keeps the loading
    // skeleton up until the locks are known — fail-closed.
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      await loadHiddenChatIds(auth.currentUser!.uid).catch(() => {});
      if (cancelled) return;
      unsub = onSnapshot(collection(db, 'users', auth.currentUser!.uid, 'starred'), snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() } as any));
        const visible = items.filter((m: any) => {
          const chatId = String(m.chatId || m.originalChatId || '');
          if (chatId && isLockedPartnerCached(chatId)) return false;
          const conv = String(m.conversationId || '');
          if (conv) {
            // #236: derive the DM partner by prefix/suffix — a naive
            // split('_') mis-splits mock uids ('usr_<uuid>'), so starred
            // messages from a locked mock DM rendered. Split check kept
            // as fallback.
            const partner = partnerIdForConversation(conv, auth.currentUser?.uid);
            if (partner && isLockedPartnerCached(partner)) return false;
            const parts = conv.split('_');
            if (parts.some((p: string) => isLockedPartnerCached(p))) return false;
          }
          return true;
        });
        setStarred(visible.sort((a, b) => (Number(b.starredAt) || 0) - (Number(a.starredAt) || 0)));
        setLoading(false);
      });
    })();
    return () => { cancelled = true; unsub?.(); };
  }, []);

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const unstar = async (msg: any) => {
    if (!auth.currentUser || unstarringId) return;
    setUnstarringId(msg.id);
    try {
      // The starred doc id IS the original message id (see ChatScreen starMsg).
      await deleteDoc(doc(db, 'users', auth.currentUser.uid, 'starred', msg.id));
      showToastMsg('Removed from starred');
    } catch {
      showToastMsg('Could not unstar. Try again.');
    } finally {
      setUnstarringId(null);
    }
  };

  const formatTime = (ts: any) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary">
      {/* Header — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Back">
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-xl font-semibold">⭐ Starred Messages</h1>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? (
          <div className="space-y-3" aria-label="Loading starred messages">
            {[0, 1, 2].map(i => (
              <div key={i} className="bg-panel-light dark:bg-panel-dark rounded-xl p-4 animate-pulse">
                <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-input-dark mb-2" />
                <div className="h-3 w-4/5 rounded bg-gray-200 dark:bg-input-dark" />
              </div>
            ))}
          </div>
        ) : starred.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
            <Star className="h-16 w-16 opacity-20" />
            <p className="text-lg font-medium">No starred messages</p>
            <p className="text-sm text-center">Long press a message → Star to save important messages here.</p>
          </div>
        ) : (
          starred.map(msg => (
            <Fragment key={msg.id}>
              <StarredCard
                msg={msg}
                formatTime={formatTime}
                onOpen={() => {
                // Phase 5: even if a locked item slips through the filter,
                // the ChatScreen route guard (P-04) re-asks for the PIN.
                // 100M-H24 (same root as Saved): jump to the starred
                // message in context, highlighted — not the bottom.
                navigate(`/chat/${msg.chatId}`, { state: { jumpToMessageId: msg.originalMessageId || msg.messageId || msg.id } });
              }}
                onUnstar={() => unstar(msg)}
                unstarring={unstarringId === msg.id}
              />
            </Fragment>
          ))
        )}
      </div>

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}

/**
 * One starred message. Subscribes to the original message doc
 * (chats/{conversationId}/messages/{id} — the starred doc id is the
 * original message id) so the card shows the LIVE text/status: if the
 * original was edited, the edited text shows with an "Edited" badge; if
 * it was deleted for everyone, the card says so instead of the stale
 * snapshot. Items without a conversationId (very old stars) just render
 * the stored snapshot.
 */
interface StarredCardProps {
  msg: any;
  formatTime: (ts: any) => string;
  onOpen: () => void;
  onUnstar: () => void;
  unstarring: boolean;
}

function StarredCard({
  msg,
  formatTime,
  onOpen,
  onUnstar,
  unstarring,
}: StarredCardProps) {
  const [live, setLive] = useState<any | null>(null);
  const [liveChecked, setLiveChecked] = useState(false);

  useEffect(() => {
    if (!msg.conversationId || !msg.id) { setLiveChecked(true); return; }
    return onSnapshot(doc(db, 'chats', msg.conversationId, 'messages', msg.id), (snap: any) => {
      setLive(snap.exists() ? snap.data() : null);
      setLiveChecked(true);
    });
  }, [msg.conversationId, msg.id]);

  const deleted = liveChecked && live === null;
  const text = live?.text ?? msg.text;
  const edited = !!live?.edited || !!msg.edited;
  const mediaUrl = live?.mediaUrl ?? msg.mediaUrl;
  const mediaType = live?.mediaType ?? msg.mediaType;

  return (
    <div className="bg-panel-light dark:bg-panel-dark rounded-xl p-4 shadow-sm border border-gray-200 dark:border-white/5">
      <div className="flex items-center gap-2 mb-2">
        <Star className="h-4 w-4 text-yellow-400 fill-yellow-400 flex-shrink-0" />
        <span className="text-xs font-medium text-gray-500 dark:text-text-secondary">{msg.senderName}</span>
        <span className="text-xs text-gray-400 dark:text-text-secondary ml-auto">{formatTime(msg.timestamp)}</span>
        <button
          onClick={onUnstar}
          disabled={unstarring}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-danger-red disabled:opacity-50 flex-shrink-0"
          aria-label="Remove from starred"
          title="Unstar"
        >
          <StarOff className="h-4 w-4" />
          <span className="hidden sm:inline">Unstar</span>
        </button>
      </div>
      <div className="cursor-pointer" onClick={onOpen} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
        {deleted ? (
          <p className="text-[14px] text-gray-400 italic">🚫 This message was deleted</p>
        ) : (
          <>
            {mediaUrl && mediaType === 'image' && (
              <img src={mediaUrl} alt="" className="rounded-lg mb-2 max-w-xs h-24 object-cover" />
            )}
            {text && <p className="text-[14px] text-gray-900 dark:text-text-primary leading-snug">{text}</p>}
            {edited && (
              <p className="text-[11px] text-gray-400 mt-1 flex items-center gap-1">
                <Pencil className="h-3 w-3" /> Edited
              </p>
            )}
          </>
        )}
        <p className="text-xs text-primary-green mt-2">Tap to open chat →</p>
      </div>
    </div>
  );
}
