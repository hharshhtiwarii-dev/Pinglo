/**
 * Message translation (Worker 3).
 *
 * Client-side translation with NO API key and NO signup, exactly as
 * specced. Two free no-key providers, tried in order:
 *
 * 1. MyMemory (https://api.mymemory.translated.net) — public, no key.
 * 2. LibreTranslate public instance (https://libretranslate.com, then the
 *    Argos Open Tech mirror) — public, no key.
 *
 * Honest limits — read before promising anything to the user:
 * - These are free, rate-limited public endpoints. MyMemory's anonymous
 *   tier is small (a few hundred characters per request, daily quota) and
 *   LibreTranslate's public instance may 403/429 or start requiring a key
 *   at any time. Translation WILL fail sometimes; when it does this module
 *   returns an honest `error` and NEVER invents translated text.
 * - Quality varies by language pair and is machine translation — it can
 *   be wrong, especially for slang, Hinglish, and long messages.
 * - There is NO offline translation here. Language detection is offline
 *   (a script + stopword heuristic, see `detectLanguage`), but actual
 *   translation always needs the network. If the device is offline the
 *   call fails fast with a clear error instead of hanging.
 * - Long messages are split into ~450-char chunks (MyMemory's anonymous
 *   per-request limit) and translated piece by piece; if any chunk fails,
 *   the whole translation fails honestly rather than returning a partial
 *   text presented as complete.
 *
 * A local cache (memory + localStorage, 200 entries) makes re-translating
 * the same message into the same language instant and saves quota.
 *
 * AUDIT-2 A10 — privacy: translation always sends the message text to an
 * outside service (MyMemory / LibreTranslate) over the internet, and
 * MyMemory only offers GET, so the text travels in the URL's query
 * string (it can appear in server/proxy logs). MyMemory documents GET
 * only (a POST probe on 2026-11-14 returned no usable response), so
 * there is no POST switch to make — instead, translation NEVER runs
 * silently: the first translation needs the user's explicit consent
 * (`TranslateOptions.consentGiven` or the stored `hasTranslationConsent`
 * flag, set by an inline confirm in the UI). Cached results and
 * same-language "translations" need no consent — nothing leaves the
 * device for those.
 */

/** Languages offered as translation targets in the sheet. */
export interface TranslateLanguage {
  code: string;
  label: string;
  nativeLabel: string;
}

export const SUPPORTED_TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português' },
  { code: 'it', label: 'Italian', nativeLabel: 'Italiano' },
  { code: 'nl', label: 'Dutch', nativeLabel: 'Nederlands' },
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية' },
  { code: 'ru', label: 'Russian', nativeLabel: 'Русский' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
  { code: 'zh-CN', label: 'Chinese (Simplified)', nativeLabel: '中文' },
  { code: 'bn', label: 'Bengali', nativeLabel: 'বাংলা' },
  { code: 'ta', label: 'Tamil', nativeLabel: 'தமிழ்' },
  { code: 'te', label: 'Telugu', nativeLabel: 'తెలుగు' },
  { code: 'ur', label: 'Urdu', nativeLabel: 'اردو' },
  { code: 'mr', label: 'Marathi', nativeLabel: 'मराठी' },
  { code: 'tr', label: 'Turkish', nativeLabel: 'Türkçe' },
];

export type TranslateProvider = 'mymemory' | 'libretranslate' | 'cache' | 'none';

export interface TranslateResult {
  /** Translated text. Absent when `error` is set — never a fake translation. */
  text?: string;
  /** Detected source language (BCP-47-ish code, e.g. 'en', 'hi'). */
  detectedLang?: string;
  /** Which provider produced this result. 'none' = no translation needed. */
  provider?: TranslateProvider;
  /** Honest failure reason, safe to show to the user. Absent on success. */
  error?: string;
  /**
   * True when the call was refused because the user has not consented to
   * sending the text to an outside service. The UI must show the consent
   * confirm (see TRANSLATION_PRIVACY_NOTICE) instead of retrying silently.
   */
  needsConsent?: boolean;
}

export interface DetectedLanguage {
  lang: string;
  /** 'high' when a non-Latin script was found; 'low' for Latin-script guesses. */
  confidence: 'high' | 'low';
  method: 'heuristic';
}

const REQUEST_TIMEOUT_MS = 8000;
const MAX_TEXT_CHARS = 5000;
const CHUNK_CHARS = 450;
const CACHE_KEY = 'dt_translation_cache_v1';
const CACHE_MAX_ENTRIES = 200;

// ── Language detection (offline heuristic) ──────────────────────────────────

function countInRange(text: string, lo: number, hi: number): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= lo && cp <= hi) n++;
  }
  return n;
}

const STOPWORDS: Record<string, string[]> = {
  es: [' el ', ' la ', ' los ', ' las ', ' que ', ' de ', ' en ', ' y ', ' es ', ' un ', ' una ', ' por ', ' con ', ' no ', ' se ', ' su ', ' para ', ' está ', ' hola ', ' gracias '],
  fr: [' le ', ' la ', ' les ', ' de ', ' des ', ' que ', ' et ', ' est ', ' un ', ' une ', ' dans ', ' pour ', ' pas ', ' je ', ' tu ', ' nous ', ' vous ', ' merci ', ' bonjour '],
  de: [' der ', ' die ', ' das ', ' und ', ' ist ', ' ein ', ' eine ', ' von ', ' mit ', ' nicht ', ' ich ', ' du ', ' wir ', ' für ', ' danke ', ' hallo '],
  pt: [' o ', ' a ', ' os ', ' as ', ' que ', ' de ', ' em ', ' e ', ' é ', ' um ', ' uma ', ' para ', ' com ', ' não ', ' se ', ' obrigado ', ' olá '],
  it: [' il ', ' lo ', ' la ', ' gli ', ' che ', ' di ', ' e ', ' è ', ' un ', ' una ', ' per ', ' con ', ' non ', ' io ', ' tu ', ' grazie ', ' ciao '],
  nl: [' de ', ' het ', ' een ', ' van ', ' ik ', ' je ', ' het ', ' in ', ' is ', ' een ', ' op ', ' te ', ' dat ', ' hij ', ' zij ', ' dank ', ' hallo '],
};

/**
 * Guess the language of a message WITHOUT any network call.
 * Script detection is reliable (Devanagari => Hindi, etc.); Latin-script
 * text is only a stopword guess and defaults to English. This is a
 * heuristic, not a guarantee — the result is labelled as such wherever
 * it is shown.
 */
export function detectLanguage(text: string): DetectedLanguage {
  const t = (text || '').trim();
  if (!t) return { lang: 'en', confidence: 'low', method: 'heuristic' };
  const len = Math.max([...t].length, 1);

  const scriptChecks: Array<[number, number, string]> = [
    [0x0900, 0x097f, 'hi'], // Devanagari
    [0x0980, 0x09ff, 'bn'], // Bengali
    [0x0b80, 0x0bff, 'ta'], // Tamil
    [0x0c00, 0x0c7f, 'te'], // Telugu
    [0x0a80, 0x0aff, 'gu'], // Gujarati
    [0x0a00, 0x0a7f, 'pa'], // Gurmukhi
    [0x0600, 0x06ff, 'ar'], // Arabic (also Urdu — see below)
    [0x0400, 0x04ff, 'ru'], // Cyrillic
    [0x3040, 0x30ff, 'ja'], // Hiragana + Katakana
    [0xac00, 0xd7af, 'ko'], // Hangul
    [0x4e00, 0x9fff, 'zh-CN'], // Han
  ];
  for (const [lo, hi, lang] of scriptChecks) {
    if (countInRange(t, lo, hi) / len > 0.3) {
      // Arabic script with Urdu-only letters leans Urdu, not Arabic.
      if (lang === 'ar' && /[ٹڈڑںے]/.test(t)) return { lang: 'ur', confidence: 'high', method: 'heuristic' };
      return { lang, confidence: 'high', method: 'heuristic' };
    }
  }

  // Latin script: score a small stopword list per language.
  const padded = ` ${t.toLowerCase()} `;
  let best: string | null = null;
  let bestScore = 0;
  for (const [lang, words] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const w of words) if (padded.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  if (best && bestScore >= 2) return { lang: best, confidence: 'low', method: 'heuristic' };
  return { lang: 'en', confidence: 'low', method: 'heuristic' };
}

// ── Cache (memory + localStorage) ───────────────────────────────────────────

interface CacheEntry {
  text: string;
  detectedLang: string;
  provider: TranslateProvider;
  at: number;
}

const memoryCache = new Map<string, CacheEntry>();
let cacheHydrated = false;

function cacheKey(text: string, sourceLang: string, targetLang: string): string {
  return `${sourceLang}|${targetLang}|${text}`;
}

function hydrateCache(): void {
  if (cacheHydrated) return;
  cacheHydrated = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const entries = JSON.parse(raw) as Array<[string, CacheEntry]>;
    if (!Array.isArray(entries)) return;
    for (const [k, v] of entries.slice(0, CACHE_MAX_ENTRIES)) {
      if (v && typeof v.text === 'string') memoryCache.set(k, v);
    }
  } catch { /* intentionally ignored */}
}

function persistCache(): void {
  try {
    const entries = [...memoryCache.entries()].slice(-CACHE_MAX_ENTRIES);
    localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
  } catch { /* intentionally ignored */}
}

function cacheGet(key: string): CacheEntry | undefined {
  hydrateCache();
  return memoryCache.get(key);
}

function cacheSet(key: string, entry: CacheEntry): void {
  memoryCache.set(key, entry);
  while (memoryCache.size > CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
  persistCache();
}

/** Clear the local translation cache (Settings can wire this to a button). */
export function clearTranslationCache(): void {
  memoryCache.clear();
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch { /* intentionally ignored */}
}

// ── Consent (AUDIT-2 A10) ─────────────────────────────────────────────────

/**
 * Shown in the UI confirm before the first translation. States plainly
 * that the text leaves the device — including that MyMemory carries it in
 * the URL itself, so it can appear in server/proxy logs.
 */
export const TRANSLATION_PRIVACY_NOTICE =
  'Translation sends this message’s text to a free public translation service (MyMemory / LibreTranslate) over the internet. ' +
  'The text leaves your device and may be logged by that service — MyMemory even carries it in the web address itself. ' +
  'Only translate messages you are happy to share.';

export const TRANSLATION_CONSENT_REQUIRED_MESSAGE =
  'Translation needs your permission first — it sends the message text to an outside translation service.';

const CONSENT_KEY = 'dt_translation_consent_v1';

/** True once the user has explicitly consented (remembered on this device). */
export function hasTranslationConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'granted';
  } catch {
    return false;
  }
}

/** Remember (or withdraw) the user's translation consent on this device. */
export function setTranslationConsent(granted: boolean): void {
  try {
    if (granted) localStorage.setItem(CONSENT_KEY, 'granted');
    else localStorage.removeItem(CONSENT_KEY);
  } catch {
    /* consent cannot be persisted: the caller must pass consentGiven per call */
  }
}

// ── Providers ───────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normaliseLangFor(provider: 'mymemory' | 'libretranslate', code: string): string {
  if (provider === 'libretranslate') return code === 'zh-CN' ? 'zh' : code;
  return code; // MyMemory accepts zh-CN
}

/** MyMemory public API. Throws on any failure; never returns fake text. */
async function translateViaMyMemory(text: string, source: string, target: string): Promise<string> {
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(normaliseLangFor('mymemory', source))}|${encodeURIComponent(normaliseLangFor('mymemory', target))}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {});
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Translation timed out. Please try again.');
    throw new Error('Could not reach the translation service. Check your connection and try again.');
  }
  if (res.status === 429) throw new Error('Translation service is busy (rate limit). Please try again in a bit.');
  if (!res.ok) throw new Error('Translation service is unavailable right now. Please try again later.');
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error('Translation service returned an unreadable response.');
  }
  const translated = data?.responseData?.translatedText;
  const status = data?.responseStatus;
  if (typeof translated !== 'string' || !translated.trim()) {
    throw new Error('Translation service returned no translation.');
  }
  if (/QUERY LENGTH LIMIT EXCEEDED|INVALID TARGET LANGUAGE|INVALID SOURCE LANGUAGE|MYMEMORY WARNING/i.test(translated)) {
    throw new Error('Translation service refused this text (limit or unsupported language).');
  }
  if (status !== 200 && status !== '200') {
    throw new Error('Translation service returned an error. Please try again.');
  }
  return translated;
}

/** LibreTranslate public instance(s). Throws on any failure. */
async function translateViaLibreTranslate(text: string, source: string, target: string): Promise<string> {
  const endpoints = [
    'https://libretranslate.com/translate',
    'https://translate.argosopentech.com/translate',
  ];
  let lastError = 'Translation service is unavailable right now. Please try again later.';
  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: text,
          source: normaliseLangFor('libretranslate', source),
          target: normaliseLangFor('libretranslate', target),
          format: 'text',
        }),
      });
      if (res.status === 403 || res.status === 429) {
        lastError = 'Translation service is busy (rate limit). Please try again in a bit.';
        continue;
      }
      if (!res.ok) continue;
      const data: any = await res.json().catch(() => null);
      const translated = data?.translatedText;
      if (typeof translated === 'string' && translated.trim()) return translated;
    } catch (e: any) {
      lastError =
        e?.name === 'AbortError'
          ? 'Translation timed out. Please try again.'
          : 'Could not reach the translation service. Check your connection and try again.';
    }
  }
  throw new Error(lastError);
}

// ── Chunking (MyMemory anonymous requests are short) ────────────────────────

function splitIntoChunks(text: string): string[] {
  if ([...text].length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if ([...rest].length <= CHUNK_CHARS) {
      chunks.push(rest);
      break;
    }
    // Prefer a sentence/word boundary before the limit.
    const cut = rest.slice(0, CHUNK_CHARS);
    const boundary = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('\n'),
      cut.lastIndexOf(' '),
    );
    const take = boundary > CHUNK_CHARS * 0.5 ? boundary + 1 : CHUNK_CHARS;
    chunks.push(rest.slice(0, take));
    rest = rest.slice(take);
  }
  return chunks;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface TranslateOptions {
  /** Override auto-detection (e.g. when the user corrects it in the sheet). */
  sourceLang?: string;
  /**
   * Explicit one-shot consent for THIS call (the UI confirm passes it).
   * When absent, the remembered `hasTranslationConsent()` flag is used.
   * Without either, the call is refused with `needsConsent: true` and no
   * network request is made.
   */
  consentGiven?: boolean;
}

/**
 * Translate a message into `targetLang`.
 *
 * - Empty text / text over 5000 chars: honest error, no network call.
 * - Source == target: returns the original text, provider `'none'`.
 * - Cache hit: instant, provider `'cache'`, no consent needed (local only).
 * - No consent (`opts.consentGiven` / remembered flag): refused with
 *   `{ error, needsConsent: true }` and NO network call — the UI must
 *   show the consent confirm first.
 * - Otherwise MyMemory first, LibreTranslate second. Any failure returns
 *   `{ error }` with `text` unset — the caller must show the error, never
 *   a made-up translation.
 */
export async function translateMessage(
  text: string,
  targetLang: string,
  opts: TranslateOptions = {},
): Promise<TranslateResult> {
  const input = (text || '').trim();
  if (!input) return { error: 'Nothing to translate.' };
  if ([...input].length > MAX_TEXT_CHARS) {
    return { error: `Message is too long to translate (${MAX_TEXT_CHARS} characters max).` };
  }
  const target = (targetLang || 'en').trim();
  if (!SUPPORTED_TRANSLATE_LANGUAGES.some((l) => l.code === target)) {
    return { error: `Language "${target}" is not supported for translation.` };
  }

  const detected = opts.sourceLang?.trim() || detectLanguage(input).lang;
  if (detected === target || (detected === 'zh-CN' && target === 'zh-CN')) {
    return { text: input, detectedLang: detected, provider: 'none' };
  }

  const key = cacheKey(input, detected, target);
  const cached = cacheGet(key);
  if (cached) {
    return { text: cached.text, detectedLang: cached.detectedLang, provider: 'cache' };
  }

  // AUDIT-2 A10: no silent send. A cache hit above already returned, so
  // anything reaching here would put the text on the network — refuse
  // without explicit consent (one-shot for this call, or remembered).
  if (opts.consentGiven !== true && !hasTranslationConsent()) {
    return { detectedLang: detected, error: TRANSLATION_CONSENT_REQUIRED_MESSAGE, needsConsent: true };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { detectedLang: detected, error: 'You appear to be offline. Translation needs an internet connection.' };
  }

  const chunks = splitIntoChunks(input);
  const providers: Array<{ name: TranslateProvider; fn: (t: string, s: string, g: string) => Promise<string> }> = [
    { name: 'mymemory', fn: translateViaMyMemory },
    { name: 'libretranslate', fn: translateViaLibreTranslate },
  ];

  let lastError = 'Translation failed. Please try again.';
  for (const provider of providers) {
    try {
      const parts: string[] = [];
      for (const chunk of chunks) {
        parts.push(await provider.fn(chunk, detected, target));
      }
      const joined = parts.join('');
      if (!joined.trim()) throw new Error('Translation service returned no translation.');
      cacheSet(key, { text: joined, detectedLang: detected, provider: provider.name, at: Date.now() });
      return { text: joined, detectedLang: detected, provider: provider.name };
    } catch (e: any) {
      lastError = e?.message || lastError;
      // Fall through to the next provider; only the last error surfaces.
    }
  }
  return { detectedLang: detected, error: lastError };
}
