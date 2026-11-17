/**
 * Disappearing messages (Feature 2, Phase 1).
 *
 * The per-chat timer is stored on the chat doc (`chats/<conversationId>`) as
 * `disappearAfter`: a duration in milliseconds, or 0 = Off.
 *
 * Expiry is evaluated client-side at read time: a message is expired once
 * `now - message.timestamp >= disappearAfter`. The expiry sweeper
 * (`src/utils/expirySweeper.ts`, run from ChatScreen on chat open + the
 * 60 s tick) then HARD-DELETES expired docs via `deleteDoc` — local
 * cache + IndexedDB + the server delete (queued offline when needed).
 * There is still no SERVER-side sweep: an expired message survives on
 * the server (and the peer's copy) until some client opens the chat and
 * sweeps it, and media bytes in S3 are not removed by the client sweep.
 *
 * Message timestamps in this app are epoch milliseconds (see
 * `serverTimestamp()` in src/aws/database.ts), but Firestore Timestamp
 * objects / ISO strings are also accepted defensively.
 */

export type DisappearAfterMs = 0 | 86400000 | 604800000 | 7776000000;

export const DISAPPEAR_OFF = 0 as DisappearAfterMs;
/** 24 hours in ms */
export const DISAPPEAR_24H = 86400000 as DisappearAfterMs;
/** 7 days in ms */
export const DISAPPEAR_7D = 604800000 as DisappearAfterMs;
/** 90 days in ms */
export const DISAPPEAR_90D = 7776000000 as DisappearAfterMs;

export interface DisappearOption {
  value: DisappearAfterMs;
  /** Label shown in the picker, e.g. "24 hours". */
  label: string;
  /** Short label for the header/menu, e.g. "24h". */
  shortLabel: string;
}

export const DISAPPEAR_OPTIONS: DisappearOption[] = [
  { value: DISAPPEAR_OFF, label: 'Off', shortLabel: 'Off' },
  { value: DISAPPEAR_24H, label: '24 hours', shortLabel: '24h' },
  { value: DISAPPEAR_7D, label: '7 days', shortLabel: '7d' },
  { value: DISAPPEAR_90D, label: '90 days', shortLabel: '90d' },
];

/** True for one of the four supported timer values (0 = Off). */
export function isValidDisappearAfter(value: unknown): value is DisappearAfterMs {
  return (
    value === DISAPPEAR_OFF ||
    value === DISAPPEAR_24H ||
    value === DISAPPEAR_7D ||
    value === DISAPPEAR_90D
  );
}

/** Human-readable label for a stored timer value; unknown values read as "Off". */
export function disappearLabel(disappearAfter: number): string {
  return DISAPPEAR_OPTIONS.find((o) => o.value === disappearAfter)?.label ?? 'Off';
}

/**
 * Normalize a message timestamp to epoch milliseconds.
 * Accepts epoch ms numbers, Firestore Timestamps (`toDate()` / `seconds`),
 * Date objects and ISO strings. Returns null when there is no usable
 * timestamp — such a message is never auto-hidden.
 */
export function messageTimestampMs(ts: unknown): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return Number.isFinite(n) ? n : null;
  }
  if (ts instanceof Date) {
    const n = ts.getTime();
    return Number.isNaN(n) ? null : n;
  }
  if (typeof ts === 'object') {
    const obj = ts as Record<string, unknown>;
    if (typeof obj.toDate === 'function') {
      try {
        const d = (obj.toDate as () => unknown)();
        return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
      } catch {
        return null;
      }
    }
    if (typeof obj.seconds === 'number') return obj.seconds * 1000;
  }
  return null;
}

/**
 * True when a message is past the chat's disappearing-message timer.
 * `disappearAfter <= 0` means Off (nothing ever expires). Messages with no
 * usable timestamp are never treated as expired.
 *
 * Kept messages (Item 10, Master-gaps Cluster B) never expire: a message
 * with `kept: true` survives the timer until somebody explicitly unkeeps
 * it. The timer itself is untouched — only kept messages are exempt.
 */
export function isMessageExpired(
  msg: { timestamp?: unknown; kept?: boolean } | null | undefined,
  disappearAfter: number,
  now: number = Date.now(),
): boolean {
  if (isKeptMessage(msg)) return false;
  if (!disappearAfter || disappearAfter <= 0) return false;
  const sentAt = messageTimestampMs(msg?.timestamp);
  if (sentAt === null) return false;
  return now - sentAt >= disappearAfter;
}

/**
 * True when a message was explicitly kept in a disappearing chat
 * (`kept: true`, set from the long-press menu — see ChatScreen.keepMsg).
 * Kept messages are excluded from the disappearing hide/delete filter and
 * show a small "Kept" marker; unkeeping clears the flag and the timer
 * applies again from the original timestamp.
 */
export function isKeptMessage(
  msg: { kept?: boolean; keptBy?: unknown; keptAt?: unknown } | null | undefined,
): boolean {
  return msg?.kept === true;
}

/** Drop expired messages from a list (returns the same array when Off).
 * Kept messages (`kept: true`) are never dropped — see isMessageExpired. */
export function filterExpiredMessages<T extends { timestamp?: unknown; kept?: boolean }>(
  messages: T[],
  disappearAfter: number,
  now: number = Date.now(),
): T[] {
  if (!disappearAfter || disappearAfter <= 0) return messages;
  return messages.filter((m) => !isMessageExpired(m, disappearAfter, now));
}
