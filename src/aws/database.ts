/**
 * AWS Data Layer (Firestore-compatible API) backed by AppSync + DynamoDB.
 *
 * - Every read and write goes to the cloud, so data is shared across users and devices.
 * - Realtime updates come from AppSync subscriptions (one per collection).
 * - A per-collection in-memory cache keeps the synchronous helpers used by screens working.
 */

import { generateClient } from 'aws-amplify/api';
import { isAwsConfigured } from './config';
import {
  enqueueOfflineOp,
  registerOfflineHandler,
  flushOfflineQueue,
  startOfflineQueue,
  dropQueuedOpsForDoc,
  PermanentQueueError,
  MAX_MESSAGE_CHARS,
} from '../services/offlineQueue';
// E2EE send/receive wiring (Worker E2): message docs in
// `chats/{chatId}/messages` are encrypted before they are stored/sent and
// decrypted before they reach snapshot listeners / getCollectionDocs.
// The stored cache always holds CIPHERTEXT (server truth); plaintext
// exists only in memory (decrypt memo + delivered snapshots).
import {
  chatIdFromMessagesCollection,
  decryptMessageDocForRead,
  encryptMessageDocForStore,
  encryptableContentChanged,
  isGroupChat,
  isGroupKeyExchangeDoc,
  isKeyExchangeDoc,
  isMessagesCollection,
} from '../services/e2eeChat';
// Worker A: peer-key generation — a memoized decrypt result is only valid
// for the key generation it was decrypted with (see decryptMemo below).
// W16 (#183): group sender keys have their own generation (a newly
// stored group sender key heals previously undecryptable group messages).
import {
  getGroupKeyGeneration,
  getPeerKeyGeneration,
  onGroupKeyChanged,
  onPeerKeyChanged,
} from '../services/e2ee/keyExchange';

// ── IndexedDB cache persistence (Phase 3, Agent C) ──────────────────────
// The in-memory cache used to vanish on reload (drafts/messages gone until
// the next fetch). Collections are now persisted per-collection to
// IndexedDB on write (debounced, best-effort) and restored on load, so a
// reload shows the last known data immediately. Every IDB call is wrapped
// in try/catch — storage failure must never break the app.
const IDB_DB_NAME = 'pinglo-cache';
const IDB_STORE = 'collections';
let idbPromise: Promise<IDBDatabase | null> | null = null;

function openCacheDb(): Promise<IDBDatabase | null> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(IDB_DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) {
            req.result.createObjectStore(IDB_STORE);
          }
        } catch { /* intentionally ignored */}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

/**
 * One shared IndexedDB transaction for the `collections` store. The four
 * call sites below (get / put / clear / getAllKeys) used to inline the
 * same open-transaction boilerplate with slightly different error
 * handling, so a fix to one copy never reached the others. `fn` runs
 * against the store and resolves the value (`store.transaction` is the
 * transaction, for oncomplete wiring); any failure — no IndexedDB, a
 * thrown transaction open, a rejected inner promise — resolves `fallback`
 * instead of throwing, so storage failure never breaks the app. Callers
 * that must surface a failure (idbPut's W5b R23 warn) pass `onUnavailable`.
 */
async function withCacheStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
  fallback: T,
  onUnavailable?: () => void,
): Promise<T> {
  try {
    const dbConn = await openCacheDb();
    if (!dbConn) {
      onUnavailable?.();
      return fallback;
    }
    try {
      return await fn(dbConn.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
    } catch {
      return fallback;
    }
  } catch {
    return fallback;
  }
}

/** Raw persisted record for one collection: docs + (since #139) their
 * server revisions. Old records carry no `revs` — readers treat that as
 * "revisions unknown" and the probe stays conservative (full fetch once,
 * which then persists revs). */
async function idbGetRecord(col: string): Promise<{ docs?: any; revs?: any; savedAt?: number } | null> {
  return withCacheStore(
    'readonly',
    (store) =>
      new Promise<{ docs?: any; revs?: any; savedAt?: number } | null>((resolve) => {
        const req = store.get(col);
        req.onsuccess = () => {
          const v = req.result;
          resolve(v && typeof v === 'object' ? v : null);
        };
        req.onerror = () => resolve(null);
      }),
    null,
  );
}

async function idbGet(col: string): Promise<Array<[string, any]> | null> {
  const rec = await idbGetRecord(col);
  return rec && Array.isArray(rec.docs) ? rec.docs : null;
}

/**
 * #139 (W30h): server `updatedAt` revisions for a collection, persisted
 * alongside the docs. Without them the rev probe can never prove an
 * IDB-restored collection unchanged (restored docs have no docRev), so
 * every cold start paid a full fetch. Returns null for a record written
 * before this landed (no `revs` key) — the caller then falls back to
 * the old behaviour (full fetch once, which persists revs for next time).
 */
async function idbGetRevs(col: string): Promise<Array<[string, any]> | null> {
  const rec = await idbGetRecord(col);
  return rec && Array.isArray(rec.revs) ? rec.revs : null;
}

async function idbPut(col: string, docs: Array<[string, any]>, revs?: Array<[string, any]> | null): Promise<void> {
  await withCacheStore(
    'readwrite',
    (store) =>
      new Promise<void>((resolve) => {
        try {
          store.put({ docs, revs: revs ?? null, savedAt: Date.now() }, col);
          store.transaction.oncomplete = () => resolve();
          store.transaction.onerror = () => {
            console.warn(`[db] idbPut(${col}): transaction error — ${docs.length} docs NOT persisted`);
            resolve();
          };
        } catch (err) {
          console.warn(`[db] idbPut(${col}): threw — ${docs.length} docs NOT persisted`, err);
          resolve();
        }
      }),
    undefined,
    () => {
      // W5b R23: a failed persist used to vanish silently (every catch
      // resolved) — a lost write then looked like a logic bug elsewhere.
      // Surface it so a persist failure is diagnosable, never silent.
      console.warn(`[db] idbPut(${col}): no IndexedDB connection — ${docs.length} docs NOT persisted`);
    },
  );
}

async function idbClearAll(): Promise<void> {
  await withCacheStore(
    'readwrite',
    (store) =>
      new Promise<void>((resolve) => {
        store.clear();
        store.transaction.oncomplete = () => resolve();
        store.transaction.onerror = () => resolve();
      }),
    undefined,
  );
}

const persistTimers = new Map<string, any>();
/** Collections with a debounced IndexedDB write still pending, kept so a
 * pagehide / backgrounding can flush them immediately (see below). */
const pendingPersistDocs = new Map<string, Map<string, any>>();
/** #139 (W30h): server revisions for the pending persist above — kept in
 * lockstep (set/deleted together) so a flushed record never carries docs
 * newer than its revs. Holds the same live-map reference as
 * pendingPersistDocs (so it also survives db.reset(), same as the docs). */
const pendingPersistRevs = new Map<string, Map<string, any>>();
function schedulePersist(col: string, docs: Map<string, any>, revs: Map<string, any>): void {
  try {
    clearTimeout(persistTimers.get(col));
    pendingPersistDocs.set(col, docs);
    pendingPersistRevs.set(col, revs);
    persistTimers.set(
      col,
      setTimeout(() => {
        persistTimers.delete(col);
        pendingPersistDocs.delete(col);
        pendingPersistRevs.delete(col);
        void idbPut(col, Array.from(docs.entries()), Array.from(revs.entries()));
      }, 1000),
    );
  } catch { /* intentionally ignored */}
}

/**
 * Immediate, awaitable persist for writes that must not wait out the 1 s
 * debounce (see putRaw): user-profile docs and key-exchange protocol
 * docs. The debounce exists to coalesce bursts, but a kx/users write
 * followed within 1 s by a navigation, sign-out or backgrounding lost
 * the write entirely — the pagehide flush clears the timer and fires an
 * abortable put, and the sign-out/reset flushes run in a fresh context
 * that no longer holds the pending entry (proven by probe-w5b-r15/r22:
 * skeletal users docs; probe-w5b-r16/r23/r26: the key-ack written by
 * Bob's list runner never reached disk, so the §10.1 "ack via list"
 * check could never pass in mock mode). These writes are rare (signup,
 * login, heartbeat, one ack/announce per chat setup), so one awaited
 * IndexedDB put each costs nothing measurable — and the caller (the kx
 * runner awaits writeKxDoc) only records the ack as sent once it is
 * durable. Regular message writes keep the debounce.
 */
async function persistNow(col: string, docs: Map<string, any>, revs: Map<string, any>): Promise<void> {
  try {
    clearTimeout(persistTimers.get(col));
    persistTimers.delete(col);
    pendingPersistDocs.delete(col);
    pendingPersistRevs.delete(col);
  } catch { /* intentionally ignored */}
  await idbPut(col, Array.from(docs.entries()), Array.from(revs.entries()));
}

/**
 * Worker B (overnight round 2, C18 hardening): write every pending
 * debounced persist NOW instead of waiting out the 1s timer. A reload,
 * tab close or phone backgrounding inside that window used to lose the
 * write entirely — the in-memory message showed fine, but IndexedDB
 * never got it, so the message was gone after the reload. Called from
 * `pagehide` (unload/reload/navigation) and from `visibilitychange`
 * → hidden (mobile backgrounding / app switch), where a pending timer
 * may never fire. Best-effort: the write is kicked off synchronously
 * and the timer is cleared so it cannot double-write afterwards.
 * Nothing here changes what is persisted, only when.
 */
export function flushPendingPersists(): void {
  try {
    for (const [col, docs] of [...pendingPersistDocs.entries()]) {
      clearTimeout(persistTimers.get(col));
      persistTimers.delete(col);
      pendingPersistDocs.delete(col);
      const revs = pendingPersistRevs.get(col);
      pendingPersistRevs.delete(col);
      void idbPut(col, Array.from(docs.entries()), revs ? Array.from(revs.entries()) : null);
    }
  } catch { /* intentionally ignored */}
}

/**
 * Awaitable twin of flushPendingPersists: same flush, but the caller does
 * not continue until every IndexedDB transaction has COMMITTED
 * (idbPut resolves on tx.oncomplete). The fire-and-forget twin is NOT
 * enough before dropping in-memory state: a read racing the uncommitted
 * put (e.g. clearPushToken's readDoc right after db.reset()) would see
 * the pre-flush disk and merge onto an empty base. Used by db.reset().
 */
export async function flushPendingPersistsAsync(): Promise<void> {
  const puts: Promise<void>[] = [];
  try {
    for (const [col, docs] of [...pendingPersistDocs.entries()]) {
      clearTimeout(persistTimers.get(col));
      persistTimers.delete(col);
      pendingPersistDocs.delete(col);
      const revs = pendingPersistRevs.get(col);
      pendingPersistRevs.delete(col);
      puts.push(idbPut(col, Array.from(docs.entries()), revs ? Array.from(revs.entries()) : null));
    }
  } catch { /* intentionally ignored */}
  await Promise.all(puts);
}

try {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => flushPendingPersists());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingPersists();
    });
  }
} catch { /* intentionally ignored */}

type ListenerCallback = (snapshot: any) => void;

const GET_DOC = `query GetDoc($col: String!, $id: ID!) {
  getDoc(col: $col, id: $id) { col id data updatedAt }
}`;

const LIST_DOCS = `query ListDocs($col: String!, $limit: Int, $nextToken: String) {
  listDocs(col: $col, limit: $limit, nextToken: $nextToken) {
    items { col id data updatedAt }
    nextToken
  }
}`;

// AUDIT-2 C1 (3A §4): metadata-only revision probe. This selects a
// SUBSET of the fields of the SAME `listDocs` field the full query
// uses (`id` + `updatedAt`, no `data`), so it needs no schema or
// resolver change — AppSync returns only the requested fields. The
// resolver still reads the items server-side (DynamoDB read units
// unchanged), but the TRANSFER per 3 s tick drops from every doc's
// full data to a few dozen bytes per doc. #139 (W30h): when revs differ,
// the sync is targeted (one GET_DOC per changed doc, syncFromRevs) and
// fetchAll runs only when the changed set is bigger than a full fetch
// costs — the saving is the idle tick AND the cold start.
const LIST_DOC_REVS = `query ListDocRevs($col: String!, $limit: Int, $nextToken: String) {
  listDocs(col: $col, limit: $limit, nextToken: $nextToken) {
    items { id updatedAt }
    nextToken
  }
}`;

const PUT_DOC = `mutation PutDoc($col: String!, $id: ID!, $data: AWSJSON!) {
  putDoc(col: $col, id: $id, data: $data) { col id data updatedAt }
}`;

const DELETE_DOC = `mutation DeleteDoc($col: String!, $id: ID!) {
  deleteDoc(col: $col, id: $id) { col id data updatedAt }
}`;

const ON_DOC_CHANGED = `subscription OnDocChanged($col: String!) {
  onDocChanged(col: $col) { col id data updatedAt }
}`;

let _client: any = null;
const gql = (): any => {
  if (!_client) _client = generateClient();
  return _client;
};

const parseData = (raw: any): any => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
};

/** Doc path (even segments) → parent collection + id. Collection path (odd) → itself. */
const splitPath = (path: string) => {
  const segs = path.split('/').filter(Boolean);
  if (segs.length % 2 === 0) {
    return { col: segs.slice(0, -1).join('/'), id: segs[segs.length - 1] || '', isDoc: true };
  }
  return { col: segs.join('/'), id: '', isDoc: false };
};

interface ColState {
  docs: Map<string, any>;
  loaded: boolean;
  sub: { unsubscribe: () => void } | null;
  retryTimer: any;
  poll: any;
  subFailures?: number;
  /** #147 (W30g): silent-catch counters — poll-tick, disk-restore and
   * single-doc-refresh failures. Surfaced via getSubscriptionHealth();
   * logging only, never changes retry behaviour. */
  pollFailures?: number;
  restoreFailures?: number;
  refreshDocFailures?: number;
  /** #138 (W30i): ms timestamp of the last ensure()/subscribe() of this
   * collection — the LRU key for the idle-docs prune
   * (maybePruneDocsCache). 0 = never used since this session started. */
  lastUsedAt: number;
  /** id → time of the last local write or realtime event for that doc */
  touched: Map<string, number>;
  /** id → server `updatedAt` for that doc (from listDocs / onDocChanged).
   * Used by the poll to detect per-doc changes without stringifying the
   * whole collection. Absent when the server did not report one (e.g.
   * restored-from-IndexedDB docs, or a locally-written doc whose server
   * revision is not known yet) — those docs fall back to a per-doc
   * comparison in fetchAll. */
  docRev: Map<string, any>;
  /** When the live subscription last dropped (null = healthy / never dropped). */
  subDroppedAt: number | null;
  /**
   * AUDIT-2 B14: ids hard-deleted locally whose DELETE has not been
   * confirmed by the server yet (id → deletedAt). The 3s poll's server
   * snapshot must not re-add them: the server still holds the doc until
   * the DELETE lands. Cleared when the DELETE succeeds, when the doc is
   * written again locally, or when a live event says it exists.
   * In-memory only; a reload loses it, but the queued 'delete' op in the
   * offline outbox retries the DELETE on start.
   */
  tombstones: Map<string, number>;
  /**
   * W7 (#79/#146): true once this collection's IndexedDB cache has been
   * read into the in-memory map (or the collection was loaded another
   * way). A write to a never-restored collection used to persist a
   * partial map over the full persisted one — saving one message wiped
   * every previously saved message. putRaw/remove restore first (see
   * restorePersisted) and set this so the restore runs at most once.
   */
  restored: boolean;
}

interface Listener {
  path: string;
  col: string;
  id: string;
  isDoc: boolean;
  filters: any[];
  cb: ListenerCallback;
}

/**
 * AUDIT-2 D6: total-order comparator for orderBy values. The old code did
 * `Number(v) || v || 0` and then `>` — on a number/string mix it was not
 * antisymmetric (Node probe: cmp('abc',5) === -1 AND cmp(5,'abc') === -1),
 * so the same set sorted differently by input order. Rule, deterministic:
 * null/undefined first, then numbers (numeric strings compare numerically
 * with numbers, so legacy string timestamps sort with numeric ones),
 * then strings (code-unit order), then booleans (false < true), then
 * anything else (equal — stable sort keeps input order).
 */
export function compareOrderValues(a: unknown, b: unknown): number {
  const rank = (v: unknown): number => {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return 1;
    if (typeof v === 'string') {
      const t = v.trim();
      return t !== '' && !Number.isNaN(Number(t)) ? 1 : 2;
    }
    if (typeof v === 'boolean') return 3;
    return 4;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 0 || ra === 4) return 0;
  if (ra === 1) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return 0;
    if (Number.isNaN(na)) return -1;
    if (Number.isNaN(nb)) return 1;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (ra === 2) {
    const sa = a as string;
    const sb = b as string;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  // Booleans: false < true.
  return a === b ? 0 : a ? 1 : -1;
}

const applyFilters = (docs: any[], filters: any[]) => {
  let out = docs;
  for (const filter of filters) {
    if (filter.type === 'where') {
      if (filter.op === '==') out = out.filter((d) => d[filter.field] === filter.value);
      else if (filter.op === '!=') out = out.filter((d) => d[filter.field] !== filter.value);
      else if (filter.op === 'in')
        out = out.filter((d) => Array.isArray(filter.value) && filter.value.includes(d[filter.field]));
    } else if (filter.type === 'orderBy') {
      out = [...out].sort((a, b) => {
        const c = compareOrderValues(a[filter.field], b[filter.field]);
        return filter.dir === 'desc' ? -c : c;
      });
    }
  }
  return out;
};

// ── AUDIT-2 B1: delivered marking outside ChatScreen ────────────────
// A message must become 'delivered' when it REACHES this device, not
// when the receiver happens to open the chat. ChatScreen's receipt
// effect only runs while the chat is mounted; this marker runs on every
// incoming doc (live event or poll catch-up) for every listened messages
// collection, batched 1.2 s like ChatScreen's L3 flush and capped per
// tick so a 200-unread catch-up cannot fire 200 PUTs at once. It only
// ever writes 'delivered' (never 'seen' — receipts-OFF still hides
// reads, same as WhatsApp), only for messages from someone else, and
// only for chats this user participates in. The uid is set by
// realtimeSync.init (which already receives it at sign-in) and cleared
// on cleanup/sign-out.
// Honest limits: blocked senders are not filtered here (database.ts does
// not know the block list — ChatScreen still skips them while open);
// group 'delivered' is the same shared-status approximation ChatScreen
// already uses (one recipient's delivery shows for all); disappearing
// expiry is not checked here (a message delivered before expiring is
// still delivered).
const cleanUidLocal = (v: unknown): string =>
  String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');

let deliveredMarkerUid: string | null = null;
/** Uid whose incoming messages get marked 'delivered' on arrival. */
export function setDeliveredMarkerUser(uid: string | null): void {
  deliveredMarkerUid = uid ? cleanUidLocal(uid) : null;
}

const deliveredPending = new Map<string, { col: string; id: string; at: number }>();
let deliveredTimer: ReturnType<typeof setTimeout> | null = null;
const DELIVERED_FLUSH_MS = 1200;
const DELIVERED_BATCH_MAX = 50;

function maybeMarkDelivered(col: string, id: string, data: any): void {
  if (!deliveredMarkerUid) return;
  if (!isMessagesCollection(col) || !data || typeof data !== 'object') return;
  if (isKeyExchangeDoc(data)) return;
  if (isGroupKeyExchangeDoc(data)) return;
  if (data.deleted || data.viewed) return;
  if (data.status === 'delivered' || data.status === 'seen') return;
  if (cleanUidLocal(data.senderId) === deliveredMarkerUid) return; // own message
  const chatId = chatIdFromMessagesCollection(col);
  if (!chatId) return;
  const me = deliveredMarkerUid;
  // DM ids are `<cleanUidA>_<cleanUidB>` (sorted pair): I participate iff
  // my cleaned uid is the first or the last `_`-joined part.
  const isMyDm = chatId.startsWith(me + '_') || chatId.endsWith('_' + me);
  if (!isMyDm) {
    // Group/community: only mark when a cached communities doc proves
    // membership. Unknown (never seen) stays unmarked — ChatScreen marks
    // it when the chat is opened, same as before this fix. readCachedAny:
    // the communities doc may have arrived via subscription (or a local
    // write) before the collection finished its initial load.
    const community = db.readCachedAny('communities', chatId);
    if (community === undefined) return;
    const members = (community as any)?.members;
    if (Array.isArray(members)) {
      if (!members.some((m: any) => cleanUidLocal(m?.uid ?? m) === me)) return;
    } else if (members !== undefined) {
      return; // unknown shape — stay conservative
    }
  }
  const key = `${col}/${id}`;
  if (deliveredPending.has(key)) return;
  deliveredPending.set(key, { col, id, at: Date.now() });
  if (!deliveredTimer) deliveredTimer = setTimeout(() => void flushDeliveredMarks(), DELIVERED_FLUSH_MS);
}

async function flushDeliveredMarks(): Promise<void> {
  deliveredTimer = null;
  if (deliveredPending.size === 0) return;
  const batch = [...deliveredPending.values()].slice(0, DELIVERED_BATCH_MAX);
  for (const item of batch) deliveredPending.delete(`${item.col}/${item.id}`);
  for (const item of batch) {
    try {
      // B1: readCachedAny, not readCached — the collection may not have
      // finished its initial load yet when the event arrived.
      const cur = db.readCachedAny(item.col, item.id);
      if (!cur || cur.status === 'delivered' || cur.status === 'seen' || cur.deleted) continue;
      await updateDoc(doc(null as any, item.col, item.id), {
        status: 'delivered',
        deliveredAt: item.at,
      });
    } catch (e) {
      console.warn(`[db] delivered mark failed for ${item.col}/${item.id} (will retry on next arrival/poll):`, e);
    }
  }
  if (deliveredPending.size > 0 && !deliveredTimer) {
    deliveredTimer = setTimeout(() => void flushDeliveredMarks(), DELIVERED_FLUSH_MS);
  }
}

// ── AUDIT-2 B15: receiver-side receipt times ──────────────────────────
// Unread counts must never depend on the SENDER's clock (`at` /
// `timestamp` — a sender 2 h fast/slow breaks the badge). When a message
// doc is first seen by this device, stamp it with `receivedAt` (this
// device's clock at receipt) and `serverStampedAt` (the server's
// `updatedAt` for the doc when known). Stamps are set ONCE and carried
// across poll rebuilds, so they never move. readReceipts.ts's
// countUnreadMessages() reads these instead of the sender's timestamp;
// true cross-device unread sync still needs the backend (BACKEND-PLAN
// §15) — this only fixes the clock-dependence on this device.
function stampReceiptTimes(data: any, serverUpdatedAt?: any): void {
  if (!data || typeof data !== 'object') return;
  if (data.receivedAt === undefined || data.receivedAt === null) data.receivedAt = Date.now();
  if (
    (data.serverStampedAt === undefined || data.serverStampedAt === null) &&
    serverUpdatedAt !== undefined &&
    serverUpdatedAt !== null
  ) {
    data.serverStampedAt = serverUpdatedAt;
  }
}

// ── AUDIT-2 C4: DynamoDB 400KB item limit ─────────────────────────────
// A DynamoDB item (the whole stored doc, incl. its col/id/updatedAt
// envelope) may not exceed 400KB — the limit cannot be raised. Nothing
// in the write path checked the size, so an oversized write failed
// server-side AFTER the optimistic local copy was already showing (and
// then rolled back). The guard below refuses oversized docs
// client-side with an honest error BEFORE any local mutation, so the
// caller can tell the user instead of silently dropping the write.
// The cap is 380KB to leave headroom for the envelope + GraphQL JSON
// escaping.
/** DynamoDB per-item limit (fixed by AWS, cannot be raised). */
export const DYNAMODB_ITEM_LIMIT_BYTES = 400 * 1024;
/** Largest serialized doc putRaw() will accept (400KB limit minus envelope headroom). */
export const MAX_DOC_BYTES = 380 * 1024;
/** Largest edit-history array kept on a message doc (oldest entries drop, see putRaw). */
export const MAX_EDIT_HISTORY_ENTRIES = 20;

/** UTF-8 byte length of the JSON serialization of `data`, or -1 when it cannot be serialized. */
export function estimateDocSizeBytes(data: any): number {
  try {
    const json = JSON.stringify(data);
    if (typeof json !== 'string') return -1;
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
    return json.length;
  } catch {
    return -1;
  }
}

/** Throw an honest, actionable error when a doc is too big to store. Callers must surface it, never swallow it. */
export function assertDocSizeWithinLimit(col: string, id: string, data: any): void {
  const size = estimateDocSizeBytes(data);
  if (size < 0) {
    throw new Error(`Cannot save ${col}/${id}: the data could not be serialized (circular or unsupported value).`);
  }
  if (size > MAX_DOC_BYTES) {
    throw new Error(
      `Cannot save ${col}/${id}: this item is ~${Math.round(size / 1024)}KB, over the ${Math.round(MAX_DOC_BYTES / 1024)}KB limit ` +
        `(DynamoDB allows at most 400KB per item). Split it into smaller items or shorten it and try again.`,
    );
  }
}

/**
 * Pure parse of one persisted-cache key into a conversation id, or null
 * when the key is not a chat messages collection. The whole H7 fix rests
 * on this regex — if the key format ever changes, listPersistedChatChannels
 * silently returns [] and Storage Usage shows 0 again, so it has its own
 * test (src/aws/database.test.ts). `saved_` channels are excluded,
 * matching getAllChatChannels (callers add the saved channel explicitly).
 */
export const parsePersistedChatChannelId = (key: unknown): string | null => {
  const m = /^chats\/([^/]+)\/messages$/.exec(String(key ?? ''));
  if (!m || !m[1] || m[1].startsWith('saved_')) return null;
  return m[1];
};

class RemoteStore {
  private cols = new Map<string, ColState>();
  private listeners: Listener[] = [];
  private pending = new Map<string, Promise<void>>();
  /** Guard so the `online` / visibilitychange re-subscribe listeners are attached once. */
  private reconnectListenersAttached = false;

  private state(col: string): ColState {
    let s = this.cols.get(col);
    if (!s) {
      s = { docs: new Map(), loaded: false, sub: null, retryTimer: null, poll: null, touched: new Map(), docRev: new Map(), subDroppedAt: null, tombstones: new Map(), restored: false, lastUsedAt: 0 };
      this.cols.set(col, s);
    }
    return s;
  }

  /**
   * Freshest cached doc for a collection, synchronously — no network.
   * Returns `undefined` when the collection has never been loaded (so the
   * caller must fall back to a network read), `null` when it is loaded but
   * the doc is absent, and the stored doc otherwise. updateDoc uses this
   * so a concurrent in-tab write cannot slip in between a network read
   * and the merge (see R3).
   */
  public readCached(col: string, id: string): any | null | undefined {
    const s = this.cols.get(col);
    if (!s || !s.loaded) return undefined;
    return s.docs.get(id) ?? null;
  }

  /**
   * AUDIT-2 B1/B14: cached doc regardless of whether the collection
   * finished its initial load. Subscription events and outbox flushes can
   * arrive before ensure() completes; readCached's loaded-gate would
   * report "unknown" and the caller would skip work it should do (the
   * delivered mark, the stale-write guard). Returns `null` when the doc
   * is absent from the cache, `undefined` only when the collection was
   * never touched at all. Callers that need "loaded" semantics must use
   * readCached instead.
   */
  public readCachedAny(col: string, id: string): any | null | undefined {
    const s = this.cols.get(col);
    if (!s) return undefined;
    return s.docs.get(id) ?? null;
  }

  /** True when a collection that should be live has no working subscription
   * (dropped and not yet re-established) — i.e. the UI is poll-only and
   * should show "reconnecting…". */
  public isReconnecting(col: string): boolean {
    const s = this.cols.get(col);
    if (!s) return false;
    if (s.sub) return false;
    return this.listeners.some((l) => l.col === col);
  }

  /** Collections currently without a live subscription (poll-only). */
  public getReconnectingCollections(): string[] {
    const out: string[] = [];
    for (const [col] of this.cols) {
      if (this.isReconnecting(col)) out.push(col);
    }
    return out;
  }

  /** Subscription health per collection, for a "reconnecting…" UI state. */
  public getSubscriptionHealth(): Record<string, { connected: boolean; failures: number; reconnecting: boolean; droppedAt: number | null; pollFailures: number; restoreFailures: number; refreshDocFailures: number }> {
    const out: Record<string, { connected: boolean; failures: number; reconnecting: boolean; droppedAt: number | null; pollFailures: number; restoreFailures: number; refreshDocFailures: number }> = {};
    for (const [col, s] of this.cols) {
      out[col] = {
        connected: !!s.sub,
        failures: s.subFailures || 0,
        reconnecting: this.isReconnecting(col),
        droppedAt: s.subDroppedAt,
        // #147 (W30g): silent-catch counters, surfaced for diagnostics.
        pollFailures: s.pollFailures || 0,
        restoreFailures: s.restoreFailures || 0,
        refreshDocFailures: s.refreshDocFailures || 0,
      };
    }
    return out;
  }

  /**
   * AUDIT-2 C5 / W2C open item (PATCH-2C §6): truly release a
   * collection — drop this screen's listener(s), stop the 3 s poll,
   * cancel any re-subscribe backoff, and unsubscribe the underlying
   * AppSync subscription. Until this existed, ChatListScreen's LRU
   * eviction only dropped its own listener (which stopped the poll once
   * it was the last one) while the AppSync subscription lived on for the
   * session. The cached docs are KEPT by default (re-activation
   * re-renders instantly from cache); pass `dropCache` to also drop
   * them (the next ensure() refetches). Safe to call for a
   * never-subscribed collection (no-op). Callers must own the
   * collection (e.g. ChatListScreen's active set): listeners from OTHER
   * screens on the same collection are dropped too.
   */
  public releaseCollection(col: string, opts?: { dropCache?: boolean }): void {
    const s = this.cols.get(col);
    if (!s) return;
    clearTimeout(s.retryTimer);
    if (s.sub) {
      try {
        s.sub.unsubscribe();
      } catch (e) {
        console.warn(`[db] releaseCollection: unsubscribe failed for "${col}":`, e);
      }
      s.sub = null;
    }
    s.subDroppedAt = null;
    s.subFailures = 0;
    this.stopPoll(col);
    // Drop this screen's listener(s) for the collection so no further
    // snapshots are delivered to them; the unsubscribe closure returned
    // by subscribe() becomes a harmless no-op for them.
    this.listeners = this.listeners.filter((l) => l.col !== col);
    // A re-activated collection must re-decrypt from the stored docs.
    for (const key of [...this.decryptMemo.keys()]) {
      if (key.startsWith(`${col}/`)) this.decryptMemo.delete(key);
    }
    // W13 NEXT R8 (B2): the memo drop above changes the served view
    // (and dropCache clears the docs) without a notify — invalidate.
    this.invalidateDocsSnapshot(col);
    if (opts?.dropCache) {
      // #138 (W30i) + #139 (W30h): a debounced persist may still hold
      // this collection's LIVE map — schedulePersist() stores the map
      // reference and serialises it 1 s later, and W30h schedules one
      // on every ensure(). Clearing the map first would let that timer
      // write an EMPTY map to IndexedDB, deleting the collection's
      // cached docs from disk (proven by probe fix4: seeded 500-msg
      // chats read back 0 docs after a prune). Flush the pending persist
      // now if one exists: persistNow() snapshots the entries
      // synchronously and clears the timer, so the disk keeps the full
      // map and the clear below is memory-only.
      if (pendingPersistDocs.has(col)) {
        void persistNow(col, s.docs, s.docRev);
      }
      s.docs.clear();
      s.docRev.clear();
      s.touched.clear();
      s.tombstones.clear();
      s.loaded = false;
      s.restored = false;
      this.pending.delete(col);
    }
  }

  /**
   * REPORT-3 #138 (W30i): bound the retained message docs. The
   * ChatListScreen LRU (MAX_ACTIVE_MESSAGE_COLLECTIONS = 12) bounds live
   * SUBSCRIPTIONS, the decrypt memo is capped at 2000 and the snapshot
   * cache at 500 — but the cached docs themselves (`s.docs`) of every
   * visited collection stayed in `this.cols` forever: heap grew ~+4 MB
   * after 20 chat visits (500 msgs each) and never came back down after
   * returning to /main + 10 s idle + forced GC.
   *
   * This prunes the docs of IDLE collections only — no live listeners
   * AND no live subscription (never the open chat, never the list's
   * active set) and no ensure() in flight — oldest-used first, down to
   * MAX_IDLE_CACHED_DOCS total docs, reusing releaseCollection(col,
   * { dropCache: true }) so the decrypt memo, snapshot cache and poll /
   * subscription teardown follow the tested path. Re-opening a pruned
   * chat refetches from disk (mock) / network (real) via ensure(); the
   * list's preview memo survives, so rows keep their real last message.
   * Live collections are deliberately exempt: dropping a subscribed
   * collection's docs would break its live updates.
   */
  private static readonly MAX_IDLE_CACHED_DOCS = 1000;

  private maybePruneDocsCache(): void {
    let idleTotal = 0;
    const idle: Array<{ col: string; lastUsedAt: number; size: number }> = [];
    for (const [col, s] of this.cols) {
      if (s.docs.size === 0) continue;
      if (s.sub) continue;
      if (this.listeners.some((l) => l.col === col)) continue;
      if (this.pending.has(col)) continue;
      idleTotal += s.docs.size;
      idle.push({ col, lastUsedAt: s.lastUsedAt || 0, size: s.docs.size });
    }
    if (idleTotal <= RemoteStore.MAX_IDLE_CACHED_DOCS) return;
    idle.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const victim of idle) {
      if (idleTotal <= RemoteStore.MAX_IDLE_CACHED_DOCS) break;
      this.releaseCollection(victim.col, { dropCache: true });
      idleTotal -= victim.size;
    }
  }

  /** Collections with a live AppSync subscription right now (probe / diagnostics). */
  public getActiveSubscriptionCols(): string[] {
    const out: string[] = [];
    for (const [col, s] of this.cols) {
      if (s.sub) out.push(col);
    }
    return out;
  }

  /**
   * Re-subscribe immediately to every listened collection whose live
   * subscription is down (called on `online` and on visibility-change
   * back to foreground). Clears any pending backoff timer for that
   * collection first; subscribeCol() itself is a no-op when a
   * subscription is already live, so this is safe to call often.
   */
  private resubscribeNow(): void {
    for (const [col, s] of [...this.cols]) {
      if (s.sub) continue;
      if (!this.listeners.some((l) => l.col === col)) continue;
      clearTimeout(s.retryTimer);
      this.subscribeCol(col);
    }
  }

  /** Attach the one-time `online` / visibilitychange re-subscribe hooks. */
  private attachReconnectListeners(): void {
    if (this.reconnectListenersAttached) return;
    this.reconnectListenersAttached = true;
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', () => this.resubscribeNow());
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.resubscribeNow();
        });
      }
    } catch { /* intentionally ignored */}
  }

  /** Load a whole collection once and keep it live via subscription. */
  public ensure(col: string, attempt = 0): Promise<void> {
    const s = this.state(col);
    if (s.loaded) return Promise.resolve();
    const existing = this.pending.get(col);
    if (existing) return existing;

    const p = (async () => {
      try {
        this.subscribeCol(col);
        // Phase 3: restore the last persisted cache first so a reload shows
        // data immediately; the network fetch below then refreshes it.
        await this.restorePersisted(col);
        // #139 (W30h): cold start must not pay a full-collection fetch
        // when the restored cache is already current — the metadata-only
        // rev probe proves it (or refreshes just the changed docs).
        // syncFromProbe returns false with no backend (local mode) or no
        // probe result, and fetchAll keeps today's behaviour then.
        if (!(await this.syncFromProbe(col))) {
          await this.fetchAll(col);
        }
        // #139 (W30h): persist the synced cache + revs so the NEXT cold
        // start can prove the collection unchanged from disk. A read-only
        // sync otherwise leaves revs in memory only, and the next cold
        // start full-fetches again. Debounced 1 s, pagehide-flushed like
        // writes; the map is complete post-sync (loaded), so this cannot
        // persist a partial map (W7 #79/#146 guard still applies to
        // writes, which restore first).
        schedulePersist(col, s.docs, s.docRev);
        this.notify(col);
        this.startPoll(col);
        // #138 (W30i): this collection just loaded — mark it used and
        // bound the retained docs of idle collections (see
        // maybePruneDocsCache).
        s.lastUsedAt = Date.now();
        this.maybePruneDocsCache();
      } catch (e) {
        console.warn(`DB load failed for "${col}" (attempt ${attempt + 1}):`, e);
        // Session may not be ready yet (e.g. right after login); retry with backoff
        // so the screen does not stay empty until it is remounted.
        if (attempt < 10) {
          clearTimeout(s.retryTimer);
          s.retryTimer = setTimeout(
            () => this.ensure(col, attempt + 1),
            Math.min(1500 * (attempt + 1), 15000)
          );
        }
      } finally {
        this.pending.delete(col);
      }
    })();
    this.pending.set(col, p);
    return p;
  }

  /** Restore a collection from IndexedDB into the in-memory cache (best-effort).
   * W7 (#79/#146): marks the collection `restored` on every exit once the
   * disk read succeeded — including when disk held nothing (there is then
   * nothing to restore, and a later write must not re-read disk on every
   * write). A write must never persist a map this never filled. */
  private async restorePersisted(col: string): Promise<void> {
    // #147 (W30g): `s` is declared outside the try so the catch below
    // can count the failure on it (a const inside try is not in scope
    // in catch).
    const s = this.state(col);
    try {
      if (s.restored) return;
      if (s.loaded) { s.restored = true; return; }
      const docs = await idbGet(col);
      // Disk read succeeded: the map now reflects disk (even when disk
      // held nothing). Mark it before filling so a concurrent write
      // racing this restore cannot start a second restore over it.
      s.restored = true;
      if (!docs || docs.length === 0) return;
      if (s.loaded) return;
      // AUDIT-2 C2 (3B): this restores the WHOLE persisted collection,
      // so the cache is complete afterwards — mark it loaded. Before
      // this, loaded stayed false, so every later ensureDoc/readDoc
      // re-restored from disk and OVERWROTE any in-memory doc with the
      // stale persisted copy: a local write made after the restore
      // (e.g. the seenUpTo watermark, persisted on a 1 s debounce) was
      // silently reverted before its persist fired (probe Q5/Q6).
      // Fill only docs ABSENT from the cache: a restore must never
      // clobber a live in-memory doc (a local write racing the restore
      // is newer than disk), and a tombstoned doc must stay deleted.
      let added = false;
      for (const [id, data] of docs) {
        if (!id || data === null || data === undefined) continue;
        if (s.docs.has(id) || s.tombstones.has(id)) continue;
        // B15: legacy docs restored from disk predate receipt stamps —
        // stamp them at restore (receiver-side time) so the unread badge
        // never falls back to the sender's clock for them.
        if (isMessagesCollection(col)) stampReceiptTimes(data);
        s.docs.set(id, data);
        added = true;
      }
      // #223/#232 (W5b R15): overlay any STILL-PENDING debounced persist
      // for this collection. pendingPersistDocs holds the live map
      // reference from the last schedulePersist; it survives db.reset()
      // (module-level, not per-collection state) and its 1 s timer may
      // not have fired — or its idbPut may not have committed — when a
      // restore runs (e.g. clearPushToken's readDoc racing the sign-out
      // reset in a flow that never awaited resetDbCache). Without this,
      // the restore reads pre-flush disk, the merge base is {}, and the
      // write lands as a skeleton doc (proven by probe-w5b-r15-dump).
      // Same guards as the disk loop: never clobber a live doc, never
      // resurrect a tombstoned one. The pending map is always the newest
      // snapshot (every write re-schedules with the current live map),
      // so overlaying it can only make the restore newer, never older.
      try {
        const pending = pendingPersistDocs.get(col);
        if (pending) {
          for (const [id, data] of pending) {
            if (!id || data === null || data === undefined) continue;
            if (s.docs.has(id) || s.tombstones.has(id)) continue;
            if (isMessagesCollection(col)) stampReceiptTimes(data);
            s.docs.set(id, data);
            added = true;
          }
        }
      } catch { /* intentionally ignored */}
      // #139 (W30h): restore the persisted server revisions alongside the
      // docs — without them the rev probe can never prove an
      // IDB-restored collection unchanged, and every cold start pays a
      // full fetch. Only revs for docs actually in the cache (and not
      // tombstoned). A record written before this landed carries no revs
      // (idbGetRevs returns null) and the probe stays conservative.
      try {
        const revs = await idbGetRevs(col);
        if (revs) {
          for (const [id, rev] of revs) {
            if (!id || rev === null || rev === undefined) continue;
            if (!s.docs.has(id) || s.tombstones.has(id)) continue;
            s.docRev.set(id, rev);
          }
        }
      } catch { /* intentionally ignored */}
      // Mirror of the pending-docs overlay above (same post-reset race:
      // the pending maps hold the pre-reset live maps, which are newer
      // than disk) — a pending doc's rev wins over the disk rev.
      try {
        const pendingRevs = pendingPersistRevs.get(col);
        if (pendingRevs) {
          for (const [id, rev] of pendingRevs) {
            if (!id || rev === null || rev === undefined) continue;
            if (!s.docs.has(id) || s.tombstones.has(id)) continue;
            s.docRev.set(id, rev);
          }
        }
      } catch { /* intentionally ignored */}
      s.loaded = true;
      if (added) this.notify(col);
    } catch (e) {
      // #147 (W30g): was silent — a failed disk restore left the cache
      // empty with no trace. Log + count; retry behaviour unchanged
      // (restored was already marked true before the fill, so this
      // session keeps the in-memory cache as-is; a fresh load retries).
      s.restoreFailures = (s.restoreFailures || 0) + 1;
      console.warn(`[db] restorePersisted failed for "${col}" (failure #${s.restoreFailures}) — cache left as-is, next load retries:`, e);
    }
  }

  /**
   * Refetch a whole collection from the server.
   * @returns true when any doc was added, removed or changed vs the cache.
   * Change is detected per doc from the server `updatedAt` revision — no
   * whole-collection JSON.stringify (the old poll stringified megabytes
   * of docs twice per 3 s tick). Only docs with no revision on either
   * side fall back to a per-doc stringify, and only for that one doc.
   */
  private async fetchAll(col: string): Promise<boolean> {
    const s = this.state(col);
    // RETEST-1 (2026-11-14): local/mock mode has no AWS backend, so there
    // is nothing to fetch — the IndexedDB-restored cache IS the data.
    // Mark loaded so screens stop retrying, and never call generateClient()
    // here: unconfigured it throws "No AmplifyContext available" as an
    // unhandled pageerror on every collection load.
    if (!isAwsConfigured()) {
      s.loaded = true;
      return false;
    }
    const next = new Map<string, any>();
    const nextRev = new Map<string, any>();
    const started = Date.now();
    let nextToken: string | null = null;
    do {
      const res: any = await gql().graphql({
        query: LIST_DOCS,
        variables: { col, limit: 500, nextToken },
      });
      const page = res?.data?.listDocs;
      for (const item of page?.items || []) {
        if (!item || item.data === null || item.data === undefined) continue;
        next.set(item.id, parseData(item.data) || {});
        if (item.updatedAt !== null && item.updatedAt !== undefined) {
          nextRev.set(item.id, item.updatedAt);
        }
      }
      nextToken = page?.nextToken || null;
    } while (nextToken);
    // The server response is only a snapshot from before this load started. Docs that
    // were written, deleted or updated locally (or by a realtime event) while the load
    // was running take their local value. Everything else follows the server, so a doc
    // deleted elsewhere is removed instead of being restored from the old cache.
    for (const [id, ts] of s.touched) {
      if (ts < started) {
        s.touched.delete(id);
        continue;
      }
      if (s.docs.has(id)) {
        next.set(id, s.docs.get(id));
        // Keep the pre-fetch revision for a locally-kept doc: its server
        // revision is unknown/stale, and the write already notified.
        if (s.docRev.has(id)) nextRev.set(id, s.docRev.get(id));
        else nextRev.delete(id);
      } else {
        next.delete(id);
        nextRev.delete(id);
      }
    }
    // B14: a locally-deleted doc whose DELETE has not landed server-side
    // yet must not be re-added from the server snapshot (the ~3s
    // re-appear). The tombstone wins until the DELETE is confirmed, the
    // doc is written again, or a live event says it exists.
    // Bound memory: drop the oldest tombstones past 1000 (their queued
    // 'delete' op in the outbox still retries the DELETE).
    while (s.tombstones.size > 1000) {
      const first = s.tombstones.keys().next().value;
      if (first === undefined) break;
      s.tombstones.delete(first);
    }
    for (const id of s.tombstones.keys()) {
      next.delete(id);
      nextRev.delete(id);
    }
    // Per-doc change detection against the previous cache.
    let changed = next.size !== s.docs.size;
    if (!changed) {
      for (const [id, data] of next) {
        if (!s.docs.has(id)) {
          changed = true;
          break;
        }
        const oldRev = s.docRev.get(id);
        const newRev = nextRev.get(id);
        if (oldRev !== undefined && newRev !== undefined) {
          if (oldRev !== newRev) {
            changed = true;
            break;
          }
        } else {
          // No revision on one/both sides (restored docs, local writes, or
          // a server that reports no updatedAt): compare just this one doc
          // instead of the whole collection.
          let oldStr = '';
          let newStr = '';
          try {
            oldStr = JSON.stringify(s.docs.get(id));
          } catch { /* intentionally ignored */}
          try {
            newStr = JSON.stringify(data);
          } catch { /* intentionally ignored */}
          if (oldStr !== newStr) {
            changed = true;
            break;
          }
        }
      }
    }
    const oldDocs = s.docs;
    s.docs = next;
    s.docRev = nextRev;
    s.loaded = true;
    // B15: carry each doc's first-seen receipt stamps across the poll
    // rebuild (the server payload has no stamps), then stamp brand-new
    // docs. Stamps are set once and never move.
    // B1: a poll catch-up is also an arrival — mark newly-seen incoming
    // messages delivered even when no chat screen is open.
    if (isMessagesCollection(col)) {
      for (const [id, data] of s.docs) {
        const old = oldDocs.get(id);
        if (old && typeof old === 'object') {
          if (old.receivedAt !== undefined && old.receivedAt !== null && (data.receivedAt === undefined || data.receivedAt === null)) data.receivedAt = old.receivedAt;
          if (old.serverStampedAt !== undefined && old.serverStampedAt !== null && (data.serverStampedAt === undefined || data.serverStampedAt === null)) data.serverStampedAt = old.serverStampedAt;
        }
        stampReceiptTimes(data, nextRev.get(id));
        maybeMarkDelivered(col, id, data);
      }
    }
    return changed;
  }

  /**
   * #139 (W30h): rev-probe page size. Revs are a few dozen bytes each, so
   * a 5,000-rev page stays far under the 1 MB DynamoDB/AppSync page cap;
   * the full-data LIST_DOCS fetch keeps limit 500 (message docs are big).
   * The probe still follows nextToken, so a server that caps lower (or a
   * >5,000-doc collection) just takes more small pages — never a wrong
   * result, only more round trips.
   */
  private static readonly REV_PROBE_PAGE_LIMIT = 5000;

  /**
   * Metadata-only revision probe (AUDIT-2 C1, 3A §4): (id → server
   * `updatedAt`) for a whole collection WITHOUT downloading any doc
   * data. Returns null in local mode (no backend to probe — the caller
   * falls through to the full fetch).
   */
  private async listDocRevs(col: string): Promise<Map<string, any> | null> {
    if (!isAwsConfigured()) return null;
    const revs = new Map<string, any>();
    let nextToken: string | null = null;
    do {
      const res: any = await gql().graphql({
        query: LIST_DOC_REVS,
        variables: { col, limit: RemoteStore.REV_PROBE_PAGE_LIMIT, nextToken },
      });
      const page = res?.data?.listDocs;
      for (const item of page?.items || []) {
        if (item && item.id) revs.set(item.id, item.updatedAt ?? null);
      }
      nextToken = page?.nextToken || null;
    } while (nextToken);
    return revs;
  }

  /**
   * True when the revision probe shows anything the cache doesn't
   * already have. Conservative by design — anything the probe cannot
   * prove unchanged counts as changed, so the next step is a targeted
   * refresh (syncFromRevs) or a full fetchAll, never a missed update:
   * - a size difference (after ignoring tombstoned deletes, which the
   *   server still lists until the DELETE lands);
   * - an id the server lists that the cache lacks (new doc), or vice
   *   versa (deleted elsewhere);
   * - a rev that differs, or a doc with no rev on either side
   *   (IDB-restored docs have no docRev until the first full fetch;
   *   a server that reports no updatedAt for a doc) — the probe
   *   cannot prove those unchanged.
   */
  private revsChanged(col: string, revs: Map<string, any>): boolean {
    const s = this.cols.get(col);
    if (!s) return true;
    // Docs the server still lists but this device deleted locally
    // (DELETE unconfirmed): expected, not a change — fetchAll already
    // excludes them via the tombstone set.
    let serverCount = revs.size;
    for (const id of s.tombstones.keys()) if (revs.has(id)) serverCount--;
    if (serverCount !== s.docs.size) return true;
    for (const [id, rev] of revs) {
      if (s.tombstones.has(id)) continue;
      if (!s.docs.has(id)) return true;
      const known = s.docRev.get(id);
      if (known === undefined || rev === undefined || rev === null) return true;
      if (known !== rev) return true;
    }
    for (const id of s.docs.keys()) {
      if (!revs.has(id)) return true;
    }
    return false;
  }

  /**
   * #139 (W30h): cold-start sync from the metadata-only rev probe.
   * Returns true when the probe ran and the collection is now in sync
   * (unchanged → nothing fetched at all; changed → just the changed
   * docs, see syncFromRevs). Returns false with no backend (local mode)
   * or no probe result — the caller then falls back to the full fetchAll
   * (today's behaviour). A probe/network error THROWS so the caller
   * (ensure) retries with backoff, exactly as a failed fetchAll does.
   */
  private async syncFromProbe(col: string): Promise<boolean> {
    if (!isAwsConfigured()) return false;
    const revs = await this.listDocRevs(col);
    if (!revs) return false;
    return this.syncFromRevs(col, revs);
  }

  /**
   * #139 (W30h): bring a collection in sync from a rev-probe result
   * WITHOUT a full fetchAll. Unchanged → zero transfer (the 5,000-message
   * cold start costs one metadata-only probe instead of 10 full-data
   * pages). Changed → one small GET_DOC per new/changed doc (deletes are
   * local-only drops, free) plus a collection notify when anything
   * moved. When the changed set is bigger than a full fetch would cost
   * in pages (ceil(serverCount / 500)), fetchAll wins and is used
   * instead — the targeted path never costs MORE round trips than the
   * old behaviour. Semantics mirror fetchAll: docs touched locally
   * during (or just before) this sync keep their local value and their
   * server revision stays unknown; tombstoned docs stay deleted;
   * message docs get the same first-seen receipt stamps + delivered
   * marking fetchAll applies.
   */
  private async syncFromRevs(col: string, revs: Map<string, any>): Promise<boolean> {
    const s = this.state(col);
    const started = Date.now();
    if (!this.revsChanged(col, revs)) {
      // Nothing changed vs the restored cache: no transfer at all.
      // (The first cold start after this lands still full-fetches once:
      // pre-existing IDB records carry no revs, so revsChanged stays
      // conservative — that fetch then persists revs for next time.)
      s.loaded = true;
      return true;
    }
    // Prune stale touches (same rule as fetchAll): a touch older than
    // this sync started is already reflected server-side (its PUT landed
    // or it rolled back / queued); a newer touch owns the doc until its
    // PUT lands, so it is skipped below.
    for (const [id, ts] of s.touched) {
      if (ts < started) s.touched.delete(id);
    }
    // How many docs actually need a GET — vs what a full fetch costs.
    let toFetch = 0;
    for (const [id, rev] of revs) {
      if (s.tombstones.has(id) || s.touched.has(id)) continue;
      const known = s.docRev.get(id);
      if (s.docs.has(id) && known !== undefined && rev !== undefined && rev !== null && known === rev) continue;
      toFetch++;
    }
    const fetchPages = Math.max(1, Math.ceil(revs.size / 500));
    if (toFetch > fetchPages) {
      const changed = await this.fetchAll(col);
      if (changed) this.notify(col);
      return true;
    }
    let changed = false;
    // Deletes: in the cache, gone from the server. Tombstoned docs are
    // already absent from s.docs; a touched doc keeps its local value.
    for (const id of [...s.docs.keys()]) {
      if (revs.has(id) || s.tombstones.has(id) || s.touched.has(id)) continue;
      s.docs.delete(id);
      s.docRev.delete(id);
      this.decryptMemo.delete(`${col}/${id}`);
      changed = true;
    }
    // New / changed docs: one small GET_DOC each.
    for (const [id, rev] of revs) {
      if (s.tombstones.has(id) || s.touched.has(id)) continue;
      const known = s.docRev.get(id);
      if (s.docs.has(id) && known !== undefined && rev !== undefined && rev !== null && known === rev) continue;
      const old = s.docs.get(id);
      await this.refreshDoc(col, id);
      const fresh = s.docs.get(id);
      if (fresh !== undefined) {
        // fetchAll parity for message docs: carry first-seen receipt
        // stamps across the refresh, stamp brand-new docs, mark
        // arrivals delivered.
        if (isMessagesCollection(col)) {
          if (old && typeof old === 'object') {
            if (old.receivedAt !== undefined && old.receivedAt !== null && (fresh.receivedAt === undefined || fresh.receivedAt === null)) fresh.receivedAt = old.receivedAt;
            if (old.serverStampedAt !== undefined && old.serverStampedAt !== null && (fresh.serverStampedAt === undefined || fresh.serverStampedAt === null)) fresh.serverStampedAt = old.serverStampedAt;
          }
          stampReceiptTimes(fresh, s.docRev.get(id));
          maybeMarkDelivered(col, id, fresh);
        }
        changed = true;
      } else if (old !== undefined) {
        // The doc vanished between the probe and the GET — a delete.
        changed = true;
      }
    }
    // Trust the probe's revs for every doc now in the cache (docs the
    // GET refreshed already carry their GET-response rev; unchanged docs
    // carry the restored rev, which the probe just confirmed). Never for
    // a touched doc: its server revision is unknown until its PUT lands.
    for (const [id, rev] of revs) {
      if (s.touched.has(id)) continue;
      if (s.docs.has(id) && rev !== undefined && rev !== null) s.docRev.set(id, rev);
    }
    // Drop revs for docs no longer in the cache (deleted above).
    for (const id of [...s.docRev.keys()]) {
      if (!s.docs.has(id)) s.docRev.delete(id);
    }
    s.loaded = true;
    if (changed) this.notify(col);
    return true;
  }

  /**
   * Refresh ONE watched doc from the server (GET_DOC) and notify its
   * listeners when it changed. The doc-only fallback for collections
   * with no whole-collection listener (see startPoll): a single doc
   * costs one small GET instead of a full-collection download.
   */
  private async refreshDoc(col: string, id: string): Promise<void> {
    if (!isAwsConfigured()) return;
    const s = this.state(col);
    try {
      const res: any = await gql().graphql({ query: GET_DOC, variables: { col, id } });
      const data = parseData(res?.data?.getDoc?.data);
      if (data === null || data === undefined) {
        if (s.docs.has(id)) {
          s.docs.delete(id);
          s.docRev.delete(id);
          this.notify(col, id);
        }
        return;
      }
      let prevStr = '';
      let nextStr = '';
      try {
        prevStr = JSON.stringify(s.docs.get(id));
      } catch { /* intentionally ignored */}
      try {
        nextStr = JSON.stringify(data);
      } catch { /* intentionally ignored */}
      if (prevStr === nextStr && s.docs.has(id)) return;
      s.docs.set(id, data);
      const updatedAt = res?.data?.getDoc?.updatedAt;
      if (updatedAt !== null && updatedAt !== undefined) s.docRev.set(id, updatedAt);
      else s.docRev.delete(id);
      this.notify(col, id);
    } catch (e) {
      // #147 (W30g): was silent — a failing single-doc refresh hid
      // network/session trouble. Log + count; the next tick retries.
      s.refreshDocFailures = (s.refreshDocFailures || 0) + 1;
      console.warn(`[db] refreshDoc failed for "${col}/${id}" (failure #${s.refreshDocFailures}) — network or session issue, the next tick retries:`, e);
    }
  }

  /** Refresh every doc with a live doc-listener on this collection (one GET_DOC each). */
  private async refreshWatchedDocs(col: string): Promise<void> {
    const ids = [...new Set(this.listeners.filter((l) => l.col === col && l.isDoc).map((l) => l.id))];
    for (const id of ids) {
      await this.refreshDoc(col, id);
    }
  }

  /**
   * Fallback sync: refetch a collection while anyone is listening to it. Live
   * subscription events may not arrive (e.g. the subscription is rejected), so this
   * keeps every screen updated within a few seconds. Notifies only when data changed
   * (fetchAll reports per-doc changes via `updatedAt`, without stringifying the
   * whole collection). Polling is deliberately kept: it is the fallback when the
   * subscription is dead.
   */
  private startPoll(col: string) {
    // RETEST-1: no backend in local mode — nothing to poll. Local writes
    // notify listeners directly, so polling would only burn CPU and throw
    // on every 3s tick.
    if (!isAwsConfigured()) return;
    const s = this.state(col);
    if (s.poll) return;
    s.poll = setInterval(async () => {
      const hasListeners = this.listeners.some((l) => l.col === col);
      if (!hasListeners) {
        this.stopPoll(col);
        return;
      }
      try {
        const hasCollectionListeners = this.listeners.some((l) => l.col === col && !l.isDoc);
        if (!hasCollectionListeners) {
          // Doc-only watchers (AUDIT-2 C2, 3A §4 scoped subs): refresh
          // just the watched docs (one GET_DOC each) instead of
          // downloading the whole collection every 3 s.
          await this.refreshWatchedDocs(col);
          return;
        }
        // AUDIT-2 C1 rev-probe (3A §4): the 3 s tick is metadata-only
        // (id + updatedAt) when nothing changed; the full fetchAll
        // (every doc's data) runs only when a rev differs or the size
        // differs. The poll's *notify* was already rev-gated; now the
        // *transfer* is too. #139 (W30h): a changed rev now refreshes
        // just the changed docs (one GET_DOC each, via syncFromRevs)
        // instead of re-downloading the whole collection; syncFromRevs
        // notifies when anything changed, and falls back to fetchAll
        // when the changed set is bigger than a full fetch costs.
        const revs = await this.listDocRevs(col);
        if (revs) {
          await this.syncFromRevs(col, revs);
          return;
        }
        const changed = await this.fetchAll(col);
        if (changed) this.notify(col);
      } catch (e) {
        // #147 (W30g): was silent — a failing poll tick hid network/
        // session trouble. Log + count; try again on the next tick.
        s.pollFailures = (s.pollFailures || 0) + 1;
        console.warn(`[db] poll tick failed for "${col}" (failure #${s.pollFailures}) — network or session issue, trying again on the next tick:`, e);
      }
    }, 3000);
  }

  private stopPoll(col: string) {
    const s = this.cols.get(col);
    if (s?.poll) {
      clearInterval(s.poll);
      s.poll = null;
    }
  }

  private subscribeCol(col: string) {
    // RETEST-1: no AppSync subscription exists in local mode. Without this
    // guard every collection threw in generateClient(), then retried on a
    // backoff timer forever, spamming console warnings.
    if (!isAwsConfigured()) return;
    const s = this.state(col);
    if (s.sub) return;
    this.attachReconnectListeners();
    try {
      const obs: any = gql().graphql({ query: ON_DOC_CHANGED, variables: { col } });
      s.sub = obs.subscribe({
        // The subscription has no server-side filter, so every subscriber receives
        // changes from all collections. Only apply events that belong to this one.
        next: ({ data }: any) => {
          if (s.subDroppedAt !== null) {
            console.warn(`Realtime subscription recovered for "${col}" after ${s.subFailures || 0} failure(s) — live updates resumed.`);
          }
          s.subFailures = 0; // a live event means the connection is healthy again
          s.subDroppedAt = null;
          const ev = data?.onDocChanged;
          if (ev && ev.col === col) this.applyEvent(col, ev);
        },
        error: (err: any) => {
          s.subDroppedAt = Date.now();
          s.subFailures = (s.subFailures || 0) + 1;
          // Back off so a failing connection does not re-subscribe in a tight loop.
          // Capped at 30s (was 120s): a dead subscription left messages
          // poll-only for up to 2 minutes. Polling keeps data fresh meanwhile;
          // only re-register the live subscription.
          const delay = Math.min(10000 * 2 ** (s.subFailures - 1), 30000);
          console.warn(
            `Realtime subscription dropped for "${col}" (failure #${s.subFailures}, retrying in ${delay / 1000}s — messages are POLL-ONLY until it recovers; UI should show "reconnecting…", see db.isReconnecting("${col}")):`,
            err,
          );
          s.sub = null;
          clearTimeout(s.retryTimer);
          s.retryTimer = setTimeout(() => this.subscribeCol(col), delay);
        },
      });
    } catch (e) {
      s.sub = null;
      s.subDroppedAt = Date.now();
      console.warn(`Could not subscribe to "${col}" — messages are POLL-ONLY until it recovers (see db.isReconnecting):`, e);
    }
  }

  private applyEvent(col: string, ev: any) {
    if (!ev || !ev.id) return;
    const s = this.state(col);
    const data = parseData(ev.data);
    s.touched.set(ev.id, Date.now());
    if (data === null) {
      s.docs.delete(ev.id);
      // B14: a delete seen live is a delete — keep it deleted even if a
      // stale poll snapshot still lists it (until the next poll confirms).
      s.tombstones.set(ev.id, Date.now());
    } else {
      // A live event saying the doc exists wins over a tombstone (the doc
      // was re-created, e.g. a meta doc re-pinned after an unpin).
      s.tombstones.delete(ev.id);
      // B15: carry the first-seen stamps across the live update; stamp
      // brand-new docs at receipt.
      if (isMessagesCollection(col)) {
        const old = s.docs.get(ev.id);
        if (old && typeof old === 'object') {
          if (old.receivedAt !== undefined && old.receivedAt !== null && (data.receivedAt === undefined || data.receivedAt === null)) data.receivedAt = old.receivedAt;
          if (old.serverStampedAt !== undefined && old.serverStampedAt !== null && (data.serverStampedAt === undefined || data.serverStampedAt === null)) data.serverStampedAt = old.serverStampedAt;
        }
        stampReceiptTimes(data, ev.updatedAt);
      }
      s.docs.set(ev.id, data);
      // B1: a live arrival is an arrival — mark delivered even when no
      // chat screen for this conversation is open.
      maybeMarkDelivered(col, ev.id, data);
    }
    // R1 belt & braces: a realtime write to this doc must not keep serving
    // the old decrypted copy. Only this doc's memo entry is dropped.
    this.decryptMemo.delete(`${col}/${ev.id}`);
    if (ev.updatedAt !== null && ev.updatedAt !== undefined) {
      if (data === null) s.docRev.delete(ev.id);
      else s.docRev.set(ev.id, ev.updatedAt);
    } else {
      // Unknown server revision: drop it so the next poll falls back to a
      // per-doc comparison for this doc instead of trusting a stale rev.
      s.docRev.delete(ev.id);
    }
    schedulePersist(col, s.docs, s.docRev);
    this.notify(col, ev.id);
  }

  private snapshotFor(l: Listener) {
    const s = this.state(l.col);
    if (l.isDoc) {
      const data = s.docs.get(l.id);
      return {
        exists: () => !!data && Object.keys(data).length > 0,
        data: () => data || {},
        id: l.id,
      };
    }
    const docs = Array.from(s.docs.entries()).map(([id, d]) => ({ id, ...d }));
    const filtered = applyFilters(docs, l.filters);
    return {
      docs: filtered.map((d) => ({ id: d.id, data: () => d })),
    };
  }

  private notify(col: string, id?: string) {
    // W13 NEXT R8 (B2): every docs mutation funnels through notify, so
    // the getCollectionDocs snapshot cache invalidates here.
    this.invalidateDocsSnapshot(col);
    for (const l of [...this.listeners]) {
      if (l.col !== col) continue;
      if (l.isDoc && id !== undefined && l.id !== id) continue;
      this.deliver(l);
    }
  }

  /* ── E2EE decrypt-on-read (Worker E2) ──────────────────────────────
   * The stored cache holds ciphertext; listeners must only ever see
   * plaintext (or the decrypt-failed placeholder). Decrypt is async
   * (WebCrypto), so message-collection snapshots are delivered via an
   * async path; every other collection keeps the old synchronous path.
   * Results are memoized by a fingerprint of the ciphertext fields, so
   * repeat notifies / the 3s poll do not redo WebCrypto work. The memo
   * is the "decrypted view" that the sync getCollectionDocs() serves. */

  // W13 NEXT R8 (B2): per-collection snapshot cache for getCollectionDocs.
  // The chat list calls getCollectionDocs() for every active collection on
  // every preview check (3 s cadence + on every subscription delivery +
  // on every render's sort), and each call rebuilt the whole decrypted
  // view: a spread per doc + a JSON.stringify fingerprint per doc (16
  // fields incl. editHistory/reactions/pollVotes) just to test the
  // decrypt memo — even on a memo HIT. Profiled on the /main settle
  // tail: ~63% of busy samples sat in that path (decryptFingerprint
  // 4.0% self, anon spread/JSON 2.9%, memoHit 1.6%, getCollectionDocs
  // 0.8%). The snapshot is the final array getCollectionDocs returns,
  // cached per collection and served as a shallow copy (callers may
  // sort in place — ChatScreen does). Invalidation contract (audited):
  // EVERY mutation of s.docs funnels through notify() (putRaw, remove,
  // merge, event-apply, restorePersisted-if-added, refreshDoc, rollback,
  // ensure-completion), so notify() invalidates; memoPut() invalidates
  // because an async warm-decrypt completion changes the served view;
  // releaseCollection() invalidates because it drops decrypt-memo
  // entries (and with dropCache clears docs) without notifying; reset()
  // clears the whole cache. A collection that is still loading caches
  // its (empty) snapshot and the load completion notifies, so the next
  // call rebuilds. No semantics change: same array contents, same order,
  // same first-call-ciphertext behaviour.
  private docsSnapshotCache = new Map<string, any[]>();
  private static readonly DOCS_SNAPSHOT_CACHE_MAX = 500;
  private invalidateDocsSnapshot(col: string): void {
    this.docsSnapshotCache.delete(col);
  }
  private decryptMemo = new Map<string, { fp: string; doc: any; gen: string }>();

  /**
   * Peer-key generation for a messages collection ('' for anything else).
   * A memoized decrypt is only valid for the generation it was computed
   * with: when the peer key arrives/changes AFTER a message was first
   * decrypted (and failed), the old memoized "decrypt-failed" copy must
   * NOT be served — the message may decrypt fine now. Worker A.
   */
  private decryptMemoGen(col: string): string {
    const chatId = chatIdFromMessagesCollection(col);
    // W16 (#183): a stored/rotated group sender key must invalidate the
    // memo exactly like a peer key does, or a group message that failed
    // before the key arrived keeps serving its decrypt-failed copy.
    return chatId ? `${getPeerKeyGeneration(chatId)}|${getGroupKeyGeneration(chatId)}` : '';
  }

  /** Memoized decrypted copy, valid only for the current ciphertext AND the current peer-key generation. */
  private memoHit(col: string, id: string, fp: string): any | null {
    const hit = this.decryptMemo.get(`${col}/${id}`);
    if (!hit || hit.fp !== fp || hit.gen !== this.decryptMemoGen(col)) return null;
    return hit.doc;
  }

  private memoPut(col: string, id: string, fp: string, doc: any): void {
    // W13 NEXT R8 (B2): an async warm-decrypt completion changes the
    // served decrypted view — drop the snapshot so the next read rebuilds.
    this.invalidateDocsSnapshot(col);
    if (this.decryptMemo.size >= 2000) {
      const first = this.decryptMemo.keys().next().value;
      if (first !== undefined) this.decryptMemo.delete(first);
    }
    this.decryptMemo.set(`${col}/${id}`, { fp, doc, gen: this.decryptMemoGen(col) });
  }

  /**
   * Drop memoized decrypted copies for one chat (or all when chatId is
   * null) and re-notify listeners so they re-decrypt with the current
   * keys. Called when a peer key arrives / changes / is wiped: a message
   * that failed to decrypt before the key existed must heal live instead
   * of showing "couldn't decrypt" until a reload.
   */
  public invalidateDecryptMemoForChat(chatId?: string | null): void {
    if (chatId) {
      const col = `chats/${chatId}/messages`;
      for (const key of [...this.decryptMemo.keys()]) {
        if (key.startsWith(`${col}/`)) this.decryptMemo.delete(key);
      }
      this.notify(col);
      return;
    }
    this.decryptMemo.clear();
    for (const col of [...this.cols.keys()]) {
      if (isMessagesCollection(col)) this.notify(col);
    }
  }

  private decryptFingerprint(doc: any): string {
    try {
      return JSON.stringify({
        e: doc.e2ee ?? null,
        ec: doc.e2eeCaption ?? null,
        t: doc.text ?? null,
        c: doc.caption ?? null,
        r: doc.replyTo ?? null,
        h: doc.editHistory ?? null,
        // W22 (#87): the saved-copy metadata envelope — a meta-only
        // change must invalidate the memo too, or the memoized copy
        // serves stale poll/location/contact fields.
        em: doc.e2eeMeta ?? null,
        enc: doc.encryption ?? null,
        // R1: metadata-only writes must invalidate the memo too, or a
        // reaction / read receipt / poll vote saved on the server is never
        // shown live (the memoized copy without it is served instead).
        // These fields are plaintext metadata, never ciphertext.
        reactions: doc.reactions ?? null,
        status: doc.status ?? null,
        deliveredAt: doc.deliveredAt ?? null,
        seenAt: doc.seenAt ?? null,
        pollVotes: doc.pollVotes ?? null,
        kept: doc.kept ?? null,
        viewed: doc.viewed ?? null,
        deleted: doc.deleted ?? null,
      });
    } catch {
      return '';
    }
  }

  /** Decrypted copy of a stored message doc (memoized; never mutates the stored doc). */
  private async decryptedDoc(col: string, id: string, raw: any): Promise<any> {
    const fp = this.decryptFingerprint(raw);
    const hitDoc = this.memoHit(col, id, fp);
    if (hitDoc !== null) return hitDoc;
    const dec = await decryptMessageDocForRead(col, raw);
    this.memoPut(col, id, fp, dec);
    return dec;
  }

  /** Best-effort background decrypt so getCollectionDocs() can serve plaintext. */
  private warmDecrypt(col: string, id: string, raw: any): void {
    if (!isMessagesCollection(col)) return;
    const fp = this.decryptFingerprint(raw);
    if (this.memoHit(col, id, fp) !== null) return;
    void this.decryptedDoc(col, id, raw).catch(() => {});
  }

  /** Snapshot with message docs decrypted (collection + single-doc listeners). */
  private async deliveredSnapshot(l: Listener): Promise<any> {
    const raw = this.snapshotFor(l);
    if (l.isDoc) {
      const data = raw.data();
      if (!data || Object.keys(data).length === 0) return raw;
      // L2: fingerprint first — an unchanged doc returns its cached
      // decrypted copy without re-awaiting / re-decrypting anything.
      const fp = this.decryptFingerprint(data);
      const hitDoc = this.memoHit(l.col, l.id, fp);
      if (hitDoc !== null) return { exists: raw.exists, id: raw.id, data: () => hitDoc };
      const dec = await this.decryptedDoc(l.col, l.id, data);
      return { exists: raw.exists, id: raw.id, data: () => dec };
    }
    // L2: compare fingerprints first and skip unchanged docs entirely —
    // only docs whose fingerprint actually changed go through
    // decryptedDoc (WebCrypto). Unchanged docs return the cached
    // decrypted copy synchronously, in original order.
    const docs: any[] = new Array(raw.docs.length);
    const pending: Promise<void>[] = [];
    raw.docs.forEach((d: any, i: number) => {
      const rawDoc = d.data();
      const fp = this.decryptFingerprint(rawDoc);
      const hitDoc = this.memoHit(l.col, d.id, fp);
      if (hitDoc !== null) {
        docs[i] = { id: d.id, data: () => hitDoc };
        return;
      }
      pending.push(
        this.decryptedDoc(l.col, d.id, rawDoc).then((dec) => {
          docs[i] = { id: d.id, data: () => dec };
        }),
      );
    });
    await Promise.all(pending);
    return { docs };
  }

  /** Deliver one snapshot to one listener (decrypting for message collections). */
  private deliver(l: Listener): void {
    if (!isMessagesCollection(l.col)) {
      try {
        l.cb(this.snapshotFor(l));
      } catch (e) {
        console.warn('Snapshot listener error:', e);
      }
      return;
    }
    void this.deliveredSnapshot(l)
      .then((snap) => {
        // The listener may have unsubscribed while decrypting.
        if (!this.listeners.includes(l)) return;
        try {
          l.cb(snap);
        } catch (e) {
          console.warn('Snapshot listener error:', e);
        }
      })
      .catch(() => {
        // Decrypt must never swallow the snapshot: fall back to raw.
        if (!this.listeners.includes(l)) return;
        try {
          l.cb(this.snapshotFor(l));
        } catch { /* intentionally ignored */}
      });
  }

  /**
   * AUDIT-2 C2 (3A §4): subscribe to a SINGLE doc without loading its
   * whole collection. Until this existed, every doc subscription
   * (`onSnapshot(doc(db, 'users', uid))`, the typing meta doc, the
   * pinned doc, …) called `ensure()`, which downloaded the ENTIRE
   * collection and started the 3 s full-fetch poll — to watch one doc.
   * Now only that doc is loaded (GET_DOC in AWS mode, IndexedDB
   * restore in local mode). Live updates still arrive via the
   * collection's AppSync subscription — the server has no per-doc
   * subscription, so events are filtered to this id by notify() — and
   * the 3 s fallback refreshes just the watched docs (see startPoll),
   * never the whole collection.
   * Honest limits: the AppSync subscription itself is still
   * per-collection (the server broadcasts every doc change in it; the
   * client drops the ones that aren't this doc) and a collection that
   * is ALSO watched whole by another listener still downloads fully.
   * True server-side filtering needs the backend (BACKEND-PLAN §16).
   */
  public subscribeDoc(col: string, id: string, cb: ListenerCallback): () => void {
    const listener: Listener = { path: `${col}/${id}`, col, id, isDoc: true, filters: [], cb };
    this.listeners.push(listener);
    this.deliver(listener);
    this.subscribeCol(col);
    // Skip the load when the doc is already cached — the synchronous
    // deliver() above already served it. Check the DOC, not `loaded`:
    // a collection can be loaded while this doc is still missing (it
    // was created — or seeded — after the load), and skipping the load
    // then leaves the subscription permanently empty.
    if (!this.state(col).docs.has(id)) void this.ensureDoc(col, id);
    this.startPoll(col);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== listener);
      if (!this.listeners.some((l) => l.col === col)) this.stopPoll(col);
    };
  }

  /** Load just one doc: from IndexedDB in local mode, from the server (GET_DOC) in AWS mode. */
  private async ensureDoc(col: string, id: string): Promise<void> {
    if (!isAwsConfigured()) {
      // Local mode has no server to GET from; restorePersisted loads the
      // persisted collection from disk (a local read, no transfer) and
      // notifies, exactly as ensure() did for doc subscriptions before.
      await this.restorePersisted(col);
      // AUDIT-2 C2 (3B): the collection may already be loaded while
      // this doc is still missing (created — or seeded — after the
      // load); restorePersisted then early-returns, so fill just this
      // one doc from disk instead of leaving the subscription empty.
      await this.restorePersistedDoc(col, id);
      this.notify(col, id);
      return;
    }
    await this.refreshDoc(col, id);
  }

  /**
   * Re-read ONE doc from the IndexedDB cache (local mode), regardless of
   * whether its collection is marked loaded. Only fills the doc when it
   * is absent from the cache and not tombstoned — never overwrites a
   * live in-memory doc with the stale disk copy (see restorePersisted).
   */
  private async restorePersistedDoc(col: string, id: string): Promise<void> {
    const s = this.state(col);
    if (s.docs.has(id) || s.tombstones.has(id)) return;
    try {
      const docs = await idbGet(col);
      if (!docs) return;
      const found = docs.find(([docId]) => docId === id);
      if (found && found[1] !== null && found[1] !== undefined) {
        if (isMessagesCollection(col)) stampReceiptTimes(found[1]);
        s.docs.set(id, found[1]);
        this.notify(col, id);
      }
    } catch { /* intentionally ignored */}
  }

  public subscribe(path: string, cb: ListenerCallback, filters: any[] = []): () => void {
    const { col, id, isDoc } = splitPath(path);
    // AUDIT-2 C2 (3A §4): a doc subscription must not ensure() the
    // whole collection — route it through the scoped path. Collection /
    // query subscriptions keep the old behaviour (full ensure).
    if (isDoc) return this.subscribeDoc(col, id, cb);
    const listener: Listener = { path, col, id, isDoc, filters, cb };
    this.listeners.push(listener);
    // #138 (W30i): a subscribe proves this collection is wanted — mark it
    // used so the idle-docs prune never evicts a live collection.
    this.state(col).lastUsedAt = Date.now();
    this.deliver(listener);
    this.ensure(col);
    // AUDIT-2 C5 / W2C: ensure() is a no-op when the collection is
    // already loaded — but its subscription may have been released since
    // (see releaseCollection). Re-establish it here; subscribeCol() is a
    // no-op when a subscription is already live (or in local mode).
    this.subscribeCol(col);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== listener);
      if (!this.listeners.some((l) => l.col === col)) this.stopPoll(col);
    };
  }

  public async readDoc(col: string, id: string): Promise<any | null> {
    const s = this.state(col);
    if (s.loaded) {
      // W12d (100-more C7): the loaded branch used to return the
      // in-memory map verbatim, so a doc that landed in IndexedDB AFTER
      // the collection loaded was invisible until a reload — a call-link
      // guest seeded after load saw "This call link doesn't point to a
      // Pinglo user any more". In local mode there is no live
      // subscription to heal the map, so fill just this doc from disk
      // before reporting "not found" — the same restorePersistedDoc the
      // not-loaded branch already uses, and it never overwrites a live
      // doc (it returns early when the doc is present or tombstoned).
      if (!isAwsConfigured() && !s.docs.has(id)) await this.restorePersistedDoc(col, id);
      return s.docs.get(id) ?? null;
    }
    // AUDIT-2 C2 (3A §4): scoped (doc-only) subscriptions cache the
    // docs they watch — serve a cached doc instead of a network GET.
    // Anything in the cache got there via a GET_DOC, a live event or a
    // local write, so it is fresh; an absent doc still goes to the
    // network below. This keeps updateDoc (e.g. every typing write)
    // from paying a GET before its PUT on a watched doc.
    if (s.docs.has(id)) return s.docs.get(id) ?? null;
    // RETEST-1: in local mode there is no server to read from — serve the
    // restored cache instead of throwing "No AmplifyContext available".
    // Restore first: one-shot reads (e.g. CallLinkScreen's user lookup)
    // run before any subscription ensures the collection, so the
    // in-memory cache would otherwise be empty and every lookup would
    // wrongly report "not found".
    if (!isAwsConfigured()) {
      await this.restorePersisted(col);
      // AUDIT-2 C2 (3B): restorePersisted is a no-op once the collection
      // is loaded, but the doc may have arrived on disk after the load
      // — fill just it before reporting "not found".
      if (!s.docs.has(id)) await this.restorePersistedDoc(col, id);
      return s.docs.get(id) ?? null;
    }
    const res: any = await gql().graphql({ query: GET_DOC, variables: { col, id } });
    return parseData(res?.data?.getDoc?.data);
  }

  public async put(col: string, id: string, data: any): Promise<void> {
    return this.putRaw(col, id, data, true);
  }

  /**
   * Write a doc (optimistic local update + GraphQL). On failure the local
   * copy rolls back AND — Phase 3 — the write is queued in the offline
   * outbox (unless queueOnFailure is false, i.e. this IS the retry) so it
   * is retried when connectivity returns instead of being silently lost.
   */
  public async putRaw(col: string, id: string, data: any, queueOnFailure = true): Promise<void> {
    // W7 (#79/#146 — P0 DATA LOSS): restore the collection from
    // IndexedDB BEFORE touching the in-memory map. putRaw used to write
    // the doc into a possibly-empty map and the debounced whole-map
    // persist then overwrote IndexedDB with that partial map — saving
    // one message wiped every previously saved message (4→1) whenever
    // the collection had never been subscribed in this page session.
    // The restore runs at most once per collection (restored flag) and
    // only fills docs absent from the map, so a live in-memory doc is
    // never clobbered by the stale disk copy.
    {
      const rs = this.state(col);
      if (!rs.restored && !rs.loaded) await this.restorePersisted(col);
    }
    // E2EE (Worker E2 + Master E2EE): encrypt message docs BEFORE they touch
    // the local cache or the network — every writer (addDoc/setDoc/updateDoc,
    // the offline retry) funnels through here, so this is the one choke point.
    // Already-encrypted docs pass through unchanged (idempotent: the
    // offline retry and reaction/status updateDocs re-put the stored doc).
    // Key-exchange protocol docs have nothing encryptable and pass through
    // untouched. A rewrite that changes no encryptable content (read
    // receipt, reaction, pin) is NOT re-encrypted, so a legacy plaintext
    // message is never silently upgraded by being read.
    const s0 = this.state(col);
    const prev0 = s0.docs.get(id);
    if (
      isMessagesCollection(col) &&
      data &&
      typeof data === 'object' &&
      !isKeyExchangeDoc(data) &&
      !isGroupKeyExchangeDoc(data)
    ) {
      if (encryptableContentChanged(prev0, data)) {
        // W16 (#183): group sends encrypt with the sender key now — the
        // marked-legacy plaintext fallback for groups is GONE (fail-closed
        // like 1-to-1). Whether this chat is a group comes from the
        // communities doc: the sync cache read is free (ChatScreen
        // subscribes to the group doc, so it is cached whenever a group
        // send happens from the chat). When it is NOT cached we treat the
        // chat as a DM and fail closed — never assume "group" and send
        // plaintext. The catch below does one best-effort server read
        // (2s cap) for the uncached case (scheduled / share sends) and
        // retries as a group instead of falling back to plaintext.
        const chatId = chatIdFromMessagesCollection(col);
        const senderId =
          typeof (data as any).senderId === 'string' ? (data as any).senderId : undefined;
        const cachedCommunity = chatId ? this.readCached('communities', chatId) : undefined;
        const group = chatId ? isGroupChat(chatId, cachedCommunity) : false;
        try {
          data = await encryptMessageDocForStore(col, data, { isGroup: group, senderId });
        } catch (firstErr) {
          let retriedAsGroup = false;
          if (!group && chatId) {
            try {
              const communityDoc = await Promise.race([
                this.readDoc('communities', chatId),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
              ]);
              if (isGroupChat(chatId, communityDoc)) {
                data = await encryptMessageDocForStore(col, data, {
                  isGroup: true,
                  senderId,
                });
                retriedAsGroup = true;
              }
            } catch {
              // Retry failed (or the doc is not a group) — fall through
              // to the fail-closed throw of the original error below.
            }
          }
          if (!retriedAsGroup) {
            // AUDIT-2 A10 FAIL-CLOSED: a message whose encryption failed
            // must NOT send as plaintext — re-throw so the send fails
            // honestly (the text returns to the composer for retry).
            // This holds for group chats too since W16 (#183).
            throw firstErr;
          }
        }
      }
    }
    const s = this.state(col);
    const prev = s.docs.get(id);
    // AUDIT-2 C4: (1) cap editHistory — it grew by arrayUnion on every
    // edit with no bound, so a much-edited message doc grew forever.
    // Keep the last MAX_EDIT_HISTORY_ENTRIES entries and flag the trim
    // so the message-info sheet can say so honestly. (2) refuse an
    // oversized doc BEFORE the optimistic local write — never
    // show-then-rollback, never silently drop. Both run here (the one
    // choke point for updateDoc, the offline flush and addDoc) rather
    // than in any one writer, so no path can bypass them. The trim only
    // ever shrinks the doc, so the size check runs after it.
    if (isMessagesCollection(col) && data && typeof data === 'object' && Array.isArray((data as any).editHistory) && (data as any).editHistory.length > MAX_EDIT_HISTORY_ENTRIES) {
      data = { ...data, editHistory: (data as any).editHistory.slice(-MAX_EDIT_HISTORY_ENTRIES), editHistoryTruncated: true };
    }
    assertDocSizeWithinLimit(col, id, data);
    // B14: a local write after a delete means the doc is alive again
    // (e.g. a meta doc re-created after an unpin) — the tombstone must
    // not strip it from the next poll snapshot.
    s.tombstones.delete(id);
    s.docs.set(id, data);
    s.touched.set(id, Date.now());
    // R1 belt & braces: drop only this doc's decrypt-memo entry so the
    // next snapshot re-decrypts it (the fingerprint change alone would
    // also invalidate it, but a write must never serve a stale copy).
    // The server revision for this doc is unknown until the PUT returns /
    // the next poll, so drop it too — the poll then falls back to a
    // per-doc comparison for this doc instead of trusting a stale rev.
    this.decryptMemo.delete(`${col}/${id}`);
    s.docRev.delete(id);
    // #223/#232 (W5b R29): user-profile docs and key-exchange protocol
    // docs persist IMMEDIATELY (awaited) instead of riding the 1 s
    // debounce — a kx/users write followed within 1 s by a navigation,
    // sign-out or backgrounding used to lose the write entirely, and
    // the peer then never saw the ack (mock transport) while the
    // sender's runner had already marked it acked. Regular message
    // writes keep the debounce (bursts coalesce; the server is the
    // transport on configured builds).
    if (col === 'users' || (data && typeof data === 'object' && isKeyExchangeDoc(data))) {
      await persistNow(col, s.docs, s.docRev);
    } else {
      schedulePersist(col, s.docs, s.docRev);
    }
    this.notify(col, id);
    // RETEST-1: local mode has no backend — the optimistic write above IS
    // the durable write. The old code fell through to the GraphQL PUT,
    // which throws without Amplify config, so putRaw rolled the local copy
    // back and persisted the rollback: no message (or any write) ever
    // survived a reload in mock mode, and cross-session DMs were
    // untestable. Real-backend behaviour below is unchanged.
    if (!isAwsConfigured()) return;
    try {
      const res: any = await gql().graphql({
        query: PUT_DOC,
        variables: { col, id, data: JSON.stringify(data) },
      });
      assertNoGraphqlErrors(res, 'write');
      // AUDIT-2 C1: record the server revision from the PUT response so
      // the rev-probe poll can prove this doc unchanged without a full
      // fetch. Only when the cached doc is still the one this PUT wrote
      // (a newer local write — or a live event — in the meantime owns
      // the next PUT's / event's rev instead).
      if (s.docs.get(id) === data) {
        const putUpdatedAt = res?.data?.putDoc?.updatedAt;
        if (putUpdatedAt !== null && putUpdatedAt !== undefined) s.docRev.set(id, putUpdatedAt);
      }
    } catch (e) {
      // Roll the local copy back so the screen does not show a change that never saved
      if (prev === undefined) s.docs.delete(id);
      else s.docs.set(id, prev);
      // The rolled-back doc is not the written one: drop its memo entry
      // too, so the next snapshot re-decrypts the restored copy.
      this.decryptMemo.delete(`${col}/${id}`);
      s.touched.set(id, Date.now());
      schedulePersist(col, s.docs, s.docRev);
      this.notify(col, id);
      if (queueOnFailure) {
        try {
          // B2/B9: label a failed whole-message write so readers of the
          // outbox (ChatScreen's queued list) can show it as a queued
          // message instead of losing it silently. `prev === undefined`
          // means this PUT created the doc — i.e. a new message send;
          // anything else is an update (reaction, receipt, edit, ...).
          enqueueOfflineOp({
            kind: 'put',
            col,
            docId: id,
            data,
            label: isMessagesCollection(col) && prev === undefined ? 'message' : undefined,
          });
        } catch { /* intentionally ignored */}
      }
      throw e;
    }
  }

  /**
   * Hard-delete a doc. The local delete is immediate and final on screen;
   * the server DELETE is retried via the offline outbox when it fails, so
   * a failed delete can never reappear from the next poll snapshot (B14).
   * @param queueOnFailure when false (the outbox retry itself) a failed
   * DELETE throws without re-queueing, so the flush loop can back off /
   * park it instead of duplicating the op.
   */
  public async remove(col: string, id: string, queueOnFailure = true): Promise<void> {
    // W7 (#79/#146): same restore-before-write as putRaw — deleting
    // from a never-restored collection would persist a partial map and
    // wipe the rest of the collection from IndexedDB.
    {
      const rs = this.state(col);
      if (!rs.restored && !rs.loaded) await this.restorePersisted(col);
    }
    const s = this.state(col);
    // B14: tombstone FIRST — from this instant the 3s poll must not
    // re-add the doc from a server snapshot that still lists it.
    s.tombstones.set(id, Date.now());
    // B14: a stale queued write for this doc must not resurrect it later.
    try {
      dropQueuedOpsForDoc(col, id);
    } catch { /* intentionally ignored */}
    s.docs.delete(id);
    s.docRev.delete(id);
    this.decryptMemo.delete(`${col}/${id}`);
    s.touched.set(id, Date.now());
    schedulePersist(col, s.docs, s.docRev);
    this.notify(col, id);
    // RETEST-1: local mode — no backend to delete from; the local delete
    // above is final. (The old code fell through to GraphQL and threw
    // "No AmplifyContext available" to callers after deleting locally.)
    if (!isAwsConfigured()) {
      s.tombstones.delete(id);
      return;
    }
    try {
      const res: any = await gql().graphql({ query: DELETE_DOC, variables: { col, id } });
      assertNoGraphqlErrors(res, 'delete');
      // Server confirmed: the tombstone has served its purpose.
      s.tombstones.delete(id);
    } catch (e) {
      // The local delete stands (tombstone keeps the poll from re-adding
      // it) and the DELETE itself is queued for retry — the doc stays
      // gone on this device and the server catches up on reconnect.
      if (queueOnFailure) {
        try {
          enqueueOfflineOp({ kind: 'delete', col, docId: id, data: {} });
        } catch { /* intentionally ignored */}
      }
      throw e;
    }
  }

  /** Cached documents of a collection (synchronous). Triggers a background load if needed. */
  public getCollectionDocs(colPath: string): any[] {
    this.ensure(colPath);
    // W13 NEXT R8 (B2): serve the cached snapshot when nothing changed
    // (see the invalidate contract above). The slice keeps the cached
    // array itself immutable for callers that sort in place.
    const cached = this.docsSnapshotCache.get(colPath);
    if (cached) return cached.slice();
    const s = this.cols.get(colPath);
    if (!s) return [];
    const docs = Array.from(s.docs.entries()).map(([id, d]) => ({ id, ...d }));
    let result: any[];
    if (!isMessagesCollection(colPath)) {
      result = docs;
    } else {
      // E2EE key-exchange protocol docs are not chat messages: they never
      // reach sync readers (chat-list preview / unread counts, search,
      // push notifications, Dev AI history, storage counts). The live
      // snapshot path (ChatScreen) sees them and handles the exchange.
      // W16 (#183): group key-exchange docs are protocol docs too.
      const chatDocs = docs.filter((d) => !isKeyExchangeDoc(d) && !isGroupKeyExchangeDoc(d));
      // E2EE (Worker E2): serve the decrypted view when it is ready; kick
      // off background decrypt for the rest (callers such as the chat list
      // re-render on a 3s tick and then see plaintext). First call for a
      // fresh doc returns the stored (ciphertext) doc, never a blank.
      result = chatDocs.map((d) => {
        const hitDoc = this.memoHit(colPath, d.id, this.decryptFingerprint(d));
        if (hitDoc !== null) return { id: d.id, ...hitDoc };
        this.warmDecrypt(colPath, d.id, d);
        return d;
      });
    }
    if (this.docsSnapshotCache.size >= RemoteStore.DOCS_SNAPSHOT_CACHE_MAX) {
      const first = this.docsSnapshotCache.keys().next().value;
      if (first !== undefined) this.docsSnapshotCache.delete(first);
    }
    this.docsSnapshotCache.set(colPath, result);
    return result.slice();
  }

  /**
   * Report 3 #223/#232 (W5b): the key-exchange protocol docs of a
   * collection — the ones `getCollectionDocs` filters out by design.
   * Synchronous, cache-only: reads `this.cols` directly and never calls
   * `ensure()` / starts a load, so callers decide when a collection is
   * loaded (exactly like `getLoadedMessages` in ChatListScreen). Only
   * docs where `isKeyExchangeDoc` holds are returned, in stored order.
   * Returned raw (no decrypt — kx docs carry public keys only, never
   * message content). `getCollectionDocs` semantics are unchanged.
   */
  public getKeyExchangeDocs(colPath: string): any[] {
    const s = this.cols.get(colPath);
    if (!s) return [];
    const docs = Array.from(s.docs.entries()).map(([id, d]) => ({ id, ...d }));
    return docs.filter((d) => isKeyExchangeDoc(d));
  }

  public getAllChatChannels(): string[] {
    this.ensure('chats');
    const channels = new Set<string>();
    const chats = this.cols.get('chats');
    if (chats) {
      for (const id of chats.docs.keys()) if (!id.startsWith('saved_')) channels.add(id);
    }
    for (const [col] of this.cols) {
      if (col.startsWith('chats/')) {
        const cid = col.split('/')[1];
        if (cid && !cid.startsWith('saved_')) channels.add(cid);
      }
    }
    return Array.from(channels);
  }

  /**
   * 100M-H7: conversation ids whose `chats/<id>/messages` collection
   * exists in the persisted IndexedDB cache (`pinglo-cache` /
   * `collections` — the same store `restorePersisted` reads from), even
   * when no collection has been loaded into memory yet. `getAllChatChannels`
   * only sees in-memory state, so on a fresh load — before the chat list
   * or any chat has loaded anything — it returns nothing and a scan over
   * it finds no media. Read-only: lists keys, never writes. Best-effort:
   * returns [] when IndexedDB is unavailable or the read fails. `saved_`
   * channels are excluded, matching `getAllChatChannels` (callers add
   * the saved channel explicitly).
   */
  public async listPersistedChatChannels(): Promise<string[]> {
    const keys: unknown = await withCacheStore(
      'readonly',
      (store) =>
        new Promise((resolve) => {
          const req = store.getAllKeys();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        }),
      null,
    );
    const ids = new Set<string>();
    if (Array.isArray(keys)) {
      for (const k of keys) {
        const id = parsePersistedChatChannelId(k);
        if (id) ids.add(id);
      }
    }
    return [...ids];
  }

  /** Drop cached data and subscriptions (call on sign-in / sign-out). */
  public async reset(): Promise<void> {
    // #223/#232 (W5b R14/R15): flush pending debounced persists BEFORE
    // dropping the in-memory maps — and AWAIT the commit. schedulePersist()
    // holds a 1 s timer that writes the LIVE map to IndexedDB; reset()
    // replaces those maps (cols.clear()) and the next users write
    // re-schedules the persist, which clearTimeout()s the still-pending
    // first timer — so a write made <1 s before a sign-out/switch (e.g.
    // the signup profile write) NEVER reaches disk. The next restore
    // then reads a doc that was never persisted, and a merge onto the
    // empty base (clearPushToken at logout, presence heartbeat) writes a
    // skeleton into the users doc. Proven by probe-w5b-r15-dump: BOTH
    // users docs on disk were ONLY {online, status, pushToken,
    // pushPlatform, pushTokenUpdatedAt, lastSeen, callLink} — no uid /
    // email / displayName / username / photoURL / bio — so ChatListScreen's
    // users filter dropped both accounts, discovery enqueued nothing,
    // and the list-only auto-ack never fired (B's list stayed
    // "No chats yet"). The fire-and-forget flush (9e08fe7) was NOT
    // enough: idbPut resolves on tx.oncomplete, and a read racing the
    // uncommitted put still sees pre-flush disk — so the flush is
    // awaited here, and restorePersisted() ALSO overlays any still-
    // pending map (see below) to cover racers that never await reset().
    // On a configured build the idbClearAll() below still wipes the
    // cache afterwards (server is the source of truth there); flushing
    // first only orders the two operations correctly.
    await flushPendingPersistsAsync();
    for (const s of this.cols.values()) {
      try {
        s.sub?.unsubscribe();
      } catch  { /* intentionally ignored */}
      clearTimeout(s.retryTimer);
      // Stop the old polling interval too, or every sign-in would leave one running
      if (s.poll) {
        clearInterval(s.poll);
        s.poll = null;
      }
    }
    this.cols.clear();
    this.pending.clear();
    // W13 NEXT R8 (B2): drop the getCollectionDocs snapshots with the maps.
    this.docsSnapshotCache.clear();
    // E2EE (Worker E2): a sign-out must not leave the previous account's
    // decrypted messages in memory for the next account.
    this.decryptMemo.clear();
    // Phase 3: a sign-out must not leave the previous account's cached
    // messages on disk for the next account to restore.
    // #223/#232 (W5b R7): wipe the disk cache ONLY on a configured build.
    // In mock/hybrid mode the IndexedDB cache IS the data — there is no
    // server to re-download from — so wiping it on every sign-in/out
    // deletes the only copy of every message, including key-announce docs.
    // The 24 h announce throttle lives in the 'pinglo-e2ee' store +
    // localStorage (NOT wiped), so it keeps suppressing re-announce while
    // the doc is gone: A believes it announced, B never sees anything,
    // and every send fails closed forever (proven by probe-w5b-r7b: the
    // announce survived 15 s + navigation but vanished on re-login, and
    // B's list stayed "No chats yet"). On a configured build the server
    // re-downloads after the wipe, so the privacy wipe stays.
    if (isAwsConfigured()) void idbClearAll();
    const active = [...this.listeners];
    for (const l of active) {
      if (l.isDoc) {
        // AUDIT-2 C2 (3A §4): a doc listener re-establishes scoped, not
        // whole-collection — same as subscribeDoc().
        this.subscribeCol(l.col);
        void this.ensureDoc(l.col, l.id).then(() => this.notify(l.col, l.id));
        this.startPoll(l.col);
      } else {
        void this.ensure(l.col).then(() => this.notify(l.col));
      }
    }
  }
}


// Amplify resolves GraphQL errors instead of throwing, so check them explicitly.
// Otherwise a rejected write looks successful and reverts on the next load.
function assertNoGraphqlErrors(res: any, what: string) {
  const errors = res?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const msg = String(errors[0]?.message || 'unknown error');
    console.warn(`DB ${what} failed:`, msg);
    throw new Error(msg);
  }
}

export const db = new RemoteStore();

// E2EE (Worker A): a newly exchanged / rotated peer key can make
// previously undecryptable messages decryptable — drop the memoized
// decrypt-failed copies and re-deliver so the chat heals without reload.
onPeerKeyChanged((chatId) => {
  try {
    db.invalidateDecryptMemoForChat(chatId);
  } catch { /* intentionally ignored */}
});

// W16 (#183): same for group sender keys — a member's key arriving late
// heals their earlier messages without a reload.
onGroupKeyChanged((chatId) => {
  try {
    db.invalidateDecryptMemoForChat(chatId);
  } catch { /* intentionally ignored */}
});

export const resetDbCache = () => db.reset();

/** Flush the offline outbox now (e.g. after sign-in, or from a UI retry button). */
export const flushOfflineWrites = () => flushOfflineQueue();

// Phase 3 — offline outbox wiring: a failed `put` is retried (without
// re-queueing) when connectivity returns. Registered once at module load.
registerOfflineHandler('put', async (op) => {
  if (!op.col || !op.docId) throw new Error('Offline put op is missing col/docId');
  // B14: a stale queued write must not resurrect a message deleted after
  // it was queued (e.g. an edit queued offline, then delete-for-everyone
  // landed first). The delete wins; the stale write is dropped silently.
  // readCachedAny: the collection may not have finished loading when the
  // flush runs (e.g. startup flush), and a load-gated read would miss
  // the soft-deleted doc entirely.
  const cached = db.readCachedAny(op.col, op.docId);
  if (cached && (cached as any).deleted && !(op.data as any)?.deleted) {
    console.warn(`[offlineQueue] dropping stale queued write for deleted doc ${op.col}/${op.docId}`);
    return;
  }
  await db.putRaw(op.col, op.docId, op.data, false);
});

// AUDIT-2 B2/B9/B11: the single-source offline send. A queued text send
// is flushed through here with its ORIGINAL send time (`data.at` written
// as the message `timestamp`) — never the flush time — and the stable
// docId generated at enqueue time, so a retried flush overwrites the
// same doc instead of creating a duplicate message.
registerOfflineHandler('message', async (op) => {
  if (!op.col || !op.docId) throw new PermanentQueueError('Offline message op is missing col/docId');
  const d = (op.data || {}) as any;
  const text = typeof d.text === 'string' ? d.text : '';
  if (text.length === 0 && !d.mediaUrl) throw new PermanentQueueError('Offline message op has no content');
  // D5: the 5000-char limit applies to queued sends too — an over-long
  // op is invalid for good, not something to retry 5× and park.
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new PermanentQueueError(`Message too long (max ${MAX_MESSAGE_CHARS.toLocaleString()} characters)`);
  }
  const doc = { ...d, id: op.docId, timestamp: d.at ?? d.timestamp ?? Date.now() };
  await db.putRaw(op.col, op.docId, doc, false);
});

// AUDIT-2 B14: a hard delete whose server DELETE failed is retried here
// (without re-queueing) until it lands; the tombstone in the collection
// state keeps the doc gone locally meanwhile.
registerOfflineHandler('delete', async (op) => {
  if (!op.col || !op.docId) throw new PermanentQueueError('Offline delete op is missing col/docId');
  await db.remove(op.col, op.docId, false);
});
startOfflineQueue();

// ── Firestore-compatible helpers ──

export interface DocRef {
  path: string;
}

export interface CollectionRef {
  path: string;
}

export interface QueryRef {
  path: string;
  filters: any[];
}

export function doc(_db: any, ...pathSegments: string[]): DocRef {
  return { path: pathSegments.filter(Boolean).join('/') };
}

export function collection(_db: any, ...pathSegments: string[]): CollectionRef {
  return { path: pathSegments.filter(Boolean).join('/') };
}

export function query(col: CollectionRef, ...filters: any[]): QueryRef {
  return { path: col.path, filters };
}

export function where(field: string, op: string, value: any) {
  return { type: 'where', field, op, value };
}

export function orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
  return { type: 'orderBy', field, dir };
}

export function serverTimestamp() {
  return Date.now();
}

export function arrayUnion(value: any) {
  return { __op: 'arrayUnion', value };
}

export function arrayRemove(value: any) {
  return { __op: 'arrayRemove', value };
}

export function increment(value: number) {
  return { __op: 'increment', value };
}

export function deleteField() {
  return { __op: 'deleteField' };
}

export function onSnapshot(
  target: DocRef | QueryRef | CollectionRef,
  callback: (snapshot: any) => void
): () => void {
  const filters = 'filters' in target && (target as QueryRef).filters ? (target as QueryRef).filters : [];
  return db.subscribe(target.path, callback, filters);
}

export async function getDoc(docRef: DocRef) {
  const { col, id } = splitPath(docRef.path);
  const data = await db.readDoc(col, id);
  return {
    exists: () => !!data && Object.keys(data).length > 0,
    data: () => data || {},
    id,
  };
}

export async function setDoc(docRef: DocRef, data: any, options?: { merge?: boolean }) {
  const { col, id } = splitPath(docRef.path);
  if (options?.merge) {
    const existing = (await db.readDoc(col, id)) || {};
    return db.put(col, id, { ...existing, ...data });
  }
  return db.put(col, id, data);
}

// Apply a Firestore-style field operation to the current value
function applyFieldOp(current: any, v: any): any {
  if (v.__op === 'arrayUnion') {
    const arr = Array.isArray(current) ? [...current] : [];
    if (!arr.includes(v.value)) arr.push(v.value);
    return arr;
  }
  if (v.__op === 'arrayRemove') {
    return (Array.isArray(current) ? current : []).filter((x: any) => x !== v.value);
  }
  if (v.__op === 'increment') {
    return (Number(current) || 0) + v.value;
  }
  return current;
}

const isFieldOp = (v: any) => v && typeof v === 'object' && typeof v.__op === 'string';

/** Merge Firestore-style updates (incl. dotted keys + field ops) onto a base doc. */
function applyUpdates(base: Record<string, any>, updates: Record<string, any>): Record<string, any> {
  const updated: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(updates)) {
    if (k.includes('.')) {
      // Nested field (e.g. 'reactions.uid'). Check field ops first: deleteField on a
      // nested key must remove that key, not store the operation object.
      const [parentKey, ...rest] = k.split('.');
      const childKey = rest.join('.');
      const parent: Record<string, any> = { ...(updated[parentKey] || {}) };
      if (isFieldOp(v)) {
        if (v.__op === 'deleteField') delete parent[childKey];
        else parent[childKey] = applyFieldOp(parent[childKey], v);
      } else {
        parent[childKey] = v;
      }
      updated[parentKey] = parent;
    } else if (isFieldOp(v)) {
      if (v.__op === 'deleteField') delete updated[k];
      else updated[k] = applyFieldOp(updated[k], v);
    } else {
      updated[k] = v;
    }
  }
  return updated;
}

/** Public alias for applyUpdates: ChatScreen builds an offline edit by
 * merging onto the STORED doc with exactly this merge (the same one
 * updateDoc does), so the queued op re-encrypts correctly at flush
 * instead of storing the decrypted view as plaintext. */
export const mergeDocFields = applyUpdates;

export async function updateDoc(docRef: DocRef, updates: Record<string, any>) {
  const { col, id } = splitPath(docRef.path);
  // R3: prefer the synchronous cached doc when the collection is loaded,
  // so no `await` (and therefore no interleaving concurrent write) sits
  // between the read and the merge. Only fall back to the network read
  // when the collection has never been loaded.
  const cached = db.readCached(col, id);
  const existing = cached !== undefined ? cached || {} : (await db.readDoc(col, id)) || {};
  // AUDIT-2 B14: an update must NEVER resurrect a deleted message doc as
  // an empty ghost (updateDoc on a missing doc used to merge onto {} and
  // PUT it back with only the update fields). Message collections only:
  // other collections (PIN private doc, call signalling, user doc) rely
  // on updateDoc-as-upsert and are untouched.
  // - cached === null: collection loaded, doc absent (deleted / never there).
  // - cached === undefined + readDoc returned nothing: absent server-side.
  if (isMessagesCollection(col)) {
    const absent = cached === null || (cached === undefined && Object.keys(existing).length === 0);
    if (absent) throw new Error(`Cannot update deleted or missing message ${col}/${id}`);
  }
  let updated = applyUpdates(existing, updates);

  // R3: re-read the freshest cached doc just before the PUT and re-apply
  // the updates onto it when it is a different object than the one merged
  // above (e.g. another reaction / read-receipt write landed in the
  // meantime). Skipped when it is the same object, so field ops such as
  // increment are never applied twice. The API still has no field-level
  // update, so this only narrows the read-modify-write race — it cannot
  // eliminate it for writers on other devices / tabs.
  const fresh = db.readCached(col, id);
  if (fresh !== undefined && fresh !== null && fresh !== existing) {
    updated = applyUpdates(fresh, updates);
  } else if (isMessagesCollection(col) && fresh === null) {
    // B14: the doc was deleted between the read and the PUT — stay deleted.
    throw new Error(`Cannot update deleted message ${col}/${id}`);
  }

  return db.put(col, id, updated);
}

export async function deleteDoc(docRef: DocRef) {
  const { col, id } = splitPath(docRef.path);
  return db.remove(col, id);
}

export async function addDoc(colRef: CollectionRef, data: any) {
  const id = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
  const docData = {
    ...data,
    id,
    timestamp: data.timestamp || Date.now(),
  };
  await db.put(colRef.path, id, docData);
  return { id };
}

// ── ROADMAP-2 item 10: per-user "clear chat" stamp ───────────────────────
// Clearing a chat hides its messages for THAT user only: the stamp lives
// on the user's own private doc (`users/{uid}/private/chatMeta`,
// `clearedAt: { [conversationId]: epochMs }`) — the same private-doc
// pattern lockedChats uses — so the other participant's copy is never
// touched and no message doc is ever deleted. ChatScreen filters
// `timestamp <= clearedAt` out of its own rendered list; messages sent
// after the stamp (timestamp > clearedAt) keep showing. A second clear
// just moves the stamp forward. `updateDoc` with a dotted key upserts
// the private doc (non-message collection) and merges the single
// conversation's stamp without clobbering other chats' stamps.
const chatMetaRef = (uid: string) => doc(db, 'users', uid, 'private', 'chatMeta');

/** Epoch ms this user cleared this conversation at, or 0 (never cleared). */
export async function getClearedAt(uid: string, conversationId: string): Promise<number> {
  if (!uid || !conversationId) return 0;
  try {
    const snap = await getDoc(chatMetaRef(uid));
    if (!snap.exists()) return 0;
    const map = (snap.data() as any)?.clearedAt;
    const v = map && typeof map === 'object' ? map[conversationId] : undefined;
    return typeof v === 'number' && v > 0 ? v : 0;
  } catch (e) {
    console.warn('[database] getClearedAt failed:', e);
    return 0;
  }
}

/** Stamp "this user cleared this conversation at `ts`" (default: now). Returns the stamp. */
export async function setClearedAt(uid: string, conversationId: string, ts: number = Date.now()): Promise<number> {
  if (!uid || !conversationId) throw new Error('setClearedAt needs a user and a conversation');
  await updateDoc(chatMetaRef(uid), { [`clearedAt.${conversationId}`]: ts });
  return ts;
}
