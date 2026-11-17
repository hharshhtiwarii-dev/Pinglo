/**
 * E2EE — Message Envelope (Worker E2: Message Envelope + Pipeline).
 *
 * This file defines the on-the-wire / on-disk shape of an encrypted chat
 * message. It does NOT do any cryptography itself: the crypto functions
 * are injected through the `E2eeCryptoPort` interface (dependency
 * injection), so this file compiles and type-checks even before E1's
 * `crypto.ts` / `keys.ts` land.
 *
 * ── REAL E1 interface (`src/services/e2ee/crypto.ts` — verified) ──
 *   encryptText(plaintext: string, key: CryptoKey, keyId?: string)
 *     => Promise<EncryptedEnvelope>   // { v: 1, alg: 'AES-256-GCM', iv, ct, kid? }
 *   decryptText(envelope: EncryptedEnvelope, key: CryptoKey) => Promise<string>
 *   - `iv` and `ct` are standard-base64 strings.
 *   - `ct` is the raw AES-256-GCM output INCLUDING the 16-byte auth tag
 *     appended by WebCrypto (`crypto.subtle.encrypt`).
 *   - A fresh random 12-byte IV per message (E1's responsibility).
 *   - `decryptText` throws `E2EEDecryptError` on a bad key / tampered
 *     ciphertext (GCM auth failure); callers here convert that into a
 *     `null` / `decrypt-failed` marker instead of letting it crash the chat.
 *
 * BUG FIX (Worker 4 ne pakda): purana `E2eeCryptoPort` ek `{ iv, ciphertext }`
 * shape assume karta tha jo real `crypto.ts` se match nahi karta tha
 * (real field `ct` hai, `ciphertext` nahi) — asli functions ko port me
 * daalte hi tsc fail hota tha aur `encryptTextField` ko `ciphertext`
 * `undefined` milta. Port ab real shape hai.
 *
 * ── ONE canonical envelope shape (Worker 3 / e2eeChat.ts se reconcile) ──
 *   WINNER: crypto.ts ka `EncryptedEnvelope` { v, alg, iv, ct, kid? }.
 *   e2eeChat.ts (glue) aur ChatScreen isi ko canonical maante hain aur
 *   `decryptText` ko seedha `doc.e2ee` dete hain. Is file ka
 *   `MessageEnvelope` ab wahi shape hai + scope fields (`chatId`,
 *   `senderId`): `interface MessageEnvelope extends EncryptedEnvelope`.
 *   Purana `ciphertext` field hataya gaya — koi stored message us shape
 *   me nahi hai (e2eeChat.ts ne hamesha `ct` likha), isliye koi migration
 *   nahi chahiye. `toCryptoEnvelope()` scope fields hatakar bare crypto
 *   envelope deta hai jab glue code ko `decryptText` chahiye ho.
 *
 * ── Decrypt-failed placeholder (ek wording, app-wide) ──
 *   Canonical text: "Couldn't decrypt this message" (neeche
 *   `DECRYPT_FAILED_TEXT`). ChatScreen (Worker 3) yahi render karta hai.
 *   e2eeChat.ts ka apna `DECRYPT_FAILED_PLACEHOLDER` ('🔒 This message
 *   couldn't be decrypted') abhi bhi alag hai — wo file is worker ke
 *   scope se bahar hai; uske owner ko ek line badalni hai
 *   (`DECRYPT_FAILED_PLACEHOLDER = DECRYPT_FAILED_TEXT` yahan se import
 *   karke). Jab tak wo na badle, do jagah do wordings dikh sakti hain.
 *
 * ── Envelope format (v1) — ONE canonical shape ──
 *   Stored on the message doc as the `e2ee` field:
 *     { v: 1, alg: 'AES-256-GCM', iv, ct, kid?, chatId, senderId }
 *   This IS `crypto.ts`'s `EncryptedEnvelope` ({ v, alg, iv, ct, kid? })
 *   plus the scope fields `chatId` / `senderId`. There is no second shape:
 *   the old E2 draft used a `ciphertext` field instead of `ct` — that
 *   field is GONE (nothing ever stored it: e2eeChat.ts always wrote `ct`,
 *   and no other module imports this file). `MessageEnvelope` extends
 *   `EncryptedEnvelope`, so a stored `e2ee` field passes crypto.ts's
 *   `isEncryptedEnvelope` check and can go straight to `decryptText`.
 *   The message doc ALSO carries `encrypted: true` and the `text` field is
 *   cleared to '' before the doc is written, so no plaintext body ever
 *   reaches the database / realtime relay. The decrypted text is restored
 *   in memory only, on load (see `pipeline.ts`).
 *
 * ── What is (and is not) encrypted ──
 *   Encrypted: `text` (message body) and `caption` (media caption, when a
 *   caption field exists — today ChatScreen stores the media label in
 *   `text`, so encrypting `text` already covers it), plus the quoted
 *   `replyTo.text` (see pipeline.ts).
 *   NOT encrypted: senderId/senderName/timestamp/status, `mediaUrl`
 *   (the S3 file itself is NOT encrypted by this worker), poll options,
 *   location/contact payloads, sticker/gif ids. Those stay plaintext —
 *   see PATCH.md "honest limits".
 *
 * ── Legacy messages ──
 *   Messages written before E2EE have a plaintext `text` and NO `e2ee`
 *   field. They are detected by `isLegacyMessage()` / `encryptionState()`
 *   and marked `encryption: 'legacy'` on load, so the UI can show a
 *   "not encrypted" mark instead of silently treating them as secure.
 *   They are NEVER auto-upgraded / re-encrypted on read (that would
 *   rewrite history with a key the original sender may not have).
 */

import type { EncryptedEnvelope } from './types';

// ── Constants ─────────────────────────────────────────────────────────────

export const ENVELOPE_VERSION = 1 as const;
export const ENVELOPE_ALG = 'AES-256-GCM' as const;

/**
 * Canonical decrypt-failed placeholder text, app-wide — "Couldn't decrypt
 * this message". ChatScreen yahi render karta hai; `markDecryptFailed`
 * yahi text doc me daalta hai. e2eeChat.ts ka apna
 * `DECRYPT_FAILED_PLACEHOLDER` abhi bhi alag wording hai (us file ke
 * owner ko yahan se import karke align karna hai — is file se bahar).
 */
export const DECRYPT_FAILED_TEXT = "Couldn't decrypt this message" as const;

/** GCM auth tag 16 bytes — ciphertext isse chhota kabhi valid nahi. */
const TAG_BYTES = 16;
/** IV 12 bytes — har message ke liye fresh random. */
const IV_BYTES = 12;

/** Encryption state of a message doc, as the UI should present it. */
export type EncryptionState = 'e2ee' | 'legacy' | 'decrypt-failed' | 'empty';

// ── Assumed E1 crypto interface ───────────────────────────────────────────

/**
 * The only crypto surface this worker needs from E1 (`crypto.ts`).
 * Real wiring:
 *   import { encryptText, decryptText } from './crypto';
 *   const crypto: E2eeCryptoPort = { encryptText, decryptText };
 * `EncryptedEnvelope.ct` hi yahan `MessageEnvelope.ct` hai — koi mapping
 * nahi, ek hi shape (`MessageEnvelope extends EncryptedEnvelope`).
 */
export interface E2eeCryptoPort {
  encryptText(
    plaintext: string,
    key: CryptoKey,
    keyId?: string,
  ): Promise<EncryptedEnvelope>;
  decryptText(envelope: EncryptedEnvelope, key: CryptoKey): Promise<string>;
}

// ── Types ─────────────────────────────────────────────────────────────────

/**
 * The encrypted payload stored on a message doc under the `e2ee` field.
 * CANONICAL shape: `EncryptedEnvelope` + scope. `ct` wahi bytes hain jo
 * crypto.ts likhta hai (GCM ciphertext + 16-byte auth tag, base64).
 */
export interface MessageEnvelope extends EncryptedEnvelope {
  /** Chat / conversation id the key belongs to (key scope check). */
  chatId: string;
  /** uid of the sender (who encrypted it). */
  senderId: string;
}

/**
 * MessageEnvelope -> bare crypto envelope (scope fields hatakar).
 * Glue code (`decryptText` ko seedha envelope dena ho) iska use kare —
 * ya envelope ko seedha pass kar de, wo bhi `EncryptedEnvelope` hai.
 */
export function toCryptoEnvelope(envelope: MessageEnvelope): EncryptedEnvelope {
  const out: EncryptedEnvelope = {
    v: envelope.v,
    alg: envelope.alg,
    iv: envelope.iv,
    ct: envelope.ct,
  };
  if (envelope.kid !== undefined) out.kid = envelope.kid;
  return out;
}

/** A chat message doc as stored in `chats/{chatId}/messages` (shape is loose — the app uses `any[]`). */
export type MessageDoc = Record<string, any>;

/** Context needed to encrypt one field of one message. */
export interface EncryptContext {
  chatId: string;
  senderId: string;
  key: CryptoKey;
  crypto: E2eeCryptoPort;
  /** Optional key id — envelope ke `kid` me jata hai (rotation support). */
  keyId?: string;
}

// ── Validation ────────────────────────────────────────────────────────────

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9\-_]+={0,2}$/;

/** True for a non-empty standard-base64 (or base64url, tolerated) string. */
export function isBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    // Base64 ki length % 4 === 1 kabhi valid nahi hoti.
    value.length % 4 !== 1 &&
    (BASE64_RE.test(value) || BASE64URL_RE.test(value))
  );
}

/** Base64 string decode karne par kitne bytes milenge (decode kiye bina). */
function decodedByteLength(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * Strict shape check for an unknown value claimed to be an envelope.
 * Used on load so a corrupt / hand-crafted doc can never crash decrypt.
 * Sirf shape nahi — IV 12 bytes aur ciphertext kam se kam 16 bytes (tag)
 * ka bhi hona chahiye, warna decrypt pehle se hi fail hoga.
 */
export function validateEnvelope(value: unknown): value is MessageEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === ENVELOPE_VERSION &&
    e.alg === ENVELOPE_ALG &&
    typeof e.chatId === 'string' &&
    e.chatId.length > 0 &&
    typeof e.senderId === 'string' &&
    e.senderId.length > 0 &&
    isBase64(e.iv) &&
    decodedByteLength(e.iv as string) === IV_BYTES &&
    isBase64(e.ct) &&
    decodedByteLength(e.ct as string) >= TAG_BYTES &&
    (e.kid === undefined || typeof e.kid === 'string')
  );
}

/** True when the doc carries a well-formed v1 envelope. */
export function isEncryptedMessage(doc: MessageDoc | null | undefined): boolean {
  if (!doc) return false;
  return validateEnvelope((doc as MessageDoc).e2ee);
}

/**
 * True for a pre-E2EE message: plaintext `text` present, no envelope.
 * (A doc with neither text nor envelope — e.g. a deleted message — is
 * neither encrypted nor legacy; see `encryptionState`.)
 */
export function isLegacyMessage(doc: MessageDoc | null | undefined): boolean {
  if (!doc) return false;
  return (
    !validateEnvelope((doc as MessageDoc).e2ee) &&
    typeof (doc as MessageDoc).text === 'string' &&
    (doc as MessageDoc).text.length > 0
  );
}

/**
 * One-word answer for the UI badge:
 * - 'e2ee'           → envelope present and well-formed
 * - 'legacy'         → plaintext text, no envelope (pre-E2EE message)
 * - 'decrypt-failed' → envelope present but marked failed on load
 *                       (pipeline sets this; a raw stored doc never has it)
 * - 'empty'          → no text and no envelope (deleted / content-less doc)
 */
export function encryptionState(doc: MessageDoc | null | undefined): EncryptionState {
  if (!doc) return 'empty';
  if ((doc as MessageDoc).decryptError === true) return 'decrypt-failed';
  if (isEncryptedMessage(doc)) return 'e2ee';
  if (isLegacyMessage(doc)) return 'legacy';
  return 'empty';
}

// ── Envelope construction ─────────────────────────────────────────────────

export function createEnvelope(parts: {
  chatId: string;
  senderId: string;
  iv: string;
  ct: string;
  kid?: string;
}): MessageEnvelope {
  if (typeof parts.chatId !== 'string' || parts.chatId.length === 0) {
    throw new Error('E2EE envelope: chatId must be a non-empty string');
  }
  if (typeof parts.senderId !== 'string' || parts.senderId.length === 0) {
    throw new Error('E2EE envelope: senderId must be a non-empty string');
  }
  if (!isBase64(parts.iv) || decodedByteLength(parts.iv) !== IV_BYTES) {
    throw new Error('E2EE envelope: iv must be base64 of 12 bytes');
  }
  if (!isBase64(parts.ct) || decodedByteLength(parts.ct) < TAG_BYTES) {
    throw new Error('E2EE envelope: ct must be base64 of at least 16 bytes');
  }
  if (parts.kid !== undefined && typeof parts.kid !== 'string') {
    throw new Error('E2EE envelope: kid must be a string');
  }
  const envelope: MessageEnvelope = {
    v: ENVELOPE_VERSION,
    chatId: parts.chatId,
    senderId: parts.senderId,
    iv: parts.iv,
    ct: parts.ct,
    alg: ENVELOPE_ALG,
  };
  if (parts.kid) envelope.kid = parts.kid;
  return envelope;
}

/**
 * Encrypt one text field into a v1 envelope.
 * Returns null for empty / whitespace-only input (nothing to encrypt —
 * callers leave the field alone instead of storing an empty envelope).
 * Throws when ctx invalid ho (khaali chatId/senderId, key/port missing) ya
 * crypto fail ho (e.g. bad key); the pipeline converts a missing key into
 * a fail-closed error before this is ever called.
 */
export async function encryptTextField(
  plaintext: string,
  ctx: EncryptContext,
): Promise<MessageEnvelope | null> {
  if (typeof plaintext !== 'string' || plaintext.trim().length === 0) return null;
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('E2EE: encryptTextField needs an EncryptContext');
  }
  if (typeof ctx.chatId !== 'string' || ctx.chatId.length === 0) {
    throw new Error('E2EE: EncryptContext.chatId must be a non-empty string');
  }
  if (typeof ctx.senderId !== 'string' || ctx.senderId.length === 0) {
    throw new Error('E2EE: EncryptContext.senderId must be a non-empty string');
  }
  if (!ctx.key || typeof ctx.key !== 'object') {
    throw new Error('E2EE: EncryptContext.key must be a CryptoKey');
  }
  if (!ctx.crypto || typeof ctx.crypto.encryptText !== 'function') {
    throw new Error('E2EE: EncryptContext.crypto.encryptText is missing');
  }
  // Port seedha real EncryptedEnvelope deta hai ({ iv, ct, kid? }) — koi
  // mapping nahi; `kid` envelope me jaata hai taaki rotation ke baad bhi
  // purani key se decrypt ho sake.
  const result = await ctx.crypto.encryptText(plaintext, ctx.key, ctx.keyId);
  if (!isBase64(result.iv) || !isBase64(result.ct)) {
    throw new Error('E2EE: crypto port returned a non-base64 iv/ct');
  }
  return createEnvelope({
    chatId: ctx.chatId,
    senderId: ctx.senderId,
    iv: result.iv,
    ct: result.ct,
    kid: result.kid,
  });
}

/**
 * Encrypt a media caption. Today ChatScreen has NO separate caption field
 * (the media label — "📷 Photo" etc. — lives in `text`), so this is for
 * the caption field when it is added; it is the same envelope format as
 * the body, only the stored field name differs (`e2eeCaption`).
 */
export async function encryptCaption(
  caption: string,
  ctx: EncryptContext,
): Promise<MessageEnvelope | null> {
  return encryptTextField(caption, ctx);
}

/**
 * Decrypt one envelope back to plaintext.
 * Returns null (never throws) when the envelope is malformed, the key is
 * wrong / missing, or GCM authentication fails (tampered ciphertext).
 * Callers mark such messages `decrypt-failed` instead of dropping them.
 * `MessageEnvelope` seedha `EncryptedEnvelope` hai — scope fields ke
 * saath port ko pass hota hai, koi mapping nahi.
 */
export async function decryptEnvelope(
  envelope: unknown,
  key: CryptoKey | null | undefined,
  crypto: E2eeCryptoPort,
): Promise<string | null> {
  if (!validateEnvelope(envelope) || !key) return null;
  if (!crypto || typeof crypto.decryptText !== 'function') return null;
  try {
    const text = await crypto.decryptText(toCryptoEnvelope(envelope), key);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

// ── Stored-doc field mapping ──────────────────────────────────────────────

/**
 * Fields to write on a message doc for its encrypted body:
 * the envelope goes in `e2ee`, `text` is wiped so no plaintext is stored,
 * and `encrypted: true` lets queries / old clients tell at a glance.
 * NOTE: this returns ONLY the e2ee-related fields — spread it over the
 * rest of the message doc (senderId, timestamp, status, mediaUrl, …).
 */
export function toEncryptedMessageFields(envelope: MessageEnvelope): {
  e2ee: MessageEnvelope;
  text: '';
  encrypted: true;
} {
  return { e2ee: envelope, text: '', encrypted: true };
}

/** Same mapping for a media caption, stored under `e2eeCaption`. */
export function toEncryptedCaptionFields(envelope: MessageEnvelope): {
  e2eeCaption: MessageEnvelope;
  caption: '';
  encrypted: true;
} {
  return { e2eeCaption: envelope, caption: '', encrypted: true };
}

/**
 * Migration / display flag for a legacy message, applied in memory on
 * load (NOT written back to the DB — history is not rewritten).
 * The UI shows a "🔓 Not encrypted" mark when `encryption === 'legacy'`.
 */
export function markLegacyMessage<T extends MessageDoc>(doc: T): T & { encryption: 'legacy' } {
  return { ...doc, encryption: 'legacy' as const };
}

/**
 * Marker for a message whose envelope could not be decrypted
 * (wrong key, rotated key, tampered ciphertext). The doc stays in the
 * list so the user sees the canonical placeholder
 * (`DECRYPT_FAILED_TEXT` — "Couldn't decrypt this message") instead of a
 * message silently vanishing. NOTE: e2eeChat.ts has its own local copy of
 * this marker with a different placeholder — uska owner yahan se align kare.
 */
export function markDecryptFailed<T extends MessageDoc>(
  doc: T,
): T & { encryption: 'decrypt-failed'; decryptError: true; text: typeof DECRYPT_FAILED_TEXT } {
  return {
    ...doc,
    encryption: 'decrypt-failed' as const,
    decryptError: true,
    text: DECRYPT_FAILED_TEXT,
  };
}
