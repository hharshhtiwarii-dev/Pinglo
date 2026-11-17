/**
 * ChannelProfileDrawer — WA audit (d) C5: the channel-specific profile
 * header / drawer (WA: WAWebNewsletterAdminProfileDetailsDrawer +
 * WAWebNewsletterConversationPanelHeader).
 *
 * The generic GroupInfoModal profile block (photo, name, member count)
 * is a group view retitled "Channel Info". A channel page instead shows:
 * description, follower (subscriber) count, whether it is
 * announcement-only, who created it, and the admin list — the info a
 * follower needs before deciding to follow, without group affordances
 * (no member list, no add-members).
 *
 * VERIFIED BADGE: the badge renders only when the channel doc carries
 * `verified: true`. No channel in DT carries verification data today —
 * nothing ever writes a `verified` field — so the badge never renders
 * yet. It is data-driven, not a gate on the drawer: the drawer itself
 * is always available. Do NOT hard-code a badge on any channel.
 */
import { BadgeCheck, Crown, Megaphone, Users } from 'lucide-react';
import type { GroupDoc } from './groupAdmin';
import { getSubscriberCount } from './groupAdmin';
import { avatarFallback } from '../utils/avatar';

export interface ChannelAdminProfile {
  uid: string;
  displayName: string;
  username?: string;
  photoURL?: string;
  isYou?: boolean;
}

export interface ChannelProfileDrawerProps {
  /** Live channel doc (communities/<id>). */
  group: GroupDoc | null;
  /** Resolved admin profiles (name + photo). Uids with no resolvable
   * profile render as "User" — the caller should resolve via
   * fetchMemberProfiles / allUsers so real names show. */
  admins: ChannelAdminProfile[];
  /** Formatted creation date, e.g. "17/11/2026". */
  createdAt?: string;
  /** True when the viewer may edit the channel name/description/icon. */
  canEdit: boolean;
  /** Opens the edit form (owned by GroupInfoModal). */
  onEdit: () => void;
}

export default function ChannelProfileDrawer({
  group,
  admins,
  createdAt,
  canEdit,
  onEdit,
}: ChannelProfileDrawerProps) {
  const name = group?.name || 'Channel';
  const emoji = group?.emoji || '📣';
  const description = (group?.description || '').trim();
  // Verified badge — data-driven only (see header comment). No verified
  // channels exist in DT, so this is false for every channel today.
  const verified = (group as any)?.verified === true;
  const subscriberCount = getSubscriberCount(group);

  return (
    <div className="space-y-5" aria-label={`Channel profile for ${name}`}>
      {/* Identity: photo / emoji tile, name + verified badge, channel pill. */}
      <div className="flex flex-col items-center text-center">
        {group?.photoURL ? (
          <img
            src={group.photoURL}
            alt=""
            className="w-24 h-24 rounded-3xl object-cover shadow-xl ring-4 ring-primary-green/30 mb-3"
          />
        ) : (
          <div
            className="w-24 h-24 rounded-3xl bg-gray-100 dark:bg-input-dark flex items-center justify-center text-5xl shadow-xl ring-4 ring-primary-green/30 mb-3"
            aria-hidden="true"
          >
            {emoji}
          </div>
        )}
        <h2 className="text-xl font-bold text-gray-900 dark:text-text-primary flex items-center gap-1.5">
          <span className="truncate">{name}</span>
          {verified && (
            <BadgeCheck
              className="h-5 w-5 text-sky-500 flex-shrink-0"
              aria-label="Verified channel"
              title="Verified channel"
            />
          )}
        </h2>
        <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-primary-green bg-primary-green/10 px-2.5 py-1 rounded-full">
          <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
          Channel · Announcement-only
        </p>
        <p className="text-xs text-gray-400 mt-2 flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          {subscriberCount} {subscriberCount === 1 ? 'follower' : 'followers'}
          {admins.length > 0 &&
            ` · ${admins.length} admin${admins.length === 1 ? '' : 's'}`}
        </p>
        {canEdit && (
          <button
            onClick={onEdit}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary-green/10 text-primary-green text-xs font-semibold hover:bg-primary-green/20 transition-colors"
            aria-label="Edit channel name, description or icon"
          >
            Edit channel
          </button>
        )}
      </div>

      {/* Description — the channel's own words (WA drawer leads with it). */}
      <div>
        <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider mb-1.5">
          About this channel
        </p>
        {description ? (
          <p className="text-sm text-gray-700 dark:text-text-primary leading-relaxed">
            {description}
          </p>
        ) : (
          <p className="text-sm text-gray-400 dark:text-text-secondary italic">
            No description yet.
          </p>
        )}
        {(group?.creatorName || createdAt) && (
          <p className="text-[11px] text-gray-400 mt-1.5">
            {group?.creatorName ? `Created by ${group.creatorName}` : ''}
            {group?.creatorName && createdAt ? ' · ' : ''}
            {createdAt}
          </p>
        )}
        <p className="text-[11px] text-gray-400 mt-1">
          Only admins can send messages in this channel. Followers can read.
        </p>
      </div>

      {/* Admins — who runs the channel (WA admin info). */}
      <div>
        <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wider mb-2">
          Channel admins ({admins.length})
        </p>
        {admins.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-text-secondary">
            No admins listed.
          </p>
        ) : (
          <ul className="space-y-2">
            {admins.map((a) => (
              <li key={a.uid} className="flex items-center gap-3">
                <img
                  src={a.photoURL || avatarFallback(a.displayName || 'User', a.uid)}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">
                    {a.displayName}
                    {a.isYou ? ' (You)' : ''}
                  </p>
                  {a.username && (
                    <p className="text-xs text-gray-500 truncate">@{a.username}</p>
                  )}
                </div>
                <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full flex-shrink-0">
                  <Crown className="h-3 w-3" aria-hidden="true" /> Admin
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
