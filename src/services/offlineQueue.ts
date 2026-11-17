/**
 * Offline send queue (Phase 3, Agent C; AUDIT-2 B2/B9/B11/B12 single source).
 *
 * LocalStorage-backed outbox for writes that fail while offline (or while
 * the AppSync session is not ready). Items are retried with exponential
 * backoff when the browser comes back online, up to MAX_ATTEMPTS, then
 * PARKED (never silently dropped) and reported via onDrop so the UI can
 * offer a manual Retry.
 *
 * AUDIT-2: this module is the SINGLE source for offline sends. ChatScreen
 * used to keep a second, per-chat localStorage queue beside this one, so
 * one message could send 2–3× and a queue stranded when its chat closed
 * before reconnect. That queue is deleted: screens enqueue here
 * (kind 'message', with the ORIGINAL send time in `data.at` — the flush
 * handler writes it as the message `timestamp`, never the flush time)
 * and the app-wide flush (window 'online', 30 s tick, foreground,
 * post-sign-in) drains it no matter which screen is open.
 *
 * Design: this module knows NOTHING about the database layer (no import
 * of ../aws/database) so database.ts can import it without a cycle.
 * Callers register a handler per `kind`; database.ts registers the
 * 'put'/'message'/'delete' handlers, screens register others.
 */

export type OfflineOpKind = 'put' | 'message' | 'generic' | 'delete';

export interface OfflineOp {
  id: string;
  kind: OfflineOpKind;
  /** Collection path, e.g. 'chats/<id>/messages' (for 'put'). */
  col?: string;
  /** Doc id within the collection (for 'put'). */
  docId?: string;
  /** Payload to write / send. */
  data: any;
  attempts: number;
  /** Epoch ms before which this item must not be retried. */
  nextAttemptAt: number;
  createdAt: number;
  lastError?: string;
  /**
   * AUDIT-2 B2/B9: what a 'put' op carries, so readers (ChatScreen's
   * queued list) can tell a not-yet-sent message from a metadata update.
   * - 'message': a whole new message doc (send failed / queued offline).
   * - 'edit': an edit of an existing message queued while offline.
   * - undefined: any other whole-doc write (reaction, receipt, ...).
   * Set by database.ts's putRaw for failed writes; set explicitly by
   * ChatScreen for offline edits.
   */
  label?: 'message' | 'edit';
}

/** Max message length (D5) — enforced on every send path, online and offline. */
export const MAX_MESSAGE_CHARS = 5000;

/**
 * AUDIT-2 D5: a permanently-invalid op (e.g. over the length limit) must
 * never be retried 5× and parked — the flush loop drops it at once and
 * reports it via onDrop instead.
 */
export class PermanentQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentQueueError';
  }
}

export function isPermanentQueueError(e: unknown): boolean {
  return e instanceof PermanentQueueError;
}

/** Stable message-doc id for a queued offline send (same shape as addDoc). */
export function newOfflineMessageId(): string {
  return 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
}

export const OFFLINE_QUEUE_KEY = 'pinglo_offline_queue';
/** Parked ops that exhausted auto-retries (L4): kept, visible and retryable — never silently lost. */
export const OFFLINE_FAILED_KEY = 'pinglo_offline_failed';
export const OFFLINE_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
/** L4: periodic retry while the app is open — a PUT that fails while
 * `navigator.onLine` stays true (AppSync error, token expiry, throttling)
 * used to sit forever until the next restart / connectivity flap. */
export const OFFLINE_FLUSH_INTERVAL_MS = 30_000;

type Handler = (op: OfflineOp) => Promise<void>;

const handlers = new Map<OfflineOpKind, Handler>();
let onDropCb: ((op: OfflineOp, reason: string) => void) | null = null;
/** L4: fired on every failed attempt (not only on drop) so callers can log / surface it. */
let onFailCb: ((op: OfflineOp, error: string, attemptsLeft: number) => void) | null = null;
let flushing = false;
let onlineListenerAttached = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let visibilityListenerAttached = false;
/**
 * AUDIT-2 B2: change subscribers (ChatScreen's greyed queued list).
 * Fired on every mutation of the active or parked queue so a screen can
 * re-read without polling. Callbacks must never throw (guarded).
 */
const queueListeners = new Set<() => void>();
export function subscribeOfflineQueue(cb: () => void): () => void {
  queueListeners.add(cb);
  return () => {
    queueListeners.delete(cb);
  };
}
function emitQueueChanged(): void {
  for (const cb of [...queueListeners]) {
    try {
      cb();
    } catch { /* intentionally ignored */}
  }
}
const onOnlineEvent = () => {
  void flushOfflineQueue();
};
const onVisibilityEvent = () => {
  if (!document.hidden) void periodicFlush();
};

function load(): OfflineOp[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((o) => o && o.id && o.data !== undefined) : [];
  } catch {
    return [];
  }
}

function save(items: OfflineOp[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(OFFLINE_QUEUE_KEY);
    else localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Storage full / unavailable: the queue is best-effort, never fatal.
  }
  emitQueueChanged();
}

export function registerOfflineHandler(kind: OfflineOpKind, handler: Handler): void {
  handlers.set(kind, handler);
}

export function onOfflineOpDropped(cb: (op: OfflineOp, reason: string) => void): void {
  onDropCb = cb;
}

/** L4: register a callback fired on every failed flush attempt (op, error, attempts left). */
export function onOfflineOpFailed(cb: (op: OfflineOp, error: string, attemptsLeft: number) => void): void {
  onFailCb = cb;
}

function loadFailed(): OfflineOp[] {
  try {
    const raw = localStorage.getItem(OFFLINE_FAILED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((o) => o && o.id && o.data !== undefined) : [];
  } catch {
    return [];
  }
}

function saveFailed(items: OfflineOp[]): void {
  try {
    if (items.length === 0) localStorage.removeItem(OFFLINE_FAILED_KEY);
    else localStorage.setItem(OFFLINE_FAILED_KEY, JSON.stringify(items));
  } catch {
    // Storage full / unavailable: best-effort, never fatal.
  }
  emitQueueChanged();
}

/**
 * AUDIT-2 B14: drop every queued/parked WRITE op for one doc (called when
 * the doc is hard-deleted). A stale queued write flushing after the delete
 * would resurrect the doc — the delete must win. Queued 'delete' ops for
 * the same doc are deliberately KEPT: remove() itself calls this, and the
 * outbox 'delete' retry must survive its own remove() call (dropping it
 * would lose a failed DELETE instead of backing it off / parking it).
 */
export function dropQueuedOpsForDoc(col: string, docId: string): void {
  const isStaleWrite = (o: OfflineOp) => o.col === col && o.docId === docId && o.kind !== 'delete';
  save(load().filter((o) => !isStaleWrite(o)));
  saveFailed(loadFailed().filter((o) => !isStaleWrite(o)));
}

/** Ops that exhausted auto-retries: parked, not lost. Shown in the UI with a Retry action. */
export function getFailedOfflineOps(): OfflineOp[] {
  return loadFailed();
}

/** Move a parked op back into the outbox (attempts reset) and flush immediately. */
export function retryOfflineOp(id: string): void {
  const failed = loadFailed();
  const op = failed.find((o) => o.id === id);
  if (!op) return;
  saveFailed(failed.filter((o) => o.id !== id));
  const items = load();
  const reset: OfflineOp = { ...op, attempts: 0, nextAttemptAt: 0, lastError: undefined };
  if (!items.some((o) => o.id === reset.id)) items.push(reset);
  save(items);
  void flushOfflineQueue();
}

/** Retry every parked op. */
export function retryAllFailedOfflineOps(): void {
  const failed = loadFailed();
  if (failed.length === 0) return;
  saveFailed([]);
  const items = load();
  for (const op of failed) {
    if (!items.some((o) => o.id === op.id)) {
      items.push({ ...op, attempts: 0, nextAttemptAt: 0, lastError: undefined });
    }
  }
  save(items);
  void flushOfflineQueue();
}

/** Discard a parked op for good (explicit user action only). */
export function discardFailedOfflineOp(id: string): void {
  saveFailed(loadFailed().filter((o) => o.id !== id));
}

function newId(): string {
  return 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Enqueue an op. For 'put'/'message'/'delete' ops the same (col, docId)
 * replaces any older queued write, so a doc edited twice offline only
 * sends its latest state — and a re-queued send never creates a second
 * copy. The LATEST intent wins: a delete supersedes a pending write for
 * the same doc (and vice versa), so the kind is adopted from the new op.
 * The ORIGINAL send time travels in `data.at` for 'message' ops (B11);
 * `createdAt` is only the enqueue time and must never be used as the
 * message timestamp.
 */
export function enqueueOfflineOp(op: Omit<OfflineOp, 'id' | 'attempts' | 'nextAttemptAt' | 'createdAt'> & Partial<Pick<OfflineOp, 'id'>>): OfflineOp {
  const items = load();
  if ((op.kind === 'put' || op.kind === 'message' || op.kind === 'delete') && op.col && op.docId) {
    const existing = items.find((i) => (i.kind === 'put' || i.kind === 'message' || i.kind === 'delete') && i.col === op.col && i.docId === op.docId);
    if (existing) {
      existing.data = op.data;
      if (op.label !== undefined) existing.label = op.label;
      // Adopt the kind: a 'message' op carries the original-time mapping
      // in its handler (a replaced 'put' for the same doc must not flush
      // by the plain put handler), and a 'delete' must supersede a
      // pending write for the same doc.
      existing.kind = op.kind;
      existing.attempts = 0;
      existing.nextAttemptAt = 0;
      save(items);
      return existing;
    }
  }
  const full: OfflineOp = {
    id: op.id || newId(),
    kind: op.kind,
    col: op.col,
    docId: op.docId,
    data: op.data,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
    label: op.label,
  };
  items.push(full);
  save(items);
  return full;
}

export function getOfflineQueue(): OfflineOp[] {
  return load();
}

export function offlineQueueSize(): number {
  return load().length;
}

export function removeOfflineOp(id: string): void {
  save(load().filter((o) => o.id !== id));
}

export function clearOfflineQueue(): void {
  save([]);
}

/** Backoff for attempt N (0-based): 2s, 4s, 8s, 16s, 32s, capped at 60s. */
export function backoffForAttempt(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt), MAX_BACKOFF_MS);
}

/**
 * Try every due item once, in FIFO order. Items whose handler throws are
 * rescheduled with backoff; items past MAX_ATTEMPTS are dropped.
 * Safe to call repeatedly; concurrent calls are coalesced.
 */
export async function flushOfflineQueue(): Promise<{ sent: number; failed: number; dropped: number }> {
  if (flushing) return { sent: 0, failed: 0, dropped: 0 };
  if (typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine) {
    return { sent: 0, failed: 0, dropped: 0 };
  }
  flushing = true;
  const result = { sent: 0, failed: 0, dropped: 0 };
  try {
    const now = Date.now();
    for (const op of load()) {
      if (op.nextAttemptAt > now) continue;
      const handler = handlers.get(op.kind) || handlers.get('generic');
      if (!handler) continue;
      try {
        await handler(op);
        removeOfflineOp(op.id);
        result.sent += 1;
      } catch (e) {
        // D5: a permanently-invalid op (e.g. over the length limit) is
        // dropped at once — retrying it 5× and parking it would only spam
        // the user with an unfixable Retry toast.
        if (isPermanentQueueError(e)) {
          removeOfflineOp(op.id);
          result.dropped += 1;
          const reason = String((e as Error)?.message || 'invalid op');
          console.warn(`[offlineQueue] DROPPED permanently-invalid ${op.kind} ${op.col || ''}/${op.docId || op.id}:`, reason);
          try {
            onDropCb?.(op, reason);
          } catch { /* intentionally ignored */}
          continue;
        }
        const attempts = op.attempts + 1;
        const errMsg = String((e as any)?.message || e);
        const attemptsLeft = Math.max(0, OFFLINE_MAX_ATTEMPTS - attempts);
        // Loud: a failed send must never fail silently, even before it is parked.
        console.warn(`[offlineQueue] send failed (attempt ${attempts}/${OFFLINE_MAX_ATTEMPTS}, ${attemptsLeft} retr${attemptsLeft === 1 ? 'y' : 'ies'} left) for ${op.kind} ${op.col || ''}/${op.docId || op.id}:`, errMsg);
        try {
          onFailCb?.(op, errMsg, attemptsLeft);
        } catch { /* intentionally ignored */}
        if (attempts >= OFFLINE_MAX_ATTEMPTS) {
          removeOfflineOp(op.id);
          result.dropped += 1;
          // L4: PARK, don't silently drop. The op leaves the auto-retry
          // queue but stays in localStorage under OFFLINE_FAILED_KEY,
          // visible in the UI with a Retry action (retryOfflineOp).
          const failed = loadFailed();
          if (!failed.some((o) => o.id === op.id)) {
            failed.push({ ...op, attempts, lastError: errMsg });
            saveFailed(failed);
          }
          console.warn(`[offlineQueue] PARKED ${op.kind} ${op.col || ''}/${op.docId || op.id} after ${attempts} failed attempts — kept in failed outbox, retryable via retryOfflineOp('${op.id}'), NOT lost. Last error:`, errMsg);
          try {
            onDropCb?.(op, 'max attempts reached — parked for manual retry');
          } catch { /* intentionally ignored */}
        } else {
          const items = load();
          const cur = items.find((i) => i.id === op.id);
          if (cur) {
            cur.attempts = attempts;
            cur.lastError = String((e as any)?.message || e);
            cur.nextAttemptAt = Date.now() + backoffForAttempt(attempts);
            save(items);
          }
          result.failed += 1;
        }
      }
    }
  } finally {
    flushing = false;
  }
  return result;
}

/** Flush due ops, then report. (AUDIT-2 B2: the synthetic-'online' nudge
 * that used to follow this is deleted — its only purpose was ChatScreen's
 * separate per-chat localStorage queue, which no longer exists; the single
 * outbox is flushed here, and scheduledMessages listens to 'online'
 * itself.) */
async function periodicFlush(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) return; // background: save battery/radio
  await flushOfflineQueue();
}

/**
 * Attach the 'online' listener once; flushes the queue when connectivity returns.
 * L4 additions: a 30 s periodic flush while the app is open, a flush when the
 * app returns to the foreground, and a flush right after auth (re)sign-in —
 * so a PUT that fails while `navigator.onLine` stays true no longer waits
 * for a restart or a connectivity flap.
 */
export function startOfflineQueue(): void {
  if (typeof window === 'undefined') return;
  if (!onlineListenerAttached) {
    onlineListenerAttached = true;
    window.addEventListener('online', onOnlineEvent);
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void periodicFlush();
    }, OFFLINE_FLUSH_INTERVAL_MS);
  }
  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', onVisibilityEvent);
  }
  // Also flush once at startup in case items were queued by a previous session.
  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    void flushOfflineQueue();
  }
}

/** Stop the periodic flush + listeners (sign-out / tests). Safe to call repeatedly. */
export function stopOfflineQueue(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnlineEvent);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityEvent);
  onlineListenerAttached = false;
  visibilityListenerAttached = false;
}

/**
 * L4: flush after an auth (re)sign-in or token refresh. There is NO
 * Amplify Hub / token-refresh listener anywhere in this repo to hook
 * into (Amplify refreshes tokens silently in the background), so App.tsx
 * calls this from onAuthStateChanged — the closest obvious hook — and
 * any future Hub listener should call this same function.
 */
export function flushOfflineQueueAfterAuthRefresh(): Promise<{ sent: number; failed: number; dropped: number }> {
  return flushOfflineQueue();
}
