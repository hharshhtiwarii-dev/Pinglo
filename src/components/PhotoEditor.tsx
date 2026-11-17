import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, PenLine, RotateCw, Send, Smile, Trash2, Type, Undo2, X } from 'lucide-react';
import { EMOJI_CATEGORIES } from './EmojiPicker';

/**
 * ROADMAP-2 item 7 — WhatsApp-style photo editor (canvas-based).
 *
 * Flow: ChatScreen opens this modal for a single picked photo (gallery pick
 * or in-app camera capture) instead of sending the raw file. The user draws,
 * adds text, crops and drops emoji overlays, then Send exports the canvas
 * to a JPEG File and hands it to the existing send path (sendFile). Cancel
 * discards every edit — the original file is never sent.
 *
 * Coordinate model (kept in ONE place so draw / text / emoji / crop agree):
 * - strokes and overlays live in FULL-image normalised coords (0..1).
 * - `crop` is a normalised rect into the full image (default: whole image).
 * - The on-screen canvas shows the CROPPED region, except while the crop
 *   tool is active, when it shows the FULL image with the crop rect drawn
 *   over it (dimmed outside + corner handles) — that is the only view in
 *   which the crop rect is directly manipulable.
 * - Export renders the cropped region at up to 2048 px on the long edge,
 *   then replays strokes / text / emoji mapped into the cropped space.
 *
 * The profile-photo cropper (PhotoCropper.tsx) is untouched: it is a
 * separate square-avatar flow in Settings and still works as before.
 * This editor deliberately reuses only the emoji *data* (EMOJI_CATEGORIES)
 * from EmojiPicker — the picker UI itself is a composer panel, not an
 * overlay grid, so it is not reused here.
 */

export interface EditorPoint { x: number; y: number }
export interface EditorStroke { color: string; size: number; points: EditorPoint[] }
export interface EditorTextItem { id: string; kind: 'text'; text: string; x: number; y: number; color: string; size: number }
export interface EditorEmojiItem { id: string; kind: 'emoji'; emoji: string; x: number; y: number; size: number }
export type EditorOverlay = EditorTextItem | EditorEmojiItem;
export interface EditorCrop { x: number; y: number; w: number; h: number }
/** WA parity (media audit §1e A14): 90° rotation. Rotation applies AFTER
 *  the crop on export (crop rects stay in the original orientation, so
 *  the crop view always shows the unrotated photo) and rotates strokes /
 *  overlays with the image, like WhatsApp. */
export interface EditorState { strokes: EditorStroke[]; overlays: EditorOverlay[]; crop: EditorCrop; rotation: number }

export const FULL_CROP: EditorCrop = { x: 0, y: 0, w: 1, h: 1 };
export const DRAW_COLORS = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ff2d92'];
export const MAX_EXPORT_DIM = 2048;
/** Overlay/text sizes are stored in px on a 1000-px-wide reference canvas. */
export const SIZE_REF = 1000;

let overlaySeq = 0;
export function nextOverlayId(): string {
  overlaySeq += 1;
  return `ov_${Date.now().toString(36)}_${overlaySeq}`;
}

/** Pure: largest centred rect of the given aspect inside the image (aspect = w/h; null = full image). */
export function cropForAspect(aspect: number | null, imgW: number, imgH: number): EditorCrop {
  if (!aspect || !imgW || !imgH) return { ...FULL_CROP };
  const imgAspect = imgW / imgH;
  if (Math.abs(imgAspect - aspect) < 0.001) return { ...FULL_CROP };
  if (imgAspect > aspect) {
    const w = imgH * aspect / imgW;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = imgW / aspect / imgH;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** Pure: clamp a crop rect so it stays inside the image with a minimum size. */
export function clampCrop(c: EditorCrop): EditorCrop {
  const w = Math.min(1, Math.max(0.05, c.w));
  const h = Math.min(1, Math.max(0.05, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  return { x, y, w, h };
}

function drawStateOnto(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  state: EditorState,
  outW: number,
  outH: number,
): void {
  const { crop } = state;
  const sx = crop.x * img.naturalWidth;
  const sy = crop.y * img.naturalHeight;
  const sw = crop.w * img.naturalWidth;
  const sh = crop.h * img.naturalHeight;
  ctx.clearRect(0, 0, outW, outH);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);
  const toOut = (p: EditorPoint): EditorPoint => ({
    x: ((p.x - crop.x) / crop.w) * outW,
    y: ((p.y - crop.y) / crop.h) * outH,
  });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of state.strokes) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, (s.size * outW) / SIZE_REF);
    ctx.beginPath();
    const first = toOut(s.points[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < s.points.length; i++) {
      const p = toOut(s.points[i]);
      ctx.lineTo(p.x, p.y);
    }
    if (s.points.length === 1) ctx.lineTo(first.x + 0.01, first.y + 0.01);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const o of state.overlays) {
    const p = toOut(o);
    if (o.kind === 'text') {
      const px = Math.max(8, (o.size * outW) / SIZE_REF);
      ctx.font = `700 ${px}px system-ui, -apple-system, sans-serif`;
      ctx.lineWidth = Math.max(2, px / 8);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(o.text, p.x, p.y);
      ctx.fillStyle = o.color;
      ctx.fillText(o.text, p.x, p.y);
    } else {
      const px = Math.max(8, (o.size * outW) / SIZE_REF);
      ctx.font = `${px}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(o.emoji, p.x, p.y);
    }
  }
}

/** Render the edited image onto a target ctx, rotating the finished
 *  render (crop + strokes + overlays together) when rotation is set.
 *  The offscreen render is drawn at the pre-rotation size, then blitted
 *  rotated into the (possibly swapped) target dims. */
function renderEditedOnto(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  state: EditorState,
  outW: number,
  outH: number,
): void {
  const rot = ((state.rotation || 0) % 360 + 360) % 360;
  if (!rot) {
    drawStateOnto(ctx, img, state, outW, outH);
    return;
  }
  const swap = rot === 90 || rot === 270;
  const off = document.createElement('canvas');
  off.width = swap ? outH : outW;
  off.height = swap ? outW : outH;
  const offCtx = off.getContext('2d');
  if (!offCtx) {
    drawStateOnto(ctx, img, state, outW, outH);
    return;
  }
  drawStateOnto(offCtx, img, state, off.width, off.height);
  ctx.clearRect(0, 0, outW, outH);
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(off, -off.width / 2, -off.height / 2);
  ctx.restore();
}

/** Pure export: render the edited image to a JPEG blob (max 2048 px long edge). */
export async function exportEditedImage(img: HTMLImageElement, state: EditorState): Promise<Blob> {
  const { crop } = state;
  const cropW = Math.max(1, Math.round(crop.w * img.naturalWidth));
  const cropH = Math.max(1, Math.round(crop.h * img.naturalHeight));
  const scale = Math.min(1, MAX_EXPORT_DIM / Math.max(cropW, cropH));
  const rot = ((state.rotation || 0) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const outW = Math.max(1, Math.round((swap ? cropH : cropW) * scale));
  const outH = Math.max(1, Math.round((swap ? cropW : cropH) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  renderEditedOnto(ctx, img, state, outW, outH);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  if (!blob) throw new Error('Could not export the edited photo.');
  return blob;
}

/** Pure helper (unit/probe-friendly): does the state differ from the untouched photo? */
export function hasEdits(state: EditorState): boolean {
  return (
    state.strokes.length > 0 ||
    state.overlays.length > 0 ||
    (state.rotation || 0) % 360 !== 0 ||
    Math.abs(state.crop.x) > 0.001 ||
    Math.abs(state.crop.y) > 0.001 ||
    Math.abs(state.crop.w - 1) > 0.001 ||
    Math.abs(state.crop.h - 1) > 0.001
  );
}

export const CROP_PRESETS: { label: string; aspect: number | null }[] = [
  { label: 'Original', aspect: null },
  { label: '1:1', aspect: 1 },
  { label: '4:3', aspect: 4 / 3 },
  { label: '3:4', aspect: 3 / 4 },
  { label: '16:9', aspect: 16 / 9 },
  { label: '9:16', aspect: 9 / 16 },
];

type Tool = 'draw' | 'text' | 'emoji' | 'crop';

interface PhotoEditorProps {
  src: string;
  fileName?: string;
  onCancel: () => void;
  /** The EDITED image as a JPEG File — hand it straight to the send path.
   * 100M-F2: the optional caption travels with it (encrypted as
   * `e2eeCaption` by the write pipeline); empty means no caption.
   * WA parity (DM audit rows 65–66): the third arg is the HD toggle —
   * the edited photo is sent as an HD original when true. */
  onSend: (file: File, caption?: string, isHD?: boolean) => void;
}

export default function PhotoEditor({ src, fileName, onCancel, onSend }: PhotoEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // 100M-F2: caption for the photo (WhatsApp-style, under the canvas).
  const [caption, setCaption] = useState('');
  // WA parity (DM audit rows 65–66): HD photo option — the edited JPEG
  // is sent as an HD original when on (badge on the bubble).
  const [sendHD, setSendHD] = useState(false);
  // #217: the stage size (measured, not assumed) so the canvas can fill
  // the screen instead of a fixed 360px box.
  const [stageSize, setStageSize] = useState({ w: 360, h: 480 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setStageSize({
      w: Math.max(240, el.clientWidth - 16),
      h: Math.max(200, el.clientHeight - 16),
    });
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', update);
    return () => { ro?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [loadError, setLoadError] = useState('');
  const [tool, setTool] = useState<Tool>('draw');
  const [strokes, setStrokes] = useState<EditorStroke[]>([]);
  const [overlays, setOverlays] = useState<EditorOverlay[]>([]);
  const [crop, setCrop] = useState<EditorCrop>({ ...FULL_CROP });
  // WA parity A14: 90° rotation steps (0/90/180/270). Applied after the
  // crop on export; the crop view always shows the original orientation.
  const [rotation, setRotation] = useState(0);
  const [history, setHistory] = useState<EditorState[]>([]);
  const [drawColor, setDrawColor] = useState('#ff3b30');
  const [drawSize, setDrawSize] = useState(8);
  const [textColor] = useState('#ffffff');
  const [textSize] = useState(48);
  const [textInput, setTextInput] = useState('');
  const [emojiCategory, setEmojiCategory] = useState('Smileys');
  const [emojiSize] = useState(72);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  // Live (in-progress) interaction state — refs so pointermove stays cheap.
  const gestureRef = useRef<
    | { kind: 'stroke'; stroke: EditorStroke }
    | { kind: 'drag-overlay'; id: string; dx: number; dy: number }
    | { kind: 'crop-corner'; corner: 'nw' | 'ne' | 'sw' | 'se'; start: EditorCrop; px: number; py: number }
    | null
  >(null);
  const [, setGestureTick] = useState(0);
  const stateRef = useRef({ strokes, overlays, crop, rotation });
  stateRef.current = { strokes, overlays, crop, rotation };

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      if (!cancelled) setLoadError('Could not load this photo for editing.');
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [src]);

  // Canvas display size: fit the visible region (cropped, or full while cropping)
  // into the measured stage, preserving aspect — edge-to-edge on a phone,
  // never clipped top/bottom for tall photos. (Was a fixed 360px box: a
  // 9:16 photo rendered 360×640 and overflowed the ~480px stage.)
  // Rotation swaps the displayed aspect (90°/270°), except in crop view,
  // which always shows the original orientation (crop applies first).
  const rotatedView = rotation % 180 !== 0 && tool !== 'crop';
  const effW = rotatedView ? natural.h : natural.w;
  const effH = rotatedView ? natural.w : natural.h;
  const visibleCrop = tool === 'crop' ? FULL_CROP : crop;
  const imgAspect = effW && effH
    ? (visibleCrop.w * effW) / (visibleCrop.h * effH)
    : 1;
  const dispW = natural.w && natural.h
    ? Math.max(200, Math.min(stageSize.w, Math.round(stageSize.h * imgAspect)))
    : stageSize.w;
  const dispH = natural.w && natural.h
    ? Math.max(120, Math.round(dispW / imgAspect))
    : 360;

  const pushHistory = useCallback(() => {
    setHistory((prev) => [...prev.slice(-29), { ...stateRef.current }]);
  }, []);

  const undo = useCallback(() => {
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      setStrokes(last.strokes);
      setOverlays(last.overlays);
      setCrop(last.crop);
      setRotation(last.rotation || 0);
      setSelectedId(null);
      return prev.slice(0, -1);
    });
  }, []);

  const rotate90 = useCallback(() => {
    if (!natural.w || exporting) return;
    pushHistory();
    setRotation((r) => (r + 90) % 360);
  }, [natural.w, exporting, pushHistory]);

  // Redraw the canvas whenever anything visible changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !natural.w) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (tool === 'crop') {
      // Full image + dimmed area outside the crop rect.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      drawStateOntoOverlayOnly(ctx, img, stateRef.current, canvas.width, canvas.height);
      const rx = crop.x * canvas.width;
      const ry = crop.y * canvas.height;
      const rw = crop.w * canvas.width;
      const rh = crop.h * canvas.height;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, canvas.width, ry);
      ctx.fillRect(0, ry + rh, canvas.width, canvas.height - ry - rh);
      ctx.fillRect(0, ry, rx, rh);
      ctx.fillRect(rx + rw, ry, canvas.width - rx - rw, rh);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
    } else {
      renderEditedOnto(ctx, img, stateRef.current, canvas.width, canvas.height);
    }
    // Selection ring around the selected overlay (rotated back into
    // display coords when the photo is rotated 90°/270°).
    const sel = stateRef.current.overlays.find((o) => o.id === selectedId);
    if (sel && tool !== 'crop') {
      const qx = ((sel.x - crop.x) / crop.w);
      const qy = ((sel.y - crop.y) / crop.h);
      const rot = ((rotation || 0) % 360 + 360) % 360;
      let dx = qx;
      let dy = qy;
      if (rot === 90) { dx = 1 - qy; dy = qx; }
      else if (rot === 180) { dx = 1 - qx; dy = 1 - qy; }
      else if (rot === 270) { dx = qy; dy = 1 - qx; }
      const p = { x: dx * canvas.width, y: dy * canvas.height };
      const r = Math.max(22, ((sel.size * canvas.width) / SIZE_REF) * 0.7);
      ctx.strokeStyle = '#25d366';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // In crop mode the strokes/overlays are drawn in full-image coords on top
  // of the full image (they are NOT clipped — the dimming shows what the
  // crop keeps; export clips them to the crop rect).
  function drawStateOntoOverlayOnly(
    ctx: CanvasRenderingContext2D,
    _img: HTMLImageElement,
    state: EditorState,
    outW: number,
    outH: number,
  ): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of state.strokes) {
      if (s.points.length === 0) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1, (s.size * outW) / SIZE_REF);
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * outW, s.points[0].y * outH);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * outW, s.points[i].y * outH);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const o of state.overlays) {
      if (o.kind === 'text') {
        const px = Math.max(8, (o.size * outW) / SIZE_REF);
        ctx.font = `700 ${px}px system-ui, -apple-system, sans-serif`;
        ctx.lineWidth = Math.max(2, px / 8);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeText(o.text, o.x * outW, o.y * outH);
        ctx.fillStyle = o.color;
        ctx.fillText(o.text, o.x * outW, o.y * outH);
      } else {
        const px = Math.max(8, (o.size * outW) / SIZE_REF);
        ctx.font = `${px}px system-ui, -apple-system, sans-serif`;
        ctx.fillText(o.emoji, o.x * outW, o.y * outH);
      }
    }
    ctx.restore();
  }

  /** Canvas pixel → full-image normalised coords, given the current view.
   *  In the rotated (non-crop) view the display coords are un-rotated
   *  first (90° clockwise: dispX = 1 − unrotY, dispY = unrotX). */
  const toFull = useCallback((clientX: number, clientY: number): EditorPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0.5, y: 0.5 };
    const rect = canvas.getBoundingClientRect();
    let px = (clientX - rect.left) / rect.width;
    let py = (clientY - rect.top) / rect.height;
    if (tool !== 'crop') {
      const rot = ((rotation || 0) % 360 + 360) % 360;
      if (rot === 90) { const t = px; px = py; py = 1 - t; }
      else if (rot === 180) { px = 1 - px; py = 1 - py; }
      else if (rot === 270) { const t = px; px = 1 - py; py = t; }
    }
    if (tool === 'crop') return { x: Math.min(1, Math.max(0, px)), y: Math.min(1, Math.max(0, py)) };
    const c = stateRef.current.crop;
    return {
      x: Math.min(1, Math.max(0, c.x + px * c.w)),
      y: Math.min(1, Math.max(0, c.y + py * c.h)),
    };
  }, [tool, rotation]);

  const hitOverlay = useCallback((p: EditorPoint): EditorOverlay | null => {
    const c = stateRef.current.crop;
    const list = [...stateRef.current.overlays].reverse();
    for (const o of list) {
      // Hit radius in full-image coords, scaled by the visible crop.
      const rx = (Math.max(28, (o.size * dispW) / SIZE_REF) / dispW) * (tool === 'crop' ? 1 : c.w);
      const ry = (Math.max(28, (o.size * dispW) / SIZE_REF) / dispW) * (tool === 'crop' ? 1 : c.h);
      if (Math.abs(o.x - p.x) <= rx && Math.abs(o.y - p.y) <= ry) return o;
    }
    return null;
  }, [dispW, tool]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!natural.w || exporting) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = toFull(e.clientX, e.clientY);
    if (tool === 'draw') {
      // Snapshot BEFORE the stroke, so one Undo removes the whole stroke.
      pushHistory();
      const stroke: EditorStroke = { color: drawColor, size: drawSize, points: [p] };
      gestureRef.current = { kind: 'stroke', stroke };
      setStrokes((prev) => [...prev, stroke]);
      return;
    }
    if (tool === 'crop') return; // corners are the HTML handles below
    const hit = hitOverlay(p);
    if (hit) {
      setSelectedId(hit.id);
      gestureRef.current = { kind: 'drag-overlay', id: hit.id, dx: p.x - hit.x, dy: p.y - hit.y };
    } else {
      setSelectedId(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current;
    if (!g) return;
    const p = toFull(e.clientX, e.clientY);
    if (g.kind === 'stroke') {
      g.stroke.points = [...g.stroke.points, p];
      setStrokes((prev) => prev.map((s) => (s === g.stroke ? { ...s, points: g.stroke.points } : s)));
      setGestureTick((t) => t + 1);
    } else if (g.kind === 'drag-overlay') {
      const nx = Math.min(1, Math.max(0, p.x - g.dx));
      const ny = Math.min(1, Math.max(0, p.y - g.dy));
      setOverlays((prev) => prev.map((o) => (o.id === g.id ? { ...o, x: nx, y: ny } : o)));
    }
  };

  const endGesture = () => {
    // The stroke was snapshotted in onPointerDown (before it started) and
    // appended live; finishing it needs no further state change.
    gestureRef.current = null;
  };

  const addText = () => {
    const text = textInput.trim();
    if (!text) return;
    pushHistory();
    const item: EditorTextItem = { id: nextOverlayId(), kind: 'text', text, x: 0.5, y: 0.5, color: textColor, size: textSize };
    setOverlays((prev) => [...prev, item]);
    setSelectedId(item.id);
    setTextInput('');
  };

  const addEmoji = (emoji: string) => {
    pushHistory();
    const item: EditorEmojiItem = { id: nextOverlayId(), kind: 'emoji', emoji, x: 0.5, y: 0.5, size: emojiSize };
    setOverlays((prev) => [...prev, item]);
    setSelectedId(item.id);
  };

  const selected = overlays.find((o) => o.id === selectedId) || null;

  const updateSelected = (patch: Partial<EditorTextItem> & Partial<EditorEmojiItem>) => {
    if (!selected) return;
    setOverlays((prev) => prev.map((o) => (o.id === selected.id ? { ...o, ...patch } as EditorOverlay : o)));
  };

  const deleteSelected = () => {
    if (!selected) return;
    pushHistory();
    setOverlays((prev) => prev.filter((o) => o.id !== selected.id));
    setSelectedId(null);
  };

  const applyCropPreset = (aspect: number | null) => {
    if (!natural.w) return;
    pushHistory();
    setCrop(cropForAspect(aspect, natural.w, natural.h));
  };

  const onCropHandleDown = (corner: 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pushHistory();
    gestureRef.current = { kind: 'crop-corner', corner, start: { ...crop }, px: e.clientX, py: e.clientY };
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (!g || g.kind !== 'crop-corner') return;
      const dx = (ev.clientX - g.px) / rect.width;
      const dy = (ev.clientY - g.py) / rect.height;
      const s = g.start;
      let next: EditorCrop = { ...s };
      if (g.corner === 'nw') next = { x: s.x + dx, y: s.y + dy, w: s.w - dx, h: s.h - dy };
      if (g.corner === 'ne') next = { x: s.x, y: s.y + dy, w: s.w + dx, h: s.h - dy };
      if (g.corner === 'sw') next = { x: s.x + dx, y: s.y, w: s.w - dx, h: s.h + dy };
      if (g.corner === 'se') next = { x: s.x, y: s.y, w: s.w + dx, h: s.h + dy };
      setCrop(clampCrop(next));
    };
    const up = () => {
      gestureRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handleSend = async () => {
    const img = imgRef.current;
    if (!img || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const blob = await exportEditedImage(img, stateRef.current);
      const base = (fileName || 'photo.jpg').replace(/\.[^.]*$/, '') || 'photo';
      const file = new File([blob], `${base}-edited.jpg`, { type: 'image/jpeg' });
      // 100M-F2: trimmed caption (or undefined = no caption field).
      onSend(file, caption.trim() || undefined, sendHD);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not export the edited photo.');
      setExporting(false);
    }
  };

  const cropHandles: { corner: 'nw' | 'ne' | 'sw' | 'se'; left: string; top: string; cursor: string }[] = [
    { corner: 'nw', left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, cursor: 'nwse-resize' },
    { corner: 'ne', left: `${(crop.x + crop.w) * 100}%`, top: `${crop.y * 100}%`, cursor: 'nesw-resize' },
    { corner: 'sw', left: `${crop.x * 100}%`, top: `${(crop.y + crop.h) * 100}%`, cursor: 'nesw-resize' },
    { corner: 'se', left: `${(crop.x + crop.w) * 100}%`, top: `${(crop.y + crop.h) * 100}%`, cursor: 'nwse-resize' },
  ];

  const emojiList = EMOJI_CATEGORIES.find((c) => c.name === emojiCategory)?.emojis || [];

  return (
    <div data-photo-editor className="fixed inset-0 z-[9999] bg-black/90 flex flex-col" role="dialog" aria-modal="true" aria-label="Edit photo">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 text-white">
        <button onClick={onCancel} aria-label="Cancel photo edit" className="p-2 rounded-full hover:bg-white/10">
          <X className="h-6 w-6" />
        </button>
        <span className="font-semibold">Edit photo</span>
        <div className="flex items-center gap-1">
          <button onClick={rotate90} disabled={!natural.w || exporting} aria-label="Rotate photo 90 degrees" title={rotation ? `Rotate photo (now ${rotation}°)` : 'Rotate photo 90°'} className="p-2 rounded-full hover:bg-white/10 disabled:opacity-30">
            <RotateCw className="h-5 w-5" />
          </button>
          <button onClick={undo} disabled={history.length === 0} aria-label="Undo edit" className="p-2 rounded-full hover:bg-white/10 disabled:opacity-30">
            <Undo2 className="h-5 w-5" />
          </button>
        </div>
      </div>
      {rotation !== 0 && (
        <p className="text-center text-xs text-white/70 px-4 pb-1">Rotated {rotation}° — crop still applies to the original orientation</p>
      )}

      {/* Canvas */}
      <div ref={stageRef} className="flex-1 flex items-center justify-center overflow-hidden px-2">
        {loadError ? (
          <p className="text-white text-sm text-center px-6">{loadError}</p>
        ) : !natural.w ? (
          <p className="text-white/70 text-sm">Loading photo…</p>
        ) : (
          <div ref={wrapRef} className="relative select-none" style={{ width: dispW, height: dispH, touchAction: 'none' }}>
            <canvas
              ref={canvasRef}
              data-testid="photo-editor-canvas"
              width={dispW}
              height={dispH}
              className="block w-full h-full rounded-lg bg-black"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endGesture}
              onPointerLeave={endGesture}
              onPointerCancel={endGesture}
            />
            {tool === 'crop' && cropHandles.map((h) => (
              <div
                key={h.corner}
                role="slider"
                aria-label={`Crop ${h.corner} corner`}
                data-crop-handle={h.corner}
                onPointerDown={onCropHandleDown(h.corner)}
                className="absolute w-6 h-6 -ml-3 -mt-3 rounded-full bg-white border-2 border-[#075E54] shadow"
                style={{ left: h.left, top: h.top, cursor: h.cursor, touchAction: 'none' }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Tool tabs */}
      <div className="flex justify-center gap-2 px-3 pt-2">
        {([
          { id: 'draw', label: 'Draw', icon: <PenLine className="h-5 w-5" /> },
          { id: 'text', label: 'Text', icon: <Type className="h-5 w-5" /> },
          { id: 'emoji', label: 'Emoji', icon: <Smile className="h-5 w-5" /> },
          { id: 'crop', label: 'Crop', icon: <Crop className="h-5 w-5" /> },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => { setTool(t.id); setSelectedId(null); }}
            aria-label={t.label}
            aria-pressed={tool === t.id}
            className={`flex flex-col items-center gap-0.5 px-4 py-2 rounded-xl text-xs font-medium ${
              tool === t.id ? 'bg-white text-black' : 'bg-white/10 text-white'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tool panels */}
      <div className="px-3 py-3 text-white">
        {tool === 'draw' && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 justify-center" role="group" aria-label="Draw colour">
              {DRAW_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setDrawColor(c)}
                  aria-label={`Draw colour ${c}`}
                  aria-pressed={drawColor === c}
                  className={`w-7 h-7 rounded-full border-2 ${drawColor === c ? 'border-white scale-110' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-3 px-2">
              <span className="text-xs text-white/70 whitespace-nowrap">Brush {drawSize}px</span>
              <input type="range" min={2} max={24} step={1} value={drawSize} onChange={(e) => setDrawSize(Number(e.target.value))} aria-label="Brush size" className="flex-1 accent-[#25d366]" />
            </div>
            <p className="text-center text-xs text-white/50">Drag on the photo to draw</p>
          </div>
        )}

        {tool === 'text' && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addText(); }}
                placeholder="Add text…"
                aria-label="Photo editor text"
                className="flex-1 min-w-0 bg-white/10 rounded-full px-4 py-2 text-sm outline-none placeholder:text-white/50"
              />
              <button onClick={addText} disabled={!textInput.trim()} aria-label="Add text" className="px-4 py-2 rounded-full bg-[#25d366] text-black text-sm font-semibold disabled:opacity-40">
                Add
              </button>
            </div>
            {selected?.kind === 'text' && (
              <div className="space-y-2 bg-white/10 rounded-xl p-2">
                <div className="flex items-center gap-2">
                  <input
                    value={selected.text}
                    onChange={(e) => updateSelected({ text: e.target.value })}
                    aria-label="Edit selected text"
                    className="flex-1 min-w-0 bg-transparent rounded px-2 py-1 text-sm outline-none border border-white/20"
                  />
                  <button onClick={deleteSelected} aria-label="Delete selected text" className="p-2 rounded-full hover:bg-white/10">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-white/70">Size</span>
                  <input type="range" min={20} max={120} step={2} value={selected.size} onChange={(e) => updateSelected({ size: Number(e.target.value) })} aria-label="Text size" className="flex-1 accent-[#25d366]" />
                </div>
                <div className="flex items-center gap-2 justify-center">
                  {DRAW_COLORS.map((c) => (
                    <button key={c} onClick={() => updateSelected({ color: c })} aria-label={`Text colour ${c}`} className={`w-6 h-6 rounded-full border-2 ${selected.color === c ? 'border-white' : 'border-transparent'}`} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <p className="text-center text-xs text-white/50">Drag the text on the photo to move it</p>
              </div>
            )}
            {!selected && <p className="text-center text-xs text-white/50">Type text and tap Add — then drag it to move it</p>}
          </div>
        )}

        {tool === 'emoji' && (
          <div className="space-y-2">
            <div className="flex gap-1 overflow-x-auto pb-1">
              {EMOJI_CATEGORIES.map((c) => (
                <button key={c.name} onClick={() => setEmojiCategory(c.name)} aria-pressed={emojiCategory === c.name} className={`px-3 py-1 rounded-full text-xs whitespace-nowrap ${emojiCategory === c.name ? 'bg-white text-black' : 'bg-white/10'}`}>
                  {c.name}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-8 gap-1 max-h-32 overflow-y-auto">
              {emojiList.map((e) => (
                <button key={e} onClick={() => addEmoji(e)} aria-label={`Editor emoji ${e}`} className="text-2xl leading-none p-1 hover:scale-125 transition-transform">
                  {e}
                </button>
              ))}
            </div>
            {selected?.kind === 'emoji' && (
              <div className="flex items-center gap-2 bg-white/10 rounded-xl p-2">
                <span className="text-2xl">{selected.emoji}</span>
                <span className="text-xs text-white/70">Size</span>
                <input type="range" min={32} max={180} step={4} value={selected.size} onChange={(e) => updateSelected({ size: Number(e.target.value) })} aria-label="Emoji size" className="flex-1 accent-[#25d366]" />
                <button onClick={deleteSelected} aria-label="Delete selected emoji" className="p-2 rounded-full hover:bg-white/10">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
            <p className="text-center text-xs text-white/50">Tap an emoji to add it — drag it on the photo to move it</p>
          </div>
        )}

        {tool === 'crop' && (
          <div className="space-y-2">
            <div className="flex gap-2 justify-center flex-wrap">
              {CROP_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyCropPreset(p.aspect)}
                  aria-label={`Crop ${p.label}`}
                  className="px-3 py-1.5 rounded-full bg-white/10 text-xs font-medium hover:bg-white/20"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-center text-xs text-white/50">Drag the white corners to adjust the crop — outside the frame is cut off on send</p>
          </div>
        )}
      </div>

      {/* 100M-F2: caption input — sits above Send, like WhatsApp. */}
      <div className="px-4 pb-1">
        <input
          data-testid="photo-caption-input"
          aria-label="Add a caption"
          placeholder="Type a caption"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          maxLength={1024}
          className="w-full bg-white/10 text-white placeholder-white/50 rounded-full px-4 py-2.5 text-sm outline-none focus:bg-white/15"
        />
      </div>

      {/* WA parity (DM audit row 66): HD photo option. */}
      <div className="px-4 pb-1">
        <button
          type="button"
          onClick={() => setSendHD((v) => !v)}
          aria-label="Send as HD photo"
          aria-pressed={sendHD}
          className={`w-full flex items-center justify-between px-4 py-2.5 rounded-full text-sm font-medium ${sendHD ? 'bg-[#25d366]/25 text-white' : 'bg-white/10 text-white/80 hover:bg-white/15'}`}
        >
          <span><span className="block font-semibold text-left">HD — original quality</span>
          <span className="block text-xs text-white/60 text-left">Full size, best quality</span></span>
          <span className="text-xs font-bold">{sendHD ? 'HD ✓' : 'HD'}</span>
        </button>
      </div>

      {/* Footer */}
      <div className="flex gap-3 px-4 pb-5 pt-1">
        <button onClick={onCancel} className="flex-1 py-3 bg-white/10 text-white rounded-full font-semibold">
          Cancel
        </button>
        <button
          onClick={() => void handleSend()}
          disabled={exporting || !natural.w}
          aria-label="Send edited photo"
          className="flex-1 py-3 bg-[#25d366] text-black rounded-full font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {exporting ? 'Sending…' : (<><Send className="h-5 w-5" /> Send</>)}
        </button>
      </div>
      {exportError && <p className="text-center text-xs text-red-400 pb-3 px-4">{exportError}</p>}
      {/* Hidden check for probes/tests: an untouched photo is still sendable. */}
      <span className="hidden" data-has-edits={hasEdits({ strokes, overlays, crop, rotation }) ? 'true' : 'false'} />
      <span className="hidden" data-editor-ready={natural.w ? 'true' : 'false'} />
      <span className="hidden" data-rotation={String(rotation)} />
    </div>
  );
}
