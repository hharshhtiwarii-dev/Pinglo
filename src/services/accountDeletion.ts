/**
 * Account deletion — Feature 4c (Pinglo Phase 2).
 *
 * Deletes the signed-in user's own data through the existing AppSync /
 * Firestore-compatible layer (`src/aws/database.ts`) and then deletes the
 * Cognito identity with Amplify Auth's `deleteUser()` (exported by the
 * installed `aws-amplify@^6.22.2` — verified in
 * `node_modules/@aws-amplify/auth/dist/esm/index.d.ts`).
 *
 * Ordering matters: app data is deleted FIRST, while the session is still
 * alive (AppSync calls need it). The Cognito identity is deleted LAST.
 * Sign-out is deliberately NOT done here — the caller shows the result
 * screen first and only signs out when the user taps "Sign out"
 * (`signOutAfterDeletion`), so the user can read what was / was not deleted.
 *
 * What is deleted (best-effort per item; one failure never aborts the rest):
 *   - `users/{uid}` — profile doc (display name, username, about, photo,
 *     chat prefs, folders, blocked list, hidden-chat list).
 *   - `users/{uid}/private/pins` — hashed hidden-chat PINs + lockout state.
 *   - `users/{uid}/starred/*` — the user's starred messages.
 *   - `chats/saved_{uid}/messages/*` — the user's own saved messages.
 *   - `statuses/*` where `userId === uid` — the user's own statuses.
 *   - `feedback/*` where `userId === uid` — the user's own support messages.
 *   - Group membership: `leaveGroup()` for every `communities/*` doc whose
 *     `members` include the uid (reuses Phase 1 group-admin logic, so a
 *     sole admin is replaced before leaving; a group left with zero
 *     members stays as an empty shell — it is not deleted).
 *   - Local mock mode only (`isAwsConfigured() === false`): the user's
 *     record in the `pinglo_mock_users` localStorage store.
 *   - Cognito identity via `deleteUser()` (AWS mode only).
 *
 * What is deliberately NOT deleted:
 *   - 1:1 chat messages (`chats/{sortedUidA_uidB}/messages/*`). Those
 *     messages are the other person's received copy too; deleting them
 *     would delete someone else's chat history. The other party keeps them.
 *   - Group messages the user sent. Same reason: they belong to the group.
 *   - Other users' docs that merely reference this uid (their `chatPrefs`,
 *     `blockedUsers`, call signalling). Harmless dangling references.
 *   - Device-local preferences (theme, wallpaper, per-device chat prefs).
 *
 * Honesty contract: the result reports per-item success and whether the
 * Cognito identity was VERIFIED deleted. If `deleteUser()` throws, the
 * result says `cognitoNeedsAdmin: true` and the UI must show the
 * "needs admin" state — never claim the account is fully gone.
 */

import { deleteUser as amplifyDeleteUser } from 'aws-amplify/auth';
import { isAwsConfigured } from '../aws/config';
import { authManager, db, doc, getDoc, deleteDoc, updateDoc } from '../aws';
import { deleteChatMedia, deleteChatMediaMany } from '../aws/storage';
import { leaveGroup } from '../components/groupAdmin';

export interface DeletionItemResult {
  /** Human-readable label, e.g. "Profile" or "Left 3 groups". */
  item: string;
  ok: boolean;
  /** Error message when ok is false. */
  detail?: string;
}

export interface DeleteAccountResult {
  /** One entry per data-deletion step, in the order attempted. */
  localData: DeletionItemResult[];
  /** True only if Amplify `deleteUser()` resolved without error. */
  cognitoDeleted: boolean;
  /**
   * True when the Cognito identity could NOT be deleted from the client
   * (AWS mode, `deleteUser()` threw). The app data above is still deleted
   * and the user is signed out, but the login itself still exists in the
   * Cognito user pool until an admin removes it.
   */
  cognitoNeedsAdmin: boolean;
  /** `deleteUser()` error message, when `cognitoNeedsAdmin` is true. */
  cognitoError?: string;
  /** True in local mock mode (no Cognito identity exists at all). */
  wasLocalMode: boolean;
}

/** Delete every doc in a collection path whose data matches `match`. */
async function deleteMatchingDocs(
  colPath: string,
  match: (d: any) => boolean,
  label: string,
  results: DeletionItemResult[]
): Promise<void> {
  try {
    await db.ensure(colPath);
    const docs = db.getCollectionDocs(colPath).filter(match);
    let deleted = 0;
    let failed = 0;
    for (const d of docs) {
      try {
        await deleteDoc(doc(db, colPath, d.id));
        deleted++;
      } catch {
        failed++;
      }
    }
    results.push({
      item: failed > 0 ? `${label} (${deleted} deleted, ${failed} failed)` : `${label} (${deleted})`,
      ok: failed === 0,
      detail: failed > 0 ? `${failed} item(s) could not be deleted.` : undefined,
    });
  } catch (e: any) {
    results.push({ item: label, ok: false, detail: e?.message || String(e) });
  }
}

/**
 * Delete the user's app data, then their Cognito identity.
 * Never throws for a single failed step — failures are recorded in the
 * result. Does NOT sign out; call `signOutAfterDeletion()` after the user
 * has seen the result screen.
 */
export async function deleteMyAccountData(uid: string): Promise<DeleteAccountResult> {
  const results: DeletionItemResult[] = [];
  const awsMode = isAwsConfigured();

  // 1. Appear offline first, so nobody sees a ghost "online" user.
  try {
    await updateDoc(doc(db, 'users', uid), { online: false, status: 'offline' });
  } catch (_) {
    // Non-fatal: the profile doc is deleted below anyway.
  }

  // 2. Phase 3 — delete the user's avatar + their own sent media from S3
  // (best-effort, capped, never aborts the rest of the deletion). Messages
  // themselves stay for the other party; only the stored media objects go.
  try {
    const profileSnap = await getDoc(doc(db, 'users', uid));
    const photoURL = profileSnap.exists() ? String(profileSnap.data().photoURL || '') : '';
    let mediaDeleted = 0;
    if (photoURL) {
      try {
        if (await deleteChatMedia(photoURL)) mediaDeleted += 1;
      } catch { /* intentionally ignored */}
    }
    const mediaUrls: string[] = [];
    try {
      for (const channel of db.getAllChatChannels()) {
        if (mediaUrls.length >= 200) break;
        const msgs = db.getCollectionDocs(`chats/${channel}/messages`);
        for (const m of msgs) {
          if (mediaUrls.length >= 200) break;
          if (m?.senderId === uid && typeof m.mediaUrl === 'string' && m.mediaUrl) {
            mediaUrls.push(m.mediaUrl);
          }
        }
      }
    } catch { /* intentionally ignored */}
    if (mediaUrls.length > 0) mediaDeleted += await deleteChatMediaMany(mediaUrls);
    results.push({ item: `Deleted my media from storage (${mediaDeleted} file(s))`, ok: true });
  } catch (e: any) {
    results.push({ item: 'Deleted my media from storage', ok: false, detail: e?.message || String(e) });
  }

  // 3. Leave every group (sole-admin promotion handled by leaveGroup).
  try {
    await db.ensure('communities');
    const mine = db
      .getCollectionDocs('communities')
      .filter((g: any) => Array.isArray(g.members) && g.members.includes(uid));
    let left = 0;
    let failed = 0;
    for (const g of mine) {
      try {
        await leaveGroup(g.id, uid);
        left++;
      } catch (_) {
        failed++;
      }
    }
    results.push({
      item: `Left ${left} group(s)`,
      ok: failed === 0,
      detail: failed > 0 ? `${failed} group(s) could not be left — ask an admin to remove you.` : undefined,
    });
  } catch (e: any) {
    results.push({ item: 'Left groups', ok: false, detail: e?.message || String(e) });
  }

  // 4. Own statuses, own feedback, own starred messages, own saved messages.
  await deleteMatchingDocs('statuses', (d: any) => d.userId === uid, 'Deleted my statuses', results);
  await deleteMatchingDocs('feedback', (d: any) => d.userId === uid, 'Deleted my support messages', results);
  await deleteMatchingDocs(`users/${uid}/starred`, () => true, 'Deleted my starred messages', results);
  await deleteMatchingDocs(`chats/saved_${uid}/messages`, () => true, 'Deleted my saved messages', results);

  // 5. Private PIN doc (hashed hidden-chat PINs + lockout state).
  try {
    await deleteDoc(doc(db, 'users', uid, 'private', 'pins'));
    results.push({ item: 'Deleted my PIN data', ok: true });
  } catch (e: any) {
    results.push({ item: 'Deleted my PIN data', ok: false, detail: e?.message || String(e) });
  }

  // 6. Profile doc itself — last, so earlier steps can still read it.
  try {
    await deleteDoc(doc(db, 'users', uid));
    results.push({ item: 'Deleted my profile', ok: true });
  } catch (e: any) {
    results.push({ item: 'Deleted my profile', ok: false, detail: e?.message || String(e) });
  }

  // 7. Local mock mode: remove the mock user record (no Cognito here).
  if (!awsMode) {
    try {
      const raw = localStorage.getItem('pinglo_mock_users');
      if (raw) {
        const mockUsers = JSON.parse(raw);
        const key = Object.keys(mockUsers).find((k: string) => mockUsers[k]?.uid === uid);
        if (key) {
          delete mockUsers[key];
          localStorage.setItem('pinglo_mock_users', JSON.stringify(mockUsers));
        }
      }
      results.push({ item: 'Deleted my local login record', ok: true });
    } catch (e: any) {
      results.push({ item: 'Deleted my local login record', ok: false, detail: e?.message || String(e) });
    }
    return { localData: results, cognitoDeleted: false, cognitoNeedsAdmin: false, wasLocalMode: true };
  }

  // 8. Cognito identity — last, because it ends the session. Verified only
  // by the call resolving; any throw means "needs admin", not "deleted".
  try {
    await amplifyDeleteUser();
    return { localData: results, cognitoDeleted: true, cognitoNeedsAdmin: false, wasLocalMode: false };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return {
      localData: results,
      cognitoDeleted: false,
      cognitoNeedsAdmin: true,
      cognitoError: msg,
      wasLocalMode: false,
    };
  }
}

/**
 * Sign out after the user has seen the deletion result. Clears the local
 * session (`pinglo_aws_auth_session`); `App.tsx` then redirects to /login
 * via `onAuthStateChanged`. Safe to call even after a successful
 * `deleteUser()` (Amplify sign-out errors are swallowed by authManager).
 */
export async function signOutAfterDeletion(): Promise<void> {
  await authManager.signOut();
}
