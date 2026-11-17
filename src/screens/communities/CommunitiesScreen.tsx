import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Users, Search, Plus, X, LogIn, Crown, Megaphone, Link2, Check, ChevronRight, Camera, ImagePlus } from 'lucide-react';
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, auth, db } from '../../aws';
import { uploadGroupPhoto } from '../../aws/storage';
import { addGroupMembers, buildChannelJoinLink, buildInviteLink, formatMemberCount, getAdminIds, getJoinRequests, getOrCreateInviteToken, getSubscriberCount, hasPendingJoinRequest, isChannel, isGroupAdmin, postGroupEvent, requestJoinGroup, MAX_GROUP_NAME_LEN } from '../../components/groupAdmin';
import { fetchMemberProfiles } from '../../services/contacts';
import GroupInfoModal from '../../components/GroupInfoModal';
import { useNavigate } from 'react-router-dom';
import { navigationManager } from '../../services/navigation';
import { useLanguage } from '../../services/language';

const CHANNEL_CATEGORY_KEYWORDS: [string, string[]][] = [
  ['Tech', ['tech', 'code', 'coding', 'ai ', 'developer', 'program', 'software', 'computer', 'android', 'ios']],
  ['News', ['news', 'breaking', 'headline', 'daily news']],
  ['Sports', ['sport', 'football', 'cricket', 'fifa', 'nba', 'score']],
  ['Gaming', ['game', 'gaming', 'esport', 'playstation', 'xbox', 'pubg', 'minecraft']],
  ['Music', ['music', 'song', 'dj', 'playlist', 'singer', 'band']],
  ['Education', ['learn', 'study', 'school', 'exam', 'course', 'tutorial', 'education']],
  ['Business', ['business', 'startup', 'money', 'finance', 'market', 'invest', 'stock', 'crypto']],
  ['Entertainment', ['movie', 'film', 'meme', 'funny', 'comedy', 'celebrity', 'entertainment']],
  ['Lifestyle', ['food', 'health', 'fitness', 'travel', 'fashion', 'lifestyle', 'recipe', 'yoga']],
];

export default function CommunitiesScreen() {
  const { t: tr } = useLanguage();
  const [communities, setCommunities] = useState<any[]>([]);
  const [loadingCommunities, setLoadingCommunities] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCommName, setNewCommName] = useState('');
  const [newCommDesc, setNewCommDesc] = useState('');
  const [newCommEmoji, setNewCommEmoji] = useState('👥');
  const [newIsChannel, setNewIsChannel] = useState(false);
  // M2 (wa-verify-status-5): a photo icon at creation — WA's create flow
  // takes a photo; DT only offered an emoji here (photo was editable later
  // via Group Info). Staged on pick, written by handleCreateCommunity.
  const [newCommPhotoURL, setNewCommPhotoURL] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const createPhotoInputRef = useRef<HTMLInputElement>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [toast, setToast] = useState('');
  const [infoComm, setInfoComm] = useState<any | null>(null);
  // WA audit (d) C5 — admin profiles for the channel profile drawer
  // (GroupInfoModal resolves admin names from `allUsers`). Only the
  // channel's own admin uids are fetched (fetchMemberProfiles), never
  // the whole users collection — the W28 all-users leak stays closed.
  const [infoAdminProfiles, setInfoAdminProfiles] = useState<any[]>([]);
  // WA audit (d) C4 — channel directory: category filter for the
  // explore view ('All' | 'Channels' | 'Communities' | topic).
  const [dirCategory, setDirCategory] = useState('All');

  const currentUser = auth.currentUser;
  const navigate = useNavigate();

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const COMM_EMOJIS = ['👥','🏘️','🎓','💼','⚽','🎮','🎵','🍕','💪','📚','🌍','🏠','🎉','💬','🚀'];

  useEffect(() => {
    const q = query(collection(db, 'communities'), orderBy('timestamp', 'desc'));
    // Note: the app's onSnapshot wrapper takes only (target, callback) — no
    // error callback. Guard the callback body instead, so a bad snapshot
    // still lands on the error state instead of spinning forever (C3).
    return onSnapshot(q, snap => {
      try {
        setCommunities(snap.docs.map(d => ({ id: d.id, ...d.data() })));
        setLoadError(false);
        setLoadingCommunities(false);
      } catch (err) {
        console.error('Failed to load communities:', err);
        setLoadError(true);
        setLoadingCommunities(false);
      }
    });
  }, [reloadTick]);

  // WA audit (d) C5 — when the info sheet opens for a channel, resolve
  // its admins to displayable profiles so the channel profile drawer
  // shows real admin names instead of "User" fallbacks. Groups keep the
  // member list GroupInfoModal already renders from its own props.
  useEffect(() => {
    if (!infoComm?.isChannel || !currentUser) {
      setInfoAdminProfiles([]);
      return;
    }
    let cancelled = false;
    const adminIds = getAdminIds(infoComm);
    if (adminIds.length === 0) {
      setInfoAdminProfiles([]);
      return;
    }
    void fetchMemberProfiles(currentUser.uid, adminIds)
      .then((list) => { if (!cancelled) setInfoAdminProfiles(list); })
      .catch(() => { if (!cancelled) setInfoAdminProfiles([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoComm]);

  useEffect(() => {
    if (showCreateModal) {
      return navigationManager.pushHandler(() => {
        setShowCreateModal(false);
        return true;
      });
    }
  }, [showCreateModal]);

  // Escape closes the create modal / info modal.
  useEffect(() => {
    if (!showCreateModal && !infoComm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowCreateModal(false);
      setInfoComm(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showCreateModal, infoComm]);

  const handleCreateCommunity = async () => {
    if (!newCommName.trim() || !currentUser) return;
    setCreating(true);
    try {
      const docRef = await addDoc(collection(db, 'communities'), {
        name: newCommName.trim(),
        description: newCommDesc.trim(),
        emoji: newCommEmoji,
        creatorId: currentUser.uid,
        creatorName: currentUser.displayName || 'User',
        admins: [currentUser.uid],
        timestamp: serverTimestamp(),
        members: [currentUser.uid],
        memberCount: 1,
        // #189: groups created here must carry isGroup like NewGroupModal's
        // do — without it they are only detectable by the absence of
        // isChannel/readOnly.
        isGroup: true,
        isChannel: newIsChannel,
        readOnly: newIsChannel,
      });
      // F36 (100-more): "X created this group" system event — best-effort,
      // never blocks the create flow.
      await postGroupEvent(docRef.id, 'created', { uid: currentUser.uid, name: currentUser.displayName || currentUser.username || 'User' });
      setShowCreateModal(false);
      setNewCommName(''); setNewCommDesc(''); setNewCommEmoji('👥'); setNewIsChannel(false);
      showToastMsg('Community created ✓');
    } catch { showToastMsg('Failed to create community.'); }
    finally { setCreating(false); }
  };

  // #181: joining from this tab used to call addGroupMembers() directly and
  // bypass join approval entirely. Now it goes through requestJoinGroup(),
  // which honours requireApproval (returns 'pending' instead of joining) —
  // the same gate the chat/group-info entry points already use. A pending
  // request navigates nowhere: the user is not a member yet.
  const joinCommunity = async (commId: string): Promise<boolean> => {
    if (!currentUser) return false;
    try {
      const result = await requestJoinGroup(
        commId,
        currentUser.uid,
        currentUser.displayName || currentUser.username || 'User',
      );
      if (result === 'pending' || result === 'requested') {
        showToastMsg('Join request sent — an admin will approve it ⏳');
        return false;
      }
      return true;
    } catch (err: any) {
      console.error('Failed to join community:', err);
      // Surfaces the group-member-limit message from addGroupMembers
      // instead of hiding it behind a generic error.
      showToastMsg(err?.message || 'Could not join. Try again.');
      return false;
    }
  };

  const copyJoinLink = async (commId: string, isChannelDoc: boolean) => {
    // Tokenised link: mint/reuse the group's invite token so the link can
    // be revoked or expire (GroupInfoModal manages it afterwards).
    let link: string;
    try {
      const token = await getOrCreateInviteToken(commId);
      link = isChannelDoc ? buildChannelJoinLink(commId, token) : buildInviteLink(commId, token);
    } catch {
      link = isChannelDoc ? buildChannelJoinLink(commId) : buildInviteLink(commId);
    }
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLinkId(commId);
      setTimeout(() => setCopiedLinkId(null), 2000);
    } catch {
      showToastMsg('Could not copy link');
    }
  };

  /** Tapping a card: members open the chat; non-members get the info/join sheet. */
  const handleCardTap = (comm: any) => {
    if (isMember(comm)) {
      navigate(`/chat/${comm.id}?type=community`);
    } else {
      setInfoComm(comm);
    }
  };

  const isMember = (comm: any) =>
    (comm.members || []).includes(currentUser?.uid);

  // #188 (client partial) — the Communities tab must not be a public
  // directory of every private group: hide groups I'm not in and haven't
  // asked to join. Public channels stay discoverable by design, and my
  // pending join requests stay visible so I can track them. The data is
  // still enumerable until the server lockdown lands (BACKEND-PHASE Wave 2)
  // — this is a UI mitigation, not a fix; do not claim otherwise.
  const isVisibleCommunity = (comm: any) => {
    if (isMember(comm)) return true;
    if (isChannel(comm)) return true;
    const myUid = currentUser?.uid;
    if (myUid && getJoinRequests(comm).some((r) => r.uid === myUid)) return true;
    return false;
  };

  const filtered = communities.filter(c =>
    isVisibleCommunity(c) &&
    (!searchQ || (c.name || '').toLowerCase().includes(searchQ.toLowerCase()))
  );

  // ── WA audit (d) C4 — channel directory ──────────────────────────────
  // The `communities` collection carries no category field and no
  // server-side recommendations, so the directory is built from what the
  // client has: categories are a keyword heuristic over name +
  // description (labelled as such — not server metadata), "Recommended"
  // is the most-subscribed public channels, and "Similar" (in the info
  // modal) is same-category channels. Discoverability is still limited
  // to public channels + my own groups by design (#188).
  const channelCategory = (ch: any): string => {
    const hay = `${ch?.name || ''} ${ch?.description || ''}`.toLowerCase();
    for (const [cat, words] of CHANNEL_CATEGORY_KEYWORDS) {
      if (words.some(w => hay.includes(w))) return cat;
    }
    return 'General';
  };
  const dirChips = useMemo(() => {
    const topics = new Set<string>();
    for (const c of filtered) if (isChannel(c)) topics.add(channelCategory(c));
    return ['All', 'Channels', 'Communities', ...[...topics].sort()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);
  const dirFiltered = filtered.filter(c => {
    if (dirCategory === 'All') return true;
    if (dirCategory === 'Channels') return !!c.isChannel;
    if (dirCategory === 'Communities') return !c.isChannel;
    return !!c.isChannel && channelCategory(c) === dirCategory;
  });
  const recommendedChannels = useMemo(() => {
    return communities
      .filter(c => isChannel(c))
      .sort((a, b) => getSubscriberCount(b) - getSubscriberCount(a))
      .slice(0, 5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [communities]);
  const showRecommended = !searchQ && dirCategory === 'All' && recommendedChannels.length >= 2;
  // Similar channels for the open info sheet: same topic, most
  // subscribed first, never the channel itself.
  const similarChannels = useMemo(() => {
    if (!infoComm?.isChannel) return [];
    const cat = channelCategory(infoComm);
    return communities
      .filter(c => c.id !== infoComm.id && isChannel(c) && channelCategory(c) === cat)
      .sort((a, b) => getSubscriberCount(b) - getSubscriberCount(a))
      .slice(0, 4);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoComm, communities]);

  return (
    <div className="flex h-full flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary relative">
      {/* Header — WhatsApp green (#075E54) in light mode, dark panel (#111B21) in dark mode */}
      <div className="pt-safe bg-[#075E54] dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-[20px] font-semibold text-white">Communities</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 bg-white/15 text-white rounded-full px-3 py-1.5 text-sm font-medium hover:bg-white/25 transition-all"
            >
              <Plus className="h-4 w-4" /> New
            </button>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-2">
        <div className="flex items-center gap-2 bg-[#F0F2F5] dark:bg-input-dark rounded-full px-4 py-2">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            type="text" value={searchQ} onChange={e => setSearchQ(e.target.value)}
            placeholder={tr('searchCommunities')}
            className="flex-1 bg-transparent text-sm text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-400"
          />
        </div>
      </div>

      {/* WA audit (d) C4 — directory category chips. Topics come from
          the channels actually present; 'Channels' / 'Communities' split
          by kind. */}
      <div className="flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-hide flex-shrink-0" role="group" aria-label="Browse by category">
        {dirChips.map(chip => (
          <button
            key={chip}
            onClick={() => setDirCategory(chip)}
            aria-pressed={dirCategory === chip}
            className={`rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap transition-colors ${
              dirCategory === chip ? 'bg-green-cta text-white shadow-sm' : 'bg-gray-200 dark:bg-input-dark text-gray-600 dark:text-text-secondary'
            }`}
          >
            {chip}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* WA audit (d) C4 — Recommended channels: the most-subscribed
            public channels. Shown only on the unfiltered explore view. */}
        {showRecommended && (
          <div className="px-4 pt-2 pb-1">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-text-secondary mb-2">{tr('recommendedChannels')}</h2>
            <div className="space-y-2">
              {recommendedChannels.map(ch => {
                const member = isMember(ch);
                const requested = !member && hasPendingJoinRequest(ch, currentUser?.uid);
                return (
                  <div
                    key={ch.id}
                    className="flex items-center gap-3 bg-panel-light dark:bg-panel-dark rounded-2xl p-3 shadow-sm border border-gray-100 dark:border-white/5 cursor-pointer hover:border-primary-green/30 transition-all"
                    onClick={() => handleCardTap(ch)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') handleCardTap(ch); }}
                    aria-label={`Recommended channel ${ch.name}, ${formatMemberCount(getSubscriberCount(ch), true)}`}
                  >
                    {ch.photoURL ? (
                      <img src={ch.photoURL} alt="" className="h-12 w-12 rounded-xl object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-12 w-12 rounded-xl bg-[#075E54]/10 dark:bg-[#005C4B]/25 flex items-center justify-center text-2xl flex-shrink-0" aria-hidden="true">
                        {ch.emoji || '📣'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 dark:text-text-primary truncate">{ch.name}</h3>
                      <p className="text-xs text-gray-400 dark:text-text-secondary mt-0.5">
                        {formatMemberCount(getSubscriberCount(ch), true)} · {channelCategory(ch)}
                      </p>
                    </div>
                    {member ? (
                      <span className="text-xs text-primary-green font-medium bg-primary-green/10 px-2 py-1 rounded-full flex-shrink-0">Open</span>
                    ) : requested ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400 font-medium bg-amber-500/10 px-3 py-1.5 rounded-full flex-shrink-0">⏳ Requested</span>
                    ) : (
                      <span className="text-xs text-white font-medium bg-green-cta px-3 py-1.5 rounded-full flex-shrink-0">Follow</span>
                    )}
                  </div>
                );
              })}
            </div>
            <h2 className="text-sm font-semibold text-gray-500 dark:text-text-secondary mt-4 mb-1">{tr('allCommunitiesChannels')}</h2>
          </div>
        )}
        {loadError ? (
          <div className="flex flex-col items-center justify-center px-6 text-center mt-8" role="alert">
            <div className="h-16 w-16 rounded-full bg-danger-red/10 flex items-center justify-center mb-4">
              <Users className="h-8 w-8 text-danger-red" />
            </div>
            <h2 className="text-lg font-semibold mb-2">Couldn&apos;t load communities</h2>
            <p className="text-gray-500 dark:text-text-secondary text-sm mb-6">Check your connection and try again.</p>
            <button
              onClick={() => { setLoadError(false); setLoadingCommunities(true); setReloadTick((t) => t + 1); }}
              className="rounded-full bg-green-cta px-6 py-2.5 font-semibold text-white hover:bg-dark-green transition-colors"
            >
              Retry
            </button>
          </div>
        ) : loadingCommunities ? (
          <div className="px-4 py-2 space-y-3" aria-label="Loading communities">
            {[0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-3 bg-panel-light dark:bg-panel-dark rounded-2xl p-4 animate-pulse">
                <div className="h-14 w-14 rounded-xl bg-gray-200 dark:bg-input-dark" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-2/5 rounded bg-gray-200 dark:bg-input-dark" />
                  <div className="h-3 w-3/5 rounded bg-gray-200 dark:bg-input-dark" />
                </div>
              </div>
            ))}
          </div>
        ) : dirFiltered.length === 0 && !searchQ && dirCategory === 'All' ? (
          /* Empty state */
          <div className="flex flex-col items-center justify-center px-6 text-center mt-8">
            <div className="h-16 w-16 rounded-full bg-primary-green/10 flex items-center justify-center mb-4">
              <Users className="h-8 w-8 text-primary-green" />
            </div>
            <h2 className="text-xl font-bold mb-2">No communities yet</h2>
            <p className="text-gray-500 dark:text-text-secondary text-sm mb-6 leading-relaxed">
              Create a community for your school, neighbourhood, team — anyone! Share updates with everyone at once.
            </p>
            <button
              onClick={() => setShowCreateModal(true)}
              className="w-full rounded-full bg-green-cta py-3 font-semibold text-white hover:bg-dark-green transition-colors"
            >
              Start your community
            </button>
          </div>
        ) : dirFiltered.length === 0 ? (
          <div className="flex flex-col items-center py-16 gap-2 text-gray-400">
            <Search className="h-12 w-12 opacity-20" />
            <p>{searchQ ? `No communities found for "${searchQ}"` : `Nothing in ${dirCategory} yet`}</p>
          </div>
        ) : (
          <div className="px-4 py-2 space-y-3">
            {dirFiltered.map(comm => {
              const member = isMember(comm);
              const isCreator = comm.creatorId === currentUser?.uid;
              // 100M-H28: a pending join request lives in `joinRequests` on
              // the group doc — the card must say so instead of offering
              // "Join" again (re-tapping only re-showed the toast; the
              // server dedups, so this is UX-only, no data bug).
              const requested = !member && hasPendingJoinRequest(comm, currentUser?.uid);
              // M10 (wa-verify-status-5): admins see pending join requests on
              // the card itself instead of having to open Group Info to find
              // them — WA surfaces membership requests in the community home.
              const pendingRequests = isGroupAdmin(comm, currentUser?.uid) ? getJoinRequests(comm).length : 0;
              return (
                <div
                  key={comm.id}
                  className="flex items-center gap-3 bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-white/5 cursor-pointer hover:border-primary-green/30 transition-all"
                  onClick={() => handleCardTap(comm)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') handleCardTap(comm); }}
                  aria-label={`${comm.name}, ${formatMemberCount(getSubscriberCount(comm), !!comm.isChannel)}${member ? '' : requested ? ', join request pending' : ', tap for info and to join'}`}
                >
                  {/* Community icon tile — WhatsApp squircle, green tint.
                      #154/#187: a group photo wins over the emoji tile. */}
                  {comm.photoURL ? (
                    <img src={comm.photoURL} alt="" className="h-14 w-14 rounded-xl object-cover flex-shrink-0" />
                  ) : (
                    <div className="h-14 w-14 rounded-xl bg-[#075E54]/10 dark:bg-[#005C4B]/25 flex items-center justify-center text-3xl flex-shrink-0" aria-hidden="true">
                      {comm.emoji || '👥'}
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h3 className="font-semibold text-gray-900 dark:text-text-primary truncate">{comm.name}</h3>
                      {comm.isChannel && (
                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-primary-green bg-primary-green/10 px-1.5 py-0.5 rounded-full flex-shrink-0">
                          <Megaphone className="h-3 w-3" /> Channel
                        </span>
                      )}
                      {isCreator && <Crown className="h-3.5 w-3.5 text-yellow-400 flex-shrink-0" title="You created this" />}
                    </div>
                    <p className="text-sm text-gray-500 dark:text-text-secondary truncate">{comm.description || 'Community group'}</p>
                    <p className="text-xs text-gray-400 dark:text-text-secondary mt-0.5 flex items-center gap-1">
                      <Users className="h-3 w-3" aria-hidden="true" />
                      {/* #153: "1 member", never "1 members". */}
                      {formatMemberCount(getSubscriberCount(comm), !!comm.isChannel)}
                      {!member && !requested && ' · Tap for info & join'}
                      {requested && ' · Join request pending'}
                      {pendingRequests > 0 && (
                        <span className="text-amber-600 dark:text-amber-400 font-medium"> · ⏳ {pendingRequests} join request{pendingRequests === 1 ? '' : 's'}</span>
                      )}
                    </p>
                  </div>

                  {/* Join / Open button */}
                  <div className="flex-shrink-0 flex items-center gap-1.5">
                    {comm.isChannel && (
                      <button
                        onClick={(e) => { e.stopPropagation(); copyJoinLink(comm.id, true); }}
                        title="Copy public join link"
                        className="p-2 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-input-dark hover:text-primary-green transition-colors"
                      >
                        {copiedLinkId === comm.id ? <Check className="h-4 w-4 text-primary-green" /> : <Link2 className="h-4 w-4" />}
                      </button>
                    )}
                    {member ? (
                      <span className="flex items-center gap-0.5 text-xs text-primary-green font-medium bg-primary-green/10 px-2 py-1 rounded-full">Open <ChevronRight className="h-3.5 w-3.5" /></span>
                    ) : requested ? (
                      <span className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 font-medium bg-amber-500/10 px-3 py-1.5 rounded-full" aria-label="Join request pending">⏳ Requested</span>
                    ) : (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const ok = await joinCommunity(comm.id); if (ok) navigate(`/chat/${comm.id}?type=community`); }}
                        className="flex items-center gap-1 text-xs text-white font-medium bg-green-cta px-3 py-1.5 rounded-full hover:bg-dark-green transition-colors"
                      >
                        {/* WA audit (d) C3 — channels are Followed, not
                            Joined; membership mechanics stay as-is. */}
                        <LogIn className="h-3.5 w-3.5" /> {comm.isChannel ? 'Follow' : 'Join'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Community info / join sheet for non-members (tap a card) */}
      <GroupInfoModal
        isOpen={!!infoComm}
        onClose={() => setInfoComm(null)}
        group={infoComm}
        groupId={infoComm?.id || ''}
        currentUser={currentUser}
        allUsers={infoAdminProfiles}
        onToast={showToastMsg}
        // WA audit (d) C4 — similar channels for the open channel.
        similarChannels={similarChannels}
        onOpenChannel={handleCardTap}
        onJoinGroup={() => {
          if (infoComm) {
            const id = infoComm.id;
            setInfoComm(null);
            navigate(`/chat/${id}?type=community`);
          }
        }}
      />

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* Create Community Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={() => setShowCreateModal(false)}>
          <div className="w-full max-w-lg mx-auto bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold">Create Community</h2>
              <button onClick={() => setShowCreateModal(false)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Emoji picker */}
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2 uppercase tracking-wide">Community icon</p>
              <div className="flex gap-2 flex-wrap">
                {COMM_EMOJIS.map(e => (
                  <button
                    key={e}
                    onClick={() => setNewCommEmoji(e)}
                    className={`text-2xl p-2 rounded-xl transition-all ${newCommEmoji === e ? 'bg-primary-green/20 ring-2 ring-primary-green' : 'bg-gray-100 dark:bg-input-dark hover:bg-gray-200 dark:hover:bg-panel-dark'}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">Community Name *</label>
              <input
                autoFocus
                type="text" value={newCommName} onChange={e => setNewCommName(e.target.value)}
                placeholder="e.g. DT Gaming Club, Society A..."
                maxLength={MAX_GROUP_NAME_LEN}
                className="w-full mt-1 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">Description</label>
              <input
                type="text" value={newCommDesc} onChange={e => setNewCommDesc(e.target.value)}
                placeholder="What is this community for?"
                className="w-full mt-1 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
              />
            </div>

            <button
              type="button"
              onClick={() => setNewIsChannel(v => !v)}
              className={`w-full flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${newIsChannel ? 'border-primary-green bg-primary-green/10' : 'border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-input-dark'}`}
            >
              <span className="mt-0.5 flex-shrink-0 text-primary-green"><Megaphone className="h-5 w-5" /></span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-gray-900 dark:text-text-primary">Public channel (announcement-only)</span>
                <span className="block text-xs text-gray-500 dark:text-text-secondary mt-0.5 leading-relaxed">Only you and admins can send messages. Everyone else joins as a subscriber and can read.</span>
              </span>
              <span className={`mt-0.5 flex-shrink-0 w-10 h-6 rounded-full p-0.5 transition-colors ${newIsChannel ? 'bg-primary-green' : 'bg-gray-300 dark:bg-gray-600'}`}>
                <span className={`block h-5 w-5 rounded-full bg-white shadow transition-transform ${newIsChannel ? 'translate-x-4' : ''}`} />
              </span>
            </button>

            <button
              onClick={handleCreateCommunity}
              disabled={creating || !newCommName.trim()}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-bold hover:bg-dark-green disabled:opacity-40 transition-all"
            >
              {creating ? 'Creating...' : newIsChannel ? `Create channel${newCommName ? `: ${newCommName}` : ''}` : `Create community${newCommName ? `: ${newCommName}` : ''}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
