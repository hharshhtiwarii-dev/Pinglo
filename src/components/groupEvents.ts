/**
 * Group events (v1, client-only) — WhatsApp parity: create an event in a
 * group (name, date/time, location, description, reminder) and RSVP
 * Going / Maybe / Not going.
 *
 * Data shape (D1): one `type: 'event'` doc in the same
 * `chats/<groupId>/messages` collection as every other group message, so
 * the existing subscription delivers it — no new collection, no new
 * subscription, no backend. RSVPs live as a `rsvps: { uid: value }` map
 * on the one doc (one doc-field update per RSVP, far under the 400 KB
 * doc guard even at 1024 members), exactly like `pollVotes` on polls.
 *
 * v2 (NOT here): Events Home + guest invite links — needs backend
 * invite-link support (phone verification, hidden address until RSVP).
 *
 * Trust model: RSVP/event writes are client-written like reactions and
 * polls; server enforcement is BACKEND-PHASE like every other group gate.
 */

import { doc, db, addDoc, collection, updateDoc, deleteField, serverTimestamp } from '../aws';
import { cleanId } from '../services/realtimeSync';

export type RsvpValue = 'going' | 'maybe' | 'not-going';
export type RsvpMap = Record<string, RsvpValue>;

/** Reminder lead time in minutes before the event starts. 0 = no reminder. */
export type ReminderMinutes = 0 | 15 | 30 | 60 | 1440;

export const RSVP_OPTIONS: { value: RsvpValue; label: string }[] = [
  { value: 'going', label: 'Going' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'not-going', label: 'Not going' },
];

export const REMINDER_OPTIONS: { value: ReminderMinutes; label: string }[] = [
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 1440, label: '1 day before' },
  { value: 0, label: 'No reminder' },
];

export interface GroupEventDoc {
  id?: string;
  type: 'event';
  eventName: string;
  /** Epoch ms. */
  startAt: number;
  location?: string;
  description?: string;
  reminderMinutes?: ReminderMinutes;
  rsvps?: RsvpMap;
  /** Uid of the host (creator). Only the host can cancel. */
  hostUid?: string;
  hostName?: string;
  /** True once the host cancels; the card renders as canceled. */
  canceled?: boolean;
  senderId?: string;
  senderName?: string;
  timestamp?: any;
  status?: string;
}

export interface EventComposerPayload {
  name: string;
  /** Epoch ms. */
  startAt: number;
  location?: string;
  description?: string;
  reminderMinutes: ReminderMinutes;
}

export const MAX_EVENT_NAME_LEN = 100;
export const MAX_EVENT_LOCATION_LEN = 200;
export const MAX_EVENT_DESCRIPTION_LEN = 500;

/** Pure validation — the sheet and the writer share it. Returns an error string or ''. */
export function validateEventPayload(p: {
  name: string;
  startAt: number;
  location?: string;
  description?: string;
}): string {
  if (!p.name.trim()) return 'Event name likho';
  if (p.name.trim().length > MAX_EVENT_NAME_LEN) return `Event name too long (max ${MAX_EVENT_NAME_LEN} characters)`;
  if (!Number.isFinite(p.startAt) || p.startAt <= Date.now()) return 'Pick a date and time in the future';
  if ((p.location || '').length > MAX_EVENT_LOCATION_LEN) return `Location too long (max ${MAX_EVENT_LOCATION_LEN} characters)`;
  if ((p.description || '').length > MAX_EVENT_DESCRIPTION_LEN) return `Description too long (max ${MAX_EVENT_DESCRIPTION_LEN} characters)`;
  return '';
}

export function isValidRsvp(v: unknown): v is RsvpValue {
  return v === 'going' || v === 'maybe' || v === 'not-going';
}

/** Counts per RSVP value, ignoring junk values. Pure — first test target. */
export function rsvpCounts(rsvps: RsvpMap | null | undefined): Record<RsvpValue, number> {
  const out: Record<RsvpValue, number> = { going: 0, maybe: 0, 'not-going': 0 };
  if (!rsvps) return out;
  for (const v of Object.values(rsvps)) {
    if (isValidRsvp(v)) out[v] += 1;
  }
  return out;
}

/** The current user's RSVP on this event, or null. Pure — first test target. */
export function myRsvp(rsvps: RsvpMap | null | undefined, uid?: string | null): RsvpValue | null {
  if (!uid || !rsvps) return null;
  const v = rsvps[uid];
  return isValidRsvp(v) ? v : null;
}

/** Uids of the members with a given RSVP. Pure — first test target. */
export function rsvpUids(rsvps: RsvpMap | null | undefined, value: RsvpValue): string[] {
  if (!rsvps) return [];
  return Object.entries(rsvps)
    .filter(([, v]) => v === value)
    .map(([uid]) => uid);
}

export function isEventPast(startAt: number, now = Date.now()): boolean {
  return Number.isFinite(startAt) && startAt <= now;
}

/** "Sat, 21 Nov · 7:00 pm" — sentence-case, no emoji. Pure. */
export function formatEventWhen(startAt: number): string {
  const d = new Date(startAt);
  if (!Number.isFinite(d.getTime())) return '';
  const date = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

/** "in 2h 15m" / "in 3 days" / "Started" — for the card + header countdown. Pure. */
export function eventCountdownLabel(startAt: number, now = Date.now()): string {
  const diff = startAt - now;
  if (diff <= 0) return 'Started';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    const rem = mins % 60;
    return rem === 0 ? `in ${hours}h` : `in ${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Which events are due a reminder right now. Pure — first test target.
 * An event is due when: not canceled, not past, reminder set (> 0), and
 * now >= startAt - reminderMinutes. `alreadyRemindedIds` is the set of
 * event ids this device already toasted for (localStorage-backed).
 */
export function dueEventReminders(
  events: { id?: string; startAt: number; reminderMinutes?: number; canceled?: boolean }[],
  alreadyRemindedIds: Set<string>,
  now = Date.now(),
): string[] {
  const due: string[] = [];
  for (const ev of events) {
    if (!ev.id || ev.canceled) continue;
    const lead = ev.reminderMinutes || 0;
    if (lead <= 0) continue;
    if (alreadyRemindedIds.has(ev.id)) continue;
    if (ev.startAt <= now) continue;
    if (now >= ev.startAt - lead * 60000) due.push(ev.id);
  }
  return due;
}

const REMINDED_KEY = 'pinglo-event-reminded';

export function loadRemindedEventIds(): Set<string> {
  try {
    const raw = localStorage.getItem(REMINDED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markEventReminded(id: string): void {
  try {
    const set = loadRemindedEventIds();
    set.add(id);
    // Keep the list bounded — old event ids are never due again.
    const arr = [...set].slice(-200);
    localStorage.setItem(REMINDED_KEY, JSON.stringify(arr));
  } catch {
    /* storage unavailable — reminder just fires again next poll */
  }
}

/** Write the event doc. Throws on failure — the caller toasts honestly. */
export async function createGroupEvent(
  groupId: string,
  payload: EventComposerPayload,
  host: { uid: string; displayName?: string },
): Promise<string> {
  const err = validateEventPayload(payload);
  if (err) throw new Error(err);
  const name = payload.name.trim();
  const ref = await addDoc(collection(db, 'chats', cleanId(groupId), 'messages'), {
    type: 'event',
    text: `📅 Event: ${name} — ${formatEventWhen(payload.startAt)}`,
    eventName: name,
    startAt: payload.startAt,
    ...(payload.location?.trim() ? { location: payload.location.trim() } : {}),
    ...(payload.description?.trim() ? { description: payload.description.trim() } : {}),
    reminderMinutes: payload.reminderMinutes,
    rsvps: { [host.uid]: 'going' },
    hostUid: host.uid,
    hostName: host.displayName || 'User',
    canceled: false,
    senderId: host.uid,
    senderName: host.displayName || 'User',
    timestamp: serverTimestamp(),
    status: 'sent',
  });
  return (ref as any)?.id || '';
}

/** One map-field update per RSVP (same pattern as poll votes). */
export async function setRsvp(
  groupId: string,
  eventMsgId: string,
  uid: string,
  value: RsvpValue | null,
): Promise<void> {
  const ref = doc(db, 'chats', cleanId(groupId), 'messages', eventMsgId);
  if (value === null) {
    await updateDoc(ref, { [`rsvps.${uid}`]: deleteField() });
  } else {
    await updateDoc(ref, { [`rsvps.${uid}`]: value });
  }
}

/** Host-only cancel (UI-gated; server enforcement is BACKEND-PHASE). */
export async function cancelGroupEvent(groupId: string, eventMsgId: string): Promise<void> {
  await updateDoc(doc(db, 'chats', cleanId(groupId), 'messages', eventMsgId), {
    canceled: true,
  });
}
