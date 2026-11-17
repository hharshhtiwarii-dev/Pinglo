import React, { useCallback, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface PhotoCropperProps {
  /** Data-URL (or object URL) of the picked image. */
  src: string;
  onCancel: () => void;
  /** Cropped square JPEG blob (512×512). */
  onCrop: (blob: Blob) => void;
}

const BOX = 280; // on-screen crop window, px
const OUTPUT = 512; // exported square, px

/**
 * WhatsApp-style profile-photo cropper: drag to pan, slider to zoom, circular
 * preview mask. No new dependency — plain <img> + canvas.
 */
export default function PhotoCropper({ src, onCancel, onCrop }: PhotoCropperProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  // Zoom multiplier over the "cover the box" base scale.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const baseScale = natural.w && natural.h ? BOX / Math.min(natural.w, natural.h) : 1;
  const effScale = baseScale * scale;

  const clampOffset = useCallback((x: number, y: number, s: number) => {
    const w = natural.w * s;
    const h = natural.h * s;
    return {
      x: Math.min(0, Math.max(BOX - w, x)),
      y: Math.min(0, Math.max(BOX - h, y)),
    };
  }, [natural]);

  const onImgLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setNatural({ w, h });
    const bs = BOX / Math.min(w, h);
    setScale(1);
    setOffset({ x: (BOX - w * bs) / 2, y: (BOX - h * bs) / 2 });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clampOffset(d.ox + (e.clientX - d.px), d.oy + (e.clientY - d.py), effScale));
  };
  const endDrag = () => { dragRef.current = null; };

  const onZoom = (v: number) => {
    setScale(v);
    setOffset((prev) => clampOffset(prev.x, prev.y, baseScale * v));
  };

  const handleSave = () => {
    const img = imgRef.current;
    if (!img || saving) return;
    setSaving(true);
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setSaving(false); return; }
    const s = BOX / effScale;
    ctx.drawImage(img, -offset.x / effScale, -offset.y / effScale, s, s, 0, 0, OUTPUT, OUTPUT);
    canvas.toBlob((blob) => {
      setSaving(false);
      if (blob) onCrop(blob);
    }, 'image/jpeg', 0.9);
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Crop profile photo">
      <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-4 shadow-2xl space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">Crop photo</h3>
          <button onClick={onCancel} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Cancel cropping">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div
          className="relative mx-auto overflow-hidden rounded-full cursor-grab active:cursor-grabbing select-none"
          style={{ width: BOX, height: BOX, touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <img
            ref={imgRef}
            src={src}
            alt="Crop preview"
            draggable={false}
            onLoad={onImgLoad}
            className="absolute max-w-none"
            style={{
              width: natural.w ? natural.w * effScale : undefined,
              height: natural.h ? natural.h * effScale : undefined,
              left: offset.x,
              top: offset.y,
            }}
          />
          <svg className="absolute inset-0 pointer-events-none" width={BOX} height={BOX} aria-hidden="true">
            <defs>
              <mask id="dt-crop-mask">
                <rect width="100%" height="100%" fill="white" />
                <circle cx={BOX / 2} cy={BOX / 2} r={BOX / 2} fill="black" />
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#dt-crop-mask)" />
            <circle cx={BOX / 2} cy={BOX / 2} r={BOX / 2 - 1} fill="none" stroke="white" strokeWidth="2" />
          </svg>
        </div>
        <p className="text-xs text-center text-gray-500 dark:text-text-secondary">Drag to position · zoom to fit</p>

        <div className="flex items-center gap-3 px-1">
          <span className="text-xs text-gray-500 dark:text-text-secondary">−</span>
          <input
            type="range" min={1} max={3} step={0.01} value={scale}
            onChange={(e) => onZoom(parseFloat(e.target.value))}
            className="flex-1 accent-[#075E54]"
            aria-label="Zoom"
          />
          <span className="text-xs text-gray-500 dark:text-text-secondary">+</span>
        </div>

        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 py-3 bg-gray-100 dark:bg-input-dark rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-panel-dark transition-all">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving || !natural.w} className="flex-1 py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green transition-all disabled:opacity-50">
            {saving ? 'Saving…' : 'Crop & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
