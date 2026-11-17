/**
 * Admin Service for Pinglo
 * 
 * Privileged administrative operations for authorized administrators.
 * Admin access is configured via the VITE_ADMIN_EMAILS
 * environment variable (comma-separated list). No admin
 * addresses are hardcoded in this file.
 */

import { doc, getDoc, db, isAwsConfigured } from '../aws';
import { generateClient } from 'aws-amplify/api';
import { partnerIdForConversation, cleanId } from './realtimeSync';

/* Admin email list, driven by the VITE_ADMIN_EMAILS environment
   variable (comma-separated). Empty or unset = no admin users. */
export const ADMIN_EMAILS: string[] = String(
  (import.meta as any).env?.VITE_ADMIN_EMAILS || '',
)
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export const isAdminUser = (user: any): boolean => {
  if (!user) return false;
  const email = (user.email || '').trim().toLowerCase();
  return ADMIN_EMAILS.includes(email);
};

export interface AdminConversation {
  id: string;
  userA: { uid: string; name: string; avatar: string; email?: string };
  userB: { uid: string; name: string; avatar: string; email?: string };
  isCommunity: boolean;
  communityName?: string;
  messageCount: number;
  lastMessage?: string;
  lastTimestamp?: number;
}

export interface AdminCallRecord {
  id: string;
  callerId: string;
  callerName: string;
  callerAvatar?: string;
  receiverId: string;
  receiverName: string;
  receiverAvatar?: string;
  type: 'audio' | 'video';
  status: string;
  timestamp: any;
}

export interface AdminUserRecord {
  id: string;
  uid: string;
  displayName: string;
  username: string;
  email: string;
  photoURL?: string;
  online?: boolean;
  status?: string;
  lastSeen?: number;
}

const fallbackUser = (uid: string): AdminUserRecord => ({
  id: uid,
  uid,
  displayName: uid.substring(0, 8),
  username: '',
  email: '',
  photoURL: '',
});

// ── AUDIT-2 C6: count-only / last-message-only dashboard summaries ──────
// Before, getActiveConversations() awaited db.ensure() for EVERY channel's
// full message history one by one, then read the whole array — only the
// count and the last message were ever used. A channel with 10,000
// messages cost a 10,000-doc download + decrypt + IndexedDB persist +
// one AppSync subscription, per channel, sequentially.
// Now a channel summary never fetches a full history on AWS:
//   1. Already-loaded collections: count + last straight from the cache
//      (no new fetch at all).
//   2. Otherwise (AWS): one listDocs with an id+updatedAt-only selection
//      set — the `data` payload (message bodies/ciphertext) is never
//      transferred — paginated to an exact count, plus a single getDoc for
//      the newest message. At most 5 channel summaries run at once.
//   3. Local/mock mode has no server to ask, so it reads the local
//      IndexedDB cache (a local read — no network, no subscription).
// Two honest limits (see phase2/PATCH-2C.md):
//   a. The id-only listing cannot tell E2EE key-exchange protocol docs
//      (type 'e2ee-key-exchange') from real messages — both share the
//      msg_<ts>_<rand> id shape — so the AWS-path count includes them
//      (typically +2 per DM; legacy flood chats carry ~200). The cached
//      path stays exact (it filters them, as before). The last message is
//      exact: the newest few docs are fetched and protocol docs skipped.
//   b. listDocs still scans the channel server-side (DynamoDB read units
//      are unchanged); what drops to ~zero is the bytes transferred, the
//      per-message decrypt, the IndexedDB persist and the subscription.
//      A true server-side count needs a backend change — a per-channel
//      metadata doc or a countDocs query (BACKEND-PLAN.md §16 follow-up).
// The lightweight queries mirror database.ts's LIST_DOCS / GET_DOC (same
// operation, same resolvers/auth) with a smaller selection set. The
// durable home for this is a db.getCollectionSummary() helper in
// database.ts — recorded in PATCH-2C.md for the coordinator; this file
// must not grow its own copy of the data layer beyond this stopgap.
/** Max channel summaries in flight at once (old code: 1, sequential). */
const ADMIN_SUMMARY_CONCURRENCY = 5;
/** How many newest docs to inspect when picking the last real message. */
const ADMIN_LAST_MESSAGE_WINDOW = 5;
/** Doc id that can never exist; used only to ask readCached() whether a
 *  collection is already loaded (undefined = never loaded). */
const LOADED_PROBE_ID = '__audit2c_loaded_probe__';

let _adminClient: any = null;
const adminGql = (): any => {
  if (!_adminClient) _adminClient = generateClient();
  return _adminClient;
};

const LIST_IDS = `query ListDocs($col: String!, $limit: Int, $nextToken: String) {
  listDocs(col: $col, limit: $limit, nextToken: $nextToken) {
    items { id updatedAt }
    nextToken
  }
}`;

const GET_ONE = `query GetDoc($col: String!, $id: ID!) {
  getDoc(col: $col, id: $id) { col id data updatedAt }
}`;

interface ChannelSummary {
  count: number;
  last?: { text: string; timestamp?: number };
}

function lastFromDoc(data: any): { text: string; timestamp?: number } | undefined {
  if (!data || data.type === 'e2ee-key-exchange') return undefined;
  return { text: data.text || (data.mediaType ? `[${data.mediaType}]` : ''), timestamp: data.timestamp };
}

/**
 * Lightweight summary (AWS path): exact count from an id+updatedAt-only
 * listing (no `data` payload transferred) + the newest real message via
 * at most ADMIN_LAST_MESSAGE_WINDOW single-doc reads. Never ensures,
 * subscribes, decrypts or persists the channel's history.
 */
async function fetchChannelSummaryLight(cid: string): Promise<ChannelSummary> {
  const col = `chats/${cid}/messages`;
  const ids: { id: string; updatedAt: any }[] = [];
  let nextToken: string | null = null;
  do {
    const res: any = await adminGql().graphql({
      query: LIST_IDS,
      variables: { col, limit: 500, nextToken },
    });
    const page = res?.data?.listDocs;
    for (const item of page?.items || []) {
      if (item?.id) ids.push({ id: item.id, updatedAt: item.updatedAt });
    }
    nextToken = page?.nextToken || null;
  } while (nextToken);
  // Newest first by server revision; inspect a small window and keep the
  // newest REAL message by its own timestamp (the newest doc can be a
  // key-exchange protocol doc, and an edited old message can carry a
  // newer updatedAt than the latest message).
  const newest = [...ids]
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, ADMIN_LAST_MESSAGE_WINDOW);
  let last: { text: string; timestamp?: number } | undefined;
  for (const cand of newest) {
    try {
      const res: any = await adminGql().graphql({ query: GET_ONE, variables: { col, id: cand.id } });
      const raw = res?.data?.getDoc?.data;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const parsed = lastFromDoc(data);
      if (!parsed) continue;
      if (!last || (Number(parsed.timestamp) || 0) > (Number(last.timestamp) || 0)) last = parsed;
    } catch {
      // One unreadable doc must not sink the channel summary.
    }
  }
  return { count: ids.length, last };
}

/**
 * Full-load summary (local/mock path, and AWS fallback when the
 * lightweight query fails): the old behaviour — ensure the whole
 * collection, count + last from the cache. Exact (protocol docs are
 * filtered by getCollectionDocs), but a full-history download.
 */
async function fetchChannelSummaryFull(cid: string): Promise<ChannelSummary> {
  const col = `chats/${cid}/messages`;
  await db.ensure(col);
  const messages = db.getCollectionDocs(col);
  const sorted = [...messages].sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
  const m = sorted[0];
  return { count: messages.length, last: m ? lastFromDoc(m) : undefined };
}

export class AdminService {
  /**
   * Retrieves all active conversation channels and their participants.
   * C6: per channel only the message COUNT and the LAST message are
   * needed, so no channel's full history is fetched (see the header
   * comment above fetchChannelSummaryLight for the paths and limits).
   */
  public async getActiveConversations(): Promise<AdminConversation[]> {
    // Wait for the shared collections to load before reading them from the cache
    await Promise.all([db.ensure('users'), db.ensure('chats')]);
    const channels = db.getAllChatChannels();
    const usersMap = new Map<string, AdminUserRecord>();

    // Load users for reference
    const usersDocs = db.getCollectionDocs('users');
    usersDocs.forEach((u: any) => {
      usersMap.set(u.id, {
        id: u.id,
        uid: u.uid || u.id,
        displayName: u.displayName || u.username || 'User',
        username: u.username || '',
        email: u.email || '',
        photoURL: u.photoURL || '',
      });
    });

    const results: AdminConversation[] = [];

    // Bounded concurrency (was: sequential await per channel). Each
    // channel costs a count-only listing + ≤5 single-doc reads on AWS,
    // or a cache read when already loaded — never a full history.
    for (let i = 0; i < channels.length; i += ADMIN_SUMMARY_CONCURRENCY) {
      const chunk = channels.slice(i, i + ADMIN_SUMMARY_CONCURRENCY);
      const settled = await Promise.all(
        chunk.map((cid) => this.summarizeChannel(cid, usersMap)),
      );
      for (const conv of settled) {
        if (conv) results.push(conv);
      }
    }

    return results.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
  }

  /**
   * One channel's dashboard row: count + last message only, from the
   * cheapest source available (loaded cache → lightweight AWS summary →
   * full load as a fallback). Returns null for channel ids that are
   * neither a community nor a uid_uid DM (same skip rule as before).
   */
  private async summarizeChannel(
    cid: string,
    usersMap: Map<string, AdminUserRecord>,
  ): Promise<AdminConversation | null> {
    const col = `chats/${cid}/messages`;
    let summary: ChannelSummary;
    if (db.readCached(col, LOADED_PROBE_ID) !== undefined) {
      // Already in memory (e.g. an open chat): exact count + last from the
      // cache — no new fetch at all, and protocol docs stay filtered.
      const messages = db.getCollectionDocs(col);
      const sorted = [...messages].sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
      const m = sorted[0];
      summary = { count: messages.length, last: m ? lastFromDoc(m) : undefined };
    } else if (isAwsConfigured()) {
      try {
        summary = await fetchChannelSummaryLight(cid);
      } catch (e) {
        // The dashboard must never go blank because the lightweight query
        // was rejected — fall back to the old full load for this channel.
        console.warn(`Admin dashboard: lightweight summary failed for "${cid}", falling back to full load:`, e);
        summary = await fetchChannelSummaryFull(cid);
      }
    } else {
      // Local/mock mode has no server to ask — the cache restore below is
      // a local IndexedDB read (no network, no subscription).
      summary = await fetchChannelSummaryFull(cid);
    }
    const { count: messageCount, last } = summary;

    if (cid.startsWith('comm_')) {
      // Community conversation
      const commSnap = await getDoc(doc(db, 'communities', cid));
      const commData = commSnap.exists() ? commSnap.data() : {};
      return {
        id: cid,
        userA: { uid: 'community', name: commData.name || 'Community', avatar: commData.avatar || '' },
        userB: { uid: 'members', name: `${commData.memberCount || 0} members`, avatar: '' },
        isCommunity: true,
        communityName: commData.name || 'Community',
        messageCount,
        lastMessage: last?.text || '',
        lastTimestamp: last?.timestamp,
      };
    }
    if (cid.includes('_')) {
      // Direct conversation (uid_uid) — derive the two sides with the
      // shared prefix/suffix helper (#236): a naive split('_') mis-splits
      // mock uids ('usr_<uuid>'), yielding 'usr' / uuid fragments as the
      // two "users". Try each known user as one side; fall back to the old
      // split only when neither side is a known user (deleted users).
      let uidA: string | null = null;
      let uidB: string | null = null;
      for (const key of usersMap.keys()) {
        const other = partnerIdForConversation(cid, key);
        if (other) { uidA = key; uidB = other; break; }
      }
      if (!uidA || !uidB) {
        const [a, b] = cid.split('_');
        uidA = a; uidB = b;
      }
      const userA = usersMap.get(uidA) || fallbackUser(uidA);
      const userB = [...usersMap.values()].find((u) => cleanId(u.id) === cleanId(uidB as string)) || fallbackUser(uidB);
      return {
        id: cid,
        userA: { uid: uidA, name: userA.displayName, avatar: userA.photoURL || '', email: userA.email },
        userB: { uid: uidB, name: userB.displayName, avatar: userB.photoURL || '', email: userB.email },
        isCommunity: false,
        messageCount,
        lastMessage: last?.text || '',
        lastTimestamp: last?.timestamp,
      };
    }
    return null;
  }
}

export const adminService = new AdminService();
