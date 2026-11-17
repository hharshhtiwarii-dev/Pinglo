import React, { useEffect, useState } from 'react';
import { ArrowLeft, Phone, Video, Ban, Mail, AtSign, Info, Flag, Bell, BellOff } from 'lucide-react';
import { navigationManager } from '../services/navigation';
import { isOnline, lastSeenText, photoURLForViewer } from '../services/presence';
import DefaultAvatar from './DefaultAvatar';
import { avatarFallback } from '../utils/avatar';
import { auth } from '../aws';
import { REPORT_REASONS, submitReport, type ReportReason } from '../services/report';

interface UserProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: any;
  onStartCall: (type: 'audio' | 'video') => void;
  onToggleBlock?: () => void;
  isBlocked?: boolean;
  // 100M-M2: per-chat mute, wired to the same chatPrefs `muted` flag the
  // chat-list long-press menu writes. Omitted by callers without a chat
  // context — the row simply does not render.
  muted?: boolean | null;
  onToggleMute?: () => void;
  muteBusy?: boolean;
}

export default function UserProfileModal({
  isOpen,
  onClose,
  user,
  onStartCall,
  onToggleBlock,
  isBlocked = false,
  muted = null,
  onToggleMute,
  muteBusy = false,
}: UserProfileModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [isOpen, onClose]);

  // Escape closes the modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Phase 4: report sheet state — hooks must sit above the early return below.
  const [showReport, setShowReport] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason>('Spam');
  const [reportDetails, setReportDetails] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [reportDone, setReportDone] = useState(false);
  const [reportError, setReportError] = useState('');
  const [toast, setToast] = useState('');

  if (!isOpen || !user) return null;

  const displayName = user.displayName || user.name || user.username || 'User';
  const username = user.username || '';
  const email = user.email || '';
  // Phase 4: profile-photo privacy — when the viewer is not allowed to see
  // this user's photo, show the initials fallback instead of the real photo.
  const viewerUid = auth.currentUser?.uid || null;
  const visiblePhoto = photoURLForViewer(user, viewerUid);
  const photoURL = visiblePhoto || avatarFallback(displayName, user.id || user.uid);
  const about = user.about || 'Hey there! I am using Pinglo.';
  const online = isOnline(user, Date.now(), viewerUid);

  const handleReport = async () => {
    const me = auth.currentUser;
    if (!me) {
      setReportError('You must be signed in to report.');
      return;
    }
    setReportBusy(true);
    setReportError('');
    try {
      // Real write to the top-level `reports` collection — no fake call.
      await submitReport(
        { reportedUid: user.uid || user.id, reportedUsername: username, reason: reportReason, details: reportDetails },
        me.uid,
        me.username
      );
      setReportDone(true);
      setToast('Report sent. Thanks — our team will review it.');
      setTimeout(() => setToast(''), 3000);
    } catch (err: any) {
      setReportError(err?.message || 'Could not send the report. Check your connection and try again.');
    } finally {
      setReportBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex flex-col justify-end sm:justify-center items-center animate-fade-in p-0 sm:p-4 select-none" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Contact info for ${displayName}`}>
      <div
        className="w-full sm:max-w-md bg-panel-light dark:bg-panel-dark sm:rounded-3xl rounded-t-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh] border border-gray-200 dark:border-white/10"
        onClick={e => e.stopPropagation()}
      >
        {/* Top Header / Bar */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-white/5">
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark focus-visible:outline-2 focus-visible:outline-primary-green" aria-label="Back">
              <ArrowLeft className="h-5 w-5 text-gray-700 dark:text-text-primary" />
            </button>
            <h3 className="font-semibold text-base text-gray-900 dark:text-text-primary">Contact info</h3>
          </div>

        </div>

        {/* Scrollable Content */}
        <div className="overflow-y-auto flex-1 p-6 space-y-6">
          {/* Big Profile Photo & Primary Info */}
          <div className="flex flex-col items-center text-center">
            <div className="relative mb-4">
              <DefaultAvatar
                name={displayName}
                photoURL={photoURL}
                seed={user.id || user.uid}
                size={112}
                className="shadow-xl"
              />
              <span
                className={`absolute bottom-1 right-1 h-5 w-5 rounded-full border-4 border-panel-light dark:border-panel-dark ${
                  online ? 'bg-primary-green' : 'bg-gray-400'
                }`}
              />
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-text-primary">{displayName}</h2>
            {username && <p className="text-sm font-mono text-primary-green mt-0.5">@{username}</p>}
            <p className="text-xs text-gray-500 mt-1 flex items-center justify-center gap-1.5">
              <span aria-hidden="true" className={`w-2 h-2 rounded-full flex-shrink-0 ${online ? 'bg-primary-green' : 'bg-gray-400'}`} />
              {online ? 'Online now' : lastSeenText(user, Date.now(), viewerUid)}
            </p>
          </div>

          {/* Quick Call Action Row */}
          <div className="flex items-center justify-around py-3 px-4 rounded-2xl bg-gray-50 dark:bg-input-dark/60 border border-gray-200 dark:border-white/5">
            <button
              onClick={() => { onClose(); onStartCall('audio'); }}
              className="flex flex-col items-center gap-1.5 text-primary-green hover:opacity-80 active:scale-95 transition-[opacity,transform]"
              aria-label={`Voice call ${displayName}`}
            >
              <div className="p-3 rounded-full bg-primary-green/10">
                <Phone className="h-5 w-5" />
              </div>
              <span className="text-xs font-medium text-gray-700 dark:text-text-secondary">Audio</span>
            </button>

            <button
              onClick={() => { onClose(); onStartCall('video'); }}
              className="flex flex-col items-center gap-1.5 text-primary-green hover:opacity-80 active:scale-95 transition-[opacity,transform]"
              aria-label={`Video call ${displayName}`}
            >
              <div className="p-3 rounded-full bg-primary-green/10">
                <Video className="h-5 w-5" />
              </div>
              <span className="text-xs font-medium text-gray-700 dark:text-text-secondary">Video</span>
            </button>


          </div>

          {/* Details Card */}
          <div className="rounded-2xl bg-gray-50 dark:bg-input-dark/40 p-4 space-y-3.5 border border-gray-200 dark:border-white/5 text-sm">
            {/* About */}
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs text-gray-500">About</p>
                <p className="text-gray-900 dark:text-text-primary font-medium mt-0.5 break-words">{about}</p>
              </div>
            </div>

            {/* Email */}
            {email && (
              <div className="flex items-start gap-3 pt-2 border-t border-gray-200 dark:border-white/5">
                <Mail className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500">Email address</p>
                  <p className="text-gray-900 dark:text-text-primary font-medium mt-0.5 break-all">{email}</p>
                </div>
              </div>
            )}

            {/* Username */}
            {username && (
              <div className="flex items-start gap-3 pt-2 border-t border-gray-200 dark:border-white/5">
                <AtSign className="h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs text-gray-500">Username</p>
                  <p className="text-gray-900 dark:text-text-primary font-medium font-mono mt-0.5">@{username}</p>
                </div>
              </div>
            )}
          </div>

          {/* Mute / Unmute Controls — 100M-M2: mute was only reachable from
              the chat-list long-press menu; this row is the same flag. */}
          {onToggleMute && (
            <div className="pt-2 border-t border-gray-200 dark:border-white/5 space-y-2">
              <button
                onClick={onToggleMute}
                disabled={muted === null || muteBusy}
                className="w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-medium text-sm bg-gray-500/10 text-gray-700 dark:text-text-primary hover:bg-gray-500/20 transition-colors disabled:opacity-50"
                aria-label={muted ? 'Unmute notifications' : 'Mute notifications'}
              >
                {muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                <span>{muted ? 'Unmute notifications' : 'Mute notifications'}</span>
              </button>
            </div>
          )}

          {/* Block / Report Controls — verified: Block lives here (onToggleBlock). */}
          {onToggleBlock && (
            <div className="pt-2 border-t border-gray-200 dark:border-white/5 space-y-2">
              <button
                onClick={() => { onToggleBlock(); onClose(); }}
                className={`w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-medium text-sm transition-colors ${
                  isBlocked
                    ? 'bg-primary-green/10 text-primary-green hover:bg-primary-green/20'
                    : 'bg-danger-red/10 text-danger-red hover:bg-danger-red/20'
                }`}
              >
                <Ban className="h-4 w-4" />
                <span>{isBlocked ? 'Unblock Contact' : 'Block Contact'}</span>
              </button>
              <button
                onClick={() => { setShowReport(true); setReportDone(false); setReportError(''); }}
                className="w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-medium text-sm bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
              >
                <Flag className="h-4 w-4" />
                <span>Report user / spam</span>
              </button>
            </div>
          )}
          {!onToggleBlock && (
            <div className="pt-2 border-t border-gray-200 dark:border-white/5">
              <button
                onClick={() => { setShowReport(true); setReportDone(false); setReportError(''); }}
                className="w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-medium text-sm bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
              >
                <Flag className="h-4 w-4" />
                <span>Report user / spam</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Report sheet */}
      {showReport && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end sm:items-center justify-center p-4" onClick={() => setShowReport(false)} role="dialog" aria-modal="true" aria-label="Report user">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">Report {displayName}</h3>
            {reportDone ? (
              <div className="text-center py-4">
                <p className="text-primary-green font-medium">Report sent ✓</p>
                <p className="text-sm text-gray-500 dark:text-text-secondary mt-1">Thanks — our team will review it. Reporting does not block the user.</p>
                <button onClick={() => setShowReport(false)} className="mt-4 w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green transition-colors">Done</button>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-500 dark:text-text-secondary">Why are you reporting this user?</p>
                <div className="space-y-2">
                  {REPORT_REASONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setReportReason(r)}
                      aria-pressed={reportReason === r}
                      className={`w-full text-left px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${reportReason === r ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <textarea
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  placeholder="Details (optional)…"
                  aria-label="Details (optional)"
                  rows={3}
                  maxLength={1000}
                  className="w-full rounded-xl border border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-input-dark px-4 py-3 text-sm text-gray-900 dark:text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-primary-green"
                />
                {reportError && <p className="text-xs text-danger-red bg-danger-red/10 rounded-lg px-3 py-2">{reportError}</p>}
                <div className="flex gap-3">
                  <button onClick={() => setShowReport(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
                  <button onClick={handleReport} disabled={reportBusy} className="flex-1 py-3 bg-amber-500 text-white rounded-xl font-semibold hover:opacity-90 disabled:opacity-50 transition-colors">
                    {reportBusy ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] bg-gray-800 text-white text-sm px-4 py-2.5 rounded-full shadow-2xl max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
