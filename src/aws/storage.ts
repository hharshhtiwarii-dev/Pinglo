import { uploadData, getUrl, remove } from 'aws-amplify/storage';
import { getAwsEnvConfig } from './config';
import { getUploadCompression } from '../services/appSettings';
import { categoryForMediaType, recordSent } from '../services/networkUsage';
import { estimateDataUrlSize } from '../services/storageUsage';

export type MediaType = 'image' | 'video' | 'audio' | 'raw' | 'file';

export const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB — unchanged: avatars are downscaled to 400px (~30KB)
export const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB — unchanged: chat images are shown at chat width / compressed to 1280px
// 200MB for video / audio / generic files (was 50MB). Safe because Amplify
// Storage auto-multiparts files > 5MB to S3 (see uploadChatMediaTask) and the
// message doc only stores the URL, not the bytes. Kept well below what a
// single browser upload can realistically finish on mobile data; there is no
// per-user quota yet, so do not raise this again without adding one.
export const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
/** Largest non-image file allowed through the local Data-URL fallback (no S3). */
const MAX_LOCAL_FALLBACK_SIZE = 5 * 1024 * 1024; // 5MB

// ── Wave-2 Media A18 — per-type "too large" messages ────────────────────
// WA copy: "This document is too large. You can send documents up to
// {maxSize}." / "This image/video/audio is too large. … up to {maxSize}."
// / "This file is too large. You can send files up to {maxSize}." The
// limits come from the constants above, so the number in the message can
// never drift from the enforced cap. Every upload path surfaces these
// verbatim (ChatScreen pre-check + send catch, shareSend.ts, Saved
// Messages) — no path rewords or swallows them.
/** "15 MB" style label for a byte limit. */
export function formatMaxSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Per-type oversize message for the send limits (image 15 MB, everything else 200 MB). All three upload paths pass 'file' for a generic (non-image/video/audio) pick, so 'file'/'raw' get WA's generic file wording; the document wording is kept for an explicit 'document' type. */
export function mediaTooLargeMessage(type: MediaType): string {
  if (type === 'image') return `This image is too large. You can send images up to ${formatMaxSize(MAX_IMAGE_SIZE)}.`;
  if (type === 'video') return `This video is too large. You can send videos up to ${formatMaxSize(MAX_FILE_SIZE)}.`;
  if (type === 'audio') return `This audio is too large. You can send audio up to ${formatMaxSize(MAX_FILE_SIZE)}.`;
  if (type === 'file' || type === 'raw') return `This file is too large. You can send files up to ${formatMaxSize(MAX_FILE_SIZE)}.`;
  return `This document is too large. You can send documents up to ${formatMaxSize(MAX_FILE_SIZE)}.`;
}

/** Per-type oversize message for the 5 MB local-mode cap (no S3 connected). */
export function localModeTooLargeMessage(type: MediaType): string {
  const noun = type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'file';
  const plural = noun === 'file' ? 'files' : `${noun}s`;
  return `This ${noun} is too large to send without storage connected. You can send ${plural} up to ${formatMaxSize(MAX_LOCAL_FALLBACK_SIZE)} in local mode.`;
}

/** Oversize message for profile / group photos (5 MB cap). */
export function photoTooLargeMessage(): string {
  return `This photo is too large. You can send photos up to ${formatMaxSize(MAX_AVATAR_SIZE)}.`;
}

// ── 100M-H6: local media blob store (IndexedDB) ──────────────────────────
// Voice recordings are ~16KB/s, so a base64 data URL grows past the 380KB
// per-doc DynamoDB cap (src/aws/database.ts MAX_DOC_BYTES) at ~17-18 s — a
// 60 s voice status / voice note could never post in local mode (and a
// real-backend user whose S3 upload failed fell back into the same trap).
// The doc must never embed audio bytes: in local mode the bytes live in
// this IndexedDB blob store and the doc keeps only a `local-media:<id>`
// reference (~30 bytes). `VoiceNotePlayer` resolves the reference back to
// a playable blob: URL. Separate DB from the `pinglo-cache` collections
// cache (database.ts) so neither store's versioning touches the other.
// Local-media refs are this-device-only: with S3 configured the S3 URL
// path above is used instead and syncs normally.
/** Prefix marking a mediaUrl that is a reference into the local blob store. */
export const LOCAL_MEDIA_URL_PREFIX = 'local-media:';
const LOCAL_MEDIA_DB_NAME = 'pinglo-media';
const LOCAL_MEDIA_STORE = 'blobs';
let localMediaDbPromise: Promise<IDBDatabase | null> | null = null;

function openLocalMediaDb(): Promise<IDBDatabase | null> {
  if (localMediaDbPromise) return localMediaDbPromise;
  localMediaDbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(LOCAL_MEDIA_DB_NAME, 1);
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(LOCAL_MEDIA_STORE)) {
            req.result.createObjectStore(LOCAL_MEDIA_STORE);
          }
        } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return localMediaDbPromise;
}

export function isLocalMediaUrl(url: string | undefined | null): url is string {
  return typeof url === 'string' && url.startsWith(LOCAL_MEDIA_URL_PREFIX);
}

export function localMediaIdFromUrl(url: string | undefined | null): string | null {
  if (!isLocalMediaUrl(url)) return null;
  const id = url.slice(LOCAL_MEDIA_URL_PREFIX.length);
  return id || null;
}

/** Store an audio blob locally; resolves to its id (used as `local-media:<id>`). */
export async function putLocalMediaBlob(blob: Blob): Promise<string> {
  const dbConn = await openLocalMediaDb();
  if (!dbConn) throw new Error('Local media storage unavailable (IndexedDB blocked).');
  const id = `lm_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = dbConn.transaction(LOCAL_MEDIA_STORE, 'readwrite');
      tx.objectStore(LOCAL_MEDIA_STORE).put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Local media save failed'));
    } catch (err) {
      reject(err as Error);
    }
  });
  return id;
}

/** Fetch a blob back by id; null when IndexedDB is unavailable or the id is gone. */
export async function getLocalMediaBlob(id: string): Promise<Blob | null> {
  try {
    const dbConn = await openLocalMediaDb();
    if (!dbConn || !id) return null;
    return await new Promise<Blob | null>((resolve) => {
      try {
        const tx = dbConn.transaction(LOCAL_MEDIA_STORE, 'readonly');
        const req = tx.objectStore(LOCAL_MEDIA_STORE).get(id);
        req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

/**
 * Resolve a mediaUrl to something an <audio>/<img> element can play:
 * `local-media:<id>` -> fresh blob: URL for the stored bytes, anything
 * else returned unchanged. Throws when the referenced bytes are gone
 * (e.g. browser storage was cleared) so the player can fail visibly.
 */
export async function resolveLocalMediaUrl(url: string): Promise<string> {
  const id = localMediaIdFromUrl(url);
  if (!id) return url;
  const blob = await getLocalMediaBlob(id);
  if (!blob) throw new Error('Voice recording not found on this device (local media missing).');
  return URL.createObjectURL(blob);
}

/** Delete one stored blob by id or `local-media:<id>` URL; false when nothing was stored. */
export async function deleteLocalMediaBlob(urlOrId: string): Promise<boolean> {
  try {
    const id = localMediaIdFromUrl(urlOrId) ?? urlOrId;
    const dbConn = await openLocalMediaDb();
    if (!dbConn || !id) return false;
    await new Promise<void>((resolve) => {
      try {
        const tx = dbConn.transaction(LOCAL_MEDIA_STORE, 'readwrite');
        tx.objectStore(LOCAL_MEDIA_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete EVERY blob in the local media store. Sign-out / account-switch
 * wipes the `pinglo-cache` collections (App.tsx, via resetDbCache) and
 * the media blobs must go with it: the doc references die with the
 * cache, so leftover blobs would be unreachable orphans — and on a
 * shared device one account's voice recordings must not outlive its
 * session. Best-effort — callers treat a throw as non-fatal.
 */
export async function clearLocalMediaBlobs(): Promise<void> {
  const dbConn = await openLocalMediaDb();
  if (!dbConn) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = dbConn.transaction(LOCAL_MEDIA_STORE, 'readwrite');
      tx.objectStore(LOCAL_MEDIA_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * True when an upload/save error means the recording was too long or too
 * large for the doc/storage available — callers must tell the user to try
 * a SHORTER recording, never a bare "try again" (retrying the same
 * recording fails the same way). Matches the 380KB doc-cap error from
 * database.ts and the honest errors thrown by uploadChatMedia below.
 */
export function isMediaTooLargeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /too long|too large|380KB|400KB|over the .* limit/i.test(msg);
}

export interface UploadProgress {
  transferredBytes: number;
  totalBytes: number;
}

export type UploadProgressCallback = (progress: UploadProgress) => void;

/** Handle for a resumable upload: promise resolves to the public URL. */
export interface ResumableUpload {
  promise: Promise<string>;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Phase 3 — executable / script uploads are never chat media. Checked by BOTH extension and MIME type. */
export const BLOCKED_FILE_EXTENSIONS = ['html', 'htm', 'js', 'mjs', 'exe', 'apk', 'bat', 'sh', 'jar', 'msi', 'com', 'scr', 'ps1', 'vbs', 'cmd'];
export const BLOCKED_MIME_TYPES = [
  'text/html',
  'application/javascript',
  'text/javascript',
  'application/x-msdownload',
  'application/vnd.android.package-archive',
  'application/java-archive',
  'application/x-msi',
  'application/x-sh',
  'application/x-bat',
  'application/x-ms-dos-executable',
];

/** Phase 3 — client-side per-user upload quota (running total in localStorage). Warn, don't block, at 1 GB. */
export const UPLOAD_QUOTA_WARN_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
export const UPLOAD_TOTAL_KEY = 'pinglo_upload_total_bytes';

export function getUploadTotalBytes(): number {
  try {
    return Number(localStorage.getItem(UPLOAD_TOTAL_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

export function recordUploadBytes(bytes: number): void {
  if (!bytes || bytes <= 0) return;
  try {
    localStorage.setItem(UPLOAD_TOTAL_KEY, String(getUploadTotalBytes() + bytes));
  } catch { /* intentionally ignored */}
}

/** Returns { total, wouldExceed } — callers should warn the user when wouldExceed is true. */
export function checkUploadQuota(fileSize: number): { totalBytes: number; wouldExceed: boolean } {
  const totalBytes = getUploadTotalBytes();
  const wouldExceed = totalBytes + (fileSize || 0) > UPLOAD_QUOTA_WARN_BYTES;
  if (wouldExceed) {
    console.warn(
      `Upload quota warning: you have uploaded ~${(totalBytes / 1024 / 1024).toFixed(0)} MB in this app (warning threshold 1 GB).`,
    );
  }
  return { totalBytes, wouldExceed };
}

/** Compress an image File to a Blob (canvas), preserving PNG/WebP where possible, else JPEG. */
export const compressImageToBlob = async (
  file: File,
  maxDimension: number = 1280,
  quality: number = 0.75,
): Promise<Blob> => {
  try {
    const dataUrl = await compressImage(file, maxDimension, quality);
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return file;
  }
};

/**
 * Compresses and resizes high-resolution images using an in-memory Canvas
 * Ensures photos fit within localStorage quotas and MQTT WebSocket payload limits (<150KB)
 */
export const compressImage = async (
  file: File,
  maxDimension: number = 1280,
  quality: number = 0.75
): Promise<string> => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(e.target?.result as string);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(compressedDataUrl);
      };
      img.onerror = () => resolve(e.target?.result as string);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
};

/**
 * Uploads a profile picture to AWS S3 (avatars/...)
 */
export const uploadProfilePicture = async (file: File): Promise<string> => {
  if (!file) throw new Error('No file provided');

  if (file.size > MAX_AVATAR_SIZE) {
    throw new Error(photoTooLargeMessage());
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Only JPG, PNG, WEBP, or GIF images are allowed');
  }

  const cfg = getAwsEnvConfig();
  const fileExt = file.name.split('.').pop() || 'jpg';
  const fileName = `avatars/avatar_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;

  if (cfg.s3Bucket) {
    try {
      const result = await uploadData({
        path: fileName,
        data: file,
        options: {
          contentType: file.type,
        },
      }).result;

      const urlOutput = await getUrl({
        path: result.path,
        options: {
          validateObjectExistence: false,
        },
      });

      return urlOutput.url.toString();
    } catch (err: any) {
      console.warn('AWS S3 upload fallback:', err);
    }
  }

  // Fallback to compressed Data URL (max 400px for avatar, ~30KB)
  return compressImage(file, 400, 0.8);
};

/**
 * #162 — uploads a group photo to AWS S3 (group-photos/...). Mirrors
 * uploadProfilePicture: same 5MB / image-type validation, same compressed
 * Data-URL fallback (max 400px) when S3 is unavailable, so group photos
 * work in local mode exactly like profile photos. Kept separate so a group
 * photo never lands in the avatars/ prefix (and vice versa).
 */
export const uploadGroupPhoto = async (file: File): Promise<string> => {
  if (!file) throw new Error('No file provided');

  if (file.size > MAX_AVATAR_SIZE) {
    throw new Error(photoTooLargeMessage());
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Only JPG, PNG, WEBP, or GIF images are allowed');
  }

  const cfg = getAwsEnvConfig();
  const fileExt = file.name.split('.').pop() || 'jpg';
  const fileName = `group-photos/group_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;

  if (cfg.s3Bucket) {
    try {
      const result = await uploadData({
        path: fileName,
        data: file,
        options: {
          contentType: file.type,
        },
      }).result;

      const urlOutput = await getUrl({
        path: result.path,
        options: {
          validateObjectExistence: false,
        },
      });

      return urlOutput.url.toString();
    } catch (err: any) {
      console.warn('AWS S3 group photo upload fallback:', err);
    }
  }

  // Fallback to compressed Data URL (max 400px, ~30KB) — same as avatars.
  return compressImage(file, 400, 0.8);
};

/**
 * Uploads media (images, videos, voice notes) for chat messages to AWS S3
 */
export const uploadChatMedia = async (
  file: File,
  type: MediaType,
  _isViewOnce: boolean = false,
  onProgress?: UploadProgressCallback,
  /** WA verify media-5 (A13/A10): HD original — skip the Media-upload-quality
   *  compression so the photo the editor exported is what actually leaves
   *  the device. The S3 path uploads the original bytes; the local
   *  no-S3 fallback can only carry a small original inside the doc, so a
   *  large HD original fails honestly there instead of compressing
   *  silently behind the HD badge. */
  opts?: { isHD?: boolean },
): Promise<string> => {
  if (!file) throw new Error('No file provided');
  validateChatMediaFile(file, type);

  const cfg = getAwsEnvConfig();

  if (cfg.s3Bucket) {
    try {
      // Amplify Storage (aws-amplify ^6.22.2, already installed): files > 5MB
      // are automatically split into 5MB parts and sent as an S3 multipart
      // upload; the task is pausable / resumable / cancellable and reports
      // progress. No new dependency, no hand-rolled chunking.
      const url = await uploadChatMediaTask(file, type, _isViewOnce, onProgress, opts).promise;
      // Network usage: these bytes left this device.
      recordSent(categoryForMediaType(type), file.size);
      return url;
    } catch (err: any) {
      console.warn('AWS S3 chat media upload fallback:', err);
      // A failed S3 upload must NOT fall through to a Data URL for a large
      // file: a ~200MB base64 string would OOM the tab and can never fit in
      // a DynamoDB/AppSync message doc (400KB item limit).
      if (file.size > MAX_LOCAL_FALLBACK_SIZE && type !== 'image') {
        throw new Error(localModeTooLargeMessage(type));
      }
    }
  }

  // Fallback to local Data URL when S3 is not yet connected. Images are
  // compressed first (~100-300KB), so they stay viable. A large non-image
  // file has no viable local fallback (see 2.4) — fail fast, don't hang the
  // tab reading hundreds of MB into a base64 string.
  if (type !== 'image' && file.size > MAX_LOCAL_FALLBACK_SIZE) {
    throw new Error(localModeTooLargeMessage(type));
  }
  // WA verify media-5 (A13/A10): an HD original must not be compressed
  // silently in local mode either — a full-size photo as a data URL only
  // fits in the doc while small, so fail honestly above that instead.
  if (type === 'image' && opts?.isHD && Math.ceil((file.size * 4) / 3) + 64 > 360 * 1024) {
    throw new Error('HD original is too large to send without S3 storage connected. Turn HD off or connect storage.');
  }
  // 100M-H6: audio NEVER goes through the data-URL fallback below — a
  // base64 data URL grows ~21.6KB/s of recording and the doc cap is 380KB,
  // so any voice note / voice status over ~17-18 s could never post and
  // the whole recording was lost. Store the bytes in the local IndexedDB
  // blob store and return only the `local-media:<id>` reference for the
  // doc; VoiceNotePlayer resolves it back to a playable blob: URL. This
  // also covers the S3-upload-failed fallthrough above (same code path).
  if (type === 'audio') {
    try {
      const id = await putLocalMediaBlob(file);
      if (onProgress) onProgress({ transferredBytes: file.size, totalBytes: file.size });
      return `${LOCAL_MEDIA_URL_PREFIX}${id}`;
    } catch (err) {
      // IndexedDB unavailable (private mode / blocked storage): only a
      // short recording can still fit in the doc as a data URL — cap the
      // data URL at ~360KB so the doc stays under the 380KB limit (the
      // old ~17 s ceiling), and fail honestly beyond that instead of
      // letting putRaw throw a generic error after the recording is gone.
      const dataUrlBytes = Math.ceil((file.size * 4) / 3) + 64;
      if (dataUrlBytes > 360 * 1024) {
        throw new Error(
          'Voice recording too long to save without storage connected (local media storage unavailable). Try a shorter recording.',
        );
      }
      console.warn('Local media blob store unavailable, falling back to data URL:', err);
    }
  }
  if (type === 'image' && !opts?.isHD) {
    // Theme fix: JPEG size/quality follow the Media upload quality setting
    // (Auto / Best quality / Data saver) in Settings > Chats.
    // HD originals skip this branch and fall through to the generic
    // FileReader below, which returns the original bytes untouched.
    const { maxDimension, quality } = getUploadCompression();
    const dataUrl = await compressImage(file, maxDimension, quality);
    // Network usage: the compressed bytes are what actually left the
    // device, not the original file size.
    recordSent('image', estimateDataUrlSize(dataUrl) ?? file.size);
    return dataUrl;
  }

  // Local fallback: report real read progress (FileReader.onprogress) so a
  // multi-file send queue can show per-file % even with no S3 configured.
  // Images take the compressImage path above (canvas, no progress events)
  // and resolve at 100% on completion — never a fabricated ramp.
  if (onProgress) onProgress({ transferredBytes: 0, totalBytes: file.size });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress({ transferredBytes: e.loaded, totalBytes: e.total || file.size });
    };
    reader.onload = () => {
      if (onProgress) onProgress({ transferredBytes: file.size, totalBytes: file.size });
      // Network usage: these bytes left this device.
      recordSent(categoryForMediaType(type), file.size);
      resolve(reader.result as string);
    };
    reader.onerror = () => reject(new Error('Failed to read media file'));
    reader.readAsDataURL(file);
  });
};

/** Shared size/type checks for chat media. Avatar (5MB) and image (15MB) caps are unchanged. */
export function validateChatMediaFile(file: File, type: MediaType): void {
  // Blocked by extension AND by MIME type — a renamed .exe must not slip through.
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (BLOCKED_FILE_EXTENSIONS.includes(ext)) {
    throw new Error(`Files of type ".${ext}" are not allowed`);
  }
  if (BLOCKED_MIME_TYPES.includes((file.type || '').toLowerCase())) {
    throw new Error(`Files of type "${file.type}" are not allowed`);
  }
  // An HTML/JS payload masquerading as an image (or vice versa) is rejected.
  if (type === 'image' && file.type && !file.type.startsWith('image/')) {
    throw new Error('Invalid image file format');
  }
  if (type === 'image') {
    if (file.size > MAX_IMAGE_SIZE) {
      throw new Error(mediaTooLargeMessage('image'));
    }
    if (!file.type.startsWith('image/')) {
      throw new Error('Invalid image file format');
    }
  } else if (type === 'video') {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(mediaTooLargeMessage('video'));
    }
    if (!file.type.startsWith('video/')) {
      throw new Error('Invalid video file format');
    }
  } else if (type === 'audio') {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(mediaTooLargeMessage('audio'));
    }
    if (!file.type.startsWith('audio/')) {
      throw new Error('Invalid audio file format');
    }
  } else if (file.size > MAX_FILE_SIZE) {
    throw new Error(mediaTooLargeMessage(type));
  }
}

/**
 * Capture a poster frame from a video file (canvas, ~1s in or 10% through,
 * whichever is earlier). Returns a JPEG data URL, or null when the frame
 * cannot be captured. Best-effort — never throws.
 */
export const captureVideoPoster = async (file: File, atSeconds?: number): Promise<string | null> => {
  try {
    if (!file || !file.type.startsWith('video/')) return null;
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error('video load failed'));
        setTimeout(() => reject(new Error('video load timeout')), 8000);
      });
      const seekTo = Math.min(atSeconds ?? 1, Math.max(0, (video.duration || 2) * 0.1));
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('video seek failed'));
        setTimeout(() => reject(new Error('video seek timeout')), 8000);
        try {
          video.currentTime = Number.isFinite(seekTo) ? seekTo : 0;
        } catch (e) {
          reject(e as Error);
        }
      });
      const scale = Math.min(1, 480 / Math.max(1, video.videoWidth || 480));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round((video.videoWidth || 480) * scale));
      canvas.height = Math.max(2, Math.round((video.videoHeight || 270) * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.7);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
};

/** Upload a captured poster frame to S3 (media/poster/...) and return its URL, or null. */
export const uploadVideoPoster = async (file: File): Promise<string | null> => {
  try {
    const poster = await captureVideoPoster(file);
    if (!poster) return null;
    const cfg = getAwsEnvConfig();
    if (!cfg.s3Bucket) return poster; // no S3: the data URL itself is the poster
    const res = await fetch(poster);
    const blob = await res.blob();
    const path = `media/poster/${Date.now()}_${Math.random().toString(36).substring(2, 9)}.jpg`;
    await uploadData({ path, data: blob, options: { contentType: 'image/jpeg' } }).result;
    const urlOutput = await getUrl({ path, options: { validateObjectExistence: false } });
    return urlOutput.url.toString();
  } catch {
    return null;
  }
};

/**
 * Upload media and, for videos, a poster frame alongside it.
 * Returns { url, posterUrl? } — screens that need the poster should use
 * this; plain uploadChatMedia keeps its string return for compatibility.
 */
export const uploadChatMediaWithPoster = async (
  file: File,
  type: MediaType,
  isViewOnce: boolean = false,
  onProgress?: UploadProgressCallback,
  opts?: { isHD?: boolean },
): Promise<{ url: string; posterUrl?: string | null }> => {
  const url = await uploadChatMedia(file, type, isViewOnce, onProgress, opts);
  if (type !== 'video') return { url };
  const posterUrl = await uploadVideoPoster(file);
  return { url, posterUrl };
};

/**
 * Resumable chat-media upload. Uses the already-installed Amplify Storage
 * `uploadData` task: multipart above 5MB, with pause/resume/cancel and
 * `onProgress`. Amplify auto-cancels uploads initiated over an hour ago, so
 * resume only works within the same session / hour — it is NOT resume-across-
 * app-restarts (that would need persisting the multipart upload id, which
 * Amplify JS does not expose). Callers that only need the URL should use
 * `uploadChatMedia` instead.
 */
export const uploadChatMediaTask = (
  file: File,
  type: MediaType,
  _isViewOnce: boolean = false,
  onProgress?: UploadProgressCallback,
  /** WA verify media-5 (A13/A10): HD original — upload the file untouched
   *  instead of re-compressing it to the upload-quality setting. */
  opts?: { isHD?: boolean },
): ResumableUpload => {
  if (!file) throw new Error('No file provided');
  validateChatMediaFile(file, type);
  // Phase 3 — quota warning (client-side running total, 1 GB threshold).
  checkUploadQuota(file.size);

  const fileExt = file.name.split('.').pop() || (type === 'audio' ? 'webm' : 'bin');
  const fileName = `media/${type}/${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;
  // Generic files download as attachments instead of executing/rendering inline.
  const isGenericFile = type === 'file' || type === 'raw';
  const contentDisposition = isGenericFile
    ? `attachment; filename="${file.name.replace(/["\r\n]/g, '_')}"`
    : undefined;

  let task: any = null;
  let cancelled = false;

  const promise = (async (): Promise<string> => {
    // Phase 3 — images are compressed BEFORE the S3 upload too, not only
    // in the no-S3 fallback. The compressed blob keeps its format where
    // feasible (PNG/WebP preserved by canvas; otherwise JPEG).
    // #209: honour the user's Media upload quality setting here too —
    // the S3 path used to hard-code 1280px/0.75, silently capping "Best
    // quality" (2560px) on the real backend path.
    let data: File | Blob = file;
    let contentType = file.type;
    // WA verify media-5 (A13/A10): an HD original is uploaded untouched —
    // compressing it to the upload-quality setting would silently undo
    // the HD toggle in the photo editor / video sheet.
    if (type === 'image' && !opts?.isHD) {
      const { maxDimension, quality } = getUploadCompression();
      const compressed = await compressImageToBlob(file, maxDimension, quality);
      if (compressed instanceof Blob && compressed.size > 0 && compressed.size < file.size) {
        data = compressed;
        contentType = compressed.type || 'image/jpeg';
      }
    }
    if (cancelled) throw new Error('Upload cancelled');
    task = uploadData({
      path: fileName,
      data,
      options: {
        contentType,
        ...(contentDisposition ? { contentDisposition } : {}),
        ...(onProgress ? { onProgress } : {}),
      },
    });
    const result = await task.result;
    recordUploadBytes(file.size);
    const urlOutput = await getUrl({
      path: result.path,
      options: { validateObjectExistence: false },
    });
    return urlOutput.url.toString();
  })();

  return {
    promise,
    pause: () => task?.pause(),
    resume: () => task?.resume(),
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
};

/**
 * Extract the S3 key (`media/<type>/...` or `avatars/...`) from a URL returned
 * by `uploadChatMedia` / `uploadProfilePicture` (a presigned `getUrl` URL).
 * Returns undefined for Data URLs, external URLs (GIFs/stickers) and anything
 * that is not one of our prefixes — those must never be passed to `remove`.
 */
export const extractS3KeyFromUrl = (url: string): string | undefined => {
  if (!url || url.startsWith('data:')) return undefined;
  try {
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
    if (path.startsWith('media/') || path.startsWith('avatars/')) return path;
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Best-effort delete of the S3 object behind a chat-media URL. No-op (returns
 * false) when S3 is not configured or the URL is not one of our S3 objects.
 * Callers should delete the message doc first and treat a false/throw here as
 * non-fatal — the message is already gone.
 */
export const deleteChatMedia = async (url: string): Promise<boolean> => {
  if (!url || typeof url !== 'string') return false;
  // 100M-H6: a `local-media:<id>` reference has no S3 object — delete the
  // stored blob instead so a deleted voice note/status frees its bytes.
  if (isLocalMediaUrl(url)) return deleteLocalMediaBlob(url);
  // Data URLs and external URLs have no S3 object behind them — nothing to delete.
  const key = extractS3KeyFromUrl(url);
  if (!key) return false;
  if (!getAwsEnvConfig().s3Bucket) return false;
  try {
    await remove({ path: key });
    return true;
  } catch (err) {
    console.warn('S3 media delete failed:', err);
    return false;
  }
};

/** Delete every S3 object referenced by the given media URLs (best-effort, never throws). */
export const deleteChatMediaMany = async (urls: Array<string | undefined | null>): Promise<number> => {
  let deleted = 0;
  for (const url of urls || []) {
    try {
      if (url && (await deleteChatMedia(url))) deleted += 1;
    } catch { /* intentionally ignored */}
  }
  return deleted;
};

