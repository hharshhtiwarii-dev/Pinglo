import React, { useEffect, useRef, useState } from 'react';
import { X, Languages, Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import { navigationManager } from '../services/navigation';
import { getLanguage } from '../services/language';
import {
  translateMessage,
  detectLanguage,
  hasTranslationConsent,
  setTranslationConsent,
  TRANSLATION_PRIVACY_NOTICE,
  SUPPORTED_TRANSLATE_LANGUAGES,
  type TranslateResult,
} from '../services/translation';

/**
 * TranslateSheet (Worker 3).
 *
 * Bottom sheet opened from a message's context menu ("Translate"). Shows
 * the original message and its translation, a target-language picker
 * (English / Hindi quick picks + the full list), loading and honest error
 * states, and a "Copy translation" action. Classic Pro styling, same
 * sheet pattern as StatusReplySheet.
 *
 * The sheet does NO translating itself: `services/translation` does the
 * work (free no-key providers + local cache). Re-opening the same message
 * is instant because the service caches it. On failure the sheet shows
 * the service's honest error and a Retry button — it never shows invented
 * text.
 */

interface TranslateSheetProps {
  open: boolean;
  onClose: () => void;
  /** Original message text. */
  originalText: string;
  /** Who sent the message (shown in the header when known). */
  senderName?: string;
  /** Preferred target language; defaults to the app's other language. */
  initialTargetLang?: string;
}

const QUICK_LANGS = ['en', 'hi'];

function langLabel(code: string): string {
  return SUPPORTED_TRANSLATE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

export default function TranslateSheet({
  open,
  onClose,
  originalText,
  senderName,
  initialTargetLang,
}: TranslateSheetProps) {
  const defaultTarget = initialTargetLang || (getLanguage() === 'hi' ? 'en' : 'hi');
  const [targetLang, setTargetLang] = useState(defaultTarget);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  // AUDIT-2 A10: translation sends the text to an outside service, so the
  // first translation needs an explicit inline confirm — nothing is sent
  // before the user agrees. Consent is remembered on this device.
  const [needsConsent, setNeedsConsent] = useState(false);
  const requestId = useRef(0);

  const detectedLang = result?.detectedLang ?? detectLanguage(originalText).lang;

  const runTranslation = (target: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setResult(null);
    setCopied(false);
    void translateMessage(originalText, target).then((r) => {
      if (requestId.current !== id) return; // a newer request superseded this one
      setResult(r);
      setLoading(false);
    });
  };

  useEffect(() => {
    if (!open) return;
    setTargetLang(defaultTarget);
    setResult(null);
    setCopied(false);
    if (hasTranslationConsent()) {
      setNeedsConsent(false);
      runTranslation(defaultTarget);
    } else {
      // No silent send: show the consent confirm first.
      setNeedsConsent(true);
    }
    return navigationManager.pushHandler(() => {
      onClose();
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, originalText]);

  const giveConsentAndTranslate = () => {
    setTranslationConsent(true);
    setNeedsConsent(false);
    runTranslation(targetLang);
  };

  if (!open) return null;

  const changeTarget = (code: string) => {
    if (code === targetLang) return;
    setTargetLang(code);
    if (!needsConsent) runTranslation(code);
  };

  const copyTranslation = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
    } catch {
      // Clipboard API unavailable (older WebView / permission): fallback.
      try {
        const ta = document.createElement('textarea');
        ta.value = result.text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch {
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const translatedText = result?.text;
  const isSameLanguage = result?.provider === 'none';

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Translate message"
    >
      <div
        className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900 dark:text-text-primary flex items-center gap-2">
            <Languages className="h-5 w-5 text-primary-green" />
            Translate{senderName ? ` · ${senderName}` : ''}
          </h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Original message */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
            Original · {langLabel(detectedLang)}
          </p>
          <p className="text-sm text-gray-900 dark:text-text-primary bg-gray-100 dark:bg-input-dark rounded-xl px-3 py-2.5 whitespace-pre-wrap break-words">
            {originalText}
          </p>
        </div>

        {/* Target language picker */}
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">
            Translate to
          </p>
          <div className="flex gap-2 flex-wrap">
            {QUICK_LANGS.map((code) => (
              <button
                key={code}
                onClick={() => changeTarget(code)}
                className={`px-3.5 py-1.5 rounded-full text-sm font-medium ${
                  targetLang === code
                    ? 'bg-green-cta text-white'
                    : 'bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary'
                }`}
              >
                {langLabel(code)}
              </button>
            ))}
            <select
              value={targetLang}
              onChange={e => changeTarget(e.target.value)}
              aria-label="Choose language"
              className="px-3 py-1.5 rounded-full text-sm font-medium bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary outline-none"
            >
              {SUPPORTED_TRANSLATE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} ({l.nativeLabel})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Translation result */}
        {/* AUDIT-2 A10: explicit consent before anything is sent. */}
        {needsConsent ? (
          <div className="rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-3 space-y-3">
            <p className="text-sm text-amber-800 dark:text-amber-200 leading-relaxed flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              {TRANSLATION_PRIVACY_NOTICE}
            </p>
            <div className="flex gap-2">
              <button
                onClick={giveConsentAndTranslate}
                className="flex-1 py-2 rounded-full bg-green-cta text-white text-sm font-semibold"
              >
                Translate — I understand
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-full bg-gray-100 dark:bg-input-dark text-sm font-medium text-gray-700 dark:text-text-primary"
              >
                Not now
              </button>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-text-secondary py-2">
            <span className="h-4 w-4 rounded-full border-2 border-primary-green border-t-transparent animate-spin" aria-hidden />
            Translating to {langLabel(targetLang)}…
          </div>
        ) : result?.error ? (
          <div className="rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 px-3 py-2.5">
            <p className="text-sm text-red-600 dark:text-red-400 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              {result.error}
            </p>
            <button
              onClick={() => runTranslation(targetLang)}
              className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary-green"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        ) : translatedText ? (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
              Translation · {langLabel(targetLang)}
              {isSameLanguage ? ' (same language)' : ''}
            </p>
            <p className="text-sm text-gray-900 dark:text-text-primary bg-[#DCF8C6] dark:bg-[#005C4B] rounded-xl px-3 py-2.5 whitespace-pre-wrap break-words">
              {translatedText}
            </p>
            <div className="flex items-center justify-between mt-3">
              <p className="text-[11px] text-gray-400">
                {result.provider === 'cache'
                  ? 'From local cache'
                  : result.provider === 'none'
                    ? 'No translation needed'
                    : `Translated by ${result.provider === 'mymemory' ? 'MyMemory' : 'LibreTranslate'} · free service, quality may vary`}
              </p>
              <button
                onClick={copyTranslation}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-green-cta text-white text-sm font-medium hover:bg-dark-green"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy translation'}
              </button>
            </div>
          </div>
        ) : null}

        <p className="text-[11px] text-gray-400 text-center">
          Translation needs internet and uses a free public service — it can be slow or unavailable at times.
        </p>
      </div>
    </div>
  );
}
