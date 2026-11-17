/**
 * BlockedContactsScreen — real manageable blocked list (Phase 5, Agent A).
 *
 * NEW FILE. Copy to: src/screens/settings/BlockedContactsScreen.tsx
 * Wired from SettingsScreen privacy tab (patch P-10): the old UI showed
 * only "{n} contacts" and a toast saying "manage from their chat screens".
 * This screen lists each blocked contact (name + avatar from the users
 * collection) with a working Unblock button, and a note that unblocking
 * does not restore messages sent while blocked.
 *
 * STYLE (user requirement): Style 1 — WhatsApp Classic Pro ONLY.
 * Deep green header #075E54, clean white background (#DCF8C6 sent
 * bubbles where applicable), dark theme #0B141A / #111B21 / #005C4B.
 */
import { useState, useEffect } from 'react';
import { ArrowLeft, Ban, UserX } from 'lucide-react';
import { doc, getDoc, updateDoc, arrayRemove, auth, db } from '../../aws';
import { setBlockedIdsLocal } from '../../services/contacts';
import { avatarFallback } from '../../utils/avatar';

export default function BlockedContactsScreen({ onBack }: { onBack: () => void }) {
  const currentUser = auth.currentUser;
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    getDoc(doc(db, 'users', currentUser.uid))
      .then(async (snap) => {
        if (cancelled) return;
        const ids: string[] = snap.exists() ? ((snap.data() as any).blockedUsers || []) : [];
        setBlockedIds(ids);
        const found: Record<string, any> = {};
        // S21 (100-more): the old code fetched profiles for at most the
        // first 100 ids but rendered ALL blocked ids — anyone past #100
        // showed as "Unknown contact" though their profile exists. Fetch
        // in pages of 100 so every rendered row gets its real profile.
        for (let i = 0; i < ids.length; i += 100) {
          if (cancelled) return;
          await Promise.all(
            ids.slice(i, i + 100).map(async (id) => {
              try {
                const p = await getDoc(doc(db, 'users', id));
                if (p.exists()) found[id] = p.data();
              } catch { /* profile deleted / offline: fall back to id below */ }
            }),
          );
        }
        if (!cancelled) {
          setProfiles(found);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  const handleUnblock = async (targetUid: string) => {
    if (!currentUser || unblockingId) return;
    setUnblockingId(targetUid);
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { blockedUsers: arrayRemove(targetUid) });
      setBlockedIds((prev) => prev.filter((id) => id !== targetUid));
      // WA audit #9 — keep the localStorage blocked mirror in sync (see
      // contacts.ts): the call service reads it at ring time.
      setBlockedIdsLocal(currentUser.uid, blockedIds.filter((id) => id !== targetUid));
      showToastMsg('Contact unblocked ✓');
    } catch {
      showToastMsg('Could not unblock. Try again.');
    } finally {
      setUnblockingId(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6">
        <div className="flex items-center gap-2 mb-1">
          <button
            onClick={onBack}
            className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
            aria-label="Back to Privacy"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h2 className="text-lg font-medium">Blocked contacts</h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-text-secondary mb-4">
          Blocked contacts can&apos;t message or call you. Unblocking them does not restore
          messages sent while they were blocked.
        </p>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
          </div>
        ) : blockedIds.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 text-center">
            <Ban className="h-12 w-12 opacity-40" />
            <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">No blocked contacts yet</p>
            <p className="text-xs max-w-xs text-gray-500 dark:text-text-secondary">
              Block someone from their chat menu (⋮ → Block User).
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-white/5">
            {blockedIds.map((id) => {
              const p = profiles[id] || {};
              const name = p.displayName || p.username || 'Unknown contact';
              return (
                <div key={id} className="flex items-center gap-3 py-3">
                  <img
                    src={p.photoURL || avatarFallback(name, id)}
                    alt=""
                    className="h-11 w-11 rounded-full object-cover flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate text-gray-900 dark:text-text-primary">{name}</p>
                    {p.username && <p className="text-xs text-gray-500 dark:text-text-secondary truncate">@{p.username}</p>}
                  </div>
                  <button
                    onClick={() => handleUnblock(id)}
                    disabled={unblockingId === id}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#DCF8C6] dark:bg-[#005C4B] text-[#075E54] dark:text-white text-xs font-semibold disabled:opacity-40"
                  >
                    <UserX className="h-3.5 w-3.5" /> {unblockingId === id ? 'Unblocking…' : 'Unblock'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {toast && (
          <p role="status" className="text-center text-sm text-primary-green mt-4">{toast}</p>
        )}
      </div>
    </div>
  );
}
