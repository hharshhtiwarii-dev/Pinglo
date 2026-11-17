/**
 * MF-01 — View-once media: domain model + behaviour-contract rules.
 *
 * SCAFFOLD (branch scaffold/plugin-mf01-view-once). Design: Hermes
 * "Viewer as a one-way valve" (Ponytail+Hermes review, MF-01, TRIZ):
 * view-once media is rendered through a dedicated `ViewOnceViewer`
 * that never receives a copyable URL — bytes are held in memory, drawn
 * to a `<canvas>` (no `<img src>`), the blob is revoked on unmount,
 * no `items` list is passed and download/share are absent.
 *
 * Behaviour-contract rules (acceptance tests in
 * `src/services/__tests__/viewOnce.acceptance.test.ts`):
 * - VO-01  view-once media opens ONLY in ViewOnceViewer, never the
 *           shared MediaLightbox (which has download/share + swipe).
 * - VO-02  the viewer exposes no download, share, or copyable URL:
 *           canvas render, no `<img src>`, no items list, no save path.
 * - VO-03  opening marks the message `viewed: true` (+ `viewedAt`)
 *           in the same action that hands bytes to the viewer, so a
 *           crash cannot re-open it; a viewed message cannot re-open.
 * - VO-04  the in-memory blob / object URL is revoked on viewer
 *           close/unmount.
 * - VO-05  Android FLAG_SECURE is applied while the viewer is open
 *           (native stub — see MainActivity.setViewOnceSecure; the
 *           Capacitor bridge plugin to call it is NOT yet built).
 *
 * Honest limits (do NOT claim otherwise): FLAG_SECURE blocks
 * screenshots/screen-recording on Android only — it cannot stop a
 * second camera photographing the screen, and iOS/web cannot block
 * screenshots at all. Canvas rendering also breaks pinch-zoom unless
 * re-implemented (TODO in ViewOnceViewer).
 */
import type { ChatMessage } from './chat';

/** Media kinds a view-once message can carry. Audio/files are out of
 * scope for view-once v1 (WhatsApp view-once is photo/video only). */
export type ViewOnceMediaType = 'image' | 'video';

/** The viewer state for one open view-once message. */
export interface ViewOnceViewerState {
  /** Message id being viewed. */
  messageId: string;
  chatId: string;
  mediaUrl: string;
  mediaType: ViewOnceMediaType;
  senderName?: string;
  time?: string;
}

/** What `markViewOnceViewed` writes — one atomic updateDoc (VO-03). */
export interface ViewOnceViewedUpdate {
  viewed: true;
  /** Epoch ms the message was opened. */
  viewedAt: number;
}

/** Build the VO-03 update payload. Pure — unit-testable without Firestore. */
export function buildViewOnceViewedUpdate(nowMs: number = Date.now()): ViewOnceViewedUpdate {
  return { viewed: true, viewedAt: nowMs };
}

/**
 * VO-01/VO-03 gate: may this message be opened in the view-once viewer?
 * - must be a view-once message with a media URL of image/video kind;
 * - must not already be viewed (receiver side) — a viewed message is
 *   unopenable (shows "Opened" instead);
 * - the sender's own copy is a preview, not a "view" — it never marks
 *   `viewed` (see `markViewOnceViewed`, which refuses `isMine`).
 */
export function isViewOnceOpenable(
  msg: Pick<ChatMessage, 'isViewOnce' | 'mediaUrl' | 'mediaType' | 'viewed'>,
): boolean {
  if (!msg.isViewOnce) return false;
  if (!msg.mediaUrl) return false;
  if (msg.mediaType !== 'image' && msg.mediaType !== 'video') return false;
  if (msg.viewed) return false;
  return true;
}

/** VO-02: the viewer must never be handed a swipeable items list. */
export function viewOnceViewerHasNoItems(state: ViewOnceViewerState): boolean {
  return !('items' in state);
}
