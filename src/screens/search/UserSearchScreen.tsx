import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, MessageSquare, Search, UserPlus, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { auth, db, doc, onSnapshot } from '../../aws';
import DefaultAvatar from '../../components/DefaultAvatar';
import {
  fetchUserProfile,
  loadBlockedIdsCached,
  loadSavedContactsCached,
  lookupUsersByUsername,
  normalizeUsername,
  saveSavedContacts,
  searchSavedContactsByPrefix,
  type PublicUserProfile,
  type SavedContact,
} from '../../services/contacts';

/**
 * Worker B (phone-issues fix): WhatsApp-style find-by-username.
 *
 * Discovery rule (see PATCH-B): nobody browses all users. A person
 * appears here ONLY when the signed-in user types their exact @username
 * (one-shot filtered lookup — `lookupUsersByUsername` in services/
 * contacts.ts) or when they already match among the user's own saved
 * contacts (prefix match over the user's own data). There is no
 * "all users" / "new users" list anywhere on this screen.
 *
 * Honest limits, shown on the screen itself:
 * - Exact username match only. The data layer has no prefix/beginsWith
 *   operator, so true prefix search needs a backend username index.
 * - A user who never set a username cannot be found by search.
 * - Blocked people never appear in results.
 */
export default function UserSearchScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const currentUser = auth.currentUser;
  const [query, setQuery] = useState(() => searchParams.get('q') || '');
  const [status, setStatus] = useState<'idle' | 'searching' | 'ok' | 'unknown'>('idle');
  const [results, setResults] = useState<PublicUserProfile[]>([]);
  const [myProfile, setMyProfile] = useState<PublicUserProfile | null>(null);
  const [saved, setSaved] = useState<SavedContact[]>(() =>
    currentUser ? loadSavedContactsCached(currentUser.uid) : []
  );
  const [profilesByUid, setProfilesByUid] = useState<Map<string, PublicUserProfile>>(new Map());
  const [blockedIds, setBlockedIds] = useState<string[]>(() =>
    currentUser ? loadBlockedIdsCached(currentUser.uid) : []
  );
  const [toast, setToast] = useState('');
  const [retrySeq, setRetrySeq] = useState(0);
  const [pendingAdd, setPendingAdd] = useState<PublicUserProfile | null>(null);
  const [nickname, setNickname] = useState('');
  const debounceRef = useRef<any>(null);
  const lookupSeqRef = useRef(0);

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // Own profile (shows "Your username is @…" / "set a username" hint) and
  // the saved-contacts list with one targeted profile read per saved uid —
  // never a subscription to, or listing of, the users collection.
  // The own-doc subscription below keeps `saved` live: on a fresh load the
  // one-shot reads above can run before the users collection has been
  // restored from the local cache, and must not leave the list empty.
  // W18f (100M-T2-2): the SAME cold-mount race hit `blockedIds` — it was
  // read once in a useState initializer and never re-read, so a blocked
  // person could appear in results on the first search after a fresh
  // boot. The blocked list lives on this same own-doc (`blockedUsers`),
  // so the subscription below is also its source of truth: it updates
  // `blockedIds` whenever the own-doc snapshot delivers.
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
    return () => {
      try { unsubMe?.(); } catch { /* intentionally ignored */}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!currentUser) return;
    void fetchUserProfile(currentUser.uid).then(setMyProfile).catch(() => {});
    // NOTE: `saved` is NOT set from a one-shot loadSavedContacts() here.
    // That one-shot can resolve [] after the own-doc subscription above
    // has already delivered the true list (its network read fails in
    // mock / offline mode while the cache restore is still landing) and
    // would wipe the list. The subscription is the source of truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.uid]);

  // One targeted profile read per saved registered contact, re-run when
  // the saved list changes (e.g. once the own-doc subscription delivers).
  useEffect(() => {
    const uids = saved.filter((c) => c.uid).map((c) => c.uid as string);
    if (uids.length === 0) return;
    let cancelled = false;
    void Promise.all(
      uids.map((uid) => fetchUserProfile(uid).then((p) => ({ uid, profile: p })))
    ).then((pairs) => {
      if (cancelled) return;
      setProfilesByUid((prev) => {
        const next = new Map(prev);
        pairs.forEach(({ uid, profile }) => {
          if (profile) next.set(uid, profile);
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [saved]);

  const blockedSet = useMemo(() => new Set(blockedIds), [blockedIds]);
  const savedByUid = useMemo(() => {
    const map = new Map<string, SavedContact>();
    saved.forEach((c) => {
      if (c.uid) map.set(c.uid, c);
    });
    return map;
  }, [saved]);

  const normalized = normalizeUsername(query);
  const isOwnUsername =
    normalized.length > 0 &&
    !!myProfile?.username &&
    normalizeUsername(myProfile.username) === normalized;

  // Debounced exact-username lookup. Only the typed query is ever sent;
  // the lookup unsubscribes after the first matching snapshot.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (isOwnUsername) {
      setStatus('ok');
      setResults([]);
      return;
    }
    if (normalized.length < 2) {
      setStatus('idle');
      setResults([]);
      return;
    }
    setStatus('searching');
    const seq = ++lookupSeqRef.current;
    debounceRef.current = setTimeout(() => {
      void lookupUsersByUsername(normalized, currentUser?.uid).then((res) => {
        if (lookupSeqRef.current !== seq) return; // a newer query superseded this one
        if (res.status === 'unknown') {
          setResults([]);
          setStatus('unknown');
          return;
        }
        setResults(res.users.filter((u) => !blockedSet.has(String(u.id))));
        setStatus('ok');
      });
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalized, isOwnUsername, currentUser?.uid, retrySeq]);

  // W18f (100M-T2-2): the lookup above filters against `blockedSet` at
  // lookup time, but a search that ran BEFORE the own-doc subscription
  // delivered the block list already rendered the blocked card. Re-filter
  // live results whenever the block list arrives — a blocked person must
  // vanish from the current results without the user re-typing.
  // (Unblocking cannot happen from this screen, so a stale-empty result
  // after unblock is not a case here; the next lookup re-reads anyway.)
  useEffect(() => {
    setResults((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((u) => !blockedSet.has(String(u.id)));
      return next.length === prev.length ? prev : next;
    });
  }, [blockedSet]);

  // Prefix matches over the user's OWN saved contacts only (never a
  // directory of all users). Exact-match ids are not repeated here.
  const contactMatches = useMemo(() => {
    if (normalized.length < 2 || isOwnUsername) return [];
    const exactIds = new Set(results.map((r) => String(r.id)));
    return searchSavedContactsByPrefix(normalized, saved, profilesByUid).filter(
      ({ contact }) =>
        contact.uid && !exactIds.has(String(contact.uid)) && !blockedSet.has(String(contact.uid))
    );
  }, [normalized, isOwnUsername, results, saved, profilesByUid, blockedSet]);

  const handleAddContact = async () => {
    if (!pendingAdd || !currentUser) return;
    const name = nickname.trim();
    if (!name) {
      showToastMsg('Enter a name for this contact.');
      return;
    }
    const next: SavedContact[] = [
      ...saved,
      { uid: String(pendingAdd.id), name, addedAt: Date.now() },
    ];
    setSaved(next);
    await saveSavedContacts(currentUser.uid, next);
    setProfilesByUid((prev) => new Map(prev).set(String(pendingAdd.id), pendingAdd));
    setPendingAdd(null);
    setNickname('');
    showToastMsg(`Added ${name} to contacts ✓`);
  };

  const renderResultCard = (profile: PublicUserProfile, opts?: { fromContacts?: boolean }) => {
    const isSaved = savedByUid.has(String(profile.id));
    const isPending = pendingAdd?.id === profile.id;
    return (
      <div
        key={profile.id}
        role="button"
        tabIndex={0}
        onClick={() => navigate(`/chat/${profile.id}`)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigate(`/chat/${profile.id}`);
          }
        }}
        className="mx-4 mt-3 rounded-2xl bg-white dark:bg-panel-dark border border-gray-100 dark:border-white/5 p-4 cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <DefaultAvatar
            name={profile.displayName || profile.username || 'User'}
            seed={profile.id}
            photoURL={profile.photoURL || null}
            size={52}
          />
          <div className="flex-1 min-w-0">
            <p className="text-[15px] font-semibold text-gray-900 dark:text-text-primary truncate">
              {profile.displayName || profile.username}
            </p>
            {profile.username && (
              <p className="text-sm text-primary-green font-mono truncate">@{profile.username}</p>
            )}
            {profile.bio ? (
              <p className="text-xs text-gray-500 dark:text-text-secondary truncate mt-0.5">
                {profile.bio}
              </p>
            ) : (
              <p className="text-xs text-gray-400 dark:text-text-secondary mt-0.5">
                No bio yet
              </p>
            )}
          </div>
          {isSaved && (
            <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-primary-green/10 text-primary-green flex-shrink-0">
              Saved
            </span>
          )}
        </div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/chat/${profile.id}`);
            }}
            className="flex-1 py-2.5 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green flex items-center justify-center gap-2"
          >
            <MessageSquare className="h-4 w-4" /> Message
          </button>
          {!isSaved && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPendingAdd(profile);
                setNickname(profile.displayName || profile.username || '');
              }}
              className="flex-1 py-2.5 bg-primary-green/10 border border-primary-green/30 text-primary-green rounded-xl font-medium hover:bg-primary-green/20 flex items-center justify-center gap-2"
            >
              <UserPlus className="h-4 w-4" /> Add to contacts
            </button>
          )}
        </div>
        {isPending && (
          <div className="mt-3" onClick={(e) => e.stopPropagation()}>
            <label className="block text-xs text-gray-500 dark:text-text-secondary mb-1">
              Name in your contacts (nickname)
            </label>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="w-full bg-gray-50 dark:bg-input-dark border border-gray-200 dark:border-white/10 rounded-xl px-3 py-2 text-sm outline-none text-gray-900 dark:text-text-primary"
              placeholder="e.g. Rahul (Gym)"
              maxLength={50}
              autoFocus
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={handleAddContact}
                className="flex-1 py-2 bg-green-cta text-white rounded-xl text-sm font-medium hover:bg-dark-green"
              >
                Add to contacts
              </button>
              <button
                onClick={() => setPendingAdd(null)}
                className="flex-1 py-2 bg-gray-100 dark:bg-input-dark rounded-xl text-sm font-medium text-gray-600 dark:text-text-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {opts?.fromContacts && (
          <p className="text-[11px] text-gray-400 dark:text-text-secondary mt-2">
            From your saved contacts
          </p>
        )}
      </div>
    );
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
            <h1 className="text-lg font-semibold text-white">Find people</h1>
            <p className="text-xs text-white/70">Search by username</p>
          </div>
        </div>
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 bg-white dark:bg-input-dark rounded-full px-3 py-2">
            <span className="text-primary-green dark:text-primary-green font-semibold flex-shrink-0">@</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="username"
              aria-label="Search by username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent outline-none text-sm text-gray-900 dark:text-text-primary placeholder:text-gray-400"
            />
            {query ? (
              <button onClick={() => setQuery('')} aria-label="Clear search" className="p-0.5">
                <X className="h-4 w-4 text-gray-400" />
              </button>
            ) : (
              <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-6">
        {/* Own username — so the user knows what others type to find them. */}
        <div className="mx-4 mt-4 rounded-2xl bg-primary-green/10 border border-primary-green/30 px-4 py-3">
          {myProfile?.username ? (
            <p className="text-sm text-gray-700 dark:text-text-primary">
              Your username is <span className="font-mono font-semibold text-primary-green">@{myProfile.username}</span> — share it so people can find you.
            </p>
          ) : (
            <p className="text-sm text-gray-700 dark:text-text-primary">
              You haven&apos;t set a username yet —{' '}
              <button onClick={() => navigate('/settings')} className="text-primary-green font-semibold underline">
                set one in Settings → Profile
              </button>{' '}
              so people can find you by username.
            </p>
          )}
        </div>

        {/* Idle / hint */}
        {status === 'idle' && (
          <p className="px-4 py-4 text-sm text-gray-400 dark:text-text-secondary leading-relaxed">
            Type someone&apos;s exact @username (with or without @) to find them — e.g. @rahul_sharma.
            People only appear when you search for them; there is no list of all users here.
          </p>
        )}

        {/* Searching */}
        {status === 'searching' && (
          <p className="px-4 py-4 text-sm text-gray-400 dark:text-text-secondary">
            Searching for @{normalized}…
          </p>
        )}

        {/* Own username typed */}
        {status === 'ok' && isOwnUsername && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 dark:text-text-secondary px-6 text-center">
            <DefaultAvatar
              name={myProfile?.displayName || myProfile?.username || 'You'}
              seed={currentUser?.uid}
              photoURL={myProfile?.photoURL || null}
              size={64}
            />
            <p className="text-base font-medium text-gray-900 dark:text-text-primary">
              That&apos;s you — @{myProfile?.username}
            </p>
            <p className="text-sm">You can&apos;t message yourself from here. Your Saved Messages are on the Chats tab.</p>
          </div>
        )}

        {/* No match */}
        {status === 'ok' && !isOwnUsername && normalized.length >= 2 && results.length === 0 && contactMatches.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 dark:text-text-secondary px-6 text-center">
            <Search className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium text-gray-900 dark:text-text-primary">
              No user found for @{normalized}
            </p>
            <p className="text-sm">
              Check the spelling, or ask them for their exact username. Someone who hasn&apos;t set a
              username yet can&apos;t be found by search.
            </p>
          </div>
        )}

        {/* Lookup failed (offline / backend unreachable) */}
        {status === 'unknown' && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-400 dark:text-text-secondary px-6 text-center">
            <Search className="h-14 w-14 opacity-20" />
            <p className="text-base font-medium text-gray-900 dark:text-text-primary">
              Couldn&apos;t search right now
            </p>
            <p className="text-sm">Check your connection and try again.</p>
            <button
              onClick={() => setRetrySeq((n) => n + 1)}
              className="mt-1 px-4 py-2 bg-green-cta text-white rounded-xl text-sm font-medium"
            >
              Retry
            </button>
          </div>
        )}

        {/* Exact-match results */}
        {status === 'ok' && results.length > 0 && (
          <>
            <p className="px-4 pt-4 pb-1 text-sm font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
              People
            </p>
            {results.map((p) => renderResultCard(p))}
          </>
        )}

        {/* Prefix matches among the user's own saved contacts */}
        {contactMatches.length > 0 && (
          <>
            <p className="px-4 pt-5 pb-1 text-sm font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
              From your contacts
            </p>
            {contactMatches.map(({ contact, profile }) =>
              renderResultCard(
                profile || {
                  id: contact.uid as string,
                  displayName: contact.name,
                },
                { fromContacts: true }
              )
            )}
          </>
        )}

        <p className="px-4 pt-6 text-xs text-gray-400 dark:text-text-secondary leading-relaxed">
          Search finds people by their exact username. Prefix search isn&apos;t available yet — it
          needs a server-side username index. Nobody can browse all Pinglo users; a person only
          appears when you search for them, or when you&apos;ve already chatted with them or saved
          them as a contact.
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
