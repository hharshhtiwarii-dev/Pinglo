/**
 * ReactionPicker — full-emoji reaction picker (Messaging Group, Worker M2).
 *
 * Replaces ChatScreen's inline 6-quick-emoji rows (ChatScreen.tsx ~line
 * 2708 long-press bubble + ~line 2777 context-menu row, both rendering
 * EMOJI_QUICK). Same storage shape — the caller keeps doing the write,
 * exactly like ChatScreen.addReaction already does:
 *
 *   const pick = (emoji: string) => addReaction(msg.id, emoji);
 *   // addReaction toggles: same emoji again = removed (deleteField),
 *   // different emoji = replaced. This picker just reports the tap.
 *
 * Behaviour (WhatsApp-like):
 * - Quick row first (the same 6 QUICK_REACTIONS), with a "+" button that
 *   expands the full picker; tapping any emoji picks it AND closes the
 *   picker (a reaction is one tap, unlike the composer emoji picker).
 * - Full picker: search (keywords, e.g. "love", "fire", "thumbs up"),
 *   Recents row (shared `dt_emoji_recents` key with EmojiPicker), and
 *   category tabs (REACTION_CATEGORIES — the 9 categories; Gestures are
 *   still reachable via search).
 * - `myReaction` highlights the emoji I already reacted with.
 * - Escape closes; backdrop click closes.
 *
 * Variants:
 * - 'popover' (default): compact bubble for anchoring above/below a
 *   message bubble (position it with a relative wrapper in the caller).
 *   Includes a transparent fixed backdrop so tapping elsewhere closes it.
 * - 'sheet': full bottom sheet (e.g. from the context menu on small
 *   screens), same layout as PollComposer.
 *
 * Also exported: `ReactionChips` — the small count chips under a message
 * (replaces ChatScreen's inline reactionCounts loop ~line 2335/2675).
 * It derives counts with getReactionCounts, highlights my reaction, and
 * reports chip taps (e.g. open the who-reacted sheet) via onChipClick.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import {
  ALL_REACTION_EMOJIS,
  QUICK_REACTIONS,
  REACTION_CATEGORIES,
  getReactionCounts,
  loadRecentReactions,
  rememberReactionEmoji,
  searchReactionEmojis,
  type ReactionMap,
} from '../services/reactions';

export interface ReactionPickerProps {
  /** The emoji I already reacted with on this message (highlights it). */
  myReaction?: string | null;
  /**
   * Display name of the message sender, for the WA accessibility label
   * "React to message from {senderName}". Pass 'You' for my own messages.
   * When omitted the dialog falls back to "Pick a reaction".
   */
  senderName?: string;
  /**
   * Called with the tapped emoji. Caller persists it with toggle
   * semantics — same emoji again removes the reaction (see header).
   * The picker closes itself right after calling this.
   */
  onSelect: (emoji: string) => void;
  /** Dismiss without picking. */
  onClose: () => void;
  /** 'popover' (default) = anchored bubble; 'sheet' = bottom sheet. */
  variant?: 'popover' | 'sheet';
  /** Show the 6-emoji quick row on top (default true). */
  showQuickRow?: boolean;
  /**
   * NF-1 channel policy 'default': only the 6 quick reactions — hide
   * the "+" that opens the full picker and never expand it.
   */
  quickOnly?: boolean;
}

export default function ReactionPicker({
  myReaction,
  senderName,
  onSelect,
  onClose,
  variant = 'popover',
  showQuickRow = true,
  quickOnly = false,
}: ReactionPickerProps) {
  const [expanded, setExpanded] = useState(variant === 'sheet');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Smileys');
  const [recents, setRecents] = useState<string[]>(() => loadRecentReactions());
  // W26 (#32 follow-up — picker closes on finger lift): a touch long-press
  // opens this picker at ~500 ms, and the finger lift then synthesises a
  // compatibility `click` that can land on this popover's fixed backdrop
  // (it covers the viewport the moment the picker mounts). Ignore
  // backdrop/Escape dismissals in the first 700 ms after mount — the echo
  // of the gesture that opened the picker must not dismiss it. Picking an
  // emoji (pick() below) never goes through this guard, so a fast tap on
  // an emoji right after opening still works.
  const mountedAtRef = useRef(Date.now());
  const isEchoDismiss = () => Date.now() - mountedAtRef.current < 700;
  const dismiss = () => {
    if (isEchoDismiss()) return;
    onClose();
  };

  // Escape closes (both variants).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    return searchReactionEmojis(q);
  }, [query]);

  const shown =
    results !== null
      ? results
      : REACTION_CATEGORIES.find((c) => c.name === category)?.emojis || [];

  const pick = (emoji: string) => {
    rememberReactionEmoji(emoji);
    setRecents(loadRecentReactions());
    onSelect(emoji);
    onClose();
  };

  const emojiBtn = (emoji: string, key: string, size = 'text-2xl') => (
    <button
      key={key}
      type="button"
      onClick={() => pick(emoji)}
      aria-label={`React ${emoji}${myReaction === emoji ? ' (your reaction, tap to remove)' : ''}`}
      aria-pressed={myReaction === emoji}
      className={`${size} leading-none p-1 rounded-lg transition-transform hover:scale-125 ${
        myReaction === emoji ? 'bg-primary-green/20 ring-2 ring-primary-green' : 'hover:bg-black/5 dark:hover:bg-white/10'
      }`}
    >
      {emoji}
    </button>
  );

  const body = (
    <div
      className={
        variant === 'sheet'
          ? 'w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-4 max-h-[85vh] overflow-y-auto'
          : 'w-[300px] max-w-[calc(100vw-2rem)] bg-panel-light dark:bg-panel-dark rounded-2xl shadow-xl border border-black/10 dark:border-white/10 p-2'
      }
      role="dialog"
      aria-modal={variant === 'sheet' ? true : undefined}
      aria-label={senderName ? `React to message from ${senderName}` : 'Pick a reaction'}
    >
      {showQuickRow && (
        <div className="flex items-center gap-0.5 px-1">
          {QUICK_REACTIONS.map((e) => emojiBtn(e, `quick:${e}`, 'text-[26px]'))}
          {!expanded && !quickOnly && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-label="Show all emojis"
              className="ml-1 w-8 h-8 flex-shrink-0 rounded-full bg-gray-100 dark:bg-input-dark hover:bg-primary-green/15 text-gray-500 dark:text-text-secondary hover:text-primary-green flex items-center justify-center transition-colors"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      {expanded && !quickOnly && (
        <>
          {/* Search */}
          <div className="flex items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5 mt-2">
            <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search emoji"
              aria-label="Search emoji"
              className="flex-1 bg-transparent text-sm outline-none text-gray-900 dark:text-text-primary placeholder:text-gray-400"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search" className="text-gray-400">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Category tabs */}
          {!query && (
            <div className="flex gap-1 pt-2 overflow-x-auto scrollbar-hide">
              {REACTION_CATEGORIES.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setCategory(c.name)}
                  aria-pressed={category === c.name}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    category === c.name
                      ? 'bg-primary-green/15 text-primary-green'
                      : 'bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary'
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {/* Recents */}
          {!query && recents.length > 0 && (
            <div className="pt-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1 px-1">
                Recent reactions
              </p>
              <div className="flex gap-1 overflow-x-auto scrollbar-hide pb-1">
                {recents.map((e) => emojiBtn(e, `recent:${e}`))}
              </div>
            </div>
          )}

          {/* Grid */}
          <div
            className={`pt-1 overflow-y-auto ${
              variant === 'sheet' ? 'max-h-[50vh]' : 'max-h-56'
            }`}
          >
            {shown.length === 0 ? (
              <p className="text-center text-xs text-gray-400 py-6">
                No emoji found.
              </p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {shown.map((e, i) => emojiBtn(e, `${category}:${i}:${e}`))}
              </div>
            )}
          </div>

          <p className="text-[11px] text-center text-gray-400 pt-1">
            {results !== null
              ? `${results.length} result${results.length === 1 ? '' : 's'}`
              : `${ALL_REACTION_EMOJIS.length} emojis`}
          </p>
        </>
      )}
    </div>
  );

  if (variant === 'sheet') {
    return (
      <div
        className="fixed inset-0 z-[9999] bg-black/60 flex items-end"
        onClick={dismiss}
      >
        <div className="w-full" onClick={(e) => e.stopPropagation()}>
          {body}
        </div>
      </div>
    );
  }

  // Popover: transparent fixed backdrop (tap elsewhere closes) + bubble.
  // WA parity E8: clicks INSIDE the picker must not bubble to ChatScreen's
  // messages-area onClick, which closes the reaction picker on any bubbled
  // click >1s after the long-press — without this, tapping '+' (expand),
  // a category tab or the search box closed the picker instead of using
  // it, so the full picker ("Recent reactions", search) was unreachable
  // from a long-press. The backdrop button below stays the outside-tap
  // dismiss path; picks close via addReaction as before.
  return (
    <>
      <button
        type="button"
        aria-label="Close reaction picker"
        tabIndex={-1}
        onClick={dismiss}
        className="fixed inset-0 z-40 cursor-default bg-transparent"
      />
      <div className="relative z-50" onClick={(e) => e.stopPropagation()}>{body}</div>
    </>
  );
}

// ── ReactionChips — count chips under a message ────────────────────────────

export interface ReactionChipsProps {
  /** The message/status `reactions` map ({ [uid]: emoji }). */
  reactions: ReactionMap | null | undefined;
  /** My uid — highlights the chip I reacted with. */
  myUid?: string | null;
  /** Chip tapped (emoji) — e.g. open the who-reacted sheet. */
  onChipClick?: (emoji: string) => void;
}

/**
 * Small count chips (❤️ 2 · 😂 1 …), most-reacted first. Replaces the
 * inline `reactionCounts` loop in ChatScreen (~line 2335/2675): that loop
 * counted raw Object.values with no validation, so a junk value stored by
 * an old client showed up as a chip. getReactionCounts skips those.
 */
export function ReactionChips({ reactions, myUid, onChipClick }: ReactionChipsProps) {
  const counts = getReactionCounts(reactions);
  if (counts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1" aria-label="Reactions">
      {counts.map(({ emoji, count, userIds }) => {
        const mine = !!myUid && userIds.includes(myUid);
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onChipClick?.(emoji)}
            title={mine ? 'Your reaction — tap to view' : 'Tap to view who reacted'}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] border transition-colors ${
              mine
                ? 'bg-primary-green/15 border-primary-green/50 font-semibold'
                : 'bg-black/5 dark:bg-white/10 border-black/10 dark:border-white/10 hover:bg-black/10 dark:hover:bg-white/15'
            }`}
          >
            <span>{emoji}</span>
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
