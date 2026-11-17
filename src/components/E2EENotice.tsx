import React, { useEffect } from 'react';
import { KeyRound, Lock, ShieldCheck, X } from 'lucide-react';

/**
 * E2EE notice sheet — WhatsApp-style "Messages are end-to-end encrypted"
 * details sheet, opened by tapping the lock pill at the top of a chat.
 *
 * Self-contained: it takes the chat's encryption state as props and does
 * NOT import the e2ee service layer, so it renders even when the crypto
 * module is still loading / unavailable. Honest limits are stated in the
 * copy itself (see below).
 *
 * Style: WhatsApp Classic Pro — #075E54 header green accents, the same
 * panel / dark-mode classes the rest of the chat screens use.
 */

export type E2EENoticeState = 'e2ee' | 'legacy' | 'unknown';

export interface E2EENoticeProps {
  /** Whether the sheet is visible. Renders nothing when false. */
  open: boolean;
  /** Close the sheet (backdrop tap, X button, "Got it", or Escape). */
  onClose: () => void;
  /** Display name of the other person / group, for the "only you and …" line. */
  chatName?: string;
  /** True for group / community chats (copy says "people in this chat"). */
  isGroup?: boolean;
  /** Encryption state of this chat. 'legacy'/'unknown' show an honest
   *  not-encrypted variant instead of claiming protection that isn't there. */
  state?: E2EENoticeState;
}

export default function E2EENotice({
  open,
  onClose,
  chatName,
  isGroup = false,
  state = 'e2ee',
}: E2EENoticeProps) {
  // Escape closes the sheet, like the other overlays in ChatScreen.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;

  const encrypted = state === 'e2ee';
  const who = isGroup
    ? 'people in this chat'
    : chatName
      ? `you and ${chatName}`
      : 'you and the other person';

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={encrypted ? 'End-to-end encryption' : 'Encryption not available'}
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 cursor-default"
      />
      {/* Sheet */}
      <div className="relative w-full sm:max-w-md bg-panel-light dark:bg-panel-dark rounded-t-2xl sm:rounded-2xl p-5 pb-6 shadow-2xl max-h-[85vh] overflow-y-auto">
        <button
          type="button"
          aria-label="Close encryption info"
          onClick={onClose}
          className="absolute top-3 right-3 p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
        >
          <X className="h-5 w-5 text-gray-400" />
        </button>

        {/* Lock mark — Classic Pro header green (#075E54). */}
        <div className="flex justify-center pt-1">
          <div className="h-16 w-16 rounded-full bg-[#075E54] text-white flex items-center justify-center shadow-md">
            <Lock className="h-7 w-7" />
          </div>
        </div>

        <h3 className="text-center text-lg font-bold text-gray-900 dark:text-text-primary mt-4">
          {encrypted ? 'Messages are end-to-end encrypted' : 'Messages are not end-to-end encrypted'}
        </h3>
        <p className="text-center text-sm text-gray-500 dark:text-text-secondary mt-1.5 leading-relaxed">
          {encrypted
            ? 'No one outside this chat can read them — not even Pinglo.'
            : 'Messages in this chat are not protected by end-to-end encryption yet. Anything sent here can be read by anyone with access to the chat data.'}
        </p>

        {encrypted ? (
          <ul className="mt-5 space-y-3.5">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary-green/15 text-primary-green">
                <Lock className="h-4 w-4" />
              </span>
              <p className="text-sm text-gray-700 dark:text-text-primary leading-relaxed">
                <span className="font-semibold">Only {who} can read them.</span>{' '}
                Messages are locked before they leave your device.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary-green/15 text-primary-green">
                <KeyRound className="h-4 w-4" />
              </span>
              <p className="text-sm text-gray-700 dark:text-text-primary leading-relaxed">
                <span className="font-semibold">The key is agreed between your phones.</span>{' '}
                Each chat has its own key, agreed directly with the other person (ECDH key exchange) — it is never sent to the server. Only message text is encrypted; photos, videos, polls, locations and contacts are not.
              </p>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary-green/15 text-primary-green">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <p className="text-sm text-gray-700 dark:text-text-primary leading-relaxed">
                <span className="font-semibold">Tampering is detected.</span>{' '}
                If a message is changed on the way, it shows as undecryptable instead of showing altered text.
              </p>
            </li>
          </ul>
        ) : (
          <p className="mt-4 text-sm text-gray-500 dark:text-text-secondary leading-relaxed">
            {isGroup
              ? 'Group chats exchange keys automatically — this group’s keys haven’t been exchanged yet, so messages sent here aren’t end-to-end encrypted yet.'
              : 'Older messages sent before encryption was turned on for this chat stay unencrypted. New messages are encrypted once both sides have exchanged keys for this chat.'}
          </p>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full min-h-[44px] rounded-full bg-green-cta text-white text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
