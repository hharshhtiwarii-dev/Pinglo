import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Phone, Video, Link2, LogIn, Copy, Check, ArrowLeft, ShieldAlert, Calendar } from 'lucide-react';
import { auth, db, doc, getDoc, onAuthStateChanged } from '../../aws';
import { callService } from '../../services/callService';
import { avatarFallback } from '../../utils/avatar';

/**
 * Join screen for a shared call link: https://dtchats.app/call/{hostUid}?t={token}
 *
 * The link carries only the host's uid (see CallsScreen), not a room/call id,
 * so "joining" means placing a normal 1-1 call to that user through the
 * existing callService flow. The global <CallModal /> in App.tsx renders the
 * outgoing/connected call UI once startCall() is invoked — this screen only
 * resolves the host and starts the call.
 *
 * Token validation (Phase 3): the host's user doc may carry
 * `callLink: { token, expiresAt, revoked }` (minted by CallsScreen). When
 * present, the `?t=` token must match, be unexpired and unrevoked —
 * otherwise this screen shows "link expired" (with the reason named:
 * revoked / expired / no-longer-current). A bare link with NO `?t=` at
 * all is a different case — the link is live, the visitor just opened
 * the short form — and shows "needs its invite code" instead (#255).
 * Links without `?t=` still work for hosts who never generated a token
 * (pre-Phase-3 links).
 *
 * Guest joining is NOT possible: callService needs a signed-in user (auth
 * uid for signalling in `callsig`, plus mic/camera permission), and there is
 * no anonymous/guest calling backend. Signed-out visitors get a clear
 * message and a Sign in button instead of a dead end.
 */
export default function CallLinkScreen() {
  const { hostUid } = useParams<{ hostUid: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<any>(auth.currentUser);
  const [host, setHost] = useState<any | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'invalid' | 'expired' | 'token-required'>('loading');
  // Report 3 #255 — 'expired' used to cover three different facts
  // (revoked, past expiry, wrong/missing token) with one message that
  // asserted revocation/expiry that never happened. The reason is now
  // kept separately so the copy can say what actually happened.
  const [expiredReason, setExpiredReason] = useState<'revoked' | 'expired' | 'mismatch' | null>(null);
  const [calling, setCalling] = useState(false);
  const [copied, setCopied] = useState(false);
  // 100M-H12 — startCall can bail out mid-call; the buttons re-enable
  // but nothing said why. This line says it.
  const [callError, setCallError] = useState('');
  // Cluster C (Item 14a): scheduled call info from the host's callLink doc.
  const [scheduled, setScheduled] = useState<{ title?: string; scheduledAt?: number | null } | null>(null);

  // Re-render when auth state changes (e.g. user signs in while on this page).
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u: any) => setCurrentUser(u));
    return () => unsub();
  }, []);

  // Resolve the host uid to a user profile. Attempted even when signed out
  // so the invite can show a name; a failed lookup just shows a generic invite.
  useEffect(() => {
    if (!hostUid) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    getDoc(doc(db, 'users', hostUid))
      .then((snap: any) => {
        if (cancelled) return;
        if (snap.exists()) {
          const data = snap.data();
          setHost(data);
          setScheduled({ title: data?.callLink?.title, scheduledAt: data?.callLink?.scheduledAt ?? null });
          // Validate the tokenised link (Phase 3). A host who has a
          // callLink record requires a matching, live token.
          // Report 3 #255 — a bare link (no ?t= at all) is NOT "expired":
          // the link is live, the visitor just opened the short form.
          // Only a revoked token, a past expiry, or a token that no
          // longer matches the host's current link count as expired.
          const link = data?.callLink;
          if (link?.token) {
            const token = searchParams.get('t');
            if (!token) {
              setStatus('token-required');
              return;
            }
            if (link.revoked) {
              setExpiredReason('revoked');
              setStatus('expired');
              return;
            }
            if (token !== link.token) {
              setExpiredReason('mismatch');
              setStatus('expired');
              return;
            }
            if (link.expiresAt && Date.now() > link.expiresAt) {
              setExpiredReason('expired');
              setStatus('expired');
              return;
            }
          }
          setStatus('ready');
        } else {
          setStatus('not-found');
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Lookup failed (e.g. signed out / offline): don't claim the link is
        // invalid — the name just falls back to a generic label and the
        // signed-out prompt below still applies.
        setStatus('ready');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostUid]);

  const hostName = host?.displayName || host?.username || 'Pinglo user';
  const hostAvatar = host?.photoURL || (hostUid ? avatarFallback(hostName, hostUid) : '');
  const isOwnLink = !!currentUser && !!hostUid && currentUser.uid === hostUid;
  const tokenParam = searchParams.get('t');
  // Report 3 #255 — copying your own link must copy a WORKING link: the
  // bare /call/<uid> form needs its invite code, so the owner's own
  // token (from the loaded host doc) is included when no ?t= is in the URL.
  const ownToken = isOwnLink ? host?.callLink?.token : null;
  const effectiveToken = tokenParam || ownToken;
  const callLink = hostUid ? `https://dtchats.app/call/${hostUid}${effectiveToken ? `?t=${effectiveToken}` : ''}` : '';

  const startCall = (type: 'audio' | 'video') => {
    if (!currentUser || !hostUid || isOwnLink || calling) return;
    setCalling(true);
    setCallError('');
    // CallModal (mounted in App.tsx) takes over the screen from here.
    // If startCall bails out (e.g. already in a call), re-enable the buttons.
    callService
      .startCall({
        targetUserId: hostUid,
        targetUserName: hostName,
        targetUserAvatar: host?.photoURL || '',
        type,
      })
      .then((res) => {
        // 100M-H12 — say why no call started instead of a dead button.
        if (res === 'already-in-call') setCallError("You're already in a call — end it first, then join this link.");
      })
      .catch(() => setCalling(false));
    // startCall resolves after signalling setup; if the call never started
    // (e.g. mic/camera denied it alerts + ends the call), let the user retry.
    setTimeout(() => setCalling(false), 3000);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(callLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { /* intentionally ignored */}
  };

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-bg-light dark:bg-bg-dark px-6 text-gray-900 dark:text-text-primary">
      <div className="w-full max-w-sm flex flex-col items-center text-center">
        <div className="h-16 w-16 rounded-full bg-primary-green/10 border border-primary-green/20 flex items-center justify-center">
          <Link2 className="h-8 w-8 text-primary-green" />
        </div>
        <h1 className="text-2xl font-bold mt-4">Pinglo call</h1>

        {status === 'loading' && (
          <p className="text-sm text-gray-500 dark:text-text-secondary mt-2">Loading call link…</p>
        )}

        {status === 'invalid' && (
          <>
            <p className="text-sm text-gray-500 dark:text-text-secondary mt-2">
              This call link is invalid — it doesn&apos;t name anyone to call.
            </p>
            <button
              onClick={() => navigate('/main')}
              className="mt-6 py-3 px-6 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
            >
              Open Pinglo
            </button>
          </>
        )}

        {status === 'not-found' && (
          <>
            <p className="text-sm text-gray-500 dark:text-text-secondary mt-2">
              This call link doesn&apos;t point to a Pinglo user any more. It may have been
              shared from an account that no longer exists.
            </p>
            <button
              onClick={() => navigate('/main')}
              className="mt-6 py-3 px-6 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
            >
              Open Pinglo
            </button>
          </>
        )}

        {status === 'expired' && (
          <>
            <div className="mt-6 flex flex-col items-center">
              <ShieldAlert className="h-12 w-12 text-danger-red opacity-80" />
              <h2 className="text-xl font-semibold mt-3">
                {expiredReason === 'mismatch' ? 'This link isn’t current any more' : 'This call link has expired'}
              </h2>
              <p className="text-sm text-gray-500 dark:text-text-secondary mt-2 leading-relaxed">
                {expiredReason === 'revoked'
                  ? `${hostName !== 'Pinglo user' ? `${hostName} revoked this link.` : 'This link was revoked.'} Ask them to share a fresh call link from the Calls tab.`
                  : expiredReason === 'expired'
                    ? 'This link passed its expiry date. Ask the host to share a fresh call link from the Calls tab.'
                    : `This link doesn’t match ${hostName !== 'Pinglo user' ? `${hostName}’s` : 'the host’s'} current call link — they may have created a new one. Ask them to share the latest link from the Calls tab.`}{' '}
              </p>
            </div>
            <button
              onClick={() => navigate('/main')}
              className="mt-6 py-3 px-6 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
            >
              Open Pinglo
            </button>
          </>
        )}

        {status === 'token-required' && (
          <>
            <div className="mt-6 flex flex-col items-center">
              <ShieldAlert className="h-12 w-12 text-primary-green opacity-80" />
              <h2 className="text-xl font-semibold mt-3">This link needs its invite code</h2>
              <p className="text-sm text-gray-500 dark:text-text-secondary mt-2 leading-relaxed">
                {isOwnLink
                  ? 'This is your own call link — the short link on its own can’t join a call. Copy the full link below (it includes your invite code) and share that instead.'
                  : `${hostName !== 'Pinglo user' ? `${hostName}’s` : 'This'} call link is still live — you just opened the short form without its invite code. Open the full link they shared with you instead.`}
              </p>
            </div>
            {isOwnLink ? (
              <button
                onClick={copyLink}
                className="mt-6 w-full flex items-center justify-center gap-2 py-3 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
              >
                {copied ? (
                  <>
                    <Check className="h-5 w-5" /> Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-5 w-5" /> Copy your full call link
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={() => navigate('/main')}
                className="mt-6 py-3 px-6 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
              >
                Open Pinglo
              </button>
            )}
          </>
        )}

        {status === 'ready' && (
          <>
            {/* Cluster C (Item 14a): scheduled time + countdown. Joining
                early is allowed (like WhatsApp) — this only informs. */}
            {scheduled?.scheduledAt ? (
              <div className="mt-4 w-full rounded-xl bg-primary-green/10 border border-primary-green/20 px-4 py-3 text-sm text-left">
                {scheduled.title && <p className="font-semibold">{scheduled.title}</p>}
                <p className="text-gray-600 dark:text-text-secondary">
                  <Calendar className="h-4 w-4 inline-block mr-1 -mt-0.5" />Scheduled for {new Date(scheduled.scheduledAt).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </p>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">
                  {scheduled.scheduledAt > Date.now()
                    ? 'This call has not started yet — you can join early; the call begins when the host is ready.'
                    : 'This call was scheduled earlier — you can join now.'}
                </p>
              </div>
            ) : null}

            {host && (
              <div className="flex flex-col items-center mt-6">
                <img
                  src={hostAvatar}
                  alt={hostName}
                  className="h-24 w-24 rounded-full object-cover"
                  referrerPolicy="no-referrer"
                />
                <h2 className="text-xl font-semibold mt-3">{hostName}</h2>
              </div>
            )}

            {!currentUser ? (
              <>
                <p className="text-sm text-gray-500 dark:text-text-secondary mt-3">
                  {host
                    ? `${hostName} invited you to a call on Pinglo.`
                    : 'Someone invited you to a call on Pinglo.'}{' '}
                  Call links only work inside the app — sign in to join. Guest joining
                  isn&apos;t available yet.
                </p>
                <button
                  onClick={() => navigate('/login')}
                  className="mt-6 w-full flex items-center justify-center gap-2 py-3 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
                >
                  <LogIn className="h-5 w-5" /> Sign in to join the call
                </button>
                <button
                  onClick={() => navigate('/signup')}
                  className="mt-3 w-full py-3 bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
                >
                  Create an account
                </button>
                <p className="text-xs text-gray-400 mt-4">
                  After signing in, open the call link again to join.
                </p>
              </>
            ) : isOwnLink ? (
              <>
                <p className="text-sm text-gray-500 dark:text-text-secondary mt-3">
                  This is your own call link — share it with someone else to call you.
                  You can&apos;t call yourself.
                </p>
                <button
                  onClick={copyLink}
                  className="mt-6 w-full flex items-center justify-center gap-2 py-3 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter]"
                >
                  {copied ? (
                    <>
                      <Check className="h-5 w-5" /> Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-5 w-5" /> Copy your call link
                    </>
                  )}
                </button>
                <button
                  onClick={() => navigate('/main')}
                  className="mt-3 w-full py-3 bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
                >
                  Back to chats
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-500 dark:text-text-secondary mt-3">
                  {host ? `${hostName} is waiting for your call.` : 'Join this call.'} Choose
                  how you want to call — your camera and microphone permission will be
                  requested.
                </p>
                <div className="flex gap-3 w-full mt-6">
                  <button
                    onClick={() => startCall('audio')}
                    disabled={calling}
                    className="flex-1 flex items-center justify-center gap-2 py-3 bg-primary-green text-on-primary-green rounded-xl font-semibold hover:brightness-95 transition-[filter] disabled:opacity-50"
                  >
                    <Phone className="h-5 w-5" /> Voice call
                  </button>
                  <button
                    onClick={() => startCall('video')}
                    disabled={calling}
                    className="flex-1 flex items-center justify-center gap-2 py-3 bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors disabled:opacity-50"
                  >
                    <Video className="h-5 w-5" /> Video call
                  </button>
                </div>
                {callError && (
                  <p role="alert" className="text-sm text-danger-red mt-4">{callError}</p>
                )}
                <button
                  onClick={() => navigate('/main')}
                  className="mt-4 flex items-center gap-1 text-sm text-gray-500 dark:text-text-secondary hover:opacity-80"
                >
                  <ArrowLeft className="h-4 w-4" /> Back to chats
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
