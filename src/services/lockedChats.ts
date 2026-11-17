/**
 * Locked chats — single source of truth (Phase 5, Agent A).
 *
 * NEW FILE. Copy to: src/services/lockedChats.ts
 *
 * What it does
 * - Owns the locked-chat id list. Canonical home is the OWNER-ONLY private
 *   doc `users/{uid}/private/locked` (`{ hiddenChatIds: string[] }`).
 *   Older builds kept `users/{uid}.hiddenChats` on the PUBLIC user doc,
 *   which any signed-in user can read (see PATCH.md L-01) — on first load
 *   the list is migrated to the private doc and the public field deleted.
 *   Honest limit: this only hides the list from casual readers / screens
 *   that subscribe to the public user doc. It does NOT help while the
 *   backend rules let any authenticated user read/write any doc (Round 3
 *   finding) — real enforcement needs server-side rules (see PATCH.md §8).
 * - Owns the secret code (WhatsApp behaviour): the code is NEVER stored
 *   in plaintext or in localStorage. Only a salted SHA-256 hash lives in
 *   the private doc (`codeSalt` + `codeHash`, format `v1$<saltHex>$<hash>`).
 *   The code is compared case-insensitively, trimmed, min 4 chars.
 * - Owns the locked-folder unlock SESSION (in-memory only, never
 *   persisted): `unlockLockedFolder()` after PIN/biometric success,
 *   `lockLockedFolder()` on background / timeout / unmount. The session
 *   lasts LOCKED_FOLDER_SESSION_MS; ChatScreen's route guard consults it.
 * - Sync cache (`refreshLockedCache` / `isLockedPartnerCached`) so
 *   notification / call paths that cannot await a Firestore read can
 *   still redact. Fail-closed is impossible for the very first message
 *   before the cache loads — the cache is refreshed in initPushForUser
 *   (sign-in) and whenever the folder is opened, so the window is small;
 *   the server-side sender must redact as well (see PATCH.md §8).
 */

import { doc, getDoc, setDoc, updateDoc, deleteField, auth, db } from '../aws';
import { getConversationId, cleanId, partnerIdForConversation } from './realtimeSync';

export const LOCKED_PIN_KEY = 'hiddenChatPin';
/** Locked-folder session lifetime after a successful unlock. */
export const LOCKED_FOLDER_SESSION_MS = 15 * 60 * 1000;

/** Generic notification copy — never contains a name or message text. */
export const LOCKED_NOTIFICATION_TITLE = 'Pinglo';
export const LOCKED_NOTIFICATION_BODY = '1 new message';
export const LOCKED_CALL_TITLE = 'Incoming call';
export const LOCKED_CALL_BODY = 'Someone is calling you';

const LOCKED_DOC_ID = 'locked';

// ── In-memory session + cache (never persisted) ──────────────────────────
let folderUnlockedUntil = 0;
let lockedIdsCache = new Set<string>();
let lockedCacheLoadedAt = 0;

// ── Local cache of the locked ids (last known list, this device only) ────
// RC3: the chat list must not render rows until the locked list is known,
// and a timeout must never declare "loaded" with an empty list. Seeding
// the list from the previous session's known ids means the first paint
// already filters locked chats; a fresh device with no cache keeps the
// skeleton until a real load resolves.
const LOCKED_IDS_CACHE_KEY = 'pinglo_locked_ids_v1';

function writeLockedIdsCache(ids: string[]): void {
  try {
    localStorage.setItem(LOCKED_IDS_CACHE_KEY, JSON.stringify({ ids, at: Date.now() }));
  } catch {
    /* private mode / storage full: first paint just waits for the load */
  }
}

/** Last known locked ids from a previous successful load, or null if never loaded. */
export function getCachedHiddenChatIds(): string[] | null {
  try {
    const raw = localStorage.getItem(LOCKED_IDS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ids?: unknown };
    if (!parsed || !Array.isArray(parsed.ids)) return null;
    return parsed.ids.map(String);
  } catch {
    return null;
  }
}

export function unlockLockedFolder(): void {
  folderUnlockedUntil = Date.now() + LOCKED_FOLDER_SESSION_MS;
}

export function lockLockedFolder(): void {
  folderUnlockedUntil = 0;
}

export function isLockedFolderUnlocked(): boolean {
  return Date.now() < folderUnlockedUntil;
}

/** Sync cache of locked partner uids (populated by refreshLockedCache). */
export function isLockedPartnerCached(partnerId: string | null | undefined): boolean {
  if (!partnerId) return false;
  return lockedIdsCache.has(String(partnerId)) || lockedIdsCache.has(cleanId(String(partnerId)));
}

export function lockedPartnerIdsCached(): Set<string> {
  return new Set(lockedIdsCache);
}

/** True when the conversation id belongs to a locked DM (partner in set). */
export function isLockedConversation(
  conversationId: string,
  myUid: string,
  hiddenIds?: Set<string> | string[],
): boolean {
  const set = hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds || lockedIdsCache);
  if (!conversationId || !myUid) return false;
  // DM conversation ids are [uidA, uidB].sort().join('_') (realtimeSync).
  // A locked partner is either side; the saved_ channel is never locked.
  if (String(conversationId).startsWith('saved_')) return false;
  // #236: derive the partner by prefix/suffix — a naive split('_')
  // mis-splits mock uids ('usr_<uuid>'), so a locked mock DM was never
  // recognised as locked. The split check stays as a fallback so no
  // previously-detected id stops being detected.
  const partner = partnerIdForConversation(conversationId, myUid);
  if (partner && (set.has(partner) || set.has(cleanId(partner)))) return true;
  const parts = String(conversationId).split('_');
  return parts.some((p) => set.has(p) || set.has(cleanId(p)));
}

/** Partner uid of a DM conversation id, or null for groups / saved chats. */
export function lockedConversationPartner(conversationId: string, myUid: string): string | null {
  if (!conversationId || String(conversationId).startsWith('saved_')) return null;
  // #236: prefix/suffix derivation — the old split('_') returned 'usr'
  // (a uid fragment) as the partner for mock DM ids. Self-chat ('me_me')
  // returns my own uid; callers that need "someone else" compare against it.
  return partnerIdForConversation(conversationId, myUid);
}

export function lockedConversationIdFor(myUid: string, partnerId: string): string {
  return getConversationId(myUid, partnerId);
}

// ── Storage (private doc, with migration from the public user doc) ──────
const lockedRef = (uid: string) => doc(db, 'users', uid, 'private', LOCKED_DOC_ID);

function currentUid(): string | null {
  return auth.currentUser?.uid ?? null;
}

/**
 * Load the locked-chat ids. Migrates the legacy public
 * `users/{uid}.hiddenChats` array into the private doc once, then deletes
 * the public field so other users' clients stop seeing the list in the
 * user-doc snapshot every screen subscribes to.
 */
export async function loadHiddenChatIds(uid?: string): Promise<string[]> {
  const { ids } = await tryLoadHiddenChatIds(uid);
  return ids;
}

/**
 * Strict loader (RC3/RC4): unlike loadHiddenChatIds, this distinguishes a
 * real load from a failure. `ok` is true only when a Firestore read
 * actually resolved (a missing doc is a real, empty result); `ok` is false
 * when every read failed, so callers must NOT treat `ids` as known and
 * must keep their loading gate up instead of declaring "loaded" with [].
 */
export async function tryLoadHiddenChatIds(uid?: string): Promise<{ ok: boolean; ids: string[] }> {
  const id = uid || currentUid();
  if (!id) return { ok: false, ids: [] };
  try {
    const snap = await getDoc(lockedRef(id));
    if (snap.exists() && Array.isArray((snap.data() as any).hiddenChatIds)) {
      const ids = (snap.data() as any).hiddenChatIds.map(String);
      lockedIdsCache = new Set(ids);
      lockedCacheLoadedAt = Date.now();
      writeLockedIdsCache(ids);
      return { ok: true, ids };
    }
    // Private doc exists but carries no list (e.g. created for the secret
    // code only) — fall through to the legacy read below, exactly like
    // the original loader, so a legacy public list still migrates.
  } catch (err) {
    /* offline / not yet created: fall through to legacy read */
    console.warn("[lockedChats] loadHiddenChatIds: const snap = await getDoc(lockedRef(id)) failed", err);
  }

  // Legacy public field — read once, migrate, delete.
  try {
    const userSnap = await getDoc(doc(db, 'users', id));
    const legacy: string[] = userSnap.exists() ? ((userSnap.data() as any).hiddenChats || []) : [];
    const ids = legacy.map(String);
    if (ids.length > 0) {
      await setDoc(lockedRef(id), { hiddenChatIds: ids, updatedAt: Date.now() }, { merge: true }).catch((err) => console.warn("[lockedChats] loadHiddenChatIds: setDoc(...) failed", err));
      await updateDoc(doc(db, 'users', id), { hiddenChats: deleteField() }).catch((err) => console.warn("[lockedChats] loadHiddenChatIds: updateDoc(...) failed", err));
    }
    lockedIdsCache = new Set(ids);
    lockedCacheLoadedAt = Date.now();
    writeLockedIdsCache(ids);
    return { ok: true, ids };
  } catch {
    return { ok: false, ids: [] };
  }
}

/** Refresh the sync cache (call on sign-in / folder open). Best-effort. */
export async function refreshLockedCache(uid?: string): Promise<void> {
  await loadHiddenChatIds(uid).catch((err) => console.warn("[lockedChats] refreshLockedCache: updateDoc(...) failed", err));
  void lockedCacheLoadedAt;
}

export async function setChatLocked(partnerId: string, locked: boolean, uid?: string): Promise<string[]> {
  const id = uid || currentUid();
  if (!id) throw new Error('Not signed in');
  const current = await loadHiddenChatIds(id);
  const next = locked
    ? Array.from(new Set([...current, String(partnerId)]))
    : current.filter((x) => x !== String(partnerId) && cleanId(x) !== cleanId(partnerId));
  await setDoc(lockedRef(id), { hiddenChatIds: next, updatedAt: Date.now() }, { merge: true });
  // Belt-and-braces: make sure no public copy survives (old builds wrote it).
  await updateDoc(doc(db, 'users', id), { hiddenChats: deleteField() }).catch((err) => console.warn("[lockedChats] setChatLocked: updateDoc(...) failed", err));
  lockedIdsCache = new Set(next);
  writeLockedIdsCache(next);
  return next;
}

// ── Secret code (salted hash only — never plaintext, never localStorage) ─
function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf as ArrayBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

function normalizeCode(code: string): string {
  return (code || '').trim().toLowerCase();
}

/** True when a secret code is set. */
export async function hasSecretCode(uid?: string): Promise<boolean> {
  const id = uid || currentUid();
  if (!id) return false;
  try {
    const snap = await getDoc(lockedRef(id));
    return !!(snap.exists() && (snap.data() as any).codeHash);
  } catch {
    return false;
  }
}

/** Set / change the secret code (min 4 chars). Stores salt + hash only. */
export async function setSecretCode(code: string, uid?: string): Promise<void> {
  const id = uid || currentUid();
  if (!id) throw new Error('Not signed in');
  const clean = normalizeCode(code);
  if (clean.length < 4) throw new Error('Secret code must be at least 4 characters');
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltHex = toHex(salt);
  const hash = await sha256Hex(`${saltHex}:${clean}`);
  await setDoc(
    lockedRef(id),
    { codeSalt: saltHex, codeHash: `v1$${saltHex}$${hash}`, updatedAt: Date.now() },
    { merge: true },
  );
}

export async function clearSecretCode(uid?: string): Promise<void> {
  const id = uid || currentUid();
  if (!id) throw new Error('Not signed in');
  await updateDoc(lockedRef(id), { codeSalt: deleteField(), codeHash: deleteField() }).catch((err) => console.warn("[lockedChats] clearSecretCode: updateDoc(...) failed", err));
}

/** Constant-time-ish comparison against the stored hash. Returns false when no code is set. */
export async function verifySecretCode(code: string, uid?: string): Promise<boolean> {
  const id = uid || currentUid();
  if (!id) return false;
  const clean = normalizeCode(code);
  if (clean.length < 4) return false;
  try {
    const snap = await getDoc(lockedRef(id));
    if (!snap.exists()) return false;
    const data = snap.data() as any;
    const stored: string | undefined = data.codeHash;
    if (!stored || !stored.startsWith('v1$')) return false;
    const [, saltHex, expected] = stored.split('$');
    const actual = await sha256Hex(`${saltHex}:${clean}`);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
