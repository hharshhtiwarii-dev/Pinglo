/**
 * MF-01 — View-once viewer (SCAFFOLD): the "one-way valve".
 *
 * Hermes grounded idea (Ponytail+Hermes review, MF-01, TRIZ): render
 * view-once media through a DEDICATED viewer that never receives a
 * copyable URL — bytes are held in memory, drawn to a `<canvas>`
 * (no `<img src>`), the blob is revoked on unmount (VO-04), no `items`
 * list is passed (VO-02, no swiping into neighbouring media) and
 * there are deliberately NO download / share buttons (VO-02).
 *
 * What this scaffold DOES:
 * - canvas render for images (createImageBitmap) and video (hidden
 *   <video> element, rAF frame pump onto the canvas);
 * - revokes the object URL on unmount;
 * - blocks the context menu / drag on the viewer surface;
 * - notifies `onOpened` once the first frame is drawn.
 *
 * TODOs for the implementing worker:
 * - pinch-zoom (canvas breaks the lightbox's pinch-zoom; re-implement
 *   or accept fixed fit — see Hermes failure mode);
 * - wire `fetchViewOnceBytes` through the E2EE decrypt path instead
 *   of the plain-URL fetch used here as the scaffold fallback;
 * - call `setViewOnceSecureMode(true)` on mount / `false` on unmount
 *   once the Capacitor bridge exists (VO-05);
 * - video: pause + blank the canvas the moment the viewer closes so
 *   no frame lingers in the compositor (done — cleanup clears it).
 */
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { navigationManager } from '../services/navigation';
import { fetchViewOnceBytes, revokeViewOnceBytes } from '../services/viewOnce';
import type { ViewOnceMediaType } from '../types/viewOnce';

export interface ViewOnceViewerProps {
  isOpen: boolean;
  onClose: () => void;
  mediaUrl: string;
  mediaType: ViewOnceMediaType;
  senderName?: string;
  time?: string;
  /** Fired once, when the first frame is drawn. The caller marks the
   * message viewed (VO-03) in the same action that opens the viewer. */
  onOpened?: () => void;
  onToast?: (msg: string) => void;
}

export default function ViewOnceViewer({
  isOpen,
  onClose,
  mediaUrl,
  mediaType,
  senderName,
  time,
  onOpened,
  onToast,
}: ViewOnceViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const openedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Back-button closes the viewer (same pattern as MediaLightbox).
  useEffect(() => {
    if (!isOpen) return;
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
  }, [isOpen, onClose]);

  // Escape closes the viewer.
  useEffect(() => {
    if (!isOpen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [isOpen, onClose]);

  // VO-02/VO-04: load bytes into memory, draw to canvas, revoke on unmount.
  useEffect(() => {
    if (!isOpen || !mediaUrl) return;
    openedRef.current = false;
    setError(null);
    let cancelled = false;
    let raf = 0;

    const drawImage = async (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const bitmap = await createImageBitmap(blob);
      if (cancelled) {
        bitmap.close();
        return;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (!openedRef.current) {
        openedRef.current = true;
        onOpened?.();
      }
    };

    const drawVideo = async (blob: Blob) => {
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const video = videoRef.current;
      if (!video) return;
      video.src = url;
      await video.play().catch(() => {
        // Autoplay with sound can be refused; muted retry is the fallback.
        video.muted = true;
        return video.play().catch(() => undefined);
      });
      if (cancelled) return;
      const pump = () => {
        const canvas = canvasRef.current;
        if (canvas && video.videoWidth > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d')?.drawImage(video, 0, 0);
          if (!openedRef.current) {
            openedRef.current = true;
            onOpened?.();
          }
        }
        if (!cancelled && !video.ended) raf = requestAnimationFrame(pump);
      };
      raf = requestAnimationFrame(pump);
    };

    fetchViewOnceBytes({ mediaUrl })
      .then((blob) => (mediaType === 'video' ? drawVideo(blob) : drawImage(blob)))
      .catch((e) => {
        if (cancelled) return;
        console.warn('[ViewOnceViewer] could not load view-once media:', e);
        setError('Could not open this view-once media');
        onToast?.('Could not open this view-once media');
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      videoRef.current?.pause();
      if (videoRef.current) videoRef.current.removeAttribute('src');
      // VO-04: revoke the in-memory blob as soon as the viewer goes away.
      revokeViewOnceBytes(objectUrlRef.current);
      objectUrlRef.current = null;
      // WA parity (DM audit row 82): blank the canvas so no frame
      // lingers in the compositor after close.
      const cv = canvasRef.current;
      if (cv) cv.getContext('2d')?.clearRect(0, 0, cv.width, cv.height);
    };
  }, [isOpen, mediaUrl, mediaType, onOpened, onToast]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[130] bg-black/95 flex flex-col justify-between animate-fade-in select-none"
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
      role="dialog"
      aria-modal="true"
      aria-label={senderName ? `View-once media from ${senderName}` : 'View-once media'}
    >
      {/* Top bar — intentionally NO download / share buttons (VO-02). */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col text-white">
          <span className="font-semibold text-sm">{senderName || 'View once'}</span>
          {time && <span className="text-xs text-gray-400">{time}</span>}
          <span className="text-xs text-gray-400">View once • Cannot be saved or shared</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close view-once viewer"
          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full hover:bg-white/10 text-white transition-colors"
          title="Close"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      {/* Canvas surface — the media never appears as an <img src> (VO-02). */}
      <div
        className="flex-1 flex items-center justify-center p-2 overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {error ? (
          <p className="text-sm text-gray-300">{error}</p>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
              draggable={false}
              aria-label="View-once media"
            />
            {/* Hidden video source for the canvas frame pump (video only). */}
            {mediaType === 'video' && (
              <video ref={videoRef} className="hidden" playsInline loop muted={false} />
            )}
          </>
        )}
      </div>

      <div className="h-8" />
    </div>
  );
}
