import { useState, useEffect, useRef, useMemo, type ChangeEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeft, Trash2, Send, Download, MapPin, User, Search, X, Paperclip, MoreVertical, Mic, Camera, Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, query, orderBy, onSnapshot, addDoc, serverTimestamp, deleteDoc, doc, auth, db } from '../../aws';
import { uploadChatMedia, validateChatMediaFile, isMediaTooLargeError, isLocalMediaUrl, deleteLocalMediaBlob } from '../../aws/storage';
import { isLockedConversation, isLockedPartnerCached, loadHiddenChatIds } from '../../services/lockedChats';
import { getWaveformPeaks } from '../../services/waveform';
import CameraModal from '../../components/CameraModal';
import VoiceNotePlayer from '../../components/VoiceNotePlayer';
import RoundVideoPlayer from '../../components/RoundVideoPlayer';
import LocationMessageCard from '../../components/LocationMessageCard';
import LiveLocationCard from '../../components/LiveLocationCard';
import ContactMessageCard from '../../components/ContactMessageCard';
import LinkPreviewCard from '../../components/LinkPreviewCard';
import MediaLightbox from '../../components/MediaLightbox';
import { saveRemoteFile, fileNameFromUrl } from '../../services/fileSave';
import { formatBytes } from '../../services/storageUsage';
import { getEnterIsSend, getLinkPreviewsEnabled } from '../../services/appSettings';

/** Text labels ChatScreen writes for media messages (no real text) —
// never render these as a message body. Same list as ChatScreen. */
// Legacy emoji-prefixed labels stay: old messages still carry them.
// Plain labels are what ChatScreen writes now (polish/ui-chatscreen).
const MEDIA_LABELS = new Set(['[Media]', '📷 Photo', '📹 Video', '🎵 Audio', '🎥 Round video', '🎬 GIF', 'Photo', 'Video', 'Audio', 'Round video', 'GIF']);

/** A file message's text is its label — legacy `📄 <filename>`,
    new plain `<filename>` (ChatScreen writes the bare name now, with
    `mediaType: 'file'`). Treat it as a media label too, so it never
    leaks as visible text under the file card. Only suppressed when the
    message actually has media (a real typed filename note without a
    file still renders). */
const isMediaLabelText = (text: string, msg: any): boolean =>
  MEDIA_LABELS.has(text) || (!!msg.mediaUrl && (text.startsWith('📄') || msg.mediaType === 'file'));

/** Same regex as ChatScreen's firstUrlInText. */
const firstUrlInText = (text?: string): string | null => {
  if (!text) return null;
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0].replace(/[),.;!?]+$/, '') : null;
};

/** W7 #92: timestamps arrive as Firestore Timestamps, epoch numbers,
    or (pending serverTimestamp) a placeholder — never crash on any. */
const toDateSafe = (ts: any): Date => {
  try {
    if (ts && typeof ts.toDate === 'function') return ts.toDate();
    const d = new Date(ts || Date.now());
    return Number.isNaN(d.getTime()) ? new Date() : d;
  } catch { return new Date(); }
};
const dayKey = (ts: any) => {
  const d = toDateSafe(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
/** Same Today / Yesterday / "12 Nov 2026" labels as ChatScreen's dateLabel. */
const dateLabel = (ts: any): string => {
  const d = toDateSafe(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today)) return 'Today';
  if (dayKey(ts) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

type SavedFilter = 'all' | 'media' | 'links' | 'files' | 'voice';

export default function SavedMessagesScreen() {
  const navigate = useNavigate();
  const currentUser = auth.currentUser;
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [toast, setToast] = useState('');
  const [pendingUnsave, setPendingUnsave] = useState<any | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // W7 #83/#95: search + filter chips over the saved list.
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<SavedFilter>('all');
  // W13 #95: jump to a date (same pattern as ChatScreen's jumpToDate).
  const [jumpDate, setJumpDate] = useState('');
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);
  // W7 #84: fullscreen photo/video viewer (ChatScreen's MediaLightbox).
  const [lightbox, setLightbox] = useState<{ open: boolean; url: string; type: 'image' | 'video'; senderName?: string; time?: string }>({ open: false, url: '', type: 'image' });
  // W7 #91: per-message actions live behind a long-press / right-click
  // (or the ⋯ button) now — the Unsave pill no longer hangs under
  // every bubble. Only the active message shows its action row.
  const [activeMsgId, setActiveMsgId] = useState<string | null>(null);
  const longPressTimer = useRef<any>(null);
  // W7 #94: attach files/photos into Saved (upload via the same S3
  // helper ChatScreen uses).
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [uploadingAttach, setUploadingAttach] = useState(false);
  // W23 #94 (residual): in-app camera — ChatScreen's CameraModal, same
  // viewfinder ChatScreen opens (photo + ≤60s video). No second camera.
  const [showCamera, setShowCamera] = useState(false);
  // W23 #94 (residual): voice-note recording — the SAME recorder path as
  // ChatScreen (ChatScreen.tsx startRecording/stopRecording/cancelRecording
  // + handleMicPointerDown gestures): getUserMedia audio → MediaRecorder
  // → audio/webm blob → uploadChatMedia(file, 'audio') → getWaveformPeaks
  // → saved message. The only difference is the target collection
  // (saved_<uid> instead of the chat) — no second recorder invented.
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const [isLockedRecording, setIsLockedRecording] = useState(false);
  const [voiceGesture, setVoiceGesture] = useState<'idle' | 'recording' | 'lock-armed' | 'cancel-armed'>('idle');
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingSecsRef = useRef(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voiceStartRef = useRef<{ x: number; y: number } | null>(null);
  const voiceDownAtRef = useRef(0);
  const voiceGestureRef = useRef<'idle' | 'recording' | 'lock-armed' | 'cancel-armed'>('idle');
  const isLockedRecordingRef = useRef(false);
  const voiceReleaseRef = useRef<'send' | 'cancel' | null>(null);
  const voiceListenersRef = useRef<{ move: (ev: PointerEvent) => void; up: () => void; cancel: () => void } | null>(null);

  useEffect(() => { isLockedRecordingRef.current = isLockedRecording; }, [isLockedRecording]);

  // Stop the mic + timer if the screen unmounts mid-recording, so a
  // half-held note never keeps the mic open after leaving Saved.
  useEffect(() => {
    return () => {
      try { if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop(); } catch { /* intentionally ignored */}
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (voiceListenersRef.current) {
        window.removeEventListener('pointermove', voiceListenersRef.current.move);
        window.removeEventListener('pointerup', voiceListenersRef.current.up);
        window.removeEventListener('pointercancel', voiceListenersRef.current.cancel);
      }
      mediaRecorderRef.current = null;
    };
  }, []);

  const savedId = currentUser ? `saved_${currentUser.uid}` : null;

  const showToastMsg = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  useEffect(() => {
    if (!savedId) return;
    // 100M-S2: the lock list MUST be loaded before the first snapshot is
    // filtered. The old fire-and-forget `void loadHiddenChatIds(...)`
    // let the snapshot win the race on a slow/loady mount: the first
    // snapshot filtered against an empty cache, the stale (unfiltered)
    // render persisted (cache population sets no React state, and the
    // snapshot only re-fires on doc changes). Awaiting here keeps the
    // loading skeleton up until the locks are known — fail-closed.
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      if (currentUser) await loadHiddenChatIds(currentUser.uid).catch(() => {});
      if (cancelled) return;
      const q = query(collection(db, 'chats', savedId, 'messages'), orderBy('timestamp', 'asc'));
      unsub = onSnapshot(q, snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setMessages(all.filter((m: any) => {
          const origin = String(m.originalChatId || m.chatId || '');
          // 100M-S1: origin is the route param saveMsg stored — a partner
          // uid when the DM was opened normally, but a full conversation
          // id when opened via /chat/<uidA_uidB> (Saved/Starred/Scheduled
          // links, toast taps — the F2 paths). isLockedPartnerCached only
          // matches partner uids, so a conv-id origin missed the lock.
          // isLockedConversation derives the partner from a conv id
          // (partnerIdForConversation + split fallback, same as
          // StarredScreen #236); the direct check stays for plain-uid
          // origins, which that derivation returns null for.
          return !(origin && (isLockedPartnerCached(origin) || isLockedConversation(origin, currentUser?.uid || '')));
        }));
        setLoading(false);
      });
    })();
    return () => { cancelled = true; unsub?.(); };
  }, [savedId]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Escape closes the unsave confirm dialog.
  useEffect(() => {
    if (!pendingUnsave) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPendingUnsave(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingUnsave]);

  // W7 #83/#95: search (text, sender, file/poll/location/contact
  // names) + filter chips, over the already-loaded list — no new query.
  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return messages.filter((m: any) => {
      if (filter === 'media' && !m.mediaUrl) return false;
      if (filter === 'links' && !firstUrlInText(m.text)) return false;
      if (filter === 'files' && m.mediaType !== 'file') return false;
      if (filter === 'voice' && m.mediaType !== 'audio') return false;
      if (!q) return true;
      const hay = [
        m.text, m.originalSenderName, m.originalFrom, m.forwardedFrom,
        m.fileName, m.pollQuestion, m.locationLabel, m.contactName,
        m.contactPhone, m.senderName,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [messages, searchQuery, filter]);

  // W13 #95: jump to a date — finds the first message of the chosen
  // day, scrolls to it and highlights it (same as a search match in
  // ChatScreen). dayKey is NOT zero-padded ("2026-11-4"), so the
  // input's ISO value is converted through dayKey, not compared raw.
  // If a search/filter hides the target day, they are cleared so the
  // message renders; no message on that day -> a toast.
  const jumpToDate = (isoDate: string) => {
    setJumpDate(isoDate);
    if (!isoDate) return;
    const key = dayKey(new Date(`${isoDate}T00:00:00`));
    const target = messages.find((m: any) => dayKey(m.timestamp) === key);
    if (!target) { showToastMsg('No messages on that date'); return; }
    if (!filteredMessages.some((m: any) => m.id === target.id)) {
      setSearchQuery('');
      setFilter('all');
    }
    setHighlightedMsgId(target.id);
    // The scroll must wait a tick: clearing the filter above renders first.
    setTimeout(() => {
      document.getElementById(`saved-msg-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    setTimeout(() => setHighlightedMsgId(null), 1800);
  };

  const handleSend = async () => {
    if (!input.trim() || !savedId || !currentUser) return;
    const txt = input.trim();
    setInput('');
    try {
      await addDoc(collection(db, 'chats', savedId, 'messages'), {
        text: txt,
        senderId: currentUser.uid,
        senderName: 'You',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
      });
    } catch {
      showToastMsg('Could not save that note. Try again.');
      setInput(txt);
    }
  };

  /** W7 #94 (+ W23 camera): save a picked / camera-captured file as a
      Saved message — same upload path as sending media in a chat (S3 via
      uploadChatMedia, same size/type validation). In mock / no-backend
      mode the upload fails honestly with a toast, exactly like a chat
      send would; nothing is ever faked as saved. `durationSecs` is set
      by the in-app camera for recorded videos. */
  const saveMediaFile = async (file: File, durationSecs?: number) => {
    if (!savedId || !currentUser) return;
    const type = file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('video/') ? 'video'
      : file.type.startsWith('audio/') ? 'audio' : 'file';
    try {
      validateChatMediaFile(file, type as any);
    } catch (err: any) {
      showToastMsg(typeof err?.message === 'string' ? err.message : 'That file can’t be saved.');
      return;
    }
    const label = type === 'video' ? '📹 Video' : type === 'audio' ? '🎵 Audio' : type === 'image' ? '📷 Photo' : `📄 ${file.name}`;
    setUploadingAttach(true);
    try {
      const mediaUrl = await uploadChatMedia(file, type as any, false);
      await addDoc(collection(db, 'chats', savedId, 'messages'), {
        text: label,
        senderId: currentUser.uid,
        senderName: 'You',
        senderAvatar: currentUser.photoURL || '',
        timestamp: serverTimestamp(),
        status: 'sent',
        mediaUrl,
        mediaType: type,
        type,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || '',
        originalSenderId: currentUser.uid,
        originalSenderName: 'You',
        ...(durationSecs != null ? { duration: durationSecs } : {}),
      });
      showToastMsg('Saved to Saved Messages 💾');
    } catch (err) {
      console.error('Save attachment failed', err);
      showToastMsg('Could not save that file. Check your connection and try again.');
    } finally {
      setUploadingAttach(false);
    }
  };

  const handleAttach = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await saveMediaFile(file);
  };

  // ── W23 #94: in-app camera (ChatScreen's CameraModal) ──────────────
  // Same open rule as ChatScreen's onOpenCamera: getUserMedia present →
  // viewfinder; otherwise fall back to the file picker. Photos go through
  // the same saveMediaFile upload as a gallery pick (ChatScreen routes
  // camera photos through its photo editor instead — Saved has no editor,
  // so the capture is saved directly); videos likewise.
  const openCamera = () => {
    if (navigator.mediaDevices?.getUserMedia) setShowCamera(true);
    else attachInputRef.current?.click();
  };
  const handleCameraPhoto = async (file: File) => {
    setShowCamera(false);
    await saveMediaFile(file);
  };
  const handleCameraVideo = async (file: File, durationSecs: number) => {
    setShowCamera(false);
    await saveMediaFile(file, durationSecs);
  };

  // ── W23 #94: voice-note recording (ChatScreen's recorder) ───────────
  const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const removeVoiceListeners = () => {
    const l = voiceListenersRef.current;
    if (!l) return;
    window.removeEventListener('pointermove', l.move);
    window.removeEventListener('pointerup', l.up);
    window.removeEventListener('pointercancel', l.cancel);
    voiceListenersRef.current = null;
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mr.ondataavailable = (e) => audioChunksRef.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
        setUploadingVoice(true);
        const finalSecs = recordingSecsRef.current;
        let mediaUrl: string | undefined;
        try {
          mediaUrl = await uploadChatMedia(file, 'audio');
          // Same as ChatScreen: REAL waveform peaks from the recorded blob
          // so VoiceNotePlayer renders the true shape (best-effort).
          const peaks = await getWaveformPeaks(blob);
          if (savedId && currentUser) {
            await addDoc(collection(db, 'chats', savedId, 'messages'), {
              text: `🎙️ Voice message (${finalSecs}s)`,
              senderId: currentUser.uid,
              senderName: 'You',
              senderAvatar: currentUser.photoURL || '',
              timestamp: serverTimestamp(),
              status: 'sent',
              mediaUrl, mediaType: 'audio',
              type: 'audio',
              duration: finalSecs,
              ...(peaks.length ? { waveform: peaks } : {}),
              fileName: file.name, fileSize: file.size, fileType: file.type || '',
              originalSenderId: currentUser.uid,
              originalSenderName: 'You',
            });
            showToastMsg('Saved to Saved Messages 💾');
          }
        } catch (e) {
          // Same as ChatScreen (D3): never fail silently — the user must
          // know the note was not saved. 100M-H6: a too-long recording
          // fails the same way on every retry — say so.
          // The blob was already stored before the doc write — if the
          // write failed, delete it or it stays an unreachable orphan.
          console.warn('[SavedMessages] voice message failed to save:', e);
          if (mediaUrl && isLocalMediaUrl(mediaUrl)) void deleteLocalMediaBlob(mediaUrl);
          showToastMsg(
            isMediaTooLargeError(e)
              ? 'Voice message too long to save. Try a shorter one.'
              : 'Voice message failed to send. Try again.',
          );
        } finally { setUploadingVoice(false); }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setIsRecording(true);
      setRecordingSecs(0);
      recordingSecsRef.current = 0;
      // Same pending-release path as ChatScreen: a fast tap can release
      // before the recorder is up (mic permission prompt) — honour the
      // release that already happened instead of recording forever.
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

  const stopRecording = () => {
    // Guard on the recorder's own state, not the `isRecording` render
    // state — same as ChatScreen: the pending-release path can call this
    // before the state has flushed.
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') {
      mr.stop();
      setIsRecording(false);
      setIsLockedRecording(false);
      setVoiceGesture('idle');
      voiceGestureRef.current = 'idle';
      removeVoiceListeners();
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      try { mediaRecorderRef.current.stop(); } catch (e) { console.warn('[SavedMessages] stopping voice recorder failed:', e); }
    }
    setIsRecording(false);
    setIsLockedRecording(false);
    setVoiceGesture('idle');
    voiceGestureRef.current = 'idle';
    removeVoiceListeners();
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
  };

  // Same hold-to-record gestures as ChatScreen (ROADMAP-2 item 12):
  // hold the mic to record; slide UP ≥60px to lock (hands-free until
  // Send), slide LEFT ≥70px to arm cancel, release sends; a release
  // within 300ms (accidental tap) discards instead of sending a ~0s note.
  // Listeners are window-level — while recording, the mic button is
  // replaced by the recording bar, so button-level handlers would die.
  const handleMicPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    // Same guard as ChatScreen: the render state only. (An earlier draft
    // also blocked on mediaRecorderRef.current — but that ref is never
    // cleared after a send, so it silently disabled every recording after
    // the first. A live recorder is already excluded by isRecording.)
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

  const confirmUnsave = async () => {
    if (!savedId || !pendingUnsave) return;
    const msgId = pendingUnsave.id;
    setPendingUnsave(null);
    setActiveMsgId(null);
    try {
      await deleteDoc(doc(db, 'chats', savedId, 'messages', msgId));
      showToastMsg('Removed from Saved Messages');
    } catch {
      showToastMsg('Could not remove it. Try again.');
    }
  };

  const formatTime = (ts: any) => {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const downloadSavedFile = async (msg: any) => {
    const ok = await saveRemoteFile(msg.mediaUrl, msg.fileName || fileNameFromUrl(msg.mediaUrl, 'file'));
    showToastMsg(ok ? 'Saved to Downloads ✓' : 'Could not save file');
  };

  // W7 #91: long-press (touch) / right-click arms a message's actions.
  const armLongPress = (id: string) => {
    try { clearTimeout(longPressTimer.current); } catch { /* intentionally ignored */}
    longPressTimer.current = setTimeout(() => setActiveMsgId(id), 450);
  };
  const disarmLongPress = () => {
    try { clearTimeout(longPressTimer.current); } catch { /* intentionally ignored */}
  };

  // ── Saved-fix: render every message type, reusing ChatScreen's
  // components/renderers. Saved copies are always the user's own, so
  // isMine=true throughout. Polls are read-only here (this is a copy —
  // voting belongs to the original chat).
  const renderSavedBody = (msg: any) => {
    const text = (msg.text || '') as string;

    // Sticker — real art when the message carries it (W30j #216), else
    // the big emoji, same as ChatScreen.
    if (msg.type === 'sticker') {
      return (
        <div className="py-1 select-none" title={msg.stickerLabel || 'Sticker'}>
          {msg.stickerImage ? (
            <img
              src={msg.stickerImage}
              alt={msg.stickerLabel || 'Sticker'}
              draggable={false}
              className="h-32 w-32 object-contain drop-shadow-sm"
            />
          ) : (
            <span className="text-[64px] leading-none drop-shadow-sm">{msg.stickerEmoji || '😀'}</span>
          )}
        </div>
      );
    }

    // Poll — question + options with vote bars (read-only).
    if (msg.type === 'poll' || (!msg.pollOptions && text.startsWith('📊 Poll: '))) {
      const question = msg.pollQuestion || text.replace(/^📊 Poll:\s*/, '') || 'Poll';
      const options: string[] = msg.pollOptions || [];
      const votes: Record<string, number> = msg.pollVotes || {};
      const totalVotes = Object.keys(votes).length;
      return (
        <div className="py-1 min-w-[220px]">
          <p className="font-semibold text-sm mb-2">📊 {question}</p>
          {options.length > 0 ? (
            <>
              <div className="space-y-1.5">
                {options.map((opt: string, optIdx: number) => {
                  const optVotes = Object.values(votes).filter(v => v === optIdx).length;
                  const percentage = totalVotes > 0 ? Math.round((optVotes / totalVotes) * 100) : 0;
                  const myVote = currentUser ? votes[currentUser.uid] === optIdx : false;
                  return (
                    <div
                      key={optIdx}
                      className={`w-full text-left p-2 rounded-xl text-xs relative overflow-hidden border ${
                        myVote ? 'border-primary-green bg-primary-green/10 font-medium' : 'border-black/10 dark:border-white/10'
                      }`}
                    >
                      <div className="absolute left-0 top-0 bottom-0 bg-primary-green/20 rounded-xl" style={{ width: `${percentage}%` }} />
                      <div className="relative flex justify-between items-center z-10">
                        <span>{myVote ? '✓ ' : ''}{opt}</span>
                        <span className="opacity-75 font-mono ml-2">{percentage}% ({optVotes})</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] opacity-60 mt-1.5 text-right">{totalVotes} votes</p>
            </>
          ) : (
            // Old saved copy (before saveMsg copied poll fields): the
            // options were never stored — point at the original chat.
            <p className="text-xs opacity-70">Poll options is save me nahi hain — original chat me dekho.</p>
          )}
        </div>
      );
    }

    // Live location — saved copy is a snapshot (ticks never flow to
    // it), so render it ended (live={false}) with the last known
    // position. Saved bubbles are LIGHT, so isMine={false}.
    if (msg.type === 'live-location') {
      if (typeof msg.latitude === 'number' && typeof msg.longitude === 'number') {
        return (
          <LiveLocationCard
            data={{
              type: 'live-location',
              liveLocationId: msg.liveLocationId || msg.id,
              latitude: msg.latitude,
              longitude: msg.longitude,
              locationAccuracy: msg.locationAccuracy,
              liveLocationExpiresAt: msg.liveLocationExpiresAt || 0,
              liveLocationUpdatedAt: msg.liveLocationUpdatedAt || 0,
              liveLocationActive: false,
              senderId: msg.senderId,
              senderName: msg.senderName,
            }}
            isMine={false}
            live={false}
            onToast={showToastMsg}
          />
        );
      }
      return (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-black/5 dark:bg-white/5 mb-1 min-w-[200px]">
          <MapPin className="h-5 w-5 text-primary-green flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{text.replace(/^📍\s*/, '') || 'Live location'}</p>
            <p className="text-[11px] opacity-70">Live location coordinates is save me nahi hain — original chat me dekho.</p>
          </div>
        </div>
      );
    }

    // Location — same card as ChatScreen.
    if (msg.type === 'location' || (msg.latitude == null && text.startsWith('📍'))) {
      if (typeof msg.latitude === 'number' && typeof msg.longitude === 'number') {
        return (
          <LocationMessageCard
            data={{
              latitude: msg.latitude,
              longitude: msg.longitude,
              locationLabel: msg.locationLabel,
              locationAccuracy: msg.locationAccuracy,
            }}
            // Saved bubbles are LIGHT (sent-bubble-light) even for own
            // messages, so the card must use its light-bubble text colours
            // (isMine=true would render near-white text — unreadable here).
            isMine={false}
            onToast={showToastMsg}
          />
        );
      }
      return (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-black/5 dark:bg-white/5 mb-1 min-w-[200px]">
          <MapPin className="h-5 w-5 text-primary-green flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{text.replace(/^📍\s*/, '') || 'Location'}</p>
            <p className="text-[11px] opacity-70">Location coordinates is save me nahi hain — original chat me dekho.</p>
          </div>
        </div>
      );
    }

    // Contact — same card as ChatScreen.
    // #89 (W15): the Message button is back for app-user contacts — the
    // saved copy carries `contactUid` (see ContactPayload → sendContact
    // → saveMsg). Phone-only contacts have no uid and keep no button:
    // guessing a DM by phone lookup would be wrong.
    if (msg.type === 'contact' || (!msg.contactName && text.startsWith('👤 '))) {
      if (msg.contactName || msg.contactPhone) {
        return (
          <ContactMessageCard
            data={{
              contactName: msg.contactName,
              contactPhone: msg.contactPhone,
              contactAvatar: msg.contactAvatar,
            }}
            // Same as LocationMessageCard above: Saved bubbles are light,
            // so use the light-bubble text colours (isMine=true renders the
            // phone number near-white — unreadable on a light bubble).
            isMine={false}
            onMessage={
              msg.contactUid && msg.contactUid !== currentUser?.uid
                ? () => navigate(`/chat/${msg.contactUid}`)
                : undefined
            }
            onToast={showToastMsg}
          />
        );
      }
      return (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-black/5 dark:bg-white/5 mb-1 min-w-[200px]">
          <User className="h-5 w-5 text-primary-green flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{text.replace(/^👤\s*/, '') || 'Contact'}</p>
            <p className="text-[11px] opacity-70">Contact details is save me nahi hain — original chat me dekho.</p>
          </div>
        </div>
      );
    }

    // Image / GIF (GIFs are type 'gif' + mediaType 'image').
    // W7 #84: tap opens ChatScreen's MediaLightbox (fullscreen +
    // download) instead of a dead bare <img>.
    if (msg.mediaUrl && msg.mediaType === 'image') {
      return (
        <button
          type="button"
          onClick={() => setLightbox({ open: true, url: msg.mediaUrl, type: 'image', senderName: msg.originalSenderName || msg.senderName, time: formatTime(msg.timestamp) })}
          className="block p-0 m-0 mb-1 rounded-lg overflow-hidden"
          aria-label="Open photo fullscreen"
        >
          <img src={msg.mediaUrl} alt="" className="rounded-lg max-w-xs" />
        </button>
      );
    }

    // Video — round video gets the circular player, else inline player.
    // W7 #85: both get an explicit Download button now (playback itself
    // still needs a real phone to prove — headless Chromium has no
    // H.264 codec). Tapping the video also opens the lightbox player.
    if (msg.mediaUrl && msg.mediaType === 'video') {
      return (
        <div className="mb-1">
          {msg.isRoundVideo ? (
            <RoundVideoPlayer url={msg.mediaUrl} posterUrl={msg.posterUrl} duration={msg.duration} isMine />
          ) : (
            <video
              src={msg.mediaUrl}
              poster={msg.posterUrl || undefined}
              controls
              preload="metadata"
              className="w-full max-w-xs rounded-lg"
            />
          )}
          <button
            type="button"
            onClick={() => void downloadSavedFile(msg)}
            className="mt-1 inline-flex items-center gap-1 rounded-full bg-black/5 dark:bg-white/10 px-2 py-1 text-[11px] font-medium hover:bg-black/10 dark:hover:bg-white/15"
          >
            <Download className="h-3 w-3" /> Download video
          </button>
        </div>
      );
    }

    // Voice note / audio. (isMine=false: Saved bubbles are light, so the
    // player needs its dark-on-light colours — white bars would vanish.)
    if (msg.mediaUrl && msg.mediaType === 'audio') {
      return (
        <div className="mb-1 min-w-[220px]">
          <VoiceNotePlayer url={msg.mediaUrl} duration={msg.duration} isMine={false} waveform={msg.waveform} seed={msg.id} />
        </div>
      );
    }

    // File / document — same card as ChatScreen, tap to download.
    if (msg.mediaUrl && msg.mediaType === 'file') {
      return (
        <button
          type="button"
          onClick={() => void downloadSavedFile(msg)}
          className="flex w-full text-left items-center gap-3 p-2 rounded-lg bg-black/5 dark:bg-white/5 mb-1 min-w-[220px] max-w-xs"
        >
          <div className="h-10 w-10 rounded-md bg-primary-green/15 text-primary-green flex items-center justify-center flex-shrink-0 text-lg">📄</div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{msg.fileName || fileNameFromUrl(msg.mediaUrl, 'Document')}</p>
            <p className="text-[11px] opacity-70">{formatBytes(msg.fileSize)}{msg.fileType ? ` · ${msg.fileType}` : ''} · Tap to save</p>
          </div>
        </button>
      );
    }

    // Unknown media type with a URL — clean placeholder, never raw "[Media]".
    if (msg.mediaUrl) {
      const label = msg.mediaType || msg.type || 'Media';
      return (
        <button
          type="button"
          onClick={() => void downloadSavedFile(msg)}
          className="flex w-full text-left items-center gap-3 p-2 rounded-lg bg-black/5 dark:bg-white/5 mb-1 min-w-[200px] max-w-xs"
        >
          <div className="h-10 w-10 rounded-md bg-primary-green/15 text-primary-green flex items-center justify-center flex-shrink-0">
            <Download className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium capitalize">{label}</p>
            <p className="text-[11px] opacity-70">Tap to open / download</p>
          </div>
        </button>
      );
    }

    // Nothing renderable at all (e.g. an old "[Media]"-only copy).
    if (!text || isMediaLabelText(text, msg)) {
      return (
        <p className="text-sm opacity-70 italic">Is message ka content save nahi ho paya — original chat me dekho.</p>
      );
    }
    return null;
  };

  /** W7 #81: the quoted original, as ChatScreen renders it — tap
      jumps to the original chat. Only new saves carry replyTo. */
  const renderReplyQuote = (msg: any) => {
    const q = msg.replyTo;
    if (!q || typeof q !== 'object') return null;
    const qText = typeof q.text === 'string' && q.text ? q.text : '';
    if (!qText && !q.senderName) return null;
    return (
      <button
        type="button"
        onClick={() => { if (msg.originalChatId) navigate(`/chat/${msg.originalChatId}`); }}
        className="mb-1 px-3 py-1.5 rounded-lg text-xs border-l-2 border-primary-green bg-black/10 dark:bg-white/5 max-w-full cursor-pointer hover:opacity-80 transition-opacity text-left self-start w-full"
      >
        <p className="font-semibold text-primary-green truncate">{q.senderName || 'Original message'}</p>
        <p className="text-gray-500 dark:text-text-secondary truncate">{qText || '[Media]'}</p>
      </button>
    );
  };

  const FILTERS: { key: SavedFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'media', label: 'Media' },
    { key: 'links', label: 'Links' },
    { key: 'files', label: 'Files' },
    { key: 'voice', label: 'Voice' },
  ];

  return (
    // W7 #96: entering Saved used to be an instant cut — a short
    // fade-in on mount (same animate-fade-in ChatScreen's lightbox uses).
    <div className="flex h-screen flex-col bg-bg-light dark:bg-bg-dark animate-fade-in">
      {/* Header — WhatsApp-identical top safe-area and status bar background */}
      <div className="pt-safe bg-panel-light dark:bg-panel-dark shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Back">
            <ArrowLeft className="h-6 w-6 text-gray-700 dark:text-text-primary" />
          </button>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-green-cta flex items-center justify-center text-white text-xl">💾</div>
            <div>
              <h2 className="font-semibold text-gray-900 dark:text-text-primary">Saved Messages</h2>
              <p className="text-xs text-gray-500 dark:text-text-secondary">Your personal cloud space</p>
            </div>
          </div>
        </div>
      </div>

      {/* Info banner */}
      <div className="bg-primary-green/10 px-4 py-2 border-b border-primary-green/20">
        <p className="text-xs text-primary-green text-center">📌 Save notes, links, and media for yourself. Only you can see this.</p>
      </div>

      {/* W7 #83: search inside Saved — the screen used to have exactly
          one input (the note composer). W7 #95: filter chips. */}
      <div className="flex-shrink-0 px-3 pt-2 pb-1 space-y-2">
        <div className="flex items-center gap-2 rounded-full bg-panel-light dark:bg-panel-dark px-3 py-2 shadow-sm">
          <Search className="h-4 w-4 text-gray-400 flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search saved messages..."
            aria-label="Search saved messages"
            className="flex-1 bg-transparent text-sm text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-400"
          />
          {/* W13 #95: jump-to-date — picks a day and scrolls to its
              first saved message (no message on that day -> a toast). */}
          <input
            type="date"
            aria-label="Jump to date"
            title="Jump to date"
            value={jumpDate}
            onChange={e => jumpToDate(e.target.value)}
            className="flex-shrink-0 bg-transparent text-xs text-gray-500 dark:text-text-secondary outline-none [color-scheme:light] dark:[color-scheme:dark]"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')} aria-label="Clear search" className="p-0.5 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark">
              <X className="h-4 w-4 text-gray-400" />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter saved messages">
          {FILTERS.map(f => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-green-cta text-white'
                  : 'bg-panel-light dark:bg-panel-dark text-gray-600 dark:text-text-secondary shadow-sm'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading ? (
          <div className="space-y-2" aria-label="Loading saved messages">
            {[0, 1].map(i => (
              <div key={i} className="flex justify-end">
                <div className="w-2/3 h-14 rounded-2xl bg-gray-200 dark:bg-input-dark animate-pulse" />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          // W7 #98: empty state with a way out, not just text.
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 dark:text-text-secondary">
            <div className="text-6xl">💾</div>
            <p className="text-lg font-medium">No saved messages yet</p>
            <p className="text-sm text-center max-w-xs">Type something below, or save messages from any chat using the context menu.</p>
            <button
              type="button"
              onClick={() => navigate('/main')}
              className="mt-1 px-5 py-2.5 rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green transition-colors"
            >
              Go to chats
            </button>
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 dark:text-text-secondary">
            <div className="text-5xl">🔍</div>
            <p className="text-base font-medium">Nothing matches that search</p>
            <p className="text-sm text-center max-w-xs">Try a different word, or clear the filter.</p>
            <button
              type="button"
              onClick={() => { setSearchQuery(''); setFilter('all'); }}
              className="mt-1 px-5 py-2.5 rounded-full bg-green-cta text-white text-sm font-semibold hover:bg-dark-green transition-colors"
            >
              Clear search &amp; filters
            </button>
          </div>
        ) : (
          filteredMessages.map((msg, idx) => {
            const text = (msg.text || '') as string;
            // Cards render their own content — don't print the raw text too.
            // Old copies (no `type` field) are detected from their text prefix.
            const isCardType = ['poll', 'location', 'live-location', 'contact', 'sticker', 'gif'].includes(msg.type);
            const isOldPoll = !msg.pollOptions && text.startsWith('📊 Poll: ');
            const isOldLocation = msg.latitude == null && text.startsWith('📍');
            const isOldContact = !msg.contactName && text.startsWith('👤 ');
            const showText = !!text && !isMediaLabelText(text, msg) && !isCardType && !isOldPoll && !isOldLocation && !isOldContact;
            // Link preview under plain-text messages only (same rule as ChatScreen).
            const linkUrl = !isCardType && firstUrlInText(msg.text);
            // W7 #93: keep the ORIGINAL alignment — a message from Rahul
            // renders left in a received bubble, not right in a green
            // sent bubble. New saves carry originalSenderId (saveMsg);
            // legacy copies only have senderId = own uid, so they keep
            // the old right alignment rather than guessing wrong.
            const mine = msg.originalSenderId
              ? msg.originalSenderId === currentUser?.uid
              : msg.senderId === currentUser?.uid;
            // Legacy originalFrom was the original sender's name (mislabeled
            // as a forward); new saves carry it as originalSenderName.
            const originName = msg.originalSenderName || msg.originalFrom || '';
            // W7 #92: date pill when the day changes (Today / Yesterday /
            // "12 Nov 2026"), same labels as ChatScreen.
            const showDateSep = idx === 0 || dayKey(filteredMessages[idx - 1]?.timestamp) !== dayKey(msg.timestamp);
            const isToday = dayKey(msg.timestamp) === dayKey(Date.now());
            const actionsOpen = activeMsgId === msg.id;
            return (
              <div key={msg.id} id={`saved-msg-${msg.id}`}>
                {showDateSep && (
                  <div className="flex justify-center my-2">
                    <span className="text-[11px] font-medium text-gray-600 dark:text-text-secondary bg-white/80 dark:bg-[#202C33]/80 px-3 py-1 rounded-full shadow-sm">{dateLabel(msg.timestamp)}</span>
                  </div>
                )}
                <div
                  className={`flex ${mine ? 'justify-end' : 'justify-start'} group ${highlightedMsgId === msg.id ? 'bg-primary-green/25 rounded-xl p-1' : ''}`}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setActiveMsgId(msg.id); }}
                  onTouchStart={() => armLongPress(msg.id)}
                  onTouchEnd={disarmLongPress}
                  onTouchMove={disarmLongPress}
                >
                  <div className={`max-w-[80%] flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    <div
                      className={
                        mine
                          ? 'bg-sent-bubble-light dark:bg-sent-bubble text-gray-900 dark:text-white rounded-2xl rounded-tr-none px-3 py-2 shadow-sm'
                          : 'bg-white dark:bg-[#202C33] text-gray-900 dark:text-white rounded-2xl rounded-tl-none px-3 py-2 shadow-sm'
                      }
                    >
                      {/* W7 #80: only a REAL forward gets the credit —
                          new saves carry forwardedFrom; legacy copies
                          never had it, so they show no forward label. */}
                      {msg.forwardedFrom && (
                        <p className="text-xs text-primary-green mb-1">↪ Forwarded from {msg.forwardedFrom}</p>
                      )}
                      {/* Sender name on incoming bubbles (WhatsApp
                          Starred keeps who said it visible). */}
                      {!mine && originName && (
                        <p className="text-xs font-semibold text-primary-green mb-1">{originName}</p>
                      )}
                      {/* W7 #90: a kept message still looks kept. */}
                      {msg.kept && (
                        <p className="text-[11px] font-medium text-primary-green mb-1">📌 Kept message</p>
                      )}
                      {renderReplyQuote(msg)}
                      {renderSavedBody(msg)}
                      {showText && <p className="dt-msg-text leading-snug whitespace-pre-wrap break-words">{text}</p>}
                      {linkUrl && getLinkPreviewsEnabled() && <LinkPreviewCard url={linkUrl} />}
                      <p className="text-[10px] opacity-60 text-right mt-0.5">
                        {/* W7 #82: the "(edited)" marker saveMsg now preserves. */}
                        {msg.edited && <span className="opacity-70 mr-1" title={msg.editedAt ? `Edited ${toDateSafe(msg.editedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Edited'}>edited</span>}
                        {/* W7 #92: date next to the time for older saves. */}
                        {!isToday && `${dateLabel(msg.timestamp)} · `}{formatTime(msg.timestamp)}
                      </p>
                      {msg.originalChatId && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); navigate(`/chat/${msg.originalChatId}`, { state: { jumpToMessageId: msg.originalMessageId || msg.id } }); }}
                          className="text-[11px] text-primary-green font-medium hover:underline mt-0.5"
                        >
                          Open in chat ↗
                        </button>
                      )}
                    </div>
                    {/* W7 #91: actions only for the long-pressed / ⋯-opened
                        message — no permanent pill under every bubble, so
                        the gap between bubbles is the list gap again. */}
                    <div className="mt-0.5 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setActiveMsgId(actionsOpen ? null : msg.id); }}
                        className="flex items-center justify-center rounded-full bg-white dark:bg-input-dark w-6 h-6 shadow-sm opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        aria-label="Saved message actions"
                        title="More actions"
                      >
                        <MoreVertical className="h-3.5 w-3.5 text-gray-500 dark:text-text-secondary" />
                      </button>
                      {actionsOpen && (
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setPendingUnsave(msg); }}
                          className="flex items-center gap-1 rounded-full bg-white dark:bg-input-dark px-2 py-1 shadow-sm"
                          aria-label="Unsave this message"
                          title="Unsave"
                        >
                          <Trash2 className="h-3 w-3 text-red-400" />
                          <span className="text-[10px] text-red-400 font-medium">Unsave</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input — W23 #94: mic (hold to record, same as chat) + in-app
          camera sit beside the attach button; while recording, the
          composer row is replaced by the recording bar (same as chat). */}
      {isRecording ? (
        <div data-voice-gesture={voiceGesture} className="flex items-center gap-2 px-3 py-2 bg-panel-light dark:bg-panel-dark border-t border-gray-200 dark:border-white/5">
          <button type="button" onClick={cancelRecording} aria-label="Cancel recording" className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-500 hover:text-red-500 flex-shrink-0">
            <Trash2 className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
            <span className="text-sm font-medium text-gray-900 dark:text-text-primary tabular-nums flex-shrink-0">
              {fmtSecs(recordingSecs)}
            </span>
            <div className="flex items-center gap-[3px] h-6 flex-1 overflow-hidden" aria-hidden="true">
              {Array.from({ length: 28 }).map((_, i) => (
                <span
                  key={i}
                  className="w-[3px] rounded-full bg-red-400/70 animate-pulse"
                  style={{ height: `${6 + ((i * 37 + recordingSecs * 13) % 16)}px`, animationDelay: `${i * 60}ms` }}
                />
              ))}
            </div>
            {voiceGesture === 'cancel-armed' ? (
              <span className="text-[11px] text-red-500 font-semibold flex-shrink-0">Release to cancel</span>
            ) : voiceGesture === 'lock-armed' || isLockedRecording ? (
              <span className="text-[11px] text-primary-green font-medium flex-shrink-0">Locked</span>
            ) : (
              <span className="text-[11px] text-gray-400 flex-shrink-0">↑ lock · ← cancel</span>
            )}
          </div>
          <button type="button" onClick={() => setIsLockedRecording(v => !v)} aria-label={isLockedRecording ? 'Unlock recording' : 'Lock recording — keep recording hands-free'} aria-pressed={isLockedRecording} title="Lock recording (slide-to-lock): release and keep recording" className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full flex-shrink-0 ${isLockedRecording ? 'bg-green-cta text-white' : 'text-gray-500 hover:text-primary-green'}`}>
            <Lock className="h-5 w-5" />
          </button>
          <button type="button" onClick={stopRecording} aria-label="Send voice message" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-green-cta text-white shadow-sm hover:bg-dark-green">
            <Send className="h-5 w-5 ml-0.5" />
          </button>
        </div>
      ) : (
      <div className="flex items-center gap-2 p-2 bg-transparent">
        {/* W7 #94: attach a photo/file into Saved (same S3 upload as chat). */}
        <input
          ref={attachInputRef}
          type="file"
          className="hidden"
          aria-label="Attach a file to Saved Messages"
          onChange={handleAttach}
        />
        <button
          type="button"
          onClick={() => attachInputRef.current?.click()}
          disabled={uploadingAttach}
          aria-label="Attach a photo or file"
          title="Attach a photo or file"
          className="h-12 w-12 flex-shrink-0 flex items-center justify-center rounded-full bg-panel-light dark:bg-panel-dark text-gray-600 dark:text-text-secondary shadow-sm disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-input-dark transition-colors"
        >
          <Paperclip className="h-5 w-5" />
        </button>
        {/* W23 #94: in-app camera (ChatScreen's CameraModal viewfinder). */}
        <button
          type="button"
          onClick={openCamera}
          disabled={uploadingAttach}
          aria-label="Take a photo or video"
          title="Take a photo or video"
          className="h-12 w-12 flex-shrink-0 flex items-center justify-center rounded-full bg-panel-light dark:bg-panel-dark text-gray-600 dark:text-text-secondary shadow-sm disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-input-dark transition-colors"
        >
          <Camera className="h-5 w-5" />
        </button>
        <div className="flex flex-1 min-w-0 items-center rounded-3xl bg-panel-light dark:bg-panel-dark px-4 py-2.5 shadow-sm">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && getEnterIsSend()) handleSend(); }}
            placeholder="Save a note, link, or reminder..."
            aria-label="Save a note"
            className="flex-1 min-w-0 bg-transparent dt-msg-text text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-400"
          />
        </div>
        {input.trim() ? (
          <button
            onClick={handleSend}
            aria-label="Send saved note"
            className="h-12 w-12 flex items-center justify-center rounded-full bg-green-cta text-white hover:bg-dark-green transition-colors"
          >
            <Send className="h-5 w-5 ml-0.5" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Record voice message — hold to record, slide up to lock, slide left to cancel"
            onPointerDown={handleMicPointerDown}
            disabled={uploadingVoice}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-green-cta text-white shadow-sm hover:bg-dark-green transition-colors active:scale-90 disabled:opacity-50 touch-none select-none"
          >
            <Mic className="h-6 w-6" />
          </button>
        )}
      </div>
      )}
      {uploadingAttach && (
        <p role="status" className="text-center text-xs text-gray-500 dark:text-text-secondary pb-1 -mt-1">Uploading attachment…</p>
      )}
      {uploadingVoice && (
        <p role="status" className="text-center text-xs text-gray-500 dark:text-text-secondary pb-1 -mt-1">Sending voice note…</p>
      )}

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}

      {/* W7 #84: photo/video lightbox (fullscreen + download). */}
      <MediaLightbox
        isOpen={lightbox.open}
        onClose={() => setLightbox({ open: false, url: '', type: 'image' })}
        mediaUrl={lightbox.url}
        mediaType={lightbox.type}
        senderName={lightbox.senderName}
        time={lightbox.time}
      />

      {/* W23 #94: in-app camera viewfinder (ChatScreen's CameraModal —
          photo capture + ≤60s video). Fallback opens the file picker. */}
      <CameraModal
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onPhoto={handleCameraPhoto}
        onVideo={handleCameraVideo}
        onFallback={() => { setShowCamera(false); attachInputRef.current?.click(); }}
      />

      {/* Unsave confirm — saved copies store no original message id, so
          unsaving only removes this copy (the original chat message is untouched). */}
      {pendingUnsave && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setPendingUnsave(null)} role="dialog" aria-modal="true" aria-label="Remove saved message">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold">Remove this saved message?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">
              It will be removed from Saved Messages. The original message in its chat is not affected.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setPendingUnsave(null)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button onClick={confirmUnsave} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all">Unsave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
