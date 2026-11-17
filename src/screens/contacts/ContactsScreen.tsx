import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MessageSquare, Search, UserPlus, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { auth, db, doc, onSnapshot } from '../../aws';
import DefaultAvatar from '../../components/DefaultAvatar';
import {
  fetchUserProfile,
  loadBlockedIdsCached,
  loadSavedContacts,
  loadSavedContactsCached,
  normalizeUsername,
  saveSavedContacts,
  type PublicUserProfile,
  type SavedContact,
} from '../../services/contacts';

/**
 * Master-gaps: Contacts screen.
 *
 * - "My contacts": the user's saved contacts (users/{uid}.contacts, with a
 *   localStorage fallback). Tap a registered contact opens the DM
 *   (ChatScreen takes the peer uid as :chatId and derives the conversation
 *   id with getConversationId). Manual name+phone entries are honestly
 *   marked "Not on Pinglo" — tapping one says so instead of opening a
 *   chat that could never deliver.
 * - Worker B (phone-issues fix): this screen NO LONGER subscribes to the
 *   users collection and never lists all registered users — previously
 *   every new user showed up here (and the header counted them: "N
 *   people on Pinglo"). Saved contacts are enriched with one targeted
 *   profile read per saved uid (fetchUserProfile). Finding new people
 *   happens only via explicit username search (/search).
 * - "Add contact": add manually by name+phone, or find someone by
 *   @username on the Find people screen and add them from there.
 * - Blocked people never appear here (they stay in BlockedContactsScreen).
 * - No phone contact sync: reading the phone's address book needs a
 *   native plugin + permission flow that is not wired up (see note at the
 *   bottom of the screen).
 */
export default function ContactsScreen() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<SavedContact[]>(() =>
    currentUser ? loadSavedContactsCached(currentUser.uid) : []
  );
  // Targeted profiles for saved registered contacts only (one getDoc per
  // saved uid) — this is what used to come from the all-users subscription.
  const [profilesByUid, setProfilesByUid] = useState<Map<string, PublicUserProfile>>(new Map());
  const [, setBlockedIds] = useState<string[]>(() =>
    currentUser ? loadBlockedIdsCached(currentUser.uid) : []
  );
  const [toast, setToast] = useState('');
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [manualError, setManualError] = useState('');

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Live saved list + blocked ids from the own user doc only. Worker B:
  // the old all-users subscription is GONE — a new user joining must not
  // appear on anyone's Contacts screen. (Other screens that still list
  // users — Calls, Status, Broadcast, ChatScreen new-chat — are outside
  // Worker B's files; see PATCH-B follow-ups.)
  useEffect(() => {
    if (!currentUser) return;
    let unsubMe: (() => void) | null = null;
    try {
      unsubMe = onSnapshot(doc(db, 'users', currentUser.uid), (snap: any) => {
        if (snap?.exists?.()) {
          const data = snap.data() as any;
          if (Array.isArray(data.contacts)) setSaved(data.contacts as SavedContact[]);
          const blocked = data.blockedUsers ?? data.blocked;
          if (Array.isArray(blocked)) setBlockedIds(blocked.map(String));
        }
      });
    } catch { /* intentionally ignored */}
    void loadSavedContacts(currentUser.uid).then(setSaved).catch(() => {});
    return () => {
      try { unsubMe?.(); } catch { /* intentionally ignored */}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid]);

  // One targeted profile read per saved registered contact (avatar /
  // @username / bio for the row). Runs when the saved list changes.
  useEffect(() => {
    const uids = saved.filter((c) => c.uid).map((c) => c.uid as string);
    if (uids.length === 0) {
      setProfilesByUid(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      uids.map((uid) => fetchUserProfile(uid).then((p) => ({ uid, profile: p })))
    ).then((pairs) => {
      if (cancelled) return;
      setProfilesByUid((prev) => {
        const next = new Map(prev);
        pairs.forEach(({ uid, profile }) => {
          if (profile) next.set(uid, profile);
          else next.delete(uid);
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [saved]);

  // Saved contacts, enriched with the registered profile when known
  // (targeted per-uid read — see profilesByUid above).
  const savedRows = useMemo(
    () =>
      saved.map((c) => {
        const profile = c.uid ? profilesByUid.get(c.uid) || null : null;
        return { contact: c, profile };
      }),
    [saved, profilesByUid]
  );

  // R4 (Worker E, overnight round 2): strip a leading @ before matching —
  // the old bare `query.trim().toLowerCase()` kept the @, so "@demo" /
  // "@demo_user7" never matched a saved contact whose username is
  // "demo_user7" (live-confirmed in RETEST-ROUND2 §4 #4). Same strip
  // Worker B applied in searchSavedContactsByPrefix / UserSearchScreen.
  const filteredSaved = useMemo(() => {
    const q = normalizeUsername(query);
    if (!q) return savedRows;
    return savedRows.filter(
      ({ contact, profile }) =>
        contact.name.toLowerCase().includes(q) ||
        (contact.phone || '').toLowerCase().includes(q) ||
        String(profile?.username || '').toLowerCase().includes(q) ||
        String(profile?.displayName || '').toLowerCase().includes(q)
    );
  }, [savedRows, query]);

  const persist = async (next: SavedContact[]) => {
    setSaved(next);
    if (currentUser) await saveSavedContacts(currentUser.uid, next);
  };

  const handleManualAdd = async () => {
    const name = manualName.trim();
    if (!name) {
      setManualError('Enter a name.');
      return;
    }
    setManualError('');
    const phone = manualPhone.trim();
    const next: SavedContact[] = [
      ...saved,
      { name, phone: phone || undefined, addedAt: Date.now() },
    ];
    await persist(next);
    setManualName('');
    setManualPhone('');
    setShowManual(false);
    showToastMsg(`Added ${name} — not on Pinglo (name & phone only)`);
  };

  const handleRemove = async (contact: SavedContact) => {
    const next = saved.filter((c) => c !== contact);
    await persist(next);
    showToastMsg(`Removed ${contact.name} from contacts`);
  };

  const handleOpenContact = (row: { contact: SavedContact; profile: any | null }) => {
    if (row.contact.uid) {
      navigate(`/chat/${row.contact.uid}`);
    } else {
      showToastMsg(`${row.contact.name} isn't on Pinglo yet — share an invite so they can join.`);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark overflow-hidden">
      {/* Header */}
      <div className="pt-safe bg-header-green dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-3 py-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-full text-white hover:bg-white/10"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-white">Contacts</h1>
            <p className="text-xs text-white/70">
              {saved.length} saved
            </p>
          </div>
        </div>
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 bg-white dark:bg-input-dark rounded-full px-3 py-2">
            <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your contacts…"
              className="flex-1 bg-transparent outline-none text-sm text-gray-900 dark:text-text-primary placeholder:text-gray-400"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear search" className="p-0.5">
                <X className="h-4 w-4 text-gray-400" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Find people by username — the only way to discover new people.
            Worker B: the old "Find people on Pinglo" list (every
            registered user, searchable) is gone. People only appear when
            you type their exact @username on the Find people screen. */}
        <div className="mx-4 mt-4">
          <button
            onClick={() => navigate('/search')}
            className="w-full p-4 rounded-2xl bg-primary-green/10 border border-primary-green/30 hover:bg-primary-green/20 transition-all flex items-center gap-3 text-left"
          >
            <span className="h-11 w-11 rounded-full bg-green-cta text-white flex items-center justify-center flex-shrink-0 text-lg font-bold">
              @
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-semibold text-gray-900 dark:text-text-primary">
                Find people by username
              </span>
              <span className="block text-xs text-gray-500 dark:text-text-secondary mt-0.5">
                Type their exact @username — no list of all users, people only appear when you search.
              </span>
            </span>
            <UserPlus className="h-5 w-5 text-primary-green flex-shrink-0" />
          </button>
        </div>

        {/* My contacts */}
        <div className="px-4 pt-4 pb-1">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
            My contacts
          </h2>
        </div>
        {filteredSaved.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-400 dark:text-text-secondary">
            {query
              ? 'No saved contact matches that search.'
              : 'No contacts saved yet. Find people by username above, or add someone manually.'}
          </p>
        ) : (
          filteredSaved.map(({ contact, profile }) => (
            <div
              key={`${contact.uid || 'manual'}-${contact.addedAt}-${contact.name}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-panel-dark/50 cursor-pointer border-b border-gray-100 dark:border-white/5"
              onClick={() => handleOpenContact({ contact, profile })}
            >
              <DefaultAvatar
                name={contact.name}
                seed={contact.uid || contact.name}
                photoURL={profile?.photoURL || null}
                size={44}
              />
              <div className="flex-1 min-w-0">
                <p className="text-[15px] text-gray-900 dark:text-text-primary truncate">
                  {contact.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-text-secondary truncate">
                  {profile?.username ? (
                    <>@{profile.username}</>
                  ) : contact.phone ? (
                    <>{contact.phone} · Not on Pinglo</>
                  ) : (
                    <>Not on Pinglo</>
                  )}
                </p>
              </div>
              {contact.uid ? (
                <MessageSquare className="h-5 w-5 text-primary-green flex-shrink-0" />
              ) : (
                <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary flex-shrink-0">
                  Not on Pinglo
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handleRemove(contact);
                }}
                aria-label={`Remove ${contact.name} from contacts`}
                className="p-2 rounded-full text-gray-400 hover:text-danger-red flex-shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))
        )}

        {/* Manual add */}
        <div className="px-4 pt-5 pb-2">
          <button
            onClick={() => setShowManual((v) => !v)}
            className="w-full py-2.5 bg-primary-green/10 border border-primary-green/30 text-primary-green rounded-xl font-medium hover:bg-primary-green/20 transition-all flex items-center justify-center gap-2"
          >
            <UserPlus className="h-4 w-4" /> Add a contact manually
          </button>
          {showManual && (
            <div className="mt-3 p-4 rounded-2xl bg-white dark:bg-panel-dark border border-gray-100 dark:border-white/5 space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-text-secondary">Name</label>
                <input
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  className="w-full border-b border-primary-green bg-transparent py-1 outline-none text-gray-900 dark:text-text-primary"
                  placeholder="e.g. Mom"
                  maxLength={50}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-text-secondary">Phone (optional)</label>
                <input
                  value={manualPhone}
                  onChange={(e) => setManualPhone(e.target.value)}
                  className="w-full border-b border-primary-green bg-transparent py-1 outline-none text-gray-900 dark:text-text-primary"
                  placeholder="+91 …"
                  inputMode="tel"
                  autoComplete="tel"
                />
              </div>
              {manualError && <p className="text-xs text-danger-red">{manualError}</p>}
              <p className="text-xs text-gray-400 dark:text-text-secondary">
                Saved by name &amp; phone only — marked &ldquo;Not on Pinglo&rdquo; until
                they join with a matching account.
              </p>
              <button
                onClick={handleManualAdd}
                className="w-full py-2.5 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green"
              >
                Save contact
              </button>
            </div>
          )}
        </div>

        <p className="px-4 py-4 text-xs text-gray-400 dark:text-text-secondary leading-relaxed">
          Phone contact sync isn&apos;t available yet — the app can&apos;t read your
          phone&apos;s address book (that needs a native contacts plugin and
          permission flow). Contacts you add here are stored in your Pinglo
          account (and on this device as a backup). Blocked people never
          appear here; manage them in Settings → Privacy → Blocked contacts.
        </p>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm px-4 py-2.5 rounded-full shadow-2xl max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
