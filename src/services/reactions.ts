/**
 * reactions.ts — Full emoji reactions (Messaging Group, Worker M2).
 *
 * Pure logic + local recents for message / status reactions. This module
 * does NOT talk to Firestore/AppSync itself: the screen that owns the
 * message keeps doing the write (the same `updateDoc` + `deleteField()`
 * pattern ChatScreen.addReaction already uses), so this file stays usable
 * from ChatScreen, StatusScreen and anywhere else a `reactions` map shows up.
 *
 * ── Storage shape (UNCHANGED — compatible with the existing 6-emoji code) ──
 *   message.reactions = { [uid]: emoji }        // chats/<id>/messages/<id>
 *   status.reactions  = { [uid]: emoji }        // statuses/<id>
 *   One user = at most one reaction per message/status. Reacting with the
 *   same emoji again removes it; reacting with a different emoji replaces it.
 *   Counts are always derived client-side from this map (never stored).
 *
 * ── Emoji data ──
 *   Categories + grids are reused from EmojiPicker (EMOJI_CATEGORIES) so the
 *   picker, the composer and reactions never drift apart. The task's list
 *   (Smileys, People, Animals, Food, Activities, Travel, Objects, Symbols,
 *   Flags) is that list minus "Gestures" — gestures still work as reactions
 *   when picked via search, they just have no dedicated tab here.
 *   Recents share EmojiPicker's localStorage key (`dt_emoji_recents`) so the
 *   composer and the reaction picker show the same recent emojis, like
 *   WhatsApp does.
 */

import { EMOJI_CATEGORIES } from '../components/EmojiPicker';

/** uid -> emoji. Exactly the shape already stored on messages/statuses. */
export type ReactionMap = Record<string, string>;

export interface ReactionCount {
  emoji: string;
  count: number;
  /** Uids that reacted with this emoji (in map insertion order). */
  userIds: string[];
}

export interface ReactionUser {
  uid: string;
  emoji: string;
  displayName: string;
  photoURL?: string | null;
  isMe: boolean;
}

/** The 6 quick emojis ChatScreen already uses (EMOJI_QUICK, same order). WA verify DM-2 row 43: WA's canonical tray order is 👍 first (Like, Love, Haha, Wow, Sad, Folded Hands) — the old order led with ❤️. Same set, WA order. */
export const QUICK_REACTIONS: string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** The 9 reaction-picker categories (EmojiPicker minus "Gestures"). */
export const REACTION_CATEGORIES: { name: string; emojis: string[] }[] =
  EMOJI_CATEGORIES.filter((c) =>
    ['Smileys', 'People', 'Animals', 'Food', 'Activities', 'Travel', 'Objects', 'Symbols', 'Flags'].includes(c.name),
  );

/** All emojis the picker can react with (the 9 categories, flattened).
 * Deduplicated: EmojiPicker repeats ~21 emojis across categories
 * (⛷️/🏂 in People+Activities, 🧸/🎁/🎈/🎉/🪄/🪅/🎊 in Activities+Objects,
 * 🕳️ in Objects+Symbols, …). Without this the picker grid gets duplicate
 * React keys and the same emoji twice. */
export const ALL_REACTION_EMOJIS: string[] = [
  ...new Set(REACTION_CATEGORIES.flatMap((c) => c.emojis)),
];

// ── Counts / lookup ────────────────────────────────────────────────────────

/** Emoji -> count + who, most-reacted first. Empty map -> []. */
export function getReactionCounts(reactions: ReactionMap | null | undefined): ReactionCount[] {
  if (!reactions) return [];
  const byEmoji = new Map<string, string[]>();
  for (const [uid, emoji] of Object.entries(reactions)) {
    if (typeof emoji !== 'string' || !emoji) continue;
    const list = byEmoji.get(emoji) ?? [];
    list.push(uid);
    byEmoji.set(emoji, list);
  }
  return [...byEmoji.entries()]
    .map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
    .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
}

/** Total number of reactions on a message/status.
 * Counts only stored non-empty string emojis, like getReactionCounts does —
 * previously Object.keys().length also counted junk values (e.g. a
 * non-string written by an old client), so the badge total could disagree
 * with the who-reacted sheet. */
export function countReactions(reactions: ReactionMap | null | undefined): number {
  if (!reactions) return 0;
  return Object.values(reactions).filter((e) => typeof e === 'string' && e).length;
}

/** The emoji `uid` reacted with, or null when they have not reacted. */
export function getMyReaction(reactions: ReactionMap | null | undefined, uid: string | null | undefined): string | null {
  if (!reactions || !uid) return null;
  return reactions[uid] ?? null;
}

// ── Add / remove / toggle (pure — return a NEW map, never mutate) ──────────

/**
 * Toggle `uid`'s reaction to `emoji`.
 * Same emoji again -> removed. Different emoji -> replaced. No reaction yet -> added.
 * Returns the new map plus the emoji that is now stored (null = removed),
 * so the caller can persist exactly that one field, like ChatScreen does:
 *   emoji ? { [`reactions.${uid}`]: emoji } : { [`reactions.${uid}`]: deleteField() }
 */
export function toggleReaction(
  reactions: ReactionMap | null | undefined,
  uid: string,
  emoji: string,
): { reactions: ReactionMap; emoji: string | null } {
  const next = { ...(reactions ?? {}) };
  if (!isValidReactionEmoji(emoji)) return { reactions: next, emoji: next[uid] ?? null };
  if (next[uid] === emoji) {
    delete next[uid];
    return { reactions: next, emoji: null };
  }
  next[uid] = emoji;
  return { reactions: next, emoji };
}

/** Set (or replace) `uid`'s reaction. Returns the new map. */
export function addReaction(reactions: ReactionMap | null | undefined, uid: string, emoji: string): ReactionMap {
  return toggleReaction(reactions, uid, emoji).reactions;
}

/** Remove `uid`'s reaction, if any. Returns the new map. */
export function removeReaction(reactions: ReactionMap | null | undefined, uid: string): ReactionMap {
  const next = { ...(reactions ?? {}) };
  delete next[uid];
  return next;
}

// ── Who reacted ────────────────────────────────────────────────────────────

/**
 * Flat who-reacted list (me first, then the rest in map order).
 * `resolveUser` maps a uid to a display name/photo — e.g. ChatScreen's
 * `contactsList.find(c => c.uid === uid || c.id === uid)` lookup, falling
 * back to `currentUser` for my own uid. Unknown users become "User".
 */
export function getWhoReacted(
  reactions: ReactionMap | null | undefined,
  myUid: string | null | undefined,
  resolveUser?: (uid: string) => { displayName?: string; username?: string; photoURL?: string | null } | undefined,
): ReactionUser[] {
  if (!reactions) return [];
  const list: ReactionUser[] = Object.entries(reactions)
    .filter(([, emoji]) => typeof emoji === 'string' && emoji)
    .map(([uid, emoji]) => {
      const user = resolveUser?.(uid);
      const isMe = !!myUid && uid === myUid;
      return {
        uid,
        emoji,
        displayName: isMe ? 'You' : user?.displayName || user?.username || 'User',
        photoURL: user?.photoURL ?? null,
        isMe,
      };
    });
  list.sort((a, b) => Number(b.isMe) - Number(a.isMe));
  return list;
}

/** Who-reacted list grouped by emoji (for the sheet's emoji filter tabs). */
export function groupReactionsByEmoji(
  reactions: ReactionMap | null | undefined,
  myUid: string | null | undefined,
  resolveUser?: (uid: string) => { displayName?: string; username?: string; photoURL?: string | null } | undefined,
): { emoji: string; count: number; users: ReactionUser[] }[] {
  const all = getWhoReacted(reactions, myUid, resolveUser);
  const byEmoji = new Map<string, ReactionUser[]>();
  for (const u of all) {
    const list = byEmoji.get(u.emoji) ?? [];
    list.push(u);
    byEmoji.set(u.emoji, list);
  }
  return [...byEmoji.entries()]
    .map(([emoji, users]) => ({ emoji, count: users.length, users }))
    .sort((a, b) => b.count - a.count);
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * True for a single emoji (one grapheme cluster): plain emoji, emoji with
 * variation selector, ZWJ sequences (👩‍💻) and flags (🇮🇳). Rejects text,
 * multiple emojis and empty strings, so a bad value can never be stored.
 */
export function isValidReactionEmoji(value: string): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segments = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)];
    if (segments.length !== 1) return false;
  } else if (Array.from(value).length > 4) {
    return false;
  }
  return /\p{Extended_Pictographic}|\p{RI}/u.test(value);
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Keyword index for search. EmojiPicker's search only matches the emoji
 * itself or its category name; these keywords cover the words people
 * actually type ("love", "laugh", "cry", "fire", "thumbs up", ...).
 * Anything without an entry here is still searchable by category name.
 */
export const REACTION_EMOJI_KEYWORDS: Record<string, string[]> = {
  '❤️': ['love', 'heart', 'like', 'red heart'],
  '🧡': ['love', 'heart', 'orange heart'],
  '💛': ['love', 'heart', 'yellow heart'],
  '💚': ['love', 'heart', 'green heart'],
  '💙': ['love', 'heart', 'blue heart'],
  '💜': ['love', 'heart', 'purple heart'],
  '🖤': ['love', 'heart', 'black heart'],
  '🤍': ['love', 'heart', 'white heart'],
  '💔': ['heart', 'broken', 'sad', 'breakup'],
  '😂': ['laugh', 'laughing', 'funny', 'lol', 'joy', 'tears'],
  '🤣': ['laugh', 'laughing', 'funny', 'lol', 'rofl'],
  '😊': ['smile', 'happy', 'blush'],
  '😍': ['love', 'heart eyes', 'adore'],
  '🥰': ['love', 'smile', 'affection'],
  '😘': ['kiss', 'love'],
  '😮': ['wow', 'surprised', 'shock', 'omg'],
  '😲': ['wow', 'surprised', 'shock', 'astonished'],
  '😢': ['cry', 'sad', 'tear'],
  '😭': ['cry', 'sad', 'sob', 'tears'],
  '🥺': ['please', 'pleading', 'sad', 'puppy'],
  '😤': ['angry', 'huff', 'mad'],
  '😡': ['angry', 'mad', 'rage'],
  '🤯': ['mind blown', 'wow', 'shock'],
  '😱': ['scared', 'scream', 'fear', 'shock'],
  '🙏': ['pray', 'please', 'thanks', 'thank you', 'namaste'],
  '👍': ['thumbs up', 'like', 'yes', 'good', 'ok'],
  '👎': ['thumbs down', 'dislike', 'no', 'bad'],
  '👏': ['clap', 'applause', 'bravo'],
  '🙌': ['celebrate', 'hooray', 'praise'],
  '💪': ['strong', 'muscle', 'power'],
  '🔥': ['fire', 'hot', 'lit'],
  '💯': ['100', 'perfect', 'hundred'],
  '🎉': ['party', 'celebrate', 'congrats'],
  '🥳': ['party', 'celebrate', 'birthday'],
  '😎': ['cool', 'sunglasses'],
  '🤔': ['think', 'thinking', 'hmm'],
  '😴': ['sleep', 'sleepy', 'tired'],
  '🤗': ['hug', 'hugging'],
  '😇': ['angel', 'innocent', 'blessed'],
  '🤝': ['handshake', 'deal', 'agree'],
  '✌️': ['peace', 'victory'],
  '👌': ['ok', 'okay', 'perfect'],
  '🎂': ['birthday', 'cake'],
  '🍕': ['pizza', 'food'],
  '☕': ['coffee', 'tea', 'chai'],
  '⚽': ['football', 'soccer', 'sport'],
  '🏏': ['cricket', 'sport'],
  '🇮🇳': ['india', 'indian', 'flag'],
};

/**
 * Search all reaction emojis by keyword, category name, or the emoji itself.
 * Matching rules (tightened — the old version matched almost everything on
 * short queries: any category name *containing* the query, and any keyword
 * *contained in* the query, so "s" or "i love you" returned hundreds):
 * - the emoji itself (any length), or
 * - (query >= 2 chars) category name *starts with* the query
 *   ("sm" -> Smileys), or a keyword *containing* the query ("up" -> 👍).
 */
export function searchReactionEmojis(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = (catName: string, emoji: string): boolean => {
    if (emoji === q) return true;
    if (q.length < 2) return false;
    if (catName.toLowerCase().startsWith(q)) return true;
    const keywords = REACTION_EMOJI_KEYWORDS[emoji] ?? [];
    return keywords.some((k) => k.includes(q));
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cat of EMOJI_CATEGORIES) {
    for (const emoji of cat.emojis) {
      if (seen.has(emoji)) continue;
      if (matches(cat.name, emoji)) {
        seen.add(emoji);
        out.push(emoji);
      }
    }
  }
  return out;
}

// ── Recents (localStorage — shared with EmojiPicker) ───────────────────────

export const REACTION_RECENTS_KEY = 'dt_emoji_recents';
const MAX_RECENTS = 24;

export function loadRecentReactions(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REACTION_RECENTS_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((x: unknown) => typeof x === 'string' && isValidReactionEmoji(x)).slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

/** Put `emoji` at the front of recents (most recent first, max 24). */
export function rememberReactionEmoji(emoji: string): void {
  if (!isValidReactionEmoji(emoji)) return;
  try {
    const list = [emoji, ...loadRecentReactions().filter((x) => x !== emoji)].slice(0, MAX_RECENTS);
    localStorage.setItem(REACTION_RECENTS_KEY, JSON.stringify(list));
  } catch {
    // Private mode / full storage: recents are best-effort, never fatal.
  }
}
