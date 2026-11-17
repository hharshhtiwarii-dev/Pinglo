/**
 * Feature 5 — Archived chats + chat folders (Phase 1).
 *
 * Storage (no schema change, no new collection):
 *   users/{uid}.chatPrefs[chatId] = { ..., archived?: boolean, folderId?: string | null }
 *   users/{uid}.chatFolders        = ChatFolder[]
 * Both are written with the existing `updateDoc(doc(db, 'users', uid), …)` path
 * used by ChatListScreen.savePref, and read back in the same onSnapshot that
 * already loads chatPrefs. `database.ts` already handles dotted nested keys
 * (`chatPrefs.<chatId>`) in updateDoc, so no DB-layer change is needed.
 *
 * localStorage fallback (hybrid local mode / offline):
 *   pinglo:chatFolders:<uid>  and  pinglo:chatPrefs:<uid>
 * Firestore wins when it has data; local data is merged underneath it so a
 * folder created while offline is not lost on the next snapshot. Writes that
 * fail in Firestore are kept in localStorage (and kept on screen) instead of
 * being silently dropped — the old savePref() only alerted and left state
 * inconsistent with the server.
 *
 * This module is dependency-free (no aws imports) so the pure helpers can be
 * unit-tested without Amplify. ChatListScreen wires it in via PATCH.md.
 */

export interface ChatFolder {
  id: string;
  name: string;
  /** Tailwind-ish hex used as a dot / chip accent. Optional; defaults to green. */
  color?: string;
  createdAt: number;
}

/** Per-chat prefs relevant to Feature 5 (subset of chatPrefs[chatId]). */
export interface ArchivePrefs {
  archived?: boolean;
  folderId?: string | null;
  pinned?: boolean;
  muted?: boolean;
  markedUnread?: boolean;
  deletedAt?: number;
}

export type ChatPrefsMap = Record<string, ArchivePrefs & Record<string, any>>;

export const ARCHIVED_FILTER = 'Archived';
export const BASE_FILTERS = ['All', 'Unread', 'Favorites', 'Groups'] as const;

export const FOLDER_COLORS = ['#25D366', '#3B82F6', '#F59E0B', '#EC4899', '#8B5CF6', '#EF4444', '#14B8A6'];

export const MAX_FOLDERS = 20;
export const MAX_FOLDER_NAME = 30;

/** Folder views are encoded in the existing string `filter` state as `folder:<id>`. */
export const folderFilter = (folderId: string): string => `folder:${folderId}`;
export const folderIdFromFilter = (filter: string): string | null =>
  filter.startsWith('folder:') ? filter.slice('folder:'.length) : null;
export const isFolderFilter = (filter: string): boolean => filter.startsWith('folder:');

export const isArchived = (prefs: ChatPrefsMap, chatId: string): boolean =>
  Boolean(prefs[chatId]?.archived);
export const getFolderId = (prefs: ChatPrefsMap, chatId: string): string | null =>
  prefs[chatId]?.folderId || null;

export function newFolderId(): string {
  return 'folder_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/**
 * Validate a folder name. Returns the trimmed name, or null with a reason
 * when it cannot be used. Duplicate check is case-insensitive.
 */
export function sanitizeFolderName(
  raw: string,
  existing: ChatFolder[],
  ignoreId?: string,
): { name: string } | { error: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { error: 'Enter a folder name.' };
  if (name.length > MAX_FOLDER_NAME) return { error: `Keep it under ${MAX_FOLDER_NAME} characters.` };
  if (existing.some((f) => f.id !== ignoreId && f.name.toLowerCase() === name.toLowerCase())) {
    return { error: 'A folder with that name already exists.' };
  }
  if (existing.length >= MAX_FOLDERS && !ignoreId) {
    return { error: `You can have up to ${MAX_FOLDERS} folders.` };
  }
  return { name };
}

export function makeFolder(name: string, color?: string): ChatFolder {
  return { id: newFolderId(), name, color: color || FOLDER_COLORS[0], createdAt: Date.now() };
}

export function folderById(folders: ChatFolder[], id: string | null | undefined): ChatFolder | undefined {
  if (!id) return undefined;
  return folders.find((f) => f.id === id);
}

/**
 * Pure view filter — mirrors the existing filteredChats chain in ChatListScreen.
 * Archived chats are hidden from All / Unread / Favorites / Groups (WhatsApp
 * behaviour); they only appear in the Archived view. A folder view shows only
 * that folder's non-archived chats. `deletedAt` resurrection (a message newer
 * than the deletion brings the chat back) is left to the caller, exactly as
 * today — pass in chats that already passed that check.
 */
export function chatsForView<T extends { id: string }>(
  chats: T[],
  prefs: ChatPrefsMap,
  filter: string,
  isFavorite: (c: T) => boolean = () => false,
  isGroup: (c: T) => boolean = () => false,
  hasUnread: (c: T) => boolean = () => false,
): T[] {
  const folderId = folderIdFromFilter(filter);
  return chats.filter((c) => {
    const archived = isArchived(prefs, c.id);
    if (filter === ARCHIVED_FILTER) return archived;
    if (archived) return false; // archived chats live only in the Archived view
    if (folderId) return getFolderId(prefs, c.id) === folderId;
    if (filter === 'Unread') return hasUnread(c);
    if (filter === 'Favorites') return isFavorite(c);
    if (filter === 'Groups') return isGroup(c);
    return true; // 'All' (and any unknown filter falls back to All)
  });
}

export function countArchived(prefs: ChatPrefsMap, chatIds: string[]): number {
  return chatIds.filter((id) => isArchived(prefs, id)).length;
}

export function countInFolder(prefs: ChatPrefsMap, chatIds: string[], folderId: string): number {
  return chatIds.filter((id) => !isArchived(prefs, id) && getFolderId(prefs, id) === folderId).length;
}

// ── localStorage fallback (per-user, so accounts never leak into each other) ──

const foldersKey = (uid: string) => `pinglo:chatFolders:${uid}`;
const prefsKey = (uid: string) => `pinglo:chatPrefs:${uid}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota / private mode: the in-memory state still works for this session.
  }
}

export function loadLocalFolders(uid: string): ChatFolder[] {
  const list = readJson<unknown>(foldersKey(uid), []);
  if (!Array.isArray(list)) return [];
  return list
    .filter((f): f is ChatFolder => !!f && typeof (f as ChatFolder).id === 'string' && typeof (f as ChatFolder).name === 'string')
    .slice(0, MAX_FOLDERS);
}

export function saveLocalFolders(uid: string, folders: ChatFolder[]): void {
  writeJson(foldersKey(uid), folders);
}

export function loadLocalChatPrefs(uid: string): ChatPrefsMap {
  const prefs = readJson<unknown>(prefsKey(uid), {});
  return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as ChatPrefsMap) : {};
}

export function saveLocalChatPrefs(uid: string, prefs: ChatPrefsMap): void {
  writeJson(prefsKey(uid), prefs);
}

/**
 * Merge order: Firestore prefs win per chat; local prefs fill in chats the
 * server does not know about yet (e.g. archived while offline). Same rule for
 * folders: server list wins when non-empty, otherwise the local list.
 */
export function mergePrefs(server: ChatPrefsMap, local: ChatPrefsMap): ChatPrefsMap {
  const out: ChatPrefsMap = { ...local };
  for (const [id, p] of Object.entries(server)) out[id] = { ...(local[id] || {}), ...p };
  return out;
}

export function mergeFolders(server: ChatFolder[], local: ChatFolder[]): ChatFolder[] {
  if (server.length > 0) return server;
  return local;
}
