import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import {
  ArrowLeft, Phone, Video, MoreVertical, Smile, Send, Sticker, Camera, Eye, EyeOff, Reply, Trash2, Edit3, Star,
  Pin, Copy, Search, X, BookmarkPlus, Play, Share2, ExternalLink, FileText, Image as ImageIcon, Timer,
  Lock, LockOpen, ChevronUp, ChevronDown, Plus, Languages, Clock, CheckSquare, ArrowDown, Users, Sun,
  Palette, Bell, Folder, Bookmark, Download, Eraser, Ban, Check, Images, Circle, BarChart2, Film,
  BellOff, MapPin, User, Calendar, Info, Flag, MailOpen, Pause, Music, CircleDashed
} from 'lucide-react';
import { useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import {
  collection, query, orderBy, onSnapshot, addDoc, serverTimestamp,
  doc, getDoc, deleteDoc, updateDoc, arrayUnion, arrayRemove, setDoc, deleteField,
  auth, onAuthStateChanged, db,
  mergeDocFields, MAX_EDIT_HISTORY_ENTRIES,
  getClearedAt, setClearedAt, isAwsConfigured
} from '../../aws';
import { uploadChatMedia, uploadChatMediaWithPoster, validateChatMediaFile, isMediaTooLargeError, isLocalMediaUrl, resolveLocalMediaUrl, deleteLocalMediaBlob, type MediaType } from '../../aws/storage';
import AlbumBubble from '../../components/AlbumBubble';
import VoiceNotePlayer from '../../components/VoiceNotePlayer';
import LinkPreviewCard from '../../components/LinkPreviewCard';
import RoundVideoPlayer from '../../components/RoundVideoPlayer';
import { getBiometricPref } from '../../services/biometric';
import { noteReceivedMessages, recordSent, utf8ByteLength } from '../../services/networkUsage';
import { getWaveformPeaks } from '../../services/waveform';
import MessageTicks from '../../components/MessageTicks';
import { callService } from '../../services/callService';
import MediaLightbox from '../../components/MediaLightbox';
import ViewOnceViewer from '../../components/ViewOnceViewer';
import { markViewOnceViewed } from '../../services/viewOnce';
import type { ViewOnceViewerState } from '../../types/viewOnce';
import { ANIMATED_STICKER_PACKS, type GifDef, type AnimatedStickerDef, stickerAnimationStyle } from '../../components/StickerPicker';
import CombinedPicker, { type CombinedTab } from '../../components/CombinedPicker';
import { ALL_STICKERS } from '../../components/stickerPack';
import type { ChatMessage } from '../../types/chat';
import LocationMessageCard from '../../components/LocationMessageCard';
import LiveLocationCard from '../../components/LiveLocationCard';
import ContactMessageCard from '../../components/ContactMessageCard';
import { LocationShareModal, ContactShareModal, type LocationPayload, type ContactPayload } from '../../components/LocationContactModals';
import { getCurrentPosition, geolocationErrorMessage } from '../../services/locationSharing';
import {
  startLiveLocation, stopLiveLocation, getActiveSession, isSharingLiveLocation,
  isLiveLocationActive, formatLiveRemaining, buildLiveLocationMessage, buildLiveLocationUpdateFields,
  type LiveLocationDuration, type LiveLocationSession,
} from '../../services/liveLocation';
import UserProfileModal from '../../components/UserProfileModal';
import GroupInfoModal from '../../components/GroupInfoModal';
import { isChannel, canSendInGroup, isGroupMember, getMemberIds, getSubscriberCount, formatMemberCount, validateInviteToken, requestJoinGroup, systemEventText } from '../../components/groupAdmin';
import { realtimeSync, getConversationId, cleanId, partnerUidFromConversationId } from '../../services/realtimeSync';
import { loadLocalChatPrefs, saveLocalChatPrefs } from '../../services/archiveFolders';
import { loadGatedContactsDetailed, fetchMemberProfiles, getAllowedContactUids, loadSavedContactsCached, loadBlockedIdsCached, getBlockedIdsLocal, setBlockedIdsLocal, KNOWN_CONVS_CHANGED_EVENT } from '../../services/contacts';
import { scheduledMessages, type ScheduledMessage } from '../../services/scheduledMessages';
import { isOnline, lastSeenText } from '../../services/presence';
import { isMutedPref, mutePrefForDuration, unmutePref } from '../../services/chatMute';
import { navigationManager } from '../../services/navigation';
import { saveRemoteFile } from '../../services/fileSave';
import { getReplaceEmoji, shouldAutoDownload, shouldDownloadHd, NOTIFICATION_TONES, getChatTone, playNotificationTone, playOutgoingMessageTone, setChatTone, getLinkPreviewsEnabled } from '../../services/appSettings';
import { getChatThemeFor, getLightChatTheme, patternDataUri, setLightChatTheme } from '../../services/chatTheme';
import { ChatThemePickerModal } from '../../components/ChatThemePicker';
import { applyTextEmojiReplacements } from '../../services/suggestions';
import FormattedText, { emojiOnlySize } from '../../components/FormattedText';
import ChatComposer, { type ChatComposerHandle, type ChatComposerCallbacks } from '../../components/ChatComposer';
import PollComposer, { type PollComposerPayload } from '../../components/PollComposer';
import PollCard from '../../components/PollCard';
import PollResultsSheet from '../../components/PollResultsSheet';
import { queueChannelPostForStatus, notifyAddToStatus } from '../../services/channelShareToStatus';
import EventSheet from '../../components/EventSheet';
import EventCard from '../../components/EventCard';
import {
  createGroupEvent,
  setRsvp as setEventRsvp,
  cancelGroupEvent,
  dueEventReminders,
  loadRemindedEventIds,
  markEventReminded,
  formatEventWhen,
  type RsvpValue,
  type ReminderMinutes,
  type EventComposerPayload,
} from '../../components/groupEvents';
import ReactionPicker, { ReactionChips } from '../../components/ReactionPicker';
import { normalizeChannelReactionPolicy, isReactionAllowed, type ChannelReactionPolicy } from '../../services/channelReactionPolicy';
import TranslateSheet from '../../components/TranslateSheet';
import CameraModal from '../../components/CameraModal';
import PhotoEditor from '../../components/PhotoEditor';
import { compressVideoFile } from '../../services/videoCompress';
import { useLanguage } from '../../services/language';
import { replyPrivately, takePendingReply } from '../../services/replyPrivately';
import {
  countReactions,
  getMyReaction,
  getWhoReacted,
  rememberReactionEmoji,
} from '../../services/reactions';
import { isMessageExpired, isKeptMessage, disappearLabel, type DisappearAfterMs } from '../../utils/disappearingMessages';
import { sweepExpiredMessages } from '../../utils/expirySweeper';
import { markChatReadLocally, readReceiptsEnabled, pickSeenUpTo, mergeSeenUpTo, compareSeenUpTo, effectiveMessageStatus, seenAtForMessage, deliveredAtForMessage, receiptsByMember, seenUpToForUser, getLocalReadAt, type SeenUpTo, type MemberReceipt } from '../../services/readReceipts';
import {
  enqueueOfflineOp, getOfflineQueue, subscribeOfflineQueue, flushOfflineQueue,
  newOfflineMessageId, MAX_MESSAGE_CHARS,
} from '../../services/offlineQueue';
import DisappearingMessagesModal from '../../components/DisappearingMessagesModal';
import DefaultAvatar from '../../components/DefaultAvatar';
import PinScreen from '../hidden/PinScreen';
import E2EENotice from '../../components/E2EENotice';
import {
  decryptIncoming,
  getChatEncryptionState,
  isEncryptedDoc,
  isEncryptionFailedError,
  isGroupKeyExchangeDoc,
  isKeyExchangeDoc,
  requestGroupKeyReExchange,
  requestKeyReExchange,
  processKeyExchangeDocs,
  ensureKeyAnnounce,
} from '../../services/e2eeChat';
import {
  buildGroupMemberAnnounce,
  buildGroupSenderKeyDoc,
  ensureSelfPeerKey,
  exportOwnGroupSenderKeyRawFor,
  exportPublicKeyBase64,
  getAnnounced,
  getGroupMemberKey,
  getOrCreateIdentityKeyPair,
  getOrCreateOwnGroupSenderKey,
  handleIncomingGroupKeyDoc,
  loadProcessedKxKeys,
  markAnnounced,
  markProcessedKx,
  onGroupKeyChanged,
  onPeerKeyChanged,
  shortFingerprint,
} from '../../services/e2ee/keyExchange';
import {
  SECURITY_CODE_CHANGED_EVENT,
  dismissSecurityCodeChange,
  listSecurityCodeChanges,
  type SecurityCodeChangeAlert,
} from '../../services/e2ee/securityNotifications';
import {
  LOCKED_PIN_KEY,
  isLockedFolderUnlocked,
  isLockedPartnerCached,
  lockLockedFolder,
  setChatLocked,
  unlockLockedFolder,
} from '../../services/lockedChats';
import { recordAppActivity } from '../../services/appLock';
import { deletedForMeKey } from '../../services/storageUsage';
import { submitReport, type ReportReason } from '../../services/report';
import {
  canDeleteForEveryone, FORWARD_CAP, forwardLabel, senderColourFor, quoteMediaLabel,
  formatMediaDuration,
} from '../../utils/waDmParity';

const EMOJI_QUICK = ['👍','❤️','😂','😮','😢','🙏']; // WA verify DM-2 row 43: WA tray order, 👍 first (was ❤️ first)

// Human-readable file size, e.g. "1.2 MB"
const formatFileSize = (bytes?: number): string => {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

// Short label for a MIME type, e.g. "PDF" or "DOCX"
const fileTypeLabel = (mime: string, name?: string): string => {
  const ext = (name || '').split('.').pop()?.toUpperCase();
  if (ext && ext !== (name || '').toUpperCase()) return ext;
  return mime.split('/').pop()?.toUpperCase() || 'FILE';
};

export default function ChatScreen() {
  const { chatId } = useParams();
  const [searchParams] = useSearchParams();
  const isCommunity = searchParams.get('type') === 'community';
  const navigate = useNavigate();
  // 100M-H24: Saved/Starred "Open in chat" passes the saved message id
  // in location.state (jumpToMessageId) — consumed by the effect next
  // to jumpToDate below.
  const location = useLocation();

  const [currentUser, setCurrentUser] = useState<any>(() => auth.currentUser);

  // F2 (100-more): the :chatId route param is usually a partner uid, but
  // the message/call toast (NotificationBanner navigates with
  // t.conversationId) and Saved/Starred/Scheduled jump links pass a full
  // DM conversation id (`uidA_uidB`). Re-wrapping that via
  // getConversationId() double-wraps it (`uidA_uidB_uid`) into a
  // nonexistent collection: empty chat, sends to the wrong collection,
  // key exchange never completes. Unwrap a full id to the partner uid
  // once here; every partner-uid use below reads partnerUid, so a chat
  // opened by either form behaves identically. For communities the param
  // is already the group id, so partnerUid is the param unchanged.
  const partnerUid = !isCommunity && currentUser?.uid && chatId
    ? (partnerUidFromConversationId(chatId, currentUser.uid) ?? chatId)
    : (chatId ?? null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      if (u) setCurrentUser(u);
    });
  }, []);

  const [messages, setMessages] = useState<any[]>([]);
  const { t: tr } = useLanguage();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isViewOnce, setIsViewOnce] = useState(false);
  const [otherUser, setOtherUser] = useState<any>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  // Phase 5: route-guard state. `hiddenLoaded` gates rendering so a locked
  // chat cannot flash before its locked status is known (L-02/L-03).
  const [hiddenLoaded, setHiddenLoaded] = useState(false);
  const [lockedGatePassed, setLockedGatePassed] = useState(false);
  // App-lock fix (2026-11-14): sticky guard. Once this mount has rendered
  // the chat unlocked (folder session valid or guard PIN passed), NEVER
  // re-show the PIN for this mount — the guard re-evaluates on every
  // render (any incoming message / typing event re-renders), and the
  // folder session is time-based (15 min), so without this the lock
  // screen popped up in the middle of an open locked chat.
  // RC7: the guard is keyed by partnerUid — a mount spans multiple chats
  // (router reuses ChatScreen on /chat/A -> /chat/B), so a pass for chat A
  // must never unlock chat B. `lockGuardChatIdRef` records which chat the
  // sticky pass belongs to; the gate below consults it.
  const lockGuardPassedRef = useRef(false);
  const lockGuardChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (hiddenLoaded && isHidden && !isCommunity && (lockedGatePassed || isLockedFolderUnlocked())) {
      lockGuardPassedRef.current = true;
      lockGuardChatIdRef.current = partnerUid as string;
    }
  });
  // RC7: reset ALL gate state whenever partnerUid changes — before paint
  // (useLayoutEffect), so the previous chat's pass / stale hidden state
  // can never render the new chat unlocked for even one frame. The load
  // effect below re-resolves hiddenLoaded/isHidden for the new chat, and
  // until it does the loading gate (not the chat) renders.
  useLayoutEffect(() => {
    setLockedGatePassed(false);
    lockGuardPassedRef.current = false;
    lockGuardChatIdRef.current = null;
    setHiddenLoaded(false);
    setIsHidden(false);
    jumpHoldRef.current = 0; // H24: a jump from the previous chat must not suppress this chat's mount auto-scroll
  }, [partnerUid]);
  const [isBlocked, setIsBlocked] = useState(false);
  // Item 12 (Master-gaps Cluster B): my read-receipts preference, read
  // LIVE from my user doc (the onSnapshot below) — never a stale snapshot.
  // Default ON (undefined on the doc = true, same as SettingsScreen).
  // OFF means: I don't send 'seen', and I don't see others' blue ticks.
  // WA72 settings #24: WhatsApp always sends read receipts in GROUP
  // chats even when the toggle is off (WA Help Center: "Read receipts
  // are always sent for group chats"). DMs honour the toggle; groups
  // always behave as if it were on — see receiptsEffective below.
  const [readReceipts, setReadReceipts] = useState(true);
  // WA72 settings #24 — group exemption for the toggle above.
  const receiptsEffective = readReceipts || isCommunity;
  const [isPartnerTyping, setIsPartnerTyping] = useState(false);
  // WA parity (DM audit, worker B): partner "recording audio" presence,
  // group typing uids (names resolved at render), group online count.
  const [isPartnerRecording, setIsPartnerRecording] = useState(false);
  const [partnerRecordingAt, setPartnerRecordingAt] = useState(0);
  const [groupTypingUids, setGroupTypingUids] = useState<string[]>([]);
  const [groupOnlineCount, setGroupOnlineCount] = useState<number | null>(null);
  // WA parity: forward-picker session state — how many chats this one
  // forward has already gone to (cap 5), and which targets, so the
  // picker can stay open for multi-chat forwarding.
  const [forwardSentCount, setForwardSentCount] = useState(0);
  const [forwardedTargetUids, setForwardedTargetUids] = useState<string[]>([]);
  const [showReportConfirm, setShowReportConfirm] = useState(false);
  // WA parity: tap-to-download progress + locally downloaded media URLs.
  const [mediaDownloadProgress, setMediaDownloadProgress] = useState<Record<string, number>>({});
  // WA parity Media V11: message ids whose voice note is mid re-upload
  // (drives the player's Upload button spinner).
  const [reuploadingVoiceIds, setReuploadingVoiceIds] = useState<Set<string>>(new Set());
  const [mediaLocalUrls, setMediaLocalUrls] = useState<Record<string, string>>({});
  const [videoDurations, setVideoDurations] = useState<Record<string, number>>({});
  // #29: floating jump-to-bottom button, shown once the user scrolls up.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  // 100M-M2: per-chat mute for the contact-info modal — the same chatPrefs
  // `muted` flag the chat-list long-press menu writes (keyed by partner
  // uid for DMs, #192), loaded when the modal opens.
  const [chatMuted, setChatMuted] = useState<boolean | null>(null);
  const [muteBusy, setMuteBusy] = useState(false);
  const chatMuteKeyRef = useRef<string | null>(null);
  const chatMutePrefRef = useRef<any>({});
  const [showGroupInfo, setShowGroupInfo] = useState(false);

  // ── E2EE (Worker 3: CHAT UI) ──
  // `e2eeChatState` is the chat-level state from the e2eeChat contract
  // (`getChatEncryptionState`); 'unknown' until it is computed from the
  // loaded messages. `decrypted` caches per-message decrypt results so a
  // bubble is never decrypted twice in one session. The loader/helpers
  // live further down (after `visibleMsgs`), next to where they are used.
  const [showE2EESheet, setShowE2EESheet] = useState(false);
  const [e2eeChatState, setE2eeChatState] = useState<'e2ee' | 'legacy' | 'unknown'>('unknown');
  // Wave-2 C3 (Settings #16b): in-chat security-code-change notice — WA
  // shows "{name}'s security code changed" inside the chat when a contact
  // reinstalls / switches phones. The alert is recorded by the
  // key-exchange path (securityNotifications.ts) and also listed in
  // Settings → Account; this banner surfaces the same alert where the
  // chat is, live while the chat is open. Dismissing here dismisses it
  // there too (same store). No key material is rendered — only the
  // peer's display name and the change time.
  const [secCodeAlerts, setSecCodeAlerts] = useState<SecurityCodeChangeAlert[]>(() => listSecurityCodeChanges());
  useEffect(() => {
    const refresh = () => setSecCodeAlerts(listSecurityCodeChanges());
    refresh();
    window.addEventListener(SECURITY_CODE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(SECURITY_CODE_CHANGED_EVENT, refresh);
  }, [chatId]);
  // Wave-2 C3 (#16b): in a group the alert names the MEMBER whose key
  // changed (the alert carries their uid) — naming the group would imply
  // the whole group's keys changed. Resolved from the cached users docs,
  // same pattern as the partner-doc lookup below.
  const secAlertPeerNames = useMemo(() => {
    const map = new Map<string, string>();
    try {
      for (const u of (db.getCollectionDocs('users') || []) as any[]) {
        const uid = String(u.uid || u.id || '');
        const name = String(u.displayName || u.username || '').trim();
        if (uid && name) map.set(uid, name);
      }
    } catch { /* best-effort; the fallback below still labels the alert */ }
    return map;
  }, [secCodeAlerts]);
  const [decrypted, setDecrypted] = useState<Record<string, DecryptEntry>>({});
  // Master E2EE: true once this device holds the peer's public key and can
  // derive the shared chat key. The lock pill only shows when this is true
  // AND at least one message is actually encrypted — a key alone encrypts
  // nothing. Key-exchange dedup lives in the shared runner now
  // (`processKeyExchangeDocs` in e2eeChat.ts): it owns the in-memory +
  // durable `processedKx` / `ackedKx` sets, so this screen keeps only the
  // snapshot refs below.
  const [e2eeKeyReady, setE2eeKeyReady] = useState(false);
  // W16 group loop only: `processedKxRef` dedups group key-exchange docs
  // across snapshots (the 3s poll re-delivers the same docs). The 1-to-1
  // loop's dedup lives in the shared runner now — this ref is NOT used
  // for 1-to-1 docs.
  const processedKxRef = useRef<Set<string>>(new Set());
  // - `kxDocsRef`: the latest snapshot's protocol docs, so the announce
  //   effect can check the SERVER collection for our own announce
  //   (server truth beats any local throttle).
  // - `messagesLoadedRef`: ref mirror of `messagesLoaded` for the
  //   announce effect's wait loop (state is stale inside its closure).
  const kxDocsRef = useRef<any[]>([]);
  // W16 (#183): latest snapshot's GROUP key-exchange docs (member
  // announces + sender-key docs), so the group announce effect can check
  // server truth for our own announce / sender-key distribution.
  const groupKxDocsRef = useRef<any[]>([]);
  const messagesLoadedRef = useRef(false);
  // Report 3 #26 (W5b): when our key-announce is known to exist (just
  // sent, already on the server, or recorded < 24 h ago) — the anchor
  // for the setup state machine below (`announcing` < 30 s,
  // `waiting-for-peer` < 120 s, `timed-out` after that; UI-only timeout,
  // keys can still arrive after it). Reset on chat change with
  // `e2eeKeyReady` (see the reset effect below).
  const [e2eeSetupAnnouncedAt, setE2eeSetupAnnouncedAt] = useState<number | null>(null);
  // Clock for the setup state machine — refreshed on a 5 s tick only
  // while the setup banner is visible (see the tick effect below).
  const [e2eeSetupNow, setE2eeSetupNow] = useState(() => Date.now());
  // Report 3 #226/#234 (W5b): true while this conversation's collection
  // has listeners but no live subscription (poll-only) — drives the
  // "Reconnecting…" pill under the header. Never shown in mock mode
  // (no subscriptions exist there; the demo banner in App.tsx is the
  // signal instead).
  const [chatReconnecting, setChatReconnecting] = useState(false);

  // Reply / Edit state
  const [replyTo, setReplyTo] = useState<any>(null);
  const [editingMsg, setEditingMsg] = useState<any>(null);

  // Context menu (long press / right click on message)
  const [ctxMenu, setCtxMenu] = useState<{msg: any, x: number, y: number} | null>(null);

  // Reactions popup — the real ReactionPicker component (quick row +
  // expandable full-emoji picker) anchored to the message bubble.
  const [showReactPicker, setShowReactPicker] = useState<string | null>(null); // msgId
  // W26: flip the anchored reaction picker BELOW the bubble when the
  // bubble sits near the top of the visible list — the popover renders
  // `-top-12` by default, which the scroll container clips for the first
  // visible message (picker invisible on long-press). Set at open time
  // from the touch/click Y vs the messages container top.
  const [reactPickerBelow, setReactPickerBelow] = useState(false);
  // Reaction sheet (ReactionPicker variant="sheet") opened from the
  // context menu "+" button — the full-emoji picker as a bottom sheet.
  const [sheetReactionMsg, setSheetReactionMsg] = useState<any | null>(null);

  // Translate sheet (TranslateSheet): the message being translated, or
  // null when the sheet is closed.
  const [translateMsg, setTranslateMsg] = useState<{ text: string; senderName?: string } | null>(null);

  // WA Wave-2 (DM #25 / Media E10): ONE combined "Emojis, GIFs, Stickers"
  // panel — single entry point (the composer's emoji button), three tabs
  // (Emoji / GIF / Sticker). Replaces the two separate pickers.
  const [showCombinedPicker, setShowCombinedPicker] = useState(false);
  const [combinedTab, setCombinedTab] = useState<CombinedTab>('emoji');

  // Open the combined panel on a given tab, closing the attach menu.
  const openCombinedPicker = (tab: CombinedTab) => {
    setCombinedTab(tab);
    setShowCombinedPicker(true);
    setShowAttachMenu(false);
  };

  // Wave-2 E9 (WA `WAWebStickerSuggestionResults` onShowMore): the
  // suggestion row's "more" opens the picker pre-filtered by the last
  // typed emoji. The combined panel is the single picker host now (A3),
  // so the old separate-picker opener is an adapter over it.
  const [stickerInitialQuery, setStickerInitialQuery] = useState('');
  const openStickerPicker = (tab: 'stickers' | 'gifs', query = '') => {
    setStickerInitialQuery(query);
    openCombinedPicker(tab);
  };

  // WA Wave-2 A3 reviewer gap (tab-state reset): closing the panel
  // resets the owned tab to the default ('emoji') and clears any
  // E9 pre-fill query, so state from one open never leaks into the
  // next — the next open always lands on Emoji unless its opener
  // explicitly picks a tab (openCombinedPicker / openStickerPicker
  // set their tab after this reset). All close paths go through here.
  const closeCombinedPicker = useCallback(() => {
    setShowCombinedPicker(false);
    setCombinedTab('emoji');
    setStickerInitialQuery('');
  }, []);

  // The composer's emoji button toggles the panel; opening lands on Emoji.
  const toggleCombinedPicker = useCallback(() => {
    if (showCombinedPicker) closeCombinedPicker();
    else { setCombinedTab('emoji'); setShowCombinedPicker(true); setShowAttachMenu(false); }
  }, [showCombinedPicker, closeCombinedPicker]);

  // Poll modal
  const [showPollModal, setShowPollModal] = useState(false);
  // WA audit (d) C8 — the poll whose full results / voter list is open
  // in the PollResultsSheet (null = closed).
  const [pollResultsMsg, setPollResultsMsg] = useState<any | null>(null);
  const [showEventModal, setShowEventModal] = useState(false);

  // Media Lightbox
  const [lightbox, setLightbox] = useState<{ open: boolean; url: string; type: 'image' | 'video'; senderName?: string; time?: string; caption?: string; items?: { url: string; type: 'image' | 'video'; senderName?: string; time?: string; caption?: string }[]; index?: number; viewOnce?: boolean }>({ open: false, url: '', type: 'image' });

  // MF-01 (scaffold, VO-01): view-once media opens ONLY in the dedicated
  // ViewOnceViewer (canvas, no download/share, no items list) — never in
  // the shared MediaLightbox above.
  const [viewOnceViewer, setViewOnceViewer] = useState<ViewOnceViewerState | null>(null);
  // WA parity (media audit V10): a view-once VOICE message plays once in
  // the bubble — this is the id of the message currently playing. `viewed`
  // is marked only when playback ENDS (marking on open would flip the
  // bubble to "opened" and unmount the player before it can play).
  const [viewOnceVoiceOpenId, setViewOnceVoiceOpenId] = useState<string | null>(null);
  // #215: open the lightbox on one item, swipable through `items` (an
  // album, or all chat media). Without `items` it shows the single item.
  const openLightbox = (
    item: { url: string; type: 'image' | 'video'; senderName?: string; time?: string; caption?: string },
    items?: { url: string; type: 'image' | 'video'; senderName?: string; time?: string; caption?: string }[],
    opts?: { viewOnce?: boolean },
  ) => {
    const list = items && items.length > 0 ? items : [item];
    const idx = Math.max(0, list.findIndex((i) => i.url === item.url));
    const cur = list[idx];
    setLightbox({ open: true, url: cur.url, type: cur.type, senderName: cur.senderName, time: cur.time, caption: cur.caption, items: list, index: idx, viewOnce: !!opts?.viewOnce });
  };
  // G2b: a view-once view is spent only once its media actually loads.
  // While a view-once item is open in the lightbox this holds its id +
  // url; the lightbox's onMediaLoad consumes it (marks viewed), its
  // onMediaError / any close drops it unspent. Null otherwise, so the
  // same lightbox callbacks are harmless no-ops for normal media.
  const pendingViewOnceRef = useRef<{ id: string; url: string } | null>(null);
  // Closing the lightbox before the media loads must NOT spend the view
  // (covers X, Escape, back-button and error closes alike).
  useEffect(() => {
    if (!lightbox.open) pendingViewOnceRef.current = null;
  }, [lightbox.open]);
  const markViewOnceSeen = () => {
    const p = pendingViewOnceRef.current;
    if (!p || !conversationId || lightbox.url !== p.url) return;
    pendingViewOnceRef.current = null;
    updateDoc(doc(db, 'chats', conversationId, 'messages', p.id), {
      viewed: true,
    }).catch((e) => { console.warn('[ChatScreen] could not mark view-once message viewed:', e); });
  };
  const handleViewOnceLoadError = () => {
    const p = pendingViewOnceRef.current;
    if (!p) return;
    pendingViewOnceRef.current = null;
    setLightbox((prev) => ({ ...prev, open: false }));
    showToastMsg("Couldn't open this photo. Your view wasn't used — try again.");
  };
  // 100M-H20: the media caption for a message — same source as the bubble
  // (adapter-decrypted msg.caption first, local decrypt-cache fallback).
  const captionFor = (m: any): string | undefined => {
    const c = (typeof m.caption === 'string' && m.caption.length > 0 ? m.caption : decrypted[m.id]?.caption) || '';
    return c || undefined;
  };
  // #215: every photo/video in this chat, as lightbox items (swipe order
  // = chat order).
  const chatMediaItems = (): { url: string; type: 'image' | 'video'; senderName?: string; time?: string; caption?: string }[] =>
    visibleMsgs
      .filter((m: any) => m.mediaUrl && (m.mediaType === 'image' || m.mediaType === 'video'))
      .map((m: any) => ({
        url: m.mediaUrl,
        type: m.mediaType === 'video' ? 'video' : 'image',
        senderName: m.senderName,
        time: formatTime(m.timestamp),
        caption: captionFor(m),
      }));
  // Phase 4 (integration): data-usage — message ids the user tapped to load
  // manually when auto-download is off for that media kind.
  const [tappedMedia, setTappedMedia] = useState<Set<string>>(new Set());
  // True when this incoming media must NOT auto-load (prefs say so and the
  // user hasn't tapped to load it yet). Own sent media always loads.
  const mediaAutoBlocked = (m: any, mine: boolean) => {
    if (mine) return false;
    // Theme fix: documents use the document auto-download setting.
    // WA parity (DM audit row 80): audio obeys its own auto-download
    // setting too — voice notes used to stream/decode on render even
    // with audio auto-download off.
    const kind = m.mediaType === 'video' ? 'video' : m.mediaType === 'file' ? 'document' : m.mediaType === 'audio' ? 'audio' : 'photo';
    return !shouldAutoDownload(kind) && !tappedMedia.has(m.id);
  };

  // Wave-2 Media A12 — per-type HD auto-download. HD downloads the
  // original file; Standard downloads the compressed variant. For photos
  // the compressed variant is produced client-side here (max 1280 px
  // long edge, JPEG 0.82 — the same constants as the upload Auto
  // compression), so the setting is honoured even though the server
  // stores a single variant. Videos have no client-side transcode, so
  // Standard video still downloads the original until a compressed
  // variant exists server-side; the pref is stored per-type regardless.
  const downscaleImageBlob = async (blob: Blob): Promise<Blob> => {
    try {
      const bmp = await createImageBitmap(blob);
      const maxEdge = 1280;
      const longest = Math.max(bmp.width, bmp.height);
      if (longest <= maxEdge) { bmp.close(); return blob; }
      const scale = maxEdge / longest;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { bmp.close(); return blob; }
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      // Keep PNGs PNG (transparency) and only re-encode lossy sources
      // as JPEG; anything else falls back to the original blob.
      const outType = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, 0.82));
      return out || blob;
    } catch {
      return blob; // never break a download for the downscale
    }
  };

  // WA parity (DM audit row 81): tap-to-download with real progress.
  // Streams the media via fetch so the placeholder can show a % while it
  // loads (an <img>/<video> src gives no progress events). The finished
  // blob URL replaces the remote src; a failure clears the progress and
  // leaves the placeholder tappable again.
  const downloadMediaWithProgress = async (m: any) => {
    if (!m?.mediaUrl || !m?.id) return;
    if (mediaLocalUrls[m.id]) {
      setTappedMedia((prev) => new Set(prev).add(m.id));
      return;
    }
    const cur = mediaDownloadProgress[m.id];
    if (typeof cur === 'number' && cur < 100) return;
    setMediaDownloadProgress((prev) => ({ ...prev, [m.id]: 0 }));
    try {
      const res = await fetch(m.mediaUrl);
      if (!res.ok || !res.body) throw new Error('download failed');
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks: BlobPart[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          if (total > 0) {
            const pct = Math.round((received / total) * 100);
            setMediaDownloadProgress((prev) => ({ ...prev, [m.id]: pct }));
          }
        }
      }
      // Wave-2 Media A12: honour the per-type HD choice — Standard
      // photos download the compressed variant, HD the original.
      let blob = new Blob(chunks);
      if (m.mediaType === 'image' && !shouldDownloadHd('photo')) {
        blob = await downscaleImageBlob(blob);
      }
      const url = URL.createObjectURL(blob);
      setMediaLocalUrls((prev) => ({ ...prev, [m.id]: url }));
      setMediaDownloadProgress((prev) => ({ ...prev, [m.id]: 100 }));
      setTappedMedia((prev) => new Set(prev).add(m.id));
    } catch {
      setMediaDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[m.id];
        return next;
      });
      showToastMsg('Could not download media. Try again.');
    }
  };

  // Wave-2 Media A12 — auto-downloaded Standard photos must render the
  // compressed variant, not the remote original the <img> src would load
  // directly. When the per-type HD choice is Standard for photos, fetch
  // + downscale incoming auto-downloaded images in the background (the
  // same downloadMediaWithProgress path as a manual tap); the bubble
  // swaps to the local blob URL when it lands. HD photos, videos (no
  // client transcode — see above), own messages and view-once media are
  // skipped; attempted ids are remembered so a re-render never refetches.
  const hdPrefetchTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (shouldDownloadHd('photo')) return;
    for (const m of messages) {
      if (!m || m.mediaType !== 'image' || !m.mediaUrl || !m.id) continue;
      if (m.isViewOnce || m.senderId === currentUser?.uid) continue;
      if (typeof m.mediaUrl !== 'string' || m.mediaUrl.startsWith('local-media:') || m.mediaUrl.startsWith('blob:')) continue;
      if (mediaLocalUrls[m.id] || hdPrefetchTriedRef.current.has(m.id)) continue;
      if (!shouldAutoDownload('photo')) continue;
      hdPrefetchTriedRef.current.add(m.id);
      void downloadMediaWithProgress(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Forward message state
  const [forwardMsg, setForwardMsg] = useState<any>(null);
  // Nightshift forward caption (§6b): caption typed in the forward
  // picker — prefilled from the message's own caption when it has one,
  // so the user can keep, edit, or clear it before sending.
  const [forwardCaption, setForwardCaption] = useState('');
  const [contactsList, setContactsList] = useState<any[]>([]);
  // W27c (100M-C2): this group chat's own members, for the contact-share
  // quick-pick only — kept separate from contactsList so the forward
  // picker and add-member candidates keep their gated behaviour.
  const [groupMemberContacts, setGroupMemberContacts] = useState<any[]>([]);
  // 100M-H27: every app user, for the Group Info add-member picker only.
  // Loaded lazily — only while Group Info is open for a group I belong
  // to — and only as minimal public fields (uid / name / username /
  // photo). Me + blocked users are excluded. The forward picker and
  // contact-share quick-pick keep their W28-gated lists; this widens
  // ONLY the add-member candidates, so a valid app user with no prior
  // DM/contact can finally be found and added by name search.
  const [allAppUsers, setAllAppUsers] = useState<any[]>([]);
  useEffect(() => {
    if (!currentUser || !showGroupInfo || !isCommunity || !otherUser || !isGroupMember(otherUser, currentUser.uid)) {
      setAllAppUsers([]);
      return;
    }
    const blocked = new Set(loadBlockedIdsCached(currentUser.uid));
    const unsub = onSnapshot(collection(db, 'users'), (snap: any) => {
      try {
        const list = (snap.docs || [])
          .map((d: any) => ({ id: d.id, ...(typeof d.data === 'function' ? d.data() : {}) }))
          .filter((u: any) => {
            const uid = u.uid || u.id;
            return uid && uid !== currentUser.uid && !blocked.has(uid) && (u.displayName || u.username);
          })
          .map((u: any) => ({ uid: u.uid || u.id, id: u.uid || u.id, displayName: u.displayName || '', username: u.username || '', photoURL: u.photoURL || '' }));
        setAllAppUsers(list);
      } catch { /* offline: keep the previous list */ }
    });
    return () => { try { unsub(); } catch { /* already closed */ } };
  }, [currentUser, showGroupInfo, isCommunity, otherUser]);

  // Schedule modal
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedText, setSchedText] = useState('');
  const [schedTime, setSchedTime] = useState('');
  // 4d: this chat's not-yet-sent scheduled messages (for the modal list).
  const [pendingScheduled, setPendingScheduled] = useState<ScheduledMessage[]>([]);
  // Location / Contact share modals (Feature 4)
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);

  // W27 — live location sharing in this chat.
  // liveSessionRef holds the running watch. The service's module-level
  // map is the source of truth, so the session survives ChatScreen
  // remounts — sharing continues when you leave the chat, WhatsApp-style.
  const liveSessionRef = useRef<LiveLocationSession | null>(null);
  // A reload killed the watch but the persisted session meta survived →
  // offer Resume instead of silently dropping the share.
  const [liveResumeNeeded, setLiveResumeNeeded] = useState(false);
  // Ticks the sharing banner's "X min left" label every 30 s.
  const [liveNow, setLiveNow] = useState(() => Date.now());

  // Attach menu
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  // Cluster C (Item 13): in-app camera viewfinder + video quality choice.
  const [showCamera, setShowCamera] = useState(false);
  const [pendingVideo, setPendingVideo] = useState<File | null>(null);
  // 100M-F2: caption typed in the video-quality sheet; cleared whenever
  // the sheet closes so it never leaks onto the next video.
  const [videoCaption, setVideoCaption] = useState('');
  // Nightshift doc caption (§6a): a single document/audio picked via
  // Attach → File waits in a caption sheet (same pattern as the video
  // quality sheet) instead of sending immediately caption-less.
  const [pendingDoc, setPendingDoc] = useState<File | null>(null);
  const [docCaption, setDocCaption] = useState('');
  // WA parity (verify dm-4 row 67 / media-5 A17): several photos/videos
  // picked together wait in an album caption sheet — one shared caption
  // for the whole album, carried on its first member — instead of
  // sending caption-less. (Same feature, built twice; one implementation.)
  const [pendingAlbum, setPendingAlbum] = useState<File[] | null>(null);
  const [albumCaption, setAlbumCaption] = useState('');
  // WA parity A9 (step 2): a picked GIF waits in a caption sheet
  // (preview + caption) instead of sending immediately caption-less.
  const [pendingGif, setPendingGif] = useState<GifDef | null>(null);
  const [gifCaption, setGifCaption] = useState('');
  // ROADMAP-2 item 7: single photo waiting in the editor (gallery pick or
  // in-app camera capture). Cleared on Send (edited file goes to sendFile)
  // or Cancel (original is discarded, never sent).
  const [pendingPhoto, setPendingPhoto] = useState<{ file: File; url: string } | null>(null);
  const [videoQualityBusy, setVideoQualityBusy] = useState(false);
  const [videoCompressPct, setVideoCompressPct] = useState(0);

  // Pinned message
  const [pinnedMsg, setPinnedMsg] = useState<any>(null);
  // Disappearing messages (Feature 2) — per-chat TTL in ms, 0 = off.
  const [disappearAfter, setDisappearAfter] = useState<number>(0);
  // AUDIT-2 C5: read/delivery watermarks, live from the chat doc
  // (`seenUpTo` / `deliveredUpTo`: { [uid]: { msgId, msgTimestamp, at } }).
  // My own entries are the stored marker the flush must not regress;
  // everyone else's entries drive my outgoing ticks (see
  // effectiveMessageStatus in services/readReceipts.ts).
  const [seenUpToByUid, setSeenUpToByUid] = useState<Record<string, SeenUpTo>>({});
  const [deliveredUpToByUid, setDeliveredUpToByUid] = useState<Record<string, SeenUpTo>>({});
  const [showDisappearModal, setShowDisappearModal] = useState(false);
  // REPORT-3 #65 (W20): per-chat notification tone picker (header menu →
  // modal below). The tone itself is a per-device pref (appSettings) and
  // the watcher plays it for this conversation (pushNotifications, W9).
  const [showToneModal, setShowToneModal] = useState(false);
  // Ticking clock so messages vanish while the chat is open, not only on reload.
  const [disappearNow, setDisappearNow] = useState<number>(() => Date.now());

  // Search in chat
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // #24: debounced in-chat search — the raw query drives the input box,
  // the debounced one drives the all-messages filter below, so typing
  // in the search bar does not re-filter every message per keystroke.
  const [searchQueryDebounced, setSearchQueryDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setSearchQueryDebounced(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [searchIdx, setSearchIdx] = useState(0);
  // 100M-H8: closing in-chat search snapped the chat to the top. While
  // searching, the list shrinks to the few matches, so the browser clamps
  // scrollTop to 0; on close the full paged list re-renders but nothing
  // restored scrollTop, and the [messages] auto-scroll effect never
  // re-fires (messages didn't change). Save the pre-search position as a
  // distance-from-bottom — immune to the search bar mounting/unmounting
  // changing the list height — and restore it after the unfiltered list
  // has re-rendered. Fallback is the bottom (latest), never the top.
  const preSearchDistFromBottomRef = useRef<number | null>(null);
  const searchRestorePendingRef = useRef(false);
  // A11y: the search bar container (focus-stranding check in closeSearch)
  // and the header menu button (focus-return target — search is opened
  // from the header menu now that the DM header has no search icon).
  const searchBarRef = useRef<HTMLDivElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  // Open search from the header menu: save
  // the position BEFORE the bar mounts — a post-mount read is already
  // off by the bar's height (the bar shrinks the list, max grows, and
  // scrollTop stays put, so a post-mount distance reads ~41 px too big
  // and the restore lands one row above the pre-search viewport).
  const openSearch = () => {
    // Audit H8-3: a re-open while a restore is pending cancels that
    // restore (the one live job of the deleted fallback effect below) —
    // the new open keeps the still-unrestored position instead of yanking
    // later. openSearch() is the only opener (the only setShowSearchBar
    // (true) in this file), so one line here replaces the whole effect.
    searchRestorePendingRef.current = false;
    // Audit H8-2: only save when the list is unfiltered. Re-opening
    // within the 250 ms debounce (debounced query still set, list still
    // the short filtered list) would otherwise overwrite the saved
    // distance with ~0 and the restore would land at the bottom instead
    // of the pre-search position. The first open always has an empty
    // debounced query, so a saved value exists by the time this guard can
    // skip; the null check covers it anyway.
    if (searchQueryDebounced === '' || preSearchDistFromBottomRef.current == null) {
      const el = messagesScrollRef.current;
      preSearchDistFromBottomRef.current = el
        ? el.scrollHeight - el.scrollTop - el.clientHeight
        : null;
    }
    setShowSearchBar(true);
  };
  // Close search from every affordance (bar X, Escape/back, header icon):
  // hide the bar, clear the query, and arm the scroll restore below.
  const closeSearch = () => {
    searchRestorePendingRef.current = true;
    // A11y (WCAG 2.4.3): if focus is inside the search bar (input, Prev/
    // Next, X), the bar unmounting would strand it on <body> and a
    // keyboard user would Tab from the top of the page. Return it to the
    // header control that opened search. When focus is already on that
    // toggle (header-icon close) nothing moves.
    const focusInBar = searchBarRef.current?.contains(document.activeElement) ?? false;
    setShowSearchBar(false);
    setSearchQuery('');
    if (focusInBar) searchToggleRef.current?.focus();
  };
  // Restore once search is closed AND the debounced query has cleared —
  // the list only switches back to the paged slice then (the bar itself
  // unmounts immediately on close). Double rAF so the full list has
  // re-rendered and scrollHeight has settled before we set scrollTop.
  useEffect(() => {
    if (showSearchBar || searchQueryDebounced || !searchRestorePendingRef.current) return;
    const dist = preSearchDistFromBottomRef.current;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        // Cancelled since scheduling (search re-opened, or navigated to
        // another chat — see the [conversationId] cancellation effect in
        // the auto-scroll section) → do not yank the scroll position of
        // whatever is on screen now. The scroll restore moves no focus,
        if (!searchRestorePendingRef.current) return;
        searchRestorePendingRef.current = false;
        const el = messagesScrollRef.current;
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        // No saved position → bottom. Otherwise the same distance from
        // the bottom as before searching, clamped into the re-rendered
        // list (a pre-search bottom, dist ≈ 0, lands on the bottom).
        el.scrollTop = dist == null ? max : Math.min(max, Math.max(0, max - Math.max(0, dist)));
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [showSearchBar, searchQueryDebounced]);
  // ── Phase 3 (Agent A): multi-select, pins/starred, info sheet, offline, mentions ──
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectMode = selectedIds.length > 0;
  // R2: whether the select-mode toolbar shows its quick-reaction row.
  const [showToolbarReact, setShowToolbarReact] = useState(false);
  const [pinnedMsgs, setPinnedMsgs] = useState<any[]>([]);
  // WA audit (d) C9 — channel pinned banner/list: index of the pin the
  // channel banner currently shows, and whether the pinned-messages
  // list sheet is open. Pin storage itself is reused unchanged
  // (chats/<id>/meta/pinnedList + legacy meta/pinned).
  const [pinBannerIdx, setPinBannerIdx] = useState(0);
  const [showPinnedList, setShowPinnedList] = useState(false);
  const [starredIds, setStarredIds] = useState<string[]>([]);
  const [msgInfo, setMsgInfo] = useState<any>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ kind: 'me' | 'everyone'; ids: string[] } | null>(null);
  const [forwardMsgs, setForwardMsgs] = useState<any[] | null>(null);
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [partnerTypingAt, setPartnerTypingAt] = useState(0);
  const [lightTheme, setLightTheme] = useState(() => getLightChatTheme(partnerUid || ''));
  // WA parity (wa-verify-settings-3, rows 38/39/40): the per-chat light
  // pref is keyed by partnerUid, which resolves once the user loads — so
  // re-read it when the chat changes instead of trusting the first render.
  useEffect(() => { setLightTheme(getLightChatTheme(partnerUid || '')); }, [partnerUid]);
  const [silentSend, setSilentSend] = useState(false);
  // Theme fix: per-chat theme picker.
  const [showChatTheme, setShowChatTheme] = useState(false);
  const [isLockedRecording, setIsLockedRecording] = useState(false);
  // ── ROADMAP-2 R1A: albums (6), clear chat (10), unread divider +
  // jump-to-date (11), voice-note gestures (12) ──
  // Item 10: this user's clearedAt stamp for this chat (epoch ms, 0 = never).
  const [clearedAt, setClearedAtState] = useState(0);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // Item 11: "last read" watermark frozen at chat open — the unread
  // divider's anchor (see the effect before "Load messages").
  const [unreadAnchorAt, setUnreadAnchorAt] = useState(0);
  const [jumpDate, setJumpDate] = useState('');
  // Item 6: albumId of the album currently expanded to full-width tiles.
  const [albumExpanded, setAlbumExpanded] = useState<string | null>(null);
  // Item 6: multi-file send queue — one entry per file, with per-file
  // progress + outcome (uploading / done / failed).
  const [uploadQueue, setUploadQueue] = useState<{ id: string; name: string; progress: number; status: 'uploading' | 'done' | 'failed' }[]>([]);
  const uploadQueueTimerRef = useRef<any>(null);
  // Item 12: live voice-gesture state (mirrored in a ref so the pointer
  // handlers never read stale render state).
  const [voiceGesture, setVoiceGesture] = useState<'idle' | 'recording' | 'lock-armed' | 'cancel-armed'>('idle');
  const voiceGestureRef = useRef<'idle' | 'recording' | 'lock-armed' | 'cancel-armed'>('idle');
  const voiceStartRef = useRef<{ x: number; y: number } | null>(null);
  const voiceDownAtRef = useRef(0);
  // Window listeners attached for one hold (added on pointerdown, removed
  // on release) — see handleMicPointerDown below for why they must be
  // window-level, not on the mic button.
  const voiceListenersRef = useRef<{ move: (e: PointerEvent) => void; up: () => void; cancel: () => void } | null>(null);
  const removeVoiceListeners = () => {
    const l = voiceListenersRef.current;
    voiceListenersRef.current = null;
    if (!l) return;
    window.removeEventListener('pointermove', l.move);
    window.removeEventListener('pointerup', l.up);
    window.removeEventListener('pointercancel', l.cancel);
  };
  // Never leak a hold's listeners if the chat unmounts mid-recording.
  useEffect(() => () => { removeVoiceListeners(); }, []);
  // A finger released before MediaRecorder is up (mic permission prompt):
  // the release action is honoured once the recorder starts.
  const voiceReleaseRef = useRef<'send' | 'cancel' | null>(null);
  const isLockedRecordingRef = useRef(false);
  // Per-album-file progress already patched onto the placeholder doc, so
  // the bubble's % updates at most every 10 points (not per S3 part).
  const albumProgressPatchedRef = useRef<Record<string, number>>({});
  // Keep the lock ref in sync — the lock button below flips state, the
  // pointer handlers read the ref.
  useEffect(() => { isLockedRecordingRef.current = isLockedRecording; }, [isLockedRecording]);
  const displayedPins = pinnedMsgs.length > 0 ? pinnedMsgs : (pinnedMsg ? [pinnedMsg] : []);

  // Theme fix — this chat's look: per-chat override if set, else the global
  // default theme. Recomputed every render, so saving a theme in the picker
  // applies immediately. Bubble / background colours come from the theme
  // (dark or light variants follow the app theme).
  const chatLook = getChatThemeFor(partnerUid || '');
  const chatDef = chatLook.def;
  const chatIsDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const bubbleSent = chatIsDark ? chatDef.sent : chatDef.sentLight;
  const bubbleRecv = chatIsDark ? chatDef.recv : chatDef.recvLight;
  const bubbleText = chatIsDark ? chatDef.text : chatDef.textLight;
  const chatBg = chatIsDark ? chatDef.bg : chatDef.bgLight;

  // Recording
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const recordingSecsRef = useRef(0);
  // WA parity (media audit V5): pause / resume. MediaRecorder.pause()
  // freezes the timer and the level loop; resume continues the SAME blob.
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const isRecordingPausedRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<any>(null);
  // UI-army #9 (listen-before-send): a finished recording stages here
  // as a preview (Play + Send + Delete) instead of sending on stop.
  // The blob URL is revoked when the preview is replaced / cleared, or
  // when the chat unmounts (effect below).
  const [voicePreview, setVoicePreview] = useState<{ url: string; blob: Blob; secs: number; waveform: number[]; isViewOnce?: boolean } | null>(null);
  useEffect(() => () => { if (voicePreview) URL.revokeObjectURL(voicePreview.url); }, [voicePreview]);
  // #208: live mic levels — an AnalyserNode on the recording stream drives
  // the bars via direct DOM updates (no React state per frame). Refs only,
  // so the level loop never re-renders the chat.
  const recorderAudioCtxRef = useRef<AudioContext | null>(null);
  const recorderAnalyserRef = useRef<AnalyserNode | null>(null);
  const recLevelRafRef = useRef<number | null>(null);
  const recBarsRef = useRef<HTMLDivElement | null>(null);

  // ── Phase 4: round video recording (Telegram-style circle video, ≤60s) ──
  const [isRoundRecording, setIsRoundRecording] = useState(false);
  const [roundSecs, setRoundSecs] = useState(0);
  const roundSecsRef = useRef(0);
  const roundRecorderRef = useRef<MediaRecorder | null>(null);
  const roundChunksRef = useRef<Blob[]>([]);
  const roundStreamRef = useRef<MediaStream | null>(null);
  const roundTimerRef = useRef<any>(null);
  const roundPreviewRef = useRef<HTMLVideoElement>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // UI-army #3: disarm View Once when the file pick is cancelled. The
  // file input mounts only AFTER the loading gate lifts, so a mount-time
  // useEffect sees fileInputRef.current === null (verified: the effect ran
  // with no input). A callback ref attaches a NATIVE 'cancel' listener
  // whenever the element appears (and detaches it when it goes away), and
  // keeps fileInputRef.current in sync for all existing .click() call
  // sites. Native, not React onCancel: React's synthetic onCancel on
  // <input type="file"> does not fire (verified in a headless probe — the
  // event propagates and fires a native listener, but React's handler
  // never runs).
  const fileInputCallbackRef = useCallback((el: HTMLInputElement | null) => {
    const prev = fileInputRef.current;
    if (prev && (prev as any).__voCancelListener) {
      prev.removeEventListener('cancel', (prev as any).__voCancelListener);
      delete (prev as any).__voCancelListener;
    }
    fileInputRef.current = el;
    if (el) {
      const onCancel = () => setIsViewOnce(false);
      (el as any).__voCancelListener = onCancel;
      el.addEventListener('cancel', onCancel);
    }
  }, []);
  // Phase 4: dedicated camera input — `capture="environment"` asks mobile
  // browsers to open the rear camera; desktop ignores it and shows the
  // file picker, so the file-picker fallback is preserved.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Typing-freeze fix (#20): the composer owns its input state (see
  // ChatComposer.tsx). ChatScreen only reads/pushes text via this ref.
  const composerRef = useRef<ChatComposerHandle | null>(null);
  // #130: guards for the load-more handler (re-entry + initial scroll).
  const loadMoreGuardRef = useRef(false);
  const initialScrollRef = useRef(false);
  // P0-2 divider follow-up (W24 R7): the scroll-up load-more must only
  // fire after the user has actually scrolled up from the bottom. On
  // open, the container starts at scrollTop 0 and the smooth scroll-to-
  // bottom animation passes through scrollTop < 80 — the 1s initial-
  // scroll guard does not cover a late/slow animation (messages arrive
  // in waves, each [messages] change re-triggers scrollIntoView), so a
  // scroll event with top < 80 could land after the guard expired and
  // grow the page 50 -> 100 before any typing (V2 re-probe + R3 probe).
  // reachedBottomRef is set only once the container has actually been
  // at the bottom; until then top < 80 is the opening animation, not
  // a user scrolling up. Reset per conversation, like initialScrollRef.
  const reachedBottomRef = useRef(false);
  // H24 (Saved/Starred "Open in chat" jump): hold timestamp (ms) until
  // which the mount auto-scroll effect below is suppressed. A jump must
  // survive the post-mount [messages] waves — the E2EE key-announce
  // write lands ~1–2 s after mount (proven live: collection 60 → 61
  // docs, kxDocs 0 → 1) and its snapshot re-fires the auto-scroll to
  // the bottom, yanking the chat off the jumped message. Set at capture
  // so the mount-time auto-scroll never runs while a jump is pending;
  // refreshed for 4 s after the scroll (covers the announce + peer
  // ack); cleared on the not-found verdict so a failed jump opens at
  // the bottom like a normal chat. Reset per conversation, like
  // reachedBottomRef.
  const jumpHoldRef = useRef(0);
  // W13 NEXT R8 (B3): a deliberate user scroll-up, distinct from the
  // opening smooth-scroll animation. The animation never produces wheel
  // or touch events, so a wheel-up / touch-drag-down that reaches the
  // top is proof a human asked for older messages — it bypasses the two
  // guards in handleMessagesScroll. (A tap has < 4 px of touch movement,
  // so the touch threshold below cannot fire on a tap.)
  const userScrollUpRef = useRef(false);
  // W13 NEXT R8 (B3): previous scrollTop, for the top-zone crossing gate
  // in handleMessagesScroll (one load-more per crossing, not per event).
  const lastScrollTopRef = useRef(Infinity);
  const lastTouchYRef = useRef<number | null>(null);
  const typingTimerRef = useRef<any>(null);
  const sendTimestampsRef = useRef<number[]>([]);
  // R2 (reaction-late fix): timestamp of the last touch long-press that
  // opened the reaction picker — a WebView `contextmenu` firing right
  // after it must not ALSO open the context menu on top of the picker.
  const touchLongPressAtRef = useRef(0);
  // AUDIT-2 C5 (reaction-late fix L3, watermark form): debounced
  // read-receipt flush. The effect only COLLECTS the pending watermark
  // (the highest incoming message seen / delivered); one timer flushes
  // it at most once per 1.2 s as a SINGLE updateDoc on the chat doc.
  // `lastSent*Ref` dedups: a snapshot echo of an already-flushed
  // watermark never re-writes it. A failed flush keeps the target
  // pending, so the next snapshot retries it instead of losing it.
  const pendingSeenRef = useRef<{ wm: SeenUpTo; cid: string } | null>(null);
  const pendingDeliveredRef = useRef<{ wm: SeenUpTo; cid: string } | null>(null);
  const lastSentSeenRef = useRef<SeenUpTo | null>(null);
  const lastSentDeliveredRef = useRef<SeenUpTo | null>(null);
  const receiptsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // L5 (reaction-late fix): flood-guard queue. Sends that arrive while
  // the 6-in-2s window is full wait here instead of being dropped.
  const sendQueueRef = useRef<Array<{ txt: string; replyTo: any; silent: boolean }>>([]);
  const sendQueueBusyRef = useRef(false);
  // AUDIT-2 A10: why the last send failed, so the toast can say
  // "Encryption failed" instead of blaming the connection. Reset at the
  // top of handleSend; set by sendTextNow's catch.
  const lastSendErrorRef = useRef<unknown>(null);

  // ── Public channels (announcement-only) ──
  // `otherUser` holds the live communities/<chatId> doc for community chats.
  // Docs without isChannel/readOnly are normal groups (backward compat).
  const isChannelDoc = isCommunity && isChannel(otherUser);
  // NF-1 — channel reaction policy (Any emoji / Default only / None),
  // stored on the communities doc as `reactionPolicy`; absent = 'any'.
  // The message list is a useMemo, so the live policy is read through
  // a ref — a policy change re-gates the picker without a memo dep.
  const channelReactionPolicy: ChannelReactionPolicy = isChannelDoc ? normalizeChannelReactionPolicy((otherUser as any)?.reactionPolicy) : 'any';
  const channelPolicyRef = useRef(channelReactionPolicy);
  channelPolicyRef.current = channelReactionPolicy;
  // Phase 3 (integration): non-members of a group/community cannot send.
  // `canSend` is checked by every send path, so folding membership in here
  // blocks text, media, sticker, poll, location, contact and voice sends.
  const isCommunityNonMember = isCommunity && !!otherUser && !!currentUser && !isGroupMember(otherUser, currentUser.uid);
  // F54 (100-more): canSendInGroup is the superset of canSendInChannel —
  // channels behave identically, and plain groups now honour
  // sendMessagesBy 'admins' (the #194 permission, previously dead code).
  const canSend = canSendInGroup(isCommunity ? otherUser : null, currentUser?.uid) && !isCommunityNonMember;
  const subscriberCount = isCommunity ? getSubscriberCount(otherUser) : 0;
  // 100M-H26: the group description lives on the live communities doc
  // (otherUser) but the header subtitle never read it — members only saw
  // the member count and had to open Group Info to find the description.
  const groupDescription = isCommunity ? String(otherUser?.description || '').trim() : '';
  const groupHeaderSubtitle = isCommunity
    ? `${formatMemberCount(subscriberCount, isChannelDoc)}${isChannelDoc ? ' · 📢 Channel' : ''}${groupOnlineCount != null && groupOnlineCount > 0 ? ` · ${groupOnlineCount} online` : ''}${groupDescription ? ` · ${groupDescription}` : ''}`
    : '';
  // WA parity (DM audit rows 6–7): group typing names from the typing
  // uids (names resolved from message senders; unknown uid → 'Someone').
  const groupTypingText = (() => {
    if (groupTypingUids.length === 0) return '';
    const nameFor = (uid: string) => {
      const m = messages.find((x: any) => x.senderId === uid);
      return (m?.senderName || '').trim() || 'Someone';
    };
    const names = groupTypingUids.map(nameFor);
    if (names.length === 1) return `${names[0]} is typing`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
    return `${names[0]}, ${names[1]} and ${names.length - 2} more are typing`;
  })();

  // F2: partnerUid is the unwrapped partner (or the raw param) — re-wrapping
  // a full conversation id here is exactly the double-wrap bug.
  const conversationId = currentUser && chatId
    ? (isCommunity ? cleanId(chatId) : getConversationId(currentUser.uid, partnerUid || chatId))
    : null;

  // REPORT-3 #65 (W20): per-chat tone, read live from the pref store at
  // render time so it is never stale after setChatTone writes. '' = no
  // override — the conversation plays the global (DM) / group tone.
  // The same conversationId is what pushNotifications passes to
  // getChatTone, so the picker and the played tone can never disagree.
  const chatToneId = getChatTone(conversationId || undefined);
  const chatToneLabel = chatToneId
    ? (NOTIFICATION_TONES.find((t) => t.id === chatToneId)?.label || 'Default')
    : 'Default';

  // Active MQTT conversation channel subscription and instant sync
  useEffect(() => {
    if (!conversationId) return;
    realtimeSync.joinConversation(conversationId, partnerUid);
    return () => {
      realtimeSync.leaveConversation(conversationId);
    };
  }, [conversationId, partnerUid]);

  // Reply privately (Worker 3 service): when this DM was opened from a
  // group message, replyPrivately() staged the quoted group message in
  // sessionStorage — consume it once here and show it as the reply
  // banner. takePendingReply() removes the record, so a reload never
  // resurrects a stale quote. `fromChatId`/`fromChatName` ride along so
  // the quote preview can tell a cross-chat quote from an in-chat one.
  useEffect(() => {
    if (!conversationId) return;
    const pending = takePendingReply(conversationId);
    if (pending) {
      setReplyTo({
        id: pending.id,
        text: pending.text,
        senderName: pending.senderName,
        fromChatId: pending.fromChatId,
        fromChatName: pending.fromChatName,
      });
      inputRef.current?.focus();
    }
  }, [conversationId]);

  // Swipe to reply gesture & jump to reply highlight
  const [swipingMsgId, setSwipingMsgId] = useState<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState<number>(0);
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);
  const touchStartX = useRef<number>(0);
  const touchStartY = useRef<number>(0);
  const isHorizontalSwipe = useRef<boolean | null>(null);

  // Reaction breakdown modal
  const [reactionDetailsMsg, setReactionDetailsMsg] = useState<any | null>(null);

  // Media, links & docs gallery modal
  const [showMediaGallery, setShowMediaGallery] = useState(false);
  const [mediaGalleryTab, setMediaGalleryTab] = useState<'media' | 'docs' | 'links'>('media');

  // Delete for me tracking
  const [deletedForMeIds, setDeletedForMeIds] = useState<string[]>([]);
  useEffect(() => {
    if (!currentUser?.uid || !conversationId) return;
    try {
      const stored = localStorage.getItem(deletedForMeKey(currentUser.uid, conversationId));
      if (stored) setDeletedForMeIds(JSON.parse(stored));
    } catch (e) { console.warn('[ChatScreen] could not read deleted-for-me list:', e); }
  }, [currentUser?.uid, conversationId]);

  // ── Click outside ──
  // NOTE (user-test C21/C22): this runs on `mousedown`, which fires BEFORE
  // the `click` on a menu/picker item. Closing unconditionally here used to
  // unmount the menu/picker under the user's tap, so Reply/Forward/Star/
  // Edit/Delete and emoji insert were all dead on real taps. Only close
  // when the press lands OUTSIDE the open overlays.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Clicks inside an open overlay must not dismiss it — each overlay
      // handles its own close button / item action.
      if ((e.target as HTMLElement).closest?.('[data-combined-picker], [data-context-menu], [data-reaction-picker]')) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
      setCtxMenu(null);
      setShowReactPicker(null);
      closeCombinedPicker();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Navigation Backstack Handlers for Overlays and Modals ──
  useEffect(() => {
    if (lightbox.open) {
      return navigationManager.pushHandler(() => {
        setLightbox(prev => ({ ...prev, open: false }));
        return true;
      });
    }
  }, [lightbox.open]);

  useEffect(() => {
    if (showPollModal) {
      return navigationManager.pushHandler(() => {
        setShowPollModal(false);
        return true;
      });
    }
  }, [showPollModal]);

  useEffect(() => {
    if (showScheduleModal) {
      return navigationManager.pushHandler(() => {
        setShowScheduleModal(false);
        return true;
      });
    }
  }, [showScheduleModal]);

  useEffect(() => {
    if (showLocationModal) {
      return navigationManager.pushHandler(() => {
        setShowLocationModal(false);
        return true;
      });
    }
  }, [showLocationModal]);

  useEffect(() => {
    if (showContactModal) {
      return navigationManager.pushHandler(() => {
        setShowContactModal(false);
        return true;
      });
    }
  }, [showContactModal]);

  useEffect(() => {
    if (forwardMsg) {
      return navigationManager.pushHandler(() => {
        setForwardMsg(null);
        return true;
      });
    }
  }, [forwardMsg]);

  useEffect(() => {
    if (showAttachMenu) {
      return navigationManager.pushHandler(() => {
        setShowAttachMenu(false);
        return true;
      });
    }
  }, [showAttachMenu]);

  useEffect(() => {
    if (showCombinedPicker) {
      return navigationManager.pushHandler(() => {
        closeCombinedPicker();
        return true;
      });
    }
  }, [showCombinedPicker, closeCombinedPicker]);

  useEffect(() => {
    if (showSearchBar) {
      return navigationManager.pushHandler(() => {
        closeSearch();
        return true;
      });
    }
  }, [showSearchBar]);

  useEffect(() => {
    if (showMenu) {
      return navigationManager.pushHandler(() => {
        setShowMenu(false);
        return true;
      });
    }
  }, [showMenu]);

  useEffect(() => {
    if (ctxMenu) {
      return navigationManager.pushHandler(() => {
        setCtxMenu(null);
        return true;
      });
    }
  }, [ctxMenu]);

  useEffect(() => {
    if (reactionDetailsMsg) {
      return navigationManager.pushHandler(() => {
        setReactionDetailsMsg(null);
        return true;
      });
    }
  }, [reactionDetailsMsg]);

  useEffect(() => {
    if (showDisappearModal) {
      return navigationManager.pushHandler(() => {
        setShowDisappearModal(false);
        return true;
      });
    }
  }, [showDisappearModal]);

  useEffect(() => {
    if (showMediaGallery) {
      return navigationManager.pushHandler(() => {
        setShowMediaGallery(false);
        return true;
      });
    }
  }, [showMediaGallery]);

  useEffect(() => {
    if (showGroupInfo) {
      return navigationManager.pushHandler(() => {
        setShowGroupInfo(false);
        return true;
      });
    }
  }, [showGroupInfo]);

  // E2EE notice sheet — back button closes it like the other overlays.
  useEffect(() => {
    if (showE2EESheet) {
      return navigationManager.pushHandler(() => {
        setShowE2EESheet(false);
        return true;
      });
    }
  }, [showE2EESheet]);

  // App-lock fix (2026-11-14): an incoming message is activity — reading
  // a chat while messages arrive must not let the app-lock timer expire.
  // (The gate's own listeners cannot see network arrivals.)
  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) recordAppActivity();
    prevMsgCountRef.current = messages.length;
  }, [messages.length]);

  // ── Load current user settings ──
  useEffect(() => {
    if (!currentUser || !partnerUid) return;
    // RC4 retry guard: once any path has resolved the hidden state, the
    // retry loop stops — it must not re-read (and re-assert) the state
    // after the user toggles hide/unhide in this chat.
    let resolved = false;
    const unsubscribe = onSnapshot(doc(db, 'users', currentUser.uid), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        // Phase 5: locked status comes from the private locked doc via
        // loadHiddenChatIds (migrates the legacy public field); the public
        // snapshot is kept only as a fallback for very old data.
        // RC4: use the strict loader — only a REAL load may resolve
        // hiddenLoaded. A failed load leaves the loading gate up; the old
        // code resolved with isHidden=false on failure, opening a locked
        // chat unlocked until the PIN slammed mid-chat.
        void import('../../services/lockedChats').then((m) =>
          m.tryLoadHiddenChatIds(currentUser.uid).then(({ ok, ids }) => {
            if (!ok) return;
            resolved = true;
            setIsHidden(ids.includes(partnerUid as string));
            setHiddenLoaded(true);
          }),
        );
        setIsBlocked((d.blockedUsers || []).includes(partnerUid));
        // Item 12: live read-receipts pref — flipping the toggle in
        // Settings takes effect here without reopening the chat.
        setReadReceipts(readReceiptsEnabled(d));
      } else {
        // App-lock fix (2026-11-14): the old code only resolved
        // `hiddenLoaded` when the user doc existed — a fresh account whose
        // doc hasn't synced yet spun forever. Resolve via the private
        // locked doc directly (it returns [] when missing/offline).
        void import('../../services/lockedChats').then((m) =>
          m.tryLoadHiddenChatIds(currentUser.uid).then(({ ok, ids }) => {
            if (!ok) return;
            resolved = true;
            setIsHidden(ids.includes(partnerUid as string));
            setHiddenLoaded(true);
          }),
        );
      }
    });
    // RC4 (fail closed): the old 10 s fallback did
    // `setHiddenLoaded(true)` while `isHidden` was still its initial
    // `false` — the chat rendered fully unlocked, then the PIN screen
    // slammed in mid-chat when the load finally landed. There is no
    // timeout resolve any more: if the load has not resolved, retry it
    // every 5 s until it does; until then the loading gate (spinner)
    // renders, never the chat content.
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attemptLoad = () => {
      if (cancelled || resolved) return;
      void import('../../services/lockedChats').then((m) =>
        m.tryLoadHiddenChatIds(currentUser.uid).then(({ ok, ids }) => {
          if (cancelled || resolved) return;
          if (ok) {
            resolved = true;
            setIsHidden(ids.includes(partnerUid as string));
            setHiddenLoaded(true);
            return;
          }
          retryTimer = setTimeout(attemptLoad, 5000);
        }),
      );
    };
    retryTimer = setTimeout(attemptLoad, 10000);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [currentUser, partnerUid]);

  // Phase 5: leaving a locked chat (unmount / different chat) ends the
  // folder unlock session, so the next locked chat re-asks for the PIN.
  useEffect(() => {
    return () => {
      if (isHidden) lockLockedFolder();
    };
  }, [isHidden, partnerUid]);

  // ── Load other user ──
  useEffect(() => {
    if (!partnerUid) return;
    const col = isCommunity ? 'communities' : 'users';
    // F2: the partner doc id is partnerUid — for a plain partner-uid param
    // that is the raw uid; for an unwrapped conversation id it is the
    // cleaned uid, which for real Cognito UUIDs differs from the doc id
    // (dashes → underscores). The users collection is subscribed at /main
    // mount, so resolve the raw doc id from the cache when it is loaded.
    let docId = partnerUid;
    if (!isCommunity && partnerUid !== chatId) {
      const cached = db.getCollectionDocs('users') || [];
      const match = cached.find((u: any) => u.id && cleanId(u.id) === cleanId(partnerUid));
      if (match) docId = match.id;
    }
    // Live subscription so the header shows online/last seen changes as they happen.
    const unsub = onSnapshot(doc(db, col, docId), (s) => {
      if (s.exists()) setOtherUser(s.data());
    });
    return () => unsub();
  }, [chatId, isCommunity, partnerUid]);

  // 100M-M2: load this DM's mute pref on open (same read as GroupInfoModal's
  // F42 mute, keyed by partner uid) — the header menu's Mute entry needs
  // it too, not just the contact-info modal (WA parity, DM audit row 8).
  useEffect(() => {
    if (isCommunity || !partnerUid || !currentUser?.uid) return;
    let cancelled = false;
    setChatMuted(null);
    // Resolve the raw partner doc id — the chat-list DM key is the user
    // doc id, and an unwrapped conversation id is the cleaned form.
    let key = partnerUid;
    if (partnerUid !== chatId) {
      const cached = db.getCollectionDocs('users') || [];
      const match = cached.find((u: any) => u.id && cleanId(u.id) === cleanId(partnerUid));
      if (match) key = match.id;
    }
    chatMuteKeyRef.current = key;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'users', currentUser.uid));
        const prefs = snap.exists() ? ((snap.data() as any)?.chatPrefs || {}) : {};
        if (!cancelled) {
          chatMutePrefRef.current = prefs[key] || {};
          setChatMuted(isMutedPref(prefs[key]));
        }
      } catch {
        // Offline / hybrid local mode: fall back to the on-device prefs,
        // mirroring ChatListScreen's savePref.
        if (!cancelled) {
          const local = loadLocalChatPrefs(currentUser.uid);
          chatMutePrefRef.current = local[key] || {};
          setChatMuted(isMutedPref(local[key]));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isCommunity, partnerUid, chatId, currentUser?.uid]);

  // 100M-M2: flip this DM's mute pref (same write as the chat-list
  // long-press Mute in ChatListScreen.savePref).
  const handleToggleChatMute = async () => {
    const myUid = currentUser?.uid;
    const key = chatMuteKeyRef.current;
    if (!myUid || !key || chatMuted === null || muteBusy) return;
    const next = !chatMuted;
    // Expiry-aware mute model (Worker A, services/chatMute.ts): the simple
    // header toggle mutes "Always" (muteEndTimestamp 0); a duration mute
    // set from the chat list is honoured by the isMutedPref() read above,
    // so an expired duration correctly shows as unmuted here.
    const nextPref = next
      ? { ...chatMutePrefRef.current, ...mutePrefForDuration(null) }
      : { ...chatMutePrefRef.current, ...unmutePref() };
    chatMutePrefRef.current = nextPref;
    setChatMuted(next);
    setMuteBusy(true);
    try {
      await updateDoc(doc(db, 'users', myUid), { [`chatPrefs.${key}`]: nextPref });
      showToastMsg(next ? 'Notifications muted for this chat' : 'Notifications unmuted for this chat');
    } catch {
      try {
        const local = loadLocalChatPrefs(myUid);
        saveLocalChatPrefs(myUid, { ...local, [key]: nextPref });
        showToastMsg(next ? 'Notifications muted for this chat (saved on this device)' : 'Notifications unmuted for this chat (saved on this device)');
      } catch {
        /* optimistic UI stays; the watcher re-reads the server value later */
      }
    } finally {
      setMuteBusy(false);
    }
  };

  // Phase 3 (integration): join from a link. Tokenised invite links must
  // present a matching, unexpired, unrevoked token (?inv=); legacy links
  // (no token stored on the group) still work.
  const handleJoinGroup = async () => {
    if (!isCommunity || !chatId || !currentUser || !otherUser) return;
    const tokenState = validateInviteToken(otherUser, searchParams.get('inv'));
    if (tokenState === 'invalid' || tokenState === 'revoked' || tokenState === 'expired') {
      showToastMsg(tokenState === 'expired' ? 'This invite link has expired' : 'This invite link is no longer valid');
      return;
    }
    try {
      // Phase 4: approval-aware join — creates a pending request when the
      // group requires approval instead of joining instantly.
      // WA72 C13: `&role=admin` admin-invite links promote on join.
      const asAdmin = searchParams.get('role') === 'admin';
      const result = await requestJoinGroup(chatId, currentUser.uid, currentUser.displayName || currentUser.username || '', asAdmin ? { asAdmin: true } : undefined);
      if (result === 'pending' || result === 'requested') showToastMsg('Join request sent — an admin will approve it');
      else if (result === 'joined') showToastMsg(asAdmin ? 'You joined as an admin ✓' : 'You joined the group ✓');
      else if (result === 'member' && asAdmin) showToastMsg('You are now an admin ✓');
    } catch (e: any) { showToastMsg(e?.message || 'Could not join the group'); }
  };

  // ── Public join link: ?type=community&join=1 auto-joins (idempotent) ──
  useEffect(() => {
    if (!isCommunity || !chatId || !currentUser || !otherUser) return;
    if (searchParams.get('join') !== '1') return;
    if (isGroupMember(otherUser, currentUser.uid)) return;
    const tokenState = validateInviteToken(otherUser, searchParams.get('inv'));
    if (tokenState === 'invalid' || tokenState === 'revoked' || tokenState === 'expired') return;
    // Phase 4: approval-aware auto-join (pending request when approval is on).
    // WA72 C13: `&role=admin` admin-invite links promote on join.
    const asAdmin = searchParams.get('role') === 'admin';
    // M10 (wa-verify-status-5): a pending result used to be swallowed silently
    // — the user opening an approval-required link got no feedback that a
    // request was sent. Surface it like the Join button does.
    requestJoinGroup(chatId, currentUser.uid, currentUser.displayName || currentUser.username || '', asAdmin ? { asAdmin: true } : undefined)
      .then((result) => {
        if (result === 'pending' || result === 'requested') showToastMsg('Join request sent — an admin will approve it');
        else if (result === 'joined') showToastMsg('You joined the group ✓');
      })
      .catch((e) => { console.warn('[ChatScreen] auto-join group failed:', e); });
  }, [isCommunity, chatId, currentUser, otherUser, searchParams]);

  // ── WA parity (merge follow-up, Worker A): ?info=1 opens the profile /
  // group-info modal — the chat-list menu's View action navigates here
  // instead of opening the modal itself. ──
  useEffect(() => {
    if (searchParams.get('info') !== '1') return;
    if (isCommunity) setShowGroupInfo(true);
    else setShowProfileModal(true);
  }, [searchParams, isCommunity]);

  // ── Load contacts for forwarding (Telegram style) ──
  // W28: gated contacts — saved contacts + proven DM partners only.
  // The forward picker, ContactShareModal and GroupInfoModal's
  // add-member candidates only ever see people I have actually talked
  // to or saved. No whole-users subscription anymore. Re-runs when the
  // chats collection changes, but profile reads only re-fire when the
  // allowed-uid SET changes. Note: the reaction-details name lookup
  // below also reads this list, so a reactor who is not a contact shows
  // as 'User' there — same trade-off as the pickers.
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
        setContactsList(list);
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
      try { unsubChats(); } catch (err) { console.warn("[ChatScreen] ChatScreen: unsubChats() failed", err); }
    };
  }, [currentUser]);

  // ── W27c (100M-C2): group members in the contact-share quick-pick ──
  // In a group chat the contact-share quick-pick also offers the group's
  // own members — the people most likely to be shared. Uids come only
  // from the group doc I already belong to (getMemberIds), so no
  // whole-users read and no re-opening of the all-users leak W28 closed;
  // fetchMemberProfiles excludes blocked users + me. Loaded only when I
  // am a member — a non-member (join screen) never sees the membership.
  // Kept in groupMemberContacts, merged into the ContactShareModal list
  // only — contactsList (forward picker / add-member) is untouched.
  useEffect(() => {
    if (!currentUser || !isCommunity || !otherUser || !isGroupMember(otherUser, currentUser.uid)) {
      setGroupMemberContacts([]);
      return;
    }
    let cancelled = false;
    const memberIds = getMemberIds(otherUser);
    if (memberIds.length === 0) { setGroupMemberContacts([]); return; }
    void fetchMemberProfiles(currentUser.uid, memberIds)
      .then((list) => { if (!cancelled) setGroupMemberContacts(list); })
      .catch(() => { /* offline: keep the previous list */ });
    return () => { cancelled = true; };
  }, [currentUser, isCommunity, otherUser]);

  // W27c (100M-C2): contact-share quick-pick = DM partners/saved contacts
  // + this group's members, deduped by uid (the DM-partner entry wins).
  // W27f (100M-W27d-1): saved MANUAL contacts (name+phone, no uid) never
  // reached the pick — contactsList only carries app users. Merge them
  // in, normalised to the modal's shape (displayName + phone, no uid so
  // the card gets no Message button), deduped by phone — or by name when
  // there is no phone — against the app users. contactsList itself (the
  // forward picker / add-member) is untouched: manual contacts must
  // never leak into pickers that open DMs or add members.
  const contactShareContacts = useMemo(() => {
    const seen = new Set(contactsList.map((c: any) => c.uid || c.id));
    const base = groupMemberContacts.length === 0
      ? contactsList
      : [...contactsList, ...groupMemberContacts.filter((c: any) => !seen.has(c.uid || c.id))];
    if (!currentUser) return base;
    const seenPhones = new Set(
      base.map((c: any) => (c.phone || c.phoneNumber || '').replace(/\D/g, '')).filter(Boolean),
    );
    const seenNames = new Set(
      base.map((c: any) => (c.displayName || c.username || '').trim().toLowerCase()).filter(Boolean),
    );
    const seenManual = new Set<string>();
    const manual = loadSavedContactsCached(currentUser.uid)
      .filter((c) => !c.uid && c.name?.trim())
      .filter((c) => {
        const phoneDigits = (c.phone || '').replace(/\D/g, '');
        if (phoneDigits && seenPhones.has(phoneDigits)) return false;
        if (!phoneDigits && seenNames.has(c.name.trim().toLowerCase())) return false;
        const key = `${c.name.trim().toLowerCase()}|${phoneDigits}`;
        if (seenManual.has(key)) return false;
        seenManual.add(key);
        return true;
      })
      .map((c) => ({
        // `id` is the React key only — pickedUid is taken from `uid`
        // (see ContactShareModal.pickContact), which manual entries do
        // not have, so no bogus Message button can ever be attached.
        id: `manual:${c.name.trim()}:${(c.phone || '').replace(/\D/g, '')}`,
        displayName: c.name.trim(),
        phone: c.phone || '',
        photoURL: '',
      }));
    return manual.length === 0 ? base : [...base, ...manual];
  }, [contactsList, groupMemberContacts, currentUser]);

  // 100M-G1: Group Info's member list + search resolve names through the
  // modal's `allUsers` prop, which used to be `contactsList` alone — the
  // W28-gated list (saved contacts + proven DM partners). A group member
  // who is neither renders as "User" and the member search filters them
  // OUT when their real name is typed. Merge this group's own members
  // (W27c `fetchMemberProfiles` — uids from the group doc I belong to, so
  // no whole-users read) so every member resolves. Safe for the modal's
  // add-member candidates: they exclude `memberIds` anyway, so the merge
  // only adds resolvable profiles for people already in this group.
  // 100M-H27: merge the lazily-loaded all-app-users list into the
  // add-member candidates (members are still excluded downstream by the
  // modal's `addCandidates`, which filters on `memberIds`). Entries that
  // come only from the all-users list — i.e. people with no prior DM or
  // saved contact — carry `noPriorDm` so the modal can label them.
  const groupInfoUsers = useMemo(() => {
    const seen = new Set(contactsList.map((c: any) => c.uid || c.id));
    const extra = groupMemberContacts.filter((c: any) => {
      const uid = c.uid || c.id;
      return uid && !seen.has(uid);
    });
    const base = extra.length === 0 ? contactsList : [...contactsList, ...extra];
    const baseSeen = new Set(base.map((c: any) => c.uid || c.id));
    const fresh = allAppUsers
      .filter((c: any) => {
        const uid = c.uid || c.id;
        return uid && !baseSeen.has(uid);
      })
      .map((c: any) => ({ ...c, noPriorDm: true }));
    return fresh.length === 0 ? base : [...base, ...fresh];
  }, [contactsList, groupMemberContacts, allAppUsers]);

  // ── G1 (nightshift): group message-info "Read by" / "Delivered to" ──
  // Per-member receipts for one message: iterate the per-uid watermark
  // maps (never the first-covering watermark — that names no one) and
  // attach member names/photos from groupInfoUsers. "Delivered to" holds
  // members who received it but have not read it. When read receipts are
  // OFF the sender gets no read times (WhatsApp symmetry), so the Read by
  // list is hidden — Delivered to still shows.
  const groupMsgReceipts = (msg: any): { readBy: Array<MemberReceipt & { name: string; photoURL: string }>; deliveredTo: Array<MemberReceipt & { name: string; photoURL: string }> } => {
    const resolve = (r: MemberReceipt) => {
      const key = String(r.uid || '').toLowerCase();
      const p = groupInfoUsers.find((c: any) => String(c.uid || c.id || '').toLowerCase() === key);
      return { ...r, name: (p?.displayName || p?.username || 'User') as string, photoURL: (p?.photoURL || '') as string };
    };
    const readBy = receiptsEffective ? receiptsByMember(msg, seenUpToByUid, currentUser?.uid).map(resolve) : [];
    const readUids = new Set(readBy.map((r) => String(r.uid).toLowerCase()));
    const deliveredTo = receiptsByMember(msg, deliveredUpToByUid, currentUser?.uid)
      .filter((r) => !readUids.has(String(r.uid).toLowerCase()))
      .map(resolve);
    return { readBy, deliveredTo };
  };

  // ── ROADMAP-2 item 10: load this user's clearedAt stamp for the chat ──
  useEffect(() => {
    if (!conversationId || !currentUser) { setClearedAtState(0); return; }
    let cancelled = false;
    void getClearedAt(currentUser.uid, conversationId).then((ts) => { if (!cancelled) setClearedAtState(ts); });
    return () => { cancelled = true; };
  }, [conversationId, currentUser]);

  // ── W27: live-location hygiene on chat open ──
  // (a) My own live messages whose window already passed but whose flag
  //     is still true (the app was closed at expiry) get flipped
  //     inactive, best-effort — receivers already treat them as ended
  //     via the expiry timestamp; this just keeps the flag honest.
  // (b) A persisted session (watch died with a reload) with no running
  //     watch → offer Resume instead of silently dropping the share.
  // The flip is idempotent: once the snapshot shows inactive, it no-ops.
  useEffect(() => {
    if (!conversationId || !currentUser || !messagesLoaded) return;
    for (const m of messages) {
      if (m?.type === 'live-location' && isMe(m) && m.liveLocationActive &&
          typeof m.liveLocationExpiresAt === 'number' && m.liveLocationExpiresAt <= Date.now()) {
        updateDoc(doc(db, 'chats', conversationId, 'messages', m.id), { liveLocationActive: false }).catch(() => {});
      }
    }
    setLiveResumeNeeded(isSharingLiveLocation(conversationId) && !getActiveSession(conversationId));
  }, [conversationId, currentUser?.uid, messagesLoaded, messages]);

  // ── ROADMAP-2 item 11: freeze the "last read" watermark at chat open ──
  // markChatReadLocally() (read-receipt effect below) stamps "read up to
  // now" as soon as the chat is on screen, so the anchor must be captured
  // here — before the first message snapshot arrives — or the divider
  // would always be empty. It stays frozen for this mount: messages that
  // arrive while the chat is open are read live, not "unread".
  useEffect(() => {
    if (!conversationId || !currentUser) { setUnreadAnchorAt(0); return; }
    setUnreadAnchorAt(getLocalReadAt(currentUser.uid, conversationId));
  }, [conversationId, currentUser]);

  // ── W16 (#183): group E2EE sender-key distribution ──
  // Wrap + post MY sender key for the given members — only for members
  // who have announced their public key in this group, and only when no
  // sender-key doc from me to them with the CURRENT keyId is already in
  // the loaded collection (idempotent: safe to call on every announce).
  // Best-effort: a failed distribution never blocks sending (the message
  // itself is still encrypted; the member heals once distribution lands
  // — their announce is re-processed on the next snapshot).
  const distributeGroupSenderKey = async (memberIds: string[]): Promise<void> => {
    if (!conversationId || !currentUser?.uid) return;
    try {
      const own = await getOrCreateOwnGroupSenderKey(conversationId, currentUser.uid);
      const pair = await getOrCreateIdentityKeyPair();
      const rawB64 = await exportOwnGroupSenderKeyRawFor(conversationId, currentUser.uid);
      for (const memberId of memberIds) {
        if (!memberId || memberId === currentUser.uid) continue;
        const memberKey = await getGroupMemberKey(conversationId, memberId);
        if (!memberKey) continue;
        const already = groupKxDocsRef.current.some(
          (d) => d.kind === 'group-sender-key' && d.senderId === currentUser.uid && d.recipientId === memberId && d.keyId === own.keyId,
        );
        if (already) continue;
        const doc = await buildGroupSenderKeyDoc(
          conversationId, currentUser.uid, memberId,
          memberKey.publicKey, pair.privateKey, rawB64, own.keyId,
        );
        await addDoc(collection(db, 'chats', conversationId, 'messages'), {
          ...doc, timestamp: Date.now(), senderId: currentUser.uid,
        });
      }
    } catch (e) {
      console.warn('[ChatScreen] group sender-key distribution failed:', e);
    }
  };

  // ── Load messages ──
  // Key-exchange protocol docs (`type: 'e2ee-key-exchange'`) travel in
  // this same collection but are NOT chat messages: they are filtered out
  // of the rendered list here, handled (peer key stored, ack sent), and
  // never counted as unread or shown as a bubble. A bad protocol doc is
  // ignored, never crashes the list. W16 (#183): group key-exchange docs
  // (`type: 'e2ee-group-key'`) are protocol docs the same way.
  //
  // Worker D (R2 flood fix), now in the shared runner: the old loop
  // re-processed EVERY protocol doc on EVERY snapshot (3s poll / remount)
  // — the in-memory dedup set reset on remount and was only marked AFTER
  // the slow async handle finished, so concurrent snapshot loops
  // re-processed the same announce and each one emitted another key-ack
  // write (613 docs in one DM, growing per poll). The runner
  // (`processKeyExchangeDocs` in e2eeChat.ts) keeps the same guarantees
  // — each doc CLAIMED synchronously in the in-memory set BEFORE any
  // await, claim persisted to IndexedDB (`pinglo-e2ee` `processedKx`
  // store), a peer keyId acked at most ONCE ever (in-memory claim +
  // durable `ackedKx` record), transient failure releases the claim so
  // the next snapshot retries — and is called from the chat list and the
  // foreground watcher too, so the peer auto-acks without opening this
  // chat (Report 3 #223/#232).
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    // New chat: drop the previous chat's snapshot state so the announce
    // effect's server-truth check never reads stale docs (our keyId is
    // per-device, so an old chat's announce would false-positive here).
    kxDocsRef.current = [];
    groupKxDocsRef.current = [];
    messagesLoadedRef.current = false;
    // Load the durable dedup set once per chat so a remount / reload
    // never re-processes a group key doc handled in an earlier session.
    // (The 1-to-1 loop's dedup now lives in the shared runner; this load
    // serves only the W16 group loop below, whose claims are keyed
    // `${uid}:${conversationId}:${docId}:${keyId}` — the format
    // markProcessedKx stores and loadProcessedKxKeys returns.)
    void (async () => {
      try {
        const processed = await loadProcessedKxKeys(conversationId, currentUser.uid);
        if (cancelled) return;
        for (const k of processed) processedKxRef.current.add(k);
      } catch (e) {
        // D3: a failed key-exchange dedup load is not fatal (the exchange
        // retries on the next snapshot) but it must not vanish silently —
        // a stuck dedup set re-processes every key doc on every snapshot.
        console.warn('[ChatScreen] could not load processed key-exchange keys:', e);
      }
    })();
    const q = query(collection(db, 'chats', conversationId, 'messages'), orderBy('timestamp', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const kxDocs = all.filter(isKeyExchangeDoc);
      kxDocsRef.current = kxDocs;
      // W16 (#183): group key-exchange docs are protocol docs too —
      // filtered out of the rendered list, handled below, never a bubble.
      const groupKxDocs = all.filter(isGroupKeyExchangeDoc);
      groupKxDocsRef.current = groupKxDocs;
      const visibleMsgs = all.filter(d => !isKeyExchangeDoc(d) && !isGroupKeyExchangeDoc(d));
      setMessages(visibleMsgs);
      // Network usage: count newly arrived incoming messages (first
      // snapshot only baselines the watermark — history is not counted).
      noteReceivedMessages(visibleMsgs as Array<Record<string, unknown>>, currentUser?.uid);
      setMessagesLoaded(true);
      messagesLoadedRef.current = true;
      // ── W16 (#183): group E2EE protocol docs ──
      // Same dedup discipline as the 1-to-1 loop above: claim in the
      // in-memory set BEFORE any await, persist the claim on a terminal
      // outcome, release it on transient failure. A 'deferred' sender-key
      // doc (sender hasn't announced yet) is NOT claimed, so the next
      // snapshot retries it once the announce arrives. Runs only for
      // groups; 1-to-1 chats never carry these docs.
      if (isCommunity && groupKxDocs.length > 0 && currentUser?.uid) {
        void (async () => {
          for (const gdoc of groupKxDocs) {
            const docKeyId = (gdoc as any).keyId || '';
            // W16 fix (probed), updated for the owner-scoped dedup
            // (44b650c): the dedup key is `${uid}:${group}:${doc}:${keyId}`
            // — the same format markProcessedKx stores when called as
            // (conversationId, docId, keyId, currentUser.uid), and the
            // same prefix loadProcessedKxKeys(conversationId, uid)
            // returns, so a remount reloads exactly the claims this
            // loop checks. Docs processed under older formats are
            // re-processed once — harmless: handlers are idempotent and
            // distribution is guarded by the server-truth `already`
            // check.
            const dedupKey = `${currentUser.uid}:${conversationId}:${gdoc.id}:${docKeyId}`;
            if ((gdoc as any).senderId === currentUser.uid) {
              if (!processedKxRef.current.has(dedupKey)) {
                processedKxRef.current.add(dedupKey);
                void markProcessedKx(conversationId, gdoc.id, docKeyId, currentUser.uid);
              }
              continue;
            }
            if (processedKxRef.current.has(dedupKey)) continue;
            processedKxRef.current.add(dedupKey);
            try {
              const res = await handleIncomingGroupKeyDoc(gdoc, conversationId, currentUser.uid);
              if (res.status === 'deferred') {
                // Sender's member-announce hasn't arrived yet — release
                // the claim so the next snapshot retries this doc.
                processedKxRef.current.delete(dedupKey);
                continue;
              }
              await markProcessedKx(conversationId, gdoc.id, docKeyId, currentUser.uid);
              if (res.status === 'member-announce') {
                // A member just announced: wrap + post my sender key
                // for them so they can decrypt my messages.
                await distributeGroupSenderKey([res.memberId]);
              } else if (res.status === 'sender-key-stored') {
                setE2eeKeyReady(true);
                // Drop cached decrypt failures so the decrypt effect
                // re-runs with the new key (same heal as the 1-to-1
                // e2eeKeyReady effect below).
                setDecrypted((prev) => {
                  let changed = false;
                  const next = { ...prev };
                  for (const id of Object.keys(next)) {
                    if (next[id]?.status === 'failed') { delete next[id]; changed = true; }
                  }
                  return changed ? next : prev;
                });
              }
            } catch {
              // Transient failure (e.g. IndexedDB blocked): release the
              // claim so the next snapshot retries it.
              processedKxRef.current.delete(dedupKey);
            }
          }
        })();
      }
      if (kxDocs.length === 0 || !currentUser?.uid) return;
      // Shared runner (see above): stores the peer key and acks an
      // announce. Groups/communities never run it (`isCommunity`).
      void processKeyExchangeDocs(
        conversationId,
        kxDocs,
        currentUser.uid,
        async (cid, payload) => {
          await addDoc(collection(db, 'chats', cid, 'messages'), {
            ...payload, timestamp: Date.now(), senderId: currentUser.uid,
          });
        },
        { isGroup: isCommunity },
      ).then(({ established }) => {
        if (!cancelled && established) setE2eeKeyReady(true);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [conversationId, currentUser?.uid, isCommunity]);

  // ── Master E2EE: key exchange for 1-to-1 chats ──
  // Groups/communities use the sender-key exchange in the group effect
  // below (W16 #183), not this one. For a DM, if this device does not
  // hold the peer's public key yet, announce ours over the message
  // channel; the peer's client answers with a key-ack (handled in the
  // snapshot effect above) and both sides derive the same chat key. A DM
  // with yourself uses your own public key directly — no announce needed.
  //
  // Worker D (R2 flood fix), now in `ensureKeyAnnounce` (e2eeChat.ts):
  // the announce is skipped when ANY of these holds: (a) our announce
  // with the current keyId is already in the server collection (server
  // truth, checked after waiting up to 8s for the first snapshot); (b)
  // the durable IndexedDB announce record for this keyId is < 24h old;
  // (c) the legacy localStorage throttle is < 24h old. The durable
  // record is written only AFTER the announce write succeeds, so a
  // failed write is retried on the next mount instead of being silenced
  // for a day. The announce is also triggered from the send path
  // (`sendTextNow`, Report 3 #223 §1.7), so a mount effect that was
  // skipped/cancelled (fast navigation, offline-then-online) cannot
  // strand the chat without an announce.
  useEffect(() => {
    if (!conversationId || !currentUser?.uid || isCommunity) return;
    let cancelled = false;
    void (async () => {
      try {
        if (partnerUid === currentUser.uid) {
          await ensureSelfPeerKey(conversationId, currentUser.uid);
          if (!cancelled) setE2eeKeyReady(true);
          return;
        }
        // Wait for the first snapshot (max 8s) so the server-truth check
        // inside ensureKeyAnnounce can see an announce already in the
        // collection. If the snapshot never loads (offline), the durable
        // / local throttles below still guard the announce.
        const waitStart = Date.now();
        while (!messagesLoadedRef.current && Date.now() - waitStart < 8000) {
          await new Promise(r => setTimeout(r, 250));
          if (cancelled) return;
        }
        const res = await ensureKeyAnnounce(
          conversationId,
          currentUser.uid,
          kxDocsRef.current,
          async (cid, payload) => {
            await addDoc(collection(db, 'chats', cid, 'messages'), {
              ...payload, timestamp: Date.now(), senderId: currentUser.uid,
            });
          },
        );
        if (cancelled) return;
        if (res.status === 'established') setE2eeKeyReady(true);
        else if (res.announcedAt) setE2eeSetupAnnouncedAt(res.announcedAt);
      } catch {
        // Key exchange is best-effort: if it fails, AUDIT-2 A10 fail-closed
        // means messages can't send until the keys are exchanged (a failed
        // send stays in the composer so the user can retry).
      }
    })();
    return () => { cancelled = true; };
  }, [conversationId, currentUser?.uid, partnerUid, isCommunity]);

  // ── W16 (#183): group E2EE — member announce + sender-key distribution ──
  // Each member owns one sender key per group (see keyExchange.ts). On
  // mount this device (a) announces its public key over the group
  // channel (same 24h throttle discipline as the DM announce above —
  // server truth, durable record, localStorage — keyed by the group id,
  // which never collides with DM ids), (b) creates its own sender key,
  // which is what makes group sends encryptable, and (c) distributes
  // that sender key to every member who has already announced. Members
  // who announce LATER are handled live by the snapshot effect above
  // (their announce triggers distribution), so opening the group once is
  // enough to bring the whole current membership up to date.
  // `e2eeKeyReady` for a group means "my sender key exists, so my sends
  // can encrypt" — the lock pill additionally needs an encrypted message
  // (see `chatIsEncrypted`), exactly like a DM.
  useEffect(() => {
    if (!conversationId || !currentUser?.uid || !isCommunity) return;
    let cancelled = false;
    void (async () => {
      try {
        const pair = await getOrCreateIdentityKeyPair();
        if (cancelled) return;
        const ownKeyId = await shortFingerprint(await exportPublicKeyBase64(pair.publicKey));
        if (cancelled) return;
        // Wait for the first snapshot (max 8s) so the server-truth checks
        // below can see docs already in the collection.
        const waitStart = Date.now();
        while (!messagesLoadedRef.current && Date.now() - waitStart < 8000) {
          await new Promise(r => setTimeout(r, 250));
          if (cancelled) return;
        }
        // (a) Server truth: my member-announce with this keyId is already there.
        const haveAnnounce = groupKxDocsRef.current.some(d => d.senderId === currentUser.uid && d.kind === 'group-member-announce' && d.keyId === ownKeyId);
        if (!haveAnnounce) {
          // (b) Durable throttle: announced this keyId < 24h ago.
          // W16 fix (probed): throttle records are keyed by group+user,
          // not group alone — the announce stores (IDB + localStorage)
          // are per-device, so two users sharing one device (account
          // switch) would otherwise suppress each other's announce for
          // 24h: B never announced after A did, so A never distributed
          // a sender key to B. The 1-to-1 effect keeps the plain chatId
          // (DM ids already embed both uids — no collision there).
          const announceThrottleKey = `${conversationId}:${currentUser.uid}`;
          const announced = await getAnnounced(announceThrottleKey);
          if (cancelled) return;
          const fresh = announced && announced.keyId === ownKeyId && Date.now() - announced.at < 24 * 60 * 60 * 1000;
          // (c) Legacy localStorage throttle (kept for back-compat).
          const lastKey = `pinglo-e2ee-announced:${announceThrottleKey}`;
          let last = 0;
          try { last = Number(localStorage.getItem(lastKey) || 0); } catch (e) { console.warn('[ChatScreen] could not read last group key-announce time:', e); }
          if (!fresh && Date.now() - last >= 24 * 60 * 60 * 1000) {
            const announce = await buildGroupMemberAnnounce(conversationId, currentUser.uid, pair.publicKey);
            await addDoc(collection(db, 'chats', conversationId, 'messages'), {
              ...announce, timestamp: Date.now(), senderId: currentUser.uid,
            });
            await markAnnounced(announceThrottleKey, ownKeyId);
            try { localStorage.setItem(lastKey, String(Date.now())); } catch (e) { console.warn('[ChatScreen] could not store last group key-announce time:', e); }
          }
        }
        // My sender key exists from here on — group sends can encrypt.
        await getOrCreateOwnGroupSenderKey(conversationId, currentUser.uid);
        if (cancelled) return;
        setE2eeKeyReady(true);
        // Distribute to every member who has already announced.
        const members = Array.isArray((otherUser as any)?.members) ? (otherUser as any).members as string[] : [];
        await distributeGroupSenderKey(members);
      } catch {
        // Key exchange is best-effort: if it fails, AUDIT-2 A10 fail-closed
        // means messages can't send until the keys are exchanged (a failed
        // send stays in the composer so the user can retry).
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, currentUser?.uid, partnerUid, isCommunity, otherUser]);

  // ── Disappearing messages: read the per-chat timer from the chat doc ──
  // AUDIT-2 C5: the same snapshot carries the read/delivery watermarks
  // (`seenUpTo` / `deliveredUpTo`) — the peer's entries drive my
  // outgoing ticks, my own entries are the stored marker the flush must
  // not regress.
  useEffect(() => {
    if (!conversationId) return;
    const unsub = onSnapshot(doc(db, 'chats', conversationId), (snap) => {
      if (snap.exists()) {
        const d = snap.data() as any;
        const v = d?.disappearAfter;
        setDisappearAfter(typeof v === 'number' && v > 0 ? v : 0);
        setSeenUpToByUid(d?.seenUpTo && typeof d.seenUpTo === 'object' ? d.seenUpTo : {});
        setDeliveredUpToByUid(d?.deliveredUpTo && typeof d.deliveredUpTo === 'object' ? d.deliveredUpTo : {});
      } else {
        setDisappearAfter(0);
        setSeenUpToByUid({});
        setDeliveredUpToByUid({});
      }
    });
    return () => unsub();
  }, [conversationId]);

  // ── Disappearing messages: re-check expiry while the chat stays open ──
  useEffect(() => {
    if (!disappearAfter) return;
    const t = setInterval(() => setDisappearNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [disappearAfter]);

  // ── Disappearing messages: expiry ENFORCEMENT sweeper (§1b) ──
  // The render filter (`visibleMsgs`) only hides expired messages; this
  // effect actually DELETES them (hard deleteDoc on the shared message
  // doc — gone from the in-memory cache, IndexedDB and, when online,
  // the server). No second timer: it rides the existing 60 s
  // `disappearNow` tick (re-runs when the tick fires, when messages
  // arrive, and once on chat open when the timer + messages are known).
  // Throttled to one run per 30 s and capped per run (see
  // expirySweeper.ts) so a huge backlog cannot spam deletes; kept
  // messages and messages with no timestamp are never swept.
  const expirySweepRef = useRef({ running: false, lastRun: 0 });
  useEffect(() => {
    if (!conversationId || !disappearAfter || messages.length === 0) return;
    const s = expirySweepRef.current;
    const now = Date.now();
    if (s.running || now - s.lastRun < 30_000) return;
    s.running = true;
    s.lastRun = now;
    void sweepExpiredMessages(conversationId, messages, disappearAfter, now).finally(() => {
      expirySweepRef.current.running = false;
    });
  }, [conversationId, disappearAfter, disappearNow, messages]);

  // ── Read receipts (AUDIT-2 C5: `seenUpTo` / `deliveredUpTo` watermark) ──
  // Incoming messages become "delivered" when they REACH this device
  // and "seen" while the chat is on screen and the app is visible. Only
  // the receiver writes these. Item 12: when MY read receipts are OFF,
  // never write 'seen' — the seen watermark is simply not written, so
  // the sender never gets a blue tick from me. (Delivered is still
  // written: receipts-off hides reads, not delivery — same as WhatsApp.)
  //
  // Reaction-late fix (L3) debounced + deduped the flush, but it still
  // fired one full-doc `updateDoc` PUT per incoming message — 200 unread
  // messages meant 200 PUTs. Now the effect only COLLECTS the pending
  // watermark: the highest incoming message in this snapshot is both
  // the delivered watermark and (visible + receipts ON) the seen
  // watermark, and ONE updateDoc on the chat doc carries both, at most
  // once per 1.2 s. Per-message seen state is DERIVED from the
  // watermark by effectiveMessageStatus() (services/readReceipts.ts) —
  // ticks, the message-info sheet and the chat list all read it — and
  // older clients that still write per-message `status: 'seen'` keep
  // working, since either signal counts as seen. The 1.2 s debounce is
  // unchanged; receipts-OFF behaviour is unchanged (no seen writes);
  // blocked senders are still never marked (Phase 3 guard above);
  // expired disappearing messages are never marked.
  //
  // Honest limits: the watermark write is a whole-doc PUT
  // (updateDoc read-modify-write — a concurrent peer write can be
  // clobbered, the B13 race; the server-side field-level update is the
  // full fix, BACKEND-PLAN.md §15). Groups use the furthest-reader
  // approximation (one reader's watermark marks the message seen — the
  // same shared-status approximation the old per-message status used).
  // The unread badge does not depend on the watermark: it clears from
  // this device's local "read up to" stamp (below) plus the per-message
  // status, as before.
  useEffect(() => {
    // Phase 3: never mark a blocked sender's messages delivered/seen.
    if (!conversationId || !currentUser || messages.length === 0 || isBlocked) return;
    const me = cleanId(currentUser.uid);
    const visible = !document.hidden;
    // Item 12: the unread badge must clear locally while the chat is
    // open even when receipts are OFF (see services/readReceipts.ts) —
    // stamp "read up to now" whenever the chat is on screen, in BOTH
    // receipts modes. Before C5 the badge cleared via the per-message
    // 'seen' write; the watermark replaces that write, so the local
    // stamp now does the badge's job. Nothing is sent to the server or
    // the peer by this stamp.
    if (visible) markChatReadLocally(currentUser.uid, conversationId);
    const readable = messages.filter((m: any) => {
      if (!m || m.deleted || !m.id || cleanId(m.senderId) === me) return false;
      if (disappearAfter && isMessageExpired(m, disappearAfter)) return false;
      return true;
    });
    if (readable.length === 0) return;
    const pick = pickSeenUpTo(readable, currentUser.uid);
    if (!pick) return;
    // Never regress the stored marker: another device/tab may have
    // written a newer watermark already (the chat-doc snapshot carries
    // it), and a flush must not move it backwards.
    const storedSeen = seenUpToForUser(seenUpToByUid, me) ?? lastSentSeenRef.current;
    const storedDelivered = seenUpToForUser(deliveredUpToByUid, me) ?? lastSentDeliveredRef.current;
    const targetSeen = visible && receiptsEffective ? mergeSeenUpTo(storedSeen, pick) : null;
    const targetDelivered = mergeSeenUpTo(storedDelivered, pick);
    // The stored marker may have advanced since a pending target was
    // queued (the chat-doc snapshot arrived late, or another device
    // wrote it) — drop any pending target it already covers.
    if (pendingSeenRef.current && storedSeen && compareSeenUpTo(storedSeen, pendingSeenRef.current.wm) >= 0) pendingSeenRef.current = null;
    if (pendingDeliveredRef.current && storedDelivered && compareSeenUpTo(storedDelivered, pendingDeliveredRef.current.wm) >= 0) pendingDeliveredRef.current = null;
    if (targetSeen && (!storedSeen || compareSeenUpTo(targetSeen, storedSeen) > 0)) {
      pendingSeenRef.current = { wm: targetSeen, cid: conversationId };
    }
    if (targetDelivered && (!storedDelivered || compareSeenUpTo(targetDelivered, storedDelivered) > 0)) {
      pendingDeliveredRef.current = { wm: targetDelivered, cid: conversationId };
    }
    if ((!pendingSeenRef.current && !pendingDeliveredRef.current) || receiptsTimerRef.current) return;
    receiptsTimerRef.current = setTimeout(() => {
      receiptsTimerRef.current = null;
      // Snapshot the pending watermarks first, then clear so a
      // re-entrant effect run cannot double-queue them. A failed flush
      // puts them back, so the next snapshot retries instead of losing
      // the read.
      const seen = pendingSeenRef.current;
      const delivered = pendingDeliveredRef.current;
      pendingSeenRef.current = null;
      pendingDeliveredRef.current = null;
      if (!seen && !delivered) return;
      const cid = seen?.cid || delivered?.cid || conversationId;
      const meUid = cleanId(currentUser.uid);
      const updates: Record<string, any> = {};
      if (seen) updates[`seenUpTo.${meUid}`] = seen.wm;
      if (delivered) updates[`deliveredUpTo.${meUid}`] = delivered.wm;
      void updateDoc(doc(db, 'chats', cid), updates)
        .then(() => {
          if (seen) lastSentSeenRef.current = seen.wm;
          if (delivered) lastSentDeliveredRef.current = delivered.wm;
        })
        .catch((e: any) => {
          console.warn('[ChatScreen] receipt watermark write failed (will retry on next snapshot):', e);
          if (seen) pendingSeenRef.current = seen;
          if (delivered) pendingDeliveredRef.current = delivered;
        });
    }, 1200);
  }, [messages, conversationId, currentUser, disappearAfter, isBlocked, readReceipts, receiptsEffective, seenUpToByUid, deliveredUpToByUid]);
  // Flush any receipts still pending when the chat unmounts, and never
  // leave a timer firing into an unmounted screen.
  useEffect(() => () => {
    if (receiptsTimerRef.current) { clearTimeout(receiptsTimerRef.current); receiptsTimerRef.current = null; }
    pendingSeenRef.current = null;
    pendingDeliveredRef.current = null;
  }, []);

  // ── Listen for partner typing ──
  useEffect(() => {
    if (!conversationId || !partnerUid || isCommunity) return;
    const unsub = onSnapshot(doc(db, 'chats', conversationId, 'meta', 'typing'), (snap) => {
      if (snap.exists()) {
        const d = snap.data();
        const t = d[partnerUid] === true;
        setIsPartnerTyping(t);
        if (t) setPartnerTypingAt(Date.now());
      }
    });
    const unsubRelay = realtimeSync.onTypingChange(conversationId, (typing) => {
      setIsPartnerTyping(typing);
      if (typing) setPartnerTypingAt(Date.now());
    });
    return () => {
      unsub();
      unsubRelay();
    };
  }, [conversationId, partnerUid, isCommunity]);

  // ── WA parity (DM audit row 5): partner "recording audio" presence ──
  // DMs subscribe to the partner's recording doc; groups use the shared
  // collection path (any member recording shows "recording audio").
  useEffect(() => {
    if (!conversationId) return;
    const unsubRec = realtimeSync.onRecordingChange(
      conversationId,
      (rec) => {
        setIsPartnerRecording(rec);
        if (rec) setPartnerRecordingAt(Date.now());
      },
      isCommunity ? undefined : partnerUid || undefined,
    );
    return () => unsubRec();
  }, [conversationId, partnerUid, isCommunity]);

  // ── WA parity (DM audit rows 6–7): group typing uids ──
  useEffect(() => {
    if (!conversationId || !isCommunity) return;
    const unsub = realtimeSync.onTypingUsersChange(conversationId, (uids) => setGroupTypingUids(uids));
    return () => unsub();
  }, [conversationId, isCommunity]);

  // ── WA parity (DM audit row 7): group online count ──
  // Member profiles are fetched (not live-subscribed) on open and every
  // 30 s while the group is open; presence dots elsewhere stay live.
  const groupMemberIdsKey = isCommunity && otherUser ? (getMemberIds(otherUser) || []).join(',') : '';
  useEffect(() => {
    if (!isCommunity || !conversationId || !currentUser?.uid || !groupMemberIdsKey) {
      setGroupOnlineCount(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const profiles = await fetchMemberProfiles(currentUser.uid, groupMemberIdsKey.split(',').filter(Boolean));
        if (!cancelled) setGroupOnlineCount(profiles.filter((p: any) => isOnline(p)).length);
      } catch { /* offline: keep the previous count */ }
    };
    void load();
    const t = setInterval(() => { void load(); }, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isCommunity, conversationId, currentUser?.uid, groupMemberIdsKey]);

  // ── WA parity (DM audit row 5): broadcast MY recording state ──
  // Driven by isRecording so start/stop/cancel/unmount all clear it;
  // heartbeat every 8 s (receiver TTL is 15 s) so a long note never
  // flickers off.
  useEffect(() => {
    if (!conversationId || !currentUser) return;
    if (!isRecording) return;
    realtimeSync.sendRecording(partnerUid || '', conversationId, true);
    const t = setInterval(() => realtimeSync.sendRecording(partnerUid || '', conversationId, true), 8000);
    return () => {
      clearInterval(t);
      realtimeSync.sendRecording(partnerUid || '', conversationId, false);
    };
  }, [isRecording, conversationId, partnerUid, currentUser?.uid]);

  // ── Listen for pinned message ──
  useEffect(() => {
    if (!conversationId) return;
    const unsub = onSnapshot(doc(db, 'chats', conversationId, 'meta', 'pinned'), (snap) => {
      if (snap.exists()) setPinnedMsg(snap.data());
      else setPinnedMsg(null);
    });
    return () => unsub();
  }, [conversationId]);

  // ── Phase 3: multiple pinned messages (meta/pinnedList {pins:[]}); legacy
  // single meta/pinned doc is still written for backward compat. ──
  useEffect(() => {
    if (!conversationId) return;
    const unsub = onSnapshot(doc(db, 'chats', conversationId, 'meta', 'pinnedList'), (snap) => {
      if (snap.exists()) setPinnedMsgs(((snap.data() as any)?.pins || []) as any[]);
      else setPinnedMsgs([]);
    });
    return () => unsub();
  }, [conversationId]);

  // ── Phase 3: starred ids (for Star/Unstar toggle in the menu) ──
  useEffect(() => {
    if (!currentUser) return;
    return onSnapshot(collection(db, 'users', currentUser.uid, 'starred'), (snap) => {
      setStarredIds(snap.docs.map(d => d.id));
    });
  }, [currentUser]);

  // ── Phase 3: typing TTL — ignore typing entries older than ~10s ──
  useEffect(() => {
    if (!isPartnerTyping) return;
    const t = setInterval(() => {
      if (partnerTypingAt && Date.now() - partnerTypingAt > 10_000) setIsPartnerTyping(false);
    }, 2000);
    return () => clearInterval(t);
  }, [isPartnerTyping, partnerTypingAt]);

  // ── WA parity (DM audit row 5): recording TTL — 15 s, like the service ──
  useEffect(() => {
    if (!isPartnerRecording) return;
    const t = setInterval(() => {
      if (partnerRecordingAt && Date.now() - partnerRecordingAt > 15_000) setIsPartnerRecording(false);
    }, 2000);
    return () => clearInterval(t);
  }, [isPartnerRecording, partnerRecordingAt]);

  // ── Phase 3: drafts — restore per-chat composer text ──
  // Deps include hiddenLoaded: before it flips true this screen returns
  // an early loading UI WITHOUT the composer, so the first run (when
  // conversationId lands) would find composerRef null and the draft
  // would never restore. Re-running on hiddenLoaded covers that mount.
  useEffect(() => {
    if (!conversationId) return;
    try {
      const d = localStorage.getItem(`dt_draft_${conversationId}`);
      if (d) composerRef.current?.setText(d);
    } catch (e) { console.warn('[ChatScreen] could not restore draft:', e); }
  }, [conversationId, hiddenLoaded]);

  // ── Phase 3: offline banner + flush queued messages on reconnect ──
  // AUDIT-2 B2: the flush is the app-wide offlineQueue flush (it drains
  // every chat's queued sends, not only this one's, and runs on any
  // 'online' event even when this chat is closed). The greyed queued list
  // is re-read after it so sent items disappear promptly.
  useEffect(() => {
    const on = () => { setIsOffline(false); void flushOfflineQueue().then(() => readQueuedMsgs()); };
    const off = () => setIsOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, currentUser]);

  // ── Phase 3: Escape closes menus / modals / selection ──
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setCtxMenu(null); setShowMenu(false); setShowReactPicker(null);
      closeCombinedPicker(); setShowAttachMenu(false);
      setMsgInfo(null); setDeleteConfirm(null);
      if (forwardMsg) { setForwardMsg(null); setForwardMsgs(null); setForwardCaption(''); }
      if (showSearchBar) closeSearch();
      if (lightbox.open) setLightbox(prev => ({ ...prev, open: false }));
      if (showMediaGallery) setShowMediaGallery(false);
      if (showPollModal) setShowPollModal(false);
      if (showScheduleModal) setShowScheduleModal(false);
      if (showLocationModal) setShowLocationModal(false);
      if (showContactModal) setShowContactModal(false);
      if (showE2EESheet) setShowE2EESheet(false);
      if (showPinnedList) setShowPinnedList(false);
      // 100M-F4: Escape also closes the video-quality sheet and the
      // photo editor — both used to stay open and pollute later queries.
      if (pendingVideo) { setPendingVideo(null); setVideoCaption(''); }
      if (pendingDoc) { setPendingDoc(null); setDocCaption(''); }
      if (pendingAlbum) { setPendingAlbum(null); setAlbumCaption(''); }
      if (pendingGif) { setPendingGif(null); setGifCaption(''); }
      if (pendingPhoto) { setPendingPhoto(null); URL.revokeObjectURL(pendingPhoto.url); }
      if (selectedIds.length) setSelectedIds([]);
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [forwardMsg, showSearchBar, lightbox.open, showMediaGallery, showPollModal, showScheduleModal, showLocationModal, showContactModal, showE2EESheet, showPinnedList, selectedIds, pendingVideo, pendingDoc, pendingPhoto, pendingAlbum, pendingGif]);

  // ── Phase 3: reset in-chat search position when the query changes ──
  useEffect(() => { setSearchIdx(0); }, [searchQuery]);

  // ── Auto scroll ──
  // #130: the smooth scroll animates through scrollTop < 80 on the way
  // down, which used to re-fire the load-more handler mid-animation.
  // The initial-scroll flag (set on chat change, cleared after 1s)
  // keeps handleMessagesScroll inert while that animation settles.
  useEffect(() => {
    initialScrollRef.current = true;
    reachedBottomRef.current = false;
    const t = setTimeout(() => { initialScrollRef.current = false; }, 1000);
    return () => clearTimeout(t);
  }, [conversationId]);
  // 100M-H8: a pending scroll restore belongs to the conversation it was
  // armed in — navigating to another chat cancels it instead of scrolling
  // the new chat's list (the restore rAF checks the flag at fire time).
  // Placed here, after conversationId is declared (a dep array is
  // evaluated eagerly, so it cannot live with the restore effect above).
  useEffect(() => {
    searchRestorePendingRef.current = false;
  }, [conversationId]);
  useEffect(() => {
    if (Date.now() < jumpHoldRef.current) return; // H24 jump in progress — a post-mount wave must not yank the chat to the bottom
    // Audit H8-1: a scroll restore is pending (search just closed, the
    // double-rAF restore has not fired yet) — a message arriving in this
    // window must not smooth-scroll the list to the bottom and undo the
    // restore. Skip the auto-scroll until the restore fires or is
    // cancelled (re-open / navigation clears the flag).
    if (searchRestorePendingRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    // W13 NEXT R8 (B3): the smooth scroll re-fires on every [messages]
    // wave; if waves keep coming the animation may never settle at the
    // bottom, so the scroll handler never sees distFromBottom <= 120 and
    // reachedBottomRef stays false — the first deliberate scroll-up then
    // misses load-more. Re-arm explicitly once the container is actually
    // at the bottom. This only asserts a fact (it IS at the bottom), so
    // W24's divider protection still holds: load-more still needs either
    // a real user gesture or the post-animation gates.
    const t = setTimeout(() => {
      const el = messagesScrollRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight <= 120) {
        reachedBottomRef.current = true;
      }
    }, 800);
    return () => clearTimeout(t);
    // Deps include hiddenLoaded (same pattern as the effect at ~1626):
    // before it flips true this screen returns the spinner tree, so the
    // anchor div does not exist and bottomRef is null — the effect runs
    // but the scroll never fires. Messages usually arrive BEFORE the
    // flip, so [messages] alone never re-runs the effect after the main
    // tree mounts and the chat opens stuck at the top (scrollTop 0):
    // the first scroll-up then produces no scroll event at all, so
    // load-more never fires. Re-running on the flip scrolls to the
    // bottom on first paint of the real tree.
  }, [messages, hiddenLoaded]);

  // ── Typing cleanup on unmount ──
  useEffect(() => {
    return () => {
      setMyTyping(false);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [conversationId]);

  // ── 4d: scheduled messages are sent by the global scheduler (App.tsx) ──
  // This screen only lists this chat's pending items so they can be
  // cancelled. The old per-chat setInterval is deleted: it only fired
  // while this chat was open and only read the localStorage queue.
  useEffect(() => {
    if (!conversationId) return;
    return scheduledMessages.subscribe((all) => {
      setPendingScheduled(
        all.filter((s) => s.conversationId === conversationId && s.status !== 'sent' && s.status !== 'cancelled'),
      );
    });
  }, [conversationId]);

  // ── Typing indicator ──
  // #142: ONE write per beat — the realtimeSync typing doc only. The old
  // code ALSO wrote `chats/{cid}/meta/typing` (updateDoc + setDoc fallback)
  // on every beat, i.e. 2 writes per beat. The partner reads BOTH sources
  // (meta/typing snapshot + realtimeSync.onTypingChange, see the listener
  // below), so dropping the meta write loses nothing.
  const setMyTyping = (typing: boolean) => {
    if (!conversationId || !currentUser) return;
    // WA parity (DM audit row 6): groups type too — the typing doc key
    // is per-conversation + per-user, so the same call serves DMs and
    // groups; the receiver resolves group names via onTypingUsersChange.
    realtimeSync.sendTyping(partnerUid || '', conversationId, typing);
  };


  // ── Phase 3 helpers ──
  const blockedGuard = () => {
    if (isBlocked) { showToastMsg('You blocked this contact. Unblock to send messages.'); return true; }
    return false;
  };
  const saveDraft = (t: string) => {
    if (!conversationId) return;
    try { if (t) localStorage.setItem(`dt_draft_${conversationId}`, t); else localStorage.removeItem(`dt_draft_${conversationId}`); } catch (e) { console.warn('[ChatScreen] could not save draft:', e); }
  };
  const clearDraft = () => { if (conversationId) { try { localStorage.removeItem(`dt_draft_${conversationId}`); } catch (e) { console.warn('[ChatScreen] could not clear draft:', e); } } };
  // ── Offline queue: single source is services/offlineQueue.ts (AUDIT-2 B2/B9/B11/B12) ──
  // ChatScreen used to keep its OWN per-chat localStorage queue
  // (`dt_offline_queue_<uid>_<cid>`) beside the DB outbox, so one message
  // could send 2–3× and a queue stranded when its chat closed before
  // reconnect. That queue is deleted: queueing, flushing and retry all
  // live in offlineQueue.ts; this screen only READS it (greyed queued
  // list below the history) and enqueues into it. Flush happens app-wide
  // on any 'online' event / 30 s tick / foreground / sign-in, not only
  // while this chat is open. Queued sends keep their ORIGINAL `at` as
  // the message timestamp (B11) and flush under a stable doc id, so a
  // retried flush can never duplicate the message (B9).
  const [queuedMsgs, setQueuedMsgs] = useState<any[]>([]);
  const readQueuedMsgs = () => {
    if (!conversationId || !currentUser) { setQueuedMsgs([]); return; }
    try {
      const col = `chats/${conversationId}/messages`;
      const ops = getOfflineQueue().filter((o) => o.col === col && (o.kind === 'message' || (o.kind === 'put' && (o.label === 'message' || o.label === 'edit'))));
      setQueuedMsgs(ops.map((o) => ({
        opId: o.id,
        text: o.data?.text ?? '',
        at: o.data?.at ?? o.createdAt,
        silent: !!o.data?.silent,
        replyTo: o.data?.replyTo ?? null,
        // A queued edit is shown as such — it is not a new message (B10).
        isEdit: o.kind === 'put' && o.label === 'edit',
      })).filter((q) => q.text));
    } catch { setQueuedMsgs([]); }
  };
  useEffect(() => { readQueuedMsgs(); }, [conversationId, currentUser?.uid]);
  // One-time migration of the pre-AUDIT-2 per-chat queue (B2): items queued
  // by older builds under `dt_offline_queue_<uid>_<cid>` move into the
  // single outbox with their ORIGINAL `at` preserved, then the old key is
  // removed so they can never send twice.
  useEffect(() => {
    if (!conversationId || !currentUser) return;
    const key = `dt_offline_queue_${currentUser.uid}_${conversationId}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const old = JSON.parse(raw);
      if (Array.isArray(old) && old.length > 0) {
        for (const item of old) {
          if (!item || typeof item.text !== 'string' || !item.text) continue;
          enqueueOfflineOp({
            kind: 'message',
            col: `chats/${conversationId}/messages`,
            docId: newOfflineMessageId(),
            data: {
              conversationId, text: item.text, at: item.at || Date.now(),
              silent: !!item.silent, replyTo: item.replyTo || null,
              senderId: currentUser.uid, senderName: currentUser.displayName || 'User',
              senderAvatar: currentUser.photoURL || '',
            },
          });
        }
      }
    } catch {
      // Old queue unreadable — drop it rather than risk a double-send.
    } finally {
      try { localStorage.removeItem(key); } catch (e) { console.warn('[ChatScreen] could not remove migrated offline queue key:', e); }
    }
    readQueuedMsgs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, currentUser?.uid]);
  // Keep the greyed list live as the global outbox drains/fills — including
  // flushes that happen while this chat is open but not from this screen.
  useEffect(() => subscribeOfflineQueue(() => { readQueuedMsgs(); }), [conversationId, currentUser?.uid]);
  const queueOfflineMessage = (text: string) => {
    if (!conversationId || !currentUser) return;
    // D5: the length limit applies offline too — an over-long message is
    // refused now, not queued and then dropped at flush time.
    if (text.length > MAX_MESSAGE_CHARS) {
      showToastMsg(`Message too long (max ${MAX_MESSAGE_CHARS.toLocaleString()} characters)`);
      return;
    }
    enqueueOfflineOp({
      kind: 'message',
      col: `chats/${conversationId}/messages`,
      docId: newOfflineMessageId(),
      data: {
        conversationId, text, at: Date.now(), silent: silentSend,
        replyTo: replyToPayload(), senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User', senderAvatar: currentUser.photoURL || '',
      },
    });
    readQueuedMsgs();
    showToastMsg('Offline — message queued, will send when reconnected');
  };
  // 100M-M1: WhatsApp allows edits only within ~15 min of sending — an
  // edit offered days later is a stale affordance, not a feature. The
  // window is measured from the original send time (timestamp), so a
  // message edited at 14 min cannot be edited again at 16 min.
  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  const isWithinEditWindow = (m: any): boolean => {
    if (!m || !m.timestamp) return false;
    const t = toDateSafe(m.timestamp).getTime();
    return Number.isFinite(t) && Date.now() - t <= EDIT_WINDOW_MS;
  };
  const isEditableMsg = (m: any): boolean => {
    if (!m || !isMe(m) || m.deleted || m.mediaUrl || ['sticker', 'poll', 'location', 'live-location', 'contact', 'gif'].includes(m.type || '')) return false;
    // WA72 DM row 50: E2EE docs store text: '' (ciphertext lives in the
    // `e2ee` envelope) — the readable text is the decrypted text, not
    // m.text. Gating on m.text hid Edit for every own message in an
    // encrypted DM. displayTextFor is defined below but only called at
    // render time, after all consts are initialised. Decrypt-failed /
    // still-decrypting messages are not editable (nothing readable to edit).
    const d = displayTextFor(m);
    return (d.state === 'plain' || d.state === 'e2ee') && d.text.trim().length > 0 && isWithinEditWindow(m);
  };
  const toggleSelect = (id: string) => setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const enterSelectMode = (m: any) => { setSelectedIds([m.id]); setCtxMenu(null); };

  // ── Send message ──
  // L5: the actual text write, shared by handleSend and the flood-guard
  // queue. `addDoc` already echoes optimistically through putRaw's local
  // cache, so the bubble appears immediately; this helper only awaits
  // the server write so a failure can be handled honestly. Result:
  // - 'sent': the server write landed.
  // - 'encryption-failed': fail-closed E2EE (A10) — nothing was sent or
  //   queued; the caller puts the text back in the composer for retry.
  // - 'queued': the write failed AND putRaw queued it in the offline
  //   outbox before throwing (B2/B9) — it WILL send on reconnect, so the
  //   caller must NOT put the text back in the composer (that is how a
  //   retry created a duplicate message).
  // - 'failed': could not send and nothing was queued (no chat/user, or
  //   over the length limit) — caller restores the text.
  const sendTextNow = async (txt: string, replyPayload: any, silent: boolean): Promise<'sent' | 'encryption-failed' | 'queued' | 'failed'> => {
    if (!conversationId || !currentUser) return 'failed';
    // D5 (defence in depth — handleSend checks first): never queue or
    // send an over-long message from any path that reaches this helper.
    if (txt.length > MAX_MESSAGE_CHARS) {
      console.warn(`[ChatScreen] refusing to send ${txt.length}-char message (max ${MAX_MESSAGE_CHARS})`);
      return 'failed';
    }
    // Report 3 #223 §1.7 (W5b): tapping Send itself triggers key setup
    // when the mount announce was skipped/cancelled (fast navigation,
    // offline-then-online) — a send attempt must never be the thing that
    // silently never announces. Self-chats and groups never announce.
    // Never throws: a failed announce leaves the send to fail closed
    // with the encryption error, exactly as before.
    if (!isCommunity && chatId !== currentUser.uid && !e2eeKeyReady) {
      const res = await ensureKeyAnnounce(conversationId, currentUser.uid, kxDocsRef.current, async (cid, payload) => {
        await addDoc(collection(db, 'chats', cid, 'messages'), {
          ...payload, timestamp: Date.now(), senderId: currentUser.uid,
        });
      });
      if (res.status === 'established') setE2eeKeyReady(true);
      else if (res.announcedAt) setE2eeSetupAnnouncedAt(res.announcedAt);
    }
    const msgData: any = {
      text: txt,
      senderId: currentUser.uid,
      senderName: currentUser.displayName || 'User',
      senderAvatar: currentUser.photoURL || '',
      timestamp: serverTimestamp(),
      status: 'sent',
      // Phase 3: silent send — the push watcher (pushNotifications.ts, not
      // owned here) must skip notify() when this flag is true.
      silent,
    };
    if (replyPayload) msgData.replyTo = replyPayload;
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), msgData);
      // WA parity (audit e #53): the outgoing message sound — gated on
      // the "Play sounds for outgoing messages" toggle inside
      // playOutgoingMessageTone (no-op when off / quiet hours). The
      // message itself already sent, so a failed tone never fails the send.
      playOutgoingMessageTone();
      // Network usage: the text left this device — count its exact bytes.
      recordSent('text', utf8ByteLength(txt));
      clearDraft();
      if (!isCommunity && partnerUid) {
        try {
          realtimeSync.sendMessage(partnerUid, {
            conversationId,
            senderId: currentUser.uid,
            senderName: currentUser.displayName || 'User',
            senderAvatar: currentUser.photoURL || '',
            text: txt,
            timestamp: Date.now(),
            silent,
          } as any);
        } catch (e) {
          // Best-effort relay only — the message itself already sent.
          console.warn('[ChatScreen] realtime relay failed after send:', e);
        }
      }
      return 'sent';
    } catch (e) {
      // AUDIT-2 A10: remember WHY the send failed (encryption vs network)
      // so the toast below can be honest. The text returns to the composer
      // only for encryption failures; a network failure is already queued
      // in the offline outbox by putRaw and must not be re-sent by hand.
      lastSendErrorRef.current = e;
      if (isEncryptionFailedError(e)) return 'encryption-failed';
      return 'queued';
    }
  };

  // L5: drain the flood-guard queue in order, one send at a time, waiting
  // out the 6-in-2s window instead of dropping. Single-flight via the
  // ref so concurrent handleSend calls never start a second drain loop.
  const processSendQueue = async () => {
    if (sendQueueBusyRef.current) return;
    sendQueueBusyRef.current = true;
    try {
      while (sendQueueRef.current.length > 0) {
        const now = Date.now();
        sendTimestampsRef.current = sendTimestampsRef.current.filter(t => now - t < 2000);
        if (sendTimestampsRef.current.length >= 6) {
          const waitMs = 2000 - (now - sendTimestampsRef.current[0]) + 50;
          await new Promise(r => setTimeout(r, Math.max(waitMs, 0)));
          continue;
        }
        const item = sendQueueRef.current.shift()!;
        sendTimestampsRef.current.push(Date.now());
        const res = await sendTextNow(item.txt, item.replyTo, item.silent);
        if (res === 'sent') {
          setReplyTo(null);
        } else if (res === 'encryption-failed') {
          // Encryption failed — nothing was queued, so the text goes back
          // in the composer for retry once the keys are exchanged.
          // Report 3 #26 (W5b): `setTextIfEmpty` does NOT schedule a
          // draft save (ChatComposer only drafts on typed input), so the
          // restored text is also written through the draft path
          // explicitly — killing/reopening the app must not lose a
          // message that was never sent.
          composerRef.current?.setTextIfEmpty(item.txt);
          saveDraft(item.txt);
          showToastMsg('Encryption failed — message not sent. Try again once the keys are exchanged.');
        } else if (res === 'queued') {
          // Already in the offline outbox — never silently lose it and
          // never put it back in the composer (that created duplicates).
          readQueuedMsgs();
          showToastMsg('Offline — message queued, will send when reconnected');
        } else {
          // Not queued and not sent (e.g. over the length limit): back in
          // the composer so the user can fix and retry it.
          composerRef.current?.setTextIfEmpty(item.txt);
          saveDraft(item.txt);
          showToastMsg('Message not sent. Check your connection and try again.');
        }
      }
    } finally {
      sendQueueBusyRef.current = false;
    }
  };

  // AUDIT-2 B10: edit a message. The edit path runs BEFORE the offline
  // and flood-guard branches in handleSend, so an edit can never fall
  // through to "send a new message". Online it is the same updateDoc as
  // before. Offline the edit is merged onto the STORED doc (via
  // mergeDocFields — the same merge updateDoc does, so the queued op
  // re-encrypts correctly at flush) and queued as a 'put' op labelled
  // 'edit': never a new message, and visible in the greyed queued list.
  // The cached doc is deliberately NOT updated optimistically here: the
  // merged doc carries plaintext text beside the old ciphertext envelope,
  // and putRaw would then see "no encryptable change" at flush and store
  // it as plaintext. The message keeps showing its old text until the
  // flush lands — honest, and the queued-edit toast + list say so.
  const doEdit = async (txt: string): Promise<void> => {
    const msg = editingMsg;
    if (!msg || !conversationId || !currentUser) return;
    // 100M-M1 (defence in depth): the menu hides Edit for old messages,
    // but a stale edit must also fail closed if it reaches here directly.
    if (!isWithinEditWindow(msg)) {
      showToastMsg('Messages can only be edited within 15 minutes of sending.');
      setEditingMsg(null);
      setReplyTo(null);
      clearDraft();
      composerRef.current?.clear();
      if (inputRef.current) inputRef.current.style.height = 'auto';
      return;
    }
    const restoreOnEditFailure = () => {
      composerRef.current?.setTextIfEmpty(txt);
      // Report 3 #26 (W5b): same draft-persistence rule as the send
      // restore above — a programmatic restore does not draft itself.
      saveDraft(txt);
      showToastMsg(
        isEncryptionFailedError(lastSendErrorRef.current)
          ? 'Encryption failed — edit not sent. Try again once the keys are exchanged.'
          : 'Edit not sent. Check your connection and try again.',
      );
    };
    const updates = {
      text: txt, edited: true, editedAt: Date.now(),
      editHistory: arrayUnion({ text: msg.text || '', at: msg.editedAt || Date.now(), editedAt: Date.now() }),
    };
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const col = `chats/${conversationId}/messages`;
      const stored = db.readCached(col, msg.id);
      if (stored === null) {
        showToastMsg('This message was deleted');
        setEditingMsg(null);
        setReplyTo(null);
        clearDraft();
        composerRef.current?.clear();
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
      if (stored === undefined) {
        // Collection not loaded yet — cannot merge safely offline. Keep
        // the edit in the composer so the user can retry when online.
        showToastMsg('Edit unavailable offline — message not loaded yet');
        return;
      }
      const merged = mergeDocFields(stored, updates);
      enqueueOfflineOp({ kind: 'put', col, docId: msg.id, data: merged, label: 'edit' });
      setEditingMsg(null);
      setReplyTo(null);
      clearDraft();
      composerRef.current?.clear();
      if (inputRef.current) inputRef.current.style.height = 'auto';
      readQueuedMsgs();
      showToastMsg('Offline — edit queued, will send when reconnected');
      return;
    }
    try {
      // Phase 3: editedAt + edit history (previous text + timestamp).
      await updateDoc(doc(db, 'chats', conversationId, 'messages', msg.id), updates);
      setEditingMsg(null);
      setReplyTo(null);
      clearDraft();
    } catch (e) {
      lastSendErrorRef.current = e;
      restoreOnEditFailure();
    }
  };

  const handleSend = async () => {
    // AUDIT-2 A10: a stale send error must never label a new failure.
    lastSendErrorRef.current = null;
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    // Theme fix: "Replace text with emoji" turns :) ;) :D <3 into emojis.
    const txt = getReplaceEmoji()
      ? applyTextEmojiReplacements((composerRef.current?.getText() ?? '').trim())
      : (composerRef.current?.getText() ?? '').trim();
    if (!txt || !conversationId || !currentUser) return;
    // D5: the length limit is checked FIRST — before the offline, edit
    // and flood branches — so no path can skip it.
    if (txt.length > MAX_MESSAGE_CHARS) {
      showToastMsg(`Message too long (max ${MAX_MESSAGE_CHARS.toLocaleString()} characters)`);
      return;
    }

    // B10: an edit is an edit on EVERY path (offline, flooding, online) —
    // it must never become a new message.
    if (editingMsg) {
      composerRef.current?.clear();
      if (inputRef.current) inputRef.current.style.height = 'auto';
      setMyTyping(false);
      await doEdit(txt);
      return;
    }

    // Phase 3: offline — queue locally instead of failing.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      queueOfflineMessage(txt);
      composerRef.current?.clear(); clearDraft(); setReplyTo(null); setEditingMsg(null);
      if (inputRef.current) inputRef.current.style.height = 'auto';
      return;
    }

    // Anti-flooding / rate-limiting guard (max 6 msgs per 2 seconds).
    // L5: rapid sends used to be DROPPED with a "Slow down" toast — a
    // fast typist lost messages. Now the text is queued (composer is
    // cleared, nothing is lost) and processSendQueue sends it in order
    // as soon as the window allows.
    const now = Date.now();
    sendTimestampsRef.current = sendTimestampsRef.current.filter(t => now - t < 2000);
    if (sendTimestampsRef.current.length >= 6) {
      const stagedReply = replyToPayload();
      const stagedSilent = silentSend;
      sendQueueRef.current.push({ txt, replyTo: stagedReply, silent: stagedSilent });
      composerRef.current?.clear(); clearDraft(); setReplyTo(null); setEditingMsg(null);
      if (inputRef.current) inputRef.current.style.height = 'auto';
      setMyTyping(false);
      showToastMsg('Queued — sending in a moment ⏳');
      void processSendQueue();
      return;
    }
    sendTimestampsRef.current.push(now);

    composerRef.current?.clear();
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setMyTyping(false);

    // On failure the text goes back into the input so it is never silently lost.
    const restoreOnFailure = () => {
      composerRef.current?.setTextIfEmpty(txt);
      // Report 3 #26 (W5b): same draft-persistence rule as the queue
      // restore above — a programmatic restore does not draft itself.
      saveDraft(txt);
      showToastMsg(
        isEncryptionFailedError(lastSendErrorRef.current)
          ? 'Encryption failed — message not sent. Try again once the keys are exchanged.'
          : 'Message not sent. Check your connection and try again.',
      );
    };

    const res = await sendTextNow(txt, replyToPayload(), silentSend);
    if (res === 'sent') setReplyTo(null);
    else if (res === 'encryption-failed') restoreOnFailure();
    else if (res === 'queued') showToastMsg('Offline — message queued, will send when reconnected');
    else restoreOnFailure();
  };

  // ── File upload ──
  // Worker B (overnight round 2, C17): validate the size BEFORE any
  // message is created or any upload is attempted, and return the exact
  // reason. This reuses storage.ts's own validateChatMediaFile (the same
  // check uploadChatMedia runs — 15MB images, 200MB video/audio/files,
  // blocked types), so the reason can never drift from the uploader's.
  // The old flow created the optimistic placeholder first and only
  // surfaced the reason from the upload catch; in mock / no-S3 mode the
  // local-fallback check threw first, so a 201MB file produced a phantom
  // "📄 big201.bin" bubble plus a generic "Upload failed" toast and the
  // user never learned the 200MB limit.
  const validateFileForUpload = (file: File): string | null => {
    const type: MediaType = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : file.type.startsWith('audio/')
          ? 'audio'
          : 'file';
    try {
      validateChatMediaFile(file, type);
      return null;
    } catch (e: any) {
      return typeof e?.message === 'string' ? e.message : 'Upload failed. Please try again.';
    }
  };

  // ROADMAP-2 item 6: multi-select — the file input carries `multiple`,
  // so Photo / Video / File / Album picks can return several files.
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!e.target.files?.length || !conversationId || !currentUser) return;
    const files: File[] = Array.from(e.target.files);
    e.target.value = '';
    // A single video keeps the HD / Data-saver quality sheet (Cluster C).
    if (files.length === 1 && files[0].type.startsWith('video/')) {
      const tooBig = validateFileForUpload(files[0]);
      // 100M-F3: same 6s readability as the album path (#210) — the
      // default 2.5s toast was gone before it could be read.
      if (tooBig) { showToastMsg(tooBig, 6000); return; }
      setPendingVideo(files[0]);
      return;
    }
    // ROADMAP-2 item 7: a single still photo opens the editor instead of
    // sending raw. Animated GIFs skip it (the editor exports a static
    // JPEG, which would kill the animation) and multi-picks go straight
    // to the album path — one editor per photo would block the batch.
    if (files.length === 1 && files[0].type.startsWith('image/') && files[0].type !== 'image/gif') {
      const tooBig = validateFileForUpload(files[0]);
      // 100M-F3: 6s, like the album path — see the video branch above.
      if (tooBig) { showToastMsg(tooBig, 6000); return; }
      setPendingPhoto({ file: files[0], url: URL.createObjectURL(files[0]) });
      return;
    }
    // Nightshift doc caption (§6a): a single document/audio (anything
    // that is not a photo or video) opens the caption sheet instead of
    // sending caption-less — same pattern as the single-video sheet.
    // Multi-picks still go straight to the album path below. Animated
    // GIFs fall through to the album path as before (no sheet for them).
    if (files.length === 1 && !files[0].type.startsWith('image/') && !files[0].type.startsWith('video/')) {
      const tooBig = validateFileForUpload(files[0]);
      if (tooBig) { showToastMsg(tooBig, 6000); return; }
      setPendingDoc(files[0]);
      return;
    }
    // Multi-pick: the album caption sheet (WA parity, verify dm-4 row
    // 67 / media-5 A17) — one caption for the whole album, sent on the
    // first member. Videos inside a multi-pick still skip the video
    // quality sheet (that sheet is a single-video flow); each file is
    // validated first, so one oversize file never blocks the rest of
    // the batch. A lone file here is a GIF, which keeps sending
    // immediately. The caption is reset so a stale one never leaks
    // into the next album.
    if (files.length > 1) {
      setPendingAlbum(files);
      setAlbumCaption('');
      return;
    }
    await sendAlbum(files);
  };

  // ── WA parity (verify dm-4 row 67 / media-5 A17): send the pending
  // album with the sheet's shared caption through sendAlbum — the
  // caption travels on the first file's doc and the pipeline encrypts
  // it to e2eeCaption, like photo/video captions.
  const sendPendingAlbum = async () => {
    const files = pendingAlbum;
    if (!files) return;
    const caption = albumCaption.trim() || undefined;
    setPendingAlbum(null);
    setAlbumCaption('');
    await sendAlbum(files, caption);
  };

  // ── Nightshift doc caption (§6a): send the pending document with the
  // sheet's caption through sendFile — the caption travels on the doc
  // and the pipeline encrypts it to e2eeCaption, like photo/video.
  const sendPendingDoc = async () => {
    const file = pendingDoc;
    if (!file) return;
    const caption = docCaption.trim() || undefined;
    setPendingDoc(null);
    setDocCaption('');
    await sendFile(file, undefined, caption);
  };

  // ── WA parity A9: send the pending GIF with the sheet's caption.
  const sendPendingGif = async () => {
    const gif = pendingGif;
    if (!gif) return;
    const caption = gifCaption.trim() || undefined;
    setPendingGif(null);
    setGifCaption('');
    await sendGif(gif, caption);
  };

  // ── ROADMAP-2 item 6: albums — multi-media send ──
  // Files picked together share one albumId, so they render as a single
  // grouped album bubble. They upload SEQUENTIALLY (one stream at a time
  // — kinder to mobile data and to the per-file progress UI); a failed
  // file is marked failed in the queue and the rest still send.
  const sendAlbum = async (files: File[], caption?: string) => {
    if (!conversationId || !currentUser) return;
    const valid: File[] = [];
    for (const f of files) {
      const err = validateFileForUpload(f);
      // #210: validation toasts stay readable (6s), not 2.5s.
      if (err) showToastMsg(`${f.name}: ${err}`, 6000);
      else valid.push(f);
    }
    if (valid.length === 0) return;
    // #214: a single document/audio must NOT be tagged as a 1-item
    // "album" — albumId is only minted when 2+ files are sent together.
    // (Single files used to carry an albumId, so any future "show album"
    // logic would have treated lone files as albums.) The queue entry
    // still travels so the upload strip keeps working for singles.
    const albumId: string | undefined = valid.length > 1
      ? `album_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
      : undefined;
    const entries = valid.map((f) => ({ id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, name: f.name, progress: 0, status: 'uploading' as const }));
    setUploadQueue((prev) => [...prev, ...entries]);
    for (let i = 0; i < valid.length; i++) {
      // WA parity (verify dm-4 row 67 / media-5 A17): the album caption
      // travels on the first member only — the album branch renders it
      // under the grid, and the lightbox shows it per item. Every tile
      // carrying it would repeat the caption under each photo.
      await sendFile(valid[i], { albumId, queueId: entries[i].id }, i === 0 ? caption : undefined);
    }
    // Clear finished entries a few seconds after the batch completes so
    // the user sees the ✓ / ✗ outcome before the strip disappears.
    if (uploadQueueTimerRef.current) clearTimeout(uploadQueueTimerRef.current);
    uploadQueueTimerRef.current = setTimeout(() => setUploadQueue([]), 4000);
  };

  /** Cluster C (Item 13a/b): the actual upload+send, shared by the file
   * picker, the quality sheet and the in-app camera modal.
   *
   * L5: the message doc is created FIRST as an optimistic placeholder
   * (local blob URL + `uploading: true`), so the bubble appears instantly
   * instead of only after compression + S3 upload + poster finish. The
   * upload then runs in the background and the doc is patched with the
   * final S3 URL / poster. The patch touches only non-encryptable fields
   * (`mediaUrl`, `posterUrl`, `uploading`), so `encryptableContentChanged`
   * stays false and the stored ciphertext is never re-encrypted.
   * Honest limit: until the patch lands, the peer's copy of the doc
   * carries the sender-local blob URL (meaningless off-device) — it is
   * replaced by the real URL seconds later, and a failed upload leaves
   * `uploadFailed: true` on the placeholder instead of a silent loss. */
  const sendFile = async (file: File, album?: { albumId: string | undefined; queueId: string }, caption?: string, opts?: { isHD?: boolean }) => {
    if (!conversationId || !currentUser) return;
    // C17: size check FIRST — before the optimistic placeholder is
    // created. This is the choke point for the file picker, the video
    // quality sheet and the in-app camera, so an oversize file never
    // leaves a phantom bubble behind. The exact reason is toasted.
    const tooBig = validateFileForUpload(file);
    if (tooBig) { showToastMsg(tooBig, 6000); return; }
    setUploading(true);
    const isVideo = file.type.startsWith('video/');
    const isAudio = file.type.startsWith('audio/');
    const isImage = file.type.startsWith('image/');
    // Anything that is not a photo, video or audio is sent as a document card
    const type: MediaType = isVideo ? 'video' : isAudio ? 'audio' : isImage ? 'image' : 'file';
    const textLabel = isViewOnce
      ? 'View Once'
      : isVideo ? 'Video' : isAudio ? 'Audio' : isImage ? 'Photo' : file.name;
    // Optimistic placeholder first: local URI so the sender sees the
    // photo/video immediately; `uploading` renders an "Uploading…" chip.
    const localUrl = URL.createObjectURL(file);
    let placeholderId: string;
    try {
      const ref = await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        text: textLabel,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        mediaUrl: localUrl, mediaType: type, isViewOnce,
        // WA parity (DM audit rows 65–66): HD originals carry the flag
        // so the bubble can show the HD badge (video HD sheet + photo
        // editor HD toggle both set it).
        ...(opts?.isHD ? { isHD: true } : {}),
        // 100M-F2: the caption travels on the doc; the write pipeline
        // encrypts it to `e2eeCaption` (envelope.ts) and the read hook
        // restores `caption` in memory — no E2EE code changes needed.
        ...(caption ? { caption } : {}),
        uploading: true, uploadProgress: 0,
        // ROADMAP-2 item 6: files sent together share an albumId and
        // render as one grouped album bubble. #214: only when 2+ files
        // were sent together — a lone file carries no albumId.
        ...(album?.albumId ? { albumId: album.albumId } : {}),
        // Stored for every media type (was documents-only) so Storage Usage
        // can account for photos/videos/voice notes too.
        fileName: file.name, fileSize: file.size, fileType: file.type || '',
        replyTo: replyToPayload(),
      });
      placeholderId = ref.id;
    } catch (e) {
      URL.revokeObjectURL(localUrl);
      // #206: the placeholder write is where the fail-closed E2EE gate
      // bites — say why instead of a generic "Upload failed".
      showToastMsg(
        isEncryptionFailedError(e)
          ? 'Setting up end-to-end encryption… Keys aren’t exchanged yet, so this file can’t send. Try again once the keys are exchanged.'
          : 'Upload failed. Please try again.',
        6000,
      );
      setUploading(false);
      return;
    }
    try {
      setUploadProgress(0);
      const onProg = ({ transferredBytes, totalBytes }: { transferredBytes: number; totalBytes: number }) => {
        if (!totalBytes) return;
        const pct = Math.round((transferredBytes / totalBytes) * 100);
        setUploadProgress(pct);
        if (!album) return;
        // Per-file queue progress.
        setUploadQueue((prev) => prev.map((q) => q.id === album.queueId ? { ...q, progress: pct } : q));
        // #212: the tile % used to jump in 10-point steps because it only
        // ever read the doc's `uploadProgress` (patched below, throttled
        // to spare AppSync mutations). Patch the LOCAL message state every
        // percent so the tile counts smoothly; the doc still only gets a
        // write every 10 points (or at 100%). The local patch is never
        // overwritten by a stale snapshot — snapshots only fire on doc
        // change, which coincides with the throttled patch at the same %.
        setMessages((prev) => prev.map((m) => (m.id === placeholderId ? { ...m, uploadProgress: pct } : m)));
        // Bubble % too, throttled to 10-point steps so a big S3 multipart
        // doesn't fire an updateDoc per part.
        if (pct === 100 || pct - (albumProgressPatchedRef.current[album.queueId] || 0) >= 10) {
          albumProgressPatchedRef.current[album.queueId] = pct;
          void updateDoc(doc(db, 'chats', conversationId, 'messages', placeholderId), { uploadProgress: pct }).catch(() => {});
        }
      };
      // Phase 4: videos go through uploadChatMediaWithPoster (src/aws/storage.ts)
      // so the message carries a posterUrl — a real poster frame captured ~1s
      // in and uploaded to S3 alongside the video. Non-video types unchanged.
      let mediaUrl: string;
      let posterUrl: string | null | undefined;
      if (isVideo) {
        const up = await uploadChatMediaWithPoster(file, type, isViewOnce, onProg, { isHD: !!opts?.isHD });
        mediaUrl = up.url;
        posterUrl = up.posterUrl;
      } else {
        mediaUrl = await uploadChatMedia(file, type, isViewOnce, onProg, { isHD: !!opts?.isHD });
      }
      // Patch the placeholder with the final URL — the bubble swaps from
      // the local preview to the S3 media without a second message.
      await updateDoc(doc(db, 'chats', conversationId, 'messages', placeholderId), {
        mediaUrl, uploading: false, uploadProgress: 100,
        ...(posterUrl ? { posterUrl } : {}),
      });
      if (album) {
        albumProgressPatchedRef.current[album.queueId] = 100;
        setUploadQueue((prev) => prev.map((q) => q.id === album.queueId ? { ...q, progress: 100, status: 'done' } : q));
      }

      if (!isCommunity && partnerUid) {
        realtimeSync.sendMessage(partnerUid, {
          conversationId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          text: textLabel,
          mediaUrl,
          mediaType: type,
          isViewOnce,
          ...(album?.albumId ? { albumId: album.albumId } : {}),
          fileName: file.name, fileSize: file.size, fileType: file.type || '',
          timestamp: Date.now(),
        });
      }
    } catch (err: any) {
      // Surface the real validation reason (user-test C17) — e.g. "File must
      // be smaller than 200MB" — instead of swallowing it behind a generic
      // toast. Anything else keeps the generic message so technical error
      // text never leaks to the user. The placeholder stays, marked failed,
      // so the message is visible (and not silently lost) instead of
      // vanishing; its local preview still renders from the blob URL.
      const msg = typeof err?.message === 'string' ? err.message : '';
      const isValidation = /smaller than|not allowed|invalid|too large/i.test(msg);
      await updateDoc(doc(db, 'chats', conversationId, 'messages', placeholderId), {
        uploading: false, uploadFailed: true,
      }).catch((e) => { console.warn('[ChatScreen] could not mark upload as failed:', e); });
      if (album) setUploadQueue((prev) => prev.map((q) => q.id === album.queueId ? { ...q, status: 'failed' } : q));
      // #206: the banner already knows the keys aren't exchanged — the
      // toast must say so too instead of hiding behind "Upload failed".
      // (Text sends already surface this via isEncryptionFailedError;
      // media sends fell through to the generic message.)
      showToastMsg(
        isEncryptionFailedError(err)
          ? 'Setting up end-to-end encryption… Keys aren’t exchanged yet, so this file can’t send. Try again once the keys are exchanged.'
          : isValidation ? msg : 'Upload failed. Please try again.',
        6000,
      );
    }
    finally {
      setUploading(false);
      setUploadProgress(0);
      setIsViewOnce(false);
      setReplyTo(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Cluster C (Item 13a): video quality choice ───────────────────────
  const sendVideoWithQuality = async (quality: 'hd' | 'saver') => {
    const file = pendingVideo;
    if (!file) return;
    // 100M-F2: the sheet's caption goes with the video either way
    // (HD original, compressed, or the fallback original).
    const caption = videoCaption.trim() || undefined;
    setPendingVideo(null);
    setVideoCaption('');
    if (quality === 'hd') {
      await sendFile(file, undefined, caption, { isHD: true });
      return;
    }
    setVideoQualityBusy(true);
    try {
      const compressed = await compressVideoFile(file, { onProgress: (p) => setVideoCompressPct(Math.round(p * 100)) });
      // #204: formatFileSize — the raw MB math printed "0.0 MB → 0.0 MB"
      // for a 30 KB clip; the quality sheet already uses formatFileSize.
      showToastMsg(`Compressed ${formatFileSize(file.size)} → ${formatFileSize(compressed.size)}`);
      await sendFile(compressed, undefined, caption);
    } catch (err) {
      // Honest fallback: compression failed, so send the original and say so.
      // #204: when the device can't decode the container at all, name the
      // reason instead of the generic line.
      const msg = err instanceof Error ? err.message : '';
      showToastMsg(
        /can't be played/i.test(msg)
          ? `${msg} Sending the original instead.`
          : 'Compression failed — sending the original video instead.',
        6000,
      );
      await sendFile(file, undefined, caption);
    } finally {
      setVideoQualityBusy(false);
      setVideoCompressPct(0);
    }
  };

  // ── Cluster C (Item 13b): in-app camera captures ─────────────────────
  // Camera recordings are already fresh MediaRecorder output, so they go
  // straight through sendFile (no quality sheet). Camera PHOTOS open the
  // ROADMAP-2 item 7 editor instead, like a gallery pick.
  const handleCameraPhoto = async (file: File) => {
    setShowCamera(false);
    setPendingPhoto({ file, url: URL.createObjectURL(file) });
  };
  const handleCameraVideo = async (file: File) => {
    setShowCamera(false);
    // WA parity (verify dm-4 row 64): a camera-recorded video used to
    // send straight away with no quality choice and no caption — route
    // it through the same HD / Data-saver sheet as a gallery video.
    setPendingVideo(file);
  };

  // ── ROADMAP-2 item 7: photo editor ───────────────────────────────────
  // The editor exports an EDITED JPEG; that file — never the original —
  // goes through the normal sendFile path (optimistic placeholder, S3 /
  // local fallback, realtime payload). Cancel discards the pick entirely.
  const handleEditedPhotoSend = async (edited: File, caption?: string, isHD?: boolean) => {
    const pending = pendingPhoto;
    setPendingPhoto(null);
    if (pending) URL.revokeObjectURL(pending.url);
    // #218: light haptic tick when a photo is sent.
    try { navigator.vibrate?.(10); } catch { /* intentionally ignored */}
    // 100M-F2: the editor's caption travels with the edited file.
    await sendFile(edited, undefined, caption, { isHD: !!isHD });
  };
  const handleEditorCancel = () => {
    const pending = pendingPhoto;
    setPendingPhoto(null);
    if (pending) URL.revokeObjectURL(pending.url);
    // UI-army #3: cancelling the editor is cancelling the pick — disarm
    // View Once so the next photo is not silently view-once.
    setIsViewOnce(false);
  };

  // ── Stickers & GIFs (Feature 3) ──
  const sendSticker = async (sticker: AnimatedStickerDef) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    closeCombinedPicker();
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        type: 'sticker',
        text: `${sticker.art} ${sticker.label}`,
        stickerId: sticker.id,
        stickerEmoji: sticker.art,
        stickerLabel: sticker.label,
        // W30j (#216): bundled real-art path (e.g. /stickers/fluent-3d/…).
        // Old clients ignore it and render `stickerEmoji` as before.
        stickerImage: sticker.image || null,
        // Animated pack motion (CSS keyframe name); old clients ignore it
        // and render the static emoji. Null for plain stickers.
        stickerAnimation: sticker.animation && sticker.animation !== 'none' ? sticker.animation : null,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        replyTo: replyToPayload(),
      });
      if (!isCommunity && partnerUid) {
        realtimeSync.sendMessage(partnerUid, {
          conversationId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          text: `${sticker.art} ${sticker.label}`,
          timestamp: Date.now(),
        });
      }
      setReplyTo(null);
    } catch (err) {
      // W24b (100-more F2): an E2EE-deadlock failure must say so — the
      // keys simply aren't exchanged yet. "Check your connection" blamed
      // the network for a key problem (text sends already use
      // isEncryptionFailedError for the same cause).
      showToastMsg(
        isEncryptionFailedError(err)
          ? 'Encryption failed — sticker not sent. Try again once the keys are exchanged.'
          : 'Sticker not sent. Check your connection and try again.',
      );
    }
  };

  const sendGif = async (gif: GifDef, caption?: string) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    closeCombinedPicker();
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        type: 'gif',
        text: 'GIF',
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        mediaUrl: gif.url,
        mediaType: 'image',
        // Wave-2 A5 (DM #78): MP4 variant drives the looping-video
        // render of the GIF bubble; absent = the .gif animates natively.
        gifVideoUrl: gif.mp4Url || null,
        // WA parity Media G6: store the provider attribution on the
        // sent GIF message (e.g. 'GIPHY'); rendered on the GIF bubble.
        // Pasted-link GIFs carry no attribution (provider unknown).
        ...(gif.attribution ? { gifAttribution: gif.attribution } : {}),
        // WA parity A9: the sheet's caption travels on the GIF; the
        // write pipeline encrypts it to e2eeCaption, like photo/video.
        // (Not in the realtime payload — sendFile doesn't put captions
        // there either; the Firestore doc is the source of truth.)
        ...(caption ? { caption } : {}),
        replyTo: replyToPayload(),
      });
      if (!isCommunity && partnerUid) {
        realtimeSync.sendMessage(partnerUid, {
          conversationId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          text: 'GIF',
          mediaUrl: gif.url,
          mediaType: 'image',
          gifVideoUrl: gif.mp4Url || undefined,
          type: 'gif',
          // WA parity Media G6: carry the provider attribution with
          // the realtime payload too (the Firestore doc is the source
          // of truth; this keeps the live path in sync).
          ...(gif.attribution ? { gifAttribution: gif.attribution } : {}),
          timestamp: Date.now(),
        });
      }
      setReplyTo(null);
    } catch (err) {
      // W24c (100-more F2 follow-up — GIF send): same pattern as W24b's
      // sticker fix. An E2EE-deadlock failure must say so — the keys
      // simply aren't exchanged yet. "Check your connection" blamed the
      // network for a key problem (text/sticker sends already use
      // isEncryptionFailedError for the same cause).
      showToastMsg(
        isEncryptionFailedError(err)
          ? 'Encryption failed — GIF not sent. Try again once the keys are exchanged.'
          : 'GIF not sent. Check your connection and try again.',
      );
    }
  };

  // ── Voice recording ──
  // #208: stop the live-level loop and release the analyser's AudioContext.
  // Called from stop/cancel and from the recorder's onstop — the level
  // loop must never outlive the recording.
  const stopRecLevelLoop = () => {
    if (recLevelRafRef.current !== null) cancelAnimationFrame(recLevelRafRef.current);
    recLevelRafRef.current = null;
    recorderAnalyserRef.current = null;
    const actx = recorderAudioCtxRef.current;
    recorderAudioCtxRef.current = null;
    if (actx) void actx.close().catch(() => {});
  };

  // UI-army #9: upload + send a recorded voice blob. Extracted from the
  // recorder's old onstop (which sent immediately); now called only from
  // the preview bar's Send button. Returns true when the note was sent —
  // on failure the preview stays so the user can retry instead of
  // losing the take.
  const sendVoiceNoteBlob = async (blob: Blob, secs: number, isViewOnceVoice = false): Promise<boolean> => {
    const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
    setUploading(true);
    setUploadProgress(0);
    let mediaUrl: string | undefined;
    try {
      // WA parity Media V11: voice send reports upload progress like
      // every other media send — the composer "Uploading…" indicator
      // reads `uploadProgress`, which used to stay 0 for voice notes
      // (bare "Uploading..." with no %). Same callback shape as the
      // generic media path (onProg, ~line 2989).
      const onProg = ({ transferredBytes, totalBytes }: { transferredBytes: number; totalBytes: number }) => {
        if (!totalBytes) return;
        setUploadProgress(Math.min(100, Math.round((transferredBytes / totalBytes) * 100)));
      };
      mediaUrl = await uploadChatMedia(file, 'audio', false, onProg);
      // Phase 4: capture REAL waveform peaks from the recorded blob and
      // store them on the message so VoiceNotePlayer renders the true
      // shape. Best-effort — a decode failure resolves to [] and the
      // player falls back to its bars.
      const peaks = await getWaveformPeaks(blob);
      if (conversationId && currentUser) {
        await addDoc(collection(db, 'chats', conversationId, 'messages'), {
          text: isViewOnceVoice ? 'View once voice message' : `Voice message (${secs}s)`,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          timestamp: serverTimestamp(),
          status: 'sent',
          mediaUrl, mediaType: 'audio',
          duration: secs,
          isVoiceNote: true,
          ...(isViewOnceVoice ? { isViewOnce: true } : {}),
          ...(peaks.length ? { waveform: peaks } : {}),
          fileName: file.name, fileSize: file.size, fileType: file.type || '',
        });

        if (!isCommunity && partnerUid) {
          realtimeSync.sendMessage(partnerUid, {
            conversationId,
            senderId: currentUser.uid,
            senderName: currentUser.displayName || 'User',
            senderAvatar: currentUser.photoURL || '',
            text: isViewOnceVoice ? 'View once voice message' : `Voice message (${secs}s)`,
            mediaUrl,
            mediaType: 'audio',
            isViewOnce: isViewOnceVoice,
            timestamp: Date.now(),
          });
        }
      }
      return true;
    } catch (e) {
      // D3: the voice-note upload/send used to fail with NO toast and
      // no log — the user believed the recording was sent. Say so.
      // 100M-H6: a too-long recording fails the same way on every
      // retry — say so instead of a bare "try again".
      // The blob was already stored before the doc write — if the
      // write failed, delete it or it stays an unreachable orphan
      // (realtimeSync.sendMessage is a no-op stub, so a throw here
      // can only come from the upload or the doc write).
      console.warn('[ChatScreen] voice message failed to send:', e);
      if (mediaUrl && isLocalMediaUrl(mediaUrl)) void deleteLocalMediaBlob(mediaUrl);
      showToastMsg(
        isMediaTooLargeError(e)
          ? 'Voice message too long to send. Try a shorter one.'
          : 'Voice message failed to send. Try again.',
      );
      return false;
    } finally { setUploading(false); setUploadProgress(0); }
  };

  // UI-army #9: preview-bar actions.
  const sendVoicePreview = async () => {
    const preview = voicePreview;
    if (!preview) return;
    const sent = await sendVoiceNoteBlob(preview.blob, preview.secs, !!preview.isViewOnce);
    if (sent) setVoicePreview(null);
  };
  const discardVoicePreview = () => {
    setVoicePreview(null);
    showToastMsg('Voice message discarded');
  };

  // WA parity Media V11 — "Upload voice message" (`testid:
  // ptt_audio_upload`): re-upload this note's audio and point the
  // message at the fresh URL. A note whose first upload failed (or
  // whose stored copy is gone) can be retried from the player instead
  // of re-recording. `local-media:` refs resolve to blob: URLs first.
  const reuploadVoiceNote = async (msg: ChatMessage) => {
    if (!msg.mediaUrl || !conversationId || reuploadingVoiceIds.has(msg.id)) return;
    setReuploadingVoiceIds((prev) => new Set(prev).add(msg.id));
    try {
      const playable = isLocalMediaUrl(msg.mediaUrl) ? await resolveLocalMediaUrl(msg.mediaUrl) : msg.mediaUrl;
      const res = await fetch(playable);
      if (!res.ok) throw new Error('fetch failed');
      const blob = await res.blob();
      const file = new File([blob], msg.fileName || `voice_${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
      const mediaUrl = await uploadChatMedia(file, 'audio');
      await updateDoc(doc(db, 'chats', conversationId, 'messages', msg.id), { mediaUrl });
      showToastMsg('Voice message uploaded ✓');
    } catch (e) {
      console.warn('[ChatScreen] voice message re-upload failed:', e);
      showToastMsg('Voice message upload failed. Try again.');
    } finally {
      setReuploadingVoiceIds((prev) => { const next = new Set(prev); next.delete(msg.id); return next; });
    }
  };

  // WA parity (media audit V12): no voice recording during a call —
  // WhatsApp's exact string. callService.getStatus() is the same source
  // the call screen uses (#123), so the guard agrees with the modal.
  const isCallActive = (): boolean => {
    try {
      const st = callService.getStatus();
      return st === 'outgoing' || st === 'incoming' || st === 'connecting' || st === 'connected';
    } catch {
      return false;
    }
  };
  const callGuard = (): boolean => {
    if (!isCallActive()) return false;
    showToastMsg("Can't record voice messages during a WhatsApp call.");
    return true;
  };

  const startRecording = async () => {
    if (blockedGuard()) return;
    if (callGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    // A staged preview from a previous take is replaced by the new one.
    if (voicePreview) setVoicePreview(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      mr.onstop = async () => {
        stopRecLevelLoop();
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        // UI-army #9: stage a listen-before-send preview (Play + Send +
        // Delete) instead of uploading/sending on stop. The note is sent
        // only when the user taps Send in the preview bar.
        let waveform: number[] = [];
        try { waveform = await getWaveformPeaks(blob); } catch { /* player falls back to its bars */ }
        // V10: a View Once armed from the attach menu carries over to the
        // voice preview (the preview's own Eye toggle can arm it too).
        setVoicePreview({ url: URL.createObjectURL(blob), blob, secs: recordingSecsRef.current, waveform, isViewOnce: isViewOnce || undefined });
      };
      mr.start();
      mediaRecorderRef.current = mr;
      isRecordingPausedRef.current = false;
      setIsRecordingPaused(false);
      // #218: light haptic tick when recording starts.
      try { navigator.vibrate?.(15); } catch { /* intentionally ignored */}
      // #208: LIVE mic levels. An AnalyserNode taps the mic stream and a
      // rAF loop writes the rolling RMS straight into the bar spans' DOM
      // heights — no React state per frame, so the level loop never
      // re-renders the chat (the typing-freeze lesson). When Web Audio is
      // unavailable the bars keep the old timer animation as a fallback.
      try {
        const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AC) {
          const actx = new AC();
          const src = actx.createMediaStreamSource(stream);
          const analyser = actx.createAnalyser();
          analyser.fftSize = 256;
          src.connect(analyser);
          void actx.resume().catch(() => {});
          recorderAudioCtxRef.current = actx;
          recorderAnalyserRef.current = analyser;
          const buf = new Uint8Array(analyser.fftSize);
          const levels: number[] = new Array(28).fill(6);
          const tick = () => {
            const an = recorderAnalyserRef.current;
            if (!an) return;
            // V5: while paused the bars freeze with the timer — the loop
            // keeps running so resume picks up without re-wiring audio.
            if (isRecordingPausedRef.current) {
              recLevelRafRef.current = requestAnimationFrame(tick);
              return;
            }
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
            const host = recBarsRef.current;
            if (host) {
              host.setAttribute('data-rec-live', 'true');
              host.setAttribute('data-rec-rms', rms.toFixed(3));
              const spans = host.children;
              for (let i = 0; i < spans.length && i < levels.length; i++) {
                (spans[i] as HTMLElement).style.height = `${levels[i].toFixed(1)}px`;
              }
            }
            recLevelRafRef.current = requestAnimationFrame(tick);
          };
          recLevelRafRef.current = requestAnimationFrame(tick);
        }
      } catch {
        // Web Audio unavailable — the timer-animated bars stay.
      }
      setIsRecording(true);
      setRecordingSecs(0);
      recordingSecsRef.current = 0;
      // ROADMAP-2 item 12: a fast tap can release before the recorder is
      // up (mic permission prompt) — honour the release that already
      // happened instead of recording forever.
      if (voiceReleaseRef.current) {
        const action = voiceReleaseRef.current;
        voiceReleaseRef.current = null;
        setTimeout(() => { if (action === 'cancel') cancelRecording(); else stopRecording(); }, 60);
      }
      recordTimerRef.current = setInterval(() => {
        recordingSecsRef.current += 1;
        setRecordingSecs(s => s + 1);
      }, 1000);
    } catch { showToastMsg('Microphone access needed for voice messages.'); }
  };

  // WA parity (media audit V5): pause / resume. MediaRecorder.pause()
  // keeps the chunks recorded so far; resume continues the same blob and
  // the timer restarts from the frozen count.
  const pauseRecording = () => {
    const mr = mediaRecorderRef.current;
    if (!mr || mr.state !== 'recording') return;
    try { mr.pause(); } catch { return; }
    isRecordingPausedRef.current = true;
    setIsRecordingPaused(true);
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    recordTimerRef.current = null;
  };
  const resumeRecording = () => {
    const mr = mediaRecorderRef.current;
    if (!mr || mr.state !== 'paused') return;
    try { mr.resume(); } catch { return; }
    isRecordingPausedRef.current = false;
    setIsRecordingPaused(false);
    recordTimerRef.current = setInterval(() => {
      recordingSecsRef.current += 1;
      setRecordingSecs(s => s + 1);
    }, 1000);
  };

  const stopRecording = () => {
    // Guard on the recorder's own state, not the `isRecording` render
    // state — the pending-release path above can call this before the
    // state has flushed, and a stale `false` must not swallow the stop.
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') {
      mr.stop();
      setIsRecording(false);
      setIsLockedRecording(false);
      isRecordingPausedRef.current = false;
      setIsRecordingPaused(false);
      setVoiceGesture('idle');
      voiceGestureRef.current = 'idle';
      removeVoiceListeners();
      stopRecLevelLoop();
      // #218: light haptic tick when the note stops — it now stages as
      // a preview (UI-army #9) instead of sending immediately.
      try { navigator.vibrate?.(10); } catch { /* intentionally ignored */}
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    }
  };

  const cancelRecording = () => {
    stopRecLevelLoop();
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      try { mediaRecorderRef.current.stop(); } catch (e) { console.warn('[ChatScreen] stopping voice recorder failed:', e); }
    }
    setIsRecording(false);
    setIsLockedRecording(false);
    isRecordingPausedRef.current = false;
    setIsRecordingPaused(false);
    setVoiceGesture('idle');
    voiceGestureRef.current = 'idle';
    removeVoiceListeners();
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
  };

  // ── ROADMAP-2 item 12: voice-note gestures (pointer events) ──
  // Hold the mic to record. While holding: slide UP ≥60px to lock
  // (recording continues hands-free until Send), slide LEFT ≥70px to arm
  // cancel — release while cancel-armed discards the note, sliding back
  // right disarms it. A plain release sends; a release within 300 ms of
  // the press (an accidental tap) discards instead of sending a ~0s note.
  //
  // The move/up listeners MUST be window-level: the moment recording
  // starts, the composer (and the mic button with it) unmounts and the
  // recording bar takes its place — button-level move/up handlers would
  // never fire again, so the slide gestures would be dead for real
  // users, not just in a probe. The listeners are added on pointerdown
  // and removed on release/cancel/unmount; they only ever touch refs
  // and setState, so the closure captured at pointerdown stays valid
  // (stopRecording/cancelRecording themselves only use refs + setters).
  const handleMicPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // V1: only the primary button starts a recording — a right-click
    // (or pen barrel-button) pointerdown must not start the mic.
    if (e.button !== 0) return;
    if (blockedGuard()) return;
    if (callGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (isRecording) return;
    voiceStartRef.current = { x: e.clientX, y: e.clientY };
    voiceDownAtRef.current = Date.now();
    voiceGestureRef.current = 'recording';
    setVoiceGesture('recording');
    const move = (ev: PointerEvent) => {
      const start = voiceStartRef.current;
      if (!start) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (dy <= -60 && !isLockedRecordingRef.current) {
        isLockedRecordingRef.current = true;
        setIsLockedRecording(true);
        voiceGestureRef.current = 'lock-armed';
        setVoiceGesture('lock-armed');
      }
      if (voiceGestureRef.current === 'lock-armed') return;
      if (dx <= -70) {
        if (voiceGestureRef.current !== 'cancel-armed') { voiceGestureRef.current = 'cancel-armed'; setVoiceGesture('cancel-armed'); }
      } else if (dx > -40 && voiceGestureRef.current === 'cancel-armed') {
        voiceGestureRef.current = 'recording';
        setVoiceGesture('recording');
      }
    };
    const up = () => {
      const start = voiceStartRef.current;
      voiceStartRef.current = null;
      removeVoiceListeners();
      if (!start) return;
      const g = voiceGestureRef.current;
      voiceGestureRef.current = 'idle';
      setVoiceGesture('idle');
      const elapsed = Date.now() - voiceDownAtRef.current;
      const discard = elapsed < 300 || g === 'cancel-armed';
      // Recorder not up yet (permission prompt) — park the release
      // action for startRecording to honour.
      if (!mediaRecorderRef.current) { voiceReleaseRef.current = discard ? 'cancel' : 'send'; return; }
      if (discard) cancelRecording();
      else if (g === 'lock-armed' || isLockedRecordingRef.current) { /* hands-free: keep recording until Send */ }
      else stopRecording();
    };
    const cancel = () => {
      voiceStartRef.current = null;
      voiceGestureRef.current = 'idle';
      setVoiceGesture('idle');
      removeVoiceListeners();
      cancelRecording();
    };
    voiceListenersRef.current = { move, up, cancel };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    void startRecording();
  };

  // ── Phase 4: round video messages (Telegram-style, ≤60s) ──
  // Records with the front camera + mic via MediaRecorder, uploads through
  // the same S3 path as normal videos (uploadChatMediaWithPoster, so round
  // videos also get a poster frame), and sends as a video message with
  // `isRoundVideo: true` so it renders as a circle. No new backend.
  const ROUND_VIDEO_MAX_SECS = 60;
  const startRoundVideo = async () => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!navigator.mediaDevices?.getUserMedia) { showToastMsg('Camera recording is not supported on this device/browser.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } },
        audio: true,
      });
      roundStreamRef.current = stream;
      roundChunksRef.current = [];
      setRoundSecs(0);
      roundSecsRef.current = 0;
      setIsRoundRecording(true);
      // The preview <video> only exists once the modal renders.
      setTimeout(() => {
        if (roundPreviewRef.current) roundPreviewRef.current.srcObject = stream;
      }, 50);
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => {
        try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
      });
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mr.ondataavailable = (e) => { if (e.data?.size) roundChunksRef.current.push(e.data); };
      mr.onstop = async () => {
        roundStreamRef.current?.getTracks().forEach((t) => t.stop());
        roundStreamRef.current = null;
        const blob = new Blob(roundChunksRef.current, { type: mr.mimeType || 'video/webm' });
        if (!blob.size) return;
        const ext = (mr.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `round_${Date.now()}.${ext}`, { type: blob.type || 'video/webm' });
        const finalSecs = roundSecsRef.current;
        setUploading(true);
        try {
          const { url: mediaUrl, posterUrl } = await uploadChatMediaWithPoster(file, 'video', false);
          if (conversationId && currentUser) {
            await addDoc(collection(db, 'chats', conversationId, 'messages'), {
              text: 'Round video',
              senderId: currentUser.uid,
              senderName: currentUser.displayName || 'User',
              senderAvatar: currentUser.photoURL || '',
              timestamp: serverTimestamp(),
              status: 'sent',
              mediaUrl, mediaType: 'video',
              isRoundVideo: true,
              duration: finalSecs,
              ...(posterUrl ? { posterUrl } : {}),
              fileName: file.name, fileSize: file.size, fileType: file.type || '',
              replyTo: replyToPayload(),
            });
            setReplyTo(null);
          }
        } catch {
          showToastMsg('Round video failed to send. Try again.');
        } finally {
          setUploading(false);
        }
      };
      mr.start(250);
      roundRecorderRef.current = mr;
      roundTimerRef.current = setInterval(() => {
        roundSecsRef.current += 1;
        setRoundSecs(roundSecsRef.current);
        if (roundSecsRef.current >= ROUND_VIDEO_MAX_SECS) stopRoundVideo();
      }, 1000);
    } catch {
      showToastMsg('Camera access needed for round video.');
    }
  };

  const stopRoundVideo = () => {
    if (roundTimerRef.current) clearInterval(roundTimerRef.current);
    try { roundRecorderRef.current?.stop(); } catch (e) { console.warn('[ChatScreen] stopping round-video recorder failed:', e); }
    setIsRoundRecording(false);
  };

  const cancelRoundVideo = () => {
    if (roundTimerRef.current) clearInterval(roundTimerRef.current);
    if (roundRecorderRef.current) {
      roundRecorderRef.current.ondataavailable = null;
      roundRecorderRef.current.onstop = null;
      try { roundRecorderRef.current.stop(); } catch (e) { console.warn('[ChatScreen] stopping round-video recorder failed:', e); }
    }
    roundStreamRef.current?.getTracks().forEach((t) => t.stop());
    roundStreamRef.current = null;
    setIsRoundRecording(false);
  };

  // ── Message actions (WhatsApp standard) ──
  const deleteForEveryone = async (msgId: string) => {
    if (!conversationId) return;
    // WA parity (DM audit row 52): Delete for everyone works only within
    // ~2 days of sending (exact window literal NOT FOUND in the extracted
    // client — phone-app behaviour). Delete for me stays always available.
    // Server-side enforcement is still open (BACKEND-PLAN.md, row 96).
    const target = messages.find((x: any) => x.id === msgId);
    if (target && !canDeleteForEveryone(target)) {
      showToastMsg('You can only delete messages for everyone within 2 days of sending', 6000);
      setCtxMenu(null);
      return;
    }
    try {
      await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), {
        deleted: true,
        // WA parity (DM audit row 40): own deleted messages read
        // "You deleted this message"; the peer's read "This message was
        // deleted" (rendered from `mine`, so old placeholders match too).
        text: 'You deleted this message',
        mediaUrl: null,
        mediaType: null,
        type: 'deleted',
        stickerId: null,
        stickerEmoji: null,
        stickerLabel: null,
        stickerImage: null,
        isViewOnce: false,
      });
      if (!isCommunity && partnerUid) {
        realtimeSync.sendAction(partnerUid, {
          conversationId,
          type: 'delete_everyone',
          msgId,
        });
      }
      showToastMsg('Message deleted for everyone');
    } catch {
      showToastMsg('Failed to delete message');
    }
    setCtxMenu(null);
  };

  const deleteForMe = (msgId: string) => {
    if (!currentUser || !conversationId) return;
    const key = deletedForMeKey(currentUser.uid, conversationId);
    setDeletedForMeIds(prev => {
      const nextList = prev.includes(msgId) ? prev : [...prev, msgId];
      try { localStorage.setItem(key, JSON.stringify(nextList)); } catch (e) { console.warn('[ChatScreen] could not save deleted-for-me list:', e); }
      return nextList;
    });
    showToastMsg('Message deleted for you');
    setCtxMenu(null);
  };
  // Phase 3: bulk delete (from the multi-select toolbar / confirm modal).
  const doDeleteConfirmed = async () => {
    if (!deleteConfirm) return;
    const { kind, ids } = deleteConfirm;
    setDeleteConfirm(null);
    if (kind === 'everyone') {
      for (const id of ids) {
        const m = messages.find(x => x.id === id);
        if (m && isMe(m)) await deleteForEveryone(id);
      }
    } else {
      for (const id of ids) deleteForMe(id);
    }
    setSelectedIds([]);
  };

  // ── ROADMAP-2 item 10: clear chat (normal chats) ──
  // Per-user only: stamps clearedAt on MY private doc and hides the
  // messages locally. No message doc is deleted, so the other
  // participant's chat is untouched; messages sent after the stamp keep
  // showing. Offline-queued outgoing messages are NOT cleared — they
  // still send when reconnected (they were never delivered).
  const doClearChat = async () => {
    if (!conversationId || !currentUser) return;
    setShowClearConfirm(false);
    try {
      const ts = await setClearedAt(currentUser.uid, conversationId, Date.now());
      setClearedAtState(ts);
      showToastMsg('Chat cleared');
    } catch (e) {
      console.warn('[ChatScreen] clear chat failed:', e);
      showToastMsg('Could not clear chat. Try again.');
    }
  };

  const scrollToMsg = (targetId: string) => {
    const el = document.getElementById(`msg-${targetId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedMsgId(targetId);
      setTimeout(() => setHighlightedMsgId(null), 1800);
      return;
    }
    // WA verify DM-2 row 37 / dm-5 row 91: a quote/pin of an older
    // message used to toast "not found" when the original sat above the
    // rendered page (visibleMsgs.slice(-visibleCount), page 50). Expand
    // pagination to include it (same pattern as jumpToDate), then scroll
    // + highlight. A text search filters the rendered list, so exit
    // filtered mode first, as jumpToDate does. (Same fix, built twice;
    // this is the fuller form — search-clear + retry.)
    if (searchQuery || searchQueryDebounced) {
      setSearchQuery('');
      setSearchQueryDebounced('');
    }
    const idx = visibleMsgs.findIndex((m: any) => m.id === targetId);
    if (idx >= 0 && idx < visibleMsgs.length - visibleCount) {
      setVisibleCount(visibleMsgs.length - idx);
      setTimeout(() => scrollToMsg(targetId), 80);
      return;
    }
    if (idx >= 0) {
      // In the rendered page but the DOM has not caught up yet (e.g. the
      // search filter was just cleared) — retry once, then give up.
      setTimeout(() => {
        const el2 = document.getElementById(`msg-${targetId}`);
        if (el2) {
          el2.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightedMsgId(targetId);
          setTimeout(() => setHighlightedMsgId(null), 1800);
        } else {
          showToastMsg('Original message not found in this chat');
        }
      }, 80);
      return;
    }
    showToastMsg('Original message not found in this chat');
  };

  const pinMsg = async (msg: any) => {
    if (!conversationId) return;
    try {
      const summary = { id: msg.id, text: msg.text, senderName: msg.senderName, timestamp: msg.timestamp };
      const cur = displayedPins.some((p: any) => p.id === msg.id) ? displayedPins : [...displayedPins, summary];
      await setDoc(doc(db, 'chats', conversationId, 'meta', 'pinnedList'), { pins: cur });
      // Legacy single-pin doc kept for older clients.
      await setDoc(doc(db, 'chats', conversationId, 'meta', 'pinned'), summary);
      showToastMsg('Pinned 📌');
    } catch (e) {
      // D3: a failed pin used to fail silently (no toast, no log).
      console.warn('[ChatScreen] pin failed:', e);
      showToastMsg('Pin failed. Try again.');
    }
    setCtxMenu(null);
  };

  const unpinMsg = async (msgId?: string) => {
    if (!conversationId) return;
    try {
      if (msgId) {
        const cur = displayedPins.filter((p: any) => p.id !== msgId);
        if (cur.length) await setDoc(doc(db, 'chats', conversationId, 'meta', 'pinnedList'), { pins: cur });
        else await deleteDoc(doc(db, 'chats', conversationId, 'meta', 'pinnedList'));
        if (pinnedMsg?.id === msgId) await deleteDoc(doc(db, 'chats', conversationId, 'meta', 'pinned'));
      } else {
        await deleteDoc(doc(db, 'chats', conversationId, 'meta', 'pinnedList'));
        await deleteDoc(doc(db, 'chats', conversationId, 'meta', 'pinned'));
      }
    } catch (e) {
      // D3: a failed unpin used to fail silently (no toast, no log).
      console.warn('[ChatScreen] unpin failed:', e);
      showToastMsg('Unpin failed. Try again.');
    }
  };

  const starMsg = async (msg: any) => {
    if (!currentUser) return;
    // Phase 5 (L-09): messages in a locked chat cannot be starred — a
    // starred copy would leak them into the Starred screen.
    if (isHidden) {
      showToastMsg('Locked chats can’t be starred');
      return;
    }
    try {
      if (starredIds.includes(msg.id)) {
        await deleteDoc(doc(db, 'users', currentUser.uid, 'starred', msg.id));
        showToastMsg('Unstarred');
      } else {
        await setDoc(doc(db, 'users', currentUser.uid, 'starred', msg.id), {
          ...msg, chatId, conversationId, starredAt: Date.now(),
          // Phase 3: live refs so Starred/Saved screens can jump to the live message.
          originalMessageId: msg.id, originalChatId: chatId, messageId: msg.id,
        });
        showToastMsg('Starred ⭐');
      }
    } catch (e) {
      // D3: a failed star/unstar used to fail silently (no toast, no log).
      console.warn('[ChatScreen] star/unstar failed:', e);
      showToastMsg('Could not update star. Try again.');
    }
    setCtxMenu(null);
  };

  const saveMsg = async (msg: any) => {
    if (!currentUser) return;
    // Phase 5 (L-10): messages in a locked chat cannot be copied to Saved.
    if (isHidden) {
      showToastMsg('Locked chats can’t be saved');
      return;
    }
    const savedCid = `saved_${currentUser.uid}`;
    const savedCol = `chats/${savedCid}/messages`;
    try {
      // W7 #79/#88: load the saved collection BEFORE writing or
      // checking for duplicates. ChatScreen never subscribes to it, so
      // without this the in-memory map is empty and the debounced
      // whole-map persist would wipe every previously saved message
      // (database.ts putRaw also restores first now — belt and braces).
      // The same load gives the duplicate check below a complete list.
      await db.ensure(savedCol);
      // W7 #88: never save the same message twice — the menu has no
      // "Saved ✓" state of its own (that label lives outside this
      // function), so the guard lives here: an existing copy keyed by
      // originalMessageId toasts instead of creating a duplicate.
      if (msg?.id && db.getCollectionDocs(savedCol).some((d: any) => d.originalMessageId === msg.id)) {
        setCtxMenu(null);
        showToastMsg('Already saved ✓');
        try { navigator.vibrate?.(10); } catch { /* intentionally ignored */}
        return;
      }
      await addDoc(collection(db, 'chats', savedCid, 'messages'), {
        text: msg.text || '[Media]',
        senderId: currentUser.uid,
        senderName: 'Saved',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        mediaUrl: msg.mediaUrl || null,
        mediaType: msg.mediaType || null,
        // W7 #80: "Forwarded from" is a property of the ORIGINAL
        // message, not of saving it. The old code stamped every saved
        // copy `originalFrom: msg.senderName`, so even a plain message
        // from Rahul read "Forwarded from Rahul" and a genuinely
        // forwarded message lost its true origin (Meera). Only a real
        // forward carries a credit now; the original sender is stored
        // separately (originalSenderId/Name) so Saved can keep the
        // original incoming/outgoing alignment (#93).
        originalFrom: msg.forwardedFrom || null,
        forwardedFrom: msg.forwardedFrom || null,
        originalSenderId: msg.senderId || null,
        originalSenderName: msg.senderName || null,
        originalMessageId: msg.id, originalChatId: chatId, messageId: msg.id,
        chatId, conversationId,
        // W7 #81: a reply without its quote is half a message — copy
        // replyTo (putRaw re-encrypts replyTo.text with the saved-chat
        // self key, exactly like the body text).
        replyTo: msg.replyTo || null,
        // W7 #82: keep the edited marker + history so Saved can show
        // "(edited)" instead of silently presenting the latest text as
        // the original. (editHistory plaintext entries are encrypted
        // by putRaw; see e2eeChat encryptOutgoingInner.)
        edited: !!msg.edited,
        editedAt: msg.editedAt ?? null,
        editHistory: msg.editHistory || null,
        // W7 #90: a kept message must still look kept in Saved.
        kept: !!msg.kept,
        keptBy: msg.keptBy || null,
        keptAt: msg.keptAt ?? null,
        // Saved-fix: copy the type-specific fields too, otherwise Saved
        // Messages can never render polls / location / contacts / files /
        // stickers properly — it only ever saw text + mediaUrl + mediaType.
        // Firestore rejects `undefined`, so everything is null-coalesced.
        // Old saved copies without these fields keep working via fallbacks
        // in SavedMessagesScreen.
        type: msg.type || null,
        pollQuestion: msg.pollQuestion || null,
        pollOptions: msg.pollOptions || null,
        pollVotes: msg.pollVotes || null,
        latitude: msg.latitude ?? null,
        longitude: msg.longitude ?? null,
        locationLabel: msg.locationLabel || null,
        locationAccuracy: msg.locationAccuracy ?? null,
        // W27: live-location snapshot fields. The saved copy never
        // receives ticks, so it must never render as live — force
        // inactive even when the original is still sharing.
        liveLocationId: msg.liveLocationId || null,
        liveLocationExpiresAt: msg.liveLocationExpiresAt ?? null,
        liveLocationUpdatedAt: msg.liveLocationUpdatedAt ?? null,
        liveLocationActive: false,
        contactName: msg.contactName || null,
        contactPhone: msg.contactPhone || null,
        contactAvatar: msg.contactAvatar || null,
        // #89: carry the app-user id so a saved contact card can offer
        // a Message button (phone-only contacts keep no uid, no button).
        contactUid: msg.contactUid || null,
        fileName: msg.fileName || null,
        fileSize: msg.fileSize ?? null,
        fileType: msg.fileType || null,
        duration: msg.duration ?? null,
        waveform: msg.waveform || null,
        posterUrl: msg.posterUrl || null,
        stickerEmoji: msg.stickerEmoji || null,
        stickerLabel: msg.stickerLabel || null,
        stickerImage: msg.stickerImage || null,
        stickerAnimation: msg.stickerAnimation || null,
        pollMultiAnswer: msg.pollMultiAnswer ?? null,
        pollMaxChoices: msg.pollMaxChoices ?? null,
        isRoundVideo: !!msg.isRoundVideo,
      });
      setCtxMenu(null);
      showToastMsg('Message saved');
      // W7 #97: the only feedback used to be a toast — a short haptic
      // tick on save (guarded; desktop browsers ignore it).
      try { navigator.vibrate?.(10); } catch { /* intentionally ignored */}
    } catch (err) {
      // Previously this failure was swallowed and the toast still said "saved"
      console.error('Save message failed', err);
      setCtxMenu(null);
      showToastMsg('Could not save message. Try again.');
    }
  };

  // Item 10 (Master-gaps Cluster B): Keep / Unkeep a message in a
  // disappearing chat. Kept messages get `kept: true` (+ who/when) on the
  // doc and are excluded from the disappearing filter (isMessageExpired
  // returns false for them), so they survive the timer. Unkeep clears the
  // fields and the timer applies again from the original timestamp.
  // The write is metadata-only (kept/keptBy/keptAt are not encryptable
  // content), so the E2EE putRaw path does not re-encrypt the message.
  const keepMsg = async (msg: any) => {
    if (!conversationId || !currentUser || !msg?.id) return;
    setCtxMenu(null);
    try {
      if (isKeptMessage(msg)) {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msg.id), {
          kept: deleteField(),
          keptBy: deleteField(),
          keptAt: deleteField(),
        });
        showToastMsg('Message unkept — it will disappear with the timer');
      } else {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msg.id), {
          kept: true,
          keptBy: currentUser.uid,
          keptAt: Date.now(),
        });
        showToastMsg('Message kept — it won’t disappear 📌');
      }
    } catch {
      showToastMsg('Could not update this message. Try again.');
    }
  };

  // Polls — created by PollComposer (multi-answer + max choices), rendered
  // by PollCard. The payload is already validated by the composer; the
  // new fields are optional so legacy single-answer polls keep working.
  const sendPoll = async (payload: PollComposerPayload) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        type: 'poll',
        text: 'Poll: ' + payload.question,
        pollQuestion: payload.question,
        pollOptions: payload.options,
        pollVotes: {},
        pollMultiAnswer: payload.multiAnswer,
        pollMaxChoices: payload.maxChoices,
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
      });
      setShowPollModal(false);
      showToastMsg('Poll sent');
    } catch {
      // Honest failure (user-test V2): never claim "sent" when the write
      // failed — the user would believe the poll went out when it didn't.
      setShowPollModal(false);
      showToastMsg("Poll couldn't be sent. Check your connection and try again.");
    }
  };

  // ── Location / Contact sharing (Feature 4) ──
  // ── W27f (P0-8 manifestation): the share paths announce the key too ──
  // sendTextNow announces before a text send; the share paths (contact /
  // static location / live location) never did, so in a fresh DM they
  // failed closed forever with a generic "check your connection" toast
  // and 0 docs stored. Announce first via the landed ensureKeyAnnounce
  // (same guard + writer as sendTextNow — self-chats and groups never
  // announce). Never throws: a failed announce leaves the send to fail
  // closed with the encryption error, exactly as before.
  const announceKeyIfNeeded = async () => {
    if (isCommunity || !chatId || !currentUser || chatId === currentUser.uid || e2eeKeyReady) return;
    const res = await ensureKeyAnnounce(conversationId, currentUser.uid, kxDocsRef.current, async (cid, payload) => {
      await addDoc(collection(db, 'chats', cid, 'messages'), {
        ...payload, timestamp: Date.now(), senderId: currentUser.uid,
      });
    });
    if (res.status === 'established') setE2eeKeyReady(true);
    else if (res.announcedAt) setE2eeSetupAnnouncedAt(res.announcedAt);
  };

  const sendLocation = async (loc: LocationPayload) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    await announceKeyIfNeeded();
    const label = loc.label || 'Location';
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        type: 'location',
        text: label,
        latitude: loc.latitude,
        longitude: loc.longitude,
        ...(typeof loc.accuracy === 'number' ? { locationAccuracy: loc.accuracy } : {}),
        ...(loc.label ? { locationLabel: loc.label } : {}),
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        replyTo: replyToPayload(),
      });
      if (!isCommunity && partnerUid) {
        realtimeSync.sendMessage(partnerUid, {
          conversationId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          type: 'location',
          text: label,
          latitude: loc.latitude,
          longitude: loc.longitude,
          ...(loc.label ? { locationLabel: loc.label } : {}),
          timestamp: Date.now(),
        });
      }
      setReplyTo(null);
      setShowLocationModal(false);
      showToastMsg('Location sent');
    } catch (err) {
      // Honest failure (user-test V3): never claim "sent" when the write failed.
      // W27f: an encryption failure means the keys aren't exchanged yet —
      // the announce above gives the peer a key to ack. Say so (and keep
      // the modal open so the user can retry), instead of blaming the
      // connection like before.
      if (isEncryptionFailedError(err)) {
        showToastMsg('Encryption failed — location not sent. Try again once the keys are exchanged.');
        return;
      }
      setShowLocationModal(false);
      showToastMsg("Location couldn't be sent. Check your connection and try again.");
    }
  };

  // ── Live location sharing (W27) ──
  // Transport: the message doc is created once (type 'live-location',
  // plaintext like static location — NOT E2EE-encrypted), then each
  // throttled tick updateDocs the SAME doc (latitude/longitude/
  // liveLocationUpdatedAt). Receivers see ticks through the normal
  // message subscription — no new channel, no fake positions.
  const startLiveSessionForMessage = async (
    msgId: string,
    liveLocationId: string,
    duration: LiveLocationDuration,
    resumeExpiresAt?: number,
  ): Promise<LiveLocationSession | null> => {
    if (!conversationId) return null;
    const session = await startLiveLocation({
      chatId: conversationId,
      liveLocationId,
      duration,
      ...(resumeExpiresAt ? { resumeExpiresAt } : {}),
      onUpdate: async (u) => {
        try {
          await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), buildLiveLocationUpdateFields(u));
        } catch {
          // One failed tick never kills tracking (the service swallows too).
        }
      },
      onExpire: async () => {
        liveSessionRef.current = null;
        try {
          await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), { liveLocationActive: false });
        } catch { /* intentionally ignored */}
        showToastMsg('Live location sharing ended');
      },
      onError: (m) => showToastMsg(m),
    });
    if (session) liveSessionRef.current = session;
    return session;
  };

  const sendLiveLocation = async (duration: LiveLocationDuration) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    if (getActiveSession(conversationId) || myActiveLiveMsg) {
      showToastMsg('You are already sharing live location in this chat');
      setShowLocationModal(false);
      return;
    }
    // W27f: same P0-8 gap as sendContact/sendLocation — a fresh DM has
    // no exchanged key, so the doc create below would fail closed with
    // a misleading connection toast. Announce first (no-op in groups /
    // once a key is established).
    await announceKeyIfNeeded();
    setShowLocationModal(false);
    // First fix validates permission before anything is sent.
    let pos;
    try {
      pos = await getCurrentPosition();
    } catch (err) {
      showToastMsg(geolocationErrorMessage(err));
      return;
    }
    const liveLocationId = 'live_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const msgData = buildLiveLocationMessage({
      liveLocationId,
      latitude: pos.latitude,
      longitude: pos.longitude,
      accuracy: pos.accuracy,
      duration,
      senderId: currentUser.uid,
      senderName: currentUser.displayName || 'User',
    });
    let msgId: string;
    try {
      const ref = await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        ...msgData,
        text: 'Live location',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        replyTo: replyToPayload(),
      });
      msgId = ref.id;
    } catch (err) {
      // W27f: an encryption failure means the keys aren't exchanged yet
      // (the announce above gives the peer a key to ack) — say so, not
      // "check your connection".
      showToastMsg(isEncryptionFailedError(err)
        ? 'Encryption failed — live location couldn\'t be shared. Try again once the keys are exchanged.'
        : "Live location couldn't be shared. Check your connection and try again.");
      return;
    }
    setReplyTo(null);
    // Start the watch only after the doc exists, so ticks never 404.
    const session = await startLiveSessionForMessage(msgId, liveLocationId, duration);
    if (!session) {
      // startLiveLocation already surfaced the reason via onError — the
      // bubble must not lie about sharing, so flip it inactive.
      try {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), { liveLocationActive: false });
      } catch { /* intentionally ignored */}
      return;
    }
    showToastMsg('Sharing live location');
  };

  const stopMyLiveLocation = async () => {
    if (!conversationId || !myActiveLiveMsg) return;
    stopLiveLocation(conversationId);
    liveSessionRef.current = null;
    setLiveResumeNeeded(false);
    try {
      await updateDoc(doc(db, 'chats', conversationId, 'messages', myActiveLiveMsg.id), { liveLocationActive: false });
    } catch { /* intentionally ignored */}
    showToastMsg('Live location sharing stopped');
  };

  const resumeLiveLocation = async () => {
    if (!conversationId || !myActiveLiveMsg) {
      // 100M-W27d-2: the paused banner can outlive the session — the
      // hygiene effect only re-runs on messages change, so after the
      // expiry passes with no new message the banner lingers while
      // myActiveLiveMsg is already null. Resume used to just hide the
      // banner with no explanation and leave the doc active:true. Say
      // so honestly, flip the stale doc inactive, and clear the
      // persisted session so the banner does not come back.
      if (conversationId) {
        const stale = messages.find((m: any) => m?.type === 'live-location' && m.senderId === currentUser?.uid && typeof m.liveLocationExpiresAt === 'number' && m.liveLocationExpiresAt <= Date.now());
        if (stale) {
          try { await updateDoc(doc(db, 'chats', conversationId, 'messages', stale.id), { liveLocationActive: false }); } catch { /* intentionally ignored */}
          stopLiveLocation(conversationId);
          liveSessionRef.current = null;
          showToastMsg('This live location session has already expired.');
        } else {
          // No live message left in this chat (deleted / cleared) — the
          // persisted session is orphaned; drop it, don't claim expiry.
          stopLiveLocation(conversationId);
          liveSessionRef.current = null;
          showToastMsg('Live location is no longer active in this chat.');
        }
      }
      setLiveResumeNeeded(false);
      return;
    }
    const msg = myActiveLiveMsg;
    const remaining = (msg.liveLocationExpiresAt || 0) - Date.now();
    // Duration only labels the session; resumeExpiresAt keeps the exact
    // original expiry, so resuming never extends the share.
    const duration: LiveLocationDuration = remaining <= 15 * 60 * 1000 ? '15m' : remaining <= 60 * 60 * 1000 ? '1h' : '8h';
    setLiveResumeNeeded(false);
    const session = await startLiveSessionForMessage(msg.id, msg.liveLocationId || msg.id, duration, msg.liveLocationExpiresAt);
    if (session) {
      showToastMsg('Live location sharing resumed');
    } else if (remaining <= 0) {
      // 100M-W27d-2 (stale-window refusal): the paused banner can outlive
      // the session — liveNow ticks every 30 s, so the message can expire
      // while the banner is still visible. The service then refuses the
      // resume honestly via onError ("already expired"), but without this
      // the doc would stay liveLocationActive:true and the persisted
      // session would linger until the next mount's hygiene effect. Clean
      // up here (no second toast — onError already said so).
      try { await updateDoc(doc(db, 'chats', conversationId, 'messages', msg.id), { liveLocationActive: false }); } catch { /* intentionally ignored */}
      stopLiveLocation(conversationId);
      liveSessionRef.current = null;
      setLiveResumeNeeded(false);
    }
  };

  const sendContact = async (contact: ContactPayload) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    // W27f (P0-8 manifestation): a fresh DM has no exchanged key, so
    // the addDoc below used to fail closed forever with a generic
    // "check your connection" toast and 0 docs stored — the peer could
    // never ack because no announce existed. Announce first (same as
    // sendTextNow); the peer auto-acks from the chat list (W5b runner)
    // and a retry then sends.
    await announceKeyIfNeeded();
    try {
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        type: 'contact',
        text: contact.name,
        contactName: contact.name,
        contactPhone: contact.phone,
        ...(contact.avatar ? { contactAvatar: contact.avatar } : {}),
        // #89: store the picked app-user's uid (if any) so the card —
        // here and in Saved Messages — can offer a Message button.
        // Phone-only contacts carry no uid and get no button.
        ...(contact.contactUid ? { contactUid: contact.contactUid } : {}),
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'User',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        replyTo: replyToPayload(),
      });
      if (!isCommunity && partnerUid) {
        realtimeSync.sendMessage(partnerUid, {
          conversationId,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          type: 'contact',
          text: contact.name,
          contactName: contact.name,
          contactPhone: contact.phone,
          ...(contact.avatar ? { contactAvatar: contact.avatar } : {}),
          ...(contact.contactUid ? { contactUid: contact.contactUid } : {}),
          timestamp: Date.now(),
        });
      }
      setReplyTo(null);
      setShowContactModal(false);
      showToastMsg('Contact sent');
    } catch (err) {
      // Honest failure (user-test V3 pattern): never claim "sent" when the write failed.
      // W27f: an encryption failure means the keys aren't exchanged yet —
      // the announce above gives the peer a key to ack. Keep the modal
      // open (the picked contact stays) so the user can retry, and say
      // so plainly instead of blaming the connection.
      if (isEncryptionFailedError(err)) {
        showToastMsg('Encryption failed — contact not sent. Try again once the keys are exchanged.');
        return;
      }
      setShowContactModal(false);
      showToastMsg("Contact couldn't be sent. Check your connection and try again.");
    }
  };

  // PollCard hands over the voter's FULL selection (number[]) — single
  // votes too (1-element array). The whole array is stored, so a
  // multi-answer vote is never flattened back to one option; an empty
  // selection removes the vote. Legacy `pollVotes.<uid> = number` values
  // are still read fine (PollCard normalises them).
  const votePoll = async (msgId: string, selection: number[]) => {
    if (!conversationId || !currentUser) return;
    try {
      if (selection.length === 0) {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), {
          [`pollVotes.${currentUser.uid}`]: deleteField()
        });
      } else {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), {
          [`pollVotes.${currentUser.uid}`]: selection
        });
      }
    } catch (e) {
      // D3: a lost poll vote used to vanish silently — the user believed
      // their vote counted. Log it and say so.
      console.warn('[ChatScreen] poll vote failed to save:', e);
      showToastMsg('Vote could not be saved. Try again.');
    }
  };

  // WA audit (d) C15 — "Add to status": re-share a channel post as a
  // status. The post text (or poll question / caption) is queued in
  // sessionStorage and the Updates tab is opened; StatusScreen consumes
  // the queue and opens its composer prefilled. Media posts carry their
  // mediaUrl so the photo editor opens with the image instead. View-once
  // and deleted posts are excluded by the menu entry that calls this —
  // sharing them would defeat the one-time view / resurrect a delete.
  const addChannelPostToStatus = (m: any) => {
    const text =
      displayTextFor(m).text ||
      (m.type === 'poll' && m.pollQuestion ? `📊 ${m.pollQuestion}` : '') ||
      m.caption ||
      '';
    const mediaUrl = typeof m.mediaUrl === 'string' ? m.mediaUrl : '';
    const mediaType =
      m.mediaType || (m.type === 'image' ? 'image' : m.type === 'video' ? 'video' : '');
    if (!text.trim() && !mediaUrl) {
      showToastMsg('Nothing to share as a status');
      return;
    }
    queueChannelPostForStatus({
      text: text.trim(),
      sourceName: otherUser?.name || 'Channel',
      mediaUrl: mediaUrl || undefined,
      mediaType: mediaType || undefined,
      caption: m.caption || undefined,
    });
    showToastMsg('Opening status composer…');
    navigate('/main');
    // MainScreen mounts (and the lazy Updates tab activates) after the
    // route change; the queued payload survives in sessionStorage, and
    // the event wakes a StatusScreen that is already mounted.
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('pinglo:switch-tab', { detail: 'updates' }));
      notifyAddToStatus();
    }, 80);
  };

  // ── Group events (v1, client-only) — create + RSVP + reminder ──
  // Event docs are `type: 'event'` messages in this chat (see
  // components/groupEvents.ts); the existing subscription delivers them.
  const groupEventDocs = useMemo(
    () => messages.filter((m: any) => m?.type === 'event' && !m.deleted),
    [messages],
  );
  // uid -> display name for EventCard "Who's going" (from senders seen
  // in this chat; falls back to the uid in the card).
  const memberNamesByUid = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of messages) {
      if (m?.senderId && m?.senderName && !map[m.senderId]) map[m.senderId] = m.senderName;
    }
    return map;
  }, [messages]);

  const sendEvent = async (payload: EventComposerPayload) => {
    if (blockedGuard()) return;
    if (!canSend) { showToastMsg(isCommunityNonMember ? 'Join this group to send messages' : `Only admins can send messages in this ${isChannelDoc ? 'channel' : 'group'} 🔇`); return; }
    if (!conversationId || !currentUser) return;
    try {
      await createGroupEvent(conversationId, payload, { uid: currentUser.uid, displayName: currentUser.displayName });
      setShowEventModal(false);
      showToastMsg('Event created');
    } catch {
      setShowEventModal(false);
      showToastMsg("Couldn't save the event. Check your connection and try again.");
    }
  };

  const rsvpEvent = async (msgId: string, value: RsvpValue | null) => {
    if (!conversationId || !currentUser) return;
    try {
      await setEventRsvp(conversationId, msgId, currentUser.uid, value);
    } catch (e) {
      console.warn('[ChatScreen] RSVP failed to save:', e);
      showToastMsg('Response could not be saved. Try again.');
    }
  };

  const cancelEvent = async (msgId: string) => {
    if (!conversationId) return;
    try {
      await cancelGroupEvent(conversationId, msgId);
      showToastMsg('Event canceled');
    } catch {
      showToastMsg("Couldn't cancel the event. Try again.");
    }
  };

  const changeEventReminder = async (msgId: string, minutes: ReminderMinutes) => {
    if (!conversationId) return;
    try {
      await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), { reminderMinutes: minutes });
    } catch {
      showToastMsg("Couldn't save the reminder. Try again.");
    }
  };

  // In-app event reminders: when an event's reminder window opens, toast
  // once per event per device (localStorage flag; no push — closed-app
  // reminders need the push sender, BACKEND-PHASE).
  useEffect(() => {
    if (!isCommunity || groupEventDocs.length === 0) return;
    const due = dueEventReminders(groupEventDocs, loadRemindedEventIds());
    if (due.length === 0) return;
    for (const id of due) {
      const ev = groupEventDocs.find((m: any) => m.id === id);
      if (ev?.eventName) {
        showToastMsg(`Reminder: ${ev.eventName} — ${formatEventWhen(ev.startAt)}`);
      }
      markEventReminded(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupEventDocs, isCommunity]);

  // ── 4d: schedule via the server-backed service (localStorage only if offline) ──
  const sendScheduled = async () => {
    if (!schedText.trim() || !schedTime) { showToastMsg('Message aur time dono daalo'); return; }
    if (schedText.trim().length > 5000) { showToastMsg('Message too long (max 5,000 characters)'); return; }
    if (!conversationId || !currentUser || !chatId) return;
    const sendAt = new Date(schedTime).getTime();
    if (sendAt <= Date.now() + 5000) { showToastMsg('Future ka time select karo'); return; }
    try {
      const { stored } = await scheduledMessages.schedule({
        conversationId,
        chatId,
        isCommunity,
        text: schedText.trim(),
        sendAt,
      });
      setShowScheduleModal(false);
      setSchedText('');
      setSchedTime('');
      showToastMsg(
        stored === 'server'
          ? `Scheduled for ${new Date(sendAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : `Scheduled on this device for ${new Date(sendAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (will sync when online)`,
      );
    } catch {
      showToastMsg('Could not schedule message. Check your connection and try again.');
    }
  };

  const cancelScheduled = async (id: string) => {
    await scheduledMessages.cancel(id);
    showToastMsg('Scheduled message cancelled');
  };

  // R3: optimistic reaction — the chip updates in local `messages`
  // state immediately when tapped and rolls back if the server write
  // fails, instead of appearing only after the round-trip (which, with
  // the stale decrypt memo, effectively never showed live). The write
  // itself is unchanged (reaction-only, so `encryptableContentChanged`
  // stays false and nothing is re-encrypted). NOTE: the next snapshot
  // delivery can still clobber this optimistic chip until Worker A's R1
  // stale-decrypt-memo fix lands in database.ts — the optimistic update
  // is correct on its own, it just needs the memo fix to survive the
  // snapshot echo.
  const addReaction = async (msgId: string, emoji: string) => {
    if (!conversationId || !currentUser) return;
    const target = messages.find(m => m.id === msgId);
    const curReaction = target?.reactions?.[currentUser.uid];
    const nextEmoji = curReaction === emoji ? null : emoji;
    // NF-1 — gate the write itself (the choke point for picker, context
    // menu and toolbar alike). Removing my own reaction is always allowed.
    if (nextEmoji && isChannelDoc && !isReactionAllowed(channelReactionPolicy, nextEmoji)) {
      showToastMsg(channelReactionPolicy === 'none' ? 'Reactions are off in this channel' : 'Only default reactions are allowed in this channel');
      return;
    }
    const prevReactions = target?.reactions;
    const uid = currentUser.uid;
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      if (nextEmoji) return { ...m, reactions: { ...(m.reactions || {}), [uid]: nextEmoji } };
      if (!m.reactions || !(uid in m.reactions)) return m;
      const { [uid]: _removed, ...rest } = m.reactions;
      return { ...m, reactions: rest };
    }));
    try {
      if (nextEmoji) {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), {
          [`reactions.${currentUser.uid}`]: nextEmoji
        });
      } else {
        await updateDoc(doc(db, 'chats', conversationId, 'messages', msgId), {
          [`reactions.${currentUser.uid}`]: deleteField()
        });
      }
      if (!isCommunity && partnerUid) {
        realtimeSync.sendAction(partnerUid, {
          conversationId,
          type: 'reaction',
          msgId,
          payload: { uid: currentUser.uid, emoji: nextEmoji },
        });
      }
    } catch {
      // Roll back the optimistic chip so the UI never shows a reaction
      // that was never saved.
      setMessages(prev => prev.map(m => (m.id === msgId ? { ...m, reactions: prevReactions } : m)));
      showToastMsg('Reaction could not be saved. Try again.');
    }
    setShowReactPicker(null);
  };

  // Reaction pick: remember the emoji in recents, then use the
  // existing toggle-save (addReaction). ReactionPicker closes itself
  // after onSelect, and addReaction closes the popover layer.
  const pickReaction = (msgId: string, emoji: string) => {
    rememberReactionEmoji(emoji);
    void addReaction(msgId, emoji);
  };

  // Reply payload for a send. A staged cross-chat quote (Reply privately)
  // keeps its origin (fromChatId/fromChatName) so the quote preview on
  // the sent message can tell it apart from an in-chat quote — see the
  // guard on the reply preview below.
  const replyToPayload = () => replyTo ? {
    id: replyTo.id,
    text: replyTo.text || '[Media]',
    senderName: replyTo.senderName,
    // WA parity (DM audit rows 36/35): the quote needs the sender id
    // (per-sender colour) and media type (Photo/Video/… label).
    senderId: replyTo.senderId || null,
    mediaType: replyTo.mediaType || null,
    ...(replyTo.fromChatId ? { fromChatId: replyTo.fromChatId, fromChatName: replyTo.fromChatName } : {}),
  } : null;

  const copyMsg = async (text: string) => {
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Android WebViews often refuse the async clipboard API; use the older copy command
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    setCtxMenu(null);
    showToastMsg(ok ? 'Copied ✓' : 'Could not copy');
  };

  // WA parity (verify dm-4 row 62): Copy copies what the bubble shows —
  // the body text, or the media caption when there is no body text. A
  // media message's `text` is only its placeholder label ('Photo',
  // 'Video', 'Audio', …) — copying that label is wrong; the copyable
  // content of a captioned photo/video/audio/file is its caption, and a
  // caption-less media message has nothing to copy. A message that
  // failed to decrypt has no copyable text either: the placeholder must
  // never reach the clipboard (Translate already excludes it; Copy did
  // not).
  const copyableTextFor = (m: any): string => {
    if (!m || displayTextFor(m).state === 'decrypt-failed') return '';
    if (m.mediaUrl || m.mediaType) return captionFor(m) || '';
    return displayTextFor(m).text || '';
  };

  // WA parity (verify dm-4 row 72): voice notes and audio FILES share
  // mediaType 'audio' but must not render alike. A voice note is flagged
  // at send time (isVoiceNote); older notes are recognised by their
  // stored waveform peaks or the `voice_<ts>.webm` filename the recorder
  // uses — an mp3 picked via Attach → File has neither.
  const isVoiceNoteMsg = (m: any): boolean => {
    if (!m || m.mediaType !== 'audio') return false;
    if (m.isVoiceNote === true) return true;
    if (Array.isArray(m.waveform) && m.waveform.length > 0) return true;
    return /^voice_\d+\.webm$/i.test(typeof m.fileName === 'string' ? m.fileName : '');
  };

  // Nightshift forward caption (§6b): `caption` is the picker's edited
  // caption for a SINGLE forwarded message. When it is provided it wins
  // over the original (empty string clears it); a multi-forward keeps
  // each message's own caption, like before.
  // WA parity (DM audit rows 59–60): reset the forward session when the
  // picker opens — the 5-chat cap counts per forward session.
  useEffect(() => {
    if (forwardMsg) {
      setForwardSentCount(0);
      setForwardedTargetUids([]);
    }
  }, [forwardMsg]);

  const handleForwardTo = async (targetUserId: string, caption?: string) => {
    const list = forwardMsgs && forwardMsgs.length > 0 ? forwardMsgs : (forwardMsg ? [forwardMsg] : []);
    if (!list.length || !currentUser) return;
    // WA parity (DM audit row 84): a view-once message can never be
    // forwarded — the context menu blocks it, but multi-select used to
    // smuggle it through. Drop view-once items here (defense in depth);
    // the toolbar also filters them before opening the picker.
    const safeList = list.filter((fm: any) => !fm.isViewOnce);
    if (safeList.length < list.length) showToastMsg('View-once messages can’t be forwarded');
    if (!safeList.length) { setForwardMsg(null); setForwardMsgs(null); setForwardCaption(''); return; }
    // WA parity (DM audit row 60): one forward goes to at most 5 chats.
    if (forwardSentCount >= FORWARD_CAP) {
      showToastMsg('You can forward to up to 5 chats at a time', 6000);
      setForwardMsg(null);
      setForwardMsgs(null);
      setForwardCaption('');
      return;
    }
    if (forwardedTargetUids.includes(targetUserId)) {
      showToastMsg('Already forwarded to this chat');
      return;
    }
    // Phase 5 (L-12): nothing forwards out of a locked chat.
    if (isHidden) {
      showToastMsg('Locked chats can’t be forwarded');
      setForwardMsg(null);
      setForwardMsgs(null);
      setForwardCaption('');
      return;
    }
    // Report 3 #227/#235 (W5b): one DM-id derivation everywhere —
    // `getConversationId` (cleanId + sort), never a raw uid join.
    const targetCid = getConversationId(currentUser.uid, targetUserId);
    // 100M-F1 (W15g): a forward in a fresh DM used to go straight to
    // addDoc with no key announce, so it failed closed with a generic
    // toast AND never started the key exchange — retrying could never
    // help until the target chat was opened. Announce first, exactly
    // like the composer send path (`sendTextNow`): the announce is
    // 24h-throttled server-side, so this is a no-op when keys are
    // already exchanged. Self-forward skips it, like the composer send.
    // Honest limit: the forward itself still fails closed on the FIRST
    // attempt until the peer acks (same as a first text send — W5b);
    // the peer auto-acks from the chat list, then a re-forward lands.
    if (targetUserId !== currentUser.uid) {
      try {
        // NOTE (W15g, found by probe run 2): pass [] — NOT kxDocsRef.current.
        // kxDocsRef holds the CURRENT chat's protocol docs, and our keyId
        // is per-device, so our announce for the current chat sits in it;
        // ensureKeyAnnounce's server-truth check would find that announce
        // and return 'skipped' without writing anything for the TARGET
        // chat (the same false-positive the snapshot effect's reset comment
        // at the top of this file warns about). The target chat has no
        // loaded snapshot, so there is no server truth to check; the
        // per-chatId durable + localStorage throttles (checks b/c) still
        // guard against duplicate announces within 24h. Worst case of []
        // is a duplicate announce (same keyId) if one already exists on
        // the server with no local record — benign, the peer acks once.
        const res = await ensureKeyAnnounce(targetCid, currentUser.uid, [], async (cid, payload) => {
          await addDoc(collection(db, 'chats', cid, 'messages'), {
            ...payload, timestamp: Date.now(), senderId: currentUser.uid,
          });
        });
        if (res.status === 'established') setE2eeKeyReady(true);
        else if (res.announcedAt) setE2eeSetupAnnouncedAt(res.announcedAt);
      } catch {
        // Announce is best-effort (same as the composer send): a failed
        // announce leaves the forward to fail closed with the honest
        // encryption error below.
      }
    }
    try {
      for (const fm of safeList) {
        await addDoc(collection(db, 'chats', targetCid, 'messages'), {
          text: fm.text || '',
          type: fm.type || null,
          stickerId: fm.stickerId || null,
          stickerEmoji: fm.stickerEmoji || null,
          stickerLabel: fm.stickerLabel || null,
          stickerImage: fm.stickerImage || null,
          stickerAnimation: fm.stickerAnimation || null,
          latitude: fm.latitude ?? null,
          longitude: fm.longitude ?? null,
          locationLabel: fm.locationLabel || null,
          locationAccuracy: fm.locationAccuracy ?? null,
          // W27: forwarded live location is a static snapshot of the
          // position — no session behind it in the new chat, so it must
          // never render as live.
          liveLocationId: fm.liveLocationId || null,
          liveLocationExpiresAt: fm.liveLocationExpiresAt ?? null,
          liveLocationUpdatedAt: fm.liveLocationUpdatedAt ?? null,
          liveLocationActive: false,
          contactName: fm.contactName || null,
          contactPhone: fm.contactPhone || null,
          contactAvatar: fm.contactAvatar || null,
          mediaUrl: fm.mediaUrl || null,
          mediaType: fm.mediaType || null,
          // 100M-F2 (W15g): a captioned photo forwards with its caption —
          // the write pipeline re-encrypts it for the target chat.
          // Nightshift §6b: for a single forward the picker's caption
          // (edited, added, or cleared) replaces the original.
          caption: safeList.length === 1 && caption !== undefined
            ? (caption.trim() || null)
            : (fm.caption || null),
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          senderAvatar: currentUser.photoURL || '',
          // WA parity (DM audit rows 58–59): keep the ORIGINAL sender
          // across re-forwards, and count the hops — at 5+ the bubble
          // reads "Forwarded many times".
          forwardedFrom: fm.forwardedFrom || fm.senderName || 'Contact',
          forwardCount: (Number(fm.forwardCount) || 0) + 1,
          timestamp: serverTimestamp(),
          status: 'sent',
        });
      }
    } catch (e) {
      // D3: a failed forward used to fail silently — the success toast
      // above never fired, but neither did any failure message.
      console.warn('[ChatScreen] forward failed:', e);
      // 100M-F1 (W15g): say WHY, like the composer send does (W24b's
      // sendSticker precedent) — "Forward failed" alone hides that the
      // keys simply aren't exchanged yet.
      showToastMsg(
        isEncryptionFailedError(e)
          ? 'Encryption failed — message not sent. Try again once the keys are exchanged.'
          : 'Forward failed. Try again.',
      );
      // A failed forward closes the picker (old behaviour) — the user
      // re-opens it to retry; a success stays open for more targets.
      setForwardMsg(null);
      setForwardMsgs(null);
      setForwardCaption('');
      setSelectedIds([]);
      return;
    }
    // Success: the picker STAYS open so one forward can reach up to 5
    // chats (WA cap, row 60); it closes itself at the cap.
    const n = forwardSentCount + 1;
    setForwardSentCount(n);
    setForwardedTargetUids((prev) => [...prev, targetUserId]);
    setSelectedIds([]);
    if (n >= FORWARD_CAP) {
      showToastMsg('Forwarded to 5 chats — that’s the limit for one forward', 6000);
      setForwardMsg(null);
      setForwardMsgs(null);
      setForwardCaption('');
    } else {
      showToastMsg(`Forwarded ✓ (${n} of ${FORWARD_CAP} chats) — pick another chat or close`);
    }
  };

  // ── WA parity (DM audit rows 9, 11): Mark as unread + Report ──
  // Mark-as-unread writes the same chatPrefs flag the chat-list
  // long-press uses (`markedUnread`), so the list shows its unread dot;
  // WA then returns to the list, so we navigate there too.
  const handleMarkAsUnread = async () => {
    const myUid = currentUser?.uid;
    const key = chatMuteKeyRef.current || partnerUid;
    if (!myUid || !key || isCommunity) return;
    const nextPref = { ...chatMutePrefRef.current, markedUnread: true };
    chatMutePrefRef.current = nextPref;
    try {
      await updateDoc(doc(db, 'users', myUid), { [`chatPrefs.${key}`]: nextPref });
    } catch {
      try {
        const local = loadLocalChatPrefs(myUid);
        saveLocalChatPrefs(myUid, { ...local, [key]: nextPref });
      } catch { /* toast still fires below; the list re-reads the server value later */ }
    }
    showToastMsg('Marked as unread');
    navigate('/main');
  };

  // Report: stores a report (services/report.ts — top-level `reports`
  // collection for admin review) AND blocks the contact, like WhatsApp's
  // Report action. Reporting alone never blocks; this menu entry does both.
  const handleReport = async (reason: ReportReason) => {
    if (!currentUser?.uid || !partnerUid || isCommunity) return;
    setShowReportConfirm(false);
    try {
      await submitReport(
        { reportedUid: partnerUid, reportedUsername: otherUser?.username || otherUser?.displayName, reason },
        currentUser.uid,
        currentUser.displayName || currentUser.username,
      );
      if (!isBlocked) {
        try {
          await updateDoc(doc(db, 'users', currentUser.uid), { blockedUsers: arrayUnion(partnerUid) });
        } catch { /* report is stored; block failure is toasted below */ }
      }
      showToastMsg('Reported. This contact is blocked.');
    } catch {
      showToastMsg('Could not send the report. Try again.');
    }
    setShowMenu(false);
  };

  const toggleHideChat = async () => {
    if (!currentUser || !partnerUid) return;
    try {
      // Phase 5: writes the PRIVATE locked doc (lockedChats.ts) and
      // deletes any legacy public copy — never writes users/{uid}.hiddenChats.
      await setChatLocked(partnerUid, !isHidden);
      if (!isHidden) {
        // Hiding a chat ends the folder session for it immediately.
        lockLockedFolder();
        setLockedGatePassed(false);
      }
    } catch (e) {
      // D3: a failed lock/unlock used to fail silently, leaving the chat
      // looking locked/unlocked when it is not.
      console.warn('[ChatScreen] lock/unlock chat failed:', e);
      showToastMsg('Could not lock/unlock this chat. Try again.');
    }
    setShowMenu(false);
  };

  const toggleBlockUser = async () => {
    if (!currentUser || !partnerUid) return;
    const ref = doc(db, 'users', currentUser.uid);
    try {
      if (isBlocked) await updateDoc(ref, { blockedUsers: arrayRemove(partnerUid) });
      else await updateDoc(ref, { blockedUsers: arrayUnion(partnerUid) });
      // WA audit #9 — keep the localStorage blocked mirror in sync so
      // the call service can block a caller at ring time even before
      // the users collection has loaded (cold boot). Mirror only on
      // success; a failed write leaves the mirror matching the doc.
      const nextBlocked = isBlocked
        ? getBlockedIdsLocal(currentUser.uid).filter((id) => id !== partnerUid)
        : [...new Set([...getBlockedIdsLocal(currentUser.uid), partnerUid])];
      setBlockedIdsLocal(currentUser.uid, nextBlocked);
    } catch (e) {
      // D3: a failed block/unblock used to fail silently, leaving the user
      // believing the contact was blocked (or unblocked) when it was not.
      console.warn('[ChatScreen] block/unblock failed:', e);
      showToastMsg('Could not update block. Try again.');
    }
    setShowMenu(false);
  };

  // Called by GroupInfoModal after the current user leaves the group, so the
  // chat screen (which they are no longer a member of) is closed.
  const handleLeaveGroup = () => {
    navigate('/main');
  };

  // ── Disappearing messages: save the per-chat timer on the chat doc ──
  const setDisappearTimer = async (value: DisappearAfterMs) => {
    if (!conversationId) return;
    // No change → just close; re-posting the system message every time
    // the modal opens would spam the chat.
    if (value === disappearAfter) {
      setShowDisappearModal(false);
      setShowMenu(false);
      return;
    }
    try {
      await setDoc(doc(db, 'chats', conversationId), { disappearAfter: value }, { merge: true });
      setDisappearAfter(value);
      setDisappearNow(Date.now());
      // WA parity (DM audit row 31): a centred system message so the
      // peer's chat shows the change too ("You turned on…" for me,
      // "{Name} turned on…" for them — rendered per-viewer by
      // systemEventText, same pattern as postGroupEvent).
      try {
        await addDoc(collection(db, 'chats', conversationId, 'messages'), {
          type: 'system',
          systemEvent: value ? 'disappearing-on' : 'disappearing-off',
          actorUid: currentUser.uid,
          actorName: currentUser.displayName || currentUser.username || 'User',
          text: value
            ? `${currentUser.displayName || currentUser.username || 'Someone'} turned on disappearing messages.`
            : `${currentUser.displayName || currentUser.username || 'Someone'} turned off disappearing messages.`,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'User',
          timestamp: serverTimestamp(),
          status: 'sent',
        });
      } catch { /* non-fatal: the timer itself already saved */ }
      showToastMsg(value ? `Messages will disappear after ${disappearLabel(value)}` : 'Disappearing messages off');
    } catch {
      showToastMsg('Could not change disappearing messages. Try again.');
    }
    setShowDisappearModal(false);
    setShowMenu(false);
  };

  // #86: one transcript line per message, shared by "Save entire chat"
  // and the .txt export. Media is no longer reduced to a bare "[image]":
  // photos / videos / files / voice carry file name + size and — for
  // remote (http/https) URLs — the URL itself, so the saved copy can
  // still open or download them. Local data: URLs cannot be embedded in
  // text (they are megabytes of base64), so the line says honestly that
  // the media lives in the original chat. Polls, locations and contacts
  // carry their structured content instead of a bare text label.
  const archiveMediaRef = (m: any): string => {
    const url = typeof m.mediaUrl === 'string' ? m.mediaUrl : '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    return 'media is in the original chat (not attached to this saved copy)';
  };
  const archiveLineFor = (m: any, fallbackName: string): string => {
    const timeStr = formatTime(m.timestamp);
    const sender = isMe(m) ? 'You' : (m.senderName || fallbackName);
    const size = m.fileSize ? ` (${formatFileSize(m.fileSize)})` : '';
    const name = m.fileName ? ` ${m.fileName}` : '';
    if (m.type === 'poll' && m.pollQuestion) {
      const opts = Array.isArray(m.pollOptions) ? m.pollOptions : [];
      const votes = m.pollVotes && typeof m.pollVotes === 'object' ? m.pollVotes : {};
      const optText = opts
        .map((o: any, i: number) => {
          const count = Object.values(votes).filter((v: any) =>
            Array.isArray(v) ? v.includes(i) : v === i,
          ).length;
          return `${typeof o === 'string' ? o : o?.text || `Option ${i + 1}`} (${count} votes)`;
        })
        .join(', ');
      return `[${timeStr}] ${sender}: 📊 Poll: ${m.pollQuestion}${optText ? ` — ${optText}` : ''}`;
    }
    if (m.type === 'location' && typeof m.latitude === 'number' && typeof m.longitude === 'number') {
      const label = m.locationLabel ? ` ${m.locationLabel} —` : '';
      return `[${timeStr}] ${sender}: 📍 Location:${label} ${m.latitude}, ${m.longitude} (https://maps.google.com/?q=${m.latitude},${m.longitude})`;
    }
    if (m.type === 'contact' && (m.contactName || m.contactPhone)) {
      return `[${timeStr}] ${sender}: 👤 Contact: ${m.contactName || 'Unknown'}${m.contactPhone ? ` — ${m.contactPhone}` : ''}`;
    }
    if (m.type === 'sticker') {
      return `[${timeStr}] ${sender}: ${m.stickerEmoji || '😀'} Sticker${m.stickerLabel ? ` (${m.stickerLabel})` : ''}`;
    }
    if (m.mediaType === 'image') {
      return `[${timeStr}] ${sender}: 📷 Photo:${name}${size} — ${archiveMediaRef(m)}`;
    }
    if (m.mediaType === 'video') {
      return `[${timeStr}] ${sender}: 📹 Video:${name}${size} — ${archiveMediaRef(m)}`;
    }
    if (m.mediaType === 'audio') {
      const secs = typeof m.duration === 'number' ? ` (${m.duration}s)` : '';
      return `[${timeStr}] ${sender}: 🎙️ Voice message${secs}:${name}${size} — ${archiveMediaRef(m)}`;
    }
    if (m.mediaType === 'file') {
      return `[${timeStr}] ${sender}: 📄${name}${size} — ${archiveMediaRef(m)}`;
    }
    if (m.mediaUrl) {
      return `[${timeStr}] ${sender}: [${m.mediaType || 'Media'}]${name}${size} — ${archiveMediaRef(m)}`;
    }
    return `[${timeStr}] ${sender}: ${m.text || `[${m.mediaType || 'Media'}]`}`;
  };
  // Structured media manifest for the saved transcript doc: one entry per
  // media message so a future Saved render can offer downloads without
  // parsing the text. Remote URLs are stored; local data: URLs are NOT
  // duplicated (they already live on the original message doc — copying
  // megabytes of base64 would double storage), only flagged as local.
  const archiveMediaManifest = (msgs: any[]): any[] =>
    msgs
      .filter((m) => m.mediaUrl)
      .map((m) => {
        const url = typeof m.mediaUrl === 'string' ? m.mediaUrl : '';
        const remote = url.startsWith('http://') || url.startsWith('https://');
        return {
          messageId: m.id || null,
          mediaType: m.mediaType || null,
          fileName: m.fileName || null,
          fileSize: m.fileSize ?? null,
          duration: m.duration ?? null,
          ...(remote ? { mediaUrl: url } : { localOnly: true }),
          ...(m.posterUrl ? { posterUrl: m.posterUrl } : {}),
        };
      });

  const saveEntireChat = async () => {
    if (!currentUser) return;
    // Phase 5 (L-10): a locked chat's transcript cannot be saved.
    if (isHidden) {
      showToastMsg('Locked chats can’t be saved');
      setShowMenu(false);
      return;
    }
    if (visibleMsgs.length === 0) {
      showToastMsg('No messages to save yet');
      setShowMenu(false);
      return;
    }
    const savedCid = `saved_${currentUser.uid}`;
    const targetName = isCommunity ? (otherUser?.name || 'Group') : (otherUser?.displayName || otherUser?.username || 'User');
    const header = `📁 Saved Chat with ${targetName} (${visibleMsgs.length} messages):\n\n`;
    // #86: media / poll / location / contact lines carry their content
    // (see archiveLineFor) instead of "[image]" placeholders.
    const transcript = visibleMsgs.map((m) => archiveLineFor(m, targetName)).join('\n');

    try {
      await addDoc(collection(db, 'chats', savedCid, 'messages'), {
        text: header + transcript,
        senderId: currentUser.uid,
        senderName: 'Saved Chat Archive',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        originalFrom: targetName,
        originalChatId: chatId,
        // #86: structured media manifest (remote URLs directly usable).
        chatArchiveMedia: archiveMediaManifest(visibleMsgs),
      });
      showToastMsg('Chat saved to Saved Messages');
    } catch (err) {
      console.error('Failed to save entire chat:', err);
      showToastMsg('Failed to save chat');
    }
    setShowMenu(false);
  };

  const exportChatTxt = () => {
    // Phase 5 (L-11): a locked chat cannot be exported as .txt.
    if (isHidden) {
      showToastMsg('Locked chats can’t be exported');
      setShowMenu(false);
      return;
    }
    if (visibleMsgs.length === 0) {
      showToastMsg('No messages to export');
      setShowMenu(false);
      return;
    }
    const targetName = isCommunity ? (otherUser?.name || 'Group') : (otherUser?.displayName || otherUser?.username || 'User');
    const header = `==============================\nPINGLO EXPORT: ${targetName}\nDate: ${new Date().toLocaleString()}\nMessages: ${visibleMsgs.length}\n==============================\n\n`;
    // #86: same media-preserving lines as "Save entire chat".
    const transcript = visibleMsgs.map((m) => archiveLineFor(m, targetName)).join('\n');

    try {
      const blob = new Blob([header + transcript], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Chat_${(targetName || 'User').replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToastMsg('Chat exported as .txt');
    } catch (e) {
      console.error('Export failed:', e);
      showToastMsg('Export failed');
    }
    setShowMenu(false);
  };

  const handleCall = async (type: 'audio' | 'video') => {
    if (!currentUser || !partnerUid) return;
    // 100M-H12 — startCall used to bail out silently mid-call, so the
    // header call button looked dead. Say so.
    const res = await callService.startCall({
      targetUserId: partnerUid,
      targetUserName: isCommunity ? otherUser?.name : (otherUser?.displayName || otherUser?.username || 'User'),
      targetUserAvatar: otherUser?.photoURL || '',
      type,
    });
    if (res === 'already-in-call') showToastMsg("You're already in a call", 4000);
  };

  // ── Toast ──
  const [toast, setToast] = useState('');
  const toastTimer = useRef<NodeJS.Timeout | null>(null);
  // #210: toasts used to live only 2.5s — validation / error toasts were
  // gone before anyone could read them. Errors now stay 6s; the default
  // (short confirmations) is unchanged. Pass an explicit duration to
  // override.
  const showToastMsg = (msg: string, durationMs = 2500) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), durationMs);
  };

  // ── Context menu ──
  const openCtx = (e: React.MouseEvent | React.TouchEvent, msg: any) => {
    e.preventDefault();
    const x = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const y = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    setCtxMenu({ msg, x: Math.min(x, window.innerWidth - 200), y: Math.min(y, window.innerHeight - 260) });
  };

  // ── Formatting helpers ──
  // Coordinator fix (crash): a corrupt message doc can carry
  // `timestamp: { toDate: 'not-a-function' }` — a truthy check
  // (`ts.toDate ?`) still calls it and throws inside render. Guard with
  // typeof + try/catch so one bad doc can never crash the chat.
  const toDateSafe = (ts: any): Date => {
    try {
      if (ts && typeof ts.toDate === 'function') return ts.toDate();
      const d = new Date(ts || Date.now());
      return Number.isNaN(d.getTime()) ? new Date() : d;
    } catch { return new Date(); }
  };

  const formatTime = (ts: any) => {
    if (!ts) return '';
    const d = toDateSafe(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // G2d: an unopened view-once message expires after 14 days
  // (WhatsApp rule). A pending serverTimestamp reads as "now"
  // (toDateSafe), so a just-sent message is never expired.
  const VIEW_ONCE_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
  const isViewOnceExpired = (m: any) => {
    if (!m?.isViewOnce || m.viewed) return false;
    const at = toDateSafe(m.timestamp).getTime();
    return at > 0 && Date.now() - at > VIEW_ONCE_EXPIRY_MS;
  };

  const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  // ── Filtered messages (removing deleted-for-me + expired disappearing messages) ──
  // ROADMAP-2 item 10: a cleared chat hides messages at/before the
  // per-user clearedAt stamp for THIS user only. Nothing is deleted —
  // the other side still sees them — and messages sent after the stamp
  // keep showing. A pending serverTimestamp reads as "now" (toDateSafe),
  // so a just-sent message is never hidden by its own clear.
  // #20: memoized — the plain .filter() used to re-scan every message
  // (isMessageExpired + toDateSafe per message) on EVERY render,
  // including every keystroke. Now it recomputes only when its inputs
  // change, and the memos below inherit the stable reference.
  const visibleMsgs = useMemo(() => messages.filter(m => !deletedForMeIds.includes(m.id) && !isMessageExpired(m, disappearAfter, disappearNow) && (!clearedAt || toDateSafe(m.timestamp).getTime() > clearedAt)), [messages, deletedForMeIds, disappearAfter, disappearNow, clearedAt]);
  // ── Phase 4: chat pagination — render-layer only ──
  // The Firestore onSnapshot subscription still loads the full collection:
  // a query-level limit/startAfter cursor would break the live subscription
  // and the read-receipt effect that iterates `messages`. Pagination caps
  // how many bubbles are RENDERED — newest 50 first, "Load more" (button
  // or scroll-up) reveals older pages. This saves DOM/render cost, NOT
  // Firestore reads or bandwidth. Honest limit, documented here and in the
  // Phase 4 PATCH notes. Searching bypasses paging so all matches show.
  const PAGE_SIZE = 50;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [conversationId]);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const hasMoreMessages = !searchQuery && visibleMsgs.length > visibleCount;
  const pagedMsgs = useMemo(() => (searchQueryDebounced ? visibleMsgs : visibleMsgs.slice(-visibleCount)), [visibleMsgs, visibleCount, searchQueryDebounced]);
  // #130: re-entry guard — a scroll event firing twice (or the button
  // + scroll together) must not add two pages at once.
  const loadMoreMessages = () => {
    if (loadMoreGuardRef.current) return;
    loadMoreGuardRef.current = true;
    setTimeout(() => { loadMoreGuardRef.current = false; }, 300);
    const el = messagesScrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setVisibleCount((c) => c + PAGE_SIZE);
    // Keep the user's scroll position after older messages are prepended.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el2 = messagesScrollRef.current;
        if (el2) el2.scrollTop += el2.scrollHeight - prevHeight;
      });
    });
  };
  const handleMessagesScroll = () => {
    const el = messagesScrollRef.current;
    if (!el) return;
    // #29: show the jump-to-bottom button once the user has scrolled up
    // more than a screenful-ish distance from the latest message.
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToBottom(distFromBottom > 120);
    // P0-2 (W24 R7): only treat top < 80 as "user scrolled up" once
    // this conversation's container has actually been at the bottom.
    // Before that, top < 80 is the opening smooth-scroll animation,
    // not a user gesture — loading older messages there grows the page
    // 50 -> 100 before any typing.
    if (distFromBottom <= 120) reachedBottomRef.current = true;
    // W13 NEXT R8 (B3): fire load-more only on the CROSSING into the
    // top zone (previous scrollTop >= 80, this one < 80), or on a
    // deliberate user gesture. A long stepped scroll-up used to re-fire
    // on every event while dwelling below 80 (3 pages on one gesture in
    // the probe: 400 -> 250). One crossing = one page, repeatable: after
    // a load the position-preserving jump puts the user mid-list, so the
    // next scroll-up crosses again. The user-gesture flag is only
    // consumed in the top zone, so a scroll-up started mid-list keeps it
    // until the crossing — the during-animation bypass still works.
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const crossedTop = prevTop >= 80 && el.scrollTop < 80;
    const userUp = userScrollUpRef.current;
    if (el.scrollTop < 80) userScrollUpRef.current = false;
    if (!hasMoreMessages) return;
    if (el.scrollTop < 80 && (crossedTop || userUp) && (userUp || (!initialScrollRef.current && reachedBottomRef.current))) loadMoreMessages();
  };
  // #29: the jump-to-bottom button's action (also used after sending).
  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };
  // ── E2EE (Worker 3: CHAT UI) — display text + decrypt effects ──
  // Wired to the real contract in src/services/e2eeChat.ts (Worker E2):
  //   getChatEncryptionState(chatId, docs?) -> 'e2ee' | 'legacy' | 'mixed' | 'none' (sync)
  //   decryptIncoming(doc, chatId?)         -> doc with plaintext restored in
  //                                            `text` (never throws; failure
  //                                            returns encryption:'decrypt-failed',
  //                                            decryptError:true, placeholder text)
  //   isEncryptedDoc(doc)                   -> well-formed v1 envelope in `e2ee`
  // NOTE on the id: keys are scoped by the COLLECTION id
  // (`chats/{conversationId}/messages`), so both calls get `conversationId`
  // (falling back to the route `chatId`), NOT the peer uid alone — passing
  // the wrong id makes every decrypt fail (no key found for that scope).
  // NOTE on envelope shape: e2eeChat.ts treats crypto.ts's
  // `{ v, alg, iv, ct, kid? }` as canonical. envelope.ts defines a
  // DIFFERENT `e2ee` shape ({ v, chatId, senderId, iv, ciphertext, alg }),
  // so this screen deliberately does NOT use envelope.ts helpers.

  // One cached decrypt outcome per message id. 'pending' is transient
  // (decrypt in flight). `replyText` is the decrypted quoted reply, so the
  // reply preview above a bubble shows the real quote, not ''.
  type DecryptEntry = {
    status: 'ok' | 'failed' | 'pending';
    text: string;
    replyText?: string;
    // 100M-F2: the decrypted media caption (same path as `text` — the
    // adapter restores `msg.caption` too, this is the fallback when it
    // hasn't yet). Undefined when the message has no caption envelope.
    caption?: string;
  };
  // Placeholder for a message whose envelope could not be decrypted —
  // never blank, never a crash, never the (absent) plaintext. Wording is
  // this task's spec; e2eeChat.ts's own DECRYPT_FAILED_PLACEHOLDER
  // ('🔒 This message couldn't be decrypted') differs — coordinator to
  // reconcile to one placeholder app-wide.
  const DECRYPT_FAILED_TEXT = "Couldn't decrypt this message";

  // True when the doc carries an encrypted body. `isEncryptedDoc` is the
  // strict canonical (crypto.ts) check; a present-but-malformed `e2ee`
  // field also counts, so a corrupt envelope shows the decrypt-failed
  // placeholder instead of silently rendering as a legacy message.
  const isE2eeDoc = (msg: any): boolean =>
    !!msg && (isEncryptedDoc(msg) || (msg.e2ee != null && typeof msg.e2ee === 'object'));

  // The text a bubble should show. Legacy (unencrypted) messages render
  // exactly as before (`msg.text` untouched); encrypted messages render
  // their decrypted text; decrypt failures render the placeholder.
  const displayTextFor = (msg: any): { text: string; replyText?: string; state: 'plain' | 'e2ee' | 'decrypt-failed' | 'decrypting' } => {
    if (!msg) return { text: '', state: 'plain' };
    // A doc already marked failed (e.g. by the adapter's read hook).
    if (msg.decryptError === true || msg.encryption === 'decrypt-failed') {
      return { text: DECRYPT_FAILED_TEXT, state: 'decrypt-failed' };
    }
    if (isE2eeDoc(msg)) {
      // Worker A: the DB layer may already have decrypted this doc (e.g.
      // the peer key arrived after the first attempt failed — the memo
      // heals and re-delivers plaintext). Prefer that plaintext over a
      // stale local 'failed' entry, or the message stays "couldn't
      // decrypt" forever even though the key is now held.
      if (typeof msg.text === 'string' && msg.text.length > 0 && msg.encryption === 'e2ee' && msg.decryptError !== true) {
        return { text: msg.text, replyText: typeof msg.replyTo?.text === 'string' ? msg.replyTo.text : undefined, state: 'e2ee' };
      }
      const entry = decrypted[msg.id];
      if (entry?.status === 'ok') return { text: entry.text, replyText: entry.replyText, state: 'e2ee' };
      if (entry?.status === 'failed') return { text: DECRYPT_FAILED_TEXT, state: 'decrypt-failed' };
      return { text: '', state: 'decrypting' };
    }
    return { text: typeof msg.text === 'string' ? msg.text : '', state: 'plain' };
  };

  // 100M-H22: the searchable text of a message — the body text PLUS the
  // media caption. displayTextFor returns only msg.text; the caption
  // travels on a separate field (adapter-decrypted msg.caption, or the
  // decrypt cache for E2EE captions), so a caption-only word never
  // matched before. Used by the search filter below only.
  const searchTextFor = (msg: any): string => {
    const text = displayTextFor(msg).text || '';
    const caption = (typeof msg.caption === 'string' && msg.caption.length > 0 ? msg.caption : decrypted[msg.id]?.caption) || '';
    return caption ? `${text} ${caption}` : text;
  };

  // Chat-level encryption state, computed from the loaded docs (sync, no
  // registry guesswork). 'mixed' counts as encrypted for the pill: the
  // chat HAS encrypted messages. Reset on chat change so the previous
  // chat's state never flashes in the next one.
  useEffect(() => {
    setE2eeChatState('unknown');
    setE2eeKeyReady(false);
    setE2eeSetupAnnouncedAt(null);
    setShowE2EESheet(false);
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return;
    try {
      const s = getChatEncryptionState(conversationId || chatId, messages);
      setE2eeChatState(s === 'e2ee' || s === 'mixed' ? 'e2ee' : s === 'legacy' ? 'legacy' : 'unknown');
    } catch {
      setE2eeChatState('unknown');
    }
  }, [chatId, conversationId, messages]);

  // Fix worker B (#3): throttle for the automatic key re-request in the
  // decrypt effect below — one auto re-request per chat per 60 s, so a
  // batch of 'no-key' failures fires exactly one announce instead of
  // one per message. Keyed by conversation id; never cleared (a stale
  // entry only delays the next auto re-request by up to 60 s).
  const lastAutoKeyReRequestRef = useRef<Record<string, number>>({});

  // Decrypt the encrypted messages currently rendered (paged slice, or all
  // matches while searching). Bounded to what's on screen so a long history
  // doesn't fire hundreds of decrypts at once; "Load older messages"
  // re-runs this via `visibleCount`. Results are cached in `decrypted`,
  // so re-renders and read-receipt snapshot updates never re-decrypt.
  useEffect(() => {
    const rendered = searchQuery ? visibleMsgs : visibleMsgs.slice(-visibleCount);
    const targets = rendered.filter((m) => isE2eeDoc(m) && !m.deleted && !decrypted[m.id]);
    if (targets.length === 0) return;
    let cancelled = false;
    // Mark pending first so a re-render can't queue the same message twice.
    setDecrypted((prev) => {
      const next = { ...prev };
      for (const m of targets) if (!next[m.id]) next[m.id] = { status: 'pending', text: '' };
      return next;
    });
    (async () => {
      // Fix worker B (#3): set when any message in this batch fails
      // with 'no-key' (no peer public key stored) — the trigger for
      // the automatic key re-request after the loop.
      let sawNoKey = false;
      for (const m of targets) {
        let entry: DecryptEntry;
        try {
          // decryptIncoming never throws per its contract; the try/catch
          // is belt-and-braces so a crypto failure can never crash the list.
          // The collection id (conversationId) is passed so the key lookup
          // uses the same scope the send side encrypted with.
          const out = await decryptIncoming(m, conversationId || chatId, currentUser?.uid ?? '');
          if (out?.decryptError === true || out?.encryption === 'decrypt-failed') {
            entry = { status: 'failed', text: '' };
            // 'no-key' means the peer's public key never landed on this
            // phone — the key exchange never completed here. 'bad-key'
            // is NOT collected: the key exists but GCM auth failed, so
            // a re-request cannot heal it (the peer must resend after
            // a fresh exchange, and the 1A/1B/1C fix makes the next
            // send/mount re-announce our current key).
            if ((out as any)?.decryptFailureReason === 'no-key') sawNoKey = true;
          } else if (typeof out?.text === 'string' && out.text.length > 0) {
            entry = {
              status: 'ok',
              text: out.text,
              replyText: typeof out.replyTo?.text === 'string' ? out.replyTo.text : undefined,
              // 100M-F2: caption from the same decrypt pass (out.caption
              // is restored by decryptIncoming from the e2eeCaption
              // envelope; the placeholder means caption-decrypt failed).
              caption: typeof out.caption === 'string' && out.caption.length > 0 ? out.caption : undefined,
            };
          } else {
            entry = { status: 'failed', text: '' };
          }
        } catch {
          entry = { status: 'failed', text: '' };
        }
        if (cancelled) return;
        setDecrypted((prev) => ({ ...prev, [m.id]: entry }));
      }
      // Fix worker B (#3): a 'no-key' failure means the key exchange
      // never completed on this phone — re-request the peer's key
      // automatically (the exact announce the manual "Retry decryption"
      // button sends), instead of leaving the bubble stuck on
      // "Couldn't decrypt" until the user taps it. Throttled to one
      // auto re-request per chat per 60 s; never toasts — this is an
      // automatic path, and the manual Retry, next chat open, and
      // next send still re-request as before. Fail-closed is untouched:
      // nothing renders as plaintext; only the key is re-requested.
      if (sawNoKey && !cancelled) {
        const cid = conversationId || chatId;
        const now = Date.now();
        if (cid && currentUser?.uid && now - (lastAutoKeyReRequestRef.current[cid] ?? 0) >= 60000) {
          lastAutoKeyReRequestRef.current[cid] = now;
          void (async () => {
            try {
              const announce = isCommunity
                ? await requestGroupKeyReExchange(cid, currentUser.uid)
                : await requestKeyReExchange(cid, currentUser.uid);
              await addDoc(collection(db, 'chats', cid, 'messages'), {
                ...announce, timestamp: Date.now(), senderId: currentUser.uid,
              });
            } catch {
              // Best-effort only: a failed auto re-request is retried
              // by the manual Retry button, the mount effect, or the
              // next send. Never crash the list from here.
            }
          })();
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, visibleCount, searchQuery, decrypted, conversationId, chatId]);

  // Worker A: a message that failed to decrypt BEFORE the peer key
  // arrived must be retried once keys are ready — otherwise it shows
  // "couldn't decrypt" forever even though the key is now held (the
  // decrypt effect above only targets messages with no cached entry).
  // Dropping the failed entries makes that effect re-run them.
  // e2eeKeyReady flips only on a real key establishment, so a still-
  // failing message (bad key) is retried once and then stays failed —
  // this cannot loop.
  useEffect(() => {
    if (!e2eeKeyReady) return;
    setDecrypted((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of Object.keys(next)) {
        if (next[id]?.status === 'failed') { delete next[id]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [e2eeKeyReady]);

  // Fix worker B (#3): the Worker-A effect above only clears cached
  // failures when `e2eeKeyReady` flips. A peer key that arrives while
  // it is already true — or a rotation that replaces the key — never
  // flips it, so those bubbles stayed "Couldn't decrypt" until a
  // manual Retry tap. Subscribe to the key-change events directly: the
  // moment a peer key lands, drop the cached failures and the decrypt
  // effect above re-runs those messages with the new key. `null` means
  // every chat (identity rotation / wipe). One retry per key event — a
  // message that still fails just stays failed; this cannot loop.
  // The group subscription is the same pattern for sender keys: a
  // member's late key heals their earlier messages the same way
  // (mirrors the DB-layer subscriptions in database.ts).
  useEffect(() => {
    const cid = conversationId || chatId;
    if (!cid) return;
    const dropFailed = (changedChatId: string | null) => {
      if (changedChatId !== null && changedChatId !== cid) return;
      setDecrypted((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          if (next[id]?.status === 'failed') { delete next[id]; changed = true; }
        }
        return changed ? next : prev;
      });
    };
    const unsubPeer = onPeerKeyChanged(dropFailed);
    const unsubGroup = onGroupKeyChanged(dropFailed);
    return () => { unsubPeer(); unsubGroup(); };
  }, [conversationId, chatId]);

  // The notice pill shows when the chat IS encrypted: a shared key has
  // been agreed with the peer AND at least one message carries an
  // envelope. A key alone encrypts nothing, and an envelope from an
  // older same-device key does not prove the peer can read it.
  const chatIsEncrypted = useMemo(
    () => e2eeKeyReady && (e2eeChatState === 'e2ee' || messages.some((m) => isE2eeDoc(m))),
    [e2eeKeyReady, e2eeChatState, messages],
  );
  // Honest "not yet" state for 1-to-1 chats: keys not exchanged yet, so
  // under AUDIT-2 A10 fail-closed messages can't send until they are
  // (a failure returns the text to the composer). Groups never get this
  // banner — they get their own "setting up" banner below (W16 #183:
  // groups have sender-key exchange now, so the group banner is the
  // same honest "setting up" wording, not "groups have no encryption").
  const showE2eeSetupBanner =
    !isCommunity && !chatIsEncrypted && !e2eeKeyReady && messagesLoaded;

  // Report 3 #26 (W5b): explicit encryption-setup state machine
  // (derived, no new server field). The 120 s `timed-out` threshold is
  // UI-only: keys can still arrive after it (the snapshot effect keeps
  // processing acks); timing out never cancels the exchange and never
  // writes plaintext. No auto-retry loop: a failed announce is retried
  // on manual Retry tap, next chat open (mount effect), or next send
  // attempt (`sendTextNow`) — never on a timer.
  const e2eeSetupState: 'ready' | 'announcing' | 'waiting-for-peer' | 'timed-out' | 'not-started' =
    e2eeKeyReady
      ? 'ready'
      : e2eeSetupAnnouncedAt == null
        ? (typeof navigator !== 'undefined' && !navigator.onLine ? 'not-started' : 'announcing')
        : e2eeSetupNow - e2eeSetupAnnouncedAt < 30_000
          ? 'announcing'
          : e2eeSetupNow - e2eeSetupAnnouncedAt < 120_000
            ? 'waiting-for-peer'
            : 'timed-out';
  // 5 s clock for the state machine above — only while the setup banner
  // is visible, so an established chat pays no timer.
  useEffect(() => {
    if (!showE2eeSetupBanner) return;
    const t = setInterval(() => setE2eeSetupNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [showE2eeSetupBanner]);
  // Transient "keys exchanged" notice: the setup ran in this mount and
  // the key has now arrived, but no encrypted message exists yet (the
  // lock pill needs one). The user taps Send normally — the preserved
  // text is NEVER auto-sent when keys arrive.
  const showKeysReadyBanner =
    !isCommunity && e2eeKeyReady && !chatIsEncrypted && e2eeSetupAnnouncedAt != null && messagesLoaded;
  // Report 3 #226/#234 (W5b): "Reconnecting…" for this conversation's
  // collection, polled on the same 3 s cadence as the DB rev-probe poll.
  // Mock mode never shows it (no subscriptions to lose).
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    const check = () => {
      if (cancelled) return;
      let rec = false;
      try {
        rec = isAwsConfigured() && db.isReconnecting(`chats/${conversationId}/messages`);
      } catch {
        rec = false;
      }
      setChatReconnecting((prev) => (prev === rec ? prev : rec));
    };
    check();
    const t = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [conversationId]);
  // Report 3 #26 (W5b): timed-out banner Retry — a real re-request, not
  // text: clears both throttles (`requestKeyReExchange`) and writes a
  // fresh announce, exactly like the decrypt-failed Retry below, then
  // returns the banner to `announcing`.
  const retryKeyExchange = async () => {
    if (!conversationId || !currentUser?.uid) return;
    try {
      const announce = await requestKeyReExchange(conversationId, currentUser.uid);
      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
        ...announce, timestamp: Date.now(), senderId: currentUser.uid,
      });
      setE2eeSetupAnnouncedAt(Date.now());
    } catch {
      showToastMsg('Could not re-request keys — check your connection and try again');
    }
  };

  // Phase 3 (integration): non-members cannot read group messages either —
  // they see a join prompt instead of the history.
  // #24: memoized on the debounced query — the old inline filter ran
  // displayTextFor per message on every render (every keystroke).
  // 100M-H22: the filter reads searchTextFor (body + caption), not just
  // displayTextFor — caption words now match.
  const filteredMsgs = useMemo(() => isCommunityNonMember ? [] : searchQueryDebounced
    ? visibleMsgs.filter(m => searchTextFor(m).toLowerCase().includes(searchQueryDebounced.toLowerCase()))
    : pagedMsgs, [isCommunityNonMember, searchQueryDebounced, visibleMsgs, pagedMsgs, decrypted]);

  // 100M-H23: the RENDER list while searching is the FULL chat, not the
  // matches — matches used to render in isolation, with no surrounding
  // messages and no in-text highlight. pagedMsgs is already the whole
  // loaded list while searching (see its definition above), so this
  // costs no extra data load. filteredMsgs stays the MATCH list for the
  // counter + Prev/Next jumping.
  const renderMsgs = searchQueryDebounced ? pagedMsgs : filteredMsgs;

  // ── ROADMAP-2 item 6: album grouping ──
  // Consecutive same-album photo/video messages render as ONE album
  // bubble on the first member; later members are skipped in the map
  // (their tiles come from the group). Non-photo/video files that were
  // sent in the same batch keep their own document bubbles — only
  // photos/videos group. Single-photo "albums" (albumId set, one item)
  // render as a normal bubble.
  const albumGroups = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const m of renderMsgs) {
      if (!m.albumId || m.deleted || !(m.mediaType === 'image' || m.mediaType === 'video')) continue;
      const arr = groups.get(m.albumId) || [];
      arr.push(m);
      groups.set(m.albumId, arr);
    }
    return groups;
  }, [renderMsgs]);
  const albumFirstIds = useMemo(() => {
    const ids = new Set<string>();
    for (const items of albumGroups.values()) if (items.length > 1) ids.add(items[0].id);
    return ids;
  }, [albumGroups]);

  // ── ROADMAP-2 item 11: unread divider ──
  // Incoming messages (not mine, not deleted) newer than the frozen
  // open-time anchor are "unread". The divider sits before the first one
  // and carries the count. Hidden while searching (filtered list).
  const unreadInfo = useMemo(() => {
    // #21 anchor fix: getLocalReadAt() returns 0 for a never-read chat,
    // which used to mark EVERY peer message unread and defeat
    // pagination. With no stamp, anchor at the top of the first
    // rendered page instead: the divider sits at the top of what is
    // loaded, older unread is reached via Load more. A real stamp
    // (returning visit) is used verbatim.
    const anchor = unreadAnchorAt || (visibleMsgs.length
      ? toDateSafe(visibleMsgs[Math.max(0, visibleMsgs.length - PAGE_SIZE)].timestamp).getTime()
      : 0);
    if (!anchor) return { firstId: null as string | null, count: 0 };
    const unread = visibleMsgs.filter((m: any) => !m.deleted && m.senderId !== currentUser?.uid && toDateSafe(m.timestamp).getTime() > anchor);
    return { firstId: unread.length ? unread[0].id : null, count: unread.length };
  }, [visibleMsgs, unreadAnchorAt, currentUser]);

  // P0-2 divider fix (W24): the divider NEVER grows the rendered page.
  // The old effect expanded visibleCount by a page whenever the first
  // unread sat above the newest 50 — in a fresh unread chat that fired
  // ~4 s after open (50 → 100 bubbles) and typing froze at
  // near-baseline levels (31 longtasks / ~2.8 s paced, V2 re-probe).
  // The page now stays at 50 until the user scrolls up / taps
  // "Load older messages"; the divider renders whenever the first
  // unread is inside the visible page (returning visit with a real
  // read stamp, or after loading older messages). No auto-expansion,
  // so no per-keystroke cost from the divider path.

  // First http(s) URL in a message, for the link preview card below it.
  const firstUrlInText = (text?: string): string | null => {
    if (!text) return null;
    const m = text.match(/https?:\/\/[^\s]+/i);
    return m ? m[0].replace(/[),.;!?]+$/, '') : null;
  };

  // ── Phase 4: hashtag tap → search this chat for the tag ──
  // Uses the existing in-chat search (same filter + prev/next jumping as
  // the search bar). Cross-chat hashtag search is NOT done here: the
  // search-all-chats flow lives in ChatListScreen (Phase 3, local-cache
  // chatMessageMatch), which this worker does not own — see PATCH notes
  // for the coordinator handoff (ChatList owner: read `?q=` / prefill).
  // Phase 4 (integration): hashtag tap searches ALL chats — jump to the chat
  // list with the tag prefilled (ChatListScreen reads ?q=). In-chat search
  // is still available from the search bar inside this chat.
  const searchHashtag = (tag: string) => {
    const q = tag.startsWith('#') ? tag : `#${tag}`;
    navigate(`/main?q=${encodeURIComponent(q)}`);
  };

  const isMe = (msg: any) => msg.senderId === currentUser?.uid;

  // W27: my live-location message in this chat that is still within its
  // window (flag + expiry both checked; a stale flag alone never counts).
  // Drives the sharing banner, the card's Stop button and resume.
  // (Placed after isMe — the memo callback runs during render, so it
  // must not reference a const still in its temporal dead zone.)
  const myActiveLiveMsg = useMemo(
    () => messages.find((m: any) => m?.type === 'live-location' && isMe(m) && isLiveLocationActive({ liveLocationActive: !!m.liveLocationActive, liveLocationExpiresAt: m.liveLocationExpiresAt || 0 }, liveNow)) || null,
    [messages, liveNow],
  );

  // Tick the banner/card "X min left" labels while a share is live.
  useEffect(() => {
    if (!myActiveLiveMsg) return;
    const t = setInterval(() => setLiveNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [myActiveLiveMsg]);

  // ── Phase 3 render helpers ──
  const msgDate = (ts: any) => toDateSafe(ts);
  const dayKey = (ts: any) => { const d = msgDate(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const dateLabel = (ts: any) => {
    const d = msgDate(ts);
    const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    if (dayKey(ts) === dayKey(today)) return 'Today';
    if (dayKey(ts) === dayKey(y)) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtDateTime = (ts: any) => {
    if (!ts) return '—';
    return msgDate(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  // Linkify URLs + highlight @mentions and #hashtags in bubble text.
  // Hashtags are tappable: they search this chat for the tag (see searchHashtag).
  // 100M-H23: while searching, `highlightTerm` marks EVERY occurrence of
  // the query with <mark> (WhatsApp marks only the current match — here
  // you can see all matches at a glance while scrolling); the current
  // Prev/Next match (`isCurrentMatch`) gets the stronger orange mark.
  const renderRichText = (text: string, mine: boolean, highlightTerm = '', isCurrentMatch = false) => {
    const parts = text.split(/((?:https?:\/\/[^\s]+)|(?:@[A-Za-z0-9_]+)|(?:#[A-Za-z0-9_]+))/g);
    return parts.map((part, i) => {
      if (/^https?:\/\//.test(part)) {
        // WA audit #68 — a shared call link renders a "Join call"
        // action, not just a bare URL: tapping it routes to the
        // CallLinkScreen for that host (token preserved). Any other
        // URL keeps the plain link render below.
        const callLink = part.match(/^https?:\/\/(?:www\.)?dtchats\.app\/call\/([A-Za-z0-9_-]+)(?:\?t=([A-Za-z0-9_-]+))?/);
        if (callLink) {
          const hostUid = callLink[1];
          const token = callLink[2];
          return (
            <span key={i} className="inline-flex flex-col gap-1.5 align-middle">
              <a href={part} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                className={`underline break-all ${mine ? 'text-green-200' : 'text-blue-500 dark:text-blue-400'}`}>{part}</a>
              <button
                type="button"
                aria-label="Join call"
                onClick={(e) => { e.stopPropagation(); navigate(`/call/${hostUid}${token ? `?t=${token}` : ''}`); }}
                className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold active:scale-95 transition-transform ${mine ? 'bg-white/25 text-white' : 'bg-green-cta text-white'}`}
              >
                <Phone className="h-3.5 w-3.5" /> Join call
              </button>
            </span>
          );
        }
        return (
          <a key={i} href={part} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className={`underline break-all ${mine ? 'text-green-200' : 'text-blue-500 dark:text-blue-400'}`}>{part}</a>
        );
      }
      if (/^@[A-Za-z0-9_]+/.test(part)) {
        return <span key={i} className="font-semibold bg-primary-green/25 rounded px-0.5">{part}</span>;
      }
      if (/^#[A-Za-z0-9_]+/.test(part)) {
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => { e.stopPropagation(); searchHashtag(part); }}
            className={`font-semibold rounded px-0.5 cursor-pointer hover:underline ${mine ? 'text-green-200 bg-primary-green/25' : 'text-blue-500 dark:text-blue-400 bg-blue-500/10'}`}
            title={`Search for ${part} in this chat`}
          >
            {part}
          </button>
        );
      }
      // Plain parts go through FormattedText (*bold* _italic_ ~strike~
      // ```mono```) — on the DECRYPTED text only, never the raw envelope.
      // (key lives on the plain span: React 19 types here reject `key`
      // on custom components.)
      if (highlightTerm) {
        const esc = highlightTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sub = part.split(new RegExp(`(${esc})`, 'gi'));
        return (
          <span key={i}>
            {sub.map((p, j) => (p.toLowerCase() === highlightTerm.toLowerCase() ? (
              <mark key={j} className={isCurrentMatch ? 'bg-orange-400 dark:bg-orange-500 text-inherit rounded px-0' : 'bg-yellow-300 dark:bg-yellow-600 text-inherit rounded px-0'}>{p}</mark>
            ) : (
              <FormattedText key={j} text={p} />
            )))}
          </span>
        );
      }
      return <span key={i}><FormattedText text={part} /></span>;
    });
  };
  // ── Typing-freeze fix (#20): stable callbacks for the extracted
  // composer ──
  // ChatComposer is memoized: it must only re-render when ITS props
  // change. Plain inline callbacks would be new every ChatScreen render
  // and defeat the memo, so the composer gets ONE stable callbacks
  // object whose methods delegate to a latest-ref updated every commit.
  // (setState dispatchers passed as props are stable by definition.)
  const composerLatestRef = useRef<ChatComposerCallbacks>({
    onSend: handleSend,
    onTypingStart: () => setMyTyping(true),
    onTypingStop: () => setMyTyping(false),
    onDraftChange: saveDraft,
    onMicPointerDown: handleMicPointerDown,
    onOpenCombinedPicker: openCombinedPicker,
    onOpenCamera: () => { if (navigator.mediaDevices?.getUserMedia) setShowCamera(true); else cameraInputRef.current?.click(); },
    // Wave-2 E9: the composer suggestion row sends through the same path
    // as the picker (sendSticker guards blocked / canSend + toasts).
    onSendSticker: (s) => { void sendSticker(s); },
    // Wave-2 E9 (WA onShowMore): "more" opens the picker filtered by
    // the last typed emoji.
    onShowMoreSuggestions: (emoji) => openStickerPicker('stickers', emoji),
  });
  useEffect(() => {
    composerLatestRef.current = {
      onSend: handleSend,
      onTypingStart: () => setMyTyping(true),
      onTypingStop: () => setMyTyping(false),
      onDraftChange: saveDraft,
      onMicPointerDown: handleMicPointerDown,
      onOpenCombinedPicker: openCombinedPicker,
      onOpenCamera: () => { if (navigator.mediaDevices?.getUserMedia) setShowCamera(true); else cameraInputRef.current?.click(); },
      onSendSticker: (s) => { void sendSticker(s); },
      onShowMoreSuggestions: (emoji) => openStickerPicker('stickers', emoji),
    };
  });
  const composerCallbacks = useMemo<ChatComposerCallbacks>(() => ({
    onSend: () => composerLatestRef.current.onSend(),
    onTypingStart: () => composerLatestRef.current.onTypingStart(),
    onTypingStop: () => composerLatestRef.current.onTypingStop(),
    onDraftChange: (t: string) => composerLatestRef.current.onDraftChange(t),
    onMicPointerDown: (e) => composerLatestRef.current.onMicPointerDown(e),
    onOpenCombinedPicker: (tab) => composerLatestRef.current.onOpenCombinedPicker(tab),
    onOpenCamera: () => composerLatestRef.current.onOpenCamera(),
    onSendSticker: (s) => composerLatestRef.current.onSendSticker(s),
    onShowMoreSuggestions: (emoji) => composerLatestRef.current.onShowMoreSuggestions?.(emoji),
  }), []);
  // Wave-2 E9: stickers the composer suggestion row may offer — bundled
  // packs + the animated packs (avatar / custom stickers stay picker-only;
  // they have no emoji tags and the picker search covers them).
  const suggestableStickers = useMemo(
    () => [...ALL_STICKERS, ...ANIMATED_STICKER_PACKS.flatMap((p) => p.stickers)],
    [],
  );

  // ── Typing-freeze fix (Report 3 #20): the bubble list, memoized ──
  // The map below used to re-run on EVERY ChatScreen render — including
  // every keystroke (input lived in this component). With the composer
  // extracted, keystrokes never re-render this component at all; this
  // memo additionally skips re-building the ~50–150 bubble elements on
  // unrelated re-renders (partner typing, presence, receipts). It only
  // rebuilds when its deps change. `input` is deliberately NOT a dep.
  // Leaf cost is cut too: FormattedText / LinkPreviewCard are memoized.
  const messageBubbles = useMemo(() => renderMsgs.map((msg, idx) => {
          const prevMsg = renderMsgs[idx - 1];
          const showDateSep = idx === 0 || dayKey(prevMsg?.timestamp) !== dayKey(msg.timestamp);
          // #30 (WhatsApp parity, corrected 2026-11-17 from the real
          // WhatsApp Web client): the tail belongs ONLY to the FIRST
          // bubble of a consecutive same-sender run — the top-most one,
          // where the tail attaches to the flattened top corner. The
          // client's own rendered snapshot proves it: a tailed message
          // is followed by a tail-less message from the same sender.
          // A new day breaks the run (the date separator sits between
          // them), as does a sender change or the start of the list.
          // Later bubbles stay fully rounded.
          const isFirstInGroup = !prevMsg || prevMsg.senderId !== msg.senderId || dayKey(prevMsg.timestamp) !== dayKey(msg.timestamp);
          // #31: only the newest bubble animates in (~150ms scale/fade);
          // older bubbles mount without animation. React reuses the DOM
          // node on memo rebuilds, so a re-render never replays it.
          const isNewest = idx === renderMsgs.length - 1;
          const mine = isMe(msg);
          // E2EE: bubble text comes from here, not raw msg.text — legacy
          // messages pass through unchanged, encrypted ones show their
          // decrypted text (or the decrypt-failed placeholder).
          const display = displayTextFor(msg);
          // 100M-F2: the media caption — adapter-decrypted `msg.caption`
          // first, local decrypt-cache fallback (same path as display.text).
          // Empty string / undefined = no caption, renders nothing.
          const captionText = (typeof msg.caption === 'string' && msg.caption.length > 0 ? msg.caption : decrypted[msg.id]?.caption) || '';
          // WA parity (DM audit row 27): time + ticks sit INLINE at the
          // bottom-right of the last line, like WhatsApp — the meta
          // floats inside the last text-bearing element (text <p> or
          // media caption <p>) so the text wraps around it, instead of
          // living on a separate row below the text. Exactly one host
          // holds the meta. Hosts, in priority order:
          //  - text <p> (plain text; NOT link-preview text — the card
          //    below it hosts the meta instead, at its bottom-right);
          //  - caption <p> (captioned media; caption defers to text);
          //  - media overlay (captionless photo/video/GIF — WA puts
          //    the meta ON the media, bottom-right over a scrim);
          //  - emoji-only <p> (absolute bottom-right; a float would
          //    pin to the TOP of the oversized emoji line box);
          //  - sticker (absolute bottom-right of the floating sticker);
          //  - link-preview card (meta prop, bottom-right of the card).
          // Carve-outs keep the old right-aligned row below the content:
          // card messages (poll/event/location/contact), voice/audio and
          // documents — WA also puts their meta at the bubble's
          // bottom-right below the card/player, so the row IS parity
          // there — plus deleted placeholders and round video (no host
          // with a straight bottom edge to overlay on).
          const hasLinkPreview = !msg.deleted && msg.type !== 'sticker' && msg.type !== 'gif' && msg.type !== 'poll' && msg.type !== 'location' && msg.type !== 'live-location' && msg.type !== 'contact' && !!firstUrlInText(display.text) && getLinkPreviewsEnabled();
          const inlineInText = !msg.deleted && msg.type !== 'sticker' && msg.type !== 'gif' && msg.type !== 'event' && msg.type !== 'poll' && msg.type !== 'live-location' && msg.type !== 'location' && msg.type !== 'contact' && !!display.text && !['Photo', 'Video', 'Audio', 'Round video'].includes(display.text) && !emojiOnlySize(display.text) && !hasLinkPreview;
          const inlineInCaption = !!captionText && !inlineInText && !(msg.isViewOnce && msg.mediaUrl);
          const overlayOnMedia = !msg.deleted && !captionText && !msg.isViewOnce && !!msg.mediaUrl && (msg.mediaType === 'image' || (msg.mediaType === 'video' && !msg.isRoundVideo)) && !mediaAutoBlocked(msg, mine);
          const emojiOnlyMeta = !msg.deleted && !hasLinkPreview && !!display.text && !!emojiOnlySize(display.text);
          const stickerMeta = !msg.deleted && msg.type === 'sticker';
          const hasInlineMeta = inlineInText || inlineInCaption || overlayOnMedia || emojiOnlyMeta || stickerMeta || hasLinkPreview;
          // Wave-2 A5 (DM #78): a GIF message renders as an autoplaying
          // looping video with a GIF badge. `type: 'gif'` is what sendGif
          // writes; `gifVideoUrl` is the MP4 variant; the `.gif` URL
          // suffix covers GIFs received from older clients / other paths.
          const isGifMsg = msg.mediaType === 'image' && (msg.type === 'gif' || !!msg.gifVideoUrl || (typeof msg.mediaUrl === 'string' && /\.gif(\?|#|$)/i.test(msg.mediaUrl)));
          // 100M-H23: the Prev/Next "current" match — its <mark> gets the
          // stronger style below; every other match still gets a mark.
          const isCurrentMatch = !!searchQueryDebounced && filteredMsgs[searchIdx]?.id === msg.id;

          const showAvatar = !mine && (!renderMsgs[idx - 1] || renderMsgs[idx - 1].senderId !== msg.senderId);

          // ROADMAP-2 item 6: later members of an album render inside the
          // first member's AlbumBubble — skip them here.
          const albumItems = msg.albumId ? albumGroups.get(msg.albumId) : undefined;
          const isAlbumFirst = !!albumItems && albumItems.length > 1 && albumFirstIds.has(msg.id);
          if (albumItems && albumItems.length > 1 && !albumFirstIds.has(msg.id)) return null;

          // ROADMAP-2 item 11: unread divider before the first unread message.
          const showUnreadDivider = !searchQuery && unreadInfo.firstId === msg.id;

          // F36 (100-more): membership system events ("X added Y", "X left",
          // "You created this group") render as a centred grey pill,
          // WhatsApp-style — never as an empty bubble. systemEventText
          // personalises actor/target to "You"/"you" for the viewer; the
          // pre-rendered `text` is the fallback for unknown kinds.
          if (msg.type === 'system') {
            return (
              <React.Fragment key={msg.id}>
              {showDateSep && (
                <div className="flex justify-center my-2">
                  <span className="text-[12.5px] font-medium text-gray-600 dark:text-text-secondary bg-white/90 dark:bg-[#1D1F1F] px-3 py-1 rounded-full shadow-sm">{dateLabel(msg.timestamp)}</span>
                </div>
              )}
              {showUnreadDivider && (
                <div className="flex justify-center my-2" role="separator" aria-label={`${unreadInfo.count} unread messages`}>
                  <span className="text-[11px] font-semibold text-white bg-green-cta px-3 py-1 rounded-full shadow-sm">{unreadInfo.count} unread message{unreadInfo.count === 1 ? '' : 's'}</span>
                </div>
              )}
              <div className="flex justify-center my-2">
                <span className="text-[12.5px] font-medium text-gray-600 dark:text-text-secondary bg-white/90 dark:bg-[#1D1F1F] px-3 py-1 rounded-full shadow-sm">{systemEventText(msg, currentUser?.uid) || msg.text || ''}</span>
              </div>
              </React.Fragment>
            );
          }

          // The bubble meta (time + ticks), shared by every host. Variants:
          //  - 'inline': floats right inside the text/caption <p> — `ml-2`
          //    leaves the WA gap between the last word and the time, and
          //    `mt-[4px]` drops the 11 px meta onto the 15 px text baseline
          //    (the float's top pins to the last line box; headless probe
          //    2026-11-17: mt-[3px] left the meta baseline ~1 px high,
          //    no-nudge ~4 px high, mt-[4px] ~0 px — see the A4 report).
          //  - 'overlay': absolute bottom-right ON the media with a dark
          //    scrim pill, white time + white ticks (WA captionless-media
          //    style); the host media wrapper must be `relative`.
          //  - 'absolute': absolute bottom-right of its host (emoji-only
          //    <p>, sticker bubble) on the bubble background, grey time.
          //  - 'row': the fallback row below the content (cards, audio,
          //    documents, deleted, round video).
          // The ticks button keeps its 24 px tap target (p-1 -m-1 → 16 px
          // outer, so it never stretches the line box). `interactiveTicks`
          // is false inside the link-preview card: the card is an <a> and
          // a <button> inside it would be invalid nesting — the ticks
          // render as a plain icon there (WA has no tap action on them
          // either). `data-bubble-meta` is the probe hook.
          const renderBubbleMeta = (variant: 'inline' | 'row' | 'overlay' | 'absolute', interactiveTicks = true) => {
            const ticksStatus = (() => {
              const s = effectiveMessageStatus(msg, seenUpToByUid, deliveredUpToByUid, currentUser?.uid);
              return !receiptsEffective && s === 'seen' ? 'delivered' : s;
            })();
            return (
            <span data-bubble-meta data-inline={variant === 'inline' ? 'true' : 'false'} data-variant={variant}
              className={
                variant === 'inline' ? 'float-right ml-2 mt-[4px] inline-flex items-center gap-1 select-none' :
                variant === 'overlay' ? 'absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 select-none bg-black/55 text-white rounded px-1.5 py-0.5' :
                variant === 'absolute' ? 'absolute bottom-0 right-0 inline-flex items-center gap-1 select-none' :
                'inline-flex items-center gap-1 select-none'
              }
              style={variant === 'overlay' ? ({ '--chat-tick-grey': '#ffffff' } as React.CSSProperties) : undefined}>
              {/* L5: optimistic media placeholder state. */}
              {msg.uploading && (
                <span className="text-[10px] font-medium opacity-70">Uploading…{typeof msg.uploadProgress === 'number' && msg.uploadProgress > 0 ? ` ${msg.uploadProgress}%` : ''}</span>
              )}
              {msg.uploadFailed && !msg.uploading && (
                <span className="text-[10px] font-medium text-red-400" title="Upload failed — the message was not sent">Upload failed</span>
              )}
              {/* Item 10: kept messages in a disappearing chat show a marker. */}
              {msg.kept && disappearAfter > 0 && (
                <span className="text-[10px] font-semibold opacity-70" title={msg.keptAt ? `Kept ${new Date(msg.keptAt).toLocaleDateString()}` : 'Kept — this message won’t disappear'}>📌 Kept</span>
              )}
              <span className={variant === 'overlay' ? 'text-[11px] text-white' : 'text-[11px] text-black/60 dark:text-white/60'}>{formatTime(msg.timestamp)}</span>
              {mine && !msg.deleted && (
                interactiveTicks ? (
                  <button type="button" aria-label="Message info — delivered and seen times" onClick={(e) => { e.stopPropagation(); setMsgInfo(msg); }} className="p-1 -m-1 min-h-[24px] min-w-[24px] flex items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10">
                    {/* AUDIT-2 C5: ticks derive from the per-message
                        `status` AND the peer's read watermark (see
                        effectiveMessageStatus) — the watermark is the
                        only 'seen' signal new clients write. Item 12
                        (symmetric WhatsApp behaviour): with my read
                        receipts OFF I also don't see others' blue ticks —
                        my own outgoing messages render capped at
                        delivered (grey) even when the stored status is
                        'seen'. The stored status itself is untouched. */}
                    <MessageTicks status={ticksStatus} />
                  </button>
                ) : (
                  <MessageTicks status={ticksStatus} />
                )
              )}
            </span>
            );
          };
          const bubbleMeta = renderBubbleMeta(hasInlineMeta ? 'inline' : 'row');

          return (
            <React.Fragment key={msg.id}>
            {showDateSep && (
              <div className="flex justify-center my-2">
                <span className="text-[12.5px] font-medium text-gray-600 dark:text-text-secondary bg-white/90 dark:bg-[#1D1F1F] px-3 py-1 rounded-full shadow-sm">{dateLabel(msg.timestamp)}</span>
              </div>
            )}
            {showUnreadDivider && (
              <div className="flex justify-center my-2" role="separator" aria-label={`${unreadInfo.count} unread messages`}>
                <span className="text-[11px] font-semibold text-white bg-green-cta px-3 py-1 rounded-full shadow-sm">{unreadInfo.count} unread message{unreadInfo.count === 1 ? '' : 's'}</span>
              </div>
            )}
            {isAlbumFirst ? (
              <div
                id={`msg-${msg.id}`}
                data-album-first={msg.albumId}
                className={`flex ${mine ? 'justify-end' : 'justify-start'} group transition duration-300 rounded-2xl ${
                  highlightedMsgId === msg.id ? 'bg-primary-green/25 p-1' : ''
                } ${selectedIds.includes(msg.id) ? 'bg-primary-green/20 p-1' : ''}`}
              >
                {selectMode && (
                  <button type="button" aria-label={selectedIds.includes(msg.id) ? 'Deselect message' : 'Select message'} onClick={(e) => { e.stopPropagation(); toggleSelect(msg.id); }}
                    className={`h-11 w-11 min-w-[44px] min-h-[44px] self-center rounded-full border-2 flex items-center justify-center text-sm font-bold flex-shrink-0 mr-1 ${selectedIds.includes(msg.id) ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400 text-transparent bg-white/70 dark:bg-black/30'}`}>✓</button>
                )}
                {!mine && (
                  <div className="w-8 mr-2 flex-shrink-0 self-end">
                    {showAvatar ? (
                      <DefaultAvatar
                        photoURL={msg.senderAvatar}
                        name={msg.senderName || 'User'}
                        seed={msg.senderId}
                        size={32}
                      />
                    ) : null}
                  </div>
                )}
                <div className={`max-w-[78%] relative ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
                  <AlbumBubble
                    items={albumItems!}
                    expanded={albumExpanded === msg.albumId}
                    onToggleExpand={() => setAlbumExpanded(albumExpanded === msg.albumId ? null : msg.albumId)}
                    onOpen={(item) => openLightbox(
                      { url: item.mediaUrl, type: item.mediaType === 'video' ? 'video' : 'image', senderName: item.senderName, time: formatTime(item.timestamp), caption: captionFor(item) || undefined },
                      albumItems!.filter((a: any) => a.mediaUrl).map((a: any) => ({ url: a.mediaUrl, type: a.mediaType === 'video' ? 'video' : 'image', senderName: a.senderName, time: formatTime(a.timestamp), caption: captionFor(a) || undefined })),
                    )}
                    // WA parity (DM audit row 27): 11 px time + ticks
                    // overlaid on the last tile's bottom-right (see
                    // AlbumBubble `meta`) — the old separate 10 px row
                    // below the album is gone.
                    meta={(
                      <span className="inline-flex items-center gap-1" style={{ '--chat-tick-grey': '#ffffff' } as React.CSSProperties}>
                        <span className="text-[11px] text-white">{formatTime(albumItems![albumItems!.length - 1].timestamp)}</span>
                        {mine && (
                          <MessageTicks status={(() => { const s = effectiveMessageStatus(albumItems![albumItems!.length - 1], seenUpToByUid, deliveredUpToByUid, currentUser?.uid); return !receiptsEffective && s === 'seen' ? 'delivered' : s; })()} />
                        )}
                      </span>
                    )}
                  />
                  {/* WA parity (verify dm-4 row 67 / media-5 A17): an album
                      carries one caption (on its first member), shown once
                      under the grid like WhatsApp — never repeated per
                      tile. It used to be dropped entirely, and the
                      lightbox opened album photos caption-less.
                      captionText comes from msg, so the decrypt-error flag
                      is msg's too. */}
                  {captionText && (
                    <p className="text-[15px] leading-snug whitespace-pre-wrap break-words px-1 pt-1">
                      {msg.captionDecryptError ? (
                        <span className="italic opacity-70">{captionText}</span>
                      ) : (
                        renderRichText(captionText, mine, searchQueryDebounced, isCurrentMatch)
                      )}
                    </p>
                  )}
                </div>
              </div>
            ) : (
            <div
              id={`msg-${msg.id}`}
              className={`flex ${mine ? 'justify-end' : 'justify-start'} group transition duration-300 rounded-2xl ${
                highlightedMsgId === msg.id ? 'bg-primary-green/25 p-1' : ''
              } ${selectedIds.includes(msg.id) ? 'bg-primary-green/20 p-1' : ''} ${isNewest ? 'animate-msg-in' : ''}`}
            >
              {selectMode && (
                <button type="button" aria-label={selectedIds.includes(msg.id) ? 'Deselect message' : 'Select message'} onClick={(e) => { e.stopPropagation(); toggleSelect(msg.id); }}
                  className={`h-11 w-11 min-w-[44px] min-h-[44px] self-center rounded-full border-2 flex items-center justify-center text-sm font-bold flex-shrink-0 mr-1 ${selectedIds.includes(msg.id) ? 'bg-green-cta border-green-cta text-white' : 'border-gray-400 text-transparent bg-white/70 dark:bg-black/30'}`}>✓</button>
              )}
              {/* Avatar for others */}
              {!mine && (
                <div className="w-8 mr-2 flex-shrink-0 self-end">
                  {showAvatar ? (
                    <DefaultAvatar
                      photoURL={msg.senderAvatar}
                      name={msg.senderName || 'User'}
                      seed={msg.senderId}
                      size={32}
                    />
                  ) : null}
                </div>
              )}

              <div
                className={`max-w-[78%] relative ${mine ? 'items-end' : 'items-start'} flex flex-col`}
                style={{
                  transform: swipingMsgId === msg.id ? `translateX(${swipeOffset}px)` : 'none',
                  transition: swipingMsgId === msg.id ? 'none' : 'transform 0.18s ease-out'
                }}
              >
                {/* Visual reply indicator when swiped right */}
                {swipingMsgId === msg.id && swipeOffset > 15 && (
                  <div className="absolute -left-9 top-1/2 -translate-y-1/2 p-1.5 rounded-full bg-primary-green/20 text-primary-green animate-scale">
                    <Reply className="h-4 w-4" />
                  </div>
                )}

                {/* WA parity (DM audit row 36): the quoted reply lives INSIDE
                    the bubble (moved from the standalone block above it),
                    with a sender-coloured bar + name and a media-type
                    label for media quotes. */}

                {/* Bubble — colours come from the chat theme (per-chat or global).
                    #30: tail corner + tail SVG only on the FIRST bubble of a
                    same-sender run. Tail paths are WhatsApp's own (8x13,
                    viewBox 0 0 8 13, from the client's tail-in/tail-out
                    SVGs); the SVG sits 1px inside the bubble edge so no
                    hairline gap shows. Stickers float with no bubble, so
                    they get no tail.
                    #216: stickers are NOT text in a bubble — they float on the
                    chat background with no bubble fill, no shadow and no text
                    selection, like WhatsApp stickers. (W30j: the "Fluent 3D"
                    pack now ships real bundled WebP art — see stickerPack.ts;
                    emoji-only packs still render the big emoji here.) */}
                <div
                  className={`relative rounded-[7.5px] pt-[6px] pr-[7px] pb-[8px] pl-[9px] cursor-pointer ${
                    msg.type === 'sticker'
                      ? 'bg-transparent shadow-none select-none'
                      : `shadow-sm select-text ${
                          isFirstInGroup ? (mine ? 'rounded-tr-[1px]' : 'rounded-tl-[1px]') : ''
                        }`
                  }`}
                  style={
                    msg.type === 'sticker'
                      ? { backgroundColor: 'transparent', color: bubbleText }
                      : { backgroundColor: mine ? bubbleSent : bubbleRecv, color: bubbleText }
                  }
                  onClick={() => { if (selectMode) toggleSelect(msg.id); }}
                  onContextMenu={(e) => {
                    // R2: a WebView `contextmenu` fired right after our own
                    // long-press already opened the reaction picker must
                    // not stack the context menu on top of it.
                    if (Date.now() - touchLongPressAtRef.current < 1000) { e.preventDefault(); return; }
                    openCtx(e, msg);
                  }}
                  onTouchStart={(e) => {
                    touchStartX.current = e.touches[0].clientX;
                    touchStartY.current = e.touches[0].clientY;
                    isHorizontalSwipe.current = null;
                    setSwipingMsgId(msg.id);

                    // R2 (WhatsApp behaviour): on a touch phone a 500 ms
                    // hold opens the quick-reaction row (the anchored
                    // ReactionPicker: 6 emojis + full picker), NOT
                    // multi-select — the old code entered select mode
                    // here, which had no React action and left no way
                    // to react at all on the APK (hover button +
                    // right-click menu are desktop-only). Multi-select
                    // stays reachable: long-press while already in
                    // select mode toggles that message, the reaction
                    // picker's "Select" button enters it, and the
                    // context menu has a Select entry.
                    const timer = setTimeout(() => {
                      touchLongPressAtRef.current = Date.now();
                      // #32: short haptic tick the moment the long-press
                      // action fires (reaction picker / select toggle),
                      // like WhatsApp. No-op where vibrate is unsupported.
                      try { navigator.vibrate?.(10); } catch { /* ignore */ }
                      if (selectMode) toggleSelect(msg.id);
                      else if (!msg.deleted) {
                        setCtxMenu(null);
                        if (channelPolicyRef.current === 'none') { showToastMsg('Reactions are off in this channel'); return; }
                        // W26: flip the picker below the bubble when the
                        // touch point is <120 px from the top of the
                        // visible list — the `-top-12` popover would be
                        // clipped by the scroll container there.
                        const containerTop = messagesScrollRef.current?.getBoundingClientRect().top ?? 0;
                        setReactPickerBelow(touchStartY.current - containerTop < 120);
                        setShowReactPicker(msg.id);
                      }
                    }, 500);
                    const cancel = () => clearTimeout(timer);
                    document.addEventListener('touchend', cancel, { once: true });
                    document.addEventListener('touchmove', cancel, { once: true });
                  }}
                  onTouchMove={(e) => {
                    const deltaX = e.touches[0].clientX - touchStartX.current;
                    const deltaY = e.touches[0].clientY - touchStartY.current;
                    if (isHorizontalSwipe.current === null) {
                      if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
                        isHorizontalSwipe.current = Math.abs(deltaX) > Math.abs(deltaY) && deltaX > 0;
                      }
                    }
                    if (isHorizontalSwipe.current && deltaX > 0) {
                      setSwipeOffset(Math.min(deltaX * 0.45, 65));
                    }
                  }}
                  onTouchEnd={(e) => {
                    // W26 (#32 follow-up — picker closes on finger lift):
                    // the 500 ms long-press opens the reaction picker, and
                    // the finger lift then synthesises compatibility mouse
                    // events (`mousedown`/`click`) on the bubble, which
                    // bubble to the messages-area container onClick and
                    // close the picker the instant it opened (V11
                    // reproduced in headless CDP). preventDefault on
                    // touchend suppresses those synthetic mouse events.
                    if (Date.now() - touchLongPressAtRef.current < 1000) e.preventDefault();
                    // WA verify DM-2 row 38: swipe-to-reply must not fire
                    // on a deleted message (WA offers no reply there) or
                    // while selecting (a swipe there is selection, not a
                    // reply — the reply banner would fight the select bar).
                    if (isHorizontalSwipe.current && swipeOffset >= 35 && !msg.deleted && !selectMode) {
                      setReplyTo(msg);
                      inputRef.current?.focus();
                    }
                    setSwipingMsgId(null);
                    setSwipeOffset(0);
                    isHorizontalSwipe.current = null;
                  }}
                >
                  {/* WhatsApp tail (fix 13): 8x13 SVG on the first bubble
                      of a same-sender run, fill = bubble colour. Paths are
                      WhatsApp's own tail-in / tail-out; the +1px shadow
                      path uses WA's tail-shadow-opacity (.13). Positioned
                      1px inside the bubble edge so no hairline gap shows. */}
                  {isFirstInGroup && msg.type !== 'sticker' && (
                    <svg
                      className={`absolute top-0 h-[13px] w-2 ${mine ? '-right-[7px]' : '-left-[7px]'}`}
                      viewBox="0 0 8 13"
                      aria-hidden="true"
                    >
                      {mine ? (
                        <>
                          <path d="M5.188,1H0v11.193l6.467-8.625 C7.526,2.156,6.958,1,5.188,1z" fill="rgba(0,0,0,0.13)" />
                          <path d="M5.188,0H0v11.193l6.467-8.625C7.526,1.156,6.958,0,5.188,0z" fill={bubbleSent} />
                        </>
                      ) : (
                        <>
                          <path d="M1.533,3.568L8,12.193V1H2.812 C1.042,1,0.474,2.156,1.533,3.568z" fill="rgba(0,0,0,0.13)" />
                          <path d="M1.533,2.568L8,11.193V0L2.812,0C1.042,0,0.474,1.156,1.533,2.568z" fill={bubbleRecv} />
                        </>
                      )}
                    </svg>
                  )}
                  {/* Deleted message placeholder (WhatsApp standard) */}
                  {msg.deleted ? (
                    <div className="flex items-center gap-1.5 py-1 text-xs italic opacity-60">
                      <span>{mine ? 'You deleted this message' : 'This message was deleted'}</span>
                    </div>
                  ) : (
                    <>
                      {/* Forwarded label (WA parity, DM audit rows 58–59):
                          plain forward is just "Forwarded"; 5+ hops is
                          "Forwarded many times". The origin stays in the
                          title tooltip. */}
                      {forwardLabel(msg) && (
                        <p className={`text-[11px] font-medium mb-1 flex items-center gap-1 ${mine ? 'text-green-200' : 'text-primary-green'}`} title={msg.forwardedFrom ? `Forwarded from ${msg.forwardedFrom}` : undefined}>
                          <Share2 className="h-3 w-3" /> {forwardLabel(msg)}
                        </p>
                      )}

                      {/* Community sender name — WA parity (row 35): a
                          per-sender colour from the WA-style palette. */}
                      {isCommunity && !mine && (
                        <p className="text-[11px] font-semibold mb-1" style={{ color: senderColourFor(msg.senderId, msg.senderName) }}>{msg.senderName}</p>
                      )}

                      {/* Quoted reply, inside the bubble (row 36). */}
                      {msg.replyTo && (
                        <div
                          onClick={() => {
                            // Cross-chat quote (Reply privately from a group):
                            // its original lives in another chat, so there is
                            // nothing to scroll to here — say so and do nothing
                            // instead of jumping to a wrong message.
                            if (msg.replyTo.fromChatId && msg.replyTo.fromChatId !== conversationId) {
                              showToastMsg(msg.replyTo.fromChatName ? `Original message is in ${msg.replyTo.fromChatName}` : 'Original message is in another chat');
                              return;
                            }
                            scrollToMsg(msg.replyTo.id);
                          }}
                          className="mb-1 px-2.5 py-1 rounded-md text-xs border-l-[3px] bg-black/5 dark:bg-white/5 max-w-full cursor-pointer hover:opacity-80 transition-opacity"
                          style={{ borderLeftColor: senderColourFor(msg.replyTo.senderId, msg.replyTo.senderName) }}
                          title="Click to see original message"
                        >
                          <p className="font-semibold" style={{ color: senderColourFor(msg.replyTo.senderId, msg.replyTo.senderName) }}>{msg.replyTo.senderName}</p>
                          <p className="text-gray-500 dark:text-text-secondary truncate">{quoteMediaLabel(msg.replyTo) || (display.replyText ?? msg.replyTo.text)}</p>
                        </div>
                      )}

                      {/* View once (WhatsApp Standard) */}
                      {msg.isViewOnce && msg.mediaUrl ? (
                        // V10: view-once VOICE — same expired/opened states
                        // as photo/video, but it plays (once) in the bubble
                        // instead of opening the image viewer. `viewed` is
                        // marked when playback ends, so the player stays
                        // mounted for the one listen.
                        msg.mediaType === 'audio' ? (
                          isViewOnceExpired(msg) ? (
                            <div className="flex items-center gap-2 bg-black/15 dark:bg-white/5 rounded-lg p-3 mb-1 text-gray-400 select-none">
                              <EyeOff className="h-5 w-5 opacity-60" />
                              <span className="font-medium text-sm">This voice message expired.</span>
                            </div>
                          ) : msg.viewed ? (
                            <div className="flex items-center gap-2 bg-black/15 dark:bg-white/5 rounded-lg p-3 mb-1 text-gray-400 select-none">
                              <EyeOff className="h-5 w-5 opacity-60" />
                              <span className="font-medium text-sm">Opened</span>
                            </div>
                          ) : viewOnceVoiceOpenId === msg.id ? (
                            <div data-view-once-voice="playing" className="mb-1">
                              <VoiceNotePlayer
                                url={msg.mediaUrl}
                                duration={msg.duration}
                                isMine={mine}
                                waveform={msg.waveform}
                                seed={msg.id}
                                // WA parity Media V11: view-once voice must
                                // not be downloadable (plays once, then gone).
                                allowDownload={false}
                                onEnded={async () => {
                                  setViewOnceVoiceOpenId(null);
                                  if (!mine && conversationId) await markViewOnceViewed(conversationId, msg.id, false);
                                }}
                              />
                              <p className="text-[11px] opacity-70 px-1 pb-1">View once voice message — plays once, then disappears</p>
                            </div>
                          ) : (
                            <button
                              data-view-once-voice="tap-to-open"
                              onClick={() => { if (!mine) setViewOnceVoiceOpenId(msg.id); }}
                              className="flex items-center gap-2 bg-black/10 dark:bg-white/10 rounded-lg p-3 mb-1 hover:bg-black/20 dark:hover:bg-white/20 transition-colors"
                            >
                              {/* WA parity (DM audit row 83): same as photo/video — unopened
                                  view-once voice shows just "Voice message" with the circled (1)
                                  view-once icon, not "View once voice message (tap to open)". */}
                              <span aria-hidden="true" className="inline-flex items-center justify-center h-5 w-5 rounded-full border-2 border-primary-green text-primary-green text-[11px] leading-none font-bold shrink-0">1</span>
                              <span className="font-medium text-sm">
                                Voice message
                              </span>
                            </button>
                          )
                        ) :
                        // G2d: unopened after 14 days → expired (no tap).
                        isViewOnceExpired(msg) ? (
                          <div className="flex items-center gap-2 bg-black/15 dark:bg-white/5 rounded-lg p-3 mb-1 text-gray-400 select-none">
                            <EyeOff className="h-5 w-5 opacity-60" />
                            <span className="font-medium text-sm">{msg.mediaType === 'video' ? 'This video expired.' : 'This photo expired.'}</span>
                          </div>
                        ) : // G2a: the sender sees "Opened" too once the
                        // recipient opened it (msg.viewed, not !mine).
                        msg.viewed ? (
                          <div className="flex items-center gap-2 bg-black/15 dark:bg-white/5 rounded-lg p-3 mb-1 text-gray-400 select-none">
                            <EyeOff className="h-5 w-5 opacity-60" />
                            <span className="font-medium text-sm">Opened</span>
                          </div>
                        ) : (
                          <button
                            onClick={async () => {
                              // WA parity (DM audit row 82): once you send a
                              // view-once photo/video you can never view it
                              // again (WhatsApp Help Center, "About view
                              // once") — the sender only ever sees "Opened".
                              if (mine) { showToastMsg('You can’t view this view-once message again'); return; }
                              // MF-01 (scaffold, VO-01/VO-03): view-once opens
                              // in the dedicated ViewOnceViewer (canvas, no
                              // download/share, no items list) — never in
                              // the shared MediaLightbox. Marking `viewed`
                              // happens in the same action that opens the
                              // viewer (service writes viewed:true +
                              // viewedAt in one updateDoc).
                              setViewOnceViewer({
                                messageId: msg.id,
                                chatId: conversationId ?? '',
                                mediaUrl: msg.mediaUrl,
                                mediaType: msg.mediaType === 'video' ? 'video' : 'image',
                                senderName: msg.senderName,
                                time: formatTime(msg.timestamp),
                              });
                              if (!mine && conversationId) {
                                await markViewOnceViewed(conversationId, msg.id, false);
                              }
                            }}
                            className="flex items-center gap-2 bg-black/10 dark:bg-white/10 rounded-lg p-3 mb-1 hover:bg-black/20 dark:hover:bg-white/20 transition-colors"
                          >
                            {/* WA parity (DM audit row 83): unopened
                                view-once shows just the media type —
                                "Photo"/"Video" — with the circled (1)
                                view-once icon, not "View Once {type}
                                (tap to open)". The sender sees the same
                                label until the recipient opens it. */}
                            <span aria-hidden="true" className="inline-flex items-center justify-center h-5 w-5 rounded-full border-2 border-primary-green text-primary-green text-[11px] leading-none font-bold shrink-0">1</span>
                            <span className="font-medium text-sm">
                              {msg.mediaType === 'video' ? 'Video' : 'Photo'}
                            </span>
                          </button>
                        )
                      ) : (
                        <>
                          {msg.type === 'sticker' && (
                            <div className="py-1 select-none" title={msg.stickerLabel || 'Sticker'}>
                              {msg.stickerImage ? (
                                <img
                                  src={msg.stickerImage}
                                  alt={msg.stickerLabel || 'Sticker'}
                                  draggable={false}
                                  className="h-32 w-32 object-contain drop-shadow-sm"
                                />
                              ) : (
                                <span className="text-[64px] leading-none drop-shadow-sm" style={stickerAnimationStyle(msg.stickerAnimation)}>{msg.stickerEmoji || '😀'}</span>
                              )}
                            </div>
                          )}
                          {msg.mediaUrl && msg.mediaType === 'image' && (
                            mediaAutoBlocked(msg, mine) ? (
                              <button
                                type="button"
                                onClick={() => void downloadMediaWithProgress(msg)}
                                className="w-full max-w-xs rounded-lg mb-1 bg-black/10 dark:bg-white/10 px-4 py-8 text-sm text-gray-600 dark:text-text-secondary"
                              >
                                {typeof mediaDownloadProgress[msg.id] === 'number' && mediaDownloadProgress[msg.id] < 100
                                  ? `Downloading… ${mediaDownloadProgress[msg.id]}%`
                                  : isGifMsg ? 'GIF — tap to download' : 'Photo — tap to download'}
                                {typeof mediaDownloadProgress[msg.id] === 'number' && mediaDownloadProgress[msg.id] < 100 && (
                                  <span className="block h-1.5 bg-black/15 dark:bg-white/15 rounded-full overflow-hidden mt-2">
                                    <span className="block h-full bg-primary-green transition-all" style={{ width: `${mediaDownloadProgress[msg.id]}%` }} />
                                  </span>
                                )}
                              </button>
                            ) : (
                              <span className="relative block w-full max-w-xs rounded-lg mb-1 overflow-hidden">
                                {/* Wave-2 A5 (DM #78): WA GIFs autoplay + loop
                                    as videos with a GIF badge. With an MP4
                                    variant use a looping muted <video>; without
                                    one the .gif itself animates + loops
                                    natively. Tap opens the lightbox as before. */}
                                {isGifMsg && msg.gifVideoUrl ? (
                                  <video
                                    // NOTE: mediaLocalUrls[msg.id] is the
                                    // downloaded .gif, which a <video> tag
                                    // cannot decode — always use the remote
                                    // MP4 here.
                                    src={msg.gifVideoUrl}
                                    autoPlay
                                    loop
                                    muted
                                    playsInline
                                    className="w-full rounded-lg object-cover cursor-pointer hover:opacity-95 transition-opacity"
                                    onClick={() => openLightbox({ url: msg.gifVideoUrl, type: 'video', senderName: msg.senderName, time: formatTime(msg.timestamp), caption: captionText || undefined }, chatMediaItems())}
                                  />
                                ) : (
                                  <img
                                    src={mediaLocalUrls[msg.id] || msg.mediaUrl}
                                    alt={isGifMsg ? 'GIF' : 'Photo'}
                                    className="w-full rounded-lg object-cover cursor-pointer hover:opacity-95 transition-opacity"
                                    onClick={() => openLightbox({ url: mediaLocalUrls[msg.id] || msg.mediaUrl, type: 'image', senderName: msg.senderName, time: formatTime(msg.timestamp), caption: captionText || undefined }, chatMediaItems())}
                                  />
                                )}
                                {isGifMsg && (
                                  <span className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[10px] font-bold px-1.5 py-0.5 rounded" title="GIF — loops automatically">GIF</span>
                                )}
                                {msg.isHD && (
                                  <span className="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] font-bold px-1.5 py-0.5 rounded" title="Sent in HD — original quality">HD</span>
                                )}
                                {/* WA parity (DM audit row 27): captionless
                                    photo/GIF — the meta overlays the media's
                                    bottom-right instead of a row below it. */}
                                {overlayOnMedia && renderBubbleMeta('overlay')}
                                {/* WA parity Media G6: provider attribution
                                    on sent GIFs (WA `VideoMessage$Attribution`,
                                    e.g. 'GIPHY'). Only GIF messages carry it —
                                    plain photos never show a provider label.
                                    Sits above the GIF badge (both bottom-left)
                                    so the two labels never overlap. */}
                                {msg.type === 'gif' && msg.gifAttribution && (
                                  <span
                                    data-testid="gif-attribution"
                                    className="absolute bottom-8 left-1.5 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded"
                                    title={`GIF via ${msg.gifAttribution}`}
                                  >
                                    via {msg.gifAttribution}
                                  </span>
                                )}
                              </span>
                            )
                          )}
                          {/* Phase 4: round video renders as a circle (tap to play). */}
                          {msg.mediaUrl && msg.mediaType === 'video' && msg.isRoundVideo && (
                            mediaAutoBlocked(msg, mine) ? (
                              <button
                                type="button"
                                onClick={() => setTappedMedia((prev) => new Set(prev).add(msg.id))}
                                className="flex h-40 w-40 shrink-0 cursor-pointer items-center justify-center rounded-full mb-1 bg-black/10 dark:bg-white/10 px-4 text-sm text-gray-600 dark:text-text-secondary"
                              >
                                Round video — tap to download
                              </button>
                            ) : (
                              <RoundVideoPlayer url={msg.mediaUrl} posterUrl={msg.posterUrl} duration={msg.duration} isMine={mine} />
                            )
                          )}
                          {msg.mediaUrl && msg.mediaType === 'video' && !msg.isRoundVideo && (
                            mediaAutoBlocked(msg, mine) ? (
                              <button
                                type="button"
                                onClick={() => void downloadMediaWithProgress(msg)}
                                className="w-full max-w-xs rounded-lg mb-1 bg-black/10 dark:bg-white/10 px-4 py-8 text-sm text-gray-600 dark:text-text-secondary"
                              >
                                {typeof mediaDownloadProgress[msg.id] === 'number' && mediaDownloadProgress[msg.id] < 100
                                  ? `Downloading… ${mediaDownloadProgress[msg.id]}%`
                                  : 'Video — tap to download'}
                                {typeof mediaDownloadProgress[msg.id] === 'number' && mediaDownloadProgress[msg.id] < 100 && (
                                  <span className="block h-1.5 bg-black/15 dark:bg-white/15 rounded-full overflow-hidden mt-2">
                                    <span className="block h-full bg-primary-green transition-all" style={{ width: `${mediaDownloadProgress[msg.id]}%` }} />
                                  </span>
                                )}
                              </button>
                            ) : (
                              <div
                                className="relative cursor-pointer max-w-xs rounded-lg overflow-hidden mb-1 group"
                                onClick={() => openLightbox({ url: mediaLocalUrls[msg.id] || msg.mediaUrl, type: 'video', senderName: msg.senderName, time: formatTime(msg.timestamp), caption: captionText || undefined }, chatMediaItems())}
                              >
                                {/* Phase 4: posterUrl is the captured poster frame (see
                                    uploadChatMediaWithPoster); older videos without one
                                    fall back to the video's own first frame. */}
                                <video
                                  src={mediaLocalUrls[msg.id] || msg.mediaUrl}
                                  poster={msg.posterUrl || undefined}
                                  preload="metadata"
                                  className="w-full rounded-lg"
                                  onLoadedMetadata={(e) => {
                                    // WA parity (DM audit row 69): capture the
                                    // duration for the thumbnail badge.
                                    const d = (e.currentTarget as HTMLVideoElement).duration;
                                    if (Number.isFinite(d) && d > 0) {
                                      setVideoDurations((prev) => (prev[msg.id] ? prev : { ...prev, [msg.id]: d }));
                                    }
                                  }}
                                />
                                <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                                  <Play className="h-10 w-10 text-white fill-current opacity-80" />
                                </div>
                                {msg.isHD && (
                                  <span className="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] font-bold px-1.5 py-0.5 rounded" title="Sent in HD — original quality">HD</span>
                                )}
                                {formatMediaDuration(videoDurations[msg.id] ?? msg.duration) && (
                                  <span className="absolute bottom-1.5 left-1.5 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded">{formatMediaDuration(videoDurations[msg.id] ?? msg.duration)}</span>
                                )}
                                {/* WA parity (DM audit row 27): captionless
                                    video — meta overlays the media's
                                    bottom-right instead of a row below it. */}
                                {overlayOnMedia && renderBubbleMeta('overlay')}
                              </div>
                            )
                          )}
                          {msg.mediaUrl && msg.mediaType === 'audio' && (

                            mediaAutoBlocked(msg, mine) ? (
                              <button
                                type="button"
                                onClick={() => setTappedMedia((prev) => new Set(prev).add(msg.id))}
                                className="w-full max-w-xs rounded-lg mb-1 bg-black/10 dark:bg-white/10 px-4 py-8 text-sm text-gray-600 dark:text-text-secondary"
                              >
                                🎵 Audio — tap to download
                              </button>
                            ) : (
                            <div className="mb-1">
                              {/* WA parity (verify dm-4 row 72): an audio
                                  FILE is not a voice note — show its name /
                                  size / type above the player, like WhatsApp's
                                  audio-file card. Voice notes keep the bare
                                  player. */}
                              {!isVoiceNoteMsg(msg) && (
                                <div className="flex items-center gap-2 px-1 pb-1 min-w-[220px]">
                                  <span className="h-8 w-8 rounded-md bg-primary-green/15 text-primary-green flex items-center justify-center flex-shrink-0 text-sm">🎵</span>
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium truncate">{msg.fileName || 'Audio file'}</span>
                                    <span className="block text-[11px] opacity-70">{formatFileSize(msg.fileSize)}{msg.fileType ? ` · ${fileTypeLabel(msg.fileType, msg.fileName)}` : ''}</span>
                                  </span>
                                </div>
                              )}
                              {/* Phase 4: pass stored real peaks; the player decodes
                                  the audio itself for older notes without them. */}
                              <VoiceNotePlayer url={msg.mediaUrl} duration={msg.duration} isMine={mine} waveform={msg.waveform} seed={msg.id} onUpload={() => void reuploadVoiceNote(msg)} uploading={reuploadingVoiceIds.has(msg.id)} />
                            </div>
                            )
                          )}
                          {msg.mediaUrl && msg.mediaType === 'file' && (
                            mediaAutoBlocked(msg, mine) ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  // WA parity (DM audit row 80): tap
                                  // downloads the document — the old
                                  // placeholder only revealed the card, so
                                  // it took a second tap to actually save.
                                  setTappedMedia((prev) => new Set(prev).add(msg.id));
                                  const ok = await saveRemoteFile(msg.mediaUrl, msg.fileName || 'file');
                                  showToastMsg(ok ? 'Saved to Downloads ✓' : 'Could not save file');
                                }}
                                className="w-full max-w-xs rounded-lg mb-1 bg-black/10 dark:bg-white/10 px-4 py-8 text-sm text-gray-600 dark:text-text-secondary"
                              >
                                <span className="block font-medium truncate">{msg.fileName || 'Document'}</span>
                                <span className="block text-xs opacity-70 mt-0.5">{formatFileSize(msg.fileSize)} · tap to download</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const ok = await saveRemoteFile(msg.mediaUrl, msg.fileName || 'file');
                                  showToastMsg(ok ? 'Saved to Downloads ✓' : 'Could not save file');
                                }}
                                className="flex w-full text-left items-center gap-3 p-2 rounded-lg bg-black/5 dark:bg-white/5 mb-1 min-w-[220px] max-w-xs"
                              >
                                <div className="h-10 w-10 rounded-md bg-primary-green/15 text-primary-green flex items-center justify-center flex-shrink-0 text-lg">📄</div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium truncate">{msg.fileName || 'Document'}</p>
                                  <p className="text-[11px] opacity-70">{formatFileSize(msg.fileSize)}{msg.fileType ? ` · ${fileTypeLabel(msg.fileType, msg.fileName)}` : ''} · Tap to save</p>
                                </div>
                              </button>
                            )
                          )}
                          {/* 100M-F2: media caption — renders under the
                              media (photo/video/audio/file), like WhatsApp.
                              The media label ("Photo" etc.) stays
                              suppressed below; the caption is the user's
                              text. A failed caption decrypt shows the
                              placeholder italic, like a failed body. */}
                          {captionText && (
                            <p className="dt-msg-text leading-snug whitespace-pre-wrap break-words">
                              {msg.captionDecryptError ? (
                                <span className="italic opacity-70">{captionText}</span>
                              ) : (
                                renderRichText(captionText, mine, searchQueryDebounced, isCurrentMatch)
                              )}
                              {/* WA parity (DM audit row 27): time + ticks
                                  float inline at the bottom-right of the
                                  caption's last line. */}
                              {inlineInCaption && renderBubbleMeta('inline')}
                            </p>
                          )}
                        </>
                      )}

                      {/* Event card (EventCard — RSVP Going / Maybe /
                          Not going, reminder, host cancel). */}
                      {msg.type === 'event' ? (
                        <EventCard
                          event={{
                            id: msg.id,
                            eventName: msg.eventName || 'Event',
                            startAt: msg.startAt,
                            location: msg.location,
                            description: msg.description,
                            reminderMinutes: msg.reminderMinutes ?? 30,
                            rsvps: msg.rsvps || {},
                            hostUid: msg.hostUid,
                            hostName: msg.hostName,
                            canceled: msg.canceled === true,
                            senderName: msg.senderName,
                          }}
                          currentUserId={currentUser?.uid}
                          memberNames={memberNamesByUid}
                          onRsvp={(value) => rsvpEvent(msg.id, value)}
                          onReminderChange={(minutes) => changeEventReminder(msg.id, minutes)}
                          onCancel={() => cancelEvent(msg.id)}
                        />
                      ) : msg.type === 'poll' ? (
                        <PollCard
                          poll={{
                            question: msg.pollQuestion,
                            options: msg.pollOptions || [],
                            votes: msg.pollVotes || {},
                            multiAnswer: msg.pollMultiAnswer === true,
                            maxChoices: msg.pollMaxChoices,
                          }}
                          currentUserId={currentUser?.uid}
                          onVote={(selection) => votePoll(msg.id, selection)}
                          onLimitReached={(max) => showToastMsg(`You can pick up to ${max} options`)}
                          // WA audit (d) C8 — channel polls open the full
                          // results sheet (per-option voter lists). DMs keep
                          // the inline-only behaviour (no onViewResults).
                          onViewResults={isChannelDoc ? () => setPollResultsMsg(msg) : undefined}
                        />
                      ) : msg.type === 'live-location' ? (
                        <LiveLocationCard
                          data={{
                            type: 'live-location',
                            liveLocationId: msg.liveLocationId || msg.id,
                            latitude: msg.latitude,
                            longitude: msg.longitude,
                            locationAccuracy: msg.locationAccuracy,
                            liveLocationExpiresAt: msg.liveLocationExpiresAt || 0,
                            liveLocationUpdatedAt: msg.liveLocationUpdatedAt || 0,
                            liveLocationActive: !!msg.liveLocationActive,
                            senderId: msg.senderId,
                            senderName: msg.senderName,
                          }}
                          isMine={mine}
                          onToast={showToastMsg}
                          onStopSharing={mine && isLiveLocationActive({ liveLocationActive: !!msg.liveLocationActive, liveLocationExpiresAt: msg.liveLocationExpiresAt || 0 }, liveNow) ? () => { void stopMyLiveLocation(); } : undefined}
                        />
                      ) : msg.type === 'location' ? (
                        <LocationMessageCard
                          data={{
                            latitude: msg.latitude,
                            longitude: msg.longitude,
                            locationLabel: msg.locationLabel,
                            locationAccuracy: msg.locationAccuracy,
                          }}
                          isMine={mine}
                          onToast={showToastMsg}
                        />
                      ) : msg.type === 'contact' ? (
                        <ContactMessageCard
                          data={{
                            contactName: msg.contactName,
                            contactPhone: msg.contactPhone,
                            contactAvatar: msg.contactAvatar,
                          }}
                          isMine={mine}
                          // #89: Message button when the shared contact is
                          // an app user (never for phone-only contacts, and
                          // never for your own card).
                          onMessage={
                            msg.contactUid && msg.contactUid !== currentUser?.uid
                              ? () => navigate(`/chat/${msg.contactUid}`)
                              : undefined
                          }
                          onToast={showToastMsg}
                        />
                      ) : (
                        msg.type !== 'sticker' && msg.type !== 'gif' && !['Photo', 'Video', 'Audio', 'Round video'].includes(display.text) && (
                          display.state === 'decrypting' ? (
                            <p className="dt-msg-text leading-snug whitespace-pre-wrap break-words italic opacity-60">🔒 Decrypting…</p>
                          ) : display.text ? (
                            <>
                              {/* E5: an emoji-only message (1–3 emoji, no
                                  text) renders large, like WhatsApp. */}
                              <p data-emoji-only={emojiOnlySize(display.text) ? 'true' : 'false'} className={`${emojiOnlySize(display.text) || 'dt-msg-text'} ${emojiOnlySize(display.text) ? 'relative' : ''} leading-snug whitespace-pre-wrap break-words`}>
                                {display.state === 'decrypt-failed' ? (
                                  <span className="italic opacity-70">{display.text}</span>
                                ) : (
                                  renderRichText(display.text, mine, searchQueryDebounced, isCurrentMatch)
                                )}
                                {msg.edited && <span className="text-[10px] opacity-50 ml-1" title={msg.editedAt ? `Edited ${fmtDateTime(msg.editedAt)}` : 'Edited'}>(edited)</span>}
                                {/* WA parity (DM audit row 27): emoji-only
                                    messages put the small time at the
                                    bottom-right of the large emoji — absolute
                                    (a float would pin to the TOP of the
                                    oversized emoji line box). */}
                                {emojiOnlyMeta && renderBubbleMeta('absolute')}
                                {inlineInText && renderBubbleMeta('inline')}
                              </p>
                              {/* Worker A: a decrypt failure used to be a dead
                                  bubble. Retry clears the cached failure so
                                  the decrypt effect re-runs with the current
                                  keys, and re-requests the peer's key with a
                                  fresh announce (throttle cleared). 'no-key'
                                  usually heals; 'bad-key' means the sender
                                  re-installed — the peer must resend after
                                  the fresh exchange. Never crashes: every
                                  step is guarded and failures toast. */}
                              {display.state === 'decrypt-failed' && (
                                <button
                                  type="button"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    setDecrypted((prev) => {
                                      const next = { ...prev };
                                      delete next[msg.id];
                                      return next;
                                    });
                                    try {
                                      if (!conversationId || !currentUser?.uid) throw new Error('no chat');
                                      // W16 (#183): groups re-request with a
                                      // group member-announce, NOT the 1-to-1
                                      // announce — a 1-to-1 key-exchange doc
                                      // in a group channel is the wrong
                                      // protocol (no peer to agree a key
                                      // with); the sender re-wraps their
                                      // sender key when they see the fresh
                                      // group announce.
                                      const announce = isCommunity
                                        ? await requestGroupKeyReExchange(conversationId, currentUser.uid)
                                        : await requestKeyReExchange(conversationId, currentUser.uid);
                                      await addDoc(collection(db, 'chats', conversationId, 'messages'), {
                                        ...announce, timestamp: Date.now(), senderId: currentUser.uid,
                                      });
                                    } catch {
                                      showToastMsg('Could not re-request keys — check your connection and try again');
                                    }
                                  }}
                                  title={msg.decryptFailureReason === 'bad-key' ? 'Decryption failed — the sender may have reinstalled. Retry re-requests their key; they may need to resend this message.' : 'Decryption failed — keys may not have arrived yet. Retry re-requests them.'}
                                  className="mt-1 inline-flex items-center gap-1 rounded-full bg-black/10 dark:bg-white/10 px-2.5 py-1 text-[11px] font-semibold opacity-80 hover:opacity-100"
                                >
                                  ↻ Retry decryption
                                </button>
                              )}
                            </>
                          ) : null
                        )
                      )}
                      {/* Phase 4: link preview under the first URL in the message.
                          Only for plain text messages (not media labels, polls,
                          stickers, location/contact cards, or deleted messages).
                          WA parity (audit e #31): "Turn off link previews" in
                          Settings > Privacy gates it — off = no preview card. */}
                      {!msg.deleted && msg.type !== 'sticker' && msg.type !== 'gif' && msg.type !== 'poll' && msg.type !== 'location' && msg.type !== 'live-location' && msg.type !== 'contact' && firstUrlInText(display.text) && getLinkPreviewsEnabled() && (
                        <LinkPreviewCard url={firstUrlInText(display.text) as string} meta={hasLinkPreview ? renderBubbleMeta('row', false) : undefined} />
                      )}
                    </>
                  )}

                  {/* Time + status — WA parity (DM audit row 27):
                      text bubbles and media captions float this meta
                      inline inside their last line, captionless media
                      overlays it, emoji-only / sticker anchor it
                      absolute bottom-right, and link-preview cards host
                      it at their bottom-right (see renderBubbleMeta
                      above); every other shape keeps this right-aligned
                      row below the content — for cards, audio and
                      documents that row IS the WA placement (meta at the
                      bubble's bottom-right below the card/player). */}
                  {!hasInlineMeta && (
                    <div className="flex items-center justify-end gap-1 mt-0.5">
                      {bubbleMeta}
                    </div>
                  )}
                  {/* WA parity (DM audit row 27): stickers float with no
                      bubble — the meta sits at the sticker's bottom-right. */}
                  {stickerMeta && renderBubbleMeta('absolute')}
                </div>

                {/* Reaction chips — counts validated by ReactionChips
                    (junk stored values are skipped, my reaction is
                    highlighted); tap opens the who-reacted sheet.
                    Wave-2 A5 (DM #42) NOT APPLIED — verify-first failed:
                    the WA value (chips float overlapping the bubble's
                    bottom edge) was NOT found in the extracted WA client
                    (~/workspace/whatsapp/wa-client/): the stylesheet is
                    atomic single-property classes with no component
                    association, and no JS hit ties reaction chips to a
                    negative-margin/overlap layout. The audit says the
                    same ("not verified from this client"). Do NOT guess
                    the overlap — confirm on a real phone first. */}
                <ReactionChips
                  reactions={msg.reactions}
                  myUid={currentUser?.uid}
                  onChipClick={() => setReactionDetailsMsg(msg)}
                />

                {/* Quick actions on hover */}
                <div className={`absolute top-0 ${mine ? 'left-0 -translate-x-full pr-2' : 'right-0 translate-x-full pl-2'} hidden group-hover:flex items-center gap-1`}>
                  <button
                    onClick={(e) => { e.stopPropagation(); if (showReactPicker === msg.id) { setShowReactPicker(null); } else if (channelPolicyRef.current === 'none') { showToastMsg('Reactions are off in this channel'); } else { const top = messagesScrollRef.current?.getBoundingClientRect().top ?? 0; setReactPickerBelow(e.clientY - top < 120); setShowReactPicker(msg.id); } }}
                    className="p-1.5 rounded-full bg-white dark:bg-input-dark shadow-md hover:scale-110 transition-transform"
                  >
                    <Smile className="h-4 w-4 text-gray-500" />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setReplyTo(msg); inputRef.current?.focus(); }}
                    className="p-1.5 rounded-full bg-white dark:bg-input-dark shadow-md hover:scale-110 transition-transform"
                  >
                    <Reply className="h-4 w-4 text-gray-500" />
                  </button>
                </div>

                {/* Reaction picker — the real ReactionPicker component:
                    6-quick row + "+" expanding to the full picker
                    (search, recents, all 9 categories). onSelect reuses
                    the existing toggle-save (pickReaction → addReaction);
                    myReaction highlights my current reaction. */}
                {showReactPicker === msg.id && (
                  <div data-reaction-picker className={`absolute ${mine ? 'right-0' : 'left-0'} ${reactPickerBelow ? 'top-full mt-2' : '-top-12'} z-50 flex flex-col ${mine ? 'items-end' : 'items-start'} gap-1`}>
                    <ReactionPicker
                      myReaction={getMyReaction(msg.reactions, currentUser?.uid)}
                      senderName={msg.senderId === currentUser?.uid ? 'You' : (msg.senderName || 'Someone')}
                      onSelect={(emoji) => pickReaction(msg.id, emoji)}
                      onClose={() => setShowReactPicker(null)}
                      quickOnly={channelPolicyRef.current === 'default'}
                    />
                    {/* R2: multi-select entry point — long-press now opens
                        this picker on touch, so select mode is entered
                        from here (or the context menu, or by long-pressing
                        while already in select mode).
                        Worker B (V10): this button MUST be `relative z-50`.
                        ReactionPicker's popover renders a transparent
                        `fixed inset-0 z-40` backdrop button that covers the
                        whole viewport — a static sibling after it paints
                        UNDER that backdrop, so every tap hit "Close
                        reaction picker" instead (elementFromPoint proved
                        it) and Select looked dead on real taps and on
                        hit-tested el.click(). The picker's own body uses
                        `relative z-50` for exactly this reason; the
                        button mirrors it, so it sits above the backdrop
                        and its onClick (enterSelectMode, the same path as
                        the context-menu Select entry) actually fires. */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setShowReactPicker(null); enterSelectMode(msg); }}
                      className="relative z-50 flex items-center gap-1.5 rounded-full bg-white dark:bg-input-dark shadow-md px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-text-secondary hover:scale-105 transition-transform"
                    >
                      <CheckSquare className="h-3.5 w-3.5" /> Select
                    </button>
                  </div>
                )}
              </div>
            </div>)}
            </React.Fragment>
          );
        }), [
    filteredMsgs,
    renderMsgs,
    albumGroups,
    albumFirstIds,
    albumExpanded,
    unreadInfo,
    searchQuery,
    searchQueryDebounced,
    searchIdx,
    decrypted,
    currentUser,
    conversationId,
    isCommunity,
    readReceipts,
    seenUpToByUid,
    deliveredUpToByUid,
    highlightedMsgId,
    selectedIds,
    selectMode,
    showReactPicker,
    reactPickerBelow,
    swipingMsgId,
    swipeOffset,
    tappedMedia,
    disappearAfter,
    bubbleSent,
    bubbleRecv,
    bubbleText,
    // V10: the view-once voice player lives INSIDE these memoized bubbles
    // — without this dep the tap sets the state (fiber proves it) but the
    // memo keeps the stale closure and the player never appears.
    viewOnceVoiceOpenId,
    // WA parity (merge follow-up, Worker F): same bug class for B's
    // tap-to-download state — without these deps a download completing
    // (or starting) leaves the bubble showing the stale tap-to-download UI.
    mediaLocalUrls,
    mediaDownloadProgress,
  ]);

  const goToSearchMatch = (dir: 1 | -1) => {
    if (!filteredMsgs.length) return;
    const next = (searchIdx + dir + filteredMsgs.length) % filteredMsgs.length;
    setSearchIdx(next);
    scrollToMsg(filteredMsgs[next].id);
  };

  // ── ROADMAP-2 item 11: jump to a date ──
  // Finds the first message of the chosen day, expands pagination so it
  // renders, then scrolls + highlights it (same as a search match).
  // dayKey is NOT zero-padded ("2026-11-4"), so the input's ISO value is
  // converted through dayKey instead of compared raw.
  const jumpToDate = (isoDate: string) => {
    setJumpDate(isoDate);
    if (!isoDate) return;
    // Audit #3: a text search filters the rendered list, so the target of
    // a date jump usually is not in the DOM and scrollToMsg reports
    // "not found". Exit filtered mode first — clear the query AND the
    // debounced copy, so the list un-filters immediately instead of after
    // the 250 ms debounce (the 80 ms scroll below would otherwise fire
    // while the list is still filtered).
    if (searchQuery || searchQueryDebounced) {
      setSearchQuery('');
      setSearchQueryDebounced('');
    }
    const key = dayKey(new Date(`${isoDate}T00:00:00`));
    const target = visibleMsgs.find((m: any) => dayKey(m.timestamp) === key);
    if (!target) { showToastMsg('No messages on that date'); return; }
    const idx = visibleMsgs.findIndex((m: any) => m.id === target.id);
    if (idx >= 0 && idx < visibleMsgs.length - visibleCount) setVisibleCount(visibleMsgs.length - idx);
    // The scroll must wait a tick: the page expansion above renders first.
    setTimeout(() => scrollToMsg(target.id), 80);
  };

  // 100M-H24: Saved/Starred "Open in chat ↗" used to plain-navigate() to
  // the chat, which opens at the bottom — an old saved message sat far
  // above the viewport with no highlight. The opener passes the saved
  // message id as location.state.jumpToMessageId; once the messages have
  // loaded, expand pagination so the target renders (same pattern as
  // jumpToDate above), then scroll + highlight it in context.
  //
  // Wave-race (proven live 2026-11-17): subscribe() delivers an EMPTY
  // first snapshot — the in-memory map, before the IDB restore lands —
  // and ChatScreen marks messagesLoaded on that empty wave. The first
  // version of this effect toasted "not found" + consumed the request on
  // that empty wave and could never retry. So the request lives in a
  // pending ref until it is actually fulfilled: no verdict while the list
  // is still empty (only a non-empty list lacking the target means "not
  // in this chat"), the page expansion re-runs the effect via the
  // visibleCount dep instead of a fixed 80 ms timeout, and the state is
  // cleared (replace) only after the scroll — so going Back never
  // re-jumps. A pending request belongs to its conversation; navigating
  // to another chat drops it instead of toasting there.
  const pendingJumpRef = useRef<{ conv: string; id: string } | null>(null);
  useEffect(() => {
    const targetId = (location.state as any)?.jumpToMessageId as string | undefined;
    if (targetId && conversationId) {
      pendingJumpRef.current = { conv: conversationId, id: targetId };
      jumpHoldRef.current = Date.now() + 10000; // hold the auto-scroll off from the first commit
    }
    const pending = pendingJumpRef.current;
    if (!pending || pending.conv !== conversationId || !messagesLoaded) return;
    const id = pending.id;
    const idx = visibleMsgs.findIndex((m: any) => m.id === id);
    if (idx < 0) {
      if (visibleMsgs.length === 0) return; // empty first wave — wait
      showToastMsg('Original message not found in this chat');
      pendingJumpRef.current = null;
      jumpHoldRef.current = 0; // release the auto-scroll…
      messagesScrollRef.current?.scrollTo({ top: messagesScrollRef.current.scrollHeight }); // …and open at the bottom like a normal chat
      navigate(location.pathname, { replace: true, state: {} });
      return;
    }
    if (idx < visibleMsgs.length - visibleCount) {
      setVisibleCount(visibleMsgs.length - idx);
      return; // re-run once the page has expanded
    }
    // Mount-time ordering: the auto-scroll effect re-fires on the
    // hiddenLoaded flip (first paint of the real tree) and scrolls to
    // the bottom — if this jump scrolled first, the flip yanks the chat
    // back down (proven live: target highlighted but 2785 px above the
    // viewport). Wait for the flip; the pending ref keeps the request.
    if (!hiddenLoaded) return;
    if (!document.getElementById(`msg-${id}`)) return; // render catching up
    scrollToMsg(id);
    jumpHoldRef.current = Date.now() + 4000; // keep post-mount waves (announce, peer ack) off the target for 4 s
    pendingJumpRef.current = null;
    navigate(location.pathname, { replace: true, state: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, messagesLoaded, visibleMsgs, visibleCount, conversationId, hiddenLoaded]);
  const bulkCopy = async () => {
    // WA parity (DM audit row 84): view-once messages can never be
    // copied — the context menu blocks it; multi-select must too.
    // WA parity (verify dm-4 row 62): a captioned media message copies
    // its caption, not '[Media]'; a decrypt-failed message never copies
    // its placeholder (copyableTextFor).
    const selCopy = visibleMsgs.filter(m => selectedIds.includes(m.id));
    const copyable = selCopy.filter(m => !m.isViewOnce);
    if (copyable.length < selCopy.length) showToastMsg('View-once messages can’t be copied');
    if (!copyable.length) { setSelectedIds([]); return; }
    const texts = copyable.map(m => copyableTextFor(m) || '[Media]').join('\n');
    await copyMsg(texts);
    setSelectedIds([]);
  };
  const bulkStar = async () => {
    // WA parity (DM audit row 84): view-once messages can never be
    // starred — the context menu blocks it; multi-select must too.
    const sel = visibleMsgs.filter(m => selectedIds.includes(m.id));
    const starrable = sel.filter(m => !m.isViewOnce);
    if (starrable.length < sel.length) showToastMsg('View-once messages can’t be starred');
    if (!starrable.length) { setSelectedIds([]); return; }
    for (const m of starrable) {
      if (!starredIds.includes(m.id)) await starMsg(m);
    }
    setSelectedIds([]);
    showToastMsg('Starred ⭐');
  };

  // ── Wallpaper style (theme fix: per-chat theme + brightness dim) ──
  // wallpaperDim 0–100 (100 = full brightness): below 100 a black overlay
  // dims the wallpaper only — bubbles stay full colour, like WhatsApp.
  const dimAlpha = Math.max(0, Math.min(100, 100 - chatLook.wallpaperDim)) / 100;
  const dimOverlay = dimAlpha > 0
    ? `linear-gradient(rgba(0,0,0,${dimAlpha.toFixed(2)}), rgba(0,0,0,${dimAlpha.toFixed(2)}))`
    : '';
  // WA parity (wa-verify-settings-3, rows 38/39/40): the wallpaper style
  // is built once from chatLook and applies in BOTH app modes — the old
  // code dropped the wallpaper image / pattern / dim entirely whenever
  // the per-chat "Light chat theme" toggle was on, so a chosen wallpaper
  // vanished in light mode. The toggle now only selects the plain-
  // background override, for this chat only (see getLightChatTheme).
  // WhatsApp parity (fix 4): both modes use the theme value (chatBg), so
  // a custom wallpaper colour applies in light mode too.
  const wallpaperStyle: React.CSSProperties = chatLook.wallpaperImg
    ? chatLook.wallpaperTile
      // WA parity (audit e): the dark pattern tile is 320×70 — repeat it
      // like WhatsApp repeats its pattern, never stretch it to cover.
      ? { backgroundImage: dimOverlay ? `${dimOverlay}, url(${chatLook.wallpaperImg})` : `url(${chatLook.wallpaperImg})`, backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'top left' }
      : { backgroundImage: dimOverlay ? `${dimOverlay}, url(${chatLook.wallpaperImg})` : `url(${chatLook.wallpaperImg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : chatLook.def.variant === 'pattern'
    ? { backgroundColor: chatLook.wallpaperColor || chatBg, backgroundImage: dimOverlay ? `${dimOverlay}, url(${patternDataUri(chatIsDark)})` : `url(${patternDataUri(chatIsDark)})` }
    : { backgroundColor: chatLook.wallpaperColor || chatBg };
  const wallStyle: React.CSSProperties = lightTheme
    ? { backgroundColor: chatLook.wallpaperColor || chatBg }
    : wallpaperStyle;

  // Phase 5 — locked-chat route guard (L-02). A locked chat renders NOTHING
  // (not even its header, avatar or last-seen) until the folder PIN /
  // biometric has been passed in this session. The guard is styled
  // WhatsApp Classic Pro via PinScreen (P-11: #075E54 header).
  // App-lock fix (2026-11-14): `lockGuardPassedRef` makes the guard sticky
  // per mount (see above) — once this chat has rendered unlocked, a later
  // re-render (incoming message, typing) can no longer resurrect the PIN
  // screen mid-chat. Leaving the chat still re-locks via the unmount
  // effect below.
  if (hiddenLoaded && isHidden && !isCommunity && !lockedGatePassed && !(lockGuardPassedRef.current && lockGuardChatIdRef.current === partnerUid) && !isLockedFolderUnlocked()) {
    return (
      <PinScreen
        title="Locked Chat"
        pinKey={LOCKED_PIN_KEY}
        // W30f: PinScreen trusts allowBiometric as passed — the locked-chat
        // opt-in lives in the vault pref, so pass it explicitly here.
        allowBiometric={getBiometricPref() === '1'}
        onSuccess={() => {
          unlockLockedFolder();
          setLockedGatePassed(true);
        }}
      />
    );
  }
  if (!hiddenLoaded && !isCommunity) {
    return (
      <div className="flex h-screen items-center justify-center bg-white dark:bg-[#0B141A]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#075E54] border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-wallpaper-light dark:bg-bg-dark">

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-xl animate-toast">
          {toast}
        </div>
      )}

      {/* Header — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm z-10 flex-shrink-0">
        <div className="flex items-center justify-between px-2 py-2">
          <div className="flex items-center min-w-0 flex-1">
            <button aria-label="Back" onClick={() => navigate(-1)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-600 dark:text-text-secondary hover:bg-gray-100 dark:hover:bg-input-dark rounded-full flex-shrink-0">
              <ArrowLeft className="h-6 w-6" />
            </button>
            <div
              onClick={() => isCommunity ? setShowGroupInfo(true) : setShowProfileModal(true)}
              className="flex items-center min-w-0 flex-1 cursor-pointer hover:opacity-90 transition-opacity"
              title={isCommunity ? 'View group info' : 'View contact info'}
            >
              <DefaultAvatar
                photoURL={otherUser?.photoURL}
                name={otherUser?.displayName || otherUser?.username || otherUser?.name || 'User'}
                seed={partnerUid}
                size={40}
                className="ml-1 ring-1 ring-gray-200 dark:ring-white/10"
                alt="Avatar"
              />
              <div className="ml-3 min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-900 dark:text-text-primary truncate">
                  {isCommunity ? otherUser?.name : (otherUser?.displayName || otherUser?.username || '...')}
                </h2>
                <p className="text-xs text-gray-500 dark:text-text-secondary truncate" title={isCommunity ? groupHeaderSubtitle : undefined}>
                  {isPartnerRecording
                    ? <span className="text-primary-green animate-pulse">{tr('recordingAudio')}</span>
                    : isPartnerTyping || groupTypingUids.length > 0
                    ? <span className="text-primary-green animate-pulse">{isCommunity ? groupTypingText : tr('typing')}</span>
                    : isCommunity
                    ? groupHeaderSubtitle
                    : lastSeenText(otherUser, Date.now(), currentUser?.uid)}
                </p>
                {disappearAfter > 0 && !isPartnerTyping && !isPartnerRecording && groupTypingUids.length === 0 && (
                  <p className="text-[11px] text-primary-green flex items-center gap-1">
                    <Timer className="h-3 w-3" /> Messages disappear after {disappearLabel(disappearAfter)} · long-press a message to keep it
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="flex space-x-1 text-gray-600 dark:text-text-secondary relative flex-shrink-0">
            {/* RETEST-1: no call buttons in a self-DM (partnerUid === own uid) —
                tapping them started a call to yourself that silently never
                showed any UI. WhatsApp's self-chat has no call buttons. */}
            {!isCommunity && partnerUid !== currentUser?.uid && (
              <>
                <button aria-label="Video call" onClick={() => handleCall('video')} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-gray-100 dark:hover:bg-input-dark rounded-full"><Video className="h-6 w-6" /></button>
                <button aria-label="Voice call" onClick={() => handleCall('audio')} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-gray-100 dark:hover:bg-input-dark rounded-full"><Phone className="h-6 w-6" /></button>
              </>
            )}
            <button ref={searchToggleRef} aria-label="Chat menu" aria-expanded={showMenu} onClick={() => setShowMenu(!showMenu)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center hover:bg-gray-100 dark:hover:bg-input-dark rounded-full"><MoreVertical className="h-6 w-6" /></button>

            {showMenu && (
              <div ref={menuRef} className="absolute right-0 top-12 w-64 rounded-xl bg-panel-light dark:bg-panel-dark shadow-2xl ring-1 ring-black/10 dark:ring-white/10 z-50 overflow-hidden divide-y divide-gray-100 dark:divide-white/5">
                <div className="py-1">
                  {[
                    ...(isCommunity ? [{ label: 'Group info', icon: <Users className="h-5 w-5" />, action: () => { setShowGroupInfo(true); setShowMenu(false); } }] : [
                      // WA parity (DM audit row 10): contact info in the menu too.
                      { label: 'View contact', icon: <User className="h-5 w-5" />, action: () => { setShowProfileModal(true); setShowMenu(false); } },
                    ]),
                    // WA parity (DM audit rows 8, 9, 11): Mute / Mark as unread /
                    // Report are DM-only here — the mute pref key is a DM
                    // partner uid, and Report blocks a contact.
                    ...(isCommunity ? [] : [
                      { label: chatMuted ? 'Unmute notifications' : 'Mute notifications', icon: chatMuted ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />, action: () => { void handleToggleChatMute(); setShowMenu(false); } },
                      { label: 'Mark as unread', icon: <MailOpen className="h-5 w-5" />, action: () => { void handleMarkAsUnread(); setShowMenu(false); } },
                      { label: 'Report', icon: <Flag className="h-5 w-5" />, action: () => { setShowReportConfirm(true); setShowMenu(false); } },
                    ]),
                    { label: 'Starred messages', icon: <Star className="h-5 w-5" />, action: () => { setShowMenu(false); navigate('/starred'); } },
                    { label: disappearAfter ? `Disappearing messages: ${disappearLabel(disappearAfter)}` : 'Disappearing messages', icon: <Timer className="h-5 w-5" />, action: () => { setShowDisappearModal(true); setShowMenu(false); } },
                    { label: lightTheme ? 'Light chat theme: On' : 'Light chat theme', icon: <Sun className="h-5 w-5" />, action: () => { const next = !lightTheme; setLightTheme(next); setLightChatTheme(partnerUid || '', next); setShowMenu(false); } },
                    { label: 'Chat theme & wallpaper', icon: <Palette className="h-5 w-5" />, action: () => { setShowChatTheme(true); setShowMenu(false); } },
                    // REPORT-3 #65 (W20): per-chat notification tone —
                    // overrides the global/group tone for this chat only.
                    { label: `Notification tone: ${chatToneLabel}`, icon: <Bell className="h-5 w-5" />, action: () => { setShowToneModal(true); setShowMenu(false); } },
                    { label: 'Media, links and docs', icon: <Folder className="h-5 w-5" />, action: () => { setShowMediaGallery(true); setShowMenu(false); } },
                    { label: 'Save Chat to Saved Messages', icon: <Bookmark className="h-5 w-5" />, action: saveEntireChat },
                    { label: 'Export Chat History (.txt)', icon: <Download className="h-5 w-5" />, action: exportChatTxt },
                    // ROADMAP-2 item 10: per-user clear — hides messages
                    // for me only, never deletes them for the other side.
                    { label: 'Clear chat', icon: <Eraser className="h-5 w-5" />, action: () => { setShowClearConfirm(true); setShowMenu(false); } },
                    { label: 'Search in conversation', icon: <Search className="h-5 w-5" />, action: () => { openSearch(); setShowMenu(false); } },
                    { label: isHidden ? 'Unhide Chat' : 'Hide Chat', icon: isHidden ? <LockOpen className="h-5 w-5" /> : <Lock className="h-5 w-5" />, action: toggleHideChat },
                    ...(isCommunity ? [] : [{ label: isBlocked ? 'Unblock User' : 'Block User', icon: isBlocked ? <Check className="h-5 w-5" /> : <Ban className="h-5 w-5" />, action: toggleBlockUser, danger: true }]),
                  ].map((item: any) => (
                    <button
                      key={item.label}
                    onClick={item.action}
                    className={`flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-input-dark ${item.danger ? 'text-red-500 font-medium' : 'text-gray-900 dark:text-text-primary'}`}
                  >
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>

      {/* Phase 3: offline banner */}
      {isOffline && (
        <div role="status" className="bg-amber-500 text-white text-xs font-medium text-center px-3 py-1.5 flex-shrink-0">
          Offline — messages will send when reconnected
        </div>
      )}

      {/* Report 3 #226/#234 (W5b): subscription lost, poll-only — a delay
          indicator, never a loss indicator. Hidden in mock mode (the pill
          state is never set there) and while the offline banner shows. */}
      {chatReconnecting && !isOffline && (
        <div role="status" className="bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-xs font-medium text-center px-3 py-1.5 flex-shrink-0">
          Reconnecting… — new messages may be delayed
        </div>
      )}

      {/* Phase 3: multi-select toolbar */}
      {selectMode && (
        <div className="flex items-center gap-1 px-2 py-1.5 bg-panel-light dark:bg-panel-dark border-b border-gray-200 dark:border-white/5 flex-shrink-0" role="toolbar" aria-label="Selected messages">
          <button aria-label="Close selection" onClick={() => setSelectedIds([])} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"><X className="h-5 w-5" /></button>
          <span className="text-sm font-semibold text-gray-900 dark:text-text-primary">{selectedIds.length} selected</span>
          <div className="ml-auto flex items-center gap-1">
            {/* WA parity (DM audit row 54): Reply in the multi-select
                toolbar — WA lists Reply first. A reply quotes exactly one
                message, so like WA the button only shows for a single
                selection; it stages the reply, exits select mode and
                focuses the composer (same as the long-press Reply). */}
            {selectedIds.length === 1 && (
              <button aria-label="Reply to selected message" onClick={() => { const m = visibleMsgs.find((x: any) => x.id === selectedIds[0]); if (!m) return; setReplyTo(m); setSelectedIds([]); inputRef.current?.focus(); }} className="p-2 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark"><Reply className="h-5 w-5" /><span className="text-[10px]">Reply</span></button>
            )}
            {/* R2: React action — was missing entirely, so multi-select
                (the old long-press destination) could not react at all.
                Toggles the quick row below; tapping an emoji reacts to
                every selected message (pickReaction → addReaction, which
                is optimistic per message). */}
            <button aria-label="React to selected" aria-expanded={showToolbarReact} onClick={() => setShowToolbarReact(v => !v)} className="p-2 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark"><Smile className="h-5 w-5" /><span className="text-[10px]">React</span></button>
            <button aria-label="Delete selected" onClick={() => setDeleteConfirm({ kind: 'me', ids: [...selectedIds] })} className="p-2 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark text-red-500"><Trash2 className="h-5 w-5" /><span className="text-[10px]">Delete</span></button>
            <button aria-label="Forward selected" onClick={() => { const sel = visibleMsgs.filter(m => selectedIds.includes(m.id)); const fwd = sel.filter(m => !m.isViewOnce); if (fwd.length < sel.length) showToastMsg('View-once messages can’t be forwarded'); if (!fwd.length) return; setForwardMsgs(fwd); const first = fwd[0] || null; setForwardMsg(first); setForwardCaption(fwd.length === 1 ? (first?.caption || '') : ''); }} className="p-2 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark"><Share2 className="h-5 w-5" /><span className="text-[10px]">Forward</span></button>
            <button aria-label="Star selected" onClick={bulkStar} className="p-2 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark"><Star className="h-5 w-5" /><span className="text-[10px]">Star</span></button>
            <button aria-label="Copy selected" onClick={bulkCopy} className="p-2 min-h-[44px] min-w-[44px] flex flex-col items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-input-dark"><Copy className="h-5 w-5" /><span className="text-[10px]">Copy</span></button>
          </div>
        </div>
      )}
      {/* R2: quick-reaction row for the selection above. */}
      {selectMode && showToolbarReact && (
        <div data-reaction-picker className="flex items-center gap-1 px-3 py-2 bg-panel-light dark:bg-panel-dark border-b border-gray-200 dark:border-white/5 flex-shrink-0" role="toolbar" aria-label="React to selected messages">
          {EMOJI_QUICK.map(e => (
            <button key={e} aria-label={`React ${e} to selected messages`} onClick={() => { const ids = [...selectedIds]; ids.forEach(id => pickReaction(id, e)); setShowToolbarReact(false); }} className="text-2xl hover:scale-125 transition-transform p-1 min-h-[44px] min-w-[44px] flex items-center justify-center">
              {e}
            </button>
          ))}
          <button aria-label="More reactions for selected" title="More reactions" onClick={() => { if (channelReactionPolicy === 'none') { showToastMsg('Reactions are off in this channel'); return; } const first = visibleMsgs.find(m => selectedIds.includes(m.id)); setShowToolbarReact(false); if (first) setShowReactPicker(first.id); }} className="h-9 w-9 flex items-center justify-center rounded-full bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary hover:scale-110 transition-transform">
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Chat search bar */}
      {showSearchBar && (
        <div ref={searchBarRef} className="flex items-center gap-2 px-3 py-2 bg-panel-light dark:bg-panel-dark border-b border-gray-200 dark:border-white/5 flex-shrink-0">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            autoFocus
            aria-label={tr('searchInConversation')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={tr('searchInConversation')}
            className="flex-1 bg-transparent text-sm text-gray-900 dark:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary-green rounded-sm placeholder:text-gray-400"
          />
          {/* ROADMAP-2 item 11: jump-to-date — picks a day and scrolls to
              its first message (no match on that day → a toast). */}
          <input
            type="date"
            aria-label="Jump to date"
            title="Jump to date"
            value={jumpDate}
            onChange={e => jumpToDate(e.target.value)}
            className="flex-shrink-0 bg-transparent text-xs text-gray-500 dark:text-text-secondary outline-none focus:ring-2 focus:ring-primary-green rounded [color-scheme:light] dark:[color-scheme:dark]"
          />
          {searchQuery && (
            <span className="flex items-center gap-1 flex-shrink-0">
              <span aria-live="polite" className="text-xs text-gray-400 tabular-nums">{filteredMsgs.length ? `${searchIdx + 1}/${filteredMsgs.length}` : 'No matches'}</span>
              <button aria-label="Previous match" onClick={() => goToSearchMatch(-1)} disabled={!filteredMsgs.length} className="p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark active:bg-gray-200 dark:active:bg-white/10 disabled:opacity-40"><ChevronUp className="h-4 w-4" /></button>
              <button aria-label="Next match" onClick={() => goToSearchMatch(1)} disabled={!filteredMsgs.length} className="p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark active:bg-gray-200 dark:active:bg-white/10 disabled:opacity-40"><ChevronDown className="h-4 w-4" /></button>
            </span>
          )}
          <button aria-label="Close search" onClick={() => closeSearch()} className="p-1.5 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark active:bg-gray-200 dark:active:bg-white/10">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Pinned message — WA audit (d) C9: channels get the WA-style
          pinned banner (WAWebNewsletterPinnedMessagesBanner): one pin at
          a time with a "1 of N" count + prev/next cycling, tap opens the
          pinned-messages list. Other chats keep the existing banner. */}
      {displayedPins.length > 0 && (isChannelDoc ? (
        <div className="flex flex-col flex-shrink-0 bg-primary-green/10 border-b border-primary-green/20">
          {(() => {
            const pins = displayedPins.filter((pm: any) => !isMessageExpired(pm, disappearAfter, disappearNow));
            if (!pins.length) return null;
            const idx = Math.min(pinBannerIdx, pins.length - 1);
            const pm = pins[idx];
            return (
              <div className="flex items-center gap-2 px-4 py-2">
                <button
                  onClick={() => setShowPinnedList(true)}
                  className="flex flex-1 min-w-0 items-center gap-2 text-left"
                  aria-label={`Pinned in this channel: ${pm.text || 'Media message'}. Tap to see all ${pins.length} pinned messages.`}
                >
                  <Pin className="h-4 w-4 text-primary-green flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-primary-green">Pinned in this channel{pins.length > 1 ? ` · ${idx + 1} of ${pins.length}` : ''}</p>
                    <p className="text-xs text-gray-600 dark:text-text-secondary truncate">{pm.senderName ? `${pm.senderName}: ` : ''}{pm.text || 'Media message'}</p>
                  </div>
                </button>
                {pins.length > 1 && (
                  <span className="flex flex-col flex-shrink-0" role="group" aria-label="Browse pinned messages">
                    <button aria-label="Previous pinned message" onClick={() => setPinBannerIdx((idx - 1 + pins.length) % pins.length)} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"><ChevronUp className="h-4 w-4 text-gray-500" /></button>
                    <button aria-label="Next pinned message" onClick={() => setPinBannerIdx((idx + 1) % pins.length)} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"><ChevronDown className="h-4 w-4 text-gray-500" /></button>
                  </span>
                )}
                <button aria-label="Unpin this message" onClick={() => void unpinMsg(pm.id)} className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center hover:bg-gray-100 dark:hover:bg-input-dark rounded-full flex-shrink-0">
                  <X className="h-3.5 w-3.5 text-gray-500" />
                </button>
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="flex flex-col flex-shrink-0 bg-primary-green/10 border-b border-primary-green/20">
          {displayedPins.filter((pm: any) => !isMessageExpired(pm, disappearAfter, disappearNow)).map((pm: any) => (
            <div key={pm.id} className="flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-primary-green/10" onClick={() => scrollToMsg(pm.id)} role="button" tabIndex={0} aria-label={`Pinned message: ${pm.text || ''}. Tap to jump to it.`} onKeyDown={(e) => { if (e.key === 'Enter') scrollToMsg(pm.id); }}>
              <Pin className="h-4 w-4 text-primary-green flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-primary-green">Pinned message</p>
                <p className="text-xs text-gray-600 dark:text-text-secondary truncate">{pm.text}</p>
              </div>
              <button aria-label="Unpin this message" onClick={(e) => { e.stopPropagation(); unpinMsg(pm.id); }} className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center hover:bg-gray-100 dark:hover:bg-input-dark rounded-full flex-shrink-0">
                <X className="h-3.5 w-3.5 text-gray-500" />
              </button>
            </div>
          ))}
        </div>
      ))}

      {/* WA audit (d) C9 — pinned-messages list for a channel
          (WAWebNewsletterPinnedMessages): every pinned post, tap jumps
          to it in the channel, X unpins it. */}
      {isChannelDoc && showPinnedList && displayedPins.length > 0 && (
        <div
          className="fixed inset-0 z-[70] bg-black/60 flex items-end"
          onClick={() => setShowPinnedList(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Pinned messages in this channel"
        >
          <div
            className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3 max-h-[70vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary flex items-center gap-2">
                <Pin className="h-4 w-4 text-primary-green" /> Pinned messages · {displayedPins.filter((pm: any) => !isMessageExpired(pm, disappearAfter, disappearNow)).length}
              </h3>
              <button onClick={() => setShowPinnedList(false)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close pinned messages">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto space-y-2">
              {displayedPins.filter((pm: any) => !isMessageExpired(pm, disappearAfter, disappearNow)).map((pm: any) => (
                <div
                  key={pm.id}
                  className="flex items-start gap-3 bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2.5 cursor-pointer hover:bg-gray-200 dark:hover:bg-white/10"
                  onClick={() => { setShowPinnedList(false); scrollToMsg(pm.id); }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') { setShowPinnedList(false); scrollToMsg(pm.id); } }}
                  aria-label={`Pinned message from ${pm.senderName || 'Unknown'}: ${pm.text || 'Media message'}. Tap to jump to it.`}
                >
                  <Pin className="h-4 w-4 text-primary-green flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-gray-900 dark:text-text-primary truncate">{pm.senderName || 'Unknown'}{pm.timestamp ? ` · ${formatTime(pm.timestamp)}` : ''}</p>
                    <p className="text-sm text-gray-600 dark:text-text-secondary break-words">{pm.text || 'Media message'}</p>
                  </div>
                  <button
                    aria-label="Unpin this message"
                    onClick={(e) => { e.stopPropagation(); void unpinMsg(pm.id); }}
                    className="p-2 rounded-full hover:bg-gray-200 dark:hover:bg-white/10 flex-shrink-0"
                  >
                    <X className="h-4 w-4 text-gray-500" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Phase 3 (integration): non-member join banner */}
      {isCommunityNonMember && (
        <div className="flex-shrink-0 bg-primary-green/10 border-b border-primary-green/20 px-4 py-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">You're not a member of this group yet</p>
            <p className="text-xs text-gray-500 dark:text-text-secondary">Join to view messages and send your own.</p>
          </div>
          <button onClick={handleJoinGroup} className="px-4 py-2 min-h-[44px] bg-green-cta text-white rounded-full text-sm font-semibold flex-shrink-0" aria-label="Join this group">
            Join group
          </button>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={messagesScrollRef}
        className="flex-1 overflow-y-auto p-3 space-y-1"
        style={{ ...wallStyle, minHeight: 0 }}
        onClick={() => {
          // W26 (#32 follow-up — picker closes on finger lift): defence in
          // depth alongside the touchend preventDefault above — if a WebView
          // fires the synthetic click anyway, the echo of the long-press
          // that just opened the picker must not dismiss it (same 1000 ms
          // guard the bubble's onContextMenu already uses). A real tap on
          // empty space 1 s+ after the long-press still dismisses.
          if (Date.now() - touchLongPressAtRef.current < 1000) return;
          setCtxMenu(null); setShowReactPicker(null); closeCombinedPicker();
        }}
        onScroll={handleMessagesScroll}
        // W13 NEXT R8 (B3): mark deliberate user scroll-ups (wheel up /
        // touch drag down) so handleMessagesScroll can tell them apart
        // from the opening smooth-scroll animation.
        onWheel={(e) => { if (e.deltaY < 0) userScrollUpRef.current = true; }}
        onTouchStart={(e) => { lastTouchYRef.current = e.touches[0]?.clientY ?? null; }}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY;
          if (y !== undefined && lastTouchYRef.current !== null && y - lastTouchYRef.current > 4) userScrollUpRef.current = true;
          if (y !== undefined) lastTouchYRef.current = y;
        }}
        onTouchEnd={() => { lastTouchYRef.current = null; }}
      >
        {/* E2EE notice — WhatsApp-style lock pill, first item in the chat.
            Only when the chat is encrypted; tap opens the details sheet. */}
        {chatIsEncrypted && !isCommunityNonMember && (
          <button
            type="button"
            onClick={() => setShowE2EESheet(true)}
            className="mx-auto mb-2 flex max-w-[92%] items-center gap-2 rounded-[7.5px] bg-[#FFF0D4] dark:bg-[#1D1F1F] px-3.5 py-2.5 text-center shadow-sm"
            aria-label="Messages are end-to-end encrypted. Tap to learn more."
          >
            <Lock className="h-3.5 w-3.5 flex-shrink-0 text-[#075E54] dark:text-primary-green" />
            <span className="text-[12.5px] leading-snug text-gray-700 dark:text-[#FFD279]">
              Messages are end-to-end encrypted. No one outside this chat can read them.{' '}
              <span className="font-semibold text-[#075E54] dark:text-primary-green">Tap to learn more.</span>
            </span>
          </button>
        )}
        {/* Master E2EE: honest "not yet encrypted" banner for 1-to-1 chats
            whose keys have not been exchanged. Not a lock — under AUDIT-2
            A10 fail-closed, messages can't send until the keys are
            exchanged; a failed one stays in the composer for retry.
            Report 3 #26 (W5b): explicit setup state — `announcing` /
            `waiting-for-peer` / `timed-out` (120 s, UI-only) /
            `not-started` (offline) — with a real Retry button on
            `timed-out`. No auto-send when keys arrive. */}
        {showE2eeSetupBanner && !isCommunityNonMember && (
          <div className="mx-auto mb-2 flex max-w-[92%] items-center gap-2 rounded-2xl bg-white/80 dark:bg-[#202C33]/80 px-3.5 py-2.5 text-center shadow-sm">
            <Lock className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
            <span className="text-xs leading-snug text-gray-500 dark:text-text-secondary">
              {e2eeSetupState === 'announcing' && (
                <>Setting up end-to-end encryption… Exchanging keys with {otherUser?.displayName || otherUser?.username || 'your contact'}.</>
              )}
              {e2eeSetupState === 'waiting-for-peer' && (
                <>Waiting for {otherUser?.displayName || otherUser?.username || 'your contact'} to connect — keys are exchanging. Your message stays in the composer until then; nothing is sent unencrypted.</>
              )}
              {e2eeSetupState === 'timed-out' && (
                <>Still waiting for {otherUser?.displayName || otherUser?.username || 'your contact'}. They may be offline, on an older version of the app, or haven&apos;t opened Pinglo yet. Ask them to open this chat once.{' '}
                  <button
                    type="button"
                    onClick={() => void retryKeyExchange()}
                    className="font-semibold text-[#075E54] dark:text-primary-green underline underline-offset-2"
                  >
                    Retry key exchange
                  </button>
                </>
              )}
              {e2eeSetupState === 'not-started' && (
                <>You&apos;re offline — key exchange will start when you&apos;re back online. Messages can&apos;t send until the keys are exchanged.</>
              )}
            </span>
          </div>
        )}
        {/* Report 3 #26 (W5b): transient "keys exchanged" notice — the
            setup ran in this mount and the key has now arrived. Tap Send
            normally; nothing is auto-sent. Disappears once the first
            encrypted message exists (the lock pill takes over). */}
        {showKeysReadyBanner && !isCommunityNonMember && (
          <div className="mx-auto mb-2 flex max-w-[92%] items-center gap-2 rounded-2xl bg-[#DCF8C6]/95 dark:bg-[#005C4B]/80 px-3.5 py-2.5 text-center shadow-sm">
            <Lock className="h-3.5 w-3.5 flex-shrink-0 text-[#075E54] dark:text-primary-green" />
            <span className="text-xs leading-snug text-gray-700 dark:text-text-primary">
              Keys exchanged — you can send now.
            </span>
          </div>
        )}
        {/* Wave-2 C3 (Settings #16b): in-chat security-code-change notice
            — WA shows "{name}'s security code changed" in the chat when a
            contact's E2EE identity key changes (reinstall / new phone).
            Review opens the E2EE settings screen (same destination as the
            Settings → Account alert); X dismisses the alert everywhere. */}
        {chatId && secCodeAlerts.filter((a) => a.chatId === chatId).map((a) => (
          <div
            key={`${a.chatId}:${a.peerKeyId || a.at}`}
            className="mx-auto mb-2 flex max-w-[92%] items-center gap-2 rounded-2xl bg-amber-500/10 border border-amber-500/30 px-3.5 py-2.5 shadow-sm"
            role="alert"
          >
            <Lock className="h-3.5 w-3.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="flex-1 min-w-0 text-xs leading-snug text-gray-700 dark:text-text-primary">
              {(isCommunity ? (secAlertPeerNames.get(a.peerUid) || 'A member') : (otherUser?.displayName || otherUser?.username || 'Your contact'))}
              &apos;s security code changed. Verify the safety number before trusting this chat.
            </span>
            <button
              type="button"
              onClick={() => navigate('/settings/e2ee')}
              className="px-2.5 py-1 rounded-full bg-primary-green/10 text-primary-green text-xs font-bold flex-shrink-0"
            >
              Review
            </button>
            <button
              type="button"
              onClick={() => { dismissSecurityCodeChange(a.chatId, a.peerKeyId); setSecCodeAlerts(listSecurityCodeChanges()); }}
              aria-label="Dismiss security code change notice"
              className="p-1 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-text-primary flex-shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
        {/* W16 (#183): group E2EE exists now (sender-key exchange) — a
            group whose keys have not been exchanged yet shows the same
            honest "setting up" banner as a DM, never a claim that groups
            have no key exchange. Once the sender key exists the lock pill
            above replaces this banner (see `chatIsEncrypted`). */}
        {isCommunity && !chatIsEncrypted && !isCommunityNonMember && (
          <div className="mx-auto mb-2 flex max-w-[92%] items-center gap-2 rounded-2xl bg-white/80 dark:bg-[#202C33]/80 px-3.5 py-2.5 text-center shadow-sm">
            <Lock className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
            <span className="text-xs leading-snug text-gray-500 dark:text-text-secondary">
              Setting up end-to-end encryption… Messages can’t send until the keys are exchanged — if one fails it stays in your composer so you can retry.
            </span>
          </div>
        )}
        {/* Phase 4: pagination — reveal older messages (newest 50 render first). */}
        {hasMoreMessages && (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              onClick={loadMoreMessages}
              className="text-xs font-medium text-primary-green bg-white/80 dark:bg-[#202C33]/80 px-3 py-1.5 rounded-full shadow-sm hover:scale-105 transition-transform"
            >
              ↑ Load older messages ({visibleMsgs.length - visibleCount} more)
            </button>
          </div>
        )}
        {messageBubbles}

        {/* Offline-queued messages (user-test C19): greyed, clearly labelled
            so the user can see the message is waiting, not lost — and does
            not send it again. Hidden while searching (queued items are not
            part of the searchable history). Queued edits (B10) are labelled
            as edits, not new messages. */}
        {!searchQuery && queuedMsgs.map((q, i) => (
          <div key={`queued-${q.opId || q.at || i}`} className="flex justify-end">
            <div className="max-w-[78%] flex flex-col items-end">
              <div className="bg-[#DCF8C6]/60 dark:bg-[#005C4B]/50 text-gray-900 dark:text-text-primary rounded-2xl rounded-tr-sm px-3 py-2 shadow-sm opacity-70">
                <p className="dt-msg-text leading-snug whitespace-pre-wrap break-words">{q.text}</p>
                <div className="flex items-center justify-end gap-1 mt-1">
                  <Clock className="h-3 w-3 text-gray-500" />
                  <span className="text-[11px] text-gray-500">{q.isEdit ? 'Edit queued — will send when online' : 'Queued — will send when online'}</span>
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Phase 5 (Agent B): bubble skeleton while the first messages load */}
        {!messagesLoaded && (
          <div className="space-y-2 py-2" role="status" aria-label="Loading messages">
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className={`flex ${i % 2 ? 'justify-start' : 'justify-end'} animate-pulse`}>
                <div className={`h-10 w-3/5 max-w-xs rounded-lg ${i % 2 ? 'rounded-tl-sm' : 'rounded-tr-sm'} opacity-70`} style={{ backgroundColor: i % 2 ? bubbleRecv : bubbleSent }} />
              </div>
            ))}
          </div>
        )}

        {/* Phase 3: empty state for chats with no messages yet */}
        {messagesLoaded && filteredMsgs.length === 0 && !searchQuery && (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-center px-6">
            <span className="text-5xl" aria-hidden="true">👋</span>
            <p className="font-semibold text-gray-700 dark:text-text-primary">{tr('noMessagesYet')}</p>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Say hi to start the conversation.</p>
          </div>
        )}

        {/* Audit #2: empty state for a search with no matches. The search
            covers the messages loaded on this device (the full synced
            collection, not just the rendered page) — say so, instead of a
            bare "0 results" on a blank list, so a word in a message that
            has not synced yet is not mistaken for a word that does not
            exist in this chat. */}
        {messagesLoaded && searchQueryDebounced && filteredMsgs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-center px-6" role="status">
            <p className="font-semibold text-gray-700 dark:text-text-primary">No results for “{searchQueryDebounced}”</p>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Only messages loaded on this device were searched.</p>
          </div>
        )}

        {/* Uploading indicator */}
        {uploading && (
          <div className="flex justify-end">
            <div className="rounded-lg rounded-tr-sm px-4 py-2 shadow-sm" style={{ backgroundColor: bubbleSent, color: bubbleText }}>
              <div className="flex items-center gap-2">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span className="text-sm">{uploadProgress > 0 ? `Uploading ${uploadProgress}%` : 'Uploading...'}</span>
              </div>
            </div>
          </div>
        )}

        {/* Typing indicator */}
        {isPartnerTyping && (
          <div className="flex justify-start items-center gap-2 ml-10">
            <div className="rounded-2xl rounded-tl-none px-4 py-3 shadow-sm flex gap-1 items-center" style={{ backgroundColor: bubbleRecv }}>
              {[0, 1, 2].map(i => (
                <span key={i} className="h-2 w-2 rounded-full bg-gray-400 dark:bg-gray-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* #29: jump-to-bottom button — appears once the user scrolls up in
          a chat (WhatsApp's floating down-arrow). The unread badge counts
          this chat's unread messages. Fixed above the composer. */}
      {showJumpToBottom && (
        <button
          type="button"
          aria-label="Jump to latest messages"
          onClick={scrollToBottom}
          className="fixed bottom-24 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-white dark:bg-panel-dark text-gray-700 dark:text-text-primary shadow-lg border border-gray-200 dark:border-white/10 active:scale-90 transition-transform"
        >
          <ArrowDown className="h-5 w-5" />
          {unreadInfo.count > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-green-cta px-1 text-[11px] font-bold text-white">
              {unreadInfo.count > 99 ? '99+' : unreadInfo.count}
            </span>
          )}
        </button>
      )}

      {/* Context menu */}
      {ctxMenu && (
        <div
          role="menu"
          data-context-menu
          className="fixed z-[9999] bg-white dark:bg-panel-dark rounded-xl shadow-2xl border border-gray-200 dark:border-white/10 py-1 min-w-[180px] overflow-hidden"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={e => e.stopPropagation()}
        >
          {/* Quick reactions row (+ opens the full-emoji picker sheet) */}
          <div className="flex gap-1 px-3 py-2 border-b border-gray-100 dark:border-white/5 items-center">
            {EMOJI_QUICK.map(e => (
              <button key={e} onClick={() => pickReaction(ctxMenu.msg.id, e)} className="text-xl hover:scale-125 transition-transform">
                {e}
              </button>
            ))}
            <button
              onClick={() => { if (channelReactionPolicy === 'none') { setCtxMenu(null); showToastMsg('Reactions are off in this channel'); return; } const m = ctxMenu.msg; setCtxMenu(null); setSheetReactionMsg(m); }}
              aria-label="More reactions"
              title="More reactions"
              className="h-7 w-7 flex items-center justify-center rounded-full bg-gray-100 dark:bg-input-dark text-gray-500 dark:text-text-secondary hover:scale-110 transition-transform"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          {[
            { icon: <Reply className="h-4 w-4" />, label: 'Reply', action: () => { setReplyTo(ctxMenu.msg); setCtxMenu(null); inputRef.current?.focus(); } },
            // WA parity (DM audit row 55): Message info in the long-press
            // menu — the sheet already exists (msgInfo); this also gives
            // RECEIVED messages an info entry point for the first time
            // (ticks only exist on your own messages).
            { icon: <Info className="h-4 w-4" />, label: 'Message info', action: () => { const m = ctxMenu.msg; setMsgInfo(m); setCtxMenu(null); } },
            // Reply privately: group/community messages from someone else
            // only (not DMs, not channels, not my own message). Opens the
            // author's DM with this message quoted — the service toasts
            // its own failure reason when it cannot.
            ...(isCommunity && !isChannelDoc && !isMe(ctxMenu.msg) ? [
              { icon: <Reply className="h-4 w-4" />, label: 'Reply privately', action: () => {
                const m = ctxMenu.msg;
                // WA72 DM row 49: stage the WA-style media label
                // ('Photo'/'Video'/…) instead of a generic '[Media]' —
                // quoteMediaLabel is what the in-chat quote renderer uses.
                const text = displayTextFor(m).text || quoteMediaLabel(m) || '[Message]';
                const res = replyPrivately({
                  groupChatId: chatId || '',
                  authorUid: m.senderId,
                  authorName: m.senderName,
                  message: { id: m.id, text },
                  groupName: otherUser?.name,
                  isChannel: isChannelDoc,
                  navigate,
                });
                setCtxMenu(null);
                if (!res.ok) showToastMsg(res.message || 'Could not reply privately');
              } },
            ] : []),
            // G2c: a view-once message cannot be forwarded or copied —
            // that would defeat the one-time view.
            ...(!ctxMenu.msg.isViewOnce ? [
              { icon: <Share2 className="h-4 w-4" />, label: 'Forward', action: () => { setForwardMsg(ctxMenu.msg); setForwardCaption(ctxMenu.msg?.caption || ''); setCtxMenu(null); } },
              // WA parity (verify dm-4 row 62): Copy only when there is
              // something to copy — body text or a media caption. A
              // caption-less photo has no Copy entry, like WhatsApp, and
              // a decrypt-failed message never copies its placeholder.
              ...(copyableTextFor(ctxMenu.msg) ? [
                { icon: <Copy className="h-4 w-4" />, label: 'Copy', action: () => copyMsg(copyableTextFor(ctxMenu.msg)) },
              ] : []),
            ] : []),
            // WA audit (d) C15 — "Add to status": re-share a channel post
            // as a status (WA: WAWebNewsletterAddToStatusButton). Channel
            // posts only; view-once and deleted posts are excluded —
            // sharing them would defeat the one-time view / resurrect a
            // delete. addChannelPostToStatus queues the post, opens the
            // Updates tab and wakes StatusScreen's composer.
            ...(isChannelDoc && !ctxMenu.msg.isViewOnce && !ctxMenu.msg.deleted ? [
              { icon: <CircleDashed className="h-4 w-4" />, label: 'Add to status', action: () => { const m = ctxMenu.msg; setCtxMenu(null); addChannelPostToStatus(m); } },
            ] : []),
            // R2: multi-select entry — long-press now opens reactions on
            // touch, so select mode needs an explicit entry point too.
            { icon: <CheckSquare className="h-4 w-4" />, label: 'Select', action: () => { enterSelectMode(ctxMenu.msg); setCtxMenu(null); } },
            // Translate: any message with (decrypted) text. displayTextFor
            // gives the E2EE-decrypted text, never the ciphertext, and the
            // decrypt-failed placeholder is excluded.
            ...(displayTextFor(ctxMenu.msg).state !== 'decrypt-failed' && displayTextFor(ctxMenu.msg).text ? [
              { icon: <Languages className="h-4 w-4" />, label: 'Translate', action: () => { const m = ctxMenu.msg; setTranslateMsg({ text: displayTextFor(m).text, senderName: m.senderName }); setCtxMenu(null); } },
            ] : []),
            { icon: <Pin className="h-4 w-4" />, label: displayedPins.some((p: any) => p.id === ctxMenu.msg.id) ? 'Unpin' : 'Pin', action: () => displayedPins.some((p: any) => p.id === ctxMenu.msg.id) ? unpinMsg(ctxMenu.msg.id) : pinMsg(ctxMenu.msg) },
            // G2c: a view-once message cannot be starred, saved or kept.
            ...(!ctxMenu.msg.isViewOnce ? [
              { icon: <Star className="h-4 w-4" />, label: starredIds.includes(ctxMenu.msg.id) ? 'Unstar' : 'Star', action: () => starMsg(ctxMenu.msg) },
              { icon: <BookmarkPlus className="h-4 w-4" />, label: 'Save Message', action: () => saveMsg(ctxMenu.msg) },
              // Item 10: Keep / Unkeep — only in a disappearing chat, only
              // for a message that hasn't been deleted. Kept messages
              // survive the disappearing timer (see keepMsg).
              ...(disappearAfter > 0 && !ctxMenu.msg.deleted ? [
                { icon: <BookmarkPlus className="h-4 w-4" />, label: isKeptMessage(ctxMenu.msg) ? 'Unkeep message' : 'Keep message', action: () => keepMsg(ctxMenu.msg) },
              ] : []),
            ] : []),
            ...(isEditableMsg(ctxMenu.msg) ? [
              // WA72 DM row 50: prefill with the DECRYPTED text, not raw
              // msg.text ('' for E2EE docs) — otherwise the composer opens
              // empty and doEdit's editHistory records ''. The enriched
              // editingMsg also feeds the "Editing message" banner and the
              // history entry; db.put re-encrypts the new text on save.
              { icon: <Edit3 className="h-4 w-4" />, label: 'Edit', action: () => { const m = ctxMenu.msg; const plain = displayTextFor(m).text; setEditingMsg({ ...m, text: plain }); composerRef.current?.setText(plain); setCtxMenu(null); inputRef.current?.focus(); } },
            ] : []),
            // WA parity (DM audit row 52): Delete for everyone is offered
            // only inside the ~2-day window; deleteForEveryone() enforces
            // the same gate for bulk deletes.
            ...(isMe(ctxMenu.msg) && canDeleteForEveryone(ctxMenu.msg) ? [
              { icon: <Trash2 className="h-4 w-4" />, label: 'Delete for everyone', action: () => { setCtxMenu(null); setDeleteConfirm({ kind: 'everyone', ids: [ctxMenu.msg.id] }); }, danger: true },
            ] : []),
            { icon: <Trash2 className="h-4 w-4" />, label: 'Delete for me', action: () => { setCtxMenu(null); setDeleteConfirm({ kind: 'me', ids: [ctxMenu.msg.id] }); }, danger: true },
          ].map((item: any) => (
            <button
              key={item.label}
              role="menuitem"
              onClick={item.action}
              className={`flex items-center gap-3 w-full px-4 py-2.5 text-sm hover:bg-gray-100 dark:hover:bg-input-dark text-left ${item.danger ? 'text-red-500' : 'text-gray-900 dark:text-text-primary'}`}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </div>
      )}

      {/* Input area */}
      {isCommunityNonMember ? (
        <div className="flex-shrink-0 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/10 px-4 py-3.5 flex items-center justify-center gap-2">
          <p className="text-sm text-gray-500 dark:text-text-secondary text-center">
            Join this group to send messages
          </p>
          <button onClick={handleJoinGroup} className="px-4 py-2 min-h-[44px] bg-green-cta text-white rounded-full text-sm font-semibold flex-shrink-0" aria-label="Join this group">
            Join
          </button>
        </div>
      ) : isCommunity && !canSend ? (
        <div className="flex-shrink-0 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/10 px-4 py-3.5 flex items-center justify-center gap-2">
          <span className="text-lg">🔇</span>
          <p className="text-sm text-gray-500 dark:text-text-secondary text-center">
            Only admins can send messages in this {isChannelDoc ? 'channel' : 'group'} · {formatMemberCount(subscriberCount, isChannelDoc)}
          </p>
        </div>
      ) : isBlocked ? (
        <div className="flex flex-col p-4 bg-panel-light dark:bg-panel-dark items-center border-t border-gray-200 dark:border-white/10">
          <p className="text-gray-500 dark:text-text-secondary mb-2 text-sm">You blocked this contact.</p>
          <button onClick={toggleBlockUser} className="px-4 py-2 bg-gray-200 dark:bg-input-dark rounded-lg text-sm font-medium">
            Tap to unblock
          </button>
        </div>
      ) : (
        <div className="flex-shrink-0 bg-transparent pb-[env(safe-area-inset-bottom)]">
          {/* ROADMAP-2 item 6: multi-file send queue — one row per file
              with live progress and the final outcome (✓ Sent / ✗ Failed).
              Clears a few seconds after the batch finishes. */}
          {uploadQueue.length > 0 && (
            <div className="px-3 pt-1 space-y-1" role="status" aria-label="Upload queue">
              {uploadQueue.map(q => (
                <div key={q.id} data-upload-queue-item={q.name} className="flex items-center gap-2 text-xs bg-panel-light dark:bg-panel-dark rounded-lg px-3 py-1.5 shadow-sm">
                  <span className="truncate flex-1 text-gray-700 dark:text-text-primary">{q.name}</span>
                  {q.status === 'uploading' && <span className="text-gray-500 dark:text-text-secondary flex-shrink-0">{q.progress > 0 ? `${q.progress}%` : 'Uploading…'}</span>}
                  {q.status === 'done' && <span className="text-primary-green font-semibold flex-shrink-0">✓ Sent</span>}
                  {q.status === 'failed' && <span className="text-red-500 font-semibold flex-shrink-0">✗ Failed</span>}
                </div>
              ))}
            </div>
          )}

          {/* Reply / Edit banner */}
          {(replyTo || editingMsg) && (
            <div className="flex items-center gap-2 px-4 py-2 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/10">
              <div className="w-1 h-8 bg-primary-green rounded-full flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-primary-green">{editingMsg ? 'Editing message' : replyTo?.fromChatName ? `Replying to ${replyTo?.senderName}, from ${replyTo.fromChatName}` : `Replying to ${replyTo?.senderName}`}</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary truncate">{editingMsg?.text || replyTo?.text || '[Media]'}</p>
              </div>
              <button onClick={() => { setReplyTo(null); setEditingMsg(null); composerRef.current?.clear(); }} className="p-2 min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
          )}

          {/* View Once indicator — a button, not a label: tapping it
              disarms View Once (UI-army #3), so an armed mode can never
              linger with no way to turn it off. */}
          {isViewOnce && (
            <div className="flex justify-center py-1 bg-transparent">
              <button
                type="button"
                onClick={() => setIsViewOnce(false)}
                aria-label="Turn off View Once"
                title="View Once is on — tap to turn it off"
                className="bg-primary-green/20 text-primary-green text-xs px-3 py-1 rounded-full font-medium flex items-center gap-1 hover:bg-primary-green/30 active:scale-95 transition"
              >
                <Eye className="h-3 w-3" /> View Once Mode Active <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Recording UI — WhatsApp-style: red dot + timer + live bars, pause/resume, lock, cancel, green send. */}
          {isRecording && (
            <div data-voice-gesture={voiceGesture} data-recording-paused={isRecordingPaused ? 'true' : 'false'} className="flex items-center gap-2 px-3 py-2 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5">
              <button onClick={cancelRecording} aria-label="Cancel recording" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-red-500 flex-shrink-0">
                <Trash2 className="h-5 w-5" />
              </button>
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
                <span className="text-sm font-medium text-gray-900 dark:text-text-primary tabular-nums flex-shrink-0">
                  {fmtSecs(recordingSecs)}
                </span>
                {/* Live level bars — #208: heights are driven by the mic's
                    AnalyserNode (see startRecording); the timer formula
                    below is only the initial paint / no-Web-Audio fallback. */}
                <div ref={recBarsRef} className="flex items-center gap-[3px] h-6 flex-1 overflow-hidden" aria-hidden="true">
                  {Array.from({ length: 28 }).map((_, i) => (
                    <span
                      key={i}
                      className="w-[3px] rounded-full bg-red-400/70 animate-pulse"
                      style={{ height: `${6 + ((i * 37 + recordingSecs * 13) % 16)}px`, animationDelay: `${i * 60}ms` }}
                    />
                  ))}
                </div>
                {/* ROADMAP-2 item 12: live gesture hint — what releasing
                    the mic will do right now. */}
                {isRecordingPaused ? (
                  <span className="text-[11px] text-amber-600 dark:text-amber-400 font-semibold flex-shrink-0">Paused — tap Resume</span>
                ) : voiceGesture === 'cancel-armed' ? (
                  <span className="text-[11px] text-red-500 font-semibold flex-shrink-0">Release to cancel</span>
                ) : voiceGesture === 'lock-armed' || isLockedRecording ? (
                  <span className="text-[11px] text-primary-green font-medium flex-shrink-0">Locked</span>
                ) : (
                  <span className="text-[11px] text-gray-500 flex-shrink-0">↑ lock, ← cancel</span>
                )}
              </div>
              {/* V5: pause / resume (WA: "Pause recording" / "Resume recording"). */}
              {isRecordingPaused ? (
                <button onClick={resumeRecording} aria-label="Resume recording" title="Resume recording" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full flex-shrink-0 bg-green-cta text-white">
                  <Play className="h-5 w-5" />
                </button>
              ) : (
                <button onClick={pauseRecording} aria-label="Pause recording" title="Pause recording" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full flex-shrink-0 text-gray-500 hover:text-primary-green">
                  <Pause className="h-5 w-5" />
                </button>
              )}
              <button onClick={() => { setIsLockedRecording(v => !v); try { navigator.vibrate?.(10); } catch { /* intentionally ignored */} }} aria-label={isLockedRecording ? 'Unlock recording' : 'Lock recording — keep recording hands-free'} aria-pressed={isLockedRecording} title="Lock recording (slide-to-lock): release and keep recording" className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full flex-shrink-0 ${isLockedRecording ? 'bg-green-cta text-white' : 'text-gray-500 hover:text-primary-green'}`}>
                <Lock className="h-5 w-5" />
              </button>
              <button onClick={stopRecording} aria-label="Send voice message" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-cta text-white shadow-sm hover:bg-dark-green">
                <Send className="h-5 w-5 ml-0.5" />
              </button>
            </div>
          )}

          {/* UI-army #9: listen-before-send preview — listen to the take,
              then Send it or Delete it. Replaces the old send-on-release. */}
          {voicePreview && !isRecording && (
            <div className="flex items-center gap-2 px-3 py-2 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5" role="region" aria-label="Voice message preview">
              <button onClick={discardVoicePreview} aria-label="Delete voice message" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-red-500 flex-shrink-0">
                <Trash2 className="h-5 w-5" />
              </button>
              <div className="flex-1 min-w-0">
                <VoiceNotePlayer url={voicePreview.url} duration={voicePreview.secs} waveform={voicePreview.waveform} seed={voicePreview.url} />
              </div>
              {/* V10: send this take as a view-once voice message (WA type
                  "View once voice message" — plays once, then "opened"). */}
              <button
                onClick={() => setVoicePreview((p) => (p ? { ...p, isViewOnce: !p.isViewOnce } : p))}
                aria-label="Send as view once voice message"
                aria-pressed={!!voicePreview.isViewOnce}
                title={voicePreview.isViewOnce ? 'View once is on — tap to turn it off' : 'Send as a view once voice message'}
                className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full flex-shrink-0 ${voicePreview.isViewOnce ? 'bg-primary-green/15 text-primary-green' : 'text-gray-500 hover:text-primary-green'}`}
              >
                <Eye className="h-5 w-5" />
              </button>
              <button onClick={() => void sendVoicePreview()} disabled={uploading} aria-label="Send voice message" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-green text-white shadow-sm hover:bg-dark-green disabled:opacity-40">
                <Send className="h-5 w-5 ml-0.5" />
              </button>
            </div>
          )}

          {/* W27: live-location sharing banner — the watch lives in the
              service's module map, so sharing continues when you leave
              the chat; stop / resume from here. */}
          {myActiveLiveMsg && (
            <div className="flex items-center gap-2 px-4 py-2 bg-green-50 dark:bg-green-900/20 border-t border-green-200 dark:border-green-800">
              <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </span>
              <p className="flex-1 min-w-0 text-xs font-semibold text-green-700 dark:text-green-300 truncate">
                {liveResumeNeeded
                  ? 'Live location sharing paused — tap Resume to continue'
                  : `Sharing live location · ${formatLiveRemaining(myActiveLiveMsg.liveLocationExpiresAt || 0, liveNow).replace(/^Live · /, '')}`}
              </p>
              {liveResumeNeeded && (
                <button type="button" onClick={() => { void resumeLiveLocation(); }} className="text-xs font-bold text-primary-green hover:underline flex-shrink-0">Resume</button>
              )}
              <button type="button" onClick={() => { void stopMyLiveLocation(); }} className="text-xs font-bold text-red-500 hover:underline flex-shrink-0">Stop</button>
            </div>
          )}

          {/* Typing-freeze fix (#20): the composer lives in its own
              memoized component (ChatComposer.tsx) with its own input
              state — typing re-renders only the composer, never this
              screen or the message list. */}
          <ChatComposer
            ref={composerRef}
            textareaRef={inputRef}
            contactsList={contactsList}
            otherUser={otherUser}
            isCommunity={isCommunity}
            chatId={partnerUid}
            editing={!!editingMsg}
            placeholder={editingMsg ? 'Edit message...' : tr('message')}
            disabled={uploading}
            isRecording={isRecording}
            showAttachMenu={showAttachMenu}
            showCombinedPicker={showCombinedPicker}
            onEmojiButton={toggleCombinedPicker}
            setShowAttachMenu={setShowAttachMenu}
            callbacks={composerCallbacks}
            suggestableStickers={suggestableStickers}
          />

          {/* WA Wave-2 (DM #25 / Media E10): ONE combined "Emojis, GIFs,
              Stickers" panel — Emoji / GIF / Sticker tabs, opened from the
              composer's emoji button (or the attach menu's Stickers / GIFs
              rows, which land on the matching tab).
              WA parity verify dm-1 row 16 + media-1 E1/E2: picking an emoji
              does NOT close the panel (WhatsApp lets you tap several emojis
              in a row) — the old separate EmojiPicker's stay-open fix,
              carried onto the combined panel. GIF/sticker picks still
              close via send. */}
          {showCombinedPicker && !isRecording && (
            <CombinedPicker
              tab={combinedTab}
              onTabChange={setCombinedTab}
              initialStickerQuery={stickerInitialQuery}
              // WA Wave-2 A3 reviewer gap (emoji-close): tapping an emoji
              // inserts it and KEEPS the panel open (WA multi-emoji entry),
              // instead of closing after a single emoji. Stickers/GIFs
              // still send-and-close (sendSticker/sendGif). The user closes
              // with the panel X, the composer emoji button, back, or Escape.
              onSelectEmoji={(e) => { composerRef.current?.insertText(e); inputRef.current?.focus(); }}
              onSelectSticker={sendSticker}
              onSelectGif={(g) => { setPendingGif(g); setShowCombinedPicker(false); }}
              onClose={closeCombinedPicker}
            />
          )}
        </div>
      )}

      {/* Attach menu popup */}
      {showAttachMenu && !isRecording && (
        <div className="bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5 px-4 py-3 grid grid-cols-4 gap-3">
          {[
            { icon: <ImageIcon className="h-6 w-6" />, label: 'Photo', action: () => { setShowAttachMenu(false); if (fileInputRef.current) { fileInputRef.current.accept = 'image/*'; fileInputRef.current.click(); } } },
            // ROADMAP-2 item 6: pick several photos/videos at once — they
            // send as one album (the input carries `multiple`).
            { icon: <Images className="h-6 w-6" />, label: 'Album', action: () => { setShowAttachMenu(false); if (fileInputRef.current) { fileInputRef.current.accept = 'image/*,video/*'; fileInputRef.current.click(); } } },
            // WA parity (A3): attach → Camera opens the in-app viewfinder
            // (CameraModal, with switch/flash/video) when the browser has
            // a camera, like the composer's camera button; the system
            // picker stays as the fallback when getUserMedia is missing.
            { icon: <Camera className="h-6 w-6" />, label: 'Camera', action: () => { setShowAttachMenu(false); if (navigator.mediaDevices?.getUserMedia) setShowCamera(true); else cameraInputRef.current?.click(); } },
            { icon: <Video className="h-6 w-6" />, label: 'Video', action: () => { setShowAttachMenu(false); if (fileInputRef.current) { fileInputRef.current.accept = 'video/*'; fileInputRef.current.click(); } } },
            { icon: <Circle className="h-6 w-6" />, label: 'Round video', action: () => { setShowAttachMenu(false); startRoundVideo(); } },
            { icon: <FileText className="h-6 w-6" />, label: 'File', action: () => { setShowAttachMenu(false); if (fileInputRef.current) { fileInputRef.current.accept = '*/*'; fileInputRef.current.click(); } } },
            // WA parity A7: dedicated Audio row (was: audio only via
            // generic File). Single audio → caption sheet; oversize →
            // "This audio is too large. You can send audio up to 200 MB." (storage.ts).
            { icon: <Music className="h-6 w-6" />, label: 'Audio', action: () => { setShowAttachMenu(false); if (fileInputRef.current) { fileInputRef.current.accept = 'audio/*'; fileInputRef.current.click(); } } },
            { icon: <BarChart2 className="h-6 w-6" />, label: 'Poll', action: () => { setShowAttachMenu(false); setShowPollModal(true); } },
            // Group events (v1): groups only — not channels, not DMs.
            ...(isCommunity && !isChannelDoc ? [
              { icon: <Calendar className="h-6 w-6" />, label: 'Event', action: () => { setShowAttachMenu(false); setShowEventModal(true); } },
            ] : []),
            { icon: <Clock className="h-6 w-6" />, label: 'Schedule', action: () => { setShowAttachMenu(false); setSchedText(composerRef.current?.getText() ?? ''); setSchedTime(new Date(Date.now()+60000).toISOString().slice(0,16)); setShowScheduleModal(true); } },
            // WA72-M4 (A8): View Once must offer photo AND video — WA has
            // "View once photo" and "View once video". The picker used to
            // force accept='image/*', so a view-once video was unreachable
            // even though sendFile, the video quality sheet and the
            // ViewOnceViewer already carry/render the flag for video.
            // accept='image/*,video/*' routes a single video to the
            // quality sheet (isViewOnce stays armed) and a single photo
            // to the editor, exactly like the plain Photo/Video rows.
            { icon: <Eye className="h-6 w-6" />, label: 'View Once', action: () => { setShowAttachMenu(false); setIsViewOnce(true); if (fileInputRef.current) { fileInputRef.current.accept = 'image/*,video/*'; fileInputRef.current.click(); } } },
            { icon: <Sticker className="h-6 w-6" />, label: 'Stickers', action: () => openCombinedPicker('stickers') },
            { icon: <Film className="h-6 w-6" />, label: 'GIFs', action: () => openCombinedPicker('gifs') },
            { icon: <BellOff className="h-6 w-6" />, label: silentSend ? 'Silent: On' : 'Silent: Off', action: () => { setShowAttachMenu(false); setSilentSend(v => !v); showToastMsg(silentSend ? 'Silent send off' : 'Silent send on — next message sends without a notification'); } },
            { icon: <MapPin className="h-6 w-6" />, label: 'Location', action: () => { setShowAttachMenu(false); setShowLocationModal(true); } },
            { icon: <User className="h-6 w-6" />, label: 'Contact', action: () => { setShowAttachMenu(false); setShowContactModal(true); } },
          ].map(item => (
            <button key={item.label} onClick={item.action} className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-gray-100 dark:bg-input-dark hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">
              <span className="flex items-center justify-center text-primary-green">{item.icon}</span>
              <span className="text-[11px] font-medium text-gray-600 dark:text-text-secondary">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Poll Modal (PollComposer — multi-answer + max choices, 2–12 options) */}
      {showPollModal && (
        <PollComposer
          onClose={() => setShowPollModal(false)}
          onSend={(p) => { void sendPoll(p); }}
          // WA audit (d) C8 — the composer title names the channel context.
          title={isChannelDoc ? '📊 Create channel poll' : undefined}
        />
      )}

      {/* WA audit (d) C8 — full poll results + voter list, opened from a
          channel poll's "View results" footer (PollCard onViewResults).
          memberNamesByUid resolves voter uids to display names. */}
      {pollResultsMsg && (
        <PollResultsSheet
          poll={{
            question: pollResultsMsg.pollQuestion,
            options: pollResultsMsg.pollOptions || [],
            votes: pollResultsMsg.pollVotes || {},
            multiAnswer: pollResultsMsg.pollMultiAnswer === true,
            maxChoices: pollResultsMsg.pollMaxChoices,
          }}
          voterNames={memberNamesByUid}
          currentUserId={currentUser?.uid}
          onClose={() => setPollResultsMsg(null)}
        />
      )}

      {/* Event Modal (EventSheet — create a group event) */}
      {showEventModal && (
        <EventSheet
          onClose={() => setShowEventModal(false)}
          onSend={(p) => { void sendEvent(p); }}
        />
      )}

      {/* Translate sheet — message translation (Worker 3 service + sheet).
          originalText is the E2EE-decrypted text from displayTextFor. */}
      {translateMsg && (
        <TranslateSheet
          open
          onClose={() => setTranslateMsg(null)}
          originalText={translateMsg.text}
          senderName={translateMsg.senderName}
        />
      )}

      {/* Full-emoji reaction sheet (ReactionPicker variant="sheet"),
          opened from the context menu "+" button. Wrapped in
          data-reaction-picker like the popover, so the document mousedown
          handler never dismisses it under a tap (C21/C22). */}
      {sheetReactionMsg && (
        <div data-reaction-picker>
          <ReactionPicker
            variant="sheet"
            myReaction={getMyReaction(sheetReactionMsg.reactions, currentUser?.uid)}
            senderName={sheetReactionMsg.senderId === currentUser?.uid ? 'You' : (sheetReactionMsg.senderName || 'Someone')}
            onSelect={(emoji) => pickReaction(sheetReactionMsg.id, emoji)}
            quickOnly={channelReactionPolicy === 'default'}
            onClose={() => setSheetReactionMsg(null)}
          />
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-end" onClick={() => setShowScheduleModal(false)}>
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-1">
              <h3 className="text-lg font-bold">Schedule message</h3>
              <button onClick={() => setShowScheduleModal(false)} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"><X className="h-5 w-5" /></button>
            </div>
            <textarea
              value={schedText}
              onChange={e => setSchedText(e.target.value)}
              placeholder="Message jo schedule karna hai..."
              rows={3}
              className="w-full bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 text-sm outline-none resize-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
            />
            <div>
              <p className="text-xs text-gray-500 dark:text-text-secondary mb-1">Send kab karna hai?</p>
              <input
                type="datetime-local"
                value={schedTime}
                onChange={e => setSchedTime(e.target.value)}
                className="w-full bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
              />
            </div>
            <button
              onClick={sendScheduled}
              disabled={!schedText.trim() || !schedTime}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green disabled:opacity-40 transition"
            >
              Schedule
            </button>
            {/* 4d: pending scheduled messages for this chat — cancel here. */}
            {pendingScheduled.length > 0 && (
              <div className="pt-2">
                <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">
                  Scheduled in this chat
                </p>
                {pendingScheduled.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 py-2 border-t border-gray-100 dark:border-white/10">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900 dark:text-text-primary truncate">{s.text}</p>
                      <p className="text-xs text-gray-500 dark:text-text-secondary">
                        {new Date(s.sendAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        {s.status === 'failed' ? ', failed, will not retry' : s.localOnly ? ', on this device only' : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => cancelScheduled(s.id)}
                      className="text-xs font-medium text-red-500 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-500/10 flex-shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Location / Contact share modals (Feature 4) */}
      {showLocationModal && (
        <LocationShareModal onClose={() => setShowLocationModal(false)} onSend={sendLocation} onSendLive={sendLiveLocation} />
      )}
      {showContactModal && (
        <ContactShareModal contacts={contactShareContacts} onClose={() => setShowContactModal(false)} onSend={sendContact} />
      )}

      {/* ROADMAP-2 item 6: `multiple` — Photo / Video / File / Album picks
          can return several files, sent together as one album.
          NOTE: ref is the callback ref above (attaches the native
          picker-cancel listener); React onCancel does not fire for file
          inputs, so there is no onCancel prop here. */}
      <input type="file" ref={fileInputCallbackRef} multiple onChange={handleFileUpload} className="hidden" />
      {/* Phase 4: in-app camera input. capture="environment" = rear camera on
          mobile; browsers that ignore capture fall back to the file picker. */}
      <input type="file" ref={cameraInputRef} accept="image/*" capture="environment" onChange={handleFileUpload} className="hidden" />

      {/* Cluster C (Item 13b): in-app camera viewfinder */}
      <CameraModal
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onPhoto={handleCameraPhoto}
        onVideo={handleCameraVideo}
        onFallback={() => { setShowCamera(false); cameraInputRef.current?.click(); }}
      />

      {/* ROADMAP-2 item 7: WhatsApp-style photo editor for a single photo */}
      {pendingPhoto && (
        <PhotoEditor
          src={pendingPhoto.url}
          fileName={pendingPhoto.file.name}
          onCancel={handleEditorCancel}
          onSend={(edited, caption, isHD) => void handleEditedPhotoSend(edited, caption, isHD)}
        />
      )}

      {/* Cluster C (Item 13a): video quality choice */}
      {pendingVideo && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-end sm:items-center justify-center p-4" onClick={() => { if (!videoQualityBusy) { setPendingVideo(null); setVideoCaption(''); setIsViewOnce(false); } }} role="dialog" aria-modal="true" aria-label="Choose video quality">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Send video</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              {/* #204: the sheet used to show "0.0 MB" for a 30 KB clip. */}
              {pendingVideo.name} ({formatFileSize(pendingVideo.size)})
            </p>
            {/* WA72-M4 (A8): the "View Once Mode Active" pill sits behind
                this modal, so a view-once video pick would otherwise give
                no sign it will send as view-once. Show the armed state
                here; tapping disarms (the sheet stays open, the video
                then sends normally). */}
            {isViewOnce && (
              <button
                type="button"
                onClick={() => setIsViewOnce(false)}
                aria-label="Turn off View Once"
                title="View Once is on — tap to turn it off"
                className="flex items-center gap-1.5 text-xs font-medium text-primary-green bg-primary-green/15 hover:bg-primary-green/25 active:scale-95 transition rounded-full px-3 py-1.5 self-start"
              >
                <Eye className="h-3 w-3" /> View Once — opens once, then disappears <X className="h-3 w-3" />
              </button>
            )}
            {/* 100M-F2: caption input — travels with the video, encrypted. */}
            <input
              data-testid="video-caption-input"
              aria-label="Add a caption"
              placeholder="Type a caption"
              value={videoCaption}
              onChange={(e) => setVideoCaption(e.target.value)}
              maxLength={1024}
              className="w-full bg-black/5 dark:bg-white/10 placeholder-gray-400 dark:placeholder-text-secondary rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green/50"
            />
            {videoQualityBusy ? (
              <div className="space-y-2">
                <div className="h-2 bg-gray-200 dark:bg-input-dark rounded-full overflow-hidden">
                  <div className="h-full bg-primary-green transition" style={{ width: `${videoCompressPct}%` }} />
                </div>
                <p className="text-sm text-center text-gray-500">Compressing… {videoCompressPct}%</p>
              </div>
            ) : (
              <>
                <button
                  onClick={() => void sendVideoWithQuality('hd')}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-primary-green/10 text-left hover:bg-primary-green/20 transition-colors"
                >
                  <span><span className="block font-semibold text-gray-900 dark:text-text-primary">HD — original quality</span>
                  <span className="block text-xs text-gray-500 dark:text-text-secondary">Full size, best quality</span></span>
                  <span className="text-xs font-semibold text-primary-green">HD</span>
                </button>
                <button
                  onClick={() => void sendVideoWithQuality('saver')}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-gray-100 dark:bg-input-dark text-left hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
                >
                  <span><span className="block font-semibold text-gray-900 dark:text-text-primary">Data saver — compressed</span>
                  <span className="block text-xs text-gray-500 dark:text-text-secondary">Re-encoded smaller (max 640p, ~1 Mbps) — uses less data</span></span>
                  <span className="text-xs font-semibold text-primary-green">SD</span>
                </button>
                <button
                  onClick={() => { setPendingVideo(null); setVideoCaption(''); setIsViewOnce(false); }}
                  className="w-full py-2.5 text-sm font-semibold text-gray-500 dark:text-text-secondary hover:opacity-80"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Nightshift doc caption (§6a): caption sheet for a single
          document/audio — same input pattern as the video sheet above.
          The caption travels with the file via sendFile (e2eeCaption). */}
      {pendingDoc && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-end sm:items-center justify-center p-4" onClick={() => { setPendingDoc(null); setDocCaption(''); }} role="dialog" aria-modal="true" aria-label="Send document">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Send document</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              {pendingDoc.name} • {formatFileSize(pendingDoc.size)}
            </p>
            <input
              data-testid="doc-caption-input"
              aria-label="Add a caption"
              placeholder="Type a caption"
              value={docCaption}
              onChange={(e) => setDocCaption(e.target.value)}
              maxLength={1024}
              className="w-full bg-black/5 dark:bg-white/10 placeholder-gray-400 dark:placeholder-text-secondary rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green/50"
            />
            <button
              onClick={() => void sendPendingDoc()}
              className="w-full py-2.5 min-h-[44px] rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green"
            >
              Send
            </button>
            <button
              onClick={() => { setPendingDoc(null); setDocCaption(''); }}
              className="w-full py-2.5 text-sm font-semibold text-gray-500 dark:text-text-secondary hover:opacity-80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* WA parity (verify dm-4 row 67 / media-5 A17): caption sheet for
          a multi-photo/video album — one shared caption for the whole
          album, carried on its first member and rendered under the grid,
          like WhatsApp. Send goes through sendPendingAlbum; Cancel
          discards the batch, never sends it. */}
      {pendingAlbum && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-end sm:items-center justify-center p-4" onClick={() => { setPendingAlbum(null); setAlbumCaption(''); }} role="dialog" aria-modal="true" aria-label="Send album">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Send album</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              {pendingAlbum.length} files • {formatFileSize(pendingAlbum.reduce((s, f) => s + f.size, 0))}
            </p>
            <input
              data-testid="album-caption-input"
              aria-label="Add a caption"
              placeholder="Add a caption…"
              value={albumCaption}
              onChange={(e) => setAlbumCaption(e.target.value)}
              maxLength={1024}
              className="w-full bg-black/5 dark:bg-white/10 placeholder-gray-400 dark:placeholder-text-secondary rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green/50"
            />
            <button
              onClick={() => void sendPendingAlbum()}
              className="w-full py-2.5 min-h-[44px] rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green"
            >
              Send
            </button>
            <button
              onClick={() => { setPendingAlbum(null); setAlbumCaption(''); }}
              className="w-full py-2.5 text-sm font-semibold text-gray-500 dark:text-text-secondary hover:opacity-80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* WA parity A9: GIF caption sheet — preview + caption before send
          (like WhatsApp); tapping a GIF no longer sends it immediately
          caption-less. The caption is encrypted to e2eeCaption by the
          write pipeline, like photo/video captions. */}
      {pendingGif && (
        <div className="fixed inset-0 z-[70] bg-black/60 flex items-end sm:items-center justify-center p-4" onClick={() => { setPendingGif(null); setGifCaption(''); }} role="dialog" aria-modal="true" aria-label="Send GIF">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Send GIF</h3>
            <div className="rounded-xl overflow-hidden bg-gray-100 dark:bg-input-dark flex items-center justify-center">
              {pendingGif.mp4Url ? (
                <video src={pendingGif.mp4Url} autoPlay loop muted playsInline className="max-h-64 w-full object-contain" />
              ) : (
                <img src={pendingGif.previewUrl || pendingGif.url} alt={pendingGif.title || 'GIF'} className="max-h-64 w-full object-contain" />
              )}
            </div>
            {pendingGif.attribution && (
              <p className="text-xs text-gray-500 dark:text-text-secondary">via {pendingGif.attribution}</p>
            )}
            <input
              data-testid="gif-caption-input"
              aria-label="Add a caption"
              placeholder="Type a caption"
              value={gifCaption}
              onChange={(e) => setGifCaption(e.target.value)}
              maxLength={1024}
              className="w-full bg-black/5 dark:bg-white/10 placeholder-gray-400 dark:placeholder-text-secondary rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green/50"
            />
            <button
              onClick={() => void sendPendingGif()}
              className="w-full py-2.5 min-h-[44px] rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green"
            >
              Send
            </button>
            <button
              onClick={() => { setPendingGif(null); setGifCaption(''); }}
              className="w-full py-2.5 text-sm font-semibold text-gray-500 dark:text-text-secondary hover:opacity-80"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Phase 4: round video recording modal — live circular preview, 60s cap. */}
      {isRoundRecording && (
        <div className="fixed inset-0 z-[9999] bg-black/85 flex flex-col items-center justify-center gap-5 p-6" role="dialog" aria-modal="true" aria-label="Record round video">
          <div className="relative h-64 w-64">
            <video ref={roundPreviewRef} autoPlay muted playsInline className="h-64 w-64 rounded-full object-cover bg-black" />
            <span className="absolute top-3 right-3 bg-black/60 text-white text-xs font-mono px-2 py-1 rounded-full">
              ● {fmtSecs(roundSecs)} / 1:00
            </span>
          </div>
          <p className="text-white text-sm text-center">Round video — up to 60 seconds.<br />Tap Stop to send it as a circle video.</p>
          <div className="flex gap-3">
            <button onClick={cancelRoundVideo} className="px-5 py-2.5 min-h-[44px] rounded-full bg-white/15 text-white text-sm font-medium hover:bg-white/25">
              Cancel
            </button>
            <button onClick={stopRoundVideo} className="px-5 py-2.5 min-h-[44px] rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green">
              Stop &amp; send
            </button>
          </div>
        </div>
      )}

      {/* Disappearing messages settings */}
      <DisappearingMessagesModal
        open={showDisappearModal}
        current={disappearAfter}
        onSelect={setDisappearTimer}
        onClose={() => setShowDisappearModal(false)}
      />

      {/* WA parity (DM audit row 11): Report this contact — stores a
          report for admin review AND blocks the contact. */}
      {showReportConfirm && !isCommunity && (
        <div className="fixed inset-0 z-[110] bg-black/60 flex items-end sm:items-center justify-center p-4 animate-fade-in" onClick={() => setShowReportConfirm(false)} role="dialog" aria-modal="true" aria-label="Report this contact">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-base flex items-center gap-2">
              <Flag className="h-4 w-4 text-red-500" /> Report {otherUser?.displayName || otherUser?.username || 'this contact'}?
            </h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Reporting also blocks this contact. The report is stored for review.</p>
            <div className="space-y-2">
              {(['Spam', 'Harassment', 'Scam', 'Other'] as ReportReason[]).map((reason) => (
                <button
                  key={reason}
                  onClick={() => void handleReport(reason)}
                  className="w-full text-left px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/15 text-sm font-medium"
                >
                  {reason}
                </button>
              ))}
              <button
                onClick={() => setShowReportConfirm(false)}
                className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-gray-500 hover:bg-gray-100 dark:hover:bg-input-dark"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* REPORT-3 #65 (W20): per-chat notification tone picker. The pick
          writes appSettings.setChatTone(conversationId, …) — the same id
          the push watcher reads — and previews the tone on tap. "Use
          default" clears the override (setChatTone deletes the entry),
          so the chat falls back to the global (DM) / group tone. The
          tone still stays silent during quiet hours (W9 enforcement). */}
      {showToneModal && conversationId && (
        <div className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowToneModal(false)}>
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-label="Notification tone for this chat">
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-white/10 pb-2">
              <h3 className="font-bold text-base flex items-center gap-2">Notification tone</h3>
              <button aria-label="Close notification tone picker" onClick={() => setShowToneModal(false)} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-text-secondary">Plays for new messages in this chat only, instead of the global tone. Silent during quiet hours.</p>
            <div className="space-y-2">
              <button
                onClick={() => { setChatTone(conversationId, ''); showToastMsg('Notification tone reset to the default for this chat'); setShowToneModal(false); }}
                className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm font-medium transition ${!chatToneId ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
              >
                <span>Use default (global / group tone){!chatToneId ? ' ✓' : ''}</span>
              </button>
              {NOTIFICATION_TONES.map((tone) => (
                <button
                  key={tone.id}
                  onClick={() => { setChatTone(conversationId, tone.id); playNotificationTone(tone.id); showToastMsg(`Notification tone for this chat: ${tone.label}`); setShowToneModal(false); }}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm font-medium transition ${chatToneId === tone.id ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
                >
                  <span>{tone.label}{chatToneId === tone.id ? ' ✓' : ''}</span>
                  <span className="text-xs opacity-60">Tap to preview</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Theme fix: per-chat theme & wallpaper picker. */}
      {showChatTheme && (
        <ChatThemePickerModal
          chatId={partnerUid || ''}
          onClose={() => setShowChatTheme(false)}
          onSaved={() => setShowChatTheme(false)}
        />
      )}

      {/* Fullscreen Media Lightbox */}
      <MediaLightbox
        allowDownload={!isHidden}
        isOpen={lightbox.open}
        onClose={() => setLightbox(prev => ({ ...prev, open: false }))}
        mediaUrl={lightbox.url}
        mediaType={lightbox.type}
        senderName={lightbox.senderName}
        time={lightbox.time}
        caption={lightbox.caption}
        items={lightbox.items}
        index={lightbox.index}
        onNavigate={(i) => setLightbox((prev) => {
          const it = prev.items?.[i];
          return it ? { ...prev, url: it.url, type: it.type, senderName: it.senderName, time: it.time, caption: it.caption, index: i } : prev;
        })}
        onToast={showToastMsg}
        // G2b: spend a view-once view only when the media loads; a failed
        // load leaves it unspent. G2c: no Share button on a view-once item.
        onMediaLoad={markViewOnceSeen}
        onMediaError={handleViewOnceLoadError}
        allowShare={!lightbox.viewOnce}
      />

      {/* MF-01 (scaffold, VO-01/VO-02): dedicated view-once viewer — the
          shared MediaLightbox above is never used for view-once media. */}
      {viewOnceViewer && (
        <ViewOnceViewer
          isOpen
          onClose={() => setViewOnceViewer(null)}
          mediaUrl={viewOnceViewer.mediaUrl}
          mediaType={viewOnceViewer.mediaType}
          senderName={viewOnceViewer.senderName}
          time={viewOnceViewer.time}
          onToast={showToastMsg}
        />
      )}

      {/* Telegram Style Message Forward Modal */}
      {forwardMsg && (
        <div className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={() => { setForwardMsg(null); setForwardMsgs(null); setForwardCaption(''); }}>
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-white/10 pb-2">
              <h3 className="font-bold text-base flex items-center gap-2">
                <Share2 className="h-4 w-4 text-primary-green" /> Forward to...{forwardSentCount > 0 ? ` (${forwardSentCount} of ${FORWARD_CAP})` : ''}
              </h3>
              <button aria-label="Close forward picker" onClick={() => { setForwardMsg(null); setForwardMsgs(null); setForwardCaption(''); }} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            {/* Nightshift §6b: caption input for a single forwarded
                message — add one, edit the prefilled original, or clear
                it. Multi-forwards keep each message's own caption, so
                no input is shown there. */}
            {(!forwardMsgs || forwardMsgs.length <= 1) && (
              <input
                data-testid="forward-caption-input"
                aria-label="Add a caption"
                placeholder="Type a caption"
                value={forwardCaption}
                onChange={(e) => setForwardCaption(e.target.value)}
                maxLength={1024}
                className="w-full bg-black/5 dark:bg-white/10 placeholder-gray-400 dark:placeholder-text-secondary rounded-full px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green/50"
              />
            )}
            <div className="max-h-60 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5">
              {contactsList.length === 0 ? (
                <p className="p-4 text-center text-xs text-gray-500">No contacts available to forward</p>
              ) : (
                contactsList
                  .filter((contact) => {
                    // Phase 5 (L-12): never forward INTO a locked chat, and
                    // never show a locked partner as a forward target.
                    return !isLockedPartnerCached(contact.uid || contact.id);
                  })
                  .map(contact => {
                    const alreadySent = forwardedTargetUids.includes(contact.uid || contact.id);
                    return (
                  <div
                    key={contact.id || contact.uid}
                    onClick={() => { if (alreadySent) { showToastMsg('Already forwarded to this chat'); return; } void handleForwardTo(contact.uid || contact.id, forwardCaption); }}
                    className={`flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-input-dark cursor-pointer transition-colors ${alreadySent ? 'opacity-60' : ''}`}
                  >
                    <DefaultAvatar
                      photoURL={contact.photoURL}
                      name={contact.displayName || contact.username || 'User'}
                      seed={contact.id || contact.uid}
                      size={40}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate text-gray-900 dark:text-text-primary">{contact.displayName || contact.username}</p>
                      <p className="text-xs text-gray-500 truncate">@{contact.username}</p>
                    </div>
                    <button className="px-3 py-1 bg-primary-green/10 text-primary-green text-xs font-semibold rounded-full hover:bg-primary-green/20">
                      {alreadySent ? '✓ Sent' : 'Send'}
                    </button>
                  </div>
                    );
                  })
              )}
            </div>
          </div>
        </div>
      )}
      {/* Group Info Modal (communities only) */}
      {isCommunity && chatId && (
        <GroupInfoModal
          isOpen={showGroupInfo}
          onClose={() => setShowGroupInfo(false)}
          group={otherUser}
          groupId={chatId}
          currentUser={currentUser}
          allUsers={groupInfoUsers}
          onLeaveGroup={handleLeaveGroup}
          onToast={showToastMsg}
          events={groupEventDocs}
          onCancelEvent={(eventId) => { void cancelEvent(eventId); }}
        />
      )}

      {/* Full Contact Profile Inspector Modal */}
      <UserProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        user={{
          uid: partnerUid,
          id: partnerUid,
          displayName: isCommunity ? otherUser?.name : (otherUser?.displayName || otherUser?.username || 'User'),
          username: otherUser?.username || '',
          email: otherUser?.email || '',
          photoURL: otherUser?.photoURL || otherUser?.avatar || '',
          about: otherUser?.bio || otherUser?.about || 'Hey there! I am using Pinglo.',
          online: isOnline(otherUser),
          lastSeen: otherUser?.lastSeen,
          // W28b/F1: pass privacy through — the modal's own isOnline() /
          // lastSeenText() calls must see it, or a Last-seen=Nobody user
          // shows "Online now" (and a real timestamp) here.
          lastSeenPrivacy: otherUser?.lastSeenPrivacy,
        }}
        onStartCall={(type) => {
          setShowProfileModal(false);
          handleCall(type);
        }}
        onToggleBlock={toggleBlockUser}
        isBlocked={isBlocked}
        muted={chatMuted}
        onToggleMute={handleToggleChatMute}
        muteBusy={muteBusy}
      />

      {/* Reaction Breakdown Bottom Sheet */}
      {reactionDetailsMsg && (
        <div className="fixed inset-0 z-[105] bg-black/60 flex items-end animate-fade-in" onClick={() => setReactionDetailsMsg(null)}>
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-4 max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-white/10 pb-3">
              <h3 className="font-bold text-base flex items-center gap-2">
                Reactions ({countReactions(reactionDetailsMsg.reactions)})
              </h3>
              <button onClick={() => setReactionDetailsMsg(null)} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="overflow-y-auto space-y-2 flex-1">
              {/* W26: validated via getWhoReacted — the old code counted and
                  rendered raw Object.entries, so a junk stored value showed
                  as a row and the header total could disagree with the
                  ReactionChips counts (the same reason countReactions
                  exists). getWhoReacted filters non-string/empty emojis,
                  puts me first as "You", resolves names from contactsList. */}
              {getWhoReacted(reactionDetailsMsg.reactions, currentUser?.uid, (uid) => {
                if (uid === currentUser?.uid && currentUser) return currentUser;
                return contactsList.find(c => c.uid === uid || c.id === uid);
              }).map(({ uid, emoji, displayName, photoURL, isMe }) => (
                <div
                  key={uid}
                  onClick={() => {
                    if (isMe) {
                      addReaction(reactionDetailsMsg.id, emoji);
                      setReactionDetailsMsg(null);
                    }
                  }}
                  className={`flex items-center justify-between p-2.5 rounded-xl ${isMe ? 'hover:bg-red-500/10 cursor-pointer' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    <DefaultAvatar photoURL={photoURL} name={displayName} seed={uid} size={40} />
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-text-primary">{displayName}</p>
                      {isMe && <p className="text-[11px] text-red-400">Tap to remove reaction</p>}
                    </div>
                  </div>
                  <span className="text-2xl">{emoji}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Phase 3: message info sheet (delivered / seen times, edit history) */}
      {msgInfo && (
        <div className="fixed inset-0 z-[105] bg-black/60 flex items-end animate-fade-in" onClick={() => setMsgInfo(null)}>
          <div className="w-full max-h-[80vh] overflow-y-auto bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Message info">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-base">Message info</h3>
              <button aria-label="Close message info" onClick={() => setMsgInfo(null)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"><X className="h-5 w-5 text-gray-500" /></button>
            </div>
            <p className="text-sm text-gray-700 dark:text-text-primary break-words">{msgInfo.text || '[Media]'}</p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500 dark:text-text-secondary">Sent</span><span>{fmtDateTime(msgInfo.timestamp)}</span></div>
              {/* 1:1 only: single Delivered / Seen times (unchanged). Groups show
                  the per-member lists below instead — one anonymous time would
                  name no one (G1). */}
              {!isCommunity && (<>
                <div className="flex justify-between"><span className="text-gray-500 dark:text-text-secondary">Delivered</span><span>{(() => { const t = deliveredAtForMessage(msgInfo, deliveredUpToByUid, currentUser?.uid); return t ? fmtDateTime(t) : (msgInfo.status === 'delivered' || msgInfo.status === 'seen' ? 'Delivered (time not recorded)' : '—'); })()}</span></div>
                <div className="flex justify-between"><span className="text-gray-500 dark:text-text-secondary">Seen</span><span>{(() => { const t = seenAtForMessage(msgInfo, seenUpToByUid, currentUser?.uid); return t ? fmtDateTime(t) : (msgInfo.status === 'seen' ? 'Seen (time not recorded)' : '—'); })()}</span></div>
              </>)}
              {msgInfo.editedAt && <div className="flex justify-between"><span className="text-gray-500 dark:text-text-secondary">Edited</span><span>{fmtDateTime(msgInfo.editedAt)}</span></div>}
            </div>
            {/* G1: group per-member receipts — Read by / Delivered to, with
                avatar + name + time per row (list items, names as text).
                Read times hidden when read receipts are off. */}
            {isCommunity && (() => {
              const { readBy, deliveredTo } = groupMsgReceipts(msgInfo);
              const row = (r: { uid: string; name: string; photoURL: string; at: number }) => (
                <li key={r.uid} className="flex items-center justify-between gap-3 py-1">
                  <span className="flex items-center gap-3 min-w-0">
                    <DefaultAvatar photoURL={r.photoURL} name={r.name} seed={r.uid} size={32} />
                    <span className="text-sm text-gray-900 dark:text-text-primary break-words min-w-0" style={{ overflowWrap: 'break-word' }}>{r.name}</span>
                  </span>
                  <span className="text-sm text-gray-500 dark:text-text-secondary shrink-0">{fmtDateTime(r.at)}</span>
                </li>
              );
              return (
                <div className="space-y-3 pt-1">
                  {receiptsEffective && (
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-text-primary mb-1">Read by</p>
                      {readBy.length === 0 ? (
                        <p className="text-sm text-gray-500 dark:text-text-secondary py-1">No one has read this yet.</p>
                      ) : (
                        <ul className="space-y-1">{readBy.map(row)}</ul>
                      )}
                    </div>
                  )}
                  {deliveredTo.length > 0 && (
                    <div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-text-primary mb-1">Delivered to</p>
                      <ul className="space-y-1">{deliveredTo.map(row)}</ul>
                    </div>
                  )}
                </div>
              );
            })()}
            {Array.isArray(msgInfo.editHistory) && msgInfo.editHistory.length > 0 && (
              <div className="pt-2 border-t border-gray-100 dark:border-white/10">
                <p className="text-xs font-semibold text-gray-500 mb-2">Edit history</p>
                {msgInfo.editHistory.map((h: any, i: number) => (
                  <p key={i} className="text-xs text-gray-500 dark:text-text-secondary py-0.5">“{h.text}” — {fmtDateTime(h.at || h.editedAt)}</p>
                ))}
                {msgInfo.editHistoryTruncated && (
                  <p className="text-xs text-gray-500 dark:text-text-secondary py-0.5">Older edits removed — only the last {MAX_EDIT_HISTORY_ENTRIES} are kept.</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Phase 3: delete confirm modal (replaces window.confirm) */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={() => setDeleteConfirm(null)}>
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm delete">
            <h3 className="font-bold text-base">Delete {deleteConfirm.ids.length > 1 ? `${deleteConfirm.ids.length} messages` : 'message'}?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">{deleteConfirm.kind === 'everyone' ? 'This will delete the message(s) for everyone in this chat.' : 'This will delete the message(s) for you only.'}</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setDeleteConfirm(null)} className="flex-1 py-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-medium">Cancel</button>
              <button onClick={doDeleteConfirmed} className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold">Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ROADMAP-2 item 10: clear-chat confirm — per-user only, never
          deletes for the other side. */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center p-4 animate-fade-in" onClick={() => setShowClearConfirm(false)}>
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label="Confirm clear chat">
            <h3 className="font-bold text-base">Clear chat?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Messages in this chat will be hidden for you only. The other person still sees them, and new messages will keep appearing.</p>
            <div className="flex gap-2 pt-1">
              <button onClick={() => setShowClearConfirm(false)} className="flex-1 py-2.5 rounded-xl bg-gray-100 dark:bg-input-dark text-sm font-medium">Cancel</button>
              <button onClick={doClearChat} className="flex-1 py-2.5 rounded-xl bg-red-500 text-white text-sm font-semibold">Clear chat</button>
            </div>
          </div>
        </div>
      )}

      {/* Media, Links & Docs Modal */}
      {showMediaGallery && (
        <div className="fixed inset-0 z-[105] bg-black/60 flex items-end animate-fade-in" onClick={() => setShowMediaGallery(false)}>
          <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-white/10 pb-2">
              <h3 className="font-bold text-base flex items-center gap-2">
                📁 Media, Links & Docs
              </h3>
              <button onClick={() => setShowMediaGallery(false)} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex bg-gray-100 dark:bg-input-dark rounded-xl p-1 gap-1">
              {(['media', 'docs', 'links'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setMediaGalleryTab(tab)}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg capitalize transition ${
                    mediaGalleryTab === tab ? 'bg-green-cta text-white shadow-sm' : 'text-gray-500'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Gallery Content */}
            <div className="overflow-y-auto flex-1 min-h-[220px]">
              {mediaGalleryTab === 'media' && (
                <div className="grid grid-cols-3 gap-2">
                  {visibleMsgs.filter(m => m.mediaUrl && (m.mediaType === 'image' || m.mediaType === 'video')).length === 0 ? (
                    <p className="col-span-3 text-center py-10 text-xs text-gray-500">No media sent in this chat</p>
                  ) : (
                    visibleMsgs.filter(m => m.mediaUrl && (m.mediaType === 'image' || m.mediaType === 'video')).map(m => (
                      <div
                        key={m.id}
                        onClick={() => {
                          setShowMediaGallery(false);
                          openLightbox({ url: m.mediaUrl, type: m.mediaType, senderName: m.senderName, time: formatTime(m.timestamp), caption: captionFor(m) }, chatMediaItems());
                        }}
                        className="aspect-square bg-gray-200 dark:bg-input-dark rounded-lg overflow-hidden cursor-pointer relative group"
                      >
                        {m.mediaType === 'video' ? (
                          <video src={m.mediaUrl} poster={m.posterUrl || undefined} preload="metadata" className="w-full h-full object-cover" />
                        ) : (
                          <img src={m.mediaUrl} alt="" className="w-full h-full object-cover" />
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}

              {mediaGalleryTab === 'docs' && (
                <div className="space-y-2">
                  {visibleMsgs.filter(m => m.mediaUrl && (m.mediaType === 'file' || m.mediaType === 'audio')).length === 0 ? (
                    <p className="text-center py-10 text-xs text-gray-500">No documents or audio in this chat</p>
                  ) : (
                    visibleMsgs.filter(m => m.mediaUrl && (m.mediaType === 'file' || m.mediaType === 'audio')).map(m => (
                      <a
                        key={m.id}
                        href={m.mediaUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-3 p-3 rounded-xl bg-gray-100 dark:bg-input-dark hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
                      >
                        <FileText className="h-6 w-6 text-primary-green flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate text-gray-900 dark:text-text-primary">{m.text || 'Document file'}</p>
                          <p className="text-[10px] text-gray-500">{formatTime(m.timestamp)}, {m.senderName}</p>
                        </div>
                        <ExternalLink className="h-4 w-4 text-gray-500" />
                      </a>
                    ))
                  )}
                </div>
              )}

              {mediaGalleryTab === 'links' && (
                <div className="space-y-2">
                  {visibleMsgs.filter(m => m.text && /https?:\/\/[^\s]+/i.test(m.text)).length === 0 ? (
                    <p className="text-center py-10 text-xs text-gray-500">No web links shared yet</p>
                  ) : (
                    visibleMsgs.filter(m => m.text && /https?:\/\/[^\s]+/i.test(m.text)).map(m => {
                      const linkMatches = m.text.match(/https?:\/\/[^\s]+/gi) || [];
                      return linkMatches.map((lnk: string, lIdx: number) => (
                        <a
                          key={`${m.id}-${lIdx}`}
                          href={lnk}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-3 p-3 rounded-xl bg-gray-100 dark:bg-input-dark hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors"
                        >
                          <ExternalLink className="h-5 w-5 text-blue-400 flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-gray-900 dark:text-text-primary truncate">{(() => { try { return new URL(lnk).hostname; } catch { return lnk; } })()}</p>
                            <p className="text-xs font-medium text-blue-400 truncate">{lnk}</p>
                            <p className="text-[10px] text-gray-500">{formatTime(m.timestamp)}, from {m.senderName}</p>
                          </div>
                        </a>
                      ));
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* E2EE notice sheet — opened by tapping the lock pill above. */}
      <E2EENotice
        open={showE2EESheet}
        onClose={() => setShowE2EESheet(false)}
        chatName={isCommunity ? otherUser?.name : (otherUser?.displayName || otherUser?.username)}
        isGroup={isCommunity}
        state={chatIsEncrypted ? 'e2ee' : e2eeChatState === 'legacy' ? 'legacy' : 'unknown'}
      />
    </div>
  );
}
