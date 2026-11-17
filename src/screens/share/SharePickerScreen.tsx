/**
 * SharePickerScreen — ROADMAP-2 #8 last mile (Worker R2B).
 *
 * Route: /share (added in App.tsx, signed-in only).
 *
 * When another app shares text / photos / video to Pinglo, Android
 * delivers the intent to the native ShareIntent plugin (Worker R1B);
 * shareIntent.ts stores the payload in localStorage (`dt_pending_share`)
 * and App.tsx navigates here. This screen shows what was shared, lists
 * the user's chats, and sends the content into the picked chat through
 * the SAME send path ChatScreen uses (shareSend.ts — addDoc into
 * `chats/<conversationId>/messages`, uploadChatMedia for files, realtime
 * relay for 1-to-1 chats).
 *
 * Rows come from the already-loaded local cache only:
 *  - Saved Messages first (always offered),
 *  - 1-to-1 conversations from `db.getAllChatChannels()` whose id is a
 *    `<uidA>_<uidB>` pair containing this user — the peer name comes
 *    from the cached `users` docs,
 *  - other channels (groups / communities) — name from the cached
 *    `communities` or `chats` doc, falling back to a short id.
 * No per-chat message collection is loaded here (the C3 storm the chat
 * list gates off): rows show a kind label, not a last-message preview.
 *
 * Excluded, with a footnote when anything was hidden:
 *  - locked chats (Phase 5: locked chats never appear in share/forward
 *    surfaces) — `loadHiddenChatIds`,
 *  - read-only channels this user cannot post in — `canSendInChannel`,
 *    checked only when the group doc is in the cache. When the group
 *    doc is NOT cached yet the row is still offered: the send goes
 *    through the same write a group member's client would make, and the
 *    limitation is stated in PATCH-R2B.md (a server-side post rule is
 *    a backend job, not something this screen can enforce).
 *
 * After sending, the stored share is consumed (cleared) and a result
 * panel says exactly what went through and what did not — with an
 * "Open chat" button. A share that sent NOTHING (encryption failed and
 * every file unreadable) is kept stored, so the user can retry.
 * On the web there is no native plugin, so file refs can never be read
 * (`fileForRef` returns null): shared files are reported as unreadable
 * and shared text still sends. The native intent path itself still
 * needs a real-device test (see PATCH-R2B.md).
 *
 * STYLE: WhatsApp Classic Pro — same page shell as the settings screens
 * (h-screen flex column, panel header, #075E54 accents).
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Bookmark, CheckCircle2, Search, Share2, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth, db, onAuthStateChanged } from '../../aws';
import DefaultAvatar from '../../components/DefaultAvatar';
import { canSendInChannel } from '../../components/groupAdmin';
import { loadHiddenChatIds } from '../../services/lockedChats';
import { MAX_MESSAGE_CHARS } from '../../services/offlineQueue';
import { cleanId, partnerIdForConversation } from '../../services/realtimeSync';
import {
  clearStoredShare,
  fileForRef,
  loadPendingShare,
  type PendingShare,
} from '../../services/shareIntent';
import {
  groupConversationId,
  sendSharedFile,
  sendSharedText,
  type FileSendResult,
  type ShareTarget,
  type TextSendResult,
} from '../../services/shareSend';

interface PickerRow extends ShareTarget {
  photoURL?: string | null;
  kindLabel: string;
}

interface SendResult {
  target: PickerRow;
  textStatus: TextSendResult | 'none';
  files: FileSendResult[];
  /** Files that could not be read from the share at all (never became a File). */
  unreadable: string[];
  /** True when nothing was sent and the stored share was kept for retry. */
  shareKept: boolean;
}

const shortId = (id: string): string =>
  id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

const displayNameOf = (u: any, fallback: string): string =>
  (u && (u.displayName || u.username || (u.email ? String(u.email).split('@')[0] : ''))) || fallback;

export default function SharePickerScreen() {
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<any>(auth.currentUser ?? null);
  const [share, setShare] = useState<PendingShare | null>(null);
  const [rows, setRows] = useState<PickerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SendResult | null>(null);
  const [excludedCount, setExcludedCount] = useState(0);

  useEffect(() => onAuthStateChanged(auth, (u) => setCurrentUser(u ?? null)), []);

  useEffect(() => {
    setShare(loadPendingShare());
  }, []);

  useEffect(() => {
    if (!currentUser?.uid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await db.ensure('chats');
        await db.ensure('users');
        await db.ensure('communities');
        const me: string = currentUser.uid;
        const myClean = cleanId(me);
        let hidden: string[] = [];
        try {
          hidden = await loadHiddenChatIds(me);
        } catch {
          hidden = [];
        }
        const hiddenClean = new Set(hidden.map((h) => cleanId(h)));
        const isHidden = (rawId: string): boolean =>
          hidden.includes(rawId) || hiddenClean.has(cleanId(rawId));

        const users: any[] = db.getCollectionDocs('users') || [];
        const userByClean = new Map<string, any>();
        for (const u of users) {
          if (u && typeof u.id === 'string') userByClean.set(cleanId(u.id), u);
        }
        const communityDocs: any[] = db.getCollectionDocs('communities') || [];
        const communityByClean = new Map<string, any>();
        for (const g of communityDocs) {
          if (g && typeof g.id === 'string') communityByClean.set(cleanId(g.id), g);
        }
        const chatDocs: any[] = db.getCollectionDocs('chats') || [];
        const chatDocByClean = new Map<string, any>();
        for (const c of chatDocs) {
          if (c && typeof c.id === 'string') chatDocByClean.set(cleanId(c.id), c);
        }

        const out: PickerRow[] = [];
        let excluded = 0;
        // Saved Messages is always first — sharing to yourself.
        out.push({
          kind: 'saved',
          chatId: me,
          conversationId: `saved_${me}`,
          name: 'Saved Messages',
          kindLabel: 'Send to yourself',
        });

        for (const cid of db.getAllChatChannels()) {
          if (cid.startsWith('saved_')) continue;
          if (isHidden(cid)) {
            excluded += 1;
            continue;
          }
          // #236: derive the DM peer by prefix/suffix — a naive split('_')
          // mis-splits mock uids ('usr_<uuid>') into 4 parts, so mock DMs
          // never matched the 1-to-1 branch and fell into the group branch.
          const peerClean = partnerIdForConversation(cid, myClean);
          if (peerClean) {
            // 1-to-1 conversation: the peer is the part that is not us.
            if (isHidden(peerClean)) {
              excluded += 1;
              continue;
            }
            const peer = userByClean.get(peerClean);
            const peerRawId = peer?.id || peerClean;
            if (peer && isHidden(peerRawId)) {
              excluded += 1;
              continue;
            }
            out.push({
              kind: 'dm',
              chatId: peerRawId,
              conversationId: cid,
              name: displayNameOf(peer, `Chat ${shortId(peerClean)}`),
              photoURL: peer?.photoURL || null,
              kindLabel: '1-to-1 chat',
            });
          } else {
            // Group / community channel: conversation id is the community id.
            const group = communityByClean.get(cleanId(cid)) || chatDocByClean.get(cleanId(cid));
            if (group && !canSendInChannel(group, me)) {
              excluded += 1;
              continue;
            }
            const name =
              group?.name || group?.groupName || group?.title || `Group ${shortId(cid)}`;
            out.push({
              kind: 'group',
              chatId: cid,
              conversationId: groupConversationId(cid),
              name: String(name),
              photoURL: group?.photoURL || group?.avatar || null,
              kindLabel: 'Group',
            });
          }
        }
        if (cancelled) return;
        setRows(out);
        setExcludedCount(excluded);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.uid]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q));
  }, [rows, query]);

  const openChat = (target: PickerRow) => {
    if (target.kind === 'saved') navigate('/saved');
    else if (target.kind === 'group') navigate(`/chat/${target.chatId}?type=community`);
    else navigate(`/chat/${target.chatId}`);
  };

  const handlePick = async (row: PickerRow) => {
    if (sending || !share || !currentUser?.uid) return;
    // The app-wide message limit applies to shares too: refuse an
    // over-long share honestly instead of silently truncating it.
    if (share.text && share.text.trim().length > MAX_MESSAGE_CHARS) {
      setError(
        `This shared text is longer than ${MAX_MESSAGE_CHARS.toLocaleString()} characters, the longest message Pinglo sends. Trim it in the other app and share again — nothing was sent.`,
      );
      return;
    }
    setSending(true);
    setError('');
    setResult(null);
    const sender = {
      uid: currentUser.uid,
      displayName: currentUser.displayName || 'User',
      photoURL: currentUser.photoURL || '',
    };
    const target: ShareTarget = {
      kind: row.kind,
      chatId: row.chatId,
      conversationId: row.conversationId,
      name: row.name,
    };
    let textStatus: TextSendResult | 'none' = 'none';
    if (share.text && share.text.trim()) {
      textStatus = await sendSharedText(target, sender, share.text);
    }
    const files: FileSendResult[] = [];
    const unreadable: string[] = [];
    const albumId =
      share.files.length > 1
        ? `album_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
        : undefined;
    for (const ref of share.files) {
      const file = await fileForRef(ref);
      if (!file) {
        unreadable.push(ref.name);
        files.push({
          name: ref.name,
          ok: false,
          status: 'failed',
          reason: 'Could not read this file from the share.',
        });
        continue;
      }
      files.push(await sendSharedFile(target, sender, file, albumId));
    }
    const anythingSent =
      textStatus === 'sent' ||
      textStatus === 'queued' ||
      files.some((f) => f.ok || f.status === 'queued');
    // Consume the share once it sent something: re-picking the same
    // stored share would duplicate the text. When NOTHING sent, keep it
    // stored so the user can retry.
    if (anythingSent) clearStoredShare();
    setResult({ target: row, textStatus, files, unreadable, shareKept: !anythingSent });
    setSending(false);
  };

  const goBack = () => navigate('/main');

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary">
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <button
            onClick={goBack}
            className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
            aria-label="Back to chats"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <Share2 className="h-5 w-5 text-primary-green flex-shrink-0" />
          <h1 className="text-xl font-medium truncate">Share to Pinglo</h1>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
          </div>
        ) : !currentUser ? (
          <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-sm text-center space-y-2">
            <p className="font-semibold">Sign in to share</p>
            <p className="text-sm text-gray-600 dark:text-text-secondary">
              You need to be signed in before anything can be sent to a chat.
            </p>
            <button
              onClick={() => navigate('/login')}
              className="mt-2 px-4 py-2 rounded-full bg-green-cta text-white text-sm font-semibold"
            >
              Go to sign in
            </button>
          </div>
        ) : !share ? (
          <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-sm text-center space-y-2">
            <Share2 className="h-10 w-10 mx-auto text-gray-300 dark:text-text-secondary" />
            <p className="font-semibold">Nothing to share</p>
            <p className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed">
              No shared content is waiting. Share a photo, video or text to
              Pinglo from another app and you will land here to pick a chat.
            </p>
            <button
              onClick={goBack}
              className="mt-2 px-4 py-2 rounded-full bg-green-cta text-white text-sm font-semibold"
            >
              Back to chats
            </button>
          </div>
        ) : result ? (
          /* ── Result panel ─────────────────────────────────────── */
          <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5 space-y-3">
            <h2 className="font-semibold flex items-center gap-2">
              {result.shareKept ? (
                <AlertTriangle className="h-5 w-5 text-amber-500" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-primary-green" />
              )}
              {result.shareKept ? 'Nothing was sent' : `Shared to ${result.target.name}`}
            </h2>
            <ul className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed list-disc pl-5 space-y-1">
              {result.textStatus === 'sent' && <li>Text sent.</li>}
              {result.textStatus === 'queued' && (
                <li>Text queued — offline, it will send when you reconnect.</li>
              )}
              {result.textStatus === 'failed' && (
                <li>Text not sent — encryption failed. Try again once the keys are exchanged.</li>
              )}
              {result.files.filter((f) => f.ok).length > 0 && (
                <li>
                  {result.files.filter((f) => f.ok).length} file(s) sent
                  {result.files.some((f) => f.status === 'queued') ? ' (some queued offline)' : ''}.
                </li>
              )}
              {result.files
                .filter((f) => !f.ok)
                .map((f) => (
                  <li key={f.name}>
                    {f.name}: {f.reason || 'could not be sent.'}
                  </li>
                ))}
              {result.unreadable.length > 0 && (
                <li>
                  {result.unreadable.length} file(s) could not be read from the share.
                </li>
              )}
            </ul>
            {result.shareKept && (
              <p className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed">
                Your share is still saved — pick the chat again to retry, or
                share again from the other app.
              </p>
            )}
            <div className="flex gap-2 pt-1">
              {!result.shareKept && (
                <button
                  onClick={() => openChat(result.target)}
                  className="flex-1 py-2.5 rounded-xl bg-green-cta text-white text-sm font-semibold"
                >
                  Open chat
                </button>
              )}
              {result.shareKept && (
                <button
                  onClick={() => setResult(null)}
                  className="flex-1 py-2.5 rounded-xl bg-green-cta text-white text-sm font-semibold"
                >
                  Try again
                </button>
              )}
              <button
                onClick={goBack}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-white/10 text-sm font-semibold"
              >
                Back to chats
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* ── What was shared ────────────────────────────────── */}
            <div className="bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-sm border border-gray-200 dark:border-white/5 space-y-2">
              <h2 className="font-semibold text-sm text-gray-500 dark:text-text-secondary">
                Sharing
              </h2>
              {share.subject && (
                <p className="text-sm font-medium truncate">{share.subject}</p>
              )}
              {share.text && (
                <p className="text-sm text-gray-700 dark:text-text-primary leading-relaxed break-words">
                  {share.text.length > 300 ? `${share.text.slice(0, 300)}…` : share.text}
                </p>
              )}
              {share.files.length > 0 && (
                <div className="space-y-1">
                  {share.files.map((f) => (
                    <p key={`${f.path}-${f.name}`} className="text-sm text-gray-600 dark:text-text-secondary truncate">
                      📎 {f.name}
                    </p>
                  ))}
                </div>
              )}
              {share.truncated && (
                <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  Only the first 10 files were received — the sender shared more than Pinglo accepts in one share.
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="text-sm text-danger-red bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-2xl p-3">
                {error}
              </p>
            )}

            {/* ── Pick a chat ────────────────────────────────────── */}
            <div className="bg-panel-light dark:bg-panel-dark rounded-2xl shadow-sm border border-gray-200 dark:border-white/5 overflow-hidden">
              <div className="px-4 pt-4 pb-2">
                <h2 className="font-semibold">Pick a chat</h2>
                <div className="mt-2 flex items-center gap-2 rounded-full bg-gray-100 dark:bg-input-dark px-3 py-2">
                  <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search chats"
                    aria-label="Search chats"
                    className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder:text-gray-400"
                  />
                </div>
              </div>
              {sending && (
                <p className="px-4 pb-2 text-sm text-primary-green">Sending…</p>
              )}
              {filteredRows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-gray-500 dark:text-text-secondary text-center">
                  {rows.length === 0
                    ? 'No chats yet — start a chat first, then share to it.'
                    : 'No chat matches that search.'}
                </p>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-white/5">
                  {filteredRows.map((row) => (
                    <button
                      key={`${row.kind}:${row.conversationId}`}
                      onClick={() => void handlePick(row)}
                      disabled={sending}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-panel-dark/50 active:bg-gray-200 dark:active:bg-input-dark disabled:opacity-50"
                    >
                      {row.kind === 'saved' ? (
                        <span className="h-12 w-12 rounded-full bg-primary-green/15 flex items-center justify-center text-primary-green flex-shrink-0">
                          <Bookmark className="h-6 w-6" />
                        </span>
                      ) : row.kind === 'group' ? (
                        <span className="h-12 w-12 rounded-full bg-primary-green/15 flex items-center justify-center text-primary-green flex-shrink-0">
                          <Users className="h-6 w-6" />
                        </span>
                      ) : (
                        <DefaultAvatar
                          photoURL={row.photoURL}
                          name={row.name}
                          seed={row.chatId}
                          size={48}
                        />
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="block font-semibold truncate">{row.name}</span>
                        <span className="block text-xs text-gray-500 dark:text-text-secondary">
                          {row.kindLabel}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {excludedCount > 0 && (
              <p className="text-xs text-gray-400 dark:text-text-secondary px-1">
                {excludedCount} chat(s) hidden here: locked chats and channels you can&apos;t post in are never offered for sharing.
              </p>
            )}
            <p className="text-xs text-gray-400 dark:text-text-secondary px-1">
              Shared messages are sent exactly as if you typed them in the chat — including end-to-end encryption where the chat has exchanged keys.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
