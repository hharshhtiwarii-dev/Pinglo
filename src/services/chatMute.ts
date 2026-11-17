/**
 * chatMute — WhatsApp-parity mute model (WA audit §1f #37, top-10 fix #1).
 *
 * WhatsApp stores a mute as an EXPIRY (`muteEndTimestamp`), not a boolean:
 * mute durations are 8 hours / 1 week / Always, and "Always" is no
 * expiration. Pinglo previously stored only `chatPrefs.muted: boolean`
 * (muted forever until manually unmuted).
 *
 * Shape (per chat, inside `users/{uid}.chatPrefs[chatId]`):
 *   { muted: boolean, muteEndTimestamp?: number }
 *   - muteEndTimestamp = epoch ms when the mute lifts; 0 / absent = no
 *     expiry ("Always"). Kept alongside `muted` (not instead of it) so
 *     older clients and the ChatScreen/GroupInfoModal toggles keep working.
 *   - An expired mute reads as UNMUTED everywhere via isMutedPref().
 */
export interface MuteDuration {
  label: string;
  /** Null = Always (no expiry). */
  ms: number | null;
}

export const MUTE_DURATIONS: MuteDuration[] = [
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Always', ms: null },
];

/** True while the mute is live. An expired muteEndTimestamp reads as unmuted. */
export function isMutedPref(pref: any, now: number = Date.now()): boolean {
  if (!pref?.muted) return false;
  const end = pref.muteEndTimestamp;
  if (typeof end !== 'number' || end <= 0) return true; // no expiry ("Always")
  return end > now;
}

/** Pref patch for muting for a duration (null ms = Always). */
export function mutePrefForDuration(ms: number | null): { muted: boolean; muteEndTimestamp: number } {
  return { muted: true, muteEndTimestamp: ms == null ? 0 : Date.now() + ms };
}

/** Pref patch for unmuting. */
export function unmutePref(): { muted: boolean; muteEndTimestamp: number } {
  return { muted: false, muteEndTimestamp: 0 };
}

/** Human label for a live mute ("Muted until Tue 18 Nov, 10:30" / "Muted (Always)"). Null when not muted. */
export function muteUntilLabel(pref: any, now: number = Date.now()): string | null {
  if (!isMutedPref(pref, now)) return null;
  const end = pref?.muteEndTimestamp;
  if (typeof end !== 'number' || end <= 0) return 'Muted (Always)';
  const d = new Date(end);
  return `Muted until ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
