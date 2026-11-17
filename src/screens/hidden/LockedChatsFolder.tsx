/**
 * LockedChatsFolder — WhatsApp-style locked-chats folder (Phase 5, Agent A).
 *
 * NEW FILE. Copy to: src/screens/hidden/LockedChatsFolder.tsx
 * Replaces HiddenChatsScreen.tsx (delete that file; App.tsx patch P-02
 * routes /hidden-chats -> /locked-chats).
 *
 * Behaviour
 * - The folder is INVISIBLE in the main chat list. It is revealed only by
 *   typing the secret code in the ChatList search bar (see ChatListScreen
 *   patch P-03) or by navigating to /locked-chats directly — either way
 *   the PIN/biometric gate below must pass before any name is shown.
 * - Inside the folder, after unlock: partner name + avatar ONLY. No
 *   last-message preview, no timestamp, no unread badge, no bio — a
 *   shoulder-surfer learns nothing about the conversation.
 * - Auto-locks after 2 min idle, or when hidden longer than a 30 s grace
 *   (brief backgrounding — notification shade, app switcher, incoming-call
 *   screen — does not lock and does not kill the 15-min session).
 *   Unlocking starts a 15-min in-memory session (lockedChats.ts) so the
 *   ChatScreen route guard lets the user open a locked chat without
 *   re-entering the PIN for every message.
 * - Secret-code management + Change PIN live here (both need the folder
 *   unlocked first). The code is stored as a salted hash only.
 *
 * STYLE (user requirement): Style 1 — WhatsApp Classic Pro ONLY.
 * Deep green header #075E54, clean white background, light green sent
 * bubbles #DCF8C6, white received bubbles, blue double ticks, green
 * unread badges. Dark theme: #0B141A / #111B21 / #005C4B. No Telegram
 * Sleek, Minimal iOS, or Dark Neon styling anywhere in this screen.
 */
import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, ChevronRight, Fingerprint, KeyRound, Lock, LockKeyhole, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, query, where, onSnapshot, auth, db } from '../../aws';
import PinScreen from './PinScreen';
import { biometricAvailable, getBiometricPref, setBiometricPref } from '../../services/biometric';
import {
  LOCKED_PIN_KEY,
  hasSecretCode,
  loadHiddenChatIds,
  lockLockedFolder,
  setChatLocked,
  setSecretCode,
  unlockLockedFolder,
  clearSecretCode,
} from '../../services/lockedChats';
import { avatarFallback } from '../../utils/avatar';

const AUTO_LOCK_MS = 120000;
/** Brief backgrounding (notification shade, app switcher, incoming-call
 * screen) must NOT lock the folder instantly — RC2. Only lock on return
 * when the folder was hidden longer than this grace. */
const BACKGROUND_GRACE_MS = 30000;

export default function LockedChatsFolder() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const [unlocked, setUnlocked] = useState(false);
  const [chats, setChats] = useState<any[]>([]);
  // UI-army #5: the true number of locked chats (the list below used
  // to silently cap at 30 — see the chunked query in the effect).
  const [lockedTotal, setLockedTotal] = useState(0);
  const [toast, setToast] = useState('');
  // 100M-D6 (W14h): same class as D5 — the toast's auto-clear timer id, so
  // a second toast fired before the first one's timer expires is cleared
  // by ITS OWN timer, not the first one's (which cut it short).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bioAvail, setBioAvail] = useState(false);
  const [bioOn, setBioOn] = useState(() => getBiometricPref() === '1');
  const [codeSet, setCodeSet] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [changingPin, setChangingPin] = useState(false);

  const showToastMsg = (msg: string) => {
    // 100M-D6: clear the previous toast's timer first — without this the
    // first toast's 2500 ms timer cleared the second toast early.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(''), 2500);
  };

  // Auto-lock: inactivity timer + background lock with grace.
  //
  // RC1: the old `unlockHandled` ref is gone — it was set on the first
  // unlock and never reset, so after any auto-lock / "Lock now" the
  // correct PIN became a silent no-op until remount. Re-unlock is now
  // just unlockLockedFolder() + setUnlocked(true) on every success;
  // double onSuccess calls are harmless (idempotent session start).
  //
  // RC2: backgrounding no longer locks instantly and no longer kills the
  // 15-min folder session. On hide we only record the time and pause the
  // idle timer; on return we lock ONLY if hidden longer than the grace
  // (notification shade / app switcher / incoming-call screen stay
  // unlocked), otherwise the idle timer re-arms.
  //
  // RC5: the idle timer now listens to the same event set as AppLockGate
  // — Gboard typing sends `input` without `keydown`, scrolling sends
  // `touchmove`/`wheel`, taps send `pointerdown`. The old
  // touchstart/mousemove/keydown-only set let the folder lock mid-typing.
  useEffect(() => {
    if (!unlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    let hiddenAt = 0;
    const lock = () => {
      setUnlocked(false);
      lockLockedFolder();
    };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, AUTO_LOCK_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        clearTimeout(timer);
        return;
      }
      // Back in foreground: lock only if hidden longer than the grace.
      if (hiddenAt && Date.now() - hiddenAt > BACKGROUND_GRACE_MS) {
        lock();
      } else {
        hiddenAt = 0;
        resetTimer();
      }
    };
    window.addEventListener('touchstart', resetTimer);
    window.addEventListener('pointerdown', resetTimer);
    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keydown', resetTimer);
    window.addEventListener('input', resetTimer, true);
    window.addEventListener('scroll', resetTimer, true);
    window.addEventListener('touchmove', resetTimer);
    window.addEventListener('wheel', resetTimer);
    document.addEventListener('visibilitychange', onVisibility);
    resetTimer();
    return () => {
      clearTimeout(timer);
      window.removeEventListener('touchstart', resetTimer);
      window.removeEventListener('pointerdown', resetTimer);
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('input', resetTimer, true);
      window.removeEventListener('scroll', resetTimer, true);
      window.removeEventListener('touchmove', resetTimer);
      window.removeEventListener('wheel', resetTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [unlocked]);

  // App-lock fix (2026-11-14): NO unmount lock here any more. The old
  // `useEffect(() => () => lockLockedFolder(), [])` fired on EVERY folder
  // unmount — including navigating INTO a locked chat. The folder unmounted,
  // the session died, and the next re-render inside the chat (any incoming
  // message / typing event) re-showed the "Locked Chat" PIN screen
  // mid-chat. The 15-min session is INTENDED to survive leaving the folder
  // (that's why it exists); the folder's own PIN gate re-asks on every
  // remount (`unlocked` is local state), and ChatScreen's own unmount
  // effect still ends the session when a locked chat is actually left.

  useEffect(() => {
    if (!unlocked) return;
    biometricAvailable().then(setBioAvail);
    hasSecretCode().then(setCodeSet).catch(() => {});
  }, [unlocked]);

  // Load locked chats from the PRIVATE locked doc (migrates the legacy
  // public users/{uid}.hiddenChats field — see lockedChats.ts).
  useEffect(() => {
    if (!currentUser || !unlocked) return;
    let cancelled = false;
    let innerUnsubs: Array<() => void> = [];
    void loadHiddenChatIds().then((ids) => {
      if (cancelled) return;
      setLockedTotal(ids.length);
      if (ids.length === 0) {
        setChats([]);
        return;
      }
      // UI-army #5: Firestore `in` caps at 30 values — the old
      // `ids.slice(0, 30)` silently dropped locked chats 31+, which
      // then looked deleted. Chunk the ids into batches of 30,
      // subscribe to each batch, and merge the snapshots so every
      // locked chat shows.
      const chunkDocs = new Map<number, any[]>();
      const order = new Map(ids.map((id, i) => [id, i]));
      const applyMerged = () => {
        if (cancelled) return;
        const merged: any[] = [];
        for (let i = 0; i < chunkDocs.size; i++) merged.push(...(chunkDocs.get(i) || []));
        merged.sort((a, b) => (order.get(a.uid) ?? order.get(a.id) ?? 0) - (order.get(b.uid) ?? order.get(b.id) ?? 0));
        setChats(merged);
      };
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
      innerUnsubs = chunks.map((chunk, ci) =>
        onSnapshot(
          query(collection(db, 'users'), where('uid', 'in', chunk)),
          (s) => {
            chunkDocs.set(ci, s.docs.map((d) => ({ id: d.id, ...d.data() })));
            applyMerged();
          },
        ),
      );
    });
    return () => {
      cancelled = true;
      innerUnsubs.forEach((u) => u());
    };
  }, [currentUser, unlocked]);

  const handleUnlock = () => {
    unlockLockedFolder();
    setUnlocked(true);
  };

  const handleUnhide = async (targetUid: string) => {
    if (!currentUser) return;
    try {
      await setChatLocked(targetUid, false);
      setChats((prev) => prev.filter((c) => c.uid !== targetUid && c.id !== targetUid));
      showToastMsg('Chat moved back to your chats ✓');
    } catch {
      showToastMsg('Could not unhide. Try again.');
    }
  };

  const toggleBiometric = () => {
    const next = !bioOn;
    setBiometricPref(next);
    setBioOn(next);
    showToastMsg(next ? 'Fingerprint unlock on' : 'Fingerprint unlock off');
  };

  const handleSaveCode = async () => {
    if (codeInput.trim().length < 4) {
      showToastMsg('Secret code must be at least 4 characters.');
      return;
    }
    try {
      await setSecretCode(codeInput);
      setCodeSet(true);
      setCodeInput('');
      showToastMsg('Secret code saved ✓ — type it in search to reveal this folder.');
    } catch {
      showToastMsg('Could not save the secret code. Try again.');
    }
  };

  const handleClearCode = async () => {
    try {
      await clearSecretCode();
      setCodeSet(false);
      showToastMsg('Secret code removed.');
    } catch {
      showToastMsg('Could not remove the secret code. Try again.');
    }
  };

  if (!unlocked) {
    return (
      <PinScreen
        title="Locked Chats"
        pinKey={LOCKED_PIN_KEY}
        // W30f: PinScreen trusts allowBiometric as passed — the locked-chat
        // opt-in lives in the vault pref (bioOn), so pass it explicitly.
        allowBiometric={bioOn}
        onSuccess={handleUnlock}
      />
    );
  }

  // Change-PIN while unlocked: show the create screen (forceCreate, P-11).
  // The folder PIN was already verified to get in here.
  if (changingPin) {
    return (
      <PinScreen
        title="Locked Chats"
        pinKey={LOCKED_PIN_KEY}
        forceCreate
        onSuccess={() => {
          setChangingPin(false);
          unlockLockedFolder();
          setUnlocked(true);
          showToastMsg('PIN changed ✓');
        }}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-bg-dark text-gray-900 dark:text-white">
      {toast && (
        <div role="status" className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-xs px-4 py-2 rounded-full shadow-2xl">
          {toast}
        </div>
      )}

      {/* WhatsApp Classic Pro header: deep green #075E54 (dark: #111B21) */}
      <div className="pt-safe bg-header-green dark:bg-panel-dark text-white shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="p-2 -ml-2 rounded-full hover:bg-white/10"
              aria-label="Back"
            >
              <ArrowLeft className="h-6 w-6" />
            </button>
            <div>
              <h1 className="font-bold text-base leading-tight">Locked Chats</h1>
              <p className="text-[11px] text-white/80">{lockedTotal > 0 ? `${lockedTotal} locked chat${lockedTotal === 1 ? '' : 's'} · Only you can see these` : 'Only you can see these'}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {bioAvail && (
              <button
                onClick={toggleBiometric}
                className={`p-2 rounded-full hover:bg-white/10 ${bioOn ? 'text-primary-green' : 'text-white/60'}`}
                title={bioOn ? 'Fingerprint unlock is on' : 'Fingerprint unlock is off'}
                aria-label="Toggle fingerprint unlock"
                aria-pressed={bioOn}
              >
                <Fingerprint className="h-5 w-5" />
              </button>
            )}
            <button
              onClick={() => {
                setUnlocked(false);
                lockLockedFolder();
              }}
              className="p-2 rounded-full hover:bg-white/10 text-white/80 hover:text-white"
              title="Lock now"
              aria-label="Lock now"
            >
              <Lock className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Secret code — the only way to reveal this folder from the chat list */}
      <div className="mx-4 mt-3 rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-panel-dark p-4 space-y-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-header-green dark:text-primary-green" /> Secret code
        </h2>
        <p className="text-xs text-gray-500 dark:text-text-secondary">
          {codeSet
            ? 'A secret code is set. Type it in the chat-list search bar to reveal this folder.'
            : 'Set a secret code (e.g. a word only you know). Typing it in the chat-list search reveals this folder.'}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder={codeSet ? 'New secret code (min 4 characters)' : 'Secret code (min 4 characters)'}
            autoComplete="off"
            autoCapitalize="off"
            className="flex-1 bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-green"
          />
          <button
            onClick={handleSaveCode}
            disabled={codeInput.trim().length < 4}
            className="px-4 py-2 bg-header-green text-white rounded-xl text-sm font-semibold disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {codeSet && (
          <button onClick={handleClearCode} className="text-xs text-red-500 font-medium py-1 px-1 -ml-1">
            Remove secret code
          </button>
        )}
      </div>

      <div className="mx-4 mt-3 flex gap-2">
        <button
          onClick={() => setChangingPin(true)}
          className="flex-1 py-2.5 rounded-xl bg-sent-bubble-light dark:bg-sent-bubble text-header-green dark:text-white text-sm font-semibold hover:opacity-90 active:scale-[0.99] transition-opacity"
        >
          Change PIN
        </button>
        <button
          onClick={() => navigate('/vault')}
          className="flex-1 py-2.5 rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-panel-dark text-sm font-semibold flex items-center justify-center gap-2 hover:bg-gray-50 dark:hover:bg-input-dark/40 active:scale-[0.99] transition-colors"
        >
          <LockKeyhole className="h-4 w-4 text-header-green dark:text-primary-green" /> Secret Vault
          <ChevronRight className="h-4 w-4 text-gray-400" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto mt-2">
        {chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 px-6 text-center gap-3 text-gray-400">
            <MessageSquare className="h-12 w-12 opacity-40" />
            <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">No locked chats</p>
            <p className="text-xs max-w-xs text-gray-500 dark:text-text-secondary">
              Open a chat, tap the menu (⋮) and choose &quot;Hide Chat&quot;. It will move here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-white/5">
            {chats.map((chat) => (
              <div
                key={chat.id}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-input-dark/40 focus-visible:bg-gray-50 dark:focus-visible:bg-input-dark/40 focus:outline-none cursor-pointer"
                role="button"
                tabIndex={0}
                aria-label={`Open locked chat with ${chat.displayName || chat.username || 'Unknown'}`}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/chat/${chat.id}`); } }}
                onClick={() => {
                  // Session is unlocked (we are inside the folder), so the
                  // ChatScreen route guard lets this open.
                  navigate(`/chat/${chat.id}`);
                }}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <img
                    src={chat.photoURL || avatarFallback(chat.displayName || chat.username || 'Unknown', chat.id)}
                    alt=""
                    className="h-11 w-11 rounded-full object-cover flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <h4 className="font-semibold text-sm truncate">{chat.displayName || chat.username || 'Unknown'}</h4>
                    {/* DELIBERATE: no bio, no last-message preview, no time,
                        no unread badge — nothing about the conversation leaks
                        here, even to someone looking over your shoulder. */}
                    <p className="text-xs text-gray-500 dark:text-text-secondary truncate flex items-center gap-1"><Lock className="h-3 w-3 flex-shrink-0" /> Message</p>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUnhide(chat.uid);
                  }}
                  className="text-xs text-header-green dark:text-primary-green font-semibold px-3 py-2 flex-shrink-0"
                >
                  Unhide
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
