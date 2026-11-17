/**
 * ChatComposer — the chat input row, extracted from ChatScreen (Report 3
 * typing-freeze fix #20/#2).
 *
 * WHY IT EXISTS: `input` used to live in the 5,190-line ChatScreen, so every
 * keystroke (`setInput`) re-rendered the whole screen — all rendered message
 * bubbles, filters, album grouping — synchronously on the main thread
 * (150-msg chat: 26 longtasks / 3.4s blocked for 42 chars, [MOCK-PROVEN]).
 * The composer now owns its own `input` state in this memoized component,
 * so a keystroke re-renders ONLY the composer. ChatScreen reads the text
 * only when it needs it (send / schedule / failure-restore) through the
 * imperative handle, and pushes text in (draft restore / edit / failure
 * restore / emoji insert) through the same handle — none of those paths
 * re-render the message list per keystroke.
 *
 * Also owns, locally (previously ChatScreen state touched per keystroke):
 *  - @mention detection + picker (#25: candidates are now memoized and
 *    computed ONLY while the picker is open, not on every render);
 *  - the format toolbar visibility (selection-driven);
 *  - the typing-indicator throttle (2.5s beat + 2s stop) — it only calls
 *    the stable `callbacks.onTypingStart/Stop`, which do the single
 *    realtimeSync write (#142: no second `chats/meta/typing` write);
 *  - the draft save, debounced 500ms (#22: no synchronous
 *    `localStorage.setItem` on every keystroke).
 *
 * The component is `memo`ed and every callback it receives is stable
 * (ChatScreen passes setState dispatchers directly + one stable callbacks
 * object built on latest-refs), so a ChatScreen re-render (incoming
 * message, presence, receipts) does not re-render the composer either.
 * It stays mounted while recording (`isRecording` renders null, state
 * kept) so a recording never wipes typed text.
 */
import React, { forwardRef, memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AtSign, Camera, ChevronRight, Mic, Paperclip, Send, Smile } from 'lucide-react';
import FormatToolbar from './FormatToolbar';
import { ALL_STICKERS, extractEmojis, suggestStickersForText, type StickerDef } from './stickerPack';
import { getEnterIsSend, getReplaceEmoji, getSpellCheck } from '../services/appSettings';
import { replaceEmoticonBeforeCursor } from '../services/suggestions';

export interface ChatComposerHandle {
  /** Current composer text (no React render involved). */
  getText: () => string;
  /** Replace the composer text (draft restore, edit, emoji handled below). */
  setText: (t: string) => void;
  /** Put text back only if the composer is currently empty (send-failure restore). */
  setTextIfEmpty: (t: string) => void;
  /** Append text at the end (emoji picker) and refocus. */
  insertText: (t: string) => void;
  /** Clear the composer (after a successful send). Cancels a pending draft save. */
  clear: () => void;
  focus: () => void;
}

/** Stable callbacks into ChatScreen (latest-ref wrappers — see ChatScreen). */
export interface ChatComposerCallbacks {
  onSend: () => void;
  onTypingStart: () => void;
  onTypingStop: () => void;
  /** Called (debounced 500ms by this component) with the current text. */
  onDraftChange: (text: string) => void;
  onMicPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  /** WA Wave-2 (DM #25 / Media E10): opens the combined Emoji/GIF/Sticker
   *  panel. Kept for parity with the old sticker-picker entry point. */
  onOpenCombinedPicker: (tab: 'emoji' | 'stickers' | 'gifs') => void;
  onOpenCamera: () => void;
  /** Wave-2 E9: send a sticker tapped in the suggestion row. */
  onSendSticker: (s: StickerDef) => void;
  /** Wave-2 E9 (WA `WAWebStickerSuggestionResults` onShowMore): open the
   *  sticker picker pre-filtered by the last typed emoji. */
  onShowMoreSuggestions?: (emoji: string) => void;
}

interface ChatComposerProps {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  contactsList: any[];
  otherUser: any;
  isCommunity: boolean;
  chatId: string | undefined;
  editing: boolean;
  placeholder: string;
  disabled: boolean;
  isRecording: boolean;
  showAttachMenu: boolean;
  showCombinedPicker: boolean;
  /** WA Wave-2 (DM #25 / Media E10): the emoji button is the single entry
   *  point for the combined Emoji/GIF/Sticker panel — toggling / tab
   *  selection lives in ChatScreen. */
  onEmojiButton: () => void;
  setShowAttachMenu: React.Dispatch<React.SetStateAction<boolean>>;
  callbacks: ChatComposerCallbacks;
  /** Wave-2 E9: stickers the suggestion row may offer. Defaults to the
   *  bundled packs; ChatScreen passes bundled + animated packs. */
  suggestableStickers?: StickerDef[];
}

const DRAFT_DEBOUNCE_MS = 500;

function ChatComposerInner(
  {
    textareaRef,
    contactsList,
    otherUser,
    isCommunity,
    chatId,
    editing,
    placeholder,
    disabled,
    isRecording,
    showAttachMenu,
    showCombinedPicker,
    onEmojiButton,
    setShowAttachMenu,
    callbacks,
    suggestableStickers,
  }: ChatComposerProps,
  ref: React.Ref<ChatComposerHandle>,
) {
  const [input, setInput] = useState('');
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [showFormatBar, setShowFormatBar] = useState(false);

  // Mirror of `input` for the imperative handle (no render on read).
  const inputValueRef = useRef('');
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(0);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // WA parity (DM audit row 23): a draft is per-chat text, not per-keystroke
  // timing. The 500 ms debounce must not eat the last keystrokes when the
  // user leaves the chat quickly — flush the pending draft on unmount
  // instead of dropping it. (clear() already cancels the timer after a
  // successful send, so a sent message never re-saves as a draft.)
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
        callbacksRef.current.onDraftChange(inputValueRef.current);
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  const scheduleDraft = (v: string) => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => callbacksRef.current.onDraftChange(v), DRAFT_DEBOUNCE_MS);
  };

  const applyText = (v: string) => {
    inputValueRef.current = v;
    setInput(v);
  };

  useImperativeHandle(ref, () => ({
    getText: () => inputValueRef.current,
    setText: (t: string) => { applyText(t); },
    setTextIfEmpty: (t: string) => { if (!inputValueRef.current) applyText(t); },
    insertText: (t: string) => {
      const next = inputValueRef.current + t;
      applyText(next);
      scheduleDraft(next);
      textareaRef.current?.focus();
    },
    clear: () => {
      if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
      applyText('');
    },
    focus: () => { textareaRef.current?.focus(); },
  }), [textareaRef]);

  // Auto-resize the textarea as the text grows/shrinks (was inline in
  // handleInputChange — a layout read/write per keystroke in ChatScreen).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input, textareaRef]);

  // #25: mention candidates are computed ONLY while the picker is open,
  // memoized on [mentionQuery, contactsList, ...] — never as an IIFE on
  // every render, and never while the picker is closed.
  // #27: dedupe by uid AND username — in a 1-1 DM the peer is both in
  // contactsList and unshifted as otherUser, so without this he showed
  // twice. The unshifted otherUser entry wins (it is first).
  const mentionCandidates = useMemo(() => {
    if (!showMention) return [];
    const list: any[] = [...contactsList];
    if (otherUser && !isCommunity) {
      list.unshift({
        id: chatId,
        displayName: otherUser.displayName || otherUser.username,
        username: otherUser.username,
        photoURL: otherUser.photoURL,
      });
    }
    const seenUids = new Set<string>();
    const seenNames = new Set<string>();
    const deduped = list.filter((c) => {
      const uidKey = String(c.uid || c.id || '').toLowerCase();
      const nameKey = String(c.username || '').toLowerCase();
      if ((uidKey && seenUids.has(uidKey)) || (nameKey && seenNames.has(nameKey))) return false;
      if (uidKey) seenUids.add(uidKey);
      if (nameKey) seenNames.add(nameKey);
      return true;
    });
    const q = mentionQuery.toLowerCase();
    return deduped
      .filter((c) => {
        const n = `${c.displayName || ''} ${c.username || ''}`.toLowerCase();
        return !q || n.includes(q);
      })
      .slice(0, 8);
  }, [showMention, mentionQuery, contactsList, otherUser, isCommunity, chatId]);

  const insertMention = (c: any) => {
    const name = c.username || (c.displayName || c.name || 'User').split(' ')[0] || 'User';
    const v = inputValueRef.current;
    const atIdx = v.lastIndexOf('@');
    const next = (atIdx >= 0 ? v.slice(0, atIdx) : v) + `@${name} `;
    applyText(next);
    scheduleDraft(next);
    setShowMention(false);
    textareaRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    let v = e.target.value;
    // WA parity E6: "Emoji will replace specific text as you type" — when
    // the toggle is on and an emoticon ends exactly at the caret (i.e.
    // its last character was just typed), swap it for the emoji in place
    // and put the caret back after it. The send-time pass in ChatScreen
    // stays as the safety net for pasted / mid-text emoticons.
    let nextCursor: number | null = null;
    if (getReplaceEmoji()) {
      const r = replaceEmoticonBeforeCursor(v, e.target.selectionStart ?? v.length);
      if (r) {
        v = r.text;
        nextCursor = r.cursor;
      }
    }
    applyText(v);
    if (nextCursor !== null) {
      // The controlled value commits on the next frame; restore the caret
      // then, so React's value write doesn't drag it to the end.
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (ta) {
          try { ta.setSelectionRange(nextCursor, nextCursor); } catch { /* intentionally ignored */ }
        }
      });
    }
    scheduleDraft(v);
    // Typing collapses any text selection, so the format bar hides.
    setShowFormatBar(false);
    const atIdx = v.lastIndexOf('@');
    if (atIdx >= 0) {
      const after = v.slice(atIdx + 1);
      if (/^[A-Za-z0-9_]*$/.test(after) && (atIdx === 0 || /\s/.test(v[atIdx - 1]))) {
        setMentionQuery(after);
        setShowMention(true);
      } else {
        setShowMention(false);
      }
    } else {
      setShowMention(false);
    }
    // Send "typing" at most once every 2.5s, not on every keystroke.
    // #142: the parent's onTypingStart does ONE write (realtimeSync
    // typing doc) — the old second `chats/meta/typing` write is gone.
    const now = Date.now();
    if (now - lastTypingSentRef.current > 2500) {
      lastTypingSentRef.current = now;
      callbacksRef.current.onTypingStart();
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => callbacksRef.current.onTypingStop(), 2000);
  };

  // Wave-2 E9 (WA WAWebStickerSuggestion): stickers matching the emoji
  // typed so far, recomputed on every keystroke (cheap: ~70 stickers).
  // Hidden while editing a message (a tap would send, not edit), and
  // while the emoji picker / attach menu covers the composer.
  const stickerSuggestions = useMemo(() => {
    if (editing || showCombinedPicker || showAttachMenu) return [];
    return suggestStickersForText(input, suggestableStickers ?? ALL_STICKERS);
  }, [input, editing, showCombinedPicker, showAttachMenu, suggestableStickers]);

  const pickSuggestedSticker = (s: StickerDef) => {
    // Tapping a suggestion sends the sticker instead of the typed text.
    applyText('');
    callbacksRef.current.onSendSticker(s);
  };

  // Wave-2 E9 (WA onShowMore): the last emoji typed is the filter the
  // sticker picker opens with when the user taps "more".
  const lastTypedEmoji = useMemo(() => {
    const emojis = extractEmojis(input);
    return emojis.length > 0 ? emojis[emojis.length - 1] : '';
  }, [input]);

  // Stay mounted while recording (state preserved) — render nothing.
  if (isRecording) return null;

  const hasText = input.trim().length > 0;

  return (
    <>
      {/* Phase 3: @mention picker */}
      {showMention && mentionCandidates.length > 0 && (
        <div className="bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5 max-h-44 overflow-y-auto" role="listbox" aria-label="Mention someone">
          {mentionCandidates.map((c: any) => (
            <button key={c.id || c.uid || c.username} type="button" role="option" onClick={() => insertMention(c)} className="flex items-center gap-3 w-full px-4 py-2.5 text-left hover:bg-gray-100 dark:hover:bg-input-dark">
              <AtSign className="h-4 w-4 text-primary-green flex-shrink-0" />
              <span className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">{c.displayName || c.username || c.name}</span>
              {c.username && <span className="text-xs text-gray-400 truncate">@{c.username}</span>}
            </button>
          ))}
        </div>
      )}

      {/* Composer fix (TG-style): formatting toolbar (B / I / S / Mono)
          shows ONLY while text is selected in the composer. */}
      {showFormatBar && hasText && (
        <FormatToolbar
          textareaRef={textareaRef}
          value={input}
          onChange={(next) => { applyText(next); scheduleDraft(next); }}
        />
      )}

      {/* Wave-2 E9: sticker suggestions for the typed emoji (WA
          WAWebStickerSuggestion). Horizontal row above the input; tapping
          a sticker sends it instead of the typed text. */}
      {stickerSuggestions.length > 0 && (
        <div
          data-sticker-suggestions
          aria-label="Sticker suggestions"
          className="flex items-center gap-2 px-3 pb-1.5 pt-1 overflow-x-auto"
        >
          {stickerSuggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickSuggestedSticker(s)}
              aria-label={`Send sticker suggestion: ${s.label}`}
              title={s.label}
              className="flex-shrink-0 h-12 w-12 rounded-2xl bg-gray-100 dark:bg-input-dark flex items-center justify-center text-2xl hover:scale-110 active:scale-95 transition-transform shadow-sm"
            >
              {s.image ? (
                <img src={s.image} alt={s.label} draggable={false} className="h-8 w-8 object-contain pointer-events-none" />
              ) : (
                <span>{s.art}</span>
              )}
            </button>
          ))}
          {/* Wave-2 E9 (WA onShowMore): opens the sticker picker filtered
              by the last typed emoji, so the user can browse all matches. */}
          {lastTypedEmoji && (
            <button
              type="button"
              onClick={() => callbacksRef.current.onShowMoreSuggestions?.(lastTypedEmoji)}
              aria-label={`More stickers with ${lastTypedEmoji}`}
              title="More stickers"
              className="flex-shrink-0 h-12 w-12 rounded-2xl bg-gray-100 dark:bg-input-dark flex items-center justify-center text-gray-500 dark:text-text-secondary hover:scale-110 active:scale-95 transition-transform shadow-sm"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </div>
      )}

      {/* Main input row — SBS fix 1: at 390px the 5×44px pill buttons +
          2×48px outer buttons overflowed the row and clipped the attach
          (paperclip) button. Buttons shrink on small screens and the
          pill/textarea may shrink (min-w-0) so everything fits. */}
      <div className="flex items-end gap-1.5 sm:gap-2 p-2 min-w-0">
        <div className="flex flex-1 min-w-0 items-end rounded-3xl bg-panel-light dark:bg-panel-dark px-2 py-1.5 shadow-sm gap-1">
          {/* Emoji button — WA Wave-2 (DM #25 / Media E10): the single
              entry point for the combined "Emojis, GIFs, Stickers" panel. */}
          <button
            aria-label="Emojis, GIFs, Stickers"
            aria-expanded={showCombinedPicker}
            onClick={onEmojiButton}
            className="p-1.5 sm:p-2 min-h-[36px] min-w-[36px] sm:min-h-[44px] sm:min-w-[44px] flex items-center justify-center text-gray-500 dark:text-text-secondary hover:text-gray-700 flex-shrink-0"
          >
            <Smile className="h-5 w-5 sm:h-6 sm:w-6" />
          </button>

          {/* Text input — spell check + Enter behaviour follow Settings > Chats. */}
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={handleInputChange}
            spellCheck={getSpellCheck()}
            autoCorrect="on"
            autoCapitalize="sentences"
            autoComplete="on"
            onKeyDown={(e) => { if (e.key === 'Escape') { setShowMention(false); return; } if (e.key === 'Enter' && !e.shiftKey && getEnterIsSend()) { e.preventDefault(); callbacksRef.current.onSend(); } }}
            onSelect={() => { const el = textareaRef.current; if (el) setShowFormatBar(el.selectionStart !== el.selectionEnd); }}
            placeholder={editing ? 'Edit message...' : placeholder}
            className="flex-1 min-w-0 bg-transparent py-2 dt-msg-text text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-500 resize-none max-h-28 leading-snug"
            style={{ minHeight: '40px' }}
            disabled={disabled}
          />

          {/* Attach menu toggle */}
          <button aria-label="Attach" aria-expanded={showAttachMenu} onClick={() => setShowAttachMenu((s) => !s)} disabled={disabled} className={`p-1.5 sm:p-2 min-h-[36px] min-w-[36px] sm:min-h-[44px] sm:min-w-[44px] flex items-center justify-center flex-shrink-0 transition-colors ${showAttachMenu ? 'text-primary-green' : 'text-gray-500 dark:text-text-secondary'}`}>
            <Paperclip className="h-5 w-5 sm:h-6 sm:w-6" />
          </button>

          {/* Camera (only when no text) — Phase 4: opens the device camera (rear) on mobile via capture="environment"; desktop ignores the hint and shows the file picker instead. */}
          {!hasText && (
            <button aria-label="Take a photo" onClick={() => callbacksRef.current.onOpenCamera()} disabled={disabled} className="p-1.5 sm:p-2 min-h-[36px] min-w-[36px] sm:min-h-[44px] sm:min-w-[44px] flex items-center justify-center text-gray-500 dark:text-text-secondary flex-shrink-0">
              <Camera className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
          )}
        </div>

        {/* Send / Mic button */}
        {/* ROADMAP-2 item 12: hold-to-record with slide gestures
            (pointer events). No onClick for the mic — the click
            fired after pointerup would start a second recording. */}
        <button
          aria-label={hasText ? 'Send message' : 'Record voice message — hold to record, slide up to lock, slide left to cancel'}
          onClick={hasText ? () => callbacksRef.current.onSend() : undefined}
          onPointerDown={hasText ? undefined : callbacksRef.current.onMicPointerDown}
          disabled={disabled}
          className="flex h-11 w-11 sm:h-12 sm:w-12 shrink-0 items-center justify-center rounded-full bg-green-cta text-white shadow-sm hover:bg-dark-green transition-[background-color,transform,opacity] active:scale-90 disabled:opacity-50 touch-none select-none"
        >
          {hasText ? <Send className="h-5 w-5 ml-0.5" /> : <Mic className="h-6 w-6" />}
        </button>
      </div>
    </>
  );
}

const ChatComposer = memo(forwardRef(ChatComposerInner));
export default ChatComposer;
