/**
 * G3 — Live location sharing.
 *
 * WhatsApp-style live location: the sharer broadcasts their position while
 * moving, for a chosen duration (15 min / 1 hour / 8 hours). Receivers see
 * the position update on a map until the session expires or the sharer stops it.
 *
 * Transport note: this module ONLY tracks the GPS position and produces
 * the update payloads. It does NOT send anything over the network by
 * itself. The caller must wire `sendUpdate` to the real transport — see
 * `LiveLocationUpdate`. ChatScreen wires it: each throttled tick
 * `updateDoc`s the live-location message doc (same doc, new
 * latitude/longitude/`liveLocationUpdatedAt`), and receivers see the
 * ticks through the normal message subscription. (An older version of
 * this comment claimed no transport existed — that was stale; the
 * ChatScreen wiring landed with W27.)
 *
 * No new dependency: uses `navigator.geolocation.watchPosition` (same
 * approach as `locationSharing.ts`, which also falls back to the browser API
 * when @capacitor/geolocation is not installed).
 */

import { isValidLatLng } from './locationSharing';

/** WhatsApp's three live-location durations. */
export type LiveLocationDuration = '15m' | '1h' | '8h';

export const LIVE_LOCATION_DURATIONS: {
  id: LiveLocationDuration;
  label: string;
  minutes: number;
  ms: number;
}[] = [
  { id: '15m', label: '15 minutes', minutes: 15, ms: 15 * 60 * 1000 },
  { id: '1h', label: '1 hour', minutes: 60, ms: 60 * 60 * 1000 },
  { id: '8h', label: '8 hours', minutes: 480, ms: 8 * 60 * 60 * 1000 },
];

export const durationMs = (d: LiveLocationDuration): number =>
  LIVE_LOCATION_DURATIONS.find((x) => x.id === d)?.ms ?? 60 * 60 * 1000;

export const durationLabel = (d: LiveLocationDuration): string =>
  LIVE_LOCATION_DURATIONS.find((x) => x.id === d)?.label ?? '1 hour';

/** One throttled position tick, ready to send over the channel. */
export interface LiveLocationUpdate {
  /** Stable id of the live session (= the live-location message id). */
  liveLocationId: string;
  latitude: number;
  longitude: number;
  /** Accuracy in metres, when the provider reports it. */
  accuracy?: number;
  /** Client timestamp (ms) of this fix. */
  updatedAt: number;
  /** Epoch ms when the session expires. */
  expiresAt: number;
}

/**
 * Fields stored on the chat message document for a live-location share.
 * The message is created once (`type: 'live-location'`) and then UPDATED
 * in place on every throttled tick — never re-sent as a new message.
 */
export interface LiveLocationMessageData {
  type: 'live-location';
  liveLocationId: string;
  latitude: number;
  longitude: number;
  locationAccuracy?: number;
  /** Epoch ms when sharing stops automatically. */
  liveLocationExpiresAt: number;
  /** Epoch ms of the last position update. */
  liveLocationUpdatedAt: number;
  /** False once expired / stopped — receivers then show the last position as ended. */
  liveLocationActive: boolean;
  senderId: string;
  senderName: string;
}

/** Payload for creating the live-location message (first position fix). */
export const buildLiveLocationMessage = (opts: {
  liveLocationId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  duration: LiveLocationDuration;
  senderId: string;
  senderName: string;
  now?: number;
}): LiveLocationMessageData => {
  const now = opts.now ?? Date.now();
  return {
    type: 'live-location',
    liveLocationId: opts.liveLocationId,
    latitude: opts.latitude,
    longitude: opts.longitude,
    ...(typeof opts.accuracy === 'number' ? { locationAccuracy: opts.accuracy } : {}),
    liveLocationExpiresAt: now + durationMs(opts.duration),
    liveLocationUpdatedAt: now,
    liveLocationActive: true,
    senderId: opts.senderId,
    senderName: opts.senderName,
  };
};

/** Fields to write on every throttled tick (updateDoc / mutation payload). */
export const buildLiveLocationUpdateFields = (
  update: LiveLocationUpdate,
): { latitude: number; longitude: number; locationAccuracy?: number; liveLocationUpdatedAt: number } => ({
  latitude: update.latitude,
  longitude: update.longitude,
  ...(typeof update.accuracy === 'number' ? { locationAccuracy: update.accuracy } : {}),
  liveLocationUpdatedAt: update.updatedAt,
});

/** Is this live-location message still active right now? */
export const isLiveLocationActive = (
  msg: Pick<LiveLocationMessageData, 'liveLocationActive' | 'liveLocationExpiresAt'>,
  now: number = Date.now(),
): boolean => !!msg.liveLocationActive && now < msg.liveLocationExpiresAt;

/** Milliseconds left on a session; 0 when expired. */
export const liveLocationRemainingMs = (expiresAt: number, now: number = Date.now()): number =>
  Math.max(0, expiresAt - now);

/** "Live · 42 min left" style label. */
export const formatLiveRemaining = (expiresAt: number, now: number = Date.now()): string => {
  const ms = liveLocationRemainingMs(expiresAt, now);
  if (ms <= 0) return 'Live location ended';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `Live · ${mins} min left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `Live · ${h} hr left` : `Live · ${h} hr ${m} min left`;
};

/* ── Map links (OpenStreetMap, no key / no dependency) ─────────────── */

export const osmMapUrl = (lat: number, lng: number, zoom = 16): string =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${zoom}/${lat}/${lng}`;

/** Embeddable OSM map centred on the point, with a marker. */
export const osmEmbedUrl = (lat: number, lng: number): string => {
  const d = 0.01; // ~1 km bbox around the point at this zoom
  const bbox = `${lng - d},${lat - d},${lng + d},${lat + d}`;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
};

/** Embed bbox covering two points (sharer + viewer) for the live viewer. */
export const osmEmbedUrlForTwoPoints = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): string => {
  const pad = 0.01;
  const minLat = Math.min(a.latitude, b.latitude) - pad;
  const maxLat = Math.max(a.latitude, b.latitude) + pad;
  const minLng = Math.min(a.longitude, b.longitude) - pad;
  const maxLng = Math.max(a.longitude, b.longitude) + pad;
  const bbox = `${minLng},${minLat},${maxLng},${maxLat}`;
  // OSM embed takes a single marker: mark the sharer (a). The viewer's own
  // position is shown in the distance/ETA card below the map.
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${a.latitude},${a.longitude}`;
};

/* ── Distance / ETA ─────────────────────────────────────────────────── */

/** Great-circle distance in metres. */
export const haversineMeters = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number => {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

export const formatDistance = (meters: number): string =>
  meters < 1000 ? `${Math.round(meters)} m away` : `${(meters / 1000).toFixed(1)} km away`;

/** Rough walking ETA (5 km/h). Returns '' when too close to matter. */
export const formatWalkingEta = (meters: number): string => {
  if (meters < 100) return '';
  const mins = Math.round(meters / 1000 / 5 * 60);
  if (mins < 1) return 'under a minute on foot';
  if (mins < 60) return `~${mins} min on foot`;
  const h = Math.floor(mins / 60);
  return `~${h} hr ${mins % 60} min on foot`;
};

/* ── Live session (watchPosition + throttle + expiry) ───────────────── */

export interface LiveLocationSessionOptions {
  /** Chat / conversation id the session belongs to. */
  chatId: string;
  /** Id of the live-location message (also the session id). */
  liveLocationId: string;
  duration: LiveLocationDuration;
  /**
   * Called with every throttled update — the caller sends it (updateDoc on
   * the message doc, or AppSync mutation). MUST be async-safe; errors are
   * swallowed by the session so one failed tick never kills tracking.
   */
  onUpdate: (update: LiveLocationUpdate) => void | Promise<void>;
  /** Called once when the duration runs out (session already stopped). */
  onExpire?: () => void;
  /** Called on a geolocation error (e.g. permission revoked mid-share). */
  onError?: (message: string) => void;
  /**
   * RESUME (W27): re-start a session whose watch died with a reload.
   * When set and still in the future, the session expires at this exact
   * instant instead of `now + duration` — resuming must never extend a
   * share past the expiry the user originally picked.
   */
  resumeExpiresAt?: number;
  /** Min seconds between sent updates. Default 12 (WhatsApp-like 10–15 s). */
  minIntervalSec?: number;
  /** Min movement in metres before a tick is sent. Default 10. */
  minDistanceM?: number;
}

export interface LiveLocationSession {
  liveLocationId: string;
  chatId: string;
  duration: LiveLocationDuration;
  expiresAt: number;
  startedAt: number;
  stop: (reason?: 'manual' | 'expired' | 'error') => void;
  readonly active: boolean;
}

const STORAGE_KEY = 'dt-live-location-sessions';

interface PersistedSession {
  liveLocationId: string;
  chatId: string;
  duration: LiveLocationDuration;
  expiresAt: number;
  startedAt: number;
}

const loadPersisted = (): PersistedSession[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedSession[];
    return Array.isArray(parsed) ? parsed.filter((s) => s.expiresAt > Date.now()) : [];
  } catch {
    return [];
  }
};

const savePersisted = (sessions: PersistedSession[]): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* storage full / private mode — session still runs in memory */
  }
};

/** Sessions this device is currently sharing (survives reload via localStorage meta). */
export const getActiveSessions = (): PersistedSession[] => loadPersisted();

export const isSharingLiveLocation = (chatId: string): boolean =>
  loadPersisted().some((s) => s.chatId === chatId);

/** One active watch per chat: starting a second share in the same chat replaces the first. */
const activeWatches = new Map<string, LiveLocationSession>();

export const getActiveSession = (chatId: string): LiveLocationSession | undefined =>
  activeWatches.get(chatId);

/**
 * Start sharing live location in a chat.
 * - Takes an immediate first fix, then `watchPosition` ticks.
 * - Ticks are throttled: at most one `onUpdate` per `minIntervalSec`
 *   (default 12 s) AND only when the device moved `minDistanceM` (default
 *   10 m) since the last sent tick — so a stationary phone sends nothing.
 * - Stops itself at `expiresAt` and calls `onExpire`.
 * - Persists session meta to localStorage so the UI can show "sharing…"
 *   after a reload; the watch itself does NOT survive a reload — the caller
 *   must call `startLiveLocation` again (or prompt the user) on app start.
 * Returns null when geolocation is unavailable/denied.
 */
export const startLiveLocation = async (
  opts: LiveLocationSessionOptions,
): Promise<LiveLocationSession | null> => {
  if (!('geolocation' in navigator)) {
    opts.onError?.('Geolocation is not supported by this device.');
    return null;
  }

  // Replace any existing share in this chat.
  activeWatches.get(opts.chatId)?.stop('manual');

  const minIntervalMs = (opts.minIntervalSec ?? 12) * 1000;
  const minDistanceM = opts.minDistanceM ?? 10;
  const startedAt = Date.now();
  // Resume: keep the ORIGINAL expiry the user picked (never extend).
  // A resume expiry already in the past means the share is over.
  if (opts.resumeExpiresAt && opts.resumeExpiresAt <= startedAt) {
    opts.onError?.('This live location session has already expired.');
    return null;
  }
  const expiresAt = opts.resumeExpiresAt && opts.resumeExpiresAt > startedAt
    ? opts.resumeExpiresAt
    : startedAt + durationMs(opts.duration);

  let lastSent: { latitude: number; longitude: number; at: number } | null = null;
  let watchId: number | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const session: LiveLocationSession = {
    liveLocationId: opts.liveLocationId,
    chatId: opts.chatId,
    duration: opts.duration,
    expiresAt,
    startedAt,
    get active() {
      return !stopped;
    },
    stop: (reason = 'manual') => {
      if (stopped) return;
      stopped = true;
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      activeWatches.delete(opts.chatId);
      savePersisted(loadPersisted().filter((s) => s.liveLocationId !== opts.liveLocationId));
      if (reason === 'expired') opts.onExpire?.();
    },
  };

  const emit = (latitude: number, longitude: number, accuracy?: number, now: number = Date.now()) => {
    if (stopped || !isValidLatLng(latitude, longitude)) return;
    if (lastSent) {
      const moved = haversineMeters(lastSent, { latitude, longitude });
      if (now - lastSent.at < minIntervalMs && moved < minDistanceM) return;
      if (now - lastSent.at < minIntervalMs) return;
      if (moved < minDistanceM && now - lastSent.at < minIntervalMs * 5) return;
    }
    lastSent = { latitude, longitude, at: now };
    const update: LiveLocationUpdate = {
      liveLocationId: opts.liveLocationId,
      latitude,
      longitude,
      ...(typeof accuracy === 'number' ? { accuracy } : {}),
      updatedAt: now,
      expiresAt,
    };
    try {
      const r = opts.onUpdate(update);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => { /* one failed tick must not kill tracking */ });
      }
    } catch {
      /* same: never let a send failure stop the watch */
    }
  };

  // First fix immediately (also validates permission before we claim to share).
  try {
    const first = await new Promise<GeolocationPosition>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 10000,
      });
    });
    if (stopped) return null;
    emit(first.coords.latitude, first.coords.longitude, first.coords.accuracy);
  } catch (err) {
    const code = (err as GeolocationPositionError)?.code;
    opts.onError?.(
      code === 1
        ? 'Location permission denied. Allow location access to share live location.'
        : 'Could not get your location. Check GPS and try again.',
    );
    return null;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => emit(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    (err) => {
      if (err.code === 1) {
        opts.onError?.('Location permission was revoked — live location stopped.');
        session.stop('error');
      }
      // code 2/3 (unavailable/timeout): keep watching, the next fix may succeed.
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 },
  );

  expiryTimer = setTimeout(() => session.stop('expired'), Math.max(0, expiresAt - Date.now()));

  activeWatches.set(opts.chatId, session);
  savePersisted([
    ...loadPersisted().filter((s) => s.chatId !== opts.chatId),
    { liveLocationId: opts.liveLocationId, chatId: opts.chatId, duration: opts.duration, expiresAt, startedAt },
  ]);

  return session;
};

/** Stop sharing in a chat (manual stop button). Returns true if a session was running. */
export const stopLiveLocation = (chatId: string): boolean => {
  const s = activeWatches.get(chatId);
  if (!s) {
    // Watch may have died with a reload: still clear the persisted meta.
    savePersisted(loadPersisted().filter((x) => x.chatId !== chatId));
    return false;
  }
  s.stop('manual');
  return true;
};
