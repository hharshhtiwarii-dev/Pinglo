/**
 * Master-gaps: saved contacts.
 *
 * A saved contact is either a registered Pinglo user (has `uid` — tap
 * opens the DM) or a manual name+phone entry (no `uid` — honestly marked
 * "Not on Pinglo"). There is no phone contact sync: reading the phone's
 * address book needs a native plugin + permission flow that is not wired
 * up, so manual add is the honest stand-in.
 *
 * Storage: `users/{uid}.contacts` on the user doc (array of
 * { uid?, name, phone?, addedAt }), mirrored to localStorage
 * (`pinglo_contacts_<uid>`) so the list still works offline / when the
 * doc write has not landed yet. The local copy is the fallback, never the
 * source of truth when the doc has a list.
 */

import { db, doc, getDoc, updateDoc, collection, query, where, onSnapshot } from '../aws';
import { cleanId, getConversationId } from './realtimeSync';

export interface SavedContact {
  /** Registered Pinglo user id. Absent for manual name+phone entries. */
  uid?: string;
  /** Display name / nickname shown in the list. */
  name: string;
  phone?: string;
  addedAt: number;
}

const storageKey = (uid: string) => `pinglo_contacts_${uid}`;

function readLocal(uid: string): SavedContact[] {
  try {
    const raw = localStorage.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c: any) => c && typeof c.name === 'string' && c.name.trim()
    ) as SavedContact[];
  } catch {
    return [];
  }
}

function writeLocal(uid: string, contacts: SavedContact[]): void {
  try {
    localStorage.setItem(storageKey(uid), JSON.stringify(contacts));
  } catch { /* intentionally ignored */}
}

/** Synchronous read: the user doc from the db cache, else the local mirror.
 * NOTE: this only ever picks out the signed-in user's OWN doc from the
 * cache — it never enumerates or returns other users. */
export function loadSavedContactsCached(uid: string): SavedContact[] {
  try {
    const docs: any[] = db.getCollectionDocs('users') || [];
    const me = docs.find((d) => d.id === uid);
    if (me && Array.isArray(me.contacts)) return me.contacts as SavedContact[];
  } catch { /* intentionally ignored */}
  return readLocal(uid);
}

/** One-shot read: the live user doc first, local mirror as fallback.
 * Warm cache first: in mock / offline mode the network getDoc below fails
 * even though the doc is already in the local cache — returning the
 * (empty) local mirror then would wipe a warm saved list. The screens'
 * live own-doc subscription corrects any staleness right after. */
export async function loadSavedContacts(uid: string): Promise<SavedContact[]> {
  const cached = loadSavedContactsCached(uid);
  if (cached.length > 0) return cached;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) {
      const data = snap.data() as any;
      if (Array.isArray(data.contacts)) {
        writeLocal(uid, data.contacts as SavedContact[]);
        return data.contacts as SavedContact[];
      }
    }
  } catch { /* intentionally ignored */}
  return readLocal(uid);
}

/**
 * Persist the list: local mirror always, user doc best-effort (a failed
 * doc write — offline, permissions — leaves the local copy, which the
 * next successful load overwrites from the doc only when the doc HAS a
 * list; an offline add therefore survives locally until it can sync).
 */
export async function saveSavedContacts(uid: string, contacts: SavedContact[]): Promise<void> {
  writeLocal(uid, contacts);
  try {
    await updateDoc(doc(db, 'users', uid), { contacts });
  } catch (e) {
    console.warn('Could not save contacts to your profile (kept on this device):', e);
  }
}

export function isContactSaved(contacts: SavedContact[], uid: string): boolean {
  return contacts.some((c) => c.uid === uid);
}

/** Public profile fields a username search is allowed to show. Email is
 * deliberately NOT part of this shape: a stranger who guesses a username
 * must not learn the person's email address from the search result. */
export interface PublicUserProfile {
  id: string;
  displayName?: string;
  username?: string;
  bio?: string;
  photoURL?: string;
  online?: boolean;
  lastSeen?: number;
}

function toPublicProfile(id: string, data: any): PublicUserProfile {
  return {
    id,
    displayName: data?.displayName || undefined,
    username: data?.username || undefined,
    bio: data?.bio || undefined,
    photoURL: data?.photoURL || undefined,
    online: typeof data?.online === 'boolean' ? data.online : undefined,
    lastSeen: typeof data?.lastSeen === 'number' ? data.lastSeen : undefined,
  };
}

/** Normalize a typed username: a leading @ is optional, matching is lowercase. */
export function normalizeUsername(raw: string): string {
  return (raw || '').trim().replace(/^@+/, '').toLowerCase();
}

/**
 * Targeted one-shot profile read: users/<uid> by id. Used to enrich the
 * user's OWN saved contacts (avatar / @username / bio) and to show the
 * signed-in user's own username, without subscribing to — or listing —
 * the whole users collection.
 *
 * Implemented as a one-shot doc subscription (not getDoc): a plain getDoc
 * goes to the network when the collection has not loaded yet, which fails
 * in mock / offline mode even though the doc sits in the local IndexedDB
 * cache. The subscription triggers the cache restore and delivers the doc
 * when it lands; an empty first snapshot is NOT trusted (grace period).
 */
export function fetchUserProfile(uid: string): Promise<PublicUserProfile | null> {
  if (!uid) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | null = null;
    const finish = (p: PublicUserProfile | null) => {
      if (done) return;
      done = true;
      try { unsub?.(); } catch { /* intentionally ignored */}
      resolve(p);
    };
    const graceTimer = setTimeout(() => finish(null), 2500);
    const hardTimer = setTimeout(() => finish(null), 8000);
    try {
      unsub = onSnapshot(doc(db, 'users', uid), (snap: any) => {
        if (done) return;
        if (snap?.exists?.()) {
          clearTimeout(graceTimer);
          clearTimeout(hardTimer);
          finish(toPublicProfile(uid, snap.data() as any));
        }
        // Doc not in the snapshot yet: keep waiting — the local cache
        // restore / first fetch may still be landing.
      });
    } catch {
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      finish(null);
    }
  });
}

/**
 * Find people by exact username — the only discovery query the app makes.
 *
 * How it works: a one-shot filtered subscription,
 * `query(users, where('username', '==', normalized))`, resolves on the
 * first snapshot that carries a match and unsubscribes immediately, so the
 * UI layer never holds the full users list. The username equality is
 * re-checked client-side too (same idiom as the Settings username
 * availability check) so the result stays correct even if the backend
 * ignores the filter.
 *
 * HONEST LIMITS (see also phone-issues PATCH-B):
 * - Exact match only. There is no prefix / beginsWith operator in the
 *   data layer (`where` supports ==, !=, in; filters are applied
 *   client-side over a whole-collection listDocs — see database.ts
 *   `applyFilters`/`fetchAll`), so a true server-side prefix search is
 *   impossible from this client. Prefix matching is offered only over
 *   the user's OWN saved contacts (their own data) in UserSearchScreen.
 *   Real prefix search needs a backend username index (e.g. an AppSync
 *   query with beginsWith on a username GSI, or a
 *   `usernames/<lowercase>` lookup collection).
 * - Until the backend adds a resolver rule for the users collection,
 *   the filtered query still fetches the whole collection over the wire
 *   (listDocs) and filters locally — the app never *shows* or *holds*
 *   the dump, but the wire-level exposure remains. That is a backend
 *   gap, not something client code can close.
 * - The first snapshot can be empty while the local cache is still being
 *   restored, so an empty result is only trusted after a short grace
 *   period (EMPTY_GRACE_MS); a snapshot that never arrives at all
 *   resolves 'unknown' (offline / backend unreachable) after TIMEOUT_MS.
 */
export type UsernameLookupResult =
  | { status: 'ok'; users: PublicUserProfile[] }
  | { status: 'unknown'; users: [] };

const EMPTY_GRACE_MS = 2500;
const LOOKUP_TIMEOUT_MS = 8000;

export function lookupUsersByUsername(rawQuery: string, excludeUid?: string): Promise<UsernameLookupResult> {
  const username = normalizeUsername(rawQuery);
  return new Promise((resolve) => {
    if (!username) {
      resolve({ status: 'ok', users: [] });
      return;
    }
    let done = false;
    let unsub: (() => void) | null = null;
    let sawSnapshot = false;
    const finish = (result: UsernameLookupResult) => {
      if (done) return;
      done = true;
      try { unsub?.(); } catch { /* intentionally ignored */}
      resolve(result);
    };
    // No match after the grace period = genuinely not found (the local
    // cache restore / first fetch has had time to land by then).
    const graceTimer = setTimeout(() => finish({ status: 'ok', users: [] }), EMPTY_GRACE_MS);
    const hardTimer = setTimeout(() => {
      clearTimeout(graceTimer);
      finish(sawSnapshot ? { status: 'ok', users: [] } : { status: 'unknown', users: [] });
    }, LOOKUP_TIMEOUT_MS);
    try {
      unsub = onSnapshot(
        query(collection(db, 'users'), where('username', '==', username)),
        (snap: any) => {
          if (done) return;
          sawSnapshot = true;
          const matches: PublicUserProfile[] = (snap?.docs || [])
            .map((d: any) => ({ id: d.id, ...(d.data?.() || {}) }))
            .filter(
              (u: any) =>
                u.id &&
                u.id !== excludeUid &&
                String(u.username || '').toLowerCase() === username &&
                (u.displayName || u.username)
            )
            .map((u: any) => toPublicProfile(String(u.id), u));
          if (matches.length > 0) {
            clearTimeout(graceTimer);
            clearTimeout(hardTimer);
            finish({ status: 'ok', users: matches });
          }
          // No match yet: keep waiting until the grace timer fires — the
          // first snapshot may have arrived before the cache restore.
        }
      );
    } catch {
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      finish({ status: 'unknown', users: [] });
    }
  });
}

/**
 * Prefix match over the user's OWN saved contacts only (display name /
 * username). This is the only prefix search the app does: the candidates
 * are data the user already owns, never a dump of all registered users.
 * Profiles come from fetchUserProfile, keyed by contact uid.
 */
export function searchSavedContactsByPrefix(
  q: string,
  saved: SavedContact[],
  profilesByUid: Map<string, PublicUserProfile>
): { contact: SavedContact; profile: PublicUserProfile | null }[] {
  // Worker B (overnight round 2, #8): strip a leading @ the same way
  // lookupUsersByUsername does (normalizeUsername). The old needle kept
  // the @, so "@demo_user7" never matched a saved contact whose username
  // is "demo_user7" — the UI invites users to "Search by name or
  // @username", and the exact-username path already stripped it, so the
  // saved-contacts path disagreed with it.
  const needle = normalizeUsername(q);
  if (needle.length < 2) return [];
  return saved
    .map((contact) => ({
      contact,
      profile: contact.uid ? profilesByUid.get(contact.uid) || null : null,
    }))
    .filter(({ contact, profile }) => {
      const hay = [
        contact.name,
        profile?.displayName || '',
        profile?.username || '',
      ].map((s) => s.toLowerCase());
      return hay.some((s) => s.startsWith(needle) || s.includes(needle));
    });
}

/** The signed-in user's blocked ids (same `blockedUsers` field the
 * BlockedContactsScreen reads) — contacts never surface blocked people.
 * NOTE: like loadSavedContactsCached, this only reads the signed-in
 * user's OWN doc out of the cache; it never enumerates other users. */
export function loadBlockedIdsCached(uid: string): string[] {
  try {
    const docs: any[] = db.getCollectionDocs('users') || [];
    const me = docs.find((d) => d.id === uid);
    const list = (me?.blockedUsers ?? me?.blocked) as unknown;
    const ids = Array.isArray(list) ? list.map(String) : [];
    // WA audit #9 — write-through to the localStorage mirror (below):
    // whenever the cached doc IS available, the mirror heals to match
    // it, so a block made on any path is reflected at ring time.
    if (ids.length > 0) setBlockedIdsLocal(uid, ids);
    return ids;
  } catch {
    return [];
  }
}

/**
 * WA audit #9 — localStorage mirror of MY OWN blocked list
 * (`dt_blocked_<uid>`), written at every block/unblock site and
 * refreshed by loadBlockedIdsCached above. The call service reads it
 * because the users collection is loaded lazily: `getCollectionDocs`
 * kicks off an async restore but returns the CURRENT in-memory map
 * synchronously, so at cold boot — exactly when an incoming call can
 * arrive before any screen has loaded `users` — the cached read sees
 * [] and a blocked caller would ring. The mirror is always available
 * (same pattern as the known-convs memo), so the ring-time check never
 * depends on collection load order. Single-device only (multi-device
 * is design-only), so the mirror cannot go stale cross-device; the
 * only writers are the block/unblock sites in this app, which always
 * write both the doc and the mirror together.
 */
export function getBlockedIdsLocal(uid: string): string[] {
  if (!uid) return [];
  try {
    const raw = localStorage.getItem(`dt_blocked_${uid}`);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

export function setBlockedIdsLocal(uid: string, ids: string[]): void {
  if (!uid) return;
  try {
    localStorage.setItem(`dt_blocked_${uid}`, JSON.stringify([...new Set(ids.map(String))]));
  } catch {
    // Storage full/blocked: the doc read still applies; the mirror is best-effort.
  }
}

/* ── W28: the gated contact universe (REPORT-3 follow-up) ─────────────
 *
 * The Nov 14 phone-issues fix gated Contacts + the chat list with
 * hasConversation(), but Calls, Status, Broadcast, Admin and ChatScreen's
 * forward picker still subscribed to the WHOLE `users` collection
 * (`where('uid', '!=', me)`) and rendered every registered user in their
 * pickers. These helpers are the single gate every picker screen now
 * uses instead:
 *
 *   Allowed = saved registered contacts (users/{me}.contacts with a uid)
 *           + proven DM partners (a real message exchanged — same proof
 *             ChatListScreen's hasConversation() uses: the conversation
 *             id is in the known-convs memo, or its messages collection
 *             holds ≥1 real message in the local cache).
 *
 * Profiles are then enriched with TARGETED single-doc reads
 * (`getDoc(doc(db, 'users', uid))`) — one per allowed uid, never a
 * collection query. Blocked users are excluded.
 *
 * HONEST LIMITS (same position as the Nov 14 fix / PATCH-B):
 * - Client-side gating only. ChatListScreen still subscribes to the whole
 *   `users` collection to feed the local cache (partner names / photos /
 *   presence), so the wire-level exposure remains until the backend
 *   ships the users minimal-profile projection + resolver rule
 *   (BACKEND-PLAN.md). What this closes: no picker screen subscribes to,
 *   holds, or renders the full user list anymore, and no new screen can
 *   do so by copying the old query — the gate is the one helper.
 * - Live updates: the old whole-collection onSnapshot pushed name/avatar
 *   changes live. The gated load is one-shot per trigger (mount + chats
 *   collection change + saved-contacts change); a contact renaming
 *   themselves refreshes on the next trigger, not instantly.
 * - A stranger you have never messaged and never saved cannot be called,
 *   broadcast to, or excluded from status — find them by exact username
 *   (/search) and message them first, exactly like WhatsApp requires a
 *   contact before calling. */
export function partnerUidFromConversationId(convId: string, myUid: string): string | null {
  const cid = cleanId(convId);
  const me = cleanId(myUid);
  if (!cid || !me || cid.startsWith('saved_')) return null;
  // DM ids are getConversationId(a, b) = sorted [cleanA, cleanB].join('_'),
  // so my cleaned uid is either the prefix or the suffix of the id.
  if (cid.startsWith(me + '_')) return cid.slice(me.length + 1);
  if (cid.endsWith('_' + me)) return cid.slice(0, cid.length - me.length - 1);
  return null;
}

/**
 * Window event fired when ChatListScreen's background discovery memos a
 * newly-proven conversation (see markKnownConv). The gated pickers load
 * contacts once on mount and refresh on chats-collection changes — but the
 * memo is a localStorage write, which fires neither. Screens that render
 * gated contact lists listen for this and re-run their load, so a partner
 * discovered after mount appears without a chats change or remount.
 */
export const KNOWN_CONVS_CHANGED_EVENT = 'pinglo:known-convs-changed';

/** Uids this user is allowed to see in pickers. Sync, cache-only, no I/O. */
export function getAllowedContactUids(myUid: string): string[] {
  const me = (myUid || '').trim();
  if (!me) return [];
  const allowed = new Set<string>();
  // 1. Saved registered contacts (explicitly added by the user).
  try {
    for (const c of loadSavedContactsCached(me)) {
      if (c.uid && c.uid !== me) allowed.add(c.uid);
    }
  } catch { /* intentionally ignored */}
  // 2. Proven DM conversations.
  const convIds = new Set<string>();
  const memoIds = new Set<string>();
  try {
    const memo = JSON.parse(localStorage.getItem(`pinglo_known_convs_${me}`) || '[]');
    if (Array.isArray(memo)) {
      for (const id of memo) {
        if (typeof id === 'string' && id) { memoIds.add(id); convIds.add(id); }
      }
    }
  } catch { /* intentionally ignored */}
  try {
    for (const id of db.getAllChatChannels()) {
      if (typeof id === 'string' && id) convIds.add(id);
    }
  } catch { /* intentionally ignored */}
  for (const cid of convIds) {
    const peer = partnerUidFromConversationId(cid, me);
    if (!peer || peer === me || allowed.has(peer)) continue;
    // Memo membership IS the proof (ChatListScreen only memos convs with
    // ≥1 message). A channel-derived id needs the live-cache proof.
    if (memoIds.has(cid)) { allowed.add(peer); continue; }
    try {
      const msgs = db.getCollectionDocs(`chats/${cid}/messages`);
      if ((msgs?.length || 0) > 0) allowed.add(peer);
    } catch { /* intentionally ignored */}
  }
  // 3. DM chat docs in the local cache whose messages collection holds ≥1
  // real message (covers conversations the memo/channels missed).
  try {
    for (const doc of db.getCollectionDocs('chats') || []) {
      if (!doc || doc.isGroup) continue;
      const peer = doc.uid || doc.id;
      if (!peer || peer === me || allowed.has(peer)) continue;
      const convId = getConversationId(me, peer);
      const msgs = db.getCollectionDocs(`chats/${convId}/messages`);
      if ((msgs?.length || 0) > 0) allowed.add(peer);
    }
  } catch { /* intentionally ignored */}
  return [...allowed];
}

/** The other side of the user's own call records (caller ↔ receiver). */
export function getCallPartnerUids(myUid: string, calls: any[]): string[] {
  const me = (myUid || '').trim();
  const out = new Set<string>();
  if (!me || !Array.isArray(calls)) return [];
  for (const c of calls) {
    if (!c) continue;
    if (c.callerId === me && c.receiverId && c.receiverId !== me) out.add(c.receiverId);
    else if (c.receiverId === me && c.callerId && c.callerId !== me) out.add(c.callerId);
  }
  return [...out];
}

/**
 * Shared chunked profile fetch: one getDoc per uid, 10 at a time.
 * `uids` is the caller-supplied allow-list — nothing here ever reads the
 * whole users collection. Blocked users + self are excluded. Also reports
 * the uids whose profile doc did not resolve, so callers can decide
 * whether a load "latched" (100M-C1).
 */
async function fetchUserProfilesDetailed(uids: string[], blocked: Set<string>, me: string): Promise<{ list: any[]; unresolvedUids: string[] }> {
  const wanted = [...new Set(uids.filter(Boolean))]
    .filter((u) => u && u !== me && !blocked.has(u));
  const out: any[] = [];
  const unresolvedUids: string[] = [];
  for (let i = 0; i < wanted.length; i += 10) {
    const chunk = wanted.slice(i, i + 10);
    const results = await Promise.all(chunk.map(async (uid) => {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap?.exists?.()) {
          const data = snap.data() as any;
          return { id: snap.id, uid, ...data };
        }
      } catch { /* offline / deleted user: skip silently */ }
      return null;
    }));
    for (let j = 0; j < chunk.length; j++) {
      if (results[j]) out.push(results[j]);
      else unresolvedUids.push(chunk[j]);
    }
  }
  return { list: out, unresolvedUids };
}

/** List-only variant of the shared chunked fetch. */
async function fetchUserProfiles(uids: string[], blocked: Set<string>, me: string): Promise<any[]> {
  const { list } = await fetchUserProfilesDetailed(uids, blocked, me);
  return list;
}

/**
 * Load enriched profiles for the gated universe via targeted single-doc
 * reads (batched 10 at a time). `extraUids` lets a screen resolve people
 * the user already chose (e.g. existing broadcast-list members) without
 * widening the picker. Blocked users are never returned.
 *
 * Detailed variant: also reports the uids whose profile doc did not
 * resolve (not yet synced / deleted user). Callers use it to decide
 * whether the load "latched": a partial load must NOT be treated as
 * complete, or a partner whose profile arrives after the first load
 * stays invisible until remount (100M-C1).
 */
export async function loadGatedContactsDetailed(myUid: string, extraUids: string[] = []): Promise<{ list: any[]; unresolvedUids: string[] }> {
  const me = (myUid || '').trim();
  if (!me) return { list: [], unresolvedUids: [] };
  const blocked = new Set(loadBlockedIdsCached(me));
  return fetchUserProfilesDetailed([...getAllowedContactUids(me), ...extraUids.filter(Boolean)], blocked, me);
}

export async function loadGatedContacts(myUid: string, extraUids: string[] = []): Promise<any[]> {
  const { list } = await loadGatedContactsDetailed(myUid, extraUids);
  return list;
}

/**
 * W27c (100M-C2): public profiles for an EXPLICIT uid list only — the
 * current group's members, taken from the group doc I already belong to.
 * No whole-users read, so the all-users leak W28 closed stays closed;
 * blocked users + me are excluded like everywhere else. The caller must
 * only pass uids the user is entitled to see (group members of a group
 * they belong to); this helper does no entitlement check of its own.
 */
export async function fetchMemberProfiles(myUid: string, uids: string[]): Promise<any[]> {
  const me = (myUid || '').trim();
  if (!me) return [];
  return fetchUserProfiles(uids, new Set(loadBlockedIdsCached(me)), me);
}
