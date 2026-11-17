/**
 * 100M-H13 — "Remind me" on an incoming call: decline now, be reminded
 * later. Reminders are per-device localStorage (same pattern as the
 * call favourites / DND prefs): the phone that declined is the phone
 * that reminds, with no backend involved — a closed app cannot fire
 * one, and that limit is stated in the UI copy ("on this device").
 *
 * The watcher in pushNotifications.ts polls this list on its 3 s tick
 * and fires each due reminder once as an in-app banner (tap opens the
 * caller's chat to call back). Reminders more than 24 h past due are
 * dropped silently instead of firing stale.
 */

export interface CallReminder {
  id: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  type: 'audio' | 'video';
  remindAt: number;
  createdAt: number;
}

const STALE_MS = 24 * 60 * 60 * 1000;

const keyFor = (uid: string) => `dt_call_reminders_${uid}`;

export function listCallReminders(uid: string): CallReminder[] {
  try {
    const raw = localStorage.getItem(keyFor(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((r: any) => r && typeof r.id === 'string') : [];
  } catch {
    return [];
  }
}

function saveCallReminders(uid: string, list: CallReminder[]): void {
  try {
    localStorage.setItem(keyFor(uid), JSON.stringify(list));
  } catch (err) {
    console.warn('[callReminders] save failed:', err);
  }
}

export function addCallReminder(
  uid: string,
  input: { callerId: string; callerName: string; callerAvatar?: string; type: 'audio' | 'video'; minutes: number },
): CallReminder {
  const reminder: CallReminder = {
    id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    callerId: input.callerId,
    callerName: input.callerName,
    callerAvatar: input.callerAvatar || '',
    type: input.type,
    remindAt: Date.now() + Math.max(1, input.minutes) * 60_000,
    createdAt: Date.now(),
  };
  const list = listCallReminders(uid);
  list.push(reminder);
  saveCallReminders(uid, list);
  return reminder;
}

/**
 * Take every reminder that is due, removing them so each fires exactly
 * once. Overdue-by-more-than-a-day reminders are dropped without
 * firing (a stale "call back" a week later helps nobody).
 */
export function takeDueCallReminders(uid: string, now = Date.now()): CallReminder[] {
  const list = listCallReminders(uid);
  if (list.length === 0) return [];
  const due: CallReminder[] = [];
  const keep: CallReminder[] = [];
  for (const r of list) {
    if (r.remindAt <= now) {
      if (now - r.remindAt <= STALE_MS) due.push(r);
      // else: stale — dropped, never fires
    } else {
      keep.push(r);
    }
  }
  if (due.length > 0 || keep.length !== list.length) saveCallReminders(uid, keep);
  return due;
}
