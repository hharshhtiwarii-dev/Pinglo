import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Delete, Fingerprint } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../../aws';
import { getPinLength, getPinLockUntil, hasPin, PinLockedError, savePin, verifyPin, describePinStrength, PIN_GUIDANCE_TEXT } from '../../services/pin';
import { biometricAuthenticate, biometricAvailable } from '../../services/biometric';

interface PinScreenProps {
  onSuccess: () => void;
  title?: string;
  pinKey?: string; // which pin field in firestore to use
  allowBiometric?: boolean; // offer fingerprint unlock (only if the user turned it on)
  onForgotPin?: () => void; // optional "forgot PIN" action (vault only; Hidden Chats omits it)
  /**
   * Phase 4 (Worker C) — optional, backward-compatible: called with the
   * verified PIN (create or enter) so the caller can derive a session key
   * (the vault uses it for AES-GCM encryption). Absent = previous
   * behaviour, nothing changes. The PIN is passed in memory only and is
   * never stored by this component.
   */
  onPinVerified?: (pin: string) => void | boolean | Promise<void | boolean>;
  /** When true, always start at the 'create' stage (change-PIN flow). */
  forceCreate?: boolean;
  /**
   * S6 (100-more): optional back handler. When the screen is embedded as
   * a tab (e.g. AppLockScreen's set/change-PIN stages) Back must cancel
   * back to the settings list, not navigate(-1) out of Settings entirely.
   * Absent = previous behaviour (navigate(-1)).
   */
  onBack?: () => void;
}

export default function PinScreen({ onSuccess, title = 'Enter PIN', pinKey = 'hiddenChatPin', allowBiometric = false, onForgotPin, onPinVerified, forceCreate = false, onBack }: PinScreenProps) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [stage, setStage] = useState<'loading' | 'create' | 'confirm' | 'enter' | 'error'>('loading');
  const [error, setError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [lockoutRemaining, setLockoutRemaining] = useState<number>(0);
  // AUDIT-2 A8: PINs can now be 4, 6 or 8 digits. `pinLen` is the length
  // this flow uses (chosen in 'create', stored length in 'enter');
  // `pinLenKnown` guards auto-submit until the stored length is loaded,
  // so a 6-digit PIN never fires a check at 4 digits.
  const [pinLen, setPinLen] = useState(4);
  const [pinLenKnown, setPinLenKnown] = useState(false);
  const [bioReady, setBioReady] = useState(false);
  const bioPrompted = useRef(false);
  const navigate = useNavigate();

  // 100M-D4: re-run when forceCreate changes. AppLockScreen renders the
  // verify-old-PIN and change-PIN screens in the same conditional position
  // (and LockedChatsFolder does the same for its change-PIN flow), so the
  // mounted instance is reused when the stage flips — with a mount-only
  // effect the forceCreate flip was never re-read and the new-PIN screen
  // stayed in verify mode ("Incorrect PIN."). (key={stage} on the caller
  // was tried first but this repo has no @types/react, so tsc rejects
  // `key` on a custom component — this effect dep is the fix instead.)
  useEffect(() => {
    loadPinStatus();
    checkLockout();
  }, [forceCreate]);

  // Fingerprint: the caller already checked ITS pref before passing
  // allowBiometric (app lock: pinglo_applock_biometric; locked chats:
  // vaultBiometric). PinScreen must NOT re-check the vault pref here —
  // the app-lock gate's pref lives elsewhere, so the old extra check
  // meant the fingerprint button never appeared for app lock.
  useEffect(() => {
    if (!allowBiometric) return;
    biometricAvailable().then(setBioReady);
  }, [allowBiometric]);

  // Ask for the fingerprint once when the PIN screen is ready, then fall back to PIN.
  // Phase 5 (L-26): when the caller derives a key from the PIN
  // (onPinVerified — the vault), biometric unlock is DISABLED here: a
  // fingerprint cannot produce the PIN, so unlocking that way would leave
  // the vault with no session key and notes would save as plaintext.
  useEffect(() => {
    if (stage !== 'enter' || !bioReady || bioPrompted.current) return;
    if (onPinVerified) return;
    bioPrompted.current = true;
    biometricAuthenticate(`Unlock ${title}`, 'Use your fingerprint').then((ok) => {
      if (ok) onSuccess();
    });
  }, [stage, bioReady, onPinVerified]);

  // Lockout state lives in the owner's private PIN doc, not in local storage,
  // so clearing site data does not reset the attempt counter.
  const checkLockout = async () => {
    try {
      const until = await getPinLockUntil(pinKey);
      if (until > Date.now()) {
        setLockoutRemaining(Math.ceil((until - Date.now()) / 1000));
        setErrorMsg('Too many failed attempts. Please wait.');
      }
    } catch {
      /* offline: the attempt itself will be checked when verifying */
    }
  };

  useEffect(() => {
    if (lockoutRemaining <= 0) return;
    const timer = setInterval(() => {
      setLockoutRemaining(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          setErrorMsg('');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutRemaining, pinKey]);

  const loadPinStatus = async () => {
    if (!auth.currentUser) return;
    setStage('loading');
    setErrorMsg('');
    // 100M-D4 (follow-up): a reused instance keeps the previous flow's
    // digits — after verifyOldPin → changePin the old PIN ('1234') was
    // still in `pin`, so the create screen auto-advanced straight to
    // 'confirm' and the new PIN mismatched ("PINs do not match"). A
    // status reload is a fresh screen: clear both PIN fields.
    setPin('');
    setConfirmPin('');
    setError(false);
    // Phase 5 (L-24): forceCreate (change-PIN) always starts at 'create'.
    if (forceCreate) {
      setPinLenKnown(true);
      setStage('create');
      return;
    }
    try {
      if (await hasPin(pinKey)) {
        try {
          setPinLen(await getPinLength(pinKey));
        } catch {
          /* unknown length: keep the 4-digit default */
        }
        setPinLenKnown(true);
        setStage('enter');
      } else {
        setPinLenKnown(true);
        setStage('create');
      }
    } catch {
      // RC44 (fail closed): a transient load failure must NEVER fall
      // through to 'create' — that asked the user to set a NEW PIN, and
      // completing it overwrote the real PIN via savePin. Stay on a
      // retry state instead; nothing is offered and nothing is written
      // until the PIN status is actually known.
      setPinLenKnown(false);
      setErrorMsg('Could not load PIN status. Check your connection and try again.');
      setStage('error');
    }
  };

  const hapticTap = () => {
    try {
      navigator.vibrate?.(10);
    } catch { /* intentionally ignored */}
  };

  // S6: embedded-as-tab callers pass onBack; otherwise navigate back.
  const goBack = () => {
    if (onBack) onBack();
    else navigate(-1);
  };

  const handleKeyPress = (key: string) => {
    if (lockoutRemaining > 0) return;
    hapticTap();
    // REPORT-3 #69: an error stays visible until the user tries again —
    // the next keypress clears it, never a timer.
    if (errorMsg) {
      setError(false);
      setErrorMsg('');
    }
    if (stage === 'create' || stage === 'enter') {
      if (pin.length < pinLen) setPin(prev => prev + key);
    } else if (stage === 'confirm') {
      if (confirmPin.length < pinLen) setConfirmPin(prev => prev + key);
    }
  };

  const handleDelete = () => {
    if (lockoutRemaining > 0) return;
    hapticTap();
    if (stage === 'create' || stage === 'enter') {
      setPin(prev => prev.slice(0, -1));
    } else if (stage === 'confirm') {
      setConfirmPin(prev => prev.slice(0, -1));
    }
  };

  // S12 (100-more): physical-keyboard input — desktop/web users can type
  // their PIN with 0–9 / Backspace instead of clicking every digit.
  // Re-subscribes on pin/confirmPin change so the guard in
  // handleKeyPress always sees the current length.
  useEffect(() => {
    if (!['create', 'confirm', 'enter'].includes(stage) || lockoutRemaining > 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handleKeyPress(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleDelete();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage, lockoutRemaining, pin, confirmPin, pinLen]);

  // Auto-check when the PIN reaches its full length (4, 6 or 8 digits)
  useEffect(() => {
    if (stage === 'create' && pin.length === pinLen && pinLenKnown) {
      // Move to confirm stage
      setTimeout(() => setStage('confirm'), 200);
    }
  }, [pin, stage, pinLen, pinLenKnown]);

  useEffect(() => {
    if (stage === 'confirm' && confirmPin.length === pinLen) {
      if (confirmPin === pin) {
        // Save PIN to Firestore
        savePinAndUnlock();
      } else {
        setError(true);
        setErrorMsg('PINs do not match. Try again.');
        // REPORT-3 #69: only the dots clear after a beat — the message
        // stays until the user types again (cleared in handleKeyPress).
        setTimeout(() => {
          setConfirmPin('');
          setError(false);
        }, 800);
      }
    }
  }, [confirmPin, stage]);

  useEffect(() => {
    if (stage === 'enter' && pin.length === pinLen && pinLenKnown) {
      checkPin();
    }
  }, [pin, stage, pinLen, pinLenKnown]);

  const savePinAndUnlock = async () => {
    if (!auth.currentUser) return;
    try {
      await savePin(pinKey, pin);
      // Phase 5 (L-27): wait for the caller's key derivation; a `false`
      // return means "do not unlock" (e.g. vault key failed).
      if ((await onPinVerified?.(pin)) === false) {
        setErrorMsg('Could not unlock encryption. Try again.');
        setPin('');
        setConfirmPin('');
        setStage('create');
        return;
      }
      onSuccess();
    } catch {
      setErrorMsg('Failed to save PIN. Try again.');
      setPin('');
      setConfirmPin('');
      setStage('create');
    }
  };

  const checkPin = async () => {
    if (!auth.currentUser) return;
    if (lockoutRemaining > 0) return;

    try {
      if (await verifyPin(pinKey, pin)) {
        if ((await onPinVerified?.(pin)) === false) {
          setErrorMsg('Could not unlock encryption. Try again.');
          setError(true);
          setTimeout(() => {
            setPin('');
            setError(false);
          }, 600);
          return;
        }
        onSuccess();
      } else {
        handleFailedAttempt();
      }
    } catch (e) {
      if (e instanceof PinLockedError) {
        setLockoutRemaining(Math.ceil((e.untilMs - Date.now()) / 1000));
        setErrorMsg('Too many failed attempts. Please wait.');
        setError(true);
        setTimeout(() => {
          setPin('');
          setError(false);
        }, 600);
        return;
      }
      setErrorMsg('Could not verify PIN. Check your connection and try again.');
      setError(true);
      setTimeout(() => {
        setPin('');
        setError(false);
      }, 600);
    }
  };

  const handleFailedAttempt = () => {
    setErrorMsg('Incorrect PIN.');
    setError(true);
    // REPORT-3 #69: the PIN dots clear, the message does not — it stays
    // until the next keypress (handleKeyPress clears it).
    setTimeout(() => {
      setPin('');
      setError(false);
    }, 600);
  };

  const currentPinLength = stage === 'confirm' ? confirmPin.length : pin.length;

  const stageTitle = () => {
    if (stage === 'loading') return 'Loading...';
    if (stage === 'error') return 'Could not load PIN';
    if (stage === 'create') return `Set a new PIN for ${title}`;
    if (stage === 'confirm') return 'Confirm your PIN';
    return title;
  };

  if (stage === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-light dark:bg-bg-dark">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
      </div>
    );
  }

  // RC44: load failure is a dead end, not a create-PIN flow — show the
  // error with a retry; the keypad is never rendered in this stage, so no
  // new PIN can be set or saved over the real one.
  if (stage === 'error') {
    return (
      <div className="flex h-screen flex-col bg-white dark:bg-[#0B141A] text-gray-900 dark:text-white">
        <div className="flex items-center px-4 py-3 bg-[#075E54] dark:bg-[#111B21] text-white">
          <button onClick={goBack} className="p-2 -ml-2 rounded-full hover:bg-white/10" aria-label="Back">
            <ArrowLeft className="h-6 w-6" />
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 gap-4 text-center">
          <h2 className="text-xl font-medium">Could not load PIN</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary max-w-xs">
            {errorMsg || 'Could not load PIN status. Check your connection and try again.'}
          </p>
          <button
            type="button"
            onClick={() => void loadPinStatus()}
            className="px-6 py-3 bg-[#075E54] text-white rounded-xl text-sm font-semibold"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-[#0B141A] text-gray-900 dark:text-white">
      {/* WhatsApp Classic Pro: deep green #075E54 header (dark: #111B21) */}
      <div className="flex items-center px-4 py-3 bg-[#075E54] dark:bg-[#111B21] text-white">
        <button onClick={goBack} className="p-2 -ml-2 rounded-full hover:bg-white/10" aria-label="Back">
          <ArrowLeft className="h-6 w-6" />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <h2 className="text-xl font-medium mb-2 text-center">{stageTitle()}</h2>
        {stage === 'create' && (
          <div className="mb-8 text-center space-y-3">
            <p className="text-sm text-gray-500 dark:text-text-secondary">Choose a PIN to protect this section</p>
            <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed max-w-xs mx-auto">{PIN_GUIDANCE_TEXT}</p>
            <div className="flex gap-2 justify-center" role="group" aria-label="PIN length">
              {[4, 6, 8].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => { setPinLen(n); setPin(''); }}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium ${pinLen === n ? 'bg-green-cta text-white' : 'bg-gray-100 dark:bg-panel-dark text-gray-700 dark:text-text-primary'}`}
                >
                  {n} digits
                </button>
              ))}
            </div>
            {pin.length >= 4 && (
              <p className="text-xs text-gray-400 dark:text-text-secondary">
                Strength: {describePinStrength(pin).label} ({describePinStrength(pin).combinations.toLocaleString('en-IN')} combinations)
              </p>
            )}
          </div>
        )}
        {stage === 'confirm' && (
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-8 text-center">Enter your PIN again to confirm</p>
        )}
        {!['create', 'confirm'].includes(stage) && <div className="mb-8" />}

        {lockoutRemaining > 0 ? (
          <div role="alert" className="mb-6 px-4 py-2 bg-danger-red/10 border border-danger-red/30 rounded-xl text-center">
            <p className="text-sm font-semibold text-danger-red">
              Locked due to too many attempts
            </p>
            <p className="text-xs text-danger-red/80 mt-0.5">
              Try again in {lockoutRemaining}s
            </p>
          </div>
        ) : errorMsg ? (
          <p role="alert" className="text-sm text-danger-red mb-4">{errorMsg}</p>
        ) : null}

        <div className={`flex ${pinLen > 4 ? 'space-x-3' : 'space-x-6'} mb-16 ${error ? 'animate-bounce' : ''}`}>
          {Array.from({ length: pinLen }).map((_, i) => (
            <div
              key={i}
              className={`h-4 w-4 rounded-full border-2 transition-all ${
                currentPinLength > i
                  ? error ? 'bg-danger-red border-danger-red' : 'bg-primary-green border-primary-green'
                  : 'border-gray-400 dark:border-text-secondary'
              }`}
            />
          ))}
        </div>

        <div className={`grid grid-cols-3 gap-x-12 gap-y-8 max-w-xs w-full ${lockoutRemaining > 0 ? 'opacity-40 pointer-events-none' : ''}`}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
            <button
              key={num}
              disabled={lockoutRemaining > 0}
              onClick={() => handleKeyPress(num.toString())}
              className="flex h-16 w-16 items-center justify-center rounded-full text-3xl font-light hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
            >
              {num}
            </button>
          ))}
          <div />
          <button
            disabled={lockoutRemaining > 0}
            onClick={() => handleKeyPress('0')}
            className="flex h-16 w-16 items-center justify-center rounded-full text-3xl font-light hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
          >
            0
          </button>
          <button
            disabled={lockoutRemaining > 0}
            onClick={handleDelete}
            className="flex h-16 w-16 items-center justify-center rounded-full hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
          >
            <Delete className="h-8 w-8" />
          </button>
        </div>

        {bioReady && stage === 'enter' && !onPinVerified && (
          <button
            type="button"
            onClick={async () => {
              const ok = await biometricAuthenticate(`Unlock ${title}`, 'Use your fingerprint');
              if (ok) onSuccess();
            }}
            className="mt-8 flex items-center gap-2 px-4 py-2 rounded-full text-primary-green font-semibold hover:bg-primary-green/10 transition-colors"
          >
            <Fingerprint className="h-6 w-6" /> Use fingerprint
          </button>
        )}

        {onForgotPin && stage === 'enter' && (
          <button
            type="button"
            onClick={onForgotPin}
            className="mt-4 text-xs text-gray-400 dark:text-text-secondary underline underline-offset-2 hover:text-danger-red transition-colors"
          >
            Forgot PIN? Erase vault &amp; reset
          </button>
        )}
      </div>
    </div>
  );
}
