import React, { useState, useEffect, useRef } from 'react';
import {
  ArrowLeft, Shield, Users, MessageSquare, Phone, Search,
  RefreshCw, AlertTriangle, Mail, Video, X
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, onSnapshot, auth, db } from '../../aws';
import { isAdminUser, adminService, AdminConversation } from '../../services/adminService';
import { loadGatedContactsDetailed, getAllowedContactUids, KNOWN_CONVS_CHANGED_EVENT } from '../../services/contacts';
import { navigationManager } from '../../services/navigation';
import { isOnline, lastSeenText } from '../../services/presence';
import { avatarFallback } from '../../utils/avatar';

export default function AdminDashboardScreen() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const isAuthorized = isAdminUser(currentUser);

  const [activeTab, setActiveTab] = useState<'chats' | 'users' | 'calls' | 'feedback'>('chats');
  const [users, setUsers] = useState<any[]>([]);
  const [conversations, setConversations] = useState<AdminConversation[]>([]);
  const [calls, setCalls] = useState<any[]>([]);
  const [feedback, setFeedback] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [, setLoading] = useState(true);

  // Chat Transcript Inspector Modal
  const [inspectChat, setInspectChat] = useState<{ id: string; title: string; messages: any[] } | null>(null);

  // Hardware / In-app back navigation
  useEffect(() => {
    return navigationManager.pushHandler(() => {
      if (inspectChat) {
        setInspectChat(null);
        return true;
      }
      navigate(-1);
      return true;
    });
  }, [inspectChat, navigate]);

  // W28: gated users — the admin tab no longer subscribes to the whole
  // `users` collection. It lists only people the admin has chatted with
  // or saved (loadGatedContacts), refreshed when the chats collection
  // changes. A real admin user directory needs the server-side admin API
  // (backend-phase); this client must not enumerate all users.
  const gatedUidsKeyRef = useRef('');
  const gatedLoadedRef = useRef(false);
  // 100M-C1: a partial load (some allowed uid had no profile doc yet)
  // must not latch — the next trigger retries. Throttled so a profile
  // that never arrives doesn't re-read on every chats snapshot.
  const gatedRetryAtRef = useRef(0);
  useEffect(() => {
    if (!isAuthorized || !currentUser) return;

    const runGatedUsers = async (force = false) => {
      try {
        const uids = [...new Set(getAllowedContactUids(currentUser.uid))].sort();
        const key = uids.join(',');
        if (!force && key === gatedUidsKeyRef.current && gatedLoadedRef.current) return;
        if (!force && !gatedLoadedRef.current && gatedRetryAtRef.current && Date.now() - gatedRetryAtRef.current < 15000) return;
        const { list, unresolvedUids } = await loadGatedContactsDetailed(currentUser.uid);
        if (unresolvedUids.length === 0) {
          gatedUidsKeyRef.current = key;
          gatedLoadedRef.current = true;
        } else {
          gatedLoadedRef.current = false;
          gatedRetryAtRef.current = Date.now();
        }
        setUsers(list.filter((u: any) => u.displayName || u.username || u.email));
      } catch {
        /* offline: keep the previous list */
      }
    };
    void runGatedUsers();
    const unsubChats = onSnapshot(collection(db, 'chats'), () => { void runGatedUsers(); });
    // W28 R5: re-run when background discovery memos a new conversation
    // (localStorage write — no chats snapshot fires for it). 100M-C1:
    // force the re-read — the uid SET may be unchanged while a profile
    // arrived after the first (partial) load.
    const onKnownConvs = () => { void runGatedUsers(true); };
    window.addEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);

    // Load All Calls
    const unsubCalls = onSnapshot(collection(db, 'calls'), (snap) => {
      const allCalls = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a: any, b: any) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
      setCalls(allCalls);
    });

    // Load All Feedback
    const unsubFeedback = onSnapshot(collection(db, 'feedback'), (snap) => {
      const allFb = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a: any, b: any) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));
      setFeedback(allFb);
    });

    loadConversations();

    return () => {
      window.removeEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
      try { unsubChats(); } catch (err) { console.warn("[AdminDashboardScreen] AdminDashboardScreen: unsubChats() failed", err); }
      unsubCalls();
      unsubFeedback();
    };
  }, [isAuthorized]);

  const loadConversations = async () => {
    setLoading(true);
    try {
      const convs = await adminService.getActiveConversations();
      setConversations(convs);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenInspector = (conv: AdminConversation) => {
    const msgs = db.getCollectionDocs(`chats/${conv.id}/messages`);
    const sorted = msgs.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    setInspectChat({
      id: conv.id,
      title: conv.isCommunity ? (conv.communityName || 'Group') : `${conv.userA.name} ↔ ${conv.userB.name}`,
      messages: sorted,
    });
  };

  const formatTime = (ts: any) => {
    if (!ts) return 'Just now';
    const d = ts.toDate ? ts.toDate() : new Date(Number(ts) || Date.now());
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
  };

  if (!isAuthorized) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-bg-light dark:bg-bg-dark p-6 text-center">
        <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 mb-4">
          <AlertTriangle className="h-8 w-8" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-text-primary">Access Restricted</h2>
        <p className="mt-2 text-sm text-gray-500 max-w-sm">
          This Admin Command Center is reserved exclusively for authorized administrators — contact the app administrator if you need access.
        </p>
        <button
          onClick={() => navigate('/main')}
          className="mt-6 px-6 py-2.5 rounded-full bg-green-cta text-white font-medium hover:bg-dark-green transition-all"
        >
          Return to Chats
        </button>
      </div>
    );
  }

  const onlineCount = users.filter(u => isOnline(u)).length;

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary select-none">
      {/* Top Header — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
              <ArrowLeft className="h-6 w-6 text-gray-700 dark:text-text-primary" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold text-gray-900 dark:text-text-primary">Admin Command Center</h1>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  👑 Super Admin
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-text-secondary">{currentUser?.email}</p>
            </div>
          </div>

          <button
            onClick={loadConversations}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-primary-green transition-transform active:rotate-180"
            title="Refresh Data"
          >
            <RefreshCw className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Analytics Summary Cards */}
      <div className="grid grid-cols-4 gap-2 p-3 bg-panel-light/50 dark:bg-panel-dark/50 border-b border-gray-200 dark:border-white/5">
        <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-panel-light dark:bg-input-dark border border-gray-200 dark:border-white/5 shadow-sm">
          <Users className="h-5 w-5 text-blue-400 mb-1" />
          <span className="text-lg font-bold">{users.length}</span>
          <span className="text-[10px] text-gray-500 dark:text-text-secondary uppercase tracking-wider font-semibold">Users</span>
        </div>

        <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-panel-light dark:bg-input-dark border border-gray-200 dark:border-white/5 shadow-sm">
          <span className="h-3 w-3 rounded-full bg-primary-green animate-pulse my-1" />
          <span className="text-lg font-bold text-primary-green">{onlineCount}</span>
          <span className="text-[10px] text-gray-500 dark:text-text-secondary uppercase tracking-wider font-semibold">Online</span>
        </div>

        <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-panel-light dark:bg-input-dark border border-gray-200 dark:border-white/5 shadow-sm">
          <MessageSquare className="h-5 w-5 text-emerald-400 mb-1" />
          <span className="text-lg font-bold">{conversations.length}</span>
          <span className="text-[10px] text-gray-500 dark:text-text-secondary uppercase tracking-wider font-semibold">Chats</span>
        </div>

        <div className="flex flex-col items-center justify-center p-2.5 rounded-xl bg-panel-light dark:bg-input-dark border border-gray-200 dark:border-white/5 shadow-sm">
          <Phone className="h-5 w-5 text-purple-400 mb-1" />
          <span className="text-lg font-bold">{calls.length}</span>
          <span className="text-[10px] text-gray-500 dark:text-text-secondary uppercase tracking-wider font-semibold">Calls</span>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-gray-200 dark:border-white/10 px-3 bg-panel-light dark:bg-panel-dark gap-2 pt-2">
        <button
          onClick={() => setActiveTab('chats')}
          className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-all ${
            activeTab === 'chats'
              ? 'border-primary-green text-primary-green'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Chats Monitor ({conversations.length})
        </button>

        <button
          onClick={() => setActiveTab('users')}
          className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-all ${
            activeTab === 'users'
              ? 'border-primary-green text-primary-green'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Users ({users.length})
        </button>

        <button
          onClick={() => setActiveTab('calls')}
          className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-all ${
            activeTab === 'calls'
              ? 'border-primary-green text-primary-green'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Calls ({calls.length})
        </button>

        <button
          onClick={() => setActiveTab('feedback')}
          className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wider border-b-2 transition-all ${
            activeTab === 'feedback'
              ? 'border-primary-green text-primary-green'
              : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          Tickets ({feedback.length})
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Search Bar */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            placeholder={`Search ${activeTab}...`}
            className="w-full bg-panel-light dark:bg-input-dark rounded-xl pl-9 pr-4 py-2.5 text-sm border border-gray-200 dark:border-white/5 outline-none focus:ring-1 focus:ring-primary-green"
          />
        </div>

        {/* ── TAB 1: CONVERSATIONS MONITOR ("Kon Kise Baat Kar Raha H") ── */}
        {activeTab === 'chats' && (
          <div className="space-y-3">
            {conversations
              .filter(c => {
                if (!searchQ) return true;
                const q = searchQ.toLowerCase();
                return (
                  c.userA.name.toLowerCase().includes(q) ||
                  c.userB.name.toLowerCase().includes(q) ||
                  (c.userA.email && c.userA.email.toLowerCase().includes(q)) ||
                  (c.userB.email && c.userB.email.toLowerCase().includes(q))
                );
              })
              .map(conv => (
                <div
                  key={conv.id}
                  onClick={() => handleOpenInspector(conv)}
                  className="p-4 rounded-2xl bg-panel-light dark:bg-panel-dark border border-gray-200 dark:border-white/5 shadow-sm hover:border-primary-green/40 cursor-pointer transition-all active:scale-[0.99]"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-primary-green">
                        {conv.userA.name}
                      </span>
                      <span className="text-xs text-gray-400">↔</span>
                      <span className="font-semibold text-sm text-blue-400">
                        {conv.userB.name}
                      </span>
                    </div>

                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-input-dark text-gray-400">
                      {conv.messageCount} msgs
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs text-gray-500 dark:text-text-secondary">
                    <p className="truncate max-w-[70%]">
                      {conv.lastMessage || 'No messages exchanged yet'}
                    </p>
                    <span>{formatTime(conv.lastTimestamp)}</span>
                  </div>
                </div>
              ))}

            {conversations.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                <MessageSquare className="h-10 w-10 mx-auto opacity-30 mb-2" />
                <p>No active conversations found yet.</p>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: REGISTERED USERS ("Kitne User H") ── */}
        {activeTab === 'users' && (
          <div className="space-y-2.5">
            <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed px-1">
              Showing people you have chatted with or saved — the full user directory is not available in the app. Full user management needs the server-side admin API (backend task).
            </p>
            {users
              .filter(u => {
                if (!searchQ) return true;
                const q = searchQ.toLowerCase();
                return (
                  (u.displayName && u.displayName.toLowerCase().includes(q)) ||
                  (u.username && u.username.toLowerCase().includes(q)) ||
                  (u.email && u.email.toLowerCase().includes(q))
                );
              })
              .map(u => (
                <div
                  key={u.id}
                  className="flex items-center justify-between p-3.5 rounded-2xl bg-panel-light dark:bg-panel-dark border border-gray-200 dark:border-white/5 shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <img
                        src={u.photoURL || avatarFallback(u.displayName || 'User', u.id)}
                        alt={u.displayName}
                        className="h-11 w-11 rounded-full object-cover"
                      />
                      <span
                        className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-panel-dark ${
                          isOnline(u) ? 'bg-primary-green' : 'bg-gray-500'
                        }`}
                      />
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold text-sm">{u.displayName || u.username}</h4>
                        {isAdminUser(u) && (
                          <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 font-bold">
                            ADMIN
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400">{u.email || `@${u.username}`}</p>
                    </div>
                  </div>

                  <span className={`text-xs font-medium ${isOnline(u) ? 'text-primary-green' : 'text-gray-500'}`}>
                    {isOnline(u) ? 'Active Now' : lastSeenText(u)}
                  </span>
                </div>
              ))}
          </div>
        )}

        {/* ── TAB 3: CALL LOGS ── */}
        {activeTab === 'calls' && (
          <div className="space-y-2.5">
            {calls.map(c => (
              <div
                key={c.id}
                className="flex items-center justify-between p-3.5 rounded-2xl bg-panel-light dark:bg-panel-dark border border-gray-200 dark:border-white/5 shadow-sm text-xs"
              >
                <div className="flex items-center gap-3">
                  <div className={`p-2.5 rounded-full ${c.type === 'video' ? 'bg-blue-500/10 text-blue-400' : 'bg-primary-green/10 text-primary-green'}`}>
                    {c.type === 'video' ? <Video className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
                  </div>
                  <div>
                    <p className="font-semibold text-sm">
                      {c.callerName} ➔ {c.receiverName}
                    </p>
                    <p className="text-gray-400 text-[11px] capitalize">Status: {c.status}</p>
                  </div>
                </div>
                <span className="text-gray-400">{formatTime(c.timestamp)}</span>
              </div>
            ))}

            {calls.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                <Phone className="h-10 w-10 mx-auto opacity-30 mb-2" />
                <p>No call records found yet.</p>
              </div>
            )}
          </div>
        )}

        {/* ── TAB 4: FEEDBACK & TICKETS ── */}
        {activeTab === 'feedback' && (
          <div className="space-y-3">
            {feedback.map(fb => (
              <div
                key={fb.id}
                className="p-4 rounded-2xl bg-panel-light dark:bg-panel-dark border border-gray-200 dark:border-white/5 shadow-sm space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm text-primary-green">{fb.userName || 'Anonymous'}</span>
                  <span className="text-xs text-gray-400">{formatTime(fb.timestamp)}</span>
                </div>
                <p className="text-xs text-gray-400">{fb.userEmail}</p>
                <p className="text-sm text-gray-200 whitespace-pre-wrap mt-1 bg-black/20 p-2.5 rounded-xl border border-white/5">
                  {fb.message}
                </p>
              </div>
            ))}

            {feedback.length === 0 && (
              <div className="text-center py-12 text-gray-500">
                <Mail className="h-10 w-10 mx-auto opacity-30 mb-2" />
                <p>No feedback messages submitted yet.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Read-Only Chat Transcript Inspector Modal */}
      {inspectChat && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 animate-fade-in" onClick={() => setInspectChat(null)}>
          <div
            className="w-full max-w-lg bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl flex flex-col max-h-[85vh] border border-white/10"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-white/10">
              <div>
                <h3 className="font-bold text-base flex items-center gap-2">
                  <Shield className="h-4 w-4 text-primary-green" /> {inspectChat.title}
                </h3>
                <span className="text-xs text-gray-400">Total messages: {inspectChat.messages.length}</span>
              </div>
              <button onClick={() => setInspectChat(null)} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>

            {/* Transcript Messages Body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {inspectChat.messages.map((m, i) => (
                <div key={i} className="flex flex-col bg-black/20 p-3 rounded-xl border border-white/5">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-primary-green">{m.senderName || 'User'}</span>
                    <span className="text-gray-400">{formatTime(m.timestamp)}</span>
                  </div>
                  {m.text && <p className="text-sm text-gray-200 whitespace-pre-wrap">{m.text}</p>}
                  {m.mediaUrl && (
                    <div className="mt-2 text-xs text-blue-400 underline">
                      <a href={m.mediaUrl} target="_blank" rel="noreferrer">View Media Attachment</a>
                    </div>
                  )}
                </div>
              ))}

              {inspectChat.messages.length === 0 && (
                <p className="text-center text-sm text-gray-500 py-6">No messages found in this chat yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
