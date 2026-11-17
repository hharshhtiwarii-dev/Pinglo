import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import { applyFontSize } from './services/appSettings';
import { restoreChatTheme } from './services/chatTheme';
import { checkWebView } from './services/webViewGuard';
import './index.css';

// AUDIT-2 D2: warn (don't crash) on WebViews too old to render Tailwind v4
// CSS (@layer needs Chrome 99+, oklch/color-mix need 111+). Runs before
// React mounts, never throws, no-ops off native Android.
checkWebView();

// Phase 4 (integration): restore the saved font size on startup so it
// survives reload before Settings is ever opened.
try { applyFontSize(); } catch (err) { /* storage unavailable — defaults apply */ console.warn("[main] unknown: applyFontSize() failed", err); }

// Theme fix: restore the saved chat theme (presets, custom colours,
// wallpaper, brightness) and the app theme (Light / Dark / System) on
// startup so they survive reload.
try { restoreChatTheme(); } catch (err) { /* storage unavailable — defaults apply */ console.warn("[main] unknown: restoreChatTheme() failed", err); }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// REPORT-3 #248 (W13 NEXT R4): boot watchdog marker — index.html shows a
// reload prompt if this flag is still unset after 15s (entry chunk failed
// to load/execute, so no React boundary exists to recover).
(window as unknown as { __PINGLO_MOUNTED__?: boolean }).__PINGLO_MOUNTED__ = true;
