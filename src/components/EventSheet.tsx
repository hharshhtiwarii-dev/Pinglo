/**
 * EventSheet — create a group event (bottom-sheet modal, PollComposer
 * pattern). Name + date/time + optional location + optional description
 * + reminder picker. Saves nothing itself — the validated payload goes
 * to `onSend`; the caller (ChatScreen) writes the doc.
 *
 * a11y: native `datetime-local` input (keyboard + screen-reader free),
 * sentence-case labels, lucide Calendar icon (no emoji as icon).
 */

import { useState } from 'react';
import { X, Calendar } from 'lucide-react';
import {
  type EventComposerPayload,
  type ReminderMinutes,
  REMINDER_OPTIONS,
  validateEventPayload,
  MAX_EVENT_NAME_LEN,
  MAX_EVENT_LOCATION_LEN,
  MAX_EVENT_DESCRIPTION_LEN,
} from './groupEvents';

export interface EventSheetProps {
  onSend: (payload: EventComposerPayload) => void | Promise<void>;
  onClose: () => void;
}

/** Default start: tomorrow, 7 pm local. */
export function defaultEventStartLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(19, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EventSheet({ onSend, onClose }: EventSheetProps) {
  const [name, setName] = useState('');
  const [startLocal, setStartLocal] = useState(defaultEventStartLocal);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [reminderMinutes, setReminderMinutes] = useState<ReminderMinutes>(30);
  const [error, setError] = useState('');

  const handleSend = () => {
    const startAt = new Date(startLocal).getTime();
    const err = validateEventPayload({ name, startAt, location, description });
    if (err) {
      setError(err);
      return;
    }
    void onSend({
      name: name.trim(),
      startAt,
      location: location.trim() || undefined,
      description: description.trim() || undefined,
      reminderMinutes,
    });
  };

  const inputCls =
    'w-full bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary';

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Create event"
    >
      <div
        className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary-green" aria-hidden />
            Create event
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close event creator"
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <label className="block">
          <span className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
            Event name
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            placeholder="Dinner, movie night, match…"
            maxLength={MAX_EVENT_NAME_LEN}
            className={`${inputCls} mt-1`}
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
            Date and time
          </span>
          <input
            type="datetime-local"
            value={startLocal}
            onChange={(e) => {
              setStartLocal(e.target.value);
              setError('');
            }}
            aria-label="Event date and time"
            className={`${inputCls} mt-1`}
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
            Location (optional)
          </span>
          <input
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              setError('');
            }}
            placeholder="Where is it happening?"
            maxLength={MAX_EVENT_LOCATION_LEN}
            className={`${inputCls} mt-1`}
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
            Description (optional)
          </span>
          <textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              setError('');
            }}
            placeholder="Add a few details for everyone"
            maxLength={MAX_EVENT_DESCRIPTION_LEN}
            rows={2}
            className={`${inputCls} mt-1 resize-none`}
          />
        </label>

        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
            Reminder
          </p>
          <div className="flex flex-wrap gap-1.5 mt-1.5" role="group" aria-label="Reminder">
            {REMINDER_OPTIONS.map((opt) => {
              const selected = reminderMinutes === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setReminderMinutes(opt.value)}
                  aria-pressed={selected}
                  className={`min-h-[36px] px-2.5 rounded-full text-xs border ${
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
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSend}
          disabled={!name.trim()}
          className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green disabled:opacity-40 transition-all mt-2"
        >
          Create event
        </button>
      </div>
    </div>
  );
}
