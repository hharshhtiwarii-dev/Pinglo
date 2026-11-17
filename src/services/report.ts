/**
 * Report user / spam (Phase 4, Worker C).
 *
 * Real write, no fake network call: reports go to the top-level `reports`
 * collection via the same `addDoc(collection(db, ...))` pattern the app
 * already uses for `feedback` (SettingsScreen) — a top-level collection
 * (not `users/{uid}/reports`) so a report about a user is not stored
 * inside that user's own doc, where they could read/delete it.
 *
 * Honest limits: there is no admin review queue UI and no automated
 * action yet — a report is stored with status `open` for a human/admin
 * to review (AdminDashboardScreen is owned by another area). Reporting
 * does NOT block the user; blocking is a separate action.
 */

import { addDoc, collection, db, serverTimestamp } from '../aws';

export type ReportReason = 'Spam' | 'Harassment' | 'Scam' | 'Other';

export const REPORT_REASONS: ReportReason[] = ['Spam', 'Harassment', 'Scam', 'Other'];

export interface SubmitReportInput {
  reportedUid: string;
  reportedUsername?: string;
  reason: ReportReason;
  details?: string;
}

/** Writes one report doc. Throws on failure — callers must show the error, not a fake success. */
export async function submitReport(input: SubmitReportInput, reporterUid: string, reporterUsername?: string): Promise<string> {
  const reportedUid = (input.reportedUid || '').trim();
  if (!reportedUid) throw new Error('Missing user to report.');
  if (!reporterUid) throw new Error('You must be signed in to report.');
  if (reportedUid === reporterUid) throw new Error('You cannot report yourself.');
  const ref = await addDoc(collection(db, 'reports'), {
    reporterUid,
    reporterUsername: reporterUsername || '',
    reportedUid,
    reportedUsername: input.reportedUsername || '',
    reason: input.reason,
    details: (input.details || '').trim().slice(0, 1000),
    status: 'open',
    createdAt: serverTimestamp(),
  });
  return ref.id;
}
