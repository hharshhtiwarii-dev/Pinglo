import { useState, useEffect } from 'react';
import { ArrowLeft, Lock, LockKeyhole, Pencil, Plus, StickyNote, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PinScreen from '../hidden/PinScreen';
import {
  addVaultNote,
  clearVaultKey,
  deleteVaultNote,
  eraseVault,
  loadVaultNotes,
  setVaultSessionKey,
  updateVaultNote,
  VAULT_PIN_KEY,
  type VaultNote,
} from '../../services/vault';

// Locks itself after 2 minutes without touch, and when the app goes to the background
const AUTO_LOCK_MS = 120000;

export default function VaultScreen() {
  const navigate = useNavigate();
  const [unlocked, setUnlocked] = useState(false);
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [showComposer, setShowComposer] = useState(false);
  const [saving, setSaving] = useState(false);
  // S22 (100-more): the note being edited, if any — the composer is
  // reused with the note prefilled instead of delete-and-retype.
  const [editingNote, setEditingNote] = useState<VaultNote | null>(null);
  const [toast, setToast] = useState('');
  // Bumped after a PIN reset so PinScreen remounts and re-checks PIN status.
  const [pinResetKey, setPinResetKey] = useState(0);
  const [pendingDeleteNote, setPendingDeleteNote] = useState<VaultNote | null>(null);
  const [showForgotPinConfirm, setShowForgotPinConfirm] = useState(false);
  // REPORT-3 #74: seconds until the vault auto-locks (2 min idle).
  // Shown live under the header so the lock never fires as a surprise.
  const [lockCountdown, setLockCountdown] = useState(AUTO_LOCK_MS / 1000);
  // Phase 4: encryption session-key status. 'pending' while the PIN-derived
  // key is being derived after unlock; 'missing' when the PIN was not
  // supplied (notes load in legacy plaintext form + a warning is shown).
  const [keyStatus, setKeyStatus] = useState<'pending' | 'ready' | 'missing'>('pending');

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  // Auto-lock: inactivity timer and background lock (same pattern as HiddenChatsScreen)
  useEffect(() => {
    if (!unlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    const lock = () => setUnlocked(false);
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, AUTO_LOCK_MS);
      // REPORT-3 #74: activity resets the visible countdown too.
      setLockCountdown(AUTO_LOCK_MS / 1000);
    };
    const onVisibility = () => {
      if (document.hidden) lock();
    };
    window.addEventListener('touchstart', resetTimer);
    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keydown', resetTimer);
    // S3 (100-more): same activity set as the fixed AppLockGate — Gboard
    // typing sends `input` without `keydown`, and scrolling sends no
    // touchstart after gesture start, so a long note could lock mid-type.
    window.addEventListener('input', resetTimer, true);
    window.addEventListener('scroll', resetTimer, true);
    window.addEventListener('touchmove', resetTimer);
    window.addEventListener('pointerdown', resetTimer);
    window.addEventListener('wheel', resetTimer);
    document.addEventListener('visibilitychange', onVisibility);
    resetTimer();
    // REPORT-3 #74: tick the displayed countdown once a second.
    const ticker = setInterval(() => setLockCountdown((prev) => Math.max(0, prev - 1)), 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(ticker);
      window.removeEventListener('touchstart', resetTimer);
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('input', resetTimer, true);
      window.removeEventListener('scroll', resetTimer, true);
      window.removeEventListener('touchmove', resetTimer);
      window.removeEventListener('pointerdown', resetTimer);
      window.removeEventListener('wheel', resetTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [unlocked]);

  // Phase 4: locking the vault drops the in-memory encryption key.
  useEffect(() => {
    if (!unlocked) {
      clearVaultKey();
      setKeyStatus('pending');
    }
  }, [unlocked]);

  // Phase 5 (L-28): navigating away unmounts this screen WITHOUT setting
  // unlocked=false — drop the key on unmount too.
  useEffect(() => () => clearVaultKey(), []);

  // If the key never arrives (PIN not supplied to this screen), fall back
  // to the legacy load path after a short grace period instead of hanging.
  useEffect(() => {
    if (!unlocked || keyStatus !== 'pending') return;
    const t = setTimeout(() => setKeyStatus((s) => (s === 'pending' ? 'missing' : s)), 1500);
    return () => clearTimeout(t);
  }, [unlocked, keyStatus]);

  // Load notes once per unlock, after the key status is settled so
  // encrypted notes can actually be decrypted on first load.
  useEffect(() => {
    if (!unlocked || keyStatus === 'pending') return;
    setLoadingNotes(true);
    loadVaultNotes()
      .then(setNotes)
      .catch(() => showToastMsg('Could not load vault notes. Try again.'))
      .finally(() => setLoadingNotes(false));
  }, [unlocked, keyStatus]);

  const handleAddNote = async () => {
    if (!body.trim() || saving) return;
    setSaving(true);
    try {
      if (editingNote) {
        const updated = await updateVaultNote(editingNote.id, title, body);
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
        setEditingNote(null);
        showToastMsg('Note updated ✓');
      } else {
        const note = await addVaultNote(title, body);
        setNotes((prev) => [note, ...prev]);
        showToastMsg('Note saved to vault ✓');
      }
      setTitle('');
      setBody('');
      setShowComposer(false);
    } catch {
      showToastMsg('Could not save note. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleEditNote = (note: VaultNote) => {
    setEditingNote(note);
    setTitle(note.title);
    setBody(note.body);
    setShowComposer(true);
  };

  const handleCancelComposer = () => {
    setShowComposer(false);
    setTitle('');
    setBody('');
    setEditingNote(null);
  };

  const handleDeleteNote = async () => {
    const note = pendingDeleteNote;
    if (!note) return;
    setPendingDeleteNote(null);
    try {
      await deleteVaultNote(note.id);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      showToastMsg('Note deleted');
    } catch {
      showToastMsg('Could not delete note. Try again.');
    }
  };

  // "Forgot PIN?" — wipe the PIN and every note, then show the create-PIN screen.
  const handleForgotPin = async () => {
    setShowForgotPinConfirm(false);
    try {
      await eraseVault();
    } catch {
      // Even if the wipe partially failed, force the PIN screen to re-check.
    }
    setNotes([]);
    setUnlocked(false);
    setPinResetKey((k) => k + 1);
  };

  const formatDate = (ms: number) => {
    if (!ms) return '';
    return new Date(ms).toLocaleString([], {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Escape closes the delete-note confirm dialog.
  useEffect(() => {
    if (!pendingDeleteNote && !showForgotPinConfirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPendingDeleteNote(null);
      setShowForgotPinConfirm(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingDeleteNote, showForgotPinConfirm]);

  if (!unlocked) {
    return (
      <div key={pinResetKey} className="contents">
        <PinScreen
          title="Secret Vault"
          pinKey={VAULT_PIN_KEY}
          onSuccess={() => setUnlocked(true)}
          onForgotPin={() => setShowForgotPinConfirm(true)}
          // Phase 4: the verified PIN derives the AES-GCM session key
          // (in-memory only) that decrypts/encrypts vault notes.
          onPinVerified={async (pin) => {
            const ok = await setVaultSessionKey(pin);
            setKeyStatus(ok ? 'ready' : 'missing');
            // Phase 5 (L-27): return false when the key could not be
            // derived — PinScreen then refuses to unlock (P-11) instead
            // of opening the vault with no key.
            return ok;
          }}
        />
        {showForgotPinConfirm && (
          <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowForgotPinConfirm(false)} role="dialog" aria-modal="true" aria-label="Forgot vault PIN">
            <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">Forgot your vault PIN?</h3>
              <p className="text-sm text-gray-500 dark:text-text-secondary">
                This erases your vault PIN and ALL vault notes. There is no other way back in.
              </p>
              <div className="flex gap-3">
                <button onClick={() => setShowForgotPinConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
                <button onClick={handleForgotPin} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all">Erase everything</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white dark:bg-[#0B141A] text-gray-900 dark:text-white">
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-xs px-4 py-2 rounded-full shadow-2xl">
          {toast}
        </div>
      )}

      {/* WhatsApp Classic Pro header: deep green #075E54 (dark: #111B21) */}
      <div className="pt-safe bg-[#075E54] dark:bg-[#111B21] text-white shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate(-1)}
              className="p-2 -ml-2 rounded-full hover:bg-white/10"
              aria-label="Back"
            >
              <ArrowLeft className="h-6 w-6" />
            </button>
            <div className="flex items-center gap-2">
              <LockKeyhole className="h-5 w-5 text-white" />
              <div>
                <h1 className="font-bold text-base leading-tight">Secret Vault</h1>
                <p className="text-[11px] text-white/70">PIN-protected · only you can see this</p>
              </div>
            </div>
          </div>
          <button
            onClick={() => setUnlocked(false)}
            className="p-2 rounded-full hover:bg-white/10 text-white/80 hover:text-red-300"
            title="Lock now"
            aria-label="Lock now"
          >
            <Lock className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <p className="text-xs text-gray-500 dark:text-text-secondary mb-4">
          Private notes, protected by a PIN separate from Hidden Chats. Notes are encrypted on this
          device with a key derived from your vault PIN (AES-256-GCM). The vault locks
          after 2 minutes idle, when the app goes to the background, and when you leave this screen.
        </p>
        {/* REPORT-3 #74: visible auto-lock countdown — "locks in 1:47". */}
        <p role="timer" className="text-xs text-gray-500 dark:text-text-secondary mb-4">
          🔒 Locks in {Math.floor(lockCountdown / 60)}:{String(lockCountdown % 60).padStart(2, '0')} of inactivity
        </p>
        {keyStatus === 'missing' && (
          <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2 mb-4">
            ⚠️ Encryption key unavailable — lock the vault and re-enter your PIN. Notes cannot be saved until the key is ready.
          </p>
        )}

        {showComposer ? (
          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-panel-light dark:bg-panel-dark p-4 mb-4 space-y-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (optional)"
              maxLength={80}
              className="w-full bg-transparent outline-none text-base font-semibold placeholder:text-gray-400"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write a private note..."
              rows={4}
              maxLength={5000}
              autoFocus
              className="w-full bg-transparent outline-none text-sm resize-none placeholder:text-gray-400"
            />
            <p className="text-[11px] text-gray-400 dark:text-text-secondary">
              📷 Photo &amp; file attachments — coming soon. Text notes only for now.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleAddNote}
                disabled={!body.trim() || saving}
                className="flex-1 py-2.5 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green disabled:opacity-40 transition-all"
              >
                {saving ? 'Saving...' : editingNote ? 'Save changes' : 'Save note'}
              </button>
              <button
                onClick={handleCancelComposer}
                className="p-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary"
                aria-label="Cancel"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowComposer(true)}
            className="w-full mb-4 py-3 rounded-2xl bg-primary-green/10 border border-primary-green/30 text-primary-green text-sm font-semibold flex items-center justify-center gap-2 hover:bg-primary-green/20 transition-all"
          >
            <Plus className="h-5 w-5" /> Add a private note
          </button>
        )}

        {loadingNotes ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-3 text-gray-400">
            <StickyNote className="h-12 w-12 opacity-40" />
            <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">Vault is empty</p>
            <p className="text-xs max-w-xs text-gray-500 dark:text-text-secondary">
              Add a private note above. Notes are stored in your owner-only private
              vault and protected by a PIN separate from Hidden Chats.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="rounded-2xl border border-gray-200 dark:border-white/10 bg-panel-light dark:bg-panel-dark p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-sm truncate">{note.title}</h3>
                    <p className="text-[11px] text-gray-500 dark:text-text-secondary mt-0.5">{formatDate(note.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handleEditNote(note)}
                      className="p-1.5 rounded-full text-gray-400 hover:text-primary-green hover:bg-primary-green/10"
                      title="Edit note"
                      aria-label={`Edit note ${note.title || ''}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setPendingDeleteNote(note)}
                      className="p-1.5 rounded-full text-gray-400 hover:text-red-500 hover:bg-red-500/10"
                      title="Delete note"
                      aria-label={`Delete note ${note.title || ''}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <p className="text-sm text-gray-700 dark:text-text-primary whitespace-pre-wrap break-words mt-2">{note.body}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete-note confirm (replaces window.confirm) */}
      {pendingDeleteNote && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingDeleteNote(null)} role="dialog" aria-modal="true" aria-label="Delete vault note">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete this note from your vault?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              “{pendingDeleteNote.title || pendingDeleteNote.body.slice(0, 60)}” will be permanently removed.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setPendingDeleteNote(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button onClick={handleDeleteNote} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
