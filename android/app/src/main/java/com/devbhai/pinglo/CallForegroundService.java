package com.devbhai.pinglo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * AUDIT-2 B18 — foreground service that keeps a call alive when the app is
 * backgrounded mid-call. The FOREGROUND_SERVICE_MICROPHONE permission was
 * already in the manifest, but no <service> was ever declared, so the OS
 * could suspend the WebView (and with it the mic / WebRTC audio) as soon
 * as the user switched apps during a call.
 *
 * Lifecycle (driven from TS, see services/callService.ts):
 *   start — when a call becomes active: outgoing dial, or an accepted
 *           incoming call. Shows an ongoing "Call in progress"
 *           notification; the mic foreground-service type tells Android
 *           this service owns the microphone.
 *   stop  — in callService.endCall() (every end path funnels through it).
 *
 * Notes:
 * - START_NOT_STICKY: if the OS kills the service, do NOT resurrect it —
 *   a resurrected service with no live call would show a stale
 *   notification and hold the mic type for nothing. The call itself is
 *   already dead by then (the peer connection lives in the WebView).
 * - The notification channel is IMPORTANCE_LOW: no sound/vibration, just
 *   the persistent "call in progress" row Android requires for a
 *   foreground service. Tapping it returns to the app.
 * - No audio is captured here — the WebView's WebRTC stack still owns
 *   the mic; this service only buys the process priority that keeps it
 *   running. It cannot fix a WebView that the OS already killed; it
 *   prevents the kill in the first place.
 */
public class CallForegroundService extends Service {

    public static final String CHANNEL_ID = "pinglo_call";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();

        Intent activityIntent = new Intent(this, MainActivity.class);
        activityIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, activityIntent, pendingFlags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Pinglo call")
                .setContentText("Call in progress")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            stopForeground(true);
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Calls",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Ongoing call notification");
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }
}
