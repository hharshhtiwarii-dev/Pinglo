import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Trash2, X } from 'lucide-react';
import { auth, authManager } from '../aws';
import { hasPin, verifyPin, PinLockedError } from '../services/pin';
import { navigationManager } from '../services/navigation';
import {
  deleteMyAccountData,
  signOutAfterDeletion,
  type DeleteAccountResult,
} from '../services/accountDeletion';

type Stage = 'confirm' | 'deleting' | 'done' | 'needs-admin';

interface DeleteAccountModalProps {
  open: boolean;
  onClose: () => void;
}

const CONFIRM_WORD = 'DELETE';

/**
 * Delete-account flow — Feature 4c (Pinglo Phase 2).
 *
 * Confirm stage: warning + type DELETE + re-authentication. Password is
 * re-checked with the same `authManager.signIn()` call the login screen
 * uses, so a wrong password stops the flow before anything is deleted.
 * If the user set a hidden-chats PIN, they may use that instead — it goes
 * through the same hashed-PIN check (`verifyPin`) with its lockout, and it
 * is never a substitute for typing DELETE.
 *
 * Result stage: an honest per-item checklist. `needs-admin` is shown when
 * the app data was deleted but the Cognito identity could not be removed
 * from the client — the user is told exactly that, not that the account
 * is fully gone. Sign-out happens only when the user taps the button (or
 * the Android back button) on the result screen, so they can read it first.
 */
export default function DeleteAccountModal({ open, onClose }: DeleteAccountModalProps) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pin, setPin] = useState('');
  const [usePin, setUsePin] = useState(false);
  const [pinAvailable, setPinAvailable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [result, setResult] = useState<DeleteAccountResult | null>(null);

  const currentUser = auth.currentUser;
  const identifier = currentUser?.email || currentUser?.username || '';

  // Reset state every time the modal opens; offer PIN only if one is set.
  useEffect(() => {
    if (!open) return;
    setStage('confirm');
    setTyped('');
    setPassword('');
    setPin('');
    setUsePin(false);
    setError('');
    setBusy(false);
    setSigningOut(false);
    setResult(null);
    hasPin('hiddenChatPin').then(setPinAvailable).catch(() => setPinAvailable(false));
  }, [open ]);

  // Android back button: close on the confirm screen, sign out on the
  // result screen (same as the button — the account is already deleted).
  useEffect(() => {
    if (!open) return;
    return navigationManager.pushHandler(() => {
      if (stage === 'done' || stage === 'needs-admin') {
        void handleFinish();
      } else if (stage === 'confirm') {
        onClose();
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stage]);

  // Escape closes on the confirm screen only (never during deletion).
  useEffect(() => {
    if (!open || stage !== 'confirm') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, stage, onClose]);

  if (!open) return null;

  const canSubmit =
    stage === 'confirm' &&
    !busy &&
    typed.trim() === CONFIRM_WORD &&
    (usePin ? pin.trim().length >= 4 : password.length > 0);

  const handleConfirmDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !currentUser) return;
    setBusy(true);
    setError('');
    try {
      // ── Step 1: re-authenticate. Nothing is deleted until this passes. ──
      if (usePin) {
        const ok = await verifyPin('hiddenChatPin', pin.trim());
        if (!ok) throw new Error('Wrong PIN. Please try again.');
      } else {
        await authManager.signIn(identifier, password);
      }
      // Clear the credential from state immediately after use.
      setPassword('');
      setPin('');

      // ── Step 2: delete app data, then the Cognito identity. ──
      setStage('deleting');
      const res = await deleteMyAccountData(currentUser.uid);
      setResult(res);
      setStage(res.cognitoNeedsAdmin ? 'needs-admin' : 'done');
    } catch (err: any) {
      if (err instanceof PinLockedError) {
        const secs = Math.max(1, Math.ceil((err.untilMs - Date.now()) / 1000));
        setError(`Too many wrong PIN attempts. Try again in ${secs}s.`);
      } else {
        setError(err?.message || 'Could not verify. Please try again.');
      }
      setStage('confirm');
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutAfterDeletion();
    } catch (_) {
      // Local session may already be gone (e.g. Cognito delete cleared it);
      // App.tsx redirects to /login on the auth-state change anyway.
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Delete my account">
      <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl border border-gray-200 dark:border-white/10 relative">
        {stage === 'confirm' && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        )}

        {/* ── Confirm stage ── */}
        {stage === 'confirm' && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-xl bg-danger-red/10 flex items-center justify-center">
                <Trash2 className="h-5 w-5 text-danger-red" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-text-primary">Delete my account</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary">{identifier}</p>
              </div>
            </div>

            <div className="rounded-xl bg-danger-red/10 border border-danger-red/20 p-3 text-sm text-danger-red leading-relaxed mb-4">
              <p className="font-semibold mb-1">This cannot be undone.</p>
              <p>
                Your profile, saved messages, starred messages, statuses and
                group memberships will be permanently deleted, and you will be
                signed out.
              </p>
              <p className="mt-2 text-xs opacity-90">
                Messages you already sent in 1:1 chats and groups stay with the
                other people — deleting your account cannot unsend them.
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-xl bg-danger-red/10 border border-danger-red/20 p-3 text-xs text-danger-red flex items-start gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleConfirmDelete} className="space-y-3.5">
              <div>
                <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                  Type DELETE to confirm
                </label>
                <input
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="DELETE"
                  autoComplete="off"
                  className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-sm font-mono tracking-widest text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-danger-red"
                />
              </div>

              {usePin ? (
                <div>
                  <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                    Hidden-chats PIN
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="••••"
                    autoComplete="off"
                    className="w-full text-center font-mono tracking-widest text-lg font-bold bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-danger-red"
                  />
                  <button
                    type="button"
                    onClick={() => setUsePin(false)}
                    className="mt-1.5 text-xs text-primary-green hover:underline"
                  >
                    Use password instead
                  </button>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                    Your account password
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 pr-10 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-danger-red"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 p-1"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {pinAvailable && (
                    <button
                      type="button"
                      onClick={() => setUsePin(true)}
                      className="mt-1.5 text-xs text-primary-green hover:underline"
                    >
                      Use my hidden-chats PIN instead
                    </button>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={!canSubmit}
                className="w-full py-2.5 bg-danger-red text-white rounded-xl font-bold text-sm hover:opacity-90 disabled:opacity-40 transition-all"
              >
                {busy ? 'Verifying…' : 'Permanently delete my account'}
              </button>
            </form>
          </>
        )}

        {/* ── Deleting stage ── */}
        {stage === 'deleting' && (
          <div className="py-8 flex flex-col items-center text-center">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-danger-red border-t-transparent mb-4" />
            <h3 className="font-bold text-lg text-gray-900 dark:text-text-primary">Deleting your account…</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary mt-1">
              Please wait — do not close the app.
            </p>
          </div>
        )}

        {/* ── Result stages ── */}
        {(stage === 'done' || stage === 'needs-admin') && result && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`h-10 w-10 rounded-xl flex items-center justify-center ${
                  stage === 'done' ? 'bg-primary-green/10' : 'bg-amber-500/10'
                }`}
              >
                {stage === 'done' ? (
                  <CheckCircle2 className="h-5 w-5 text-primary-green" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-amber-500" />
                )}
              </div>
              <div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-text-primary">
                  {stage === 'done' ? 'Account deleted' : 'Almost deleted — admin needed'}
                </h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary">
                  {stage === 'done'
                    ? result.wasLocalMode
                      ? 'Your local account and data are gone.'
                      : 'Your data and your login have been deleted.'
                    : 'Your data is deleted, but your login still exists.'}
                </p>
              </div>
            </div>

            <div className="space-y-1.5 mb-4">
              {result.localData.map((item) => (
                <div key={item.item} className="flex items-start gap-2 text-sm">
                  {item.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-primary-green flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-danger-red flex-shrink-0 mt-0.5" />
                  )}
                  <span className="text-gray-700 dark:text-text-secondary">
                    {item.item}
                    {item.detail ? <span className="block text-xs text-danger-red">{item.detail}</span> : null}
                  </span>
                </div>
              ))}
              <div className="flex items-start gap-2 text-sm">
                {result.cognitoDeleted || result.wasLocalMode ? (
                  <CheckCircle2 className="h-4 w-4 text-primary-green flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                )}
                <span className="text-gray-700 dark:text-text-secondary">
                  {result.wasLocalMode
                    ? 'Login removed (local mode — no Cognito identity)'
                    : result.cognitoDeleted
                      ? 'Login deleted from Cognito'
                      : 'Login NOT deleted from Cognito — needs admin'}
                </span>
              </div>
            </div>

            {stage === 'needs-admin' && (
              <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3 text-sm text-amber-600 dark:text-amber-400 leading-relaxed mb-4">
                <p className="font-semibold mb-1">What still needs to happen</p>
                <p>
                  Your chats, profile and saved data above are deleted, but the
                  login itself could not be removed from the server (
                  {result.cognitoError || 'server refused the delete'}). Please
                  contact Dev Bhai at support@dtchats.app and ask for the login
                  for <span className="font-mono">{identifier}</span> to be
                  deleted from the Cognito user pool. Until then, do not sign
                  back in — signing in would recreate an empty profile.
                </p>
              </div>
            )}

            <button
              onClick={handleFinish}
              disabled={signingOut}
              className="w-full py-2.5 bg-green-cta text-white rounded-xl font-bold text-sm hover:bg-dark-green disabled:opacity-50 transition-all"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
