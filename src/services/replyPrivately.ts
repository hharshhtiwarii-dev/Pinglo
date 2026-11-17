/**
 * Reply privately (Worker 3).
 *
 * "Reply privately" from a group message: opens (or starts) the 1-to-1 DM
 * with that message's author, with the original group message quoted as the
 * reply context, so the user can answer them without the group seeing it.
 *
 * How it works with the existing app (read-only reuse, nothing modified):
 * - DM identity is the deterministic id from `getConversationId` in
 *   `services/realtimeSync` — the same id ChatScreen computes for a DM.
 * - The DM route is the existing `/chat/<otherUid>` route (the same route
 *   StatusScreen and CallsScreen already use to open a DM). There is no
 *   explicit "create chat" API in the app: a DM chat record is created on
 *   first send, exactly like a status reply. Navigating is the create.
 * - The quoted group message cannot travel through the draft
 *   (`dt_draft_<conversationId>` is plain text ChatScreen reads on open),
 *   so it is staged as a one-shot pending-reply record in sessionStorage
 *   (`dt_pending_reply_<conversationId>`). ChatScreen must read it on open
 *   — see `takePendingReply()` below and the integration notes in the
 *   handoff. sessionStorage (not localStorage) so a stale quote never
 *   reappears after a reload.
 *
 * Honest limits:
 * - The quote is a *preview* of the group message (id + text + author
 *   name). If the DM is opened without ChatScreen consuming the pending
 *   reply (integration not done), the DM still opens — the quote is just
 *   lost. Nothing is auto-sent, ever: the user types and sends as normal.
 * - Channels (announcement-only communities) return `ok: false` with
 *   reason `'channel'`: there is no per-message author conversation to
 *   reply to there.
 * - Replying to yourself is a no-op (`reason: 'self'`).
 */

import { auth } from '../aws';
import { getConversationId } from './realtimeSync';

/** Minimal shape of the group message being replied to. */
export interface GroupMessageRef {
  /** Message id in the group chat (used for the quote; may be empty for legacy messages). */
  id: string;
  /** Message text; non-text messages should pass a placeholder like '[Photo]'. */
  text?: string;
}

export interface ReplyPrivatelyParams {
  /** Group/community chat id (the `chatId` route param of the group). */
  groupChatId: string;
  /** Uid of the message author. */
  authorUid: string;
  /** Display name of the author (falls back to 'Unknown'). */
  authorName?: string;
  /** The group message to quote. */
  message: GroupMessageRef;
  /** Group name, shown in the quote context if ChatScreen displays it. */
  groupName?: string;
  /**
   * True when the source chat is a public channel / announcement-only
   * community. The calling screen already knows this (`isChannelDoc` in
   * ChatScreen); pass it through so channels get a clean not-applicable
   * result instead of opening a DM.
   */
  isChannel?: boolean;
  /**
   * react-router `navigate` from the calling screen. When omitted the
   * service falls back to `window.location.assign(...)`.
   */
  navigate?: (path: string) => void;
}

export type ReplyPrivatelyReason =
  | 'self'
  | 'channel'
  | 'not-signed-in'
  | 'invalid-author'
  | 'invalid-group';

export interface ReplyPrivatelyResult {
  ok: boolean;
  /** Canonical DM conversation id (`getConversationId(myUid, authorUid)`). */
  dmChatId?: string;
  /** Route that was opened, e.g. `/chat/<authorUid>`. */
  dmRoute?: string;
  /** Machine-readable reason when `ok` is false. */
  reason?: ReplyPrivatelyReason;
  /** Human-readable explanation (safe to show in a toast). */
  message?: string;
}

/** The quote ChatScreen should show above the DM composer. */
export interface PendingReply {
  /** Id of the original group message. */
  id: string;
  /** Quoted text (truncated to 500 chars). */
  text: string;
  /** Author of the original message. */
  senderName: string;
  /** Group the message came from. */
  fromChatId: string;
  /** Group name, when known. */
  fromChatName?: string;
  /** When the reply was staged (ms since epoch). */
  at: number;
}

const PENDING_REPLY_PREFIX = 'dt_pending_reply_';
const QUOTE_MAX_CHARS = 500;

function pendingReplyKey(conversationId: string): string {
  return `${PENDING_REPLY_PREFIX}${conversationId}`;
}

/**
 * Stage the quoted group message for the DM. ChatScreen reads it on open
 * via `takePendingReply()` and sets it as its `replyTo` state.
 */
export function stagePendingReply(conversationId: string, reply: PendingReply): void {
  try {
    sessionStorage.setItem(pendingReplyKey(conversationId), JSON.stringify(reply));
  } catch {
    // Storage unavailable (private mode / quota): the DM still opens,
    // the quote is just lost. Never fail the navigation over this.
  }
}

/**
 * Read + remove the staged quote for a conversation. Returns null when
 * there is none (normal case) or when the stored record is malformed.
 * Call this once, on ChatScreen mount, after `conversationId` is known.
 */
export function takePendingReply(conversationId: string): PendingReply | null {
  try {
    const raw = sessionStorage.getItem(pendingReplyKey(conversationId));
    if (!raw) return null;
    sessionStorage.removeItem(pendingReplyKey(conversationId));
    const parsed = JSON.parse(raw) as PendingReply;
    if (!parsed || typeof parsed.text !== 'string' || typeof parsed.senderName !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Open the 1-to-1 DM with a group message's author, quoting that message.
 *
 * Returns `{ ok: true, dmChatId, dmRoute }` on success. On failure nothing
 * is navigated and nothing is staged; check `reason` / `message`.
 */
export function replyPrivately(params: ReplyPrivatelyParams): ReplyPrivatelyResult {
  const { groupChatId, authorUid, message } = params;
  const authorName = (params.authorName || '').trim() || 'Unknown';

  if (!groupChatId || !groupChatId.trim()) {
    return { ok: false, reason: 'invalid-group', message: 'Could not identify the group this message came from.' };
  }
  if (!authorUid || !authorUid.trim()) {
    return { ok: false, reason: 'invalid-author', message: 'Could not identify who sent this message.' };
  }

  const myUid = auth.currentUser?.uid;
  if (!myUid) {
    return { ok: false, reason: 'not-signed-in', message: 'You need to be signed in to reply privately.' };
  }

  if (authorUid === myUid) {
    return { ok: false, reason: 'self', message: 'This is your own message — reply to it in the group instead.' };
  }

  if (params.isChannel) {
    return {
      ok: false,
      reason: 'channel',
      message: 'Reply privately is not available for channel announcements.',
    };
  }

  const dmChatId = getConversationId(myUid, authorUid);
  const dmRoute = `/chat/${authorUid}`;

  // Stage the quote BEFORE navigating so ChatScreen can pick it up on open.
  const quoteText = (message.text || '').trim() || '[Message]';
  stagePendingReply(dmChatId, {
    id: message.id || '',
    text: quoteText.slice(0, QUOTE_MAX_CHARS),
    senderName: authorName,
    fromChatId: groupChatId,
    fromChatName: params.groupName?.trim() || undefined,
    at: Date.now(),
  });

  if (params.navigate) {
    params.navigate(dmRoute);
  } else if (typeof window !== 'undefined' && window.location) {
    window.location.assign(dmRoute);
  }

  return { ok: true, dmChatId, dmRoute };
}
