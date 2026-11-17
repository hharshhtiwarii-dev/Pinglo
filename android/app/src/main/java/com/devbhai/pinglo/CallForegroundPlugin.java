package com.devbhai.pinglo;

import android.content.Intent;
import android.os.Build;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AUDIT-2 B18 — Capacitor bridge for CallForegroundService (registered in
 * MainActivity, same pattern as AudioRoutePlugin). TS side:
 * services/callService.ts registers the 'CallForeground' plugin and calls
 * start() when a call becomes active / stop() in endCall(). On the web
 * there is no native plugin, so the calls reject and are swallowed — the
 * browser keeps its own call-audio behaviour.
 */
@CapacitorPlugin(name = "CallForeground")
public class CallForegroundPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), CallForegroundService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not start call foreground service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), CallForegroundService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not stop call foreground service: " + e.getMessage());
        }
    }
}
