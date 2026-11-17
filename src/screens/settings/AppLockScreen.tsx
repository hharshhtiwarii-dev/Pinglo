import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Fingerprint, LockKeyhole, ShieldCheck } from 'lucide-react';
import PinScreen from '../hidden/PinScreen';
import ToggleSwitch from '../../components/ToggleSwitch';
import {
  APP_LOCK_PIN_KEY,
  AUTO_LOCK_OPTIONS,
  autoLockDelayMs,
  disableAppLock,
  getAppLockBiometricPref,
  getAutoLockDelay,
  getLastAppActivityAt,
  hasAppLockPin,
  isAppLockEnabled,
  markAppUnlocked,
  recordAppActivity,
  setAppLockBiometricPref,
  setAppLockEnabled,
  setAutoLockDelay,
  shouldShowAppLock,
  type AutoLockDelay,
} from '../../services/appLock';
import { biometricAvailable } from '../../services/biometric';

/**
 * App lock UI (Phase 4, Worker C).
 *
 * Two exports:
 * - `AppLockScreen` — the settings screen (rendered inside SettingsScreen
 *   as a tab; NOT a route, because App.tsx is not owned by Worker C).
 *   Lets the user enable the lock (set a PIN via PinScreen),
 *   pick the auto-lock delay, turn on biometric unlock, change the PIN,
 *   or disable the lock (deletes the PIN hash — only after the current
 *   PIN is verified, so a person holding the unlocked phone cannot
 *   switch the lock off in one tap).
 * - `AppLockGate` — the startup gate. App.tsx must render it ABOVE the
 *   router (exact insertion instructions in the PATCH notes). While
 *   locked it covers the whole app; on unlock it calls `onUnlocked` and
 *   disappears. It also re-locks after inactivity (auto-lock timer) by
 *   listening for activity while unlocked.
 *
 * PIN reuse: the lock PIN is stored by pin.ts (`appLockPin`) as a salted
 * PBKDF2 hash with lockout — the same mechanism as the vault PIN.
 * Honest limit: UI-level lock only; it does not encrypt app data.
 */

// Re-export the gate helpers for App.tsx wiring convenience.
export { shouldShowAppLock, markAppUnlocked, recordAppActivity };

/** Full-screen gate shown at startup (and on auto-lock) until unlocked. */
export function AppLockGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [locked, setLocked] = useState(() => shouldShowAppLock());
  const [bioReady, setBioReady] = useState(false);

  useEffect(() => {
    if (!locked) return;
    if (!getAppLockBiometricPref()) return;
    biometricAvailable().then(setBioReady);
  }, [locked]);

  // Auto-lock while unlocked: any activity resets the timer; when the
  // delay passes with no activity, lock again.
  //
  // App-lock fix (2026-11-14) — the old version only listened to
  // touchstart / mousemove / keydown, which is NOT "activity" on a phone:
  //  - reading a chat for 60 s without touching the screen is normal, yet
  //    the old 1-min default locked mid-chat;
  //  - Android soft keyboards (Gboard swipe / autocorrect / suggestion
  //    commits) send `input` events WITHOUT a DOM `keydown`, so typing a
  //    long message never reset the timer;
  //  - scrolling fires touchstart only at gesture start, and incoming
  //    messages (ChatScreen calls recordAppActivity) reset nothing.
  // Now: input (typing), scroll/wheel/touchmove (reading), pointerdown
  // (tap, touch + mouse) all count. A brief backgrounding (notification
  // shade, quick app switch) does NOT lock instantly: on return we lock
  // only if the full delay really elapsed while away, otherwise the
  // timer re-arms. The visibilitychange listener is also removed in
  // cleanup now (the old code leaked one per lock/unlock cycle).
  useEffect(() => {
    if (locked) return;
    let timer: ReturnType<typeof setTimeout>;
    // RC6: the delay is re-read on EVERY arm (never captured once), so a
    // Settings change applies to the live timer immediately.
    const arm = () => {
      clearTimeout(timer);
      const delay = autoLockDelayMs();
      if (delay === 0) {
        // 'Immediately' means: lock when the app leaves the foreground
        // (onVisibility below) or on restart (shouldShowAppLock), NOT
        // while the user is actively using the app. The old code locked
        // at once here, and arm() runs on mount while unlocked, on every
        // activity, and on delay change — so with 'Immediately' the app
        // re-locked instantly after every unlock and even locked the
        // moment the user picked the delay in Settings. No idle timer
        // is armed for delay 0.
        return;
      }
      timer = setTimeout(() => setLocked(true), delay);
    };
    const onActivity = () => {
      recordAppActivity();
      arm();
    };
    // RC6: recordAppActivity() (e.g. an incoming message in ChatScreen)
    // dispatches this event — the live timer must re-arm on it, not just
    // the timestamp. Without this the app locked mid-read while messages
    // kept arriving.
    const onAppActivityEvent = () => {
      arm();
    };
    // RC6: a Settings delay change re-arms the live timer with the new
    // delay (arm() re-reads it); 'immediate' arms NO timer — it locks on
    // background/restart only, never via arm().
    const onDelayChanged = () => {
      arm();
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (getAutoLockDelay() === 'immediate') setLocked(true);
        return;
      }
      // Back in foreground: lock only if the whole delay really elapsed
      // while away (timer may have been throttled in background).
      if (Date.now() - getLastAppActivityAt() > autoLockDelayMs()) setLocked(true);
      else {
        recordAppActivity();
        arm();
      }
    };
    window.addEventListener('touchstart', onActivity);
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('mousemove', onActivity);
    window.addEventListener('keydown', onActivity);
    window.addEventListener('input', onActivity, true);
    window.addEventListener('scroll', onActivity, true);
    window.addEventListener('touchmove', onActivity);
    window.addEventListener('wheel', onActivity);
    window.addEventListener('pinglo:app-activity', onAppActivityEvent);
    window.addEventListener('pinglo:applock-delay-changed', onDelayChanged);
    document.addEventListener('visibilitychange', onVisibility);
    // The gate mounted unlocked, so the user is present now — seed the
    // activity timestamp, otherwise getLastAppActivityAt() stays 0 and the
    // first foreground-return would lock immediately (same class of bug as
    // Phase 5 L-21 for shouldShowAppLock).
    recordAppActivity();
    arm();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('touchstart', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('input', onActivity, true);
      window.removeEventListener('scroll', onActivity, true);
      window.removeEventListener('touchmove', onActivity);
      window.removeEventListener('wheel', onActivity);
      window.removeEventListener('pinglo:app-activity', onAppActivityEvent);
      window.removeEventListener('pinglo:applock-delay-changed', onDelayChanged);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [locked]);

  if (!locked) return null;

  return (
    <div className="fixed inset-0 z-[10000] bg-bg-light dark:bg-bg-dark">
      <PinScreen
        title="Pinglo"
        pinKey={APP_LOCK_PIN_KEY}
        allowBiometric={bioReady}
        onSuccess={() => {
          markAppUnlocked();
          setLocked(false);
          onUnlocked();
        }}
      />
    </div>
  );
}

export default function AppLockScreen({ onBack }: { onBack: () => void }) {
  const [enabled, setEnabled] = useState(() => isAppLockEnabled());
  const [hasPin, setHasPin] = useState(false);
  const [delay, setDelay] = useState<AutoLockDelay>(() => getAutoLockDelay());
  const [bioOn, setBioOn] = useState(() => getAppLockBiometricPref());
  const [bioAvailable, setBioAvailable] = useState(false);
  const [stage, setStage] = useState<'settings' | 'setPin' | 'changePin' | 'verifyOldPin'>('settings');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  // 100M-D6 (W14h): same class as D5 — the toast's auto-clear timer id, so
  // a second toast fired before the first one's timer expires is cleared
  // by ITS OWN timer, not the first one's (which cut it short).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // S2 (100-more): disabling the lock requires the current PIN first.
  // When the user toggles off, we go to the verify-PIN stage with this
  // flag set; on success the disable runs, otherwise nothing changes.
  const [pendingDisable, setPendingDisable] = useState(false);

  useEffect(() => {
    hasAppLockPin().then(setHasPin).catch(() => {});
    biometricAvailable().then(setBioAvailable);
  }, [stage]);

  const showToastMsg = (msg: string) => {
    // 100M-D6: clear the previous toast's timer first — without this the
    // first toast's 3 s timer cleared the second toast ~1 s after it fired.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  };

  const handleToggle = async (next: boolean) => {
    if (next) {
      // Enabling requires a PIN: go to the create-PIN flow first.
      setStage('setPin');
      return;
    }
    // S2: disabling requires the current PIN — anyone holding the
    // unlocked phone must not be able to switch the lock off in one tap.
    // Verify first; the actual disable runs in handleVerifiedDisable.
    setPendingDisable(true);
    setStage('verifyOldPin');
  };

  const handleVerifiedDisable = async () => {
    setPendingDisable(false);
    setBusy(true);
    try {
      await disableAppLock();
      setEnabled(false);
      setHasPin(false);
      setStage('settings');
      showToastMsg('App lock disabled');
    } catch {
      setStage('settings');
      showToastMsg('Could not disable app lock. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handlePinCreated = () => {
    setAppLockEnabled(true);
    setEnabled(true);
    setHasPin(true);
    markAppUnlocked();
    setStage('settings');
    showToastMsg('App lock enabled ✓');
  };

  const handleDelay = (d: AutoLockDelay) => {
    setDelay(d);
    setAutoLockDelay(d);
  };

  const handleBioToggle = async (next: boolean) => {
    if (next && !bioAvailable) {
      showToastMsg('Fingerprint is not available on this device.');
      return;
    }
    if (next) {
      // Confirm the user can actually use biometrics before turning it on.
      const { biometricAuthenticate } = await import('../../services/biometric');
      const ok = await biometricAuthenticate('Unlock Pinglo', 'Confirm your fingerprint to enable biometric unlock');
      if (!ok) {
        showToastMsg('Fingerprint not confirmed — biometric unlock stays off.');
        return;
      }
    }
    setAppLockBiometricPref(next);
    setBioOn(next);
  };

  if (stage !== 'settings') {
    return (
      <div className="flex-1 overflow-y-auto">
        {stage === 'verifyOldPin' ? (
          <PinScreen
            title="App Lock"
            pinKey={APP_LOCK_PIN_KEY}
            onBack={() => { setPendingDisable(false); setStage('settings'); }}
            onSuccess={() => (pendingDisable ? void handleVerifiedDisable() : setStage('changePin'))}
          />
        ) : (
          <PinScreen
            title="App Lock"
            pinKey={APP_LOCK_PIN_KEY}
            forceCreate={stage === 'changePin'}
            onBack={() => setStage('settings')}
            onSuccess={handlePinCreated}
          />
        )}
        <p className="text-center text-xs text-gray-400 px-6 pb-4 -mt-2">
          {stage === 'changePin'
            ? 'Enter a new PIN for the app lock.'
            : stage === 'verifyOldPin'
              ? 'Enter your current PIN first.'
              // 100M-C4: when a PIN already exists, enabling the lock does NOT
              // ask for a new one — PinScreen verifies the existing PIN (no
              // confirm stage). The old caption ("Choose a PIN...") told the
              // user the opposite, so say what the screen actually wants.
              : hasPin
                ? 'Enter your PIN to turn the lock on.'
                : 'Choose a PIN to lock the whole app.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-primary-green/10 flex items-center justify-center">
            <LockKeyhole className="h-6 w-6 text-primary-green" />
          </div>
          <div>
            <h2 className="text-lg font-medium">App Lock</h2>
            <p className="text-xs text-gray-500 dark:text-text-secondary">Lock the whole app with a PIN or fingerprint.</p>
          </div>
        </div>

        <p className="text-xs text-gray-500 dark:text-text-secondary bg-gray-50 dark:bg-input-dark rounded-xl p-3 leading-relaxed">
          When enabled, Pinglo asks for your PIN (or fingerprint) every time the app starts and after the
          auto-lock delay. This locks the app screen — it does not encrypt your messages or stored data.
        </p>

        <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
          <div>
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Lock app</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">{hasPin ? 'PIN is set' : 'No PIN set yet'}</p>
          </div>
          <ToggleSwitch
            checked={enabled}
            onChange={(v) => void handleToggle(v)}
            label="Enable app lock"
            disabled={busy}
          />
        </div>

        {enabled && (
          <>
            <div className="py-2 border-b border-gray-200 dark:border-white/5">
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary mb-2">Auto-lock</h3>
              <div className="flex flex-wrap gap-2">
                {AUTO_LOCK_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => handleDelay(o.value)}
                    aria-pressed={delay === o.value}
                    className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${delay === o.value ? 'bg-green-cta text-white border-green-cta' : 'border-gray-300 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
              <div>
                <h3 className="text-base font-medium text-gray-900 dark:text-text-primary flex items-center gap-2">
                  <Fingerprint className="h-4 w-4" /> Unlock with fingerprint
                </h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">
                  {bioAvailable ? 'Use your fingerprint instead of the PIN.' : 'Not available on this device/browser.'}
                </p>
              </div>
              <ToggleSwitch
                checked={bioOn}
                onChange={(v) => void handleBioToggle(v)}
                label="Enable fingerprint unlock"
                disabled={!bioAvailable}
              />
            </div>

            <button
              onClick={() => setStage('verifyOldPin')}
              className="w-full py-3 bg-[#DCF8C6] dark:bg-[#005C4B] text-[#075E54] dark:text-white rounded-xl font-medium hover:opacity-90 transition-all flex items-center justify-center gap-2"
            >
              <ShieldCheck className="h-4 w-4" /> Change PIN
            </button>
          </>
        )}

        <button onClick={onBack} className="w-full py-3 text-gray-500 dark:text-text-secondary font-medium flex items-center justify-center gap-2">
          <ArrowLeft className="h-4 w-4" /> Back to Privacy
        </button>

        {toast && (
          <p role="status" className="text-center text-sm text-primary-green">{toast}</p>
        )}
      </div>
    </div>
  );
}
