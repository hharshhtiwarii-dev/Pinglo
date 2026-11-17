import { deleteDoc, doc, getDoc, setDoc, auth, db } from '../aws';
import { deleteChatMediaMany } from '../aws/storage';
import { deletePin } from './pin';

/**
 * Secret Vault notes — CLIENT-SIDE ENCRYPTED (Phase 4, Worker C).
 *
 * - Notes live in the owner-only private doc `users/{uid}/private/vault` —
 *   the same private area pin.ts stores PIN hashes in. They are never
 *   written to the public user doc or to any chat.
 * - NEW: note contents are encrypted with AES-256-GCM (WebCrypto). The key
 *   is derived from the vault PIN with PBKDF2-SHA256 (600,000 iterations —
 *   OWASP 2023 recommendation for PBKDF2-HMAC-SHA256; see
 *   VAULT_PBKDF2_ITERATIONS) and a random 16-byte salt stored in the
 *   vault doc (`encSalt`, base64 — a salt is not secret). The derived key
 *   lives ONLY in memory for the current unlock session (`vaultKey`,
 *   cleared on lock/erase); it is never written to storage.
 * - MIGRATION (AUDIT-2 A8): vaults created at the old 210,000 iterations
 *   keep working — the stored iteration count (`kdfIterations`, default
 *   210,000 when absent) is honoured on unlock, and on the next
 *   successful unlock every note is re-encrypted under a key derived at
 *   600,000 iterations and `kdfIterations` is bumped. If the PIN is wrong
 *   no note decrypts under the old key and the migration is skipped (the
 *   old iteration count stays), so a wrong PIN can never strand the notes.
 * - Each note stores `{ id, createdAt, updatedAt, enc }` where `enc` is
 *   base64(12-byte IV ‖ ciphertext) of JSON `{title, body}`. Timestamps
 *   stay plaintext so notes can be sorted/deleted without decrypting.
 * - MIGRATION: plaintext notes from earlier builds (`title`/`body`
 *   fields, no `enc`) are decrypted-readable as before; on the next
 *   unlock WITH the PIN-derived key available, `loadVaultNotes()` re-saves
 *   them encrypted and drops the plaintext fields. If the vault is opened
 *   without a session key (e.g. the PIN was not supplied to this module),
 *   legacy notes still load, encrypted notes show a locked placeholder,
 *   and new notes fall back to plaintext — that fallback is honest, not
 *   silent: VaultScreen shows a warning when the session key is missing.
 * - AUDIT-2 C4 SHARDING: notes are packed across shard docs `vault`,
 *   `vault-2`, `vault-3`, … (each capped at VAULT_SHARD_MAX_BYTES), not
 *   one unbounded doc — a vault of ~60 max-length notes already nears
 *   the DynamoDB 400KB item limit. Migration-safe: a vault with no
 *   shards is just shard 1, the old layout. The KDF salt/iterations
 *   stay on the main doc only. A single note bigger than a shard still
 *   gets its own shard; database.ts's putRaw guard then refuses it
 *   honestly if it exceeds 380KB.
 * - HONEST LIMIT: this is client-side encryption, NOT end-to-end
 *   encryption. The PIN is short (4 digits) so PBKDF2 only slows
 *   guessing; anyone who obtains the PIN — or the in-memory key while
 *   unlocked — can read the notes. The server / anyone with database
 *   access to the private doc sees ciphertext, not plaintext, which is
 *   strictly better than before (plaintext at rest), but it is NOT a
 *   substitute for E2EE or for a strong passphrase.
 */

export const VAULT_PIN_KEY = 'vaultPin';
const VAULT_DOC_ID = 'vault';
/**
 * AUDIT-2 A8 — PBKDF2-SHA256 iterations for the vault key (was 210,000).
 * 600,000 is the OWASP 2023 recommendation for PBKDF2-HMAC-SHA256. It
 * runs once per vault unlock; measured ~0.3–0.6s on this VM's WebCrypto
 * and the same order on a mid-range phone. Honest limit: ~3x the
 * offline-guessing cost of 210k, but a 4-digit PIN (10,000 guesses) is
 * still quickly brute-forced offline once the vault doc is copied —
 * length (6–8 digits, see pin.ts PIN_GUIDANCE_TEXT) is the real
 * protection, not iterations.
 */
export const VAULT_PBKDF2_ITERATIONS = 600000;
/** Iteration count vaults created before AUDIT-2 Phase 2 were derived with. */
const VAULT_PBKDF2_ITERATIONS_LEGACY = 210000;

export interface VaultNote {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** Raw stored form: either encrypted (`enc`) or legacy plaintext (`title`/`body`). */
interface StoredNote {
  id: string;
  createdAt: number;
  updatedAt: number;
  enc?: string;
  title?: string;
  body?: string;
  /**
   * REPORT-3 #78: S3 media URLs referenced by this note, stored in
   * PLAINTEXT alongside the (encrypted) body. Deliberate tradeoff: the
   * URLs reveal which media objects the vault references, but NOT the
   * note text — and without them a "Forgot PIN" erase (no key, so the
   * bodies cannot be decrypted to find the URLs) left the S3 objects
   * behind forever. With mediaRefs, eraseVault can delete them blind.
   */
  mediaRefs?: string[];
}

/** S3 media URLs inside note text (same /media/ + /avatars/ rule eraseVault already used). */
function extractMediaRefs(title: string, body: string): string[] {
  const out: string[] = [];
  const urlRe = /https?:\/\/[^\s"'<>]+/g;
  for (const text of [title, body]) {
    for (const u of (text || '').match(urlRe) || []) {
      if ((u.includes('/media/') || u.includes('/avatars/')) && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

function currentUid(): string | null {
  return auth.currentUser?.uid ?? null;
}

const vaultRef = (uid: string) => doc(db, 'users', uid, 'private', VAULT_DOC_ID);

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── base64 helpers (binary-safe) ──────────────────────────────────────────
function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBuf(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ── Session key (memory only, never persisted) ────────────────────────────
let vaultKey: CryptoKey | null = null;

export function hasVaultKey(): boolean {
  return vaultKey !== null;
}

/** Clear the in-memory key (call on vault lock / erase / sign-out). */
export function clearVaultKey(): void {
  vaultKey = null;
}

/**
 * Derive the vault key from a PIN. Exported so probes/tests can measure
 * the KDF cost and verify the migration without a signed-in user.
 */
export async function deriveVaultKey(
  pin: string,
  salt: Uint8Array,
  iterations: number = VAULT_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.buffer as ArrayBuffer, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

interface VaultKdfParams {
  salt: Uint8Array;
  /** Iterations the stored notes were derived with (legacy default 210k). */
  iterations: number;
}

async function getOrCreateKdfParams(uid: string): Promise<VaultKdfParams> {
  const snap = await getDoc(vaultRef(uid));
  const data = snap.exists() ? (snap.data() as any) : undefined;
  const storedSalt = typeof data?.encSalt === 'string' && data.encSalt.length > 0 ? data.encSalt : undefined;
  const storedIterations =
    typeof data?.kdfIterations === 'number' && Number.isFinite(data.kdfIterations) && data.kdfIterations > 0
      ? Math.floor(data.kdfIterations)
      : VAULT_PBKDF2_ITERATIONS_LEGACY;
  if (storedSalt) {
    try {
      return { salt: b64ToBuf(storedSalt), iterations: storedIterations };
    } catch {
      /* corrupt salt: fall through and create a fresh one */
    }
  }
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  await setDoc(
    vaultRef(uid),
    { encSalt: bufToB64(salt), kdfIterations: VAULT_PBKDF2_ITERATIONS, updatedAt: Date.now() },
    { merge: true },
  ).catch(() => {});
  return { salt, iterations: VAULT_PBKDF2_ITERATIONS };
}

/**
 * Re-encrypt every note from `oldKey` to `newKey` and bump the stored
 * iteration count. Returns true when it is safe to switch to the new key:
 * there are no encrypted notes, or at least one re-encrypted cleanly
 * (notes that fail under the old key were already undecryptable — e.g.
 * corrupt — and are kept as-is). Returns false when encrypted notes
 * exist but NONE decrypted under the old key, which means the PIN was
 * wrong: the caller must keep the old key and the old iteration count,
 * or the notes would be stranded.
 */
async function migrateVaultKdf(uid: string, oldKey: CryptoKey, newKey: CryptoKey): Promise<boolean> {
  const stored = await loadStoredNotes();
  let encTotal = 0;
  let encOk = 0;
  let changed = false;
  const out: StoredNote[] = [];
  for (const n of stored) {
    if (typeof n.enc === 'string') {
      encTotal += 1;
      vaultKey = oldKey;
      const dec = await decryptPayload(n.enc);
      if (!dec) {
        out.push(n);
        continue;
      }
      vaultKey = newKey;
      try {
        const enc = await encryptPayload(dec);
        out.push({ id: n.id, createdAt: n.createdAt, updatedAt: n.updatedAt, enc });
        encOk += 1;
        changed = true;
      } catch {
        out.push(n);
      }
    } else {
      // Legacy plaintext note: loadVaultNotes() migrates it with the new key.
      out.push(n);
    }
  }
  vaultKey = newKey;
  if (encTotal > 0 && encOk === 0) {
    vaultKey = oldKey;
    return false;
  }
  if (changed) await saveStoredNotes(out).catch(() => {});
  await setDoc(vaultRef(uid), { kdfIterations: VAULT_PBKDF2_ITERATIONS, updatedAt: Date.now() }, { merge: true }).catch(() => {});
  return true;
}

/**
 * Derive + hold the vault key for this unlock session. Call with the PIN
 * the user just entered (PinScreen supplies it via `onPinVerified`).
 * Returns false when no PIN / no user — callers then use the legacy
 * plaintext path and should warn the user.
 *
 * AUDIT-2 A8: vaults created at 210,000 iterations are migrated to
 * 600,000 on this successful unlock (see `migrateVaultKdf`).
 */
export async function setVaultSessionKey(pin: string): Promise<boolean> {
  const uid = currentUid();
  if (!uid || !pin) {
    vaultKey = null;
    return false;
  }
  try {
    const { salt, iterations } = await getOrCreateKdfParams(uid);
    const key = await deriveVaultKey(pin, salt, iterations);
    vaultKey = key;
    if (iterations < VAULT_PBKDF2_ITERATIONS) {
      const newKey = await deriveVaultKey(pin, salt, VAULT_PBKDF2_ITERATIONS);
      const ok = await migrateVaultKdf(uid, key, newKey);
      vaultKey = ok ? newKey : key;
    }
    return true;
  } catch {
    vaultKey = null;
    return false;
  }
}

async function encryptPayload(payload: { title: string; body: string }): Promise<string> {
  if (!vaultKey) throw new Error('Vault is locked');
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, vaultKey, data);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return bufToB64(combined);
}

async function decryptPayload(enc: string): Promise<{ title: string; body: string } | null> {
  if (!vaultKey) return null;
  try {
    const combined = b64ToBuf(enc);
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      vaultKey,
      cipher.buffer as ArrayBuffer
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain));
    if (typeof parsed?.body !== 'string') return null;
    return { title: typeof parsed.title === 'string' ? parsed.title : '', body: parsed.body };
  } catch {
    return null; // wrong key / corrupt data: never throw plaintext at the caller
  }
}

// ── Raw storage ───────────────────────────────────────────────────────────
// AUDIT-2 C4: shard docs (see header). Shard 1 is the legacy `vault` doc.
/** Largest serialized notes array in one vault shard doc (headroom under the 400KB DynamoDB limit). */
export const VAULT_SHARD_MAX_BYTES = 256 * 1024;
/** Hard cap on shard probing, so a corrupt layout cannot loop forever. */
export const VAULT_MAX_SHARDS = 64;

const vaultShardRef = (uid: string, n: number) =>
  n <= 1 ? vaultRef(uid) : doc(db, 'users', uid, 'private', `${VAULT_DOC_ID}-${n}`);

function estimateNotesBytes(notes: StoredNote[]): number {
  try {
    const json = JSON.stringify(notes);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
    return json.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Pack notes (kept in order, newest first) into shard-sized groups. A single over-cap note still gets its own shard. */
function packNotesIntoShards(notes: StoredNote[]): StoredNote[][] {
  const shards: StoredNote[][] = [[]];
  for (const n of notes) {
    const cur = shards[shards.length - 1];
    if (cur.length > 0 && estimateNotesBytes([...cur, n]) > VAULT_SHARD_MAX_BYTES) {
      shards.push([n]);
    } else {
      cur.push(n);
    }
  }
  return shards;
}

/**
 * Load all vault notes across shards, newest first. Shards are
 * discovered by probing (vault-2, vault-3, … until one does not exist)
 * rather than trusting a stored count, so a save interrupted halfway
 * can never strand a shard.
 */
async function loadStoredNotes(): Promise<StoredNote[]> {
  const uid = currentUid();
  if (!uid) return [];
  const out: StoredNote[] = [];
  for (let n = 1; n <= VAULT_MAX_SHARDS; n++) {
    const snap = await getDoc(vaultShardRef(uid, n));
    if (!snap.exists()) break;
    const raw = (snap.data() as any).notes;
    if (!Array.isArray(raw)) {
      // A doc with no notes array (e.g. the main doc of a vault that
      // only holds KDF params so far) is not the end of the chain when
      // it is shard 1 — keep probing; for shard 2+ it is.
      if (n === 1) continue;
      break;
    }
    for (const note of raw) {
      if (note && typeof (note as StoredNote).id === 'string') out.push(note as StoredNote);
    }
  }
  return out;
}

/** Rewrite all notes, repacked across shards. Surplus shards from before are deleted so no note survives a shrink. */
async function saveStoredNotes(notes: StoredNote[]): Promise<void> {
  const uid = currentUid();
  if (!uid) throw new Error('Not signed in');
  const shards = packNotesIntoShards(notes);
  for (let i = 0; i < shards.length; i++) {
    const ref = vaultShardRef(uid, i + 1);
    if (i === 0) {
      // Main doc also carries encSalt / kdfIterations — merge, never replace.
      await setDoc(ref, { notes: shards[i], noteShardCount: shards.length, updatedAt: Date.now() }, { merge: true });
    } else {
      await setDoc(ref, { notes: shards[i], updatedAt: Date.now() });
    }
  }
  // Delete any surplus shards from before; probe until the first missing
  // doc so a count left stale by an interrupted save cannot strand notes.
  for (let n = shards.length + 1; n <= VAULT_MAX_SHARDS; n++) {
    const snap = await getDoc(vaultShardRef(uid, n));
    if (!snap.exists()) break;
    await deleteDoc(vaultShardRef(uid, n)).catch(() => {});
  }
}

function normalizeLegacy(n: StoredNote): VaultNote {
  return {
    id: n.id,
    title: typeof n.title === 'string' ? n.title : '',
    body: typeof n.body === 'string' ? n.body : '',
    createdAt: typeof n.createdAt === 'number' ? n.createdAt : 0,
    updatedAt: typeof n.updatedAt === 'number' ? n.updatedAt : 0,
  };
}

/**
 * Load all vault notes (newest first). Encrypted notes are decrypted with
 * the session key; without a key they appear as a locked placeholder.
 * When a key IS present, any legacy plaintext notes are migrated to
 * encrypted form on this load (best-effort; a failure leaves them
 * plaintext rather than losing them).
 */
export async function loadVaultNotes(): Promise<VaultNote[]> {
  const stored = await loadStoredNotes();
  const out: VaultNote[] = [];
  let needsMigration = false;
  const migrated: StoredNote[] = [];

  for (const n of stored) {
    if (typeof n.enc === 'string') {
      const dec = await decryptPayload(n.enc);
      if (dec) {
        out.push({ id: n.id, title: dec.title, body: dec.body, createdAt: n.createdAt, updatedAt: n.updatedAt });
        migrated.push(n);
      } else {
        // No key (or wrong key): show a placeholder, keep the ciphertext.
        out.push({
          id: n.id,
          title: 'Encrypted note',
          body: '🔒 Locked — unlock the vault with your PIN to read this note.',
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        });
        migrated.push(n);
      }
    } else {
      // Legacy plaintext note. Phase 5 (L-27): without a session key it is
      // NEVER returned as readable text — it shows the same locked
      // placeholder as an undecryptable note, and is migrated to encrypted
      // form on the next load WITH a key (below). Returning it readable
      // was the plaintext-at-rest hole.
      if (!vaultKey) {
        out.push({
          id: n.id,
          title: 'Encrypted note',
          body: '🔒 Locked — unlock the vault with your PIN to read this note.',
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        });
        migrated.push(n);
        continue;
      }
      out.push(normalizeLegacy(n));
      if (vaultKey) {
        needsMigration = true;
        try {
          const enc = await encryptPayload({ title: out[out.length - 1].title, body: out[out.length - 1].body });
          // REPORT-3 #78: migrating a legacy note also records its refs.
          migrated.push({ id: n.id, createdAt: n.createdAt, updatedAt: n.updatedAt, enc, mediaRefs: extractMediaRefs(out[out.length - 1].title, out[out.length - 1].body) });
        } catch {
          migrated.push(n);
        }
      } else {
        migrated.push(n);
      }
    }
  }

  if (needsMigration) {
    await saveStoredNotes(migrated).catch(() => {});
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Add a note. Encrypted when a session key is held, plaintext otherwise (see header). */
export async function addVaultNote(title: string, body: string): Promise<VaultNote> {
  const cleanBody = body.trim();
  if (!cleanBody) throw new Error('Note is empty');
  const now = Date.now();
  const cleanTitle = title.trim() || cleanBody.split('\n')[0].slice(0, 60);
  const note: VaultNote = { id: newId(), title: cleanTitle, body: cleanBody, createdAt: now, updatedAt: now };
  const stored = await loadStoredNotes();
  let storedNote: StoredNote;
  // REPORT-3 #78: record the note's S3 media refs in plaintext (see
  // StoredNote.mediaRefs) so a key-less erase can still delete them.
  const mediaRefs = extractMediaRefs(cleanTitle, cleanBody);
  if (vaultKey) {
    try {
      storedNote = { id: note.id, createdAt: now, updatedAt: now, enc: await encryptPayload({ title: cleanTitle, body: cleanBody }), mediaRefs };
    } catch {
      storedNote = { id: note.id, title: cleanTitle, body: cleanBody, createdAt: now, updatedAt: now, mediaRefs };
    }
  } else {
    storedNote = { id: note.id, title: cleanTitle, body: cleanBody, createdAt: now, updatedAt: now, mediaRefs };
  }
  await saveStoredNotes([storedNote, ...stored]);
  return note;
}

/** Delete one note by id. */
export async function deleteVaultNote(id: string): Promise<void> {
  const notes = await loadStoredNotes();
  await saveStoredNotes(notes.filter((n) => n.id !== id));
}

/**
 * S22 (100-more): update a note's title/body in place. Keeps the id and
 * createdAt, bumps updatedAt, and re-encrypts with the session key using
 * the same path as addVaultNote (REPORT-3 #78 mediaRefs preserved).
 */
export async function updateVaultNote(id: string, title: string, body: string): Promise<VaultNote> {
  const cleanBody = body.trim();
  if (!cleanBody) throw new Error('Note is empty');
  const cleanTitle = title.trim() || cleanBody.split('\n')[0].slice(0, 60);
  const stored = await loadStoredNotes();
  const existing = stored.find((n) => n.id === id);
  if (!existing) throw new Error('Note not found');
  const now = Date.now();
  const mediaRefs = extractMediaRefs(cleanTitle, cleanBody);
  let updated: StoredNote;
  if (vaultKey) {
    try {
      updated = { id, createdAt: existing.createdAt, updatedAt: now, enc: await encryptPayload({ title: cleanTitle, body: cleanBody }), mediaRefs };
    } catch {
      updated = { id, createdAt: existing.createdAt, updatedAt: now, title: cleanTitle, body: cleanBody, mediaRefs };
    }
  } else {
    updated = { id, createdAt: existing.createdAt, updatedAt: now, title: cleanTitle, body: cleanBody, mediaRefs };
  }
  await saveStoredNotes(stored.map((n) => (n.id === id ? updated : n)));
  return { id, title: cleanTitle, body: cleanBody, createdAt: existing.createdAt, updatedAt: now };
}

/**
 * Erase the whole vault: deletes the vault PIN (and its lockout counters),
 * all vault notes, the encryption salt, and the in-memory session key.
 * Used by the "Forgot PIN?" flow on the PIN screen. This is deliberately
 * destructive — it is the only way back in without the PIN, and it
 * guarantees a locked-out vault can never be read, only wiped.
 */
export async function eraseVault(): Promise<void> {
  const uid = currentUid();
  if (!uid) throw new Error('Not signed in');
  clearVaultKey();
  // REPORT-3 #78 (W10): the wipe must delete referenced S3 media even
  // WITHOUT the session key. Before, only the decrypted-body scan below
  // found URLs, so a key-less erase left the S3 objects behind. Now:
  // (1) the plaintext `mediaRefs` recorded at add-time cover every note
  // written since this fix, with or without a key; (2) when a key IS
  // held, the decrypted-body scan still covers older notes written
  // before mediaRefs existed. Pre-fix notes erased without a key can
  // still leave their S3 objects behind — that residue is unavoidable
  // (the URLs are inside undecryptable ciphertext) and is stated here,
  // not hidden.
  try {
    const rawNotes = await loadStoredNotes();
    const urls: string[] = [];
    for (const n of rawNotes) {
      for (const u of n.mediaRefs || []) if (!urls.includes(u)) urls.push(u);
    }
    if (urls.length > 0) await deleteChatMediaMany(urls);
  } catch { /* intentionally ignored */}
  await deletePin(VAULT_PIN_KEY).catch(() => {});
  // AUDIT-2 C4: the vault may span shard docs — delete every shard,
  // probing until the first missing one, or notes would survive the wipe.
  for (let n = 1; n <= VAULT_MAX_SHARDS; n++) {
    const snap = await getDoc(vaultShardRef(uid, n)).catch(() => null);
    if (!snap || !snap.exists()) break;
    await deleteDoc(vaultShardRef(uid, n)).catch(() => {});
  }
}
