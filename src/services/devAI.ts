/**
 * Dev AI service — persona, chat-context helpers, offline fallback and the
 * Gemini call. Only DevAIScreen imports this; nothing else in the app
 * depends on it, so the theme/composer work happening in parallel is safe.
 *
 * SECURITY NOTE (audit finding, NOT fixed here — needs a backend):
 * VITE_GEMINI_API_KEY ships inside the client bundle, so anyone who
 * downloads the app can extract it, and a key pasted in chat is stored
 * in plain text in localStorage (dt_gemini_api_key). The real fix is a
 * server-side AI proxy (Lambda/AppSync) that holds the key. Never rotate
 * or change the user's key from this code.
 */
import { GoogleGenAI } from '@google/genai';
import { db } from '../aws/database';
import { authManager } from '../aws/auth';
import { getConversationId } from './realtimeSync';
import { loadHiddenChatIds } from './lockedChats';
import { getAllowedContactUids } from './contacts';

export type DevTone = 'friendly' | 'formal' | 'funny';

export interface DevChatMessage {
  senderName: string;
  text: string;
  time?: string;
  mine?: boolean;
}

export interface DevChatContext {
  chatId: string;
  chatName: string;
  isGroup: boolean;
  messages: DevChatMessage[];
}

export interface ChatOption {
  id: string;
  name: string;
  isGroup: boolean;
  lastText?: string;
}

/* ------------------------------------------------------------------ */
/* Persona                                                             */
/* ------------------------------------------------------------------ */

/**
 * Friendly Hinglish persona — warm, dostana, Roman Hindi + English mix,
 * exactly how Muse talks to the user. Short WhatsApp-style replies, never
 * formal or robotic, never calls itself "AI" or "Assistant".
 */
export function buildSystemPrompt(userName: string, tone: DevTone): string {
  const toneLine =
    tone === 'formal'
      ? 'Aaj thoda formal aur polite tone me baat kar — respect ke saath, phir bhi warm.'
      : tone === 'funny'
        ? 'Aaj funny aur playful tone me baat kar — halke mazak, witty replies, par kabhi rude mat ban.'
        : 'Friendly, warm aur casual tone me baat kar — jaise ek achha dost WhatsApp par baat karta hai.';
  return `Tu "Dev" hai — ${userName} ka dost, Pinglo ke andar rehne wala.
Tu Hinglish mein baat karta hai — Roman Hindi aur English mix, jaise WhatsApp par dost baat karte hain.
${toneLine}
- User ka naam ${userName} hai — kabhi-kabhi naam se bula, par har message me naam mat ghused.
- Short, natural replies de — zyada tar 1-3 chhoti lines. Lambi essay-type jawab mat de jab tak user detail na maange.
- Formal, robotic ya "As an AI..." wali tone kabhi mat use kar.
- Apne aap ko kabhi "AI" ya "Assistant" mat bol. Agar koi pooche "tu kaun hai" toh bol: "Yaar main Dev hoon, bas tera dost 😄"
- User jis language/script me likhe, usi me jawab de: Roman Hindi likhe to Hinglish me, Devanagari Hindi likhe to Hindi me, English likhe to English me.
- Emoji dostana tareeke se use kar — har line me nahi, jahan natural lage.
- Kisi bhi topic par baat kar — movies, life, advice, mazak, padhai, code sab.
- Galat ya harmful cheez ke liye seedha mana kar, par dostana tareeke se.
- Agar user chat ka summary ya message ka draft maange, to chat context ko dhyan se padh kar relevant jawab de.`;
}

export const DEV_SYSTEM_PROMPT = buildSystemPrompt('dost', 'friendly');

/** First name of the signed-in user; falls back to "dost". */
export function getUserFirstName(): string {
  try {
    const u: any = (authManager as any)?.user;
    const raw = u?.displayName || u?.username || '';
    const first = String(raw).split(/[\s_]+/)[0]?.trim();
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  } catch  { /* intentionally ignored */}
  return 'dost';
}

export function isDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

/* ------------------------------------------------------------------ */
/* App help — offline knowledge base (Hinglish guides)                 */
/* ------------------------------------------------------------------ */

interface HelpTopic {
  keys: string[];
  title: string;
  body: string;
}

const APP_HELP: HelpTopic[] = [
  {
    keys: ['vault', 'secret', 'chhupa', 'private note', 'notes'],
    title: 'Secret Vault',
    body: 'Vault me apne private notes aur photos rakh sakte ho — PIN se locked rehta hai. Khulne ke liye: Chats list se Vault kholo, apna PIN daalo. Note add karne ke liye + dabao. Dhyan rahe, Vault sirf is device par PIN se protected hai.',
  },
  {
    keys: ['saved', 'save message', 'saved message', 'bookmark'],
    title: 'Saved Messages',
    body: 'Kisi bhi message ko long-press karke Save karo — wo Saved Messages me aa jayega, jo chat list me sabse upar dikhta hai. Text, photo, video, voice note, file, poll, location, contact — sab kuch save hota hai. Unsave karne ke liye Saved Messages me jaakar Unsave dabao.',
  },
  {
    keys: ['lock', 'locked chat', 'hide', 'chhupa', 'chhupana', 'secret code'],
    title: 'Locked Chats',
    body: 'Chat ko lock karne ke liye: chat par long-press karo → Lock chat. Locked chats main list se gayab ho jate hain — wapas dekhne ke liye search bar me apna secret code type karo, phir PIN/biometric se khulta hai. Locked chats ki notifications me bhi naam/preview nahi dikhta.',
  },
  {
    keys: ['theme', 'wallpaper', 'colour', 'color', 'bubble', 'dark mode', 'light mode'],
    title: 'Chat Theme',
    body: 'Theme badalne ke liye: Settings → Chats → Default chat theme. Wahan se 15 themes me se chuno, ya Custom me apne colours, wallpaper aur brightness khud set karo. Light / Dark / System default bhi wahin se badalta hai. Kisi ek chat ka alag wallpaper bhi set kar sakte ho.',
  },
  {
    keys: ['scheduled', 'schedule', 'baad me bhejna', 'schedule message'],
    title: 'Scheduled Messages',
    body: 'Message ko baad me bhejne ke liye: chat me message likho, send button ko long-press karo → Schedule. Saare scheduled messages /scheduled screen par dikhte hain — wahan se edit ya delete bhi kar sakte ho. App khula ho to time par bhej deta hai.',
  },
  {
    keys: ['broadcast', 'bulk message', 'sabko ek saath'],
    title: 'Broadcast Lists',
    body: 'Ek message kai logon ko alag-alag bhejne ke liye Broadcast list banao: Chats screen se Broadcast → New list. Ek list me 256 tak log add kar sakte ho. Har kisi ko message alag chat me jata hai, group nahi banta.',
  },
  {
    keys: ['channel', 'announcement'],
    title: 'Channels',
    body: 'Channels me sirf admin post kar sakta hai, baaki sab sirf padhte hain. Channel join karne ke liye invite link chahiye. Apna channel banane ke liye Communities/Channels section me jao.',
  },
  {
    keys: ['status', 'story'],
    title: 'Status',
    body: 'Status lagane ke liye Updates tab me jao → My status. Photo, video ya text status laga sakte ho, 24 ghante me expire hota hai. Kaun dekh sakta hai ye Status privacy se set karo. Status par reply aur reaction bhi de sakte ho.',
  },
  {
    keys: ['call', 'video call', 'voice call'],
    title: 'Calls',
    body: 'Call karne ke liye chat kholo aur phone/video icon dabao, ya Calls tab se call karo. Call link bhi bana sakte ho — /call/:id link share karo, dusra us link se join karega. Missed calls Calls tab me dikhte hain.',
  },
  {
    keys: ['backup', 'export', 'account info', 'data'],
    title: 'Backup / Account Info',
    body: 'Apna data export karne ke liye: Settings → Account → Request account info. Ye tumhare chats ka .txt export banata hai. Delete account ke liye bhi wahin option hai — DELETE type karke password daalna padta hai.',
  },
  {
    keys: ['block', 'spam', 'report'],
    title: 'Block / Report',
    body: 'Kisi ko block karne ke liye: uski chat kholo → profile → Block. Blocked list Settings → Privacy → Blocked contacts me dikhti hai, wahan se Unblock bhi kar sakte ho. Spam report karne ke liye chat ke menu me Report spam hai.',
  },
  {
    keys: ['group', 'admin', 'join', 'invite link'],
    title: 'Groups',
    body: 'Group banane ke liye + dabao → New group. Admin members add/remove kar sakta hai, invite link expiry ke saath bana sakta hai, aur join approval on kar sakta hai. Group ka naam, description aur emoji bhi change kar sakte ho.',
  },
  {
    keys: ['app lock', 'pin', 'fingerprint', 'biometric', 'password'],
    title: 'App Lock',
    body: 'App Lock ke liye: Settings → Privacy → App lock. PIN set karo, phir app khulte hi PIN/biometric maangega. Auto-lock ka time bhi set kar sakte ho — Immediately se 1 hour tak. PIN bhool jao to Change PIN se badal lo.',
  },
  {
    keys: ['disappear', 'gayab', 'disappearing'],
    title: 'Disappearing Messages',
    body: 'Disappearing messages on karne ke liye: chat kholo → chat settings → Disappearing messages → 24 hours / 7 days / 90 days. Uske baad bheje gaye messages time ke baad gayab ho jayenge.',
  },
];

export function findAppHelp(text: string): { title: string; body: string } | null {
  const q = text.toLowerCase();
  for (const t of APP_HELP) {
    if (t.keys.some((k) => q.includes(k))) return { title: t.title, body: t.body };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Chat context                                                        */
/* ------------------------------------------------------------------ */

function normalizeMsg(m: any, myUid: string, nameById: Map<string, string>): DevChatMessage {
  const senderId = m.senderId || m.sender || m.from || '';
  const mine = senderId === myUid;
  const text = m.text || m.message || (m.mediaUrl ? '[Media]' : m.mediaType ? `[${m.mediaType}]` : '');
  const senderName = mine ? 'Maine' : nameById.get(senderId) || m.senderName || 'Unhone';
  const t = m.timestamp || m.createdAt || m.time;
  const time = t ? new Date(typeof t === 'number' ? t : Date.parse(t)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined;
  return { senderName, text: String(text), time, mine };
}

export async function loadChatContext(
  chatId: string,
  chatName: string,
  isGroup: boolean,
  myUid: string,
): Promise<DevChatContext> {
  const raw: any[] = db.getCollectionDocs(`chats/${chatId}/messages`) || [];
  const users: any[] = db.getCollectionDocs('users') || [];
  const nameById = new Map<string, string>();
  for (const u of users) {
    const n = u.displayName || u.name || u.username || '';
    if (u.id) nameById.set(u.id, n);
    if (u.uid) nameById.set(u.uid, n);
  }
  const sorted = [...raw].sort((a, b) => {
    const ta = a.timestamp || a.createdAt || 0;
    const tb = b.timestamp || b.createdAt || 0;
    return (typeof ta === 'number' ? ta : Date.parse(ta) || 0) - (typeof tb === 'number' ? tb : Date.parse(tb) || 0);
  });
  const messages = sorted
    .slice(-20)
    .map((m) => normalizeMsg(m, myUid, nameById))
    .filter((m) => m.text.trim().length > 0);
  return { chatId, chatName, isGroup, messages };
}

// ── AUDIT-2 C3: lazy picker loads ────────────────────────────────────────
// Before, listAttachableChats called db.getCollectionDocs() — which calls
// db.ensure(), a full fetch + one AppSync subscription — for EVERY
// registered user's message collection, just to fill the picker's
// last-message snippet. 1000 users = 1000 fetches + 1000 subscriptions
// (AppSync default limit: 100/connection) before the picker even paints.
// Now the option list is built from the already-loaded `users` / `chats`
// collections only (no per-user load), and the snippet is fetched lazily
// for at most CHAT_PICKER_LAST_TEXT_BUDGET chats, most-recently-seen
// first, at bounded concurrency. The rest show name-only rows (the picker
// renders lastText only when present — DevAIScreen.tsx:462) and can load
// their snippet on demand via loadChatLastText() when the row is rendered
// or tapped. loadChatContext() is already lazy — it loads the ONE chat the
// user actually attaches — and is unchanged. A server-side per-user
// conversation index (BACKEND-PLAN.md §16) is the full fix.
/** Max picker rows whose last-message snippet is pre-loaded. */
export const CHAT_PICKER_LAST_TEXT_BUDGET = 10;
const CHAT_PICKER_LAST_TEXT_CONCURRENCY = 4;

function lastTextOf(msgs: any[]): string {
  const last = msgs[msgs.length - 1];
  return last?.text || last?.message || '';
}

/**
 * Last-message snippet for ONE chat, on demand (picker row rendered /
 * tapped). Loads only that chat's collection — never the whole user list.
 */
export async function loadChatLastText(chatId: string): Promise<string> {
  try {
    await db.ensure(`chats/${chatId}/messages`);
    const msgs: any[] = db.getCollectionDocs(`chats/${chatId}/messages`) || [];
    return lastTextOf(msgs);
  } catch {
    return '';
  }
}

/** Chats the user can attach to Dev AI (DMs + groups). Locked chats are excluded. */
export async function listAttachableChats(myUid: string): Promise<ChatOption[]> {
  const out: ChatOption[] = [];
  try {
    const hidden = new Set(await loadHiddenChatIds(myUid).catch(() => [] as string[]));
    // W28: the attach picker used to list EVERY registered user, straight
    // from the whole `users` collection. Now it only offers people the user
    // has actually talked to or saved (same gate as the Calls / Status /
    // Broadcast / Admin pickers). Names/recency still come from the local
    // cache docs, but only for allowed uids — the cache is a lookup, never
    // the candidate list. Client-side hiding only; the wire-level
    // enumeration needs the backend users projection (BACKEND-PHASE).
    const allowed = new Set(getAllowedContactUids(myUid));
    const cacheByUid = new Map<string, any>();
    for (const u of db.getCollectionDocs('users') || []) {
      const uid = u?.id || u?.uid;
      if (uid && allowed.has(uid)) cacheByUid.set(uid, u);
    }
    // Most-recently-seen first: without loading any message collection,
    // lastSeen is the only recency signal, so the bounded snippet budget
    // goes to the chats the user most likely wants to attach.
    const dmCandidates = [...cacheByUid.entries()]
      .map(([uid, u]) => ({ u, uid }))
      .filter(({ uid }) => uid !== myUid && !hidden.has(uid))
      .sort((a, b) => (Number(b.u.lastSeen) || 0) - (Number(a.u.lastSeen) || 0));
    for (const { u, uid } of dmCandidates) {
      const name = u.displayName || u.name || u.username || uid;
      out.push({ id: getConversationId(myUid, uid), name, isGroup: false, lastText: '' });
    }
    // Groups: channel docs that carry a name/members (DM channels have no doc-level name).
    const channels: any[] = db.getCollectionDocs('chats') || [];
    for (const c of channels) {
      const id = c.id;
      if (!id || id.startsWith('saved_')) continue;
      const isGroupDoc = Array.isArray(c.members) || c.isGroup === true || (c.name && c.type !== 'dm');
      if (!isGroupDoc) continue;
      if (hidden.has(id)) continue;
      out.push({ id, name: c.name || c.title || 'Group', isGroup: true, lastText: '' });
    }
    // Lazy snippets: at most CHAT_PICKER_LAST_TEXT_BUDGET collections, in
    // list order (DMs most-recently-seen first), at bounded concurrency.
    // Every other row stays name-only until loadChatLastText() is called
    // for it (e.g. when its picker row renders).
    const budget = out.slice(0, CHAT_PICKER_LAST_TEXT_BUDGET);
    for (let i = 0; i < budget.length; i += CHAT_PICKER_LAST_TEXT_CONCURRENCY) {
      const chunk = budget.slice(i, i + CHAT_PICKER_LAST_TEXT_CONCURRENCY);
      await Promise.all(
        chunk.map(async (opt) => {
          opt.lastText = await loadChatLastText(opt.id);
        }),
      );
    }
  } catch (_) {
    // Picker degrades to "no chats found" — never crashes the screen.
  }
  return out;
}

/** Last N messages formatted for the model (and shown to the user before sending). */
export function buildChatContextSnippet(ctx: DevChatContext, myName: string): string {
  if (!ctx.messages.length) return `(Chat "${ctx.chatName}" me abhi koi message nahi hai.)`;
  const lines = ctx.messages.map((m) => `${m.mine ? myName : m.senderName}: ${m.text}`);
  return `Chat context — "${ctx.chatName}"${ctx.isGroup ? ' (group)' : ''}, aakhri ${lines.length} messages:\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* Offline fallback (no key / no network)                              */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  ('hai hein hain hoon ho the a an the is are was were to ka ki ke ko se ne par aur ya bhi ye wo yeh woh kya kaise kab kahan kaun kyon main mera meri mere tum aap apna apni tumhara tumhari uska uski uske iska iski iske ye ye hai hain tha thi the aur or but if then so very just not no yes ok theek chalo bhai yaar arre'.split(' ')),
);

export function summarizeChatLocally(ctx: DevChatContext, _myName: string): string {
  const msgs = ctx.messages;
  if (!msgs.length) return `"${ctx.chatName}" me abhi koi message nahi hai, isliye summary banane ke liye kuch nahi hai 🙂`;
  const mine = msgs.filter((m) => m.mine).length;
  const theirs = msgs.length - mine;
  const speakers = new Map<string, number>();
  for (const m of msgs) speakers.set(m.senderName, (speakers.get(m.senderName) || 0) + 1);
  const topSpeakers = [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} (${c})`).join(', ');
  const wordCount = new Map<string, number>();
  for (const m of msgs) {
    for (const w of m.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/)) {
      if (w.length > 2 && !STOPWORDS.has(w)) wordCount.set(w, (wordCount.get(w) || 0) + 1);
    }
  }
  const topics = [...wordCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w).join(', ');
  const last = msgs.slice(-3).map((m) => `• ${m.senderName}: ${m.text.slice(0, 120)}`).join('\n');
  return (
    `📝 "${ctx.chatName}" ka summary (offline):\n` +
    `• Kul ${msgs.length} messages dekhe — Maine ${mine}, samne se ${theirs}.\n` +
    (topSpeakers ? `• Sabse zyada: ${topSpeakers}.\n` : '') +
    (topics ? `• Baat-cheet in cheezon par thi: ${topics}.\n` : '') +
    `• Aakhri messages:\n${last}\n\n` +
    `Detail wala AI summary chahiye to Gemini key chahiye — key paste kar do, phir main behtar summary dunga 🙂`
  );
}

export function draftReplyLocally(ctx: DevChatContext, tone: DevTone): string {
  const lastIncoming = [...ctx.messages].reverse().find((m) => !m.mine);
  const topic = lastIncoming ? lastIncoming.text.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  const ref = topic ? `"${topic}" par ` : '';
  const drafts =
    tone === 'formal'
      ? [
          `Ji, aapki baat samajh gaya. ${ref}Main is par gaur karke aapko jald batata hoon. Dhanyavaad!`,
          `Aapka message mil gaya. ${ref}Main is baare me soch kar aapko reply karta hoon.`,
        ]
      : tone === 'funny'
        ? [
            `Arre wah 😂 ${ref}Ye to mast hai! Aur batao, aage kya scene hai?`,
            `Haha, sahi hai yaar 😄 ${ref}Chal, iska jawab to banta hai!`,
          ]
        : [
            `Haan, bilkul! ${ref}Tum sahi keh rahe ho 😄 Tum batao, aage kya karein?`,
            `Samajh gaya 👍 ${ref}Mujhe lagta hai ye theek rahega. Tum kya sochte ho?`,
          ];
  return (
    `✍️ Jawab ke options (offline draft — apne hisaab se edit karke bhejo):\n\n` +
    drafts.map((d, i) => `${i + 1}. ${d}`).join('\n\n') +
    `\n\nAur behtar, context-aware draft ke liye Gemini key chahiye 🙂`
  );
}

/** Friendly offline answer when there is no API key / no network. Returns null if nothing matches. */
export function getOfflineReply(text: string, opts: { context?: DevChatContext | null; tone: DevTone; userName: string }): string | null {
  const q = text.toLowerCase();
  if (/^(hi+|hello+|hey+|namaste|namaskar|hii+|helo+|salaam|good morning|good evening)[!.\s]*$/.test(q.trim())) {
    return `Arre ${opts.userName}! 😄 Kya chal raha hai? Main Dev hoon — baat kar sakte hain, ya main tumhari chat ka summary ya message ka draft bhi bana sakta hoon. Bas batao kya chahiye!`;
  }
  if (/\b(summary|summarise|summarize|summary de|saransh|chat ka summary)\b/.test(q) && opts.context) {
    return summarizeChatLocally(opts.context, opts.userName);
  }
  if (/\b(jawab|reply|draft|jawab likho|message likho)\b/.test(q) && opts.context) {
    return draftReplyLocally(opts.context, opts.tone);
  }
  const help = findAppHelp(text);
  if (help) return `📍 ${help.title}\n\n${help.body}\n\nAur kuch poochna ho to batao!`;
  if (/\b(tu kaun|tum kaun|who are you|tera naam|tumhara naam)\b/.test(q)) {
    return `Yaar main Dev hoon, bas tera dost 😄 Pinglo ke andar rehta hoon — baat kar sakta hoon, chat ka summary bana sakta hoon, message likhne me madad kar sakta hoon, aur app ke features samjha sakta hoon.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Models + provider fallback chain                                  */
/* ------------------------------------------------------------------ */

/**
 * Primary model — VERIFIED REAL (checked 2026-11-13 against Google's
 * official model docs at aistudio.google.com/docs/models and the
 * Gemini API release notes):
 * - `gemini-3.8-flash` — GA 2 Sep 2026, latest GA model in the Flash
 *   tier, Google's recommended model for new projects. Free tier is
 *   small (about 20 requests/day), so a cheaper model backs it up.
 * - `gemini-3.5-flash-lite` — GA 21 Jul 2026, low-cost tier, free tier
 *   about 500 requests/day.
 * - `gemini-3-flash-preview` — still listed by Google, kept as the
 *   last Gemini resort.
 * The planned names in earlier notes were correct — no invented model
 * is used anywhere here. Gemini STAYS primary (user's final word:
 * "Gemini rehne de"); the other providers below are fallbacks only,
 * and only run when their key exists in .env.
 *
 * W29 #259 (2026-11-15, live probe): gemini-3.8-flash HUNG — no
 * response at all in 35.0 s (parent saw the same at 30.8 s) — while
 * gemini-3.5-flash-lite answered HTTP 200 in ~1.7 s with the same
 * prompt and key. So 3.8-flash is DEMOTED below 3.5-flash-lite until
 * it recovers: the chain now tries 3.5 first, then 3.8, then preview.
 * 3.8 is NOT removed — if 3.5 ever fails, 3.8 is still tried (bounded
 * by the 15 s per-attempt timeout). Re-check 3.8 health before moving
 * it back to the front. DEV_AI_PRIMARY_MODEL follows the first model
 * in the chain (the Dev AI header shows it).
 */
export const DEV_AI_PRIMARY_MODEL = 'gemini-3.5-flash-lite';
export const DEV_AI_MODEL_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3-flash-preview',
] as const;

export type DevAIProvider = 'gemini' | 'nvidia' | 'groq' | 'openrouter' | 'pollinations';

/** Optional env key (never hardcoded, never logged). Empty = provider skipped. */
function getEnvKey(name: string): string {
  try {
    const env: any = (import.meta as any).env;
    return String(env?.[name] || '').trim();
  } catch (_) {
    return '';
  }
}

/** Which providers are actually configured right now (for the UI to say honestly). */
export function getConfiguredProviders(): DevAIProvider[] {
  const out: DevAIProvider[] = ['gemini', 'pollinations'];
  if (getEnvKey('VITE_NVIDIA_API_KEY')) out.splice(1, 0, 'nvidia');
  if (getEnvKey('VITE_GROQ_API_KEY')) out.push('groq');
  if (getEnvKey('VITE_OPENROUTER_API_KEY')) out.push('openrouter');
  return out;
}

/* ------------------------------------------------------------------ */
/* Photo generation (Pollinations — free, no key)                      */
/* ------------------------------------------------------------------ */

/**
 * Pollinations image API: GET https://image.pollinations.ai/prompt/{prompt}
 * Free, no signup, no key. Images are generated on first load and cached
 * by the CDN. Honest limits (from Pollinations' own docs): free anonymous
 * requests are rate-limited per IP (roughly one image at a time, tens of
 * seconds apart) and there is no uptime guarantee. Generated images are
 * public via their CDN URL — never use it for private photos.
 */
export function buildPhotoImageUrl(
  prompt: string,
  opts: { width?: number; height?: number; seed?: number } = {},
): string {
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const q = new URLSearchParams({
    width: String(opts.width ?? 1024),
    height: String(opts.height ?? 1024),
    model: 'flux',
    nologo: 'true',
    seed: String(seed),
  });
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.trim())}?${q.toString()}`;
}

/** Add style hints so "Ghibli style" / ad prompts actually look like it. */
export function enhancePhotoPrompt(raw: string): string {
  const q = raw.toLowerCase();
  let extra = '';
  if (/ghibli|studio ghibli|anime/.test(q)) {
    extra = ', Studio Ghibli style, hand-painted anime, soft watercolour, whimsical, warm light';
  } else if (/ad|advert|poster|banner|promotion/.test(q)) {
    extra = ', professional advertisement poster, clean layout, bold readable text, studio lighting';
  } else if (/logo/.test(q)) {
    extra = ', minimalist logo, flat vector style, clean background';
  }
  return raw.trim() + extra;
}

/**
 * Does the user want a photo generated from a text prompt?
 * True for "photo banao", "ghibli photo", "poster banao", "image generate
 * karo" etc. — but NOT for questions about a photo or asking Dev to look
 * at an attached image.
 *
 * W30: "bana ke do / banaa do / photo dedo" are common Hinglish spellings
 * of the same request — they used to fall through to the text chat, so the
 * user got a text answer instead of a photo. Bare "do" is deliberately NOT
 * a make-word: "do you know about this photo?" is a question, not a request.
 */
export function isPhotoRequest(text: string): boolean {
  const q = text.toLowerCase();
  const hasPhotoWord = /\b(photo|tasveer|tasvir|image|picture|pic|poster|wallpaper|art|drawing|painting|logo|banner|ghibli|anime)\b/.test(q);
  const hasMakeWord = /\b(banao|banado|banake|banaa|bana|generate|create|draw|design|bana do|banaa do|bana de|bana ke|bana ke do|banake do|dedo|de do|chahiye|dikhado|dikhao)\b/.test(q);
  return hasPhotoWord && hasMakeWord;
}

/**
 * Regenerate a Pollinations image URL with a fresh random seed, so a
 * failed / rate-limited generation can be retried as a NEW generation
 * instead of re-requesting the same (cached, failed) image. Non-Pollinations
 * URLs are returned unchanged — the caller must not mangle blob/data URLs.
 */
export function regeneratePhotoUrl(url: string): string {
  if (!url.includes('pollinations.ai')) return url;
  const fresh = String(Math.floor(Math.random() * 1_000_000));
  if (/([?&])seed=\d+/.test(url)) return url.replace(/([?&])seed=\d+/, `$1seed=${fresh}`);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}seed=${fresh}`;
}

/**
 * Does the user want THEIR OWN attached photo converted/edited
 * (e.g. "is photo ko Ghibli banao")? That is photo-to-photo conversion,
 * which is NOT available free — Pollinations' kontext model needs the
 * source image on a public URL, and this app has nowhere free/private to
 * host it. The screen answers this honestly instead of faking it.
 *
 * NEW-1: the old check matched bare style words (ghibli/anime/style/
 * painting/sketch), so a QUESTION about a photo's style ("is photo ka
 * style kaisa hai?") was refused as if it were a conversion request.
 * Now a conversion needs an imperative convert verb ("banao", "badlo",
 * "convert karo", "edit karo" …) — bare style words alone never trigger
 * it — and a how-to question ("convert kaise karte hain?") is exempt
 * unless it also carries a direct imperative ("banao"/"badlo"), which
 * wins over a trailing "?" ("is photo ko Ghibli banao?").
 */
export function isPhotoConvertRequest(text: string): boolean {
  const q = text.toLowerCase();
  const hasImperative = /\b(banao|bana do|bana de|banaa do|badlo|badal do|convert|transform|edit kar\w*|convert kar\w*|transform kar\w*|kar do|bana ke do)\b/.test(q);
  if (!hasImperative) return false;
  const isQuestion =
    /\b(kaisa|kaisi|kaise|kya|kyun|kab|kahan|kis|kaun|kon)\b/.test(q) ||
    /^(what|how|why|when|where|which|who)\b/.test(q) ||
    /\bhow (to|do|does|can)\b/.test(q) ||
    q.trim().endsWith('?');
  if (!isQuestion) return true;
  // Direct imperative still wins over a trailing "?" — "is photo ko
  // Ghibli banao?" IS a conversion request; "convert kaise karte hain?"
  // is a how-to question and is not.
  return /\b(banao|bana do|bana de|banaa do|badlo|badal do|bana ke do)\b/.test(q);
}

/**
 * Does the user want to SEE a photo Dev already generated in this chat
 * ("wo purani photo dikhao", "pehle wali photo dikhao")? NEW-2: this used
 * to fall into isPhotoRequest ("dikhao" is a make-word there) and start a
 * NEW generation. A bare "photo dikhao" (no reference to an existing one)
 * still means "generate one" — this only fires when the prompt points at
 * a photo that already exists. The screen shows the last generated photo
 * when one exists and only falls through to generation when none does.
 */
export function isShowExistingPhotoRequest(text: string): boolean {
  const q = text.toLowerCase();
  const hasPhotoWord = /\b(photo|tasveer|tasvir|image|picture|pic)\b/.test(q);
  const hasShowVerb = /\b(dikhao|dikhado|dikha do|dikha|show|dekho|dikhaiye)\b/.test(q);
  const hasExistingRef = /\b(purani|purana|pehle|pehli|pichli|pichla|wo|woh|us|ussi|last|dobara|phir se|wapas)\b/.test(q);
  return hasPhotoWord && hasShowVerb && hasExistingRef;
}

/** URL of the most recent photo Dev generated in this chat, or null. */
export function findLastGeneratedPhotoUrl(messages: { sender: string; image?: string }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Generated photos are dev messages with a Pollinations image URL.
    // User messages carry blob/data preview URLs of their own attachments.
    if (m.sender === 'dev' && m.image && m.image.includes('image.pollinations.ai')) return m.image;
  }
  return null;
}

/** Plain-language reply used when a photo-to-photo conversion is asked for. */
export function photoConvertNotAvailableReply(userName: string): string {
  return (
    `Yaar ${userName}, tumhari apni photo ko Ghibli style me badalna free me possible nahi hai 😅 ` +
    `Uske liye photo ko pehle kisi public link par upload karna padta hai, aur wo yahan se free/private tareeke se nahi hota. ` +
    `Lekin main prompt se nayi photo bana sakta hoon — bas batao kaisi photo chahiye, jaise "Ghibli style me ek gaon ki photo banao", aur main bana dunga 🎨`
  );
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

export function getGeminiApiKey(): string {
  try {
    const env: any = (import.meta as any).env;
    return env?.VITE_GEMINI_API_KEY || env?.GEMINI_API_KEY || localStorage.getItem('dt_gemini_api_key') || '';
  } catch (_) {
    return '';
  }
}

export type DevAIErrorKind = 'no-key' | 'network' | 'bad-key' | 'quota' | 'unknown';

export function friendlyErrorMessage(kind: DevAIErrorKind): string {
  switch (kind) {
    case 'no-key':
      return 'Bhai Gemini API key set nahi hai! 😅 https://aistudio.google.com/apikey se free key leke yahin chat me paste kar do — main save kar lunga, aur key sirf is device par rahegi. Tab tak main app ke features aur offline cheezon me madad kar sakta hoon.';
    case 'network':
      return 'Yaar network me gadbad lag rahi hai — internet check karke dobara try karo 😅 Tab tak main offline wale kaam kar sakta hoon: chat ka summary, message ka draft, ya app ke features samjhana.';
    case 'bad-key':
      return 'Arre, ye API key kaam nahi kar rahi — shayad galat ya expire ho gayi hai 😅 Sahi key yahin chat me paste kar do, main nayi key save kar lunga.';
    case 'quota':
      return 'Aaj ki AI limit khatam ho gayi lagti hai 😅 Thodi der baad try karo, ya phir offline wale kaam kar lete hain — summary, draft, app help.';
    default:
      return 'Yaar kuch gadbad ho gayi, thoda baad try kar 😅 Agar baar-baar ho raha hai to key dobara paste karke dekh lo.';
  }
}

export function classifyDevError(error: any): DevAIErrorKind {
  const msg = `${(error as any)?.message || ''} ${(error as any)?.status || ''}`.toLowerCase();
  if (/network|fetch failed|failed to fetch|econn|offline|timeout|timed out/.test(msg)) return 'network';
  if (/api key not valid|api_key_invalid|invalid key|401|403|permission_denied|unauthenticated/.test(msg)) return 'bad-key';
  if (/quota|429|resource_exhausted|rate limit/.test(msg)) return 'quota';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* Per-attempt timeout (#259)                                          */
/* ------------------------------------------------------------------ */

/**
 * Per-attempt timeout for EVERY model attempt in the chain (Gemini,
 * NVIDIA/Groq/OpenRouter, Pollinations). #259: the Gemini fetch had NO
 * timeout of its own — only the UI cancel signal — so when the primary
 * model hung (gemini-3.8-flash: no response in 30+ s, live-probed
 * 2026-11-15), the call never returned or threw, the fallback chain
 * never ran, and the UI spun forever. A hung attempt must now fall
 * through to the next model within this timeout instead.
 */
export const DEV_AI_ATTEMPT_TIMEOUT_MS = 15_000;

interface AttemptScope {
  /** Signal to pass to the fetch/SDK call: aborts on timeout OR outer cancel. */
  signal: AbortSignal;
  /** True only when OUR timer fired — an outer abort is a user cancel, not a timeout. */
  timedOut: () => boolean;
  cleanup: () => void;
}

/** Exported for the W29 harness test (mock): the timeout helper is the
 *  mechanism every attempt path shares, so its semantics are tested
 *  directly with a hung promise instead of waiting on a live hang. */
export function withAttemptTimeout(outer?: AbortSignal, timeoutMs: number = DEV_AI_ATTEMPT_TIMEOUT_MS): AttemptScope {
  const controller = new AbortController();
  let timeoutFired = false;
  const timer = setTimeout(() => {
    timeoutFired = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timeoutFired,
    cleanup: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

/** Error thrown when our per-attempt timer fires (outer signal NOT aborted). */
function attemptTimeoutError(model: string): Error {
  return new Error(`Dev AI attempt timed out after ${DEV_AI_ATTEMPT_TIMEOUT_MS / 1000}s (model ${model})`);
}

export async function generateDevReply(args: {
  apiKey: string;
  historyText: string;
  prompt: string;
  imagePart?: { inlineData: { data: string; mimeType: string } } | null;
  chatContextSnippet?: string;
  tone: DevTone;
  userName: string;
  signal?: AbortSignal;
}): Promise<string> {
  const systemInstruction = buildSystemPrompt(args.userName, args.tone);
  const contextBlock = args.chatContextSnippet ? `${args.chatContextSnippet}\n\n` : '';
  const userLine = `${contextBlock}${args.historyText}\nUser: ${args.prompt}`;

  // Vision (attached image) only works through Gemini — the text
  // fallbacks below are text-only, so never send them an image and
  // pretend it was seen. If Gemini fails with an image, fail honestly.
  if (args.imagePart) {
    return generateViaGemini(args.apiKey, args, systemInstruction, userLine);
  }

  // 1) Gemini — try each model in the chain (capable first, cheap next).
  //    A 404/429/quota error on one model falls through to the next.
  //    Overnight round 2, Part 3: with NO key, Gemini throws a
  //    non-retryable 400 ("API key not valid") on the first model and the
  //    throw below used to skip steps 2-3 entirely — so the keyless
  //    Pollinations path was unreachable exactly when it was most needed
  //    (key lost, .env empty). Skip Gemini outright when apiKey is empty;
  //    the keyed fallbacks and Pollinations below still run.
  // eslint-disable-next-line no-useless-assignment -- the `= null` init is dead (the Pollinations catch below always assigns before the throw), but TS definite-assignment needs an initializer: the assignments live inside loop/catch bodies it cannot prove run.
  let lastError: any = null;
  if (args.apiKey) {
  for (const model of DEV_AI_MODEL_CHAIN) {
    try {
      return await generateViaGeminiModel(args.apiKey, model, args, systemInstruction, userLine);
    } catch (e) {
      if (args.signal?.aborted) throw e;
      if (!isRetryableModelError(e)) throw e;
    }
  }
  }

  // 2) Provider fallbacks — each runs ONLY if its key exists in .env.
  //    Order: NVIDIA NIM → Groq → OpenRouter :free (all OpenAI-compatible).
  const openAIProviders: Array<{
    name: Exclude<DevAIProvider, 'gemini' | 'pollinations'>;
    envKey: string;
    url: string;
    model: string;
    headers: (key: string) => Record<string, string>;
  }> = [
    {
      name: 'nvidia',
      envKey: 'VITE_NVIDIA_API_KEY',
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      model: 'meta/llama-3.1-70b-instruct',
      headers: (k) => ({ Authorization: `Bearer ${k}` }),
    },
    {
      name: 'groq',
      envKey: 'VITE_GROQ_API_KEY',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      headers: (k) => ({ Authorization: `Bearer ${k}` }),
    },
    {
      name: 'openrouter',
      envKey: 'VITE_OPENROUTER_API_KEY',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      headers: (k) => ({
        Authorization: `Bearer ${k}`,
        'HTTP-Referer': 'https://dtchats.app',
        'X-Title': 'Pinglo Dev AI',
      }),
    },
  ];
  for (const p of openAIProviders) {
    const key = getEnvKey(p.envKey);
    if (!key) continue; // not configured — skip gracefully, never ask for it in code
    try {
      return await openAICompatibleChat({
        url: p.url,
        apiKey: key,
        model: p.model,
        extraHeaders: p.headers(key),
        system: systemInstruction,
        user: userLine,
        signal: args.signal,
      });
    } catch (e) {
      if (args.signal?.aborted) throw e;
    }
  }

  // 3) Pollinations text — free, no key, last resort.
  try {
    return await generateViaPollinationsText(systemInstruction, userLine, args.signal);
  } catch (e) {
    lastError = e;
  }

  throw lastError || new Error('Dev AI: all providers failed');
}

/** 404 (model not found) / 429 / quota errors are worth retrying on the next model. */
function isRetryableModelError(error: any): boolean {
  const msg = `${(error as any)?.message || ''} ${(error as any)?.status || ''}`.toLowerCase();
  // #259: a per-attempt timeout (or an aborted attempt that was NOT a UI
  // cancel — the callers rethrow first when args.signal.aborted) must
  // fall through to the next model, not stop the chain.
  return /404|not.?found|429|quota|resource_exhausted|rate limit|overloaded|503|500|timed?\s?out|abort/.test(msg);
}

/** One Gemini model attempt (text or vision). */
async function generateViaGeminiModel(
  apiKey: string,
  model: string,
  args: {
    prompt: string;
    imagePart?: { inlineData: { data: string; mimeType: string } } | null;
    signal?: AbortSignal;
  },
  systemInstruction: string,
  userLine: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const parts: any[] = [{ text: args.prompt || "What's in this image?" }];
  if (args.imagePart) parts.unshift(args.imagePart);
  const contents: any = args.imagePart ? parts : userLine;
  // #259: per-attempt timeout. The combined signal aborts the SDK's
  // fetch (it forwards abortSignal), AND the race below guarantees
  // fall-through within the timeout even if the SDK ever swallows the
  // signal — a hung model must never spin the UI forever again. A
  // timeout here throws attemptTimeoutError, which isRetryableModelError
  // matches, so the chain moves to the next model. A UI cancel (outer
  // signal aborted) still rethrows as AbortError.
  const scope = withAttemptTimeout(args.signal);
  if (scope.signal.aborted && args.signal?.aborted) {
    scope.cleanup();
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          abortSignal: scope.signal,
        },
      }),
      new Promise<never>((_, reject) => {
        scope.signal.addEventListener(
          'abort',
          () => {
            if (scope.timedOut() && !args.signal?.aborted) reject(attemptTimeoutError(model));
            else reject(new DOMException('The operation was aborted', 'AbortError'));
          },
          { once: true },
        );
      }),
    ]);
    return response.text || 'Yaar kuch gadbad ho gayi, thoda baad try kar 😅';
  } catch (e) {
    if (scope.timedOut() && !args.signal?.aborted) throw attemptTimeoutError(model);
    throw e;
  } finally {
    scope.cleanup();
  }
}

/** Gemini chain for the vision path (image attached): try each model in order. */
async function generateViaGemini(
  apiKey: string,
  args: {
    prompt: string;
    imagePart?: { inlineData: { data: string; mimeType: string } } | null;
    signal?: AbortSignal;
  },
  systemInstruction: string,
  userLine: string,
): Promise<string> {
  let lastError: any = null;
  for (const model of DEV_AI_MODEL_CHAIN) {
    try {
      return await generateViaGeminiModel(apiKey, model, args, systemInstruction, userLine);
    } catch (e) {
      lastError = e;
      if (args.signal?.aborted) throw e;
      if (!isRetryableModelError(e)) throw e;
    }
  }
  throw lastError || new Error('Dev AI: Gemini failed');
}

/** Minimal OpenAI-compatible chat-completions call (NVIDIA / Groq / OpenRouter). */
async function openAICompatibleChat(args: {
  url: string;
  apiKey: string;
  model: string;
  extraHeaders: Record<string, string>;
  system: string;
  user: string;
  signal?: AbortSignal;
}): Promise<string> {
  // #259: same per-attempt timeout as the Gemini path — a hung fallback
  // must fall through (or fail visibly) within 15 s, never spin forever.
  // fetch honours the combined signal natively; a timeout abort throws
  // attemptTimeoutError so the caller can tell it apart from a UI cancel.
  const scope = withAttemptTimeout(args.signal);
  if (scope.signal.aborted && args.signal?.aborted) {
    scope.cleanup();
    throw new DOMException('The operation was aborted', 'AbortError');
  }
  try {
    const res = await fetch(args.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...args.extraHeaders },
      body: JSON.stringify({
        model: args.model,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
      signal: scope.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty reply from fallback provider');
    return text.trim();
  } catch (e) {
    if (scope.timedOut() && !args.signal?.aborted) throw attemptTimeoutError(args.model);
    throw e;
  } finally {
    scope.cleanup();
  }
}

/** Pollinations text — free, no key. OpenAI-compatible endpoint, model `openai`. */
async function generateViaPollinationsText(
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  // #259: the old bespoke 30 s AbortController that lived here is gone —
  // the per-attempt timeout now lives in openAICompatibleChat, so this
  // keyless last resort shares the same unified 15 s cap as every other
  // attempt in the chain. The caller's (UI cancel) signal still aborts
  // it sooner when the UI cancels.
  return openAICompatibleChat({
    url: 'https://text.pollinations.ai/openai',
    apiKey: '',
    model: 'openai',
    extraHeaders: {},
    system,
    user,
    signal,
  });
}
