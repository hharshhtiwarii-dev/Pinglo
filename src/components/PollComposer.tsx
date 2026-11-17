/**
 * PollComposer — poll banane ka bottom-sheet modal (multi-answer support).
 *
 * M3 (Messaging Group): gap-list PARTIAL #22 "Polls — single-vote, max 6
 * options" ka composer hissa. Existing ChatScreen poll modal
 * (ChatScreen.tsx ~line 2806) sirf question + 2–6 options deta tha; ye
 * component uski jagah use hota hai aur ye naya deta hai:
 * - "Allow multiple answers" toggle (ToggleSwitch, existing component).
 * - Max choices setting (2–12, options ki ginti tak clamp; sirf
 *   multi-answer on hone par dikhta hai).
 * - Options add/remove: 2 se 12 tak (pehle max 6 tha).
 *
 * Ye component kuch bhi save NAHI karta — valid payload `onSend` ko deta
 * hai; caller (ChatScreen ka `sendPoll` jaisa handler) use database me
 * likhta hai. Isliye existing poll data format se compatible hai: naye
 * fields (`pollMultiAnswer`, `pollMaxChoices`) optional hain aur purane
 * single-answer polls bina inke bhi chalte hain.
 *
 * Usage (ChatScreen me poll modal ki jagah):
 *   {showPollModal && (
 *     <PollComposer
 *       onClose={() => setShowPollModal(false)}
 *       onSend={(p) => sendPoll(p)}
 *     />
 *   )}
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import ToggleSwitch from './ToggleSwitch';
import { POLL_MIN_OPTIONS, POLL_MAX_OPTIONS } from './PollCard';

export interface PollComposerPayload {
  question: string;
  /** Trimmed, non-empty options (2–12). */
  options: string[];
  /** true = voter kai options chun sakta hai. */
  multiAnswer: boolean;
  /**
   * Multi-answer me ek voter kitne options chun sakta hai.
   * Single-answer me hamesha 1. Multi me 2..options.length.
   */
  maxChoices: number;
}

export interface PollComposerProps {
  /** Poll bhej diya gaya — caller is payload ko database me likhe. */
  onSend: (payload: PollComposerPayload) => void | Promise<void>;
  /** Modal band karo (backdrop / X / bhej ne ke baad caller se). */
  onClose: () => void;
  /**
   * WA audit (d) C8 — channel poll flow: the composer title names the
   * context ("Create channel poll" in a channel). Default: "📊 Create Poll".
   */
  title?: string;
}

export default function PollComposer({ onSend, onClose, title }: PollComposerProps) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiAnswer, setMultiAnswer] = useState(false);
  const [maxChoices, setMaxChoices] = useState(2);
  const [error, setError] = useState('');

  const validOptions = options.map((o) => o.trim()).filter(Boolean);
  /**
   * Effective cap: removing option rows can leave maxChoices above the
   * options that actually exist (the remove handler only clamps against
   * the row count, not the filled count). Clamp here so the label and the
   * payload never promise more choices than there are options.
   */
  const effectiveMaxChoices = multiAnswer
    ? Math.max(2, Math.min(maxChoices, Math.max(validOptions.length, 2)))
    : 1;
  const duplicateOptions =
    new Set(validOptions.map((o) => o.toLowerCase())).size !== validOptions.length;
  const canSend =
    question.trim().length > 0 &&
    validOptions.length >= POLL_MIN_OPTIONS &&
    !duplicateOptions;

  const setOptionAt = (idx: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === idx ? value : o)));
    setError('');
  };

  const removeOption = (idx: number) => {
    setOptions((prev) => prev.filter((_, i) => i !== idx));
    // Max choices options ki ginti se zyada na rahe.
    setMaxChoices((prev) => Math.min(prev, Math.max(2, options.length - 1)));
    setError('');
  };

  const addOption = () => {
    if (options.length >= POLL_MAX_OPTIONS) return;
    setOptions((prev) => [...prev, '']);
  };

  const handleMultiToggle = (next: boolean) => {
    setMultiAnswer(next);
    // WA72 A6 (PARTIAL→PARITY): WhatsApp "Allow multiple answers" lets a
    // voter pick ANY of the options — there is no cap. The old default
    // (maxChoices 2) silently capped a WA-style "pick all that apply"
    // poll at 2 unless the user noticed the stepper. Default the cap to
    // all options (the stepper still lets the sender lower it to 2+).
    // Off karte hi maxChoices ka matlab khatam.
    if (next) setMaxChoices(Math.max(2, options.length));
  };

  const handleSend = () => {
    if (!question.trim()) {
      setError('Poll question likho');
      return;
    }
    if (validOptions.length < POLL_MIN_OPTIONS) {
      setError(`Kam se kam ${POLL_MIN_OPTIONS} options chahiye`);
      return;
    }
    if (duplicateOptions) {
      setError('Do options ek jaise nahi ho sakte');
      return;
    }
    const choices = multiAnswer ? effectiveMaxChoices : 1;
    void onSend({
      question: question.trim(),
      options: validOptions,
      multiAnswer,
      maxChoices: choices,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Create poll"
    >
      <div
        className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-bold">{title || '📊 Create Poll'}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close poll composer"
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <input
          autoFocus
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            setError('');
          }}
          placeholder="Poll question likho..."
          maxLength={255}
          className="w-full bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
        />

        <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide mt-2">
          Options ({validOptions.length}/{POLL_MAX_OPTIONS})
        </p>
        {options.map((opt, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={opt}
              onChange={(e) => setOptionAt(i, e.target.value)}
              placeholder={`Option ${i + 1}`}
              maxLength={100}
              className="flex-1 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
            />
            {options.length > POLL_MIN_OPTIONS && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                aria-label={`Remove option ${i + 1}`}
                className="p-2 text-red-400 hover:text-red-500"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        {options.length < POLL_MAX_OPTIONS && (
          <button
            type="button"
            onClick={addOption}
            className="w-full py-2 border border-dashed border-gray-300 dark:border-white/20 rounded-xl text-sm text-primary-green hover:bg-primary-green/5 transition-colors"
          >
            + Add Option
          </button>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <div>
            <p className="text-sm font-medium">Allow multiple answers</p>
            <p className="text-xs opacity-60">Voters can choose more than one option</p>
          </div>
          <ToggleSwitch
            checked={multiAnswer}
            onChange={handleMultiToggle}
            label="Allow multiple answers"
          />
        </div>

        {multiAnswer && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Max choices per voter</p>
              <p className="text-xs opacity-60">
                Each voter can pick up to {effectiveMaxChoices} option
                {effectiveMaxChoices > 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Decrease max choices"
                onClick={() => setMaxChoices((prev) => Math.max(2, prev - 1))}
                disabled={maxChoices <= 2}
                className="w-8 h-8 rounded-full border border-black/10 dark:border-white/20 text-lg leading-none disabled:opacity-40"
              >
                −
              </button>
              <span className="w-6 text-center text-sm font-semibold" aria-live="polite">
                {effectiveMaxChoices}
              </span>
              <button
                type="button"
                aria-label="Increase max choices"
                onClick={() =>
                  setMaxChoices((prev) => Math.min(Math.max(validOptions.length, 2), prev + 1))
                }
                disabled={maxChoices >= Math.max(validOptions.length, 2)}
                className="w-8 h-8 rounded-full border border-black/10 dark:border-white/20 text-lg leading-none disabled:opacity-40"
              >
                +
              </button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green disabled:opacity-40 transition-all mt-2"
        >
          Send Poll 📊
        </button>
      </div>
    </div>
  );
}
