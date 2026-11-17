package com.devbhai.pinglo;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Parcelable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;

/**
 * ROADMAP-2 #8 — Android share-sheet target (native half).
 *
 * The manifest now declares ACTION_SEND / ACTION_SEND_MULTIPLE
 * intent-filters on MainActivity (text/plain, image/*, video/*), so
 * Gallery / browser "Share → Pinglo" offers the app. This plugin
 * receives the intent and hands it to the web side:
 *
 *  - Cold start: the launch intent is captured in load().
 *  - App already open: MainActivity is singleTask, so the share arrives
 *    via handleOnNewIntent() and is broadcast as a "shareReceived"
 *    event (light payload only — text + file count — so listeners stay
 *    cheap; the full payload is pulled with getPendingShare()).
 *  - getPendingShare(): returns { text, subject, files: [{ name,
 *    mimeType, path }] } and CONSUMES the pending intent (a second call
 *    returns empty), so a share is never delivered twice.
 *
 * Shared content:// streams are COPIED into the app cache dir
 * (cache/shared/) before being returned: the granting app's URI
 * permission dies with the share, and the WebView cannot fetch a
 * content:// URI directly. The TS side (services/shareIntent.ts)
 * converts each returned file path with Capacitor.convertFileSrc() and
 * fetches it into a File for the chat send path. At most 10 files are
 * kept — a share-sheet dump of dozens of photos is capped honestly
 * instead of OOM-ing the copy loop; the cap is reported in the payload
 * as `truncated: true`.
 *
 * TS side: services/shareIntent.ts registers the 'ShareIntent' plugin
 * (getPendingShare / clearPendingShare / 'shareReceived' listener).
 * On the web there is no native plugin, so every call rejects and the
 * TS side treats that as "no share" — the browser keeps working.
 *
 * NOT compiled in this sandbox (no javac / Android SDK here): the next
 * CI APK build is the compile check — see roadmap2/PATCH-R1B.md.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {

    /** Max shared files kept per share (see class doc). */
    private static final int MAX_FILES = 10;

    /** The most recent un-consumed share intent, or null. */
    private Intent pendingIntent;

    @Override
    public void load() {
        super.load();
        try {
            if (getActivity() == null) return;
            Intent intent = getActivity().getIntent();
            if (isShareIntent(intent)) {
                pendingIntent = intent;
            }
        } catch (Exception e) {
            // Never crash startup over a share intent.
        }
    }

    /**
     * Capacitor calls this when MainActivity receives a new intent while
     * the app is alive (singleTask launch mode). A share arriving here is
     * stored and broadcast; the web side pulls the full payload with
     * getPendingShare().
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            if (!isShareIntent(intent)) return;
            pendingIntent = intent;
            JSObject event = new JSObject();
            event.put("hasText", intent.getStringExtra(Intent.EXTRA_TEXT) != null);
            event.put("fileCount", countStreams(intent));
            notifyListeners("shareReceived", event, false);
        } catch (Exception e) {
            // A malformed share must not crash the app.
        }
    }

    /** Full pending share, consumed on read. Empty payload when none. */
    @PluginMethod
    public void getPendingShare(PluginCall call) {
        try {
            Intent intent = pendingIntent;
            pendingIntent = null;
            if (intent == null || !isShareIntent(intent)) {
                JSObject empty = new JSObject();
                empty.put("text", JSObject.NULL);
                empty.put("subject", JSObject.NULL);
                empty.put("files", new JSArray());
                empty.put("truncated", false);
                call.resolve(empty);
                return;
            }
            call.resolve(extractPayload(intent));
        } catch (Exception e) {
            call.reject("Could not read shared content: " + e.getMessage());
        }
    }

    /** Discard a pending share without reading it. */
    @PluginMethod
    public void clearPendingShare(PluginCall call) {
        pendingIntent = null;
        call.resolve();
    }

    // ── Intent parsing ────────────────────────────────────────────────

    private static boolean isShareIntent(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        return Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
    }

    private int countStreams(Intent intent) {
        try {
            if (Intent.ACTION_SEND.equals(intent.getAction())) {
                return intent.getParcelableExtra(Intent.EXTRA_STREAM) != null ? 1 : 0;
            }
            ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            return list != null ? list.size() : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    /** Build the JS payload for a share intent, copying streams to cache. */
    private JSObject extractPayload(Intent intent) {
        JSObject out = new JSObject();
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        out.put("text", text != null ? text.toString() : JSObject.NULL);
        out.put("subject", subject != null ? subject.toString() : JSObject.NULL);

        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else {
            ArrayList<Parcelable> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) {
                for (Parcelable p : list) {
                    if (p instanceof Uri) uris.add((Uri) p);
                }
            }
        }

        JSArray files = new JSArray();
        boolean truncated = uris.size() > MAX_FILES;
        int kept = Math.min(uris.size(), MAX_FILES);
        for (int i = 0; i < kept; i++) {
            JSObject file = copyStreamToCache(uris.get(i), i, intent.getType());
            if (file != null) files.put(file);
        }
        out.put("files", files);
        out.put("truncated", truncated);
        return out;
    }

    /**
     * Copy one shared stream into cache/shared/ and describe it. Returns
     * null when the stream cannot be read (that file is skipped, the rest
     * of the share still goes through).
     */
    private JSObject copyStreamToCache(Uri uri, int index, String intentType) {
        ContentResolver resolver = getContext().getContentResolver();
        String mimeType = null;
        try {
            mimeType = resolver.getType(uri);
        } catch (Exception ignored) {
        }
        if (mimeType == null || mimeType.isEmpty()) mimeType = intentType;
        if (mimeType == null || mimeType.isEmpty()) mimeType = "application/octet-stream";

        String name = safeFileName(uri, mimeType, index);
        try {
            File dir = new File(getContext().getCacheDir(), "shared");
            if (!dir.exists() && !dir.mkdirs()) return null;
            File out = new File(dir, System.currentTimeMillis() + "_" + index + "_" + name);
            InputStream in = resolver.openInputStream(uri);
            if (in == null) return null;
            try {
                OutputStream os = new FileOutputStream(out);
                try {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        os.write(buf, 0, n);
                    }
                } finally {
                    try { os.close(); } catch (Exception ignored) {}
                }
            } finally {
                try { in.close(); } catch (Exception ignored) {}
            }
            JSObject file = new JSObject();
            file.put("name", name);
            file.put("mimeType", mimeType);
            file.put("path", out.getAbsolutePath());
            return file;
        } catch (Exception e) {
            return null;
        }
    }

    /** Last path segment, stripped of anything that could escape the cache dir. */
    private static String safeFileName(Uri uri, String mimeType, int index) {
        String raw = uri.getLastPathSegment();
        if (raw == null || raw.isEmpty()) raw = "shared-" + index;
        // Keep only safe chars; drop directories / traversal outright.
        String cleaned = raw.replaceAll("[^A-Za-z0-9._-]", "_");
        if (cleaned.equals(".") || cleaned.equals("..") || cleaned.isEmpty()) {
            cleaned = "shared-" + index;
        }
        // Guarantee an extension the send path can recognise.
        if (cleaned.lastIndexOf('.') <= 0) {
            String ext = extensionFor(mimeType);
            if (ext != null) cleaned = cleaned + ext;
        }
        return cleaned;
    }

    private static String extensionFor(String mimeType) {
        if (mimeType == null) return null;
        switch (mimeType) {
            case "image/jpeg": return ".jpg";
            case "image/png": return ".png";
            case "image/gif": return ".gif";
            case "image/webp": return ".webp";
            case "video/mp4": return ".mp4";
            case "video/quicktime": return ".mov";
            case "video/webm": return ".webm";
            case "text/plain": return ".txt";
            default: return null;
        }
    }
}
