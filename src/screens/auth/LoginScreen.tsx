import React, { useState, useRef, useEffect } from 'react';
import { authManager } from '../../aws';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, MessageCircle, X, Mail, KeyRound, CheckCircle2, RefreshCw } from 'lucide-react';
import { navigationManager } from '../../services/navigation';
import { consumeSwitchTo, recordCurrentAccount } from '../../services/accounts';

export default function LoginScreen() {
  const [identifier, setIdentifier] = useState(''); // email or username
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Report 3 #224/#239 (W5b): forced re-login notice set by App's
  // startup session validation. Read once on mount, then clear the
  // flag so the notice never reappears on a later login visit.
  const [notice, setNotice] = useState('');
  useEffect(() => {
    try {
      const flag = localStorage.getItem('pinglo_forced_relogin');
      if (flag === 'mock') {
        setNotice('This account was created in offline demo mode on this phone, before the app was connected to the server. It doesn\u2019t exist on the server, so please sign up again (or log in with your real account). Your demo chats were only ever stored on this phone and can\u2019t be moved to the new account.');
      } else if (flag === 'expired') {
        setNotice('Session expired — please log in again.');
      }
      if (flag) localStorage.removeItem('pinglo_forced_relogin');
    } catch { /* storage unavailable — no notice */ }
  }, []);

  const identifierRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Forgot password modal state
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [forgotStep, setForgotStep] = useState<'request' | 'confirm'>('request');
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState('');
  const [forgotSuccess, setForgotSuccess] = useState('');

  // Unconfirmed user OTP modal state
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpUsername, setOtpUsername] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');
  const [otpNotice, setOtpNotice] = useState('');
  // S7 (100-more): resend cooldown in seconds — the resend button is
  // disabled while it runs, so codes cannot be spammed.
  const [resendCooldown, setResendCooldown] = useState(0);
  // Report 3 #46 — the OTP modal now collects the password too: verifying
  // without one used to log in as a stub account.
  const [otpPassword, setOtpPassword] = useState('');
  const [showOtpPassword, setShowOtpPassword] = useState(false);
  // AUDIT-2 Phase 2 (Worker 2B) — the old `loginHint` ("Tip: if this
  // email is not verified yet, log in with your username instead…")
  // fired on EVERY failed email login, because the A14 generic error
  // starts with "Invalid email" for wrong-password failures too. It was
  // misleading, not leaking — but it pointed at a verify screen the
  // username path no longer opened. It is gone. The unconfirmed-account
  // guidance now lives ONLY inside the verify-code modal, reached via
  // the explicit "I have a verification code" entry point below
  // (the 1B follow-up for stranded signed-up-but-never-confirmed users:
  // they can reach the verify screen without logging in or re-signing
  // up, and a wrong code just fails — nothing reveals whether the
  // account exists).

  const navigate = useNavigate();

  // Phase 4: account switching — prefill the identifier when Settings asked
  // to switch to a saved account (the password must still be re-entered).
  useEffect(() => {
    const prefill = consumeSwitchTo();
    if (prefill) setIdentifier(prefill);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const rawId = identifierRef.current?.value || identifier;
    const rawPass = passwordRef.current?.value || password;

    const cleanId = (rawId || '').trim();
    // Report 3 #58 — the password must NOT be trimmed: a password with a
    // leading/trailing space could never be entered correctly (and the
    // stored credential is compared exactly). The identifier is still
    // trimmed; the password is compared exactly as typed.
    const cleanPass = rawPass || '';

    if (!cleanId || !cleanPass) {
      setError('Please enter your email/username and password.');
      return;
    }

    setLoading(true);

    try {
      const user = await authManager.signIn(cleanId, cleanPass);
      // Phase 4: remember this account for the Settings account switcher.
      recordCurrentAccount(user);
      navigate('/main');
    } catch (err: any) {
      // Report 3 #53 — the old catch mapped 'user-not-found' /
      // 'wrong-password' / 'invalid-credential' substrings and branched on
      // err.code === 'CONFIRM_SIGN_UP', but signIn only ever throws the
      // single A14 generic error ("Invalid email or password") with no
      // code — all of that mapping was dead code. Show the thrown message
      // as-is (it is already the generic, non-leaking one).
      setError(err.message || 'Failed to login');
      // AUDIT-2 Phase 2 (Worker 2B): NO auto-hint here any more. The old
      // code showed the unconfirmed-account tip on every failed email
      // login (wrong password included) — it is now only shown inside
      // the verify-code modal, reached via the explicit entry point.
    } finally {
      setLoading(false);
    }
  };

  // AUDIT-2 Phase 2 (Worker 2B) — "I have a verification code" entry
  // point (1B follow-up a): a user who signed up but never confirmed can
  // no longer reach the verify screen by logging in or re-signing up
  // (A14 generic errors). This opens the same OTP modal directly, with
  // an empty username field for them to fill in.
  const openVerifyModal = () => {
    setOtpUsername(identifier.trim());
    setOtpCode('');
    setOtpPassword('');
    setOtpError('');
    setOtpNotice('Signed up but never got in? Enter your username and the 6-digit code from your email — if the code is wrong, verification just fails, nothing here reveals whether the account exists.');
    setShowOtpModal(true);
  };

  // ── Forgot Password Handlers ──
  const openForgotModal = () => {
    setForgotEmail(identifier.trim());
    setForgotStep('request');
    setForgotError('');
    setForgotSuccess('');
    setResetCode('');
    setNewPassword('');
    setShowForgotModal(true);
  };

  useEffect(() => {
    if (showForgotModal) {
      return navigationManager.pushHandler(() => {
        setShowForgotModal(false);
        return true;
      });
    }
  }, [showForgotModal]);

  useEffect(() => {
    if (showOtpModal) {
      return navigationManager.pushHandler(() => {
        setShowOtpModal(false);
        return true;
      });
    }
  }, [showOtpModal]);

  const handleSendResetCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) {
      setForgotError('Please enter your registered email address.');
      return;
    }
    setForgotLoading(true);
    setForgotError('');
    try {
      const res = await authManager.resetPassword(forgotEmail.trim());
      setForgotStep('confirm');
      // AUDIT-2 A14 (prescribed wording, Phase 2 Worker 2B): never name
      // the destination — the old "Reset code sent to <email>!" wording
      // implied an account exists there. Behaviour was already
      // non-distinguishing (a missing account resolves the same way);
      // now the text is too. `res.destination` is deliberately unused.
      void res;
      setForgotSuccess('If an account exists, a reset code was sent.');
    } catch (err: any) {
      setForgotError(err.message || 'Could not send reset code.');
    } finally {
      setForgotLoading(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetCode.trim()) {
      setForgotError('Please enter the 6-digit reset code.');
      return;
    }
    // Report 3 #54 — Cognito requires min 8; the old min-6 check let a
    // 6–7 char password through to a real Cognito submit that rejects it.
    if (newPassword.length < 8) {
      setForgotError('New password must be at least 8 characters.');
      return;
    }

    setForgotLoading(true);
    setForgotError('');

    try {
      await authManager.confirmResetPassword(forgotEmail.trim(), resetCode.trim(), newPassword);
      setForgotSuccess('Password changed successfully! Logging in...');

      // Auto sign in with new password
      await authManager.signIn(forgotEmail.trim(), newPassword);
      setTimeout(() => {
        navigate('/main');
      }, 700);
    } catch (err: any) {
      // S20 (100-more): the success banner was set BEFORE the auto sign-in,
      // so a sign-in failure showed success + error stacked. Clear it.
      setForgotSuccess('');
      setForgotError(err.message || 'Failed to reset password. Please check your code.');
    } finally {
      setForgotLoading(false);
    }
  };

  // ── OTP Confirm Handler (for unconfirmed users) ──
  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpUsername.trim()) {
      setOtpError('Please enter the username you signed up with.');
      return;
    }
    if (!otpCode.trim()) {
      setOtpError('Please enter the 6-digit confirmation code.');
      return;
    }
    // Report 3 #46 — verifying without a password used to log in as a
    // STUB account (auth.ts created `aws_<username>` / `usr_<username>`
    // with no credential). The password is required: confirmSignUp signs
    // in for real and returns the real uid, and it throws without one.
    if (!otpPassword) {
      setOtpError('Please enter your password to log in after verifying.');
      return;
    }

    setOtpLoading(true);
    setOtpError('');

    try {
      const user = await authManager.confirmSignUp(otpUsername, otpCode.trim(), otpPassword);
      // The confirmed user is now really signed in — remember the account
      // for the Settings account switcher, like a normal login.
      recordCurrentAccount(user);
      setShowOtpModal(false);
      navigate('/main');
    } catch (err: any) {
      setOtpError(err.message || 'Verification failed. Please try again.');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!otpUsername || resendCooldown > 0) return;
    setOtpError('');
    try {
      await authManager.resendSignUpCode(otpUsername);
      // S7: never name the destination (the forgot-password flow hides it
      // too, AUDIT-2 A14) — and start a 30 s cooldown against resend spam.
      setOtpNotice('New code sent ✓');
      setResendCooldown(30);
    } catch (err: any) {
      setOtpError(err.message || 'Could not resend code.');
    }
  };

  // S7: tick the resend cooldown down once a second.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-light dark:bg-bg-dark px-4 py-8 pt-safe pb-safe">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="h-20 w-20 rounded-full bg-[#25D366] flex items-center justify-center shadow-2xl shadow-green-900/40 mb-4">
            <MessageCircle className="h-10 w-10 text-white" fill="white" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-text-primary tracking-tight">Pinglo</h1>
          <p className="text-sm text-gray-500 dark:text-text-secondary mt-1">Simple. Secure. Reliable messaging.</p>
        </div>

        {/* Card */}
        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-xl border border-gray-200 dark:border-white/5">
          <h2 className="text-xl font-bold text-gray-900 dark:text-text-primary mb-1">Welcome back</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-5">Login karo aur chat shuru karo</p>

          {notice && (
            <div className="mb-4 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-3 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-xl bg-red-50 dark:bg-danger-red/10 border border-red-200 dark:border-danger-red/20 p-3 text-sm text-red-600 dark:text-danger-red flex items-start gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} noValidate className="space-y-3.5">
            {/* Email or Username */}
            <div>
              <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide mb-1 block">
                Email or Username
              </label>
              <input
                ref={identifierRef}
                type="text"
                name="username"
                maxLength={100}
                autoComplete="username"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                onInput={(e: any) => setIdentifier(e.target.value)}
                onBlur={(e) => setIdentifier(e.target.value)}
                placeholder="you@gmail.com or username"
                className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 text-[15px] text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green focus:border-transparent transition-all placeholder:text-gray-400"
              />
            </div>

            {/* Password */}
            <div>
              <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide mb-1 block">
                Password
              </label>
              <div className="relative">
                <input
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  maxLength={64}
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  onInput={(e: any) => setPassword(e.target.value)}
                  onBlur={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-3 pr-12 text-[15px] text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green focus:border-transparent transition-all placeholder:text-gray-400"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-text-primary p-1"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {/* Forgot password */}
            <div className="flex justify-end pt-0.5">
              <button
                type="button"
                onClick={openForgotModal}
                className="text-xs text-primary-green hover:text-dark-green font-semibold"
              >
                Forgot password?
              </button>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-bold text-[15px] shadow-lg shadow-green-900/25 hover:bg-dark-green active:scale-[0.98] transition-all disabled:opacity-50 mt-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Logging in...
                </span>
              ) : 'Log in'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-500 dark:text-text-secondary mt-5">
            Account nahi hai?{' '}
            <Link to="/signup" className="font-semibold text-primary-green hover:text-dark-green">
              Sign up karo
            </Link>
          </p>
          {/* AUDIT-2 Phase 2 (Worker 2B) — 1B follow-up (a): explicit entry
              point for signed-up-but-never-confirmed users. */}
          <p className="text-center text-sm text-gray-500 dark:text-text-secondary mt-2">
            <button
              type="button"
              onClick={openVerifyModal}
              className="font-semibold text-primary-green hover:text-dark-green"
            >
              I have a verification code
            </button>
          </p>
        </div>

        <p className="text-center text-xs text-gray-400 dark:text-text-secondary mt-6">
          Private messaging for you and your friends.
        </p>
      </div>

      {/* ── FORGOT PASSWORD MODAL ── */}
      {showForgotModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowForgotModal(false)} role="dialog" aria-modal="true" aria-label="Reset password">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl border border-gray-200 dark:border-white/10 relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowForgotModal(false)}
              className="absolute right-4 top-4 p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-xl bg-primary-green/10 flex items-center justify-center">
                <KeyRound className="h-5 w-5 text-primary-green" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-text-primary">Reset Password</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary">
                  {forgotStep === 'request' ? 'Enter email to receive reset code' : 'Enter code & set new password'}
                </p>
              </div>
            </div>

            {forgotSuccess && (
              <div className="mb-4 rounded-xl bg-primary-green/10 border border-primary-green/20 p-3 text-xs text-primary-green flex items-start gap-2">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{forgotSuccess}</span>
              </div>
            )}

            {forgotError && (
              <div className="mb-4 rounded-xl bg-danger-red/10 border border-danger-red/20 p-3 text-xs text-danger-red flex items-start gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{forgotError}</span>
              </div>
            )}

            {forgotStep === 'request' ? (
              // Report 3 #47 — noValidate, like the main login form: without
              // it the browser's native validation intercepts an empty
              // submit and the in-app error below is dead code.
              <form onSubmit={handleSendResetCode} noValidate className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                    Email or Username
                  </label>
                  <input
                    type="text"
                    required
                    value={forgotEmail}
                    onChange={e => setForgotEmail(e.target.value)}
                    placeholder="you@gmail.com or username"
                    className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                  />
                </div>

                <button
                  type="submit"
                  disabled={forgotLoading}
                  className="w-full py-2.5 bg-green-cta text-white rounded-xl font-bold text-sm hover:bg-dark-green disabled:opacity-50 transition-all"
                >
                  {forgotLoading ? 'Sending reset code...' : 'Send reset code'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleConfirmReset} noValidate className="space-y-3.5">
                <div>
                  <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                    6-Digit Reset Code
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={6}
                    value={resetCode}
                    onChange={e => setResetCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="123456"
                    className="w-full text-center font-mono tracking-widest text-lg font-bold bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2 text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                    New Password (min 8 chars)
                  </label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      required
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 pr-10 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(s => !s)}
                      aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 p-1"
                    >
                      {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={forgotLoading || resetCode.length < 6 || newPassword.length < 8}
                  className="w-full py-2.5 bg-green-cta text-white rounded-xl font-bold text-sm hover:bg-dark-green disabled:opacity-50 transition-all"
                >
                  {forgotLoading ? 'Updating...' : 'Set new password & log in'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ── UNCONFIRMED EMAIL OTP MODAL ── */}
      {showOtpModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowOtpModal(false)} role="dialog" aria-modal="true" aria-label="Verify your email">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl border border-gray-200 dark:border-white/10 relative" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowOtpModal(false)}
              className="absolute right-4 top-4 p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-xl bg-primary-green/10 flex items-center justify-center">
                <Mail className="h-5 w-5 text-primary-green" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-gray-900 dark:text-text-primary">Account Verification</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Enter verification code from email</p>
              </div>
            </div>

            {otpNotice && (
              <div className="mb-4 rounded-xl bg-primary-green/10 border border-primary-green/20 p-3 text-xs text-primary-green">
                {otpNotice}
              </div>
            )}

            {otpError && (
              <div className="mb-4 rounded-xl bg-danger-red/10 border border-danger-red/20 p-3 text-xs text-danger-red flex items-start gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <span>{otpError}</span>
              </div>
            )}

            {/* Report 3 #47 — noValidate, like the main login form: without
                it the browser's native validation intercepts an empty
                submit and the in-app errors in handleVerifyOtp are dead. */}
            <form onSubmit={handleVerifyOtp} noValidate className="space-y-4">
              {/* AUDIT-2 Phase 2 (Worker 2B): the modal is now reachable
                  directly via "I have a verification code", so the username
                  is an editable field, not just a value carried over from
                  a failed login. */}
              <div>
                <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                  Username or email
                </label>
                <input
                  type="text"
                  required
                  value={otpUsername}
                  onChange={e => setOtpUsername(e.target.value)}
                  placeholder="username you signed up with"
                  className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                  6-Digit Verification Code
                </label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className="w-full text-center font-mono tracking-widest text-xl font-bold bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                />
              </div>
              {/* Report 3 #46 — the password is required to log in after
                  verifying. Without it confirmSignUp throws instead of
                  creating a stub session. */}
              <div>
                <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary block mb-1">
                  Your password
                </label>
                <div className="relative">
                  <input
                    type={showOtpPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={otpPassword}
                    onChange={e => setOtpPassword(e.target.value)}
                    placeholder="Password you signed up with"
                    className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-4 py-2.5 pr-10 text-sm text-gray-900 dark:text-text-primary outline-none focus:ring-2 focus:ring-primary-green"
                  />
                  <button
                    type="button"
                    onClick={() => setShowOtpPassword(s => !s)}
                    aria-label={showOtpPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 p-1"
                  >
                    {showOtpPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={otpLoading || otpCode.length < 6}
                className="w-full py-2.5 bg-green-cta text-white rounded-xl font-bold text-sm hover:bg-dark-green disabled:opacity-50 transition-all"
              >
                {otpLoading ? 'Verifying...' : 'Verify & log in'}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={handleResendOtp}
                  disabled={otpLoading || resendCooldown > 0}
                  className="text-xs text-primary-green hover:underline disabled:opacity-50 disabled:no-underline flex items-center justify-center gap-1 mx-auto"
                >
                  <RefreshCw className="h-3 w-3" />
                  {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend verification code'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
