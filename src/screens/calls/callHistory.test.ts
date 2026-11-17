// Tests for dedupCallHistory + isMissedCallFor (see ./callHistory.ts) —
// the pure call-history identity behind the H3 duplicate-call fix and its
// audit follow-ups (exact signalId key, shared missed rule).
//
// NOTE (runner pending): the repo has no test runner yet (no `test` script
// in package.json). These tests are written in Vitest style (the natural
// runner for this Vite repo) so they run as soon as the runner lands. Do
// NOT add the runner here — a sibling worker owns it. The dedup logic
// itself was verified headless via a node/esbuild mock run (see the audit
// report) until then.
//
// The @ts-ignore below is the bridge until that lands: `vitest` is not
// installed yet, so without it `npm run lint` (tsc --noEmit) fails on this
// import. Delete the @ts-ignore line when the runner (and vitest) lands —
// the import itself stays as-is.
// @ts-ignore - vitest not installed yet; runner sibling owns it.
import { describe, it, expect } from 'vitest';
import { dedupCallHistory, isMissedCallFor, isSameCallDoc, CALL_IDENTITY_WINDOW_MS } from './callHistory';

const A = 'user-a';
const B = 'user-b';
const doc = (over: Record<string, unknown>) => ({
  id: 'doc',
  callerId: A,
  receiverId: B,
  type: 'audio',
  status: 'unanswered',
  timestamp: 1_000_000,
  ...over,
});

describe('dedupCallHistory — exact key branch', () => {
  it('merges two docs with the same signalId even far apart in time', () => {
    const rows = dedupCallHistory([
      doc({ id: 'caller-doc', signalId: 'sig-1', timestamp: 1_000_000 }),
      doc({ id: 'callee-doc', signalId: 'sig-1', status: 'missed', timestamp: 1_000_000 + 10 * 60_000 }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('keeps two genuinely distinct rapid redials apart (different signalIds, same 60 s window)', () => {
    const rows = dedupCallHistory([
      doc({ id: 'call-1', signalId: 'sig-1', timestamp: 1_000_000 }),
      doc({ id: 'call-2', signalId: 'sig-2', timestamp: 1_000_000 + 30_000 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['call-1', 'call-2']);
  });

  it('treats callId the same as signalId', () => {
    const rows = dedupCallHistory([
      doc({ id: 'caller-doc', callId: 'sig-9', timestamp: 1_000_000 }),
      doc({ id: 'callee-doc', signalId: 'sig-9', timestamp: 1_000_000 + 5_000 }),
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('dedupCallHistory — time window branch (no exact key)', () => {
  it('merges two key-less docs for the same call within the window', () => {
    const rows = dedupCallHistory([
      doc({ id: 'caller-doc', timestamp: 1_000_000 }),
      doc({ id: 'callee-doc', status: 'missed', timestamp: 1_000_000 + 30_000 }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('keeps two key-less docs apart outside the window', () => {
    const rows = dedupCallHistory([
      doc({ id: 'call-1', timestamp: 1_000_000 }),
      doc({ id: 'call-2', timestamp: 1_000_000 + CALL_IDENTITY_WINDOW_MS + 1 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('still merges a mixed old/new pair (one side predates signalId writes)', () => {
    const rows = dedupCallHistory([
      doc({ id: 'old-doc', timestamp: 1_000_000 }),
      doc({ id: 'new-doc', signalId: 'sig-1', timestamp: 1_000_000 + 10_000 }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('merges two pending docs (serverTimestamp not landed yet, ts 0)', () => {
    const rows = dedupCallHistory([
      doc({ id: 'pending-1', timestamp: 0 }),
      doc({ id: 'pending-2', timestamp: 0 }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('does not merge different types or directions', () => {
    expect(
      dedupCallHistory([
        doc({ id: 'audio-doc', type: 'audio', timestamp: 1_000_000 }),
        doc({ id: 'video-doc', type: 'video', timestamp: 1_000_000 + 5_000 }),
      ]),
    ).toHaveLength(2);
    expect(
      dedupCallHistory([
        doc({ id: 'a-to-b', callerId: A, receiverId: B, timestamp: 1_000_000 }),
        doc({ id: 'b-to-a', callerId: B, receiverId: A, timestamp: 1_000_000 + 5_000 }),
      ]),
    ).toHaveLength(2);
  });
});

describe('dedupCallHistory — preference swap', () => {
  const pair = [
    doc({ id: 'caller-doc', status: 'unanswered', timestamp: 1_000_000 }),
    doc({ id: 'callee-doc', status: 'missed', timestamp: 1_000_000 + 5_000 }),
  ];
  it('receiver view keeps the missed record', () => {
    const rows = dedupCallHistory(pair, B);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('callee-doc');
  });

  it('caller view keeps the non-missed record', () => {
    const rows = dedupCallHistory(pair, A);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('caller-doc');
  });
});

describe('isSameCallDoc — twin-delete identity (WA-verify-calls-4 row 55)', () => {
  it('matches twin docs sharing a signalId', () => {
    expect(isSameCallDoc(
      doc({ id: 'caller-doc', signalId: 'sig-1', status: 'declined' }),
      doc({ id: 'callee-doc', signalId: 'sig-1', status: 'declined' }),
    )).toBe(true);
  });

  it('matches a doc with itself', () => {
    const d = doc({ id: 'only-doc' });
    expect(isSameCallDoc(d, d)).toBe(true);
  });

  it('keeps distinct rapid redials apart (different signalIds)', () => {
    expect(isSameCallDoc(
      doc({ id: 'call-1', signalId: 'sig-1', timestamp: 1_000_000 }),
      doc({ id: 'call-2', signalId: 'sig-2', timestamp: 1_000_000 + 30_000 }),
    )).toBe(false);
  });

  it('matches key-less twins inside the window, not outside it', () => {
    expect(isSameCallDoc(
      doc({ id: 'a', timestamp: 1_000_000 }),
      doc({ id: 'b', timestamp: 1_000_000 + 30_000 }),
    )).toBe(true);
    expect(isSameCallDoc(
      doc({ id: 'a', timestamp: 1_000_000 }),
      doc({ id: 'b', timestamp: 1_000_000 + CALL_IDENTITY_WINDOW_MS + 1 }),
    )).toBe(false);
  });
});

describe('isMissedCallFor — the one shared missed rule', () => {
  it('missed is missed for everyone', () => {
    expect(isMissedCallFor(doc({ status: 'missed' }), A)).toBe(true);
    expect(isMissedCallFor(doc({ status: 'missed' }), B)).toBe(true);
  });

  it('declined/busy count as missed only for the receiver', () => {
    expect(isMissedCallFor(doc({ status: 'declined' }), B)).toBe(true);
    expect(isMissedCallFor(doc({ status: 'declined' }), A)).toBe(false);
    expect(isMissedCallFor(doc({ status: 'busy' }), B)).toBe(true);
    expect(isMissedCallFor(doc({ status: 'busy' }), A)).toBe(false);
  });

  it('completed/unanswered are never missed', () => {
    expect(isMissedCallFor(doc({ status: 'completed' }), B)).toBe(false);
    expect(isMissedCallFor(doc({ status: 'unanswered' }), B)).toBe(false);
  });
});

// WA-verify-calls-4 (rows 56/57): the Calls-tab badge must count deduped
// CALLS through the shared missed rule, not raw docs. An unanswered ring
// is two docs — caller 'unanswered' + callee 'missed' — and the callee's
// 'missed' doc lands in the CALLER's snapshot too (its callerId is the
// caller), so counting raw docs showed a badge of 1 for the caller.
// After dedup the caller keeps the 'unanswered' doc (0 missed) and the
// callee keeps the 'missed' doc (1 missed).
describe('missed badge view — dedup + shared missed rule', () => {
  const pair = [
    doc({ id: 'caller-doc', status: 'unanswered', timestamp: 1_000_000 }),
    doc({ id: 'callee-doc', status: 'missed', timestamp: 1_000_000 + 5_000 }),
  ];
  const missedAfterDedup = (viewer: string) =>
    dedupCallHistory(pair, viewer).filter((c) => isMissedCallFor(c, viewer)).length;

  it('caller of an unanswered ring sees no missed call', () => {
    expect(missedAfterDedup(A)).toBe(0);
  });

  it('callee of the same ring sees exactly one missed call', () => {
    expect(missedAfterDedup(B)).toBe(1);
  });
});
