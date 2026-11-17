import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Bookmark, FileText, HardDrive, Image as ImageIcon, MessageSquare, Mic, RefreshCw, Trash2, Users, Video,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../../aws';
import {
  collectStorageItems, deleteStorageItem, deleteStorageItemForMe, ensureStorageCollections, formatBytes, summarizeStorage,
  summarizeStorageByChat,
  STORAGE_CATEGORIES, type StorageCategory, type StorageMediaItem,
} from '../../services/storageUsage';
import { loadHiddenChatIds, lockedConversationIdFor } from '../../services/lockedChats';

const CATEGORY_ICON: Record<StorageCategory, any> = {
  photos: ImageIcon,
  videos: Video,
  files: FileText,
  voice: Mic,
};

const formatDate = (ts: number): string => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

export default function StorageUsageScreen({ onBack }: { onBack?: () => void } = {}) {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const [items, setItems] = useState<StorageMediaItem[]>([]);
  const [filter, setFilter] = useState<'all' | StorageCategory>('all');
  // Wave-2 C3 (Settings #60): per-chat breakdown — tapping a chat row
  // filters the item list below to that chat (the "Manage storage"
  // review, per chat); tapping again clears it.
  const [chatFilter, setChatFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StorageMediaItem | null>(null);
  // Audit #4: confirm state for deleting a RECEIVED item for me only.
  const [pendingDeleteForMe, setPendingDeleteForMe] = useState<StorageMediaItem | null>(null);
  const [toast, setToast] = useState('');
  // S18 (100-more): multi-select + bulk delete for own sends. Audit #4:
  // received media is no longer read-only — a single received item can be
  // deleted for me (local hide; the sender keeps their copy). Bulk
  // delete-for-me for received items is not wired yet (bulk stays
  // own-sends only).
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingBulk, setPendingBulk] = useState<StorageMediaItem[] | null>(null);
  const [deletingBulk, setDeletingBulk] = useState(false);

  const itemKey = (item: StorageMediaItem) => `${item.conversationId}:${item.id}`;

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Phase 5 (L-13): pass the locked conversation ids so their media is
  // excluded from the scan (collectStorageItems also guards itself).
  // S13 (100-more): returns the scan promise so the caller can clear the
  // loading state only when the first scan actually resolves.
  // 100M-H7: ensure the persisted message collections are loaded into
  // the in-memory cache BEFORE collecting — otherwise a fresh load (no
  // chat opened yet) scans zero in-memory channels and reports 0 forever.
  // The ensure is best-effort: if it fails, fall through to the old
  // in-memory-only scan rather than leaving the screen stuck loading.
  const scan = () => {
    return ensureStorageCollections(currentUser?.uid).catch(() => {}).then(() =>
      loadHiddenChatIds(currentUser?.uid).then((ids) => {
        const locked = new Set(ids.map((id) => lockedConversationIdFor(currentUser?.uid || '', id)));
        setItems(collectStorageItems(currentUser?.uid, locked));
      }),
    );
  };

  useEffect(() => {
    // 100M-H7: scan() now ensures the persisted collections first, so
    // the first scan is a real one, not a partial in-memory-only pass.
    // The 2.5 s re-scan stays as a safety net for collections still
    // syncing in the background, and Refresh re-runs the same path.
    // S13: the old code called setLoading(false) synchronously right after
    // kicking scan() off, so the skeleton never showed and "No media here
    // yet" flashed before the first scan populated the list.
    let cancelled = false;
    scan().catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    const t = setTimeout(scan, 2500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Audit #4: delete a RECEIVED item for me only. This hides the message
  // from my chats and this list (same list ChatScreen's delete-for-me
  // uses) — the server doc and the sender's copy are untouched.
  const handleDeleteForMe = () => {
    const item = pendingDeleteForMe;
    if (!item || !currentUser?.uid) return;
    setPendingDeleteForMe(null);
    deleteStorageItemForMe(item, currentUser.uid);
    setItems((prev) => prev.filter((i) => !(i.conversationId === item.conversationId && i.id === item.id)));
    showToastMsg('Deleted for you');
  };

  // Escape closes the delete confirm dialog.
  useEffect(() => {
    if (!pendingDelete && !pendingBulk && !pendingDeleteForMe) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setPendingDelete(null); setPendingBulk(null); setPendingDeleteForMe(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDelete, pendingBulk, pendingDeleteForMe]);

  const summary = useMemo(() => summarizeStorage(items), [items]);
  // Wave-2 C3 (Settings #60): per-chat sizes, largest first.
  const byChat = useMemo(() => summarizeStorageByChat(items, currentUser?.uid), [items, currentUser?.uid]);
  const chatFilterName = chatFilter ? byChat.find((c) => c.conversationId === chatFilter)?.chatName : null;
  const visible = useMemo(
    () => items.filter((i) => (filter === 'all' || i.category === filter) && (!chatFilter || i.conversationId === chatFilter)),
    [items, filter, chatFilter],
  );

  const handleDelete = async () => {
    const item = pendingDelete;
    if (!item) return;
    setPendingDelete(null);
    setDeletingId(item.id);
    try {
      await deleteStorageItem(item);
      setItems((prev) => prev.filter((i) => itemKey(i) !== itemKey(item)));
      showToastMsg('Item deleted');
    } catch {
      showToastMsg('Could not delete that item. Please try again.');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteBulk = async () => {
    const targets = pendingBulk;
    if (!targets || targets.length === 0) return;
    setPendingBulk(null);
    setDeletingBulk(true);
    let ok = 0;
    let fail = 0;
    for (const item of targets) {
      try {
        await deleteStorageItem(item);
        ok++;
      } catch {
        fail++;
      }
    }
    setItems((prev) => prev.filter((i) => !targets.some((t) => t.conversationId === i.conversationId && t.id === i.id)));
    setSelected(new Set());
    setSelecting(false);
    showToastMsg(fail > 0 ? `Deleted ${ok} item${ok === 1 ? '' : 's'}, ${fail} failed` : `Deleted ${ok} item${ok === 1 ? '' : 's'}`);
    setDeletingBulk(false);
  };

  const toggleSelect = (item: StorageMediaItem) => {
    const key = itemKey(item);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const goBack = () => (onBack ? onBack() : navigate(-1));

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary">
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={goBack} aria-label="Back" className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-xl font-medium">Storage usage</h1>
          <button
            onClick={() => { scan().catch(() => {}); }}
            title="Refresh"
            aria-label="Refresh storage list"
            disabled={loading}
            className="ml-auto p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark disabled:opacity-50"
          >
            <RefreshCw className={`h-5 w-5 text-gray-500 dark:text-text-secondary ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Total */}
        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-primary-green/15 flex items-center justify-center text-primary-green">
              <HardDrive className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-text-secondary">Total media in your chats</p>
              {/* Audit #5: the total sums only known-size items — when any
                  item has an unknown size it is a lower bound, so say so
                  instead of printing it as an exact total. */}
              <p className="text-2xl font-bold leading-tight tabular-nums">{summary.totalUnknown > 0 ? `At least ${formatBytes(summary.totalBytes)}` : formatBytes(summary.totalBytes)}</p>
              <p className="text-xs text-gray-500 dark:text-text-secondary">
                {items.length} items, {summary.totalKnown} with known size
                {summary.totalUnknown > 0 && `, ${summary.totalUnknown} older items have unknown size`}
              </p>
            </div>
          </div>
          <div className="flex h-2 mt-4 rounded-full overflow-hidden bg-gray-200 dark:bg-input-dark">
            {STORAGE_CATEGORIES.map(({ id }) => {
              const bytes = summary.byCategory[id].bytes;
              if (!bytes || !summary.totalBytes) return null;
              const pct = (bytes / summary.totalBytes) * 100;
              const color =
                id === 'photos' ? 'bg-sky-500' : id === 'videos' ? 'bg-violet-500' : id === 'files' ? 'bg-amber-500' : 'bg-emerald-500';
              return <div key={id} role="img" aria-label={`${id}: ${formatBytes(bytes)} (${pct.toFixed(0)}% of media)`} className={`${color}`} style={{ width: `${pct}%` }} title={`${id}: ${formatBytes(bytes)}`} />;
            })}
          </div>
        </div>

        {/* Per-category breakdown */}
        <div className="grid grid-cols-2 gap-3">
          {STORAGE_CATEGORIES.map(({ id, label }) => {
            const Icon = CATEGORY_ICON[id];
            const bucket = summary.byCategory[id];
            return (
              <button
                key={id}
                onClick={() => setFilter(filter === id ? 'all' : id)}
                aria-pressed={filter === id}
                className={`text-left bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border transition-colors ${
                  filter === id ? 'border-primary-green ring-1 ring-primary-green' : 'border-gray-200 dark:border-white/5'
                }`}
              >
                <Icon className="h-5 w-5 text-primary-green mb-2" />
                <p className="text-sm font-medium">{label}</p>
                <p className="text-lg font-bold tabular-nums">{formatBytes(bucket.bytes)}</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">
                  {bucket.count} item{bucket.count === 1 ? '' : 's'}
                  {bucket.unknown > 0 ? `, ${bucket.unknown} unknown size` : ''}
                </p>
              </button>
            );
          })}
        </div>

        {/* Wave-2 C3 (Settings #60): per-chat size breakdown — WA shows
            per-chat sizes + a "Manage storage" review. Tapping a chat
            filters the item list below to that chat; tapping again (or
            "Show all chats") clears it. Sizes sum known-size items only,
            like the totals above. */}
        {byChat.length > 0 && (
          <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold">Storage by chat</h2>
              {chatFilter && (
                <button onClick={() => setChatFilter(null)} className="text-xs text-primary-green font-medium py-1 px-1">
                  Show all chats
                </button>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-text-secondary mb-3">
              Tap a chat to review its media below.
            </p>
            <div className="space-y-1">
              {byChat.map((chat) => {
                const pct = summary.totalBytes > 0 ? (chat.bytes / summary.totalBytes) * 100 : 0;
                const active = chatFilter === chat.conversationId;
                const ChatIcon = chat.conversationId.startsWith('saved_') ? Bookmark : chat.isGroup ? Users : MessageSquare;
                return (
                  <button
                    key={chat.conversationId}
                    onClick={() => setChatFilter(active ? null : chat.conversationId)}
                    aria-pressed={active}
                    className={`w-full text-left rounded-xl p-2 transition-colors ${active ? 'bg-primary-green/10 ring-1 ring-primary-green' : 'hover:bg-gray-100 dark:hover:bg-input-dark'}`}
                  >
                    <span className="flex items-center gap-3">
                      <span className="h-9 w-9 rounded-full bg-primary-green/10 flex items-center justify-center text-primary-green flex-shrink-0">
                        <ChatIcon className="h-5 w-5" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-medium truncate">{chat.chatName}</span>
                          <span className="text-sm font-bold tabular-nums flex-shrink-0">{formatBytes(chat.bytes)}</span>
                        </span>
                        <span className="flex items-center gap-2 mt-1">
                          <span className="flex-1 h-1.5 rounded-full overflow-hidden bg-gray-200 dark:bg-input-dark">
                            <span className="block h-full bg-primary-green rounded-full" style={{ width: `${Math.max(pct, chat.bytes > 0 ? 2 : 0)}%` }} />
                          </span>
                          <span className="text-xs text-gray-500 dark:text-text-secondary flex-shrink-0">
                            {chat.count} item{chat.count === 1 ? '' : 's'}
                            {chat.unknown > 0 ? `, ${chat.unknown} unknown size` : ''}
                          </span>
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Item list */}
        <div>
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-text-secondary">
              {chatFilterName || (filter === 'all' ? 'All media' : STORAGE_CATEGORIES.find((c) => c.id === filter)?.label)}
            </h2>
            <div className="flex items-center gap-3">
              {(filter !== 'all' || chatFilter) && (
                <button onClick={() => { setFilter('all'); setChatFilter(null); }} className="text-xs text-primary-green font-medium py-1 px-1">
                  Show all
                </button>
              )}
              {/* Wave-2 C3 (Settings #60): per-chat clear — deletes every
                  stored item for the filtered chat (all categories), via
                  the same bulk-delete confirm dialog as Select mode. */}
              {chatFilter && (
                <button
                  onClick={() => setPendingBulk(items.filter((i) => i.conversationId === chatFilter))}
                  disabled={deletingBulk}
                  className="text-xs text-red-500 font-medium py-1 px-1 disabled:opacity-50"
                >
                  Delete all in this chat
                </button>
              )}
              {visible.some((i) => i.senderId === currentUser?.uid) && (
                <button
                  onClick={() => { setSelecting((s) => !s); setSelected(new Set()); }}
                  className="text-xs text-primary-green font-medium py-1 px-1"
                >
                  {selecting ? 'Cancel' : 'Select'}
                </button>
              )}
            </div>
          </div>
          {selecting && (
            <div className="flex items-center gap-3 mb-2 px-1">
              <button
                onClick={() => setSelected(new Set(visible.filter((i) => i.senderId === currentUser?.uid).map(itemKey)))}
                className="text-xs font-medium text-gray-700 dark:text-text-primary underline"
              >
                Select all
              </button>
              <span className="text-xs text-gray-500 dark:text-text-secondary">{selected.size} selected</span>
              <button
                disabled={selected.size === 0 || deletingBulk}
                onClick={() => setPendingBulk(visible.filter((i) => selected.has(itemKey(i))))}
                className="ml-auto px-3 py-1.5 bg-danger-red text-white text-xs font-semibold rounded-full hover:opacity-90 disabled:opacity-50"
              >
                Delete selected ({selected.size})
              </button>
            </div>
          )}

          {loading ? (
            <div className="space-y-2" role="status" aria-label="Loading storage items">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 bg-panel-light dark:bg-panel-dark rounded-2xl p-3 animate-pulse">
                  <div className="h-12 w-12 rounded-xl bg-gray-200 dark:bg-input-dark" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-2/5 rounded bg-gray-200 dark:bg-input-dark" />
                    <div className="h-3 w-3/5 rounded bg-gray-200 dark:bg-input-dark" />
                  </div>
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-6 text-center border border-gray-200 dark:border-white/5">
              <HardDrive className="h-10 w-10 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
              <p className="font-medium">No media here yet</p>
              <p className="text-sm text-gray-500 dark:text-text-secondary mt-1">
                Photos, videos, files and voice notes you send or receive will show up here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {visible.map((item) => {
                const Icon = CATEGORY_ICON[item.category];
                const mine = item.senderId === currentUser?.uid;
                const deleting = deletingId === item.id;
                return (
                  <div
                    key={`${item.conversationId}:${item.id}`}
                    className="flex items-center gap-3 bg-panel-light dark:bg-panel-dark rounded-2xl p-3 shadow-sm border border-gray-200 dark:border-white/5"
                  >
                    {selecting && mine && (
                      <input
                        type="checkbox"
                        checked={selected.has(itemKey(item))}
                        onChange={() => toggleSelect(item)}
                        aria-label={`Select ${item.fileName}`}
                        className="h-6 w-6 accent-primary-green flex-shrink-0"
                      />
                    )}
                    {item.mediaType === 'image' && (item.mediaUrl.startsWith('http') || item.mediaUrl.startsWith('data:image/')) ? (
                      <img src={item.mediaUrl} alt={item.fileName} className="h-12 w-12 rounded-xl object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-12 w-12 rounded-xl bg-primary-green/10 flex items-center justify-center text-primary-green flex-shrink-0">
                        <Icon className="h-6 w-6" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.fileName}</p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary truncate">
                        {item.senderName}, {formatDate(item.timestamp)}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary">
                        {item.fileSize !== undefined
                          ? `${formatBytes(item.fileSize)}${item.fileSizeExact ? '' : ' (estimated)'}`
                          : 'Size unknown. Sent before sizes were tracked'}
                      </p>
                    </div>
                    {mine ? (
                      <button
                        onClick={() => setPendingDelete(item)}
                        disabled={deleting}
                        title="Delete message and file"
                        aria-label={`Delete ${item.fileName}`}
                        className="p-2 rounded-full text-danger-red hover:bg-danger-red/10 disabled:opacity-50 flex-shrink-0"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => setPendingDeleteForMe(item)}
                        disabled={deleting}
                        title="Delete for me — the sender keeps their copy"
                        aria-label={`Delete ${item.fileName} for me`}
                        className="p-2 rounded-full text-danger-red hover:bg-danger-red/10 disabled:opacity-50 flex-shrink-0"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <p className="text-xs text-gray-400 dark:text-text-secondary leading-relaxed px-1 pb-4">
          Media you sent can be deleted for everyone — deleting removes the message and its file
          for everyone in that chat. Received media can be deleted for you only — it stays with
          the sender. Tap “Select” to delete several of your items at once. Sizes for
          media sent before this update are unknown (only documents stored a size), so totals are
          a lower bound. External GIFs/stickers and expiring statuses are not counted.
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* Delete-for-me confirm (Audit #4, received items) */}
      {pendingDeleteForMe && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingDeleteForMe(null)} role="dialog" aria-modal="true" aria-label="Delete received media item for me">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete “{pendingDeleteForMe.fileName}” for you?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              This removes the message from your chats and this list. The sender keeps their copy. This can&apos;t be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setPendingDeleteForMe(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={handleDeleteForMe} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-opacity">Delete for me</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm (replaces window.confirm) */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingDelete(null)} role="dialog" aria-modal="true" aria-label="Delete media item">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete “{pendingDelete.fileName}”?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              This removes the message and its file for everyone in that chat. This can&apos;t be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setPendingDelete(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={handleDelete} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-opacity">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete confirm */}
      {pendingBulk && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingBulk(null)} role="dialog" aria-modal="true" aria-label="Delete selected media items">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete {pendingBulk.length} item{pendingBulk.length === 1 ? '' : 's'}?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              This removes each message and its file for everyone in that chat. This can&apos;t be undone.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setPendingBulk(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={handleDeleteBulk} disabled={deletingBulk} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
