// AUDIT-2 D2 — old-WebView guard.
//
// Tailwind v4 ships CSS that a stock old Android WebView cannot render:
//   * the whole stylesheet lives in `@layer` blocks (Chrome 99+ only) —
//     below Chrome 99 the browser drops the entire stylesheet, so the app
//     is completely unstyled, not just slightly off;
//   * colours are `oklch()` / `color-mix()` (Chrome 111+ only) — below
//     Chrome 111 the theme colours and every `/opacity` utility lose
//     their colour;
//   * preflight + the dark variant use `:where()` (Chrome 88+ only).
// Tailwind v4 hardcodes its Lightning CSS targets (Chrome 111, Safari
// 16.4, Firefox 128) in @tailwindcss/node — there is no browserslist or
// config knob to retarget it, and a Lightning CSS post-pass was measured
// (see PATCH-3C.md): it converts static oklch/color-mix to hex fallbacks
// but leaves `color-mix(var()/currentcolor)`, `@property` and, fatally,
// `@layer`/`:where()` untouched. So no build-time CSS fix can make the
// app work on a stock API-22 (~Chromium 39) WebView — and the JS bundle
// (Vite default target) would not parse there either.
//
// What this module does instead (honest, safe): on native Android it
// reads the WebView's Chrome version from the user agent. Below Chrome 99
// it shows a full-screen notice (inline styles only — Tailwind classes
// cannot be trusted there) telling the user to update Android System
// WebView from the Play Store, with a "Continue anyway" escape hatch.
// Chrome 99–110 gets a smaller dismissible banner (layout works, some
// colours will be wrong). Chrome 111+ (every WebView the Play Store has
// shipped in years — WebView updates independently of the OS on
// Android 5+) sees nothing.
//
// This deliberately does NOT raise minSdk: that drops Android 5–7 users
// and needs a user decision (see PATCH-3C.md). The guard only warns.

export type WebViewStatus = 'ok' | 'degraded' | 'unsupported' | 'unknown';

export interface WebViewInfo {
  /** Chrome major version from the UA, or null if none is present. */
  chrome: number | null;
  isAndroid: boolean;
  status: WebViewStatus;
}

const DISMISS_KEY = 'dt_webview_warn_dismissed';

/** Pure UA parser — unit-tested, no DOM/Capacitor access. */
export function parseWebViewVersion(userAgent: string): WebViewInfo {
  const isAndroid = /Android/i.test(userAgent);
  const m = userAgent.match(/Chrome\/(\d+)/);
  const chrome = m ? parseInt(m[1], 10) : null;
  let status: WebViewStatus;
  if (!isAndroid) {
    // Desktop dev / preview — the WebView problem does not apply.
    status = 'ok';
  } else if (chrome === null) {
    // Pre-Chrome stock WebView (Android 4.4 `Version/4.0` style UA) —
    // predates @layer, :where, flex gap and modern JS alike.
    status = 'unsupported';
  } else if (chrome < 99) {
    status = 'unsupported';
  } else if (chrome < 111) {
    status = 'degraded';
  } else {
    status = 'ok';
  }
  return { chrome, isAndroid, status };
}

function dismissedVersion(): number | null {
  try {
    const v = localStorage.getItem(DISMISS_KEY);
    return v === null ? null : parseInt(v, 10);
  } catch {
    return null;
  }
}

function rememberDismissed(chrome: number | null): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(chrome ?? -1));
  } catch (err) {
    console.warn('[webViewGuard] could not remember WebView warning dismissal', err);
  }
}

const PLAY_STORE_URL =
  'https://play.google.com/store/apps/details?id=com.google.android.webview';

/** Render the warning with plain DOM + inline styles only. */
function renderWarning(info: WebViewInfo): void {
  const unsupported = info.status === 'unsupported';
  const overlay = document.createElement('div');
  overlay.setAttribute('data-dt-webview-warning', '');
  overlay.style.cssText = unsupported
    ? 'position:fixed;inset:0;z-index:99999;background:#0B141A;color:#E9EDEF;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif;'
    : 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#7f1d1d;color:#fff;padding:10px 12px;text-align:center;font-family:system-ui,sans-serif;font-size:14px;line-height:1.4;';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:18px;margin-bottom:8px;';
  title.textContent = unsupported
    ? 'Pinglo needs a newer Android System WebView'
    : 'Your Android System WebView is out of date';
  const body = document.createElement('div');
  body.style.cssText = unsupported
    ? 'font-size:15px;line-height:1.5;max-width:420px;margin-bottom:16px;'
    : 'font-size:14px;margin-bottom:8px;';
  body.textContent = unsupported
    ? 'This phone is running a very old WebView, so the app cannot display correctly. Please update Android System WebView from the Play Store — it is free and takes a minute. You can continue anyway, but the app will look broken.'
    : 'Some colours may look wrong until you update Android System WebView from the Play Store.';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';
  const updateBtn = document.createElement('a');
  updateBtn.href = PLAY_STORE_URL;
  updateBtn.target = '_blank';
  updateBtn.rel = 'noopener';
  updateBtn.textContent = 'Update WebView';
  updateBtn.style.cssText =
    'background:#25D366;color:#062b1a;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:15px;';
  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = 'Continue anyway';
  dismissBtn.style.cssText =
    'background:transparent;color:inherit;border:1px solid currentColor;padding:10px 18px;border-radius:8px;font-size:15px;cursor:pointer;';
  dismissBtn.addEventListener('click', () => {
    rememberDismissed(info.chrome);
    overlay.remove();
  });
  row.appendChild(updateBtn);
  row.appendChild(dismissBtn);
  overlay.appendChild(title);
  overlay.appendChild(body);
  overlay.appendChild(row);
  document.body.appendChild(overlay);
}

/**
 * Check the running WebView and warn if it is too old to render the app.
 * Safe to call before React mounts; never throws; no-ops everywhere
 * except native Android. Call once at startup (main.tsx).
 */
export function checkWebView(): void {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    const info = parseWebViewVersion(navigator.userAgent || '');
    if (info.status === 'ok' || info.status === 'unknown') return;
    // Only warn inside the real Android app — the web preview is a dev tool.
    const isNative =
      typeof window !== 'undefined' &&
      (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;
    if (!isNative) return;
    // Don't nag every launch after the user chose to continue.
    if (dismissedVersion() === (info.chrome ?? -1)) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => renderWarning(info), { once: true });
    } else {
      renderWarning(info);
    }
  } catch (err) {
    // The guard must never break startup.
    console.warn('[webViewGuard] WebView check failed', err);
  }
}
