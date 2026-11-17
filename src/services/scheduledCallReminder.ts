/**
 * 100M-H15 — scheduled call-link reminder. A scheduled call used to do
 * nothing at fire time: `scheduledAt` was display-only (a render-time
 * countdown string). The save (CallsScreen.saveSchedule) mirrors the
 * time + title here, and the pushNotifications watcher tick fires ONE
 * banner when the time arrives.
 *
 * Per-device, in-app-only contract: no backend push exists, so a closed
 * app fires nothing, and a schedule set on another device is invisible
 * here. A reminder more than 15 min late (app reopened long after the
 * time) is marked fired without showing — a stale "starting now" hours
 * later is noise.
 */

export interface ScheduledCallMirror {
  scheduledAt: number;
  title: string;
  /** The scheduledAt value already fired for (prevents double-fire). */
  firedFor: number | null;
}

const keyFor = (uid: string) => `dt_sched_call_${uid}`;

export function saveScheduledCallMirror(
  uid: string,
  mirror: { scheduledAt: number | null; title: string } | null,
): void {
  try {
    if (!mirror || !mirror.scheduledAt) {
      localStorage.removeItem(keyFor(uid));
      return;
    }
    const prev = readScheduledCallMirror(uid);
    const next: ScheduledCallMirror = {
      scheduledAt: mirror.scheduledAt,
      title: mirror.title || '',
      // A re-save for a NEW time re-arms the reminder; re-saving the
      // same time keeps the fired state (no double banner).
      firedFor: prev && prev.scheduledAt === mirror.scheduledAt ? prev.firedFor : null,
    };
    localStorage.setItem(keyFor(uid), JSON.stringify(next));
  } catch (err) {
    console.warn('[scheduledCallReminder] mirror save failed:', err);
  }
}

export function readScheduledCallMirror(uid: string): ScheduledCallMirror | null {
  try {
    const raw = localStorage.getItem(keyFor(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.scheduledAt !== 'number') return null;
    return {
      scheduledAt: parsed.scheduledAt,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      firedFor: typeof parsed.firedFor === 'number' ? parsed.firedFor : null,
    };
  } catch {
    return null;
  }
}

/** Returns the mirror if its time has arrived and it has not fired yet; marks it fired. */
export function takeDueScheduledCall(uid: string, now = Date.now()): ScheduledCallMirror | null {
  const mirror = readScheduledCallMirror(uid);
  if (!mirror || mirror.firedFor === mirror.scheduledAt || mirror.scheduledAt > now) return null;
  try {
    localStorage.setItem(keyFor(uid), JSON.stringify({ ...mirror, firedFor: mirror.scheduledAt }));
  } catch {
    /* best-effort: a failed mark risks a repeat banner, not a lost one */
  }
  // More than 15 min late: fired-and-forgotten, no banner.
  if (now - mirror.scheduledAt > 15 * 60_000) return null;
  return mirror;
}
