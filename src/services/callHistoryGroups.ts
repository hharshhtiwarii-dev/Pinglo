/**
 * Call history date grouping (Ponytail audit #19) — pure helpers with no
 * imports, so they are unit-testable without the app's AWS/React graph.
 * Labels use calendar days, not 24-hour windows, so a call at 23:50
 * yesterday is "Yesterday" even 20 minutes later.
 */

export type CallTimestampLike =
  | { toMillis?: () => number }
  | number
  | string
  | Date
  | null
  | undefined;

/** Milliseconds for a Firestore Timestamp, Date, epoch number or string. */
export const callTimestampMs = (ts: CallTimestampLike): number => {
  if (!ts) return 0;
  if (typeof ts === 'object' && 'toMillis' in ts && typeof (ts as { toMillis?: unknown }).toMillis === 'function') {
    return (ts as { toMillis: () => number }).toMillis();
  }
  if (ts instanceof Date) return ts.getTime();
  return Number(ts) || 0;
};

const startOfDayMs = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today" / "Yesterday" / "12 Nov" / "3 Jan 2025" (year only when not this year). */
export const getCallDateLabel = (ts: CallTimestampLike, now: Date = new Date()): string => {
  const ms = callTimestampMs(ts);
  if (!ms) return 'Older';
  const d = new Date(ms);
  const diffDays = Math.round((startOfDayMs(now) - startOfDayMs(d)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
};

/** Groups calls (already in display order) under their date label, in order. */
export const groupCallsByDate = <T extends { timestamp?: CallTimestampLike }>(
  calls: T[],
  now: Date = new Date(),
): { label: string; calls: T[] }[] => {
  const groups: { label: string; calls: T[] }[] = [];
  for (const call of calls) {
    const label = getCallDateLabel(call.timestamp, now);
    const existing = groups.find((g) => g.label === label);
    if (existing) existing.calls.push(call);
    else groups.push({ label, calls: [call] });
  }
  return groups;
};
