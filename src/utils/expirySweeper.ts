/**
 * Disappearing-message expiry enforcement — client sweeper (§1b).
 *
 * The timer itself is only a render filter (`ChatScreen.visibleMsgs`
 * drops expired messages, re-checked on a 60 s tick). This sweeper is
 * the enforcement: it HARD-DELETES expired message docs via `deleteDoc`
 * (`db.remove` in src/aws/database.ts) — the doc leaves the in-memory
 * cache, the IndexedDB `collections` store (via schedulePersist) and,
 * when AWS is configured, the server (GraphQL DELETE, retried from the
 * offline outbox when offline). That is real deletion, not hiding:
 * turning the timer off afterwards cannot resurrect a swept message.
 *
 * Rules (same condition as the render filter — `isMessageExpired`):
 * - only when `disappearAfter > 0` (timer Off sweeps nothing);
 * - only messages past `timestamp + disappearAfter`;
 * - `kept: true` messages are never swept;
 * - messages with no usable timestamp are never swept.
 *
 * Bounds (performance): at most MAX_DELETE_PER_RUN docs per run, and
 * callers throttle runs (ChatScreen reuses the existing 60 s
 * `disappearNow` tick — no second timer). Media bytes in S3 are NOT
 * removed by this sweeper (deleteDoc drops the doc, not the object);
 * a server-side sweep + media cleanup is still backend work.
 */
import { db, doc, deleteDoc } from '../aws';
import { isMessageExpired } from './disappearingMessages';

/** Cap per sweep run — a huge backlog deletes in bounded batches. */
export const EXPIRY_SWEEP_MAX_PER_RUN = 50;

export interface ExpirySweepResult {
  /** Ids actually deleted this run. */
  deleted: string[];
  /** Ids that failed to delete (kept in the list for the next run). */
  failed: string[];
  /** Expired ids left over because the per-run cap was hit. */
  deferred: string[];
}

/**
 * Pure selection step: which of `messages` are expired right now.
 * No I/O — unit-testable without the database. Returns the expired
 * docs in timestamp order (oldest first, so a capped run deletes the
 * oldest first).
 */
export function collectExpiredMessages<T extends { id?: string; timestamp?: unknown; kept?: boolean }>(
  messages: T[],
  disappearAfter: number,
  now: number = Date.now(),
): T[] {
  if (!disappearAfter || disappearAfter <= 0) return [];
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const expired = messages.filter((m) => m && m.id && isMessageExpired(m, disappearAfter, now));
  expired.sort((a, b) => {
    const ta = typeof a.timestamp === 'number' ? a.timestamp : 0;
    const tb = typeof b.timestamp === 'number' ? b.timestamp : 0;
    return ta - tb;
  });
  return expired;
}

/**
 * Delete expired messages for one conversation. Safe to call often:
 * no-ops when the timer is Off, when nothing is expired, or when the
 * conversation id is missing. Each delete is a hard `deleteDoc` on the
 * shared `chats/<conversationId>/messages/<id>` doc — i.e. deleted for
 * everyone, not just hidden for me. Failures are per-message (one bad
 * doc never blocks the rest) and reported in `failed` for retry.
 */
export async function sweepExpiredMessages(
  conversationId: string,
  messages: Array<{ id?: string; timestamp?: unknown; kept?: boolean }>,
  disappearAfter: number,
  now: number = Date.now(),
  maxPerRun: number = EXPIRY_SWEEP_MAX_PER_RUN,
): Promise<ExpirySweepResult> {
  const result: ExpirySweepResult = { deleted: [], failed: [], deferred: [] };
  if (!conversationId || !disappearAfter || disappearAfter <= 0) return result;
  const expired = collectExpiredMessages(messages, disappearAfter, now);
  if (expired.length === 0) return result;
  const batch = expired.slice(0, maxPerRun);
  result.deferred = expired.slice(maxPerRun).map((m) => String(m.id));
  for (const m of batch) {
    const id = String(m.id);
    try {
      await deleteDoc(doc(db, 'chats', conversationId, 'messages', id));
      result.deleted.push(id);
    } catch (e) {
      console.warn('[expirySweeper] deleteDoc failed for expired message', id, e);
      result.failed.push(id);
    }
  }
  if (result.deleted.length > 0) {
    console.log(
      `[expirySweeper] deleted ${result.deleted.length} expired message(s) in ${conversationId}` +
        (result.deferred.length > 0 ? ` (${result.deferred.length} deferred to next run)` : ''),
    );
  }
  return result;
}
