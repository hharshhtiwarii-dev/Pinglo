/**
 * PollCard — WhatsApp-style poll renderer with multi-answer voting.
 *
 * M3 (Messaging Group): gap-list PARTIAL #22 "Polls — single-vote, max 6
 * options; multiple-answer/quiz/anonymous poll nahi hai" ka multi-answer
 * hissa. Ye component sirf render + vote-selection karta hai; vote ko
 * server/database me likhna caller ka kaam hai (ChatScreen ka `votePoll`
 * jaisa handler `onVote` me diya jata hai).
 *
 * BACKWARD COMPATIBILITY (existing data format):
 * - Legacy single-answer votes: `pollVotes: Record<uid, optIdx>` (number).
 * - New multi-answer votes: `pollVotes: Record<uid, optIdx[]>` (number[]).
 * - `normalizePollVotes()` dono ko `Record<uid, number[]>` me badal deta
 *   hai, isliye purane polls bina migration ke yahi render hote hain.
 * - Naye fields optional hain: `multiAnswer?: boolean`,
 *   `maxChoices?: number`. Inke bina poll purana single-vote poll hi hai.
 *
 * Usage (ChatScreen me poll render ki jagah, ChatScreen.tsx ~line 2359):
 *   <PollCard
 *     poll={{
 *       question: msg.pollQuestion,
 *       options: msg.pollOptions || [],
 *       votes: msg.pollVotes || {},
 *       multiAnswer: msg.pollMultiAnswer === true,
 *       maxChoices: msg.pollMaxChoices ?? undefined,
 *     }}
 *     currentUserId={currentUser?.uid}
 *     voterNames={userNameByUid} // optional: uid -> display name
 *     onVote={(selection) => votePoll(msg.id, selection)}
 *   />
 * NOTE: `onVote` ko hamesha poori selection (number[]) milti hai, single
 * vote ke liye bhi (1-element array). Caller ko `pollVotes.<uid>` field ko
 * usi array se overwrite karna hai — legacy single number likhne se naye
 * multi-answer vote ka data kho jayega.
 */

export type PollVoteValue = number | number[];
export type PollVotes = Record<string, PollVoteValue>;

export interface PollData {
  /** Poll ka sawal. */
  question: string;
  /** Options (2–12). */
  options: string[];
  /**
   * Votes: legacy `Record<uid, optIdx>` ya naya `Record<uid, optIdx[]>`.
   * Mixed bhi ho sakta hai (purana user single number, naya user array).
   */
  votes?: PollVotes | null;
  /** true = ek voter kai options chun sakta hai. Default false (single). */
  multiAnswer?: boolean;
  /**
   * Multi-answer me ek voter kitne options chun sakta hai.
   * Default: options ki ginti (koi cap nahi). Single-answer me hamesha 1.
   */
  maxChoices?: number;
}

export interface PollCardProps {
  poll: PollData;
  /** Vote karne wala user (null = signed-in nahi / sirf dekh raha hai). */
  currentUserId?: string | null;
  /** Optional: voter uid -> display name ("voted by" list ke liye). */
  voterNames?: Record<string, string>;
  /**
   * Vote badalne par call hota hai — argument hamesha voter ki POORI
   * selection hoti hai (multi: 0..maxChoices indices, single: 0..1 index).
   * Empty array = vote wapas lena (remove vote).
   */
  onVote?: (selection: number[]) => void | Promise<void>;
  /** false (default) = vote badla ja sakta hai; true = pehla vote final. */
  disableChange?: boolean;
  /** Vote karna band (e.g. poll band ho gaya ho). Default false. */
  disabled?: boolean;
  /** Max-choices cap chhoone par dikhane ke liye (optional toast). */
  onLimitReached?: (maxChoices: number) => void;
  /**
   * WA audit (d) C8 — full results view. When provided, the "N votes"
   * footer becomes a button opening the PollResultsSheet (per-option
   * voter lists). Without it the inline "Voted by" lists are the only
   * voter view (e.g. DMs keep the old inline-only behaviour).
   */
  onViewResults?: () => void;
}

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 12;

/** Out-of-range / duplicate indices hatao, legacy number ko [n] banao. */
export function normalizePollVotes(
  votes: PollVotes | null | undefined,
  optionCount: number,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!votes) return out;
  for (const [uid, raw] of Object.entries(votes)) {
    const arr = Array.isArray(raw) ? raw : [raw];
    const clean = [...new Set(arr)]
      .filter((n) => Number.isInteger(n) && n >= 0 && n < optionCount)
      .sort((a, b) => a - b);
    if (clean.length > 0) out[uid] = clean;
  }
  return out;
}

/** Ek option ko kitne voters ne chuna. */
export function countVotesForOption(
  normalized: Record<string, number[]>,
  optIdx: number,
): number {
  return Object.values(normalized).filter((sel) => sel.includes(optIdx)).length;
}

/** Kul kitne alag voters hain (multi-answer me ek voter = 1 vote). */
export function totalVoters(normalized: Record<string, number[]>): number {
  return Object.keys(normalized).length;
}

/** Kul kitne selections hue (multi-answer me voter se zyada ho sakta hai). */
export function totalSelections(normalized: Record<string, number[]>): number {
  return Object.values(normalized).reduce((sum, sel) => sum + sel.length, 0);
}

/** Current user ki selection (normalized, hamesha array). */
export function myPollSelection(
  votes: PollVotes | null | undefined,
  currentUserId: string | null | undefined,
  optionCount: number,
): number[] {
  if (!currentUserId) return [];
  return normalizePollVotes(votes, optionCount)[currentUserId] || [];
}

/**
 * Ek option ko kis-kis ne vote diya.
 * Returns { uid, name } pairs — NOT bare names: two voters can share a
 * display name (or both fall back to their uid), and keying the <li> list
 * by name produced duplicate React keys. Key by `uid`.
 */
export function votersForOption(
  normalized: Record<string, number[]>,
  optIdx: number,
  voterNames?: Record<string, string>,
): { uid: string; name: string }[] {
  return Object.entries(normalized)
    .filter(([, sel]) => sel.includes(optIdx))
    .map(([uid]) => ({ uid, name: voterNames?.[uid] || uid }));
}

export default function PollCard({
  poll,
  currentUserId,
  voterNames,
  onVote,
  disableChange = false,
  disabled = false,
  onLimitReached,
  onViewResults,
}: PollCardProps) {
  const options = poll.options || [];
  const multi = poll.multiAnswer === true;
  const maxChoices = multi
    ? Math.max(1, Math.min(poll.maxChoices ?? options.length, options.length || 1))
    : 1;
  const normalized = normalizePollVotes(poll.votes, options.length);
  const voters = totalVoters(normalized);
  const selections = totalSelections(normalized);
  const mySelection = currentUserId ? normalized[currentUserId] || [] : [];
  const hasVoted = mySelection.length > 0;
  // Vote tabhi badla ja sakta hai jab: disabled nahi, vote-change band
  // nahi, aur (pehli baar vote ho ya change allowed ho).
  const canVote = !disabled && !!currentUserId && !!onVote && (!hasVoted || !disableChange);

  const handleToggle = (optIdx: number) => {
    if (!canVote) return;
    if (multi) {
      if (mySelection.includes(optIdx)) {
        // Deselect — hamesha allowed (vote kam karna cap ko nahi chhoota).
        void onVote(mySelection.filter((i) => i !== optIdx));
      } else {
        if (mySelection.length >= maxChoices) {
          onLimitReached?.(maxChoices);
          return;
        }
        void onVote([...mySelection, optIdx].sort((a, b) => a - b));
      }
    } else {
      // Single-answer: dobara tap = vote wapas (WhatsApp jaisa toggle).
      void onVote(mySelection.includes(optIdx) ? [] : [optIdx]);
    }
  };

  const handleRemoveVote = () => {
    if (!canVote || !hasVoted) return;
    void onVote([]);
  };

  return (
    <div className="py-1 min-w-[220px]" role="group" aria-label={`Poll: ${poll.question}`}>
      <p className="font-semibold text-sm mb-1">{poll.question}</p>
      <p className="text-[11px] opacity-60 mb-2">
        {multi ? `Multiple answers allowed · up to ${maxChoices}` : 'Choose one'}
        {disableChange && hasVoted ? ' · Vote cannot be changed' : ''}
      </p>

      <div className="space-y-1.5">
        {options.map((opt, optIdx) => {
          const optVotes = countVotesForOption(normalized, optIdx);
          const percentage = voters > 0 ? Math.round((optVotes / voters) * 100) : 0;
          const mine = mySelection.includes(optIdx);
          const names = votersForOption(normalized, optIdx, voterNames);

          return (
            <div key={optIdx}>
              <button
                type="button"
                onClick={() => handleToggle(optIdx)}
                disabled={!canVote}
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={mine}
                aria-label={`${opt}, ${optVotes} votes, ${percentage} percent`}
                className={`w-full text-left p-2 rounded-xl text-xs relative overflow-hidden transition border ${
                  mine
                    ? 'border-primary-green bg-primary-green/10 font-medium'
                    : 'border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5'
                } ${!canVote ? 'cursor-default' : 'cursor-pointer'}`}
              >
                <div
                  className="absolute left-0 top-0 bottom-0 bg-primary-green/20 rounded-xl transition"
                  style={{ width: `${percentage}%` }}
                />
                <div className="relative flex justify-between items-center z-10 gap-2">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      aria-hidden
                      className={`flex-shrink-0 w-4 h-4 flex items-center justify-center text-[10px] border rounded-[4px] ${
                        multi ? 'rounded-[4px]' : 'rounded-full'
                      } ${
                        mine
                          ? 'bg-green-cta border-green-cta text-white'
                          : 'border-black/30 dark:border-white/30 text-transparent'
                      }`}
                    >
                      ✓
                    </span>
                    <span className="truncate">{opt}</span>
                  </span>
                  <span className="opacity-75 font-mono ml-2 flex-shrink-0">
                    {percentage}% ({optVotes})
                  </span>
                </div>
              </button>
              {names.length > 0 && (
                <details className="mt-0.5 ml-7">
                  <summary className="text-[11px] opacity-60 cursor-pointer hover:opacity-90">
                    Voted by{' '}
                    {names.length === 1
                      ? names[0].name
                      : `${names.length} people`}
                  </summary>
                  <ul className="text-[11px] opacity-70 mt-0.5 space-y-0.5 list-none">
                    {names.map(({ uid, name }) => (
                      <li key={uid} className="truncate">
                        {name}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-1.5">
        {onViewResults && voters > 0 ? (
          <button
            type="button"
            onClick={onViewResults}
            className="text-[10px] font-medium text-primary-green hover:underline"
            aria-label={`View poll results, ${voters} ${voters === 1 ? 'vote' : 'votes'}`}
          >
            {voters} {voters === 1 ? 'vote' : 'votes'}
            {multi && selections !== voters ? ` · ${selections} selections` : ''}
            {' · View results'}
          </button>
        ) : (
          <p className="text-[10px] opacity-60">
            {voters} {voters === 1 ? 'vote' : 'votes'}
            {multi && selections !== voters ? ` · ${selections} selections` : ''}
          </p>
        )}
        {hasVoted && canVote && (
          <button
            type="button"
            onClick={handleRemoveVote}
            className="text-[11px] font-medium text-primary-green hover:underline"
          >
            Remove vote
          </button>
        )}
      </div>
      {hasVoted && !canVote && !disabled && (
        <p className="text-[10px] opacity-60 mt-1">Your vote is locked for this poll.</p>
      )}
    </div>
  );
}
