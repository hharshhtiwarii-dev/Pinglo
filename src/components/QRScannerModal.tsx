import React, { useEffect, useRef, useState } from 'react';
import { X, ScanLine, Link2 } from 'lucide-react';
import { parseDeepLink } from '../services/deepLink';

/**
 * Scan-QR modal (Cluster C, Item 15a).
 *
 * Decodes QR codes with the platform BarcodeDetector API when available
 * (Chrome on Android/desktop, Edge; `BarcodeDetector.getSupportedFormats`
 * is probed for 'qr_code'). No new dependency was added — there is no QR
 * decode library in package.json and none is needed where the API exists.
 *
 * Where BarcodeDetector is absent (Firefox, Safari, older browsers) the
 * modal says so honestly and offers a paste-a-link box instead: the user
 * pastes `pinglo://user/<uid>` (or a dtchats.app link) and it routes
 * exactly like a scanned code. The camera is still requested only when
 * the detector exists, so Safari users are not asked for a camera that
 * could never decode.
 */

interface QRScannerModalProps {
  open: boolean;
  onClose: () => void;
  /** Raw scanned / pasted link text (e.g. pinglo://user/<uid>). */
  onScan: (raw: string) => void;
}

type DetectorCtor = new (opts?: { formats?: string[] }) => { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };

export default function QRScannerModal({ open, onClose, onScan }: QRScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const scannedRef = useRef(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    scannedRef.current = false;
    setError('');
    setPasted('');
    setPasteError('');
    const BD = (window as unknown as { BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
    (async () => {
      let ok = false;
      try {
        if (BD) {
          if (typeof BD.getSupportedFormats === 'function') {
            const formats = await BD.getSupportedFormats();
            ok = formats.includes('qr_code');
          } else {
            ok = true; // Constructor exists; assume QR support.
          }
        }
      } catch { ok = false; }
      if (cancelled) return;
      setSupported(ok);
      if (!ok) return;
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This device has no camera to scan with — paste the link below instead.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        const detector = new BD!({ formats: ['qr_code'] });
        const canvas = document.createElement('canvas');
        const loop = async () => {
          if (cancelled || scannedRef.current) return;
          try {
            const video = videoRef.current;
            if (video && video.readyState >= 2 && video.videoWidth) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              canvas.getContext('2d')?.drawImage(video, 0, 0);
              const codes = await detector.detect(canvas);
              const value = codes?.[0]?.rawValue;
              if (value) {
                scannedRef.current = true;
                onScan(value);
                return;
              }
            }
          } catch { /* intentionally ignored */}
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      } catch {
        if (!cancelled) setError('Camera could not be opened — permission denied or no camera. Paste the link below instead.');
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  if (!open) return null;

  const submitPaste = () => {
    const link = parseDeepLink(pasted);
    if (!link) {
      setPasteError('That is not a Pinglo link — it should look like pinglo://user/<id>.');
      return;
    }
    onScan(pasted.trim());
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-end sm:items-center justify-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Scan QR code">
      <div className="w-full max-w-md bg-panel-light dark:bg-panel-dark rounded-t-2xl sm:rounded-2xl p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <ScanLine className="h-5 w-5 text-primary-green" /> Scan QR code
          </h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {supported === null && <p className="text-sm text-gray-500 dark:text-text-secondary text-center py-4">Checking camera support…</p>}

        {supported === true && !error && (
          <div className="relative rounded-2xl overflow-hidden bg-black aspect-[4/3]">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            <div className="absolute inset-6 border-2 border-primary-green rounded-2xl pointer-events-none" />
            <p className="absolute bottom-2 inset-x-0 text-center text-xs text-white/80">Point the camera at a Pinglo QR code</p>
          </div>
        )}

        {(supported === false || error) && (
          <p className="text-sm text-gray-500 dark:text-text-secondary leading-relaxed">
            {error || 'QR scanning needs a browser with BarcodeDetector support (Chrome on Android or desktop). Safari and Firefox do not provide it yet — paste the link instead.'}
          </p>
        )}

        <div>
          <label className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide flex items-center gap-1.5" htmlFor="qr-paste">
            <Link2 className="h-3.5 w-3.5" /> Or paste a Pinglo link
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="qr-paste"
              value={pasted}
              onChange={(e) => { setPasted(e.target.value); setPasteError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitPaste(); }}
              placeholder="pinglo://user/…"
              className="flex-1 bg-gray-50 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green min-w-0"
            />
            <button onClick={submitPaste} disabled={!pasted.trim()} className="px-4 py-2.5 bg-green-cta text-white rounded-xl text-sm font-semibold disabled:opacity-40">
              Open
            </button>
          </div>
          {pasteError && <p className="text-xs text-danger-red mt-1.5">{pasteError}</p>}
        </div>
      </div>
    </div>
  );
}
