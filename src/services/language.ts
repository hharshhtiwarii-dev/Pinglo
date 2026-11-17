/**
 * Language framework (Phase 4, Worker C).
 *
 * - Two string tables today: English (`en`, default) and Hindi (`hi`,
 *   Roman + Devanagari mix matching the app's existing Hinglish tone).
 * - `t(key)` reads the persisted choice; `useLanguage()` is a React hook
 *   that re-renders when the language changes (same-tab via a custom
 *   event, cross-tab via the `storage` event).
 * - Cluster C (Item 15b): Hindi now also covers the main strings of
 *   Settings-adjacent items, Chats list, Chat screen chrome, Calls and
 *   Status screens. Anything still untranslated falls back to English
 *   via `t()` — no blank strings, no i18n library, no network fetch,
 *   no fake "auto-translate".
 * - Wave-2 C5 (audit Settings #50): the tables now cover the main
 *   screens in Hindi — Settings rows, Chat list (chips, Archived,
 *   empty states, presence preview), DM header (online / typing /
 *   recording / last-seen via presence.ts), composer placeholder,
 *   Calls (tabs, labels, menu, empty states), Status (Channels
 *   section) and Communities (header, search, directory headings).
 *   Detail screens, toasts and dynamic content (names, bios, message
 *   bodies) stay in English for now — see the Language section copy
 *   in SettingsScreen for the honest scope note.
 * - Persisted in localStorage (`pinglo_language`); defaults to `en`.
 */

import { useEffect, useState } from 'react';

export type LanguageCode = 'en' | 'hi';

const STORAGE_KEY = 'pinglo_language';
const CHANGE_EVENT = 'pinglo:language-changed';

export type TranslationKey =
  | 'chats'
  | 'updates'
  | 'communities'
  | 'calls'
  | 'settings'
  | 'search'
  | 'newChat'
  | 'status'
  | 'cancel'
  | 'save'
  | 'back'
  | 'logout'
  | 'myStatus'
  | 'tapToAddStatus'
  | 'recentUpdates'
  | 'viewedUpdates'
  | 'mutedUpdates'
  | 'statusPrivacy'
  | 'postStatus'
  | 'voiceStatus'
  | 'recentCalls'
  | 'createCallLink'
  | 'scheduledFor'
  | 'scanQR'
  | 'myQRCode'
  | 'message'
  | 'searchChats'
  | 'searchInConversation'
  | 'searchUpdates'
  | 'noRecentUpdates'
  | 'noRecentCalls'
  | 'reply'
  | 'deleteStatus'
  | 'whoViewed'
  | 'allCalls'
  | 'missedCalls'
  | 'camera'
  | 'voiceCall'
  | 'videoCall'
  // Wave-2 C5 — main-screen strings beyond the nav labels.
  | 'archived'
  | 'unread'
  | 'favourites'
  | 'groups'
  | 'folders'
  | 'searchOrStartChat'
  | 'noChatsYet'
  | 'noFilteredChats'
  | 'startChattingHint'
  | 'chatsWillShowHint'
  | 'noMessagesYet'
  | 'online'
  | 'typing'
  | 'recordingAudio'
  | 'searchCalls'
  | 'newCall'
  | 'clearCallHistory'
  | 'shareCallLink'
  | 'startCallHint'
  | 'noMissedCalls'
  | 'voice'
  | 'video'
  | 'missed'
  | 'incoming'
  | 'outgoing'
  | 'couldntConnect'
  | 'noAnswer'
  | 'answeredElsewhere'
  | 'declined'
  | 'busy'
  | 'noFavouritesYet'
  | 'channels'
  | 'findChannels'
  | 'noChannelsYet'
  | 'noMatchingUpdates'
  | 'searchCommunities'
  | 'recommendedChannels'
  | 'allCommunitiesChannels'
  | 'account'
  | 'privacy'
  | 'secretVault'
  | 'notifications'
  | 'displayLanguage'
  | 'storageUsage'
  | 'networkUsage'
  | 'proxy'
  | 'help'
  | 'chatTheme'
  | 'avatar'
  | 'inviteFriend'
  | 'appLock'
  | 'language'
  | 'all';

const STRINGS: Record<LanguageCode, Record<TranslationKey, string>> = {
  en: {
    chats: 'Chats',
    updates: 'Updates',
    communities: 'Communities',
    calls: 'Calls',
    settings: 'Settings',
    search: 'Search',
    newChat: 'New Chat',
    status: 'Status',
    cancel: 'Cancel',
    save: 'Save',
    back: 'Back',
    logout: 'Log out',
    myStatus: 'My status',
    tapToAddStatus: 'Tap to add status update',
    recentUpdates: 'Recent updates',
    viewedUpdates: 'Viewed updates',
    mutedUpdates: 'Muted updates',
    statusPrivacy: 'Status privacy',
    postStatus: 'Post Status',
    voiceStatus: 'Voice status',
    recentCalls: 'Recent',
    createCallLink: 'Create call link',
    scheduledFor: 'Scheduled for',
    scanQR: 'Scan QR code',
    myQRCode: 'My QR code',
    message: 'Message',
    searchChats: 'Search chats',
    searchInConversation: 'Search in conversation...',
    searchUpdates: 'Search updates...',
    noRecentUpdates: 'No recent updates from contacts',
    noRecentCalls: 'No recent calls',
    reply: 'Reply',
    deleteStatus: 'Delete this status update?',
    whoViewed: 'Viewed by',
    allCalls: 'All',
    missedCalls: 'Missed',
    camera: 'Camera',
    voiceCall: 'Voice call',
    videoCall: 'Video call',
    // Wave-2 C5 — main-screen strings beyond the nav labels.
    archived: 'Archived',
    unread: 'Unread',
    favourites: 'Favourites',
    groups: 'Groups',
    folders: 'Folders',
    searchOrStartChat: 'Search or start a new chat',
    noChatsYet: 'No chats yet',
    noFilteredChats: 'No chats match this filter',
    startChattingHint: 'Tap the + button below to find people by username and start chatting.',
    chatsWillShowHint: 'Chats will show up here when they match this filter.',
    noMessagesYet: 'No messages yet',
    online: 'Online',
    typing: 'typing...',
    recordingAudio: 'recording audio',
    searchCalls: 'Search calls...',
    newCall: 'New call',
    clearCallHistory: 'Clear call history',
    shareCallLink: 'Share a link for your Pinglo call',
    startCallHint: 'Start a call from any chat by tapping the phone icon in the header, or tap the phone button below to start a new call.',
    noMissedCalls: 'No missed calls',
    voice: 'Voice',
    video: 'Video',
    missed: 'Missed',
    incoming: 'Incoming',
    outgoing: 'Outgoing',
    couldntConnect: "Couldn't connect",
    noAnswer: 'No answer',
    answeredElsewhere: 'Answered elsewhere',
    declined: 'Declined',
    busy: 'Busy',
    noFavouritesYet: 'No favourites yet — tap the star on any call below to add someone here for quick calling.',
    channels: 'Channels',
    findChannels: 'Find channels',
    noChannelsYet: 'No channels yet. Channels you follow will appear here.',
    noMatchingUpdates: 'No updates match your search',
    searchCommunities: 'Search communities...',
    recommendedChannels: 'Recommended channels',
    allCommunitiesChannels: 'All communities & channels',
    account: 'Account',
    privacy: 'Privacy',
    secretVault: 'Secret Vault',
    notifications: 'Notifications',
    displayLanguage: 'Display & Language',
    storageUsage: 'Storage Usage',
    networkUsage: 'Network Usage',
    proxy: 'Proxy',
    help: 'Help',
    chatTheme: 'Chat Theme',
    avatar: 'Avatar',
    inviteFriend: 'Invite a Friend',
    appLock: 'App Lock',
    language: 'Language',
    all: 'All',
  },
  hi: {
    chats: 'चैट्स',
    updates: 'अपडेट्स',
    communities: 'कम्युनिटी',
    calls: 'कॉल्स',
    settings: 'सेटिंग्स',
    search: 'खोजें',
    newChat: 'नई चैट',
    status: 'स्टेटस',
    cancel: 'रद्द करें',
    save: 'सेव करें',
    back: 'वापस',
    logout: 'लॉग आउट',
    myStatus: 'मेरा स्टेटस',
    tapToAddStatus: 'स्टेटस जोड़ने के लिए टैप करें',
    recentUpdates: 'हाल के अपडेट्स',
    viewedUpdates: 'देखे गए अपडेट्स',
    mutedUpdates: 'म्यूट किए गए अपडेट्स',
    statusPrivacy: 'स्टेटस प्राइवेसी',
    postStatus: 'स्टेटस पोस्ट करें',
    voiceStatus: 'वॉइस स्टेटस',
    recentCalls: 'हाल की',
    createCallLink: 'कॉल लिंक बनाएँ',
    scheduledFor: 'शेड्यूल्ड',
    scanQR: 'QR स्कैन करें',
    myQRCode: 'मेरा QR कोड',
    message: 'मैसेज',
    searchChats: 'चैट्स खोजें',
    searchInConversation: 'इस चैट में खोजें...',
    searchUpdates: 'अपडेट्स खोजें...',
    noRecentUpdates: 'कॉन्टैक्ट्स के कोई हाल के अपडेट नहीं',
    noRecentCalls: 'कोई हाल की कॉल नहीं',
    reply: 'जवाब दें',
    deleteStatus: 'यह स्टेटस डिलीट करें?',
    whoViewed: 'देखा गया',
    allCalls: 'सभी',
    missedCalls: 'मिस्ड',
    camera: 'कैमरा',
    voiceCall: 'वॉइस कॉल',
    videoCall: 'वीडियो कॉल',
    // Wave-2 C5 — main-screen strings beyond the nav labels.
    archived: 'आर्काइव्ड',
    unread: 'अपठित',
    favourites: 'पसंदीदा',
    groups: 'ग्रुप्स',
    folders: 'फ़ोल्डर',
    searchOrStartChat: 'खोजें या नई चैट शुरू करें',
    noChatsYet: 'अभी कोई चैट नहीं',
    noFilteredChats: 'इस फ़िल्टर से कोई चैट नहीं मिली',
    startChattingHint: 'नीचे + बटन पर टैप करके यूज़रनेम से लोगों को खोजें और चैट शुरू करें।',
    chatsWillShowHint: 'इस फ़िल्टर से मेल खाने वाली चैट्स यहाँ दिखेंगी।',
    noMessagesYet: 'अभी कोई मैसेज नहीं',
    online: 'ऑनलाइन',
    typing: 'टाइप कर रहा है...',
    recordingAudio: 'ऑडियो रिकॉर्ड कर रहा है...',
    searchCalls: 'कॉल्स खोजें...',
    newCall: 'नई कॉल',
    clearCallHistory: 'कॉल हिस्ट्री साफ़ करें',
    shareCallLink: 'अपनी Pinglo कॉल के लिए लिंक शेयर करें',
    startCallHint: 'किसी भी चैट के हेडर में फ़ोन आइकन पर टैप करके कॉल शुरू करें, या नीचे फ़ोन बटन से नई कॉल शुरू करें।',
    noMissedCalls: 'कोई मिस्ड कॉल नहीं',
    voice: 'वॉइस',
    video: 'वीडियो',
    missed: 'मिस्ड',
    incoming: 'आने वाली',
    outgoing: 'जाने वाली',
    couldntConnect: 'कनेक्ट नहीं हो पाया',
    noAnswer: 'कोई जवाब नहीं',
    answeredElsewhere: 'दूसरी डिवाइस पर उठाई गई',
    declined: 'अस्वीकार की गई',
    busy: 'व्यस्त',
    noFavouritesYet: 'अभी कोई पसंदीदा नहीं — नीचे किसी कॉल पर स्टार टैप करके यहाँ जोड़ें।',
    channels: 'चैनल्स',
    findChannels: 'चैनल खोजें',
    noChannelsYet: 'अभी कोई चैनल नहीं। आपके फॉलो किए चैनल यहाँ दिखेंगे।',
    noMatchingUpdates: 'आपकी खोज से कोई अपडेट नहीं मिला',
    searchCommunities: 'कम्युनिटी खोजें...',
    recommendedChannels: 'सुझाए गए चैनल',
    allCommunitiesChannels: 'सभी कम्युनिटी और चैनल',
    account: 'अकाउंट',
    privacy: 'प्राइवेसी',
    secretVault: 'सीक्रेट वॉल्ट',
    notifications: 'नोटिफिकेशन',
    displayLanguage: 'डिस्प्ले और भाषा',
    storageUsage: 'स्टोरेज उपयोग',
    networkUsage: 'नेटवर्क उपयोग',
    proxy: 'प्रॉक्सी',
    help: 'मदद',
    chatTheme: 'चैट थीम',
    avatar: 'अवतार',
    inviteFriend: 'दोस्तों को बुलाएँ',
    appLock: 'ऐप लॉक',
    language: 'भाषा',
    all: 'सभी',
  },
};

export const SUPPORTED_LANGUAGES: { code: LanguageCode; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
];

export function getLanguage(): LanguageCode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'hi' || v === 'en') return v;
  } catch { /* intentionally ignored */}
  return 'en';
}

export function setLanguage(code: LanguageCode): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch { /* intentionally ignored */}
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: code }));
  } catch { /* intentionally ignored */}
}

/** Translate a key in the currently selected language (falls back to English). */
export function t(key: TranslationKey): string {
  const lang = getLanguage();
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}

/** React hook: current language + translated strings, re-renders on change. */
export function useLanguage(): { lang: LanguageCode; t: (key: TranslationKey) => string; setLanguage: (c: LanguageCode) => void } {
  const [lang, setLang] = useState<LanguageCode>(() => getLanguage());
  useEffect(() => {
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<LanguageCode>).detail;
      if (next === 'en' || next === 'hi') setLang(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLang(getLanguage());
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return { lang, t: (key: TranslationKey) => STRINGS[lang][key] ?? STRINGS.en[key] ?? key, setLanguage: (c) => { setLanguage(c); setLang(c); } };
}
