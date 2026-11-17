import { deleteField, doc, getDoc, setDoc, updateDoc, auth, db } from '../aws';

/**
 * PIN storage.
 *
 * - PINs are stored as a salted PBKDF2-SHA256 hash (v3 format) in
 *   users/{uid}/private/pins. That sub-document is readable/writable only by its
 *   owner (see the AppSync ownership rules).
 * - v3 hashes use 600,000 PBKDF2-HMAC-SHA256 iterations (OWASP 2023
 *   recommendation). Older v2 hashes (210,000 iterations) still verify and
 *   are upgraded to v3 on the next successful unlock; v1 (salted SHA-256)
 *   verifies and upgrades the same way.
 * - Older builds stored the raw PIN in users/{uid}[pinKey]; that is readable by
 *   every signed-in user, so it is migrated to the private hash on first successful
 *   unlock and then deleted.
 * - 100M-D7: the old code ALSO accepted that plaintext field as a standing
 *   credential (verifyPin's "legacy plaintext fallback" branch) and
 *   `deletePin` never removed it, so a legacy PIN stayed usable forever
 *   and survived the vault's "Erase everything". The fallback is now a
 *   strictly one-time migration (verifyPin): it fires only when the
 *   private doc has NO entry, and on success the PIN is hashed into the
 *   private doc and the plaintext field is deleted and its deletion
 *   verified — the branch can never fire twice for the same pinKey.
 *   `deletePin` and `savePin` delete the legacy field too (awaited and
 *   logged, never swallowed).
 * - `hasPin` still treats a legacy field as "a PIN is set". That is
 *   deliberate, NOT an oversight: PinScreen chooses CREATE vs ENTER from
 *   it, and CREATE + savePin would overwrite the PIN and unlock the gate
 *   without knowing the old one — AppLockGate renders PinScreen at
 *   startup (AppLockScreen.tsx) and `shouldShowAppLock()` never consults
 *   hasPin, so dropping the legacy read would turn the app-lock and
 *   locked-chats gates into CREATE screens for legacy accounts (a bypass;
 *   the vault would lose its old notes instead, its key being PIN-derived
 *   — see PinScreen RC44). The legacy read only selects the ENTER stage;
 *   it never grants access, and the field is deleted on first unlock /
 *   save / delete, after which the read is dead code.
 * - Failed attempts and the lockout are stored in the same private doc, so they
 *   survive app reloads and cannot be reset by clearing local storage.
 *
 * AUDIT-2 A8 — lockout hardening:
 * - The lockout is enforced from the MAX of the wall-clock remaining time
 *   and a monotonic remaining time (see `effectiveRemainingMs`). A
 *   monotonic anchor (wall time + `performance.now()` at the moment the
 *   lockout was set/observed) is kept in localStorage, so moving the
 *   device clock FORWARD while the app is running cannot shorten the
 *   lockout. `performance.now()` resets on every page load, so an anchor
 *   from a previous session cannot be trusted — after a restart the
 *   lockout falls back to the server (wall-clock) value in the private
 *   doc, which still survives restarts. A forward clock jump across a
 *   restart is the remaining hole: only a trusted server timestamp can
 *   close it (needs backend — see PATCH-1A).
 * - The fail counter is incremented SYNCHRONOUSLY in localStorage
 *   (`recordLocalPinAttempt`) BEFORE any async work runs, and attempts
 *   are serialised per pinKey (`withPinLock`), so parallel attempts can
 *   no longer read the same count and skip the lockout. The server doc
 *   is reconciled with `max(server, local)` on every attempt. Cross-device
 *   races (two phones guessing at once) still need a server-side atomic
 *   increment — same backend note as above.
 */

const PRIVATE_PIN_DOC = 'pins';
/** Legacy v2 iteration count — kept only to verify (and upgrade) old hashes. */
const PBKDF2_ITERATIONS_V2 = 210000;
/**
 * Current iteration count (v3). OWASP 2023 recommends 600,000 for
 * PBKDF2-HMAC-SHA256. This runs once per unlock (a lock-screen action,
 * not a hot path); measured ~0.3–0.6s on this VM's WebCrypto and the same
 * order on a mid-range phone — acceptable for a PIN check, and ~3x the
 * offline-guessing cost of v2. Honest limit: no iteration count saves a
 * 4-digit PIN from offline guessing once the hash is copied — length is
 * the real protection (see PIN_GUIDANCE_TEXT).
 */
const PBKDF2_ITERATIONS = 600000;
const MAX_FAILS_BEFORE_LOCK = 5;
const BASE_LOCK_MS = 30000;
const MAX_LOCK_MS = 15 * 60 * 1000;

/** PIN length the UI offers. 4-digit PINs keep working (existing users). */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const PIN_RECOMMENDED_MIN_LENGTH = 6;
export const PIN_GUIDANCE_TEXT =
  'A 4-digit PIN has only 10,000 combinations — anyone who gets your phone can guess it quickly. ' +
  'Use 6–8 digits if you can remember them; every extra digit makes guessing 10× harder. ' +
  'Even a slow key check cannot save a short PIN if someone copies your encrypted data, so length is the real protection.';

export function describePinStrength(pin: string): {
  length: number;
  combinations: number;
  label: 'weak' | 'fair' | 'strong';
  advice: string;
} {
  const digits = (pin || '').replace(/\D/g, '');
  const length = digits.length;
  const combinations = 10 ** length;
  if (length < 4) {
    return { length, combinations, label: 'weak', advice: 'Use at least 4 digits.' };
  }
  if (length === 4) {
    return {
      length,
      combinations,
      label: 'weak',
      advice:
        'A 4-digit PIN has only 10,000 combinations — anyone who gets your phone can guess it quickly. Use 6–8 digits if you can remember them.',
    };
  }
  if (length < 6) {
    return {
      length,
      combinations,
      label: 'fair',
      advice: 'Better than 4 digits, but 6–8 digits is much harder to guess.',
    };
  }
  return {
    length,
    combinations,
    label: 'strong',
    advice: 'Good — 6 or more digits makes guessing far harder.',
  };
}

export class PinLockedError extends Error {
  constructor(public readonly untilMs: number) {
    super('PIN locked');
  }
}

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(buf as ArrayBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

/** Legacy v1 hash (salted SHA-256). Kept only to verify old PINs. */
async function hashPinV1(uid: string, pinKey: string, pin: string): Promise<string> {
  return sha256Hex(`${uid}:${pinKey}:${pin}`);
}

/**
 * v2/v3 hash: PBKDF2-SHA256 with a random per-PIN salt.
 * Stored as "v2$<saltHex>$<hashHex>" (210k) or "v3$<saltHex>$<hashHex>" (600k).
 */
async function hashPin(pin: string, saltHex: string, version: 2 | 3): Promise<string> {
  const iterations = version === 3 ? PBKDF2_ITERATIONS : PBKDF2_ITERATIONS_V2;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex).buffer as ArrayBuffer, iterations },
    key,
    256
  );
  return `v${version}$${saltHex}$${toHex(bits)}`;
}

async function newStoredPin(pin: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return hashPin(pin, toHex(salt), 3);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function currentUid(): string | null {
  return auth.currentUser?.uid ?? null;
}

const privateRef = (uid: string) => doc(db, 'users', uid, 'private', PRIVATE_PIN_DOC);

async function readPrivate(uid: string): Promise<Record<string, any>> {
  const snap = await getDoc(privateRef(uid));
  return snap.exists() ? snap.data() : {};
}

/* ------------------------------------------------------------------ */
/* Lockout hardening (AUDIT-2 A8): monotonic anchor + atomic counting  */
/* ------------------------------------------------------------------ */

/** A lockout observed at `anchorWall` (wall) / `anchorPerf` (monotonic). */
export interface LockAnchor {
  untilWall: number;
  anchorWall: number;
  anchorPerf: number;
  durationMs: number;
  sessionId: string;
}

const LOCAL_LOCK_PREFIX = 'dt_pin_lock_v1:';
const LOCAL_FAILS_PREFIX = 'dt_pin_fails_v1:';

/** In-memory fallback when localStorage is unavailable (private mode). */
const memStore = new Map<string, string>();
function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return memStore.get(k) ?? null;
  }
}
function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    memStore.set(k, v);
  }
}
function lsDel(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    memStore.delete(k);
  }
}

let cachedSessionId: string | null = null;
/** Stable id for this page load. `performance.now()` is only comparable within one load. */
function sessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  try {
    let s = sessionStorage.getItem('dt_pin_session_v1');
    if (!s) {
      s =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem('dt_pin_session_v1', s);
    }
    cachedSessionId = s;
  } catch {
    cachedSessionId = `mem-${Date.now().toString(36)}`;
  }
  return cachedSessionId;
}

function perfNow(): number {
  try {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  } catch {
    return Date.now();
  }
}

/** Build an anchor for a lockout ending at `untilWall`. Exported for tests/probes. */
export function makeLockAnchor(untilWall: number, nowWall: number = Date.now()): LockAnchor {
  return {
    untilWall,
    anchorWall: nowWall,
    anchorPerf: perfNow(),
    durationMs: Math.max(0, untilWall - nowWall),
    sessionId: sessionId(),
  };
}

export function readLockAnchor(pinKey: string): LockAnchor | null {
  try {
    const raw = lsGet(LOCAL_LOCK_PREFIX + pinKey);
    if (!raw) return null;
    const a = JSON.parse(raw) as LockAnchor;
    if (typeof a?.untilWall !== 'number' || typeof a?.anchorPerf !== 'number' || typeof a?.durationMs !== 'number') return null;
    return a;
  } catch {
    return null;
  }
}

function writeLockAnchor(pinKey: string, anchor: LockAnchor): void {
  try {
    lsSet(LOCAL_LOCK_PREFIX + pinKey, JSON.stringify(anchor));
  } catch {
    /* lockout still enforced server-side; the monotonic anchor is best-effort */
  }
}

/** Ensure a monotonic anchor exists for a lockout ending at `untilWall`. */
function ensureLockAnchor(pinKey: string, untilWall: number): void {
  if (!(untilWall > Date.now())) return;
  const existing = readLockAnchor(pinKey);
  if (existing && existing.untilWall === untilWall && existing.sessionId === sessionId()) return;
  writeLockAnchor(pinKey, makeLockAnchor(untilWall));
}

/**
 * Monotonic remaining ms for an anchor, or null when the anchor is
 * unusable — e.g. it was written in a previous page load, where
 * `performance.now()` had a different origin. Exported for tests/probes.
 */
export function monotonicRemainingMs(anchor: LockAnchor | null, nowPerf: number = perfNow()): number | null {
  if (!anchor) return null;
  if (anchor.sessionId !== sessionId()) return null;
  const elapsed = nowPerf - anchor.anchorPerf;
  if (elapsed < 0) return anchor.durationMs; // monotonic clock anomaly: fail safe, full duration
  return Math.max(0, anchor.durationMs - elapsed);
}

/**
 * Effective remaining lockout: the LONGER of wall-clock and monotonic.
 * Moving the device clock forward cannot shorten it while the app is
 * running; moving it back only extends it (safe direction).
 */
export function effectiveRemainingMs(
  untilWall: number,
  anchor: LockAnchor | null,
  nowWall: number = Date.now(),
  nowPerf?: number,
): number {
  const wall = Math.max(0, untilWall - nowWall);
  const mono = monotonicRemainingMs(anchor, nowPerf);
  return Math.max(wall, mono ?? 0);
}

/** Local (this-device) lockout end, wall-clock timestamp, 0 if not locked. */
export function getLocalLockUntil(pinKey: string, nowWall: number = Date.now()): number {
  const anchor = readLockAnchor(pinKey);
  if (!anchor) return 0;
  const remaining = effectiveRemainingMs(anchor.untilWall, anchor, nowWall);
  return remaining > 0 ? nowWall + remaining : 0;
}

/**
 * Synchronously record one attempt in localStorage BEFORE any async work.
 * `localStorage` writes are synchronous in JS, so two parallel attempts in
 * this tab cannot both read the same count. Returns the new local count.
 * When the count reaches the lockout threshold the lockout anchor is
 * written synchronously too, so the device enforces the lockout even if
 * the server write that follows fails (offline).
 */
export function recordLocalPinAttempt(pinKey: string): number {
  const k = LOCAL_FAILS_PREFIX + pinKey;
  const cur = Number(lsGet(k) || 0) || 0;
  const next = cur + 1;
  lsSet(k, String(next));
  if (next >= MAX_FAILS_BEFORE_LOCK) {
    const step = Math.floor((next - MAX_FAILS_BEFORE_LOCK) / MAX_FAILS_BEFORE_LOCK);
    const duration = Math.min(BASE_LOCK_MS * 2 ** step, MAX_LOCK_MS);
    writeLockAnchor(pinKey, makeLockAnchor(Date.now() + duration));
  }
  return next;
}

export function resetLocalPinAttempts(pinKey: string): void {
  lsDel(LOCAL_FAILS_PREFIX + pinKey);
  lsDel(LOCAL_LOCK_PREFIX + pinKey);
}

/** Serialise attempts per pinKey so concurrent verifies cannot race the counter. */
const verifyChains = new Map<string, Promise<unknown>>();
function withPinLock<T>(pinKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = verifyChains.get(pinKey) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const entry = next.then(
    (value) => {
      if (verifyChains.get(pinKey) === entry) verifyChains.delete(pinKey);
      return value;
    },
    (err) => {
      if (verifyChains.get(pinKey) === entry) verifyChains.delete(pinKey);
      throw err;
    },
  );
  verifyChains.set(pinKey, entry.catch(() => undefined));
  return entry;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Whether a PIN has already been set for this pinKey. */
export async function hasPin(pinKey: string): Promise<boolean> {
  const uid = currentUid();
  if (!uid) return false;

  const priv = await readPrivate(uid);
  if (priv[pinKey]) return true;

  // 100M-D7: legacy plaintext field (pre-migration) still counts as "a PIN
  // is set". PinScreen picks CREATE vs ENTER from this, and CREATE would
  // let anyone holding the phone set a NEW PIN and walk past the gate
  // without knowing the old one (AppLockGate / LockedChatsFolder render
  // PinScreen; the vault would lose its PIN-derived notes instead — see
  // the header note). This read only selects the ENTER stage; it never
  // grants access, and the field is deleted on first unlock / save /
  // delete, so the branch goes dead once migration has run.
  const userSnap = await getDoc(doc(db, 'users', uid));
  return !!(userSnap.exists() && userSnap.data()[pinKey]);
}

/** Length of the stored PIN (4 when unknown — pre-AUDIT-2 PINs). Used by the PIN screen to auto-submit at the right length. */
export async function getPinLength(pinKey: string): Promise<number> {
  const uid = currentUid();
  if (!uid) return PIN_MIN_LENGTH;
  try {
    const priv = await readPrivate(uid);
    const len = Number(priv[`${pinKey}_len`]) || 0;
    if (len >= PIN_MIN_LENGTH && len <= PIN_MAX_LENGTH) return len;
  } catch {
    /* fall through to the default */
  }
  return PIN_MIN_LENGTH;
}

/**
 * Delete a legacy plaintext PIN field from the public users doc.
 * Returns true when the field is gone (or was never there). Logs and
 * returns false on failure so callers can retry / warn — 100M-D7: the old
 * fire-and-forget `.catch(() => {})` could fail silently and leave a
 * plaintext PIN enumerable by any signed-in user. Never throws: a failed
 * delete must not block saving or deleting the hashed PIN itself.
 */
async function deleteLegacyPinField(uid: string, pinKey: string): Promise<boolean> {
  try {
    await updateDoc(doc(db, 'users', uid), { [pinKey]: deleteField() });
    return true;
  } catch (err) {
    console.warn(`[pin] deleteLegacyPinField(${pinKey}) failed — plaintext PIN may still be in the users doc`, err);
    return false;
  }
}

/** Save (or replace) a PIN as a salted hash in the owner-only private doc. */
export async function savePin(pinKey: string, pin: string): Promise<void> {
  const uid = currentUid();
  if (!uid) throw new Error('Not signed in');

  const stored = await newStoredPin(pin);
  await setDoc(
    privateRef(uid),
    {
      [pinKey]: stored,
      [`${pinKey}_len`]: (pin || '').replace(/\D/g, '').length || PIN_MIN_LENGTH,
      [`${pinKey}_fails`]: 0,
      [`${pinKey}_until`]: 0,
      updatedAt: Date.now(),
    },
    { merge: true }
  );
  resetLocalPinAttempts(pinKey);

  // Remove any legacy plaintext copy so it can't be read by other users.
  // 100M-D7: awaited and logged — the old fire-and-forget delete could
  // fail silently and leave the plaintext PIN in the public users doc.
  const legacyDeleted = await deleteLegacyPinField(uid, pinKey);
  if (!legacyDeleted) {
    console.warn(`[pin] savePin(${pinKey}): legacy plaintext field delete failed — retry on next unlock`);
  }
}

/** Delete a PIN (and its failure/lockout counters). Used by the vault's "forgot PIN" erase flow. */
export async function deletePin(pinKey: string): Promise<void> {
  const uid = currentUid();
  if (!uid) throw new Error('Not signed in');
  resetLocalPinAttempts(pinKey);
  await updateDoc(privateRef(uid), {
    [pinKey]: deleteField(),
    [`${pinKey}_len`]: deleteField(),
    [`${pinKey}_fails`]: deleteField(),
    [`${pinKey}_until`]: deleteField(),
  }).catch(() => {});
  // 100M-D7: also delete the legacy plaintext field in the public users
  // doc. The old code never touched it, so "Erase everything" left a
  // legacy PIN fully functional — the same PIN unlocked again afterwards.
  const legacyDeleted = await deleteLegacyPinField(uid, pinKey);
  if (!legacyDeleted) {
    console.warn(`[pin] deletePin(${pinKey}): legacy plaintext field delete failed — legacy PIN may still unlock`);
  }
}

/**
 * Current lockout state for a pinKey (ms timestamp when the lock ends, 0 if not locked).
 * MAX of the server lockout and the local monotonic lockout, so a moved
 * device clock cannot clear it while the app is running. Survives app
 * restarts via the private doc (and the local anchor, wall-clock only
 * after a restart — see the header note).
 */
export async function getPinLockUntil(pinKey: string): Promise<number> {
  const localUntil = getLocalLockUntil(pinKey);
  const uid = currentUid();
  if (!uid) return localUntil > Date.now() ? localUntil : 0;
  const priv = await readPrivate(uid);
  const serverUntil = Number(priv[`${pinKey}_until`]) || 0;
  ensureLockAnchor(pinKey, serverUntil);
  const until = Math.max(serverUntil, getLocalLockUntil(pinKey));
  return until > Date.now() ? until : 0;
}

async function recordFailure(uid: string, pinKey: string, failsIncludingThisAttempt: number): Promise<number> {
  const fails = Math.max(1, failsIncludingThisAttempt);
  let until = 0;
  if (fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = Math.floor((fails - MAX_FAILS_BEFORE_LOCK) / MAX_FAILS_BEFORE_LOCK);
    const duration = Math.min(BASE_LOCK_MS * 2 ** step, MAX_LOCK_MS);
    until = Date.now() + duration;
  }
  await setDoc(
    privateRef(uid),
    { [`${pinKey}_fails`]: fails, [`${pinKey}_until`]: until },
    { merge: true }
  );
  if (until > Date.now()) ensureLockAnchor(pinKey, until);
  return until;
}

/**
 * Check a PIN.
 * - Throws PinLockedError while the account is locked after too many failures.
 * - Upgrades v1/v2 hashes to v3 and migrates legacy plaintext PINs on success.
 * - Attempts are counted synchronously in localStorage before the async
 *   check and serialised per pinKey, so parallel attempts cannot skip the count.
 */
export async function verifyPin(pinKey: string, pin: string): Promise<boolean> {
  const uid = currentUid();
  if (!uid) return false;

  // Atomic pre-count (see header): synchronous, before any await.
  const localFails = recordLocalPinAttempt(pinKey);

  return withPinLock(pinKey, async () => {
    const priv = await readPrivate(uid);
    const serverUntil = Number(priv[`${pinKey}_until`]) || 0;
    const serverFails = Number(priv[`${pinKey}_fails`]) || 0;
    ensureLockAnchor(pinKey, serverUntil);
    const until = Math.max(serverUntil, getLocalLockUntil(pinKey));
    if (until > Date.now()) throw new PinLockedError(until);
    // Effective count: the higher of server and local — neither store can lose a count.
    const fails = Math.max(serverFails, localFails);

    const stored: string | undefined = priv[pinKey];
    let ok = false;
    // 100M-D7: set only when the PIN is accepted via the one-time legacy
    // migration below, so the success path can verify the plaintext field
    // is actually gone.
    let migratedFromLegacy = false;

    if (stored && stored.startsWith('v3$')) {
      const [, salt] = stored.split('$');
      ok = constantTimeEquals(await hashPin(pin, salt, 3), stored);
    } else if (stored && stored.startsWith('v2$')) {
      const [, salt] = stored.split('$');
      ok = constantTimeEquals(await hashPin(pin, salt, 2), stored);
    } else if (stored) {
      // v1 hash: verify, then upgrade to v3 below
      ok = constantTimeEquals(await hashPinV1(uid, pinKey, pin), stored);
    } else {
      // 100M-D7 — ONE-TIME legacy migration, not a standing fallback.
      // A plaintext PIN may exist in the public users doc from
      // pre-AUDIT-2 builds. Accept it exactly ONCE, and only when the
      // private doc has NO entry: on success the PIN is hashed into the
      // private doc and the plaintext field is deleted (and its deletion
      // verified below), so this branch can never fire again for this
      // pinKey. On failure the attempt is rejected and counted exactly
      // like a wrong hashed PIN. Once a hash exists, a legacy field —
      // even one re-seeded afterwards — is never consulted again.
      const userSnap = await getDoc(doc(db, 'users', uid));
      const legacy = userSnap.exists() ? userSnap.data()[pinKey] : undefined;
      if (typeof legacy === 'string' && legacy.length > 0) {
        ok = constantTimeEquals(legacy, pin);
        migratedFromLegacy = ok;
      }
    }

    if (ok) {
      resetLocalPinAttempts(pinKey);
      if (!stored || !stored.startsWith('v3$')) {
        await savePin(pinKey, pin);
        if (migratedFromLegacy) {
          // Confirm the plaintext field is actually gone — a failed
          // delete would leave the PIN enumerable, so re-read and retry
          // once, and log loudly if it still survives.
          const check = await getDoc(doc(db, 'users', uid));
          const stillThere = check.exists() && typeof check.data()[pinKey] === 'string';
          if (stillThere) {
            const retried = await deleteLegacyPinField(uid, pinKey);
            if (!retried) {
              console.warn(
                `[pin] verifyPin(${pinKey}): legacy plaintext field could NOT be deleted after migration — plaintext PIN still present in the users doc`
              );
            }
          }
        }
      } else if (serverFails || serverUntil) {
        await setDoc(privateRef(uid), { [`${pinKey}_fails`]: 0, [`${pinKey}_until`]: 0 }, { merge: true });
      }
      return true;
    }

    const newUntil = await recordFailure(uid, pinKey, fails);
    if (newUntil > Date.now()) throw new PinLockedError(newUntil);
    return false;
  });
}
