import { registerPlugin, Capacitor } from '@capacitor/core';

interface FileSaverPlugin {
  save(options: { url: string; fileName: string }): Promise<{ ok: boolean }>;
}

// Native DownloadManager bridge (android/.../FileSaverPlugin.java).
// Android WebViews do not save blob: or <a download> files, so the app must do it.
const FileSaver = registerPlugin<FileSaverPlugin>('FileSaver');

/** Keep only characters that are safe in a file name. */
export const safeFileName = (name: string | undefined | null, fallback = 'file'): string => {
  // eslint-disable-next-line no-control-regex -- the \x00-\x1f range is the point: control characters must be stripped from file names.
  const cleaned = (name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned.slice(0, 180) || fallback;
};

/** Fallback name from the URL path, e.g. .../media/abc.pdf -> abc.pdf */
export const fileNameFromUrl = (url: string, fallback: string): string => {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return safeFileName(last, fallback);
  } catch {
    return safeFileName(fallback);
  }
};

/** Save a remote file to the phone's Downloads (native) or start a browser download (web). */
export const saveRemoteFile = async (url: string, fileName: string): Promise<boolean> => {
  if (!url) return false;
  const name = safeFileName(fileName);
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await FileSaver.save({ url, fileName: name });
      return !!res?.ok;
    } catch {
      return false;
    }
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
};
