/**
 * E2EESettings — "End-to-end encryption" settings screen (E2EE Worker 4,
 * reworked by the Master E2EE pass).
 *
 * Route: /settings/e2ee (added in App.tsx, additive only).
 *
 * Shows, for this device only:
 *  - encryption status for the account (WebCrypto + own identity key),
 *  - the device's own identity-key fingerprint,
 *  - per-chat key status for chats that have EXCHANGED keys (ECDH peer
 *    public key stored, safety number, verified mark) with a Verify
 *    action per chat and a per-chat reset,
 *  - identity reset.
 *
 * There is deliberately NO key backup export/import here any more: chat
 * keys are DERIVED (ECDH + HKDF) from the identity key + the peer's
 * public key, so they are re-derived whenever both keys are present —
 * there is nothing to back up. The identity private key is
 * non-extractable by design and cannot be exported. What DOES exist is
 * an encrypted HISTORY backup — Settings → Chats → Backup & restore
 * (ROADMAP-2 item 3): it stores the chat history decrypted on this
 * device, re-encrypted under a passphrase. It does NOT contain the
 * identity private key, so it restores readable history but not the key
 * itself: on a new device new chats re-exchange keys, and a server
 * re-sync can replace restored messages with ciphertext this device
 * cannot decrypt. Lose the device / wipe app data WITHOUT a backup and
 * the old encrypted messages can never be decrypted again.
 *
 * HONEST COPY (kept in the UI, not just comments):
 *  - Keys are agreed per 1-to-1 chat with ECDH (P-256) + HKDF; the server
 *    only ever sees public keys, never a chat key. No server enforces
 *    encryption: a modified client (or anyone with direct database
 *    access) can still send/read plaintext.
 *  - No forward secrecy / ratcheting (one long-lived key per peer key;
 *    a peer key change keeps ONE previous generation decryptable).
 *  - 1-to-1 chats only — group key distribution does not exist yet.
 *  - Media files, polls, location/contact messages and message metadata
 *    (who, when) are NOT encrypted; only message text is.
 *  - Messages sent before the keys are exchanged stay plaintext; they
 *    are never re-encrypted on read.
 *  - Lose the device / wipe app data without a backup: old messages
 *    can never be decrypted again. A backup DOES exist — Settings →
 *    Chats → Backup & restore — but it holds decrypted history
 *    re-encrypted under a passphrase, not the identity private key
 *    (see the backup bullet in the UI below).
 *
 * STYLE: WhatsApp Classic Pro — same page shell as StorageUsageScreen
 * (h-screen flex column, panel header, #075E54 / primary-green accents).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Fingerprint, KeyRound,
  RefreshCw, ShieldCheck, ShieldAlert,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth, db, doc, getDoc } from '../../aws';
import { cleanId, partnerIdForConversation } from '../../services/realtimeSync';
import KeyExchangeSheet from '../../components/KeyExchangeSheet';
import { isWebCryptoAvailable } from '../../services/e2ee/crypto';
import {
  deletePeerKey,
  exportPublicKeyBase64,
  getOrCreateIdentityKeyPair,
  isVerified,
  listPeerKeys,
  rotateIdentityKeyPair,
  shortFingerprint,
  type StoredPeerKey,
} from '../../services/e2ee/keyExchange';

interface ChatKeyRow {
  chatId: string;
  /** Display name resolved from the users doc (DM partner uid). */
  displayName: string;
  /** Fingerprint of the exchanged peer public key. */
  peerKeyId: string;
  /** When the peer key was received. */
  receivedAt: number;
  /** A previous peer key is kept (peer re-installed) — old messages still open. */
  hasPreviousKey: boolean;
  /** Has the peer's ECDH public key been exchanged for this chat? (always true for listed rows) */
  peerExchanged: boolean;
  /** Has the user confirmed the safety number for this chat? */
  verified: boolean;
}

const formatDate = (ts: number): string => {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const shortId = (id: string): string =>
  id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

export default function E2EESettings({ onBack }: { onBack?: () => void } = {}) {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;

  const [loading, setLoading] = useState(true);
  const [cryptoAvailable, setCryptoAvailable] = useState(true);
  const [ownFingerprint, setOwnFingerprint] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [rows, setRows] = useState<ChatKeyRow[]>([]);
  const [verifyChat, setVerifyChat] = useState<ChatKeyRow | null>(null);
  const [resettingChatId, setResettingChatId] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resettingIdentity, setResettingIdentity] = useState(false);
  const [toast, setToast] = useState('');

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const goBack = () => (onBack ? onBack() : navigate(-1));

  const load = useCallback(async () => {
    setLoading(true);
    setIdentityError('');
    if (!isWebCryptoAvailable()) {
      setCryptoAvailable(false);
      setLoading(false);
      return;
    }
    setCryptoAvailable(true);
    try {
      const identity = await getOrCreateIdentityKeyPair();
      const ownPubB64 = await exportPublicKeyBase64(identity.publicKey);
      setOwnFingerprint(await shortFingerprint(ownPubB64));
    } catch {
      setIdentityError('Could not load this device’s identity key.');
      setOwnFingerprint(null);
    }
    try {
      // Rows come from EXCHANGED peer keys (ECDH). A chat with only a
      // retired same-device symmetric key and no peer key does not appear:
      // it was never end-to-end encrypted with the other side.
      const peers = await listPeerKeys(currentUser?.uid ?? '');
      // Name lookup is cache-first: the users docs are usually already in
      // the local cache (chat list / chat header loaded them); a network
      // getDoc is only the fallback, so this also works offline / in mock.
      let cachedUsers: any[] = [];
      try {
        cachedUsers = db.getCollectionDocs('users') || [];
      } catch { /* cache unreadable: getDoc fallback below */ }
      const findUserDoc = async (candidate: string): Promise<any | null> => {
        const hit = cachedUsers.find((u: any) => u.id === candidate || u.uid === candidate);
        if (hit) return hit;
        try {
          const snap = await getDoc(doc(db, 'users', candidate));
          if (snap.exists()) return snap.data();
        } catch { /* offline / no permission: fall through */ }
        return null;
      };
      const enriched: ChatKeyRow[] = await Promise.all(
        peers.map(async (p: StoredPeerKey & { chatId: string }) => {
          let displayName = shortId(p.chatId);
          try {
            if (p.chatId.startsWith('saved_')) {
              displayName = 'Saved Messages (yourself)';
            } else {
              // DM chat ids are conversation ids `uidA_uidB` — the peer
              // is the part that is not our own uid. Try each part as a
              // users doc; first hit wins (group ids have no users doc).
              const me = currentUser?.uid ? cleanId(currentUser.uid) : '';
              // #236: derive the single peer by prefix/suffix — a naive
              // split('_') mis-splits mock uids ('usr_<uuid>') into
              // fragments that never match a users doc, so mock peers
              // showed the raw id instead of their name.
              const peer = partnerIdForConversation(p.chatId, me);
              if (peer && peer !== me) {
                const d = await findUserDoc(peer);
                if (d) {
                  displayName =
                    d.displayName || d.username || (d.email ? d.email.split('@')[0] : displayName);
                }
              } else if (peer === me && me) {
                displayName = 'You (self chat)';
              }
            }
          } catch { /* offline / no permission: keep the id fallback */ }
          return {
            chatId: p.chatId,
            displayName,
            peerKeyId: p.keyId,
            receivedAt: p.receivedAt,
            hasPreviousKey: Boolean(p.previousPublicKey),
            peerExchanged: true,
            verified: isVerified(p.chatId, currentUser?.uid ?? ''),
          };
        }),
      );
      enriched.sort((a, b) => b.receivedAt - a.receivedAt);
      setRows(enriched);
    } catch {
      setRows([]);
      showToastMsg('Could not load the chat key list. Try again.');
    } finally {
      setLoading(false);
    }
  }, [currentUser?.uid]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleResetChatKey = async (chatId: string) => {
    if (resettingChatId) return;
    setResettingChatId(chatId);
    try {
      // Deletes the exchanged peer key + verified mark for this chat.
      // Messages already encrypted stay as ciphertext, but this device
      // can no longer derive the key for them until the keys are
      // exchanged again — the chat re-announces on next open.
      await deletePeerKey(chatId, currentUser?.uid ?? '');
      showToastMsg('Chat keys reset — keys will be exchanged again when you open the chat.');
      await load();
    } catch {
      showToastMsg('Could not reset the chat keys. Try again.');
    } finally {
      setResettingChatId(null);
    }
  };

  const handleResetIdentity = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResettingIdentity(true);
    try {
      // New identity keypair; clears every listed chat's exchanged peer
      // key + verified mark. Chats must exchange keys again, and messages
      // encrypted under the old identity can no longer be decrypted on
      // this device (their ciphertext stays, shown as undecryptable).
      await rotateIdentityKeyPair(rows.map((r) => r.chatId), currentUser?.uid ?? '');
      setOwnFingerprint(null);
      setConfirmReset(false);
      showToastMsg('Identity reset ✓ — chats must exchange keys again before encrypted messages can resume.');
      await load();
    } catch {
      showToastMsg('Could not reset the identity key. Try again.');
    } finally {
      setResettingIdentity(false);
    }
  };

  const encryptedCount = rows.length;
  const verifiedCount = rows.filter((r) => r.verified).length;

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary">
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={goBack}
            className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
            aria-label="Back to Settings"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="text-xl font-medium">End-to-end encryption</h1>
          <button
            onClick={() => void load()}
            title="Refresh"
            aria-label="Refresh encryption status"
            className="ml-auto p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
          >
            <RefreshCw className="h-5 w-5 text-gray-500 dark:text-text-secondary" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ── Account status ─────────────────────────────────────────── */}
        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-primary-green/15 flex items-center justify-center text-primary-green flex-shrink-0">
              {cryptoAvailable && ownFingerprint ? (
                <ShieldCheck className="h-6 w-6" />
              ) : (
                <ShieldAlert className="h-6 w-6" />
              )}
            </div>
            <div className="min-w-0">
              <p className="font-semibold">
                {!cryptoAvailable
                  ? 'Encryption unavailable on this device'
                  : ownFingerprint
                    ? 'Encryption is on for chats set up on this device'
                    : 'Encryption not set up yet'}
              </p>
              <p className="text-xs text-gray-500 dark:text-text-secondary">
                {encryptedCount} chat(s) with a key · {verifiedCount} verified
                {currentUser?.email ? ` · ${currentUser.email}` : ''}
              </p>
            </div>
          </div>

          {!cryptoAvailable && (
            <p className="text-sm text-gray-600 dark:text-text-secondary mt-3 leading-relaxed">
              WebCrypto is not available here (insecure context or an old
              WebView), so keys cannot be created or checked. Messages are
              sent unencrypted from this device.
            </p>
          )}

          {identityError && (
            <p className="text-sm text-danger-red mt-3">{identityError}</p>
          )}

          {ownFingerprint && (
            <div className="flex items-start gap-3 mt-4 pt-3 border-t border-gray-200 dark:border-white/5">
              <Fingerprint className="h-4 w-4 text-primary-green mt-0.5 flex-shrink-0" />
              <div className="min-w-0">
                <p className="text-xs text-gray-500 dark:text-text-secondary">Your identity-key fingerprint (this device)</p>
                <p className="text-sm font-mono text-gray-900 dark:text-text-primary break-all">
                  {ownFingerprint.replace(/(.{4})(?=.)/g, '$1 ').toUpperCase()}
                </p>
                <p className="text-xs text-gray-400 dark:text-text-secondary mt-1">
                  This identifies your device, not your account. A new phone
                  or a fresh install gets a new identity — contacts will see
                  a changed safety number.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── What is / isn't encrypted ──────────────────────────────── */}
        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5 space-y-2">
          <h2 className="font-semibold flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary-green" />
            What&apos;s protected — and what isn&apos;t
          </h2>
          <p className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed">
            In a 1-to-1 chat that has exchanged keys, message <em>text</em> is
            encrypted on this device with AES-256-GCM before it leaves the
            phone. The chat key is agreed directly with the other
            person&apos;s phone (ECDH key exchange) and is never sent to the
            server — only public keys travel over the network.
          </p>
          <ul className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed list-disc pl-5 space-y-1">
            <li>Not encrypted: media files, polls, location &amp; contact messages, and who messaged whom and when.</li>
            <li>Group chats exchange keys automatically too (sender-key exchange, one key per member) — until a group’s keys are exchanged, its messages aren’t end-to-end encrypted, and the chat shows a “setting up encryption” notice instead of a lock.</li>
            <li>If encryption fails, a 1-to-1 message is not sent at all — it stays in your composer so you can retry. Nothing is ever sent as plaintext from a 1-to-1 chat when encryption fails.</li>
            <li>Messages sent before the keys are exchanged stay plaintext; they are never re-encrypted on read.</li>
            <li>No forward secrecy: one long-lived key per peer key, so a leaked key can decrypt that chat&apos;s history. A peer key change keeps one previous generation readable.</li>
            <li>The server does not enforce encryption. A modified client or direct database access can still send or read plaintext — and a substituted public key is only caught if you verify the safety number out-of-band.</li>
            <li>Backups: Settings → Chats → Backup &amp; restore saves your chat history — decrypted on this device, then re-encrypted under a passphrase you choose. The identity private key itself is never in the backup (it can&apos;t be exported), so a backup restores readable history but not the key: on a new device, new chats re-exchange keys, and a server re-sync can replace restored messages with ciphertext this device can&apos;t decrypt. Lose the passphrase and the backup is unrecoverable — there is no reset.</li>
          </ul>
        </div>

        {/* ── Per-chat keys ──────────────────────────────────────────── */}
        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5">
          <h2 className="font-semibold mb-1">Chats with exchanged keys</h2>
          <p className="text-xs text-gray-500 dark:text-text-secondary mb-3">
            A chat appears here once both sides have exchanged public keys
            for it on this device. Chats that have never exchanged keys
            don&apos;t appear — open the 1-to-1 chat and the exchange happens
            automatically when both sides are online.
          </p>

          {loading ? (
            <div className="flex justify-center py-10">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-gray-400 text-center">
              <KeyRound className="h-10 w-10 opacity-40" />
              <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">No exchanged keys yet</p>
              <p className="text-xs max-w-xs text-gray-500 dark:text-text-secondary">
                Open a 1-to-1 chat — keys are exchanged automatically when
                both sides are online, and new text messages are then
                end-to-end encrypted.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100 dark:divide-white/5">
              {rows.map((row) => (
                <div key={row.chatId} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate text-gray-900 dark:text-text-primary">
                        {row.displayName}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary truncate">
                        Peer key {row.peerKeyId.toUpperCase()} · exchanged {formatDate(row.receivedAt)}
                        {row.hasPreviousKey ? ' · previous peer key kept' : ''}
                      </p>
                      <p className="text-xs mt-0.5">
                        {row.verified ? (
                          <span className="text-primary-green font-medium inline-flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Verified
                          </span>
                        ) : row.peerExchanged ? (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">Keys exchanged · not verified</span>
                        ) : (
                          <span className="text-gray-400 dark:text-text-secondary">Key on this device only · peer key not exchanged</span>
                        )}
                      </p>
                    </div>
                    <div className="flex flex-col gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => setVerifyChat(row)}
                        className="px-3 py-1.5 rounded-full bg-[#DCF8C6] dark:bg-[#005C4B] text-[#075E54] dark:text-white text-xs font-semibold"
                      >
                        Verify keys
                      </button>
                      <button
                        onClick={() => void handleResetChatKey(row.chatId)}
                        disabled={resettingChatId === row.chatId}
                        className="px-3 py-1.5 rounded-full border border-gray-200 dark:border-white/10 text-xs font-medium text-gray-700 dark:text-text-primary disabled:opacity-40"
                      >
                        {resettingChatId === row.chatId ? 'Resetting…' : 'Reset keys'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Danger zone ────────────────────────────────────────────── */}
        <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-red-200 dark:border-red-500/20 space-y-2">
          <h2 className="font-semibold text-danger-red flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            Reset identity
          </h2>
          <p className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed">
            Creates a new identity key for this device and clears every
            exchanged peer key and verified mark. Chats must exchange keys
            again, contacts will see a changed safety number, and messages
            encrypted under the old identity can no longer be decrypted on
            this device. A backup (Settings → Chats → Backup &amp; restore)
            still holds the readable history it captured — but it cannot
            bring back the old identity key, so anything backed up after
            the reset only contains what this device can still decrypt.
          </p>
          <button
            onClick={() => void handleResetIdentity()}
            disabled={resettingIdentity}
            className="w-full py-2.5 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-danger-red text-sm font-semibold disabled:opacity-50"
          >
            {resettingIdentity
              ? 'Resetting…'
              : confirmReset
                ? 'Tap again to confirm — this cannot be undone'
                : 'Reset my identity key'}
          </button>
        </div>

        {toast && (
          <p role="status" className="text-center text-sm text-primary-green pb-2">{toast}</p>
        )}
      </div>

      {verifyChat && (
        <KeyExchangeSheet
          open
          chatId={verifyChat.chatId}
          ownerUid={currentUser?.uid ?? ''}
          peerName={verifyChat.displayName}
          onClose={() => setVerifyChat(null)}
          onVerifiedChange={() => void load()}
        />
      )}
    </div>
  );
}
