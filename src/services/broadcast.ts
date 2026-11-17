/**
 * Broadcast lists (Phase 4, Agent B).
 *
 * A broadcast list is a named set of recipients. Sending a broadcast does
 * NOT create a group chat: the message is delivered as a separate 1:1 DM to
 * each recipient, exactly like sending the same text by hand in each DM.
 *
 * DM send path (reused, not re-implemented): the same two calls
 * ChatScreen.handleSend makes for a 1:1 text message —
 *   addDoc(collection(db, 'chats', getConversationId(myUid, recipientId), 'messages'),
 *     { text, senderId, senderName, senderAvatar, timestamp: serverTimestamp(), status: 'sent' })
 *   realtimeSync.sendMessage(recipientId, { conversationId, senderId, senderName,
 *     senderAvatar, text, timestamp: Date.now() })
 * `getConversationId` comes from services/realtimeSync (deterministic DM id,
 * same one ChatScreen / ChatListScreen use). No file in another worker's
 * ownership is edited to do this; broadcast.ts only calls those shared
 * helpers.
 *
 * Storage (no new collection, same pattern as archiveFolders Feature 5):
 *   users/{uid}.broadcastLists = BroadcastList[]
 * with a localStorage fallback `pinglo:broadcastLists:<uid>` (same hybrid
 * pattern ChatListScreen.savePref uses): a Firestore write that fails keeps
 * the list locally instead of losing it, and the local copy is merged under
 * the server value on load.
 *
 * Honest limits: sending is per-recipient and best-effort — the result
 * reports exactly which recipients got the message and which failed, and a
 * failed recipient is never reported as sent. Recipients whose E2EE is not
 * set up yet are reported separately as `pendingSetup` (W18b, P0-8): the
 * send fails closed, nothing is sent as plaintext, and the sender retries
 * once the peer's app has acked the key-announce this send triggers.
 * There is no delivery/read tracking beyond the normal per-DM `status: 'sent'` field. Blocked users
 * are skipped (never sent to): the sender's `users/{uid}.blockedUsers` list is
 * read the same way ChatScreen reads it, and a blocked recipient is
 * reported as skipped, not failed.
 */

import {
  collection,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  serverTimestamp,
  auth,
  db,
} from '../aws';
import { getConversationId, realtimeSync } from './realtimeSync';
import { isEncryptionFailedError } from './e2eeChat';
import {
  buildKeyExchangeMessage,
  establishChatKey,
  exportPublicKeyBase64,
  getAnnounced,
  getOrCreateIdentityKeyPair,
  markAnnounced,
  shortFingerprint,
} from './e2ee/keyExchange';

export interface BroadcastList {
  id: string;
  name: string;
  /** Recipient user ids (uids, not doc ids — same as ChatScreen chatId for DMs). */
  recipientIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BroadcastSendResult {
  sent: string[];
  failed: { uid: string; error: string }[];
  skippedBlocked: string[];
  /**
   * W18b (P0-8): recipients whose send failed ONLY because E2EE is not set
   * up with them yet — no peer key exchanged, so the fail-closed adapter
   * refused to write the message. They got nothing (no plaintext fallback)
   * and the sender can retry once the peer's app has acked the announce.
   * Never mixed into `failed`: the user-facing copy and the retry button
   * treat these differently from a real send error.
   */
  pendingSetup: string[];
}

export const MAX_BROADCAST_NAME_LEN = 50;
/** WhatsApp parity: broadcast lists hold up to 256 recipients (was 100). */
export const MAX_BROADCAST_RECIPIENTS = 256;

const localKey = (uid: string) => `pinglo:broadcastLists:${uid}`;

function newListId(): string {
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return 'bc_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'bc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

function loadLocal(uid: string): BroadcastList[] {
  try {
    const raw = localStorage.getItem(localKey(uid));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocal(uid: string, lists: BroadcastList[]) {
  try {
    localStorage.setItem(localKey(uid), JSON.stringify(lists));
  } catch { /* intentionally ignored */}
}

function sanitizeLists(raw: any): BroadcastList[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l) => l && typeof l.id === 'string' && typeof l.name === 'string')
    .map((l) => ({
      id: l.id,
      name: String(l.name).slice(0, MAX_BROADCAST_NAME_LEN),
      recipientIds: (Array.isArray(l.recipientIds)
        ? [...new Set(l.recipientIds.filter((x: any) => typeof x === 'string'))]
        : []) as string[],
      createdAt: Number(l.createdAt) || 0,
      updatedAt: Number(l.updatedAt) || 0,
    }));
}

/** Load the user's broadcast lists: server value wins, local fills gaps. */
export async function loadBroadcastLists(uid: string): Promise<BroadcastList[]> {
  const local = loadLocal(uid);
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const server = snap.exists() ? sanitizeLists((snap.data() as any).broadcastLists) : [];
    const merged = [...server];
    for (const l of local) {
      if (!merged.some((m) => m.id === l.id)) merged.push(l);
    }
    return merged.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return local;
  }
}

async function persistLists(uid: string, lists: BroadcastList[]): Promise<void> {
  saveLocal(uid, lists);
  try {
    await updateDoc(doc(db, 'users', uid), { broadcastLists: lists });
  } catch {
    // Offline / hybrid local mode: the local copy is kept (see header).
  }
}

/** Create a broadcast list. Throws on an empty name or no recipients. */
export async function createBroadcastList(
  uid: string,
  name: string,
  recipientIds: string[],
): Promise<BroadcastList> {
  const cleanName = name.trim();
  if (!cleanName) throw new Error('Give the broadcast list a name');
  const recipients = [...new Set(recipientIds.filter(Boolean))];
  if (recipients.length === 0) throw new Error('Pick at least one recipient');
  if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`A broadcast list holds at most ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  const list: BroadcastList = {
    id: newListId(),
    name: cleanName.slice(0, MAX_BROADCAST_NAME_LEN),
    recipientIds: recipients,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const lists = await loadBroadcastLists(uid);
  await persistLists(uid, [list, ...lists]);
  return list;
}

/** Delete a broadcast list (does not delete any chats or messages). */
export async function deleteBroadcastList(uid: string, listId: string): Promise<void> {
  const lists = await loadBroadcastLists(uid);
  await persistLists(uid, lists.filter((l) => l.id !== listId));
}

/** Rename / change recipients of an existing list. */
export async function updateBroadcastList(
  uid: string,
  listId: string,
  patch: { name?: string; recipientIds?: string[] },
): Promise<BroadcastList | null> {
  const lists = await loadBroadcastLists(uid);
  const idx = lists.findIndex((l) => l.id === listId);
  if (idx === -1) return null;
  const next: BroadcastList = {
    ...lists[idx],
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, MAX_BROADCAST_NAME_LEN) } : {}),
    ...(patch.recipientIds !== undefined
      ? { recipientIds: [...new Set(patch.recipientIds.filter(Boolean))] }
      : {}),
    updatedAt: Date.now(),
  };
  if (!next.name) throw new Error('Give the broadcast list a name');
  if (next.recipientIds.length === 0) throw new Error('Pick at least one recipient');
  // updateBroadcastList previously had NO cap at all — a list edited here
  // could silently grow past the limit createBroadcastList enforces.
  if (next.recipientIds.length > MAX_BROADCAST_RECIPIENTS) {
    throw new Error(`A broadcast list holds at most ${MAX_BROADCAST_RECIPIENTS} recipients`);
  }
  lists[idx] = next;
  await persistLists(uid, lists);
  return next;
}

/** Read the sender's blocked-user list (same field ChatScreen checks: `blockedUsers`). */
async function loadBlockedUids(uid: string): Promise<Set<string>> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const data = snap.exists() ? (snap.data() as any) : {};
    const blocked = data.blockedUsers ?? data.blocked;
    if (Array.isArray(blocked)) return new Set(blocked.map(String));
    if (blocked && typeof blocked === 'object') return new Set(Object.keys(blocked));
    return new Set();
  } catch {
    return new Set();
  }
}

/**
 * W18b (P0-8): make sure a key-announce exists for a broadcast recipient
 * before attempting the send. A broadcast recipient may never have had a
 * DM opened with them, so ChatScreen's mount announce may never have run
 * for them — without an announce the peer can never ack and the send below
 * fails closed forever. Mirrors ChatScreen's mount-effect announce on
 * master (same primitives, same (b)/(c) 24h throttles). It SKIPS that
 * effect's (a) server-truth check — broadcast holds no live snapshot of
 * the DM's kx docs — which is safe: a duplicate announce is harmless by
 * design (same key re-derived, same safety number) and (b)/(c) throttle
 * to at most one announce per 24h per chat. W5b's fix/delivery branch
 * extracts this into `ensureKeyAnnounce` in e2eeChat.ts — when that
 * merges, this helper should call it instead. Best-effort, never throws:
 * a failed announce leaves the send to fail closed, exactly as before.
 */
async function ensureBroadcastKeyAnnounce(chatId: string, myUid: string): Promise<void> {
  try {
    const established = await establishChatKey(chatId, myUid);
    if (established) return;
    const pair = await getOrCreateIdentityKeyPair();
    const ownKeyId = await shortFingerprint(await exportPublicKeyBase64(pair.publicKey));
    const announced = await getAnnounced(chatId);
    if (announced && announced.keyId === ownKeyId && Date.now() - announced.at < 24 * 60 * 60 * 1000) return;
    const lastKey = `pinglo-e2ee-announced:${chatId}`;
    let last = 0;
    try {
      last = Number(localStorage.getItem(lastKey) || 0);
    } catch { /* intentionally ignored */}
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    const announce = await buildKeyExchangeMessage(chatId, myUid, pair.publicKey, 'key-announce');
    await addDoc(collection(db, 'chats', chatId, 'messages'), {
      ...announce,
      timestamp: Date.now(),
      senderId: myUid,
    });
    await markAnnounced(chatId, ownKeyId);
    try {
      localStorage.setItem(lastKey, String(Date.now()));
    } catch { /* intentionally ignored */}
  } catch {
    // Best-effort only.
  }
}

/**
 * Send one text message to every recipient of a broadcast list, as
 * individual DMs (no group chat is created). Returns per-recipient results
 * — check `failed` / `skippedBlocked` before telling the user it all went
 * through. Throws on empty text.
 */
export async function sendBroadcast(
  list: BroadcastList,
  text: string,
): Promise<BroadcastSendResult> {
  const clean = text.trim();
  if (!clean) throw new Error('Write a message first');
  if (clean.length > 5000) throw new Error('Message too long (max 5,000 characters)');
  const me = auth.currentUser;
  if (!me) throw new Error('You need to be signed in to send a broadcast');
  const senderName = me.displayName || (me as any).username || 'User';
  const senderAvatar = me.photoURL || '';
  const blocked = await loadBlockedUids(me.uid);

  const result: BroadcastSendResult = { sent: [], failed: [], skippedBlocked: [], pendingSetup: [] };
  for (const recipientId of list.recipientIds) {
    if (blocked.has(recipientId)) {
      result.skippedBlocked.push(recipientId);
      continue;
    }
    try {
      const conversationId = getConversationId(me.uid, recipientId);
      // W18b (P0-8): a broadcast recipient may never have had a DM opened
      // with them, so no key-announce may exist yet — without one the peer
      // can never ack and the send below fails closed forever. Announce
      // first (same announce ChatScreen sends; never throws, throttled to
      // once per 24h per chat, duplicates are harmless).
      await ensureBroadcastKeyAnnounce(conversationId, me.uid);
      // Same message fields ChatScreen.handleSend writes for a 1:1 text.
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        text: clean,
        senderId: me.uid,
        senderName,
        senderAvatar,
        timestamp: serverTimestamp(),
        status: 'sent',
        broadcast: true,
      });
      realtimeSync.sendMessage(recipientId, {
        conversationId,
        senderId: me.uid,
        senderName,
        senderAvatar,
        text: clean,
        timestamp: Date.now(),
      });
      result.sent.push(recipientId);
    } catch (e: any) {
      // W18b (P0-8): fail-closed encryption (no peer key yet) is NOT a
      // generic send error — it means "not set up yet, retry later". Keep
      // it out of `failed` so the UI can explain it and offer a retry.
      if (isEncryptionFailedError(e)) {
        result.pendingSetup.push(recipientId);
      } else {
        result.failed.push({ uid: recipientId, error: e?.message || 'Could not send' });
      }
    }
  }
  return result;
}
