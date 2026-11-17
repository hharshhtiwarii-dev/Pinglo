/**
 * Storage usage — collects the current user's chat media from the existing
 * local database cache (the same `db.getCollectionDocs` / `db.getAllChatChannels`
 * helpers ChatListScreen and AdminDashboardScreen already use) and groups it
 * into Photos / Videos / Files / Voice notes.
 *
 * Accuracy notes (shown in the UI too):
 * - Only messages sent AFTER the Phase 2 storage patch carry `fileSize` for
 *   every media type. Older image/video/voice messages only stored `fileSize`
 *   for documents, so their size is "unknown" unless the media is a small
 *   local Data URL, whose size can be estimated from its base64 length.
 * - External media (e.g. GIFs/stickers hosted elsewhere) is not the user's
 *   S3 storage, so it is excluded.
 * - Statuses are excluded: they expire and are not chat storage.
 * - Totals cover chats already loaded into the local cache. The screen
 *   re-scans a couple of seconds after opening (collections load in the
 *   background) and has a manual Refresh button.
 * - 100M-H7: before scanning, `ensureStorageCollections()` loads the
 *   persisted message collections from IndexedDB (via `db.ensure`), so
 *   the first open — with nothing yet in memory — sees the same media
 *   as a warm run. Without it the scan only ever saw in-memory channels
 *   and a fresh load reported 0 forever.
 */

import { db, doc, deleteDoc } from '../aws';
import { deleteChatMedia, isLocalMediaUrl } from '../aws/storage';
import { isLockedConversation, isLockedPartnerCached } from './lockedChats';

export type StorageCategory = 'photos' | 'videos' | 'files' | 'voice';

export interface StorageMediaItem {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  mediaType: 'image' | 'video' | 'audio' | 'file';
  category: StorageCategory;
  fileName: string;
  /** Bytes, when known (stored on the message, or estimated for Data URLs). */
  fileSize?: number;
  /** True when fileSize is exact, false when estimated from a Data URL. */
  fileSizeExact: boolean;
  mediaUrl: string;
  text?: string;
  duration?: number;
}

export interface StorageSummary {
  totalBytes: number;
  totalKnown: number;
  totalUnknown: number;
  byCategory: Record<StorageCategory, { bytes: number; count: number; unknown: number }>;
}

export const STORAGE_CATEGORIES: { id: StorageCategory; label: string }[] = [
  { id: 'photos', label: 'Photos' },
  { id: 'videos', label: 'Videos' },
  { id: 'files', label: 'Files' },
  { id: 'voice', label: 'Voice notes' },
];

const categoryOf = (mediaType: string): StorageCategory | null => {
  if (mediaType === 'image') return 'photos';
  if (mediaType === 'video') return 'videos';
  if (mediaType === 'audio') return 'voice';
  if (mediaType === 'file') return 'files';
  return null;
};

/** Human-readable size, e.g. "1.2 MB". Mirrors ChatScreen's formatFileSize. */
export const formatBytes = (bytes?: number): string => {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};

/** Estimate the byte size of a `data:...;base64,...` URL from its payload length. */
export const estimateDataUrlSize = (url: string): number | undefined => {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const payload = url.slice(comma + 1);
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

/**
 * True for media that lives in this app's storage: an S3 object under
 * `media/...` (the path `uploadChatMedia` writes), a local Data URL
 * from the no-S3 fallback, or a `local-media:<id>` reference into the
 * IndexedDB blob store (100M-H6 voice notes/statuses — voice messages
 * carry `fileSize`, so their size is exact). Anything else (e.g. a GIF
 * hosted elsewhere) is not counted — deleting it would not free our
 * storage.
 */
const isOwnStorageUrl = (url: string): boolean =>
  url.startsWith('data:') || url.includes('/media/') || isLocalMediaUrl(url);

const displayNameOf = (msg: any, mediaType: string): string => {
  if (msg.fileName) return String(msg.fileName);
  if (mediaType === 'audio') {
    return msg.duration ? `Voice note (${msg.duration}s)` : 'Voice note';
  }
  if (mediaType === 'image') return 'Photo';
  if (mediaType === 'video') return 'Video';
  return 'File';
};

/**
 * Max concurrent `db.ensure()` calls while pre-loading message
 * collections. Each ensure() restores from disk, runs a rev probe (and a
 * full fetchAll when changed) and — with AWS configured — opens a live
 * AppSync subscription, so firing one per chat with no cap (200 chats →
 * 200 concurrent ensures) spikes network, subscriptions and CPU on first
 * open. Batches of 5 keep the scan fast without the spike.
 */
export const STORAGE_ENSURE_CONCURRENCY = 5;

/**
 * 100M-H7: load every persisted chat messages collection into the
 * in-memory cache before a scan runs. `collectStorageItems` is sync and
 * only sees in-memory channels (`db.getAllChatChannels()`), so on a fresh
 * load — direct to Storage Usage without opening a chat first — it found
 * nothing and the screen showed 0 forever (re-scan and Refresh re-ran the
 * same in-memory-only scan). This awaits `db.ensure('chats')` so the chat
 * list is known, unions the live channels with the conversation ids whose
 * message collections exist on disk (`db.listPersistedChatChannels()` —
 * covers chats whose `chats` doc never loaded), then ensures each
 * `chats/<id>/messages` collection (restores from IndexedDB in mock mode;
 * `ensure` is a no-op for already-loaded collections). Callers must await
 * this before `collectStorageItems`.
 *
 * Audit follow-ups: ensures run in batches of STORAGE_ENSURE_CONCURRENCY
 * (unbounded Promise.all spiked 200 concurrent ensures on large accounts),
 * and persisted ids with no doc in the `chats` collection are skipped as
 * stale (chat deleted on another device) — see the guard below.
 */
export const ensureStorageCollections = async (currentUserId?: string): Promise<void> => {
  await db.ensure('chats');
  const channels = new Set<string>(db.getAllChatChannels());
  // Freshness: a persisted `chats/<id>/messages` collection whose chat no
  // longer exists (deleted on another device) is stale — ensuring and
  // scanning it surfaces media for a chat that is gone. Skip persisted ids
  // with no doc in the (just-ensured) `chats` collection. Guard: only when
  // the chats collection actually has entries — an empty or failed chats
  // load must never wipe the scan back to 0 (the exact H7 bug). Live
  // in-memory channels are untouched: they are already loaded, so ensure
  // is a no-op for them, and collectStorageItems still reads them.
  const knownChats = new Set(db.getCollectionDocs('chats').map((d: any) => String(d.id)));
  let stale = 0;
  for (const id of await db.listPersistedChatChannels()) {
    if (knownChats.size > 0 && !knownChats.has(id)) {
      stale++;
      continue;
    }
    channels.add(id);
  }
  if (stale > 0) {
    console.warn(`[storageUsage] ensureStorageCollections: skipped ${stale} stale persisted chat(s) with no chats doc`);
  }
  if (currentUserId) channels.add(`saved_${currentUserId}`);
  const ids = [...channels];
  for (let i = 0; i < ids.length; i += STORAGE_ENSURE_CONCURRENCY) {
    await Promise.all(
      ids.slice(i, i + STORAGE_ENSURE_CONCURRENCY).map((id) => db.ensure(`chats/${id}/messages`)),
    );
  }
};

export const collectStorageItems = (
  currentUserId?: string,
  lockedConversationIds?: Set<string>,
): StorageMediaItem[] => {
  const channels = new Set<string>(db.getAllChatChannels());
  // Phase 5 (L-13): locked chats' media never appears in Storage Usage —
  // no thumbnails, file names, sender names or sizes.
  if (lockedConversationIds) {
    for (const id of lockedConversationIds) channels.delete(id);
  }
  // Saved messages live in `chats/saved_<uid>/messages`, which
  // getAllChatChannels() deliberately skips — include them explicitly.
  if (currentUserId) channels.add(`saved_${currentUserId}`);

  const items: StorageMediaItem[] = [];
  for (const conversationId of channels) {
    // Phase 5 (L-13): defence in depth — skip a locked channel even if
    // the caller forgot to pass the exclusion set.
    if (currentUserId && isLockedConversation(conversationId, currentUserId)) continue;
    let messages: any[];
    try {
      messages = db.getCollectionDocs(`chats/${conversationId}/messages`);
    } catch {
      continue;
    }
    // Audit #4: read the delete-for-me list once per channel, not per message.
    const deletedForMe = currentUserId ? new Set(readDeletedForMeIds(currentUserId, conversationId)) : null;
    for (const msg of messages) {
      // 100M-S5: a saved copy's origin chat was never consulted — the
      // saved_ channel id itself is never locked, so saved media from a
      // locked chat rendered here even after /saved hid the copy itself.
      // Skip saved items whose origin (originalChatId/chatId) is locked,
      // same origin logic /saved uses (100M-S1: partner-uid or conv-id).
      if (conversationId.startsWith('saved_') && currentUserId) {
        const origin = String(msg.originalChatId || msg.chatId || '');
        if (origin && (lockedConversationIds?.has(origin) || isLockedPartnerCached(origin) || isLockedConversation(origin, currentUserId))) continue;
      }
      if (!msg?.mediaUrl || typeof msg.mediaUrl !== 'string') continue;
      const category = categoryOf(msg.mediaType);
      if (!category) continue;
      if (!isOwnStorageUrl(msg.mediaUrl)) continue;
      // Audit #4: a message deleted for me (from the chat, or from this
      // screen for a received item) must not resurface on the next scan.
      if (deletedForMe?.has(String(msg.id))) continue;

      const storedSize =
        typeof msg.fileSize === 'number' && msg.fileSize > 0 ? msg.fileSize : undefined;
      const estimatedSize = storedSize === undefined ? estimateDataUrlSize(msg.mediaUrl) : undefined;
      items.push({
        id: String(msg.id),
        conversationId,
        senderId: String(msg.senderId || ''),
        senderName: String(msg.senderName || 'Unknown'),
        timestamp: Number(msg.timestamp) || 0,
        mediaType: msg.mediaType,
        category,
        fileName: displayNameOf(msg, msg.mediaType),
        fileSize: storedSize ?? estimatedSize,
        fileSizeExact: storedSize !== undefined,
        mediaUrl: msg.mediaUrl,
        text: msg.text,
        duration: typeof msg.duration === 'number' ? msg.duration : undefined,
      });
    }
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
};

export const summarizeStorage = (items: StorageMediaItem[]): StorageSummary => {
  const byCategory: StorageSummary['byCategory'] = {
    photos: { bytes: 0, count: 0, unknown: 0 },
    videos: { bytes: 0, count: 0, unknown: 0 },
    files: { bytes: 0, count: 0, unknown: 0 },
    voice: { bytes: 0, count: 0, unknown: 0 },
  };
  let totalBytes = 0;
  let totalUnknown = 0;
  for (const item of items) {
    const bucket = byCategory[item.category];
    bucket.count += 1;
    if (item.fileSize !== undefined) {
      bucket.bytes += item.fileSize;
      totalBytes += item.fileSize;
    } else {
      bucket.unknown += 1;
      totalUnknown += 1;
    }
  }
  return { totalBytes, totalKnown: items.length - totalUnknown, totalUnknown, byCategory };
};

/**
 * Wave-2 C3 (Settings #60 — per-chat storage breakdown): WA's storage
 * screen shows per-chat sizes + a "Manage storage" review. Group the
 * same scanned items by conversation, largest first, with the chat name
 * resolved the same way the chat list does (chats doc: group name, or
 * the peer's displayName / username / email prefix). Chats with no doc
 * in the local cache (e.g. a DM whose `chats` doc never loaded) fall
 * back to the most frequent other sender's name in that chat's items,
 * then to "Chat". `saved_<uid>` is "Saved messages". `bytes` sums known
 * sizes only; `unknown` counts items without a size, like the totals.
 */
export interface StorageChatUsage {
  conversationId: string;
  chatName: string;
  isGroup: boolean;
  bytes: number;
  count: number;
  unknown: number;
}

export const summarizeStorageByChat = (
  items: StorageMediaItem[],
  currentUserId?: string,
): StorageChatUsage[] => {
  const chatDocs = new Map<string, any>();
  try {
    for (const d of db.getCollectionDocs('chats') || []) {
      chatDocs.set(String((d as any).id || ''), d);
    }
  } catch {
    // No cached chat docs — every chat falls back to sender names.
  }
  const byChat = new Map<string, { bytes: number; count: number; unknown: number; senders: Map<string, number> }>();
  for (const item of items) {
    let bucket = byChat.get(item.conversationId);
    if (!bucket) {
      bucket = { bytes: 0, count: 0, unknown: 0, senders: new Map() };
      byChat.set(item.conversationId, bucket);
    }
    bucket.count += 1;
    if (item.fileSize !== undefined) bucket.bytes += item.fileSize;
    else bucket.unknown += 1;
    if (item.senderId && item.senderId !== currentUserId && item.senderName && item.senderName !== 'Unknown') {
      bucket.senders.set(item.senderName, (bucket.senders.get(item.senderName) || 0) + 1);
    }
  }
  const out: StorageChatUsage[] = [];
  for (const [conversationId, bucket] of byChat) {
    let chatName = '';
    let isGroup = false;
    if (conversationId.startsWith('saved_')) {
      chatName = 'Saved messages';
    } else {
      const doc = chatDocs.get(conversationId) as any;
      if (doc) {
        isGroup = Boolean(doc.isGroup);
        if (isGroup) chatName = (doc.name || '').trim() || 'Group';
        else {
          chatName = (doc.displayName || doc.username || '').trim() ||
            (doc.email ? String(doc.email).split('@')[0] : '') || 'DT User';
        }
      }
    }
    if (!chatName) {
      // Fallback: the peer's name as seen on their messages in this chat.
      let best = '';
      let bestCount = 0;
      for (const [name, n] of bucket.senders) {
        if (n > bestCount) { best = name; bestCount = n; }
      }
      chatName = best || 'Chat';
    }
    out.push({ conversationId, chatName, isGroup, bytes: bucket.bytes, count: bucket.count, unknown: bucket.unknown });
  }
  out.sort((a, b) => b.bytes - a.bytes || b.count - a.count);
  return out;
};

/**
 * Audit #4 — delete-for-me for received media.
 *
 * Deleting a received message for everyone is impossible (the sender owns
 * it), so received items use the SAME delete-for-me list ChatScreen
 * already honours: `dt_deleted_for_me_<uid>_<conversationId>` in
 * localStorage. Recording the id here hides the message from the chat
 * AND from Storage Usage (collectStorageItems skips listed ids), and
 * touches neither the server doc nor the S3 object — the sender keeps
 * their copy. Honest limit: this is a hide, like chat delete-for-me —
 * the cached message bytes stay in local IndexedDB until the cache
 * evicts the doc; the Storage Usage list and totals drop immediately.
 * For a `saved_<uid>` channel the key uses the saved channel id, so
 * removing a saved copy never hides the original chat message.
 */
export const deletedForMeKey = (userId: string, conversationId: string): string =>
  `dt_deleted_for_me_${userId}_${conversationId}`;

export const readDeletedForMeIds = (userId: string, conversationId: string): string[] => {
  try {
    const stored = localStorage.getItem(deletedForMeKey(userId, conversationId));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Hide one item for this user only — no server doc or S3 object is touched. */
export const deleteStorageItemForMe = (item: StorageMediaItem, userId: string): void => {
  if (!userId) return;
  const key = deletedForMeKey(userId, item.conversationId);
  const next = readDeletedForMeIds(userId, item.conversationId);
  if (!next.includes(item.id)) next.push(item.id);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch (e) {
    console.warn('[storageUsage] could not save deleted-for-me list:', e);
  }
};

/**
 * Delete one media item: remove the message document first, then best-effort
 * delete the S3 object (see `deleteChatMedia` — it no-ops for Data URLs and
 * external URLs). A failed S3 delete must not resurrect the message, and a
 * failed message delete must not orphan-delete the file, hence this order.
 */
export const deleteStorageItem = async (item: StorageMediaItem): Promise<void> => {
  await deleteDoc(doc(db, 'chats', item.conversationId, 'messages', item.id));
  try {
    await deleteChatMedia(item.mediaUrl);
  } catch (err) {
    console.warn('Storage item message deleted, but S3 object could not be removed:', err);
  }
};
