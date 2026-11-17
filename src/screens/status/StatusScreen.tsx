import React, { useState, useEffect, useRef } from 'react';
import { Camera, MoreVertical, Search, X, Lock, Globe, ChevronDown, ChevronRight, Type, Trash2, Eye, Users, UserX, UserCheck, Check, MessageCircle, VolumeX, Volume2, CircleDashed, Mic, Square, Smile, Megaphone, Send, Pencil, Link2, AtSign, Plus, Download, Flag, Forward, Bell, BellOff, Heart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, doc, getDoc, deleteDoc, updateDoc, arrayUnion, deleteField, auth, db } from '../../aws';
import { uploadChatMedia, isMediaTooLargeError, isLocalMediaUrl, deleteLocalMediaBlob } from '../../aws/storage';
import { loadGatedContactsDetailed, getAllowedContactUids, KNOWN_CONVS_CHANGED_EVENT } from '../../services/contacts';
import { getEnterIsSend } from '../../services/appSettings';
import { getDefaultStatusAllow, getDefaultStatusExclude, getDefaultStatusPrivacy, setDefaultStatusAllow, setDefaultStatusExclude } from '../../services/presence';
import { navigationManager } from '../../services/navigation';
import { getConversationId, realtimeSync, cleanId } from '../../services/realtimeSync';
import { isGroupMember, getSubscriberCount, formatMemberCount } from '../../components/groupAdmin';
import { savePendingShare } from '../../services/shareIntent';
import { takeQueuedChannelPostForStatus, ADD_TO_STATUS_EVENT, TEXT_STATUS_MAX_LEN } from '../../services/channelShareToStatus';
import { loadLocalChatPrefs, saveLocalChatPrefs } from '../../services/archiveFolders';
import { isEncryptionFailedError } from '../../services/e2eeChat';
import DefaultAvatar from '../../components/DefaultAvatar';
import ListSkeleton from '../../components/ListSkeleton';
import StatusRing from '../../components/StatusRing';
import VoiceNotePlayer from '../../components/VoiceNotePlayer';
import { getWaveformPeaks } from '../../services/waveform';
import { ALL_STICKERS } from '../../components/stickerPack';
import { isSafeHttpsUrl, normalizeStatusLink, linkHostLabel, parseStatusText, type StatusMention } from '../../utils/statusLinks';
import { useLanguage } from '../../services/language';

/**
 * Status privacy (Phase 3). Stored on each status doc:
 *   privacy: 'everyone' | 'contacts' | 'exclude' | 'nobody' | 'closeFriends'
 *   privacyAllow?: string[]   — for 'contacts': the poster's contacts at
 *                               post time (a snapshot; new contacts added
 *                               later don't retroactively gain access).
 *                               For 'closeFriends' (WA audit (d) S9): the
 *                               poster's Close Friends list at post time.
 *   privacyExclude?: string[] — for 'exclude': uids who must NOT see it.
 *   viewerTimes?: Record<uid, epoch ms> — when each viewer saw it, for the
 *                               who-viewed sheet (alongside `viewers`).
 *
 * Enforced client-side in the snapshot filter below. 'contacts' is
 * resolved from the gated contact set (saved contacts + proven DM
 * partners — see services/contacts.ts loadGatedContacts), hence the
 * post-time snapshot. W28: the snapshot used to be taken over ALL users,
 * so 'contacts' behaved exactly like 'everyone'. AUDIT-2 A7: the privacy
 * sheet therefore does NOT offer 'contacts' as a NEW choice, and the
 * label never claims contacts-only privacy for new posts. A stored
 * 'contacts' value (older default) is now genuinely contacts-only in
 * the client filter. This is a client-side filter only — the statuses
 * collection is still readable by any signed-in user, so it is
 * privacy-by-UI, not access control. Server rules are out of scope
 * (backend task).
 *
 * S9 — Close Friends: the list lives on the poster's own user doc
 * (`users/{uid}.closeFriends: string[]`, localStorage fallback
 * `pinglo:closeFriends:<uid>`, same pattern as mutedStatusUsers).
 * The sheet DOES offer it as a new choice (unlike 'contacts'): picking
 * it shows a contact picker for the list, and the post-time snapshot
 * goes into privacyAllow. The ring for a Close Friends group is purple
 * #C15ADD (WA token) — see StatusRing `closeFriends`.
 */
type StatusPrivacy = 'everyone' | 'contacts' | 'exclude' | 'onlyShare' | 'nobody' | 'closeFriends';

const PRIVACY_LABELS: Record<StatusPrivacy, string> = {
  everyone: 'Everyone',
  // W28: a stored 'contacts' value is now genuinely contacts-only (the
  // post-time snapshot is the gated contact set), so it is labelled
  // 'Contacts'. The sheet still does not offer it as a new choice.
  contacts: 'Contacts',
  exclude: 'Everyone except…',
  onlyShare: 'Only share with…',
  nobody: 'Only me',
  closeFriends: 'Close Friends',
};

const PRIVACY_ICONS: Record<StatusPrivacy, React.ReactNode> = {
  everyone: <Globe className="h-3.5 w-3.5 text-primary-green" />,
  contacts: <Users className="h-3.5 w-3.5 text-primary-green" />,
  exclude: <UserX className="h-3.5 w-3.5 text-primary-green" />,
  onlyShare: <UserCheck className="h-3.5 w-3.5 text-primary-green" />,
  nobody: <Lock className="h-3.5 w-3.5 text-gray-500" />,
  closeFriends: <Heart className="h-3.5 w-3.5 text-[#C15ADD]" />,
};

/** WA audit (d) S9 — Close Friends list on the viewer's own user doc. */
const closeFriendsKey = (uid: string) => `pinglo:closeFriends:${uid}`;
const loadLocalCloseFriends = (uid: string): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(closeFriendsKey(uid)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** WA audit (d) S22 — statuses the user reported, recorded on-device.
 * Client-side record only; there is no server moderation endpoint yet,
 * so a report is a local log + toast, never presented as a sent report. */
const reportedStatusesKey = (uid: string) => `pinglo:reportedStatuses:${uid}`;

/**
 * WA audit (d) S14 — text-status backgrounds + fonts. Stored alongside
 * textContent on the status doc as `bgStyle` / `fontStyle` (ids below);
 * the viewer renders the matching gradient/font, defaulting to teal/sans
 * for old docs. WA's exact palette was NOT FOUND in the extracted client,
 * so these are DT's own 4 backgrounds, not claimed WA values.
 */
const TEXT_STATUS_STYLES = [
  { id: 'teal', label: 'Teal', bg: 'from-[#128C7E] to-[#075E54]' },
  { id: 'purple', label: 'Purple', bg: 'from-[#7C3AED] to-[#4C1D95]' },
  { id: 'sunset', label: 'Sunset', bg: 'from-[#F97316] to-[#DC2626]' },
  { id: 'midnight', label: 'Midnight', bg: 'from-[#1E293B] to-[#0F172A]' },
] as const;
const TEXT_STATUS_FONTS = [
  { id: 'sans', label: 'Sans', cls: '' },
  { id: 'serif', label: 'Serif', cls: 'font-serif' },
] as const;

/**
 * Phase 4 — status reactions. Same 6-emoji quick set ChatScreen uses
 * (EMOJI_QUICK) and the same storage shape as message reactions:
 *   statuses/<id>.reactions = { [uid]: emoji }
 * Tapping your own emoji again removes it (deleteField on the nested key,
 * same as ChatScreen.addReaction). Counts are derived client-side.
 *
 * WA audit (d) S26 — VERIFY-FIRST, checked 2026-11-17 against the real
 * WA client (~/workspace/whatsapp/wa-client/): NO WA viewer reaction
 * set was found. The only status-reaction evidence is the telemetry
 * module `WAWebStatusReactionCTLLogging` plus the strings
 * `StatusReaction` / `StatusReactionNotification` /
 * `StatusReactionsSetting` (notification + setting, not a viewer emoji
 * set); there is no reaction tray/picker module for the status viewer.
 * So the 6-emoji row above is NOT changed — NOT-APPLIED, reason: WA
 * value not found in the client; do not guess the set. Confirm against
 * the WA phone app before touching this row.
 */
const STATUS_EMOJIS = ['❤️', '😂', '😮', '😢', '🙏', '👍'] as const;

/** Phase 4 — status mute. Muted poster uids live on the viewer's own user
 * doc (`users/{uid}.mutedStatusUsers: string[]`, same per-user-prefs pattern
 * as chatPrefs in archiveFolders) with a localStorage fallback
 * `pinglo:mutedStatuses:<uid>` for offline / hybrid-local mode. Muted
 * posters' statuses move to a "Muted" section and never appear in the
 * main list. Muting only hides them from this user; the poster is not
 * notified and their status is unchanged. */
const mutedStatusesKey = (uid: string) => `pinglo:mutedStatuses:${uid}`;
const loadLocalMuted = (uid: string): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(mutedStatusesKey(uid)) || '[]');
    return Array.isArray(parsed) ? parsed.filter((x: any) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export default function StatusScreen() {
  const [statuses, setStatuses] = useState<any[]>([]);
  const [loadingStatuses, setLoadingStatuses] = useState(true);
  const [uploading, setUploading] = useState(false);
  // REPORT-2 bug #10: picking a photo used to upload immediately — the
  // editor never opened and any upload failure went straight to "Failed
  // to upload status". The pick now only opens this editor; the upload
  // happens when the user taps Post inside it.
  const [photoEditor, setPhotoEditor] = useState<{ file: File; previewUrl: string; isVideo: boolean } | null>(null);
  const [photoCaption, setPhotoCaption] = useState('');
  const [viewingStatus, setViewingStatus] = useState<any>(null);
  const [statusIdx, setStatusIdx] = useState(0);
  const [showComposeText, setShowComposeText] = useState(false);
  const [textStatusContent, setTextStatusContent] = useState('');
  // WA parity (audit e #23): new statuses start with the Settings default
  // audience (Settings → Privacy → Status), not hardcoded 'everyone'.
  // The default "Everyone except…" list is the sheet's exclude list.
  const [textStatusPrivacy, setTextStatusPrivacy] = useState<StatusPrivacy>(() => getDefaultStatusPrivacy() as StatusPrivacy);
  const [showPrivacySheet, setShowPrivacySheet] = useState(false);
  const [privacyExclude, setPrivacyExclude] = useState<string[]>(() => getDefaultStatusExclude());
  // WA parity (audit e #23, Wave-2 C4): the default "Only share with…"
  // allow-list — the mirror of the exclude list above.
  const [privacyAllow, setPrivacyAllow] = useState<string[]>(() => getDefaultStatusAllow());
  const [contacts, setContacts] = useState<any[]>([]);
  // SBS fix 6 — Channels on the Updates tab (WhatsApp shows Channels under
  // Status). Channels are `communities` docs with isChannel: true.
  const [channels, setChannels] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteMineConfirm, setShowDeleteMineConfirm] = useState(false);
  const [toast, setToast] = useState('');
  const [showViewers, setShowViewers] = useState(false);
  const [viewerProfiles, setViewerProfiles] = useState<any[]>([]);
  const [loadingViewers, setLoadingViewers] = useState(false);
  // WA audit (d) S25 — status reply is INLINE in the viewer (WA
  // `WAWebStatusQuotedFlow`), not a separate bottom sheet: tapping Reply
  // opens a quoted composer anchored at the bottom of the viewer itself,
  // and the auto-advance timer freezes while it is open.
  const [inlineReplyOpen, setInlineReplyOpen] = useState(false);
  const [inlineReplyText, setInlineReplyText] = useState('');
  // #251 — the status the reply was opened for. The viewer auto-advances
  // every 5s, so the quote must be snapshotted at open time, not read
  // from statusIdx at send time (which may have moved on).
  const [replyTarget, setReplyTarget] = useState<{ posterUid: string; posterName: string; status: any } | null>(null);
  const { t: tr } = useLanguage();
  // Cluster C (Item 11a) — voice status: same MediaRecorder + waveform
  // pattern as ChatScreen voice notes, capped at 60s.
  const [isRecVoiceStatus, setIsRecVoiceStatus] = useState(false);
  const [voiceStatusSecs, setVoiceStatusSecs] = useState(0);
  const voiceStatusRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStatusChunksRef = useRef<Blob[]>([]);
  const voiceStatusSecsRef = useRef(0);
  const voiceStatusSendRef = useRef(true);
  const voiceStatusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // a11y (100M-H6 review): the "Post voice status" FAB unmounts the moment
  // recording starts, so keyboard focus would be lost to <body>. Move it
  // to Stop on start; when recording ends, return it to the FAB — but
  // only if focus was actually stranded on <body> (never yank it from
  // wherever the user moved it, e.g. on the 60 s auto-stop).
  const voiceStatusFabRef = useRef<HTMLButtonElement | null>(null);
  const stopVoiceStatusBtnRef = useRef<HTMLButtonElement | null>(null);
  const wasRecVoiceStatusRef = useRef(false);
  useEffect(() => {
    const was = wasRecVoiceStatusRef.current;
    wasRecVoiceStatusRef.current = isRecVoiceStatus;
    if (isRecVoiceStatus) {
      stopVoiceStatusBtnRef.current?.focus();
      return;
    }
    if (was && document.activeElement === document.body) voiceStatusFabRef.current?.focus();
  }, [isRecVoiceStatus]);
  // Audit #10: live mic level — AnalyserNode on the recording stream,
  // same pattern as ChatScreen voice notes (#208): a rAF loop writes the
  // RMS straight into the meter's DOM (no React state per frame, so the
  // level loop never re-renders the screen).
  const voiceStatusAudioCtxRef = useRef<AudioContext | null>(null);
  const voiceStatusAnalyserRef = useRef<AnalyserNode | null>(null);
  const voiceStatusLevelRafRef = useRef<number | null>(null);
  const voiceStatusLevelHostRef = useRef<HTMLDivElement | null>(null);
  // Audit #9: mic permission was denied — show a re-enable route instead
  // of ending at a toast.
  const [micDenied, setMicDenied] = useState(false);
  // Audit #8: confirm before discarding a longer take (10 s or more).
  const [showCancelVoiceConfirm, setShowCancelVoiceConfirm] = useState(false);
  // Cluster C (Item 11b) — stickers on a text status: real-art stickers
  // from the local sticker pack (Fluent 3D image when the def carries
  // one, emoji fallback otherwise — 100M-H21), preset slots, tap to
  // remove) + one text sticker.
  const [statusStickers, setStatusStickers] = useState<{ id: string; emoji: string; image?: string; x: number; y: number }[]>([]);
  const [textSticker, setTextSticker] = useState('');
  const [textStickerPos, setTextStickerPos] = useState<{ x: number; y: number } | null>(null);
  const [showStatusStickerPicker, setShowStatusStickerPicker] = useState(false);
  // Nightshift — status link sticker + @mention: a tappable https link
  // sticker (https allow-list enforced by normalizeStatusLink /
  // isSafeHttpsUrl — see utils/statusLinks.ts) and @mentions of contacts.
  const [statusLinkInput, setStatusLinkInput] = useState('');
  const [statusLink, setStatusLink] = useState<string | null>(null);
  const [statusLinkError, setStatusLinkError] = useState('');
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [statusMentions, setStatusMentions] = useState<StatusMention[]>([]);
  const [mutedUids, setMutedUids] = useState<string[]>([]);
  // WA audit (d) S9 — my Close Friends list (user doc + local fallback).
  const [closeFriends, setCloseFriends] = useState<string[]>([]);
  // WA audit (d) S14 — text-status background + font for the composer.
  const [textBg, setTextBg] = useState<string>('teal');
  const [textFont, setTextFont] = useState<string>('sans');
  // WA audit (d) S20 — viewer pause on press-and-hold. The timer effect
  // (below) records the remaining ms in remainingMsRef on every cleanup,
  // so pausing clears the timeout and resuming re-arms it with what's
  // left instead of restarting the 5s from scratch.
  const [viewerPaused, setViewerPaused] = useState(false);
  const advanceAtRef = useRef(0);
  const advanceKeyRef = useRef('');
  const durationUsedRef = useRef(0);
  const remainingMsRef = useRef(0);
  // WA audit (d) S19 — real video durations, keyed by status id. The
  // viewer timer uses these instead of the old fixed 15s; until a clip's
  // metadata loads the 15s fallback still applies (then the timer
  // re-arms with the real duration — see the timer effect).
  const [videoDurationById, setVideoDurationById] = useState<Record<string, number>>({});
  // WA audit (d) S22+S23 — viewer overflow menu (Mute / Forward /
  // Download / Report).
  const [showViewerMenu, setShowViewerMenu] = useState(false);
  // WA audit (d) C10 — per-channel mute in the Updates channel list.
  // Same pref the chat-list long-press Mute and GroupInfoModal write:
  // users/<uid>.chatPrefs[<cleanId(channelId)>].muted.
  const [channelMuted, setChannelMuted] = useState<Record<string, boolean>>({});
  const channelPrefsRef = useRef<Record<string, any>>({});
  // WA audit (d) S30 — "Expires in Xh" countdown under My Status.
  // Re-rendered once a minute so the countdown moves without a snapshot.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentUser = auth.currentUser;

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  // WA audit (d) C15 — "Add to status" consumer (WA:
  // WAWebNewsletterAddToStatusButton). ChatScreen queues a channel post
  // in sessionStorage and fires `pinglo:add-to-status` after switching
  // to the Updates tab; this screen consumes the queue on mount (covers
  // a tab that was not activated yet, so the event was never heard) and
  // on the event (covers an already-mounted tab). Either path opens the
  // composer prefilled — text composer for text posts, photo editor for
  // media posts — and the queue is consumed exactly once, so a late event
  // after a mount-consume is a no-op. The 80ms setTimeout in ChatScreen
  // is therefore timing-safe: the queue, not the event timing, is the
  // source of truth — the event is only a wake-up, the mount read is the
  // fallback, and whichever runs first wins exactly once.
  const composerOpenRef = useRef(false);
  useEffect(() => {
    composerOpenRef.current = showComposeText || photoEditor !== null;
  }, [showComposeText, photoEditor]);

  useEffect(() => {
    const openFromQueue = async () => {
      const queued = takeQueuedChannelPostForStatus();
      if (!queued) return;
      // Never clobber a status already being composed.
      if (composerOpenRef.current) {
        showToastMsg('Finish your current status first, then try again');
        return;
      }
      const sourceNote = queued.sourceName ? `Shared from ${queued.sourceName}` : '';
      if (queued.mediaUrl) {
        try {
          const res = await fetch(queued.mediaUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const isVideo = queued.mediaType === 'video' || blob.type.startsWith('video/');
          const name = decodeURIComponent(queued.mediaUrl.split('/').pop()?.split('?')[0] || 'channel-post') || 'channel-post';
          const file = new File([blob], name, { type: blob.type || (isVideo ? 'video/mp4' : 'image/jpeg') });
          setPhotoCaption(queued.caption || queued.text || '');
          setPhotoEditor({ file, previewUrl: URL.createObjectURL(file), isVideo });
          showToastMsg(sourceNote ? `${sourceNote} — edit and post` : 'Edit and post your status');
          return;
        } catch {
          // Media fetch failed (expired URL / offline): fall through to
          // the text composer with whatever text the post had, so the
          // share still lands instead of silently dying.
          showToastMsg('Could not load the media — shared as text instead');
        }
      }
      const text = (queued.text || '').slice(0, TEXT_STATUS_MAX_LEN);
      if (!text.trim()) return;
      setTextStatusContent(text);
      setShowComposeText(true);
      if (sourceNote) showToastMsg(sourceNote);
    };
    void openFromQueue();
    const onAddToStatus = () => { void openFromQueue(); };
    window.addEventListener(ADD_TO_STATUS_EVENT, onAddToStatus);
    return () => window.removeEventListener(ADD_TO_STATUS_EVENT, onAddToStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // W28: gated contacts — saved contacts + proven DM partners only.
  // Used by the privacy exclude picker and the 'contacts' post-time
  // snapshot. No whole-users subscription anymore. Re-runs when the
  // chats collection changes (a new conversation joins the set), but
  // profile reads only re-fire when the allowed-uid SET changes.
  const gatedUidsKeyRef = useRef('');
  const gatedLoadedRef = useRef(false);
  // 100M-C1: a partial load (some allowed uid had no profile doc yet)
  // must not latch — the next trigger retries. Throttled so a profile
  // that never arrives doesn't re-read on every chats snapshot.
  const gatedRetryAtRef = useRef(0);
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    const run = async (force = false) => {
      try {
        const uids = [...new Set(getAllowedContactUids(currentUser.uid))].sort();
        const key = uids.join(',');
        if (!force && key === gatedUidsKeyRef.current && gatedLoadedRef.current) return;
        if (!force && !gatedLoadedRef.current && gatedRetryAtRef.current && Date.now() - gatedRetryAtRef.current < 15000) return;
        const { list, unresolvedUids } = await loadGatedContactsDetailed(currentUser.uid);
        if (cancelled) return;
        if (unresolvedUids.length === 0) {
          gatedUidsKeyRef.current = key;
          gatedLoadedRef.current = true;
        } else {
          gatedLoadedRef.current = false;
          gatedRetryAtRef.current = Date.now();
        }
        setContacts(list);
      } catch {
        /* offline: keep the previous list */
      }
    };
    void run();
    const unsubChats = onSnapshot(collection(db, 'chats'), () => { void run(); });
    // W28 R5: re-run when background discovery memos a new conversation
    // (localStorage write — no chats snapshot fires for it). 100M-C1:
    // force the re-read — the uid SET may be unchanged while a profile
    // arrived after the first (partial) load.
    const onKnownConvs = () => { void run(true); };
    window.addEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
    return () => {
      cancelled = true;
      window.removeEventListener(KNOWN_CONVS_CHANGED_EVENT, onKnownConvs);
      try { unsubChats(); } catch (err) { console.warn("[StatusScreen] StatusScreen: unsubChats() failed", err); }
    };
  }, [currentUser]);

  // SBS fix 6 — Channels section: subscribe to `communities` and keep only
  // announcement-only channels (isChannel). WA audit (d) C1 (verify):
  // the Updates tab lists channels you FOLLOW — public channels you
  // haven't followed belong in discovery (Communities tab), not here.
  // (Creator counts as a follower, for channels created before the
  // members array existed.) Tapping a channel opens its chat
  // (/chat/<id>?type=community); non-members get the Join UI in ChatScreen
  // when they open one from discovery.
  useEffect(() => {
    const myUid = currentUser?.uid;
    const q = query(collection(db, 'communities'), orderBy('timestamp', 'desc'));
    return onSnapshot(q, snap => {
      try {
        setChannels(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter((c: any) => c.isChannel && !!myUid && (isGroupMember(c, myUid) || c.creatorId === myUid)));
      } catch {
        setChannels([]);
      }
    });
  }, [currentUser]);

  // Phase 4 — muted status posters: server value (users/{uid}.mutedStatusUsers)
  // wins; the localStorage copy fills gaps and survives offline writes.
  useEffect(() => {
    if (!currentUser) return;
    setMutedUids(loadLocalMuted(currentUser.uid));
    return onSnapshot(doc(db, 'users', currentUser.uid), snap => {
      if (!snap.exists()) return;
      const server = (snap.data() as any).mutedStatusUsers;
      if (Array.isArray(server)) {
        const merged = [...new Set([...server, ...loadLocalMuted(currentUser.uid)])];
        setMutedUids(merged);
      }
    });
  }, [currentUser]);

  // WA audit (d) S9 + C10 — Close Friends list + per-channel mute prefs,
  // both on the viewer's own user doc with the same localStorage fallback
  // pattern as mutedStatusUsers above. The channel prefs map is keyed by
  // cleanId(channelId) so it matches what ChatListScreen / GroupInfoModal
  // write (the notification watcher keys muted chats by conversation id).
  useEffect(() => {
    if (!currentUser) return;
    setCloseFriends(loadLocalCloseFriends(currentUser.uid));
    const localPrefs = loadLocalChatPrefs(currentUser.uid);
    const mutedFrom = (prefs: Record<string, any>): Record<string, boolean> => {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(prefs)) if ((v as any)?.muted) out[k] = true;
      return out;
    };
    channelPrefsRef.current = localPrefs;
    setChannelMuted(mutedFrom(localPrefs));
    return onSnapshot(doc(db, 'users', currentUser.uid), snap => {
      if (!snap.exists()) return;
      const d = snap.data() as any;
      if (Array.isArray(d.closeFriends)) {
        setCloseFriends([...new Set([...d.closeFriends, ...loadLocalCloseFriends(currentUser.uid)])]);
      }
      if (d.chatPrefs && typeof d.chatPrefs === 'object') {
        channelPrefsRef.current = d.chatPrefs;
        setChannelMuted(mutedFrom(d.chatPrefs));
      }
    });
  }, [currentUser]);

  useEffect(() => {
    // 24 hour status expiration like WhatsApp
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const ts = (s: any) => (s.timestamp?.toMillis ? s.timestamp.toMillis() : Number(s.timestamp) || 0);

    const unsub = onSnapshot(collection(db, 'statuses'), (snap) => {
      const allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Filter: not expired, and allowed by privacy
      const validStatuses = allDocs
        .filter(s => {
          const isMine = s.userId === currentUser?.uid;
          const notExpired = (Date.now() - ts(s)) < ONE_DAY_MS;
          if (!notExpired) return false;
          if (isMine) return true;
          const privacy: StatusPrivacy = s.privacy || 'everyone';
          if (privacy === 'nobody') return false;
          if (privacy === 'exclude') {
            return !(s.privacyExclude || []).includes(currentUser?.uid);
          }
          if (privacy === 'onlyShare') {
            // WA parity (audit e #23, Wave-2 C4) — new audience, so no
            // legacy docs exist: fail closed when the post-time
            // snapshot is missing, same as Close Friends.
            if (Array.isArray(s.privacyAllow)) return s.privacyAllow.includes(currentUser?.uid);
            return false;
          }
          if (privacy === 'contacts') {
            // Post-time snapshot of the poster's contacts; old docs without
            // a snapshot fall back to visible (backwards compat).
            if (Array.isArray(s.privacyAllow)) return s.privacyAllow.includes(currentUser?.uid);
            return true;
          }
          if (privacy === 'closeFriends') {
            // WA audit (d) S9 — new audience, so no legacy docs exist:
            // fail closed when the post-time snapshot is missing.
            if (Array.isArray(s.privacyAllow)) return s.privacyAllow.includes(currentUser?.uid);
            return false;
          }
          return true;
        })
        .sort((a, b) => ts(b) - ts(a));

      // Group by user
      const grouped = validStatuses.reduce((acc: any, status: any) => {
        if (!acc[status.userId]) {
          acc[status.userId] = {
            userId: status.userId,
            name: status.userName || 'User',
            avatar: status.userAvatar || '',
            statuses: [],
            latestTime: status.timestamp,
            hasUnseen: true
          };
        }
        acc[status.userId].statuses.push(status);
        return acc;
      }, {});

      // Phase 5 (Agent B): a group is "viewed" only when I am in `viewers`
      // on every status in it. Previously hasUnseen was hardcoded true, so
      // everything stayed under "Recent updates" with a green ring forever.
      const groups = Object.values(grouped) as any[];
      for (const g of groups) {
        g.hasUnseen = g.statuses.some((s: any) => !(s.viewers || []).includes(currentUser?.uid));
        // WA audit (d) S9 — a group is a Close Friends group when any of
        // its statuses was posted to that audience; its ring is purple.
        g.closeFriends = g.statuses.some((s: any) => s.privacy === 'closeFriends');
      }
      setStatuses(groups);
      setLoadingStatuses(false);
    });

    return () => unsub();
  }, [currentUser]);

  // R6 (#256 follow-up): keep the open viewer's data live. `viewingStatus`
  // was a snapshot taken at open time, so a reaction tap saved the reaction
  // (visible in the store) yet the counts pill / pressed highlight never
  // appeared until close + reopen. Refresh the open group in place when the
  // current status's reactions/viewers change, or the group's size changes
  // (new post / deletion — the fresh index is clamped inline below).
  // Deliberately narrow (signature compare) so unrelated snapshots don't
  // restart the 5s auto-advance timer.
  useEffect(() => {
    if (!viewingStatus) return;
    const fresh = (statuses as any[]).find((g: any) => g.userId === viewingStatus.userId);
    if (!fresh) return; // group gone — the subscription effect already closes the viewer
    const cur = viewingStatus.statuses[statusIdx];
    const freshCur = fresh.statuses[Math.min(statusIdx, Math.max(0, fresh.statuses.length - 1))];
    if (!cur || !freshCur) return;
    const sig = (s: any) => JSON.stringify({ r: s.reactions || {}, v: s.viewers || [], id: s.id });
    if (sig(cur) !== sig(freshCur) || fresh.statuses.length !== viewingStatus.statuses.length) {
      setViewingStatus((prev: any) => (prev ? { ...prev, statuses: fresh.statuses, name: fresh.name, avatar: fresh.avatar } : prev));
    }
  }, [statuses]);

  useEffect(() => {
    if (viewingStatus) {
      return navigationManager.pushHandler(() => {
        setViewingStatus(null);
        return true;
      });
    }
  }, [viewingStatus]);

  useEffect(() => {
    if (showComposeText) {
      return navigationManager.pushHandler(() => {
        setShowComposeText(false);
        return true;
      });
    }
  }, [showComposeText]);

  useEffect(() => {
    if (showSearch) {
      return navigationManager.pushHandler(() => {
        setShowSearch(false);
        setSearchQ('');
        return true;
      });
    }
  }, [showSearch]);

  // Escape closes viewer / sheets / menus.
  useEffect(() => {
    if (!showViewers && !showPrivacySheet && !showMenu && !showDeleteConfirm && !showDeleteMineConfirm && !inlineReplyOpen && !showViewerMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowViewers(false); setShowPrivacySheet(false); setShowMenu(false);
      setShowDeleteConfirm(false); setShowDeleteMineConfirm(false); setInlineReplyOpen(false);
      setShowViewerMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showViewers, showPrivacySheet, showMenu, showDeleteConfirm, showDeleteMineConfirm, inlineReplyOpen, showViewerMenu]);

  // WA audit (d) S19 + S20 — auto-advance with the video's REAL duration
  // (not the old fixed 15s) and pause on press-and-hold. The timer
  // re-arms from remainingMsRef when resuming (the cleanup records what
  // was left), and restarts with the full duration when the status
  // changes or when a video's real duration first arrives (metadata
  // load). `currentDurationMs` is defined below the component's helpers
  // and read here — it is a render-time value, so the effect re-runs
  // whenever it changes.
  const advanceViewer = () => {
    if (!viewingStatus) return;
    setShowViewerMenu(false);
    setInlineReplyOpen(false);
    if (statusIdx < viewingStatus.statuses.length - 1) {
      setStatusIdx(prev => prev + 1);
    } else {
      setViewingStatus(null);
      setStatusIdx(0);
    }
  };

  // Opening a new status (or a new group) clears a stale pause.
  useEffect(() => { setViewerPaused(false); }, [viewingStatus, statusIdx]);

  // WA verify status-3 S21/S27 — any overlay over the viewer (who-viewed
  // sheet, reply sheet, overflow menu, delete confirm) pauses the
  // auto-advance + progress fill, resuming with the remaining time (same
  // mechanism as the press-and-hold pause). Without this the timer could
  // advance mid-confirm and Delete would remove the NEXT status, and the
  // who-viewed sheet would switch to another status's viewers under you.
  const viewerOverlayOpen = showViewers || inlineReplyOpen || showViewerMenu || showDeleteConfirm;

  // WA audit (d) S19 — video advances on its REAL duration (recorded
  // from onLoadedMetadata, keyed by status id); until metadata loads the
  // old 15s fallback applies and the timer re-arms when it arrives.
  // Defined here (before the timer effect) so the effect reads an
  // already-declared value.
  const currentStatus = viewingStatus?.statuses?.[statusIdx];
  const currentDurationMs = currentStatus?.mediaType === 'video'
    ? (videoDurationById[currentStatus?.id] ?? 15000)
    : currentStatus?.mediaType === 'voice'
    ? Math.min(Math.max((currentStatus?.duration || 5) * 1000, 1000), 60000)
    : 5000;

  useEffect(() => {
    if (!viewingStatus || !viewingStatus.statuses?.length) return;
    // S20: while held, no timer runs — the previous cleanup already
    // recorded the remaining ms, and the resume re-arms it below.
    // S25: same freeze while the inline reply composer is open.
    // WA verify status-3: same while a viewer overlay is open.
    if (viewerPaused || inlineReplyOpen || viewerOverlayOpen) return;
    const current = viewingStatus.statuses[statusIdx];
    const key = `${viewingStatus.userId}:${current?.id ?? statusIdx}`;
    let duration: number;
    if (key !== advanceKeyRef.current || currentDurationMs !== durationUsedRef.current) {
      // Fresh status, or a video's real duration just arrived (S19).
      duration = currentDurationMs;
    } else {
      duration = remainingMsRef.current > 0 ? remainingMsRef.current : currentDurationMs;
    }
    advanceKeyRef.current = key;
    durationUsedRef.current = currentDurationMs;
    remainingMsRef.current = duration;
    advanceAtRef.current = Date.now() + duration;
    const timer = setTimeout(advanceViewer, duration);
    return () => {
      clearTimeout(timer);
      remainingMsRef.current = Math.max(0, advanceAtRef.current - Date.now());
    };
    // currentDurationMs is a render-time value derived from
    // videoDurationById — listed so a metadata load re-arms the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingStatus, statusIdx, viewerPaused, inlineReplyOpen, viewerOverlayOpen, currentDurationMs]);

  // Mark status as viewed by currentUser (+ record the view time).
  useEffect(() => {
    if (!viewingStatus || !currentUser) return;
    const current = viewingStatus.statuses[statusIdx];
    if (current?.id && viewingStatus.userId !== currentUser.uid) {
      updateDoc(doc(db, 'statuses', current.id), {
        viewers: arrayUnion(currentUser.uid),
        [`viewerTimes.${currentUser.uid}`]: Date.now(),
      }).catch(() => {});
    }
  }, [viewingStatus, statusIdx, currentUser]);

  // Resolve viewer uids to profiles when the owner opens the who-viewed sheet.
  useEffect(() => {
    if (!showViewers || !viewingStatus) return;
    const current = viewingStatus.statuses[statusIdx];
    const uids: string[] = current?.viewers || [];
    if (uids.length === 0) { setViewerProfiles([]); return; }
    let cancelled = false;
    setLoadingViewers(true);
    Promise.all(uids.map(async (uid: string) => {
      try {
        const snap = await getDoc(doc(db, 'users', uid));
        const data = snap.exists() ? snap.data() : {};
        return {
          uid,
          displayName: data.displayName || data.username || 'User',
          username: data.username || '',
          photoURL: data.photoURL || '',
          viewedAt: current?.viewerTimes?.[uid] || null,
        };
      } catch {
        return { uid, displayName: 'User', username: '', photoURL: '', viewedAt: null };
      }
    })).then(list => {
      if (!cancelled) {
        setViewerProfiles(list.sort((a, b) => (b.viewedAt || 0) - (a.viewedAt || 0)));
        setLoadingViewers(false);
      }
    });
    return () => { cancelled = true; };
  }, [showViewers, viewingStatus, statusIdx]);

  const privacyFieldsForPost = () => {
    const fields: any = { privacy: textStatusPrivacy };
    if (textStatusPrivacy === 'contacts') {
      // Snapshot of current contacts at post time (see header comment).
      fields.privacyAllow = contacts.map(c => c.uid || c.id).filter(Boolean);
    }
    if (textStatusPrivacy === 'closeFriends') {
      // WA audit (d) S9 — snapshot of the Close Friends list at post
      // time; the snapshot filter fails closed without it.
      fields.privacyAllow = [...closeFriends];
    }
    if (textStatusPrivacy === 'exclude') {
      fields.privacyExclude = privacyExclude;
      // Keep the Settings default in sync with the sheet's picks, so the
      // next status excludes the same people without re-picking them.
      setDefaultStatusExclude(privacyExclude);
    }
    if (textStatusPrivacy === 'onlyShare') {
      // WA parity (audit e #23, Wave-2 C4) — snapshot of the allow-list
      // at post time; the snapshot filter fails closed without it.
      // Keep the Settings default in sync with the sheet's picks, so the
      // next status shares with the same people without re-picking them.
      fields.privacyAllow = [...privacyAllow];
      setDefaultStatusAllow(privacyAllow);
    }
    return fields;
  };

  /** WA audit (d) S9 — toggle a contact in my Close Friends list.
   * Persisted to the user doc + localStorage (same pattern as mute). */
  const toggleCloseFriend = async (uid: string) => {
    if (!currentUser) return;
    const next = closeFriends.includes(uid) ? closeFriends.filter(u => u !== uid) : [...closeFriends, uid];
    setCloseFriends(next);
    try {
      localStorage.setItem(closeFriendsKey(currentUser.uid), JSON.stringify(next));
    } catch { /* intentionally ignored */ }
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { closeFriends: next });
    } catch {
      // Offline: the local copy above is the source of truth until sync.
    }
  };

  /** WA audit (d) C10 — mute/unmute a channel from the Updates list.
   * Same pref + write as the chat-list long-press Mute / GroupInfoModal. */
  const toggleChannelMute = async (ch: any) => {
    if (!currentUser) return;
    const key = cleanId(ch.id);
    const next = !channelMuted[key];
    const nextPref = { ...(channelPrefsRef.current[key] || {}), muted: next };
    channelPrefsRef.current = { ...channelPrefsRef.current, [key]: nextPref };
    setChannelMuted(prev => ({ ...prev, [key]: next }));
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { [`chatPrefs.${key}`]: nextPref });
      showToastMsg(next ? `Muted ${ch.name} 🔕` : `Unmuted ${ch.name} 🔔`);
    } catch {
      try {
        const local = loadLocalChatPrefs(currentUser.uid);
        saveLocalChatPrefs(currentUser.uid, { ...local, [key]: nextPref });
        showToastMsg(next ? `Muted ${ch.name} 🔕 (saved on this device)` : `Unmuted ${ch.name} 🔔 (saved on this device)`);
      } catch { /* optimistic UI stays */ }
    }
  };

  /** WA audit (d) S22 — forward the viewed status via the existing share
   * path (SharePickerScreen reads `dt_pending_share`). Text statuses
   * forward their text; photo/video/voice forward their caption when
   * there is one, otherwise a label naming the poster. Media bytes do
   * NOT travel this path on web — the share intent can only carry file
   * refs the web cannot read (see shareIntent.ts) — so a media status
   * without a caption forwards as a labelled text, never as a fake file. */
  const forwardCurrentStatus = () => {
    if (!viewingStatus) return;
    const current = viewingStatus.statuses[statusIdx];
    if (!current) return;
    const label = statusPreviewFor(current);
    const text = current?.mediaType === 'text'
      ? (current?.textContent || label)
      : (current?.textContent?.trim() ? current.textContent.trim() : `${label} from ${viewingStatus.name}`);
    savePendingShare({ text, subject: `${viewingStatus.name}'s status`, files: [], truncated: false });
    setShowViewerMenu(false);
    setViewingStatus(null);
    setStatusIdx(0);
    navigate('/share');
  };

  /** WA audit (d) S22 — download the viewed status. Media fetches its
   * URL (works for the local blob URLs the app stores, and for https
   * media); a text status downloads as a .txt file. */
  const downloadCurrentStatus = async () => {
    if (!viewingStatus) return;
    const current = viewingStatus.statuses[statusIdx];
    if (!current) return;
    setShowViewerMenu(false);
    try {
      if (current?.mediaType === 'text' || !current?.mediaUrl) {
        const blob = new Blob([(current?.textContent || statusPreviewFor(current)) + '\n'], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `status-${current?.id || 'text'}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToastMsg('Status downloaded ✓');
        return;
      }
      const res = await fetch(current.mediaUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const ext = (blob.type.split('/')[1] || (current.mediaType === 'video' ? 'mp4' : current.mediaType === 'voice' ? 'webm' : 'jpg')).split(';')[0];
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `status-${current?.id || 'media'}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      showToastMsg('Status downloaded ✓');
    } catch {
      showToastMsg('Could not download this status');
    }
  };

  /** WA audit (d) S22 — report the viewed status. There is no server
   * moderation endpoint yet, so this records the report on-device and
   * says so in the toast — it is never presented as a report sent to a
   * review team. Server-side reporting is backend work (follow-up). */
  const reportCurrentStatus = () => {
    if (!viewingStatus || !currentUser) return;
    const current = viewingStatus.statuses[statusIdx];
    if (!current?.id) return;
    setShowViewerMenu(false);
    try {
      const raw = JSON.parse(localStorage.getItem(reportedStatusesKey(currentUser.uid)) || '[]');
      const list = Array.isArray(raw) ? raw : [];
      if (!list.includes(current.id)) {
        list.push(current.id);
        localStorage.setItem(reportedStatusesKey(currentUser.uid), JSON.stringify(list));
      }
    } catch { /* intentionally ignored */ }
    showToastMsg('Thanks — this status has been reported for review (saved on this device; server review needs backend work)');
  };

  // ── Cluster C (Item 11a): record a voice note as a status ────────────
  // Audit #10: stop the live-level loop and release the analyser's
  // AudioContext. Called from stop/cancel and from the recorder's onstop —
  // the level loop must never outlive the recording.
  const stopVoiceLevelLoop = () => {
    if (voiceStatusLevelRafRef.current !== null) cancelAnimationFrame(voiceStatusLevelRafRef.current);
    voiceStatusLevelRafRef.current = null;
    voiceStatusAnalyserRef.current = null;
    const actx = voiceStatusAudioCtxRef.current;
    voiceStatusAudioCtxRef.current = null;
    if (actx) void actx.close().catch(() => {});
  };

  // Audit #10: AnalyserNode taps the mic stream; a rAF loop writes the
  // rolling RMS into the meter's DOM. When Web Audio is unavailable the
  // meter stays empty and the timer keeps working (same fallback as
  // ChatScreen #208).
  const startVoiceLevelLoop = (stream: MediaStream) => {
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const actx = new AC();
      const src = actx.createMediaStreamSource(stream);
      const analyser = actx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      void actx.resume().catch(() => {});
      voiceStatusAudioCtxRef.current = actx;
      voiceStatusAnalyserRef.current = analyser;
      const buf = new Uint8Array(analyser.fftSize);
      // Live waveform bars (same rolling-RMS pattern as ChatScreen #208):
      // 14 bars, heights written straight into the spans' DOM — no React
      // state per frame, so the level loop never re-renders the screen.
      const levels: number[] = new Array(14).fill(4);
      const tick = () => {
        const an = voiceStatusAnalyserRef.current;
        if (!an) return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length); // 0..~1
        const h = 4 + Math.min(1, rms * 4) * 20; // 4..24px
        levels.push(h);
        levels.shift();
        const host = voiceStatusLevelHostRef.current;
        if (host) {
          host.setAttribute('data-rec-live', 'true');
          host.setAttribute('data-rec-rms', rms.toFixed(3));
          const spans = host.children;
          for (let i = 0; i < spans.length && i < levels.length; i++) {
            (spans[i] as HTMLElement).style.height = `${levels[i].toFixed(1)}px`;
          }
        }
        voiceStatusLevelRafRef.current = requestAnimationFrame(tick);
      };
      voiceStatusLevelRafRef.current = requestAnimationFrame(tick);
    } catch {
      // Web Audio unavailable — the timer-animated UI stays.
    }
  };

  // Audit #10: never leak the level loop if the screen unmounts mid-take.
  useEffect(() => () => { stopVoiceLevelLoop(); }, []);

  const startVoiceStatus = async () => {
    if (!currentUser || isRecVoiceStatus) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      voiceStatusChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data?.size) voiceStatusChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stopVoiceLevelLoop();
        stream.getTracks().forEach((t) => t.stop());
        if (voiceStatusTimerRef.current) clearInterval(voiceStatusTimerRef.current);
        const send = voiceStatusSendRef.current;
        const secs = voiceStatusSecsRef.current;
        const blob = new Blob(voiceStatusChunksRef.current, { type: 'audio/webm' });
        setIsRecVoiceStatus(false);
        if (!send || !blob.size || !currentUser) return;
        const file = new File([blob], `voice_status_${Date.now()}.webm`, { type: 'audio/webm' });
        setUploading(true);
        let mediaUrl: string | undefined;
        try {
          mediaUrl = await uploadChatMedia(file, 'audio');
          const peaks = await getWaveformPeaks(blob);
          await addDoc(collection(db, 'statuses'), {
            userId: currentUser.uid,
            userName: currentUser.displayName || 'User',
            userAvatar: currentUser.photoURL || '',
            mediaUrl,
            mediaType: 'voice',
            type: 'voice',
            duration: secs,
            ...(peaks.length ? { waveform: peaks } : {}),
            timestamp: serverTimestamp(),
            ...privacyFieldsForPost(),
          });
          showToastMsg('Voice status posted ✓');
        } catch (e) {
          // 100M-H6: the blob was already stored before the doc write —
          // if the write failed, delete it or it stays an unreachable
          // orphan in the local media store (no doc ever references it).
          if (mediaUrl && isLocalMediaUrl(mediaUrl)) void deleteLocalMediaBlob(mediaUrl);
          // 100M-H6: a too-long recording fails the same way on every
          // retry — say so instead of "try again".
          showToastMsg(
            isMediaTooLargeError(e)
              ? 'Voice status too long to post. Try a shorter one.'
              : 'Failed to post voice status. Please try again.',
          );
        } finally { setUploading(false); }
      };
      mr.start();
      voiceStatusRecorderRef.current = mr;
      voiceStatusSendRef.current = true;
      voiceStatusSecsRef.current = 0;
      setVoiceStatusSecs(0);
      setIsRecVoiceStatus(true);
      // Audit #9: a retry that gets the mic clears the denied notice.
      setMicDenied(false);
      startVoiceLevelLoop(stream);
      voiceStatusTimerRef.current = setInterval(() => {
        voiceStatusSecsRef.current += 1;
        setVoiceStatusSecs(voiceStatusSecsRef.current);
        if (voiceStatusSecsRef.current >= 60) stopVoiceStatus(true);
      }, 1000);
    } catch (err) {
      // Audit #9: a denied mic used to end at a toast with no way back.
      // Keep the toast, but also raise the denied notice (with a Try again
      // button + site-settings guidance) until the mic is granted.
      if ((err as any)?.name === 'NotAllowedError' || (err as any)?.name === 'SecurityError') setMicDenied(true);
      showToastMsg('Microphone access needed for a voice status.');
    }
  };

  const stopVoiceStatus = (send: boolean) => {
    stopVoiceLevelLoop();
    voiceStatusSendRef.current = send;
    try { voiceStatusRecorderRef.current?.stop(); } catch { /* intentionally ignored */}
    setIsRecVoiceStatus(false);
    if (voiceStatusTimerRef.current) clearInterval(voiceStatusTimerRef.current);
  };

  // REPORT-2 bug #10: picking a photo used to upload it immediately, so
  // the editor never opened — the user went straight to "Failed to upload
  // status". The pick now ONLY opens the editor (preview + caption); the
  // upload runs when the user taps Post inside it (postPhotoStatus).
  const handleUploadStatus = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !currentUser) return;
    const file = e.target.files[0];
    if (photoEditor) URL.revokeObjectURL(photoEditor.previewUrl);
    setPhotoCaption('');
    // WA72 S16: link state is shared with the text composer — a link set
    // there must not leak into a photo status (and vice versa).
    setStatusLink(null);
    setStatusLinkInput('');
    setStatusLinkError('');
    setPhotoEditor({ file, previewUrl: URL.createObjectURL(file), isVideo: file.type.startsWith('video/') });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const closePhotoEditor = () => {
    if (photoEditor) URL.revokeObjectURL(photoEditor.previewUrl);
    setPhotoEditor(null);
    setPhotoCaption('');
    setStatusLink(null);
    setStatusLinkInput('');
    setStatusLinkError('');
  };

  // Upload + post the photo/video the editor is showing. The caption is
  // stored as textContent, which the status viewer already renders (line
  // ~1217), so it shows under the photo like WhatsApp.
  const postPhotoStatus = async () => {
    if (!photoEditor || !currentUser || uploading) return;
    const { file, isVideo } = photoEditor;
    setUploading(true);
    try {
      const mediaUrl = await uploadChatMedia(file, isVideo ? 'video' : 'image');

      await addDoc(collection(db, 'statuses'), {
        userId: currentUser.uid,
        userName: currentUser.displayName || 'User',
        userAvatar: currentUser.photoURL || '',
        mediaUrl,
        mediaType: isVideo ? 'video' : 'image',
        type: 'media',
        ...(photoCaption.trim() ? { textContent: photoCaption.trim() } : {}),
        // WA72 S16: link sticker also travels with a photo/video status.
        ...(statusLink ? { linkSticker: { url: statusLink } } : {}),
        timestamp: serverTimestamp(),
        ...privacyFieldsForPost(),
      });
      showToastMsg('Status posted ✓');
      closePhotoEditor();
    } catch {
      showToastMsg('Failed to upload status. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteStatus = async () => {
    if (!viewingStatus || !currentUser) return;
    const current = viewingStatus.statuses[statusIdx];
    if (!current) return;
    setShowDeleteConfirm(false);
    try {
      await deleteDoc(doc(db, 'statuses', current.id));
      showToastMsg('Status deleted');
      if (viewingStatus.statuses.length <= 1) {
        setViewingStatus(null);
        setStatusIdx(0);
      } else {
        setStatusIdx((prev: number) => Math.max(0, prev - 1));
      }
    } catch (_) {
      showToastMsg('Failed to delete status');
    }
  };

  const handleDeleteMyStatus = async () => {
    if (!myStatusGroup || !currentUser) return;
    setShowDeleteMineConfirm(false);
    try {
      await Promise.all(myStatusGroup.statuses.map((s: any) => deleteDoc(doc(db, 'statuses', s.id))));
      showToastMsg('Your status updates were deleted');
    } catch {
      showToastMsg('Could not delete your status. Try again.');
    }
  };

  const handlePostTextStatus = async () => {
    if (!textStatusContent.trim() || !currentUser) return;
    setUploading(true);
    try {
      await addDoc(collection(db, 'statuses'), {
        userId: currentUser.uid,
        userName: currentUser.displayName || 'User',
        userAvatar: currentUser.photoURL || '',
        textContent: textStatusContent.trim(),
        type: 'text',
        mediaType: 'text',
        timestamp: serverTimestamp(),
        // WA audit (d) S14 — background + font travel with the text.
        ...(textBg !== 'teal' ? { bgStyle: textBg } : {}),
        ...(textFont !== 'sans' ? { fontStyle: textFont } : {}),
        ...(statusStickers.length ? { stickers: statusStickers } : {}),
        ...(textSticker.trim() && textStickerPos ? { textSticker: { text: textSticker.trim(), x: textStickerPos.x, y: textStickerPos.y } } : {}),
        // Nightshift — link sticker (already https-validated) + @mentions.
        ...(statusLink ? { linkSticker: { url: statusLink } } : {}),
        ...(statusMentions.length ? { mentions: statusMentions } : {}),
        ...privacyFieldsForPost(),
      });
      setTextStatusContent('');
      setStatusStickers([]);
      setTextBg('teal');
      setTextFont('sans');
      setStatusLink(null);
      setStatusLinkInput('');
      setStatusLinkError('');
      setStatusMentions([]);
      setShowMentionPicker(false);
      setTextSticker('');
      setTextStickerPos(null);
      setShowStatusStickerPicker(false);
      setShowComposeText(false);
      showToastMsg('Status posted ✓');
    } catch {
      showToastMsg('Failed to post status. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const formatTime = (timestamp: any) => {
    if (!timestamp) return 'Just now';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // ── Phase 4 — status mute / reactions / reply ──────────────────────────

  const toggleMuteStatus = async (posterUid: string, name: string) => {
    if (!currentUser) return;
    const muted = mutedUids.includes(posterUid);
    const next = muted ? mutedUids.filter(u => u !== posterUid) : [...mutedUids, posterUid];
    setMutedUids(next);
    try {
      localStorage.setItem(mutedStatusesKey(currentUser.uid), JSON.stringify(next));
    } catch { /* intentionally ignored */}
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { mutedStatusUsers: next });
    } catch {
      // Offline: the local copy above is the source of truth until sync.
    }
    showToastMsg(muted ? `Unmuted ${name}'s status updates` : `Muted ${name}'s status updates — find them under “Muted” below`);
  };

  /** Toggle my reaction on the currently viewed status (same emoji = remove). */
  const toggleStatusReaction = async (emoji: string) => {
    if (!viewingStatus || !currentUser) return;
    const current = viewingStatus.statuses[statusIdx];
    if (!current?.id) return;
    const mine = current.reactions?.[currentUser.uid];
    try {
      await updateDoc(doc(db, 'statuses', current.id), {
        [`reactions.${currentUser.uid}`]: mine === emoji ? deleteField() : emoji,
      });
    } catch {
      showToastMsg('Could not save reaction');
    }
  };

  const statusReactionCounts = (status: any): Record<string, number> => {
    const counts: Record<string, number> = {};
    const reactions = status?.reactions || {};
    for (const emoji of Object.values(reactions)) {
      if (typeof emoji === 'string') counts[emoji] = (counts[emoji] || 0) + 1;
    }
    return counts;
  };

  const statusPreviewFor = (s: any): string => {
    if (!s) return '';
    if (s.mediaType === 'text' || s.type === 'text') return s.textContent || 'Text status';
    if (s.mediaType === 'voice' || s.type === 'voice') return 'Voice status';
    if (s.mediaType === 'video') return 'Video status';
    return 'Photo status';
  };

  /**
   * #253 — open channel discovery. Discovery itself lives on the
   * Communities tab (search + full list + Join, in CommunitiesScreen);
   * the tabs share one MainScreen whose activeTab is local state, so
   * this dispatches the same CustomEvent pattern language.ts /
   * appLock.ts already use, and MainScreen switches to 'communities'.
   */
  const openChannelDiscovery = () => {
    window.dispatchEvent(new CustomEvent('pinglo:switch-tab', { detail: 'communities' }));
  };

  /**
   * #251 — Reply to the viewed status: SENDS IMMEDIATELY into the
   * poster's DM, quoted against the status, as WhatsApp does. Same write
   * ChatScreen's sendTextNow does (addDoc through database.ts putRaw, so
   * 1-to-1 text gets the same E2EE encryption and the same fail-closed
   * behaviour), same replyTo shape ChatScreen renders, same best-effort
   * realtime relay. The quote carries fromChatId 'status' so tapping it
   * in the DM says "Original message is in <name>'s status" (ChatScreen's
   * cross-chat guard) instead of scrolling to a message id that is not
   * in this chat. putRaw encrypts replyTo.text into replyTo.e2ee and the
   * decrypt path restores it (e2eeChat.ts), so the quote round-trips.
   * Results: 'sent'/'queued' close the inline composer + viewer and open
   * the DM (queued shows greyed there, like a queued chat message); an
   * encryption failure sends nothing and queues nothing, so the inline
   * composer stays open with the text intact for retry. No draft is written.
   */
  const handleStatusReplySend = async (text: string) => {
    if (!currentUser) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // Snapshotted at sheet-open time (see replyTarget); fall back to the
    // currently viewed status only if the sheet was opened without one.
    const target = replyTarget || (viewingStatus ? { posterUid: viewingStatus.userId, posterName: viewingStatus.name, status: viewingStatus.statuses?.[statusIdx] } : null);
    if (!target) return;
    const conversationId = getConversationId(currentUser.uid, target.posterUid);
    const msgData: any = {
      text: trimmed,
      senderId: currentUser.uid,
      senderName: currentUser.displayName || 'User',
      senderAvatar: currentUser.photoURL || '',
      timestamp: serverTimestamp(),
      status: 'sent',
      replyTo: {
        id: `status:${target.status?.id || 'unknown'}`,
        text: statusPreviewFor(target.status),
        senderName: target.posterName,
        fromChatId: 'status',
        fromChatName: `${target.posterName}'s status`,
      },
    };
    const closeAndOpenDm = () => {
      setInlineReplyOpen(false);
      setInlineReplyText('');
      setReplyTarget(null);
      setViewingStatus(null);
      setStatusIdx(0);
      navigate(`/chat/${target.posterUid}`);
    };
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), msgData);
      try {
        realtimeSync.sendMessage(target.posterUid, {
          conversationId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          text: trimmed,
          timestamp: Date.now(),
        } as any);
      } catch {
        // Best-effort relay only — the message itself already sent.
      }
      closeAndOpenDm();
    } catch (e) {
      if (isEncryptionFailedError(e)) {
        // Fail-closed E2EE: nothing sent or queued — keep the inline
        // composer open with the text intact so the user can retry once
        // keys exchange.
        showToastMsg('Encryption failed — reply not sent. Try again once the keys are exchanged.');
        return;
      }
      // Any other failure: putRaw queued the doc in the offline outbox
      // before throwing (same as ChatScreen's 'queued' branch) — it WILL
      // send on reconnect, so open the DM where it shows queued.
      showToastMsg('Offline — reply queued, will send when reconnected');
      closeAndOpenDm();
    }
  };

  const formatViewedAt = (ms: number | null) => {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const myStatusGroup = statuses.find(s => s.userId === currentUser?.uid);
  const otherStatuses = statuses.filter(s => s.userId !== currentUser?.uid);
  // WA verify status-3 S28 — search matches the poster name AND the
  // updates' own text (text statuses + photo/video captions). The old
  // filter was name-only, so searching for words in a status never
  // matched anything.
  const filteredOthers = otherStatuses.filter(g => {
    if (!searchQ.trim()) return true;
    const q = searchQ.trim().toLowerCase();
    if ((g.name || '').toLowerCase().includes(q)) return true;
    return (g.statuses || []).some((s: any) => (s.textContent || '').toLowerCase().includes(q));
  });
  // WA verify status-3 S28 — the Channels section on the same Updates
  // tab ignored the query entirely; filter it by channel name too.
  const filteredChannels = channels.filter((ch: any) =>
    !searchQ.trim() || (ch.name || '').toLowerCase().includes(searchQ.trim().toLowerCase())
  );
  // Phase 4 — muted posters never appear in the main list.
  const visibleOthers = filteredOthers.filter(g => !mutedUids.includes(g.userId));
  const mutedOthers = filteredOthers.filter(g => mutedUids.includes(g.userId));
  // Phase 5 (Agent B) — WhatsApp split: unviewed under "Recent updates"
  // (green ring), viewed under "Viewed updates" (grey ring).
  const unviewedOthers = visibleOthers.filter(g => g.hasUnseen);
  const viewedOthers = visibleOthers.filter(g => !g.hasUnseen);
  const currentViewers = viewingStatus?.statuses?.[statusIdx]?.viewers || [];

  // WA verify status-3 S18 — cross-poster tap navigation. WhatsApp plays
  // statuses straight through posters: tap-next on a poster's last status
  // opens the next poster's first status, tap-prev on the first opens the
  // previous poster's last status. The old handler closed the viewer on
  // next-at-last and did nothing on prev-at-first. The traversal order is
  // the on-screen order at the moment the viewer OPENS (Recent, then
  // Viewed, then Muted), snapshotted in a ref: deriving it live would
  // flip the order mid-viewing — a poster moves from Recent to Viewed
  // the moment their last status is watched, so "next" from them would
  // suddenly point at themselves / close the viewer instead of advancing
  // (headless probe caught this: tap-next on Asha's last status closed
  // the viewer once Asha had become Viewed). The snapshot clears when
  // the viewer closes, so the next open re-reads the list. It never
  // leaves the own-status viewer for other posters.
  const viewerGroupsRef = useRef<any[]>([]);
  useEffect(() => {
    if (!viewingStatus) { viewerGroupsRef.current = []; return; }
    if (viewerGroupsRef.current.length === 0) {
      viewerGroupsRef.current = [...unviewedOthers, ...viewedOthers, ...mutedOthers];
    }
    // Lists intentionally NOT in deps: the order is a per-open snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingStatus]);
  const goViewerPrev = () => {
    if (!viewingStatus) return;
    if (statusIdx > 0) { setStatusIdx(prev => prev - 1); return; }
    const gi = viewerGroupsRef.current.findIndex(g => g.userId === viewingStatus.userId);
    if (gi > 0) {
      const prev = viewerGroupsRef.current[gi - 1];
      setViewingStatus(prev);
      setStatusIdx(Math.max(0, prev.statuses.length - 1));
    }
    // First status of the first poster: stay (WA does nothing here).
  };
  const goViewerNext = () => {
    if (!viewingStatus) return;
    setShowViewerMenu(false);
    if (statusIdx < viewingStatus.statuses.length - 1) { setStatusIdx(prev => prev + 1); return; }
    const gi = viewerGroupsRef.current.findIndex(g => g.userId === viewingStatus.userId);
    if (gi >= 0 && gi < viewerGroupsRef.current.length - 1) {
      setViewingStatus(viewerGroupsRef.current[gi + 1]);
      setStatusIdx(0);
    } else {
      setViewingStatus(null);
      setStatusIdx(0);
    }
  };

  // WA verify status-3 S18/S21 — keyboard prev/next + Escape closes the
  // viewer (WA Web parity). Skipped while any viewer overlay is open or
  // focus is in an editable field, so typing a status reply never
  // navigates. No dep array on purpose: goViewerPrev/goViewerNext are
  // fresh closures each render, so the listener is re-registered.
  useEffect(() => {
    if (!viewingStatus) return;
    const onKey = (e: KeyboardEvent) => {
      if (showViewers || inlineReplyOpen || showViewerMenu || showDeleteConfirm) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goViewerPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goViewerNext(); }
      else if (e.key === 'Escape') { setViewingStatus(null); setStatusIdx(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** WA audit (d) S30 — "Expires in 5h 12m" / "Expires in 42m" for My
   * Status, from latestTime + 24h. `nowTick` re-renders once a minute. */
  const expiresInLabel = (latestTime: any): string => {
    const ms = latestTime?.toMillis ? latestTime.toMillis() : Number(latestTime) || 0;
    if (!ms) return '';
    const left = ms + 24 * 60 * 60 * 1000 - nowTick;
    if (left <= 0) return 'Expiring soon';
    const mins = Math.floor(left / 60000);
    if (mins < 60) return `Expires in ${mins}m`;
    return `Expires in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  return (
    <div className="flex h-full flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary relative">
      {/* App Bar — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-header-green dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          {showSearch ? (
            <div className="flex items-center w-full gap-2">
              <input
                autoFocus
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
                placeholder={tr('searchUpdates')}
                aria-label="Search status updates"
                className="flex-1 bg-white/15 dark:bg-input-dark rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-white/50 text-white dark:text-text-primary placeholder:text-white/80"
              />
              <button onClick={() => { setShowSearch(false); setSearchQ(''); }} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark text-white dark:text-text-primary" aria-label="Close search">
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold text-white dark:text-text-primary">{tr('updates')}</h1>
              <div className="flex items-center space-x-1 text-white/85 dark:text-text-secondary">
                <button onClick={() => setShowSearch(true)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark" aria-label="Search updates">
                  <Search className="h-5 w-5" />
                </button>
                <div className="relative">
                  <button onClick={() => setShowMenu(v => !v)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 dark:hover:bg-input-dark" aria-label="More options" aria-haspopup="menu" aria-expanded={showMenu}>
                    <MoreVertical className="h-5 w-5" />
                  </button>
                  {showMenu && (
                    <div role="menu" className="absolute right-0 top-11 z-50 w-60 bg-panel-light dark:bg-panel-dark rounded-xl shadow-2xl border border-gray-200 dark:border-white/10 py-1 animate-fade-in">
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowPrivacySheet(true); }}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-gray-900 dark:text-text-primary"
                      >
                        <Lock className="h-4 w-4 text-primary-green" /> Status privacy
                      </button>
                      <button
                        role="menuitem"
                        onClick={() => { setShowMenu(false); setShowDeleteMineConfirm(true); }}
                        disabled={!myStatusGroup}
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-danger-red disabled:opacity-40"
                      >
                        <Trash2 className="h-4 w-4" /> Delete my status
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-24">
        {/* My Status */}
        <div className="px-4 py-3">
          <h2 className="text-lg font-semibold mb-3">{tr('status')}</h2>
          <div className="flex items-center justify-between">
            <div
              className="flex items-center cursor-pointer flex-1"
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') { if (myStatusGroup) { setStatusIdx(0); setViewingStatus(myStatusGroup); } else { fileInputRef.current?.click(); } } }}
              onClick={() => {
                if (myStatusGroup) {
                  setStatusIdx(0);
                  setViewingStatus(myStatusGroup);
                } else {
                  fileInputRef.current?.click();
                }
              }}
            >
              <div className="relative">
                <StatusRing size={64} viewed={myStatusGroup ? myStatusGroup.statuses.map(() => false) : []} closeFriends={!!myStatusGroup?.closeFriends}>
                  <DefaultAvatar
                    photoURL={currentUser?.photoURL}
                    name={currentUser?.displayName || 'User'}
                    seed={currentUser?.uid}
                    size={56}
                    alt="My Status"
                  />
                </StatusRing>
                {!myStatusGroup && (
                  <div className="absolute bottom-0 right-0 flex h-5 w-5 items-center justify-center rounded-full border-2 border-bg-light dark:border-bg-dark bg-green-cta text-white">
                    <Plus className="h-3 w-3" />
                  </div>
                )}
              </div>
              <div className="ml-4 flex-1">
                <h3 className="font-medium text-gray-900 dark:text-text-primary">{tr('myStatus')}</h3>
                <p className="text-sm text-gray-500 dark:text-text-secondary">
                  {/* WA audit (d) S30 — expiry countdown from latest + 24h. S3: singular "1 update". */}
                  {myStatusGroup ? `${myStatusGroup.statuses.length} update${myStatusGroup.statuses.length === 1 ? '' : 's'} • ${formatTime(myStatusGroup.latestTime)} • ${expiresInLabel(myStatusGroup.latestTime)}` : tr('tapToAddStatus')}
                </p>
              </div>
            </div>

            {/* Quick add status buttons when user already has a status */}
            {myStatusGroup && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowComposeText(true)}
                  className="p-2.5 rounded-full bg-gray-100 dark:bg-input-dark hover:bg-gray-200 dark:hover:bg-panel-dark text-gray-700 dark:text-text-primary transition"
                  title="Add text status"
                  aria-label="Add text status"
                >
                  <Type className="h-4 w-4" />
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2.5 rounded-full bg-green-cta text-white hover:bg-dark-green transition shadow-md"
                  title="Add photo/video status"
                  aria-label="Add photo or video status"
                >
                  <Camera className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {/* Privacy selector for my status */}
          <div className="mt-3 ml-[72px] flex items-center gap-2">
            <button
              onClick={() => setShowPrivacySheet(true)}
              className="flex items-center gap-1.5 text-xs bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5 text-gray-600 dark:text-text-secondary hover:bg-gray-200 dark:hover:bg-panel-dark transition"
              aria-label="Change status privacy"
            >
              {PRIVACY_ICONS[textStatusPrivacy]}
              <span className="text-primary-green">{PRIVACY_LABELS[textStatusPrivacy]}</span>
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
        </div>

        <div className="h-2 w-full bg-gray-100 dark:bg-panel-dark/30" />

        {/* Recent Updates */}
        <div className="px-4 py-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-text-secondary mb-3">{tr('recentUpdates')}</h3>
          {loadingStatuses ? (
            <ListSkeleton rows={3} />
          ) : (
            <div className="space-y-4">
              {unviewedOthers.map((statusGroup) => (
                <div key={statusGroup.userId} className="flex items-center" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { setStatusIdx(0); setViewingStatus(statusGroup); } }} onClick={() => { setStatusIdx(0); setViewingStatus(statusGroup); }}>
                  {/* WA audit (d) S7: list avatar 48px → 49px (WA chat-list
                      avatar), ring 56px → 57px to keep the 4px inset. */}
                  <StatusRing size={57} viewed={statusGroup.statuses.map((s: any) => (s.viewers || []).includes(currentUser?.uid))} closeFriends={!!statusGroup.closeFriends}>
                    <DefaultAvatar photoURL={statusGroup.avatar} name={statusGroup.name} seed={statusGroup.userId} size={49} />
                  </StatusRing>
                  <div className="ml-4 border-b border-gray-200 dark:border-white/5 pb-3 flex-1 cursor-pointer">
                    <h3 className="font-medium text-gray-900 dark:text-text-primary">{statusGroup.name}</h3>
                    <p className="text-sm text-gray-500 dark:text-text-secondary">{formatTime(statusGroup.latestTime)}</p>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); void toggleMuteStatus(statusGroup.userId, statusGroup.name); }}
                    className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-gray-500 hover:text-gray-600 dark:hover:text-text-secondary flex-shrink-0"
                    title={`Mute ${statusGroup.name}'s status updates`}
                    aria-label={`Mute ${statusGroup.name}'s status updates`}
                  >
                    <VolumeX className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {unviewedOthers.length === 0 && viewedOthers.length === 0 && mutedOthers.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
                  <CircleDashed className="h-12 w-12 text-gray-300 dark:text-gray-600" />
                  <p className="text-sm font-medium text-gray-500 dark:text-text-secondary">
                    {searchQ ? tr('noMatchingUpdates') : tr('noRecentUpdates')}
                  </p>
                  {!searchQ && <p className="text-xs text-gray-500 dark:text-text-secondary">When contacts post a status, it will show up here.</p>}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Phase 5 (Agent B) — Viewed updates: grey ring, like WhatsApp. */}
        {viewedOthers.length > 0 && (
          <div className="px-4 py-3">
            <h3 className="text-sm font-medium text-gray-500 dark:text-text-secondary mb-3">{tr('viewedUpdates')}</h3>
            <div className="space-y-4">
              {viewedOthers.map((statusGroup) => (
                <div key={statusGroup.userId} className="flex items-center" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { setStatusIdx(0); setViewingStatus(statusGroup); } }} onClick={() => { setStatusIdx(0); setViewingStatus(statusGroup); }}>
                  <StatusRing size={57} viewed={statusGroup.statuses.map((s: any) => (s.viewers || []).includes(currentUser?.uid))} closeFriends={!!statusGroup.closeFriends}>
                    <DefaultAvatar photoURL={statusGroup.avatar} name={statusGroup.name} seed={statusGroup.userId} size={49} />
                  </StatusRing>
                  <div className="ml-4 border-b border-gray-200 dark:border-white/5 pb-3 flex-1 cursor-pointer">
                    <h3 className="font-medium text-gray-900 dark:text-text-primary">{statusGroup.name}</h3>
                    <p className="text-sm text-gray-500 dark:text-text-secondary">{formatTime(statusGroup.latestTime)}</p>
                  </div>
                  {/* R2b/R2c: viewed rows had no mute button — once a status was
                      marked viewed, muting that poster became unreachable from
                      Updates (the viewer has no mute action either). Same button
                      as the unviewed rows. */}
                  <button
                    onClick={e => { e.stopPropagation(); void toggleMuteStatus(statusGroup.userId, statusGroup.name); }}
                    className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-gray-500 hover:text-gray-600 dark:hover:text-text-secondary flex-shrink-0"
                    title={`Mute ${statusGroup.name}'s status updates`}
                    aria-label={`Mute ${statusGroup.name}'s status updates`}
                  >
                    <VolumeX className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Phase 4 — Muted updates: muted posters' statuses live here only. */}
        {mutedOthers.length > 0 && (
          <div className="px-4 py-3">
            <h3 className="text-sm font-medium text-gray-500 dark:text-text-secondary mb-3">{tr('mutedUpdates')}</h3>
            <div className="space-y-4">
              {mutedOthers.map((statusGroup) => (
                <div key={statusGroup.userId} className="flex items-center opacity-70">
                  <div className="cursor-pointer" role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') { setStatusIdx(0); setViewingStatus(statusGroup); } }} onClick={() => { setStatusIdx(0); setViewingStatus(statusGroup); }}>
                    <StatusRing size={57} viewed={statusGroup.statuses.map((s: any) => (s.viewers || []).includes(currentUser?.uid))} closeFriends={!!statusGroup.closeFriends}>
                      <DefaultAvatar photoURL={statusGroup.avatar} name={statusGroup.name} seed={statusGroup.userId} size={49} className="grayscale" />
                    </StatusRing>
                  </div>
                  <div className="ml-4 border-b border-gray-200 dark:border-white/5 pb-3 flex-1 cursor-pointer" onClick={() => { setStatusIdx(0); setViewingStatus(statusGroup); }}>
                    <h3 className="font-medium text-gray-900 dark:text-text-primary">{statusGroup.name}</h3>
                    <p className="text-sm text-gray-500 dark:text-text-secondary">{formatTime(statusGroup.latestTime)}</p>
                  </div>
                  <button
                    onClick={() => void toggleMuteStatus(statusGroup.userId, statusGroup.name)}
                    className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-primary-green flex-shrink-0"
                    title={`Unmute ${statusGroup.name}'s status updates`}
                    aria-label={`Unmute ${statusGroup.name}'s status updates`}
                  >
                    <Volume2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SBS fix 6 — Channels section (WhatsApp shows Channels under
            Status). Lists channels you follow; tap opens the
            channel chat. #253: the section is no longer a dead end —
            "Find channels" switches to the Communities tab, where
            discovery (search + list + Follow) lives. */}
        <div className="mt-6 px-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-500 dark:text-text-secondary">{tr('channels')}</h3>
            <button
              onClick={openChannelDiscovery}
              className="flex items-center gap-0.5 text-sm font-medium text-primary-green hover:underline"
              aria-label={tr('findChannels')}
            >
              <Search className="h-3.5 w-3.5" /> {tr('findChannels')} <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {filteredChannels.length === 0 ? (
            <div className="px-1">
              <p className="text-sm text-gray-500 dark:text-text-secondary">{searchQ ? `No channels matching "${searchQ}".` : tr('noChannelsYet')}</p>
              <button
                onClick={openChannelDiscovery}
                className="mt-2 text-sm font-medium text-primary-green hover:underline"
                aria-label={tr('findChannels')}
              >
                {tr('findChannels')}
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredChannels.map((ch: any) => {
                // WA verify status-4 row C2: same count + photo rules as
                // the CommunitiesScreen channel card (#154/#187) — the
                // stored memberCount drifts, so recompute from members,
                // and a channel photo wins over the emoji tile.
                // Kept on filteredChannels (status-3 S28): the list stays
                // search-filtered; C1 followed-only is the filter source.
                const subs = getSubscriberCount(ch);
                const subsLabel = formatMemberCount(subs, true);
                return (
                  <div
                    key={ch.id}
                    className="flex items-center gap-3 cursor-pointer"
                    onClick={() => navigate(`/chat/${ch.id}?type=community`)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') navigate(`/chat/${ch.id}?type=community`); }}
                    aria-label={`${ch.name}, channel, ${subsLabel}`}
                  >
                    {ch.photoURL ? (
                      <img src={ch.photoURL} alt="" className="h-14 w-14 rounded-xl object-cover flex-shrink-0" />
                    ) : (
                      <div className="h-14 w-14 rounded-xl bg-header-green/10 dark:bg-sent-bubble/25 flex items-center justify-center text-3xl flex-shrink-0" aria-hidden="true">
                        {ch.emoji || '📣'}
                      </div>
                    )}
                    <div className="flex-1 min-w-0 border-b border-gray-200 dark:border-white/5 pb-3">
                      <div className="flex items-center gap-1.5">
                        <h3 className="font-medium text-gray-900 dark:text-text-primary truncate">{ch.name}</h3>
                        <span className="flex items-center gap-0.5 text-[10px] font-bold text-primary-green bg-primary-green/10 px-1.5 py-0.5 rounded-full flex-shrink-0">
                          <Megaphone className="h-3 w-3" /> Channel
                        </span>
                      </div>
                      <p className="text-sm text-gray-500 dark:text-text-secondary truncate">{ch.description || 'Announcement channel'}</p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">{subsLabel}</p>
                    </div>
                    {/* WA audit (d) C10 — channel mute, same pref the chat
                        list / GroupInfoModal write (chatPrefs muted). */}
                    <button
                      onClick={e => { e.stopPropagation(); void toggleChannelMute(ch); }}
                      className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark text-gray-500 hover:text-gray-600 dark:hover:text-text-secondary flex-shrink-0"
                      title={channelMuted[cleanId(ch.id)] ? `Unmute ${ch.name}` : `Mute ${ch.name}`}
                      aria-label={channelMuted[cleanId(ch.id)] ? `Unmute channel ${ch.name}` : `Mute channel ${ch.name}`}
                      aria-pressed={!!channelMuted[cleanId(ch.id)]}
                    >
                      {channelMuted[cleanId(ch.id)] ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <input type="file" ref={fileInputRef} onChange={handleUploadStatus} className="hidden" accept="image/*,video/*" />

      {/* Photo status editor (REPORT-2 bug #10): opens on pick, BEFORE any
          upload attempt. Cancel uploads nothing; Post uploads + posts. */}
      {photoEditor && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col" role="dialog" aria-modal="true" aria-label="Photo status editor">
          <div className="pt-safe flex items-center justify-between px-2 py-2 text-white flex-shrink-0">
            <button onClick={closePhotoEditor} aria-label="Cancel photo status" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10">
              <X className="h-6 w-6" />
            </button>
            <h3 className="text-base font-semibold">Photo status</h3>
            <div className="w-11" />
          </div>
          <div className="flex-1 min-h-0 flex items-center justify-center px-4 py-2">
            {photoEditor.isVideo ? (
              <video src={photoEditor.previewUrl} controls className="max-h-full max-w-full rounded-lg" />
            ) : (
              <img src={photoEditor.previewUrl} alt="Status preview" className="max-h-full max-w-full rounded-lg object-contain" />
            )}
          </div>
          {/* WA72 S16: link sticker on a photo/video status — same
              https-only validation as the text composer (normalizeStatusLink). */}
          <div className="px-4 pb-2 flex-shrink-0">
            <div className="flex gap-2">
              <div className="flex-1 flex items-center gap-1.5 bg-white/15 rounded-full px-3 py-2 min-w-0">
                <Link2 className="h-4 w-4 text-white/80 flex-shrink-0" />
                <input
                  value={statusLinkInput}
                  onChange={e => { setStatusLinkInput(e.target.value); setStatusLinkError(''); }}
                  placeholder="Add a link (https://…)"
                  aria-label="Add a link to photo status"
                  inputMode="url"
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-white/70 outline-none min-w-0"
                />
                {statusLink && (
                  <button type="button" onClick={() => { setStatusLink(null); setStatusLinkInput(''); }} aria-label="Remove link" className="text-white/70 hover:text-white flex-shrink-0"><X className="h-4 w-4" /></button>
                )}
              </div>
              <button
                type="button"
                disabled={!statusLinkInput.trim() || !!statusLink}
                onClick={() => {
                  const url = normalizeStatusLink(statusLinkInput);
                  if (!url) {
                    setStatusLinkError('Only https links can be added.');
                    return;
                  }
                  setStatusLink(url);
                  setStatusLinkError('');
                }}
                className="px-3 py-2 bg-white/15 text-white rounded-full text-sm font-semibold disabled:opacity-40"
              >
                Add link
              </button>
            </div>
            {statusLinkError && <p className="text-[11px] text-red-300 mt-1" role="alert">{statusLinkError}</p>}
            {statusLink && (
              <p className="text-[11px] text-white/70 mt-1 truncate">
                Link sticker: <span className="underline">{linkHostLabel(statusLink)}</span>
              </p>
            )}
          </div>
          <div className="pb-safe flex items-center gap-2 p-4 flex-shrink-0">
            <input
              type="text"
              value={photoCaption}
              onChange={(e) => setPhotoCaption(e.target.value)}
              placeholder="Add a caption…"
              aria-label="Status caption"
              maxLength={500}
              className="flex-1 min-w-0 bg-white/15 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-white/80 outline-none focus:ring-2 focus:ring-white/50"
            />
            <button
              onClick={() => void postPhotoStatus()}
              disabled={uploading}
              aria-label="Post photo status"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-cta text-white shadow-lg hover:bg-dark-green transition-colors disabled:opacity-50"
            >
              {uploading
                ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                : <Send className="h-5 w-5 ml-0.5" />}
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* Status privacy sheet */}
      {showPrivacySheet && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end" onClick={() => setShowPrivacySheet(false)} role="dialog" aria-modal="true" aria-label="Status privacy">
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">{tr('statusPrivacy')}</h3>
              <button onClick={() => setShowPrivacySheet(false)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
              Who can see your next status update? This applies to new statuses you post. Status privacy is not enforced on the server yet — anyone who can load statuses can see them.
            </p>
            <div className="space-y-1">
              {/* AUDIT-2 A7: 'contacts' is not listed as a new choice. W28: a stored 'contacts' value is now genuinely contacts-only (gated snapshot). */}
              {(Object.keys(PRIVACY_LABELS) as StatusPrivacy[]).filter(p => p !== 'contacts').map(p => (
                <button
                  key={p}
                  onClick={() => setTextStatusPrivacy(p)}
                  aria-pressed={textStatusPrivacy === p}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                    textStatusPrivacy === p
                      ? 'bg-primary-green/10 text-primary-green'
                      : 'text-gray-900 dark:text-text-primary hover:bg-gray-100 dark:hover:bg-input-dark'
                  }`}
                >
                  <span className="flex items-center gap-2.5">{PRIVACY_ICONS[p]}{PRIVACY_LABELS[p]}</span>
                  {textStatusPrivacy === p && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
            {textStatusPrivacy === 'contacts' && (
              <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
                This older audience is now genuinely contacts-only — it reaches your saved contacts and people you have chatted with. It is still client-side only: server enforcement needs backend rules.
              </p>
            )}
            {textStatusPrivacy === 'closeFriends' && (
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">
                  Close Friends ({closeFriends.length} selected) — only these people can see a status posted to Close Friends. Their ring is purple.
                </p>
                {contacts.length === 0 ? (
                  <p className="text-xs text-gray-500 py-2">No contacts to add yet — add contacts first, then pick your Close Friends here.</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
                    {contacts.map(c => {
                      const uid = c.uid || c.id;
                      const selected = closeFriends.includes(uid);
                      const name = c.displayName || c.username || 'User';
                      return (
                        <div
                          key={uid}
                          onClick={() => void toggleCloseFriend(uid)}
                          className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60"
                          role="checkbox"
                          aria-checked={selected}
                          tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggleCloseFriend(uid); } }}
                        >
                          <DefaultAvatar photoURL={c.photoURL} name={name} seed={uid} size={36} />
                          <span className="flex-1 text-sm font-medium text-gray-900 dark:text-text-primary truncate">{name}</span>
                          <span className={`h-5 w-5 rounded-full flex items-center justify-center border ${selected ? 'bg-[#C15ADD] border-[#C15ADD] text-white' : 'border-gray-400'}`}>
                            {selected && <Check className="h-3 w-3 stroke-[3]" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {textStatusPrivacy === 'exclude' && (
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">
                  Hide from ({privacyExclude.length} selected)
                </p>
                {contacts.length === 0 ? (
                  <p className="text-xs text-gray-500 py-2">No contacts to exclude.</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
                    {contacts.map(c => {
                      const uid = c.uid || c.id;
                      const selected = privacyExclude.includes(uid);
                      const name = c.displayName || c.username || 'User';
                      return (
                        <div
                          key={uid}
                          onClick={() => setPrivacyExclude(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid])}
                          className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60"
                          role="checkbox"
                          aria-checked={selected}
                          tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrivacyExclude(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]); } }}
                        >
                          <DefaultAvatar photoURL={c.photoURL} name={name} seed={uid} size={36} />
                          <span className="flex-1 text-sm font-medium text-gray-900 dark:text-text-primary truncate">{name}</span>
                          <span className={`h-5 w-5 rounded-full flex items-center justify-center border ${selected ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400'}`}>
                            {selected && <Check className="h-3 w-3 stroke-[3]" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {textStatusPrivacy === 'onlyShare' && (
              <div>
                <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">
                  Share with ({privacyAllow.length} selected) — only these people can see a status posted to “Only share with…”.
                </p>
                {contacts.length === 0 ? (
                  <p className="text-xs text-gray-500 py-2">No contacts to share with yet — add contacts first, then pick them here.</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
                    {contacts.map(c => {
                      const uid = c.uid || c.id;
                      const selected = privacyAllow.includes(uid);
                      const name = c.displayName || c.username || 'User';
                      return (
                        <div
                          key={uid}
                          onClick={() => setPrivacyAllow(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid])}
                          className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60"
                          role="checkbox"
                          aria-checked={selected}
                          tabIndex={0}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPrivacyAllow(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]); } }}
                        >
                          <DefaultAvatar photoURL={c.photoURL} name={name} seed={uid} size={36} />
                          <span className="flex-1 text-sm font-medium text-gray-900 dark:text-text-primary truncate">{name}</span>
                          <span className={`h-5 w-5 rounded-full flex items-center justify-center border ${selected ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400'}`}>
                            {selected && <Check className="h-3 w-3 stroke-[3]" />}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => setShowPrivacySheet(false)}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green transition"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Delete single status confirm */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowDeleteConfirm(false)} role="dialog" aria-modal="true" aria-label="Delete status">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete this status update?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">It will be removed for everyone.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition">Cancel</button>
              <button onClick={handleDeleteStatus} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete all my statuses confirm */}
      {showDeleteMineConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowDeleteMineConfirm(false)} role="dialog" aria-modal="true" aria-label="Delete my status">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Delete all my status updates?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">This removes every status you posted in the last 24 hours.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteMineConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition">Cancel</button>
              <button onClick={handleDeleteMyStatus} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition">Delete all</button>
            </div>
          </div>
        </div>
      )}

      {/* Audit #8: confirm before discarding a longer voice-status take.
          Short taps (under 10 s) discard at once; this dialog only opens
          for takes of 10 s or more. The recording keeps running while the
          dialog is open — Discard stops it, Keep recording closes this. */}
      {showCancelVoiceConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowCancelVoiceConfirm(false)} role="dialog" aria-modal="true" aria-label="Discard voice status recording">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Discard this recording?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">This voice status is {voiceStatusSecs} seconds long. Discarding deletes the recording.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowCancelVoiceConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Keep recording</button>
              <button onClick={() => { setShowCancelVoiceConfirm(false); stopVoiceStatus(false); }} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-opacity">Discard</button>
            </div>
          </div>
        </div>
      )}

      {/* Text Status Compose Modal */}
      {showComposeText && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end" role="dialog" aria-modal="true" aria-label="Post a text status">
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">{tr('postStatus')}</h3>
              <button onClick={() => setShowComposeText(false)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <textarea
              autoFocus
              value={textStatusContent}
              onChange={(e) => setTextStatusContent(e.target.value)}
              placeholder="Kya chal raha hai? Kuch likh de..."
              rows={4}
              aria-label="Status text"
              className="w-full bg-gray-50 dark:bg-input-dark rounded-xl px-4 py-3 text-sm text-gray-900 dark:text-text-primary resize-none outline-none focus:ring-2 focus:ring-primary-green placeholder:text-gray-500"
              maxLength={280}
            />
            <div className="flex justify-between items-center">
              <span className="text-xs text-gray-500 tabular-nums">{textStatusContent.length}/280</span>
              <button
                onClick={() => setShowPrivacySheet(true)}
                className="flex items-center gap-1.5 text-xs bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5 hover:bg-gray-200 transition"
                aria-label="Change status privacy"
              >
                {PRIVACY_ICONS[textStatusPrivacy]}
                <span className="text-primary-green">{PRIVACY_LABELS[textStatusPrivacy]}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
            </div>
            {/* WA audit (d) S14 — background + font picker. Stored as
                bgStyle / fontStyle on the status doc; the viewer renders
                the same gradient/font. */}
            <div className="space-y-2">
              <div className="flex items-center gap-2" role="group" aria-label="Text status background">
                <span className="text-xs font-medium text-gray-500 dark:text-text-secondary">Background</span>
                {TEXT_STATUS_STYLES.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setTextBg(s.id)}
                    aria-label={`Background ${s.label}`}
                    aria-pressed={textBg === s.id}
                    title={s.label}
                    className={`h-9 w-9 rounded-full bg-gradient-to-br ${s.bg} transition-all ${textBg === s.id ? 'ring-2 ring-primary-green ring-offset-2 ring-offset-panel-light dark:ring-offset-panel-dark scale-110' : 'opacity-70 hover:opacity-100'}`}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2" role="group" aria-label="Text status font">
                <span className="text-xs font-medium text-gray-500 dark:text-text-secondary">Font</span>
                {TEXT_STATUS_FONTS.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setTextFont(f.id)}
                    aria-pressed={textFont === f.id}
                    className={`px-3 py-1.5 rounded-full text-sm font-semibold transition-colors ${textFont === f.id ? 'bg-primary-green/10 text-primary-green' : 'bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary'} ${f.cls}`}
                  >
                    Aa · {f.label}
                  </button>
                ))}
              </div>
            </div>
            {/* Cluster C (Item 11b): stickers on a text status */}
            <div>
              <button
                type="button"
                onClick={() => setShowStatusStickerPicker(v => !v)}
                className="flex items-center gap-1.5 text-xs bg-gray-100 dark:bg-input-dark rounded-full px-3 py-1.5 hover:bg-gray-200 transition"
                aria-label="Add sticker to status"
                aria-expanded={showStatusStickerPicker}
              >
                <Smile className="h-4 w-4 text-primary-green" /> Add sticker {statusStickers.length ? `(${statusStickers.length})` : ''}
              </button>
              {statusStickers.length > 0 && (
                <p className="text-[11px] text-gray-500 mt-1.5">Tap a placed sticker to remove it.</p>
              )}
              {showStatusStickerPicker && (
                <div className="mt-2">
                  <div className="grid grid-cols-8 gap-1 max-h-28 overflow-y-auto">
                    {ALL_STICKERS.slice(0, 48).map(st => (
                      <button
                        key={st.id}
                        type="button"
                        title={st.label}
                        aria-label={`Add sticker ${st.label}`}
                        disabled={statusStickers.length >= 5}
                        onClick={() => {
                          const slots = [{ x: 12, y: 14 }, { x: 68, y: 12 }, { x: 18, y: 62 }, { x: 64, y: 58 }, { x: 42, y: 38 }];
                          const slot = slots[statusStickers.length % slots.length];
                          // 100M-H21: keep the sticker IMAGE (same
                          // /stickers/fluent-3d/*.webp the chat picker
                          // sends) — the old code stored only the emoji,
                          // so the status rendered 😂 instead of the art.
                          // Emoji stays as the fallback for legacy packs
                          // and old docs without `image`.
                          setStatusStickers(prev => [...prev, { id: `${st.id}-${Date.now()}`, emoji: st.art, ...(st.image ? { image: st.image } : {}), ...slot }]);
                        }}
                        className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark disabled:opacity-30 flex items-center justify-center"
                      >
                        {st.image ? <img src={st.image} alt={st.label} className="h-7 w-7 object-contain" /> : <span className="text-2xl">{st.art}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input
                      value={textSticker}
                      onChange={e => setTextSticker(e.target.value)}
                      placeholder="Text sticker…"
                      aria-label="Text sticker"
                      maxLength={30}
                      className="flex-1 bg-gray-50 dark:bg-input-dark rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-green min-w-0"
                    />
                    <button
                      type="button"
                      disabled={!textSticker.trim() || !!textStickerPos}
                      onClick={() => setTextStickerPos({ x: 30, y: 8 })}
                      className="px-3 py-2 bg-primary-green/10 text-primary-green rounded-xl text-sm font-semibold disabled:opacity-40"
                    >
                      Add text
                    </button>
                    {textStickerPos && (
                      <button type="button" onClick={() => { setTextStickerPos(null); setTextSticker(''); }} className="px-3 py-2 bg-gray-100 dark:bg-input-dark rounded-xl text-sm">Remove</button>
                    )}
                  </div>
                </div>
              )}
              {(statusStickers.length > 0 || textStickerPos) && (
                <div className={`relative mt-2 h-28 rounded-xl bg-gradient-to-br ${(TEXT_STATUS_STYLES.find(s => s.id === textBg) || TEXT_STATUS_STYLES[0]).bg} overflow-hidden`}>
                  <p className={`absolute inset-0 flex items-center justify-center text-white text-sm font-bold px-4 text-center ${(TEXT_STATUS_FONTS.find(f => f.id === textFont) || TEXT_STATUS_FONTS[0]).cls}`}>{textStatusContent || 'Your text…'}</p>
                  {statusStickers.map(st => (
                    <button key={st.id} type="button" title="Remove sticker" aria-label="Remove sticker" onClick={() => setStatusStickers(prev => prev.filter(x => x.id !== st.id))} className="absolute" style={{ left: `${st.x}%`, top: `${st.y}%` }}>
                      {st.image ? <img src={st.image} alt="Sticker" className="h-8 w-8 object-contain drop-shadow" /> : <span className="text-3xl">{st.emoji}</span>}
                    </button>
                  ))}
                  {textStickerPos && textSticker.trim() && (
                    <span className="absolute bg-black/40 text-white text-sm font-bold px-2 py-0.5 rounded-full" style={{ left: `${textStickerPos.x}%`, top: `${textStickerPos.y}%` }}>{textSticker.trim()}</span>
                  )}
                </div>
              )}
            </div>
            {/* Nightshift — link sticker + @mention (same row as stickers). */}
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1 flex items-center gap-1.5 bg-gray-50 dark:bg-input-dark rounded-xl px-3 py-2 min-w-0">
                  <Link2 className="h-4 w-4 text-primary-green flex-shrink-0" />
                  <input
                    value={statusLinkInput}
                    onChange={e => { setStatusLinkInput(e.target.value); setStatusLinkError(''); }}
                    placeholder="Add a link (https://…)"
                    aria-label="Add a link to status"
                    inputMode="url"
                    className="flex-1 bg-transparent text-sm outline-none min-w-0"
                  />
                  {statusLink && (
                    <button type="button" onClick={() => { setStatusLink(null); setStatusLinkInput(''); }} aria-label="Remove link" className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X className="h-4 w-4" /></button>
                  )}
                </div>
                <button
                  type="button"
                  disabled={!statusLinkInput.trim() || !!statusLink}
                  onClick={() => {
                    const url = normalizeStatusLink(statusLinkInput);
                    if (!url) {
                      setStatusLinkError(statusLinkInput.trim().toLowerCase().startsWith('http://') || /^[a-z][a-z0-9+.-]*:/i.test(statusLinkInput.trim())
                        ? 'Only https links can be added — http and other links are not tappable.'
                        : 'Enter a valid link, e.g. https://example.com');
                      return;
                    }
                    setStatusLink(url);
                    setStatusLinkError('');
                  }}
                  className="px-3 py-2 bg-primary-green/10 text-primary-green rounded-xl text-sm font-semibold disabled:opacity-40"
                >
                  Add link
                </button>
                <button
                  type="button"
                  onClick={() => setShowMentionPicker(v => !v)}
                  aria-label="Mention a contact"
                  aria-expanded={showMentionPicker}
                  title="Mention a contact"
                  className="px-3 py-2 bg-primary-green/10 text-primary-green rounded-xl text-sm font-semibold flex items-center gap-1"
                >
                  <AtSign className="h-4 w-4" /> @
                </button>
              </div>
              {statusLinkError && <p className="text-[11px] text-red-500" role="alert">{statusLinkError}</p>}
              {statusLink && (
                <p className="text-[11px] text-gray-500 dark:text-text-secondary truncate">
                  Link sticker: <span className="text-primary-green underline">{linkHostLabel(statusLink)}</span> — tap to remove it above.
                </p>
              )}
              {showMentionPicker && (
                <div className="max-h-36 overflow-y-auto rounded-xl border border-gray-200 dark:border-white/10 divide-y divide-gray-100 dark:divide-white/5" role="listbox" aria-label="Mention a contact">
                  {contacts.length === 0 && <p className="text-xs text-gray-400 p-3">No contacts to mention yet.</p>}
                  {contacts.map((c: any) => {
                    const uid = c.uid || c.id;
                    const username = c.username || (c.displayName || 'user').replace(/[^A-Za-z0-9_]/g, '').toLowerCase() || 'user';
                    const already = statusMentions.some(m => m.uid === uid);
                    return (
                      <button
                        key={uid}
                        type="button"
                        disabled={already}
                        onClick={() => {
                          setStatusMentions(prev => [...prev, { uid, username, displayName: c.displayName || c.name || username }]);
                          setTextStatusContent(prev => (prev ? prev + ' ' : '') + `@${username} `);
                          setShowMentionPicker(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-input-dark disabled:opacity-40"
                      >
                        <DefaultAvatar photoURL={c.photoURL} name={c.displayName || c.name} seed={uid} size={28} />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium truncate">{c.displayName || c.name || username}</span>
                          <span className="block text-xs text-gray-400 truncate">@{username}</span>
                        </span>
                        {already && <span className="text-xs text-primary-green">Added</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              onClick={handlePostTextStatus}
              disabled={!textStatusContent.trim() || uploading}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green disabled:opacity-40 transition"
            >
              {uploading ? 'Posting...' : tr('postStatus')}
            </button>
          </div>
        </div>
      )}

      {/* FABs */}
      <div className="absolute bottom-4 right-4 flex flex-col space-y-3">
        {uploading && (
          <div className="flex items-center justify-center bg-panel-light dark:bg-panel-dark rounded-xl p-2 shadow-lg mb-2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-green border-t-transparent mr-2"></div>
            <span className="text-sm">Uploading...</span>
          </div>
        )}
        {/* #252 — WhatsApp-style FABs: green circular pencil FAB for text
            status at the bottom, smaller circular camera FAB above it for
            photo/video. (Was three grey rounded-square buttons.) Voice
            status keeps its smaller circular FAB above the camera one. */}
        {isRecVoiceStatus ? (
          <>
            {/* Audit #7: the 60 s auto-stop fires with no warning — show a
                countdown cue for the last 10 seconds so the stop is not a
                surprise. */}
            {voiceStatusSecs >= 50 && (
              <div role="status" className="flex items-center justify-center bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 rounded-full shadow-lg px-3 py-1.5">
                <span className="text-xs font-medium tabular-nums">Stopping in {60 - voiceStatusSecs}s</span>
              </div>
            )}
            <div className="flex items-center gap-2 bg-panel-light dark:bg-panel-dark rounded-full shadow-lg px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm font-medium tabular-nums">{Math.floor(voiceStatusSecs / 60)}:{String(voiceStatusSecs % 60).padStart(2, '0')} / 1:00</span>
              {/* Audit #10: live mic level — 14 waveform bars driven by an
                  AnalyserNode (same pattern as ChatScreen #208). Bar heights
                  + data-rec-rms are written by the rAF loop, not by React
                  state, so the loop never re-renders the screen. */}
              <div ref={voiceStatusLevelHostRef} data-rec-live="false" data-rec-rms="0.000" aria-label="Microphone level, live" className="flex h-6 items-center gap-[2px] flex-shrink-0">
                {Array.from({ length: 14 }).map((_, i) => (
                  <span key={i} className="w-[3px] rounded-full bg-primary-green" style={{ height: '4px' }} />
                ))}
              </div>
              {/* Audit #6: Stop/Cancel had no hover/active states while the
                  sibling FAB has hover:opacity-90 — match it. */}
              <button ref={stopVoiceStatusBtnRef} onClick={() => stopVoiceStatus(true)} className="p-2 rounded-full bg-green-cta text-white hover:opacity-90 active:scale-95 transition-opacity" aria-label="Stop and post voice status" title="Stop and post">
                <Square className="h-4 w-4" />
              </button>
              {/* Audit #8: Cancel discards any length with no confirm — a
                  take of 10 s or more asks first; a short accidental tap
                  still discards at once. */}
              <button onClick={() => { if (voiceStatusSecs >= 10) setShowCancelVoiceConfirm(true); else stopVoiceStatus(false); }} className="p-2 rounded-full bg-gray-200 dark:bg-input-dark hover:opacity-90 active:scale-95 transition-opacity" aria-label="Cancel voice status" title="Cancel">
                <X className="h-4 w-4" />
              </button>
            </div>
          </>
        ) : (
          <button
            ref={voiceStatusFabRef}
            onClick={startVoiceStatus}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-panel-light dark:bg-panel-dark text-gray-700 dark:text-text-primary shadow-lg hover:opacity-90 transition-opacity"
            aria-label="Post voice status"
            title="Voice status"
          >
            <Mic className="h-5 w-5" />
          </button>
        )}
        {/* Audit #9: mic denied — a toast alone left the user with no way
            back. Offer a retry (re-requests permission) plus guidance for
            when the browser keeps blocking it. */}
        {micDenied && !isRecVoiceStatus && (
          <div role="alert" className="w-64 rounded-xl bg-panel-light dark:bg-panel-dark p-3 shadow-lg">
            <p className="text-sm font-medium">Microphone is blocked</p>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Allow the microphone to record a voice status. If your browser keeps blocking it, allow it in the site settings for this app.</p>
            <div className="mt-2 flex gap-2">
              <button onClick={startVoiceStatus} className="flex-1 py-2 bg-green-cta text-white rounded-xl text-sm font-medium hover:opacity-90 active:scale-95 transition-opacity">Try again</button>
              <button onClick={() => setMicDenied(false)} className="flex-1 py-2 bg-gray-100 dark:bg-input-dark rounded-xl text-sm font-medium hover:opacity-90 active:scale-95 transition-opacity">Dismiss</button>
            </div>
          </div>
        )}
        {/* Photo/video status button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-panel-light dark:bg-panel-dark text-gray-700 dark:text-text-primary shadow-lg hover:opacity-90 transition-opacity"
          aria-label="Post photo or video status"
          title="Photo status"
        >
          <Camera className="h-5 w-5" />
        </button>
        {/* Text status button */}
        <button
          onClick={() => setShowComposeText(true)}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-green-cta text-white shadow-lg hover:bg-dark-green transition-colors"
          aria-label="Post text status"
          title="Text status"
        >
          <Pencil className="h-6 w-6" />
        </button>
      </div>

      {/* Status Viewer Modal */}
      {viewingStatus && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col select-none" role="dialog" aria-modal="true" aria-label="Status viewer" data-viewer-paused={viewerPaused ? 'true' : 'false'}>
          {/* Top Controls — z-40 so the header (progress, author, menu,
              close) sits ABOVE the z-30 media layer. (WA audit (d) S22/S23:
              at z-30 the header was painted over by the later-in-DOM media
              container, hiding the progress bar and the ⋮ menu button.) */}
          <div className="absolute top-0 w-full z-40 flex flex-col bg-gradient-to-b from-black/85 via-black/40 to-transparent pt-3">
            {/* Progress bar auto-advance positioned right below safe area */}
            <div className="flex gap-1.5 px-4 pt-2 pb-3">
              {viewingStatus.statuses.map((_: any, i: number) => (
                <div key={i} className="flex-1 h-1 bg-white/30 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-white rounded-full"
                    style={
                      i < statusIdx
                        ? { width: '100%' }
                        : i === statusIdx
                        // WA audit (d) S20 — the fill freezes while held.
                        // S25: also frozen while the inline reply is open.
                        // WA verify status-3: also while a viewer overlay
                        // is open, or the fill would finish while paused.
                        ? { animation: `status-progress ${currentDurationMs}ms linear forwards`, animationPlayState: (viewerPaused || inlineReplyOpen || viewerOverlayOpen) ? 'paused' : 'running' }
                        : { width: 0 }
                    }
                  />
                </div>
              ))}
            </div>

            {/* Author info row */}
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center">
                <DefaultAvatar photoURL={viewingStatus.avatar} name={viewingStatus.name} seed={viewingStatus.userId} size={40} className="ring-1 ring-white/20" />
                <div className="ml-3">
                  <h3 className="font-semibold text-white text-sm">{viewingStatus.name}</h3>
                  <p className="text-xs text-white/70">{formatTime(viewingStatus.statuses[statusIdx]?.timestamp || viewingStatus.latestTime)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {viewingStatus.userId === currentUser?.uid && (
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(true)}
                    className="p-2 text-white/80 hover:text-red-400 hover:bg-white/10 rounded-full transition-colors"
                    title="Delete status"
                    aria-label="Delete this status"
                  >
                    <Trash2 className="h-5 w-5" />
                  </button>
                )}
                {/* WA audit (d) S22+S23 — viewer overflow menu: Mute (others
                    only), Forward, Download, Report (others only). */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowViewerMenu(v => !v)}
                    className="p-2 text-white hover:bg-white/10 rounded-full"
                    title="More options"
                    aria-label="Status options"
                    aria-haspopup="menu"
                    aria-expanded={showViewerMenu}
                  >
                    <MoreVertical className="h-5 w-5" />
                  </button>
                  {showViewerMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowViewerMenu(false)} aria-hidden="true" />
                      <div role="menu" aria-label="Status options" className="absolute right-0 top-11 z-50 w-56 bg-panel-light dark:bg-panel-dark rounded-xl shadow-2xl border border-gray-200 dark:border-white/10 py-1 animate-fade-in">
                        {viewingStatus.userId !== currentUser?.uid && (
                          <button
                            role="menuitem"
                            onClick={() => { setShowViewerMenu(false); void toggleMuteStatus(viewingStatus.userId, viewingStatus.name); }}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-gray-900 dark:text-text-primary"
                          >
                            {mutedUids.includes(viewingStatus.userId) ? <Volume2 className="h-4 w-4 text-primary-green" /> : <VolumeX className="h-4 w-4 text-primary-green" />}
                            {mutedUids.includes(viewingStatus.userId) ? `Unmute ${viewingStatus.name}'s status` : `Mute ${viewingStatus.name}'s status`}
                          </button>
                        )}
                        <button
                          role="menuitem"
                          onClick={forwardCurrentStatus}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-gray-900 dark:text-text-primary"
                        >
                          <Forward className="h-4 w-4 text-primary-green" /> Forward
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => void downloadCurrentStatus()}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-gray-900 dark:text-text-primary"
                        >
                          <Download className="h-4 w-4 text-primary-green" /> Download
                        </button>
                        {viewingStatus.userId !== currentUser?.uid && (
                          <button
                            role="menuitem"
                            onClick={reportCurrentStatus}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left hover:bg-gray-100 dark:hover:bg-input-dark text-danger-red"
                          >
                            <Flag className="h-4 w-4" /> Report status
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <button onClick={() => { setViewingStatus(null); setStatusIdx(0); }} className="p-2 text-white hover:bg-white/10 rounded-full" aria-label="Close status viewer">
                  <X className="h-6 w-6" />
                </button>
              </div>
            </div>
          </div>

          {/* UI-army #4: the old full-screen left/right tap zones sat at
              z-20 ABOVE the media, so the video controls and the voice
              player were visible but unclickable. The zones are gone —
              navigation now lives on the media container itself (below),
              which sits at z-30 so media controls receive taps. */}

          {/* Center Story Content — relative z-30 so the video controls
              and voice player sit above any overlay and receive taps.
              Taps on empty media still navigate: left third = previous
              status, right two-thirds = next (closes on the last one) —
              except on interactive elements (video, player buttons and
              seek bar, links), which keep their own behaviour. */}
          <div
            className="relative z-30 flex-1 flex items-center justify-center bg-black"
            // WA audit (d) S20 — press-and-hold pauses the auto-advance
            // (timer + progress fill freeze; release resumes with the
            // remaining time). Interactive targets keep their own
            // behaviour; a long-press must not pop a context menu.
            onPointerDown={(e) => {
              const t = e.target as HTMLElement;
              if (t.closest('video, audio, button, a, input, select, textarea, [role="slider"]')) return;
              setViewerPaused(true);
            }}
            onPointerUp={() => setViewerPaused(false)}
            onPointerLeave={() => setViewerPaused(false)}
            onPointerCancel={() => setViewerPaused(false)}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => {
              const t = e.target as HTMLElement;
              if (t.closest('video, audio, button, a, input, select, textarea, [role="slider"]')) return;
              const rect = e.currentTarget.getBoundingClientRect();
              // WA verify status-3 S18 — left third = previous, right
              // two-thirds = next; at the ends navigation crosses to the
              // neighbouring poster's statuses (goViewerPrev/Next).
              if (e.clientX - rect.left < rect.width / 3) goViewerPrev();
              else goViewerNext();
            }}
          >
            {viewingStatus.statuses[statusIdx]?.mediaType === 'text' ? (
              <div className={`relative w-full h-full flex flex-col items-center justify-center bg-gradient-to-br ${(TEXT_STATUS_STYLES.find(s => s.id === viewingStatus.statuses[statusIdx]?.bgStyle) || TEXT_STATUS_STYLES[0]).bg} px-8 text-center overflow-hidden`}>
                <p className={`text-white text-2xl font-bold leading-relaxed shadow-sm relative z-30 ${(TEXT_STATUS_FONTS.find(f => f.id === viewingStatus.statuses[statusIdx]?.fontStyle) || TEXT_STATUS_FONTS[0]).cls}`}>
                  {parseStatusText(viewingStatus.statuses[statusIdx].textContent || '').map((seg, i) => {
                    if (seg.kind === 'link') {
                      return (
                        <a key={i} href={seg.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                          className="underline text-green-100 break-all">{seg.text}</a>
                      );
                    }
                    if (seg.kind === 'mention') {
                      const hit = (viewingStatus.statuses[statusIdx].mentions || []).find((m: any) => m.username === seg.username);
                      if (!hit) return <span key={i} className="text-green-100">{seg.text}</span>;
                      return (
                        <button key={i} type="button" onClick={e => { e.stopPropagation(); navigate(`/chat/${hit.uid}`); }}
                          aria-label={`Open chat with ${hit.displayName || seg.username}`}
                          className="text-green-100 bg-white/20 rounded px-1 underline">{seg.text}</button>
                      );
                    }
                    return <span key={i}>{seg.text}</span>;
                  })}
                </p>
                {/* Nightshift — link sticker: only a stored https: URL is
                    tappable; anything else renders as plain text. */}
                {viewingStatus.statuses[statusIdx].linkSticker?.url && (
                  isSafeHttpsUrl(viewingStatus.statuses[statusIdx].linkSticker.url) ? (
                    <a href={viewingStatus.statuses[statusIdx].linkSticker.url} target="_blank" rel="noreferrer"
                      onClick={e => e.stopPropagation()} aria-label={`Open link ${linkHostLabel(viewingStatus.statuses[statusIdx].linkSticker.url)}`}
                      className="relative z-30 mt-4 inline-flex items-center gap-1.5 bg-white text-gray-900 text-sm font-semibold px-4 py-2 rounded-full shadow-lg hover:bg-gray-100">
                      <Link2 className="h-4 w-4 text-primary-green" /> {linkHostLabel(viewingStatus.statuses[statusIdx].linkSticker.url)}
                    </a>
                  ) : (
                    <span className="relative z-30 mt-4 inline-flex bg-white/20 text-white/80 text-sm px-4 py-2 rounded-full">
                      {String(viewingStatus.statuses[statusIdx].linkSticker.url)}
                    </span>
                  )
                )}
                {(viewingStatus.statuses[statusIdx].stickers || []).map((st: any) => (
                  // 100M-H21: render the stored sticker IMAGE (Fluent 3D
                  // art); emoji only for old docs / legacy packs without
                  // an image.
                  st.image ? (
                    <img key={st.id} src={st.image} alt="Sticker" className="absolute h-14 w-14 object-contain drop-shadow-lg" style={{ left: `${st.x}%`, top: `${st.y}%` }} />
                  ) : (
                    <span key={st.id} className="absolute text-5xl drop-shadow-lg" style={{ left: `${st.x}%`, top: `${st.y}%` }}>{st.emoji}</span>
                  )
                ))}
                {viewingStatus.statuses[statusIdx].textSticker && (
                  <span className="absolute bg-black/40 text-white text-lg font-bold px-3 py-1 rounded-full" style={{ left: `${viewingStatus.statuses[statusIdx].textSticker.x}%`, top: `${viewingStatus.statuses[statusIdx].textSticker.y}%` }}>
                    {viewingStatus.statuses[statusIdx].textSticker.text}
                  </span>
                )}
              </div>
            ) : viewingStatus.statuses[statusIdx]?.mediaType === 'voice' ? (
              <div className="w-full h-full flex flex-col items-center justify-center bg-header-green px-6 gap-4">
                <div className="bg-white/10 backdrop-blur rounded-2xl p-3">
                  <VoiceNotePlayer
                    url={viewingStatus.statuses[statusIdx]?.mediaUrl}
                    duration={viewingStatus.statuses[statusIdx]?.duration}
                    waveform={viewingStatus.statuses[statusIdx]?.waveform}
                    seed={viewingStatus.statuses[statusIdx]?.id || viewingStatus.statuses[statusIdx]?.mediaUrl}
                  />
                </div>
                <p className="text-white/80 text-sm">{tr('voiceStatus')} ({viewingStatus.statuses[statusIdx]?.duration || 0}s)</p>
              </div>
            ) : viewingStatus.statuses[statusIdx]?.mediaType === 'video' ? (
              <video
                src={viewingStatus.statuses[statusIdx]?.mediaUrl}
                autoPlay
                controls
                className="w-full max-h-full object-contain"
                // WA audit (d) S19 — record the clip's real duration so
                // the auto-advance uses it (not the old fixed 15s), and
                // advance the moment the clip ends.
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  const id = viewingStatus.statuses[statusIdx]?.id;
                  if (id && Number.isFinite(d) && d > 0) {
                    setVideoDurationById(prev => (prev[id] === Math.round(d * 1000) ? prev : { ...prev, [id]: Math.round(d * 1000) }));
                  }
                }}
                onEnded={advanceViewer}
              />
            ) : (
              <img src={viewingStatus.statuses[statusIdx]?.mediaUrl} alt="Status" className="w-full max-h-full object-contain" />
            )}
            {/* WA72 S16: link sticker on a photo/video status — same
                https-only check as the text branch (which renders its own
                chip); non-https stored values render as plain text there
                and are never linked here either. */}
            {(viewingStatus.statuses[statusIdx]?.mediaType === 'image' || viewingStatus.statuses[statusIdx]?.mediaType === 'video') && viewingStatus.statuses[statusIdx].linkSticker?.url && isSafeHttpsUrl(viewingStatus.statuses[statusIdx].linkSticker.url) && (
              <a href={viewingStatus.statuses[statusIdx].linkSticker.url} target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()} aria-label={`Open link ${linkHostLabel(viewingStatus.statuses[statusIdx].linkSticker.url)}`}
                className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 inline-flex items-center gap-1.5 bg-white text-gray-900 text-sm font-semibold px-4 py-2 rounded-full shadow-lg hover:bg-gray-100">
                <Link2 className="h-4 w-4 text-primary-green" /> {linkHostLabel(viewingStatus.statuses[statusIdx].linkSticker.url)}
              </a>
            )}
            {/* WA audit (d) S20 — visible pause cue while held. */}
            {viewerPaused && (
              <div role="status" className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 bg-black/60 backdrop-blur-md px-4 py-1.5 rounded-full text-xs text-white flex items-center gap-1.5 border border-white/10 pointer-events-none">
                ❚❚ Paused
              </div>
            )}
          </div>

          {/* View Counter Pill for Owner's Status — tap to see who viewed */}
          {viewingStatus.userId === currentUser?.uid && (
            <div className="absolute bottom-6 inset-x-0 flex items-center justify-center z-30">
              <button
                onClick={() => setShowViewers(true)}
                className="bg-black/60 backdrop-blur-md px-4 py-1.5 rounded-full text-xs text-white flex items-center gap-1.5 border border-white/10 hover:bg-black/80 transition-colors"
                aria-label={`Viewed by ${currentViewers.length} people. Tap to see who viewed.`}
              >
                <Eye className="h-3.5 w-3.5 text-primary-green" />
                <span>{currentViewers.length} view{currentViewers.length === 1 ? '' : 's'} — tap to see who</span>
              </button>
            </div>
          )}

          {/* Phase 4 — reactions + reply (other people's statuses only).
              WA audit (d) S25: the reply composer is INLINE in the viewer
              (WAWebStatusQuotedFlow) — a quoted bar at the bottom of the
              viewer with the status preview, input + Send, no separate
              sheet. The viewer stays put (timer frozen) while typing. */}
          {viewingStatus.userId !== currentUser?.uid && (
            <div className="absolute bottom-0 inset-x-0 z-30 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-4 pt-8 pb-5">
              {(() => {
                const counts = statusReactionCounts(viewingStatus.statuses[statusIdx]);
                const total = Object.values(counts).reduce((a, b) => a + b, 0);
                const myEmoji = viewingStatus.statuses[statusIdx]?.reactions?.[currentUser?.uid];
                if (inlineReplyOpen) {
                  const target = replyTarget || { posterUid: viewingStatus.userId, posterName: viewingStatus.name, status: viewingStatus.statuses[statusIdx] };
                  const sendInline = () => {
                    if (!inlineReplyText.trim()) return;
                    void handleStatusReplySend(inlineReplyText.trim());
                  };
                  return (
                    <div className="flex flex-col gap-2" role="group" aria-label={`Reply to ${target.posterName}'s status`}>
                      <div className="flex items-center gap-2 bg-black/60 backdrop-blur-md rounded-xl px-3 py-2 border border-white/10">
                        <span className="h-6 w-1 rounded-full bg-green-cta flex-shrink-0" aria-hidden="true" />
                        <p className="flex-1 min-w-0 text-xs text-white/90 truncate">
                          <span className="font-semibold text-green-cta">{target.posterName}</span>
                          {' · '}{statusPreviewFor(target.status)}
                        </p>
                        <button
                          type="button"
                          onClick={() => { setInlineReplyOpen(false); setInlineReplyText(''); }}
                          className="p-1 rounded-full text-white/70 hover:text-white hover:bg-white/10 flex-shrink-0"
                          aria-label="Cancel reply"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={inlineReplyText}
                          onChange={e => setInlineReplyText(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && getEnterIsSend()) sendInline(); }}
                          placeholder="Reply…"
                          maxLength={5000}
                          aria-label="Reply text"
                          className="flex-1 bg-black/60 backdrop-blur-md border border-white/10 rounded-full px-4 py-2.5 text-sm outline-none text-white placeholder:text-white/50 focus:border-green-cta"
                        />
                        <button
                          type="button"
                          onClick={sendInline}
                          disabled={!inlineReplyText.trim()}
                          className="h-10 w-10 flex items-center justify-center rounded-full bg-green-cta text-white hover:bg-dark-green transition-all disabled:opacity-40 flex-shrink-0"
                          aria-label="Send reply"
                        >
                          <Send className="h-4 w-4" />
                        </button>
                      </div>
                      {/* WA audit (d) S29 — reply-privacy disclaimer (WA
                          `WAWebWamEnumCoexStatusReplyPrivacyDisclaimerUserAction`:
                          DISPLAYED when the composer opens). Shown under the
                          input on every reply so the private-message nature
                          is never a surprise; the first display is recorded
                          locally (see the Reply button's onClick). */}
                      <p className="flex items-center gap-1.5 text-[11px] text-white/60 px-1">
                        <Lock className="h-3 w-3 flex-shrink-0" />
                        <span>Your reply is a private message — only {target.posterName} can see it. It won&apos;t appear on their status.</span>
                      </p>
                    </div>
                  );
                }
                return (
                  <div className="flex flex-col items-center gap-2">
                    {total > 0 && (
                      <div className="flex items-center gap-1.5" aria-label={`${total} reactions`}>
                        {Object.entries(counts).map(([emoji, count]) => (
                          <span key={emoji} className="bg-black/60 backdrop-blur-md px-2 py-0.5 rounded-full text-xs text-white border border-white/10">
                            {emoji} {count}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1 bg-black/60 backdrop-blur-md rounded-full px-2 py-1 border border-white/10" role="group" aria-label="React to this status">
                        {STATUS_EMOJIS.map(emoji => (
                          <button
                            key={emoji}
                            onClick={() => void toggleStatusReaction(emoji)}
                            aria-pressed={myEmoji === emoji}
                            aria-label={`React ${emoji}`}
                            title={`React ${emoji}`}
                            className={`text-xl leading-none p-1 rounded-full transition-transform hover:scale-125 active:scale-95 ${
                              myEmoji === emoji ? 'bg-white/25 ring-1 ring-white/40' : ''
                            }`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={() => { setReplyTarget({ posterUid: viewingStatus.userId, posterName: viewingStatus.name, status: viewingStatus.statuses[statusIdx] }); setInlineReplyText(''); setInlineReplyOpen(true); try { if (!localStorage.getItem('dt_status_reply_privacy_notice_seen')) localStorage.setItem('dt_status_reply_privacy_notice_seen', String(Date.now())); } catch { /* intentionally ignored */ } }}
                        className="flex items-center gap-1.5 bg-green-cta text-white text-sm font-semibold px-4 py-2 rounded-full hover:bg-dark-green transition-colors shadow-lg"
                        aria-label={`Reply to ${viewingStatus.name}'s status`}
                      >
                        <MessageCircle className="h-4 w-4" /> Reply
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Who-viewed sheet */}
      {showViewers && viewingStatus && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end" onClick={() => setShowViewers(false)} role="dialog" aria-modal="true" aria-label="Who viewed this status">
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-6 space-y-4 max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Eye className="h-5 w-5 text-primary-green" /> Viewed by {currentViewers.length}
              </h3>
              <button onClick={() => setShowViewers(false)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loadingViewers ? (
                <div className="space-y-3 py-2" aria-label="Loading viewers">
                  {[0, 1].map(i => (
                    <div key={i} className="flex items-center gap-3 animate-pulse">
                      <div className="h-10 w-10 rounded-full bg-gray-200 dark:bg-input-dark" />
                      <div className="h-3 w-1/3 rounded bg-gray-200 dark:bg-input-dark" />
                    </div>
                  ))}
                </div>
              ) : viewerProfiles.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-text-secondary text-center py-6">
                  No one has viewed this update yet.
                </p>
              ) : (
                <div className="divide-y divide-gray-100 dark:divide-white/5">
                  {viewerProfiles.map(v => (
                    <div key={v.uid} className="flex items-center gap-3 py-2.5">
                      <DefaultAvatar photoURL={v.photoURL} name={v.displayName} seed={v.uid} size={40} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">{v.displayName}</p>
                        {v.username && <p className="text-xs text-gray-500 truncate">@{v.username}</p>}
                      </div>
                      <span className="text-xs text-gray-500 flex-shrink-0">{formatViewedAt(v.viewedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <p className="text-[11px] text-gray-500 text-center">
              View times are recorded from this update onwards; older views show no time.
            </p>
          </div>
        </div>
      )}
      <style>{`@keyframes status-progress { from { width: 0% } to { width: 100% } }`}</style>
    </div>
  );
}
