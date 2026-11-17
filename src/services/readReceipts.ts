/**
 * Read receipts (Item 12, Master-gaps Cluster B).
 *
 * The toggle lives on the user doc (`users/{uid}.readReceipts`, written by
 * SettingsScreen, default ON when absent). ChatScreen subscribes to that
 * doc live and, when receipts are OFF, never writes 'seen' (caps at
 * 'delivered') and renders its own outgoing ticks capped at delivered —
 * the WhatsApp-symmetric behaviour. WA72 settings #24: the OFF gate is
 * DM-only — WhatsApp always sends read receipts in group chats, so
 * ChatScreen/ChatListScreen use `receiptsEffective = readReceipts ||
 * isGroup` at every gate (seen writes, tick caps, Read-by list).
 *
 * One side effect of never writing 'seen': the chat-list unread badge is
 * computed from `status !== 'seen'`, so a chat you opened with receipts
 * OFF would look unread forever. That badge is LOCAL — it must clear when
 * YOU read the chat even though the sender gets no receipt. So ChatScreen
 * stamps a local-only "read at" marker (localStorage, never sent anywhere)
 * when the chat is open with receipts OFF, and ChatListScreen treats
 * messages at/before that stamp as locally read for the badge only.
 * Nothing here is sent to the server or the peer.
 */

/** Default ON: an absent field means receipts are enabled. */
export function readReceiptsEnabled(userData: any): boolean {
  return userData?.readReceipts !== false;
}

// ── AUDIT-2 B15: unread count must not depend on the sender's clock ──
// The old badge rule compared the sender's `timestamp`/`at` against the
// local "read up to" stamp, so a sender whose clock ran fast made their
// messages look already-read (badge missing) and a slow clock made old
// messages look unread forever. database.ts now stamps every message doc
// the first time THIS device sees it:
//   - `receivedAt`: this device's clock at receipt (receiver-side time)
//   - `serverStampedAt`: the server's `updatedAt` for the doc, when known
// The badge rule below uses only those two, never the sender's fields.
// True cross-device unread sync still needs the backend (a per-user
// server-side read marker — BACKEND-PLAN.md §15); this fixes the
// clock-dependence on this device. Callers: ChatListScreen's getChatPreview
// should replace `(Number(m.timestamp) || 0) > localReadAt` with
// countUnreadMessages(msgs, uid, localReadAt).
const cleanUid = (v: unknown): string =>
  String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');

/** Receiver-side receipt time for a message doc, or 0 when unstamped. */
export function messageReceiptTime(m: any): number {
  if (!m || typeof m !== 'object') return 0;
  return Number(m.receivedAt) || Number(m.serverStampedAt) || 0;
}

/** Badge rule for one message: someone else's, not seen/viewed, and received after the local "read up to" stamp. */
export function isMessageUnreadForBadge(m: any, myUid: string, localReadAt: number, ownSeenUpTo?: SeenUpTo | null): boolean {
  if (!m || typeof m !== 'object') return false;
  if (m.deleted) return false;
  if (cleanUid(m.senderId) === cleanUid(myUid)) return false;
  if (m.status === 'seen' || m.viewed) return false;
  // AUDIT-2 C5: my own watermark says I read this message (e.g. from
  // another device, or before localStorage was cleared) — it is read
  // even when the per-message status was never written.
  if (ownSeenUpTo && isMessageCoveredBySeenUpTo(m, ownSeenUpTo)) return false;
  const rt = messageReceiptTime(m);
  // No receipt stamp yet (legacy doc not yet re-stamped by the next poll):
  // the status alone says unread — count it rather than hide a real unread.
  if (!rt) return true;
  return rt > localReadAt;
}

/** Unread-badge count for a chat's messages, clock-skew-proof. */
export function countUnreadMessages(messages: any[], myUid: string, localReadAt: number, ownSeenUpTo?: SeenUpTo | null): number {
  let n = 0;
  for (const m of messages || []) {
    if (isMessageUnreadForBadge(m, myUid, localReadAt, ownSeenUpTo)) n++;
  }
  return n;
}

// ── AUDIT-2 C5: `seenUpTo` / `deliveredUpTo` watermark ─────────────────
// One mutation per chat instead of one per unread message: the receiver
// writes a single marker on the chat doc —
//   seenUpTo:      { [uid]: { msgId, msgTimestamp, at } }
//   deliveredUpTo: { [uid]: { msgId, msgTimestamp, at } }
// — carrying the highest message they have seen / that reached them,
// and every reader derives each message's seen/delivered state from it.
// Ordering is by the sender's (timestamp, id): a message is covered
// when its timestamp is below the watermark's, or equal with an id that
// sorts at-or-before the watermark's id (ids are `msg_<ts>_<rand>`, so
// same-timestamp ids order deterministically). A message with no usable
// timestamp is covered only by exact id match. `at` is the receiver's
// clock at the moment of reading (for the message-info "Seen" time); it
// is display only, never used for coverage, so sender clock skew cannot
// fake a read. Older clients that still write per-message `status:
// 'seen'` / `'delivered'` keep working: effectiveMessageStatus()
// treats either signal as seen/delivered.
// Honest limits: the watermark is a per-chat whole-doc PUT (updateDoc
// read-modify-write, B13 race — a concurrent peer write can be
// clobbered; the server-side field-level update is the full fix,
// BACKEND-PLAN.md §15), and groups use the furthest-reader
// approximation (one reader's watermark marks the message seen — the
// same shared-status approximation the old per-message status used).
// The unread badge does NOT read the watermark for other devices'
// reads — it clears from this device's local "read up to" stamp
// (markChatReadLocally, stamped by ChatScreen whenever the chat is on
// screen) plus this device's own watermark when available.

/** One participant's read/delivery watermark on a chat doc. */
export interface SeenUpTo {
  /** Id of the highest message seen / delivered. */
  msgId: string;
  /** Sender timestamp of that message. */
  msgTimestamp: number;
  /** Receiver's clock (ms) when it was read — display only. */
  at: number;
}

/** One participant's watermark from a map, trying the cleaned uid first, then the raw uid (older writers used raw). */
export function seenUpToForUser(map: Record<string, SeenUpTo> | null | undefined, uid: string): SeenUpTo | null {
  if (!map) return null;
  return map[cleanUid(uid)] ?? map[uid] ?? null;
}

/** Order two watermarks by (msgTimestamp, msgId). */
export function compareSeenUpTo(a: SeenUpTo, b: SeenUpTo): number {
  if (a.msgTimestamp !== b.msgTimestamp) return a.msgTimestamp < b.msgTimestamp ? -1 : 1;
  if (a.msgId === b.msgId) return 0;
  return a.msgId < b.msgId ? -1 : 1;
}

/** The newer of two watermarks (null-safe). A flush must never regress the stored marker. */
export function mergeSeenUpTo(existing: SeenUpTo | null | undefined, next: SeenUpTo | null | undefined): SeenUpTo | null {
  if (!existing) return next ?? null;
  if (!next) return existing;
  return compareSeenUpTo(next, existing) > 0 ? next : existing;
}

/** Highest incoming (not mine, not deleted) message in `messages`, or null when there is none. */
export function pickSeenUpTo(messages: any[], myUid: string): SeenUpTo | null {
  let best: SeenUpTo | null = null;
  for (const m of messages || []) {
    if (!m || typeof m !== 'object' || m.deleted || !m.id) continue;
    if (cleanUid(m.senderId) === cleanUid(myUid)) continue;
    const cand: SeenUpTo = { msgId: String(m.id), msgTimestamp: Number(m.timestamp) || 0, at: Date.now() };
    if (!best || compareSeenUpTo(cand, best) > 0) best = cand;
  }
  return best;
}

/** True when the watermark covers this message (see ordering rule above). */
export function isMessageCoveredBySeenUpTo(m: any, wm: SeenUpTo | null | undefined): boolean {
  if (!m || typeof m !== 'object' || !wm || !wm.msgId) return false;
  if (String(m.id || '') === String(wm.msgId)) return true;
  const mTs = Number(m.timestamp) || 0;
  const wTs = Number(wm.msgTimestamp) || 0;
  if (!mTs || !wTs) return false;
  if (mTs !== wTs) return mTs < wTs;
  return String(m.id || '') <= String(wm.msgId);
}

/** The watermark in `wmByUid` (excluding `myUid`) that covers this message, or null. */
function coveringWatermark(m: any, wmByUid: Record<string, SeenUpTo> | null | undefined, myUid?: string): SeenUpTo | null {
  if (!wmByUid) return null;
  for (const [uid, wm] of Object.entries(wmByUid)) {
    if (myUid && cleanUid(uid) === cleanUid(myUid)) continue;
    if (isMessageCoveredBySeenUpTo(m, wm)) return wm;
  }
  return null;
}

/** One member's receipt for a message: their uid + the watermark's `at` time. */
export interface MemberReceipt {
  uid: string;
  /** Receiver's clock (ms) when they read / received the message — display only. */
  at: number;
}

/**
 * G1 (nightshift): per-member receipts for one message. Every other
 * participant whose watermark in `wmByUid` covers the message, earliest
 * first. Pure function — no test runner in the repo yet; first candidate
 * for one when it lands (cover: self excluded, uncovered excluded,
 * `at <= 0` excluded, ascending order).
 */
export function receiptsByMember(
  m: any,
  wmByUid: Record<string, SeenUpTo> | null | undefined,
  myUid?: string,
): MemberReceipt[] {
  if (!m || typeof m !== 'object' || !wmByUid) return [];
  const out: MemberReceipt[] = [];
  for (const [uid, wm] of Object.entries(wmByUid)) {
    if (myUid && cleanUid(uid) === cleanUid(myUid)) continue;
    if (!wm || typeof wm.at !== 'number' || wm.at <= 0) continue;
    if (isMessageCoveredBySeenUpTo(m, wm)) out.push({ uid, at: wm.at });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * Effective tick status for one message, from the per-message `status`
 * AND every other participant's watermarks. A message is 'seen' when
 * its own status says so (older clients) or any other participant's
 * seen watermark covers it; 'delivered' likewise from status or any
 * other participant's delivered watermark. Groups use the
 * furthest-reader approximation (see header). `myUid` entries are
 * ignored — my own watermark says what I read, not what the peer read.
 *
 * Wave-2 A5 (DM #41): 'pending' wins over every delivered state. A
 * message still uploading (`uploading: true`, the optimistic media
 * placeholder) or explicitly queued (`status: 'pending' | 'queued'`)
 * has no delivery state yet — WA shows a clock icon, not a tick, so
 * the caller (MessageTicks) must see 'pending', never 'sent'.
 */
export function effectiveMessageStatus(
  m: any,
  seenUpToByUid: Record<string, SeenUpTo> | null | undefined,
  deliveredUpToByUid?: Record<string, SeenUpTo> | null | undefined,
  myUid?: string,
): 'pending' | 'sent' | 'delivered' | 'seen' {
  if (!m || typeof m !== 'object') return 'sent';
  // Wave-2 A5 (DM #41): not-yet-sent — clock, not a tick. Checked
  // first so a stale watermark can never mask an in-flight upload.
  if (m.uploading === true || m.status === 'pending' || m.status === 'queued') return 'pending';
  if (m.status === 'seen' || coveringWatermark(m, seenUpToByUid, myUid)) return 'seen';
  if (m.status === 'delivered' || coveringWatermark(m, deliveredUpToByUid, myUid)) return 'delivered';
  return 'sent';
}

/** 'Seen' time to show for a message: its own seenAt, else the covering seen watermark's `at`, else null. */
export function seenAtForMessage(m: any, seenUpToByUid: Record<string, SeenUpTo> | null | undefined, myUid?: string): number | null {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.seenAt === 'number' && m.seenAt > 0) return m.seenAt;
  const wm = coveringWatermark(m, seenUpToByUid, myUid);
  return wm && typeof wm.at === 'number' && wm.at > 0 ? wm.at : null;
}

/** 'Delivered' time to show for a message: its own deliveredAt, else the covering delivered watermark's `at`, else null. */
export function deliveredAtForMessage(m: any, deliveredUpToByUid: Record<string, SeenUpTo> | null | undefined, myUid?: string): number | null {
  if (!m || typeof m !== 'object') return null;
  if (typeof m.deliveredAt === 'number' && m.deliveredAt > 0) return m.deliveredAt;
  const wm = coveringWatermark(m, deliveredUpToByUid, myUid);
  return wm && typeof wm.at === 'number' && wm.at > 0 ? wm.at : null;
}

const localReadKey = (uid: string, conversationId: string) =>
  `dt_read_local_${uid}_${conversationId}`;

/** Record that this device's user has read this chat up to now (local only). */
export function markChatReadLocally(uid: string, conversationId: string): void {
  try {
    localStorage.setItem(localReadKey(uid, conversationId), String(Date.now()));
  } catch { /* intentionally ignored */}
}

/** Epoch ms this chat was last read locally with receipts OFF, or 0. */
export function getLocalReadAt(uid: string, conversationId: string): number {
  try {
    return Number(localStorage.getItem(localReadKey(uid, conversationId))) || 0;
  } catch {
    return 0;
  }
}
