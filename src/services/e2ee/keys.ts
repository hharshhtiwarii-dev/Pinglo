/**
 * E2EE key management — Worker E1.
 *
 * Per-chat symmetric AES-256 keys:
 * - Generate: `crypto.getRandomValues` (32 bytes) -> extractable CryptoKey.
 * - Store: apni chhoti IndexedDB (`pinglo-e2ee-keys`, store `chatKeys`).
 *   database.ts ka cache helper yahan reuse NAHI hua — wo private hai aur
 *   uska store sirf message cache ke liye hai; database.ts edit karna is
 *   worker ke scope se bahar hai, isliye yahan apna minimal IDB helper hai.
 * - Memory cache: CryptoKey objects in-memory Map me rakhe jaate hain taaki
 *   har message par IDB + importKey na karna pade.
 * - Rotation: nayi key banti hai, purani key `previousKey` me ek generation
 *   tak rakhi jaati hai (purane messages decrypt hote rahein).
 * - Backup: NONE — there is no key-backup export. The old
 *   `exportKeyBackup()` (raw keys, never wired to any UI) was dead code
 *   and was removed in AUDIT-2 Phase 2; the settings screen says plainly
 *   that no backup exists. The identity private key is non-extractable
 *   and chat keys are ECDH-derived, so there is nothing meaningful to
 *   export — lose the device and old encrypted messages stay unreadable.
 *
 * HONEST LIMITS:
 * - Keys isi device par hain. Device kho gaya / app data wipe hua to keys
 *   gayi — bina backup ke purane messages hamesha ke liye unreadable.
 * - MASTER E2EE PASS: ye symmetric keys ab message encrypt karne ke liye
 *   use NAHI hoti — chat keys ECDH se derive hoti hain (keyExchange.ts)
 *   aur e2eeChat.ts unhi ko use karta hai. Ye module sirf (a) purane
 *   builds se is device par encrypt kiye messages ka decrypt fallback aur
 *   (b) delete-account / wipe ke liye rakha gaya hai. Naye code ko
 *   getOrCreateChatKey() se encrypt NAHI karna chahiye.
 * - Keys ko app-lock PIN se wrap nahi kiya gaya hai (vault.ts ka pattern
 *   yahan apply karna baaki hai — E2EE hardening worker ka kaam).
 */
import {
  base64ToBytes,
  bytesToBase64,
  importAesKey,
  randomBytes,
} from './crypto';
import { E2EE_KEY_BYTES, type ChatKey, type KeyMeta } from './types';

/** Types yahin se bhi import ho sakein — callers ko `./types` yaad rakhne ki zaroorat nahi. */
export type { ChatKey, KeyMeta } from './types';

const IDB_DB_NAME = 'pinglo-e2ee-keys';
const IDB_STORE = 'chatKeys';
const IDB_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Small IndexedDB helper (keys ke liye alag DB — database.ts se alag) */
/* ------------------------------------------------------------------ */

let idbPromise: Promise<IDBDatabase | null> | null = null;

function openKeysDb(): Promise<IDBDatabase | null> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      // Cached promise ko reset karo taaki baad me environment badle to retry ho sake.
      idbPromise = null;
      return resolve(null);
    }
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE, { keyPath: 'chatId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Error / blocked par cached promise reset karo — warna ek transient
    // failure ke baad ye DB hamesha ke liye "unavailable" dikhega.
    req.onerror = () => {
      idbPromise = null;
      resolve(null);
    };
    req.onblocked = () => {
      idbPromise = null;
      resolve(null);
    };
  });
  return idbPromise;
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('E2EE keys: IndexedDB error'));
  });
}

async function idbGet(chatId: string): Promise<ChatKey | undefined> {
  const db = await openKeysDb();
  if (!db) return undefined;
  const tx = db.transaction(IDB_STORE, 'readonly');
  return idbRequest(tx.objectStore(IDB_STORE).get(chatId));
}

async function idbPut(record: ChatKey): Promise<void> {
  const db = await openKeysDb();
  if (!db) throw new Error('E2EE keys: IndexedDB unavailable — key not stored');
  const tx = db.transaction(IDB_STORE, 'readwrite');
  await idbRequest(tx.objectStore(IDB_STORE).put(record));
}

async function idbDelete(chatId: string): Promise<void> {
  const db = await openKeysDb();
  if (!db) return;
  const tx = db.transaction(IDB_STORE, 'readwrite');
  await idbRequest(tx.objectStore(IDB_STORE).delete(chatId));
}

async function idbGetAll(): Promise<ChatKey[]> {
  const db = await openKeysDb();
  if (!db) return [];
  const tx = db.transaction(IDB_STORE, 'readonly');
  return idbRequest(tx.objectStore(IDB_STORE).getAll());
}

async function idbClear(): Promise<void> {
  const db = await openKeysDb();
  if (!db) return;
  const tx = db.transaction(IDB_STORE, 'readwrite');
  await idbRequest(tx.objectStore(IDB_STORE).clear());
}

/* ------------------------------------------------------------------ */
/* In-memory CryptoKey cache                                           */
/* ------------------------------------------------------------------ */

interface CachedKey {
  key: CryptoKey;
  keyId: string;
  version: number;
}

/** chatId -> current key (memory only; reload par IDB se wapas bharna hota hai). */
const keyCache = new Map<string, CachedKey>();
/** chatId -> previous key (rotation ke baad purane messages ke liye). */
const prevKeyCache = new Map<string, CachedKey>();

function newKeyId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return bytesToBase64(randomBytes(16));
}

/** chatId khaali / galat type ho to clear error — khaali chatId se kabhi key store mat karo. */
function assertChatId(chatId: unknown): asserts chatId is string {
  if (typeof chatId !== 'string' || chatId.length === 0) {
    throw new Error('E2EE keys: chatId must be a non-empty string');
  }
}

/**
 * Ek chat ke key operations ko serialize karo. Bina iske do concurrent
 * `getOrCreateChatKey` calls dono "key nahi hai" dekh kar do alag keys
 * generate kar dete — pehli key se encrypt kiye messages phir kabhi
 * decrypt nahi hote (race bug). Chain hamesha resolve hoti hai (reject
 * hone par bhi agla op chal sake, isliye catch ke saath store hoti hai).
 */
const chatOpChains = new Map<string, Promise<unknown>>();

function withChatLock<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chatOpChains.get(chatId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  // Agla op isi chain se jude; chain khatam hote hi entry hata do taaki
  // Map har chat ke liye ek purana promise pakad kar na baithe.
  const entry = next.then(
    (value) => {
      if (chatOpChains.get(chatId) === entry) chatOpChains.delete(chatId);
      return value;
    },
    (err) => {
      if (chatOpChains.get(chatId) === entry) chatOpChains.delete(chatId);
      throw err;
    },
  );
  chatOpChains.set(chatId, entry.catch(() => undefined));
  return entry;
}

function toMeta(record: ChatKey): KeyMeta {
  return {
    chatId: record.chatId,
    keyId: record.keyId,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    version: record.version,
    hasPreviousKey: record.previousKey !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface ChatKeyHandle {
  /** Decrypt/encrypt ke liye ready CryptoKey. */
  key: CryptoKey;
  /** Envelope ke `kid` me daalne wala id. */
  keyId: string;
  version: number;
}

function handleFromRecord(record: ChatKey, key: CryptoKey): ChatKeyHandle {
  return { key, keyId: record.keyId, version: record.version };
}

/**
 * Chat ke liye nayi AES-256 key generate karo aur IndexedDB me store karo.
 * Pehle se key hai to overwrite ho jayegi — aam taur par `getOrCreateChatKey`
 * ya `rotateChatKey` use karo, seedha `generateChatKey` nahi.
 */
export async function generateChatKey(chatId: string): Promise<ChatKeyHandle> {
  assertChatId(chatId);
  const raw = randomBytes(E2EE_KEY_BYTES);
  const key = await importAesKey(raw, true);
  // raw hi key material hai — export karke wapas lena bekaar hai (aur
  // export fail ho to key aadhi state me reh jati). Seedha raw store karo.
  const record: ChatKey = {
    chatId,
    keyId: newKeyId(),
    keyB64: bytesToBase64(raw),
    createdAt: Date.now(),
    rotatedAt: null,
    version: 1,
    previousKey: null,
  };
  await idbPut(record);
  keyCache.set(chatId, { key, keyId: record.keyId, version: 1 });
  prevKeyCache.delete(chatId);
  return handleFromRecord(record, key);
}

/** Corrupt IDB record ko CryptoKey me badlo — fail ho to null (caller fail-closed rahe). */
async function importStoredKey(keyB64: string): Promise<CryptoKey | null> {
  try {
    const raw = base64ToBytes(keyB64);
    if (raw.length !== E2EE_KEY_BYTES) return null;
    return await importAesKey(raw, false);
  } catch {
    return null;
  }
}

/**
 * Chat ki current key lao (memory cache -> IndexedDB). Nahi mili to `null`.
 * Key milne par CryptoKey import karke cache me rakha jata hai.
 * Corrupt record (galat base64 / galat length) par throw nahi karta — `null`
 * deta hai taaki chat load crash na ho; caller "encryption not ready" dikhaye.
 *
 * NOTE: `keyExchange.ts` ka `getChatKey` alag cheez hai (ECDH se derive ki
 * hui key, `Promise<CryptoKey | null>`) — naam ek, return type alag.
 * Confusion se bachne ke liye yahan ka alias `getStoredChatKey` aur wahan
 * ka alias `getDerivedChatKey` use karo. (Dono ko ek API me merge karna
 * baaki hai — E2EE integration worker ka kaam.)
 */
export async function getChatKey(chatId: string): Promise<ChatKeyHandle | null> {
  if (typeof chatId !== 'string' || chatId.length === 0) return null;
  const cached = keyCache.get(chatId);
  if (cached) return { key: cached.key, keyId: cached.keyId, version: cached.version };
  const record = await idbGet(chatId);
  if (!record) return null;
  const key = await importStoredKey(record.keyB64);
  if (!key) return null;
  keyCache.set(chatId, { key, keyId: record.keyId, version: record.version });
  // Previous key corrupt ho to bhi current key kaam karni chahiye.
  if (record.previousKey) {
    const prev = await importStoredKey(record.previousKey.keyB64);
    if (prev) {
      prevKeyCache.set(chatId, {
        key: prev,
        keyId: record.previousKey.keyId,
        version: record.version - 1,
      });
    }
  }
  return handleFromRecord(record, key);
}

/** `getChatKey` ka saaf naam — IndexedDB me stored symmetric key (keyExchange wali nahi). */
export const getStoredChatKey = getChatKey;

/** Key hai to lao, nahi to generate karo. Chat kholne / pehla message bhejne se pehle ye call karo. */
export async function getOrCreateChatKey(chatId: string): Promise<ChatKeyHandle> {
  assertChatId(chatId);
  // Concurrent calls serialize hoti hain — ek hi key banti hai (race bug fix).
  return withChatLock(chatId, async () => {
    const existing = await getChatKey(chatId);
    if (existing) return existing;
    return generateChatKey(chatId);
  });
}

/**
 * Key rotate karo: nayi key banti hai, purani key `previousKey` me jaati hai.
 * Naye messages nayi key se encrypt honge; purane messages purani key se
 * abhi bhi decrypt honge (ek generation tak). Dusri rotation par usse
 * purani key hamesha ke liye chali jati hai.
 */
export async function rotateChatKey(chatId: string): Promise<ChatKeyHandle> {
  assertChatId(chatId);
  return withChatLock(chatId, async () => {
    const old = await idbGet(chatId);
    const raw = randomBytes(E2EE_KEY_BYTES);
    const key = await importAesKey(raw, true);
    const record: ChatKey = {
      chatId,
      keyId: newKeyId(),
      keyB64: bytesToBase64(raw),
      createdAt: old ? old.createdAt : Date.now(),
      rotatedAt: Date.now(),
      version: old ? old.version + 1 : 1,
      previousKey: old ? { keyId: old.keyId, keyB64: old.keyB64 } : null,
    };
    await idbPut(record);
    if (old) {
      const prev = await importStoredKey(old.keyB64);
      if (prev) {
        prevKeyCache.set(chatId, { key: prev, keyId: old.keyId, version: old.version });
      }
    }
    keyCache.set(chatId, { key, keyId: record.keyId, version: record.version });
    return handleFromRecord(record, key);
  });
}

/**
 * Decrypt ke liye try karne wali keys — pehle current, phir previous
 * (agar envelope ka `kid` previous key ka ho). `decryptText` ko is list
 * par loop karke call karo; pehli successful decrypt jeet ti hai.
 */
export async function getDecryptionKeys(
  chatId: string,
  envelopeKeyId?: string,
): Promise<CryptoKey[]> {
  const current = await getChatKey(chatId);
  if (!current) return [];
  const keys: CryptoKey[] = [];
  const prev = prevKeyCache.get(chatId);
  // Agar envelope purani key ka hai to pehle wahi try karo.
  if (envelopeKeyId && prev && prev.keyId === envelopeKeyId) {
    keys.push(prev.key, current.key);
  } else {
    keys.push(current.key);
    if (prev) keys.push(prev.key);
  }
  return keys;
}

/** Sab chats ki key metadata (bina secret key material ke) — Settings UI ke liye. */
export async function listChatKeys(): Promise<KeyMeta[]> {
  const all = await idbGetAll();
  return all.map(toMeta);
}

/** Ek chat ki key metadata, ya `null`. */
export async function getKeyMeta(chatId: string): Promise<KeyMeta | null> {
  const record = await idbGet(chatId);
  return record ? toMeta(record) : null;
}

/** Ek chat ki key delete karo (chat delete / "reset encryption" par). Purane messages phir decrypt nahi honge. */
export async function deleteChatKey(chatId: string): Promise<void> {
  assertChatId(chatId);
  await idbDelete(chatId);
  keyCache.delete(chatId);
  prevKeyCache.delete(chatId);
}

/** Memory cache khali karo (logout / app lock par call karo). IDB keys safe rehti hain. */
export function clearKeyCache(): void {
  keyCache.clear();
  prevKeyCache.clear();
}

/**
 * SAARI keys hamesha ke liye delete karo (delete-account / factory reset).
 * Ye irreversible hai — bina backup ke koi purana message decrypt nahi hoga.
 */
export async function eraseAllKeys(): Promise<void> {
  await idbClear();
  clearKeyCache();
}
