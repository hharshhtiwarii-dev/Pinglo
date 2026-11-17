/**
 * Feature 4 — Location sharing helpers.
 *
 * No new dependency: @capacitor/geolocation is NOT installed. On native builds
 * the plugin is loaded with a non-literal dynamic import (so `tsc` does not
 * try to resolve the missing package); if it is absent the call rejects and
 * we fall back to the browser Geolocation API, which also works inside the
 * Capacitor WebView. On web we go straight to navigator.geolocation.
 *
 * To get true native GPS (better accuracy / background behaviour), run:
 *   npm install @capacitor/geolocation && npx cap sync
 * — no code change is needed; the dynamic import below will then succeed.
 */

import { Capacitor } from '@capacitor/core';

export interface LatLng {
  latitude: number;
  longitude: number;
  /** Accuracy in metres, when the provider reports it. */
  accuracy?: number;
}

export const googleMapsUrl = (lat: number, lng: number): string =>
  `https://www.google.com/maps?q=${lat},${lng}`;

export const formatCoords = (lat: number, lng: number): string =>
  `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

export const isValidLatLng = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

/** Human-readable reason for a geolocation failure. */
export const geolocationErrorMessage = (err: any): string => {
  const code = err?.code;
  if (code === 1 || /denied|permission/i.test(String(err?.message || ''))) {
    return 'Location permission denied. Allow location access and try again, or enter coordinates manually.';
  }
  if (code === 2) return 'Location unavailable. Check GPS / network and try again, or enter coordinates manually.';
  if (code === 3) return 'Timed out while getting your location. Try again, or enter coordinates manually.';
  return 'Could not get your location. Try again, or enter coordinates manually.';
};

const browserPosition = (timeoutMs = 10000): Promise<LatLng> =>
  new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation is not supported by this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });

const capacitorPosition = async (timeoutMs = 10000): Promise<LatLng> => {
  // Non-literal specifier on purpose: the package is not installed, so a
  // literal import would fail `tsc`. With a variable specifier TS treats the
  // import as `any`; Vite leaves it alone (/* @vite-ignore */) and at runtime
  // it resolves only if the app installed @capacitor/geolocation.
  const specifier = '@capacitor/geolocation';
  const mod: any = await import(/* @vite-ignore */ specifier);
  const pos = await mod.Geolocation.getCurrentPosition({
    enableHighAccuracy: true,
    timeout: timeoutMs,
    maximumAge: 30000,
  });
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
  };
};

/**
 * Current device position. Tries Capacitor Geolocation on native platforms
 * (only when the plugin is installed), otherwise the browser Geolocation API.
 */
export const getCurrentPosition = async (timeoutMs = 10000): Promise<LatLng> => {
  if (Capacitor.isNativePlatform()) {
    try {
      return await capacitorPosition(timeoutMs);
    } catch {
      // Plugin not installed (or native call failed) — fall through to browser API.
    }
  }
  return browserPosition(timeoutMs);
};
