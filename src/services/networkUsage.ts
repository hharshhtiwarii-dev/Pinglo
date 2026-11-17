/**
 * Network usage stats (nightshift, client-only v1).
 *
 * Local byte counters for data sent / received, broken down by media
 * category. Persisted in localStorage (per-device, never synced, never
 * leaves the device) — the same persistence shape as appSettings.ts.
 *
 * What is counted (all exact, no estimates):
 * - Sent text: UTF-8 byte length of the message, recorded in
 *   ChatScreen.sendTextNow after the doc write succeeds.
 * - Sent media: file size at upload, recorded in uploadChatMedia after
 *   the upload (or local compress/read) succeeds. Images in local mode
 *   are compressed first, so the compressed size is recorded, not the
 *   original file size.
 * - Received text: UTF-8 byte length of incoming messages, recorded in
 *   ChatScreen's messages snapshot. Only messages arriving AFTER the
 *   first snapshot are counted: the first snapshot baselines a
 *   watermark (max timestamp seen) so opening an old chat does not
 *   count its whole history as "received".
 *
 * What is NOT counted in v1 (honest limits, shown on the screen):
 * - Received media bytes: a media bubble's remote URL carries no size
 *   and the browser fetches it for display without a hook to measure
 *   it. Received media is counted by message only, bytes stay 0.
 * - Call bytes: needs RTC stats; not wired yet. The Network usage
 *   screen shows a calls row anyway (audit #61, Wave-2 C4): call count
 *   + total connected duration read from the `calls` collection, with
 *   bytes honestly marked "not measured" — no fake byte count, and call
 *   bytes are not folded into the Sent/Received totals.
 * - Push / sync / key-exchange traffic: protocol overhead, not counted.
 *
 * Performance: counters are plain numbers in one localStorage key.
 * Recording is one synchronous read-modify-write per message/upload —
 * O(1), no per-byte work, no re-render (screens poll on mount only).
 * Nothing here holds message content: only byte counts and a timestamp
 * watermark are stored.
 */

export type NetworkUsageCategory = 'text' | 'image' | 'video' | 'audio' | 'document';

export const NETWORK_USAGE_CATEGORIES: NetworkUsageCategory[] = [
  'text',
  'image',
  'video',
  'audio',
  'document',
];

export const NETWORK_USAGE_CATEGORY_LABELS: Record<NetworkUsageCategory, string> = {
  text: 'Messages',
  image: 'Photos',
  video: 'Videos',
  audio: 'Audio',
  document: 'Documents',
};

export interface CategoryStats {
  bytes: number;
  count: number;
}

export interface NetworkUsage {
  sent: Record<NetworkUsageCategory, CategoryStats>;
  received: Record<NetworkUsageCategory, CategoryStats>;
  /** Max message timestamp (ms) seen by the received counter. 0 = never baselined. */
  receivedWatermark: number;
  updatedAt: number;
}

export type NetworkUsageDirection = 'sent' | 'received';

const STORAGE_KEY = 'pinglo_network_usage_v1';

/** MediaType from aws/storage.ts — duplicated as a string union to avoid a heavy import. */
export type ChatMediaType = 'image' | 'video' | 'audio' | 'file' | 'raw';

export function categoryForMediaType(type: ChatMediaType): NetworkUsageCategory {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  if (type === 'audio') return 'audio';
  return 'document';
}

/** UTF-8 byte length of a string (TextEncoder is available on web + WebView). */
export function utf8ByteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    // Fallback for environments without TextEncoder: ASCII length is a
    // lower bound, still better than crashing the send path.
    return text.length;
  }
}

export function emptyCategoryStats(): CategoryStats {
  return { bytes: 0, count: 0 };
}

export function emptyNetworkUsage(): NetworkUsage {
  const blank = (): Record<NetworkUsageCategory, CategoryStats> => ({
    text: emptyCategoryStats(),
    image: emptyCategoryStats(),
    video: emptyCategoryStats(),
    audio: emptyCategoryStats(),
    document: emptyCategoryStats(),
  });
  return { sent: blank(), received: blank(), receivedWatermark: 0, updatedAt: Date.now() };
}

/** Pure: returns a new usage object with one record added. Never mutates. */
export function addUsage(
  usage: NetworkUsage,
  direction: NetworkUsageDirection,
  category: NetworkUsageCategory,
  bytes: number,
): NetworkUsage {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  const next: NetworkUsage = {
    sent: { ...usage.sent },
    received: { ...usage.received },
    receivedWatermark: usage.receivedWatermark,
    updatedAt: Date.now(),
  };
  const side = direction === 'sent' ? next.sent : next.received;
  const prev = side[category];
  side[category] = { bytes: prev.bytes + safeBytes, count: prev.count + 1 };
  return next;
}

export function totalBytes(usage: NetworkUsage, direction: NetworkUsageDirection): number {
  return NETWORK_USAGE_CATEGORIES.reduce((sum, c) => sum + usage[direction][c].bytes, 0);
}

export function totalCount(usage: NetworkUsage, direction: NetworkUsageDirection): number {
  return NETWORK_USAGE_CATEGORIES.reduce((sum, c) => sum + usage[direction][c].count, 0);
}

function isValidUsage(v: unknown): v is NetworkUsage {
  if (!v || typeof v !== 'object') return false;
  const u = v as NetworkUsage;
  for (const dir of ['sent', 'received'] as const) {
    if (!u[dir] || typeof u[dir] !== 'object') return false;
    for (const c of NETWORK_USAGE_CATEGORIES) {
      const s = u[dir][c];
      if (!s || typeof s.bytes !== 'number' || typeof s.count !== 'number') return false;
    }
  }
  return typeof u.receivedWatermark === 'number';
}

export function getNetworkUsage(): NetworkUsage {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyNetworkUsage();
    const parsed: unknown = JSON.parse(raw);
    if (!isValidUsage(parsed)) return emptyNetworkUsage();
    return parsed;
  } catch (err) {
    console.warn('[networkUsage] getNetworkUsage: read failed', err);
    return emptyNetworkUsage();
  }
}

function saveNetworkUsage(usage: NetworkUsage): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
  } catch (err) {
    // Counters are best-effort diagnostics: a full/blocked store must
    // never break sending or uploading.
    console.warn('[networkUsage] saveNetworkUsage: write failed', err);
  }
}

export function recordSent(category: NetworkUsageCategory, bytes: number): void {
  try {
    saveNetworkUsage(addUsage(getNetworkUsage(), 'sent', category, bytes));
  } catch (err) {
    console.warn('[networkUsage] recordSent failed', err);
  }
}

export function recordReceived(category: NetworkUsageCategory, bytes: number): void {
  try {
    saveNetworkUsage(addUsage(getNetworkUsage(), 'received', category, bytes));
  } catch (err) {
    console.warn('[networkUsage] recordReceived failed', err);
  }
}

export function resetNetworkUsage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[networkUsage] resetNetworkUsage failed', err);
  }
}

/**
 * Count newly arrived incoming messages.
 *
 * `messages` are the raw docs from the chat snapshot (any shape — only
 * `id`, `senderId`, `timestamp`, `text`/`caption` and `mediaType` are
 * read). Messages from `myUid` are skipped. On the very first call the
 * watermark is 0, so the batch only baselines the watermark (existing
 * history is NOT counted as received); later calls count docs newer
 * than the watermark and advance it. Returns how many messages were
 * counted — 0 on the baseline pass.
 *
 * Timestamp may be a number (ms), a Firestore Timestamp ({ toMillis }),
 * or a { seconds } shape; unparseable timestamps are skipped, never
 * counted, so a malformed doc cannot inflate the counters.
 */
export function noteReceivedMessages(
  messages: Array<Record<string, unknown>>,
  myUid: string | undefined | null,
): number {
  if (!myUid) return 0;
  const usage = getNetworkUsage();
  let watermark = usage.receivedWatermark;
  let counted = 0;
  let next = usage;
  let maxTs = watermark;

  for (const m of messages) {
    if (m.senderId === myUid) continue;
    const ts = toMillis(m.timestamp);
    if (ts === undefined) continue;
    if (ts > maxTs) maxTs = ts;
    // Baseline pass: watermark 0 means "first sight" — set the mark,
    // count nothing.
    if (watermark === 0) continue;
    if (ts <= watermark) continue;
    const mediaType = typeof m.mediaType === 'string' ? m.mediaType : undefined;
    const category: NetworkUsageCategory =
      mediaType === 'image' || mediaType === 'video' || mediaType === 'audio' || mediaType === 'file'
        ? categoryForMediaType(mediaType as ChatMediaType)
        : 'text';
    // Media bytes are not measurable on receipt (see header) — count
    // the message, bytes stay 0 for media. Text bytes are exact.
    const bytes = category === 'text'
      ? utf8ByteLength(typeof m.text === 'string' ? m.text : '')
      : 0;
    next = addUsage(next, 'received', category, bytes);
    counted++;
  }

  if (maxTs > watermark || counted > 0) {
    next = { ...next, receivedWatermark: maxTs, updatedAt: Date.now() };
    saveNetworkUsage(next);
  }
  return counted;
}

function toMillis(ts: unknown): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (ts && typeof ts === 'object') {
    const t = ts as { toMillis?: unknown; seconds?: unknown };
    if (typeof t.toMillis === 'function') {
      const v = (t as { toMillis: () => unknown }).toMillis();
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    if (typeof t.seconds === 'number' && Number.isFinite(t.seconds)) return t.seconds * 1000;
  }
  return undefined;
}
