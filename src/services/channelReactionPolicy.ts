/**
 * Channel reaction policy (nightshift NF-1).
 *
 * WhatsApp channel setting: who may react to channel posts.
 * - 'any'     — any emoji (full picker). Default for channels without
 *               a stored policy, so existing channels behave as before.
 * - 'default' — the 6 default quick reactions only.
 * - 'none'    — reactions disabled in this channel.
 *
 * Stored on the `communities` doc as `reactionPolicy`. Enforcement is
 * client-side UI gating only (same as the other group permissions in
 * groupAdmin.ts — server enforcement is a backend item).
 *
 * Pure functions — first candidates for unit tests when a runner lands.
 */

import { QUICK_REACTIONS } from './reactions';

export type ChannelReactionPolicy = 'any' | 'default' | 'none';

export const CHANNEL_REACTION_POLICIES: {
  value: ChannelReactionPolicy;
  label: string;
  hint: string;
}[] = [
  { value: 'any', label: 'Any emoji', hint: 'Everyone can react with any emoji.' },
  { value: 'default', label: 'Default only', hint: 'Only the 6 default reactions.' },
  { value: 'none', label: 'None', hint: 'Reactions are turned off in this channel.' },
];

export function normalizeChannelReactionPolicy(value: unknown): ChannelReactionPolicy {
  if (value === 'default' || value === 'none' || value === 'any') return value;
  return 'any';
}

/** What the reaction picker may offer under this policy. */
export function reactionPickerMode(policy: ChannelReactionPolicy): 'full' | 'quick' | 'none' {
  if (policy === 'none') return 'none';
  if (policy === 'default') return 'quick';
  return 'full';
}

export function isReactionAllowed(policy: ChannelReactionPolicy, emoji: string): boolean {
  if (policy === 'none') return false;
  if (policy === 'default') return QUICK_REACTIONS.includes(emoji);
  return true;
}
