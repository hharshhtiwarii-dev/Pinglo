/**
 * GIF provider — Giphy + mandatory IndexedDB cache (REPORT-3 #203,
 * FIX-REPORT-3 §18, user decision 2026-11-15).
 *
 * Provider: Giphy ONLY.
 * - Endpoints: `GET https://api.giphy.com/v1/gifs/search`
 *   (`api_key` + `q` + `limit`) and `GET
 *   https://api.giphy.com/v1/gifs/trending` (`api_key` + `limit`).
 * - The key comes from app config (`VITE_GIPHY_API_KEY` via
 *   `import.meta.env`). It is NEVER hard-coded, pasted, copied or
 *   embedded anywhere in this file. There is NO demo-key fallback: the
 *   key comes from the environment only. If the key is missing at
 *   runtime, the GIF tab shows an honest error instead of falling back.
 * - No fallback to Klipy (its key is stuck in TESTING status, unverified)
 *   and no fallback to Tenor (Google shut the Tenor GIF API down on
 *   June 30, 2026).
 *
 * Caching (mandatory — the Giphy beta key is limited to 100 calls/hour):
 * - IndexedDB (`pinglo-giphy-cache`), persists across sessions.
 * - Cache-first on open: render from cache immediately; spend an API call
 *   only when the entry is missing or its TTL has expired.
 * - Trending: one entry, TTL 1 hour. Search: one entry per query string,
 *   TTL 24 hours, capped at ~50 stored queries (oldest evicted first).
 * - Stale-serve on failure: on 401/403/429 or network failure, serve the
 *   stale cached entry (even past TTL) with an honest note instead of
 *   failing empty. On 429 specifically, stop API calls until the hour
 *   window passes.
 * - Budget guard: a lightweight in-memory count of API calls in the
 *   current hour; approaching the 100/hour limit stops calls and serves
 *   cache only. 20 picker opens in an hour must cost ~0–2 calls, not 20.
 *
 * Emoji stays fully local (no emoji path calls any network API) and local
 * sticker packs stay local — see stickerPack.ts. The StickerPicker GIF
 * tab uses this same code path as the chat GIF picker (not a second
 * client).
 *
 * Key status: the Giphy beta key was VERIFIED WORKING at connector level
 * (2026-11-15), but it is NOT in the app's `.env` and this file must not
 * put it there. In-app live verification is PENDING-KEY-IN-ENV.
 */
import type { GifDef } from '../components/stickerPack';

const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';
const GIF_LIMIT = 24;

/** Giphy beta-key hourly budget is 100 calls/hour; stop calling when the
 *  in-memory count in the current hour reaches this, and serve cache. */
const BUDGET_STOP_AT = 90;

const TRENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SEARCH_ENTRIES = 50;

const CACHE_DB = 'pinglo-giphy-cache';
const CACHE_STORE = 'entries';
const BLOCKED_UNTIL_KEY = 'dt_giphy_blocked_until';

/** Read the Giphy key from app config. Empty string when not configured. */
export function getGiphyApiKey(): string {
  try {
    return (
      (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as { env?: Record<string, string | undefined> }).env
          ?.VITE_GIPHY_API_KEY) ||
      ''
    ).trim();
  } catch {
    return '';
  }
}

export function isGiphyConfigured(): boolean {
  return getGiphyApiKey().length > 0;
}

/** Thrown (as a rejected promise) when no key is configured and there is
 *  no stale cache to serve. The picker renders the message honestly. */
export class GiphyKeyMissingError extends Error {
  constructor() {
    super('GIFs unavailable — key not configured');
    this.name = 'GiphyKeyMissingError';
  }
}

export interface GifResult {
  gifs: GifDef[];
  /** True when the GIFs came from the IndexedDB cache (no API call spent). */
  fromCache: boolean;
  /** True when the entry served is past its TTL (failure / no-key path). */
  stale: boolean;
  /** Honest note for the picker UI, e.g. "Showing saved GIFs — offline". */
  note?: string;
}

// ── IndexedDB cache ─────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  kind: 'trending' | 'search';
  query?: string;
  gifs: GifDef[];
  savedAt: number;
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(CACHE_STORE)) {
        req.result.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open GIF cache'));
  });
}

function idbTx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openCacheDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let req: IDBRequest<T>;
        try {
          req = run(db.transaction(CACHE_STORE, mode).objectStore(CACHE_STORE));
        } catch (e) {
          try { db.close(); } catch { /* intentionally ignored */}
          reject(e instanceof Error ? e : new Error('GIF cache transaction failed'));
          return;
        }
        req.onsuccess = () => {
          const value = req.result;
          try { db.close(); } catch { /* intentionally ignored */}
          resolve(value);
        };
        req.onerror = () => {
          try { db.close(); } catch { /* intentionally ignored */}
          reject(req.error || new Error('GIF cache request failed'));
        };
      }),
  );
}

async function cacheGet(key: string): Promise<CacheEntry | null> {
  try {
    return (await idbTx('readonly', (s) => s.get(key))) || null;
  } catch {
    return null;
  }
}

async function cachePut(entry: CacheEntry): Promise<void> {
  try {
    await idbTx('readwrite', (s) => s.put(entry));
  } catch {
    // Cache is best-effort: a failed write must never break the picker.
  }
  if (entry.kind === 'search') void evictOldSearches();
}

/** Cap stored search queries at ~50, evicting the oldest first. */
async function evictOldSearches(): Promise<void> {
  try {
    const all = await idbTx<CacheEntry[]>('readonly', (s) => s.getAll());
    const searches = (all || [])
      .filter((e) => e.kind === 'search')
      .sort((a, b) => a.savedAt - b.savedAt);
    if (searches.length <= MAX_SEARCH_ENTRIES) return;
    const excess = searches.slice(0, searches.length - MAX_SEARCH_ENTRIES);
    const db = await openCacheDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      const store = tx.objectStore(CACHE_STORE);
      for (const e of excess) store.delete(e.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    try { db.close(); } catch { /* intentionally ignored */}
  } catch {
    // Best-effort only.
  }
}

/** Delete every cached entry (diagnostics / tests). */
export async function clearGifCache(): Promise<void> {
  try {
    await idbTx('readwrite', (s) => s.clear());
  } catch {
    // Best-effort only.
  }
}

// ── Hourly budget guard ─────────────────────────────────────────────────

let callsThisHour = 0;
let hourWindowStart = 0;

function getBlockedUntil(): number {
  try {
    return Number(localStorage.getItem(BLOCKED_UNTIL_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

function setBlockedUntil(ts: number): void {
  try {
    localStorage.setItem(BLOCKED_UNTIL_KEY, String(ts));
  } catch {
    // Best-effort only.
  }
}

/** True when an API call may be spent right now (not 429-blocked and
 *  under the hourly budget). Resets the window every hour. */
function canCallApi(): boolean {
  if (Date.now() < getBlockedUntil()) return false;
  const now = Date.now();
  if (now - hourWindowStart >= 60 * 60 * 1000) {
    hourWindowStart = now;
    callsThisHour = 0;
  }
  return callsThisHour < BUDGET_STOP_AT;
}

function recordApiCall(): void {
  const now = Date.now();
  if (now - hourWindowStart >= 60 * 60 * 1000) {
    hourWindowStart = now;
    callsThisHour = 0;
  }
  callsThisHour += 1;
}

// ── Giphy fetch ─────────────────────────────────────────────────────────

function toGifDef(r: any): GifDef | null {
  try {
    const images = r?.images || {};
    const original = images.original?.url || images.downsized_large?.url || '';
    const preview = images.fixed_width_small?.url || images.preview_gif?.url || original;
    if (!original) return null;
    return {
      id: `giphy-${r.id}`,
      title: String(r.title || 'GIF'),
      url: original,
      // Wave-2 A5 (DM #78): Giphy's MP4 variant drives the looping-video
      // render of the GIF bubble; absent = the .gif animates natively.
      mp4Url: images.original_mp4?.mp4 || images.downsized?.mp4 || undefined,
      previewUrl: preview,
      // WA parity Media G6: every GIF from this provider carries the
      // GIPHY attribution (WA `VideoMessage$Attribution.GIPHY`), stored
      // on the sent message and rendered on the GIF bubble.
      attribution: 'GIPHY',
    };
  } catch {
    return null;
  }
}

function staleResult(entry: CacheEntry, note: string): GifResult {
  return { gifs: entry.gifs, fromCache: true, stale: true, note };
}

/**
 * Cache-first fetch for one cache key. Throws only when there is nothing
 * to show at all (no key + no stale cache, or failure + no stale cache);
 * otherwise serves stale cache with an honest note.
 */
async function fetchGiphyCached(
  key: string,
  kind: 'trending' | 'search',
  query: string | undefined,
  ttlMs: number,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<GifResult> {
  const cached = await cacheGet(key);
  const fresh = cached && Date.now() - cached.savedAt < ttlMs;
  if (fresh && cached) {
    return { gifs: cached.gifs, fromCache: true, stale: false };
  }

  const apiKey = getGiphyApiKey();
  if (!apiKey) {
    if (cached) {
      return staleResult(cached, 'Showing saved GIFs — GIFs unavailable, key not configured.');
    }
    throw new GiphyKeyMissingError();
  }
  if (!canCallApi()) {
    if (cached) {
      return staleResult(cached, 'Showing saved GIFs — GIF limit reached for this hour.');
    }
    throw new Error('GIF limit reached for this hour. Try again later.');
  }

  let res: Response;
  try {
    const qs = new URLSearchParams({ api_key: apiKey, rating: 'g', lang: 'en', ...params });
    res = await fetch(`${GIPHY_BASE}${path}?${qs}`, { signal });
  } catch {
    if (cached) return staleResult(cached, 'Showing saved GIFs — you appear to be offline.');
    throw new Error('Could not load GIFs. Check your connection and try again.');
  }
  if (!res.ok) {
    if (res.status === 429) setBlockedUntil(Date.now() + 60 * 60 * 1000);
    if (cached) {
      const note =
        res.status === 429
          ? 'Showing saved GIFs — GIF service is busy right now.'
          : res.status === 401 || res.status === 403
            ? 'Showing saved GIFs — GIF service rejected the key.'
            : 'Showing saved GIFs — GIF service is unavailable.';
      return staleResult(cached, note);
    }
    if (res.status === 429) throw new Error('GIF service is busy. Try again later.');
    if (res.status === 401 || res.status === 403) {
      throw new Error('GIF service unavailable — the key was rejected.');
    }
    throw new Error(`GIF service unavailable (${res.status}).`);
  }
  recordApiCall();
  const data = await res.json();
  const gifs = ((data?.data || []) as any[]).map(toGifDef).filter((g): g is GifDef => !!g);
  void cachePut({ key, kind, query, gifs, savedAt: Date.now() });
  return { gifs, fromCache: false, stale: false };
}

/** Trending GIFs for the picker home view (cached 1 hour). */
export async function trendingGiphyGifs(signal?: AbortSignal): Promise<GifResult> {
  return fetchGiphyCached('trending', 'trending', undefined, TRENDING_TTL_MS, '/trending', { limit: String(GIF_LIMIT) }, signal);
}

/** Search GIFs (each query cached separately for 24 hours). */
export async function searchGiphyGifs(query: string, signal?: AbortSignal): Promise<GifResult> {
  const q = query.trim().toLowerCase();
  return fetchGiphyCached(
    `search:${q}`,
    'search',
    q,
    SEARCH_TTL_MS,
    '/search',
    { q: query.trim(), limit: String(GIF_LIMIT) },
    signal,
  );
}
