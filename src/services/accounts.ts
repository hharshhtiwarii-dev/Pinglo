/**
 * Multiple accounts (Phase 4, Worker C). Max 3 saved accounts.
 *
 * SESSION MECHANISM FOUND (src/aws/auth.ts — AwsAuthManager):
 * - The app does NOT keep Cognito tokens in app code. Amplify manages the
 *   live Cognito session itself (its own storage, `CognitoIdentityServiceProvider.*`
 *   keys) and refreshes tokens; `authManager.signIn()` calls Amplify
 *   `signIn()` + `getCurrentUser()` + `fetchUserAttributes()`.
 * - App code keeps ONE local session cache in localStorage under
 *   `pinglo_aws_auth_session`: `{ user: {uid,email,displayName,photoURL,username},
 *   expiresAt, savedAt }`, trusted for 7 days (SESSION_TTL_MS). `signOut()`
 *   clears it (and calls Amplify `signOut()`).
 * - There is NO multi-account token store anywhere in the app: only one
 *   Cognito session can be live at a time.
 *
 * WHAT THIS MODULE DOES (honest limits):
 * - Stores up to 3 saved accounts in localStorage (`pinglo_saved_accounts`):
 *   `{ uid, displayName, email, username, savedAt }` — identity only.
 *   NO passwords, NO tokens, NO Cognito refresh tokens are ever stored here.
 * - `recordCurrentAccount(user)` is called after a successful login/signup
 *   so the account appears in the switcher.
 * - Switching accounts = save current account, `authManager.signOut()`
 *   (kills the live Cognito session), then go to /login with the target
 *   account's email prefilled (`pinglo_switch_to`). The user MUST re-enter
 *   their password — true password-less switching is impossible without a
 *   backend token vault, and storing passwords/tokens locally would be a
 *   security hole. This is documented in the Settings UI too.
 * - Removing an account only removes it from this device's list; it does
 *   NOT delete the account (delete-account lives in DeleteAccountModal).
 */

import { auth, authManager } from '../aws';

export interface SavedAccount {
  uid: string;
  displayName: string;
  email: string;
  username?: string;
  savedAt: number;
}

export const MAX_SAVED_ACCOUNTS = 3;
const STORAGE_KEY = 'pinglo_saved_accounts';
/** LoginScreen reads + clears this to prefill the identifier field. */
export const SWITCH_TO_KEY = 'pinglo_switch_to';

export function listSavedAccounts(): SavedAccount[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a) => a && typeof a.uid === 'string') : [];
  } catch {
    return [];
  }
}

function persist(accounts: SavedAccount[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts.slice(0, MAX_SAVED_ACCOUNTS)));
  } catch { /* intentionally ignored */}
}

/** Record the currently signed-in user in the saved list (most recent first). */
export function recordCurrentAccount(user?: { uid: string; displayName?: string; email?: string; username?: string } | null): SavedAccount[] {
  const u = user ?? auth.currentUser;
  if (!u?.uid) return listSavedAccounts();
  const entry: SavedAccount = {
    uid: u.uid,
    displayName: u.displayName || u.username || (u.email ? u.email.split('@')[0] : 'User'),
    email: u.email || '',
    username: u.username,
    savedAt: Date.now(),
  };
  const rest = listSavedAccounts().filter((a) => a.uid !== u.uid);
  const next = [entry, ...rest].slice(0, MAX_SAVED_ACCOUNTS);
  persist(next);
  return next;
}

export function removeSavedAccount(uid: string): SavedAccount[] {
  const next = listSavedAccounts().filter((a) => a.uid !== uid);
  persist(next);
  return next;
}

/**
 * Switch to another saved account: remember the current one, sign out of
 * the live Cognito session, and prefill the login screen with the target
 * account's email/username. The caller navigates to /login afterwards.
 * Returns false when there is nothing to switch to.
 */
export async function switchToAccount(targetUid: string): Promise<boolean> {
  const target = listSavedAccounts().find((a) => a.uid === targetUid);
  if (!target) return false;
  recordCurrentAccount();
  try {
    localStorage.setItem(SWITCH_TO_KEY, target.email || target.username || '');
  } catch { /* intentionally ignored */}
  try {
    await authManager.signOut();
  } catch { /* intentionally ignored */}
  return true;
}

/** "Add account": remember the current one, sign out, go to a blank login screen. */
export async function addAccount(): Promise<void> {
  recordCurrentAccount();
  try {
    localStorage.removeItem(SWITCH_TO_KEY);
  } catch { /* intentionally ignored */}
  try {
    await authManager.signOut();
  } catch { /* intentionally ignored */}
}

/** Read + clear the prefill value left by switchToAccount(). */
export function consumeSwitchTo(): string {
  try {
    const v = localStorage.getItem(SWITCH_TO_KEY) || '';
    localStorage.removeItem(SWITCH_TO_KEY);
    return v;
  } catch {
    return '';
  }
}
