import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { regeneratePhotoUrl } from '../services/devAI';

/**
 * Generated-photo bubble for Dev AI (Pollinations, free, no key).
 *
 * The old code rendered a bare `<img src={url}>` with no load/error
 * handling at all — when Pollinations was slow, rate-limited (429) or
 * unreachable, the bubble showed a broken-image icon forever next to the
 * text "photo ban rahi hai", with no error and no way to retry. It looked
 * exactly like the infinite loading from #259.
 *
 * This component applies the #259 pattern to the image path:
 *  - loading placeholder while the image generates (never a bare spinner
 *    with no explanation),
 *  - per-attempt timeout (default 45 s — free-tier generation commonly
 *    takes 5–30 s, longer than a text reply, so the text timeout of 15 s
 *    would false-fail here),
 *  - honest error state + one-tap retry (fresh seed = a new generation),
 *  - a late load that arrives after the timeout still recovers to the image.
 */
export const DEV_AI_PHOTO_TIMEOUT_MS = 45_000;

type PhotoStatus = 'loading' | 'loaded' | 'error';

interface DevAIGeneratedImageProps {
  src: string;
  alt?: string;
  /** Overridable for tests — production default is DEV_AI_PHOTO_TIMEOUT_MS. */
  timeoutMs?: number;
}

export default function DevAIGeneratedImage({
  src: initialSrc,
  alt = 'Generated photo',
  timeoutMs = DEV_AI_PHOTO_TIMEOUT_MS,
}: DevAIGeneratedImageProps) {
  const [src, setSrc] = useState(initialSrc);
  const [status, setStatus] = useState<PhotoStatus>('loading');
  const [attempts, setAttempts] = useState(1);
  const timerRef = useRef<number | null>(null);
  const settledRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const armTimeout = useCallback(() => {
    clearTimer();
    settledRef.current = false;
    timerRef.current = window.setTimeout(() => {
      if (!settledRef.current) {
        settledRef.current = true;
        setStatus('error');
      }
    }, timeoutMs);
  }, [clearTimer, timeoutMs]);

  // New image (new message, or a retry with a fresh seed): start loading.
  useEffect(() => {
    armTimeout();
    return clearTimer;
  }, [src, armTimeout, clearTimer]);

  // A new src prop (new message reusing this instance): reset fully.
  useEffect(() => {
    setSrc(initialSrc);
    setAttempts(1);
    setStatus('loading');
  }, [initialSrc]);

  const handleLoad = useCallback(() => {
    // Late load after the timeout fired: recover to the image instead of
    // leaving the error on screen.
    settledRef.current = true;
    clearTimer();
    setStatus('loaded');
  }, [clearTimer]);

  const handleError = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    clearTimer();
    setStatus('error');
  }, [clearTimer]);

  const retry = useCallback(() => {
    const next = regeneratePhotoUrl(src);
    setAttempts((a) => a + 1);
    // Re-arm here, not only in the src-change effect: for a non-Pollinations
    // URL the regenerated src is identical, so that effect does NOT re-run —
    // without this, settledRef stays true from the failed attempt and the
    // remounted <img>'s onError is swallowed, leaving the bubble on
    // "loading" forever (the exact #259-style hang this component exists
    // to prevent). armTimeout() clears any previous timer first, so the
    // src-change effect re-arming right after is harmless.
    armTimeout();
    setSrc(next);
    setStatus('loading');
  }, [src, armTimeout]);

  return (
    <div className="w-full max-w-xs mb-2">
      {/* The <img> stays mounted in every state so the browser keeps
          loading it; it is only shown once it actually loaded. */}
      <img
        key={`${attempts}-${src}`}
        src={src}
        alt={alt}
        onLoad={handleLoad}
        onError={handleError}
        className={`w-full rounded-lg object-cover ${status === 'loaded' ? '' : 'hidden'}`}
      />
      {status === 'loading' && (
        <div
          data-testid="devai-photo-loading"
          className="w-full aspect-square rounded-lg bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3 text-center"
        >
          <div className="h-6 w-6 rounded-full border-2 border-primary-green border-t-transparent animate-spin" aria-label="Loading" />
          <p className="text-xs text-gray-500 dark:text-text-secondary">Photo ban rahi hai… 🎨</p>
          <p className="text-[11px] text-gray-400 dark:text-text-secondary/70">
            Free Pollinations se generate ho rahi hai, kuch seconds lagenge
          </p>
        </div>
      )}
      {status === 'error' && (
        <div
          data-testid="devai-photo-error"
          className="w-full rounded-lg bg-black/5 dark:bg-white/5 flex flex-col items-center justify-center gap-2 px-3 py-6 text-center"
        >
          <p className="text-sm font-medium">Photo load nahi hui 😅</p>
          <p className="text-xs text-gray-500 dark:text-text-secondary">
            Free Pollinations limit ya network issue ho sakta hai — thoda ruk ke dobara try karo.
          </p>
          <button
            type="button"
            onClick={retry}
            className="flex items-center gap-1.5 rounded-full bg-green-cta px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:opacity-90"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Dobara try karo
          </button>
        </div>
      )}
    </div>
  );
}
