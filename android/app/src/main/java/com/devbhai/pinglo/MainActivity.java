package com.devbhai.pinglo;

import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AudioRoutePlugin.class);
        registerPlugin(FileSaverPlugin.class);
        registerPlugin(BiometricPlugin.class);
        // AUDIT-2 B18: foreground service for background call audio.
        registerPlugin(CallForegroundPlugin.class);
        // ROADMAP-2 #8: share-sheet target — receives ACTION_SEND /
        // ACTION_SEND_MULTIPLE intents (see ShareIntentPlugin.java).
        registerPlugin(ShareIntentPlugin.class);
        super.onCreate(savedInstanceState);
        // Ensure native Android status bar sits outside the WebView, matching WhatsApp exactly
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }

    /**
     * MF-01 (scaffold, VO-05): toggle FLAG_SECURE on this activity's
     * window while the view-once viewer is open, so screenshots and
     * screen recording are blocked on Android for view-once media.
     *
     * TODO (implementing worker): expose this through a Capacitor
     * plugin bridge and call it from `setViewOnceSecureMode` in
     * src/services/viewOnce.ts on viewer mount/unmount. Until the
     * bridge exists this method is uncalled — screenshots are NOT
     * blocked yet. FLAG_SECURE cannot stop a second camera, and
     * iOS/web cannot block screenshots at all.
     */
    public void setViewOnceSecure(boolean secure) {
        if (secure) {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        }
    }
}
