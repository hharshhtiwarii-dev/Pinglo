/**
 * EventCard — WhatsApp-style group-event renderer.
 *
 * Renders a `type: 'event'` message doc: title, date/time, location,
 * description, host, RSVP row (Going / Maybe / Not going + counts) and a
 * reminder picker. The host can cancel. Pure render + callbacks — the
 * caller (ChatScreen) owns the Firestore writes, like PollCard.
 *
 * a11y: RSVP buttons are min 44px targets with `aria-pressed`; the row is
 * `role="group" aria-label="Responses"`; counts announce via aria-live.
 * Hallmark Floor: existing tokens only, sentence-case labels, lucide
 * Calendar icon (no emoji as icon).
 */

import { useState } from 'react';
import { Calendar, MapPin, Bell, X } from 'lucide-react';
import {
  type RsvpValue,
  type ReminderMinutes,
  RSVP_OPTIONS,
  REMINDER_OPTIONS,
  rsvpCounts,
  myRsvp,
  rsvpUids,
  formatEventWhen,
  eventCountdownLabel,
  isEventPast,
} from './groupEvents';

export interface EventCardData {
  id?: string;
  eventName: string;
  startAt: number;
  location?: string;
  description?: string;
  reminderMinutes?: ReminderMinutes;
  rsvps?: Record<string, RsvpValue>;
  hostUid?: string;
  hostName?: string;
  canceled?: boolean;
  senderName?: string;
}

export interface EventCardProps {
  event: EventCardData;
  currentUserId?: string | null;
  /** uid -> display name, for the "who's going" list. */
  memberNames?: Record<string, string>;
  onRsvp?: (value: RsvpValue | null) => void | Promise<void>;
  /** Reminder choice changed (creator's default on the doc). */
  onReminderChange?: (minutes: ReminderMinutes) => void | Promise<void>;
  /** Host taps cancel. */
  onCancel?: () => void | Promise<void>;
}

export default function EventCard({
  event,
  currentUserId,
  memberNames,
  onRsvp,
  onReminderChange,
  onCancel,
}: EventCardProps) {
  const [showReminder, setShowReminder] = useState(false);
  const [showWho, setShowWho] = useState(false);
  const counts = rsvpCounts(event.rsvps);
  const mine = myRsvp(event.rsvps, currentUserId);
  const past = isEventPast(event.startAt);
  const canceled = event.canceled === true;
  const iAmHost = !!currentUserId && !!event.hostUid && event.hostUid === currentUserId;
  const canRsvp = !canceled && !past && !!currentUserId && !!onRsvp;
  const goingNames = rsvpUids(event.rsvps, 'going').map((uid) => memberNames?.[uid] || uid);
  const total = counts.going + counts.maybe + counts['not-going'];

  const handleRsvp = (value: RsvpValue) => {
    if (!canRsvp) return;
    // Tapping your current choice again clears it (WhatsApp-like toggle).
    void onRsvp(mine === value ? null : value);
  };

  return (
    <div
      className="py-1 min-w-[220px]"
      role="group"
      aria-label={`Event: ${event.eventName}`}
    >
      <div className="flex items-start gap-2">
        <span className="flex-shrink-0 w-9 h-9 rounded-lg bg-primary-green/15 text-primary-green flex items-center justify-center">
          <Calendar className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm leading-snug break-words">{event.eventName}</p>
          <p className="text-xs opacity-75 mt-0.5">
            {formatEventWhen(event.startAt)}
            {!canceled && !past ? ` · ${eventCountdownLabel(event.startAt)}` : ''}
          </p>
          {event.location ? (
            <p className="text-xs opacity-75 mt-0.5 flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
              <span className="truncate">{event.location}</span>
            </p>
          ) : null}
        </div>
      </div>

      {event.description ? (
        <p className="text-[13px] leading-snug whitespace-pre-wrap break-words mt-2">
          {event.description}
        </p>
      ) : null}

      {canceled ? (
        <p className="text-xs font-medium text-red-500 mt-2">Event canceled</p>
      ) : past ? (
        <p className="text-xs opacity-60 mt-2">This event has ended</p>
      ) : null}

      <div
        className="flex gap-2 mt-2.5"
        role="group"
        aria-label="Responses"
      >
        {RSVP_OPTIONS.map(({ value, label }) => {
          const selected = mine === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleRsvp(value)}
              disabled={!canRsvp}
              aria-pressed={selected}
              aria-label={`${label}, ${counts[value]} ${counts[value] === 1 ? 'person' : 'people'}`}
              className={`min-h-[44px] flex-1 px-2 rounded-xl text-xs font-medium border transition-colors ${
                selected
                  ? 'border-green-cta bg-green-cta text-white'
                  : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
              } ${!canRsvp ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
            >
              {label}
              <span className="block text-[11px] font-normal opacity-80">{counts[value]}</span>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] opacity-60 mt-1.5" aria-live="polite">
        {total === 0
          ? 'No responses yet'
          : `${counts.going} going, ${counts.maybe} maybe, ${counts['not-going']} not going`}
      </p>

      {goingNames.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setShowWho((v) => !v)}
            aria-expanded={showWho}
            className="text-[11px] font-medium text-primary-green hover:underline"
          >
            Who&apos;s going ({goingNames.length})
          </button>
          {showWho && (
            <ul className="text-[11px] opacity-70 mt-0.5 space-y-0.5 list-none">
              {goingNames.map((name, i) => (
                <li key={`${name}-${i}`} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!canceled && !past && (
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => setShowReminder((v) => !v)}
            aria-expanded={showReminder}
            className="flex items-center gap-1 text-[11px] font-medium text-primary-green hover:underline min-h-[32px]"
          >
            <Bell className="h-3.5 w-3.5" aria-hidden />
            Remind me: {REMINDER_OPTIONS.find((o) => o.value === (event.reminderMinutes ?? 30))?.label || '30 minutes before'}
          </button>
          {iAmHost && onCancel && (
            <button
              type="button"
              onClick={() => void onCancel()}
              className="ml-auto flex items-center gap-1 text-[11px] font-medium text-red-500 hover:underline min-h-[32px]"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
              Cancel event
            </button>
          )}
        </div>
      )}

      {showReminder && !canceled && !past && (
        <div className="flex flex-wrap gap-1.5 mt-1.5" role="group" aria-label="Reminder">
          {REMINDER_OPTIONS.map((opt) => {
            const selected = (event.reminderMinutes ?? 30) === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  void onReminderChange?.(opt.value);
                  setShowReminder(false);
                }}
                aria-pressed={selected}
                className={`min-h-[36px] px-2.5 rounded-full text-[11px] border ${
                  selected
                    ? 'border-primary-green bg-primary-green/10 text-primary-green font-medium'
                    : 'border-black/10 dark:border-white/10'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      {event.hostName ? (
        <p className="text-[10px] opacity-50 mt-1.5">
          Hosted by {iAmHost ? 'you' : event.hostName}
        </p>
      ) : null}
    </div>
  );
}
