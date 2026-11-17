import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

// WA-verify-5 #67: the Settings "App Info" version was a hardcoded
// '1.0.0' literal that had already drifted from Android's versionName
// ("1.0"). Read it from package.json at build time so the displayed
// version can never drift from the web build again.
const pkgVersion: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'),
).version as string;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    // RETEST-1 (2026-11-14): base must be '/' not './'. With './' the
    // built index.html references ./assets/..., which resolves relative
    // to the URL path — fine at / and /settings, but on any 2-segment
    // route (/chat/:id, /call/:id, /settings/storage) the browser asked
    // for /chat/assets/... and got the SPA fallback HTML instead of JS,
    // so a hard load / refresh / deep link to a chat or call link rendered
    // a BLANK page (driver1e BLANK-CHAT/BLANK-CALL, re-reproduced here).
    // Capacitor 6 serves the app from https://localhost/ (see
    // CapConfig.java: hostname "localhost", CAPACITOR_HTTPS_SCHEME), so
    // absolute /assets/... paths resolve correctly on Android too.
    base: '/',
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      __APP_VERSION__: JSON.stringify(pkgVersion),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      // Capacitor ke liye output folder
      outDir: 'dist',
      // Source maps for debugging
      sourcemap: false,
      // Chunk size warning threshold
      chunkSizeWarningLimit: 2000,
      // Phase 3 — split the old single ~1.2 MB chunk: vendor libs load once
      // and are cached, screens load on demand via React.lazy (App.tsx).
      rollupOptions: {
        output: {
          // REPORT-3 #248 (W13 NEXT R4): Rollup splits every tiny shared
          // module into its own chunk — the baseline build had 80 JS
          // chunks, 44 of them under 1 KB (one lucide icon per chunk, e.g.
          // the 342-byte `search` chunk). Every chunk is an independent
          // module fetch, and ONE failed leaf poisons the whole screen
          // import (the browser caches the module-map error, so the
          // in-page retries can never re-fetch it — proven by probe).
          // Merge sub-5 KB chunks into their importers: the icon leaves
          // disappear as separate fetches (a 342-byte icon inlined into
          // its importer costs ~342 bytes of duplication, not a network
          // round-trip). Real screens/services (2.3 KB+) stay separate
          // chunks, so lazy-loading is unaffected.
          experimentalMinChunkSize: 5000,
          manualChunks(id) {
            // Phase 3 splits (kept): vendor libs load once and are cached.
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom/') || id.includes('node_modules/react-router/')) return 'vendor-react';
            // B1 (W13 NEXT R6): split the S3 storage client out of
            // vendor-amplify. aws-amplify/storage (+ its @aws-sdk/client-s3
            // dep) is only used by lazy screens (ChatScreen, Settings,
            // Signup, Status, Vault, account deletion); nothing in the boot
            // path imports it, so it must not ride in the first-load
            // bundle. MUST stay above the vendor-amplify rule below:
            // 'node_modules/aws-amplify' also matches '@aws-amplify/*'.
            if (id.includes('node_modules/@aws-amplify/storage') || id.includes('node_modules/aws-amplify/storage') || id.includes('node_modules/@aws-sdk/client-s3')) return 'vendor-amplify-storage';
            if (id.includes('node_modules/aws-amplify')) return 'vendor-amplify';
            if (id.includes('node_modules/@capacitor/')) return 'vendor-capacitor';
            // REPORT-3 #248 (W13 NEXT R4): lucide-react ships one module
            // per icon, and Rollup splits each into its own micro-chunk —
            // the baseline had 44 sub-1 KB icon chunks (the 342-byte
            // `search` chunk was the poisoned leaf in the D-7 forensics).
            // Every chunk is an independent module fetch, so 44 icon
            // fetches per screen load means 44 chances for one transient
            // failure to poison the whole import (module-map error
            // caching). One shared icon chunk cuts that to a single fetch.
            if (id.includes('node_modules/lucide-react')) return 'vendor-icons';
            return undefined;
          },
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
