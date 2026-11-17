/**
 * E2EE send/receive wiring — Worker E2 (SEND/RECEIVE WIRING).
 *
 * This module is the single seam between the chat persistence layer
 * (`src/aws/database.ts`, Firestore-style `db`) and the E2EE crypto
 * primitives in `src/services/e2ee/*` (which this file does NOT modify).
 *
 * ── Stored format (canonical) ──────────────────────────────────────────
 * The envelope stored on a message doc is `crypto.ts`' `EncryptedEnvelope`
 *   { v: 1, alg: 'AES-256-GCM', iv, ct, kid? }
 * under the `e2ee` field, with `text: ''` and `encrypted: true`, plus a
 * human-readable `encryption: 'e2ee'` marker. Same envelope shape is used
 * for `e2eeCaption`, `replyTo.e2ee` and `editHistory[].e2ee`.
 *
 * NOTE — envelope-shape conflict (coordinator: please reconcile): E2's
 * `src/services/e2ee/envelope.ts` defines a DIFFERENT `e2ee` field shape
 * ({ v, chatId, senderId, iv, ciphertext, alg }) and its `E2eeCryptoPort`
 * assumes `encryptText` returns `{ iv, ciphertext }`. The real
 * `crypto.ts` (E1) returns `{ iv, ct, ... }` and has no `ciphertext`
 * field, so `envelope.ts`' helpers cannot be used as-is. This module
 * therefore uses `crypto.ts` + `keys.ts` directly and treats the E1
 * `EncryptedEnvelope` shape as canonical. If `envelope.ts` is kept, it
 * should be adapted to the E1 shape — do NOT "fix" this module to the
 * `ciphertext` shape, or stored messages will stop decrypting.
 *
 * ── Key source ─────────────────────────────────────────────────────────
 * Keys come from ECDH key agreement (`keyExchange.ts`): each device holds
 * its own P-256 identity keypair (IndexedDB, private key non-extractable),
 * the two devices exchange PUBLIC keys over the existing message channel
 * (key-announce / key-ack docs — see ChatScreen), and both sides derive
 * the SAME per-chat AES-256-GCM key (ECDH + HKDF-SHA-256, info bound to
 * the chat id). The server only ever sees public keys, never the chat key.
 * `keys.ts` (per-chat symmetric keys invented on this device alone) is NO
 * LONGER used to encrypt: a key the peer never holds makes every message
 * undecryptable for the peer. It is kept only as a DECRYPT fallback for
 * messages encrypted by older builds of this app on this same device.
 *
 * ── HONEST LIMITS ──────────────────────────────────────────────────────
 * - 1-to-1 text + group text. Group/community chats exchange keys with
 *   the sender-key design in `keyExchange.ts` (each member owns one
 *   sender key per group, wrapped per member under a pairwise ECDH key);
 *   media BYTES are not encrypted (S3 URLs stay as-is); only the text /
 *   caption label is encrypted. View Once / media payloads unchanged.
 * - Type-specific payloads stay plaintext in live chats: poll
 *   question/options, location coords/label, contact name/phone,
 *   sticker/gif ids+labels. Only `text` (+ `caption`, quoted
 *   `replyTo.text`, `editHistory` texts) are encrypted. EXCEPTION (W22,
 *   REPORT-3 #87): in SAVED copies (`saved_<uid>`) those same payload
 *   fields ARE encrypted — one `e2eeMeta` envelope under the saved-chat
 *   self key, blanked at rest, restored by `decryptIncoming` — because a
 *   saved copy is a single-device snapshot and its metadata IS the
 *   message content at rest.
 * - No forward secrecy / ratchet (one long-lived derived key per peer
 *   keypair; a peer key change keeps ONE previous generation decryptable).
 *   Groups keep one previous sender key per sender the same way. A member
 *   who leaves a group keeps the sender keys they already hold (no
 *   rotation on removal in v1 — see keyExchange.ts).
 * - No server authentication of public keys: a compromised server (or
 *   anyone who can write to the messages collection) can substitute a
 *   peer's public key (MITM) until the users verify the safety number
 *   out-of-band (Settings → End-to-end encryption → Verify keys).
 * - `realtimeSync.sendMessage` (push/notify path) still carries plaintext
 *   `text` when it is implemented — it is a no-op stub today, but whoever
 *   implements it must encrypt or drop the text field.
 * - AUDIT-2 A10 FAIL-CLOSED: if encryption fails at write time (e.g.
 *   WebCrypto unavailable, key store denied) OR no peer key has been
 *   exchanged yet, a 1-to-1 message is NOT sent at all — `encryptOutgoing`
 *   throws `EncryptionFailedError` ("Encryption failed — message not
 *   sent"), the write is aborted, and the text returns to the composer so
 *   the user can retry after the keys are exchanged. NOTHING is ever sent
 *   as plaintext from a 1-to-1 chat when encryption fails. Group chats
 *   fail closed the same way since W16 (#183): a group send whose sender
 *   key cannot be created/used throws instead of writing marked-legacy
 *   plaintext (the old group legacy fallback in database.ts is gone).
 */

import {
  decryptText,
  encryptText,
  isEncryptedEnvelope,
  isWebCryptoAvailable,
} from './e2ee/crypto';
import type { EncryptedEnvelope } from './e2ee/types';
import {
  ensureSelfPeerKey,
  establishChatKey,
  getDerivedDecryptionKeys,
  getPeerPublicKey,
  buildKeyExchangeMessage,
  getOrCreateIdentityKeyPair,
  resetKeyAnnounceThrottle,
  clearAnnounced,
  // W16 (#183 — group E2EE, sender-key design).
  buildGroupMemberAnnounce,
  getOrCreateOwnGroupSenderKey,
  getGroupSenderKeysForDecrypt,
  isGroupKeyExchangeMessage,
  getAnnounced,
  markAnnounced,
  exportPublicKeyBase64,
  shortFingerprint,
  handleIncomingKeyExchange,
  loadProcessedKxKeys,
  loadAckedKxKeys,
  markProcessedKx,
  markAckedKx,
  type EstablishedChatKey,
  type KeyExchangePayload,
  type GroupKeyExchangePayload,
} from './e2ee/keyExchange';
import {
  getDecryptionKeys as getLegacyDecryptionKeys,
} from './e2ee/keys';
import { isKeyExchangeMessage } from './e2ee/keyExchange';
import { DECRYPT_FAILED_TEXT } from './e2ee/envelope';

/** Chat-level encryption state (also the per-message `encryption` marker). */
export type ChatEncryptionState = 'e2ee' | 'legacy' | 'mixed' | 'none';

/** Per-message marker for a doc whose envelope could not be decrypted. */
export type MessageEncryptionState = 'e2ee' | 'legacy' | 'decrypt-failed';

/**
 * Why a decrypt failed (Worker A). The two cases need different UI:
 * - 'no-key' — no peer key has been exchanged yet (key-ack still in
 *   flight, peer hasn't opened the chat). Transient: retry once keys
 *   arrive, and offer "re-request keys".
 * - 'bad-key' — a key was tried and GCM auth failed on every candidate
 *   (peer re-installed / identity reset, or tampered ciphertext). A
 *   retry with the same keys cannot help; the sender must resend after
 *   a fresh key exchange.
 */
export type DecryptFailureReason = 'no-key' | 'bad-key';

/** Placeholder text shown instead of a message that cannot be decrypted. Never blank. Canonical wording lives in envelope.ts (DECRYPT_FAILED_TEXT). */
export const DECRYPT_FAILED_PLACEHOLDER = DECRYPT_FAILED_TEXT;

/** Placeholder for a quoted reply that cannot be decrypted. */
export const DECRYPT_FAILED_REPLY_PLACEHOLDER = '🔒 Encrypted reply';

/**
 * AUDIT-2 A10 — fail-closed send error. Thrown by `encryptOutgoing` /
 * `encryptMessageDocForStore` when a 1-to-1 message cannot be encrypted.
 * The persistence adapter must let this propagate (the send fails, the
 * text returns to the composer for retry) — it must NEVER be caught and
 * turned into a plaintext write. `isEncryptionFailedError` lets the UI
 * show the honest message instead of a generic "check your connection".
 */
export const ENCRYPTION_FAILED_MESSAGE = 'Encryption failed — message not sent';
export class EncryptionFailedError extends Error {
  constructor(message: string = ENCRYPTION_FAILED_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptionFailedError';
  }
}
export function isEncryptionFailedError(e: unknown): e is EncryptionFailedError {
  return (
    e instanceof EncryptionFailedError ||
    (typeof e === 'object' &&
      e !== null &&
      (e as { name?: unknown }).name === 'EncryptionFailedError')
  );
}

export type MessageDoc = Record<string, any>;

/* ------------------------------------------------------------------ */
/* Collection helpers (for the persistence adapter)                    */
/* ------------------------------------------------------------------ */

/** True for a message collection path: `chats/{chatId}/messages`. */
export function isMessagesCollection(col: string): boolean {
  return /^chats\/[^/]+\/messages$/.test(col);
}

/** chatId out of a `chats/{chatId}/messages` path, or null. */
export function chatIdFromMessagesCollection(col: string): string | null {
  const m = /^chats\/([^/]+)\/messages$/.exec(col);
  return m ? m[1] : null;
}

/** True when the doc carries a well-formed v1 envelope in `e2ee`. */
export function isEncryptedDoc(doc: MessageDoc | null | undefined): boolean {
  if (!doc || typeof doc !== 'object') return false;
  return isEncryptedEnvelope((doc as MessageDoc).e2ee);
}

/* ------------------------------------------------------------------ */
/* Key setup                                                           */
/* ------------------------------------------------------------------ */

/** True when the doc is a key-exchange protocol message (never a chat bubble). */
export function isKeyExchangeDoc(doc: MessageDoc | null | undefined): boolean {
  return isKeyExchangeMessage(doc);
}

/** True when the doc is a GROUP key-exchange protocol message (W16 #183:
 * member-announce / sender-key docs — never a chat bubble). */
export function isGroupKeyExchangeDoc(doc: MessageDoc | null | undefined): boolean {
  return isGroupKeyExchangeMessage(doc);
}

/**
 * AUDIT-2 A10 — true when `chatId` is a group/community chat. Groups
 * DO have E2EE since W16 (#183, sender-key design) — this helper only
 * answers "is this a group", it no longer means "no encryption".
 * `communityDoc` is the `communities/<chatId>` doc when the caller has
 * one — any doc in that collection IS a group/channel. `chatsDoc` is a
 * `chats/<chatId>` channel doc when one exists. With neither doc
 * available the answer is FALSE: the caller must then fail CLOSED
 * (treat the chat as a DM), never assume "group" and send plaintext.
 * There is deliberately NO id-shape fallback: `addDoc` ids
 * (`msg_<ts>_<rand>`) contain '_' just like DM ids (`uidA_uidB`), so
 * the id shape cannot tell them apart.
 */
export function isGroupChat(
  chatId: string,
  communityDoc?: unknown,
  chatsDoc?: unknown,
): boolean {
  if (!chatId || chatId.startsWith('saved_')) return false;
  if (communityDoc && typeof communityDoc === 'object') return true;
  if (chatsDoc && typeof chatsDoc === 'object') {
    const d = chatsDoc as { members?: unknown; isGroup?: unknown; type?: unknown };
    if (d.isGroup === true) return true;
    if (d.type === 'group' || d.type === 'community') return true;
    if (Array.isArray(d.members) && d.members.length > 2) return true;
  }
  return false;
}

/** Handle for the chat key `encryptOutgoing` encrypts with (ECDH-derived). */
export interface ChatKeyHandle {
  /** AES-256-GCM key derived from the ECDH shared secret. */
  key: CryptoKey;
  /** Envelope `kid`: the peer key fingerprint this key was derived from. */
  keyId: string;
  version: number;
}

/**
 * Get the ECDH-derived chat key for sending. Fail-closed: throws when
 * WebCrypto is unavailable, when the peer's public key has not been
 * exchanged yet (DM not set up / peer offline), or for group chats (no
 * single peer to agree a key with). Callers that must keep sending decide
 * the (explicit, marked) legacy fallback — this function never silently
 * writes plaintext.
 *
 * Self-chat (`saved_<uid>`): the peer is yourself — your own public key
 * is used, so no exchange message is needed. Saved messages then decrypt
 * only on this device (a second device has a different identity).
 */
export async function ensureChatKey(
  chatId: string,
  _peerId?: string,
  ownerUid?: string,
): Promise<ChatKeyHandle> {
  if (!chatId) throw new Error('E2EE: ensureChatKey needs a chatId');
  if (!isWebCryptoAvailable()) {
    throw new Error('E2EE: WebCrypto unavailable — secure context required');
  }
  let owner = ownerUid;
  if (chatId.startsWith('saved_')) {
    const ownUid = chatId.slice('saved_'.length);
    if (!ownUid) throw new Error('E2EE: saved chat id has no owner');
    await ensureSelfPeerKey(chatId, ownUid);
    owner = ownUid;
  }
  const established: EstablishedChatKey | null = await establishChatKey(chatId, owner);
  if (!established) {
    throw new Error(
      'E2EE: no peer key exchanged for this chat yet — message would not be readable by the other side',
    );
  }
  return { key: established.chatKey, keyId: established.peerKeyId, version: 1 };
}

/**
 * W16 (#183) — the group sender key for sending in a group chat. The
 * sender key is created locally on first use (no network, no peer
 * needed); distribution to members is the ChatScreen announce effect's
 * job. Throws when WebCrypto is unavailable or the key cannot be
 * created — the caller must fail closed, never send plaintext.
 * `senderId` is the message author's uid (the sender key is per sender).
 */
export async function ensureGroupChatKey(
  groupId: string,
  senderId?: string,
): Promise<ChatKeyHandle> {
  if (!groupId) throw new Error('E2EE: ensureGroupChatKey needs a groupId');
  if (!isWebCryptoAvailable()) {
    throw new Error('E2EE: WebCrypto unavailable — secure context required');
  }
  if (!senderId) {
    throw new Error('E2EE: group send needs a senderId (own sender key)');
  }
  const own = await getOrCreateOwnGroupSenderKey(groupId, senderId);
  return { key: own.key, keyId: own.keyId, version: 1 };
}

/** Options for the encrypt entry points (group sends only). */
export interface EncryptOutgoingOptions {
  /** True when the chat is a group/community chat (sender-key path). */
  isGroup?: boolean;
  /** Message author's uid — the group sender key is per sender. */
  senderId?: string;
}

/**
 * W22 (REPORT-3 #87) — content-bearing metadata fields that are encrypted
 * ONLY in saved copies (`chats/saved_<uid>/messages`). In a live chat
 * these stay plaintext (honest limit — poll tallying, location rendering
 * etc. read them raw); in a saved copy they ARE the message content (a
 * poll question, a location, a contact's phone number, a file name), so
 * they are encrypted into one `e2eeMeta` envelope under the SAME per-chat
 * (self) key as the body and the plaintext fields are blanked.
 *
 * Deliberately NOT in this list (kept plaintext, needed raw by other
 * readers or not content): `fileSize`/`duration` (numbers — Storage
 * Usage reads them raw via getCollectionDocs), `mediaUrl`/`posterUrl`/
 * `mediaType` (media pointers — media bytes are not encrypted by design),
 * `type` (render discriminator), routing ids (`chatId`/`conversationId`/
 * `originalChatId`/`messageId`/`originalMessageId` — locked-chat
 * filtering + the save duplicate guard read them raw), status metadata
 * (`kept`/`edited`/timestamps) and `liveLocation*` (dead snapshot).
 */
export const SAVED_META_FIELDS = [
  'pollQuestion',
  'pollOptions',
  'pollVotes',
  'latitude',
  'longitude',
  'locationLabel',
  'locationAccuracy',
  'contactName',
  'contactPhone',
  'contactAvatar',
  'contactUid',
  'fileName',
  'fileType',
  'waveform',
  'stickerEmoji',
  'stickerLabel',
  'stickerImage',
  'stickerAnimation',
  'originalSenderName',
  'originalFrom',
  'forwardedFrom',
  'originalSenderId',
] as const;

/** Plaintext meta values present on a doc (null/undefined/'' count as absent). */
function collectSavedMeta(doc: MessageDoc): Record<string, unknown> | null {
  if (!doc || typeof doc !== 'object') return null;
  const meta: Record<string, unknown> = {};
  let any = false;
  for (const f of SAVED_META_FIELDS) {
    const v = (doc as MessageDoc)[f];
    if (v !== null && v !== undefined && v !== '') {
      meta[f] = v;
      any = true;
    }
  }
  return any ? meta : null;
}

/**
 * True when a write changes something E2EE would encrypt (body, caption,
 * quoted reply text, or a plaintext edit-history entry). The database
 * adapter uses this so a status-only rewrite (read receipt, reaction,
 * pin) does NOT silently re-encrypt — and thereby upgrade — a legacy
 * plaintext message: legacy history is never rewritten by a read.
 *
 * W22 (#87): a saved copy's metadata counts too — a plaintext meta field
 * that changed (or a changed `e2eeMeta` envelope) must re-encrypt, while
 * a status-only rewrite of an already-encrypted saved copy must not.
 */
export function encryptableContentChanged(prev: MessageDoc | null | undefined, next: MessageDoc): boolean {
  if (!prev || typeof prev !== 'object') return true;
  if ((prev.text ?? '') !== (next.text ?? '')) return true;
  if ((prev.caption ?? '') !== (next.caption ?? '')) return true;
  if ((prev.replyTo?.text ?? '') !== (next.replyTo?.text ?? '')) return true;
  const prevHist = Array.isArray(prev.editHistory) ? prev.editHistory : [];
  const nextHist = Array.isArray(next.editHistory) ? next.editHistory : [];
  if (prevHist.length !== nextHist.length) return true;
  for (let i = 0; i < nextHist.length; i++) {
    const p = prevHist[i] as any;
    const n = nextHist[i] as any;
    if (!p || !n) return true;
    if ((p.text ?? '') !== (n.text ?? '')) return true;
    if (Boolean(p.e2ee) !== Boolean(n.e2ee)) return true;
  }
  // W22 (#87): saved-copy metadata. The stored copy carries blanked
  // fields + an `e2eeMeta` envelope; a merge that sets a plaintext meta
  // field (or swaps the envelope) changes encryptable content.
  for (const f of SAVED_META_FIELDS) {
    if (JSON.stringify((prev as MessageDoc)[f] ?? null) !== JSON.stringify((next as MessageDoc)[f] ?? null)) return true;
  }
  if (JSON.stringify((prev as MessageDoc).e2eeMeta ?? null) !== JSON.stringify((next as MessageDoc).e2eeMeta ?? null)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Encrypt (send path)                                                 */
/* ------------------------------------------------------------------ */

function hasPlaintextText(doc: MessageDoc): boolean {
  return typeof doc.text === 'string' && doc.text.length > 0;
}

function hasPlaintextCaption(doc: MessageDoc): boolean {
  return typeof doc.caption === 'string' && doc.caption.length > 0;
}

function hasEncryptableContent(doc: MessageDoc, chatId?: string): boolean {
  // 100M-H14 — `type: 'system'` docs ("Missed voice call", group
  // membership events) are app-generated metadata, not user content:
  // their text is a fixed label, already reflected in the unencrypted
  // call history / group roster. They must not be fail-closed by E2EE
  // (no peer key can ever exist for a pill the peer never sent) — the
  // same category as the key-exchange protocol docs below, which pass
  // through unchanged. Only app code writes system docs (the composer
  // creates type 'text'), so no user text can smuggle through here.
  if (doc.type === 'system') return false;
  if (hasPlaintextText(doc) || hasPlaintextCaption(doc)) return true;
  const replyText = doc.replyTo?.text;
  if (typeof replyText === 'string' && replyText.length > 0) return true;
  if (Array.isArray(doc.editHistory)) {
    if (doc.editHistory.some(
      (h: any) => h && typeof h.text === 'string' && h.text.length > 0 && !isEncryptedEnvelope(h.e2ee),
    )) return true;
  }
  // W22 (#87): a saved copy with only metadata (no body text) still has
  // encryptable content — the meta fields below.
  if (chatId && chatId.startsWith('saved_') && collectSavedMeta(doc)) return true;
  return false;
}

/**
 * Encrypt a message doc's text fields for storage. Returns a NEW object
 * (input is never mutated); every other field passes through untouched.
 *
 * - Plaintext `text` -> `e2ee` envelope, `text: ''`, `encrypted: true`,
 *   `encryption: 'e2ee'`. Same for `caption` -> `e2eeCaption`.
 * - Quoted `replyTo.text` -> `replyTo.e2ee` envelope, `replyTo.text: ''`.
 * - `editHistory[]` entries with plaintext `text` -> entry `e2ee`.
 * - Docs with nothing encryptable (key-exchange protocol docs, docs with
 *   no text at all) are returned unchanged.
 * - Idempotent: a doc that is already encrypted (`e2ee` + empty `text`)
 *   is returned as-is. A doc with an envelope AND new plaintext `text`
 *   (message edit / delete-for-everyone via updateDoc merge) is
 *   re-encrypted with a fresh envelope.
 *
 * Fail-closed: throws `EncryptionFailedError` when WebCrypto is
 * unavailable or the key cannot be created/used. Callers must let it
 * propagate for 1-to-1 chats (the message is not sent); only group chats
 * keep a marked-legacy write, decided by the persistence adapter — this
 * function never silently writes plaintext.
 *
 * W16 (#183): group chats fail closed too. `opts.isGroup` selects the
 * sender-key path (`ensureGroupChatKey`); without it a group send would
 * try the 1-to-1 key and throw. The persistence adapter (database.ts)
 * passes `isGroup` from the communities doc.
 */
async function encryptOutgoingInner<T extends MessageDoc>(
  chatId: string,
  fields: T,
  opts?: EncryptOutgoingOptions,
): Promise<T & { encryption?: ChatEncryptionState }> {
  if (!fields || typeof fields !== 'object') return fields;
  if (!hasEncryptableContent(fields, chatId)) return fields;

  const handle = opts?.isGroup
    ? await ensureGroupChatKey(chatId, opts?.senderId ?? (fields as MessageDoc).senderId)
    // W5c: the 1-to-1 peer key is owner-scoped — the sender is the owner
    // for outgoing mail, so the sender uid scopes the key lookup.
    : await ensureChatKey(chatId, undefined, opts?.senderId ?? (fields as MessageDoc).senderId);
  const out: MessageDoc = { ...fields };
  let encryptedAny = isEncryptedDoc(fields) && !hasPlaintextText(fields);

  if (hasPlaintextText(fields)) {
    out.e2ee = await encryptText(fields.text, handle.key, handle.keyId);
    out.text = '';
    out.encrypted = true;
    encryptedAny = true;
  }
  if (hasPlaintextCaption(fields)) {
    out.e2eeCaption = await encryptText(fields.caption, handle.key, handle.keyId);
    out.caption = '';
    out.encrypted = true;
    encryptedAny = true;
  }
  const replyTo = fields.replyTo;
  if (replyTo && typeof replyTo === 'object') {
    if (typeof replyTo.text === 'string' && replyTo.text.length > 0) {
      const env = await encryptText(replyTo.text, handle.key, handle.keyId);
      out.replyTo = { ...replyTo, e2ee: env, text: '' };
      encryptedAny = true;
    } else if (isEncryptedEnvelope(replyTo.e2ee)) {
      // Already-encrypted quote — keep as-is.
      encryptedAny = true;
    }
  }
  if (Array.isArray(fields.editHistory)) {
    let changed = false;
    const next = fields.editHistory.map((h: any) => {
      if (!h || typeof h !== 'object') return h;
      if (typeof h.text === 'string' && h.text.length > 0 && !isEncryptedEnvelope(h.e2ee)) {
        changed = true;
        return { ...h, __e2eePending: h.text };
      }
      return h;
    });
    if (changed) {
      // Encrypt sequentially (cheap; history is tiny) and swap in envelopes.
      for (let i = 0; i < next.length; i++) {
        const pending = (next[i] as any)?.__e2eePending;
        if (typeof pending === 'string') {
          const env = await encryptText(pending, handle.key, handle.keyId);
          const { __e2eePending: _drop, ...rest } = next[i] as any;
          next[i] = { ...rest, e2ee: env, text: '' };
        }
      }
      out.editHistory = next;
      encryptedAny = true;
    }
  }

  // W22 (REPORT-3 #87) — saved-copy metadata. The body above is
  // encrypted with the saved-chat self key; the type-specific payload
  // fields are message content too, so they go into ONE `e2eeMeta`
  // envelope under the SAME key and the plaintext fields are blanked.
  // Live chats are untouched (gate is `saved_` only — the honest limit
  // in the module header still holds there). Fail-closed like the body:
  // if an existing meta envelope cannot be decrypted (tampered / key
  // lost), the write throws instead of silently dropping the old meta.
  // A doc with no plaintext meta and an existing envelope keeps that
  // envelope as-is (a body-only edit must not churn the meta envelope).
  if (chatId.startsWith('saved_')) {
    const plainMeta = collectSavedMeta(fields);
    const hasOldEnvelope = isEncryptedEnvelope((fields as MessageDoc).e2eeMeta);
    if (plainMeta || hasOldEnvelope) {
      let merged: Record<string, unknown> = {};
      if (hasOldEnvelope) {
        let oldPlain: string | null;
        try {
          oldPlain = await decryptText((fields as MessageDoc).e2eeMeta as EncryptedEnvelope, handle.key);
        } catch {
          oldPlain = null;
        }
        if (oldPlain === null) {
          throw new EncryptionFailedError('Encryption failed — saved metadata could not be read back', {
            cause: new Error('e2eeMeta decrypt failed'),
          });
        }
        try {
          const parsed = JSON.parse(oldPlain);
          if (parsed && typeof parsed === 'object') merged = parsed as Record<string, unknown>;
        } catch {
          throw new EncryptionFailedError('Encryption failed — saved metadata could not be read back', {
            cause: new Error('e2eeMeta JSON parse failed'),
          });
        }
      }
      if (plainMeta) {
        merged = { ...merged, ...plainMeta };
        const env = await encryptText(JSON.stringify(merged), handle.key, handle.keyId);
        out.e2eeMeta = env;
        for (const f of SAVED_META_FIELDS) (out as MessageDoc)[f] = null;
        encryptedAny = true;
      } else if (hasOldEnvelope) {
        out.e2eeMeta = (fields as MessageDoc).e2eeMeta;
      }
    }
  }

  if (encryptedAny) out.encryption = 'e2ee';
  return out as T & { encryption?: ChatEncryptionState };
}

/**
 * Encrypt a message doc's text fields for storage (public entry point).
 * Fail-closed (AUDIT-2 A10): any failure — WebCrypto unavailable, no peer
 * key exchanged yet, key store denied — throws `EncryptionFailedError`
 * and the message must NOT be sent. Never returns a plaintext doc for a
 * 1-to-1 chat; the specific underlying reason is kept on `cause`.
 */
export async function encryptOutgoing<T extends MessageDoc>(
  chatId: string,
  fields: T,
  opts?: EncryptOutgoingOptions,
): Promise<T & { encryption?: ChatEncryptionState }> {
  try {
    return await encryptOutgoingInner(chatId, fields, opts);
  } catch (e) {
    if (e instanceof EncryptionFailedError) throw e;
    throw new EncryptionFailedError(undefined, { cause: e });
  }
}

/**
 * Adapter write hook: encrypt a message doc for the given collection
 * before it is stored. Non-message collections pass through untouched.
 * Returns the (possibly new) doc to store.
 */
export async function encryptMessageDocForStore(
  col: string,
  data: MessageDoc,
  opts?: EncryptOutgoingOptions,
): Promise<MessageDoc> {
  const chatId = chatIdFromMessagesCollection(col);
  if (!chatId || !data || typeof data !== 'object') return data;
  return encryptOutgoing(chatId, data, opts);
}

/* ------------------------------------------------------------------ */
/* Decrypt (read path) — never throws, never returns blank text        */
/* ------------------------------------------------------------------ */

interface ObservedState {
  e2ee: number;
  legacy: number;
}
/** Per-chat encryption mix observed this session (via decrypt/encrypt calls). */
const observedByChat = new Map<string, ObservedState>();

function observe(chatId: string | null, state: 'e2ee' | 'legacy'): void {
  if (!chatId) return;
  const cur = observedByChat.get(chatId) ?? { e2ee: 0, legacy: 0 };
  cur[state] += 1;
  observedByChat.set(chatId, cur);
}

/**
 * Decrypt one envelope with the chat's keys. Tries, in order:
 *  0. Group sender keys (W16 #183) — when `senderId` is given and this
 *     device holds a sender key for that sender in this group, the
 *     message was encrypted with it. (For 1-to-1 chats the lookup is
 *     empty and this step is a no-op.)
 *  1. ECDH-derived keys (current peer key, then the previous peer key
 *     after a peer key change) — the real E2EE path.
 *  2. The retired per-chat symmetric key (`keys.ts`) — decrypt fallback
 *     for messages this device encrypted with older builds. A peer never
 *     held that key, so it can only ever succeed on this device.
 * Returns the plaintext plus, on failure, WHY it failed ('no-key' when
 * no key existed to try at all, 'bad-key' when keys were tried and every
 * GCM auth check failed). Never throws.
 */
async function tryDecryptEnvelopeDetailed(
  envelope: unknown,
  chatId: string,
  senderId?: string,
  ownerUid?: string,
): Promise<{ plain: string | null; reason: DecryptFailureReason | null }> {
  if (!isEncryptedEnvelope(envelope)) return { plain: null, reason: 'bad-key' };
  let keys: CryptoKey[];
  let hadKey = false;
  // W16 (#183): group sender key for this sender, current generation
  // first (previous generation when `kid` names it).
  if (senderId) {
    try {
      const groupKeys = await getGroupSenderKeysForDecrypt(
        chatId,
        senderId,
        (envelope as EncryptedEnvelope).kid,
      );
      if (groupKeys.length > 0) hadKey = true;
      for (const key of groupKeys) {
        try {
          const plain = await decryptText(envelope as EncryptedEnvelope, key);
          if (typeof plain === 'string') return { plain, reason: null };
        } catch {
          // Try the next key (sender key rotation); a GCM auth failure
          // just means this key is not the one that encrypted it.
        }
      }
    } catch {
      // No group key store — fall through to the 1-to-1 keys.
    }
  }
  try {
    // W5c: ownerUid is optional here — when the caller cannot know it
    // (database.ts read hook), getDerivedDecryptionKeys falls back to the
    // signed-in session. The decrypt path only ever runs for the
    // currently signed-in user, so the session IS the owner.
    keys = await getDerivedDecryptionKeys(chatId, (envelope as EncryptedEnvelope).kid, ownerUid);
  } catch {
    keys = [];
  }
  if (keys.length > 0) hadKey = true;
  for (const key of keys) {
    try {
      const plain = await decryptText(envelope as EncryptedEnvelope, key);
      if (typeof plain === 'string') return { plain, reason: null };
    } catch {
      // Try the next key (peer key change); a GCM auth failure just means
      // this key is not the one that encrypted the message.
    }
  }
  // Legacy fallback: same-device messages from older builds.
  try {
    const legacyKeys = await getLegacyDecryptionKeys(chatId, (envelope as EncryptedEnvelope).kid);
    if (legacyKeys.length > 0) hadKey = true;
    for (const key of legacyKeys) {
      try {
        const plain = await decryptText(envelope as EncryptedEnvelope, key);
        if (typeof plain === 'string') return { plain, reason: null };
      } catch {
        // Try the next key.
      }
    }
  } catch {
    // No legacy key store — nothing more to try.
  }
  return { plain: null, reason: hadKey ? 'bad-key' : 'no-key' };
}

async function tryDecryptEnvelope(
  envelope: unknown,
  chatId: string,
  senderId?: string,
  ownerUid?: string,
): Promise<string | null> {
  return (await tryDecryptEnvelopeDetailed(envelope, chatId, senderId, ownerUid)).plain;
}

function markDecryptFailed<T extends MessageDoc>(doc: T, reason: DecryptFailureReason = 'bad-key'): T {
  return {
    ...doc,
    encryption: 'decrypt-failed' as const,
    decryptError: true,
    decryptFailureReason: reason,
    decryptFailedAt: Date.now(),
    text: DECRYPT_FAILED_PLACEHOLDER,
  };
}

/**
 * Decrypt a stored message doc back to renderable plaintext. NEVER throws
 * and NEVER returns a blank message for a doc that had content:
 * - Encrypted doc + key available -> plaintext restored, `encryption: 'e2ee'`.
 * - Encrypted doc + key missing/wrong/tampered -> placeholder text,
 *   `encryption: 'decrypt-failed'`, `decryptError: true`. The envelope is
 *   kept so a later key import can still decrypt it.
 * - Legacy plaintext doc -> returned with `encryption: 'legacy'` (and
 *   rendered exactly as before).
 * - Content-less docs (deleted placeholders with no text/envelope,
 *   key-exchange protocol docs) -> returned unchanged.
 *
 * `chatId` may be passed explicitly (the adapter knows it from the
 * collection path); otherwise `doc.chatId` / `doc.conversationId` are
 * tried. Without a chatId an encrypted doc cannot be decrypted and is
 * marked decrypt-failed. Input is never mutated.
 */
export async function decryptIncoming<T extends MessageDoc>(
  doc: T,
  chatId?: string | null,
  ownerUid?: string,
): Promise<T> {
  if (!doc || typeof doc !== 'object') return doc;
  // Worker A (crash hardening): a corrupt / hand-crafted doc must never
  // hand a non-string `text`/`caption` to render or search code
  // (`String.prototype` calls on a number/object throw). Coerce in the
  // in-memory view only — the stored doc is untouched.
  if (typeof (doc as MessageDoc).text !== 'undefined' && typeof (doc as MessageDoc).text !== 'string') {
    doc = { ...doc, text: '' } as T;
  }
  if (typeof (doc as MessageDoc).caption !== 'undefined' && typeof (doc as MessageDoc).caption !== 'string') {
    doc = { ...doc, caption: '' } as T;
  }
  const cid =
    chatId || (doc as MessageDoc).chatId || (doc as MessageDoc).conversationId || null;
  const hasEnvelope = isEncryptedDoc(doc);
  const hasCaptionEnvelope = isEncryptedEnvelope((doc as MessageDoc).e2eeCaption);
  const hasReplyEnvelope = isEncryptedEnvelope((doc as MessageDoc).replyTo?.e2ee);
  const hasHistoryEnvelopes =
    Array.isArray((doc as MessageDoc).editHistory) &&
    (doc as MessageDoc).editHistory.some((h: any) => isEncryptedEnvelope(h?.e2ee));
  // W22 (#87): saved-copy metadata envelope.
  const hasMetaEnvelope = isEncryptedEnvelope((doc as MessageDoc).e2eeMeta);

  if (!hasEnvelope && !hasCaptionEnvelope && !hasReplyEnvelope && !hasHistoryEnvelopes && !hasMetaEnvelope) {
    // No envelopes at all: legacy plaintext, or a content-less doc.
    if (hasPlaintextText(doc) || hasPlaintextCaption(doc)) {
      observe(cid, 'legacy');
      if ((doc as MessageDoc).encryption) return doc;
      return { ...doc, encryption: 'legacy' as const };
    }
    return doc;
  }

  // Encrypted doc (or encrypted nested fields on an otherwise plain doc).
  if (cid) observe(cid, 'e2ee');
  const out: MessageDoc = { ...doc };

  if (hasEnvelope) {
    if (typeof doc.text === 'string' && doc.text.length > 0) {
      // Envelope + plaintext text: transitional state (should not be
      // stored — the write hook re-encrypts first). Keep the newer
      // plaintext and keep the e2ee marker.
      out.encryption = 'e2ee';
    } else {
      const attempt = cid
        ? await tryDecryptEnvelopeDetailed(doc.e2ee, cid, (doc as MessageDoc).senderId, ownerUid)
        : { plain: null, reason: 'no-key' as DecryptFailureReason };
      if (attempt.plain !== null) {
        out.text = attempt.plain;
        out.encryption = 'e2ee';
      } else {
        // Keep the (possibly decrypted) nested fields below, but the body
        // itself failed: placeholder, never blank, never a crash. The
        // reason tells the UI whether a retry can help ('no-key') or the
        // sender must resend after a fresh key exchange ('bad-key').
        return markDecryptFailed(out, attempt.reason ?? 'bad-key') as T;
      }
    }
  } else if (out.encryption !== 'e2ee') {
    out.encryption = 'e2ee';
  }

  if (hasCaptionEnvelope) {
    const plain = cid ? await tryDecryptEnvelope(doc.e2eeCaption, cid, (doc as MessageDoc).senderId, ownerUid) : null;
    out.caption = plain !== null ? plain : DECRYPT_FAILED_PLACEHOLDER;
    if (plain === null) out.captionDecryptError = true;
  }
  if (hasReplyEnvelope) {
    const plain = cid ? await tryDecryptEnvelope(doc.replyTo.e2ee, cid, (doc as MessageDoc).senderId, ownerUid) : null;
    out.replyTo = {
      ...doc.replyTo,
      text: plain !== null ? plain : DECRYPT_FAILED_REPLY_PLACEHOLDER,
    };
  }
  if (hasHistoryEnvelopes && Array.isArray(doc.editHistory)) {
    const next = [...doc.editHistory];
    for (let i = 0; i < next.length; i++) {
      const h = next[i];
      if (h && typeof h === 'object' && isEncryptedEnvelope(h.e2ee)) {
        const plain = cid ? await tryDecryptEnvelope(h.e2ee, cid, (doc as MessageDoc).senderId, ownerUid) : null;
        next[i] = { ...h, text: plain !== null ? plain : DECRYPT_FAILED_PLACEHOLDER };
      }
    }
    out.editHistory = next;
  }
  // W22 (#87): saved-copy metadata envelope — decrypt with the same
  // chat key as the body and restore the fields. Old plaintext saves
  // (no envelope) pass through unchanged above, so legacy copies keep
  // rendering. A failed meta decrypt leaves the fields blank and flags
  // `metaDecryptError` — the body still renders; in practice meta and
  // body share one key, so this only fires when the body fails too (and
  // that path already returned the decrypt-failed placeholder above).
  if (hasMetaEnvelope) {
    const plain = cid ? await tryDecryptEnvelope(doc.e2eeMeta, cid, (doc as MessageDoc).senderId) : null;
    if (plain !== null) {
      try {
        const meta = JSON.parse(plain);
        if (meta && typeof meta === 'object') {
          for (const f of SAVED_META_FIELDS) {
            if (f in meta) (out as MessageDoc)[f] = meta[f];
          }
        }
      } catch {
        out.metaDecryptError = true;
      }
    } else {
      out.metaDecryptError = true;
    }
  }
  if (!out.encryption) out.encryption = 'e2ee';
  return out as T;
}

/**
 * Adapter read hook: decrypt a stored message doc from the given
 * collection for rendering. Non-message collections pass through
 * untouched. Never throws — on any unexpected error the raw doc is
 * returned (legacy rendering) rather than crashing the list.
 */
export async function decryptMessageDocForRead(
  col: string,
  doc: MessageDoc,
  ownerUid?: string,
): Promise<MessageDoc> {
  try {
    const chatId = chatIdFromMessagesCollection(col);
    if (!chatId || !doc || typeof doc !== 'object') return doc;
    return await decryptIncoming(doc, chatId, ownerUid);
  } catch {
    return doc;
  }
}

/**
 * Build a fresh key-announce for the decrypt-failed Retry action
 * (Worker A). The caller sends the returned doc over the message channel
 * exactly like the mount-time announce (addDoc to the chat's messages
 * collection); this function only builds it, so the database layer stays
 * out of the import graph (no cycle). The 24h announce throttle is
 * cleared first, so a manual re-request is never blocked by it, and the
 * peer answers with a key-ack (handled by the normal snapshot path) —
 * after which the failed message is re-decrypted (see the peer-key
 * generation invalidation in database.ts). Throws only when the identity
 * keypair cannot be created/loaded; the caller shows a toast then.
 */
export async function requestKeyReExchange(
  chatId: string,
  senderId: string,
): Promise<KeyExchangePayload> {
  if (!chatId) throw new Error('E2EE: requestKeyReExchange needs a chatId');
  if (!senderId) throw new Error('E2EE: requestKeyReExchange needs a senderId');
  resetKeyAnnounceThrottle(chatId);
  // Worker D (R2): the durable announce record must be cleared too, or a
  // manual re-request is blocked for 24h by the IDB throttle.
  await clearAnnounced(chatId);
  const pair = await getOrCreateIdentityKeyPair();
  return buildKeyExchangeMessage(chatId, senderId, pair.publicKey, 'key-announce');
}

/**
 * W16 (#183) — group version of the decrypt-failed Retry action: build
 * a fresh member-announce for the group. The caller sends the returned
 * doc over the message channel exactly like the mount-time announce
 * (addDoc to the group's messages collection); when a sender who holds
 * the group open sees the fresh announce, they wrap + post their sender
 * key for this member again, after which the failed message re-decrypts
 * (see the group-key generation invalidation in database.ts). The 24h
 * announce throttle is cleared first, so a manual re-request is never
 * blocked by it. Throws only when the identity keypair cannot be
 * created/loaded; the caller shows a toast then.
 */
export async function requestGroupKeyReExchange(
  groupId: string,
  senderId: string,
): Promise<GroupKeyExchangePayload> {
  if (!groupId) throw new Error('E2EE: requestGroupKeyReExchange needs a groupId');
  if (!senderId) throw new Error('E2EE: requestGroupKeyReExchange needs a senderId');
  // Same composite throttle key as the group announce effect
  // (group+user — see the throttle-collision note there).
  const throttleKey = `${groupId}:${senderId}`;
  resetKeyAnnounceThrottle(throttleKey);
  await clearAnnounced(throttleKey);
  const pair = await getOrCreateIdentityKeyPair();
  return buildGroupMemberAnnounce(groupId, senderId, pair.publicKey);
}

/* ------------------------------------------------------------------ */
/* Shared key-exchange runner (Report 3 #223/#232, W5b)                */
/* ------------------------------------------------------------------ */

/**
 * Write callback the runner uses to emit a key-exchange doc. Injected
 * by the caller (ChatScreen / ChatListScreen / foreground watcher) so
 * this module never imports the database layer — `database.ts` imports
 * `e2eeChat.ts` for the encrypt hook, so a static import back would be
 * a cycle. The caller writes the payload to the chat's `messages`
 * collection exactly as ChatScreen always did:
 * `addDoc(collection(db, 'chats', chatId, 'messages'),
 *   { ...payload, timestamp: Date.now(), senderId: myUid })`.
 * The payload already carries `senderId` (set by
 * `buildKeyExchangeMessage`); the caller re-stamps it with the same uid.
 */
export type KxDocWriter = (chatId: string, payload: KeyExchangePayload) => Promise<void>;

/** Outcome of one `processKeyExchangeDocs` pass. */
export interface KxProcessResult {
  /** A chat key can now be derived for this chat. */
  established: boolean;
  /** This pass wrote at least one key-ack. */
  acked: boolean;
}

// In-memory dedup sets, owned by the runner (module-level, per chat AND
// per owner uid):
// - `processedKxMem`: `${myUid}:${chatId}:${docId}:${keyId}` — claimed
//   SYNCHRONOUSLY before any await, exactly as ChatScreen's
//   `processedKxRef` did, so concurrent passes (snapshot + list probe +
//   watcher tick) can never handle the same doc twice in one session.
// - `ackedKxMem`: `${myUid}:${chatId}:${senderId}:${keyId}` — claimed BEFORE the
//   ack write, so one peer keyId is acked at most once ever per owner.
// Durable backing is the same `pinglo-e2ee` IndexedDB stores
// (`processedKx` / `ackedKx`) ChatScreen loaded on mount; the runner
// loads them lazily once per chat+owner (`kxDedupLoad`) so a remount /
// reload never re-processes or re-acks a doc handled in an earlier session.
// R11: the sets AND the durable keys are scoped by owner uid — the IDB
// is per-origin, so two accounts on one device share it, and an unscoped
// key let A's own-echo mark suppress B's handling of the same announce
// forever (no ack, A waits forever). Map keys are `${myUid}:${chatId}` so
// an account switch inside one session cannot reuse the other account's
// sets; the in-memory dedupKey/ackKey strings carry the same prefix so
// they match the durable keys loaded above.
const processedKxMem = new Map<string, Set<string>>();
const ackedKxMem = new Map<string, Set<string>>();
const kxDedupLoad = new Map<string, Promise<void>>();

async function ensureKxDedupLoaded(chatId: string, myUid: string): Promise<void> {
  const memKey = `${myUid}:${chatId}`;
  let loading = kxDedupLoad.get(memKey);
  if (!loading) {
    loading = (async () => {
      try {
        const [processed, acked] = await Promise.all([
          loadProcessedKxKeys(chatId, myUid),
          loadAckedKxKeys(chatId, myUid),
        ]);
        let pSet = processedKxMem.get(memKey);
        if (!pSet) { pSet = new Set(); processedKxMem.set(memKey, pSet); }
        for (const k of processed) pSet.add(k);
        let aSet = ackedKxMem.get(memKey);
        if (!aSet) { aSet = new Set(); ackedKxMem.set(memKey, aSet); }
        for (const k of acked) aSet.add(k);
      } catch (e) {
        // A failed dedup load is not fatal (the exchange retries on the
        // next pass) but must not vanish silently — a stuck dedup set
        // re-processes every key doc on every pass.
        console.warn('[e2eeChat] could not load processed key-exchange keys:', e);
      }
    })();
    kxDedupLoad.set(memKey, loading);
  }
  await loading;
}

/**
 * Report 3 #223/#232 (W5b): the ONE shared key-exchange runner. This is
 * a verbatim move of the ChatScreen snapshot loop (Worker D R2 flood
 * fix included) — same ordering guarantees, same dedup, same wire
 * format. Called from three places so B auto-acks WITHOUT opening the
 * chat: the ChatScreen snapshot effect, the ChatListScreen discovery
 * probe + live-collection callbacks, and the foreground watcher tick.
 *
 * Per doc, in the given order:
 * 1. Skip own echo (`senderId === myUid`, marked processed durably).
 * 2. Skip if already claimed; otherwise CLAIM synchronously in the
 *    in-memory set BEFORE any `await`.
 * 3. `handleIncomingKeyExchange` (validates key + fingerprint BEFORE
 *    storing); on terminal outcome persist the claim with
 *    `markProcessedKx`; on transient throw RELEASE the claim so the
 *    next pass retries.
 * 4. On `established` + `shouldAck` (incoming `key-announce`): claim
 *    the ack BEFORE the write, build it with `buildKeyExchangeMessage`,
 *    write it via `writeKxDoc`, and only after the write succeeds call
 *    `markAckedKx`. A failed ack write is NOT marked acked (otherwise
 *    the ack is lost forever and A waits forever).
 *
 * Group/community chats are never processed here (`opts.isGroup`) — they
 * have no key exchange by design and stay marked legacy. The runner
 * also ignores any non-kx doc defensively (callers pass filtered lists).
 * Never throws for a single bad doc (that doc is marked processed and
 * skipped); the pass itself only throws if the dedup load or the final
 * `establishChatKey` check throws, which callers treat as transient.
 * `putRaw` / fail-closed E2EE are untouched — this runner only moves
 * public keys, never message plaintext.
 */
export async function processKeyExchangeDocs(
  chatId: string,
  docs: Array<{ id: string } & KeyExchangePayload>,
  myUid: string,
  writeKxDoc: KxDocWriter,
  opts?: { isGroup?: boolean },
): Promise<KxProcessResult> {
  if (!chatId || !myUid || opts?.isGroup) return { established: false, acked: false };
  const kxDocs = (Array.isArray(docs) ? docs : []).filter((d) => d && isKeyExchangeDoc(d));
  if (kxDocs.length === 0) return { established: false, acked: false };
  await ensureKxDedupLoaded(chatId, myUid);
  const memKey = `${myUid}:${chatId}`;
  let processedSet = processedKxMem.get(memKey);
  if (!processedSet) { processedSet = new Set(); processedKxMem.set(memKey, processedSet); }
  let ackedSet = ackedKxMem.get(memKey);
  if (!ackedSet) { ackedSet = new Set(); ackedKxMem.set(memKey, ackedSet); }
  let acked = false;
  for (const kxDoc of kxDocs) {
    const docKeyId = (kxDoc as KeyExchangePayload).keyId || '';
    const dedupKey = `${myUid}:${chatId}:${kxDoc.id}:${docKeyId}`;
    // Our own echo: never a peer key, never an ack. Mark it processed
    // (durable, scoped to us) so it is never revisited by us — and so
    // it can never suppress the PEER's handling of the same doc.
    if ((kxDoc as KeyExchangePayload).senderId === myUid) {
      if (!processedSet.has(dedupKey)) {
        processedSet.add(dedupKey);
        void markProcessedKx(chatId, kxDoc.id, docKeyId, myUid);
      }
      continue;
    }
    if (processedSet.has(dedupKey)) continue;
    // Claim synchronously, before the slow async handle: a second pass
    // arriving mid-handle must not start a duplicate.
    processedSet.add(dedupKey);
    try {
      const res = await handleIncomingKeyExchange(kxDoc, chatId, myUid);
      // Terminal outcome (established / ignored-self / invalid):
      // persist the claim so no later session retries this doc.
      await markProcessedKx(chatId, kxDoc.id, docKeyId, myUid);
      if (res.status === 'established' && res.shouldAck) {
        const ackKey = `${myUid}:${chatId}:${(kxDoc as KeyExchangePayload).senderId}:${docKeyId}`;
        if (!ackedSet.has(ackKey)) {
          // Claim the ack BEFORE the write: concurrent passes in this
          // session cannot emit a second ack for this key.
          ackedSet.add(ackKey);
          try {
            const pair = await getOrCreateIdentityKeyPair();
            const ack = await buildKeyExchangeMessage(chatId, myUid, pair.publicKey, 'key-ack');
            await writeKxDoc(chatId, ack);
            await markAckedKx(chatId, (kxDoc as KeyExchangePayload).senderId, docKeyId, myUid);
            acked = true;
          } catch (e) {
            // #223/#232 (W5b R28): a failed ack write must RELEASE the
            // claim. The old code left it claimed: the durable mark was
            // correctly never written, but no later pass in this session
            // would retry the ack (the `ackedSet.has` guard above), so
            // the peer waited forever on a write that never landed.
            // Re-throwing lets the outer catch release the processed
            // claim too, so the next pass retries the whole doc.
            ackedSet.delete(ackKey);
            throw e;
          }
        }
      }
    } catch {
      // Transient failure (e.g. IndexedDB blocked while storing the
      // peer key): release the claim so the next pass retries it.
      processedSet.delete(dedupKey);
    }
  }
  let established: boolean;
  try {
    established = (await establishChatKey(chatId)) !== null;
  } catch {
    established = false;
  }
  return { established, acked };
}

/** Outcome of one `ensureKeyAnnounce` call. */
export interface KeyAnnounceResult {
  status: 'established' | 'announced' | 'skipped' | 'failed';
  /**
   * When our announce is known to exist (just sent, already on the
   * server, or recorded < 24 h ago): its `sentAt` / record time, so the
   * UI can show how long the peer has had to answer. Absent when no
   * announce is known.
   */
  announcedAt: number | null;
}

const KEY_ANNOUNCE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/**
 * Report 3 #223 §1.7 (W5b): the announce half of ChatScreen's mount
 * effect, extracted verbatim. Sends our `key-announce` for a 1-to-1 chat
 * when no chat key is established yet and no announce is already known:
 * (a) server truth — our announce with the current keyId is already in
 * the collection (`kxDocs`, the caller's latest snapshot); (b) durable
 * IndexedDB announce record for this keyId < 24 h old; (c) legacy
 * localStorage throttle < 24 h old. The durable record is written only
 * AFTER the announce write succeeds, so a failed write is retried on
 * the next call instead of being silenced for a day. Never throws —
 * a failure returns `{ status: 'failed' }` and the caller (send path)
 * still fails closed with the encryption error as before.
 *
 * Callers: ChatScreen's mount effect (after its 8 s wait for the first
 * snapshot, so the server-truth check can see an announce already in
 * the collection) and `sendTextNow` (so tapping Send itself triggers
 * key setup when the mount effect was skipped/cancelled). Self-chats
 * and groups must not call this — the caller guards those.
 */
export async function ensureKeyAnnounce(
  chatId: string,
  myUid: string,
  kxDocs: Array<{ id: string } & Partial<KeyExchangePayload>>,
  writeKxDoc: KxDocWriter,
): Promise<KeyAnnounceResult> {
  if (!chatId || !myUid) return { status: 'failed', announcedAt: null };
  try {
    const pair = await getOrCreateIdentityKeyPair();
    const ownKeyId = await shortFingerprint(await exportPublicKeyBase64(pair.publicKey));
    // (a) Server truth: our announce with this keyId is already there.
    // FIX 1A (one-way messaging): check this BEFORE the establishChatKey
    // short-circuit. After an identity rotation the derived chat key
    // changes, but a stored peer key still makes establishChatKey
    // succeed — returning 'established' there would skip the re-announce
    // and leave the peer deriving a different key, so every message we
    // send fails to decrypt on their side ("Couldn't decrypt" / invisible).
    // Never report 'established' unless the peer can see our current key.
    const ownAnnounce = (Array.isArray(kxDocs) ? kxDocs : []).find(
      (d) => d && d.senderId === myUid && d.kind === 'key-announce' && d.keyId === ownKeyId,
    );
    if (ownAnnounce) {
      const at = Number((ownAnnounce as KeyExchangePayload).sentAt) || Number((ownAnnounce as unknown as { timestamp?: number }).timestamp) || null;
      const established = await establishChatKey(chatId);
      if (established) return { status: 'established', announcedAt: null };
      return { status: 'skipped', announcedAt: at };
    }
    // Our current key is NOT on the server — we must (re-)announce, even
    // if a chat key exists (it may be stale after a rotation).
    // (b) Durable throttle: announced this keyId < 24h ago.
    const announced = await getAnnounced(chatId);
    if (announced && announced.keyId === ownKeyId && Date.now() - announced.at < KEY_ANNOUNCE_THROTTLE_MS) {
      return { status: 'skipped', announcedAt: announced.at };
    }
    // (c) Legacy localStorage throttle (kept for back-compat).
    // FIX 1B: keyed by ownKeyId so an identity rotation is not blocked
    // for 24h by the throttle from the old key.
    const lastKey = `pinglo-e2ee-announced:${chatId}:${ownKeyId}`;
    let last = 0;
    try { last = Number(localStorage.getItem(lastKey) || 0); } catch (e) { console.warn('[e2eeChat] could not read last key-announce time:', e); }
    if (Date.now() - last < KEY_ANNOUNCE_THROTTLE_MS) {
      return { status: 'skipped', announcedAt: last || null };
    }
    const announce = await buildKeyExchangeMessage(chatId, myUid, pair.publicKey, 'key-announce');
    await writeKxDoc(chatId, announce);
    await markAnnounced(chatId, ownKeyId);
    try { localStorage.setItem(lastKey, String(Date.now())); } catch (e) { console.warn('[e2eeChat] could not store last key-announce time:', e); }
    return { status: 'announced', announcedAt: Date.now() };
  } catch {
    // Key exchange is best-effort: if it fails, fail-closed means
    // messages can't send until the keys are exchanged (a failed send
    // stays in the composer so the user can retry).
    return { status: 'failed', announcedAt: null };
  }
}

/* ------------------------------------------------------------------ */
/* Chat encryption state                                               */
/* ------------------------------------------------------------------ */

/**
 * Overall encryption state of a chat:
 * - 'e2ee'   -> every observed message is encrypted
 * - 'legacy' -> every observed message is plaintext (pre-E2EE)
 * - 'mixed'  -> both encrypted and legacy messages seen
 * - 'none'   -> no messages observed (or no docs supplied)
 *
 * With `docs` supplied the state is computed from those docs directly.
 * Without `docs` it reflects messages observed this session through
 * `decryptIncoming` / `encryptOutgoing` (the persistence adapter calls
 * those for every message read/written, so the registry fills in
 * naturally). The registry is session-only and never touches the DB —
 * this module must not import the database layer (import cycle).
 */
export function getChatEncryptionState(
  chatId: string,
  docs?: Array<MessageDoc | null | undefined> | null,
): ChatEncryptionState {
  if (docs && docs.length > 0) {
    let e2ee = 0;
    let legacy = 0;
    for (const d of docs) {
      if (!d || typeof d !== 'object') continue;
      if (isEncryptedDoc(d) || (d as MessageDoc).encryption === 'e2ee') e2ee += 1;
      else if (
        (typeof (d as MessageDoc).text === 'string' && (d as MessageDoc).text.length > 0) ||
        (d as MessageDoc).encryption === 'legacy'
      ) {
        legacy += 1;
      }
    }
    if (e2ee > 0 && legacy > 0) return 'mixed';
    if (e2ee > 0) return 'e2ee';
    if (legacy > 0) return 'legacy';
    return 'none';
  }
  const obs = observedByChat.get(chatId);
  if (!obs || (obs.e2ee === 0 && obs.legacy === 0)) return 'none';
  if (obs.e2ee > 0 && obs.legacy > 0) return 'mixed';
  return obs.e2ee > 0 ? 'e2ee' : 'legacy';
}

/**
 * Key metadata for a chat (ids/timestamps only, no secret material) —
 * Settings/Security UI. The chat key itself is derived, not stored, so
 * this reports the exchanged peer key it is derived from.
 */
export async function getChatKeyInfo(chatId: string, ownerUid?: string): Promise<{
  chatId: string;
  keyId: string;
  createdAt: number;
  rotatedAt: number | null;
  version: number;
  hasPreviousKey: boolean;
} | null> {
  const peer = await getPeerPublicKey(chatId, ownerUid);
  if (!peer) return null;
  return {
    chatId,
    keyId: peer.keyId,
    createdAt: peer.receivedAt,
    rotatedAt: null,
    version: 1,
    hasPreviousKey: Boolean(peer.previousPublicKey),
  };
}

/** Drop in-memory decrypt observations (logout / chat delete). */
export function clearEncryptionObservations(chatId?: string): void {
  if (chatId) observedByChat.delete(chatId);
  else observedByChat.clear();
}
