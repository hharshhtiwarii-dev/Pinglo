import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // App ID — IMPORTANT: change this to your own unique ID
  // Format: com.yourname.appname (reverse domain)
  appId: 'com.devbhai.pinglo',

  // App name shown on phone
  appName: 'Pinglo',

  // Vite build output folder
  webDir: 'dist',

  // Android specific settings
  android: {
    // Allow HTTP (needed for local dev, remove for production)
    allowMixedContent: false,
    // Capture input (needed for keyboard on some devices)
    captureInput: false,
    // WebView settings
    webContentsDebuggingEnabled: false,
  },

  // Plugin configuration
  plugins: {
    // Status bar — native solid WhatsApp status bar seamlessly matching the app dark theme
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#121B22',
      overlaysWebView: false,
    },
    // Keyboard — push content up when keyboard opens
    Keyboard: {
      resize: 'body',
      resizeOnFullScreen: true,
    },
    // SplashScreen settings (if you add @capacitor/splash-screen later)
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#121B22',
      showSpinner: false,
    },
  },
};

export default config;
