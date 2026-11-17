/**
 * App lock (Phase 4, Worker C) — optional whole-app lock.
 *
 * - PIN: reuses pin.ts (`savePin` / `verifyPin` / `hasPin`) with pinKey
 *   `appLockPin`, so the PIN is a salted PBKDF2-SHA256 hash in the
 *   owner-only `users/{uid}/private/pins` doc, with the same lockout
 *   (5 failures -> escalating lockout) as the vault / hidden chats.
 * - Biometric: reuses biometric.ts, but with its OWN localStorage pref
 *   (`pinglo_applock_biometric`) — the vault's `vaultBiometric` pref in
 *   biometric.ts belongs to the vault and must not be shared.
 * - Enabled flag + auto-lock timer are per-device localStorage prefs
 *   (the lock protects this device; the PIN hash itself is per-account).
 * - Enforcement: `AppLockGate` (in AppLockScreen.tsx) must wrap the app
 *   in App.tsx — Worker C does NOT own App.tsx, so exact insertion
 *   instructions are in the PATCH notes. The gate checks
 *   `shouldShowAppLock()` on startup and re-locks after inactivity via
 *   `recordAppActivity()` / the timer.
 * - Honest limit: this is a UI-level lock. It does not encrypt data and
 *   does not stop someone with the signed-in account / device storage
 *   from reading cached data. Same threat model as the vault PIN gate.
 */

import { deletePin, hasPin } from './pin';
import { biometricAuthenticate, biometricAvailable } from './biometric';

export const APP_LOCK_PIN_KEY = 'appLockPin';

export type AutoLockDelay = 'immediate' | '1min' | '5min' | '15min' | '30min' | '1hour';

export const AUTO_LOCK_OPTIONS: { value: AutoLockDelay; label: string; ms: number }[] = [
  { value: 'immediate', label: 'Immediately', ms: 0 },
  { value: '1min', label: 'After 1 minute', ms: 60_000 },
  { value: '5min', label: 'After 5 minutes', ms: 5 * 60_000 },
  { value: '15min', label: 'After 15 minutes', ms: 15 * 60_000 },
  // WA parity (audit e #34): WhatsApp's phone app offers a 30-minute delay;
  // DT's list skipped straight from 15 min to 1 hour.
  { value: '30min', label: 'After 30 minutes', ms: 30 * 60_000 },
  { value: '1hour', label: 'After 1 hour', ms: 60 * 60_000 },
];

const ENABLED_KEY = 'pinglo_applock_enabled';
const DELAY_KEY = 'pinglo_applock_delay';
const BIO_KEY = 'pinglo_applock_biometric';
const UNLOCKED_AT_KEY = 'pinglo_applock_unlocked_at';
/** Last user activity (ms epoch) — updated by recordAppActivity(). Session-only.
 * Phase 5 (L-21): initialised to 0, NOT Date.now(). The old value made
 * shouldShowAppLock() think the user had *just* been active on every fresh
 * start, so the app never locked on startup for any delay > 0. */
let lastActivityAt = 0;

export function isAppLockEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAppLockEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
    if (!on) localStorage.removeItem(UNLOCKED_AT_KEY);
  } catch (err) {
    console.warn("[appLock] setAppLockEnabled: localStorage.setItem(ENABLED_KEY, on ? '1' : '0'...", err);
  }
}

export function getAutoLockDelay(): AutoLockDelay {
  try {
    const v = localStorage.getItem(DELAY_KEY);
    if (v === 'immediate' || v === '1min' || v === '5min' || v === '15min' || v === '30min' || v === '1hour') return v;
  } catch (err) {
    console.warn("[appLock] getAutoLockDelay: const v = localStorage.getItem(DELAY_KEY) failed", err);
  }
  // App-lock fix (2026-11-14): the old '1min' default locked the app in the
  // middle of a chat — 60 s of reading without touching the screen is
  // normal chat use, and a soft keyboard often sends no DOM keydown at all.
  // 5 minutes is the sane idle threshold for users who never picked one.
  return '5min';
}

export function setAutoLockDelay(d: AutoLockDelay): void {
  try {
    localStorage.setItem(DELAY_KEY, d);
  } catch (err) {
    console.warn("[appLock] setAutoLockDelay: localStorage.setItem(DELAY_KEY, d) failed", err);
  }
  // RC6: the gate captures the delay once when it arms its timer, so a
  // Settings change must reach the LIVE timer. The gate listens for this.
  dispatchAppLockEvent('pinglo:applock-delay-changed');
}

/** Best-effort CustomEvent dispatch (no-op outside a DOM env). */
function dispatchAppLockEvent(type: string): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(type));
    }
  } catch {
    /* event delivery is best-effort; the timestamp is still updated */
  }
}

export function autoLockDelayMs(d?: AutoLockDelay): number {
  return AUTO_LOCK_OPTIONS.find((o) => o.value === (d || getAutoLockDelay()))?.ms ?? 60_000;
}

export function getAppLockBiometricPref(): boolean {
  try {
    return localStorage.getItem(BIO_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAppLockBiometricPref(on: boolean): void {
  try {
    localStorage.setItem(BIO_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn("[appLock] setAppLockBiometricPref: localStorage.setItem(BIO_KEY, on ? '1' : '...", err);
  }
}

/** Whether a PIN has been set for the app lock (async — reads the private PIN doc). */
export async function hasAppLockPin(): Promise<boolean> {
  try {
    return await hasPin(APP_LOCK_PIN_KEY);
  } catch {
    return false;
  }
}

/** Disable the lock entirely: clears the flag and deletes the stored PIN hash. */
export async function disableAppLock(): Promise<void> {
  setAppLockEnabled(false);
  try {
    await deletePin(APP_LOCK_PIN_KEY);
  } catch (err) {
    console.warn("[appLock] disableAppLock: await deletePin(APP_LOCK_PIN_KEY) failed", err);
  }
}

/**
 * Call on any user interaction while unlocked, AND on non-DOM activity the
 * gate cannot see (e.g. an incoming message). RC6: the old version only
 * wrote the `lastActivityAt` timestamp — the gate's live `setTimeout` was
 * never touched, so the app still locked `delay` after the last tap even
 * while messages kept arriving. Now it also dispatches
 * `pinglo:app-activity`, which the gate listens for and uses to re-arm
 * its live timer.
 */
export function recordAppActivity(): void {
  lastActivityAt = Date.now();
  dispatchAppLockEvent('pinglo:app-activity');
}

/** Last activity timestamp (ms epoch) for the gate's background-grace check. */
export function getLastAppActivityAt(): number {
  return lastActivityAt;
}

/** Mark a successful unlock (persisted so a reload within the delay does not re-prompt). */
export function markAppUnlocked(): void {
  lastActivityAt = Date.now();
  try {
    localStorage.setItem(UNLOCKED_AT_KEY, String(Date.now()));
  } catch (err) {
    console.warn("[appLock] markAppUnlocked: localStorage.setItem(UNLOCKED_AT_KEY, String(Date....", err);
  }
}

/**
 * Startup check used by AppLockGate: true when the lock is enabled, a PIN
 * exists, and the last unlock is older than the auto-lock delay (or there
 * was no unlock). 'immediate' always locks on startup.
 */
export function shouldShowAppLock(): boolean {
  if (!isAppLockEnabled()) return false;
  const delay = autoLockDelayMs();
  if (delay === 0) return true;
  const unlockedAt = Number(localStorage.getItem(UNLOCKED_AT_KEY) || 0);
  // Phase 5 (L-21): with lastActivityAt starting at 0, a fresh start with
  // no stored unlock correctly reports "lock now" for every delay.
  const last = Math.max(unlockedAt, lastActivityAt);
  return Date.now() - last > delay;
}

/** Biometric unlock for the app lock (only when available AND the user turned it on). */
export async function tryBiometricAppUnlock(): Promise<boolean> {
  if (!getAppLockBiometricPref()) return false;
  if (!(await biometricAvailable())) return false;
  const ok = await biometricAuthenticate('Unlock Pinglo', 'Use your fingerprint to unlock the app');
  if (ok) markAppUnlocked();
  return ok;
}
