/**
 * MF-01 — View-once media service (SCAFFOLD).
 *
 * Thin seam over the existing message-doc writes (see ChatScreen's
 * view-once tap handler, which previously inlined `updateDoc(...,
 * { viewed: true })`). Only `markViewOnceViewed` is wired today;
 * everything else is a TODO stub for the implementing worker.
 */
import { db, doc, updateDoc } from '../aws';
import { buildViewOnceViewedUpdate, type ViewOnceViewerState } from '../types/viewOnce';

/**
 * VO-03 — Mark a view-once message viewed, in the same action that
 * opens the viewer. One atomic updateDoc: `viewed: true` + `viewedAt`.
 * Refuses the sender's own message (a sender preview must never mark
 * the message viewed for the receiver) and a message with no ids.
 * Returns false when nothing was written.
 */
export async function markViewOnceViewed(
  chatId: string,
  messageId: string,
  isMine: boolean,
): Promise<boolean> {
  if (!chatId || !messageId || isMine) return false;
  try {
    await updateDoc(doc(db, 'chats', chatId, 'messages', messageId), buildViewOnceViewedUpdate());
    return true;
  } catch (e) {
    console.warn('[viewOnce] could not mark view-once message viewed:', e);
    return false;
  }
}

/**
 * VO-02 — Fetch view-once bytes into memory for the canvas viewer.
 *
 * TODO (implementing worker): do NOT pass the remote URL to the viewer.
 * For E2EE chats, decrypt the envelope in memory (see e2eeChat.ts) and
 * return the plaintext bytes; for legacy media, fetch the URL and
 * return the bytes. The caller must revoke the object URL via
 * `revokeViewOnceBytes` on unmount (VO-04).
 *
 * SCAFFOLD: plain fetch only — no decryption yet, no caching, and the
 * bytes are NOT persisted anywhere (no IndexedDB, no disk).
 */
export async function fetchViewOnceBytes(state: Pick<ViewOnceViewerState, 'mediaUrl'>): Promise<Blob> {
  // TODO: replace with in-memory E2EE decrypt when the message carries
  // an `e2ee` envelope; fetch is only the legacy-media fallback.
  const res = await fetch(state.mediaUrl);
  if (!res.ok) throw new Error(`[viewOnce] fetch failed: ${res.status}`);
  return await res.blob();
}

/** VO-04 — Revoke the object URL created from view-once bytes. */
export function revokeViewOnceBytes(objectUrl: string | null): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}

/**
 * VO-05 — Toggle Android FLAG_SECURE while the viewer is open.
 *
 * TODO (implementing worker): build the Capacitor plugin bridge that
 * calls `MainActivity.setViewOnceSecure(secure)` (stub added on this
 * branch). Until the bridge exists this is a no-op on all platforms —
 * screenshots are NOT blocked yet. Web/iOS cannot block screenshots
 * at all; the sender notice ("screenshot attempted") is a separate
 * TODO (see `ChatMessage.screenshotAttempted`).
 */
export function setViewOnceSecureMode(_secure: boolean): void {
  // TODO: Capacitor plugin bridge -> MainActivity.setViewOnceSecure.
}
