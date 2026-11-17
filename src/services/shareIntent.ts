/**
 * ROADMAP-2 #8 — Android share-sheet target (web half).
 *
 * Native half: ShareIntentPlugin.java + the ACTION_SEND /
 * ACTION_SEND_MULTIPLE intent-filters in AndroidManifest.xml. When the
 * user picks "Share → Pinglo" in Gallery / a browser, Android
 * delivers the intent to the app; the plugin copies shared streams into
 * the app cache dir and exposes them here.
 *
 * Flow:
 *  1. Share arrives while the app runs → plugin fires 'shareReceived'
 *     (light event: hasText + fileCount). initShareListener() fetches
 *     the full payload, stores it, and calls the app's onShare callback.
 *  2. Cold start (app was closed) → the launch intent is held by the
 *     plugin; checkPendingShare() pulls it the same way.
 *  3. The payload is stored in localStorage (`dt_pending_share`) so it
 *     survives to the chat picker. The picker reads it with
 *     loadPendingShare(), turns each file ref back into a File with
 *     fileForRef(), sends, then clears it with clearStoredShare().
 *
 * OPEN — picker UI (NOT faked here): there is no /share route and no
 * chat-picker screen yet, and App.tsx / ChatScreen.tsx are outside this
 * worker's file list. The coordinator wires two lines in App.tsx:
 *   initShareListener(() => navigate('/main'));   // next to registerDeepLinkListener
 *   useEffect(() => { void checkPendingShare(); }, []);  // once, after login
 * and a later worker builds the picker screen on loadPendingShare() +
 * fileForRef() + clearStoredShare(). Until then a share opens the app
 * and the payload waits in storage — it is NOT silently dropped.
 *
 * On the web there is no native plugin: every plugin call rejects and
 * every function below degrades to null / no-op — the browser keeps
 * working, and `?share=` links are intentionally NOT invented as a
 * fallback (a pasted URL is not a share intent).
 */

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface SharedFileRef {
  /** File name as shared (sanitised by the plugin). */
  name: string;
  mimeType: string;
  /** Absolute path in the app cache dir (native only). */
  path: string;
}

export interface PendingShare {
  text: string | null;
  subject: string | null;
  files: SharedFileRef[];
  /** True when the sender shared more than the plugin's 10-file cap. */
  truncated: boolean;
  /** When the share was stored (ms epoch). */
  savedAt: number;
}

export interface ShareFile extends SharedFileRef {
  /** Usable File for the chat send path; null when it could not be read. */
  file: File | null;
}

export interface FetchedShare {
  text: string | null;
  subject: string | null;
  files: ShareFile[];
  truncated: boolean;
}

interface RawSharePayload {
  text?: unknown;
  subject?: unknown;
  files?: unknown;
  truncated?: unknown;
}

interface ShareReceivedEvent {
  hasText: boolean;
  fileCount: number;
}

interface ShareIntentPlugin {
  getPendingShare(): Promise<RawSharePayload>;
  clearPendingShare(): Promise<void>;
  addListener(
    eventName: 'shareReceived',
    listenerFunc: (event: ShareReceivedEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const ShareIntent = registerPlugin<ShareIntentPlugin>('ShareIntent');

const STORE_KEY = 'dt_pending_share';
/** A stored share older than this is stale (cache files may be evicted) — never offered. */
export const PENDING_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

const asText = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * Validate + normalise a raw plugin payload. Pure — unit-tested by the
 * R1B probe. Anything malformed degrades to an empty share, never a crash.
 */
export function normalizeSharePayload(raw: unknown): Omit<PendingShare, 'savedAt'> {
  const empty = { text: null as string | null, subject: null as string | null, files: [] as SharedFileRef[], truncated: false };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as RawSharePayload;
  const files: SharedFileRef[] = Array.isArray(r.files)
    ? (r.files as unknown[])
        .filter(
          (f): f is SharedFileRef =>
            !!f &&
            typeof f === 'object' &&
            typeof (f as any).name === 'string' &&
            typeof (f as any).path === 'string',
        )
        .map((f: any) => ({
          name: f.name as string,
          mimeType: typeof f.mimeType === 'string' && f.mimeType ? f.mimeType : 'application/octet-stream',
          path: f.path as string,
        }))
    : [];
  return {
    text: asText(r.text),
    subject: asText(r.subject),
    files,
    truncated: r.truncated === true,
  };
}

function isEmptyShare(s: Omit<PendingShare, 'savedAt'>): boolean {
  return !s.text && s.files.length === 0;
}

/** Turn a stored file ref back into a sendable File (native only). */
export async function fileForRef(ref: SharedFileRef): Promise<File | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const url = Capacitor.convertFileSrc(ref.path);
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], ref.name, { type: ref.mimeType });
  } catch (err) {
    console.warn('[shareIntent] fileForRef: could not read shared file', ref.name, err);
    return null;
  }
}

/** Pull the pending share from the native plugin (consumes it). Null when none / on web. */
export async function fetchPendingShare(): Promise<FetchedShare | null> {
  let raw: RawSharePayload;
  try {
    raw = await ShareIntent.getPendingShare();
  } catch {
    return null; // Web (no plugin) or no share — not an error.
  }
  const share = normalizeSharePayload(raw);
  if (isEmptyShare(share)) return null;
  const files: ShareFile[] = [];
  for (const ref of share.files) {
    files.push({ ...ref, file: await fileForRef(ref) });
  }
  return { text: share.text, subject: share.subject, files, truncated: share.truncated };
}

/** Persist a share so the (future) chat picker can consume it. */
export function savePendingShare(share: Omit<PendingShare, 'savedAt'>): void {
  if (isEmptyShare(share)) return;
  try {
    const stored: PendingShare = { ...share, savedAt: Date.now() };
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch (err) {
    console.warn('[shareIntent] savePendingShare: could not store share', err);
  }
}

/** Read the stored share. Null when none or stale (>24 h — cache files may be gone). */
export function loadPendingShare(): PendingShare | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingShare>;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt > PENDING_SHARE_TTL_MS) {
      clearStoredShare();
      return null;
    }
    const share = normalizeSharePayload(parsed);
    return { ...share, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function clearStoredShare(): void {
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (err) {
    console.warn('[shareIntent] clearStoredShare failed', err);
  }
}

/**
 * Cold-start check: pull any share the plugin is holding from the launch
 * intent, store it, and return it. The coordinator calls this once after
 * login (see header). Returns null when there is no share.
 */
export async function checkPendingShare(): Promise<FetchedShare | null> {
  const share = await fetchPendingShare();
  if (!share) return null;
  savePendingShare({ text: share.text, subject: share.subject, files: share.files, truncated: share.truncated });
  return share;
}

/**
 * Live listener: a share arriving while the app runs stores the payload
 * and invokes onShare. Returns a cleanup function. No-op on web.
 */
export function initShareListener(onShare: (share: FetchedShare) => void): () => void {
  let remove: (() => void) | undefined;
  try {
    const maybeHandle: any = ShareIntent.addListener('shareReceived', () => {
      void (async () => {
        const share = await fetchPendingShare();
        if (!share) return;
        savePendingShare({ text: share.text, subject: share.subject, files: share.files, truncated: share.truncated });
        try {
          onShare(share);
        } catch (err) {
          console.warn('[shareIntent] onShare callback failed', err);
        }
      })();
    });
    if (maybeHandle && typeof maybeHandle.then === 'function') {
      maybeHandle
        .then((h: PluginListenerHandle) => {
          remove = () => {
            try {
              void h.remove();
            } catch (err) {
              console.warn('[shareIntent] listener remove failed', err);
            }
          };
        })
        .catch(() => undefined);
    } else if (maybeHandle && typeof maybeHandle.remove === 'function') {
      remove = () => {
        try {
          void maybeHandle.remove();
        } catch (err) {
          console.warn('[shareIntent] listener remove failed', err);
        }
      };
    }
  } catch {
    // Web / plugin missing — shares simply never arrive.
  }
  return () => {
    try {
      remove?.();
    } catch (err) {
      console.warn('[shareIntent] initShareListener cleanup failed', err);
    }
  };
}
