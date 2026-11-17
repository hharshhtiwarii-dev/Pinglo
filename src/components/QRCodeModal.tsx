import { useEffect, useState } from 'react';
import { X, Share2, Copy, Check } from 'lucide-react';
import QRCode from 'qrcode';

/**
 * Reusable QR code helper + modal (Phase 4, Worker C).
 *
 * Uses the already-installed `qrcode` v1.5.4 package (no new dependency).
 *
 * - `generateQRDataURL(text)` is the shared helper. The group-invite QR
 *   in GroupInfoModal is owned by another worker — that worker should call
 *   this helper (or render <QRCodeModal>) with the group invite link, e.g.:
 *       import { generateQRDataURL } from '../components/QRCodeModal';
 *       const url = await generateQRDataURL(`https://dtchats.app/join/${inviteCode}`);
 *     or: <QRCodeModal open={showQr} onClose={...} title="Group invite"
 *            value={`https://dtchats.app/join/${inviteCode}`} subtitle={groupName} />
 * - "My QR" in Settings encodes `pinglo://user/<uid>` (a profile link).
 *   Scanning it routes via `parseDeepLink` + `routeDeepLink`
 *   (services/deepLink.ts) to `/chat/<uid>` — the DM with that user —
 *   and the native `appUrlOpen` listener / `?link=` web fallback handle
 *   links arriving from outside the app. One server-side piece remains:
 *   dtchats.app must host `.well-known/assetlinks.json` or Android will
 *   not verify the https App Link (BACKEND-PLAN.md — do NOT fake it).
 */

export async function generateQRDataURL(text: string, size = 512): Promise<string> {
  if (!text) throw new Error('Nothing to encode');
  return QRCode.toDataURL(text, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });
}

interface QRCodeModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The exact string encoded in the QR code. */
  value: string;
  subtitle?: string;
}

export default function QRCodeModal({ open, onClose, title, value, subtitle }: QRCodeModalProps) {
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDataUrl('');
    setError('');
    generateQRDataURL(value)
      .then(setDataUrl)
      .catch(() => setError('Could not generate QR code.'));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title, text: value });
      } else {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* intentionally ignored */}
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={onClose} role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-sm bg-panel-light dark:bg-panel-dark rounded-2xl p-6 shadow-2xl space-y-4 text-center" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900 dark:text-text-primary">{title}</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
            <X className="h-5 w-5 text-gray-400" />
          </button>
        </div>
        {subtitle && <p className="text-sm text-gray-500 dark:text-text-secondary -mt-2">{subtitle}</p>}
        <div className="bg-white rounded-2xl p-4 mx-auto w-fit">
          {error ? (
            <p className="text-sm text-danger-red px-4 py-8">{error}</p>
          ) : dataUrl ? (
            <img src={dataUrl} alt={`QR code for ${title}`} className="w-56 h-56" />
          ) : (
            <div className="w-56 h-56 flex items-center justify-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary-green border-t-transparent" />
            </div>
          )}
        </div>
        <p className="text-xs text-gray-400 dark:text-text-secondary break-all font-mono">{value}</p>
        <button onClick={handleShare} className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green transition-all flex items-center justify-center gap-2">
          {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
          {copied ? 'Copied ✓' : 'Share / Copy link'}
          {!copied && <Copy className="h-4 w-4 opacity-70" />}
        </button>
      </div>
    </div>
  );
}
