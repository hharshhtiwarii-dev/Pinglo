import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowLeft, Key, Bell, Lock, LockKeyhole, HelpCircle, LogOut, Camera, ChevronRight, CheckCircle2, Check, Moon, Sun, Share2, Shield, HardDrive, Download, QrCode, UserPlus, Trash2, Volume2, Languages, Type, Palette, Edit2, MessageSquare, ScanLine, ArrowUpDown, Globe, Smile, Image as ImageIcon, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { signOut, updateProfile, authManager, validateDisplayUsername, doc, getDoc, updateDoc, collection, addDoc, serverTimestamp, onSnapshot, query, where, auth, db } from '../../aws';
import { uploadProfilePicture, photoTooLargeMessage } from '../../aws/storage';
import { navigationManager } from '../../services/navigation';
import { partnerIdForConversation } from '../../services/realtimeSync';
import DeleteAccountModal from '../../components/DeleteAccountModal';
import DefaultAvatar from '../../components/DefaultAvatar';
import PhotoCropper from '../../components/PhotoCropper';
import CameraModal from '../../components/CameraModal';
import ToggleSwitch from '../../components/ToggleSwitch';
import QRCodeModal from '../../components/QRCodeModal';
import QRScannerModal from '../../components/QRScannerModal';
import ChatBackupPanel from '../../components/ChatBackupPanel';
import { parseDeepLink, routeDeepLink } from '../../services/deepLink';
import AppLockScreen from './AppLockScreen';
import { addAccount, listSavedAccounts, recordCurrentAccount, removeSavedAccount, switchToAccount, MAX_SAVED_ACCOUNTS, type SavedAccount } from '../../services/accounts';
import { getLanguage, SUPPORTED_LANGUAGES, useLanguage, type LanguageCode } from '../../services/language';
import {
  applyFontSize, getDataUsagePrefs, getDefaultDisappearing, getEnterIsSend, getFontSize,
  getMediaUploadQuality, getNotificationPrefs, getNotificationTone, getReplaceEmoji,
  getSpellCheck, NOTIFICATION_TONES, playNotificationTone, setDataUsagePrefs,
  setDefaultDisappearing, setEnterIsSend, setMediaUploadQuality, setNotificationPrefs,
  setNotificationTone, setReplaceEmoji, setSpellCheck,
  getQuietHours, isQuietHoursActive, setQuietHours,
  getBlockUnknownMessages, getKeepChatsArchived, getLinkPreviewsEnabled,
  setBlockUnknownMessages, setKeepChatsArchived, setLinkPreviewsEnabled,
  getSecurityNotificationsEnabled, setSecurityNotificationsEnabled,
  getHdAutoDownloadPrefs, setHdAutoDownloadPrefs,
  type AutoDownloadMode, type DataUsagePrefs, type FontSize, type HdAutoDownloadPrefs, type MediaUploadQuality,
  type NotificationPrefs, type PopupMode, type QuietHours, type VibrateMode,
} from '../../services/appSettings';
import { ChatThemePicker } from '../../components/ChatThemePicker';
import AvatarCreator from '../../components/AvatarCreator';
import { loadAvatarTraits, svgDataUrlToPngFile } from '../../components/avatar';
import {
  applyAppTheme, effectiveDark, getCurrentThemeName, resolveTheme, saveChatThemeState,
  type AppThemeMode, type ChatThemeState,
} from '../../services/chatTheme';
import { isAppLockEnabled } from '../../services/appLock';
import BlockedContactsScreen from './BlockedContactsScreen';
import { loadHiddenChatIds } from '../../services/lockedChats';
import { normalizeGroupsPrivacy, normalizeOnlinePrivacy, normalizePrivacyLevel, setMyLastSeenPrivacy, setMyOnlinePrivacy, type GroupsPrivacy, type OnlinePrivacy, type PrivacyLevel } from '../../services/presence';
import { getDefaultStatusAllow, getDefaultStatusPrivacy, setDefaultStatusAllow, setDefaultStatusPrivacy, type StatusPrivacyDefault } from '../../services/presence';
import { loadGatedContactsDetailed } from '../../services/contacts';
// REPORT-3 #66/#242 (W10): call prefs live in callService; Settings is
// the first screen that ever writes them (previously zero callers).
import { callService, getCallPrefs, setCallPrefs, type CallPrefs } from '../../services/callService';
import {
  getNotificationPermission,
  getSavedPushToken,
  isWebNotificationSupported,
  requestPermissionAndRegister,
  setNotificationsEnabled as setPushNotificationsEnabled,
  notifyIncomingMessage,
} from '../../services/pushNotifications';
import { isAdminUser } from '../../services/adminService';
import {
  SECURITY_CODE_CHANGED_EVENT,
  dismissSecurityCodeChange,
  listSecurityCodeChanges,
  type SecurityCodeChangeAlert,
} from '../../services/e2ee/securityNotifications';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { avatarFallback } from '../../utils/avatar';

export default function SettingsScreen() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;

  const [activeTab, setActiveTab] = useState<'main' | 'account' | 'privacy' | 'notifications' | 'help' | 'theme' | 'display' | 'applock' | 'blocked' | 'chats'>('main');
  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(currentUser?.displayName || '');
  const [username, setUsername] = useState(currentUser?.username || '');
  const [about, setAbout] = useState('Hey there! I am using Pinglo.');
  const [avatar, setAvatar] = useState(currentUser?.photoURL || avatarFallback(currentUser?.displayName || 'User', currentUser?.uid));
  // Profile-fix: phone is read-only (from the account), cropper + photo menu state.
  const [phone, setPhone] = useState('');
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [showPhotoMenu, setShowPhotoMenu] = useState(false);
  // WA parity (audit e #3): Take-photo opens the in-app camera.
  const [showCamera, setShowCamera] = useState(false);
  const [showRemovePhotoConfirm, setShowRemovePhotoConfirm] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [checkingUsername, setCheckingUsername] = useState(false);
  // Master-gaps: dedicated Change username / Change password forms (Account tab).
  const [showChangeUsername, setShowChangeUsername] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [usernameChangeError, setUsernameChangeError] = useState('');
  const [changingUsername, setChangingUsername] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [notifPermission, setNotifPermission] = useState<string>(() => getNotificationPermission());
  const [pushTokenSaved, setPushTokenSaved] = useState(() => !!getSavedPushToken());
  const [readReceipts, setReadReceipts] = useState(true);
  const [blockedUsersCount, setBlockedUsersCount] = useState(0);
  const [darkMode, setDarkMode] = useState(() => document.documentElement.classList.contains('dark'));
  const [contactMsg, setContactMsg] = useState('');
  const [contactSent, setContactSent] = useState(false);
  // WA-verify-5 #65: guard against double-tap duplicate sends (the
  // submit had no busy flag — two quick taps wrote two feedback docs).
  const [contactSending, setContactSending] = useState(false);
  // 100M-D2 (follow-up): the success banner's auto-reset timer id, so a
  // stale timer from an earlier send can never hide a later send's banner.
  const contactSentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 100M-D5 (W14f): same class as D2 — the toast's auto-clear timer id, so
  // a second toast fired before the first one's timer expires is cleared
  // by ITS OWN timer, not the first one's (which cut it short at ~1 s).
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  // A12: shown only when the clipboard copy actually failed.
  const [inviteCopyFailed, setInviteCopyFailed] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [accountInfoRequested, setAccountInfoRequested] = useState(false);
  const [accountInfoBusy, setAccountInfoBusy] = useState(false);
  const [contactError, setContactError] = useState('');
  const [toast, setToast] = useState('');
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [appliedTheme, setAppliedTheme] = useState<string | null>(() => getCurrentThemeName());
  // Theme fix — Chats / notifications / privacy prefs (WhatsApp parity).
  const [notifPrefs, setNotifPrefsState] = useState<NotificationPrefs>(() => getNotificationPrefs());
  // S19: explanatory note shown after "Send a test notification" when the
  // banner is suppressed by the Popup pref.
  const [testNote, setTestNote] = useState('');
  const [groupTone, setGroupTone] = useState<string>(() => getNotificationPrefs().groupTone);
  const [uploadQuality, setUploadQuality] = useState<MediaUploadQuality>(() => getMediaUploadQuality());
  const [spellCheckOn, setSpellCheckOn] = useState<boolean>(() => getSpellCheck());
  const [replaceEmojiOn, setReplaceEmojiOn] = useState<boolean>(() => getReplaceEmoji());
  const [enterIsSendOn, setEnterIsSendOn] = useState<boolean>(() => getEnterIsSend());
  const [aboutPrivacy, setAboutPrivacy] = useState<PrivacyLevel>('everyone');
  const [statusDefault, setStatusDefault] = useState<StatusPrivacyDefault>(() => getDefaultStatusPrivacy());
  // WA parity (audit e #23, Wave-2 C4): the default "Only share with…"
  // allow-list — the mirror of the except-list. Persisted in
  // localStorage (presence.ts) and snapshotted onto each new status at
  // post time; the snapshot filter fails closed when it is missing.
  // Contacts come only from the gated contacts graph (no whole-users
  // read — the W28 enumeration leak stays closed).
  const [statusAllow, setStatusAllow] = useState<string[]>(() => getDefaultStatusAllow());
  const [statusAllowContacts, setStatusAllowContacts] = useState<any[]>([]);
  const statusAllowLoadedRef = useRef(false);
  // 100M-D3: the state setter was named setDefaultDisappearing, shadowing
  // the imported persistence function of the same name — the handler then
  // called the state setter twice and never persisted. Renamed so both
  // are reachable.
  const [defaultDisappearing, setDefaultDisappearingState] = useState<number>(() => getDefaultDisappearing());
  // REPORT-3 #66/#242: DND + silence-unknown-callers (per-device prefs,
  // localStorage — same model as the other call prefs in callService).
  const [callPrefs, setCallPrefsState] = useState<CallPrefs>(() => getCallPrefs());
  // REPORT-3 #72: one short tap buzz for settings toggles / pills.
  // navigator.vibrate is a no-op where unsupported; never throws.
  const hapticTap = () => {
    try {
      navigator.vibrate?.(10);
    } catch { /* intentionally ignored */}
  };
  // Phase 4 (Worker C) — accounts / tones / font / language / data usage / privacy / QR / app lock.
  const { t: tr, setLanguage: setLangHook } = useLanguage();
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>(() => listSavedAccounts());
  const [switchingUid, setSwitchingUid] = useState<string | null>(null);
  const [notifTone, setNotifTone] = useState<string>(() => getNotificationTone());
  // REPORT-3 #65 (W20): quiet hours — pref layer + enforcement already
  // exist (W9, appSettings + pushNotifications); this state drives the
  // Settings UI that lets the user set them.
  const [quietHours, setQuietHoursState] = useState<QuietHours>(() => getQuietHours());
  const [fontSize, setFontSizeState] = useState<FontSize>(() => getFontSize());
  const [language, setLanguageState] = useState<LanguageCode>(() => getLanguage());
  const [dataUsage, setDataUsage] = useState<DataUsagePrefs>(() => getDataUsagePrefs());
  const [lastSeenPrivacy, setLastSeenPrivacy] = useState<PrivacyLevel>('everyone');
  const [photoPrivacy, setPhotoPrivacy] = useState<PrivacyLevel>('everyone');
  // WA parity (audit e top-10): online visibility, groups privacy, link
  // previews, block-unknown-messages, per-type HD auto-download, keep-archived.
  const [onlinePrivacy, setOnlinePrivacy] = useState<OnlinePrivacy>('everyone');
  const [groupsPrivacy, setGroupsPrivacy] = useState<GroupsPrivacy>('everyone');
  const [linkPreviewsOn, setLinkPreviewsOn] = useState<boolean>(() => getLinkPreviewsEnabled());
  const [blockUnknownOn, setBlockUnknownOn] = useState<boolean>(() => getBlockUnknownMessages());
  const [hdAutoDownload, setHdAutoDownload] = useState<HdAutoDownloadPrefs>(() => getHdAutoDownloadPrefs());
  const [keepArchivedOn, setKeepArchivedOn] = useState<boolean>(() => getKeepChatsArchived());
  // Wave-2 C3 (Settings #16b): security notifications toggle + pending
  // security-code-change alerts raised by the E2EE key-exchange path.
  const [securityNotifsOn, setSecurityNotifsOn] = useState<boolean>(() => getSecurityNotificationsEnabled());
  const [secAlerts, setSecAlerts] = useState<SecurityCodeChangeAlert[]>(() => listSecurityCodeChanges());
  const [showMyQR, setShowMyQR] = useState(false);
  const [showAvatarCreator, setShowAvatarCreator] = useState(false);
  // Cluster C (Item 15a): scan a Pinglo QR code.
  const [showScanQR, setShowScanQR] = useState(false);
  const [appLockOn, setAppLockOn] = useState(() => isAppLockEnabled());

  const showToastMsg = (msg: string) => {
    // 100M-D5: clear the previous toast's timer first — without this the
    // first toast's 3 s timer cleared the second toast ~1 s after it fired.
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(''), 3000);
  };
  // Wave-2 C3 (#16b): display name for a security-code-change alert —
  // same source as the chat list (chats doc: group name, or the peer's
  // displayName / username), falling back to the users doc for the peer
  // uid, then to a generic label. Recomputed when alerts arrive or the
  // tab changes, so docs that land after first render still resolve.
  const secAlertNames = useMemo(() => {
    const map = new Map<string, string>();
    try {
      for (const d of (db as any).getCollectionDocs?.('chats') || []) {
        const id = String(d.id || '');
        if (!id) continue;
        if (d.isGroup) map.set(id, (d.name || '').trim() || 'Group');
        else {
          map.set(id, (d.displayName || d.username || '').trim() ||
            (d.email ? String(d.email).split('@')[0] : '') || 'DT User');
        }
      }
      for (const u of (db as any).getCollectionDocs?.('users') || []) {
        const uid = String(u.uid || u.id || '');
        const name = ((u.displayName || u.username || '') as string).trim();
        if (uid && name) map.set(`user:${uid}`, name);
      }
    } catch { /* best-effort; the fallback below still labels the alert */ }
    return map;
  }, [secAlerts, activeTab]);
  const secAlertName = (a: SecurityCodeChangeAlert): string =>
    secAlertNames.get(a.chatId) || secAlertNames.get(`user:${a.peerUid}`) || 'A contact';
  const formatAlertTime = (ts: number): string => {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };
  const handleSecurityNotifsChange = (on: boolean) => {
    setSecurityNotificationsEnabled(on);
    setSecurityNotifsOn(on);
    hapticTap();
  };
  // Wave-2 C3 (#16b): refresh the pending alerts whenever the Account
  // tab opens, and live when a change is detected while this screen is
  // mounted (the `dt:security-code-changed` event from
  // securityNotifications.ts). A toast confirms the alert even if the
  // user is looking at the Account tab when it lands.
  useEffect(() => {
    if (activeTab === 'account') setSecAlerts(listSecurityCodeChanges());
    const onChange = () => {
      setSecAlerts(listSecurityCodeChanges());
      if (activeTab === 'account') showToastMsg('A contact’s security code changed');
    };
    window.addEventListener(SECURITY_CODE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SECURITY_CODE_CHANGED_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  // Snapshot of profile fields when edit mode starts, so Cancel can discard changes.
  const editSnapshotRef = useRef({ displayName: '', about: '', username: '' });
  // Side-by-side (Item 7a/7b): mirror of isEditing for snapshot callbacks.
  const isEditingRef = useRef(false);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);
  // Side-by-side (Item 7a): opening the profile editor must show the
  // whole avatar — the settings list may be scrolled down, which used to
  // leave the avatar half cut off at the top. Jump back to the top when
  // editing starts.
  const mainScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isEditing) mainScrollRef.current?.scrollTo({ top: 0 });
  }, [isEditing]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // WA parity (audit e #66): the Terms & Privacy row at the top of Help
  // scrolls to the in-app Terms / Privacy Policy text below.
  const termsRef = useRef<HTMLDivElement>(null);
  const privacyRef = useRef<HTMLDivElement>(null);

  // Side-by-side (Item 7b): read the profile (incl. username) from the
  // users doc via a live snapshot, not a one-shot getDoc. In mock /
  // no-backend mode getDoc's GraphQL read fails before the local cache
  // restores from IndexedDB, so the username stayed blank and the form
  // showed the "@choose a username" placeholder; the snapshot delivers
  // the doc once the cache restores. While editing, snapshots are
  // ignored so a background refresh never clobbers typed values.
  useEffect(() => {
    if (!currentUser) {
      // Phase 4: apply the saved font size live (startup restore in main.tsx is still pending — see PATCH).
      applyFontSize(getFontSize());
      return;
    }
    const unsub = onSnapshot(doc(db, 'users', currentUser.uid), (docSnap: any) => {
      if (!docSnap.exists() || isEditingRef.current) return;
      const data = docSnap.data();
      // Worker B (overnight round 2, #7): the Account screen used to read
      // the username ONLY from the users doc, so it showed `@unknown`
      // whenever that doc had not landed yet (or was missing) even though
      // the signed-in session already carries the username the user just
      // signed up with — the profile editor and the Account screen then
      // disagreed. Fall back to the session username, the same source the
      // display name already falls back to below, so both screens agree
      // from the first render; the users doc still wins when present.
      setUsername(data.username || currentUser.username || '');
      setDisplayName(data.displayName || currentUser.displayName || data.username || '');
      // Phone is account data — shown read-only, never edited here.
      if (data.phone) setPhone(String(data.phone));
      else if (data.phoneNumber) setPhone(String(data.phoneNumber));
      if (data.about) setAbout(data.about);
      if (data.bio) setAbout(data.bio);
      if (data.photoURL) setAvatar(data.photoURL);
      if (data.notificationsEnabled !== undefined) setNotificationsEnabled(data.notificationsEnabled);
      if (data.readReceipts !== undefined) setReadReceipts(data.readReceipts);
      if (data.blockedUsers) setBlockedUsersCount(data.blockedUsers.length);
      // Phase 4: privacy choices stored on the user doc.
      setLastSeenPrivacy(normalizePrivacyLevel(data.lastSeenPrivacy));
      setPhotoPrivacy(normalizePrivacyLevel(data.profilePhotoPrivacy));
      // WA parity (audit e): online visibility + groups privacy, same
      // user-doc model as last seen (client-side enforcement only).
      setOnlinePrivacy(normalizeOnlinePrivacy(data.onlinePrivacy));
      setGroupsPrivacy(normalizeGroupsPrivacy(data.groupsPrivacy));
      // Theme fix: About privacy + default status audience.
      setAboutPrivacy(normalizePrivacyLevel(data.aboutPrivacy));
      if (data.defaultStatusPrivacy) setStatusDefault(data.defaultStatusPrivacy);
    });
    // Phase 4: apply the saved font size live (startup restore in main.tsx is still pending — see PATCH).
    applyFontSize(getFontSize());
    return () => { try { unsub(); } catch (err) { console.warn("[SettingsScreen] SettingsScreen: unsub() failed", err); } };
  }, [currentUser]);

  useEffect(() => {
    if (activeTab !== 'main') {
      return navigationManager.pushHandler(() => {
        setActiveTab('main');
        return true;
      });
    }
  }, [activeTab]);

  // WA parity (audit e #23, Wave-2 C4): load the gated contacts once,
  // only when the Privacy tab is opened, so the "Only share with…"
  // allow-list picker has someone to pick from. Offline failures keep
  // the previous (possibly empty) list — the picker says so honestly.
  useEffect(() => {
    if (activeTab !== 'privacy' || !currentUser?.uid || statusAllowLoadedRef.current) return;
    let cancelled = false;
    void loadGatedContactsDetailed(currentUser.uid).then(({ list }) => {
      if (cancelled) return;
      statusAllowLoadedRef.current = true;
      setStatusAllowContacts(list);
    }).catch(() => { /* offline: keep the previous list */ });
    return () => { cancelled = true; };
  }, [activeTab, currentUser?.uid]);

  // Escape closes the logout confirm dialog.
  useEffect(() => {
    if (!showLogoutConfirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowLogoutConfirm(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showLogoutConfirm]);

  const toggleDarkMode = async () => {
    hapticTap();
    const newMode = !darkMode;
    setDarkMode(newMode);
    // Theme fix: route through the chat-theme service so the Privacy toggle
    // and the theme screen's Light/Dark/System control stay in sync.
    applyAppTheme(newMode ? 'dark' : 'light');
    // Keep the phone's status bar in step with the app theme
    if (Capacitor.isNativePlatform()) {
      StatusBar.setStyle({ style: newMode ? Style.Dark : Style.Light }).catch((err) => console.warn("[SettingsScreen] SettingsScreen: StatusBar.setStyle({ style: newMode ? Style....", err));
      StatusBar.setBackgroundColor({ color: newMode ? '#111B21' : '#FFFFFF' }).catch((err) => console.warn("[SettingsScreen] SettingsScreen: StatusBar.setBackgroundColor({ color: newMod...", err));
    }
    // Save preference
    if (currentUser) {
      try {
        await updateDoc(doc(db, 'users', currentUser.uid), { darkMode: newMode });
      } catch (err) {
        console.warn("[SettingsScreen] SettingsScreen: await updateDoc(doc(db, 'users', currentUser...", err);
      }
    }
  };

  const handleLogout = async () => {
    setShowLogoutConfirm(true);
  };

  const confirmLogout = async () => {
    setShowLogoutConfirm(false);
    if (currentUser) {
      // Phase 4: remember this account so it shows in the switcher next time.
      recordCurrentAccount();
      try { await updateDoc(doc(db, 'users', currentUser.uid), { online: false, status: 'offline' }); } catch (err) { console.warn("[SettingsScreen] SettingsScreen: await updateDoc(doc(db, 'users', currentUser...", err); }
    }
    await signOut(auth);
    navigate('/login');
  };

  // ── Phase 4: multiple accounts ──────────────────────────────────────────
  const handleSwitchAccount = async (targetUid: string) => {
    if (targetUid === currentUser?.uid || switchingUid) return;
    setSwitchingUid(targetUid);
    try {
      const ok = await switchToAccount(targetUid);
      if (!ok) {
        showToastMsg('Could not switch to that account.');
        return;
      }
      // signOut() triggers App's auth listener -> routes to /login, where
      // the target email is prefilled; the user re-enters their password.
      navigate('/login');
    } catch {
      showToastMsg('Could not switch accounts. Try again.');
    } finally {
      setSwitchingUid(null);
    }
  };

  const handleAddAccount = async () => {
    await addAccount();
    navigate('/login');
  };

  const handleRemoveAccount = (uid: string) => {
    setSavedAccounts(removeSavedAccount(uid));
    showToastMsg('Account removed from this device (the account itself is NOT deleted).');
  };

  // ── Phase 4: notification tone / font size / language / data usage ─────
  const handleToneChange = (id: string) => {
    setNotifTone(id);
    setNotificationTone(id);
    playNotificationTone(id);
  };

  const handleFontSizeChange = (size: FontSize) => {
    hapticTap();
    setFontSizeState(size);
    applyFontSize(size);
  };

  const handleLanguageChange = (code: LanguageCode) => {
    setLanguageState(code);
    setLangHook(code); // persists + notifies all useLanguage() subscribers
  };

  const handleDataUsageChange = (kind: 'photos' | 'videos' | 'documents' | 'audio', mode: AutoDownloadMode) => {
    const next = { ...dataUsage, [kind]: mode };
    setDataUsage(next);
    setDataUsagePrefs(next);
  };

  // ── Phase 4: last-seen / profile-photo privacy ──────────────────────────
  // Theme fix: extended with About privacy (same client-side-only model).
  const handlePrivacyChange = async (field: 'lastSeenPrivacy' | 'profilePhotoPrivacy' | 'aboutPrivacy', level: PrivacyLevel) => {
    if (!currentUser) return;
    hapticTap();
    if (field === 'lastSeenPrivacy') {
      setLastSeenPrivacy(level);
      setMyLastSeenPrivacy(level); // stop/start publishing lastSeen immediately
    } else if (field === 'profilePhotoPrivacy') {
      setPhotoPrivacy(level);
    } else {
      setAboutPrivacy(level);
    }
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { [field]: level });
      showToastMsg('Privacy updated ✓');
    } catch {
      showToastMsg('Could not save privacy setting. Try again.');
    }
  };

  // ── WA parity (audit e top-10): online visibility + groups privacy ───
  // Same user-doc model as last seen (client-side enforcement only — the
  // Settings footer says so plainly; real enforcement needs backend rules).
  const handleOnlinePrivacyChange = async (level: OnlinePrivacy) => {
    if (!currentUser) return;
    hapticTap();
    setOnlinePrivacy(level);
    setMyOnlinePrivacy(level); // presence display-gate reads the cache
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { onlinePrivacy: level });
      showToastMsg('Privacy updated ✓');
    } catch {
      showToastMsg('Could not save privacy setting. Try again.');
    }
  };

  const handleGroupsPrivacyChange = async (level: GroupsPrivacy) => {
    if (!currentUser) return;
    hapticTap();
    setGroupsPrivacy(level);
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { groupsPrivacy: level });
      showToastMsg('Privacy updated ✓');
    } catch {
      showToastMsg('Could not save privacy setting. Try again.');
    }
  };

  // WA parity (audit e #31): link previews on/off — ChatScreen and Saved
  // Messages read the pref at render time, so this takes effect at once.
  const handleLinkPreviewsChange = (on: boolean) => {
    hapticTap();
    setLinkPreviewsOn(on);
    setLinkPreviewsEnabled(on);
  };

  // WA parity (audit e #30): block unknown account messages — when on,
  // senders who are not saved contacts and have no proven DM with you
  // never trigger a notification. Their messages still appear in the
  // chat list (full blocking needs the server); the row says so.
  const handleBlockUnknownChange = (on: boolean) => {
    hapticTap();
    setBlockUnknownOn(on);
    setBlockUnknownMessages(on);
    showToastMsg(on ? 'Unknown senders will no longer notify you.' : 'Unknown senders can notify you again.');
  };

  // Wave-2 Media A12 — per-type HD auto-download (WA: "Photos will be
  // automatically downloaded in HD quality, but videos will not." /
  // "Photos and videos will be automatically downloaded in HD quality."
  // / "You can choose which photos or videos to download in HD quality.").
  // Photos and videos each get their own HD / Standard choice; the copy
  // under the heading follows the combination, WA's exact sentences.
  const handleHdAutoDownloadChange = (kind: 'photos' | 'videos', hd: boolean) => {
    hapticTap();
    const next = { ...hdAutoDownload, [kind]: hd };
    setHdAutoDownload(next);
    setHdAutoDownloadPrefs(next);
    showToastMsg(hd ? `${kind === 'photos' ? 'Photos' : 'Videos'} will auto-download in HD quality.` : `${kind === 'photos' ? 'Photos' : 'Videos'} will auto-download in standard quality.`);
  };

  // WA parity (audit e #48): keep chats archived — ON (default) archived
  // chats stay in the Archived view even with new messages; OFF lets an
  // archived chat with unread messages resurface in the main list.
  const handleKeepArchivedChange = (on: boolean) => {
    hapticTap();
    setKeepArchivedOn(on);
    setKeepChatsArchived(on);
  };
  // Do Not Disturb silences every incoming call; silence-unknown rings
  // only for saved contacts / proven conversations / previously called
  // people (callService.isKnownCaller). Silenced calls are still logged
  // as missed on this device — the caller hears ringing until timeout.
  const handleCallPrefsChange = (patch: Partial<CallPrefs>) => {
    hapticTap();
    setCallPrefsState(setCallPrefs(patch));
  };

  // 100M-C8 (W12f) — call ringtone: same tap-to-preview pattern as the
  // message tone (handleToneChange). The preview plays exactly what an
  // incoming call will play for that tone (callService.previewCallRingtone
  // shares the ring-cycle renderer with the live ring).
  const handleCallRingtoneChange = (id: string) => {
    handleCallPrefsChange({ ringtone: id });
    callService.previewCallRingtone(id);
  };

  // ── Theme fix: notifications / chats / privacy extras ──────────────────
  const handleNotifPrefsChange = (patch: Partial<NotificationPrefs>) => {
    hapticTap();
    const next = { ...notifPrefs, ...patch };
    setNotifPrefsState(next);
    setNotificationPrefs(patch);
  };

  const handleGroupToneChange = (id: string) => {
    setGroupTone(id);
    handleNotifPrefsChange({ groupTone: id });
    playNotificationTone(id);
  };

  // REPORT-3 #65 (W20): quiet-hours UI. While quiet hours are active the
  // watcher silences the tone + vibration (pushNotifications.ts, W9) —
  // the banner still shows, so nothing is lost, it just does not buzz.
  const handleQuietHoursChange = (patch: Partial<QuietHours>) => {
    hapticTap();
    // <input type="time"> can be cleared to '' — ignore an invalid time
    // and keep the previous valid one (getQuietHours would fall back
    // anyway, but the input should not go blank on a stray clear).
    const validTime = (v: string | undefined) =>
      v === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    if (!validTime(patch.start) || !validTime(patch.end)) return;
    const next = { ...quietHours, ...patch };
    setQuietHoursState(next);
    setQuietHours(patch);
  };

  const handleUploadQualityChange = (q: MediaUploadQuality) => {
    setUploadQuality(q);
    setMediaUploadQuality(q);
    showToastMsg(
      q === 'best' ? 'Best quality: photos upload up to 2560px, less compression.'
        : q === 'data-saver' ? 'Data saver: photos compressed to 1024px before upload.'
        : 'Auto: photos compressed to 1600px before upload.'
    );
  };

  const handleSpellCheckChange = (v: boolean) => {
    setSpellCheckOn(v);
    setSpellCheck(v);
  };

  const handleReplaceEmojiChange = (v: boolean) => {
    setReplaceEmojiOn(v);
    setReplaceEmoji(v);
  };

  const handleEnterIsSendChange = (v: boolean) => {
    setEnterIsSendOn(v);
    setEnterIsSend(v);
  };

  const handleStatusDefaultChange = (v: StatusPrivacyDefault) => {
    setStatusDefault(v);
    setDefaultStatusPrivacy(v);
    showToastMsg('Default status audience saved. It applies to new statuses you post.');
  };

  // WA parity (audit e #23, Wave-2 C4): toggle one person in the
  // default "Only share with…" allow-list and persist immediately, so
  // the per-status sheet (which reads the same default) stays in sync.
  const handleStatusAllowToggle = (uid: string) => {
    if (!uid) return;
    setStatusAllow(prev => {
      const next = prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid];
      setDefaultStatusAllow(next);
      return next;
    });
  };

  const handleDefaultDisappearingChange = (seconds: number) => {
    // 100M-D3: update the UI state AND persist (imported setDefaultDisappearing
    // writes dt_default_disappearing). The old code called the state setter
    // twice and never persisted, so the timer reverted to Off on reload
    // while the toast claimed it was saved.
    setDefaultDisappearingState(seconds);
    setDefaultDisappearing(seconds);
    showToastMsg(seconds === 0 ? 'Default disappearing timer off for new chats.' : 'Default disappearing timer saved for new chats.');
  };

  // ── Profile-fix: username rules ──────────────────────────────────────────
  // The rule lives in aws/auth.ts (validateDisplayUsername) so the profile
  // editor and the dedicated Change-username form share one rule: 3–30
  // chars, starts with a letter; letters, numbers, dots and underscores.
  const validateUsername = (v: string): string => validateDisplayUsername(v);

  /**
   * One-shot availability check against the users collection. The doc-level
   * username comparison is done client-side too, so the check stays correct
   * even if the backend ignores the `where` filter (mock mode).
   */
  const checkUsernameAvailable = (candidate: string): Promise<'free' | 'taken' | 'unknown'> => {
    return new Promise((resolve) => {
      let done = false;
      let unsub: (() => void) | null = null;
      const finish = (result: 'free' | 'taken' | 'unknown') => {
        if (done) return;
        done = true;
        setTimeout(() => { try { unsub?.(); } catch (err) { console.warn("[SettingsScreen] finish: unsub?.() failed", err); } }, 0);
        resolve(result);
      };
      try {
        unsub = onSnapshot(query(collection(db, 'users'), where('username', '==', candidate)), (snap: any) => {
          const docs: any[] = snap?.docs || [];
          const taken = docs.some((d: any) => d.id !== currentUser?.uid && (d.data?.()?.username || '') === candidate);
          finish(taken ? 'taken' : 'free');
        });
      } catch {
        finish('unknown');
        return;
      }
      setTimeout(() => finish('unknown'), 8000);
    });
  };

  const handleSaveProfile = async () => {
    if (!currentUser || checkingUsername) return;
    // WA verify settings-1, row 5/row 4: the inputs cap typing via
    // maxLength, but a programmatic value set bypasses that (a headless
    // probe proved a 120-char About could be staged). Clamp here so the
    // stored value can never exceed the caps on any input path.
    const cleanName = displayName.trim().slice(0, 30);
    const cleanAbout = about.trim().slice(0, 100);
    if (!cleanName) {
      showToastMsg('Display name cannot be empty');
      return;
    }
    const cleanUsername = username.trim().toLowerCase();
    const usernameChanged = cleanUsername !== editSnapshotRef.current.username;
    // A never-set username may stay unset; once set it can't be blanked.
    if (usernameChanged) {
      const uErr = validateUsername(cleanUsername);
      if (uErr) {
        setUsernameError(uErr);
        showToastMsg(uErr);
        return;
      }
      setCheckingUsername(true);
      const availability = await checkUsernameAvailable(cleanUsername);
      setCheckingUsername(false);
      if (availability === 'taken') {
        const msg = 'This username is already taken. Please choose another.';
        setUsernameError(msg);
        showToastMsg(msg);
        return;
      }
      if (availability === 'unknown') {
        showToastMsg('Could not verify username availability — check your connection and try again.');
        return;
      }
    }
    try {
      // Never persist the initials fallback (a data: SVG URI) as the photo —
      // an empty photoURL lets every screen render DefaultAvatar instead.
      const photoToSave = avatar.startsWith('data:') ? '' : avatar;
      await updateProfile(currentUser, { displayName: cleanName, photoURL: photoToSave });
      await updateDoc(doc(db, 'users', currentUser.uid), {
        displayName: cleanName,
        username: cleanUsername,
        about: cleanAbout,
        bio: cleanAbout,
        photoURL: photoToSave
      });
      setUsername(cleanUsername);
      setUsernameError('');
      setIsEditing(false);
      showToastMsg('Profile updated ✓');
    } catch {
      showToastMsg('Failed to update profile.');
    }
  };

  // ── Master-gaps: dedicated Change username / Change password ───────────
  // Username: same rule + same availability check as the profile editor.
  // Uniqueness is a client-side check against the users collection — there
  // is no server-side unique index, so a race between two users picking
  // the same name at the same moment could still collide.
  const handleChangeUsername = async () => {
    if (!currentUser || changingUsername) return;
    const clean = newUsername.trim().toLowerCase();
    const uErr = validateUsername(clean);
    if (uErr) {
      setUsernameChangeError(uErr);
      return;
    }
    if (clean === (username || '').toLowerCase()) {
      setUsernameChangeError('That is already your username.');
      return;
    }
    setChangingUsername(true);
    setUsernameChangeError('');
    try {
      const availability = await checkUsernameAvailable(clean);
      if (availability === 'taken') {
        setUsernameChangeError('This username is already taken. Please choose another.');
        return;
      }
      if (availability === 'unknown') {
        setUsernameChangeError('Could not verify username availability — check your connection and try again.');
        return;
      }
      await authManager.changeUsername(clean);
      setUsername(clean);
      setNewUsername('');
      setShowChangeUsername(false);
      showToastMsg('Username changed ✓');
    } catch (err: any) {
      setUsernameChangeError(err?.message || 'Could not change username. Try again.');
    } finally {
      setChangingUsername(false);
    }
  };

  // Password: verified by Cognito via Amplify updatePassword — a wrong
  // current password is an error, never a fake success.
  const handleChangePassword = async () => {
    if (changingPassword) return;
    setPasswordError('');
    if (!currentPassword) {
      setPasswordError('Enter your current password.');
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    setChangingPassword(true);
    try {
      await authManager.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowChangePassword(false);
      showToastMsg('Password changed ✓');
    } catch (err: any) {
      setPasswordError(err?.message || 'Could not change password. Try again.');
    } finally {
      setChangingPassword(false);
    }
  };

  // Enter edit mode remembering the saved values, so Cancel can discard edits.
  const startEditing = () => {
    editSnapshotRef.current = { displayName, about, username };
    setUsernameError('');
    setIsEditing(true);
  };
  const cancelEditing = () => {
    setDisplayName(editSnapshotRef.current.displayName);
    setAbout(editSnapshotRef.current.about);
    setUsername(editSnapshotRef.current.username);
    setUsernameError('');
    setIsEditing(false);
  };

  // Live username input: lowercase + strip characters that can never be valid,
  // and show the rule error inline as the user types.
  const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
    setUsername(cleaned);
    setUsernameError(cleaned ? validateUsername(cleaned) : '');
  };

  // Picking a photo opens the cropper; the upload happens only after cropping.
  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToastMsg('Please choose an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToastMsg(photoTooLargeMessage());
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setCropSrc(reader.result); };
    reader.onerror = () => showToastMsg('Could not read that image.');
    reader.readAsDataURL(file);
  };

  // WA parity (audit e #3): a photo taken in the in-app camera goes
  // through the same validation + cropper flow as a gallery pick, so the
  // upload path (handleCropDone) stays the single writer.
  const handleCameraPhoto = (file: File) => {
    setShowCamera(false);
    if (!file.type.startsWith('image/')) {
      showToastMsg('Please take a photo (image file).');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToastMsg('Profile picture must be smaller than 5MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') setCropSrc(reader.result); };
    reader.onerror = () => showToastMsg('Could not read that photo.');
    reader.readAsDataURL(file);
  };

  const handleCropDone = async (blob: Blob) => {
    setCropSrc(null);
    if (!currentUser) return;
    const file = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
    setUploading(true);
    try {
      const url = await uploadProfilePicture(file);
      setAvatar(url);
      await updateProfile(currentUser, { photoURL: url });
      await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url });
      showToastMsg('Profile photo updated ✓');
    } catch (err: any) {
      showToastMsg(err.message || 'Failed to upload image.');
    } finally {
      setUploading(false);
    }
  };

  const handleRemovePhoto = async () => {
    setShowRemovePhotoConfirm(false);
    if (!currentUser) return;
    try {
      await updateProfile(currentUser, { photoURL: '' });
      await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: '' });
      setAvatar(avatarFallback(displayName || 'User', currentUser.uid));
      showToastMsg('Profile photo removed');
    } catch {
      showToastMsg('Could not remove photo. Try again.');
    }
  };

  // WA verify settings-1, row 9: WA's avatar IS the profile avatar — DT's
  // AvatarCreator was stickers-only. Rasterise the avatar SVG to PNG
  // (uploadProfilePicture rejects SVG, and a `data:` photoURL renders as
  // the initials fallback) then save it through the exact same path as
  // the photo cropper, so the avatar becomes the profile photo.
  const handleUseAvatarAsPhoto = async (dataUrl: string) => {
    if (!currentUser || uploading) return;
    setUploading(true);
    try {
      const file = await svgDataUrlToPngFile(dataUrl);
      const url = await uploadProfilePicture(file);
      setAvatar(url);
      await updateProfile(currentUser, { photoURL: url });
      await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url });
      setShowAvatarCreator(false);
      showToastMsg('Profile photo updated ✓');
    } catch (err: any) {
      showToastMsg(err?.message || 'Could not use avatar as profile photo.');
    } finally {
      setUploading(false);
    }
  };

  const toggleSetting = async (setting: 'notificationsEnabled' | 'readReceipts', currentValue: boolean) => {
    if (!currentUser) return;
    hapticTap();
    const newValue = !currentValue;
    if (setting === 'notificationsEnabled') {
      setNotificationsEnabled(newValue);
      // Keep the foreground watcher / banner in step with the user doc.
      setPushNotificationsEnabled(newValue);
      if (newValue) {
        const res = await requestPermissionAndRegister(currentUser.uid).catch(() => null);
        setNotifPermission(getNotificationPermission());
        setPushTokenSaved(!!getSavedPushToken() || res?.ok === true);
      }
    }
    if (setting === 'readReceipts') setReadReceipts(newValue);
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), { [setting]: newValue });
    } catch (err) {
      console.warn("[SettingsScreen] toggleSetting: await updateDoc(doc(db, 'users', currentUser....", err);
    }
  };

  const handleEnableNotifications = async () => {
    if (!currentUser) return;
    await requestPermissionAndRegister(currentUser.uid).catch((err) => console.warn("[SettingsScreen] handleEnableNotifications: updateDoc(...) failed", err));
    setNotifPermission(getNotificationPermission());
    setPushTokenSaved(!!getSavedPushToken());
  };

  const handleTestNotification = () => {
    // S19 (100-more): with Popup off the test looks dead — the banner is
    // suppressed by design and a silent tone + no vibrate leaves nothing
    // at all. Say so instead of silently doing nothing.
    // WA-verify-5 #57: 'screen-off' also suppresses the banner while the
    // app is in use (it only shows when the app is in the background),
    // so the same explanation applies — otherwise the test looks broken.
    if (notifPrefs.popup === 'off') {
      setTestNote('No banner will appear. Popup is set to “Off”. The tone still plays. Turn Popup on to see the banner.');
    } else if (notifPrefs.popup === 'screen-off') {
      setTestNote('No banner will appear while you’re using the app. Popup is set to “Screen off” — the banner only shows when the app is in the background. The tone still plays.');
    } else {
      setTestNote('');
    }
    notifyIncomingMessage({
      conversationId: '',
      senderId: 'test',
      senderName: 'Pinglo',
      text: 'Test notification. Notifications are working ✓',
      messageId: `test-${Date.now()}`,
    });
  };

  // S10 (100-more): keyboard support for clickable rows that are plain
  // <div onClick> (the SettingsItem component already does this).
  const onRowKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  };

  const handleInviteFriend = async () => {
    const inviteText = `Hey! Join me on Pinglo - the best private messaging app! 🚀\n\nDownload now: https://dtchats.app\n\nMy username: @${username || displayName || 'pinglo_user'}`;
    const showCopied = () => {
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2500);
    };
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Join Pinglo', text: inviteText });
        return;
      }
      await navigator.clipboard.writeText(inviteText);
      showCopied();
    } catch (_) {
      // A12: only claim "copied" when the copy actually succeeded. The
      // old code set inviteCopied(true) in the catch path even when the
      // clipboard write failed (headless: NotAllowedError — "Document is
      // not focused"). A cancelled share sheet also lands here, so fall
      // back to the clipboard once, honestly.
      try {
        await navigator.clipboard.writeText(inviteText);
        showCopied();
      } catch (err) {
        console.warn('[SettingsScreen] handleInviteFriend: clipboard copy failed', err);
        setInviteCopyFailed(true);
        setTimeout(() => setInviteCopyFailed(false), 4000);
      }
    }
  };

  const handleContactSubmit = async () => {
    if (!contactMsg.trim() || contactSending) return;
    setContactError('');
    setContactSending(true);
    // 100M-D2 (follow-up): the success banner's 4 s auto-reset timer must
    // not outlive its own send — a stale timer from send #1 fired after
    // send #2's success and hid the banner, so the second message looked
    // unsent (textarea cleared, no success, no error). Cancel any pending
    // reset before starting a new one.
    if (contactSentTimerRef.current) clearTimeout(contactSentTimerRef.current);
    try {
      await addDoc(collection(db, 'feedback'), {
        userId: currentUser?.uid || 'anonymous',
        userEmail: currentUser?.email || 'unknown',
        userName: displayName || currentUser?.displayName || 'User',
        message: contactMsg.trim(),
        timestamp: serverTimestamp()
      });
      setContactSent(true);
      setContactMsg('');
      contactSentTimerRef.current = setTimeout(() => setContactSent(false), 4000);
    } catch {
      // Honest failure: previously the success banner showed even when the
      // write failed. Now the user sees an error and can retry.
      setContactError('Could not send your message — check your connection and try again.');
    } finally {
      setContactSending(false);
    }
  };

  /**
   * Request account info — real export, not a fake "we'll email you".
   * Builds a JSON file with the profile, settings and chat list and
   * downloads it on the spot. Chat contents are NOT included (only the
   * chat list: id, participants, type), so the file stays small.
   */
  const handleRequestAccountInfo = async () => {
    if (!currentUser || accountInfoBusy) return;
    setAccountInfoBusy(true);
    try {
      const profileSnap = await getDoc(doc(db, 'users', currentUser.uid)).catch(() => null);
      const profile = profileSnap?.exists() ? profileSnap.data() : {};
      // One-shot read of the chats collection (unsubscribe after first snapshot).
      const chats: any[] = await new Promise((resolve) => {
        const unsub = onSnapshot(collection(db, 'chats'), (snap: any) => {
          const list = (snap?.docs || []).map((d: any) => {
            const data = d.data() || {};
            return {
              id: d.id,
              type: data.type || data.isCommunity ? 'community' : 'chat',
              participants: data.participants || data.members || undefined,
              name: data.name || data.displayName || undefined,
              lastMessageAt: data.lastMessageAt || data.timestamp || undefined,
            };
          });
          // Defer unsubscribe so the subscription is registered first.
          setTimeout(() => { try { unsub(); } catch (err) { console.warn("[SettingsScreen] handleRequestAccountInfo: unsub() failed", err); } }, 0);
          // Phase 5 (L-15): strip locked chats from the export. A locked
          // DM's conversation id is the sorted uid pair; a locked partner
          // also appears in `participants`. Either match excludes the row.
          void loadHiddenChatIds(currentUser.uid).then((hidden) => {
            const hiddenSet = new Set(hidden);
            const visible = list.filter((c: any) => {
              const parts: string[] = Array.isArray(c.participants) ? c.participants.map(String) : [];
              if (parts.some((p) => hiddenSet.has(p))) return false;
              // #236: derive the DM partner by prefix/suffix — a naive
              // split('_') mis-splits mock uids ('usr_<uuid>'), so a locked
              // mock DM leaked into the account-info export. Split check
              // kept as fallback.
              const partner = partnerIdForConversation(String(c.id || ''), currentUser.uid);
              if (partner && hiddenSet.has(partner)) return false;
              const idParts = String(c.id || '').split('_');
              if (idParts.some((p) => hiddenSet.has(p))) return false;
              return true;
            });
            resolve(visible.slice(0, 500));
          });
        });
      });
      const exportData = {
        exportedAt: new Date().toISOString(),
        app: 'Pinglo',
        account: {
          uid: currentUser.uid,
          email: currentUser.email || '',
          username: profile.username || username || '',
          displayName: profile.displayName || displayName || '',
          about: profile.about || profile.bio || about || '',
          photoURL: profile.photoURL || '',
          createdAt: profile.createdAt || null,
        },
        settings: {
          darkMode,
          notificationsEnabled,
          readReceipts,
          blockedUsersCount,
          chatTheme: appliedTheme || getCurrentThemeName(),
          wallpaper: localStorage.getItem('dtwall') || null,
        },
        chats,
        note: 'This export contains your profile, settings and chat list. Message contents are not included.',
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pinglo-account-info-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setAccountInfoRequested(true);
    } catch {
      showToastMsg('Could not build your account export. Try again.');
    } finally {
      setAccountInfoBusy(false);
    }
  };

  const renderAccountScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6">
        <h2 className="text-lg font-medium mb-4">Account Security</h2>
        <p className="text-sm text-gray-500 dark:text-text-secondary mb-6">
          Your account is protected by AWS Cognito sign-in. In 1-to-1 chats that have exchanged keys, message text is end-to-end encrypted (AES-256-GCM, keys agreed directly with the other person) before it leaves your phone. But media, polls, group chats and messages sent before the keys were exchanged are not, and the server does not enforce encryption.
        </p>
        <button
          className="w-full text-left py-3 border-b border-gray-200 dark:border-white/5 text-gray-900 dark:text-text-primary hover:text-primary-green transition-colors flex items-center justify-between"
          onClick={() => navigate('/settings/e2ee')}
        >
          <span className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary-green" />
            <span>
              <span className="block text-sm font-medium">End-to-end encryption</span>
              <span className="block text-xs text-gray-500 dark:text-text-secondary">Keys, safety numbers &amp; verification</span>
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-gray-400" />
        </button>
        {/* Wave-2 C3 (Settings #16b): security notifications — WA's
            Account subtitle is "Security notifications, account info".
            When on, a contact's security-code (E2EE identity-key) change
            raises an alert here so the safety number can be re-verified
            before trusting the chat again. */}
        <div className="flex items-center justify-between py-3 border-b border-gray-200 dark:border-white/5">
          <div className="pr-3">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Security notifications</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Get notified when a contact&apos;s security code changes — for example, after they reinstall Pinglo or switch phones.</p>
          </div>
          <ToggleSwitch checked={securityNotifsOn} onChange={handleSecurityNotifsChange} label="Security notifications" />
        </div>
        {secAlerts.length > 0 && (
          <div className="py-3 border-b border-gray-200 dark:border-white/5">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Security code changes</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1 mb-2">These contacts&apos; security codes changed. Check the safety number before trusting the chat again.</p>
            <div className="space-y-2">
              {secAlerts.map((a) => (
                <div key={`${a.chatId}:${a.peerKeyId || a.at}`} className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
                  <Shield className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-text-primary">{secAlertName(a)}&apos;s security code changed</p>
                    <p className="text-xs text-gray-500 dark:text-text-secondary">{formatAlertTime(a.at)}</p>
                  </div>
                  <button
                    onClick={() => navigate('/settings/e2ee')}
                    className="px-3 py-1.5 rounded-full bg-primary-green/10 text-primary-green text-xs font-bold flex-shrink-0"
                  >
                    Review
                  </button>
                  <button
                    onClick={() => { dismissSecurityCodeChange(a.chatId, a.peerKeyId); setSecAlerts(listSecurityCodeChanges()); }}
                    aria-label={`Dismiss security code change for ${secAlertName(a)}`}
                    className="p-1.5 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-text-primary flex-shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-4">
          <div className="py-3 border-b border-gray-200 dark:border-white/5">
            <p className="text-sm text-gray-500 dark:text-text-secondary">Email</p>
            <p className="text-base text-gray-900 dark:text-text-primary font-medium">{currentUser?.email}</p>
          </div>
          <div className="py-3 border-b border-gray-200 dark:border-white/5">
            <p className="text-sm text-gray-500 dark:text-text-secondary">Username</p>
            <p className="text-base text-gray-900 dark:text-text-primary font-medium">@{username || 'unknown'}</p>
          </div>
          {/* Master-gaps: Change username — same rule + availability check as
              the profile editor. The Cognito login name itself can't be
              renamed; this changes the @username people see (saved as the
              Cognito preferred_username when possible). */}
          <button
            className="w-full text-left py-3 border-b border-gray-200 dark:border-white/5 text-gray-900 dark:text-text-primary hover:text-primary-green transition-colors flex items-center justify-between"
            onClick={() => { setShowChangeUsername((v) => !v); setShowChangePassword(false); setUsernameChangeError(''); setNewUsername(username); }}
          >
            <span className="flex items-center gap-2">
              <Edit2 className="h-4 w-4 text-primary-green" />
              <span>
                <span className="block text-sm font-medium">Change username</span>
                <span className="block text-xs text-gray-500 dark:text-text-secondary">3–30 characters, letters, numbers, dots and underscores</span>
              </span>
            </span>
            <ChevronRight className={`h-4 w-4 text-gray-400 transition-transform ${showChangeUsername ? 'rotate-90' : ''}`} />
          </button>
          {showChangeUsername && (
            <div className="py-3 border-b border-gray-200 dark:border-white/5 space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-text-secondary">New username</label>
                <div className="flex items-center border-b border-primary-green focus-within:border-header-green py-1">
                  <span className="text-gray-500 dark:text-text-secondary mr-0.5">@</span>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => {
                      const cleaned = e.target.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
                      setNewUsername(cleaned);
                      setUsernameChangeError(cleaned ? validateUsername(cleaned) : '');
                    }}
                    className="flex-1 bg-transparent outline-none text-gray-900 dark:text-text-primary font-mono"
                    maxLength={30}
                    placeholder="choose a username"
                    autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  />
                </div>
                {usernameChangeError ? (
                  <p className="text-xs text-danger-red mt-1">{usernameChangeError}</p>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Your sign-in name stays the same. Cognito login names can&apos;t be renamed. Only the @username people see changes.</p>
                )}
              </div>
              <button
                onClick={handleChangeUsername}
                disabled={changingUsername}
                className="w-full py-2.5 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green disabled:opacity-50"
              >
                {changingUsername ? 'Checking availability…' : 'Save username'}
              </button>
            </div>
          )}
          {/* Master-gaps: Change password — verified by Cognito via Amplify
              updatePassword. A wrong current password shows an error. */}
          <button
            className="w-full text-left py-3 border-b border-gray-200 dark:border-white/5 text-gray-900 dark:text-text-primary hover:text-primary-green transition-colors flex items-center justify-between"
            onClick={() => { setShowChangePassword((v) => !v); setShowChangeUsername(false); setPasswordError(''); }}
          >
            <span className="flex items-center gap-2">
              <Key className="h-4 w-4 text-primary-green" />
              <span>
                <span className="block text-sm font-medium">Change password</span>
                <span className="block text-xs text-gray-500 dark:text-text-secondary">Your current password is required</span>
              </span>
            </span>
            <ChevronRight className={`h-4 w-4 text-gray-400 transition-transform ${showChangePassword ? 'rotate-90' : ''}`} />
          </button>
          {showChangePassword && (
            <div className="py-3 border-b border-gray-200 dark:border-white/5 space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-text-secondary">Current password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full border-b border-primary-green bg-transparent py-1 outline-none focus:border-header-green text-gray-900 dark:text-text-primary"
                  autoComplete="current-password"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-text-secondary">New password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full border-b border-primary-green bg-transparent py-1 outline-none focus:border-header-green text-gray-900 dark:text-text-primary"
                  autoComplete="new-password"
                />
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">At least 8 characters.</p>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-text-secondary">Confirm new password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full border-b border-primary-green bg-transparent py-1 outline-none focus:border-header-green text-gray-900 dark:text-text-primary"
                  autoComplete="new-password"
                />
              </div>
              {passwordError && <p className="text-xs text-danger-red">{passwordError}</p>}
              <button
                onClick={handleChangePassword}
                disabled={changingPassword}
                className="w-full py-2.5 bg-green-cta text-white rounded-xl font-medium hover:bg-dark-green disabled:opacity-50"
              >
                {changingPassword ? 'Changing password…' : 'Change password'}
              </button>
            </div>
          )}
          <button
            className="w-full text-left py-3 border-b border-gray-200 dark:border-white/5 text-gray-900 dark:text-text-primary hover:text-primary-green transition-colors flex items-center justify-between"
            onClick={handleRequestAccountInfo}
            disabled={accountInfoBusy}
          >
            <span>Request account info</span>
            {accountInfoBusy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
            ) : (
              <Download className="h-4 w-4 text-gray-400" />
            )}
          </button>
          {accountInfoRequested && (
            <p className="text-xs text-primary-green py-2">Your account info was downloaded as a JSON file ✓. It includes your profile, settings and chat list (not message contents).</p>
          )}
          <button className="w-full text-left py-3 text-danger-red font-medium hover:opacity-80 active:opacity-60" onClick={() => setShowDeleteAccount(true)}>
            Delete my account
          </button>
        </div>

        {/* Phase 4: multiple accounts (max 3, this device only). Switching signs
            out of the live Cognito session — the password must be re-entered on
            the login screen. No passwords or tokens are stored for saved accounts. */}
        <div className="mt-8">
          <h3 className="text-base font-medium mb-1">Switch account</h3>
          <p className="text-xs text-gray-500 dark:text-text-secondary mb-3">
            Up to {MAX_SAVED_ACCOUNTS} accounts on this device. Switching signs you out. You&apos;ll re-enter that account&apos;s password.
          </p>
          <div className="space-y-2">
            {savedAccounts.filter((a) => a.uid !== currentUser?.uid).map((a) => (
              <div key={a.uid} className="flex items-center gap-3 py-2 border-b border-gray-200 dark:border-white/5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-text-primary truncate">{a.displayName}</p>
                  <p className="text-xs text-gray-500 dark:text-text-secondary truncate">{a.email || a.username || a.uid}</p>
                </div>
                <button
                  onClick={() => handleSwitchAccount(a.uid)}
                  disabled={!!switchingUid}
                  className="px-3 py-1.5 rounded-full bg-green-cta text-white text-xs font-bold disabled:opacity-50"
                >
                  {switchingUid === a.uid ? 'Switching…' : 'Switch'}
                </button>
                <button onClick={() => handleRemoveAccount(a.uid)} className="p-2 rounded-full text-gray-400 hover:text-danger-red" aria-label={`Remove ${a.displayName} from this device`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            {savedAccounts.filter((a) => a.uid !== currentUser?.uid).length === 0 && (
              <p className="text-xs text-gray-500 dark:text-text-secondary py-1">No other saved accounts yet.</p>
            )}
          </div>
          <button
            onClick={handleAddAccount}
            className="mt-3 w-full py-2.5 bg-primary-green/10 border border-primary-green/30 text-primary-green rounded-xl font-medium hover:bg-primary-green/20 transition-colors flex items-center justify-center gap-2"
          >
            <UserPlus className="h-4 w-4" /> Add another account
          </button>
        </div>
      </div>
    </div>
  );

  const renderPrivacyScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6">
        <h2 className="text-lg font-medium mb-4">Privacy Settings</h2>
        <div className="space-y-6">
          {/* Wave-2 C1 (audit Settings #1): dark mode no longer lives in
              Privacy — it is under Appearance → App theme (Light / Dark /
              System default, ChatThemePicker), matching WA. */}
          {/* Wave-2 C1 (audit Settings #1): row order matches WA
              Privacy bundle order — Last seen · Profile photo ·
              About · Status · Read receipts · Link previews ·
              Block unknown · Disappearing · Groups · Calls ·
              Blocked contacts · App lock. */}
          {/* Phase 4: last-seen + profile-photo privacy (client-side only —
              server-side enforcement still needs a backend; see PATCH notes). */}
          <PrivacyPicker
            title="Last seen and online"
            subtitle="Who can see when you were last online"
            value={lastSeenPrivacy}
            onChange={(v) => handlePrivacyChange('lastSeenPrivacy', v)}
          />
          {/* WA parity (audit e #20): separate online-visibility control
              under Last seen — Everyone, or Same as last seen. */}
          <div className="py-2 border-b border-gray-200 dark:border-white/5">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Who can see when I&apos;m online</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-2">“Same as last seen” hides your online status from everyone who can&apos;t see your last seen.</p>
            <div className="flex gap-2">
              {([
                { value: 'everyone', label: 'Everyone' },
                { value: 'same-as-last-seen', label: 'Same as last seen' },
              ] as { value: OnlinePrivacy; label: string }[]).map((o) => (
                <button
                  key={o.value}
                  aria-pressed={onlinePrivacy === o.value}
                  onClick={() => handleOnlinePrivacyChange(o.value)}
                  className={`flex-1 py-1.5 rounded-full border text-xs font-semibold transition-colors ${onlinePrivacy === o.value ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <PrivacyPicker
            title="Profile photo"
            subtitle="Who can see your profile photo (others see your initials)"
            value={photoPrivacy}
            onChange={(v) => handlePrivacyChange('profilePhotoPrivacy', v)}
          />
          {/* Theme fix: About + Status audience + default disappearing timer. */}
          <PrivacyPicker
            title="About"
            subtitle="Who can see your About text"
            value={aboutPrivacy}
            onChange={(v) => handlePrivacyChange('aboutPrivacy', v)}
          />
          {/* WA parity (audit e #23): Status default audience, incl.
              "Everyone except…" (except-list picked in Status → Status
              privacy) and "Only share with…" (allow-list picked below,
              same list the per-status sheet edits). */}
          <StatusPrivacyPicker
            value={statusDefault}
            onChange={handleStatusDefaultChange}
            allow={statusAllow}
            contacts={statusAllowContacts}
            onAllowToggle={handleStatusAllowToggle}
          />
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Read receipts</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">If turned off, you won&apos;t send or receive read receipts. Read receipts are always sent for group chats.</p>
            </div>
            <ToggleSwitch checked={readReceipts} onChange={() => toggleSetting('readReceipts', readReceipts)} label="Read receipts" />
          </div>
          {/* WA parity (audit e #31/#30): link previews + unknown senders. */}
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Turn off link previews</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Links in messages won&apos;t show a preview card.</p>
            </div>
            <ToggleSwitch checked={!linkPreviewsOn} onChange={(v) => handleLinkPreviewsChange(!v)} label="Turn off link previews" />
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Block unknown account messages</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">People who aren&apos;t in your contacts and have never chatted with you won&apos;t send you notifications. Their messages still appear in your chat list — full blocking needs the server.</p>
            </div>
            <ToggleSwitch checked={blockUnknownOn} onChange={handleBlockUnknownChange} label="Block unknown account messages" />
          </div>
          <div className="py-2 border-b border-gray-200 dark:border-white/5">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Default disappearing messages</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-2">New chats start with this timer. Messages older than the timer are hidden (client-side only — see note below).</p>
            <div className="flex gap-2">
              {[
                { seconds: 0, label: 'Off' },
                { seconds: 86400, label: '24 hours' },
                { seconds: 604800, label: '7 days' },
                { seconds: 7776000, label: '90 days' },
              ].map((o) => (
                <button
                  key={o.seconds}
                  aria-pressed={defaultDisappearing === o.seconds}
                  onClick={() => handleDefaultDisappearingChange(o.seconds)}
                  className={`flex-1 py-1.5 rounded-full border text-xs font-semibold transition-colors ${defaultDisappearing === o.seconds ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {/* WA parity (audit e #25): who can add me to groups. Enforced
              client-side when a group admin adds members. */}
          <PrivacyPicker
            title="Groups"
            subtitle="Who can add me to groups"
            value={groupsPrivacy}
            options={[
              { value: 'everyone', label: 'Everyone' },
              { value: 'contacts', label: 'My contacts' },
            ]}
            onChange={(v) => handleGroupsPrivacyChange(v as GroupsPrivacy)}
          />
          {/* REPORT-3 #66/#242: call prefs — previously service-only with
              zero UI callers, so DND / silence-unknown could never be
              turned on. Per-device (this phone only). */}
          <div className="py-2 border-b border-gray-200 dark:border-white/5">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Calls</h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-2">Silenced calls don&apos;t ring. They are logged as missed on this device.</p>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Do Not Disturb</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">Incoming calls never ring or show the incoming screen.</p>
              </div>
              <ToggleSwitch checked={callPrefs.doNotDisturb} onChange={(v) => handleCallPrefsChange({ doNotDisturb: v })} label="Do Not Disturb for calls" />
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Silence unknown callers</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">Only saved contacts and people you&apos;ve chatted or called with ring.</p>
              </div>
              <ToggleSwitch checked={callPrefs.silenceUnknownCallers} onChange={(v) => handleCallPrefsChange({ silenceUnknownCallers: v })} label="Silence unknown callers" />
            </div>
            {/* WA audit #41 — "Protect IP address in calls": relay-only
                ICE (TURN) so the other side never sees your IP in a
                peer candidate. WA's honest copy: this will reduce call
                quality. Per-device, like the other call prefs. */}
            <div className="flex items-center justify-between py-2">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Protect IP address in calls</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">Calls are relayed through the server so it&apos;s harder to infer your location. This will reduce call quality.</p>
              </div>
              <ToggleSwitch checked={callPrefs.protectIpAddress} onChange={(v) => handleCallPrefsChange({ protectIpAddress: v })} label="Protect IP address in calls" />
            </div>
            {/* WA72 calls row 75: ringtone + vibrate moved to Settings →
                Notifications → Call notifications (WA placement). DND /
                silence-unknown / Protect-IP stay here — WA puts
                silence-unknown under Privacy too. */}
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5 cursor-pointer" onClick={() => setActiveTab('blocked')} role="button" tabIndex={0} onKeyDown={(e) => onRowKeyDown(e, () => setActiveTab('blocked'))}>
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Blocked contacts</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">{blockedUsersCount} contacts</p>
            </div>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </div>
          <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
            &ldquo;Contacts&rdquo; means the people in your saved contacts (Contacts tab) and anyone
            you&apos;ve chatted with. Privacy is enforced in this app&apos;s screens only.
            Anyone using a modified client or direct database access can still read your
            last-seen time, online status and photo, and can still add you to a group —
            real enforcement needs server-side rules.
          </p>
          {/* Phase 4: app lock */}
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5 cursor-pointer focus:outline-none focus-visible:bg-gray-50 dark:focus-visible:bg-panel-dark/50" onClick={() => { setAppLockOn(isAppLockEnabled()); setActiveTab('applock'); }} role="button" tabIndex={0} onKeyDown={(e) => onRowKeyDown(e, () => { setAppLockOn(isAppLockEnabled()); setActiveTab('applock'); })}>
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">App lock</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">{appLockOn ? 'On. PIN / fingerprint required at startup' : 'Off. Lock the whole app with a PIN'}</p>
            </div>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </div>
        </div>
      </div>
    </div>
  );

  const renderNotificationsScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6">
        <h2 className="text-lg font-medium mb-4">Message Notifications</h2>
        <div className="space-y-6">
          {/* Wave-2 C1 (audit Settings #1): row order matches WA
              Notifications bundle order — Message notifications ·
              Show previews · tones · quiet hours; DT extras
              (browser permission / push token / test) last. */}
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Show notifications</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Receive push notifications for new messages.</p>
            </div>
            <ToggleSwitch checked={notificationsEnabled} onChange={() => toggleSetting('notificationsEnabled', notificationsEnabled)} label="Show notifications" />
          </div>
          <div className="border-t border-gray-200 dark:border-white/5 pt-4 space-y-3">
          {/* WA-verify-5 #55: WhatsApp's separate "Show notifications for
              incoming calls" toggle — DT used to gate messages and calls
              together. Off silences incoming/missed-call banners only;
              the live call ring is governed by the call ringtone/vibrate
              prefs, and closed-app delivery still needs the server sender. */}
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Call notifications</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Show notifications for incoming calls.</p>
            </div>
            <ToggleSwitch checked={notifPrefs.callNotifications} onChange={(v) => handleNotifPrefsChange({ callNotifications: v })} label="Call notifications" />
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Vibrate</h3>
              <div className="flex gap-2 mt-2">
                {(['off', 'default', 'short', 'long'] as VibrateMode[]).map((m) => (
                  <button key={m} onClick={() => handleNotifPrefsChange({ vibrate: m })} aria-pressed={notifPrefs.vibrate === m} className={`flex-1 py-1.5 rounded-full border text-xs font-semibold capitalize transition-colors ${notifPrefs.vibrate === m ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Popup notification</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-2">Show a banner when a message arrives while you&apos;re using the app. &ldquo;Off&rdquo; plays the tone only. &ldquo;Screen off&rdquo; shows the banner only when the app is in the background.</p>
              <div className="flex gap-2">
                {(['off', 'screen-off', 'always'] as PopupMode[]).map((m) => (
                  <button key={m} onClick={() => handleNotifPrefsChange({ popup: m })} aria-pressed={notifPrefs.popup === m} className={`flex-1 py-1.5 rounded-full border text-xs font-semibold transition-colors ${notifPrefs.popup === m ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}>
                    {m === 'off' ? 'Off' : m === 'screen-off' ? 'Screen off' : 'Always'}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Show preview</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Show the message text in notifications. Off shows only &ldquo;New message&rdquo;.</p>
              </div>
              <ToggleSwitch checked={notifPrefs.showPreview} onChange={(v) => handleNotifPrefsChange({ showPreview: v })} label="Show preview" />
            </div>
          </div>
          </div>
          {/* Phase 4: notification tones (WebAudio beeps, preview on tap). */}
          <div className="border-t border-gray-200 dark:border-white/5 pt-4">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary flex items-center gap-2">
              <Volume2 className="h-4 w-4" /> Notification tone
            </h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1 mb-3">Tap a tone to preview it. The tone plays for in-app notifications.</p>
            <div className="space-y-2">
              {NOTIFICATION_TONES.map((tone) => (
                <button
                  key={tone.id}
                  onClick={() => handleToneChange(tone.id)}
                  aria-pressed={notifTone === tone.id}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${notifTone === tone.id ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
                >
                  <span>{tone.label}{notifTone === tone.id ? ' ✓' : ''}</span>
                  <Volume2 className="h-4 w-4 opacity-60" />
                </button>
              ))}
            </div>
          </div>
          {/* Theme fix: group tone, vibrate, popup, preview — WhatsApp parity. */}
          <div className="border-t border-gray-200 dark:border-white/5 pt-4">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary flex items-center gap-2">
              <Volume2 className="h-4 w-4" /> Group notification tone
            </h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1 mb-3">Tap a tone to preview it. Group messages play this tone instead of the message tone.</p>
            <div className="space-y-2">
              {NOTIFICATION_TONES.map((tone) => (
                <button
                  key={tone.id}
                  onClick={() => handleGroupToneChange(tone.id)}
                  aria-pressed={groupTone === tone.id}
                  className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${groupTone === tone.id ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
                >
                  <span>{tone.label}{groupTone === tone.id ? ' ✓' : ''}</span>
                  <Volume2 className="h-4 w-4 opacity-60" />
                </button>
              ))}
            </div>
          </div>
          {/* WA72 calls row 75 (WA parity): call ringtone + vibrate live
              under Notifications → Call notifications in WA; they used to
              sit under Privacy → Calls. Same tone list and tap-to-preview
              pattern as the message tone picker; the outgoing dial tone
              is unchanged (picker is incoming only). */}
          <div className="border-t border-gray-200 dark:border-white/5 pt-4">
            <h3 className="text-base font-medium text-gray-900 dark:text-text-primary flex items-center gap-2">
              <Volume2 className="h-4 w-4" /> Call notifications
            </h3>
            <p className="text-xs text-gray-500 dark:text-text-secondary mt-1 mb-3">Tap a tone to preview it. Incoming calls ring with this tone.</p>
            <div className="space-y-2">
              {NOTIFICATION_TONES.map((tone) => (
                <button
                  key={tone.id}
                  onClick={() => handleCallRingtoneChange(tone.id)}
                  aria-pressed={callPrefs.ringtone === tone.id}
                  aria-label={`Call ringtone ${tone.label}`}
                  className={`w-full flex items-center justify-between px-4 py-2 rounded-xl border text-sm font-medium transition-colors ${callPrefs.ringtone === tone.id ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
                >
                  <span>{tone.label}{callPrefs.ringtone === tone.id ? ' ✓' : ''}</span>
                  <Volume2 className="h-4 w-4 opacity-60" />
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between py-2 mt-2">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Vibrate on incoming calls</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">Buzz the phone while an incoming call rings.</p>
              </div>
              <ToggleSwitch checked={callPrefs.vibrate} onChange={(v) => handleCallPrefsChange({ vibrate: v })} label="Vibrate on incoming calls" />
            </div>
          </div>
          {/* REPORT-3 #65 (W20): quiet hours — silence tones + vibration on
              a schedule. The banner still shows, so nothing is lost. */}
          <div className="border-t border-gray-200 dark:border-white/5 pt-4">
            <div className="flex items-center justify-between py-2">
              <div>
                <h3 className="text-base font-medium text-gray-900 dark:text-text-primary flex items-center gap-2">
                  <Moon className="h-4 w-4" /> Quiet hours
                </h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Silence message tones and vibration at night. Notifications still appear silently.</p>
              </div>
              <ToggleSwitch checked={quietHours.enabled} onChange={(v) => handleQuietHoursChange({ enabled: v })} label="Quiet hours" />
            </div>
            {quietHours.enabled && (
              <div className="mt-2 space-y-3">
                <div className="flex items-center gap-3">
                  <label className="flex-1">
                    <span className="text-xs font-medium text-gray-500 dark:text-text-secondary">From</span>
                    <input
                      type="time"
                      aria-label="Quiet hours start time"
                      value={quietHours.start}
                      onChange={(e) => handleQuietHoursChange({ start: e.target.value })}
                      className="mt-1 w-full rounded-xl border border-gray-200 dark:border-white/10 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-text-primary outline-none"
                    />
                  </label>
                  <label className="flex-1">
                    <span className="text-xs font-medium text-gray-500 dark:text-text-secondary">To</span>
                    <input
                      type="time"
                      aria-label="Quiet hours end time"
                      value={quietHours.end}
                      onChange={(e) => handleQuietHoursChange({ end: e.target.value })}
                      className="mt-1 w-full rounded-xl border border-gray-200 dark:border-white/10 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-text-primary outline-none"
                    />
                  </label>
                </div>
                <p className="text-xs text-gray-500 dark:text-text-secondary" role="status">
                  {isQuietHoursActive()
                    ? `Quiet hours are on now — tones and vibration are silenced until ${quietHours.end}.`
                    : `Quiet hours ${quietHours.start}–${quietHours.end}. Overnight ranges work (e.g. 22:00–08:00).`}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Browser permission</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">
                {!isWebNotificationSupported()
                  ? 'System notifications are not supported in this browser.'
                  : notifPermission === 'granted'
                    ? 'Allowed — you will get a system notification when the tab is in the background.'
                    : notifPermission === 'denied'
                      ? 'Blocked — allow notifications in your browser site settings to turn them on.'
                      : 'Not asked yet — tap Enable to allow them.'}
              </p>
            </div>
            {isWebNotificationSupported() && notifPermission !== 'granted' && (
              <button onClick={handleEnableNotifications} className="rounded-full bg-green-cta px-3 py-1.5 text-xs font-bold text-white hover:bg-dark-green">
                Enable
              </button>
            )}
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-white/5">
            <div>
              <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Device push token</h3>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">
                {pushTokenSaved
                  ? 'Saved — this device can receive pushes when the app is closed (once server delivery is set up).'
                  : 'Not registered — on the Android app, install the optional push plugin (see below). On web, background delivery needs Firebase Cloud Messaging setup.'}
              </p>
            </div>
            {/* WA parity (audit e #53): incoming/outgoing message sounds.
                Off silences the tone; the banner still appears. */}
            <div className="flex items-center justify-between py-2">
              <div>
                <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Play sounds for incoming messages</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Play the message tone when a message arrives.</p>
              </div>
              <ToggleSwitch checked={notifPrefs.incomingSound} onChange={(v) => handleNotifPrefsChange({ incomingSound: v })} label="Play sounds for incoming messages" />
            </div>
            <div className="flex items-center justify-between py-2">
              <div>
                <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Play sounds for outgoing messages</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Play a short sound when you send a message.</p>
              </div>
              <ToggleSwitch checked={notifPrefs.outgoingSound} onChange={(v) => handleNotifPrefsChange({ outgoingSound: v })} label="Play sounds for outgoing messages" />
            </div>
            {/* WA parity (audit e #59): reaction notifications — off means
                a reaction on your message never banners or buzzes. */}
            <div className="flex items-center justify-between py-2">
              <div>
                <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Show reaction notifications</h3>
                <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">Notify me when someone reacts to my messages.</p>
              </div>
              <ToggleSwitch checked={notifPrefs.showReactionNotifications} onChange={(v) => handleNotifPrefsChange({ showReactionNotifications: v })} label="Show reaction notifications" />
            </div>
          </div>
          <button
            onClick={handleTestNotification}
            className="w-full py-2.5 bg-primary-green/10 border border-primary-green/30 text-primary-green rounded-lg font-medium hover:bg-primary-green/20 transition-colors flex items-center justify-center gap-2"
          >
            <Bell className="h-4 w-4" /> Send a test notification
          </button>
          {testNote && (
            <p role="status" className="text-xs text-amber-600 dark:text-amber-400 mt-2 leading-relaxed">{testNote}</p>
          )}
          <p className="text-xs text-gray-500 dark:text-text-secondary leading-relaxed">
            Notifications work while the app is open. Receiving them while the app is fully closed needs
            server-side delivery (Firebase Cloud Messaging / AWS SNS) — not yet configured for this project.
          </p>
        </div>
      </div>
    </div>
  );

  // ── Theme fix: Default chat theme — full WhatsApp-style customiser ─────
  // ChatThemePicker owns the 15 presets + Custom colours + wallpaper +
  // brightness + live preview. onSave applies + persists via chatTheme.ts.
  const handleThemeSave = (state: ChatThemeState) => {
    saveChatThemeState(state);
    setAppliedTheme(resolveTheme(state).name);
    showToastMsg(`Theme applied: ${resolveTheme(state).name} ✓`);
  };

  const handleAppThemeChange = async (mode: AppThemeMode) => {
    applyAppTheme(mode);
    setDarkMode(effectiveDark(mode));
    if (currentUser) {
      try {
        await updateDoc(doc(db, 'users', currentUser.uid), { darkMode: effectiveDark(mode) });
      } catch (err) {
        console.warn("[SettingsScreen] handleAppThemeChange: await updateDoc(doc(db, 'users', curre...", err);
      }
    }
  };

  const renderThemeScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <ChatThemePicker
        mode="global"
        onSaveGlobal={handleThemeSave}
        onAppThemeChange={handleAppThemeChange}
        onClose={() => setActiveTab('main')}
      />
    </div>
  );

  // ── Theme fix: Settings > Chats (WhatsApp Web parity) ───────────────────
  const renderChatsScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6 space-y-6">
        <div>
          <h2 className="text-lg font-medium mb-1 flex items-center gap-2"><MessageSquare className="h-5 w-5" /> Chats</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary">Chat theme, media and message settings.</p>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-500 dark:text-text-secondary mb-2">Media</h3>
          <div className="bg-white dark:bg-panel-dark rounded-xl border border-gray-100 dark:border-white/5 overflow-hidden">
            {/* Wave-2 C1 (audit Settings #1): WA Chats bundle order —
                Media auto-download · Media upload quality ·
                Auto-download quality. */}
            <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3">
              <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Media auto-download</p>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">Choose when media downloads automatically: on Wi-Fi, on mobile data, or never.</p>
              <div className="space-y-2 mt-2">
                {(['photos', 'videos', 'audio', 'documents'] as const).map((kind) => (
                  <div key={kind} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-700 dark:text-text-primary capitalize">{kind}</span>
                    <div className="flex gap-1.5">
                      {(['wifi', 'always', 'never'] as AutoDownloadMode[]).map((m) => (
                        <button key={m} onClick={() => handleDataUsageChange(kind, m)} aria-pressed={dataUsage[kind] === m} className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${dataUsage[kind] === m ? 'bg-green-cta text-white' : 'bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary'}`}>
                          {m === 'wifi' ? 'Wi-Fi' : m === 'always' ? 'Mobile data' : 'Never'}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Media upload quality</p>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">Photos are compressed before upload. Best quality keeps more detail; Data saver uses less data.</p>
              <div className="flex gap-2 mt-2">
                {(['auto', 'best', 'data-saver'] as MediaUploadQuality[]).map((q) => (
                  <button key={q} onClick={() => handleUploadQualityChange(q)} aria-pressed={uploadQuality === q} className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${uploadQuality === q ? 'bg-green-cta text-white' : 'bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary'}`}>
                    {q === 'auto' ? 'Auto' : q === 'best' ? 'Best quality' : 'Data saver'}
                  </button>
                ))}
              </div>
            </div>
            {/* Wave-2 Media A12: per-type HD auto-download, WA's exact copy
                for each combination. HD downloads the original file,
                Standard the compressed variant. */}
            <div className="border-t border-gray-100 dark:border-white/5 px-4 py-3">
              <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Auto-download quality</p>
              <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5">
                {hdAutoDownload.photos && hdAutoDownload.videos
                  ? 'Photos and videos will be automatically downloaded in HD quality.'
                  : hdAutoDownload.photos
                    ? 'Photos will be automatically downloaded in HD quality, but videos will not.'
                    : hdAutoDownload.videos
                      ? 'Videos will be automatically downloaded in HD quality, but photos will not.'
                      : 'You can choose which photos or videos to download in HD quality.'}
              </p>
              <div className="space-y-2 mt-2">
                {(['photos', 'videos'] as const).map((kind) => (
                  <div key={kind} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-700 dark:text-text-primary capitalize">{kind}</span>
                    <div className="flex gap-2">
                      {([
                        { value: false, label: 'Standard quality' },
                        { value: true, label: 'HD quality' },
                      ] as { value: boolean; label: string }[]).map((o) => (
                        <button key={o.label} onClick={() => handleHdAutoDownloadChange(kind, o.value)} aria-pressed={hdAutoDownload[kind] === o.value} className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${hdAutoDownload[kind] === o.value ? 'bg-green-cta text-white' : 'bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary'}`}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-gray-500 dark:text-text-secondary mb-2">Messages</h3>
          <div className="bg-white dark:bg-panel-dark rounded-xl border border-gray-100 dark:border-white/5 divide-y divide-gray-100 dark:divide-white/5">
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Spell check</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Underline misspelled words while typing</p>
              </div>
              <ToggleSwitch checked={spellCheckOn} onChange={handleSpellCheckChange} label="Spell check" />
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Replace text with emoji</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Emoji will replace specific text as you type</p>
              </div>
              <ToggleSwitch checked={replaceEmojiOn} onChange={handleReplaceEmojiChange} label="Replace text with emoji" />
            </div>
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Enter is send</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Pressing Enter sends the message. When off, Enter adds a new line</p>
              </div>
              <ToggleSwitch checked={enterIsSendOn} onChange={handleEnterIsSendChange} label="Enter is send" />
            </div>
            {/* WA parity (audit e #48): keep chats archived. */}
            <div className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-sm font-medium text-gray-900 dark:text-text-primary">Keep chats archived</p>
                <p className="text-xs text-gray-500 dark:text-text-secondary">Archived chats stay in the Archived view even when new messages arrive. When off, an archived chat with unread messages comes back to the main list.</p>
              </div>
              <ToggleSwitch checked={keepArchivedOn} onChange={handleKeepArchivedChange} label="Keep chats archived" />
            </div>
          </div>
        </div>

        {/* ROADMAP-2 item 3 (Worker R1C): encrypted chat backup & restore. */}
        <ChatBackupPanel />
      </div>
    </div>
  );

  // Phase 4: display, language & data usage.
  const renderDisplayScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6 space-y-6">
        <div>
          <h2 className="text-lg font-medium mb-1 flex items-center gap-2"><Type className="h-5 w-5" /> Font size</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">Applies app-wide immediately.</p>
          <div className="flex gap-2">
            {(['small', 'medium', 'large'] as FontSize[]).map((s) => (
              <button
                key={s}
                onClick={() => handleFontSizeChange(s)}
                aria-pressed={fontSize === s}
                className={`flex-1 py-2.5 rounded-xl border text-sm font-medium capitalize transition-colors ${fontSize === s ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
              >
                {/* REPORT-3 #73: label text itself is capitalised, not
                    just CSS-capitalised — DOM text and screen readers
                    both read "Small / Medium / Large". */}
                {s.charAt(0).toUpperCase() + s.slice(1)}{fontSize === s ? ' ✓' : ''}
              </button>
            ))}
          </div>
          {/* REPORT-3 #75: live preview — a sample message at the picked
              size (px map mirrors appSettings FONT_PX: 14 / 16 / 18). */}
          <div className="mt-3 rounded-xl bg-gray-50 dark:bg-input-dark px-4 py-3">
            <p className="text-[11px] text-gray-500 dark:text-text-secondary mb-2">Preview</p>
            <p style={{ fontSize: `${{ small: 14, medium: 16, large: 18 }[fontSize]}px` }} className="text-gray-900 dark:text-text-primary leading-snug">
              Hey! Kaise ho? 👋 This is how your messages will look.
            </p>
          </div>
        </div>
        <div className="border-t border-gray-200 dark:border-white/5 pt-4">
          <h2 className="text-lg font-medium mb-1 flex items-center gap-2"><Languages className="h-5 w-5" /> Language</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">Main screens (navigation, Chats, Calls, Updates, Communities, Settings) switch language. Detail screens, toasts and message text stay in English for now.</p>
          <div className="space-y-2">
            {SUPPORTED_LANGUAGES.map((l) => (
              <button
                key={l.code}
                onClick={() => handleLanguageChange(l.code)}
                aria-pressed={language === l.code}
                className={`w-full text-left px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${language === l.code ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-700 dark:text-text-primary'}`}
              >
                {l.label}{language === l.code ? ' ✓' : ''}
              </button>
            ))}
          </div>
        </div>
        {/* S8 (100-more): the duplicate auto-download UI lived here (Photos/
            Videos only, "Wi-Fi only / Always / Never") while the Chats tab
            has the complete one (Photos/Videos/Documents, "Wi-Fi / Mobile
            data / Never"). One UI only — this section is removed; the Chats
            tab is the single place to change auto-download. */}
      </div>
    </div>
  );

  const renderHelpScreen = () => (
    <div className="flex-1 overflow-y-auto">
      <div className="py-4 px-6 space-y-6">
        {/* WA parity (audit e #66): Terms & Privacy row, WhatsApp-style —
            a row linking to the in-app text (scrolls to the section below). */}
        <div>
          <h2 className="text-lg font-medium mb-3">Terms &amp; Privacy Policy</h2>
          <div className="bg-white dark:bg-panel-dark rounded-xl border border-gray-100 dark:border-white/5 divide-y divide-gray-100 dark:divide-white/5">
            <button
              type="button"
              onClick={() => termsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-t-xl"
            >
              <span className="text-base text-gray-900 dark:text-text-primary">Terms of Service</span>
              <ChevronRight className="h-5 w-5 text-gray-400 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => privacyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="flex w-full items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-b-xl"
            >
              <span className="text-base text-gray-900 dark:text-text-primary">Privacy Policy</span>
              <ChevronRight className="h-5 w-5 text-gray-400 shrink-0" />
            </button>
          </div>
        </div>

        {/* WA parity (audit e #64): Help Centre / FAQ — the biggest Help gap.
            Static answers, no backend; "How to delete my account" included. */}
        <div>
          <h2 className="text-lg font-medium mb-1">Help Centre</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">Frequently asked questions</p>
          <div className="space-y-2">
            {[
              {
                q: 'How do I delete my account?',
                a: 'Go to Settings → Account → Delete my account. Type DELETE to confirm and enter your password or PIN. This deletes your account and app data on this device. Chats you sent stay visible to the other person unless you delete them for everyone first.',
              },
              {
                q: 'How do I lock a chat?',
                a: 'Long-press a chat in the list and choose Lock chat, then set a PIN. Locked chats live in the Locked Chats folder, which opens only with your PIN or fingerprint — no preview, no time, no unread count shows.',
              },
              {
                q: 'How do I change my chat wallpaper or theme?',
                a: 'Go to Settings → Appearance. Pick one of the 15 themes or make your own colours, choose a wallpaper (including the WhatsApp doodle wallpapers) and set how bright it looks. You can also set a different theme for one chat from inside that chat.',
              },
              {
                q: 'Why do some messages say "Couldn\'t decrypt"?',
                a: 'Your chats are end-to-end encrypted. If a key has not arrived yet, the message waits — tap "Retry decryption" and it re-requests the key automatically. If the other person reinstalled, they may need to resend the message.',
              },
              {
                q: 'How do I back up my chats?',
                a: 'Go to Settings → Chats → Chat backup. Backups are encrypted on this device; keep the backup file safe — without it, messages cannot be restored.',
              },
              {
                q: 'Why don\'t I get notifications when the app is closed?',
                a: 'Notifications work while the app is open. Receiving them while the app is fully closed needs server-side delivery, which is not set up for this project yet.',
              },
            ].map((item) => (
              <details key={item.q} className="bg-white dark:bg-panel-dark rounded-xl border border-gray-100 dark:border-white/5 px-4 py-3">
                <summary className="text-sm font-medium text-gray-900 dark:text-text-primary cursor-pointer list-none flex items-center justify-between gap-2">
                  {item.q}
                  <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                </summary>
                <p className="text-sm text-gray-600 dark:text-text-secondary leading-relaxed mt-2">{item.a}</p>
              </details>
            ))}
          </div>
        </div>

        {/* Contact Us */}
        <div>
          <h2 className="text-lg font-medium mb-1">Contact Us</h2>
          <p className="text-sm text-gray-500 dark:text-text-secondary mb-3">
            Dev bhai se seedha baat karo — koi bhi problem ho, yahan message karo. 😄
          </p>
          {contactSent ? (
            <div className="rounded-lg bg-primary-green/10 border border-primary-green/30 p-4 text-center">
              <CheckCircle2 className="h-8 w-8 text-primary-green mx-auto mb-2" />
              <p className="text-primary-green font-medium">Message bhej diya! Dev bhai dekh lenge. 🙏</p>
              {/* 100M-D2: the form was one-shot — after one send the success
                  banner stayed (4 s timer) with no way to send another
                  message without leaving/reloading the tab. */}
              <button
                type="button"
                onClick={() => { if (contactSentTimerRef.current) clearTimeout(contactSentTimerRef.current); setContactSent(false); }}
                className="mt-3 px-4 py-2 rounded-full border border-primary-green text-primary-green text-sm font-medium hover:bg-primary-green/10 transition-colors"
              >
                Send another message
              </button>
            </div>
          ) : (
            <div>
              <textarea
                value={contactMsg}
                onChange={(e) => setContactMsg(e.target.value)}
                placeholder="Yahan likho apni problem ya feedback... Dev bhai padh lenge! 😎"
                rows={4}
                maxLength={2000}
                aria-label="Your feedback or problem"
                className="w-full rounded-lg border border-gray-300 dark:border-white/10 bg-gray-50 dark:bg-input-dark px-4 py-3 text-sm text-gray-900 dark:text-text-primary resize-none focus:outline-none focus:ring-2 focus:ring-primary-green"
              />
              {contactError && (
                <p className="text-xs text-danger-red mt-2 bg-danger-red/10 rounded-lg px-3 py-2">{contactError}</p>
              )}
              <button
                onClick={handleContactSubmit}
                disabled={!contactMsg.trim() || contactSending}
                className="mt-2 w-full py-2.5 bg-green-cta text-white rounded-lg font-medium hover:bg-dark-green disabled:opacity-40 transition-colors"
              >
                {contactSending ? 'Sending…' : 'Send to Dev Bhai 🚀'}
              </button>
            </div>
          )}
        </div>

        <div ref={termsRef} className="border-t border-gray-200 dark:border-white/5 pt-4 scroll-mt-4">
          <h2 className="text-lg font-medium mb-3">Terms & Conditions</h2>
          <div className="bg-gray-50 dark:bg-input-dark rounded-xl p-4 text-sm text-gray-700 dark:text-text-secondary space-y-3 leading-relaxed">
            <p className="font-semibold text-gray-900 dark:text-text-primary text-base">Pinglo — Rules of the Game 📜</p>
            <p>🚫 <strong>No Scam, No Backchodi</strong> — Kisi bhi user ke saath fraud, dhoka ya koi bhi illegal cheez mat karo. Aisa kiya toh seedha ban!</p>
            <p>🤝 <strong>Izzat ke saath baat karo</strong> — Har user ke saath respectfully baat karo. Gaali-galoch, harassment, bullying bilkul nahi chalega.</p>
            <p>🛡️ <strong>App ka sahi use karo</strong> — Pinglo sirf legitimate conversations ke liye hai. Illegal content, hate speech, ya kisi ko harm karna strictly banned hai.</p>
            <p>🔐 <strong>Privacy ka dhyan rakho</strong> — Kisi ki personal info bina permission share mat karo. Dusron ki privacy respect karo.</p>
            <p>⚠️ <strong>Spam mat karo</strong> — Mass messaging, fake accounts, ya automated bots use karna mana hai.</p>
            <p>📞 <strong>Problem hai?</strong> — Seedha Dev Bhai ko contact karo — yahan "Contact Us" main message karo ya report karo.</p>
            <p className="text-xs text-gray-400 dark:text-text-secondary pt-2">In rules ko padh liya aur samajh liya means aap agree karte ho. Violations pe account ban ho sakta hai. — Dev Bhai 🙏</p>
          </div>
        </div>

        <div ref={privacyRef} className="border-t border-gray-200 dark:border-white/5 pt-4 scroll-mt-4">
          <h2 className="text-lg font-medium mb-3">Privacy Policy</h2>
          <div className="bg-gray-50 dark:bg-input-dark rounded-xl p-4 text-sm text-gray-700 dark:text-text-secondary space-y-3 leading-relaxed">
            <p className="font-semibold text-gray-900 dark:text-text-primary text-base">Pinglo — Privacy Policy 🔐</p>
            <p><strong>What we collect.</strong> Your account details (name, username, email, profile photo and About text), your messages and media, your contacts list (only to find people you know), and basic usage data (such as message counts for the Network usage screen). We do not collect your precise location unless you choose to share live location in a chat.</p>
            <p><strong>End-to-end encryption.</strong> Your 1-to-1 chats are end-to-end encrypted: only you and the person you are chatting with can read them. Group chats, media files and message metadata (such as timestamps and delivery status) are not end-to-end encrypted yet.</p>
            <p><strong>What we do with your data.</strong> Your data is used only to run Pinglo — delivering messages, calls and notifications, and keeping your account secure. We never sell your personal data, and we never show you ads based on your messages.</p>
            <p><strong>Where your data lives.</strong> Messages and media are stored on Pinglo servers (AWS, ap-southeast-2) and on your device. Backups you create are encrypted on your device before they leave it; only you hold the backup password.</p>
            <p><strong>Who can see your info.</strong> Your last-seen time, profile photo and About text are visible according to your Privacy settings (Everyone / My contacts / Nobody). Locked chats are hidden on your device and never appear in notifications with any preview.</p>
            <p><strong>Notifications.</strong> When notifications are on, a push token may be stored so your device can receive them. Message previews in notifications follow your &ldquo;Show preview&rdquo; setting.</p>
            <p><strong>Deleting your data.</strong> You can delete your account from Settings → Account → Delete my account. Deleting your account removes your profile and messages from our servers; messages already delivered to other people&apos;s devices stay on their devices.</p>
            <p><strong>Children.</strong> Pinglo is not intended for children under 13. If you are under 18, please use Pinglo only with a parent or guardian&apos;s permission.</p>
            <p><strong>Changes.</strong> If this policy changes, we will show the updated version here in Help. Continued use of Pinglo after a change means you accept the new policy.</p>
            <p><strong>Questions?</strong> Contact Dev Bhai from Help → Contact Us, or report a problem from any chat.</p>
            <p className="text-xs text-gray-400 dark:text-text-secondary pt-2">Last updated: November 2026. Pinglo is an independent app and is not affiliated with WhatsApp or Meta. — Dev Bhai 🙏</p>
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-white/5 pt-4">
          <h2 className="text-lg font-medium mb-3">App Info</h2>
          <div className="bg-gray-50 dark:bg-input-dark rounded-xl p-4 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-text-secondary">App Name</span>
              <span className="font-medium text-gray-900 dark:text-text-primary">Pinglo</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-text-secondary">Version</span>
              {/* WA-verify-5 #67: was a hardcoded '1.0.0' literal — now
                  injected from package.json at build time (vite define). */}
              <span className="font-medium text-gray-900 dark:text-text-primary">{__APP_VERSION__}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-text-secondary">Made by</span>
              <span className="font-medium text-primary-green">Dev Bhai 👨‍💻</span>
            </div>
            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-white/10">
              <p className="text-gray-600 dark:text-text-secondary leading-relaxed">
                Kya karega jan ke? 😄 Dev ke bete ne banaya hai ye app — bas samajh jaa! Koi bhi dikkat ho toh Dev Bhai se contact karo, solve ho jaayega. 🔥
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark text-gray-900 dark:text-text-primary">
      {/* Header — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center">
            <button
              onClick={() => activeTab === 'main' ? navigate(-1) : setActiveTab('main')}
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark"
              aria-label={activeTab === 'main' ? 'Back' : 'Back to settings'}
            >
              <ArrowLeft className="h-6 w-6" />
            </button>
            <h1 className="ml-2 text-xl font-medium">
              {activeTab === 'main' ? tr('settings') :
               activeTab === 'account' ? 'Account' :
               activeTab === 'privacy' ? 'Privacy' :
               activeTab === 'notifications' ? 'Notifications' : activeTab === 'theme' ? 'Appearance' : activeTab === 'chats' ? 'Chats' : activeTab === 'display' ? 'Display & Language' : activeTab === 'applock' ? 'App Lock' : 'Help'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {/* Dark mode quick toggle in header */}
            <button onClick={toggleDarkMode} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
              {darkMode ? <Sun className="h-5 w-5 text-yellow-400" /> : <Moon className="h-5 w-5 text-gray-500" />}
            </button>
            {activeTab === 'main' && isEditing && (
              <>
                <button onClick={cancelEditing} className="text-gray-500 dark:text-text-secondary font-medium px-3 py-2">
                  Cancel
                </button>
                <button onClick={handleSaveProfile} className="text-primary-green font-medium px-3 py-2">
                  Save
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* REPORT-3 #71: tab switches slide in from the right (WhatsApp-style)
          instead of an instant cut. key={activeTab} remounts the wrapper
          per tab so the animation replays; 160ms, ease-out, no layout shift. */}
      <style>{`@keyframes settingsTabIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}.settings-tab-enter{animation:settingsTabIn 160ms ease-out}`}</style>
      <div key={activeTab} className="settings-tab-enter flex min-h-0 flex-1 flex-col">
      {activeTab === 'main' ? (
        <div ref={mainScrollRef} className="flex-1 overflow-y-auto">
          {/* Profile Section */}
          <div className="flex flex-col items-center px-4 py-6 border-b border-gray-200 dark:border-white/5">
            <div className="relative mb-4">
              {avatar.startsWith('data:') ? (
                <DefaultAvatar name={displayName || 'User'} seed={currentUser?.uid} size={96} />
              ) : (
                <img src={avatar} alt="Profile" className="h-24 w-24 rounded-full object-cover" referrerPolicy="no-referrer" />
              )}
              <button
                onClick={() => setShowPhotoMenu(true)}
                disabled={uploading}
                className="absolute bottom-0 right-0 p-2.5 bg-green-cta text-white rounded-full shadow-lg hover:bg-dark-green disabled:opacity-50"
                aria-label="Change profile photo"
              >
                <Camera className="h-4 w-4" />
              </button>
              <input type="file" ref={fileInputRef} onChange={handleAvatarUpload} className="hidden" accept="image/*" />
              {uploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                </div>
              )}
            </div>

            {isEditing ? (
              <div className="w-full max-w-sm space-y-4">
                <div>
                  <label className="text-xs text-gray-500 dark:text-text-secondary">Display name</label>
                  <input
                    type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full border-b border-primary-green bg-transparent py-1 outline-none focus:border-header-green text-gray-900 dark:text-text-primary"
                    maxLength={30}
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-text-secondary">Username</label>
                  <div className="flex items-center border-b border-primary-green focus-within:border-header-green py-1">
                    <span className="text-gray-500 dark:text-text-secondary mr-0.5">@</span>
                    <input
                      type="text" value={username} onChange={handleUsernameChange}
                      className="flex-1 bg-transparent outline-none text-gray-900 dark:text-text-primary font-mono"
                      maxLength={30}
                      placeholder="choose a username"
                      autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    />
                  </div>
                  {usernameError ? (
                    <p className="text-xs text-danger-red mt-1">{usernameError}</p>
                  ) : (
                    <p className="text-xs text-gray-500 dark:text-text-secondary mt-1">3–30 characters, letters, numbers, dots and underscores</p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-text-secondary">About</label>
                  <input
                    type="text" value={about} onChange={(e) => setAbout(e.target.value)}
                    className="w-full border-b border-primary-green bg-transparent py-1 outline-none focus:border-header-green text-gray-900 dark:text-text-primary"
                    maxLength={100}
                    placeholder="Share a thought"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-text-secondary">Phone number</label>
                  <p className="text-sm text-gray-500 dark:text-text-secondary py-1">{phone || 'Not added'}</p>
                  <p className="text-xs text-gray-500 dark:text-text-secondary">Phone number can&apos;t be changed here.</p>
                </div>
              </div>
            ) : (
              <div className="w-full flex items-center justify-between px-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-panel-dark/50 focus-visible:bg-gray-100 dark:focus-visible:bg-input-dark py-2 rounded-lg" onClick={startEditing} role="button" tabIndex={0} onKeyDown={(e) => onRowKeyDown(e, startEditing)} aria-label="Edit profile">
                <div className="flex-1 text-center">
                  <h2 className="text-xl font-medium">{displayName || 'Set your name'}</h2>
                  {username && <p className="text-xs text-primary-green font-mono">@{username}</p>}
                  <p className="text-sm text-gray-500 dark:text-text-secondary mt-1">{about || 'Share a thought'}</p>
                  <p className="text-sm text-gray-500 dark:text-text-secondary">{phone || 'No phone number added'}</p>
                </div>
                <Edit2 className="h-5 w-5 text-primary-green" />
              </div>
            )}
          </div>

          {/* Settings Options */}
          <div className="py-2">
            {isAdminUser(currentUser) && (
              <div
                onClick={() => navigate('/admin')}
                className="mx-4 my-3 p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/20 to-emerald-500/20 border border-amber-500/30 flex items-center justify-between cursor-pointer hover:opacity-95 active:scale-[0.99] transition-[opacity,transform] shadow-md"
              >
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl bg-amber-500/25 flex items-center justify-center text-amber-400">
                    <Shield className="h-6 w-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <h3 className="font-bold text-sm text-amber-700 dark:text-amber-300">Admin Command Center</h3>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-700 dark:text-amber-300">Super Admin</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-300">Live conversations, all users, call logs & stats</p>
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              </div>
            )}
            {/* Wave-2 C1 (audit Settings #1): WA main order — Profile ·
                Account · Privacy · Chats · Notifications · Appearance ·
                Help · Log out. DT extras (Vault, Avatar, Storage, Network,
                Proxy, QR, Display & Language, Invite) stay as their own
                "More" group between Appearance and Help. Titles localised
                (Wave-2 C5). */}
            <SettingsItem icon={Key} title={tr('account')} subtitle="Email, username, security notifications" onClick={() => setActiveTab('account')} />
            <SettingsItem icon={Lock} title={tr('privacy')} subtitle="Blocked contacts, read receipts, disappearing messages" onClick={() => setActiveTab('privacy')} />
            <SettingsItem icon={MessageSquare} title={tr('chats')} subtitle="Media, spell check, chat settings" onClick={() => setActiveTab('chats')} />
            <SettingsItem icon={Bell} title={tr('notifications')} subtitle="Messages, groups, sounds" onClick={() => setActiveTab('notifications')} />
            <SettingsItem icon={Palette} title={tr('chatTheme')} subtitle="Chat theme, app theme, wallpaper" onClick={() => setActiveTab('theme')} />
            {/* DT extras — own group, after the WA core sections. */}
            <p className="px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-text-secondary">More</p>
            <SettingsItem icon={LockKeyhole} title={tr('secretVault')} subtitle="PIN-protected private notes" onClick={() => navigate('/vault')} />
            <SettingsItem icon={Smile} title={tr('avatar')} subtitle={loadAvatarTraits() ? 'Edit your avatar stickers' : 'Create your avatar stickers'} onClick={() => setShowAvatarCreator(true)} />
            <SettingsItem icon={HardDrive} title={tr('storageUsage')} subtitle="Photos, videos, files & voice notes" onClick={() => navigate('/settings/storage')} />
            <SettingsItem icon={ArrowUpDown} title={tr('networkUsage')} subtitle="Data sent and received on this device" onClick={() => navigate('/settings/network-usage')} />
            <SettingsItem icon={Globe} title={tr('proxy')} subtitle="Route traffic through a proxy (not active yet)" onClick={() => navigate('/settings/proxy')} />
            <SettingsItem icon={QrCode} title={tr('myQRCode')} subtitle="Let others scan to find you" onClick={() => setShowMyQR(true)} />
            <SettingsItem icon={ScanLine} title={tr('scanQR')} subtitle="Scan someone's Pinglo QR code" onClick={() => setShowScanQR(true)} />
            <SettingsItem icon={Type} title={tr('displayLanguage')} subtitle="Font size, language, data usage" onClick={() => setActiveTab('display')} />
            <div
              className="flex items-center px-4 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-panel-dark/50 focus:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-input-dark"
              onClick={handleInviteFriend}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => onRowKeyDown(e, () => void handleInviteFriend())}
              aria-label="Invite a Friend"
            >
              <Share2 className="h-6 w-6 text-text-secondary flex-shrink-0" />
              <div className="ml-4 flex-1 min-w-0">
                <h3 className="text-[15px] text-gray-900 dark:text-text-primary truncate">{tr('inviteFriend')}</h3>
                {inviteCopied && <p className="text-xs text-primary-green mt-0.5">Link copied to clipboard! ✓</p>}
                {inviteCopyFailed && <p className="text-xs text-danger-red mt-0.5">Couldn't copy the link — please copy it manually: https://dtchats.app</p>}
              </div>
              <ChevronRight className="h-5 w-5 text-gray-400" />
            </div>
            <SettingsItem icon={HelpCircle} title={tr('help')} subtitle="Help Centre, contact us, terms" onClick={() => setActiveTab('help')} />
          </div>

          {/* Logout */}
          <div className="mt-4 border-t border-gray-200 dark:border-white/5 pt-4">
            <button
              onClick={handleLogout}
              className="flex w-full items-center px-4 py-3 text-danger-red hover:bg-gray-50 dark:hover:bg-panel-dark/50"
            >
              <LogOut className="h-6 w-6 mr-4" />
              <span className="text-base font-medium">Log out</span>
            </button>
          </div>
        </div>
      ) : activeTab === 'account' ? renderAccountScreen()
        : activeTab === 'privacy' ? renderPrivacyScreen()
        : activeTab === 'notifications' ? renderNotificationsScreen()
        : activeTab === 'help' ? renderHelpScreen()
        : activeTab === 'display' ? renderDisplayScreen()
        : activeTab === 'applock' ? <AppLockScreen onBack={() => { setAppLockOn(isAppLockEnabled()); setActiveTab('privacy'); }} />
        : activeTab === 'blocked' ? <BlockedContactsScreen onBack={() => setActiveTab('privacy')} />
        : activeTab === 'chats' ? renderChatsScreen()
        : renderThemeScreen()}
      </div>

      {/* Phase 4: My QR code */}
      <QRScannerModal
        open={showScanQR}
        onClose={() => setShowScanQR(false)}
        onScan={(raw) => {
          const link = parseDeepLink(raw);
          setShowScanQR(false);
          if (link) {
            routeDeepLink(link, (path) => navigate(path));
          } else {
            showToastMsg('That QR code is not a Pinglo link.');
          }
        }}
      />

      <QRCodeModal
        open={showMyQR}
        onClose={() => setShowMyQR(false)}
        title="My QR code"
        subtitle={displayName ? `${displayName}${username ? ` (@${username})` : ''}` : undefined}
        value={currentUser ? `pinglo://user/${currentUser.uid}` : 'pinglo://user/unknown'}
      />

      {/* Feature 4c: delete account (confirm -> delete -> result -> sign out) */}
      <DeleteAccountModal open={showDeleteAccount} onClose={() => setShowDeleteAccount(false)} />

      {/* Avatar stickers v1 (nightshift §4): manual trait picker, local-only. */}
      {showAvatarCreator && (
        <AvatarCreator onClose={() => setShowAvatarCreator(false)} onSaved={() => { /* traits persist in localStorage */ }} onUseAsPhoto={handleUseAvatarAsPhoto} />
      )}

      {/* Profile-fix: photo options (WhatsApp-style sheet) */}
      {showPhotoMenu && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-end sm:items-center justify-center p-4" onClick={() => setShowPhotoMenu(false)} role="dialog" aria-modal="true" aria-label="Profile photo options">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-2 shadow-2xl" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => { setShowPhotoMenu(false); fileInputRef.current?.click(); }}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-xl"
            >
              <ImageIcon className="h-5 w-5 text-primary-green" />
              <span className="text-base">Choose from gallery</span>
            </button>
            {/* WA parity (audit e #3): Take photo via the in-app camera.
                No getUserMedia on this browser → fall back to the gallery
                picker instead of a dead button. */}
            <button
              onClick={() => {
                setShowPhotoMenu(false);
                if (navigator.mediaDevices?.getUserMedia) setShowCamera(true);
                else fileInputRef.current?.click();
              }}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-xl"
            >
              <Camera className="h-5 w-5 text-primary-green" />
              <span className="text-base">Take photo</span>
            </button>
            {!avatar.startsWith('data:') && (
              <button
                onClick={() => { setShowPhotoMenu(false); setShowRemovePhotoConfirm(true); }}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-xl text-danger-red"
              >
                <Trash2 className="h-5 w-5" />
                <span className="text-base">Remove photo</span>
              </button>
            )}
            <button
              onClick={() => setShowPhotoMenu(false)}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-panel-dark/50 rounded-xl"
            >
              <span className="text-base text-gray-500 dark:text-text-secondary">Cancel</span>
            </button>
          </div>
        </div>
      )}

      {/* Profile-fix: remove-photo confirm */}
      {showRemovePhotoConfirm && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowRemovePhotoConfirm(false)} role="dialog" aria-modal="true" aria-label="Confirm remove profile photo">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Remove profile photo?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Your photo will be removed and your initials will show instead. You can add a new photo anytime.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowRemovePhotoConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={handleRemovePhoto} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-colors">Remove</button>
            </div>
          </div>
        </div>
      )}

      {/* Profile-fix: photo cropper */}
      {cropSrc && (
        <PhotoCropper src={cropSrc} onCancel={() => setCropSrc(null)} onCrop={handleCropDone} />
      )}

      {/* WA parity (audit e #3): in-app camera for the profile photo.
          Video can't be a profile photo — the modal's video path closes
          with an honest toast instead of a dead end. */}
      <CameraModal
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onPhoto={handleCameraPhoto}
        onVideo={() => { setShowCamera(false); showToastMsg('Videos can\'t be used as a profile photo — take a photo instead.'); }}
        onFallback={() => { setShowCamera(false); fileInputRef.current?.click(); }}
      />

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2.5 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* Logout confirm */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowLogoutConfirm(false)} role="dialog" aria-modal="true" aria-label="Confirm log out">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Log out of Pinglo?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">You&apos;ll need to sign in again to see your chats.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowLogoutConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-colors">Cancel</button>
              <button onClick={confirmLogout} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-colors">Log out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PrivacyPicker({ title, subtitle, value, options, onChange }: { title: string; subtitle: string; value: PrivacyLevel; options?: { value: PrivacyLevel; label: string }[]; onChange: (v: PrivacyLevel) => void }) {
  // REPORT-3 #77: "Contacts" IS offered now — the saved-contacts graph
  // (contacts.ts, users/{uid}.contacts) makes it a real choice, enforced
  // in presence.ts (fail-closed: unknown viewer = hidden). A stored
  // 'contacts' value from older versions now behaves as contacts-only.
  // WA parity (audit e #25): callers may pass a shorter option list
  // (Groups offers Everyone / My contacts only — no Nobody).
  const opts: { value: PrivacyLevel; label: string }[] = options || [
    { value: 'everyone', label: 'Everyone' },
    { value: 'contacts', label: 'Contacts' },
    { value: 'nobody', label: 'Nobody' },
  ];
  return (
    <div className="py-2 border-b border-gray-200 dark:border-white/5">
      <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">{title}</h3>
      <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-2">{subtitle}</p>
      <div className="flex gap-2">
        {opts.map((o) => (
          <button
            key={o.value}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`flex-1 py-1.5 rounded-full border text-xs font-semibold transition-colors ${value === o.value ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** WA parity (audit e #23): Status default audience — the same five
    choices as the per-status sheet (Everyone / Contacts / Everyone
    except… / Only share with… / Only me). 'exclude' means "My contacts
    except…": the except-list is picked in Status → Status privacy.
    'onlyShare' means "Only share with…": the allow-list is picked
    right here, and only those people can see a new status. An empty
    allow-list shares with nobody — fail closed, never fall back to
    everyone. */
function StatusPrivacyPicker({ value, onChange, allow, contacts, onAllowToggle }: {
  value: StatusPrivacyDefault;
  onChange: (v: StatusPrivacyDefault) => void;
  allow: string[];
  contacts: any[];
  onAllowToggle: (uid: string) => void;
}) {
  const options: { value: StatusPrivacyDefault; label: string }[] = [
    { value: 'everyone', label: 'Everyone' },
    { value: 'contacts', label: 'My contacts' },
    { value: 'exclude', label: 'Everyone except…' },
    { value: 'onlyShare', label: 'Only share with…' },
    { value: 'nobody', label: 'Only me' },
  ];
  return (
    <div className="py-2 border-b border-gray-200 dark:border-white/5">
      <h3 className="text-base font-medium text-gray-900 dark:text-text-primary">Status</h3>
      <p className="text-xs text-gray-500 dark:text-text-secondary mt-0.5 mb-2">Default audience for new statuses you post (you can still change it per status). “Everyone except…” hides your status from people you pick in Status → Status privacy. “Only share with…” shows it only to the people you pick below.</p>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={`flex-1 min-w-[40%] py-1.5 rounded-full border text-xs font-semibold transition-colors ${value === o.value ? 'border-primary-green bg-primary-green/10 text-primary-green' : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-text-secondary'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {value === 'onlyShare' && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary mb-2">
            Share with ({allow.length} selected) — only these people can see a status posted to “Only share with…”.
          </p>
          {contacts.length === 0 ? (
            <p className="text-xs text-gray-500 py-2">No contacts to share with yet — add contacts first, then pick them here.</p>
          ) : (
            <div className="max-h-48 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 rounded-xl border border-gray-200 dark:border-white/10">
              {contacts.map(c => {
                const uid = c.uid || c.id;
                const selected = allow.includes(uid);
                const name = c.displayName || c.username || 'User';
                return (
                  <div
                    key={uid}
                    onClick={() => onAllowToggle(uid)}
                    className="flex items-center gap-3 p-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-input-dark/60"
                    role="checkbox"
                    aria-checked={selected}
                    tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAllowToggle(uid); } }}
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
    </div>
  );
}

function SettingsItem({ icon: Icon, title, subtitle, onClick }: { icon: any, title: string, subtitle?: string, onClick: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      className="flex items-center px-4 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-panel-dark/50 focus:outline-none focus-visible:bg-gray-100 dark:focus-visible:bg-input-dark"
    >
      <Icon className="h-6 w-6 text-text-secondary flex-shrink-0" />
      <div className="ml-4 flex-1 min-w-0">
        <h3 className="text-[15px] text-gray-900 dark:text-text-primary truncate">{title}</h3>
        {subtitle && <p className="text-[13px] text-gray-500 dark:text-text-secondary truncate">{subtitle}</p>}
      </div>
      <ChevronRight className="h-5 w-5 text-text-secondary flex-shrink-0" />
    </div>
  );
}
