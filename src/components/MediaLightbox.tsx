import React, { useEffect, useRef, useState } from 'react';
import { X, Download, Share2, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { navigationManager } from '../services/navigation';
import { saveRemoteFile, fileNameFromUrl } from '../services/fileSave';

export interface LightboxItem {
  url: string;
  type: 'image' | 'video';
  senderName?: string;
  time?: string;
  /** 100M-H20: the media caption (chatMediaItems carries it) — shown
   *  under the photo/video, like WhatsApp's viewer. */
  caption?: string;
}

interface MediaLightboxProps {
  isOpen: boolean;
  onClose: () => void;
  mediaUrl: string;
  mediaType?: 'image' | 'video';
  senderName?: string;
  time?: string;
  /** 100M-H20: caption for the single-item fallback (same as item.caption). */
  caption?: string;
  /** Phase 5 (L-14): false inside a locked chat — downloading would copy
   * the media out of the app's lock into device storage. Default true. */
  allowDownload?: boolean;
  /** #215: the list to swipe through (e.g. an album, or all chat media).
   * When absent the lightbox shows the single `mediaUrl` only. */
  items?: LightboxItem[];
  /** Index of the current item inside `items`. */
  index?: number;
  /** #215: called with the new index on prev/next / swipe. */
  onNavigate?: (index: number) => void;
  /** #219: user feedback for download / share ("Saved to Downloads ✓"). */
  onToast?: (msg: string) => void;
  /** G2b: fired when the shown media actually loads (img onLoad, video
   * onCanPlay/onPlaying) — the caller uses it to consume a one-time view
   * only after the media is really visible. */
  onMediaLoad?: () => void;
  /** G2b: fired when the shown media fails to load — the caller leaves
   * the one-time view unspent and shows a retry. */
  onMediaError?: () => void;
  /** G2c: false while a view-once item is shown — sharing would copy the
   * media out of its one-time view. Default true. */
  allowShare?: boolean;
}

const clampScale = (s: number) => Math.min(4, Math.max(1, s));

// 100M-H20 excellence: URLs in the caption are tappable links, like the
// chat bubble renders them (WhatsApp linkifies viewer captions too).
// Split on http(s) URLs; non-URL parts render as plain spans so the
// caption text is unchanged.
const renderCaptionLinks = (text: string) => {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    /^https?:\/\/[^\s]+$/.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" className="text-sky-300 underline underline-offset-2 break-all">{part}</a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
};

export default function MediaLightbox({
  isOpen,
  onClose,
  mediaUrl,
  mediaType = 'image',
  senderName,
  time,
  caption,
  allowDownload = true,
  items,
  index = 0,
  onNavigate,
  onToast,
  onMediaLoad,
  onMediaError,
  allowShare = true,
}: MediaLightboxProps) {
  // #215: zoom + pan state. Reset whenever the shown item changes.
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const gestureRef = useRef({
    pointers: new Map<number, { x: number; y: number }>(),
    pinchStart: 0,
    pinchScale: 1,
    swipeStartX: 0,
    swipeStartY: 0,
  });

  const list = items && items.length > 0 ? items : [{ url: mediaUrl, type: mediaType, senderName, time, caption }];
  const current = list[Math.min(Math.max(index, 0), list.length - 1)] || { url: mediaUrl, type: mediaType, senderName, time, caption };
  const hasNav = list.length > 1 && !!onNavigate;

  useEffect(() => {
    if (!isOpen) return;
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [isOpen, onClose]);

  // Phase 3: Escape closes the lightbox.
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (hasNav && e.key === 'ArrowLeft') onNavigate(Math.max(0, index - 1));
      if (hasNav && e.key === 'ArrowRight') onNavigate(Math.min(list.length - 1, index + 1));
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [isOpen, onClose, hasNav, index, list.length, onNavigate]);

  // Zoom resets on every item change.
  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, [current.url]);

  if (!isOpen || !current.url) return null;

  const goTo = (next: number) => {
    if (!hasNav) return;
    const clamped = Math.min(Math.max(next, 0), list.length - 1);
    if (clamped !== index) onNavigate(clamped);
  };

  const handleDownload = async () => {
    const fallback = `pinglo_${current.type}_${Date.now()}.${current.type === 'video' ? 'mp4' : 'jpg'}`;
    const name = fileNameFromUrl(current.url, fallback);
    const ok = await saveRemoteFile(current.url, name);
    // #219: the download used to be silent — say whether it worked.
    if (ok) onToast?.('Saved to Downloads ✓');
    else {
      onToast?.('Could not save file');
      window.open(current.url, '_blank');
    }
  };

  // #215: share the shown media. Native share sheet when available,
  // otherwise fall back to a download. A cancelled share sheet
  // (AbortError) must NOT trigger a download.
  const handleShare = async () => {
    const fallback = `pinglo_${current.type}_${Date.now()}.${current.type === 'video' ? 'mp4' : 'jpg'}`;
    const name = fileNameFromUrl(current.url, fallback);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          url: current.url,
          title: current.senderName ? `Media from ${current.senderName}` : 'Photo',
        });
        onToast?.('Shared ✓');
        return;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        // Share failed (e.g. data: URL) — fall through to download.
      }
    }
    const ok = await saveRemoteFile(current.url, name);
    if (ok) onToast?.('Saved to Downloads ✓');
    else onToast?.('Could not share this media');
  };

  const zoomBy = (delta: number) => {
    setScale((s) => {
      const next = clampScale(s + delta);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  // #215: pinch-zoom (two pointers), drag-to-pan when zoomed, swipe
  // left/right to the next/previous item when not zoomed.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const g = gestureRef.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 1) {
      g.swipeStartX = e.clientX;
      g.swipeStartY = e.clientY;
    }
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      g.pinchStart = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      g.pinchScale = scale;
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    const prev = g.pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 2) {
      const [a, b] = [...g.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (g.pinchStart > 0) {
        const next = clampScale(g.pinchScale * (dist / g.pinchStart));
        setScale(next);
        if (next === 1) setPan({ x: 0, y: 0 });
      }
    } else if (scale > 1) {
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    const wasSingle = g.pointers.size === 1;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size < 2) g.pinchStart = 0;
    // Swipe (not zoomed, single finger, mostly horizontal).
    if (wasSingle && scale === 1 && hasNav) {
      const dx = e.clientX - g.swipeStartX;
      const dy = e.clientY - g.swipeStartY;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        goTo(dx < 0 ? index + 1 : index - 1);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/95 flex flex-col justify-between animate-fade-in select-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={current.senderName ? `Media from ${current.senderName}` : 'Media preview'}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col text-white">
          <span className="font-semibold text-sm">{current.senderName || 'Photo'}</span>
          {current.time && <span className="text-xs text-gray-400">{current.time}</span>}
          {list.length > 1 && (
            <span className="text-xs text-gray-400">{index + 1} / {list.length}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => zoomBy(-0.5)}
            aria-label="Zoom out"
            disabled={scale <= 1}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 text-white transition-colors disabled:opacity-30"
            title="Zoom out"
          >
            <ZoomOut className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(0.5)}
            aria-label="Zoom in"
            disabled={scale >= 4}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 text-white transition-colors disabled:opacity-30"
            title="Zoom in"
          >
            <ZoomIn className="h-5 w-5" />
          </button>
          {/* G2c: no Share button on a view-once item — sharing would
              copy the media out of its one-time view. */}
          {allowShare && (
            <button
              type="button"
              onClick={handleShare}
              aria-label="Share media"
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 text-white transition-colors"
              title="Share"
            >
              <Share2 className="h-5 w-5" />
            </button>
          )}
          {allowDownload && (
            <button
              type="button"
              onClick={handleDownload}
              aria-label="Download media"
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 text-white transition-colors"
              title="Download"
            >
              <Download className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 text-white transition-colors"
            title="Close"
          >
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Main Media Container */}
      <div
        className="flex-1 flex items-center justify-center p-2 overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          // Double-tap toggles 1x / 2x.
          setScale((s) => {
            const next = s > 1 ? 1 : 2;
            if (next === 1) setPan({ x: 0, y: 0 });
            return next;
          });
        }}
        onWheel={(e) => {
          setScale((s) => {
            const next = clampScale(s * Math.exp(-e.deltaY * 0.0015));
            if (next === 1) setPan({ x: 0, y: 0 });
            return next;
          });
        }}
        style={{ touchAction: 'none' }}
      >
        <div
          data-lightbox-zoom={scale.toFixed(2)}
          className="max-h-full max-w-full flex items-center justify-center"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        >
          {current.type === 'video' ? (
            <video
              src={current.url}
              controls
              autoPlay
              onCanPlay={() => onMediaLoad?.()}
              onPlaying={() => onMediaLoad?.()}
              onError={() => onMediaError?.()}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            />
          ) : (
            <img
              src={current.url}
              alt="Preview"
              onLoad={() => onMediaLoad?.()}
              onError={() => onMediaError?.()}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              draggable={false}
            />
          )}
        </div>
        {hasNav && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); goTo(index - 1); }}
              aria-label="Previous photo"
              disabled={index <= 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors disabled:opacity-30"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); goTo(index + 1); }}
              aria-label="Next photo"
              disabled={index >= list.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors disabled:opacity-30"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}
      </div>

      {/* 100M-H20: media caption under the photo/video (WhatsApp shows
          it in the viewer). stopPropagation: the root closes on click,
          and tapping the caption must not dismiss the viewer. */}
      {current.caption ? (
        <div className="flex-shrink-0 px-4 pb-4 pt-2" onClick={(e) => e.stopPropagation()}>
          <p data-testid="lightbox-caption" className="text-center text-sm text-white/90 leading-snug whitespace-pre-wrap break-words">{renderCaptionLinks(current.caption)}</p>
        </div>
      ) : (
        <div className="h-8" />
      )}
    </div>
  );
}
