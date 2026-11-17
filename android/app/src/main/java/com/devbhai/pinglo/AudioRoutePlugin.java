package com.devbhai.pinglo;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * Routes call audio during a call.
 *
 * Report 3, P0-7 (#9/#10/#16): the old version pinned every call to the
 * built-in earpiece the moment it connected
 * ({@code setCommunicationDevice(first TYPE_BUILTIN_EARPIECE)}), which
 * tells Android to stop auto-routing — a connected Bluetooth or wired
 * headset then stayed silent for the whole call, and the Speaker toggle
 * could only ever pick earpiece vs loudspeaker. There was no Bluetooth
 * handling at all: no SCO, no device listener, no output selector.
 *
 * This version, on API 31+ (targetSdk 34):
 * <ul>
 *   <li>auto-routes to a connected Bluetooth headset first, then a wired
 *       headset, then the earpiece — {@link #routeAuto()};</li>
 *   <li>exposes the real device list ({@link #getDevices()}) and explicit
 *       selection ({@link #setDevice(PluginCall)}), so the UI can offer
 *       Earpiece / Speaker / &lt;headset name&gt; like WhatsApp;</li>
 *   <li>listens for devices appearing/disappearing mid-call
 *       ({@code addOnCommunicationDeviceChangedListener}) and re-routes,
 *       notifying the web side via the {@code audioRouteChanged} event;</li>
 *   <li>requests {@code BLUETOOTH_CONNECT} at runtime (API 31+), without
 *       which {@code getAvailableCommunicationDevices()} hides Bluetooth
 *       devices entirely (#14).</li>
 * </ul>
 * Pre-31 (minSdk 22) there is no communication-device API, so the old
 * {@code setSpeakerphoneOn()} path is kept and Bluetooth SCO is attempted
 * best-effort ({@code setBluetoothScoOn(true)} /
 * {@code startBluetoothSco()}); that path can only be proven on a real
 * pre-12 device. No route is ever silently pinned: every method reports
 * the device that is actually active.
 */
@CapacitorPlugin(
    name = "AudioRoute",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        )
    }
)
public class AudioRoutePlugin extends Plugin {

    private static final String KIND_EARPIECE = "earpiece";
    private static final String KIND_SPEAKER = "speaker";
    private static final String KIND_BLUETOOTH = "bluetooth";
    private static final String KIND_WIRED = "wired";
    private static final String KIND_UNKNOWN = "unknown";

    /** Device the user explicitly picked in the call UI; null = auto-route. */
    private String userSelectedId = null;
    /** Last device we routed to (for the change listener + read-back). */
    private String lastRoutedId = null;

    private AudioManager.OnCommunicationDeviceChangedListener commListener = null;
    private AudioManager.AudioDeviceCallback deviceCallback = null;

    private AudioManager audio() {
        return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
    }

    // ── Device model ──────────────────────────────────────────────────

    private static String kindOf(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE:
                return KIND_EARPIECE;
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
                return KIND_SPEAKER;
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
            case AudioDeviceInfo.TYPE_BLE_HEADSET:
            case AudioDeviceInfo.TYPE_BLE_BROADCAST:
            case AudioDeviceInfo.TYPE_BLE_SPEAKER:
                return KIND_BLUETOOTH;
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_USB_DEVICE:
                return KIND_WIRED;
            default:
                return KIND_UNKNOWN;
        }
    }

    /** Stable id for a device. getId() only exists on API 28+. */
    private static String idOf(AudioDeviceInfo d) {
        if (Build.VERSION.SDK_INT >= 28) {
            return "id:" + d.getId();
        }
        CharSequence name = d.getProductName();
        return "type:" + d.getType() + ":" + (name == null ? "" : name.toString());
    }

    private static JSObject toJson(AudioDeviceInfo d) {
        JSObject o = new JSObject();
        o.put("id", idOf(d));
        o.put("kind", kindOf(d.getType()));
        o.put("name", d.getProductName() == null ? "" : d.getProductName().toString());
        o.put("type", d.getType());
        return o;
    }

    private static JSObject toJson(String id, String kind, String name) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("kind", kind);
        o.put("name", name);
        o.put("type", -1);
        return o;
    }

    /**
     * Available communication devices on API 31+. Returns an empty list
     * (never throws) when BLUETOOTH_CONNECT is missing — the caller
     * reports that as denied instead of crashing the call.
     */
    private List<AudioDeviceInfo> availableDevices() {
        List<AudioDeviceInfo> out = new ArrayList<>();
        if (Build.VERSION.SDK_INT < 31) return out;
        try {
            for (AudioDeviceInfo d : audio().getAvailableCommunicationDevices()) {
                out.add(d);
            }
        } catch (SecurityException e) {
            // BLUETOOTH_CONNECT not granted: Bluetooth devices are hidden.
            // Earpiece/speaker are still listed by the platform, so the
            // call can proceed without Bluetooth.
        }
        return out;
    }

    private AudioDeviceInfo findDevice(String id) {
        if (id == null) return null;
        for (AudioDeviceInfo d : availableDevices()) {
            if (id.equals(idOf(d))) return d;
        }
        return null;
    }

    private AudioDeviceInfo firstOfKind(String kind) {
        for (AudioDeviceInfo d : availableDevices()) {
            if (kind.equals(kindOf(d.getType()))) return d;
        }
        return null;
    }

    /** The device actually in use right now, or null if none is set. */
    private JSObject currentDeviceJson() {
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                AudioDeviceInfo cur = audio().getCommunicationDevice();
                if (cur != null) return toJson(cur);
            } catch (SecurityException ignored) {
                // Fall through to the speakerphone read-back below.
            }
        }
        AudioManager m = audio();
        if (m.isSpeakerphoneOn()) {
            return toJson("speaker", KIND_SPEAKER, "Speaker");
        }
        if (Build.VERSION.SDK_INT < 31 && m.isBluetoothScoOn()) {
            return toJson("bluetooth-sco", KIND_BLUETOOTH, "Bluetooth headset");
        }
        return toJson("earpiece", KIND_EARPIECE, "Earpiece");
    }

    private JSObject resultWithDevice() {
        JSObject r = new JSObject();
        r.put("device", currentDeviceJson());
        r.put("bluetoothDenied", isBluetoothDenied());
        return r;
    }

    private boolean isBluetoothDenied() {
        if (Build.VERSION.SDK_INT < 31) return false;
        return ActivityCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED;
    }

    // ── Routing ───────────────────────────────────────────────────────

    /**
     * Auto-route preference: Bluetooth headset &gt; wired headset &gt;
     * earpiece. Never pins the earpiece while a headset is connected —
     * that was the P0-7 bug.
     */
    private void routeAuto() {
        AudioManager m = audio();
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo bt = firstOfKind(KIND_BLUETOOTH);
            if (bt != null) {
                m.setCommunicationDevice(bt);
                lastRoutedId = idOf(bt);
                return;
            }
            AudioDeviceInfo wired = firstOfKind(KIND_WIRED);
            if (wired != null) {
                m.setCommunicationDevice(wired);
                lastRoutedId = idOf(wired);
                return;
            }
            AudioDeviceInfo earpiece = firstOfKind(KIND_EARPIECE);
            if (earpiece != null) {
                m.setCommunicationDevice(earpiece);
                lastRoutedId = idOf(earpiece);
                return;
            }
            m.setSpeakerphoneOn(false);
            lastRoutedId = null;
            return;
        }
        // Pre-31: no communication-device API. Prefer Bluetooth SCO when
        // the platform says it is available, else the earpiece.
        routeLegacy(false);
    }

    /**
     * Legacy route (API &lt; 31): speaker on/off, with a best-effort
     * Bluetooth SCO attempt when the speaker is off. SCO needs the
     * legacy BLUETOOTH permission (declared maxSdkVersion 30).
     */
    private void routeLegacy(boolean speaker) {
        AudioManager m = audio();
        if (speaker) {
            try { m.stopBluetoothSco(); } catch (Exception ignored) {}
            try { m.setBluetoothScoOn(false); } catch (Exception ignored) {}
            m.setSpeakerphoneOn(true);
            lastRoutedId = "speaker";
            return;
        }
        m.setSpeakerphoneOn(false);
        try {
            if (m.isBluetoothScoAvailableOffCall()) {
                m.setBluetoothScoOn(true);
                m.startBluetoothSco();
                lastRoutedId = "bluetooth-sco";
                return;
            }
        } catch (Exception ignored) {
            // No headset / SCO refused: fall through to the earpiece.
        }
        lastRoutedId = "earpiece";
    }

    /**
     * Route to one explicit device (or the speaker/earpiece by kind).
     * Returns false when the requested device is not available.
     */
    private boolean routeTo(String deviceId) {
        if (deviceId == null) {
            routeAuto();
            return true;
        }
        if ("speaker".equals(deviceId)) {
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo sp = firstOfKind(KIND_SPEAKER);
                if (sp != null) {
                    audio().setCommunicationDevice(sp);
                    lastRoutedId = idOf(sp);
                    return true;
                }
            }
            audio().setSpeakerphoneOn(true);
            lastRoutedId = "speaker";
            return true;
        }
        if ("earpiece".equals(deviceId)) {
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo ep = firstOfKind(KIND_EARPIECE);
                if (ep != null) {
                    audio().setCommunicationDevice(ep);
                    lastRoutedId = idOf(ep);
                    return true;
                }
            }
            audio().setSpeakerphoneOn(false);
            lastRoutedId = "earpiece";
            return true;
        }
        if (Build.VERSION.SDK_INT >= 31) {
            AudioDeviceInfo d = findDevice(deviceId);
            if (d != null) {
                audio().setCommunicationDevice(d);
                lastRoutedId = idOf(d);
                return true;
            }
            // The id may be stale (device re-enumerated with a new id):
            // fall back to the same kind if one is present.
            String kind = deviceId.startsWith("bluetooth") ? KIND_BLUETOOTH
                    : deviceId.startsWith("wired") ? KIND_WIRED : null;
            if (kind != null) {
                AudioDeviceInfo sameKind = firstOfKind(kind);
                if (sameKind != null) {
                    audio().setCommunicationDevice(sameKind);
                    lastRoutedId = idOf(sameKind);
                    return true;
                }
            }
            return false;
        }
        // Pre-31: only speaker/earpiece ids are addressable; a headset
        // id here means "prefer the headset", i.e. the SCO attempt.
        if (deviceId.startsWith("bluetooth") || deviceId.startsWith("wired")) {
            routeLegacy(false);
            return true;
        }
        return false;
    }

    // ── Device-change listening (#12) ─────────────────────────────────

    private void registerDeviceListener() {
        unregisterDeviceListener();
        final AudioManager m = audio();
        if (Build.VERSION.SDK_INT >= 31) {
            Executor executor = getContext().getMainExecutor();
            commListener = new AudioManager.OnCommunicationDeviceChangedListener() {
                @Override
                public void onCommunicationDeviceChanged(AudioDeviceInfo device) {
                    onDevicesChanged();
                }
            };
            try {
                m.addOnCommunicationDeviceChangedListener(executor, commListener);
            } catch (Exception ignored) {
                commListener = null;
            }
        } else if (Build.VERSION.SDK_INT >= 23) {
            deviceCallback = new AudioManager.AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                    onDevicesChanged();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                    onDevicesChanged();
                }
            };
            try {
                m.registerAudioDeviceCallback(deviceCallback, new Handler());
            } catch (Exception ignored) {
                deviceCallback = null;
            }
        }
    }

    private void unregisterDeviceListener() {
        AudioManager m = audio();
        if (commListener != null && Build.VERSION.SDK_INT >= 31) {
            try {
                m.removeOnCommunicationDeviceChangedListener(commListener);
            } catch (Exception ignored) {}
            commListener = null;
        }
        if (deviceCallback != null && Build.VERSION.SDK_INT >= 23) {
            try {
                m.unregisterAudioDeviceCallback(deviceCallback);
            } catch (Exception ignored) {}
            deviceCallback = null;
        }
    }

    /**
     * A device appeared or disappeared mid-call. An explicit user pick
     * wins while it is still present (never yank the user off the
     * speaker they chose because a headset was plugged in); otherwise
     * re-run auto-routing — a newly connected headset takes over, a
     * disconnected one falls back to earpiece, never to silence.
     */
    private void onDevicesChanged() {
        try {
            if (userSelectedId != null) {
                if (findDevice(userSelectedId) != null
                        || "speaker".equals(userSelectedId)
                        || "earpiece".equals(userSelectedId)) {
                    // Explicit pick still valid — re-apply it in case the
                    // platform moved the route underneath us.
                    routeTo(userSelectedId);
                } else {
                    // The picked device is gone: drop back to auto-route.
                    userSelectedId = null;
                    routeAuto();
                }
            } else {
                routeAuto();
            }
            JSObject event = new JSObject();
            event.put("device", currentDeviceJson());
            event.put("bluetoothDenied", isBluetoothDenied());
            notifyListeners("audioRouteChanged", event);
        } catch (Exception ignored) {
            // Routing must never crash a live call.
        }
    }

    // ── Plugin methods ────────────────────────────────────────────────

    @PluginMethod
    public void start(PluginCall call) {
        audio().setMode(AudioManager.MODE_IN_COMMUNICATION);
        registerDeviceListener();
        // Auto-route (Bluetooth/wired first) — NOT a forced earpiece.
        // The old code called route(false) here, which pinned the
        // earpiece and disabled Android auto-routing for the whole call.
        userSelectedId = null;
        routeAuto();
        call.resolve(resultWithDevice());
    }

    /**
     * Legacy two-way toggle kept for callers that only know speaker on/off.
     * Speaker OFF now means "auto-route" (headset if present, else
     * earpiece) instead of "force earpiece" — the old behaviour is what
     * made the toggle unable to reach Bluetooth (#10).
     */
    @PluginMethod
    public void setSpeaker(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        if (on) {
            userSelectedId = "speaker";
            routeTo("speaker");
        } else {
            userSelectedId = null;
            routeAuto();
        }
        JSObject current = currentDeviceJson();
        JSObject result = resultWithDevice();
        result.put("speaker", KIND_SPEAKER.equals(current.optString("kind")));
        call.resolve(result);
    }

    /** All available call-audio outputs (type + product name). */
    @PluginMethod
    public void getDevices(PluginCall call) {
        JSObject result = new JSObject();
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : availableDevices()) {
                arr.put(toJson(d));
            }
        } else {
            // Pre-31 has no enumeration API: report what we can know.
            arr.put(toJson("earpiece", KIND_EARPIECE, "Earpiece"));
            arr.put(toJson("speaker", KIND_SPEAKER, "Speaker"));
            AudioManager m = audio();
            try {
                if (m.isBluetoothScoAvailableOffCall()) {
                    arr.put(toJson("bluetooth-sco", KIND_BLUETOOTH, "Bluetooth headset"));
                }
            } catch (Exception ignored) {}
        }
        result.put("devices", arr);
        result.put("current", currentDeviceJson());
        result.put("bluetoothDenied", isBluetoothDenied());
        call.resolve(result);
    }

    /** Route to one explicit device (see getDevices ids, or "speaker"/"earpiece"). */
    @PluginMethod
    public void setDevice(PluginCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId == null || deviceId.isEmpty()) {
            call.reject("setDevice: deviceId is required");
            return;
        }
        boolean ok = routeTo(deviceId);
        if (!ok) {
            call.reject("setDevice: device '" + deviceId + "' is not available");
            return;
        }
        userSelectedId = deviceId;
        call.resolve(resultWithDevice());
    }

    /** The device actually active right now (read-back, not last request). */
    @PluginMethod
    public void getCurrentDevice(PluginCall call) {
        call.resolve(resultWithDevice());
    }

    /**
     * Runtime BLUETOOTH_CONNECT permission (#14). On API &lt; 31 it is
     * not a runtime permission: resolves granted. On API 31+ resolves
     * {@code {granted: false}} when the user denies — the call still
     * works on earpiece/speaker, the UI says why Bluetooth is missing.
     */
    @PluginMethod
    public void ensureBluetoothPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 31) {
            JSObject r = new JSObject();
            r.put("granted", true);
            r.put("notNeeded", true);
            call.resolve(r);
            return;
        }
        if (!isBluetoothDenied()) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
            return;
        }
        // Show the system dialog; the result lands in the callback below
        // (Capacitor saves the call itself — no saveCall() needed).
        requestPermissionForAlias("bluetooth", call, "bluetoothPermissionCallback");
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        boolean granted = getPermissionState("bluetooth") == PermissionState.GRANTED;
        JSObject r = new JSObject();
        r.put("granted", granted);
        call.resolve(r);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        unregisterDeviceListener();
        userSelectedId = null;
        lastRoutedId = null;
        AudioManager m = audio();
        if (Build.VERSION.SDK_INT >= 31) {
            try { m.clearCommunicationDevice(); } catch (Exception ignored) {}
        } else {
            try { m.stopBluetoothSco(); } catch (Exception ignored) {}
            try { m.setBluetoothScoOn(false); } catch (Exception ignored) {}
        }
        m.setSpeakerphoneOn(false);
        m.setMode(AudioManager.MODE_NORMAL);
        call.resolve();
    }
}
