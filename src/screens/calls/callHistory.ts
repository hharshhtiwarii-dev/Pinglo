/**
 * Call-history identity + dedup (100M-H3 + audit follow-ups). Pure module —
 * no React, no AWS imports — so the unit test (callHistory.test.ts) imports
 * it directly and the screen stays a thin view over it.
 *
 * Every call is written twice: the caller writes its own `calls` doc
 * (startCall / endCall in callService.ts) and the callee writes a second
 * one (`recordCalleeCall`) for the same call. Since the audit H3-1 fix both
 * docs store the signal doc id as `signalId` at write time, so the two
 * docs share an exact key. The 60 s time window below is only a fallback
 * for docs written before that landed (or any doc that still lacks the
 * key): same pair, same type, timestamps within the window.
 *
 * Render-layer dedup only — the second write is NOT stopped (the data
 * model is untouched): each side still owns a doc it can read/delete.
 *
 * When two docs are the same call, keep the one that matches the viewer's
 * perspective: the receiver keeps the missed/declined/busy record (their
 * Missed badge depends on it), the caller keeps the non-missed record (a
 * caller-cancelled ring is 'unanswered', never Missed, per REPORT-3
 * #243). Ties keep the earlier doc (stable anchor).
 */
export const CALL_IDENTITY_WINDOW_MS = 60_000;

export const callDocTs = (c: any): number =>
  c.timestamp?.toMillis ? c.timestamp.toMillis() : Number(c.timestamp) || 0;

/**
 * The one shared "missed" rule (audit H3-2). It used to live in two
 * places — `isMissedFor` here (dedup preference) vs `isMissedCall` in
 * CallsScreen (badge/filter) — and REPORT-3 #243 already changed this
 * rule once, so the next change had to land in both copies or the dedup
 * preference and the badge would disagree. Now there is one helper:
 * `missed`, or `declined`/`busy` for the receiver (an outgoing declined
 * call is never Missed for its caller).
 */
export const isMissedCallFor = (c: any, viewerUid?: string): boolean =>
  c.status === 'missed' ||
  ((c.status === 'declined' || c.status === 'busy') && c.receiverId === viewerUid);

/**
 * WA-verify-calls-4 (row 55): are two raw `calls` docs the SAME call?
 * The exact rule `dedupCallHistory` uses, as a predicate — so a delete
 * can remove the hidden twin doc too. Same signalId/callId key wins;
 * otherwise same pair + same type within the 60 s window (docs that
 * predate signalId writes). Two docs with different exact keys are
 * genuinely distinct calls (rapid redial), even inside the window.
 */
export const isSameCallDoc = (a: any, b: any): boolean => {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  const sigA = a.signalId || a.callId;
  const sigB = b.signalId || b.callId;
  if (sigA && sigB) return sigA === sigB;
  if (sigA || sigB) return false;
  return (
    a.callerId === b.callerId &&
    a.receiverId === b.receiverId &&
    (a.type || 'audio') === (b.type || 'audio') &&
    Math.abs(callDocTs(a) - callDocTs(b)) <= CALL_IDENTITY_WINDOW_MS
  );
};

export function dedupCallHistory(docs: any[], viewerUid?: string): any[] {
  const sorted = [...docs].sort((a, b) => callDocTs(a) - callDocTs(b));
  const kept: any[] = [];
  for (const callDoc of sorted) {
    const sig = callDoc.signalId || callDoc.callId;
    let dupOf: any = sig
      ? kept.find((k) => (k.signalId || k.callId) && (k.signalId || k.callId) === sig)
      : undefined;
    if (!dupOf) {
      dupOf = kept.find((k) => {
        const kSig = k.signalId || k.callId;
        // Audit H3-1: both docs carry an exact call key and they differ —
        // genuinely distinct calls (rapid redial), even inside the time
        // window. Merge on the time window only when at least one side
        // predates signalId writes and has no exact key to compare.
        if (sig && kSig) return false;
        return (
          k.callerId === callDoc.callerId &&
          k.receiverId === callDoc.receiverId &&
          (k.type || 'audio') === (callDoc.type || 'audio') &&
          Math.abs(callDocTs(k) - callDocTs(callDoc)) <= CALL_IDENTITY_WINDOW_MS
        );
      });
    }
    if (!dupOf) {
      kept.push(callDoc);
      continue;
    }
    const preferMissed = callDoc.receiverId === viewerUid;
    const dupMissed = isMissedCallFor(dupOf, viewerUid);
    const docMissed = isMissedCallFor(callDoc, viewerUid);
    if (preferMissed ? !dupMissed && docMissed : dupMissed && !docMissed) {
      kept[kept.indexOf(dupOf)] = callDoc;
    }
    // Otherwise keep the earlier doc.
  }
  return kept;
}
