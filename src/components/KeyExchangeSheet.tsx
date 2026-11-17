/**
 * KeyExchangeSheet — peer key verification (E2EE Worker 4, UI only).
 *
 * Bottom sheet that shows the peer's safety number / key fingerprint for
 * one chat and lets the user confirm (or reject) that the numbers match
 * what the peer sees on their device.
 *
 * READ-ONLY use of src/services/e2ee/* — this file only calls the
 * existing exports of keyExchange.ts / crypto.ts; it never modifies them
 * and never sends a key-exchange message itself (sending the announce/ack
 * over the message channel is the pipeline worker's wiring, not UI).
 *
 * HOW VERIFICATION WORKS (honest limits):
 * - The 60-digit safety number is derived from both devices' public keys
 *   (computeSafetyNumber in keyExchange.ts). If it matches on both phones,
 *   no one has substituted a key in the middle — as long as the numbers
 *   were compared out-of-band (in person, or on a call you trust).
 * - The server does NOT authenticate public keys, so verification is the
 *   only MITM protection. A matching number proves nothing about the
 *   server; it proves the two devices hold each other's real keys.
 * - The "verified" mark is local only (localStorage on this device). The
 *   peer never sees it, and it is cleared automatically if the peer's key
 *   changes (re-install / identity reset / possible MITM).
 * - 1-to-1 chats only. Groups exchange keys separately (sender-key
 *   design, Report 3 #183) — this sheet does not verify group sender keys.
 *
 * STYLE: WhatsApp Classic Pro — white/dark panels, #075E54 accents,
 * same bottom-sheet shell as StatusReplySheet.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Fingerprint, KeyRound, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { navigationManager } from '../services/navigation';
import { isWebCryptoAvailable } from '../services/e2ee/crypto';
import {
  clearVerified,
  exportPublicKeyBase64,
  getOrCreateIdentityKeyPair,
  getPeerPublicKey,
  getSafetyNumber,
  isVerified,
  markVerified,
  rotateIdentityKeyPair,
  shortFingerprint,
  type StoredPeerKey,
} from '../services/e2ee/keyExchange';

export interface KeyExchangeSheetProps {
  open: boolean;
  onClose: () => void;
  /** Chat id (DM channel id) whose peer key is being verified. */
  chatId: string;
  /** Signed-in owner's uid — scopes the peer-key / verified-mark lookup (W5c). */
  ownerUid?: string;
  /** Display name of the peer, for labels. Defaults to "this contact". */
  peerName?: string;
  /** Called after the verified mark changes, so the parent can refresh. */
  onVerifiedChange?: (verified: boolean) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'unavailable'; reason: string }
  | { status: 'no-peer' }
  | {
      status: 'ready';
      peer: StoredPeerKey;
      safetyNumber: string;
      ownFingerprint: string;
      verified: boolean;
    };

function formatFingerprint(fp: string): string {
  // 16 hex chars -> "abcd ef01 2345 6789" for easy reading aloud.
  return fp.replace(/(.{4})(?=.)/g, '$1 ').toUpperCase();
}

export default function KeyExchangeSheet({
  open,
  onClose,
  chatId,
  ownerUid,
  peerName,
  onVerifiedChange,
}: KeyExchangeSheetProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [mismatch, setMismatch] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    setMismatch(false);
    setConfirmReset(false);
    if (!isWebCryptoAvailable()) {
      setState({
        status: 'unavailable',
        reason: 'WebCrypto is not available on this device/browser, so encryption keys cannot be created or checked here.',
      });
      return;
    }
    setState({ status: 'loading' });
    try {
      const peer = await getPeerPublicKey(chatId, ownerUid);
      if (!peer) {
        setState({ status: 'no-peer' });
        return;
      }
      const [safetyNumber, identity] = await Promise.all([
        getSafetyNumber(chatId, ownerUid),
        getOrCreateIdentityKeyPair(),
      ]);
      if (!safetyNumber) {
        // Peer key stored but the chat key could not be derived — treat as
        // "not exchanged yet" rather than showing a half-broken number.
        setState({ status: 'no-peer' });
        return;
      }
      const ownPubB64 = await exportPublicKeyBase64(identity.publicKey);
      const ownFingerprint = await shortFingerprint(ownPubB64);
      setState({
        status: 'ready',
        peer,
        safetyNumber,
        ownFingerprint,
        verified: isVerified(chatId, ownerUid),
      });
    } catch {
      setState({
        status: 'unavailable',
        reason: 'Could not load the encryption keys for this chat. Try again when you are back online.',
      });
    }
  }, [chatId, ownerUid]);

  useEffect(() => {
    if (!open) return;
    void load();
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [open, load, onClose]);

  if (!open) return null;

  const displayName = peerName?.trim() || 'this contact';

  const handleMatch = () => {
    markVerified(chatId, ownerUid);
    onVerifiedChange?.(true);
    setMismatch(false);
    setState((prev) => (prev.status === 'ready' ? { ...prev, verified: true } : prev));
  };

  const handleMismatch = () => {
    clearVerified(chatId, ownerUid);
    onVerifiedChange?.(false);
    setMismatch(true);
    setState((prev) => (prev.status === 'ready' ? { ...prev, verified: false } : prev));
  };

  const handleReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setError('');
    try {
      // New identity keypair; clears this chat's stored peer key + verified
      // mark. Both sides must exchange keys again before encrypted
      // messages can resume.
      await rotateIdentityKeyPair([chatId], ownerUid);
      onVerifiedChange?.(false);
      await load();
    } catch {
      setError('Could not reset the keys. Try again.');
    } finally {
      setResetting(false);
    }
  };

  const safetyGroups =
    state.status === 'ready' ? state.safetyNumber.split(' ') : [];

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Verify encryption keys for ${displayName}`}
    >
      <div
        className="w-full max-h-[88vh] overflow-y-auto bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary-green" />
            Verify {displayName}
          </h3>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
          Compare these numbers with {displayName} in person or on a call you
          trust. If they match, nobody is sitting between your two devices.
          If they don&apos;t match, don&apos;t send anything sensitive — the
          keys may have been substituted, or {displayName} may have
          re-installed the app.
        </p>

        {state.status === 'loading' && (
          <div className="flex justify-center py-10">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
          </div>
        )}

        {state.status === 'unavailable' && (
          <div className="flex gap-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-3">
            <AlertTriangle className="h-5 w-5 text-danger-red flex-shrink-0 mt-0.5" />
            <p className="text-sm text-gray-700 dark:text-text-primary">{state.reason}</p>
          </div>
        )}

        {state.status === 'no-peer' && (
          <div className="bg-gray-100 dark:bg-input-dark rounded-xl p-4 space-y-2">
            <p className="text-sm font-semibold text-gray-900 dark:text-text-primary flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary-green" />
              Keys not exchanged yet
            </p>
            <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
              {displayName} hasn&apos;t exchanged encryption keys with this
              device yet. Keys are exchanged automatically when you both open
              this chat — ask {displayName} to open the chat, then come back
              here to compare safety numbers. Until then, messages in this
              chat are not end-to-end encrypted.
            </p>
          </div>
        )}

        {state.status === 'ready' && (
          <>
            {/* Safety number — 60 digits, 12 groups of 5 (WhatsApp-style). */}
            <div>
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">
                Safety number
              </p>
              <div className="grid grid-cols-3 gap-2">
                {safetyGroups.map((group, i) => (
                  <div
                    key={i}
                    className="bg-gray-100 dark:bg-input-dark rounded-lg py-2 text-center font-mono text-sm tracking-wider text-gray-900 dark:text-text-primary"
                  >
                    {group}
                  </div>
                ))}
              </div>
            </div>

            {/* Fingerprints */}
            <div className="space-y-2">
              <div className="flex items-start gap-3 py-2 border-b border-gray-200 dark:border-white/5">
                <Fingerprint className="h-4 w-4 text-primary-green mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 dark:text-text-secondary">Your key fingerprint</p>
                  <p className="text-sm font-mono text-gray-900 dark:text-text-primary break-all">
                    {formatFingerprint(state.ownFingerprint)}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 py-2 border-b border-gray-200 dark:border-white/5">
                <Fingerprint className="h-4 w-4 text-primary-green mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs text-gray-500 dark:text-text-secondary">
                    {displayName}&apos;s key fingerprint
                  </p>
                  <p className="text-sm font-mono text-gray-900 dark:text-text-primary break-all">
                    {formatFingerprint(state.peer.keyId)}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-text-secondary mt-0.5">
                    Received {new Date(state.peer.receivedAt).toLocaleDateString()}{' '}
                    {new Date(state.peer.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            </div>

            {/* Verification state + actions */}
            {state.verified ? (
              <div className="flex gap-3 bg-[#DCF8C6] dark:bg-[#005C4B]/30 border border-[#25D366]/30 rounded-xl p-3">
                <CheckCircle2 className="h-5 w-5 text-[#075E54] dark:text-[#25D366] flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-[#075E54] dark:text-white">Verified on this device</p>
                  <p className="text-xs text-gray-600 dark:text-text-secondary">
                    You confirmed these numbers match. The mark is stored only
                    on this device, and it clears itself if {displayName}&apos;s
                    key ever changes.
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500 dark:text-text-secondary">
                Not verified yet — the numbers above have not been compared
                with {displayName}.
              </p>
            )}

            {mismatch && (
              <div className="flex gap-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-xl p-3">
                <AlertTriangle className="h-5 w-5 text-danger-red flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">Numbers don&apos;t match</p>
                  <p className="text-xs text-gray-600 dark:text-text-secondary leading-relaxed">
                    Stop here — don&apos;t send sensitive messages in this
                    chat. Either {displayName} re-installed the app (ask them
                    to open the chat so keys re-exchange), or someone is in
                    the middle. You can reset your own keys below and
                    exchange again.
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={handleMatch}
                disabled={state.verified}
                className="py-2.5 rounded-xl bg-green-cta text-white text-sm font-semibold disabled:opacity-40"
              >
                {state.verified ? 'Numbers match ✓' : 'Numbers match'}
              </button>
              <button
                onClick={handleMismatch}
                className="py-2.5 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-danger-red text-sm font-semibold"
              >
                Don&apos;t match
              </button>
            </div>

            <div className="pt-1">
              <button
                onClick={() => void handleReset()}
                disabled={resetting}
                className="w-full py-2.5 rounded-xl border border-gray-200 dark:border-white/10 text-sm font-medium text-gray-700 dark:text-text-primary hover:bg-gray-100 dark:hover:bg-input-dark disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <RefreshCw className="h-4 w-4" />
                {resetting
                  ? 'Resetting keys…'
                  : confirmReset
                    ? 'Tap again to confirm reset'
                    : 'Reset my keys for this chat'}
              </button>
              <p className="text-xs text-gray-400 dark:text-text-secondary mt-2 leading-relaxed">
                Resetting creates a new identity key on this device and clears
                the exchanged peer key. Both sides must exchange keys again;
                messages encrypted with the old keys can no longer be
                decrypted on this device.
              </p>
            </div>
          </>
        )}

        {error && (
          <p role="status" className="text-center text-sm text-danger-red">{error}</p>
        )}
      </div>
    </div>
  );
}
