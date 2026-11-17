/**
 * GroupInfoModal — Feature 1 (Pinglo Phase 1).
 *
 * Group profile / info view for a `communities` group chat, opened from the
 * ChatScreen header (community chats) and its ⋮ menu. Mirrors the layout and
 * conventions of UserProfileModal (bottom sheet on mobile, centred card on
 * desktop, navigationManager back-button handler, Tailwind dark-mode classes).
 *
 * What it does:
 *  - Group profile: emoji avatar, name, description, created-by, member count.
 *  - Copyable invite link: deep link `/chat/<groupId>?type=community`.
 *  - Member list with Creator / Admin badges and per-member admin controls.
 *  - Admin-only: add members (from the user's contacts), remove members,
 *    make / remove admin. Non-admins see a read-only list + a note.
 *  - Leave group for any member (sole admin auto-promotes the next member).
 *
 * TARGET PATH (coordinator copies this file to): src/components/GroupInfoModal.tsx
 * All DB writes go through ./groupAdmin — this file holds no Firestore calls
 * except via those helpers.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Users, Crown, UserPlus, UserMinus, Link2, Copy, Check,
  LogOut, Search, ShieldCheck, ArrowLeft, RefreshCw, ShieldAlert, LogIn,
  Pencil, UserCheck, UserX, Clock, ImagePlus, Bell, BellOff, Calendar,
} from 'lucide-react';
import { navigationManager } from '../services/navigation';
import { doc, db, getDoc, updateDoc } from '../aws';
import { uploadGroupPhoto } from '../aws/storage';
import { cleanId } from '../services/realtimeSync';
import { loadLocalChatPrefs, saveLocalChatPrefs } from '../services/archiveFolders';
import { isMutedPref, mutePrefForDuration, unmutePref } from '../services/chatMute';
import QRCodeModal from './QRCodeModal';
import ChannelProfileDrawer from './ChannelProfileDrawer';
import { formatEventWhen, rsvpCounts, isEventPast } from './groupEvents';
import {
  GroupDoc,
  getAdminIds,
  getMemberIds,
  isGroupAdmin,
  isGroupCreator,
  isChannel,
  getSubscriberCount,
  buildInviteLink,
  buildChannelJoinLink,
  buildAdminInviteLink,
  setChannelMode,
  addGroupMembers,
  removeGroupMember,
  makeGroupAdmin,
  removeGroupAdmin,
  leaveGroup,
  getOrCreateInviteToken,
  revokeInviteToken,
  regenerateInviteToken,
  inviteTokenExpiryLabel,
  getJoinRequests,
  requestJoinGroup,
  approveJoinRequest,
  declineJoinRequest,
  setRequireApproval,
  updateGroupDetails,
  setGroupPermissions,
  setChannelReactionPolicy,
  canEditGroupInfo,
  MAX_GROUP_NAME_LEN,
  MAX_GROUP_MEMBERS,
  GROUP_MEMBER_LIMIT_MESSAGE,
  groupMemberCountLabel,
  formatMemberCount,
  wouldExceedGroupMemberLimit,
} from './groupAdmin';
import { avatarFallback } from '../utils/avatar';
import { canAddMeToGroups } from '../services/presence';
import { CHANNEL_REACTION_POLICIES, normalizeChannelReactionPolicy, type ChannelReactionPolicy } from '../services/channelReactionPolicy';

interface GroupInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Live group doc from ChatScreen (`otherUser`, communities/<chatId>). */
  group: GroupDoc | null;
  groupId: string;
  currentUser: any;
  /** All users except the current user (ChatScreen already loads this as contactsList). */
  allUsers?: any[];
  /** Called after a successful leave so the parent can navigate away. */
  onLeaveGroup?: () => void;
  /** Called after the current user joins (non-member info view). */
  onJoinGroup?: () => void;
  /** WA audit (d) C4 — similar channels for the open channel (same
   * topic, most subscribed first). Only rendered for channels. */
  similarChannels?: any[];
  /** Open another channel from the Similar list (parent swaps the sheet). */
  onOpenChannel?: (comm: any) => void;
  /** Parent toast (ChatScreen's showToastMsg). Falls back to an inline toast. */
  onToast?: (msg: string) => void;
  /** Group event docs (`type: 'event'` messages, newest last) for the Events list. */
  events?: any[];
  /** Host cancels an event from the Events list. */
  onCancelEvent?: (eventId: string) => void;
}

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export default function GroupInfoModal({
  isOpen,
  onClose,
  group,
  groupId,
  currentUser,
  allUsers = [],
  onLeaveGroup,
  onJoinGroup,
  onToast,
  events = [],
  onCancelEvent,
  similarChannels = [],
  onOpenChannel,
}: GroupInfoModalProps) {
  const [search, setSearch] = useState('');
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedAdmin, setCopiedAdmin] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [localToast, setLocalToast] = useState('');
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenRevokedLocal, setTokenRevokedLocal] = useState(false);
  // F42 (100-more): per-group mute. null = not loaded yet. Same pref the
  // chat-list long-press Mute (#192) writes: users/<uid>.chatPrefs[<cleanId
  // (groupId)>].muted — the notification watcher skips muted chats by
  // conversation id, so muting here silences push + in-app notifications.
  const [muted, setMuted] = useState<boolean | null>(null);
  const [muteBusy, setMuteBusy] = useState(false);
  const prefRef = useRef<any>({});
  // Phase 4 — admin group edit + join approval.
  const [showEdit, setShowEdit] = useState(false);
  // Phase 4 (integration): group invite QR — shows the invite link as a QR.
  const [showInviteQR, setShowInviteQR] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editEmoji, setEditEmoji] = useState('');
  // #162 — group photo picked in the edit form (upload on pick, saved with
  // the rest of the edit in handleSaveEdit). '' = no photo / remove photo.
  const [editPhotoURL, setEditPhotoURL] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // #178 — member-list search, separate from the add-members `search` box
  // above so typing in one never filters the other.
  const [memberSearch, setMemberSearch] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [isOpen, onClose]);

  // Escape closes the modal (and any confirm dialog first).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, confirm, onClose]);

  // Reset transient state each time the modal opens.
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setSelectedToAdd([]);
      setBusy(null);
      setCopied(false);
      setConfirm(null);
      setInviteToken(null);
      // F15 (100-more): the revoked flag is doc state, not session state —
      // reset the local override on every open so a revoke by another admin
      // (or a regenerate since this modal last opened) is read fresh from
      // the group doc below instead of going stale.
      setTokenRevokedLocal(false);
      setShowEdit(false);
      setEditName(group?.name || '');
      setEditDesc(group?.description || '');
      setEditEmoji(group?.emoji || '👥');
      setEditPhotoURL(group?.photoURL || '');
      setMemberSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const toast = (msg: string) => {
    if (onToast) onToast(msg);
    else {
      setLocalToast(msg);
      setTimeout(() => setLocalToast(''), 3000);
    }
  };

  const myUid: string | undefined = currentUser?.uid;
  // F36 (100-more): the acting user, passed to the membership helpers so
  // they can post "X added Y" / "X left" system events.
  const meActor = myUid ? { uid: myUid, name: currentUser?.displayName || currentUser?.username || '' } : undefined;
  const memberIds = useMemo(() => getMemberIds(group), [group]);
  const adminIds = useMemo(() => getAdminIds(group), [group]);
  const iAmAdmin = isGroupAdmin(group, myUid);
  const iAmMember = !!myUid && memberIds.includes(myUid);
  const iAmSoleAdmin = iAmAdmin && adminIds.length === 1 && memberIds.length > 1;
  // Phase 4 — pending join requests live on the group doc (ChatScreen keeps
  // `group` live via onSnapshot, so this list updates when requests arrive).
  const joinRequests = useMemo(() => getJoinRequests(group), [group]);
  const myPendingRequest = !!myUid && joinRequests.some(r => r.uid === myUid);
  const requireApproval = group?.requireApproval === true;

  // Tokenised invite link: admins mint (or reuse) the token when the modal
  // opens; non-members/non-admins use the token already on the doc, if any.
  useEffect(() => {
    if (!isOpen || !groupId) return;
    let cancelled = false;
    if (iAmAdmin) {
      setTokenBusy(true);
      getOrCreateInviteToken(groupId)
        .then(t => { if (!cancelled) setInviteToken(t); })
        .catch(() => { if (!cancelled) setInviteToken(group?.inviteToken || null); })
        .finally(() => { if (!cancelled) setTokenBusy(false); });
    } else {
      setInviteToken(group?.inviteToken || null);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, groupId, iAmAdmin]);

  // F42 (100-more): load this group's mute pref when the modal opens.
  useEffect(() => {
    if (!isOpen || !groupId || !myUid) return;
    let cancelled = false;
    setMuted(null);
    const key = cleanId(groupId);
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', myUid));
        const prefs = snap.exists() ? ((snap.data() as any)?.chatPrefs || {}) : {};
        if (!cancelled) {
          prefRef.current = prefs[key] || {};
          // WA parity top-10 #1: expiry-aware — an expired mute reads unmuted.
          setMuted(isMutedPref(prefs[key]));
        }
      } catch {
        // Offline / hybrid local mode: fall back to the on-device prefs,
        // mirroring ChatListScreen's savePref.
        if (!cancelled) {
          const local = loadLocalChatPrefs(myUid);
          prefRef.current = local[key] || {};
          setMuted(isMutedPref(local[key]));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, groupId, myUid]);

  // F42 (100-more): flip this group's mute pref (same write as the
  // chat-list long-press Mute in ChatListScreen.savePref).
  const handleToggleMute = async () => {
    if (!myUid || !groupId || muted === null || muteBusy) return;
    const next = !muted;
    const key = cleanId(groupId);
    // WA parity top-10 #1: muting from here is "Always" (no expiry);
    // unmuting clears the expiry too.
    const nextPref = next ? { ...prefRef.current, ...mutePrefForDuration(null) } : { ...prefRef.current, ...unmutePref() };
    prefRef.current = nextPref;
    setMuted(next);
    setMuteBusy(true);
    try {
      await updateDoc(doc(db, 'users', myUid), { [`chatPrefs.${key}`]: nextPref });
      toast(next ? 'Notifications muted for this group 🔕' : 'Notifications unmuted for this group 🔔');
    } catch {
      try {
        const local = loadLocalChatPrefs(myUid);
        saveLocalChatPrefs(myUid, { ...local, [key]: nextPref });
        toast(next ? 'Notifications muted for this group 🔕 (saved on this device)' : 'Notifications unmuted for this group 🔔 (saved on this device)');
      } catch {
        /* optimistic UI stays; the watcher re-reads the server value later */
      }
    } finally {
      setMuteBusy(false);
    }
  };

  // Resolve a member UID to a displayable profile. Falls back to an
  // initials avatar + "User", the same fallback ChatScreen uses for unknown senders.
  const profileFor = (uid: string) => {
    if (uid === myUid) {
      return {
        uid,
        displayName: currentUser?.displayName || 'You',
        username: currentUser?.username || '',
        photoURL: currentUser?.photoURL || '',
      };
    }
    const u = allUsers.find((x) => (x.uid || x.id) === uid);
    return {
      uid,
      displayName: u?.displayName || u?.username || 'User',
      username: u?.username || '',
      photoURL: u?.photoURL || '',
    };
  };

  const avatarFor = (uid: string, photoURL?: string, name?: string) =>
    photoURL || avatarFallback(name || 'User', uid);

  // Contacts who are not members yet, filtered by the add-member search box.
  const addCandidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allUsers.filter((u) => {
      const uid = u.uid || u.id;
      if (!uid || memberIds.includes(uid)) return false;
      if (!q) return true;
      return (
        (u.displayName || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q)
      );
    });
  }, [allUsers, memberIds, search]);

  // #178 — member list filtered by its own search box (display name or
  // @username). Empty query shows the full list, unchanged.
  const visibleMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return memberIds;
    return memberIds.filter((uid) => {
      const p = profileFor(uid);
      return (
        (p.displayName || '').toLowerCase().includes(q) ||
        (p.username || '').toLowerCase().includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIds, memberSearch, allUsers, myUid, currentUser]);

  const channel = isChannel(group);
  const inviteLink = groupId ? (channel ? buildChannelJoinLink(groupId, inviteToken) : buildInviteLink(groupId, inviteToken)) : '';
  // F15 (100-more): revoked is DOC state, not session state. The old code
  // showed "Revoked" only when the local flag was set in this modal session
  // AND a token was present — after a revoke `inviteToken` is null, so the
  // label never rendered on reopen (and the input showed a dead legacy
  // link with a working Copy button). Derive from the doc flag so a revoke
  // by any admin surfaces on every open, and hide the dead link.
  const isInviteRevoked = tokenRevokedLocal || group?.inviteTokenRevoked === true;
  const inviteLinkShown = isInviteRevoked ? '' : inviteLink;
  const tokenLabel = tokenRevokedLocal
    ? 'Revoked'
    : inviteTokenExpiryLabel(group ? { ...group, inviteToken: inviteToken || group.inviteToken } : null);

  const handleRevokeInvite = async () => {
    if (!groupId) return;
    setTokenBusy(true);
    try {
      await revokeInviteToken(groupId);
      setInviteToken(null);
      setTokenRevokedLocal(true);
      toast('Invite link revoked — old links no longer work');
    } catch (e: any) {
      toast(e?.message || 'Could not revoke the invite link');
    } finally {
      setTokenBusy(false);
    }
  };

  const handleRegenerateInvite = async () => {
    if (!groupId) return;
    setTokenBusy(true);
    try {
      const t = await regenerateInviteToken(groupId);
      setInviteToken(t);
      setTokenRevokedLocal(false);
      toast('New invite link created ✓');
    } catch (e: any) {
      toast(e?.message || 'Could not create a new invite link');
    } finally {
      setTokenBusy(false);
    }
  };

  const handleJoin = async () => {
    if (!groupId || !myUid) return;
    setBusy('join');
    try {
      // Phase 4: honours requireApproval — returns 'pending' instead of
      // joining when approval is on (see groupAdmin.requestJoinGroup).
      const result = await requestJoinGroup(
        groupId,
        myUid,
        currentUser?.displayName || currentUser?.username || 'User',
      );
      if (result === 'pending' || result === 'requested') {
        toast('Join request sent — an admin will approve it ⏳');
        return;
      }
      // WA audit (d) C3 — channels are Followed, not Joined.
      toast(channel ? 'You are now following this channel ✓' : 'You joined the group ✓');
      onJoinGroup?.();
      onClose();
    } catch (e: any) {
      toast(e?.message || 'Could not join the group');
    } finally {
      setBusy(null);
    }
  };

  // #162 — pick a group photo. uploadGroupPhoto validates type/size
  // (image, < 5 MB) and uploads to S3 group-photos/, falling back to a
  // compressed data URL when S3 is unavailable (mirrors the profile-photo
  // helper). The URL is only staged here; it is written by handleSaveEdit.
  const handleGroupPhotoPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please choose an image file.');
      return;
    }
    setPhotoBusy(true);
    try {
      const url = await uploadGroupPhoto(file);
      setEditPhotoURL(url);
    } catch (err: any) {
      toast(err?.message || 'Could not upload group photo.');
    } finally {
      setPhotoBusy(false);
    }
  };

  // Phase 4 — admin group edit (name / description / emoji / photo).
  const handleSaveEdit = async () => {
    if (!groupId) return;
    if (!editName.trim()) {
      toast('Group name cannot be empty');
      return;
    }
    setBusy('edit');
    try {
      await updateGroupDetails(groupId, { name: editName, description: editDesc, emoji: editEmoji, photoURL: editPhotoURL });
      toast('Group updated ✓');
      setShowEdit(false);
    } catch (e: any) {
      toast(e?.message || 'Could not update group');
    } finally {
      setBusy(null);
    }
  };

  const handleToggleApproval = async () => {
    if (!groupId) return;
    setBusy('approval');
    try {
      await setRequireApproval(groupId, !requireApproval);
      toast(!requireApproval
        ? 'Join approval on — new members need an admin to approve them'
        : 'Join approval off — invite links join instantly again');
    } catch (e: any) {
      toast(e?.message || 'Could not change join approval');
    } finally {
      setBusy(null);
    }
  };

  const handleApproveRequest = async (uid: string, name: string) => {
    setBusy(`approve:${uid}`);
    try {
      await approveJoinRequest(groupId, uid, meActor);
      toast(`${name} joined the group ✓`);
    } catch (e: any) {
      toast(e?.message || 'Could not approve request');
    } finally {
      setBusy(null);
    }
  };

  const handleDeclineRequest = async (uid: string, name: string) => {
    setBusy(`decline:${uid}`);
    try {
      await declineJoinRequest(groupId, uid);
      toast(`Declined ${name}'s join request`);
    } catch (e: any) {
      toast(e?.message || 'Could not decline request');
    } finally {
      setBusy(null);
    }
  };

  const copyInviteLink = async () => {
    // F15 (100-more): never copy a revoked (dead legacy) link.
    if (!inviteLinkShown) return;
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(inviteLink);
      ok = true;
    } catch {
      // Android WebViews often refuse the async clipboard API (same fallback
      // as ChatScreen's copyMsg).
      const ta = document.createElement('textarea');
      ta.value = inviteLink;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast('Invite link copied ✓');
    } else {
      toast('Could not copy link');
    }
  };

  // WA72 C13 — admin invite link: same token, `&role=admin` — whoever
  // opens it joins as an admin. Same clipboard fallback as copyInviteLink.
  const copyAdminInviteLink = async () => {
    if (!inviteLinkShown || !groupId) return;
    const adminLink = buildAdminInviteLink(groupId, inviteToken);
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(adminLink);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = adminLink;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) {
      setCopiedAdmin(true);
      setTimeout(() => setCopiedAdmin(false), 2000);
      toast('Admin invite link copied ✓');
    } else {
      toast('Could not copy link');
    }
  };

  const handleAddMembers = async () => {
    if (selectedToAdd.length === 0 || !groupId) return;
    if (wouldExceedGroupMemberLimit(memberIds.length, selectedToAdd.length)) {
      toast(GROUP_MEMBER_LIMIT_MESSAGE);
      return;
    }
    // WA parity (audit e #25): respect each target's groups-privacy
    // setting — "My contacts" means only people in their saved contacts
    // may add them. Client-side only (a hostile client can add directly);
    // the Settings row says so. Skipped people are named, the rest go in.
    const byUid = new Map(allUsers.map((u: any) => [String(u.uid || u.id), u]));
    const allowed: string[] = [];
    const skipped: string[] = [];
    for (const targetUid of selectedToAdd) {
      const target = byUid.get(String(targetUid));
      if (target && !canAddMeToGroups(target, myUid)) {
        skipped.push(target.displayName || target.username || 'Someone');
      } else {
        allowed.push(targetUid);
      }
    }
    if (skipped.length > 0) {
      toast(`${skipped.join(', ')} only allow${skipped.length > 1 ? '' : 's'} contacts to add them to groups — skipped.`);
    }
    if (allowed.length === 0) return;
    if (wouldExceedGroupMemberLimit(memberIds.length, allowed.length)) {
      toast(GROUP_MEMBER_LIMIT_MESSAGE);
      return;
    }
    setBusy('add');
    try {
      await addGroupMembers(groupId, allowed, meActor);
      toast(`Added ${allowed.length} member${allowed.length > 1 ? 's' : ''} ✓`);
      setSelectedToAdd([]);
      setSearch('');
    } catch (e: any) {
      toast(e?.message || 'Could not add members');
    } finally {
      setBusy(null);
    }
  };

  const handleRemoveMember = async (uid: string, name: string) => {
    setConfirm({
      title: `Remove ${name}?`,
      body: `${name} will no longer be a member of this group.`,
      confirmLabel: 'Remove',
      onConfirm: async () => {
        setBusy(`remove:${uid}`);
        try {
          await removeGroupMember(groupId, uid, meActor);
          toast(`${name} removed`);
        } catch (e: any) {
          toast(e?.message || 'Could not remove member');
        } finally {
          setBusy(null);
        }
      },
    });
  };

  const handleToggleAdmin = async (uid: string, name: string, currentlyAdmin: boolean) => {
    if (currentlyAdmin) {
      if (adminIds.length === 1 && memberIds.length > 1) {
        toast('Cannot remove the last admin. Make someone else an admin first.');
        return;
      }
      setConfirm({
        title: `Remove ${name} as admin?`,
        body: 'They will stay a member of the group.',
        confirmLabel: 'Remove admin',
        onConfirm: async () => {
          setBusy(`admin:${uid}`);
          try {
            await removeGroupAdmin(groupId, uid, meActor);
            toast(`${name} is no longer an admin`);
          } catch (e: any) {
            toast(e?.message || 'Could not update admin');
          } finally {
            setBusy(null);
          }
        },
      });
      return;
    }
    setBusy(`admin:${uid}`);
    try {
      await makeGroupAdmin(groupId, uid, meActor);
      toast(`${name} is now an admin 👑`);
    } catch (e: any) {
      toast(e?.message || 'Could not update admin');
    } finally {
      setBusy(null);
    }
  };

  const handleToggleChannel = async () => {
    if (!groupId) return;
    setBusy('channel');
    try {
      await setChannelMode(groupId, !channel);
      toast(!channel ? 'Channel mode on — only admins can post 📢' : 'Converted back to a group — everyone can post');
    } catch (e: any) {
      toast(e?.message || 'Could not change channel mode');
    } finally {
      setBusy(null);
    }
  };

  // F54 (100-more): granular group permissions — #194's setGroupPermissions
  // existed with no UI and no enforcement. Admins pick who can send and who
  // can edit; the doc values drive canSendInGroup (ChatScreen) and
  // canEditGroupInfo (this modal's Edit button).
  const handleSetPermission = async (key: 'sendMessagesBy' | 'editInfoBy', value: 'all' | 'admins') => {
    if (!groupId) return;
    setBusy('perms');
    try {
      await setGroupPermissions(groupId, { [key]: value });
      toast(value === 'admins' ? 'Only admins can now do this' : 'Everyone can now do this');
    } catch (e: any) {
      toast(e?.message || 'Could not change group settings');
    } finally {
      setBusy(null);
    }
  };

  // NF-1 — channel reaction policy (channels only, admins only).
  const handleSetReactionPolicy = async (value: ChannelReactionPolicy) => {
    if (!groupId) return;
    setBusy('reaction-policy');
    try {
      await setChannelReactionPolicy(groupId, value);
      toast(value === 'none' ? 'Reactions are off in this channel' : value === 'default' ? 'Only default reactions in this channel' : 'Any emoji reaction allowed in this channel');
    } catch (e: any) {
      toast(e?.message || 'Could not change reaction policy');
    } finally {
      setBusy(null);
    }
  };

  const handleLeave = async () => {
    if (!myUid) return;
    // WA audit (d) C3 — leaving a channel is Unfollowing it (confirm
    // dialog, like WA's unfollow confirmation). Membership mechanics
    // (leaveGroup) stay as-is.
    const warning = channel
      ? iAmSoleAdmin
        ? 'You are the only admin. Another member will become admin when you unfollow. Unfollow this channel?'
        : 'You will stop receiving updates from this channel. You can follow it again anytime.'
      : iAmSoleAdmin
      ? 'You are the only admin. Another member will become admin when you leave. Leave this group?'
      : memberIds.length <= 1
      ? 'You are the last member. The group will be left empty. Leave this group?'
      : 'Leave this group?';
    setConfirm({
      title: channel ? 'Unfollow this channel?' : 'Leave this group?',
      body: warning,
      confirmLabel: channel ? 'Unfollow' : 'Leave',
      onConfirm: async () => {
        setBusy('leave');
        try {
          await leaveGroup(groupId, myUid, meActor);
          toast(channel ? 'You unfollowed this channel' : 'You left the group');
          onLeaveGroup?.();
          onClose();
        } catch (e: any) {
          toast(e?.message || 'Could not leave group');
        } finally {
          setBusy(null);
        }
      },
    });
  };

  if (!isOpen) return null;

  // #191 — "Created by" date must never silently show today for a legacy
  // doc whose timestamp is not a plain number (server-timestamp object,
  // Firestore Timestamp, ISO string). Parse every known shape; when none
  // parses, return null and the date is omitted instead of faked.
  const parseGroupTimestamp = (ts: any): number | null => {
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (ts instanceof Date && !Number.isNaN(ts.getTime())) return ts.getTime();
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      return Number.isFinite(ms) ? ms : null;
    }
    if (ts && typeof ts === 'object') {
      if (typeof ts.seconds === 'number') return ts.seconds * 1000;
      if (typeof ts._seconds === 'number') return ts._seconds * 1000;
      if (typeof ts.toDate === 'function') {
        try {
          const d = ts.toDate();
          if (d instanceof Date && !Number.isNaN(d.getTime())) return d.getTime();
        } catch { /* not a Timestamp — fall through to null */ }
      }
      if (typeof ts.toMillis === 'function') {
        try {
          const ms = ts.toMillis();
          if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
        } catch { /* not a Timestamp — fall through to null */ }
      }
    }
    return null;
  };

  const groupName = group?.name || 'Group';
  const groupEmoji = group?.emoji || '👥';
  const createdAtMs = group?.timestamp ? parseGroupTimestamp(group.timestamp) : null;
  const createdAt = createdAtMs ? new Date(createdAtMs).toLocaleDateString() : '';

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex flex-col justify-end sm:justify-center items-center animate-fade-in p-0 sm:p-4 select-none">
      <div
        className="w-full sm:max-w-md bg-panel-light dark:bg-panel-dark sm:rounded-3xl rounded-t-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh] border border-gray-200 dark:border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-white/5 flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
              <ArrowLeft className="h-5 w-5 text-gray-700 dark:text-text-primary" />
            </button>
            <h3 className="font-semibold text-base text-gray-900 dark:text-text-primary">{channel ? 'Channel Info' : 'Group Info'}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-6 space-y-6">
          {/* WA audit (d) C5 — channels get the channel-specific profile
              drawer (description, follower count, admin info) instead of
              the generic group profile block retitled "Channel Info". */}
          {channel ? (
            <ChannelProfileDrawer
              group={group}
              admins={adminIds.map((uid) => {
                const p = profileFor(uid);
                return { uid, displayName: p.displayName, username: p.username, photoURL: p.photoURL, isYou: uid === myUid };
              })}
              createdAt={createdAt}
              canEdit={canEditGroupInfo(group, myUid)}
              onEdit={() => {
                setEditName(group?.name || '');
                setEditDesc(group?.description || '');
                setEditEmoji(group?.emoji || '👥');
                setEditPhotoURL(group?.photoURL || '');
                setShowEdit(v => !v);
              }}
            />
          ) : (
          <div className="flex flex-col items-center text-center">
            {group?.photoURL ? (
              <img src={group.photoURL} alt="" className="w-24 h-24 rounded-3xl object-cover shadow-xl ring-4 ring-primary-green/30 mb-3" />
            ) : (
              <div className="w-24 h-24 rounded-3xl bg-gray-100 dark:bg-input-dark flex items-center justify-center text-5xl shadow-xl ring-4 ring-primary-green/30 mb-3">
                {groupEmoji}
              </div>
            )}
            <h2 className="text-xl font-bold text-gray-900 dark:text-text-primary">{groupName}</h2>
            {canEditGroupInfo(group, myUid) && (
              <button
                onClick={() => {
                  setEditName(group?.name || '');
                  setEditDesc(group?.description || '');
                  setEditEmoji(group?.emoji || '👥');
                  setEditPhotoURL(group?.photoURL || '');
                  setShowEdit(v => !v);
                }}
                className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary-green/10 text-primary-green text-xs font-semibold hover:bg-primary-green/20 transition-colors"
                aria-label="Edit group name, description or icon"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit group
              </button>
            )}
            <p className="text-xs text-gray-400 mt-1 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {channel && '📢 Channel · '}{groupMemberCountLabel(getSubscriberCount(group))} {channel ? 'subscribers' : 'members'}
              {adminIds.length > 0 && ` · ${adminIds.length} admin${adminIds.length === 1 ? '' : 's'}`}
            </p>
            {group?.description && (
              <p className="text-sm text-gray-500 dark:text-text-secondary mt-2 leading-relaxed">
                {group.description}
              </p>
            )}
            {(group?.creatorName || createdAt) && (
              <p className="text-[11px] text-gray-400 mt-1.5">
                {group?.creatorName ? `Created by ${group.creatorName}` : ''}
                {group?.creatorName && createdAt ? ' · ' : ''}
                {createdAt}
              </p>
            )}
          </div>
          )}

          {/* Phase 4 — admin group edit form */}
          {iAmAdmin && showEdit && (
            <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-3 border border-gray-200 dark:border-white/5">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                <Pencil className="h-3.5 w-3.5" /> Edit group
              </p>
              {/* #162 — group photo upload. The edit form previously had zero
                  file inputs (emoji text only); the photo is staged on pick
                  and saved with the rest of the edit. */}
              <div className="flex items-center gap-3">
                {editPhotoURL ? (
                  <img src={editPhotoURL} alt="" className="h-12 w-12 rounded-2xl object-cover shadow-inner flex-shrink-0" />
                ) : (
                  <div className="h-12 w-12 rounded-2xl bg-gray-100 dark:bg-input-dark flex items-center justify-center text-2xl shadow-inner flex-shrink-0">
                    {editEmoji || '👥'}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    disabled={photoBusy}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-primary-green/10 text-primary-green text-xs font-semibold hover:bg-primary-green/20 transition-colors disabled:opacity-40"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    {photoBusy ? 'Uploading…' : editPhotoURL ? 'Change photo' : 'Upload photo'}
                  </button>
                  {editPhotoURL && (
                    <button
                      type="button"
                      onClick={() => setEditPhotoURL('')}
                      className="px-3 py-2 rounded-xl bg-danger-red/10 text-danger-red text-xs font-semibold hover:bg-danger-red/20 transition-colors"
                    >
                      Remove photo
                    </button>
                  )}
                </div>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleGroupPhotoPick}
                  aria-label="Group photo"
                />
              </div>
              <label className="block">
                <span className="text-xs text-gray-500 dark:text-text-secondary">Icon (emoji)</span>
                <input
                  value={editEmoji}
                  onChange={e => setEditEmoji(e.target.value)}
                  maxLength={4}
                  aria-label="Group icon emoji"
                  className="mt-1 w-full bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2 text-sm text-gray-900 dark:text-text-primary outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500 dark:text-text-secondary">Name *</span>
                <input
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  maxLength={MAX_GROUP_NAME_LEN}
                  aria-label="Group name"
                  className="mt-1 w-full bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2 text-sm text-gray-900 dark:text-text-primary outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs text-gray-500 dark:text-text-secondary">Description</span>
                <textarea
                  value={editDesc}
                  onChange={e => setEditDesc(e.target.value)}
                  rows={2}
                  aria-label="Group description"
                  className="mt-1 w-full bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2 text-sm text-gray-900 dark:text-text-primary outline-none resize-none"
                />
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowEdit(false)}
                  className="flex-1 py-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEdit}
                  disabled={busy === 'edit' || !editName.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-green-cta hover:bg-dark-green text-white text-sm font-bold transition-all disabled:opacity-40"
                >
                  {busy === 'edit' ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          )}

          {/* F42 (100-more): per-group mute — WhatsApp parity. The chat-list
              long-press Mute (#192) writes this same pref; this is the
              in-group-info control. Members only: non-members get no
              notifications for this group anyway. */}
          {iAmMember && (
            <button
              onClick={handleToggleMute}
              disabled={muted === null || muteBusy}
              className="w-full flex items-center gap-3 rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 border border-gray-200 dark:border-white/5 text-left disabled:opacity-60"
              aria-label={muted ? 'Unmute notifications for this group' : 'Mute notifications for this group'}
            >
              {muted ? <BellOff className="h-5 w-5 text-gray-500 flex-shrink-0" /> : <Bell className="h-5 w-5 text-primary-green flex-shrink-0" />}
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-gray-900 dark:text-text-primary">Mute notifications</span>
                <span className="block text-xs text-gray-500 dark:text-text-secondary">{muted ? 'Muted — you won’t be notified about new messages here' : 'Get notified about new messages in this group'}</span>
              </span>
              <span className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${muted ? 'bg-primary-green' : 'bg-gray-300 dark:bg-white/20'}`}>
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${muted ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </span>
            </button>
          )}

          {/* Invite link */}
          <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-2 border border-gray-200 dark:border-white/5">
            <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5" /> Invite link
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={isInviteRevoked ? 'Invite link revoked — regenerate to create a new one' : tokenBusy && !inviteToken ? 'Generating link…' : inviteLink}
                onFocus={(e) => e.target.select()}
                className="flex-1 min-w-0 bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2 text-xs text-gray-700 dark:text-text-primary outline-none truncate"
                aria-label="Invite link"
              />
              <button
                onClick={copyInviteLink}
                disabled={!inviteLinkShown}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-green-cta text-white text-xs font-semibold hover:bg-dark-green transition-colors flex-shrink-0 disabled:opacity-40"
                aria-label="Copy invite link"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => setShowInviteQR(true)}
                disabled={!inviteLinkShown}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gray-200 dark:bg-white/10 text-gray-700 dark:text-text-primary text-xs font-semibold hover:bg-gray-300 dark:hover:bg-white/20 transition-colors flex-shrink-0 disabled:opacity-40"
                aria-label="Show invite QR code"
              >
                QR
              </button>
            </div>
            <p className="text-[11px] text-gray-400">
              {requireApproval
                ? `Anyone with this link can open this ${channel ? 'channel' : 'group'} and request to join — an admin approves new members.`
                : channel
                  ? 'Anyone with this link can join this channel as a subscriber.'
                  : 'Anyone with this link can open the group and join it themselves — no admin approval needed.'}
            </p>
            {/* F15 (100-more): the label must render whenever there is a label
                to show — the old `inviteToken &&` guard hid "Revoked" exactly
                when it mattered, because a revoked token is null. */}
            {tokenLabel && (
              <p className={`text-[11px] flex items-center gap-1 ${tokenLabel === 'Revoked' || tokenLabel.startsWith('Expired') ? 'text-danger-red' : 'text-gray-500 dark:text-text-secondary'}`}>
                <ShieldAlert className="h-3 w-3" /> {tokenLabel}
              </p>
            )}
            {iAmAdmin && (
              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleRevokeInvite}
                  disabled={tokenBusy || !inviteToken}
                  className="flex-1 py-2 rounded-xl bg-danger-red/10 text-danger-red text-xs font-semibold hover:bg-danger-red/20 transition-colors disabled:opacity-40"
                >
                  Revoke link
                </button>
                <button
                  onClick={handleRegenerateInvite}
                  disabled={tokenBusy}
                  className="flex-1 py-2 rounded-xl bg-primary-green/10 text-primary-green text-xs font-semibold hover:bg-primary-green/20 transition-colors disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  <RefreshCw className="h-3 w-3" /> Regenerate link
                </button>
              </div>
            )}
            {iAmAdmin && (
              <p className="text-[11px] text-gray-400">
                Revoking or regenerating makes every previously shared link stop working — opening one shows “link expired”.
              </p>
            )}
            {iAmAdmin && (
              <button
                onClick={copyAdminInviteLink}
                disabled={!inviteLinkShown}
                className="flex items-center justify-center gap-1.5 w-full py-2 rounded-xl bg-primary-green/10 text-primary-green text-xs font-semibold hover:bg-primary-green/20 transition-colors disabled:opacity-40"
                aria-label="Copy admin invite link"
              >
                <Crown className="h-3.5 w-3.5" />
                {copiedAdmin ? 'Admin link copied ✓' : 'Copy admin invite link'}
              </button>
            )}
            {iAmAdmin && (
              <p className="text-[11px] text-gray-400">
                Anyone opening the admin link joins as an admin — share it only with people you trust to manage this {channel ? 'channel' : 'group'}.
              </p>
            )}
          </div>

          {/* Non-member: join to view messages */}
          {!iAmMember && (
            <div className="rounded-2xl bg-primary-green/10 border border-primary-green/30 p-4 space-y-3 text-center">
              {myPendingRequest ? (
                <>
                  <p className="text-sm font-semibold text-gray-900 dark:text-text-primary flex items-center justify-center gap-1.5">
                    <Clock className="h-4 w-4 text-primary-green" /> Join request pending
                  </p>
                  <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
                    Your request to join this {channel ? 'channel' : 'group'} is waiting for an admin to approve it. You&apos;ll be able to read and send messages once approved.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-gray-900 dark:text-text-primary flex items-center justify-center gap-1.5">
                    <LogIn className="h-4 w-4 text-primary-green" /> {channel ? 'Follow to view messages' : 'Join to view messages'}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
                    You&apos;re not a member of this {channel ? 'channel' : 'group'} yet, so its messages are hidden from you. {channel ? 'Follow to read and send messages.' : 'Join to read and send messages.'}
                    {requireApproval && ' An admin will need to approve your request first.'}
                  </p>
                  <button
                    onClick={handleJoin}
                    disabled={busy === 'join'}
                    className="w-full py-2.5 rounded-xl bg-green-cta hover:bg-dark-green text-white text-sm font-bold transition-all disabled:opacity-40"
                  >
                    {busy === 'join' ? (channel ? 'Following…' : 'Joining…') : requireApproval ? 'Request to join' : channel ? 'Follow channel' : 'Join group'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Channel mode (admins only) */}
          {iAmAdmin && (
            <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-2 border border-gray-200 dark:border-white/5">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
                📢 Announcement-only channel
              </p>
              <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
                {channel
                  ? 'On — only admins can send messages. Subscribers can read.'
                  : 'Off — every member can send messages.'}
              </p>
              <button
                onClick={handleToggleChannel}
                disabled={busy === 'channel'}
                className="w-full py-2.5 rounded-xl bg-green-cta hover:bg-dark-green text-white text-sm font-bold transition-all disabled:opacity-40"
              >
                {busy === 'channel' ? 'Saving...' : channel ? 'Convert back to group' : 'Make announcement-only channel'}
              </button>
            </div>
          )}
          {!iAmAdmin && channel && (
            <p className="text-xs text-center text-gray-400">
              🔇 Only admins can send messages in this channel.
            </p>
          )}

          {/* F54 (100-more): granular group permissions (admins only). */}
          {iAmAdmin && (
            <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-3 border border-gray-200 dark:border-white/5">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
                ⚙️ Group settings
              </p>
              {([
                { key: 'sendMessagesBy', label: 'Who can send messages', value: group?.sendMessagesBy ?? 'all' },
                { key: 'editInfoBy', label: 'Who can edit group info', value: group?.editInfoBy ?? 'all' },
              ] as const).map(row => (
                <div key={row.key} className="space-y-1.5">
                  <p className="text-sm font-medium text-gray-900 dark:text-text-primary">{row.label}</p>
                  <div className="flex rounded-xl bg-gray-100 dark:bg-input-dark p-1 gap-1" role="group" aria-label={row.label}>
                    {(['all', 'admins'] as const).map(opt => (
                      <button
                        key={opt}
                        onClick={() => handleSetPermission(row.key, opt)}
                        disabled={busy === 'perms' || row.value === opt}
                        aria-pressed={row.value === opt}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                          row.value === opt ? 'bg-white dark:bg-panel-dark shadow text-primary-green' : 'text-gray-500 dark:text-text-secondary'
                        }`}
                      >
                        {opt === 'all' ? 'Everyone' : 'Admins only'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* NF-1 — channel reaction policy (channels only). Admins pick;
              everyone else sees the current policy as read-only text. */}
          {channel && iAmAdmin && (
            <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-3 border border-gray-200 dark:border-white/5">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
                Reactions
              </p>
              <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Who can react to channel posts</p>
              <div className="space-y-1.5" role="radiogroup" aria-label="Channel reaction policy">
                {CHANNEL_REACTION_POLICIES.map(opt => {
                  const current = normalizeChannelReactionPolicy(group?.reactionPolicy);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={current === opt.value}
                      disabled={busy === 'reaction-policy' || current === opt.value}
                      onClick={() => handleSetReactionPolicy(opt.value)}
                      className={`w-full flex items-start gap-2 text-left px-3 py-2 rounded-xl text-sm transition-colors disabled:opacity-60 ${
                        current === opt.value ? 'bg-primary-green/10 ring-1 ring-primary-green' : 'bg-gray-100 dark:bg-input-dark hover:bg-gray-200 dark:hover:bg-white/10'
                      }`}
                    >
                      <span className={`mt-0.5 h-4 w-4 rounded-full border-2 flex-shrink-0 ${current === opt.value ? 'border-primary-green bg-primary-green' : 'border-gray-300 dark:border-white/30'}`} />
                      <span>
                        <span className="block font-semibold text-gray-900 dark:text-text-primary">{opt.label}</span>
                        <span className="block text-xs text-gray-500 dark:text-text-secondary">{opt.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {channel && !iAmAdmin && (
            <p className="text-xs text-center text-gray-400">
              Reactions in this channel: {CHANNEL_REACTION_POLICIES.find(o => o.value === normalizeChannelReactionPolicy(group?.reactionPolicy))?.label}
            </p>
          )}
          {!iAmAdmin && group?.sendMessagesBy === 'admins' && (
            <p className="text-xs text-center text-gray-400">
              🔇 Only admins can send messages in this group.
            </p>
          )}

          {/* Phase 4 — join approval (admins only) */}
          {iAmAdmin && (
            <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-2 border border-gray-200 dark:border-white/5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
                    ✅ Approve new members
                  </p>
                  <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed mt-1">
                    {requireApproval
                      ? 'On — people joining via invite link wait for an admin to approve them.'
                      : 'Off — invite links join instantly.'}
                  </p>
                </div>
                <button
                  onClick={handleToggleApproval}
                  disabled={busy === 'approval'}
                  role="switch"
                  aria-checked={requireApproval}
                  aria-label="Require admin approval for new members"
                  className={`relative h-6 w-11 rounded-full transition-colors flex-shrink-0 disabled:opacity-40 ${
                    requireApproval ? 'bg-primary-green' : 'bg-gray-300 dark:bg-input-dark'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                      requireApproval ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {/* Phase 4 — pending join requests (admins only) */}
          {iAmAdmin && joinRequests.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
                Join requests ({joinRequests.length})
              </p>
              <div className="divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden">
                {joinRequests.map(r => {
                  const p = profileFor(r.uid);
                  return (
                    <div key={r.uid} className="flex items-center gap-3 p-2.5">
                      <img
                        src={avatarFor(r.uid, p.photoURL, p.displayName)}
                        alt=""
                        className="h-10 w-10 rounded-full object-cover flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">{r.name || p.displayName}</p>
                        <p className="text-xs text-gray-500">
                          {r.at ? `Requested ${new Date(r.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'Requested recently'}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleApproveRequest(r.uid, r.name || p.displayName)}
                          disabled={busy === `approve:${r.uid}`}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-primary-green/10 text-primary-green text-[11px] font-semibold hover:bg-primary-green/20 transition-colors disabled:opacity-40"
                        >
                          <UserCheck className="h-3.5 w-3.5" /> Approve
                        </button>
                        <button
                          onClick={() => handleDeclineRequest(r.uid, r.name || p.displayName)}
                          disabled={busy === `decline:${r.uid}`}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-danger-red/10 text-danger-red text-[11px] font-semibold hover:bg-danger-red/20 transition-colors disabled:opacity-40"
                        >
                          <UserX className="h-3.5 w-3.5" /> Decline
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Add members (admins only) */}
          {iAmAdmin ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                <UserPlus className="h-3.5 w-3.5" /> Add members
              </p>
              <p className="text-[11px] text-gray-400">
                {groupMemberCountLabel(memberIds.length)} members
                {MAX_GROUP_MEMBERS - memberIds.length <= 0
                  ? ' — group is full'
                  : ` · ${MAX_GROUP_MEMBERS - memberIds.length} spot${MAX_GROUP_MEMBERS - memberIds.length === 1 ? '' : 's'} left`}
              </p>
              <div className="flex items-center gap-2 bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2">
                <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search all users to add..."
                  aria-label="Search all users to add"
                  className="flex-1 bg-transparent text-sm text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-400"
                />
              </div>
              {addCandidates.length === 0 ? (
                <p className="text-xs text-center text-gray-400 py-2">
                  {search.trim() ? 'No matching users' : 'Everyone is already a member'}
                </p>
              ) : (
                <div className="max-h-44 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
                  {addCandidates.map((u) => {
                    const uid = u.uid || u.id;
                    const selected = selectedToAdd.includes(uid);
                    return (
                      <div
                        key={uid}
                        onClick={() =>
                          setSelectedToAdd((prev) => {
                            if (prev.includes(uid)) return prev.filter((id) => id !== uid);
                            if (wouldExceedGroupMemberLimit(memberIds.length, prev.length + 1)) {
                              toast(GROUP_MEMBER_LIMIT_MESSAGE);
                              return prev;
                            }
                            return [...prev, uid];
                          })
                        }
                        className="flex items-center justify-between p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <img
                            src={avatarFor(uid, u.photoURL, u.displayName || u.username)}
                            alt=""
                            className="h-9 w-9 rounded-full object-cover flex-shrink-0"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">
                              {u.displayName || u.username}
                            </p>
                            {u.username && <p className="text-xs text-gray-500 truncate">@{u.username}</p>}
                            {/* 100M-H27: flag people found via the all-users
                                pool who have no prior DM/contact, so the
                                admin knows this is a first contact. */}
                            {u.noPriorDm && <p className="text-[11px] text-amber-600 dark:text-amber-400 truncate">No prior chat — new contact</p>}
                          </div>
                        </div>
                        <div
                          className={`h-5 w-5 rounded-full flex items-center justify-center border transition-all flex-shrink-0 ${
                            selected ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400'
                          }`}
                        >
                          {selected && <Check className="h-3 w-3 stroke-[3]" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedToAdd.length > 0 && (
                <button
                  onClick={handleAddMembers}
                  disabled={busy === 'add'}
                  className="w-full py-2.5 rounded-xl bg-green-cta hover:bg-dark-green text-white text-sm font-bold transition-all disabled:opacity-40"
                >
                  {busy === 'add' ? 'Adding...' : `Add ${selectedToAdd.length} member${selectedToAdd.length > 1 ? 's' : ''} ✓`}
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-center text-gray-400 flex items-center justify-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> Only group admins can add or remove members.
            </p>
          )}

          {/* Events — group events (v1): upcoming first, then past/canceled.
              Host can cancel from here; RSVP happens on the card in chat. */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
              Events ({events.length})
            </p>
            {events.length === 0 ? (
              <p className="text-xs text-center text-gray-400 py-3">No events yet — create one from the attach menu in the group</p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden">
                {[...events]
                  .sort((a, b) => (a.startAt || 0) - (b.startAt || 0))
                  .map((ev) => {
                    const counts = rsvpCounts(ev.rsvps || {});
                    const past = isEventPast(ev.startAt);
                    const canceled = ev.canceled === true;
                    const iAmHost = !!myUid && !!ev.hostUid && ev.hostUid === myUid;
                    return (
                      <div key={ev.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <span className="flex-shrink-0 w-8 h-8 rounded-lg bg-primary-green/15 text-primary-green flex items-center justify-center">
                          <Calendar className="h-4 w-4" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{ev.eventName || 'Event'}</p>
                          <p className="text-[11px] opacity-70">
                            {formatEventWhen(ev.startAt)}
                            {canceled ? ' · Canceled' : past ? ' · Ended' : ''}
                          </p>
                          <p className="text-[11px] opacity-70">
                            {counts.going} going, {counts.maybe} maybe, {counts['not-going']} not going
                          </p>
                        </div>
                        {iAmHost && !canceled && !past && onCancelEvent && (
                          <button
                            type="button"
                            onClick={() => onCancelEvent(ev.id)}
                            className="flex-shrink-0 text-[11px] font-medium text-red-500 hover:underline min-h-[32px] px-1"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Member list — #178: searchable by name / @username. The input
              filters via `visibleMembers`; the count stays the full roster. */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
              Members ({groupMemberCountLabel(memberIds.length)})
            </p>
            {memberIds.length > 1 && (
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                <input
                  type="text"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  placeholder="Search members…"
                  aria-label="Search members"
                  className="w-full pl-9 pr-8 py-2 rounded-xl bg-gray-100 dark:bg-input-dark text-sm text-gray-900 dark:text-text-primary placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-green/40"
                />
                {memberSearch && (
                  <button
                    type="button"
                    onClick={() => setMemberSearch('')}
                    aria-label="Clear member search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-white/10"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
            {memberIds.length === 0 ? (
              <p className="text-xs text-center text-gray-400 py-3">No members yet</p>
            ) : visibleMembers.length === 0 ? (
              <p className="text-xs text-center text-gray-400 py-3">No members match “{memberSearch.trim()}”</p>
            ) : (
              <div className="divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden">
                {visibleMembers.map((uid) => {
                  const p = profileFor(uid);
                  const isCreator = isGroupCreator(group, uid);
                  const isAdmin = adminIds.includes(uid);
                  const isMe = uid === myUid;
                  return (
                    <div key={uid} className="flex items-center gap-3 p-2.5">
                      <img
                        src={avatarFor(uid, p.photoURL, p.displayName)}
                        alt=""
                        className="h-10 w-10 rounded-full object-cover flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">
                          {p.displayName}
                          {isMe && <span className="text-gray-400 font-normal"> (You)</span>}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {p.username ? `@${p.username}` : ''}
                          {isCreator && (
                            <span className="inline-flex items-center gap-0.5 ml-1 text-amber-500 font-semibold">
                              <Crown className="h-3 w-3" /> Creator
                            </span>
                          )}
                          {!isCreator && isAdmin && (
                            <span className="inline-flex items-center gap-0.5 ml-1 text-primary-green font-semibold">
                              <Crown className="h-3 w-3" /> Admin
                            </span>
                          )}
                        </p>
                      </div>
                      {/* Admin controls: never on yourself (no self-demote / self-remove lockout) */}
                      {iAmAdmin && !isMe && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleToggleAdmin(uid, p.displayName, isAdmin)}
                            disabled={busy === `admin:${uid}`}
                            title={isAdmin ? 'Remove admin' : 'Make admin'}
                            className={`px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-colors disabled:opacity-40 ${
                              isAdmin
                                ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20'
                                : 'bg-primary-green/10 text-primary-green hover:bg-primary-green/20'
                            }`}
                          >
                            {isAdmin ? 'Remove admin' : 'Make admin'}
                          </button>
                          <button
                            onClick={() => handleRemoveMember(uid, p.displayName)}
                            disabled={busy === `remove:${uid}`}
                            title={`Remove ${p.displayName} from group`}
                            className="p-1.5 rounded-full text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                          >
                            <UserMinus className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* WA audit (d) C4 — Similar channels: same-topic channels, most
              subscribed first. Only for channels, only when the parent
              passes a non-empty list. */}
          {channel && similarChannels.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider">
                Similar channels
              </p>
              <div className="space-y-1">
                {similarChannels.map((sim: any) => (
                  <div
                    key={sim.id}
                    className="flex items-center gap-3 p-2 rounded-xl cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60"
                    onClick={() => onOpenChannel?.(sim)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') onOpenChannel?.(sim); }}
                    aria-label={`Similar channel ${sim.name}`}
                  >
                    {sim.photoURL ? (
                      <img src={sim.photoURL} alt="" className="h-10 w-10 rounded-xl object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-10 w-10 rounded-xl bg-[#075E54]/10 dark:bg-[#005C4B]/25 flex items-center justify-center text-xl flex-shrink-0" aria-hidden="true">
                        {sim.emoji || '📣'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">{sim.name}</p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary truncate">
                        {formatMemberCount(getSubscriberCount(sim), true)}
                      </p>
                    </div>
                    <span className="text-xs text-primary-green font-medium flex-shrink-0">View</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Leave group */}
          {iAmMember && (
            <div className="pt-2 border-t border-gray-200 dark:border-white/5">
              {iAmSoleAdmin && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 text-center mb-2">
                  You are the only admin — another member will become admin when you leave.
                </p>
              )}
              <button
                onClick={handleLeave}
                disabled={busy === 'leave'}
                className="w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-medium text-sm bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all disabled:opacity-40"
              >
                <LogOut className="h-4 w-4" />
                <span>{busy === 'leave' ? 'Leaving...' : channel ? 'Unfollow channel' : 'Leave Group'}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Inline confirm dialog (replaces window.confirm) */}
      {confirm && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setConfirm(null)} role="dialog" aria-modal="true" aria-label={confirm.title}>
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">{confirm.title}</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">{confirm.body}</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirm(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button
                onClick={() => { const fn = confirm.onConfirm; setConfirm(null); void fn(); }}
                className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all"
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Local toast (only when no parent onToast is provided) */}
      {localToast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {localToast}
        </div>
      )}

      {/* Phase 4 (integration): group invite QR code */}
      <QRCodeModal
        open={showInviteQR}
        onClose={() => setShowInviteQR(false)}
        title="Group invite"
        value={inviteLink}
        subtitle={group?.name || 'Pinglo group'}
      />
    </div>
  );
}
