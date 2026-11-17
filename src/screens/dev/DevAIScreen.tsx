import React, { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Send, Sparkles, Camera, X, Trash2, Copy, RefreshCw, MessageSquarePlus, FileText, PenLine, ChevronDown, ChevronUp, Lock } from 'lucide-react';
import DevAIGeneratedImage from '../../components/DevAIGeneratedImage';
import { useNavigate, useLocation } from 'react-router-dom';
import { authManager } from '../../aws/auth';
import {
  getUserFirstName,
  getGeminiApiKey,
  generateDevReply,
  classifyDevError,
  friendlyErrorMessage,
  getOfflineReply,
  summarizeChatLocally,
  draftReplyLocally,
  buildChatContextSnippet,
  loadChatContext,
  listAttachableChats,
  isPhotoRequest,
  buildPhotoImageUrl,
  enhancePhotoPrompt,
  isPhotoConvertRequest,
  isShowExistingPhotoRequest,
  findLastGeneratedPhotoUrl,
  photoConvertNotAvailableReply,
  DEV_AI_PRIMARY_MODEL,
  type DevTone,
  type DevChatContext,
  type ChatOption,
} from '../../services/devAI';

type Intent = 'chat' | 'summary' | 'draft';

export default function DevAIScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const [userName] = useState(() => getUserFirstName());
  const [messages, setMessages] = useState<{ id: string; text: string; sender: 'me' | 'dev'; time: string; image?: string }[]>(() => {
    try {
      const saved = localStorage.getItem('dt_dev_ai_chat_history');
      if (saved) return JSON.parse(saved);
    } catch (err) {
      console.warn("[DevAIScreen] DevAIScreen: const saved = localStorage.getItem('dt_dev_ai_chat...", err);
    }
    const name = getUserFirstName();
    return [
      { id: '1', text: `Arre ${name}! 😄 Kya chal raha hai? Main Dev hoon — baat kar sakte hain, chat ka summary bana sakta hoon, ya message ka jawab likhne me madad kar sakta hoon.`, sender: 'dev', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    ];
  });

  useEffect(() => {
    try {
      localStorage.setItem('dt_dev_ai_chat_history', JSON.stringify(messages));
    } catch (err) {
      console.warn("[DevAIScreen] DevAIScreen: localStorage.setItem('dt_dev_ai_chat_history', JSO...", err);
    }
  }, [messages]);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // #259: last prompt that failed after ALL providers were tried, so the
  // user can retry it with one tap (Retry button below the messages)
  // instead of retyping. Cleared on the next send attempt.
  const [lastFailed, setLastFailed] = useState<{ text: string; intent: Intent } | null>(null);
  // REPORT-2 bug #9: Dev AI needs the same "too long" toast the DM
  // composer has — there was no toast mechanism on this screen at all.
  const [toast, setToast] = useState('');
  const toastTimerRef = useRef<number | null>(null);
  const showToastMsg = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 3000);
  };
  const [selectedImage, setSelectedImage] = useState<{ file: File, preview: string } | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  // Chat-context awareness: attach a chat so Dev can summarise it / draft replies.
  const [attached, setAttached] = useState<DevChatContext | null>(null);
  const [tone, setTone] = useState<DevTone>('friendly');
  const [showPicker, setShowPicker] = useState(false);
  const [pickerChats, setPickerChats] = useState<ChatOption[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [showContextDetail, setShowContextDetail] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** AbortController for the in-flight Gemini request (real Stop button). */
  const abortRef = useRef<AbortController | null>(null);
  /** Monotonic id: stale responses after an abort are ignored. */
  const requestIdRef = useRef(0);

  const myUid = authManager.user?.uid || '';

  // Auto-attach when navigated here with a chat (e.g. future "Ask Dev" button in a chat).
  useEffect(() => {
    const state: any = (location as any)?.state;
    if (state?.chatId && !attached) {
      loadChatContext(state.chatId, state.chatName || 'Chat', !!state.isGroup, myUid)
        .then((ctx) => setAttached(ctx))
        .catch((err) => console.warn("[DevAIScreen] DevAIScreen: loadChatContext(...) failed", err));
    }
    // Only on mount / navigation state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const postDev = (text: string, image?: string) => {
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString() + Math.random().toString(36).slice(2, 6), text, sender: 'dev', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), ...(image ? { image } : {}) }
    ]);
  };

  const clearChatHistory = () => {
    setShowClearConfirm(true);
  };

  const confirmClearHistory = () => {
    setShowClearConfirm(false);
    const initial = [
      { id: Date.now().toString(), text: `History cleared. Bol ${userName}, kya chal raha hai? 😄`, sender: 'dev' as const, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    ];
    setMessages(initial);
    try {
      localStorage.setItem('dt_dev_ai_chat_history', JSON.stringify(initial));
    } catch (err) {
      console.warn("[DevAIScreen] DevAIScreen: localStorage.setItem('dt_dev_ai_chat_history', JSO...", err);
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, selectedImage]);

  useEffect(() => {
    return () => {
      if (selectedImage?.preview) {
        URL.revokeObjectURL(selectedImage.preview);
      }
    };
  }, [selectedImage]);

  // Abort any in-flight request when leaving the screen; Escape closes confirm.
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!showClearConfirm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowClearConfirm(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showClearConfirm]);

  const openPicker = async () => {
    setShowPicker(true);
    setPickerLoading(true);
    try {
      const list = await listAttachableChats(myUid);
      setPickerChats(list);
    } catch (_) {
      setPickerChats([]);
    } finally {
      setPickerLoading(false);
    }
  };

  const attachChat = async (opt: ChatOption) => {
    setShowPicker(false);
    try {
      const ctx = await loadChatContext(opt.id, opt.name, opt.isGroup, myUid);
      setAttached(ctx);
      postDev(`📎 "${opt.name}" attach kar diya — ab is chat ka summary ya jawab maang sakte ho 🙂 Neeche Summary ya Draft dabao, ya bas pooch lo.`);
    } catch (_) {
      postDev('Yaar us chat ko attach nahi kar paya 😅 Dobara try karo.');
    }
  };

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (selectedImage?.preview) {
        URL.revokeObjectURL(selectedImage.preview);
      }
      const preview = URL.createObjectURL(file);
      setSelectedImage({ file, preview });
    }
  };

  const fileToGenerativePart = async (file: File): Promise<{ inlineData: { data: string; mimeType: string } }> => {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
    };
  };

  const stopGeneration = () => {
    // Abort the in-flight Gemini request. The SDK supports abortSignal
    // (GenerateContentConfig.abortSignal); the catch below turns the abort
    // into a "Stopped" message instead of a fake error, and the request id
    // guard drops any late response.
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setMessages((prev) => [
      ...prev,
      { id: Date.now().toString(), text: 'Rok diya ✋ Bol, kya karna hai ab?', sender: 'dev', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    ]);
  };

  const handleSend = async (text: string = input, intent: Intent = 'chat', opts?: { skipUserEcho?: boolean }) => {
    if ((!text.trim() && !selectedImage) || loading) return;
    // A new attempt supersedes the previous failure's Retry button.
    setLastFailed(null);

    // Pasted Gemini key: "AIza…" (39 chars) sent as a chat message is
    // saved to localStorage (dt_gemini_api_key) and never sent to the API
    // as a prompt. The key is masked in the chat bubble.
    const trimmed = text.trim();
    // REPORT-2 bug #9: DM composer blocks >5000 chars ("Message too long
    // (max 5,000 characters)"); Dev AI accepted 6000 with no complaint.
    // Same limit, same message, checked before the key-paste path.
    if (trimmed.length > 5000) {
      showToastMsg('Message too long (max 5,000 characters)');
      return;
    }
    const keyMatch = trimmed.match(/AIza[0-9A-Za-z\-_]{30,}/);
    if (keyMatch && !selectedImage) {
      const key = keyMatch[0];
      try {
        localStorage.setItem('dt_gemini_api_key', key);
      } catch (err) {
        console.warn("[DevAIScreen] DevAIScreen: localStorage.setItem('dt_gemini_api_key', key) failed", err);
      }
      const masked = `${key.slice(0, 6)}…${key.slice(-4)}`;
      setMessages((prev) => [
        ...prev,
        { id: Date.now().toString(), text: '🔑 •••••••• (API key)', sender: 'me', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
        { id: (Date.now() + 1).toString(), text: `Key save kar diya (${masked}) ✅ Ab kuch bhi pooch, main ready hoon! Key sirf is device par saved hai.`, sender: 'dev', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
      ]);
      setInput('');
      return;
    }

    const newMsg = {
      id: Date.now().toString(),
      text,
      sender: 'me' as const,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      image: selectedImage?.preview
    };

    // #259: a Retry re-sends the same prompt — the user's bubble is
    // already in the chat, so don't post it a second time.
    if (!opts?.skipUserEcho) setMessages((prev) => [...prev, newMsg]);
    setInput('');
    const imageToSend = selectedImage?.file;
    setSelectedImage(null);
    setLoading(true);

    const apiKey = getGeminiApiKey();
    const requestId = ++requestIdRef.current;
    const ctx = attached;
    const chatContextSnippet = ctx ? buildChatContextSnippet(ctx, userName) : undefined;

    // Photo-to-photo conversion asked for an ATTACHED photo (e.g. "is photo
    // ko Ghibli banao"): not available free — say so plainly, no API call.
    if (imageToSend && isPhotoConvertRequest(trimmed)) {
      setLoading(false);
      postDev(photoConvertNotAvailableReply(userName));
      return;
    }

    // NEW-2: asking to SEE a photo that already exists ("wo purani photo
    // dikhao") shows the last generated photo instead of generating a new
    // one. Only when a generation already exists in this chat — otherwise
    // fall through to generation below (a fresh photo is the honest
    // answer when there is nothing to show yet).
    if (!imageToSend && isShowExistingPhotoRequest(trimmed)) {
      const lastPhoto = findLastGeneratedPhotoUrl(messages);
      if (lastPhoto) {
        setLoading(false);
        postDev(
          `Ye rahi tumhari pichli photo 🙂 Neeche dekh lo — wahi wali hai, nayi nahi banayi.`,
          lastPhoto,
        );
        return;
      }
    }

    // Photo from a text prompt: free via Pollinations, no key needed.
    // The image URL itself triggers generation when the <img> loads.
    if (!imageToSend && isPhotoRequest(trimmed)) {
      setLoading(false);
      const url = buildPhotoImageUrl(enhancePhotoPrompt(trimmed));
      postDev(
        `Ye lo, tumhari photo ban rahi hai 🎨\n"${trimmed}"\n\nFree Pollinations se bani hai — load hone me kuch seconds lag sakte hain. Ek saath bahut saari photo banao to free limit lag sakti hai, thoda ruk ke try karna 🙂`,
        url,
      );
      return;
    }

    // Intent prompts — summary / draft use the attached chat context.
    let effectivePrompt = text;
    if (intent === 'summary' && ctx) {
      effectivePrompt = `Is chat ("${ctx.chatName}") ka summary de do — main points, kisne kya bola, aur aakhri messages ka matlab. Short aur clear.`;
    } else if (intent === 'draft' && ctx) {
      const toneWord = tone === 'formal' ? 'formal aur polite' : tone === 'funny' ? 'funny aur playful' : 'friendly aur casual';
      effectivePrompt = `Is chat ("${ctx.chatName}") ke aakhri message ka ${toneWord} tone me jawab likho — bhejne layak draft do, 2-3 options ke saath.`;
    }

    const historyText = messages.map(m => `${m.sender === 'dev' ? 'Dev' : 'User'}: ${m.text}`).join('\n');

    if (!apiKey) {
      // Overnight round 2, Part 3: the Gemini key is LOST (empty .env) —
      // Dev AI was dead for every question. The Pollinations text path in
      // devAI.ts is keyless by design, but this branch returned before
      // generateDevReply was ever called, and Gemini with an empty key
      // throws a non-retryable 400 before the Pollinations step. So with
      // no image attached, try the keyless path first (generateDevReply
      // skips Gemini when apiKey is empty); only if THAT fails do we fall
      // back to the offline reply / no-key message below. Vision (an
      // attached image) still needs Gemini — it keeps the offline path.
      if (!imageToSend) {
        try {
          const reply = await generateDevReply({
            apiKey: '',
            historyText,
            prompt: effectivePrompt,
            imagePart: null,
            chatContextSnippet,
            tone,
            userName,
          });
          if (requestId !== requestIdRef.current) return;
          postDev(reply || 'Yaar kuch gadbad ho gayi, thoda baad try kar 😅');
          setLoading(false);
          return;
        } catch (err) {
          // Keyless path failed (offline / rate-limited) — fall through
          // to the offline reply / no-key message below.
          console.warn("[DevAIScreen] DevAIScreen: const reply = await generateDevReply({ failed", err);
        }
      }
      // Offline fallback first: local summary / draft / app help / greeting.
      const offline = getOfflineReply(effectivePrompt, { context: ctx, tone, userName });
      setTimeout(() => {
        if (requestId !== requestIdRef.current) return;
        if (offline) {
          postDev(offline);
        } else if (intent === 'summary' && ctx) {
          postDev(summarizeChatLocally(ctx, userName));
        } else if (intent === 'draft' && ctx) {
          postDev(draftReplyLocally(ctx, tone));
        } else {
          postDev(friendlyErrorMessage('no-key'));
        }
        setLoading(false);
      }, 500);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const imagePart = imageToSend ? await fileToGenerativePart(imageToSend) : null;
      const reply = await generateDevReply({
        apiKey,
        historyText,
        prompt: effectivePrompt,
        imagePart,
        chatContextSnippet,
        tone,
        userName,
        signal: controller.signal,
      });

      // Aborted (or superseded) while awaiting: drop the late response.
      if (requestId !== requestIdRef.current) return;

      postDev(reply || 'Yaar kuch gadbad ho gayi, thoda baad try kar 😅');
    } catch (error) {
      // Aborted via Stop: the "Stopped" message was already posted by
      // stopGeneration — don't add a fake error on top.
      if (requestId !== requestIdRef.current) return;
      const aborted = (error as any)?.name === 'AbortError' || controller.signal.aborted;
      console.error(error);
      if (!aborted) {
        const kind = classifyDevError(error);
        // Network/key trouble: still try the offline answer so the user is never stuck.
        const offline = getOfflineReply(effectivePrompt, { context: ctx, tone, userName });
        const extra = offline ? `\n\nTab tak offline me ye bata sakta hoon:\n${offline}` : '';
        postDev(friendlyErrorMessage(kind) + extra);
        // #259: every provider failed and loading is cleared in the
        // finally below — offer a one-tap Retry. Image sends are
        // excluded: the attachment is already consumed and can't be
        // re-sent, so the user re-attaches it manually.
        if (!imageToSend) setLastFailed({ text: trimmed, intent });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  const quickChips = [
    'Chat ka summary de do 📝',
    'Is message ka jawab likho ✍️',
    'App me ye feature kahan hai? 🧭',
    'Vault kaise use karein? 🔐',
    'Joke suna 😂',
    'Motivate kar 💪',
    '🖼️ Photo banao 🎨',
  ];

  const onChip = (chip: string) => {
    if (chip.startsWith('🖼️')) {
      postDev('Batao kaisi photo chahiye? 😄 Jaise "Ghibli style me ek gaon ki photo banao" ya "ek ad poster banao" — prompt se photo bana dunga 🎨 (Apni photo ko convert karna free me nahi hota, wo main pehle hi bata dunga.)');
      return;
    }
    if (chip.startsWith('Chat ka summary')) {
      if (!attached) { openPicker(); return; }
      void handleSend('Is chat ka summary de do', 'summary');
    } else if (chip.startsWith('Is message ka jawab')) {
      if (!attached) { openPicker(); return; }
      void handleSend('Is message ka jawab likho', 'draft');
    } else {
      void handleSend(chip);
    }
  };

  return (
    <div className="flex h-screen flex-col bg-wallpaper-light dark:bg-bg-dark">
      {/* Header — WhatsApp Classic Pro deep green */}
      <div className="pt-safe bg-header-green dark:bg-panel-dark shadow-sm z-10 flex-shrink-0">
        <div className="flex items-center justify-between px-2 py-2">
          <div className="flex items-center">
            <button onClick={() => navigate(-1)} className="p-2 text-white/90 hover:bg-white/10 rounded-full" aria-label="Back">
              <ArrowLeft className="h-6 w-6" />
            </button>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 ml-1">
              <Sparkles className="h-6 w-6 text-white" />
            </div>
            <div className="ml-3">
              <h2 className="text-base font-semibold text-white">Dev</h2>
              {/* No Gemini key tonight (lost .env): the subtitle must not
                  claim Gemini when answers come from the keyless
                  Pollinations path — see handleSend, Part 3. */}
              <p className="text-xs text-white/80">online • {getGeminiApiKey() ? DEV_AI_PRIMARY_MODEL.replace('gemini-', 'Gemini ') : 'Pollinations (free, no key)'}</p>
            </div>
          </div>
          <button
            onClick={clearChatHistory}
            className="p-2 rounded-full text-white/85 hover:text-white hover:bg-white/10 transition-colors"
            title="Clear Chat History"
            aria-label="Clear chat history"
          >
            <Trash2 className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Clear history confirm */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowClearConfirm(false)} role="dialog" aria-modal="true" aria-label="Clear chat history">
          <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">Clear DEV AI chat history?</h3>
            <p className="text-sm text-gray-500 dark:text-text-secondary">Your saved conversation with Dev will be deleted from this device.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowClearConfirm(false)} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">Cancel</button>
              <button onClick={confirmClearHistory} className="flex-1 py-3 bg-danger-red text-white rounded-xl font-semibold hover:opacity-90 transition-all">Clear</button>
            </div>
          </div>
        </div>
      )}

      {/* Chat picker — attach a chat for summary / draft help */}
      {showPicker && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-end sm:items-center justify-center" onClick={() => setShowPicker(false)} role="dialog" aria-modal="true" aria-label="Choose a chat">
          <div className="w-full max-w-md max-h-[75vh] flex flex-col bg-panel-light dark:bg-panel-dark rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-white/5">
              <h3 className="text-base font-bold text-gray-900 dark:text-text-primary">Chat attach karo</h3>
              <button onClick={() => setShowPicker(false)} className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close"><X className="h-5 w-5 text-gray-500" /></button>
            </div>
            <p className="px-4 pt-3 text-xs text-gray-500 dark:text-text-secondary flex items-start gap-1.5">
              <Lock className="h-3.5 w-3.5 mt-px shrink-0" />
              Chat sirf is device par padhi jati hai. Locked chats yahan nahi dikhte.
            </p>
            <div className="flex-1 overflow-y-auto p-2">
              {pickerLoading ? (
                <p className="text-center text-sm text-gray-500 py-8">Chats load ho rahi hain…</p>
              ) : pickerChats.length === 0 ? (
                <p className="text-center text-sm text-gray-500 py-8">Koi chat nahi mili — pehle kisi se chat karo, phir wapas aao 🙂</p>
              ) : (
                pickerChats.map((c) => (
                  <button key={c.id} onClick={() => void attachChat(c)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-input-dark text-left">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-header-green text-white text-sm font-bold">
                      {(c.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium text-gray-900 dark:text-text-primary truncate">{c.name}{c.isGroup ? ' • group' : ''}</p>
                      {c.lastText ? <p className="text-xs text-gray-500 dark:text-text-secondary truncate">{c.lastText}</p> : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Attached chat context bar */}
      {attached && (
        <div className="flex-shrink-0 px-3 pt-2">
          <div className="rounded-2xl bg-panel-light dark:bg-panel-dark border border-primary-green/20 shadow-sm px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm">📎</span>
              <span className="flex-1 min-w-0 text-sm font-medium text-gray-900 dark:text-text-primary truncate">
                {attached.chatName} • {attached.messages.length} messages
              </span>
              <button
                onClick={() => setShowContextDetail((v) => !v)}
                className="text-xs text-primary-green font-medium flex items-center gap-0.5"
              >
                Context dekho {showContextDetail ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              <button onClick={() => { setAttached(null); setShowContextDetail(false); }} className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Remove attached chat">
                <X className="h-4 w-4 text-gray-500" />
              </button>
            </div>
            {showContextDetail && (
              <div className="mt-2 max-h-32 overflow-y-auto rounded-xl bg-gray-50 dark:bg-input-dark p-2">
                <p className="text-[11px] text-gray-500 dark:text-text-secondary whitespace-pre-wrap">{buildChatContextSnippet(attached, userName)}</p>
                <p className="text-[11px] text-gray-400 mt-2">↑ Yehi context Dev ko bheja jayega — tum dekh sakte ho, kuch chhupa nahi hai.</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <span className="text-xs text-gray-500 dark:text-text-secondary">Tone:</span>
              {(['friendly', 'formal', 'funny'] as DevTone[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${tone === t ? 'bg-green-cta text-white' : 'bg-gray-100 dark:bg-input-dark text-gray-600 dark:text-text-secondary'}`}
                >
                  {t === 'friendly' ? 'Friendly 😊' : t === 'formal' ? 'Formal 🙏' : 'Funny 😂'}
                </button>
              ))}
              <button
                onClick={() => void handleSend('Is chat ka summary de do', 'summary')}
                disabled={loading}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-primary-green/10 text-primary-green disabled:opacity-50"
              >
                <FileText className="h-3.5 w-3.5" /> Summary
              </button>
              <button
                onClick={() => void handleSend('Is message ka jawab likho', 'draft')}
                disabled={loading}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-primary-green/10 text-primary-green disabled:opacity-50"
              >
                <PenLine className="h-3.5 w-3.5" /> Draft
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => {
          const isMe = msg.sender === 'me';
          return (
            <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-2xl px-3 py-1.5 shadow-sm ${
                  isMe
                    ? 'bg-sent-bubble-light dark:bg-sent-bubble text-gray-900 dark:text-text-primary rounded-tr-none'
                    : 'bg-panel-light dark:bg-recv-bubble text-gray-900 dark:text-text-primary rounded-tl-none border border-gray-100 dark:border-white/5'
                }`}
              >
                {/* W30: dev-sent images are Pollinations generations — they
                    get load/timeout/error/retry handling (DevAIGeneratedImage)
                    instead of a bare <img> that shows a broken icon forever
                    when generation fails. User-uploaded previews are local
                    blob URLs and keep the plain <img>. */}
                {msg.image && msg.sender === 'dev' ? (
                  <DevAIGeneratedImage src={msg.image} alt="Generated photo" />
                ) : msg.image ? (
                  <img src={msg.image} alt="Uploaded" className="w-full max-w-xs rounded-lg mb-2 object-cover" />
                ) : null}
                <p className="text-[15px] leading-snug whitespace-pre-wrap break-words">{msg.text}</p>
                <div className="flex items-center justify-between space-x-1 mt-1 pt-1 border-t border-black/5 dark:border-white/5">
                  {msg.sender === 'dev' ? (
                    <button
                      onClick={() => navigator.clipboard.writeText(msg.text).catch((err) => console.warn("[DevAIScreen] onChip: writeText(...) failed", err))}
                      className="text-[10px] text-gray-400 hover:text-primary-green flex items-center gap-1 transition-colors"
                      title="Copy message"
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                  ) : <div />}
                  <span className="text-[10px] text-gray-500 dark:text-text-secondary/80">{msg.time}</span>
                </div>
              </div>
            </div>
          );
        })}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-panel-light dark:bg-recv-bubble rounded-2xl rounded-tl-none px-4 py-3 shadow-sm border border-gray-100 dark:border-white/5 flex items-center gap-3">
              <div className="flex space-x-1">
                <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span className="text-xs text-gray-500 dark:text-text-secondary">Dev likh raha hai…</span>
              <button
                onClick={stopGeneration}
                className="text-[10px] font-semibold text-red-400 hover:text-red-500 bg-red-500/10 px-2 py-0.5 rounded-full"
                aria-label="Stop generating"
              >
                Stop
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* #259: Retry after all providers failed — the error bubble above
          explains what happened; this re-sends the failed prompt. Shown
          only when not loading (loading is cleared in handleSend's
          finally), so the user is never stuck on infinite loading. */}
      {lastFailed && !loading && (
        <div className="flex justify-center px-4 pb-1">
          <button
            onClick={() => void handleSend(lastFailed.text, lastFailed.intent, { skipUserEcho: true })}
            className="flex items-center gap-1.5 rounded-full bg-green-cta px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" /> Dobara try karo
          </button>
        </div>
      )}

      {/* Quick Chips */}
      {messages.length < 3 && !selectedImage && (
        <div className="flex overflow-x-auto px-2 py-2 space-x-2 scrollbar-hide">
          {quickChips.map((chip) => (
            <button
              key={chip}
              onClick={() => onChip(chip)}
              className="whitespace-nowrap rounded-full border border-primary-green/30 bg-primary-green/10 px-3 py-1.5 text-sm text-primary-green dark:text-primary-green"
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {/* Image Preview */}
      {selectedImage && (
        <div className="px-4 py-2 relative">
          <div className="relative inline-block">
            <img src={selectedImage.preview} alt="Preview" className="h-24 w-24 object-cover rounded-xl border-2 border-primary-green" />
            <button
              onClick={() => setSelectedImage(null)}
              className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 shadow-md"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Input Bar */}
      <div className="flex items-end p-2 bg-transparent">
        <div className="flex min-w-0 flex-1 items-center rounded-3xl bg-panel-light dark:bg-panel-dark px-2 py-1.5 shadow-sm">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageSelect}
            className="hidden"
            accept="image/*"
          />
          <button
            onClick={() => void openPicker()}
            disabled={loading}
            className="p-2 text-gray-500 dark:text-text-secondary hover:text-primary-green disabled:opacity-50"
            title="Chat attach karo — summary ya draft ke liye"
            aria-label="Attach a chat"
          >
            <MessageSquarePlus className="h-6 w-6" />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            className="p-2 text-gray-500 dark:text-text-secondary hover:text-gray-700 dark:hover:text-text-primary disabled:opacity-50"
          >
            <Camera className="h-6 w-6" />
          </button>
          <input
            type="text"
            placeholder="Message Dev..."
            className="min-w-0 flex-1 bg-transparent px-2 py-2 text-[15px] text-gray-900 dark:text-text-primary outline-none placeholder:text-gray-500"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleSend()}
            disabled={loading}
          />
        </div>
        <button
          onClick={() => void handleSend()}
          disabled={(!input.trim() && !selectedImage) || loading}
          className="ml-2 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-header-green text-white shadow-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          aria-label="Send message"
        >
          <Send className="h-5 w-5 ml-1" />
        </button>
      </div>

      {/* Toast (REPORT-2 bug #9: "too long" feedback lives here) */}
      {toast && (
        <div role="status" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-2xl animate-toast max-w-[90vw] text-center">
          {toast}
        </div>
      )}
    </div>
  );
}
