/**
 * PollResultsSheet — WA audit (d) C8: channel poll results + voter list
 * (WA: WAWebNewsletterPollVotes / WAWebNewsletterPollVotersCache).
 *
 * PollCard already shows live percentages and a per-option "Voted by"
 * inline list; this sheet is the full results view: total votes, one
 * section per option (bar, %, count) with every voter named, the current
 * user's own vote marked. It reuses PollCard's normalisers so legacy
 * single-number votes and new multi-answer votes render identically.
 * Rendered by ChatScreen when a poll's "View results" is tapped — in a
 * channel that is the only place a poll's voters are listed in full.
 */
import { X } from 'lucide-react';
import {
  countVotesForOption,
  normalizePollVotes,
  totalSelections,
  totalVoters,
  votersForOption,
  type PollData,
} from './PollCard';

export interface PollResultsSheetProps {
  poll: PollData;
  /** uid -> display name ("You" is derived from currentUserId). */
  voterNames?: Record<string, string>;
  currentUserId?: string | null;
  onClose: () => void;
}

export default function PollResultsSheet({
  poll,
  voterNames,
  currentUserId,
  onClose,
}: PollResultsSheetProps) {
  const options = poll.options || [];
  const normalized = normalizePollVotes(poll.votes, options.length);
  const voters = totalVoters(normalized);
  const selections = totalSelections(normalized);
  const multi = poll.multiAnswer === true;

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/60 flex items-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Poll results: ${poll.question}`}
    >
      <div
        className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold">📊 Poll results</h3>
            <p className="font-semibold text-sm mt-1 break-words">{poll.question}</p>
            <p className="text-xs opacity-60 mt-1">
              {voters} {voters === 1 ? 'vote' : 'votes'}
              {multi && selections !== voters ? ` · ${selections} selections` : ''}
              {multi ? ' · Multiple answers allowed' : ' · Choose one'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close poll results"
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark flex-shrink-0"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {voters === 0 ? (
          <p className="text-sm text-gray-500 dark:text-text-secondary">
            No votes yet — be the first to vote.
          </p>
        ) : (
          <div className="space-y-4">
            {options.map((opt, optIdx) => {
              const optVotes = countVotesForOption(normalized, optIdx);
              const percentage =
                voters > 0 ? Math.round((optVotes / voters) * 100) : 0;
              const names = votersForOption(normalized, optIdx, voterNames);
              return (
                <div key={optIdx}>
                  <div className="flex justify-between items-center gap-2 text-sm">
                    <span className="font-medium truncate">{opt}</span>
                    <span className="opacity-75 font-mono flex-shrink-0 text-xs">
                      {percentage}% ({optVotes})
                    </span>
                  </div>
                  <div
                    className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden mt-1"
                    role="progressbar"
                    aria-valuenow={percentage}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${opt}: ${percentage} percent`}
                  >
                    <div
                      className="h-full bg-primary-green rounded-full transition-all"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                  {names.length > 0 ? (
                    <ul className="text-xs opacity-70 mt-1.5 space-y-0.5 list-none">
                      {names.map(({ uid, name }) => (
                        <li key={uid} className="truncate">
                          {uid === currentUserId ? 'You' : name}
                          {uid === currentUserId && name && name !== 'You'
                            ? ` (${name})`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs opacity-50 mt-1">No votes for this option yet.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
