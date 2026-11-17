import React, { useEffect } from 'react';
import { X, Timer, Check } from 'lucide-react';
import {
  DISAPPEAR_OPTIONS,
  type DisappearAfterMs,
} from '../utils/disappearingMessages';

interface DisappearingMessagesModalProps {
  /** Whether the sheet is visible. */
  open: boolean;
  /** Currently stored timer value (ms, 0 = Off). */
  current: number;
  /** Called with the chosen value; the parent persists it on the chat doc. */
  onSelect: (value: DisappearAfterMs) => void;
  onClose: () => void;
}

/**
 * Bottom-sheet picker for the per-chat disappearing-messages timer.
 * Styled to match the existing Poll / Schedule modals in ChatScreen.
 * Purely presentational: it holds no state and writes nothing itself.
 */
export default function DisappearingMessagesModal({
  open,
  current,
  onSelect,
  onClose,
}: DisappearingMessagesModalProps) {
  // Escape closes the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-end" onClick={onClose} role="dialog" aria-modal="true" aria-label="Disappearing messages">
      <div
        className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Timer className="h-5 w-5 text-primary-green" /> Disappearing messages
          </h3>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
          Messages in this chat will disappear after the selected time.
          Turning a timer on also hides older messages that are already past
          that time. Expired messages are deleted when this chat is opened;
          media files may remain in storage.
        </p>

        <div className="space-y-1">
          {DISAPPEAR_OPTIONS.map((opt) => {
            const selected = current === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => onSelect(opt.value)}
                aria-pressed={selected}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                  selected
                    ? 'bg-primary-green/10 text-primary-green'
                    : 'text-gray-900 dark:text-text-primary hover:bg-gray-100 dark:hover:bg-input-dark'
                }`}
              >
                <span>{opt.label === 'Off' ? 'Off' : `After ${opt.label}`}</span>
                {selected && <Check className="h-4 w-4" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
