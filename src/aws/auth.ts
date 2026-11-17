import {
  signIn as amplifySignIn,
  signUp as amplifySignUp,
  confirmSignUp as amplifyConfirmSignUp,
  resendSignUpCode as amplifyResendSignUpCode,
  signOut as amplifySignOut,
  resetPassword as amplifyResetPassword,
  confirmResetPassword as amplifyConfirmResetPassword,
  getCurrentUser as amplifyGetCurrentUser,
  fetchAuthSession as amplifyFetchAuthSession,
  fetchUserAttributes,
  updateUserAttributes,
  updatePassword as amplifyUpdatePassword,
} from 'aws-amplify/auth';
import { isAwsConfigured } from './config';
import { doc, getDoc, setDoc, updateDoc, db, flushPendingPersistsAsync } from './database';

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  username?: string;
}

export interface SignUpResult {
  user: AuthUser;
  isSignUpComplete: boolean;
  destination?: string;
  cognitoUsername: string;
}

type AuthCallback = (user: AuthUser | null) => void;

/**
 * AUDIT-2 A14 — account-existence leak, closed. Every sign-in / sign-up /
 * password-reset failure returns ONE generic message (below), no matter
 * whether the account exists, the password was wrong, or the account is
 * unconfirmed. The old code threw distinct messages for
 * UserNotFoundException / NotAuthorizedException / UsernameExistsException
 * (and opened a verify-code modal only for unconfirmed accounts), so an
 * attacker could enumerate accounts by error text alone.
 *
 * TRADEOFF (honest): closing the leak also removes the automatic
 * verify-code prompt — a user who signed up but never confirmed can no
 * longer reach the verify screen by logging in or by re-signing up.
 * They use the explicit "I have a verification code" entry point on the
 * login/signup screens instead (AUDIT-2 Phase 2, Worker 2B) — it opens
 * the same verify-code modal without logging in first, and it never
 * reveals whether the account exists (a wrong code just fails).
 */
export const GENERIC_SIGN_IN_ERROR = 'Invalid email or password';
export const GENERIC_SIGN_UP_ERROR = 'Account could not be created. Try a different username or email.';

// Report 3 #55 — the duplicate-account signal, internal only. A14 keeps
// the error MESSAGE generic for every creation failure; the `code` on the
// thrown error is never rendered, it only lets the signup screen offer
// the "Already got a code?" button for a pending-code account. The
// always-visible "I have a verification code" entry point remains the
// leak-free path; this button is a shortcut for the person who just
// typed these exact credentials (and the generic message itself already
// hints "try a different username or email").
function withSignUpCode(message: string, code: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

/**
 * Phase 3 — session expiry. A restored session is only trusted for
 * SESSION_TTL_MS after it was saved; stale sessions are rejected instead
 * of being trusted blindly. Sessions saved before this change have no
 * expiry stored — they are migrated by stamping one now (see
 * restoreSession), never by trusting them forever. Note: this is the
 * *local* session cache only; the live Cognito tokens are still managed
 * (and refreshed) by Amplify itself.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Report 3 #224/#239 (W5b): true for mock-mode uids — the local-dev
 * stand-ins (`usr_<uuid>` from mock sign-up, `aws_<username>` from the
 * old confirmSignUp stub, closed by W9's #46 fix). A Cognito uid is a
 * UUID `sub`, never `usr_`/`aws_`-prefixed.
 */
export function isMockUid(uid: string): boolean {
  return typeof uid === 'string' && (uid.startsWith('usr_') || uid.startsWith('aws_'));
}

/** Outcome of `validateRestoredSession` (Report 3 #224/#239, W5b). */
export type RestoredSessionStatus =
  | 'valid'
  | 'mock-on-real-build'
  | 'no-cognito-session'
  | 'unvalidated-offline'
  | 'no-session';

/** Hard timeout for one startup validation attempt (D6: never hang the splash). */
export const SESSION_VALIDATION_TIMEOUT_MS = 10_000;

function withValidationTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Session validation timed out')), ms),
    ),
  ]);
}

/** Best-effort network-error test: only a network failure may keep an unvalidated session. */
function isNetworkValidationError(e: unknown): boolean {
  const msg = `${(e as any)?.name || ''} ${(e as any)?.message || ''}`;
  return /network|failed to fetch|load failed|timed? ?out|offline|ECONN|ENOTFOUND|not reachable|network request failed/i.test(msg);
}

interface StoredSession {
  user: AuthUser;
  /** Epoch ms after which the cached session must not be trusted. */
  expiresAt: number;
  savedAt: number;
}

/** Usernames: 3–30 chars, lowercase letters, digits and underscores only. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

/**
 * Derive the single canonical username from raw input. Spaces become
 * underscores; anything else outside [a-z0-9_] is REJECTED (not silently
 * mapped), so the Cognito username and the app username can never drift
 * apart. Returns an error message string when invalid, else null.
 */
export function validateUsername(raw: string | undefined | null): string | null {
  const candidate = (raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!candidate) return 'Please choose a username.';
  if (candidate.length < 3) return 'Username must be at least 3 characters.';
  if (candidate.length > 30) return 'Username must be at most 30 characters.';
  if (!USERNAME_PATTERN.test(candidate)) {
    return 'Username can only contain letters, numbers and underscores (no spaces or special characters).';
  }
  return null;
}

/** Canonical username (same value is used for Cognito and for the app profile). */
export function canonicalUsername(raw: string | undefined | null, fallback: string): string {
  const candidate = (raw || fallback || 'user').trim().toLowerCase().replace(/\s+/g, '_');
  return candidate;
}

/**
 * Master-gaps: the DISPLAY username rule shared by the profile editor and
 * the dedicated Change-username form (Settings → Account). 3–30 chars,
 * starts with a letter; letters, digits, dots and underscores only; dots /
 * underscores may not sit next to each other or at the end (same spirit as
 * WhatsApp's @username rules). This is deliberately different from
 * validateUsername() above, which is the stricter Cognito sign-up rule
 * (lowercase letters/digits/underscores, 3–32) — the Cognito login username
 * itself can never be renamed, so a display username may use dots.
 * Returns an error message string when invalid, else ''.
 */
export function validateDisplayUsername(raw: string | undefined | null): string {
  const u = (raw || '').trim().toLowerCase();
  if (!u) return 'Username cannot be empty';
  if (u.length < 3) return 'Username must be at least 3 characters';
  if (u.length > 30) return 'Username must be at most 30 characters';
  if (!/^[a-z][a-z0-9._]{2,29}$/.test(u)) return 'Use only lowercase letters, numbers, dots and underscores, starting with a letter';
  if (u.includes('..') || u.includes('__') || u.includes('._') || u.includes('_.')) return 'Dots and underscores cannot be next to each other';
  if (u.endsWith('.') || u.endsWith('_')) return 'Username cannot end with a dot or underscore';
  return '';
}

const memStorage = new Map<string, string>();
const safeGetItem = (key: string): string | null => {
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      console.warn("[auth] validateDisplayUsername: return localStorage.getItem(key) failed", err);
    }
  }
  return memStorage.get(key) || null;
};
const safeSetItem = (key: string, val: string): void => {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, val);
      return;
    } catch (err) {
      console.warn("[auth] validateDisplayUsername: localStorage.setItem(key, val) failed", err);
    }
  }
  memStorage.set(key, val);
};
const safeRemoveItem = (key: string): void => {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(key);
      return;
    } catch (err) {
      console.warn("[auth] validateDisplayUsername: localStorage.removeItem(key) failed", err);
    }
  }
  memStorage.delete(key);
};

class AwsAuthManager {
  private listeners: Set<AuthCallback> = new Set();
  private currentUser: AuthUser | null = null;
  private storageKey = 'pinglo_aws_auth_session';

  constructor() {
    this.restoreSession();
  }

  private restoreSession() {
    try {
      const stored = safeGetItem(this.storageKey);
      if (!stored) return;
      const parsed: any = JSON.parse(stored);
      // New shape: { user, expiresAt, savedAt }.
      if (parsed && parsed.user && typeof parsed.user === 'object') {
        const expiresAt = Number(parsed.expiresAt) || 0;
        // A stored token exp (seconds) wins over the local stamp when present.
        const tokenExpMs =
          typeof parsed.user.exp === 'number'
            ? parsed.user.exp * 1000
            : typeof parsed.user.tokenExp === 'number'
              ? parsed.user.tokenExp
              : 0;
        const effectiveExpiry = tokenExpMs > 0 ? Math.min(expiresAt || Infinity, tokenExpMs) : expiresAt;
        if (effectiveExpiry && Date.now() > effectiveExpiry) {
          safeRemoveItem(this.storageKey);
          this.currentUser = null;
          return;
        }
        this.currentUser = parsed.user;
        // Migrate: stamp an expiry if none was stored, then re-save.
        if (!expiresAt) this.saveSession(parsed.user);
        return;
      }
      // Legacy shape: the user object itself, with no expiry. Stamp one
      // now (grace period) instead of trusting it forever.
      if (parsed && typeof parsed.uid === 'string') {
        this.currentUser = parsed as AuthUser;
        this.saveSession(this.currentUser);
      }
    } catch (_) {
      // Corrupt session: fail closed, do not trust it.
      try {
        safeRemoveItem(this.storageKey);
      } catch (err) {
        console.warn("[auth] validateDisplayUsername: safeRemoveItem(this.storageKey) failed", err);
      }
      this.currentUser = null;
    }
  }

  /**
   * Returns a promise that resolves once the user-doc write (if any) has
   * landed. Callers that write the doc themselves right after (e.g.
   * updateProfile, followed by Settings' own updateDoc with the NEW
   * username) MUST await this: the doc write is async (getDoc then
   * setDoc), and an un-awaited write lands AFTER the caller's write and
   * clobbers it with the pre-change values — that is exactly how a
   * profile edit used to lose the new username while keeping the new
   * display name. Plain login/restore callers need not await.
   */
  private saveSession(user: AuthUser | null, opts?: { writeProfile?: boolean }): Promise<void> {
    this.currentUser = user;
    if (user) {
      const session: StoredSession = {
        user,
        expiresAt: Date.now() + SESSION_TTL_MS,
        savedAt: Date.now(),
      };
      safeSetItem(this.storageKey, JSON.stringify(session));
      // AUDIT-2 B8 — login must NOT overwrite the stored profile. The old
      // code wrote displayName/username/photoURL into the user doc on
      // EVERY login, derived from whatever the user typed at login (or
      // from the Cognito attrs, where custom:username was never written
      // — so the username silently reset to the email prefix). The stored
      // user doc is now the source of truth for the profile:
      //  - doc exists + no explicit profile change (plain login/restore):
      //    write ONLY identity + presence (uid/email/online/status and
      //    lastSeen when privacy allows). displayName/username/photoURL
      //    are never touched.
      //  - doc missing (first login): write the full profile so the doc
      //    is created with the signup values.
      //  - opts.writeProfile (updateProfile / changeUsername only): the
      //    user explicitly changed the profile, so write it.
      // AUDIT-2 A7: respect last-seen privacy on login. When the user chose
      // 'nobody', do NOT write lastSeen here (the old code wrote it
      // unconditionally on every login). The `online` boolean is the
      // short-lived heartbeat field — it carries no timestamp — so it is
      // still written. A missing user doc (first login) means the default
      // 'everyone', so lastSeen is written then.
      // The chain is RETURNED (not fire-and-forget): callers that write
      // the doc themselves right after must be able to await it (see the
      // method docstring). The trailing .catch swallows failures so an
      // awaited saveSession never throws over a doc write.
      const done = getDoc(doc(db, 'users', user.uid))
        .then((snap: any) => ({
          exists: !!(snap && snap.exists()),
          level: snap && snap.exists() ? snap.data()?.lastSeenPrivacy : undefined,
        }))
        .catch(() => ({ exists: false, level: undefined }))
        .then(({ exists, level }) => {
          const fields: Record<string, unknown> = {
            uid: user.uid,
            email: user.email,
            online: true,
            status: 'online',
          };
          if (!exists || opts?.writeProfile) {
            fields.displayName = user.displayName || user.username || (user.email ? user.email.split('@')[0] : 'User');
            fields.username = user.username || (user.displayName || '').toLowerCase().replace(/\s+/g, '_');
            fields.photoURL = user.photoURL || '';
          }
          if (level !== 'nobody') fields.lastSeen = Date.now();
          return setDoc(doc(db, 'users', user.uid), fields, { merge: true });
        })
        .catch((err) => console.warn("[auth] validateDisplayUsername: setDoc(...) failed", err));
      this.notify();
      return done.then(() => undefined);
    }
    safeRemoveItem(this.storageKey);
    this.notify();
    return Promise.resolve();
  }

  private notify() {
    this.listeners.forEach((cb) => {
      try {
        cb(this.currentUser);
      } catch (e) {
        console.error('Auth listener error:', e);
      }
    });
  }

  /**
   * Report 3 #224/#239 (W5b): validate a restored session against live
   * Cognito at startup. `restoreSession()` trusts the local 7-day stamp
   * only — a mock account created while the app was in mock mode used
   * to survive an APK update, look logged in on a real-config build,
   * and then fail every AppSync write (queued forever, "Offline —
   * message queued" while online). Decision table (delivery-mechanism
   * §4.3, all approved):
   * - No restored session → 'no-session' (login screen as today).
   * - Mock uid on a mock build → 'valid' (mock mode is intended).
   * - Mock uid on a real build → 'mock-on-real-build' (caller forces
   *   re-login; do NOT delete `pinglo_mock_users` — the record is
   *   harmless once the session is gone).
   * - Cognito-shaped uid on a real build → `fetchAuthSession()` +
   *   `getCurrentUser()` (one 10 s race for both); tokens present and
   *   `userId` matches → 'valid'. Auth error / userId mismatch →
   *   'no-cognito-session' (caller forces re-login with the generic
   *   copy; the Cognito error text is never surfaced, AUDIT-2 A14).
   * - Device offline at startup, or a network/timeout error →
   *   'unvalidated-offline': NEVER log out for a network error — the
   *   cached session is kept for local reads and the caller re-runs
   *   this validation on the next `online` event / foreground.
   * On 'valid' the stored session's `expiresAt` is refreshed from the
   * live token expiry when available (best-effort, no user-doc write,
   * no listener notify). Never throws — an unexpected failure is
   * reported as 'unvalidated-offline' (fail open to the cached session
   * is safer than stranding a user offline; the next `online`
   * re-validation settles it).
   */
  public async validateRestoredSession(): Promise<RestoredSessionStatus> {
    const user = this.currentUser;
    if (!user?.uid) return 'no-session';
    if (isMockUid(user.uid)) {
      return isAwsConfigured() ? 'mock-on-real-build' : 'valid';
    }
    if (!isAwsConfigured()) return 'valid';
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'unvalidated-offline';
    try {
      const [session, me] = await withValidationTimeout(
        Promise.all([amplifyFetchAuthSession(), amplifyGetCurrentUser()]),
        SESSION_VALIDATION_TIMEOUT_MS,
      );
      const tokens = (session as any)?.tokens;
      if (!tokens || (me as any)?.userId !== user.uid) return 'no-cognito-session';
      // Best-effort: refresh the stored expiry from the live token exp.
      try {
        const exp = (tokens as any)?.idToken?.payload?.exp;
        if (typeof exp === 'number' && exp > 0) {
          const raw = safeGetItem(this.storageKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.user) {
              const prevExpiry = Number(parsed.expiresAt) || Infinity;
              parsed.expiresAt = Math.min(prevExpiry, exp * 1000);
              safeSetItem(this.storageKey, JSON.stringify(parsed));
            }
          }
        }
      } catch {
        /* expiry refresh is best-effort */
      }
      return 'valid';
    } catch (e) {
      if (isNetworkValidationError(e)) return 'unvalidated-offline';
      return 'no-cognito-session';
    }
  }

  public get user(): AuthUser | null {
    return this.currentUser;
  }

  public onAuthStateChanged(callback: AuthCallback): () => void {
    this.listeners.add(callback);
    // Initial emit
    callback(this.currentUser);
    return () => {
      this.listeners.delete(callback);
    };
  }

  public async signIn(identifier: string, pass: string): Promise<AuthUser> {
    const trimmed = identifier.trim().toLowerCase();

    if (isAwsConfigured()) {
      try {
        const output = await amplifySignIn({
          username: trimmed,
          password: pass,
        });

        if (!output.isSignedIn) {
          // AUDIT-2 A14: even "needs confirmation" is a login failure like
          // any other — same generic error, no CONFIRM_SIGN_UP code (the
          // old code opened a verify-code modal only for unconfirmed
          // accounts, leaking existence). See the tradeoff note above.
          throw new Error(GENERIC_SIGN_IN_ERROR);
        }

        const cognitoUser = await amplifyGetCurrentUser();
        const attrs = await fetchUserAttributes().catch(() => ({} as Record<string, string>));

        // AUDIT-2 B8 — the stored user doc is the source of truth for the
        // profile. Cognito's `name`/`picture` are only a fallback: the
        // app profile (displayName/username/photoURL) is what the user
        // set in Settings, and it must survive a logout/login round-trip.
        // `custom:username` is the Cognito-side mirror (written at signup
        // and on username change — see signUp / changeUsername); it is
        // also only a fallback, never allowed to clobber the doc.
        const stored = await getDoc(doc(db, 'users', cognitoUser.userId))
          .then((snap: any) => (snap && snap.exists() ? snap.data() : null))
          .catch(() => null);

        const user: AuthUser = {
          uid: cognitoUser.userId,
          email: attrs.email || stored?.email || trimmed,
          displayName: stored?.displayName || attrs.name || attrs.nickname || trimmed.split('@')[0],
          photoURL: stored?.photoURL ?? attrs.picture ?? '',
          username: stored?.username || attrs['custom:username'] || trimmed.split('@')[0],
        };

        this.saveSession(user);
        return user;
      } catch (err: any) {
        // AUDIT-2 A14: every sign-in failure — unknown account, wrong
        // password, unconfirmed account, throttling — returns the SAME
        // generic message. Never attach a code, and never pass
        // Cognito's message through (it names the failure reason).
        console.error('AWS Cognito signIn error:', err);
        throw new Error(GENERIC_SIGN_IN_ERROR);
      }
    }

    // Local development mode when AWS .env is not yet populated
    const mockUsers = JSON.parse(safeGetItem('pinglo_mock_users') || '{}');
    const existing = mockUsers[trimmed] || Object.values(mockUsers).find((u: any) => u.username === trimmed);

    if (!existing || existing.password !== pass) {
      throw new Error(GENERIC_SIGN_IN_ERROR);
    }

    // AUDIT-2 B8 (same rule as the AWS path above): the stored user doc
    // is the source of truth for the profile. The mock record is only
    // the Cognito stand-in — its login-time values must not clobber a
    // doc that says something else (e.g. a displayName/username/photo
    // changed in Settings after the record was written).
    const stored = await getDoc(doc(db, 'users', existing.uid))
      .then((snap: any) => (snap && snap.exists() ? snap.data() : null))
      .catch(() => null);

    const user: AuthUser = {
      uid: existing.uid,
      email: stored?.email || existing.email,
      displayName: stored?.displayName || existing.displayName,
      photoURL: stored?.photoURL ?? existing.photoURL ?? '',
      username: stored?.username || existing.username,
    };

    this.saveSession(user);
    return user;
  }

  public async signUp(
    email: string,
    pass: string,
    displayName: string,
    username?: string,
    photoURL?: string
  ): Promise<SignUpResult> {
    const trimmedEmail = (email || '').trim().toLowerCase();
    const cleanDisplayName = (displayName || trimmedEmail.split('@')[0] || 'User').trim();
    // ONE canonical username for both Cognito and the app profile. Special
    // characters are rejected with a clear error — never silently mapped to
    // '_' (which used to create a Cognito user under a different name than
    // the one shown in the app) and never replaced by a random user_... name.
    const usernameError = validateUsername(username || cleanDisplayName);
    if (usernameError) throw new Error(usernameError);
    const cleanUsername = canonicalUsername(username || cleanDisplayName, 'user');
    const cognitoUsername = cleanUsername;
    // Report 3 #54 — the UI used to say "min 6" while Cognito requires
    // min 8, so a 6–7 char password passed every client check and was
    // rejected only at real Cognito submit. Enforce 8 up front, on both
    // paths, with the same message Cognito itself surfaces.
    if (!pass || pass.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }

    if (isAwsConfigured()) {
      const userAttributes: Record<string, string> = {
        email: trimmedEmail,
      };
      if (cleanDisplayName) {
        userAttributes.name = cleanDisplayName;
      }
      if (photoURL && photoURL.startsWith('http')) {
        userAttributes.picture = photoURL;
      }
      // AUDIT-2 B8 — persist the username in Cognito as `custom:username`
      // so signIn can read it back (it was never written before, so the
      // login-time fallback silently reset the username to the email
      // prefix). Honest limit: this only works if the user pool schema
      // defines the custom:username attribute. If the pool rejects it,
      // signUp is retried once WITHOUT it — the app user doc (written by
      // finishAccountSetup) stays the source of truth for the username,
      // so signup must never fail over a missing pool attribute.
      userAttributes['custom:username'] = cleanUsername;

      const doSignUp = (attrs: Record<string, string>) =>
        amplifySignUp({
          username: cognitoUsername,
          password: pass,
          options: { userAttributes: attrs },
        });

      try {
        // Fail loudly on a Cognito error: no silent retry under a random
        // user_... username (that used to create an account the user could
        // never sign back into under the name they chose).
        let output: any;
        try {
          output = await doSignUp(userAttributes);
        } catch (firstErr: any) {
          const msg = `${firstErr?.name || ''} ${firstErr?.message || ''}`;
          if (/custom:username/i.test(msg)) {
            console.warn('Cognito pool has no custom:username attribute — signing up without it (app user doc still holds the username).');
            const { 'custom:username': _dropped, ...withoutCustom } = userAttributes;
            output = await doSignUp(withoutCustom);
          } else {
            throw firstErr;
          }
        }

        // Report 3 #46 (same class as the confirmSignUp stub): never invent
        // a fallback `aws_<username>` uid. If Cognito does not return a
        // userId, fail the signup instead of creating a session under an
        // id that is not the real Cognito identity.
        const uid = output.userId;
        if (!uid) {
          throw new Error(GENERIC_SIGN_UP_ERROR);
        }
        const user: AuthUser = {
          uid,
          email: trimmedEmail,
          displayName: cleanDisplayName,
          photoURL: photoURL || '',
          username: cleanUsername,
        };

        const isComplete = Boolean(output.isSignUpComplete);
        const destination = (output.nextStep as any)?.codeDeliveryDetails?.destination || trimmedEmail;

        if (isComplete) {
          this.saveSession(user);
        }

        return {
          user,
          isSignUpComplete: isComplete,
          destination,
          cognitoUsername,
        };
      } catch (err: any) {
        console.error('AWS Cognito signUp error:', err);
        // AUDIT-2 A14: one generic message for EVERY creation failure —
        // UsernameExistsException used to say "already registered" (and
        // carried a code + the username/email, which the signup screen
        // used to open the verify-code flow — i.e. existence leaked by
        // error text AND by UI). The only exception is the password
        // policy: that is about the password just typed, not about
        // whether an account exists, so it stays specific.
        if (err.name === 'InvalidPasswordException') {
          throw new Error('Password does not meet the requirements (at least 8 characters).');
        }
        // Report 3 #55: Cognito's UsernameExistsException is normalised
        // to the generic message (A14) but keeps its code as an internal
        // signal, so the signup screen can offer the verify-code button.
        if (err.name === 'UsernameExistsException' || err.code === 'UsernameExistsException') {
          throw withSignUpCode(GENERIC_SIGN_UP_ERROR, 'UsernameExistsException');
        }
        throw new Error(GENERIC_SIGN_UP_ERROR);
      }
    }

    // Local development store for immediate testing
    const mockUsers = JSON.parse(safeGetItem('pinglo_mock_users') || '{}');
    // AUDIT-2 A14: mock mode leaks the same way — email-taken and
    // username-taken used to throw different messages. One generic
    // message for both, same as the AWS path.
    if (mockUsers[trimmedEmail]) {
      throw withSignUpCode(GENERIC_SIGN_UP_ERROR, 'UsernameExistsException');
    }

    // Check if username already exists
    const usernameTaken = Object.values(mockUsers).some(
      (u: any) => u.username === cleanUsername
    );
    if (usernameTaken) {
      throw withSignUpCode(GENERIC_SIGN_UP_ERROR, 'UsernameExistsException');
    }

    // AUDIT-2 D4: mock-mode user ids used Math.random. No weak-randomness
    // fallback — crypto.randomUUID() or an honest error.
    const c: any = (globalThis as any).crypto;
    if (!c || typeof c.randomUUID !== 'function') {
      throw new Error('Secure ID generation is unavailable in this browser. Please update it and try again.');
    }
    const uid = 'usr_' + c.randomUUID();
    const newRecord = {
      uid,
      email: trimmedEmail,
      displayName: cleanDisplayName,
      username: cleanUsername,
      photoURL: photoURL || '',
      password: pass,
      bio: 'Hey there! I am using Pinglo.',
      online: true,
      lastSeen: Date.now(),
    };

    mockUsers[trimmedEmail] = newRecord;
    safeSetItem('pinglo_mock_users', JSON.stringify(mockUsers));

    const user: AuthUser = {
      uid,
      email: trimmedEmail,
      displayName: cleanDisplayName,
      photoURL: photoURL || '',
      username: cleanUsername,
    };

    this.saveSession(user);
    return {
      user,
      isSignUpComplete: true,
      destination: trimmedEmail,
      cognitoUsername: cleanUsername,
    };
  }

  public async confirmSignUp(username: string, code: string, password?: string): Promise<AuthUser> {
    const cleanUser = username.trim().toLowerCase().replace(/@/g, '_');
    const cleanCode = code.trim();

    // Report 3 #46 (P0 security hole) — confirming with a code but NO
    // password used to create a STUB session (`aws_<username>` / mock
    // `usr_<username>`, empty email) and navigate to /main. That stub uid
    // differs from the real Cognito uid the user gets on a later normal
    // login, splitting their identity/doc — and it let anyone who knew a
    // username + a code (or, in mock, anything) in with no credential.
    // A stub/mock session may NEVER be created from this path: without a
    // password there is no sign-in, only a confirmation. Callers must
    // collect the password and pass it; with it, confirm signs the user
    // in for real and returns the real uid.
    if (!password) {
      throw new Error('Enter your password to log in after verifying your email.');
    }

    if (isAwsConfigured()) {
      try {
        await amplifyConfirmSignUp({
          username: cleanUser,
          confirmationCode: cleanCode,
        });

        // Password is required (see above) — auto sign in to establish a
        // live session under the REAL Cognito uid.
        return await this.signIn(cleanUser, password);
      } catch (err: any) {
        console.error('Cognito confirmSignUp error:', err);
        if (err.name === 'CodeMismatchException') {
          throw new Error('Invalid verification code provided. Please check your email and try again.');
        }
        if (err.name === 'ExpiredCodeException') {
          throw new Error('Verification code has expired. Please click Resend Code.');
        }
        throw new Error(err.message || 'Verification failed. Please try again.');
      }
    }

    // Mock mode: no stored confirmation code exists, so the code itself
    // cannot be checked here (pre-existing mock limit) — but the session
    // is still only ever the REAL mock user, verified by password via
    // signIn. No `usr_<username>` stub is ever created or saved.
    return await this.signIn(cleanUser, password);
  }

  public async resendSignUpCode(username: string): Promise<string> {
    const cleanUser = username.trim().toLowerCase().replace(/@/g, '_');
    if (isAwsConfigured()) {
      try {
        const res = await amplifyResendSignUpCode({ username: cleanUser });
        return res.destination || 'your email';
      } catch (err: any) {
        console.error('Cognito resendSignUpCode error:', err);
        // AUDIT-2 A14 (same class as reset): a missing account resolves
        // like a real one instead of throwing UserNotFoundException.
        if (err.name === 'UserNotFoundException') {
          return 'your email';
        }
        throw new Error('Could not resend verification code');
      }
    }
    return 'your email';
  }

  public async signOut(): Promise<void> {
    // Report 3 #50 — logout never cleared the push token, so a logged-out
    // device could keep receiving (server-sent) pushes for the account.
    // Capture the uid BEFORE the session is dropped, then clear the token
    // best-effort. Dynamic import: pushNotifications imports ../aws, so a
    // static import here would be a cycle; the token clear must never
    // break sign-out itself.
    const uid = this.currentUser?.uid || null;
    if (isAwsConfigured()) {
      try {
        await amplifySignOut();
      } catch (e) {
        console.warn('Cognito signOut notice:', e);
      }
    }
    // #223/#232 (W5b R23): commit every pending debounced persist BEFORE
    // the session drops. The App auth listener resets the DB cache on
    // sign-out (and signOut itself clears the push token right after),
    // but neither awaited the listener — a write made <1 s before
    // sign-out (profile, ack, message) could lose its 1 s timer to the
    // reset/navigation and never reach disk, so the next login merged
    // onto an empty base and wrote a skeleton doc (proven by
    // probe-w5b-r15/r22-dump: users docs with no uid/email/displayName).
    // Awaiting the flush here makes the sign-out boundary durable for
    // every collection, whatever the listener does.
    try { await flushPendingPersistsAsync(); } catch { /* best-effort */ }
    this.saveSession(null);
    if (uid) {
      try {
        const { clearPushToken } = await import('../services/pushNotifications');
        await clearPushToken(uid);
      } catch (e) {
        console.warn('Push token clear on sign-out failed (best-effort):', e);
      }
    }
  }

  public async resetPassword(identifier: string): Promise<{ destination?: string }> {
    const trimmed = identifier.trim().toLowerCase();
    if (isAwsConfigured()) {
      try {
        const res = await amplifyResetPassword({ username: trimmed });
        return { destination: res.nextStep?.codeDeliveryDetails?.destination || trimmed };
      } catch (err: any) {
        console.error('Cognito resetPassword error:', err);
        // AUDIT-2 A14: a missing account resolves EXACTLY like a real one
        // (same shape, same destination) — never reveal whether the
        // account exists. The login screen renders this as the generic
        // "If an account exists, a reset code was sent" (Phase 2, Worker
        // 2B) — it never names the destination. Other failures
        // (throttling, bad input) get a generic error — Cognito's message
        // is never passed through, it can name the account.
        if (err.name === 'UserNotFoundException') {
          return { destination: trimmed };
        }
        throw new Error('Could not send reset code. Please try again.');
      }
    }
    console.log(`[AWS Cognito Local Mode] Password reset requested for ${trimmed}`);
    return { destination: trimmed };
  }

  public async confirmResetPassword(identifier: string, code: string, newPass: string): Promise<void> {
    const trimmed = identifier.trim().toLowerCase();
    const cleanCode = code.trim();
    if (isAwsConfigured()) {
      try {
        await amplifyConfirmResetPassword({
          username: trimmed,
          confirmationCode: cleanCode,
          newPassword: newPass,
        });
        return;
      } catch (err: any) {
        console.error('Cognito confirmResetPassword error:', err);
        if (err.name === 'CodeMismatchException') {
          throw new Error('Invalid reset code provided. Please check your email.');
        }
        if (err.name === 'ExpiredCodeException') {
          throw new Error('Reset code has expired. Please request a new code.');
        }
        throw new Error(err.message || 'Could not reset password.');
      }
    }
    // Local mode mock update
    const mockUsers = JSON.parse(safeGetItem('pinglo_mock_users') || '{}');
    if (mockUsers[trimmed]) {
      mockUsers[trimmed].password = newPass;
      safeSetItem('pinglo_mock_users', JSON.stringify(mockUsers));
    }
  }

  /**
   * Master-gaps: in-app change password via Amplify Auth `updatePassword`
   * (aws-amplify v6, `updatePassword({ oldPassword, newPassword })`).
   * The current password is verified by Cognito — a wrong one throws and
   * is surfaced as an error, never a fake success. In mock (no-AWS) mode
   * the password stored in the local mock-user record is checked the
   * same way. Cognito's default password policy also applies (8+ chars);
   * policy failures are reported honestly.
   */
  public async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.currentUser) throw new Error('You are not signed in.');
    if (!oldPassword) throw new Error('Enter your current password.');
    if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters.');
    if (oldPassword === newPassword) throw new Error('New password must be different from the current one.');

    if (isAwsConfigured()) {
      try {
        await amplifyUpdatePassword({ oldPassword, newPassword });
        return;
      } catch (err: any) {
        if (err?.name === 'NotAuthorizedException' || /incorrect|not authorized/i.test(err?.message || '')) {
          throw new Error('Current password is incorrect. Please try again.');
        }
        if (err?.name === 'InvalidPasswordException' || /password/i.test(err?.message || '')) {
          throw new Error(err?.message || 'New password does not meet the requirements (at least 8 characters).');
        }
        throw new Error(err?.message || 'Could not change password. Please try again.');
      }
    }

    // Mock mode: the local mock-user record holds the password.
    const mockUsers = JSON.parse(safeGetItem('pinglo_mock_users') || '{}');
    const record = mockUsers[this.currentUser.email];
    if (!record || record.password !== oldPassword) {
      throw new Error('Current password is incorrect. Please try again.');
    }
    record.password = newPassword;
    mockUsers[this.currentUser.email] = record;
    safeSetItem('pinglo_mock_users', JSON.stringify(mockUsers));
  }

  /**
   * Master-gaps: change the @username people see. Uniqueness must be
   * checked by the caller first (SettingsScreen.checkUsernameAvailable)
   * — there is no server-side unique index on the users collection.
   *
   * Honest limit: the Cognito *login* username is immutable and can never
   * be renamed. The closest Cognito-side mirror is `preferred_username`,
   * updated best-effort (a failure there is warned, not fatal — the app
   * username in the user doc is what the app actually displays). The
   * sign-in name therefore stays the same; only the @username changes.
   */
  public async changeUsername(newUsername: string): Promise<string> {
    if (!this.currentUser) throw new Error('You are not signed in.');
    const clean = (newUsername || '').trim().toLowerCase();
    const err = validateDisplayUsername(clean);
    if (err) throw new Error(err);
    if (clean === (this.currentUser.username || '').toLowerCase()) {
      throw new Error('That is already your username.');
    }

    if (isAwsConfigured()) {
      try {
        // AUDIT-2 B8 — mirror the new username into Cognito so signIn can
        // read it back: `custom:username` (the read-back attribute) as well
        // as `preferred_username` (the display-facing one). Best-effort:
        // a failure here is warned, not fatal — the app username in the
        // user doc is what the app actually displays. If the pool schema
        // has no custom:username attribute this throws and is swallowed
        // by the same catch.
        await updateUserAttributes({
          userAttributes: { preferred_username: clean, 'custom:username': clean },
        });
      } catch (e) {
        console.warn('Cognito preferred_username update failed (app username still updated):', e);
      }
    }

    try {
      await updateDoc(doc(db, 'users', this.currentUser.uid), { username: clean });
    } catch (e) {
      console.warn('User doc username update failed:', e);
    }

    const updated = { ...this.currentUser, username: clean };
    // Explicit profile change — write it to the doc (see saveSession/B8).
    // Awaited: the caller's own doc write (if any) must land after this
    // one, never before it (see the saveSession docstring).
    await this.saveSession(updated, { writeProfile: true });

    // Mock store mirror (mock mode only; no-op otherwise).
    try {
      const mockUsers = JSON.parse(safeGetItem('pinglo_mock_users') || '{}');
      if (mockUsers[updated.email]) {
        mockUsers[updated.email] = { ...mockUsers[updated.email], username: clean };
        safeSetItem('pinglo_mock_users', JSON.stringify(mockUsers));
      }
    } catch (err) {
      console.warn("[auth] changeUsername: const mockUsers = JSON.parse(safeGetItem('pinglo_mock...", err);
    }
    return clean;
  }

  public async updateProfile(updates: { displayName?: string; photoURL?: string }): Promise<void> {
    if (!this.currentUser) return;

    if (isAwsConfigured()) {
      try {
        const userAttributes: Record<string, string> = {};
        if (updates.displayName) userAttributes.name = updates.displayName;
        if (updates.photoURL) userAttributes.picture = updates.photoURL;
        await updateUserAttributes({ userAttributes });
      } catch (e) {
        console.warn('Cognito updateUserAttributes:', e);
      }
    }

    const updated = {
      ...this.currentUser,
      ...updates,
    };
    // Explicit profile change (Settings/profile edit) — write it to the
    // doc (see saveSession/B8). A plain login must never do this.
    // Awaited: Settings' handleSaveProfile writes the NEW username to the
    // doc right after this returns — if this write were still in flight
    // it would land later and clobber the new username with the old one.
    await this.saveSession(updated, { writeProfile: true });

    // Sync to local mock database if present
    const mockUsers = JSON.parse(safeGetItem('pinglo_mock_users') || '{}');
    if (mockUsers[updated.email]) {
      mockUsers[updated.email] = {
        ...mockUsers[updated.email],
        displayName: updated.displayName,
        photoURL: updated.photoURL,
      };
      safeSetItem('pinglo_mock_users', JSON.stringify(mockUsers));
    }
  }
}

export const authManager = new AwsAuthManager();

// Compatibility exports matching standard Auth interface
export const auth = {
  get currentUser() {
    return authManager.user;
  },
};

export const onAuthStateChanged = (
  _authInstance: typeof auth,
  callback: (user: AuthUser | null) => void
) => {
  return authManager.onAuthStateChanged(callback);
};

export const signInWithEmailAndPassword = async (_authInstance: typeof auth, email: string, pass: string) => {
  return authManager.signIn(email, pass);
};

export const createUserWithEmailAndPassword = async (
  _authInstance: typeof auth,
  email: string,
  pass: string
) => {
  const res = await authManager.signUp(email, pass, email.split('@')[0], email.split('@')[0]);
  return { user: res.user };
};

export const signOut = async (_authInstance: typeof auth) => {
  return authManager.signOut();
};

export const sendPasswordResetEmail = async (_authInstance: typeof auth, email: string) => {
  return authManager.resetPassword(email);
};

export const confirmSignUp = async (username: string, code: string, password?: string) => {
  return authManager.confirmSignUp(username, code, password);
};

export const resendSignUpCode = async (username: string) => {
  return authManager.resendSignUpCode(username);
};

export const confirmResetPassword = async (username: string, code: string, newPass: string) => {
  return authManager.confirmResetPassword(username, code, newPass);
};

export const updateProfile = async (
  _user: any,
  profile: { displayName?: string; photoURL?: string }
) => {
  return authManager.updateProfile(profile);
};
