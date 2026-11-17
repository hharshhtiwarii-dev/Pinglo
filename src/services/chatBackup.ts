/**
 * Chat backup & restore — ROADMAP-2 item 3 (Worker R1C).
 *
 * Phone lost = E2EE history lost. This module is the client side of the
 * encrypted backup: it gathers the local chat history, decrypts it on
 * THIS device (where the keys live), re-encrypts the whole payload under
 * a key derived from the user's passphrase, and stores the encrypted blob
 * in S3 (or, when S3 is not configured, in a local IndexedDB blob store
 * on this device only — reported honestly as `location: 'local'`).
 *
 * ── Design (deliberate, WhatsApp-end-to-end-backup-style) ─────────────
 * The backup does NOT contain the E2EE ciphertext as stored on the
 * server. It contains the DECRYPTED history, re-encrypted under the
 * passphrase key. Why: the E2EE identity private key is created with
 * `extractable: false` (keyExchange.ts) and WebCrypto will not export it
 * — there is no byte form of it to put in a backup. Re-importing the
 * identity key on a new device is therefore impossible from this client
 * alone. Decrypt-then-re-encrypt is the only backup that actually lets a
 * restore show readable history, and it is exactly what WhatsApp's
 * end-to-end encrypted backup does.
 *
 * What IS included, so restores keep working as far as the client can:
 *  - every chat's messages as decrypted on this device (text, caption,
 *    quoted replies, edit history — via decryptMessageDocForRead);
 *  - the legacy per-chat symmetric keys (keys.ts stores them as raw
 *    base64, so they ARE exportable) — old-device messages stay
 *    decryptable after a restore;
 *  - the identity PUBLIC key + fingerprint and all peer public keys, so
 *    a restored device can re-establish chats with a fresh key exchange.
 *
 * What is NOT included (honest limits — also shown in the Settings UI):
 *  - the identity PRIVATE key: `crypto.subtle.exportKey('pkcs8', …)`
 *    throws for a non-extractable key. The backup records
 *    `identity.privateKeyB64: null` + the reason instead of pretending.
 *    A future change to keyExchange.ts (generate the identity keypair
 *    with `extractable: true` and wrap it, or a key-escrow design) is
 *    needed for true cross-device E2EE restore — see PATCH-R1C.md.
 *  - media BYTES: message docs keep their S3 URLs; the media objects
 *    themselves are not copied. If an S3 object is deleted, that media
 *    is gone from the backup too.
 *  - locked chats: excluded, like the account export (Phase 5).
 *  - messages this device cannot decrypt (no key yet / bad key): skipped
 *    and counted as `undecryptableSkipped`, never baked in as the
 *    "Couldn't decrypt this message" placeholder.
 *
 * ── Crypto ─────────────────────────────────────────────────────────────
 * PBKDF2-HMAC-SHA-256, 600,000 iterations, 16-byte random salt → 256-bit
 * AES-256-GCM key; fresh 12-byte random IV per backup. 600k is OWASP's
 * current recommendation for PBKDF2-HMAC-SHA256 (2023 cheat sheet); the
 * salt stops rainbow tables, the iteration count makes passphrase
 * guessing expensive, and GCM authentication makes any tampered byte
 * fail decryption instead of silently producing garbage.
 * The passphrase is NEVER stored, logged, or sent anywhere. Lose it and
 * the backup is unrecoverable — there is no server-side escrow and no
 * reset path. The UI says this in plain words before the first backup.
 *
 * ── Restore limits ─────────────────────────────────────────────────────
 * Restore writes the decrypted messages into the local IndexedDB message
 * cache (`pinglo-cache`, same shape database.ts persists) and refreshes
 * the in-memory collections, so restored chats are readable immediately.
 * On a device with a live backend, the next server re-sync replaces
 * restored docs with the server's ciphertext for the same message ids
 * (database.ts `fetchAll` trusts the server snapshot) — and without the
 * identity key that ciphertext cannot be decrypted there. So: restore is
 * a LOCAL recovery mechanism, not a server-side one. A server-side
 * backup job / key escrow is explicitly out of scope for this worker.
 *
 * ── Storage ────────────────────────────────────────────────────────────
 * S3 path: `backups/<uid>/pinglo-backup-<epoch>.dtbackup`. The bucket
 * must restrict each user to their own `backups/<uid>/` prefix — that is
 * a backend/bucket-policy job, flagged in PATCH-R1C.md, not enforced by
 * this client (the client cannot prove its own prefix to S3).
 * When S3 is not configured (mock/local mode) the blob goes to IndexedDB
 * `pinglo-backup` on this device. The UI labels that "on this device
 * only" — it does not survive losing the phone, which is the whole point
 * of the feature, so the UI pushes the user to connect S3.
 *
 * This file creates NO server state and edits NO other module: it only
 * reads the public APIs of database.ts / e2eeChat.ts / keyExchange.ts /
 * keys.ts and its own IndexedDB stores.
 */

import { uploadData, downloadData, remove } from 'aws-amplify/storage';
import { db } from '../aws/database';
import { auth } from '../aws/auth';
import { getAwsEnvConfig } from '../aws/config';
import { decryptMessageDocForRead, isKeyExchangeDoc } from './e2eeChat';
import {
  getOrCreateIdentityKeyPair,
  exportPublicKeyBase64,
  fingerprintPublicKey,
  listPeerKeys,
} from './e2ee/keyExchange';
import { bytesToBase64, base64ToBytes, randomBytes } from './e2ee/crypto';
import { loadHiddenChatIds } from './lockedChats';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Backup format version — bump when the payload shape changes. */
export const BACKUP_VERSION = 1;
/** OWASP (2023) recommended PBKDF2-HMAC-SHA256 iteration count. */
export const PBKDF2_ITERATIONS = 600_000;
export const PBKDF2_SALT_BYTES = 16;
export const BACKUP_IV_BYTES = 12;
export const MIN_PASSPHRASE_LENGTH = 8;

const META_KEY = 'pinglo_backup_meta';
const LOCAL_BACKUP_DB = 'pinglo-backup';
const LOCAL_BACKUP_STORE = 'blobs';
const CACHE_DB_NAME = 'pinglo-cache';
const CACHE_STORE = 'collections';

/* ------------------------------------------------------------------ */
/* Types + errors                                                      */
/* ------------------------------------------------------------------ */

export type BackupLocation = 's3' | 'local';

export interface BackupMeta {
  key: string;
  location: BackupLocation;
  createdAt: number;
  uid: string;
  chatCount: number;
  messageCount: number;
  undecryptableSkipped: number;
  excludedLockedChats: number;
  sizeBytes: number;
  /** False when the identity private key could not be exported (always, today). */
  identityKeyIncluded: boolean;
}

export interface BackupResult extends BackupMeta {
  /** Human-readable one-liner for the UI toast. */
  summary: string;
}

export interface RestoreResult {
  chatCount: number;
  messageCount: number;
  restoredAt: number;
  fromKey: string;
  fromLocation: BackupLocation;
  identityKeyIncluded: boolean;
  undecryptableSkippedAtExport: number;
  summary: string;
}

export type BackupErrorCode =
  | 'no-user'
  | 'passphrase-too-short'
  | 'no-webcrypto'
  | 'wrong-passphrase'
  | 'corrupt-backup'
  | 'upload-failed'
  | 'download-failed'
  | 'no-backup'
  | 'uid-mismatch'
  | 'empty-backup'
  | 'restore-failed';

export class BackupError extends Error {
  code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function requireWebCrypto(): void {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.subtle === 'undefined' ||
    typeof crypto.getRandomValues === 'undefined'
  ) {
    throw new BackupError(
      'no-webcrypto',
      'This device/browser does not support WebCrypto — backup needs it.',
    );
  }
}

export function validatePassphrase(passphrase: string): string | null {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  return null;
}

function getMeta(): BackupMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.key !== 'string') return null;
    return parsed as BackupMeta;
  } catch {
    return null;
  }
}

function setMeta(meta: BackupMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* intentionally ignored */}
}

export function getLastBackupMeta(): BackupMeta | null {
  return getMeta();
}

function backupS3Key(uid: string): string {
  return `backups/${uid}/pinglo-backup-${Date.now()}.dtbackup`;
}

function backupFileName(key: string): string {
  return key.split('/').pop() || 'pinglo-backup.dtbackup';
}

/* ------------------------------------------------------------------ */
/* IndexedDB helpers (own stores only — database.ts is untouched)      */
/* ------------------------------------------------------------------ */

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB error'));
  });
}

function openDb(name: string, version: number, store: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(store)) {
        req.result.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

/** Read a raw record from the legacy symmetric-key store (keys.ts). */
async function readLegacyChatKeys(): Promise<
  Array<{ chatId: string; keyId: string; keyB64: string; previousKey: { keyId: string; keyB64: string } | null }>
> {
  try {
    const conn = await openDb('pinglo-e2ee-keys', 1, 'chatKeys');
    if (!conn) return [];
    const tx = conn.transaction('chatKeys', 'readonly');
    const all = await idbRequest<any[]>(tx.objectStore('chatKeys').getAll());
    return (all || [])
      .filter((r) => r && typeof r.chatId === 'string' && typeof r.keyB64 === 'string')
      .map((r) => ({
        chatId: r.chatId,
        keyId: String(r.keyId ?? ''),
        keyB64: r.keyB64,
        previousKey:
          r.previousKey && typeof r.previousKey.keyB64 === 'string'
            ? { keyId: String(r.previousKey.keyId ?? ''), keyB64: r.previousKey.keyB64 }
            : null,
      }));
  } catch {
    return [];
  }
}

/**
 * REPORT-3 #68: message collections that exist in the persisted cache
 * (`pinglo-cache`, the same store database.ts restores from) but are
 * NOT in the live in-memory channel set — e.g. a chat whose messages
 * were seeded / restored under a conversation id the chat list never
 * derived, so `db.getAllChatChannels()` never lists it and the backup
 * silently reports "0 message(s)" while history sits on the device.
 * Enumerating the cache keys directly makes the backup cover what is
 * actually on this device, not only what the live channel set knows
 * about. Read-only: it only lists keys, never writes.
 */
async function listCachedMessageChatIds(): Promise<string[]> {
  try {
    const conn = await openDb(CACHE_DB_NAME, 1, CACHE_STORE);
    if (!conn) return [];
    const tx = conn.transaction(CACHE_STORE, 'readonly');
    const keys = await idbRequest<any[]>(tx.objectStore(CACHE_STORE).getAllKeys());
    const ids = new Set<string>();
    for (const k of keys || []) {
      const m = /^chats\/([^/]+)\/messages$/.exec(String(k ?? ''));
      if (m && m[1] && !m[1].startsWith('saved_')) ids.add(m[1]);
    }
    return [...ids];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Passphrase key derivation + envelope                                */
/* ------------------------------------------------------------------ */

async function deriveBackupKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface BackupEnvelope {
  format: 'pinglo-backup';
  v: number;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
}

/** Encrypt a UTF-8 payload string under the passphrase. Returns the envelope bytes. */
export async function encryptBackupBytes(plainText: string, passphrase: string): Promise<Uint8Array> {
  requireWebCrypto();
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const iv = randomBytes(BACKUP_IV_BYTES);
  const key = await deriveBackupKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plainText),
  );
  const envelope: BackupEnvelope = {
    format: 'pinglo-backup',
    v: BACKUP_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct)),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** Decrypt envelope bytes with the passphrase. Wrong passphrase / tampering → BackupError. */
export async function decryptBackupBytes(bytes: Uint8Array, passphrase: string): Promise<string> {
  requireWebCrypto();
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BackupError('corrupt-backup', 'This file is not a Pinglo backup.');
  }
  if (
    !envelope ||
    envelope.format !== 'pinglo-backup' ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ct !== 'string'
  ) {
    throw new BackupError('corrupt-backup', 'This file is not a Pinglo backup.');
  }
  if (envelope.v !== BACKUP_VERSION) {
    throw new BackupError(
      'corrupt-backup',
      `Backup version ${envelope.v} is not supported by this app (supports v${BACKUP_VERSION}).`,
    );
  }
  const iterations = Number(envelope.iterations) || PBKDF2_ITERATIONS;
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ct = base64ToBytes(envelope.ct);
  let plain: ArrayBuffer;
  try {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
      'deriveKey',
    ]);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, ct as BufferSource);
  } catch {
    // GCM authentication failure: wrong passphrase OR tampered bytes. The
    // two are indistinguishable by design — report it as a wrong
    // passphrase (the common case) without claiming which one it was.
    throw new BackupError(
      'wrong-passphrase',
      'Wrong passphrase — or this backup file was damaged. Check the passphrase and try again.',
    );
  }
  return new TextDecoder().decode(plain);
}

/* ------------------------------------------------------------------ */
/* Blob storage: S3 when configured, local IndexedDB otherwise         */
/* ------------------------------------------------------------------ */

async function putLocalBlob(key: string, bytes: Uint8Array): Promise<void> {
  const conn = await openDb(LOCAL_BACKUP_DB, 1, LOCAL_BACKUP_STORE);
  if (!conn) throw new BackupError('upload-failed', 'Local backup storage is unavailable on this device.');
  const tx = conn.transaction(LOCAL_BACKUP_STORE, 'readwrite');
  // Register the completion handler BEFORE awaiting the request: the
  // transaction can complete in the same tick the request succeeds, so
  // attaching oncomplete afterwards can miss it forever (deadlock).
  const done = new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  await idbRequest(tx.objectStore(LOCAL_BACKUP_STORE).put(bytes, key));
  await done;
}

async function getLocalBlob(key: string): Promise<Uint8Array | null> {
  const conn = await openDb(LOCAL_BACKUP_DB, 1, LOCAL_BACKUP_STORE);
  if (!conn) return null;
  const tx = conn.transaction(LOCAL_BACKUP_STORE, 'readonly');
  const val = await idbRequest<any>(tx.objectStore(LOCAL_BACKUP_STORE).get(key));
  if (!val) return null;
  return val instanceof Uint8Array ? val : new Uint8Array(val);
}

async function deleteLocalBlob(key: string): Promise<void> {
  try {
    const conn = await openDb(LOCAL_BACKUP_DB, 1, LOCAL_BACKUP_STORE);
    if (!conn) return;
    const tx = conn.transaction(LOCAL_BACKUP_STORE, 'readwrite');
    await idbRequest(tx.objectStore(LOCAL_BACKUP_STORE).delete(key));
  } catch { /* intentionally ignored */}
}

async function uploadBackupBlob(bytes: Uint8Array, uid: string): Promise<{ key: string; location: BackupLocation }> {
  const cfg = getAwsEnvConfig();
  const key = backupS3Key(uid);
  if (cfg.s3Bucket) {
    // S3 is configured: the blob MUST land there. A failed upload is an
    // error, never a silent local fallback — otherwise the user would
    // believe the backup is in the cloud when it is only on this phone.
    try {
      await uploadData({
        path: key,
        data: new Blob([bytes as unknown as BlobPart]),
        options: { contentType: 'application/octet-stream' },
      }).result;
      return { key, location: 's3' };
    } catch (err) {
      throw new BackupError(
        'upload-failed',
        `Could not upload the backup to S3 (${err instanceof Error ? err.message : 'upload failed'}). Check your connection and try again.`,
      );
    }
  }
  await putLocalBlob(key, bytes);
  return { key, location: 'local' };
}

async function downloadBackupBlob(meta: BackupMeta): Promise<Uint8Array> {
  if (meta.location === 'local') {
    const bytes = await getLocalBlob(meta.key);
    if (!bytes) throw new BackupError('no-backup', 'The saved backup could not be found on this device.');
    return bytes;
  }
  try {
    const out = await downloadData({ path: meta.key }).result;
    const body: any = (out as any).body;
    if (!body) throw new Error('empty download');
    const buf: ArrayBuffer =
      typeof body.arrayBuffer === 'function' ? await body.arrayBuffer() : body;
    return new Uint8Array(buf);
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(
      'download-failed',
      `Could not download the backup from S3 (${err instanceof Error ? err.message : 'download failed'}).`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Collecting the payload                                              */
/* ------------------------------------------------------------------ */

export interface BackupPayload {
  version: number;
  app: 'pinglo';
  exportedAt: number;
  uid: string;
  chats: Array<{
    chatId: string;
    meta: Record<string, unknown> | null;
    messages: Array<Record<string, unknown>>;
  }>;
  counts: { chats: number; messages: number; undecryptableSkipped: number; excludedLockedChats: number };
  keys: {
    identity: {
      publicKeyB64: string | null;
      fingerprint: string | null;
      privateKeyB64: string | null;
      privateKeyMissingReason: string | null;
    };
    legacyChatKeys: Array<{
      chatId: string;
      keyId: string;
      keyB64: string;
      previousKey: { keyId: string; keyB64: string } | null;
    }>;
    peerPublicKeys: Array<Record<string, unknown>>;
  };
  notes: string[];
}

async function collectBackupPayload(uid: string): Promise<BackupPayload> {
  const hidden = new Set(await loadHiddenChatIds(uid).catch(() => [] as string[]));
  const channels = db.getAllChatChannels().filter((cid) => !hidden.has(cid));
  const savedChannel = `saved_${uid}`;

  // Chat metadata (names, participants) from the 'chats' collection.
  const chatMetaById = new Map<string, any>();
  try {
    await db.ensure('chats');
    for (const doc of db.getCollectionDocs('chats') || []) {
      if (doc && typeof doc.id === 'string') chatMetaById.set(doc.id, doc);
    }
  } catch { /* intentionally ignored */}

  const chats: BackupPayload['chats'] = [];
  let messageCount = 0;
  let undecryptableSkipped = 0;

  const collectChannel = async (chatId: string) => {
    const col = `chats/${chatId}/messages`;
    try {
      await db.ensure(col);
    } catch { /* intentionally ignored */}
    const rawDocs = db.getCollectionDocs(col) || [];
    const messages: Array<Record<string, unknown>> = [];
    for (const doc of rawDocs) {
      if (!doc || typeof doc !== 'object') continue;
      if (isKeyExchangeDoc(doc as any)) continue; // protocol docs, not history
      let plain: any;
      try {
        plain = await decryptMessageDocForRead(col, doc as any, uid);
      } catch {
        continue;
      }
      // A message this device cannot decrypt must not be baked in as the
      // "Couldn't decrypt" placeholder — skip it and count it honestly.
      if (plain && (plain.encryption === 'decrypt-failed' || plain.decryptFailureReason)) {
        undecryptableSkipped += 1;
        continue;
      }
      const { id: plainId, ...rest } = plain as any;
      messages.push({ id: plainId ?? (doc as any).id, ...rest });
    }
    messages.sort((a, b) => Number((a as any).timestamp ?? 0) - Number((b as any).timestamp ?? 0));
    messageCount += messages.length;
    chats.push({
      chatId,
      meta: (chatMetaById.get(chatId) as Record<string, unknown> | undefined) ?? null,
      messages,
    });
  };

  for (const cid of channels) await collectChannel(cid);
  // REPORT-3 #68: also collect message collections that exist in the
  // persisted cache but never made it into the live channel set (see
  // listCachedMessageChatIds) — otherwise their history is silently
  // left out of the backup as "0 message(s)".
  const collected = new Set(channels);
  for (const cid of await listCachedMessageChatIds()) {
    if (hidden.has(cid) || collected.has(cid)) continue;
    collected.add(cid);
    await collectChannel(cid);
  }
  // Saved Messages is a chat too (top of the list) — back it up as well.
  if (!hidden.has(savedChannel)) {
    try {
      await collectChannel(savedChannel);
    } catch { /* intentionally ignored */}
  }

  // ── Keys ────────────────────────────────────────────────────────────
  let identityPublicKeyB64: string | null = null;
  let identityFingerprint: string | null = null;
  let privateKeyMissingReason: string | null;
  try {
    const pair = await getOrCreateIdentityKeyPair();
    identityPublicKeyB64 = await exportPublicKeyBase64(pair.publicKey);
    try {
      identityFingerprint = await fingerprintPublicKey(identityPublicKeyB64);
    } catch {
      identityFingerprint = null;
    }
    try {
      // Expected to throw: the identity key is non-extractable by design.
      await crypto.subtle.exportKey('pkcs8', pair.privateKey);
      privateKeyMissingReason = null; // unreachable today — kept for honesty if generation ever changes
    } catch {
      privateKeyMissingReason =
        'Identity private key is non-extractable (generated with extractable:false). ' +
        'It cannot be exported by the browser, so it is NOT in this backup. ' +
        'Restored history stays readable as the decrypted copy in this backup; ' +
        'new chats re-exchange keys after restore.';
    }
  } catch (err) {
    privateKeyMissingReason = `Identity key could not be loaded (${err instanceof Error ? err.message : 'unknown error'}).`;
  }

  let peerPublicKeys: Array<Record<string, unknown>> = [];
  try {
    peerPublicKeys = (await listPeerKeys(uid)).map((p: any) => ({
      chatId: p.chatId,
      peerUid: p.peerUid ?? p.peerId ?? null,
      publicKeyB64: p.publicKeyB64 ?? p.publicKey ?? null,
    }));
  } catch { /* intentionally ignored */}

  const legacyChatKeys = await readLegacyChatKeys();

  return {
    version: BACKUP_VERSION,
    app: 'pinglo',
    exportedAt: Date.now(),
    uid,
    chats,
    counts: {
      chats: chats.length,
      messages: messageCount,
      undecryptableSkipped,
      excludedLockedChats: hidden.size,
    },
    keys: {
      identity: {
        publicKeyB64: identityPublicKeyB64,
        fingerprint: identityFingerprint,
        privateKeyB64: null,
        privateKeyMissingReason,
      },
      legacyChatKeys,
      peerPublicKeys,
    },
    notes: [
      'Messages are stored decrypted, re-encrypted under the passphrase key. Media bytes are NOT included — only their S3 URLs.',
      'The E2EE identity private key is non-extractable and is NOT in this backup. Losing the passphrase loses the backup.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Public API: create / restore / download / delete                    */
/* ------------------------------------------------------------------ */

/**
 * Back up all chats now. Returns the backup metadata + a summary line.
 * Throws BackupError on any failure — never reports success it did not get.
 */
export async function createBackup(
  passphrase: string,
  opts?: { uid?: string },
): Promise<BackupResult> {
  requireWebCrypto();
  const err = validatePassphrase(passphrase);
  if (err) throw new BackupError('passphrase-too-short', err);
  const uid = opts?.uid || auth.currentUser?.uid || '';
  if (!uid) throw new BackupError('no-user', 'You are not signed in — sign in first, then back up.');

  const payload = await collectBackupPayload(uid);
  if (payload.counts.messages === 0 && payload.counts.chats === 0) {
    // An empty backup is still a valid backup (a fresh account), but say
    // so plainly instead of implying history was saved.
    console.info('[chatBackup] creating an empty backup (no chats yet)');
  }
  const plainJson = JSON.stringify(payload);
  const bytes = await encryptBackupBytes(plainJson, passphrase);
  const { key, location } = await uploadBackupBlob(bytes, uid);

  const meta: BackupMeta = {
    key,
    location,
    createdAt: payload.exportedAt,
    uid,
    chatCount: payload.counts.chats,
    messageCount: payload.counts.messages,
    undecryptableSkipped: payload.counts.undecryptableSkipped,
    excludedLockedChats: payload.counts.excludedLockedChats,
    sizeBytes: bytes.length,
    identityKeyIncluded: payload.keys.identity.privateKeyB64 !== null,
  };
  setMeta(meta);
  const where =
    location === 's3' ? 'backed up to S3' : 'saved on this device only (S3 is not connected)';
  const skipped =
    meta.undecryptableSkipped > 0
      ? ` ${meta.undecryptableSkipped} message(s) could not be decrypted on this device and were left out.`
      : '';
  return {
    ...meta,
    summary: `Backed up ${meta.messageCount} message(s) in ${meta.chatCount} chat(s) — ${where}.${skipped}`,
  };
}

/** Write restored docs into the local message cache (same shape database.ts persists). */
async function writeRestoredToCache(payload: BackupPayload): Promise<string[]> {
  const conn = await openDb(CACHE_DB_NAME, 1, CACHE_STORE);
  if (!conn) throw new BackupError('restore-failed', 'Local message storage is unavailable on this device.');
  const restoredCols: string[] = [];

  const putCollection = async (col: string, docs: Array<[string, any]>) => {
    const tx = conn.transaction(CACHE_STORE, 'readonly');
    const existing = await idbRequest<any>(tx.objectStore(CACHE_STORE).get(col));
    const merged = new Map<string, any>();
    if (existing && Array.isArray(existing.docs)) {
      for (const [id, data] of existing.docs) {
        if (id) merged.set(id, data);
      }
    }
    // Restored docs win on id collision: they are the decrypted copy the
    // user asked to bring back.
    for (const [id, data] of docs) {
      if (id) merged.set(id, data);
    }
    const txW = conn.transaction(CACHE_STORE, 'readwrite');
    // Same ordering rule as putLocalBlob: register completion first.
    const done = new Promise<void>((resolve) => {
      txW.oncomplete = () => resolve();
      txW.onerror = () => resolve();
    });
    await idbRequest(
      txW.objectStore(CACHE_STORE).put(
        { docs: Array.from(merged.entries()), savedAt: Date.now() },
        col,
      ),
    );
    await done;
  };

  // Chat metadata first, so the chat list can render restored chats.
  const chatMetaDocs: Array<[string, any]> = [];
  for (const chat of payload.chats) {
    if (chat.meta) chatMetaDocs.push([chat.chatId, chat.meta]);
  }
  if (chatMetaDocs.length > 0) {
    await putCollection('chats', chatMetaDocs);
    restoredCols.push('chats');
  }

  for (const chat of payload.chats) {
    const col = `chats/${chat.chatId}/messages`;
    const docs: Array<[string, any]> = chat.messages.map((m: any) => [
      String(m.id ?? `${chat.chatId}-${Math.random().toString(36).slice(2)}`),
      { ...m, restoredFromBackup: true, restoredAt: Date.now() },
    ]);
    if (docs.length === 0) continue;
    await putCollection(col, docs);
    restoredCols.push(col);
  }
  return restoredCols;
}

/** Refresh the in-memory collections from the cache we just wrote (best-effort). */
async function refreshRestoredCollections(cols: string[]): Promise<void> {
  for (const col of cols) {
    try {
      db.releaseCollection(col, { dropCache: true });
      await db.ensure(col);
    } catch { /* intentionally ignored */}
  }
}

function parsePayload(plainJson: string): BackupPayload {
  let payload: BackupPayload;
  try {
    payload = JSON.parse(plainJson);
  } catch {
    throw new BackupError('corrupt-backup', 'Backup decrypted but its contents are damaged.');
  }
  if (!payload || payload.app !== 'pinglo' || !Array.isArray(payload.chats)) {
    throw new BackupError('corrupt-backup', 'Backup decrypted but its contents are damaged.');
  }
  if (payload.version !== BACKUP_VERSION) {
    throw new BackupError(
      'corrupt-backup',
      `Backup version ${payload.version} is not supported by this app.`,
    );
  }
  return payload;
}

/**
 * Restore from raw backup bytes (a downloaded .dtbackup file, or a blob
 * fetched from S3 / local storage). Verifies the passphrase by decrypting;
 * a wrong passphrase throws BackupError('wrong-passphrase') and NOTHING
 * is written.
 */
export async function restoreBackupFromBytes(
  bytes: Uint8Array,
  passphrase: string,
  opts?: { uid?: string },
): Promise<RestoreResult> {
  requireWebCrypto();
  const err = validatePassphrase(passphrase);
  if (err) throw new BackupError('passphrase-too-short', err);
  const uid = opts?.uid || auth.currentUser?.uid || '';
  if (!uid) throw new BackupError('no-user', 'You are not signed in — sign in first, then restore.');

  const plainJson = await decryptBackupBytes(bytes, passphrase);
  const payload = parsePayload(plainJson);
  if (payload.uid !== uid) {
    throw new BackupError(
      'uid-mismatch',
      'This backup belongs to a different account. Sign in with the account that made the backup.',
    );
  }
  const cols = await writeRestoredToCache(payload);
  await refreshRestoredCollections(cols);
  return {
    chatCount: payload.counts.chats,
    messageCount: payload.counts.messages,
    restoredAt: Date.now(),
    fromKey: '',
    fromLocation: 'local',
    identityKeyIncluded: payload.keys.identity.privateKeyB64 !== null,
    undecryptableSkippedAtExport: payload.counts.undecryptableSkipped,
    summary:
      `Restored ${payload.counts.messages} message(s) in ${payload.counts.chats} chat(s) on this device.` +
      (payload.keys.identity.privateKeyMissingReason
        ? ' Note: the identity private key was not in the backup, so new chats will re-exchange keys.'
        : ''),
  };
}

/** Restore the latest backup (the one recorded in local metadata). */
export async function restoreBackup(
  passphrase: string,
  opts?: { uid?: string },
): Promise<RestoreResult> {
  const meta = getMeta();
  if (!meta) throw new BackupError('no-backup', 'No backup found — make a backup first.');
  const bytes = await downloadBackupBlob(meta);
  const result = await restoreBackupFromBytes(bytes, passphrase, opts);
  return { ...result, fromKey: meta.key, fromLocation: meta.location };
}

/** Restore from a .dtbackup file the user picks (new phone / lost metadata). */
export async function restoreBackupFromFile(
  file: File,
  passphrase: string,
  opts?: { uid?: string },
): Promise<RestoreResult> {
  const buf = await file.arrayBuffer();
  return restoreBackupFromBytes(new Uint8Array(buf), passphrase, opts);
}

/** Download the latest encrypted backup as a .dtbackup file (move it to a new phone yourself). */
export async function downloadBackupFile(): Promise<{ fileName: string; sizeBytes: number }> {
  const meta = getMeta();
  if (!meta) throw new BackupError('no-backup', 'No backup found — make a backup first.');
  const bytes = await downloadBackupBlob(meta);
  const fileName = backupFileName(meta.key);
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { fileName, sizeBytes: bytes.length };
}

/** Delete the latest backup (S3 object + local blob + metadata). Irreversible. */
export async function deleteBackup(): Promise<void> {
  const meta = getMeta();
  if (!meta) return;
  try {
    if (meta.location === 's3') {
      await remove({ path: meta.key });
    } else {
      await deleteLocalBlob(meta.key);
    }
  } catch { /* intentionally ignored */}
  try {
    localStorage.removeItem(META_KEY);
  } catch { /* intentionally ignored */}
}

/** True when a backup exists that restore can use. */
export function hasBackup(): boolean {
  return getMeta() !== null;
}
