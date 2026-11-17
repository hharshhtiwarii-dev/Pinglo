import React, { useState, useRef, useEffect } from 'react';
import { doc, setDoc, db, authManager } from '../../aws';
import { uploadProfilePicture } from '../../aws/storage';
import { Link, useNavigate } from 'react-router-dom';
import { Camera, AlertCircle, CheckCircle2, Eye, EyeOff, Mail, ArrowLeft, RefreshCw, X } from 'lucide-react';
import { navigationManager } from '../../services/navigation';
import { recordCurrentAccount } from '../../services/accounts';

// Audit #26 — was declared inside SignupScreen's render, so React
// recreated the component (and reset its state) on every render.
function InputStatus({ valid }: { valid: boolean | null }) {
  if (valid === null) return null;
  return valid
    ? <CheckCircle2 className="h-4 w-4 text-primary-green absolute right-3 top-1/2 -translate-y-1/2" />
    : <AlertCircle className="h-4 w-4 text-danger-red absolute right-3 top-1/2 -translate-y-1/2" />;
}

export default function SignupScreen() {
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState('');
  // What the user actually typed, before cleaning. The input shows this;
  // `username` holds the cleaned value that will be saved. We show the
  // cleaned result live instead of silently stripping characters.
  const [usernameRaw, setUsernameRaw] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailValid, setEmailValid] = useState<boolean | null>(null);
  const [passwordValid, setPasswordValid] = useState<boolean | null>(null);
  const [usernameValid, setUsernameValid] = useState<boolean | null>(null);

  // Confirmation OTP step state
  const [confirmationCode, setConfirmationCode] = useState('');
  const [pendingUsername, setPendingUsername] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [pendingPassword, setPendingPassword] = useState('');
  const [pendingDisplayName, setPendingDisplayName] = useState('');
  const [pendingPhotoURL, setPendingPhotoURL] = useState('');
  const [resendNotice, setResendNotice] = useState('');
  const [resending, setResending] = useState(false);

  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    };
  }, [avatarPreview]);

  useEffect(() => {
    if (step === 'confirm') {
      return navigationManager.pushHandler(() => {
        setStep('form');
        return true;
      });
    }
  }, [step]);

  const isValidEmail = (str: string) => {
    if (!str) return false;
    const clean = str.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').toLowerCase();
    const parts = clean.split('@');
    if (parts.length !== 2) return false;
    const [user, domain] = parts;
    return user.length >= 1 && domain.includes('.') && domain.length >= 4;
  };

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setEmail(val);
    if (val.length > 3) setEmailValid(isValidEmail(val));
    else setEmailValid(null);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPassword(val);
    // Report 3 #54 — Cognito requires min 8, so the live check must too
    // (was 6, disagreeing with the validator and Cognito).
    if (val.length > 0) setPasswordValid(val.length >= 8);
    else setPasswordValid(null);
  };

  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Usernames allow only lowercase letters, numbers and underscore.
    // Spaces, capitals and special characters are removed — show the
    // result live below the field so nothing happens silently.
    const val = raw.toLowerCase().replace(/[^a-z0-9_]/g, '');
    setUsernameRaw(raw);
    setUsername(val);
    if (val.length > 0) setUsernameValid(val.length >= 3);
    else setUsernameValid(null);
  };

  const usernameStripped = usernameRaw !== usernameRaw.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const usernamePreview = username ? `@${username}` : '';

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
      setAvatarFile(file);
      setAvatarPreview(URL.createObjectURL(file));
      // Reset the input so picking the same file again (e.g. after
      // Remove) fires onChange instead of being a no-op.
      e.target.value = '';
    }
  };

  // W35 backfill — remove-photo control. Before this there was no way to
  // drop a picked photo: after a persistent upload failure (#57) the only
  // options were retry or pick a different photo. Removing clears the
  // file + preview (and the input value, so the same file can be picked
  // again); signup then proceeds with no photo (photoURL '').
  const handleAvatarRemove = () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarFile(null);
    setAvatarPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // DOM fallback handles Android autofill / Gboard suggestions that don't trigger synthetic onChange
    const rawName = nameInputRef.current?.value || displayName;
    const rawUsername = usernameInputRef.current?.value || username;
    const rawEmail = emailInputRef.current?.value || email;
    const rawPassword = passwordInputRef.current?.value || password;

    const cleanName = (rawName || '').trim();
    if (cleanName.length < 2) {
      setError('Display name must be at least 2 characters long.');
      return;
    }
    if (cleanName.length > 30) {
      setError('Display name must be at most 30 characters.');
      return;
    }

    let cleanEmail = (rawEmail || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
    // Auto-fix common mobile typing mistake (.con instead of .com)
    if (cleanEmail.endsWith('.con')) {
      cleanEmail = cleanEmail.slice(0, -4) + '.com';
      setEmail(cleanEmail);
    }

    if (!isValidEmail(cleanEmail)) {
      setError('Please enter a valid email address (e.g. name@gmail.com)');
      return;
    }

    // Report 3 #58 — never trim the password: a leading/trailing space is
    // part of the password. Login compares it exactly, so signup must
    // create the account with exactly what was typed.
    const cleanPassword = rawPassword || '';
    // Report 3 #54 — Cognito requires min 8; the UI, this check and
    // Cognito must agree (was min 6).
    if (cleanPassword.length < 8) {
      setError('Password must be at least 8 characters long.');
      return;
    }

    const cleanUsername = (rawUsername || '')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '');
    if (cleanUsername.length < 3) {
      setError('Username must be at least 3 characters.');
      return;
    }

    setLoading(true);

    try {
      let photoURL = '';
      if (avatarFile) {
        // Report 3 #57 — never silently swallow an avatar-upload failure:
        // the photo is the user's explicit choice, so a failed upload stops
        // the signup with a visible in-app error instead of proceeding
        // with no photo and no message. Pressing "Create account" again
        // retries the upload (or pick a different photo — or Remove photo
        // and continue without one, W35).
        try {
          photoURL = await uploadProfilePicture(avatarFile);
        } catch (err: any) {
          setError(err?.message
            ? `Profile photo upload failed: ${err.message} Please try again.`
            : 'Profile photo upload failed. Please check your connection and try again.');
          return;
        }
      }

      const res = await authManager.signUp(
        cleanEmail,
        cleanPassword,
        cleanName,
        cleanUsername,
        photoURL
      );

      setPendingUsername(res.cognitoUsername);
      setPendingEmail(cleanEmail);
      // Report 3 #58 — store the exact password that created the account
      // (untrimmed, as passed to signUp), so the confirm step signs in
      // with the same password.
      setPendingPassword(cleanPassword);
      setPendingDisplayName(cleanName);
      setPendingPhotoURL(photoURL);

      if (!res.isSignUpComplete) {
        // AWS Cognito requires email confirmation code
        setStep('confirm');
        setResendNotice(`6-digit code sent to ${cleanEmail}`);
        return;
      }

      // If sign up completed immediately (e.g. local mode)
      await finishAccountSetup(res.user.uid, res.cognitoUsername, cleanName, photoURL);
      // Phase 4: remember this account for the Settings account switcher.
      recordCurrentAccount({ uid: res.user.uid, displayName: cleanName, email: cleanEmail, username: res.cognitoUsername });
      navigate('/main');
    } catch (err: any) {
      const msg = err.message || 'Failed to sign up';
      if (err.code === 'UsernameExistsException') {
        setPendingUsername(username.toLowerCase().trim());
        setPendingEmail(cleanEmail);
        // Report 3 #58 — exact password, as typed (see above).
        setPendingPassword(cleanPassword);
        setPendingDisplayName(cleanName);
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const finishAccountSetup = async (uid: string, uName: string, dName: string, pUrl: string) => {
    try {
      await setDoc(doc(db, 'users', uid), {
        uid,
        username: uName.toLowerCase().trim(),
        displayName: dName,
        photoURL: pUrl || '',
        bio: 'Hey there! I am using Pinglo.',
        online: true,
        lastSeen: Date.now(),
        status: 'online',
        pushToken: '',
        pushPlatform: '',
        pushTokenUpdatedAt: 0,
        notificationsEnabled: true,
      }, { merge: true });

      await setDoc(doc(db, 'usernames', uName.toLowerCase().trim()), { uid }, { merge: true });
    } catch (e) {
      console.warn('Profile DB save warning:', e);
    }
  };

  // AUDIT-2 Phase 2 (Worker 2B) — "I have a verification code" entry
  // point (1B follow-up a): a user who signed up but never confirmed
  // (e.g. they closed the app on the confirm step) can reach the verify
  // screen directly, without re-signing up — re-signup fails with the
  // A14 generic error and reveals nothing. pendingUsername starts empty
  // and the confirm step shows a username field for them to fill in.
  const openVerifyEntry = () => {
    setPendingUsername('');
    setPendingEmail('');
    setPendingPassword('');
    setPendingDisplayName('');
    setPendingPhotoURL('');
    setConfirmationCode('');
    setResendNotice('');
    setError('');
    setStep('confirm');
  };

  const handleConfirmCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingUsername.trim()) {
      setError('Please enter the username you signed up with.');
      return;
    }
    if (!confirmationCode.trim()) {
      setError('Please enter the 6-digit confirmation code.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const confirmedUser = await authManager.confirmSignUp(
        pendingUsername,
        confirmationCode.trim(),
        pendingPassword
      );

      await finishAccountSetup(
        confirmedUser.uid,
        pendingUsername,
        pendingDisplayName || pendingUsername,
        pendingPhotoURL
      );
      // Phase 4: remember this account for the Settings account switcher.
      // Prefer the confirmed user's real email (entry-point mode has no
      // pendingEmail — the user typed only a username + password).
      recordCurrentAccount({ uid: confirmedUser.uid, displayName: pendingDisplayName || pendingUsername, email: confirmedUser.email || pendingEmail, username: pendingUsername });

      navigate('/main');
    } catch (err: any) {
      setError(err.message || 'Invalid code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!pendingUsername) return;
    setResending(true);
    setError('');
    try {
      const dest = await authManager.resendSignUpCode(pendingUsername);
      setResendNotice(`New code sent to ${dest} ✓`);
    } catch (err: any) {
      setError(err.message || 'Could not resend code. Please try again.');
    } finally {
      setResending(false);
    }
  };

  // ── Step 2: OTP Email Confirmation Screen ──
  if (step === 'confirm') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-bg-light dark:bg-bg-dark px-4 py-8 pt-safe pb-safe">
        <div className="w-full max-w-md space-y-6 rounded-2xl bg-panel-light dark:bg-panel-dark p-6 sm:p-8 shadow-xl border border-gray-200 dark:border-white/5">
          <div className="flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-2xl bg-primary-green/10 flex items-center justify-center mb-4">
              <Mail className="h-8 w-8 text-primary-green" />
            </div>
            <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-text-primary">
              Verify your email
            </h2>
            {pendingEmail || pendingUsername ? (
              <>
                <p className="mt-2 text-sm text-gray-600 dark:text-text-secondary">
                  We sent a 6-digit verification code to:
                </p>
                <p className="font-semibold text-primary-green text-sm mt-0.5 break-all">
                  {pendingEmail || pendingUsername}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  (Check your Gmail Inbox or Spam folder)
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-gray-600 dark:text-text-secondary">
                Signed up but never confirmed? Enter the username and password
                you signed up with, plus the 6-digit code from your email.
              </p>
            )}
          </div>

          {resendNotice && (
            <div className="rounded-xl bg-primary-green/10 border border-primary-green/20 p-3 text-xs text-primary-green text-center">
              {resendNotice}
            </div>
          )}

          {error && (
            <div className="rounded-md bg-danger-red/10 p-3 text-sm text-danger-red flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Report 3 #47 — noValidate, like the main login form: without
              it the browser's native validation intercepts an empty /
              malformed-email submit and the in-app errors in handleConfirmCode
              are dead code. */}
          <form onSubmit={handleConfirmCode} noValidate className="space-y-5">
            {/* AUDIT-2 Phase 2 (Worker 2B): entry-point mode — the user
                arrived via "I have a verification code" with no pending
                signup, so username + password are editable fields. The
                password is needed so confirmSignUp can auto-sign-in and
                return the real Cognito uid (without it the profile would
                be written under a stub `aws_<username>` uid). */}
            {!pendingUsername && (
              <div>
                <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-2 text-center">
                  Username you signed up with
                </label>
                <input
                  type="text"
                  required
                  value={pendingUsername}
                  onChange={(e) => setPendingUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  placeholder="e.g. shweta"
                  className="block w-full rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-input-dark py-3 px-4 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green sm:text-sm outline-none"
                />
              </div>
            )}
            {!pendingEmail && (
              <div>
                <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-2 text-center">
                  Your password
                </label>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={pendingPassword}
                  onChange={(e) => setPendingPassword(e.target.value)}
                  placeholder="••••••••"
                  className="block w-full rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-input-dark py-3 px-4 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green sm:text-sm outline-none"
                />
              </div>
            )}
            <div>
              <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-2 text-center">
                Enter 6-Digit Code
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  autoFocus
                  maxLength={6}
                  value={confirmationCode}
                  onChange={(e) => setConfirmationCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className="block w-full text-center tracking-[0.4em] font-mono text-2xl font-bold rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-input-dark py-3 px-4 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green outline-none"
                />

              </div>
            </div>

            <button
              type="submit"
              disabled={loading || confirmationCode.length < 6}
              className="flex w-full justify-center rounded-xl bg-green-cta px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-green-900/20 hover:bg-dark-green disabled:opacity-50 transition-all active:scale-[0.99]"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Verifying code...
                </span>
              ) : (
                'Verify & start chatting'
              )}
            </button>
          </form>

          <div className="flex flex-col gap-3 pt-2 text-center text-sm">
            <button
              type="button"
              disabled={resending}
              onClick={handleResend}
              className="text-primary-green hover:text-dark-green font-medium flex items-center justify-center gap-1.5 text-xs disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${resending ? 'animate-spin' : ''}`} />
              {resending ? 'Sending...' : 'Didn\'t get code? Resend Code'}
            </button>

            <button
              type="button"
              onClick={() => { setStep('form'); setError(''); }}
              className="text-gray-500 dark:text-text-secondary hover:text-gray-700 dark:hover:text-text-primary text-xs flex items-center justify-center gap-1"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Back to edit details
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1: Sign Up Form ──
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-light dark:bg-bg-dark px-4 py-8 pt-safe pb-safe">
      <div className="w-full max-w-md space-y-7 rounded-2xl bg-panel-light dark:bg-panel-dark p-6 sm:p-8 shadow-xl border border-gray-200 dark:border-white/5">
        <div className="flex flex-col items-center">
          <div
            role="button"
            tabIndex={0}
            aria-label={avatarPreview ? 'Change profile photo' : 'Add a profile photo (optional)'}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
            className="relative flex h-24 w-24 cursor-pointer items-center justify-center rounded-full bg-primary-green/10 overflow-hidden group border-2 border-dashed border-primary-green/40"
            onClick={() => fileInputRef.current?.click()}
          >
            {avatarPreview ? (
              <img src={avatarPreview} alt="Avatar preview" className="h-full w-full object-cover" />
            ) : (
              <Camera className="h-10 w-10 text-primary-green" />
            )}
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera className="h-8 w-8 text-white" />
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-text-secondary">Add a photo (optional)</p>
          {avatarPreview && (
            <button
              type="button"
              onClick={handleAvatarRemove}
              aria-label="Remove photo"
              className="mt-1 text-xs font-semibold text-danger-red hover:underline flex items-center gap-1"
            >
              <X className="h-3.5 w-3.5" /> Remove photo
            </button>
          )}
          <input type="file" ref={fileInputRef} onChange={handleAvatarChange} accept="image/*" className="hidden" />
          <h2 className="mt-5 text-center text-3xl font-bold tracking-tight text-gray-900 dark:text-text-primary">
            Create Account
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-text-secondary">Join Pinglo today</p>
        </div>

        {/* Report 3 #47 — noValidate, like the main login form: without it
            the browser's native validation intercepts an empty /
            malformed-email submit and the in-app errors in handleSignup
            are dead code. */}
        <form className="space-y-4" onSubmit={handleSignup} noValidate>
          {error && (
            <div className="rounded-xl bg-danger-red/10 border border-danger-red/20 p-3 text-sm text-danger-red flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
              {pendingUsername && (
                <button
                  type="button"
                  onClick={() => { setStep('confirm'); setError(''); }}
                  className="mt-1 self-start text-xs font-bold underline text-primary-green hover:text-dark-green"
                >
                  👉 Already got a code? Enter it here to activate
                </button>
              )}
            </div>
          )}

          {/* Display Name */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-1">
              Your Name
            </label>
            <input
              ref={nameInputRef}
              type="text"
              name="name"
              autoComplete="name"
              required
              maxLength={30}
              className="block w-full rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-input-dark py-3 px-4 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green sm:text-sm outline-none"
              placeholder="e.g. Shweta"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onInput={(e: any) => setDisplayName(e.target.value)}
              onBlur={(e) => setDisplayName(e.target.value)}
            />
          </div>

          {/* Username */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-1">
              Username
            </label>
            <div className="relative">
              <input
                ref={usernameInputRef}
                type="text"
                name="username"
                autoComplete="username"
                required
                maxLength={30}
                aria-describedby="username-help"
                className={`block w-full rounded-xl border bg-gray-50 dark:bg-input-dark py-3 px-4 pr-10 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green sm:text-sm outline-none ${usernameValid === false ? 'border-danger-red ring-1 ring-danger-red' : 'border-gray-300 dark:border-white/10'}`}
                placeholder="e.g. shweta (min 3 chars)"
                value={usernameRaw}
                onChange={handleUsernameChange}
                onInput={handleUsernameChange}
                onBlur={handleUsernameChange}
              />
              <InputStatus valid={usernameValid} />
            </div>
            <p id="username-help" className="text-xs mt-1 ml-1 leading-relaxed">
              {usernamePreview ? (
                <span className="text-primary-green font-medium">Will be saved as {usernamePreview}</span>
              ) : (
                <span className="text-gray-400">Only lowercase letters, numbers and _ are allowed.</span>
              )}
              {usernameStripped && (
                <span className="text-amber-600 dark:text-amber-400 block">
                  Spaces, capitals &amp; special characters were removed automatically.
                </span>
              )}
            </p>
            {usernameValid === false && <p className="text-xs text-danger-red mt-1 ml-1">Min 3 characters. Letters, numbers, underscore only.</p>}
          </div>

          {/* Email */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-1">
              Email Address
            </label>
            <div className="relative">
              <input
                ref={emailInputRef}
                type="email"
                name="email"
                autoComplete="email"
                required
                maxLength={100}
                className={`block w-full rounded-xl border bg-gray-50 dark:bg-input-dark py-3 px-4 pr-10 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green sm:text-sm outline-none ${emailValid === false ? 'border-danger-red ring-1 ring-danger-red' : 'border-gray-300 dark:border-white/10'}`}
                placeholder="you@gmail.com"
                value={email}
                onChange={handleEmailChange}
                onInput={handleEmailChange}
                onBlur={handleEmailChange}
              />
              <InputStatus valid={emailValid} />
            </div>
            {emailValid === false && <p className="text-xs text-danger-red mt-1 ml-1">Enter a valid email like name@gmail.com</p>}
          </div>

          {/* Password */}
          <div>
            <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider block mb-1">
              Password
            </label>
            <div className="relative">
              <input
                ref={passwordInputRef}
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="new-password"
                required
                maxLength={64}
                className={`block w-full rounded-xl border bg-gray-50 dark:bg-input-dark py-3 px-4 pr-16 text-gray-900 dark:text-text-primary focus:ring-2 focus:ring-primary-green sm:text-sm outline-none ${passwordValid === false ? 'border-danger-red ring-1 ring-danger-red' : 'border-gray-300 dark:border-white/10'}`}
                placeholder="Minimum 8 characters"
                value={password}
                onChange={handlePasswordChange}
                onInput={handlePasswordChange}
                onBlur={handlePasswordChange}
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setShowPassword(s => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-text-primary p-0.5"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                {passwordValid !== null && (
                  passwordValid ? (
                    <CheckCircle2 className="h-4 w-4 text-primary-green" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-danger-red" />
                  )
                )}
              </div>
            </div>
            {passwordValid === false && <p className="text-xs text-danger-red mt-1 ml-1">Password must be at least 8 characters.</p>}
          </div>

          <button
            type="submit" disabled={loading}
            className="flex w-full justify-center rounded-xl bg-green-cta px-4 py-3.5 text-sm font-bold text-white shadow-lg shadow-green-900/20 hover:bg-dark-green disabled:opacity-50 transition-all active:scale-[0.99] mt-2"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Creating account...
              </span>
            ) : 'Create account'}
          </button>

          <div className="text-center text-sm pt-2">
            <span className="text-gray-500 dark:text-text-secondary">Already have an account? </span>
            <Link to="/login" className="font-semibold text-primary-green hover:text-dark-green">Sign in</Link>
          </div>
          {/* AUDIT-2 Phase 2 (Worker 2B) — 1B follow-up (a): explicit entry
              point for signed-up-but-never-confirmed users. */}
          <div className="text-center text-sm">
            <button
              type="button"
              onClick={openVerifyEntry}
              className="font-semibold text-primary-green hover:text-dark-green"
            >
              I have a verification code
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
