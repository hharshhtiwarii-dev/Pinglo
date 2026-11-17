import { describe, expect, it } from 'vitest';
import { getCallDateLabel, groupCallsByDate } from './callHistoryGroups';

// Smoke test for the vitest runner (audit #27) + coverage for the
// date-grouping helpers (audit #19). Pure helpers, no app imports.

describe('getCallDateLabel', () => {
  const now = new Date('2026-11-17T10:00:00');

  it('labels same-day calls Today', () => {
    expect(getCallDateLabel(new Date('2026-11-17T09:00:00').getTime(), now)).toBe('Today');
  });

  it('labels yesterday by calendar day, not 24h window', () => {
    // 23:50 yesterday is Yesterday even 20 minutes later.
    expect(getCallDateLabel(new Date('2026-11-16T23:50:00').getTime(), now)).toBe('Yesterday');
  });

  it('labels older dates without a year when this year', () => {
    expect(getCallDateLabel(new Date('2026-11-10T08:00:00').getTime(), now)).toBe('Nov 10');
  });

  it('adds the year for other years', () => {
    expect(getCallDateLabel(new Date('2025-12-25T08:00:00').getTime(), now)).toBe('Dec 25, 2025');
  });

  it('accepts Firestore-style timestamps and missing values', () => {
    expect(
      getCallDateLabel({ toMillis: () => new Date('2026-11-17T08:00:00').getTime() }, now),
    ).toBe('Today');
    expect(getCallDateLabel(undefined, now)).toBe('Older');
  });
});

describe('groupCallsByDate', () => {
  it('groups in display order, one section per date', () => {
    const now = new Date('2026-11-17T10:00:00');
    const calls = [
      { id: 'a', timestamp: new Date('2026-11-17T09:00:00').getTime() },
      { id: 'b', timestamp: new Date('2026-11-16T23:50:00').getTime() },
      { id: 'c', timestamp: new Date('2026-11-16T08:00:00').getTime() },
      { id: 'd', timestamp: new Date('2026-11-10T08:00:00').getTime() },
    ];
    expect(groupCallsByDate(calls, now)).toEqual([
      { label: 'Today', calls: [calls[0]] },
      { label: 'Yesterday', calls: [calls[1], calls[2]] },
      { label: 'Nov 10', calls: [calls[3]] },
    ]);
  });
});
