/**
 * keyExchange.ts — E2EE per-chat key agreement (Worker E3).
 *
 * WebCrypto ECDH (P-256) + HKDF (SHA-256) → per-chat AES-256-GCM key.
 *
 * E1 API (src/services/e2ee/crypto.ts — REAL, verified):
 *   encryptText(plaintext: string, key: CryptoKey, keyId?: string)
 *     : Promise<EncryptedEnvelope>   // { v: 1, alg: 'AES-256-GCM', iv, ct, kid? }
 *   decryptText(envelope: EncryptedEnvelope, key: CryptoKey): Promise<string>
 *   (iv/ct standard base64 hain; `ct` me GCM auth tag shaamil hai.)
 * NOTE: is file ka `getChatKey()` ECDH se derive ki hui key deta hai
 * (`Promise<CryptoKey | null>`), jabki `keys.ts` ka `getChatKey()` stored
 * symmetric key ka handle deta hai (`Promise<ChatKeyHandle | null>`) —
 * naam ek hai, return type alag hai. Confusion se bachne ke liye is file
 * ka alias `getDerivedChatKey` use karo; dono ko ek hi jagah import
 * karoge to naam takrayega. (Dono ko ek API me merge karna baaki hai —
 * E2EE integration worker ka kaam.)
 *
 * This module's contract for E1 / ChatScreen / database wiring:
 *   - getDerivedChatKey(chatId) → CryptoKey (AES-GCM 256) | null
 *     Hand this key straight to E1's encryptText / decryptText.
 *   - buildKeyExchangeMessage(...) → the message doc to send over the
 *     EXISTING message channel (addDoc to the chat's messages collection).
 *   - handleIncomingKeyExchange(doc, chatId) → call this from the message
 *     listener for every incoming doc where isKeyExchangeMessage(doc) is
 *     true. It stores the peer key and derives the chat key. The doc must
 *     NOT be rendered as a chat bubble (see PATCH integration snippet).
 *
 * SECURITY MODEL (honest limits — see PATCH.md):
 *   - 1-to-1 chats only. Groups need sender-key distribution (not here).
 *   - No server authentication of public keys: a compromised server (or
 *     anyone who can write to the messages collection) can substitute a
 *     peer's public key (MITM) until the users verify the safety number
 *     out-of-band. That is exactly what the Security screen's verify flow
 *     is for — it does not magically prevent MITM.
 *   - No forward secrecy / ratcheting (no Double Ratchet). One long-lived
 *     chat key per peer keypair. Rotating the identity key re-keys chats.
 *   - Private key is non-extractable and lives only in IndexedDB on this
 *     device. Clearing site data / uninstall = identity lost; chats must
 *     re-exchange keys. No multi-device sync of the identity key.
 */

// clearAllE2EEKeys() ko symmetric chat keys (keys.ts ki IDB) bhi mitani
// hain — warna "delete account" ke baad bhi chat keys device par rehti.
import { clearKeyCache, eraseAllKeys } from './keys';
import { getSecurityNotificationsEnabled } from '../appSettings';
import { recordSecurityCodeChange } from './securityNotifications';
import {
  base64ToBytes,
  bytesToBase64,
  decryptText,
  encryptText,
  exportAesKeyRaw,
  importAesKey,
  isEncryptedEnvelope,
  randomBytes,
} from './crypto';
import type { EncryptedEnvelope } from './types';

export type KeyExchangeKind = 'key-announce' | 'key-ack';

/** Wire format of a key-exchange message doc in the messages collection. */
export interface KeyExchangePayload {
  /** Protocol version. Bump on any incompatible wire change. */
  version: 1;
  /** Message type discriminator — see buildKeyExchangeMessage(). */
  type: 'e2ee-key-exchange';
  kind: KeyExchangeKind;
  /** UID of the sender (Cognito sub / app user id). */
  senderId: string;
  /** Sender's ECDH P-256 public key, SPKI DER, base64. */
  publicKey: string;
  /** Short fingerprint of publicKey (first 16 hex of SHA-256). */
  keyId: string;
  /** Client timestamp (ms). Ordering only — NOT trusted for security. */
  sentAt: number;
}

/** Result of establishing (or loading) a chat key. */
export interface EstablishedChatKey {
  /** AES-256-GCM key for E1's encryptText / decryptText. */
  chatKey: CryptoKey;
  /** 60-digit safety number shared by both sides (verify out-of-band). */
  safetyNumber: string;
  /** Peer's key fingerprint (keyId). */
  peerKeyId: string;
}

const IDB_DB_NAME = 'pinglo-e2ee';
const IDB_VERSION = 3;
const STORE_IDENTITY = 'identity';
const STORE_PEERS = 'peers';
/** W16 (#183 — group E2EE, sender-key design): `groupMemberKeys` holds
 * each group member's announced ECDH public key
 * (key `${groupId}:${memberUid}`); `groupSenderKeys` holds the per-sender
 * AES-256-GCM sender key for a group (key `${groupId}:${senderUid}`) —
 * the key a member's own messages are encrypted with, and the key other
 * members' messages arrive encrypted with. */
const STORE_GROUP_MEMBER_KEYS = 'groupMemberKeys';
const STORE_GROUP_SENDER_KEYS = 'groupSenderKeys';
/** Worker D (R2): durable key-exchange dedup stores. `processedKx` records
 * every protocol doc this device has handled (key `${chatId}:${docId}:${keyId}`);
 * `ackedKx` records one ack per peer key (key `${chatId}:${senderId}:${keyId}`);
 * `announced` records our own last announce per chat (key chatId, value
 * { keyId, at }). All three survive remounts and fresh page loads, so a
 * re-delivered snapshot can never re-process or re-ack a doc, and a
 * remount can never re-announce within 24h. */
const STORE_PROCESSED_KX = 'processedKx';
const STORE_ACKED_KX = 'ackedKx';
const STORE_ANNOUNCED = 'announced';
const IDENTITY_KEY_ID = 'identity-ecdh-p256';

/**
 * W5c (peers-slot scoping): the signed-in owner's uid, read from the
 * persisted auth session (`pinglo_aws_auth_session`, the same key auth.ts
 * writes synchronously on login/logout). keyExchange.ts must NOT import
 * auth.ts — that would close an import cycle (auth -> database ->
 * e2eeChat -> keyExchange -> auth). '' means nobody is signed in.
 * Callers that know the owner pass it explicitly (preferred); this is
 * only the fallback for paths that cannot (the decrypt read hook in
 * database.ts, which has no owner in scope).
 */
export function currentOwnerUid(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    const raw = localStorage.getItem('pinglo_aws_auth_session');
    if (!raw) return '';
    const parsed: any = JSON.parse(raw);
    if (parsed && parsed.user && typeof parsed.user === 'object') {
      return typeof parsed.user.uid === 'string' ? parsed.user.uid : '';
    }
    return typeof parsed?.uid === 'string' ? parsed.uid : '';
  } catch {
    return '';
  }
}

/** Explicit owner wins; otherwise fall back to the signed-in session. */
function resolveOwnerUid(ownerUid?: string): string {
  return ownerUid && ownerUid.length > 0 ? ownerUid : currentOwnerUid();
}

/**
 * W5c: peers-store key, scoped by owner uid — mirrors 44b650c's kx-dedup
 * scoping. The `pinglo-e2ee` IndexedDB is per-ORIGIN (per device /
 * browser profile), not per account, so two accounts on one device share
 * it. The old key was the bare chatId, so Alice storing Bob's key and Bob
 * storing Alice's key for the same DM overwrote each other — whichever
 * wrote last won, and the other side then derived with the WRONG peer
 * key. Old unscoped rows are simply never read again (orphaned,
 * harmless); a missing scoped key fails closed and re-exchanges.
 */
function peerKeyStoreKey(ownerUid: string, chatId: string): string {
  return `${ownerUid}:${chatId}`;
}

/** localStorage key (per owner + chat) recording a user-confirmed safety-number match. */
const verifiedKey = (chatId: string, ownerUid: string) => `pinglo-e2ee-verified:${ownerUid}:${chatId}`;

// ---------------------------------------------------------------------------
// IndexedDB helpers (private key never leaves this store)
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      // Cached promise reset karo taaki ek failure hamesha ke liye na chipke.
      dbPromise = null;
      reject(new Error('IndexedDB is not available in this environment'));
      return;
    }
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_IDENTITY)) {
        req.result.createObjectStore(STORE_IDENTITY);
      }
      if (!req.result.objectStoreNames.contains(STORE_PEERS)) {
        req.result.createObjectStore(STORE_PEERS);
      }
      // Worker D (R2): v2 adds the durable key-exchange dedup stores.
      // Upgrading keeps the existing identity/peers stores untouched.
      if (!req.result.objectStoreNames.contains(STORE_PROCESSED_KX)) {
        req.result.createObjectStore(STORE_PROCESSED_KX);
      }
      if (!req.result.objectStoreNames.contains(STORE_ACKED_KX)) {
        req.result.createObjectStore(STORE_ACKED_KX);
      }
      if (!req.result.objectStoreNames.contains(STORE_ANNOUNCED)) {
        req.result.createObjectStore(STORE_ANNOUNCED);
      }
      // W16 (#183): v3 adds the group E2EE stores (member public keys +
      // per-sender group keys). Existing stores are untouched.
      if (!req.result.objectStoreNames.contains(STORE_GROUP_MEMBER_KEYS)) {
        req.result.createObjectStore(STORE_GROUP_MEMBER_KEYS);
      }
      if (!req.result.objectStoreNames.contains(STORE_GROUP_SENDER_KEYS)) {
        req.result.createObjectStore(STORE_GROUP_SENDER_KEYS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Failed to open E2EE key store'));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('E2EE key store is blocked (another tab holds it open)'));
    };
  });
  return dbPromise;
}

function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error ?? new Error('E2EE store read failed'));
      }),
  );
}

function idbPut(store: string, key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('E2EE store write failed'));
      }),
  );
}

function idbDelete(store: string, key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('E2EE store delete failed'));
      }),
  );
}

// ---------------------------------------------------------------------------
// Base64 helpers (SPKI DER <-> base64 string for the wire)
// ---------------------------------------------------------------------------

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error('E2EE key exchange: public key must be a non-empty base64 string');
  }
  // Base64url tolerate karo aur missing padding jod do; galat input par
  // atob ka raw DOMException nahi, clear Error do.
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/=]/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('E2EE key exchange: invalid base64 public key');
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('E2EE key exchange: invalid base64 public key');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** WebCrypto available hai ya nahi — bina iske ECDH/HKDF kuch nahi kar sakta. */
function requireWebCrypto(): void {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.subtle === 'undefined' ||
    typeof crypto.getRandomValues !== 'function'
  ) {
    throw new Error(
      'E2EE key exchange: WebCrypto unavailable — secure context (https / Capacitor) required',
    );
  }
}

// ---------------------------------------------------------------------------
// Identity keypair (ECDH P-256, this device)
// ---------------------------------------------------------------------------

/** Generate a fresh ECDH P-256 identity keypair. Private key is non-extractable. */
export async function generateIdentityKeyPair(): Promise<CryptoKeyPair> {
  requireWebCrypto();
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveKey',
    'deriveBits',
  ]);
}

/**
 * Load the device identity keypair from IndexedDB, generating + storing one
 * on first use. This is THE identity of this device — never send the
 * private key anywhere, never log it, never put it in localStorage.
 *
 * Concurrent calls dedupe hoti hain — bina iske do calls do alag keypairs
 * generate karke ek ko overwrite kar dete (pehle wala orphan ho jata).
 */
let identityPromise: Promise<CryptoKeyPair> | null = null;

export async function getOrCreateIdentityKeyPair(): Promise<CryptoKeyPair> {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    const stored = await idbGet<CryptoKeyPair>(STORE_IDENTITY, IDENTITY_KEY_ID);
    if (stored?.privateKey && stored?.publicKey) return stored;
    const pair = await generateIdentityKeyPair();
    await idbPut(STORE_IDENTITY, IDENTITY_KEY_ID, pair);
    return pair;
  })();
  try {
    return await identityPromise;
  } catch (e) {
    // Fail hone par dedup reset karo taaki agli call retry kar sake.
    identityPromise = null;
    throw e;
  }
}

/** Export a public key as base64 SPKI — the wire format for key exchange. */
export async function exportPublicKeyBase64(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return arrayBufferToBase64(spki);
}

/** Import a peer's base64 SPKI public key. Malformed input par clear `Error`. */
export async function importPeerPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  requireWebCrypto();
  let bytes: ArrayBuffer;
  try {
    bytes = base64ToArrayBuffer(publicKeyB64);
  } catch (e) {
    throw new Error(
      `E2EE key exchange: invalid peer public key — ${e instanceof Error ? e.message : 'bad base64'}`,
    );
  }
  try {
    return await crypto.subtle.importKey(
      'spki',
      bytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    );
  } catch {
    throw new Error('E2EE key exchange: invalid peer public key (not a P-256 SPKI key)');
  }
}

/** SHA-256 hex of a base64 SPKI public key (fingerprint / keyId source). */
export async function fingerprintPublicKey(publicKeyB64: string): Promise<string> {
  requireWebCrypto();
  const digest = await crypto.subtle.digest('SHA-256', base64ToArrayBuffer(publicKeyB64));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short fingerprint shown in UI: first 16 hex chars of the SHA-256. */
export async function shortFingerprint(publicKeyB64: string): Promise<string> {
  return (await fingerprintPublicKey(publicKeyB64)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Chat key derivation (ECDH shared secret -> HKDF -> AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Derive the per-chat AES-256-GCM key from our private key + peer public key.
 * HKDF salt is empty (fixed protocol constant) and info binds the key to
 * this chat id + protocol version, so keys never collide across chats.
 * Both sides derive the identical key: ECDH is symmetric.
 */
export async function deriveChatKey(
  ownPrivateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  chatId: string,
): Promise<CryptoKey> {
  requireWebCrypto();
  if (!ownPrivateKey || !peerPublicKey || typeof chatId !== 'string' || chatId.length === 0) {
    throw new Error('E2EE key exchange: deriveChatKey needs both keys and a chatId');
  }
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    ownPrivateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`pinglo-e2ee-v1:${chatId}`),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the chat key must never leave memory
    ['encrypt', 'decrypt'],
  );
}

/**
 * WhatsApp-style 60-digit safety number, identical on both sides.
 * SHA-256 over the two public keys in sorted order -> first 30 bytes ->
 * 60 decimal digits (each byte contributes 2 digits), grouped in 12x5.
 * If the numbers differ between two phones, someone is in the middle.
 */
export async function computeSafetyNumber(
  ownPublicKeyB64: string,
  peerPublicKeyB64: string,
): Promise<string> {
  requireWebCrypto();
  const [a, b] = [ownPublicKeyB64, peerPublicKeyB64].sort();
  const bytesA = new Uint8Array(base64ToArrayBuffer(a));
  const bytesB = new Uint8Array(base64ToArrayBuffer(b));
  const combined = new Uint8Array(bytesA.byteLength + bytesB.byteLength);
  combined.set(bytesA, 0);
  combined.set(bytesB, bytesA.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined.buffer));
  const digits = [...digest.slice(0, 30)]
    .map((byte) => String(byte % 100).padStart(2, '0'))
    .join('');
  return digits.replace(/(\d{5})(?=\d)/g, '$1 ');
}

// ---------------------------------------------------------------------------
// Peer key storage (per chat)
// ---------------------------------------------------------------------------

export interface StoredPeerKey {
  peerId: string;
  publicKey: string; // base64 SPKI
  keyId: string; // short fingerprint
  receivedAt: number;
  /**
   * Previous peer public key (one generation) — kept when the peer's key
   * changes (re-install / identity reset). The chat key derived from it
   * still decrypts messages sent before the change. Public keys are not
   * secret, so keeping the old one is safe.
   */
  previousPublicKey?: string;
  /** Short fingerprint of previousPublicKey. */
  previousKeyId?: string;
}

export async function storePeerPublicKey(
  chatId: string,
  peerId: string,
  publicKeyB64: string,
  ownerUid?: string,
): Promise<StoredPeerKey> {
  if (typeof chatId !== 'string' || chatId.length === 0) {
    throw new Error('E2EE key exchange: chatId must be a non-empty string');
  }
  if (typeof peerId !== 'string' || peerId.length === 0) {
    throw new Error('E2EE key exchange: peerId must be a non-empty string');
  }
  // W5c: a peer key without an owner scope would land in the shared slot
  // and collide with the other account's key for the same chat — fail
  // closed instead of storing it unscoped.
  const owner = resolveOwnerUid(ownerUid);
  if (!owner) {
    throw new Error('E2EE key exchange: ownerUid is required to store a peer key');
  }
  // Pehle key ko import karke verify karo — kachra key store karne se
  // establishChatKey baad me fail hota aur purani sahi key bhi kho jati.
  await importPeerPublicKey(publicKeyB64);
  const previous = await getPeerPublicKey(chatId, owner);
  // Peer key badli (re-install / identity reset / possible MITM): purani
  // public key ek generation tak rakho taaki usse encrypt kiye purane
  // messages abhi bhi decrypt hon. Public key secret nahi hoti.
  const previousPublicKey =
    previous && previous.publicKey !== publicKeyB64 ? previous.publicKey : previous?.previousPublicKey;
  const previousKeyId =
    previous && previous.publicKey !== publicKeyB64 ? previous.keyId : previous?.previousKeyId;
  const record: StoredPeerKey = {
    peerId,
    publicKey: publicKeyB64,
    keyId: await shortFingerprint(publicKeyB64),
    receivedAt: Date.now(),
    ...(previousPublicKey ? { previousPublicKey, previousKeyId } : {}),
  };
  await idbPut(STORE_PEERS, peerKeyStoreKey(owner, chatId), record);
  // Derived key ab stale hai — agla establishChatKey nayi key derive kare.
  clearDerivedKeyCache(chatId, owner);
  // Worker A: a new peer key can make previously undecryptable messages
  // decryptable — readers must drop their memoized decrypt-failed copy.
  bumpPeerKeyGeneration(chatId);
  return record;
}

export async function getPeerPublicKey(chatId: string, ownerUid?: string): Promise<StoredPeerKey | null> {
  const owner = resolveOwnerUid(ownerUid);
  if (!owner) return null;
  return (await idbGet<StoredPeerKey>(STORE_PEERS, peerKeyStoreKey(owner, chatId))) ?? null;
}

/** Delete one owner's exchanged peer key for a chat (per-chat "reset encryption"). */
export async function deletePeerKey(chatId: string, ownerUid?: string): Promise<void> {
  const owner = resolveOwnerUid(ownerUid);
  if (owner) {
    await idbDelete(STORE_PEERS, peerKeyStoreKey(owner, chatId));
    clearDerivedKeyCache(chatId, owner);
    clearVerified(chatId, owner);
  }
  bumpPeerKeyGeneration(chatId);
}

/** All exchanged peer keys for one owner on this device (chatId is stored on the record). */
export async function listPeerKeys(ownerUid?: string): Promise<Array<StoredPeerKey & { chatId: string }>> {
  try {
    const owner = resolveOwnerUid(ownerUid);
    if (!owner) return [];
    const db = await openDb();
    const rows: Array<StoredPeerKey & { chatId: string }> = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_PEERS, 'readonly').objectStore(STORE_PEERS).getAll();
      const keyReq = db.transaction(STORE_PEERS, 'readonly').objectStore(STORE_PEERS).getAllKeys();
      let values: StoredPeerKey[] | null = null;
      let keys: string[] | null = null;
      const done = () => {
        if (values !== null && keys !== null) {
          // Keys are `${ownerUid}:${chatId}` (W5c); only this owner's rows
          // are listed, with the owner prefix stripped. Legacy unscoped
          // rows (bare chatId) never match the prefix and stay invisible.
          const prefix = `${owner}:`;
          resolve(
            values
              .map((v, i) => ({
                ...v,
                chatId: (keys[i] ?? '').startsWith(prefix) ? keys[i].slice(prefix.length) : '',
              }))
              .filter((r) => r.chatId),
          );
        }
      };
      req.onsuccess = () => {
        values = (req.result as StoredPeerKey[]) || [];
        done();
      };
      req.onerror = () => reject(req.error ?? new Error('E2EE peer list read failed'));
      keyReq.onsuccess = () => {
        keys = (keyReq.result as string[]) || [];
        done();
      };
      keyReq.onerror = () => reject(keyReq.error ?? new Error('E2EE peer list read failed'));
    });
    return rows;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Derived chat-key cache (memory only — keys re-derive from the     */
/* stored peer public key, so nothing secret is persisted here)      */
/* ------------------------------------------------------------------ */

/**
 * Peer-key generation tracking (Worker A — decrypt-failure heal).
 *
 * Root cause it fixes: a message that arrives BEFORE its peer key (the
 * key-ack is processed async, after the first decrypt attempt) used to
 * be memoized as "decrypt-failed" forever — the decrypt memo in
 * database.ts is keyed only by the ciphertext fingerprint, which never
 * changes when the key arrives, and nothing ever re-tried the decrypt.
 * Every peer-key store / delete / rotation bumps the generation for
 * that chat (identity rotation bumps a global epoch, i.e. every chat),
 * so readers can tell a memoized failure predates the current key and
 * must be re-decrypted. Listeners (database.ts) also get a push so the
 * chat heals live, without a reload.
 */
let peerKeyEpoch = 0;
const peerKeyGenerationByChat = new Map<string, number>();
type PeerKeyChangeListener = (chatId: string | null) => void;
const peerKeyChangeListeners = new Set<PeerKeyChangeListener>();

/** Sync token for "which peer-key generation does this chat have now". */
export function getPeerKeyGeneration(chatId: string): string {
  return `${peerKeyEpoch}:${peerKeyGenerationByChat.get(chatId) ?? 0}`;
}

/** Subscribe to peer-key changes. `chatId === null` means "every chat" (identity rotation / wipe). */
export function onPeerKeyChanged(listener: PeerKeyChangeListener): () => void {
  peerKeyChangeListeners.add(listener);
  return () => {
    peerKeyChangeListeners.delete(listener);
  };
}

function emitPeerKeyChanged(chatId: string | null): void {
  for (const listener of [...peerKeyChangeListeners]) {
    try {
      listener(chatId);
    } catch (err) {
      // A listener must never break key storage.
      console.warn("[keyExchange] emitPeerKeyChanged: listener(chatId) failed", err);
    }
  }
}

function bumpPeerKeyGeneration(chatId: string): void {
  peerKeyGenerationByChat.set(chatId, (peerKeyGenerationByChat.get(chatId) ?? 0) + 1);
  emitPeerKeyChanged(chatId);
}

interface CachedDerivedKey {
  chatKey: CryptoKey;
  peerKeyId: string;
}

const derivedKeyCache = new Map<string, CachedDerivedKey>();

/**
 * Drop cached derived keys (one chat for one owner, or all — logout /
 * identity reset). The cache is keyed `${ownerUid}:${chatId}` (W5c) so an
 * account switch can never serve the other account's derived key.
 */
export function clearDerivedKeyCache(chatId?: string, ownerUid?: string): void {
  if (!chatId) {
    derivedKeyCache.clear();
    return;
  }
  const owner = resolveOwnerUid(ownerUid);
  if (owner) {
    derivedKeyCache.delete(peerKeyStoreKey(owner, chatId));
    return;
  }
  // No owner known (e.g. identity rotation with no session): drop every
  // cached key for this chat, whatever owner it was derived for. Cached
  // keys re-derive from the stored peer key, so this only costs a
  // re-derivation, never a wrong key.
  for (const key of [...derivedKeyCache.keys()]) {
    if (key.endsWith(`:${chatId}`)) derivedKeyCache.delete(key);
  }
}

/**
 * Full establish flow for a chat: load identity + stored peer key, derive
 * the chat key and safety number. Returns null when the peer key has not
 * been exchanged yet — the caller must then start a key exchange.
 * Corrupt peer key / storage failure par bhi `null` (throw nahi) — caller
 * "encryption not ready" samjhe, chat crash na ho.
 */
export async function establishChatKey(chatId: string, ownerUid?: string): Promise<EstablishedChatKey | null> {
  if (typeof chatId !== 'string' || chatId.length === 0) return null;
  const owner = resolveOwnerUid(ownerUid);
  if (!owner) return null;
  const cacheKey = peerKeyStoreKey(owner, chatId);
  try {
    const peer = await getPeerPublicKey(chatId, owner);
    if (!peer) return null;
    const cached = derivedKeyCache.get(cacheKey);
    if (cached && cached.peerKeyId === peer.keyId) {
      const identity = await getOrCreateIdentityKeyPair();
      const ownPubB64 = await exportPublicKeyBase64(identity.publicKey);
      return {
        chatKey: cached.chatKey,
        safetyNumber: await computeSafetyNumber(ownPubB64, peer.publicKey),
        peerKeyId: peer.keyId,
      };
    }
    const identity = await getOrCreateIdentityKeyPair();
    const peerKey = await importPeerPublicKey(peer.publicKey);
    const chatKey = await deriveChatKey(identity.privateKey, peerKey, chatId);
    derivedKeyCache.set(cacheKey, { chatKey, peerKeyId: peer.keyId });
    const ownPubB64 = await exportPublicKeyBase64(identity.publicKey);
    return {
      chatKey,
      safetyNumber: await computeSafetyNumber(ownPubB64, peer.publicKey),
      peerKeyId: peer.keyId,
    };
  } catch {
    return null;
  }
}

/**
 * Decrypt ke liye try karne wali derived keys — pehle current peer key se
 * derive ki hui, phir previous peer key se (peer ne key badli ho to purane
 * messages ke liye). `kid` envelope ke peer-key fingerprint se match kare
 * to wahi generation pehle try hoti hai. Koi key nahi mili to `[]`.
 */
export async function getDerivedDecryptionKeys(
  chatId: string,
  envelopeKeyId?: string,
  ownerUid?: string,
): Promise<CryptoKey[]> {
  if (typeof chatId !== 'string' || chatId.length === 0) return [];
  const owner = resolveOwnerUid(ownerUid);
  if (!owner) return [];
  try {
    const peer = await getPeerPublicKey(chatId, owner);
    if (!peer) return [];
    const identity = await getOrCreateIdentityKeyPair();
    const deriveFrom = async (pubB64: string): Promise<CryptoKey | null> => {
      try {
        return await deriveChatKey(identity.privateKey, await importPeerPublicKey(pubB64), chatId);
      } catch {
        return null;
      }
    };
    const current = await deriveFrom(peer.publicKey);
    const previous = peer.previousPublicKey ? await deriveFrom(peer.previousPublicKey) : null;
    const keys: CryptoKey[] = [];
    if (envelopeKeyId && peer.previousKeyId === envelopeKeyId && previous) {
      keys.push(previous);
      if (current) keys.push(current);
    } else {
      if (current) keys.push(current);
      if (previous) keys.push(previous);
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * Self-chat (`saved_<uid>` collections) ke liye: apni hi public key ko
 * peer key ki tarah store karo. ECDH(apni private, apni public) ek valid
 * shared secret deta hai — koi network message bhejne ki zaroorat nahi,
 * aur server ko sirf public key dikhti hai. Dusre device ki alag identity
 * hoti hai, isliye saved messages sirf is device par decrypt honge
 * (pehle wali local-key behaviour jaisi hi limit — PATCH.md dekho).
 */
export async function ensureSelfPeerKey(chatId: string, ownUid: string): Promise<boolean> {
  try {
    if (await getPeerPublicKey(chatId, ownUid)) return true;
    const identity = await getOrCreateIdentityKeyPair();
    const ownPubB64 = await exportPublicKeyBase64(identity.publicKey);
    await storePeerPublicKey(chatId, ownUid, ownPubB64, ownUid);
    return true;
  } catch {
    return false;
  }
}

/**
 * The key E1's encrypt/decrypt consume. Null = encryption not ready for
 * this chat yet (no peer key). Callers must NOT fall back to sending
 * plaintext silently — queue the message or show "setting up encryption".
 *
 * NOTE: `keys.ts` ka `getChatKey` alag cheez hai (stored symmetric key).
 * Confusion se bachne ke liye `getDerivedChatKey` alias use karo.
 */
export async function getChatKey(chatId: string, ownerUid?: string): Promise<CryptoKey | null> {
  return (await establishChatKey(chatId, ownerUid))?.chatKey ?? null;
}

/** `getChatKey` ka saaf naam — ECDH se derive ki hui key (keys.ts wali nahi). */
export const getDerivedChatKey = getChatKey;

/** Safety number for the Security screen. Null when keys not exchanged yet. */
export async function getSafetyNumber(chatId: string, ownerUid?: string): Promise<string | null> {
  return (await establishChatKey(chatId, ownerUid))?.safetyNumber ?? null;
}

// ---------------------------------------------------------------------------
// Key-exchange protocol over the EXISTING message channel
// ---------------------------------------------------------------------------

/**
 * Build the message doc to send for a key exchange. Send it with the
 * existing transport (addDoc to the chat's messages collection) exactly
 * like a normal message doc, with NO user-visible text:
 *
 *   const pair = await getOrCreateIdentityKeyPair();
 *   const doc = await buildKeyExchangeMessage(chatId, myUid, pair.publicKey, 'key-announce');
 *   await addDoc(collection(db, 'chats', chatId, 'messages'), doc);
 *
 * Message type: `type: 'e2ee-key-exchange'`, payload fields flat on the doc
 * (version / kind / senderId / publicKey / keyId / sentAt). The doc must be
 * filtered out of the rendered message list — it is a protocol message,
 * not a chat message. Receivers handle it via handleIncomingKeyExchange().
 *
 * Flow (1-to-1 chat, both sides online or not — docs persist in the channel):
 *   1. A opens chat (or first message): A sends kind 'key-announce' with
 *      A's public key. A stores nothing yet — A has no peer key.
 *   2. B receives it (message listener): handleIncomingKeyExchange stores
 *      A's key, derives the chat key, and B replies kind 'key-ack' with
 *      B's public key so A can derive the same key.
 *   3. A receives the ack: handleIncomingKeyExchange stores B's key.
 *      Both sides now hold the same chat key. Encryption can start.
 *   4. If B re-installs / rotates identity, B sends a fresh 'key-announce';
 *      A overwrites the stored peer key and the safety number changes —
 *      the Security screen shows the new number and verified=false.
 *   5. Duplicate / replayed announces are harmless: same key re-derived,
 *      same safety number. A announce from a DIFFERENT keyId overwrites
 *      the peer key and clears the verified mark (possible MITM / re-install).
 */
export async function buildKeyExchangeMessage(
  chatId: string,
  senderId: string,
  ownPublicKey: CryptoKey,
  kind: KeyExchangeKind,
): Promise<KeyExchangePayload> {
  void chatId; // chatId is the collection path, not part of the doc payload
  if (typeof senderId !== 'string' || senderId.length === 0) {
    throw new Error('E2EE key exchange: senderId must be a non-empty string');
  }
  if (!ownPublicKey || typeof ownPublicKey !== 'object') {
    throw new Error('E2EE key exchange: ownPublicKey must be a CryptoKey');
  }
  if (kind !== 'key-announce' && kind !== 'key-ack') {
    throw new Error(`E2EE key exchange: invalid kind ${String(kind)}`);
  }
  const publicKey = await exportPublicKeyBase64(ownPublicKey);
  return {
    version: 1,
    type: 'e2ee-key-exchange',
    kind,
    senderId,
    publicKey,
    keyId: await shortFingerprint(publicKey),
    sentAt: Date.now(),
  };
}

/** Type guard: is this message doc a key-exchange protocol message? */
export function isKeyExchangeMessage(doc: unknown): doc is KeyExchangePayload {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Record<string, unknown>;
  return (
    d['type'] === 'e2ee-key-exchange' &&
    d['version'] === 1 &&
    (d['kind'] === 'key-announce' || d['kind'] === 'key-ack') &&
    typeof d['senderId'] === 'string' &&
    (d['senderId'] as string).length > 0 &&
    typeof d['publicKey'] === 'string' &&
    (d['publicKey'] as string).length > 0 &&
    typeof d['keyId'] === 'string' &&
    /^[0-9a-f]{16}$/.test(d['keyId'] as string) &&
    (d['sentAt'] === undefined || typeof d['sentAt'] === 'number')
  );
}

/**
 * Handle an incoming key-exchange doc. Stores the peer key, derives the
 * chat key, clears the verified mark if the peer key CHANGED, and reports
 * what the caller should do next.
 *
 * Returns:
 *   { status: 'established', shouldAck, safetyNumber, peerKeyId } — peer
 *     key stored; if shouldAck is true (incoming kind was 'key-announce')
 *     the caller should send a 'key-ack' with its own public key back.
 *   { status: 'ignored-self' } — our own echo; ignore.
 *   { status: 'invalid' } — malformed doc; ignore.
 */
export async function handleIncomingKeyExchange(
  doc: unknown,
  chatId: string,
  ownUserId: string,
): Promise<
  | {
      status: 'established';
      shouldAck: boolean;
      safetyNumber: string;
      peerKeyId: string;
      peerKeyChanged: boolean;
    }
  | { status: 'ignored-self' | 'invalid' }
> {
  if (!isKeyExchangeMessage(doc)) return { status: 'invalid' };
  if (doc.senderId === ownUserId) return { status: 'ignored-self' };
  if (typeof chatId !== 'string' || chatId.length === 0) return { status: 'invalid' };

  // PEHLE validate karo, PHIR store karo: key importable honi chahiye aur
  // doc.keyId usi key ka fingerprint hona chahiye. Warna ek kachra/attacker
  // doc purani sahi peer key ko overwrite karke chats ko tod deta.
  try {
    await importPeerPublicKey(doc.publicKey);
    if ((await shortFingerprint(doc.publicKey)) !== doc.keyId) {
      return { status: 'invalid' };
    }
  } catch {
    return { status: 'invalid' };
  }

  const previous = await getPeerPublicKey(chatId, ownUserId);
  const peerKeyChanged = previous ? previous.publicKey !== doc.publicKey : false;
  await storePeerPublicKey(chatId, doc.senderId, doc.publicKey, ownUserId);

  if (peerKeyChanged) {
    // Key changed under us: re-install or MITM. Force re-verification.
    clearVerified(chatId, ownUserId);
    // Wave-2 C3 (Settings #16b — security notifications): WA alerts
    // when a contact's security code changes. The alert is raised here
    // — the one place every key-exchange pass flows through (ChatScreen
    // snapshot, ChatList discovery probe, foreground watcher) — and only
    // when the Account toggle is on. Best-effort and wrapped: a
    // localStorage/event failure must never break key exchange.
    try {
      if (getSecurityNotificationsEnabled()) {
        recordSecurityCodeChange(chatId, doc.senderId, doc.keyId);
      }
    } catch {
      // Alert failed; the key itself is already stored above.
    }
  }

  const established = await establishChatKey(chatId, ownUserId);
  if (!established) return { status: 'invalid' };
  return {
    status: 'established',
    shouldAck: doc.kind === 'key-announce',
    safetyNumber: established.safetyNumber,
    peerKeyId: established.peerKeyId,
    peerKeyChanged,
  };
}

// ---------------------------------------------------------------------------
// Verification marks (safety-number comparison, local only)
// ---------------------------------------------------------------------------

/** Has the user confirmed the safety number matches the peer out-of-band? */
export function isVerified(chatId: string, ownerUid?: string): boolean {
  try {
    const owner = resolveOwnerUid(ownerUid);
    if (!owner) return false;
    return localStorage.getItem(verifiedKey(chatId, owner)) === '1';
  } catch {
    return false;
  }
}

/** Mark this chat verified (user compared the 60-digit numbers in person / call). */
export function markVerified(chatId: string, ownerUid?: string): void {
  try {
    const owner = resolveOwnerUid(ownerUid);
    if (!owner) return;
    localStorage.setItem(verifiedKey(chatId, owner), '1');
  } catch (err) {
    // Private mode etc. — verification simply won't persist.
    console.warn("[keyExchange] markVerified: localStorage.setItem(verifiedKey(chatId), '1') fa...", err);
  }
}

/** Clear the verified mark (peer key changed, or user taps "numbers don't match"). */
export function clearVerified(chatId: string, ownerUid?: string): void {
  try {
    const owner = resolveOwnerUid(ownerUid);
    if (!owner) return;
    localStorage.removeItem(verifiedKey(chatId, owner));
  } catch (err) {
    // ignore
    console.warn("[keyExchange] clearVerified: localStorage.removeItem(verifiedKey(chatId)) failed", err);
  }
}

// ---------------------------------------------------------------------------
// Rotation + wipe
// ---------------------------------------------------------------------------

/**
 * Rotate this device's identity keypair (e.g. user taps "Reset encryption"
 * after a "numbers don't match"). Old chat keys can no longer be derived —
 * peers must re-exchange. Also clears all stored peer keys + verified marks
 * for the given chats (pass every chat id the device knows, or omit to
 * clear only the identity and let per-chat peer keys be overwritten by
 * fresh announces).
 */
export async function rotateIdentityKeyPair(chatIds: string[] = [], ownerUid?: string): Promise<CryptoKeyPair> {
  // PEHLE nayi key generate karo, PHIR purani hatao — ulta karne se agar
  // generate fail ho to device ki identity hamesha ke liye kho jati.
  const pair = await generateIdentityKeyPair();
  await idbDelete(STORE_IDENTITY, IDENTITY_KEY_ID);
  await idbPut(STORE_IDENTITY, IDENTITY_KEY_ID, pair);
  // In-memory dedup cache bhi nayi key par le jao — warna getOrCreate
  // purani (ab delete hui) key deta rehta.
  identityPromise = Promise.resolve(pair);
  // Purani identity se derive ki hui chat keys ab kabhi dobara derive
  // nahi ho sakti — unse encrypt kiye purane messages unreadable ho
  // jayenge (ciphertext rehta hai, placeholder dikhega). Ye identity
  // reset ki jaani-pehchani keemat hai; UI copy me likhi hai.
  clearDerivedKeyCache();
  // Worker A: rotating OUR identity changes every chat's derived key, so
  // every memoized decrypt result is stale — bump the global epoch.
  peerKeyEpoch += 1;
  emitPeerKeyChanged(null);
  for (const chatId of chatIds) {
    // W5c: only this owner's scoped peer key + verified mark are cleared;
    // another account's keys for the same chat are untouched. Without an
    // owner, fall back to the legacy unscoped row (pre-scoping installs).
    if (ownerUid) {
      await deletePeerKey(chatId, ownerUid);
    } else {
      await idbDelete(STORE_PEERS, chatId);
      clearVerified(chatId);
    }
    // FIX 1C (one-way messaging): rotating our identity means the next
    // announce must go out immediately — clear the announce throttle so
    // the 24h block from the old key cannot silence the re-announce.
    resetKeyAnnounceThrottle(chatId);
  }
  return pair;
}

/**
 * Delete ALL E2EE key material on this device (delete-account flow).
 * Isme identity + peer keys ke saath keys.ts ki per-chat symmetric keys
 * bhi mit ti hain — pehle sirf identity/peer mit te the aur chat keys
 * reh jati thi. Best-effort hai: ek store fail ho to bhi baaki mit te hain.
 * LIMIT: localStorage wale verified marks per-chat hain aur unki list
 * kahin nahi rakhi — isliye wo sirf un chats ke liye mit te hain jinki
 * ids pata hon (rotateIdentityKeyPair dekho); bache hue marks harmless
 * hain (key wapas exchange hone par hi dobara set hote hain).
 */
export async function clearAllE2EEKeys(): Promise<void> {
  const errors: unknown[] = [];
  try {
    await idbDelete(STORE_IDENTITY, IDENTITY_KEY_ID);
  } catch (e) {
    errors.push(e);
  }
  identityPromise = null;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE_PEERS, 'readwrite').objectStore(STORE_PEERS).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('Failed to clear peer keys'));
    });
  } catch (e) {
    errors.push(e);
  }
  // W16 (#183): group member public keys + group sender keys are key
  // material too — a delete-account wipe that left them would leave
  // group messages decryptable on this device.
  for (const store of [STORE_GROUP_MEMBER_KEYS, STORE_GROUP_SENDER_KEYS]) {
    try {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const req = db.transaction(store, 'readwrite').objectStore(store).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error(`Failed to clear ${store}`));
      });
    } catch (e) {
      errors.push(e);
    }
  }
  groupKeyEpoch += 1;
  emitGroupKeyChanged(null);
  try {
    await eraseAllKeys();
  } catch (e) {
    errors.push(e);
  }
  clearKeyCache();
  clearDerivedKeyCache();
  // Worker A: all key material is gone — every memoized decrypt result
  // is stale. Bump the epoch so readers re-decrypt (or re-fail) instead
  // of serving pre-wipe plaintext.
  peerKeyEpoch += 1;
  emitPeerKeyChanged(null);
  if (errors.length > 0) {
    throw new Error(
      `E2EE: failed to clear some key stores (${errors.length} error(s)); some key material may remain`,
    );
  }
}

// ---------------------------------------------------------------------------
// Key re-request (Worker A — decrypt-failed retry action)
// ---------------------------------------------------------------------------

/**
 * localStorage key for the "announced once per 24h" throttle (ChatScreen's
 * mount effect). The retry action clears it so a manual re-request is
 * never blocked by the throttle.
 */
export function getKeyAnnounceThrottleKey(chatId: string): string {
  return `pinglo-e2ee-announced:${chatId}`;
}

/** Clear the announce throttle so the next announce is sent immediately.
 * FIX 1B/1C: the throttle key is now per-keyId
 * (`pinglo-e2ee-announced:${chatId}:${keyId}`), so clear every key for
 * this chat — the legacy bare key and any per-keyId keys — otherwise a
 * manual retry / rotation could still be blocked by a stale entry. */
export function resetKeyAnnounceThrottle(chatId: string): void {
  try {
    const prefix = `pinglo-e2ee-announced:${chatId}`;
    localStorage.removeItem(prefix);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix + ':')) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch (err) {
    // Private mode etc. — the throttle simply won't clear.
    console.warn("[keyExchange] resetKeyAnnounceThrottle: localStorage.removeItem(getKeyAnnounc...", err);
  }
}

// ---------------------------------------------------------------------------
// Durable key-exchange dedup (Worker D — R2 flood fix)
// ---------------------------------------------------------------------------
// The snapshot effect re-delivers every protocol doc on each 3s poll /
// remount, and the old in-memory `processedKxRef` set reset on remount
// and was only marked AFTER the slow async handle finished — concurrent
// snapshot loops re-processed the same announce many times, and every
// re-processed announce emitted another key-ack write (613 docs in one
// DM). These helpers persist the dedup state in the same `pinglo-e2ee`
// IndexedDB (v2 stores above) so it survives remounts, reloads and
// fresh contexts on the same device. Every helper is best-effort and
// never throws: a failed dedup read/write must never break sending —
// the in-memory sets in ChatScreen stay the first line of defence.

// #223/#232 follow-up (W5b R11): the dedup keys are scoped by the OWNER
// uid. The `pinglo-e2ee` IndexedDB is per-ORIGIN (per device / browser
// profile), not per account — two accounts on one device (multi-account,
// or the mock two-account probe sharing one Chrome profile) share it.
// Unscoped keys let account A's own-echo mark (`processed`, step 1 of
// the runner) suppress account B's handling of the SAME announce doc
// forever: B's runner loads the key, sees `processedSet.has(dedupKey)`
// and skips — no ack, ever — while A waits forever. That is the P0-8
// deadlock wearing the flood fix's clothes. Old unscoped keys already
// stored are simply ignored by the new prefix filter (orphaned,
// harmless); no migration is needed because the runner re-handles any
// doc it has no scoped mark for.
function processedKxKey(ownerUid: string, chatId: string, docId: string, keyId: string): string {
  return `${ownerUid}:${chatId}:${docId}:${keyId || ''}`;
}

function ackedKxKey(ownerUid: string, chatId: string, senderId: string, keyId: string): string {
  return `${ownerUid}:${chatId}:${senderId}:${keyId || ''}`;
}

async function idbGetAllKeys(store: string): Promise<string[]> {
  try {
    const db = await openDb();
    return await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
      req.onsuccess = () => resolve(((req.result as unknown[]) || []).map(String));
      req.onerror = () => reject(req.error ?? new Error('E2EE dedup list read failed'));
    });
  } catch {
    return [];
  }
}

/** All durable processed-protocol-doc keys for one chat + owner (for the in-memory set). */
export async function loadProcessedKxKeys(chatId: string, ownerUid: string): Promise<Set<string>> {
  const keys = await idbGetAllKeys(STORE_PROCESSED_KX);
  return new Set(keys.filter((k) => k.startsWith(`${ownerUid}:${chatId}:`)));
}

/** Record a protocol doc as processed (durable). Never throws. */
export async function markProcessedKx(chatId: string, docId: string, keyId: string, ownerUid: string): Promise<void> {
  try {
    await idbPut(STORE_PROCESSED_KX, processedKxKey(ownerUid, chatId, docId, keyId), { at: Date.now() });
  } catch (err) {
    // Dedup is best-effort; the in-memory set still guards this session.
    console.warn("[keyExchange] markProcessedKx: await idbPut(STORE_PROCESSED_KX, processedKxKe...", err);
  }
}

/** All durable acked-peer-key keys for one chat + owner (for the in-memory set). */
export async function loadAckedKxKeys(chatId: string, ownerUid: string): Promise<Set<string>> {
  const keys = await idbGetAllKeys(STORE_ACKED_KX);
  return new Set(keys.filter((k) => k.startsWith(`${ownerUid}:${chatId}:`)));
}

/** True when this peer keyId was already acked by this owner (durable). Never throws. */
export async function hasAckedKx(chatId: string, senderId: string, keyId: string, ownerUid: string): Promise<boolean> {
  try {
    return (await idbGet<{ at: number }>(STORE_ACKED_KX, ackedKxKey(ownerUid, chatId, senderId, keyId))) !== undefined;
  } catch {
    return false;
  }
}

/** Record a peer keyId as acked by this owner (durable). Never throws. */
export async function markAckedKx(chatId: string, senderId: string, keyId: string, ownerUid: string): Promise<void> {
  try {
    await idbPut(STORE_ACKED_KX, ackedKxKey(ownerUid, chatId, senderId, keyId), { at: Date.now() });
  } catch (err) {
    // Dedup is best-effort; the in-memory set still guards this session.
    console.warn("[keyExchange] markAckedKx: await idbPut(STORE_ACKED_KX, ackedKxKey(chatId, se...", err);
  }
}

export interface AnnouncedRecord {
  keyId: string;
  at: number;
}

/** Our last durable announce for a chat (null = never announced). Never throws. */
export async function getAnnounced(chatId: string): Promise<AnnouncedRecord | null> {
  try {
    return (await idbGet<AnnouncedRecord>(STORE_ANNOUNCED, chatId)) ?? null;
  } catch {
    return null;
  }
}

/** Record our announce (durable). Never throws. */
export async function markAnnounced(chatId: string, keyId: string): Promise<void> {
  try {
    await idbPut(STORE_ANNOUNCED, chatId, { keyId, at: Date.now() });
  } catch (err) {
    // The localStorage 24h throttle still guards this session.
    console.warn("[keyExchange] markAnnounced: await idbPut(STORE_ANNOUNCED, chatId, { keyId, a...", err);
  }
}

/** Clear our durable announce record (manual re-request / identity rotation). Never throws. */
export async function clearAnnounced(chatId: string): Promise<void> {
  try {
    await idbDelete(STORE_ANNOUNCED, chatId);
  } catch (err) {
    // ignore
    console.warn("[keyExchange] clearAnnounced: await idbDelete(STORE_ANNOUNCED, chatId) failed", err);
  }
}

// ---------------------------------------------------------------------------
// Group E2EE — sender-key design (W16, REPORT-3 #183)
// ---------------------------------------------------------------------------
// 1-to-1 chats agree ONE key per chat (ECDH between the two members).
// A group has no single peer, so each member instead owns ONE sender key
// per group: a random AES-256-GCM key that encrypts THAT member's own
// messages in the group (Signal's sender-key idea, without the ratchet).
//
// How a sender key reaches the other members — all inside the existing
// group messages collection, no new collection, no server help:
//   1. Every member posts a `group-member-announce` doc carrying their
//      ECDH public key (same SPKI base64 as the 1-to-1 announce).
//   2. A sender wraps (AES-GCM-encrypts) their sender key once per
//      member, under a pairwise ECDH key derived from their own private
//      key + that member's announced public key (HKDF info bound to
//      group + sender + recipient), and posts one `group-sender-key`
//      doc per member. The wire carries only public keys + ciphertext.
//   3. A recipient derives the same pairwise key (own private + sender's
//      announced public key), unwraps their copy, and stores the sender
//      key. The ciphertext of old messages stays in the collection, so a
//      member who receives the key late can still decrypt earlier
//      messages (same heal-as-1:1 behaviour).
//
// HONEST LIMITS (same class as the 1-to-1 limits above):
// - No forward secrecy / ratchet: one long-lived sender key per member
//   per group (one previous generation kept for decryption).
// - No server authentication of public keys: a substituted announce is
//   only caught if members verify safety numbers out-of-band (the group
//   sheet has no per-member safety-number UI yet).
// - A member who LEAVES the group keeps the sender keys they already
//   hold, so they can still decrypt messages sent after they left until
//   every sender rotates their sender key. Rotating on removal is NOT
//   implemented in v1 — the UI must not claim removed members are
//   locked out. (Identity rotation DOES rotate the own sender key.)
// - A member who has never opened the group has never announced, so
//   nobody can wrap a sender key for them: they see "couldn't decrypt"
//   until they open the group (their announce triggers distribution)
//   AND a sender is online with the group open to distribute. The
//   message itself is still encrypted — never plaintext.
// - Only text / caption / quoted reply / edit history are encrypted,
//   same as 1-to-1. Media bytes, polls, locations, contacts stay
//   plaintext (see e2eeChat.ts).
// - Fail-closed, same as 1-to-1: if the group sender key cannot be
//   created/used, the message is NOT sent (EncryptionFailedError in
//   e2eeChat.ts). There is no plaintext fallback for groups anymore.

/** Wire format of a group key-exchange doc in the group messages collection. */
export interface GroupKeyExchangePayload {
  /** Protocol version. Bump on any incompatible wire change. */
  version: 1;
  /** Message type discriminator — never rendered as a chat bubble. */
  type: 'e2ee-group-key';
  kind: 'group-member-announce' | 'group-sender-key';
  /** UID of the sender (the member announcing / distributing). */
  senderId: string;
  /** group-sender-key only: the member this wrapped key is for. */
  recipientId?: string;
  /** group-member-announce only: sender's ECDH P-256 public key, SPKI DER, base64. */
  publicKey?: string;
  /** Announce: short fingerprint of publicKey. Sender-key: sender-key id. */
  keyId: string;
  /** group-sender-key only: the sender key (raw 32 bytes, base64) wrapped
   * under the pairwise ECDH key — an E1 EncryptedEnvelope. */
  encryptedKey?: EncryptedEnvelope;
  /** Client timestamp (ms). Ordering only — NOT trusted for security. */
  sentAt: number;
}

export type GroupKeyExchangeKind = GroupKeyExchangePayload['kind'];

/** Stored group-member public key (one per member per group). */
export interface StoredGroupMemberKey {
  groupId: string;
  memberId: string;
  publicKey: string; // base64 SPKI
  keyId: string; // short fingerprint
  receivedAt: number;
}

/** Stored per-sender group key (one per sender per group, + 1 previous). */
export interface StoredGroupSenderKey {
  groupId: string;
  senderId: string;
  keyId: string; // first 16 hex of SHA-256(raw key bytes)
  key: CryptoKey; // AES-256-GCM; extractable ONLY for the own sender key
  previousKey?: CryptoKey;
  previousKeyId?: string;
  receivedAt: number;
  /** Own sender key only: identity fingerprint it was created under.
   * A mismatch (identity rotated) forces a rotation on next use. */
  announceKeyId?: string;
}

/** HKDF info binding for a wrapped group sender key. Both sides must
 * compute the identical string: senderId is the key owner, recipientId
 * the member the wrapped copy is for. */
export function groupWrappingKeyBinding(
  groupId: string,
  senderId: string,
  recipientId: string,
): string {
  return `pinglo-group-key-v1:${groupId}:${senderId}:${recipientId}`;
}

/** Short id of a raw 32-byte sender key: first 16 hex of its SHA-256. */
export async function fingerprintSenderKey(rawKey: Uint8Array): Promise<string> {
  requireWebCrypto();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    rawKey.buffer.slice(rawKey.byteOffset, rawKey.byteOffset + rawKey.byteLength),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Group-key generation tracking (decrypt-memo invalidation, mirrors  */
/* the peer-key generation above). A stored/rotated group sender key  */
/* can make previously undecryptable messages decryptable, so the     */
/* database layer's decrypt memo is keyed on this generation too.     */
/* ------------------------------------------------------------------ */

let groupKeyEpoch = 0;
const groupKeyGenerationByChat = new Map<string, number>();
type GroupKeyChangeListener = (chatId: string | null) => void;
const groupKeyChangeListeners = new Set<GroupKeyChangeListener>();

/** Sync token for "which group-key generation does this group have now". */
export function getGroupKeyGeneration(chatId: string): string {
  return `${groupKeyEpoch}:${groupKeyGenerationByChat.get(chatId) ?? 0}`;
}

/** Subscribe to group sender-key changes. `chatId === null` = every group. */
export function onGroupKeyChanged(listener: GroupKeyChangeListener): () => void {
  groupKeyChangeListeners.add(listener);
  return () => {
    groupKeyChangeListeners.delete(listener);
  };
}

function emitGroupKeyChanged(chatId: string | null): void {
  for (const listener of [...groupKeyChangeListeners]) {
    try {
      listener(chatId);
    } catch (err) {
      console.warn('[keyExchange] emitGroupKeyChanged: listener(chatId) failed', err);
    }
  }
}

function bumpGroupKeyGeneration(chatId: string): void {
  groupKeyGenerationByChat.set(chatId, (groupKeyGenerationByChat.get(chatId) ?? 0) + 1);
  emitGroupKeyChanged(chatId);
}

/* ------------------------------------------------------------------ */
/* Group member public keys                                            */
/* ------------------------------------------------------------------ */

function groupMemberKeyId(groupId: string, memberId: string): string {
  return `${groupId}:${memberId}`;
}

/** Store a member's announced public key (validated first — a bad key
 * must never overwrite a good one). Returns the stored record. */
export async function storeGroupMemberKey(
  groupId: string,
  memberId: string,
  publicKeyB64: string,
): Promise<StoredGroupMemberKey> {
  if (!groupId || !memberId) {
    throw new Error('E2EE group: storeGroupMemberKey needs a groupId and memberId');
  }
  await importPeerPublicKey(publicKeyB64);
  const record: StoredGroupMemberKey = {
    groupId,
    memberId,
    publicKey: publicKeyB64,
    keyId: await shortFingerprint(publicKeyB64),
    receivedAt: Date.now(),
  };
  await idbPut(STORE_GROUP_MEMBER_KEYS, groupMemberKeyId(groupId, memberId), record);
  return record;
}

export async function getGroupMemberKey(
  groupId: string,
  memberId: string,
): Promise<StoredGroupMemberKey | null> {
  return (
    (await idbGet<StoredGroupMemberKey>(
      STORE_GROUP_MEMBER_KEYS,
      groupMemberKeyId(groupId, memberId),
    )) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Group sender keys                                                   */
/* ------------------------------------------------------------------ */

function groupSenderKeyId(groupId: string, senderId: string): string {
  return `${groupId}:${senderId}`;
}

export async function getGroupSenderKey(
  groupId: string,
  senderId: string,
): Promise<StoredGroupSenderKey | null> {
  return (
    (await idbGet<StoredGroupSenderKey>(
      STORE_GROUP_SENDER_KEYS,
      groupSenderKeyId(groupId, senderId),
    )) ?? null
  );
}

async function putGroupSenderKey(record: StoredGroupSenderKey): Promise<void> {
  await idbPut(
    STORE_GROUP_SENDER_KEYS,
    groupSenderKeyId(record.groupId, record.senderId),
    record,
  );
  bumpGroupKeyGeneration(record.groupId);
}

/**
 * This device's own sender key for a group: load it, or generate + store
 * one (random 32 bytes, extractable so it can be wrapped for members).
 * Rotates when the identity key changed since the key was created (the
 * stored `announceKeyId` no longer matches this device's fingerprint):
 * the old key is kept one generation so messages sent with it still
 * decrypt. Never throws for a missing key — only for WebCrypto/IDB
 * failure, in which case the caller must fail closed.
 */
export async function getOrCreateOwnGroupSenderKey(
  groupId: string,
  ownUid: string,
): Promise<StoredGroupSenderKey> {
  if (!groupId || !ownUid) {
    throw new Error('E2EE group: getOrCreateOwnGroupSenderKey needs a groupId and ownUid');
  }
  const identity = await getOrCreateIdentityKeyPair();
  const ownFingerprint = await shortFingerprint(
    await exportPublicKeyBase64(identity.publicKey),
  );
  const existing = await getGroupSenderKey(groupId, ownUid);
  if (existing && existing.announceKeyId === ownFingerprint) return existing;
  const raw = randomBytes(32);
  const key = await importAesKey(raw, true);
  const keyId = await fingerprintSenderKey(raw);
  const record: StoredGroupSenderKey = {
    groupId,
    senderId: ownUid,
    keyId,
    key,
    ...(existing
      ? { previousKey: existing.key, previousKeyId: existing.keyId }
      : {}),
    receivedAt: Date.now(),
    announceKeyId: ownFingerprint,
  };
  await putGroupSenderKey(record);
  return record;
}

/** Raw bytes (base64) of this device's own sender key, for wrapping.
 * Throws when no own key exists yet (call getOrCreate first). */
export async function exportOwnGroupSenderKeyRawFor(
  groupId: string,
  ownUid: string,
): Promise<string> {
  const record = await getGroupSenderKey(groupId, ownUid);
  if (!record) {
    throw new Error('E2EE group: no own sender key for this group yet');
  }
  return bytesToBase64(await exportAesKeyRaw(record.key));
}

/**
 * Decryption keys for one sender's messages in a group: the current
 * sender key first, then the previous generation (sender rotated). The
 * envelope `kid` picks the matching generation first when it names the
 * previous key. Empty when this device holds no key for that sender.
 */
export async function getGroupSenderKeysForDecrypt(
  groupId: string,
  senderId: string,
  envelopeKeyId?: string,
): Promise<CryptoKey[]> {
  if (!groupId || !senderId) return [];
  try {
    const record = await getGroupSenderKey(groupId, senderId);
    if (!record) return [];
    const keys: CryptoKey[] = [];
    if (envelopeKeyId && record.previousKeyId === envelopeKeyId && record.previousKey) {
      keys.push(record.previousKey);
      keys.push(record.key);
    } else {
      keys.push(record.key);
      if (record.previousKey) keys.push(record.previousKey);
    }
    return keys;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Group key-exchange protocol docs                                    */
/* ------------------------------------------------------------------ */

/** Build a member-announce doc (my public key, for the group channel). */
export async function buildGroupMemberAnnounce(
  groupId: string,
  senderId: string,
  ownPublicKey: CryptoKey,
): Promise<GroupKeyExchangePayload> {
  if (!senderId) throw new Error('E2EE group: senderId must be a non-empty string');
  if (!ownPublicKey || typeof ownPublicKey !== 'object') {
    throw new Error('E2EE group: ownPublicKey must be a CryptoKey');
  }
  const publicKey = await exportPublicKeyBase64(ownPublicKey);
  return {
    version: 1,
    type: 'e2ee-group-key',
    kind: 'group-member-announce',
    senderId,
    publicKey,
    keyId: await shortFingerprint(publicKey),
    sentAt: Date.now(),
  };
}

/**
 * Build a sender-key doc for ONE member: wrap the raw sender key
 * (base64) under the pairwise ECDH key derived from my private key +
 * the member's announced public key. The wrapping key is bound to this
 * group + sender + recipient, so the same pair of users in another
 * group gets a different wrapping key.
 */
export async function buildGroupSenderKeyDoc(
  groupId: string,
  senderId: string,
  recipientId: string,
  recipientPublicKeyB64: string,
  ownPrivateKey: CryptoKey,
  senderKeyRawB64: string,
  senderKeyId: string,
): Promise<GroupKeyExchangePayload> {
  if (!groupId || !senderId || !recipientId) {
    throw new Error('E2EE group: buildGroupSenderKeyDoc needs groupId, senderId and recipientId');
  }
  if (!senderKeyId || !/^[0-9a-f]{16}$/.test(senderKeyId)) {
    throw new Error('E2EE group: senderKeyId must be a 16-hex fingerprint');
  }
  let raw: Uint8Array;
  try {
    raw = base64ToBytes(senderKeyRawB64);
  } catch {
    throw new Error('E2EE group: sender key must be base64 of 32 raw bytes');
  }
  if (raw.length !== 32) {
    throw new Error('E2EE group: sender key must be 32 raw bytes');
  }
  const recipientPublicKey = await importPeerPublicKey(recipientPublicKeyB64);
  const wrappingKey = await deriveChatKey(
    ownPrivateKey,
    recipientPublicKey,
    groupWrappingKeyBinding(groupId, senderId, recipientId),
  );
  const encryptedKey = await encryptText(senderKeyRawB64, wrappingKey, senderKeyId);
  return {
    version: 1,
    type: 'e2ee-group-key',
    kind: 'group-sender-key',
    senderId,
    recipientId,
    keyId: senderKeyId,
    encryptedKey,
    sentAt: Date.now(),
  };
}

/** Type guard: is this message doc a group key-exchange protocol doc? */
export function isGroupKeyExchangeMessage(doc: unknown): doc is GroupKeyExchangePayload {
  if (!doc || typeof doc !== 'object') return false;
  const d = doc as Record<string, unknown>;
  if (d['type'] !== 'e2ee-group-key' || d['version'] !== 1) return false;
  if (d['kind'] === 'group-member-announce') {
    return (
      typeof d['senderId'] === 'string' &&
      (d['senderId'] as string).length > 0 &&
      typeof d['publicKey'] === 'string' &&
      (d['publicKey'] as string).length > 0 &&
      typeof d['keyId'] === 'string' &&
      /^[0-9a-f]{16}$/.test(d['keyId'] as string)
    );
  }
  if (d['kind'] === 'group-sender-key') {
    return (
      typeof d['senderId'] === 'string' &&
      (d['senderId'] as string).length > 0 &&
      typeof d['recipientId'] === 'string' &&
      (d['recipientId'] as string).length > 0 &&
      typeof d['keyId'] === 'string' &&
      /^[0-9a-f]{16}$/.test(d['keyId'] as string) &&
      isEncryptedEnvelope(d['encryptedKey'])
    );
  }
  return false;
}

/**
 * Handle an incoming group key-exchange doc. Stores the member key or
 * the unwrapped sender key; never renders a bubble (callers filter
 * these docs out of the message list, like the 1-to-1 protocol docs).
 *
 * Returns:
 *   { status: 'member-announce', memberId } — member key stored; the
 *     caller should distribute its own sender key to this member.
 *   { status: 'sender-key-stored', senderId } — sender key stored; the
 *     caller should drop cached decrypt failures for this group.
 *   { status: 'ignored-self' } — our own echo; ignore.
 *   { status: 'not-for-me' } — a sender-key doc addressed to someone else.
 *   { status: 'invalid' } — malformed doc; ignore (terminal: never retry).
 *   { status: 'deferred' } — a sender-key doc whose sender hasn't
 *     announced their public key yet; the caller must NOT mark it
 *     processed, so the next snapshot retries it once the announce
 *     arrives.
 */
export async function handleIncomingGroupKeyDoc(
  doc: unknown,
  groupId: string,
  ownUserId: string,
): Promise<
  | { status: 'member-announce'; memberId: string; keyChanged: boolean }
  | { status: 'sender-key-stored'; senderId: string }
  | { status: 'ignored-self' | 'not-for-me' | 'invalid' }
  | { status: 'deferred'; reason: 'no-member-key' }
> {
  if (!isGroupKeyExchangeMessage(doc)) return { status: 'invalid' };
  if (doc.senderId === ownUserId) return { status: 'ignored-self' };
  if (typeof groupId !== 'string' || groupId.length === 0) return { status: 'invalid' };

  if (doc.kind === 'group-member-announce') {
    // Validate BEFORE storing: importable key + fingerprint match, same
    // as the 1-to-1 handler — a junk/attacker doc must never overwrite
    // a good member key.
    try {
      await importPeerPublicKey(doc.publicKey as string);
      if ((await shortFingerprint(doc.publicKey as string)) !== doc.keyId) {
        return { status: 'invalid' };
      }
    } catch {
      return { status: 'invalid' };
    }
    const previous = await getGroupMemberKey(groupId, doc.senderId);
    const keyChanged = previous ? previous.publicKey !== doc.publicKey : false;
    await storeGroupMemberKey(groupId, doc.senderId, doc.publicKey as string);
    return { status: 'member-announce', memberId: doc.senderId, keyChanged };
  }

  // group-sender-key
  if (doc.recipientId !== ownUserId) return { status: 'not-for-me' };
  const senderMemberKey = await getGroupMemberKey(groupId, doc.senderId);
  if (!senderMemberKey) return { status: 'deferred', reason: 'no-member-key' };
  try {
    const identity = await getOrCreateIdentityKeyPair();
    const senderPublicKey = await importPeerPublicKey(senderMemberKey.publicKey);
    const wrappingKey = await deriveChatKey(
      identity.privateKey,
      senderPublicKey,
      groupWrappingKeyBinding(groupId, doc.senderId, ownUserId),
    );
    const rawB64 = await decryptText(doc.encryptedKey as EncryptedEnvelope, wrappingKey);
    const raw = base64ToBytes(rawB64);
    if (raw.length !== 32) return { status: 'invalid' };
    const key = await importAesKey(raw, false);
    const keyId = await fingerprintSenderKey(raw);
    if (keyId !== doc.keyId) return { status: 'invalid' };
    const existing = await getGroupSenderKey(groupId, doc.senderId);
    const record: StoredGroupSenderKey = {
      groupId,
      senderId: doc.senderId,
      keyId,
      key,
      ...(existing && existing.keyId !== keyId
        ? { previousKey: existing.key, previousKeyId: existing.keyId }
        : existing?.previousKey
          ? { previousKey: existing.previousKey, previousKeyId: existing.previousKeyId }
          : {}),
      receivedAt: Date.now(),
    };
    await putGroupSenderKey(record);
    return { status: 'sender-key-stored', senderId: doc.senderId };
  } catch {
    // GCM auth failure (wrong wrapping key / tampered envelope) or a
    // malformed payload: terminal, never retry this doc.
    return { status: 'invalid' };
  }
}

/** Delete one group's exchanged keys (per-group "reset encryption"). */
export async function deleteGroupKeys(groupId: string): Promise<void> {
  try {
    const db = await openDb();
    for (const store of [STORE_GROUP_MEMBER_KEYS, STORE_GROUP_SENDER_KEYS]) {
      const keys = await new Promise<string[]>((resolve, reject) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
        req.onsuccess = () => resolve(((req.result as unknown[]) || []).map(String));
        req.onerror = () => reject(req.error ?? new Error('E2EE group key list read failed'));
      });
      for (const key of keys.filter((k) => k.startsWith(`${groupId}:`))) {
        await idbDelete(store, key);
      }
    }
  } catch {
    // Best-effort: a failed delete must never break the chat.
  }
  bumpGroupKeyGeneration(groupId);
}
