/**
 * channelShareToStatus — WA audit (d) C15: "Add to status" handoff
 * (WA: WAWebNewsletterAddToStatusButton).
 *
 * A channel post lives in a ChatScreen route (`/chat/:id`), while the
 * status composer lives in StatusScreen under the MainScreen Updates
 * tab — there is no shared route state between them. The handoff is a
 * one-shot sessionStorage payload (same-tab only, cleared on read) plus
 * a `pinglo:add-to-status` CustomEvent (the same CustomEvent pattern
 * MainScreen's `pinglo:switch-tab` uses):
 * - ChatScreen queues the payload, navigates to /main, switches to the
 *   Updates tab, then fires the event.
 * - StatusScreen consumes the queue on mount (covers a tab that was not
 *   activated yet, so the event was never heard) and on the event
 *   (covers an already-mounted tab). Either path opens the composer
 *   prefilled — text composer for text posts, photo editor for media
 *   posts — and the queue is consumed exactly once.
 */
export interface ChannelPostForStatus {
  /** Post text (or poll question / caption). May be '' for media-only posts. */
  text: string;
  /** Channel name, shown in the composer's "Shared from …" toast. */
  sourceName: string;
  /** Remote media URL for photo/video posts (opened in the photo editor). */
  mediaUrl?: string;
  /** 'image' | 'video' (best-effort; the fetched blob type wins). */
  mediaType?: string;
  /** Caption on a media post (prefilled as the status caption). */
  caption?: string;
}

const QUEUE_KEY = 'dt_add_to_status';

/** CustomEvent fired after the Updates tab switch, for an already-mounted StatusScreen. */
export const ADD_TO_STATUS_EVENT = 'pinglo:add-to-status';

/** Text-status composer cap (StatusScreen textarea maxLength). */
export const TEXT_STATUS_MAX_LEN = 280;

export function queueChannelPostForStatus(payload: ChannelPostForStatus): void {
  try {
    sessionStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ ...payload, queuedAt: Date.now() }),
    );
  } catch {
    // Private mode / storage full: the share silently cannot queue.
    // The caller toasts the failure path instead of pretending it worked.
  }
}

/** Reads + clears the queued share. Returns null when nothing is queued. */
export function takeQueuedChannelPostForStatus(): ChannelPostForStatus | null {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(QUEUE_KEY);
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ChannelPostForStatus;
  } catch {
    return null;
  }
}

export function notifyAddToStatus(): void {
  window.dispatchEvent(new CustomEvent(ADD_TO_STATUS_EVENT));
}
