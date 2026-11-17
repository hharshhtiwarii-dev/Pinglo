/**
 * Group admin helpers — Feature 1 (Pinglo Phase 1).
 *
 * Groups are `communities` docs. Shape (see NewGroupModal / CommunitiesScreen):
 *   { name, emoji, description, creatorId, creatorName, members: string[],
 *     memberCount: number, admins?: string[], timestamp, isGroup?: true }
 *
 * BACKWARD COMPATIBILITY: groups created before this feature have no `admins`
 * field. For those, the creator is treated as the sole admin. Once any admin
 * write happens, an explicit `admins` array is stored and used as-is.
 *
 * All writes go through the existing Firestore-style API in `../aws`
 * (database.ts over AppSync). Every op is read-modify-write via getDoc +
 * updateDoc, which is how updateDoc already works internally, so the member
 * list and memberCount stay consistent in a single document write.
 *
 * NOTE: there is no server-side permission check — the UI gates admin actions
 * behind `isGroupAdmin`. A non-admin client could still write the doc; true
 * enforcement would need an AppSync resolver / auth rule (out of scope).
 */

import { doc, db, getDoc, updateDoc, addDoc, collection } from '../aws';
import { cleanId } from '../services/realtimeSync';

export interface GroupDoc {
  id?: string;
  name?: string;
  emoji?: string;
  description?: string;
  creatorId?: string;
  creatorName?: string;
  /** UIDs of members. Absent on very old docs — treated as []. */
  members?: string[];
  memberCount?: number;
  /** UIDs of admins. Absent on pre-Feature-1 groups — creator is admin. */
  admins?: string[];
  /** Group photo URL (S3 or compressed data URL — see uploadProfilePicture).
   * Absent = no photo; the emoji icon is the fallback identity everywhere. */
  photoURL?: string;
  /** #194 — granular group permissions (WhatsApp parity). Absent = 'all'
   * (existing groups behave exactly as before). 'admins' restricts the
   * action to group admins; enforcement is client-side UI gating only
   * (#180 server enforcement is BACKEND-PHASE). */
  editInfoBy?: 'all' | 'admins';
  sendMessagesBy?: 'all' | 'admins';
  timestamp?: any;
  isGroup?: boolean;
  /** True = public announcement-only channel: only admins can post. Absent = normal group. */
  isChannel?: boolean;
  /** NF-1 — channel reaction policy: 'any' | 'default' | 'none'.
   * Absent = 'any' (existing channels behave exactly as before).
   * Only meaningful on channels; client-side gating only. */
  reactionPolicy?: string;
  /** Alias for isChannel, accepted on read. Written together with isChannel. */
  readOnly?: boolean;
  /**
   * Phase 4 — join approval. When `requireApproval` is true, joining via an
   * invite link does NOT add the user directly; instead a request is stored
   * in `joinRequests` and an admin must approve it (see requestJoinGroup /
   * approveJoinRequest / declineJoinRequest). Default off (absent = false),
   * so existing groups behave exactly as before.
   */
  requireApproval?: boolean;
  /** Pending join requests: { uid, name, at } (epoch ms). */
  joinRequests?: JoinRequest[];
  /**
   * Tokenised invite link (Phase 3). `inviteToken` is a random token that
   * must appear in the invite URL (`?inv=<token>`); `inviteTokenExpiresAt`
   * is epoch ms (0 / absent = no expiry, legacy links); `inviteTokenRevoked`
   * marks a token dead before its expiry. Old links without `?inv=` keep
   * working until an admin regenerates/revokes — see validateInviteToken.
   */
  inviteToken?: string;
  inviteTokenExpiresAt?: number;
  inviteTokenRevoked?: boolean;
  [key: string]: any;
}

/** One pending join request (Phase 4). Stored on the group doc. */
export interface JoinRequest {
  uid: string;
  name: string;
  at: number;
}

/** Max members in a group (WhatsApp parity: 1,024). Client-side only — a
 * modified client or direct DB write can still exceed it; true enforcement
 * needs a server/AppSync rule (backend work, out of scope). */
export const MAX_GROUP_MEMBERS = 1024;

/** Shown whenever an add/create would take a group over the limit. */
export const GROUP_MEMBER_LIMIT_MESSAGE = 'Groups can have up to 1,024 members';

/** #153 — "1 member" / "1 subscriber", never "1 members". */
export function formatMemberCount(count: number, channel = false): string {
  const n = Math.max(0, Math.floor(count) || 0);
  const noun = channel ? (n === 1 ? 'subscriber' : 'subscribers') : (n === 1 ? 'member' : 'members');
  return `${n.toLocaleString()} ${noun}`;
}

/** "128 / 1,024" — used in GroupInfo / add-members UI. */
export function groupMemberCountLabel(count: number): string {
  return `${count.toLocaleString()} / ${MAX_GROUP_MEMBERS.toLocaleString()}`;
}

/** True when adding `addingCount` new members to a group of `currentCount` would exceed the limit. */
export function wouldExceedGroupMemberLimit(currentCount: number, addingCount: number): boolean {
  return currentCount + addingCount > MAX_GROUP_MEMBERS;
}

/** Invite links live 30 days by default, then must be regenerated. */
export const INVITE_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Random invite token: `inv_` + 20 hex chars (crypto-grade only).
 *  AUDIT-2 D4: the Math.random() fallback is gone. Without
 *  crypto.getRandomValues() this throws an honest error instead of
 *  minting a guessable invite token. */
export function newInviteToken(): string {
  const c: any = (globalThis as any).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Secure invite tokens need crypto.getRandomValues() — this browser/WebView is too old to create an invite link.');
  }
  const bytes = new Uint8Array(10);
  c.getRandomValues(bytes);
  return 'inv_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type InviteTokenState = 'ok' | 'expired' | 'revoked' | 'invalid' | 'legacy';

/**
 * Validate an invite token against a group doc (pure, no I/O).
 *  - 'ok': token matches, not revoked, not expired.
 *  - 'expired': token matches but inviteTokenExpiresAt is in the past.
 *  - 'revoked': token was revoked by an admin.
 *  - 'invalid': token does not match the stored one.
 *  - 'legacy': the group has no token stored yet (pre-Phase-3 group or a
 *    link shared before tokens existed) — old `?type=community` links
 *    without `?inv=` are still accepted. Once an admin regenerates a
 *    token, only that token works.
 */
export function validateInviteToken(
  group: GroupDoc | null | undefined,
  token?: string | null,
): InviteTokenState {
  if (!group) return 'invalid';
  const stored = group.inviteToken;
  if (!stored) return 'legacy';
  if (!token || token !== stored) return 'invalid';
  if (group.inviteTokenRevoked) return 'revoked';
  const exp = group.inviteTokenExpiresAt;
  if (typeof exp === 'number' && exp > 0 && Date.now() > exp) return 'expired';
  return 'ok';
}

/** Human-readable expiry for the stored invite token, or '' when none. */
export function inviteTokenExpiryLabel(group: GroupDoc | null | undefined): string {
  if (!group?.inviteToken) return '';
  if (group.inviteTokenRevoked) return 'Revoked';
  const exp = group.inviteTokenExpiresAt;
  if (typeof exp !== 'number' || exp <= 0) return 'Never expires';
  const d = new Date(exp);
  if (Date.now() > exp) return `Expired ${d.toLocaleDateString()}`;
  return `Expires ${d.toLocaleDateString()}`;
}

/** Member UIDs, never null. */
export function getMemberIds(group: GroupDoc | null | undefined): string[] {
  if (!group || !Array.isArray(group.members)) return [];
  return [...group.members];
}

/**
 * Admin UIDs. If the doc has a non-empty `admins` array it wins; otherwise
 * the creator is the admin (backward compat for groups made before Feature 1).
 */
export function getAdminIds(group: GroupDoc | null | undefined): string[] {
  if (!group) return [];
  if (Array.isArray(group.admins) && group.admins.length > 0) return [...group.admins];
  return group.creatorId ? [group.creatorId] : [];
}

export function isGroupAdmin(group: GroupDoc | null | undefined, uid?: string | null): boolean {
  if (!uid) return false;
  return getAdminIds(group).includes(uid);
}

export function isGroupMember(group: GroupDoc | null | undefined, uid?: string | null): boolean {
  if (!uid) return false;
  return getMemberIds(group).includes(uid);
}

export function isGroupCreator(group: GroupDoc | null | undefined, uid?: string | null): boolean {
  if (!uid) return false;
  return group?.creatorId === uid;
}

/**
 * Public channels (Phase 2). A doc is a channel when either flag is true,
 * so docs written by either name behave the same. Docs with neither flag
 * (all pre-Phase-2 communities/groups) are normal groups.
 */
export function isChannel(group: GroupDoc | null | undefined): boolean {
  if (!group) return false;
  return group.isChannel === true || group.readOnly === true;
}

/** True when this user may post in this chat. Non-channels: always true. */
export function canSendInChannel(group: GroupDoc | null | undefined, uid?: string | null): boolean {
  if (!isChannel(group)) return true;
  return isGroupAdmin(group, uid);
}

/**
 * #194 — granular "Send messages" permission. Channels keep their existing
 * admin-only rule; a plain group with sendMessagesBy 'admins' is admin-only
 * too. Absent = everyone (existing groups unchanged). Client-side only.
 */
export function canSendInGroup(group: GroupDoc | null | undefined, uid?: string | null): boolean {
  if (isChannel(group)) return isGroupAdmin(group, uid);
  if (group?.sendMessagesBy === 'admins') return isGroupAdmin(group, uid);
  return true;
}

/**
 * #194 — granular "Edit group info" permission. 'admins' = admins only;
 * anything else (incl. absent) = any member may edit. Non-members never.
 * Client-side only.
 */
export function canEditGroupInfo(group: GroupDoc | null | undefined, uid?: string | null): boolean {
  if (!group || !uid) return false;
  if (!isGroupMember(group, uid)) return false;
  if (group.editInfoBy === 'admins') return isGroupAdmin(group, uid);
  return true;
}

/** NF-1 — admin-only: set the channel reaction policy. Validated here
 * (unknown values are rejected, never stored) so a hand-written doc or
 * an older client cannot smuggle in a bogus policy. */
export async function setChannelReactionPolicy(
  groupId: string,
  policy: 'any' | 'default' | 'none',
): Promise<void> {
  if (policy !== 'any' && policy !== 'default' && policy !== 'none') return;
  await updateDoc(doc(db, 'communities', groupId), { reactionPolicy: policy });
}

/** #194 — admin-only: set the granular group permissions. */
export async function setGroupPermissions(
  groupId: string,
  patch: { editInfoBy?: 'all' | 'admins'; sendMessagesBy?: 'all' | 'admins' },
): Promise<void> {
  const updates: Record<string, any> = {};
  if (patch.editInfoBy !== undefined) updates.editInfoBy = patch.editInfoBy;
  if (patch.sendMessagesBy !== undefined) updates.sendMessagesBy = patch.sendMessagesBy;
  if (Object.keys(updates).length === 0) return;
  await updateDoc(doc(db, 'communities', groupId), updates);
}

/**
 * Subscriber/member count, recomputed from `members.length` on every read.
 * The stored `memberCount` is NOT trusted: it drifts whenever a member is
 * added/removed by a path that forgets to update it (Phase 3 fix). It is
 * only used as a fallback for docs that predate the `members` array.
 */
export function getSubscriberCount(group: GroupDoc | null | undefined): number {
  if (!group) return 0;
  if (Array.isArray(group.members)) return group.members.length;
  if (typeof group.memberCount === 'number' && group.memberCount > 0) {
    return group.memberCount;
  }
  return group.creatorId ? 1 : 0;
}

/** Same recompute, returned on a copy of the doc (handy for list rendering). */
export function withFreshMemberCount(group: GroupDoc): GroupDoc {
  return { ...group, memberCount: getSubscriberCount(group) };
}

/** Public join link for a channel — opening it auto-joins (ChatScreen, `join=1`).
 * Note: buildInviteLink already appends `&join=1` (#185), so this is just an
 * alias — appending it a second time used to produce `&join=1&join=1`. */
export function buildChannelJoinLink(groupId: string, token?: string | null): string {
  return buildInviteLink(groupId, token);
}

/**
 * WA72 C13 — admin invite link. Same tokenised join link as
 * buildChannelJoinLink, plus `&role=admin`: whoever opens it joins AND is
 * promoted to admin (ChatScreen passes `asAdmin` to requestJoinGroup).
 * The token is the same member-invite token, so revoke/regenerate kills
 * admin links too — no second token to manage. Admin-only: only shown to
 * admins in GroupInfoModal.
 */
export function buildAdminInviteLink(groupId: string, token?: string | null): string {
  return `${buildInviteLink(groupId, token)}&role=admin`;
}

/** Admin-only: convert a group to a channel, or a channel back to a group. */
export async function setChannelMode(groupId: string, isChannelValue: boolean): Promise<void> {
  await updateDoc(doc(db, 'communities', groupId), {
    isChannel: isChannelValue,
    readOnly: isChannelValue,
  });
}

/** Idempotent public join (via addGroupMembers — no double-count on re-join). */
export async function joinChannel(groupId: string, uid: string): Promise<void> {
  await addGroupMembers(groupId, [uid]);
}

/** Deep link that opens this group in ChatScreen (`?type=community`). */
export const INVITE_LINK_BASE = 'https://dtchats.app';

/**
 * #185 — group links now carry `&join=1` like channel links, so opening one
 * auto-joins (ChatScreen's approval-aware auto-join effect) instead of
 * landing on a join prompt with no explanation. Honest limit: the https
 * form only opens the app directly once the server hosts
 * `.well-known/assetlinks.json` for dtchats.app (backend follow-up — see
 * BACKEND-PLAN.md). Until then, tapping the link in another app opens the
 * browser; the pinglo:// form works as soon as the app is installed
 * (Android intent-filter added in this change).
 */
export function buildInviteLink(groupId: string, token?: string | null): string {
  const base = `${INVITE_LINK_BASE}/chat/${encodeURIComponent(groupId)}?type=community`;
  const withToken = token ? `${base}&inv=${encodeURIComponent(token)}` : base;
  return `${withToken}&join=1`;
}

/**
 * Read the group's current invite token, creating one (30-day expiry) if
 * the group has none or its token is expired. Returns null when the stored
 * token was REVOKED (#165): a revoked link must stay visibly dead until an
 * admin explicitly regenerates it — silently minting a fresh token on the
 * next Group Info open used to defeat the revoke. Callers should only call
 * this when showing an invite link (admins in GroupInfoModal, channel
 * copy-link in CommunitiesScreen) — not on every render. Callers must
 * handle a null return (show the Revoked state / refuse to copy a dead link).
 */
export async function getOrCreateInviteToken(groupId: string): Promise<string | null> {
  const group = await readGroup(groupId);
  const now = Date.now();
  // #165: revoked stays revoked — no silent re-mint.
  if (group.inviteTokenRevoked && group.inviteToken) return null;
  const usable =
    group.inviteToken &&
    !group.inviteTokenRevoked &&
    (typeof group.inviteTokenExpiresAt !== 'number' ||
      group.inviteTokenExpiresAt <= 0 ||
      group.inviteTokenExpiresAt > now);
  if (usable) return group.inviteToken as string;
  const token = newInviteToken();
  await updateDoc(doc(db, 'communities', groupId), {
    inviteToken: token,
    inviteTokenExpiresAt: now + INVITE_LINK_TTL_MS,
    inviteTokenRevoked: false,
  });
  return token;
}

/** Admin-only: kill the current invite token. Old links stop working. */
export async function revokeInviteToken(groupId: string): Promise<void> {
  await updateDoc(doc(db, 'communities', groupId), { inviteTokenRevoked: true });
}

/** Admin-only: mint a fresh token (30-day expiry) and un-revoke. */
export async function regenerateInviteToken(groupId: string): Promise<string> {
  const token = newInviteToken();
  await updateDoc(doc(db, 'communities', groupId), {
    inviteToken: token,
    inviteTokenExpiresAt: Date.now() + INVITE_LINK_TTL_MS,
    inviteTokenRevoked: false,
  });
  return token;
}

async function readGroup(groupId: string): Promise<GroupDoc> {
  const snap = await getDoc(doc(db, 'communities', groupId));
  if (!snap.exists()) throw new Error('Group not found');
  return snap.data() as GroupDoc;
}

/** If `admins` would end up empty while members remain, promote the first member. */
function withAdminFallback(members: string[], admins: string[]): string[] {
  if (admins.length > 0 || members.length === 0) return admins;
  return [members[0]];
}

/** Add users to the group. Caller must be an admin (enforced by the UI).
 * Throws GROUP_MEMBER_LIMIT_MESSAGE when the add would take the group
 * over MAX_GROUP_MEMBERS — every add path funnels through here
 * (GroupInfoModal, joinChannel, requestJoinGroup, CommunitiesScreen join),
 * so the limit is enforced in one place. */
export async function addGroupMembers(
  groupId: string,
  userIds: string[],
  actor?: GroupSystemEventActor,
  via?: string,
): Promise<void> {
  const group = await readGroup(groupId);
  const members = getMemberIds(group);
  const next = [...members];
  const added: string[] = [];
  for (const uid of userIds) {
    if (uid && !next.includes(uid)) {
      next.push(uid);
      added.push(uid);
    }
  }
  if (next.length === members.length) return; // nothing new
  if (next.length > MAX_GROUP_MEMBERS) throw new Error(GROUP_MEMBER_LIMIT_MESSAGE);
  await updateDoc(doc(db, 'communities', groupId), {
    members: next,
    memberCount: next.length,
  });
  // F36 (100-more): membership system event per newly-added member, when an
  // actor is given — 'added' (admin adds someone) or 'joined' (the actor
  // adds themself, e.g. the invite-link path via requestJoinGroup). `via` is
  // recorded on joined events ('link'). No actor → no event, so the bulk
  // account-deletion path and legacy callers stay silent. Best-effort: a
  // failed event write never fails the membership change that already landed.
  if (actor?.uid) {
    for (const uid of added) {
      const selfJoin = String(actor.uid) === String(uid);
      await postGroupEvent(
        groupId,
        selfJoin ? 'joined' : 'added',
        { uid: actor.uid, name: actor.name || '' },
        { uid, name: await resolveUserName(uid) },
        selfJoin ? via || '' : undefined,
      );
    }
  }
}

/** Best-effort display name for a uid (users doc; '' when unknown). Never throws. */
async function resolveUserName(uid: string): Promise<string> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return '';
    const d: any = snap.data() || {};
    return (typeof d.displayName === 'string' && d.displayName) || (typeof d.username === 'string' && d.username) || '';
  } catch {
    return '';
  }
}

/** Remove one member. Also strips their admin role if they had one. */
export async function removeGroupMember(groupId: string, targetUid: string, actor?: GroupSystemEventActor): Promise<void> {
  const group = await readGroup(groupId);
  const members = getMemberIds(group).filter((uid) => uid !== targetUid);
  const admins = withAdminFallback(
    members,
    getAdminIds(group).filter((uid) => uid !== targetUid),
  );
  await updateDoc(doc(db, 'communities', groupId), {
    members,
    admins,
    memberCount: members.length,
  });
  // F36 (100-more): 'removed' system event when an actor is given.
  if (actor?.uid) {
    await postGroupEvent(groupId, 'removed', { uid: actor.uid, name: actor.name || '' }, { uid: targetUid, name: await resolveUserName(targetUid) });
  }
}

/** Promote a member to admin. The target must already be a member. */
export async function makeGroupAdmin(groupId: string, targetUid: string, actor?: GroupSystemEventActor): Promise<void> {
  const group = await readGroup(groupId);
  if (!getMemberIds(group).includes(targetUid)) {
    throw new Error('User is not a member of this group');
  }
  const admins = getAdminIds(group);
  if (admins.includes(targetUid)) return;
  await updateDoc(doc(db, 'communities', groupId), {
    admins: [...admins, targetUid],
  });
  // F36 (100-more): 'made-admin' system event when an actor is given.
  if (actor?.uid) {
    await postGroupEvent(groupId, 'made-admin', { uid: actor.uid, name: actor.name || '' }, { uid: targetUid, name: await resolveUserName(targetUid) });
  }
}

/**
 * Demote an admin back to a regular member. Refuses to remove the last admin
 * while other members remain (the group would be left admin-less) — use
 * leaveGroup (which auto-promotes) or promote someone else first.
 */
export async function removeGroupAdmin(groupId: string, targetUid: string, actor?: GroupSystemEventActor): Promise<void> {
  const group = await readGroup(groupId);
  const admins = getAdminIds(group).filter((uid) => uid !== targetUid);
  if (admins.length === 0 && getMemberIds(group).length > 1) {
    throw new Error('Cannot remove the last admin. Make someone else an admin first.');
  }
  await updateDoc(doc(db, 'communities', groupId), { admins });
  // F36 (100-more): 'removed-admin' system event when an actor is given.
  if (actor?.uid) {
    await postGroupEvent(groupId, 'removed-admin', { uid: actor.uid, name: actor.name || '' }, { uid: targetUid, name: await resolveUserName(targetUid) });
  }
}

/**
 * Current user leaves the group. If they were the sole admin and members
 * remain, the longest-standing remaining member (first in `members`) is
 * promoted so the group is never left without an admin.
 */
export async function leaveGroup(groupId: string, uid: string, actor?: GroupSystemEventActor): Promise<void> {
  const group = await readGroup(groupId);
  const members = getMemberIds(group).filter((id) => id !== uid);
  const admins = withAdminFallback(
    members,
    getAdminIds(group).filter((id) => id !== uid),
  );
  await updateDoc(doc(db, 'communities', groupId), {
    members,
    admins,
    memberCount: members.length,
  });
  // F36 (100-more): 'left' system event when an actor is given (the leaver
  // themself from the UI). No actor → no event, so bulk account deletion
  // does not spam an event into every group.
  if (actor?.uid) {
    await postGroupEvent(groupId, 'left', { uid: actor.uid, name: actor.name || '' });
  }
}

/* ── Phase 4 — group join approval + group edit ──────────────────────────
 *
 * `requireApproval` (default off) is an admin-only group setting, edited in
 * GroupInfoModal. When ON, joining via an invite link must go through
 * requestJoinGroup() instead of addGroupMembers(): the user is recorded in
 * `joinRequests` on the group doc and an admin approves/declines from
 * GroupInfoModal. When OFF, requestJoinGroup() behaves exactly like
 * addGroupMembers() (instant join) — existing behaviour is unchanged.
 *
 * NOTE (wiring): ChatScreen's handleJoinGroup() and its `?join=1` auto-join
 * effect both go through requestJoinGroup() (approval-aware since the
 * Phase-4 integration), and GroupInfoModal uses it for its own Join button.
 * Every join entry point honours requireApproval.
 *
 * As with all groupAdmin helpers there is no server-side permission check:
 * the UI gates these behind isGroupAdmin; true enforcement needs an
 * AppSync resolver / auth rule (out of scope, same as Phase 1).
 */

/** Pending join requests on a group doc, never null. */
export function getJoinRequests(group: GroupDoc | null | undefined): JoinRequest[] {
  if (!group || !Array.isArray(group.joinRequests)) return [];
  return group.joinRequests.filter((r) => r && typeof r.uid === 'string');
}

export function hasPendingJoinRequest(
  group: GroupDoc | null | undefined,
  uid?: string | null,
): boolean {
  if (!uid) return false;
  return getJoinRequests(group).some((r) => r.uid === uid);
}

/**
 * Join via an invite link, honouring `requireApproval`.
 * Returns 'joined' (added immediately), 'pending' (request recorded, an
 * admin must approve), 'member' (already a member — no-op) or 'requested'
 * (a request is already pending — no duplicate).
 * Callers must already have validated the invite token (validateInviteToken)
 * before calling this — this helper does not check tokens.
 *
 * WA72 C13 — `opts.asAdmin` (admin invite link, `&role=admin`): the
 * inviter is an admin vouching for the joiner, so join-approval is
 * bypassed and the joiner is promoted to admin right after joining (an
 * existing member opening an admin link is promoted too). No actor is
 * passed to makeGroupAdmin: the inviter is not known at join time, and
 * attributing the promotion to the joiner themself would be wrong.
 */
export async function requestJoinGroup(
  groupId: string,
  uid: string,
  displayName?: string,
  opts?: { asAdmin?: boolean },
): Promise<'joined' | 'pending' | 'member' | 'requested'> {
  const group = await readGroup(groupId);
  if (getMemberIds(group).includes(uid)) {
    if (opts?.asAdmin) await makeGroupAdmin(groupId, uid);
    return 'member';
  }
  if (group.requireApproval === true && !opts?.asAdmin) {
    const requests = getJoinRequests(group);
    if (requests.some((r) => r.uid === uid)) return 'requested';
    await updateDoc(doc(db, 'communities', groupId), {
      joinRequests: [...requests, { uid, name: displayName || 'User', at: Date.now() }],
    });
    return 'pending';
  }
  await addGroupMembers(groupId, [uid], { uid, name: displayName || 'User' }, 'link');
  if (opts?.asAdmin) await makeGroupAdmin(groupId, uid);
  return 'joined';
}

/** Admin-only: approve a pending request — removes it and adds the member.
 * Throws GROUP_MEMBER_LIMIT_MESSAGE when the group is already full; the
 * request stays pending so the admin can retry after someone leaves.
 * F36 (100-more): posts an 'added' system event when `actor` is given. */
export async function approveJoinRequest(groupId: string, targetUid: string, actor?: GroupSystemEventActor): Promise<void> {
  const group = await readGroup(groupId);
  const requestName = getJoinRequests(group).find((r) => r.uid === targetUid)?.name || '';
  const requests = getJoinRequests(group).filter((r) => r.uid !== targetUid);
  const members = getMemberIds(group);
  if (!members.includes(targetUid) && members.length >= MAX_GROUP_MEMBERS) {
    throw new Error(GROUP_MEMBER_LIMIT_MESSAGE);
  }
  const next = members.includes(targetUid) ? members : [...members, targetUid];
  await updateDoc(doc(db, 'communities', groupId), {
    joinRequests: requests,
    members: next,
    memberCount: next.length,
  });
  if (actor?.uid && !members.includes(targetUid)) {
    await postGroupEvent(groupId, 'added', { uid: actor.uid, name: actor.name || '' }, { uid: targetUid, name: requestName || (await resolveUserName(targetUid)) });
  }
}

/** Admin-only: decline a pending request — removes it, nobody is added. */
export async function declineJoinRequest(groupId: string, targetUid: string): Promise<void> {
  const group = await readGroup(groupId);
  await updateDoc(doc(db, 'communities', groupId), {
    joinRequests: getJoinRequests(group).filter((r) => r.uid !== targetUid),
  });
}

/** Admin-only: turn join approval on/off. */
export async function setRequireApproval(groupId: string, value: boolean): Promise<void> {
  await updateDoc(doc(db, 'communities', groupId), { requireApproval: value });
}

/** Max group-name length (same cap NewGroupModal uses for display). */
export const MAX_GROUP_NAME_LEN = 60;

/**
 * Admin-only: edit the group name, description, emoji/icon and photo.
 * Throws when the trimmed name is empty. Only the fields passed are
 * written; description/emoji may be cleared by passing ''. photoURL may
 * be cleared by passing '' (falls back to the emoji icon everywhere).
 */
export async function updateGroupDetails(
  groupId: string,
  patch: { name?: string; description?: string; emoji?: string; photoURL?: string },
): Promise<void> {
  const updates: Record<string, any> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('Group name cannot be empty');
    updates.name = name.slice(0, MAX_GROUP_NAME_LEN);
  }
  if (patch.description !== undefined) updates.description = patch.description.trim();
  if (patch.emoji !== undefined) updates.emoji = patch.emoji.trim() || '👥';
  if (patch.photoURL !== undefined) updates.photoURL = patch.photoURL.trim();
  if (Object.keys(updates).length === 0) return;
  await updateDoc(doc(db, 'communities', groupId), updates);
}

/* ── #186 — membership system/event messages ─────────────────────────────
 *
 * WhatsApp shows "X added Y", "X left", "You created this group" as centred
 * grey rows in the chat. Pinglo had no such message type at all, so every
 * roster change was silent. These events are plain `type: 'system'` docs in
 * the same `chats/<groupId>/messages` collection (same addDoc write path as
 * group messages, legacy-stamped by database.ts), rendered as a centred pill
 * by ChatScreen. They are `kept: true` so disappearing-message timers never
 * hide them, and `status: 'seen'` so they never inflate unread badges.
 * Structured fields (kind/actor/target) let the renderer personalise
 * ("You added Priya"); `text` is the pre-rendered fallback for any surface
 * that only reads text (chat-list preview, search).
 *
 * postGroupEvent is best-effort by design: it never throws, so a membership
 * op can never fail because its event row failed to write.
 */

export type GroupSystemEventKind =
  | 'created'
  | 'joined'
  | 'added'
  | 'removed'
  | 'left'
  | 'made-admin'
  | 'removed-admin'
  | 'disappearing-on'
  | 'disappearing-off';

export interface GroupSystemEventActor {
  uid?: string | null;
  name?: string | null;
}

/** Rendered line for a system-event message doc. `myUid` personalises the actor/target to "You"/"you". */
export function systemEventText(msg: any, myUid?: string | null): string {
  if (!msg || typeof msg !== 'object') return '';
  const kind = msg.systemEvent as GroupSystemEventKind | undefined;
  if (!kind) return typeof msg.text === 'string' ? msg.text : '';
  const who = (uid?: string | null, name?: string | null, selfWord?: string) =>
    uid && myUid && String(uid) === String(myUid) ? (selfWord || 'You') : (name || 'Someone');
  const actor = who(msg.actorUid, msg.actorName, 'You');
  const target = who(msg.targetUid, msg.targetName, 'you');
  switch (kind) {
    case 'created': return `${actor} created this group`;
    case 'joined': return msg.via === 'link' ? `${actor} joined via invite link` : `${actor} joined the group`;
    case 'added': return `${actor} added ${target}`;
    case 'removed': return `${actor} removed ${target}`;
    case 'left': return `${actor} left the group`;
    case 'made-admin': return `${actor} made ${target} an admin`;
    case 'removed-admin': return `${actor} removed ${target} as admin`;
    // WA parity (DM audit row 31): disappearing-timer change, rendered
    // per-viewer — "You turned on…" for the actor, "{Name} turned on…"
    // for everyone else.
    case 'disappearing-on': return `${actor} turned on disappearing messages.`;
    case 'disappearing-off': return `${actor} turned off disappearing messages.`;
    default: return typeof msg.text === 'string' ? msg.text : '';
  }
}

export async function postGroupEvent(
  groupId: string,
  kind: GroupSystemEventKind,
  actor: GroupSystemEventActor,
  target?: GroupSystemEventActor,
  via?: string,
): Promise<void> {
  try {
    const eventDoc: any = {
      type: 'system',
      systemEvent: kind,
      actorUid: actor?.uid || '',
      actorName: actor?.name || '',
      targetUid: target?.uid || '',
      targetName: target?.name || '',
      via: via || '',
      text: '',
      senderId: 'system',
      senderName: '',
      timestamp: Date.now(),
      status: 'seen',
      kept: true,
      encryption: 'legacy',
    };
    // Fallback text uses real names (no "You") — the renderer personalises
    // per viewer from the structured fields above.
    eventDoc.text = systemEventText(eventDoc, null);
    await addDoc(collection(db, 'chats', cleanId(groupId), 'messages'), eventDoc);
  } catch (err) {
    console.warn('[groupAdmin] postGroupEvent failed (non-fatal):', err);
  }
}
