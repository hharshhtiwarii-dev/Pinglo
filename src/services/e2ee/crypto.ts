/**
 * E2EE Crypto Core — Worker E1.
 *
 * WebCrypto API se AES-256-GCM (koi nayi dependency nahi).
 * - Har message ke liye fresh random 12-byte IV (`crypto.getRandomValues`).
 * - GCM auth tag ciphertext ke saath aata hai: koi bhi byte badla to
 *   `decrypt` fail hota hai (tamper detection, `E2EEDecryptError`).
 * - Ye module keys ko STORE nahi karta — key management `keys.ts` me hai.
 *   Yahan sirf `CryptoKey` (ya raw bytes) in/out hote hain.
 *
 * Base64 convention: envelope ke `iv`/`ct` standard base64 hain (koi
 * base64url nahi) — database.ts me ye plain string fields ki tarah
 * store ho sakte hain.
 */
import {
  E2EE_ENVELOPE_VERSION,
  E2EE_IV_BYTES,
  E2EE_KEY_BYTES,
  E2EE_TAG_BYTES,
  E2EEDecryptError,
  type EncryptedEnvelope,
} from './types';

/**
 * Type re-exports taaki callers ek hi jagah se sab kuch import kar sakein:
 * `import { encryptText, type EncryptedEnvelope } from './e2ee/crypto'`
 * (e2eeChat.ts isi tarah import karta hai). Asli definitions `types.ts` me hain.
 */
export type { ChatKey, KeyMeta } from './types';
export type { EncryptedEnvelope } from './types';

const AES_ALG = 'AES-GCM' as const;
/** GCM auth tag length (bits) — WebCrypto default 128. */
const TAG_BITS = 128;

/** WebCrypto available hai ya nahi (insecure context / purana WebView). */
export function isWebCryptoAvailable(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  );
}

function requireWebCrypto(): void {
  if (!isWebCryptoAvailable()) {
    throw new Error(
      'E2EE: WebCrypto unavailable — secure context (https / Capacitor) required',
    );
  }
}

/** `n` cryptographically random bytes. */
export function randomBytes(n: number): Uint8Array {
  requireWebCrypto();
  // crypto.getRandomValues: n integer hona chahiye, 1..65536 (per-call limit).
  if (!Number.isInteger(n) || n < 1 || n > 65536) {
    throw new Error(`E2EE: randomBytes needs an integer 1..65536, got ${String(n)}`);
  }
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Uint8Array view ka EXACT underlying bytes wala ArrayBuffer.
 * BUG FIX: `view.buffer` seedha use karna galat hai — view agar kisi bade
 * buffer ka subarray/slice ho (byteOffset > 0) to `.buffer` poora backing
 * buffer de deta hai, galat key/plaintext encrypt ho jata. Ye helper sirf
 * view ke apne bytes kaat kar deta hai.
 */
function viewToArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** Key/plaintext jaisi value CryptoKey jaisi dikhti hai ya nahi (halki jaanch). */
function assertCryptoKey(key: unknown, what = 'key'): asserts key is CryptoKey {
  if (
    !key ||
    typeof key !== 'object' ||
    (key as CryptoKey).type !== 'secret' ||
    (key as CryptoKey).algorithm?.name !== 'AES-GCM'
  ) {
    throw new Error(`E2EE: invalid ${what} — expected an AES-GCM CryptoKey`);
  }
}

/** Bytes -> base64 string (bade buffers ke liye chunked, stack-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Base64 string -> bytes. Invalid input par clear `Error` throw karta hai. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== 'string' || b64.length === 0) {
    throw new Error('E2EE: base64 input must be a non-empty string');
  }
  // Base64url bhi tolerate karo (-_ -> +/) aur missing padding jod do.
  // Whitespace / galat length (len % 4 === 1 kabhi valid nahi) reject karo.
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/=]/.test(normalized) || normalized.length % 4 === 1) {
    throw new Error('E2EE: invalid base64 input');
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('E2EE: invalid base64 input');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Raw 32-byte key material se AES-GCM `CryptoKey` banao.
 * `extractable: false` default — key memory se bahar nahi nikalni chahiye;
 * export sirf `keys.ts` ke backup path me hota hai (wahan alag se
 * extractable key banayi jaati hai).
 */
export async function importAesKey(
  rawKey: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  requireWebCrypto();
  if (!(rawKey instanceof Uint8Array)) {
    throw new Error('E2EE: key must be a Uint8Array of 32 bytes');
  }
  if (rawKey.length !== E2EE_KEY_BYTES) {
    throw new Error(`E2EE: key must be ${E2EE_KEY_BYTES} bytes, got ${rawKey.length}`);
  }
  return crypto.subtle.importKey('raw', viewToArrayBuffer(rawKey), AES_ALG, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/** `CryptoKey` -> raw bytes (sirf extractable key ke liye; backup path). */
export async function exportAesKeyRaw(key: CryptoKey): Promise<Uint8Array> {
  requireWebCrypto();
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/**
 * Plaintext encrypt karo.
 * @param plaintext — message text (UTF-8).
 * @param key — chat ki AES-256-GCM `CryptoKey` (keys.ts se).
 * @param keyId — optional; envelope me `kid` ke roop me jata hai.
 * @returns `EncryptedEnvelope` — sirf ye object database/network par jata hai.
 */
export async function encryptText(
  plaintext: string,
  key: CryptoKey,
  keyId?: string,
): Promise<EncryptedEnvelope> {
  requireWebCrypto();
  if (typeof plaintext !== 'string') {
    throw new Error('E2EE: plaintext must be a string');
  }
  assertCryptoKey(key);
  if (keyId !== undefined && typeof keyId !== 'string') {
    throw new Error('E2EE: keyId must be a string');
  }
  const iv = randomBytes(E2EE_IV_BYTES);
  const data = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt(
    { name: AES_ALG, iv: viewToArrayBuffer(iv), tagLength: TAG_BITS },
    key,
    viewToArrayBuffer(data),
  );
  const envelope: EncryptedEnvelope = {
    v: E2EE_ENVELOPE_VERSION,
    alg: 'AES-256-GCM',
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(cipher)),
  };
  if (keyId) envelope.kid = keyId;
  return envelope;
}

/**
 * Envelope ke iv/ct ko decode karke validate karo.
 * @throws `E2EEDecryptError` — format galat ho to. (Callers is error ko
 *   "decrypt nahi ho paya" me badalte hain; kabhi raw throw nahi leak hota.)
 */
function decodeEnvelope(envelope: EncryptedEnvelope): { iv: Uint8Array; ct: Uint8Array } {
  if (!isEncryptedEnvelope(envelope)) {
    throw new E2EEDecryptError('Invalid envelope: bad version/algorithm');
  }
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    iv = base64ToBytes(envelope.iv);
    ct = base64ToBytes(envelope.ct);
  } catch {
    throw new E2EEDecryptError('Invalid envelope: bad base64');
  }
  if (iv.length !== E2EE_IV_BYTES) {
    throw new E2EEDecryptError('Invalid envelope: bad IV length');
  }
  // Ciphertext me kam se kam GCM auth tag (16 bytes) hona chahiye — khaali
  // plaintext ka bhi ct 16 bytes ka hota hai; isse chhota ct kabhi valid nahi.
  if (ct.length < E2EE_TAG_BYTES) {
    throw new E2EEDecryptError('Invalid envelope: ciphertext too short');
  }
  return { iv, ct };
}

/**
 * Envelope decrypt karo.
 * @throws `E2EEDecryptError` — ciphertext/IV badla ho, galat key ho, ya
 *   envelope ka format galat ho. Caller ko is error par message ko
 *   "decrypt nahi ho paya" dikhana chahiye, plaintext guess nahi karna.
 */
export async function decryptText(
  envelope: EncryptedEnvelope,
  key: CryptoKey,
): Promise<string> {
  requireWebCrypto();
  assertCryptoKey(key);
  const { iv, ct } = decodeEnvelope(envelope);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: AES_ALG, iv: viewToArrayBuffer(iv), tagLength: TAG_BITS },
      key,
      viewToArrayBuffer(ct),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new E2EEDecryptError();
  }
}

/**
 * Raw bytes encrypt karo (aage media / attachment E2EE ke liye).
 * Envelope wahi `EncryptedEnvelope` shape hai.
 */
export async function encryptBytes(
  data: Uint8Array,
  key: CryptoKey,
  keyId?: string,
): Promise<EncryptedEnvelope> {
  requireWebCrypto();
  if (!(data instanceof Uint8Array)) {
    throw new Error('E2EE: data must be a Uint8Array');
  }
  assertCryptoKey(key);
  if (keyId !== undefined && typeof keyId !== 'string') {
    throw new Error('E2EE: keyId must be a string');
  }
  const iv = randomBytes(E2EE_IV_BYTES);
  const cipher = await crypto.subtle.encrypt(
    { name: AES_ALG, iv: viewToArrayBuffer(iv), tagLength: TAG_BITS },
    key,
    viewToArrayBuffer(data),
  );
  const envelope: EncryptedEnvelope = {
    v: E2EE_ENVELOPE_VERSION,
    alg: 'AES-256-GCM',
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(cipher)),
  };
  if (keyId) envelope.kid = keyId;
  return envelope;
}

/** `encryptBytes` ka ulta — tamper par `E2EEDecryptError`. */
export async function decryptBytes(
  envelope: EncryptedEnvelope,
  key: CryptoKey,
): Promise<Uint8Array> {
  requireWebCrypto();
  assertCryptoKey(key);
  const { iv, ct } = decodeEnvelope(envelope);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: AES_ALG, iv: viewToArrayBuffer(iv), tagLength: TAG_BITS },
      key,
      viewToArrayBuffer(ct),
    );
    return new Uint8Array(plain);
  } catch {
    throw new E2EEDecryptError();
  }
}

/** Kya ye object ek valid v1 AES-256-GCM envelope hai? (type guard) */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === E2EE_ENVELOPE_VERSION &&
    v.alg === 'AES-256-GCM' &&
    typeof v.iv === 'string' &&
    typeof v.ct === 'string' &&
    (v.kid === undefined || typeof v.kid === 'string')
  );
}

/* ------------------------------------------------------------------ */
/* Self-test                                                           */
/* ------------------------------------------------------------------ */

/** `selfTest()` ki ek check ka natija. */
export interface SelfTestCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

/** `selfTest()` ka poora natija — `passed` tabhi true jab koi check fail na ho. */
export interface SelfTestResult {
  passed: boolean;
  checks: SelfTestCheck[];
}

/**
 * In-memory self-test — key gen -> encrypt -> decrypt (text + bytes),
 * envelope create -> validate -> decrypt, aur ECDH key-exchange round-trip.
 * IndexedDB wala hissa (chat-key storage) sirf tab chalta hai jab
 * `indexedDB` available ho, warna `skip` hota hai — Node/SSR me fail nahi.
 * Ye function kabhi throw nahi karta: har check ka pass/fail/skip result
 * me aata hai. Debug/Settings screen se call karo ("Test encryption").
 *
 * NOTE: keyExchange/keys/envelope ko dynamic import kiya gaya hai taaki
 * crypto.ts <-> keys.ts ke beech static import cycle na bane.
 */
export async function selfTest(): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];
  const run = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const detail = await fn();
      checks.push({
        name,
        status: 'pass',
        detail: typeof detail === 'string' ? detail : undefined,
      });
    } catch (e) {
      checks.push({
        name,
        status: 'fail',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const skip = (name: string, detail: string): void => {
    checks.push({ name, status: 'skip', detail });
  };

  if (!isWebCryptoAvailable()) {
    checks.push({ name: 'webcrypto-available', status: 'fail', detail: 'WebCrypto unavailable' });
    skip('key-gen-import-export', 'WebCrypto unavailable');
    skip('encrypt-decrypt-text', 'WebCrypto unavailable');
    skip('encrypt-decrypt-bytes', 'WebCrypto unavailable');
    skip('iv-uniqueness', 'WebCrypto unavailable');
    skip('tamper-detection', 'WebCrypto unavailable');
    skip('envelope-round-trip', 'WebCrypto unavailable');
    skip('key-exchange-round-trip', 'WebCrypto unavailable');
    skip('chat-key-storage', 'WebCrypto unavailable');
    return { passed: false, checks };
  }
  checks.push({ name: 'webcrypto-available', status: 'pass' });

  let key: CryptoKey | null = null;
  await run('key-gen-import-export', async () => {
    const raw = randomBytes(E2EE_KEY_BYTES);
    key = await importAesKey(raw);
    const back = await exportAesKeyRaw(await importAesKey(raw, true));
    if (back.length !== raw.length || !back.every((b, i) => b === raw[i])) {
      throw new Error('exported key does not match generated key');
    }
  });

  await run('encrypt-decrypt-text', async () => {
    if (!key) throw new Error('no key (key-gen check failed)');
    for (const text of ['hello e2ee', '', 'नमस्ते 🙏 café — ünïcode ✓']) {
      const env = await encryptText(text, key);
      if ((await decryptText(env, key)) !== text) {
        throw new Error(`text round-trip mismatch for ${JSON.stringify(text)}`);
      }
    }
  });

  await run('encrypt-decrypt-bytes', async () => {
    if (!key) throw new Error('no key (key-gen check failed)');
    const raw = randomBytes(64);
    const env = await encryptBytes(raw, key);
    const back = await decryptBytes(env, key);
    if (back.length !== raw.length || !back.every((b, i) => b === raw[i])) {
      throw new Error('bytes round-trip mismatch');
    }
    // Subarray view: backing buffer ka sirf ek hissa encrypt hona chahiye
    // (viewToArrayBuffer fix ka regression test).
    const backing = randomBytes(100);
    const view = backing.subarray(10, 50);
    const env2 = await encryptBytes(view, key);
    const back2 = await decryptBytes(env2, key);
    if (back2.length !== view.length || !back2.every((b, i) => b === view[i])) {
      throw new Error('subarray bytes round-trip mismatch');
    }
  });

  await run('iv-uniqueness', async () => {
    if (!key) throw new Error('no key (key-gen check failed)');
    const a = await encryptText('same plaintext', key);
    const b = await encryptText('same plaintext', key);
    if (a.iv === b.iv || a.ct === b.ct) {
      throw new Error('IV/ciphertext repeated — nonce reuse');
    }
  });

  await run('tamper-detection', async () => {
    if (!key) throw new Error('no key (key-gen check failed)');
    const otherKey = await importAesKey(randomBytes(E2EE_KEY_BYTES));
    const env = await encryptText('do not tamper', key);
    const ctBytes = base64ToBytes(env.ct);
    ctBytes[ctBytes.length - 1] ^= 0x01;
    const tampered: EncryptedEnvelope = { ...env, ct: bytesToBase64(ctBytes) };
    let threw = false;
    try {
      await decryptText(tampered, key);
    } catch (e) {
      threw = e instanceof E2EEDecryptError;
    }
    if (!threw) throw new Error('tampered ciphertext decrypted without error');
    let wrongKeyThrew = false;
    try {
      await decryptText(env, otherKey);
    } catch (e) {
      wrongKeyThrew = e instanceof E2EEDecryptError;
    }
    if (!wrongKeyThrew) throw new Error('wrong key decrypted without error');
  });

  await run('envelope-round-trip', async () => {
    if (!key) throw new Error('no key (key-gen check failed)');
    const env = await import('./envelope');
    const cryptoPort = { encryptText, decryptText };
    const msgEnv = await env.encryptTextField('envelope hello', {
      chatId: '__e2ee-selftest__',
      senderId: 'selftest',
      key,
      crypto: cryptoPort,
      keyId: 'test-kid-1',
    });
    if (!msgEnv || !env.validateEnvelope(msgEnv)) {
      throw new Error('envelope failed validation');
    }
    // Canonical shape proof: MessageEnvelope seedha EncryptedEnvelope hai.
    if (!isEncryptedEnvelope(msgEnv) || msgEnv.kid !== 'test-kid-1') {
      throw new Error('envelope is not a canonical EncryptedEnvelope (ct/kid)');
    }
    if ((await env.decryptEnvelope(msgEnv, key, cryptoPort)) !== 'envelope hello') {
      throw new Error('envelope decrypt mismatch');
    }
    // Tampered / invalid envelope kabhi throw nahi karta — null deta hai.
    const bad = { ...msgEnv, ct: msgEnv.ct.slice(0, -4) + 'AAAA' };
    if ((await env.decryptEnvelope(bad, key, cryptoPort)) !== null) {
      throw new Error('tampered envelope did not return null');
    }
    if ((await env.decryptEnvelope({ v: 99 }, key, cryptoPort)) !== null) {
      throw new Error('invalid envelope did not return null');
    }
  });

  await run('key-exchange-round-trip', async () => {
    const kx = await import('./keyExchange');
    const chatId = '__e2ee-selftest__';
    const pairA = await kx.generateIdentityKeyPair();
    const pairB = await kx.generateIdentityKeyPair();
    const keyAB = await kx.deriveChatKey(pairA.privateKey, pairB.publicKey, chatId);
    const keyBA = await kx.deriveChatKey(pairB.privateKey, pairA.publicKey, chatId);
    // Dono taraf se derive ki hui key se cross-decrypt hona chahiye.
    const env = await encryptText('shared secret works', keyAB);
    if ((await decryptText(env, keyBA)) !== 'shared secret works') {
      throw new Error('ECDH derived keys do not match');
    }
    const pubA = await kx.exportPublicKeyBase64(pairA.publicKey);
    const pubB = await kx.exportPublicKeyBase64(pairB.publicKey);
    const n1 = await kx.computeSafetyNumber(pubA, pubB);
    const n2 = await kx.computeSafetyNumber(pubB, pubA);
    if (n1 !== n2 || n1.replace(/ /g, '').length !== 60) {
      throw new Error('safety number mismatch / wrong length');
    }
  });

  if (typeof indexedDB === 'undefined') {
    skip('chat-key-storage', 'IndexedDB unavailable in this environment');
  } else {
    await run('chat-key-storage', async () => {
      const keys = await import('./keys');
      const chatId = '__e2ee-selftest__';
      try {
        const handle = await keys.getOrCreateChatKey(chatId);
        const env = await encryptText('stored key works', handle.key);
        if ((await decryptText(env, handle.key)) !== 'stored key works') {
          throw new Error('stored-key round-trip mismatch');
        }
        // Rotation: purani key se encrypt kiya message nayi key ke baad
        // bhi getDecryptionKeys() se decrypt hona chahiye.
        const oldEnv = await encryptText('before rotation', handle.key);
        await keys.rotateChatKey(chatId);
        const candidates = await keys.getDecryptionKeys(chatId, oldEnv.kid);
        let ok = false;
        for (const k of candidates) {
          try {
            if ((await decryptText(oldEnv, k)) === 'before rotation') ok = true;
          } catch {
            // galat key — agla candidate try karo
          }
        }
        if (!ok) throw new Error('pre-rotation message undecryptable after rotation');
      } finally {
        await keys.deleteChatKey(chatId);
      }
      if ((await keys.getChatKey(chatId)) !== null) {
        throw new Error('key still present after deleteChatKey');
      }
    });
  }

  return { passed: checks.every((c) => c.status !== 'fail'), checks };
}
