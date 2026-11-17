/**
 * E2EE shared types — Worker E1 (Crypto Core).
 *
 * Ye file sirf types rakhti hai; koi runtime logic nahi. crypto.ts aur
 * keys.ts dono isi file se import karte hain taaki envelope/key ka shape
 * ek jagah se define ho.
 *
 * HONEST LIMIT: ye types client-side E2EE ke liye hain — chat key ECDH
 * key agreement se derive hoti hai (keyExchange.ts: dono devices apni
 * public keys exchange karte hain, phir ECDH + HKDF se ek hi AES key
 * derive karte hain). Ye Signal protocol nahi hai — na forward secrecy,
 * na per-message ratchet, na server-side enforcement. Server/database par
 * ciphertext hi dikhega. keys.ts ki per-chat symmetric keys ab encrypt
 * ke liye use nahi hoti (sirf purane same-device messages ka decrypt
 * fallback hain).
 */

/** AES-GCM IV length (96 bit) — har message ke liye fresh random IV. */
export const E2EE_IV_BYTES = 12;

/** AES key length (256 bit = 32 bytes). */
export const E2EE_KEY_BYTES = 32;

/** GCM auth tag length (128 bit = 16 bytes) — appended to the ciphertext. */
export const E2EE_TAG_BYTES = 16;

/** Envelope format version — aage format badle to yahin bump hoga. */
export const E2EE_ENVELOPE_VERSION = 1;

/**
 * Ek encrypted message ka wire format. Database / network par sirf ye
 * object store/send hota hai — plaintext kabhi isme nahi hota.
 *
 * - `iv`: per-message random 12-byte IV, base64.
 * - `ct`: ciphertext + 16-byte GCM auth tag (WebCrypto tag ko ciphertext
 *   ke end me jod deta hai), base64.
 * - `kid`: jis key se encrypt hua uska key id (rotation ke baad purani
 *   key se decrypt karne ke liye). Optional taaki v1 envelopes bhi chalein.
 */
export interface EncryptedEnvelope {
  v: 1;
  alg: 'AES-256-GCM';
  iv: string;
  ct: string;
  kid?: string;
}

/**
 * Ek chat ki symmetric key — IndexedDB me isi shape me store hoti hai.
 *
 * - `keyB64`: raw 32-byte AES key, base64. Ye SECRET hai — isse kabhi
 *   server ko mat bhejo, kabhi log mat karo.
 * - `previousKey`: rotation ke baad purani key — sirf purane messages
 *   decrypt karne ke liye rakhi jaati hai. Sirf ek generation peeche.
 * - `version`: rotation count (1 = pehli key).
 */
export interface ChatKey {
  chatId: string;
  keyId: string;
  keyB64: string;
  createdAt: number;
  rotatedAt: number | null;
  version: number;
  previousKey: { keyId: string; keyB64: string } | null;
}

/** Key ki public (non-secret) metadata — list/export UI ke liye. */
export interface KeyMeta {
  chatId: string;
  keyId: string;
  createdAt: number;
  rotatedAt: number | null;
  version: number;
  hasPreviousKey: boolean;
}

/** Decrypt fail hone par throw hone wala error (tamper / galat key). */
export class E2EEDecryptError extends Error {
  constructor(message = 'Decryption failed: message tampered or wrong key') {
    super(message);
    this.name = 'E2EEDecryptError';
    // Transpile target ES5 hone par bhi `instanceof` sahi chale.
    Object.setPrototypeOf(this, E2EEDecryptError.prototype);
  }
}
