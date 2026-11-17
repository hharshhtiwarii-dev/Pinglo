/**
 * FormatToolbar — B / I / S / Mono buttons above the composer
 * (Messaging Group, Worker M1).
 *
 * WhatsApp-style: the user selects text in the composer and taps a
 * button to wrap it (`hello` -> `*hello*`); tapping again unwraps it.
 * With no selection, tapping inserts an empty pair (`**`) and parks the
 * caret inside it so the user types already-formatted text. The markup
 * is stored in the message text itself, so no message schema change is
 * needed — FormattedText renders it on the receiving side.
 *
 * Contract:
 * - `textareaRef` — the composer's textarea ref (ChatScreen `inputRef`).
 *   The toolbar reads selectionStart/End from it and restores focus +
 *   selection after the change.
 * - `value` — the composer's current text (`input` state).
 * - `onChange(next)` — called with the new text; the parent owns the
 *   state (and its draft/typing side-effects) exactly as if the user
 *   had typed. ChatScreen note: its `handleInputChange` also saves the
 *   draft and fires typing — wire `onChange` to `setInput` + `saveDraft`
 *   (see PATCH.md), or pass a small adapter; do NOT bypass the draft.
 * - `disabled` — optional; disables all four buttons (e.g. while
 *   uploading, like the rest of the composer).
 *
 * The toolbar renders nothing but the button row — the parent decides
 * when to show it (suggested: above the main input row, only while the
 * composer has text or focus; see PATCH.md).
 *
 * Active-state sync: the buttons highlight while the textarea selection
 * is formatted. Clicks on the buttons bump the state, and listeners on
 * the textarea (`select` / `keyup` / `click`) keep it in sync for
 * keyboard/mouse selection changes made without touching the toolbar.
 * The textarea can remount (ChatScreen hides it while recording), so
 * the listeners re-attach whenever the element behind the ref changes.
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Bold, Italic, Strikethrough, Code } from 'lucide-react';
import {
  applyFormat,
  isSelectionFormatted,
  type FormatKind,
} from '../utils/formatting';

interface FormatToolbarProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

const BUTTONS: { kind: FormatKind; label: string; title: string; Icon: typeof Bold }[] = [
  { kind: 'bold', label: 'Bold', title: 'Bold (*text*)', Icon: Bold },
  { kind: 'italic', label: 'Italic', title: 'Italic (_text_)', Icon: Italic },
  { kind: 'strike', label: 'Strikethrough', title: 'Strikethrough (~text~)', Icon: Strikethrough },
  { kind: 'mono', label: 'Monospace', title: 'Monospace (```text```)', Icon: Code },
];

/** ChatScreen caps the composer at 120px (handleInputChange) — match it here. */
const COMPOSER_MAX_HEIGHT_PX = 120;

export default function FormatToolbar({
  textareaRef,
  value,
  onChange,
  disabled = false,
}: FormatToolbarProps) {
  // Re-render on selection change so the active button stays in sync.
  // A counter is enough — the real state lives in the textarea.
  const [, setSelTick] = useState(0);

  // Listeners attached to the current textarea element, so keyboard /
  // mouse selection changes update the active button without a click.
  const attachedRef = useRef<{ el: HTMLTextAreaElement; bump: () => void } | null>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || attachedRef.current?.el === el) return;
    const prev = attachedRef.current;
    if (prev) {
      prev.el.removeEventListener('select', prev.bump);
      prev.el.removeEventListener('keyup', prev.bump);
      prev.el.removeEventListener('click', prev.bump);
    }
    const bump = () => setSelTick((t) => t + 1);
    el.addEventListener('select', bump);
    el.addEventListener('keyup', bump);
    el.addEventListener('click', bump);
    attachedRef.current = { el, bump };
  });
  useEffect(
    () => () => {
      const prev = attachedRef.current;
      if (prev) {
        prev.el.removeEventListener('select', prev.bump);
        prev.el.removeEventListener('keyup', prev.bump);
        prev.el.removeEventListener('click', prev.bump);
        attachedRef.current = null;
      }
    },
    [],
  );

  const activeState = (kind: FormatKind): boolean => {
    const el = textareaRef.current;
    if (!el) return false;
    return isSelectionFormatted(value, el.selectionStart ?? 0, el.selectionEnd ?? 0, kind);
  };

  const handleFormat = (kind: FormatKind) => {
    const el = textareaRef.current;
    if (!el || disabled) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const result = applyFormat(value, start, end, kind);
    onChange(result.text);
    // Restore focus + selection after React re-renders the new value.
    window.setTimeout(() => {
      const nextEl = textareaRef.current;
      if (!nextEl) return;
      nextEl.focus();
      nextEl.setSelectionRange(result.selectionStart, result.selectionEnd);
      // Auto-resize, same as ChatScreen's handleInputChange does.
      nextEl.style.height = 'auto';
      nextEl.style.height = `${Math.min(nextEl.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
      setSelTick((t) => t + 1);
    }, 0);
  };

  return (
    <div
      role="toolbar"
      aria-label="Text formatting"
      className="flex items-center gap-1 px-2 py-1 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5"
    >
      {BUTTONS.map(({ kind, label, title, Icon }) => {
        const active = activeState(kind);
        return (
          <button
            key={kind}
            type="button"
            aria-label={label}
            aria-pressed={active}
            title={title}
            disabled={disabled}
            onClick={() => handleFormat(kind)}
            onMouseUp={() => setSelTick((t) => t + 1)}
            className={`p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
              active
                ? 'bg-green-cta text-white'
                : 'text-gray-500 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-white/10'
            }`}
          >
            <Icon className="h-5 w-5" />
          </button>
        );
      })}
      <span className="ml-1 text-[11px] text-gray-400 dark:text-text-secondary select-none">
        *bold* _italic_ ~strike~ ```mono```
      </span>
    </div>
  );
}
