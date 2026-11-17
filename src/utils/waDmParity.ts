/**
 * WhatsApp DM parity helpers (WA audit — DM screen, worker B).
 *
 * Values the extracted WhatsApp Web client did NOT contain are marked
 * below and use the phone app's documented behaviour instead:
 * - Delete-for-everyone window (~2 days): no literal in the client.
 * - Forward cap (5 chats) + "Forwarded many times" (5+ hops): no literal.
 * - Per-sender name palette: no colour-by-sender rule in the client
 *   (atomic CSS); this is a WA-style 8-colour set, verify visually
 *   against the phone app before shipping.
 * Server-side enforcement of the delete window / disappearing expiry is
 * NOT here (BACKEND-PLAN.md) — this is the client-side gate only.
 */

/** WhatsApp phone app: Delete for everyone works ~2 days after sending. */
export const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** True when a message is still young enough to delete for everyone. */
export function canDeleteForEveryone(msg: any, now: number = Date.now()): boolean {
  if (!msg) return false;
  const t = typeof msg.timestamp === 'number'
    ? msg.timestamp
    : msg.timestamp?.toDate
      ? msg.timestamp.toDate().getTime()
      : Number(msg.timestamp) || 0;
  // No usable timestamp (legacy doc): allow — the server gate is the
  // backstop, and refusing an undatable message would strand it.
  if (!t) return true;
  return now - t <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

/** WhatsApp caps one forward at 5 chats at a time. */
export const FORWARD_CAP = 5;
/** A message forwarded 5+ times shows "Forwarded many times". */
export const FORWARDED_MANY_TIMES_MIN = 5;

export function isForwardedManyTimes(msg: any): boolean {
  return (Number(msg?.forwardCount) || 0) >= FORWARDED_MANY_TIMES_MIN;
}

/** WhatsApp forward label: plain forward is just "Forwarded". */
export function forwardLabel(msg: any): string | null {
  if (!msg?.forwardedFrom && !(Number(msg?.forwardCount) || 0)) return null;
  return isForwardedManyTimes(msg) ? 'Forwarded many times' : 'Forwarded';
}

/**
 * Per-sender colour for group sender names / quoted-reply bars.
 * WA-style 8-colour set (palette NOT FOUND in the extracted client —
 * see header). Stable hash over sender id, falling back to the name.
 */
export const SENDER_PALETTE = [
  '#E91E63', // pink
  '#7C4DFF', // purple
  '#2196F3', // blue
  '#009688', // teal
  '#FF9800', // orange
  '#F44336', // red
  '#8BC34A', // light green
  '#795548', // brown
];

export function senderColourFor(senderId?: string | null, senderName?: string | null): string {
  const key = String(senderId || senderName || '');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return SENDER_PALETTE[h % SENDER_PALETTE.length];
}

/** Media-type label for a quoted reply ("Photo", "Video", …), WA-style. */
export function quoteMediaLabel(replyTo: any): string | null {
  if (!replyTo) return null;
  const mt = String(replyTo.mediaType || '');
  if (replyTo.isViewOnce) return 'Photo';
  switch (mt) {
    case 'image': return 'Photo';
    case 'video': return 'Video';
    case 'audio': return 'Voice message';
    case 'file': return 'Document';
    default: break;
  }
  const t = String(replyTo.type || '');
  if (t === 'sticker') return 'Sticker';
  if (t === 'gif') return 'GIF';
  if (t === 'poll') return 'Poll';
  if (t === 'location' || t === 'live-location') return 'Location';
  if (t === 'contact') return 'Contact';
  return null;
}

/** "m:ss" duration for video thumbnails. */
export function formatMediaDuration(secs: unknown): string | null {
  const s = Math.round(Number(secs));
  if (!Number.isFinite(s) || s < 0) return null;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
