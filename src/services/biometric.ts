import { registerPlugin, Capacitor } from '@capacitor/core';

interface BiometricPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  authenticate(options: { title: string; subtitle?: string }): Promise<{ ok: boolean; error?: string }>;
}

// Native androidx.biometric bridge (android/.../BiometricPlugin.java)
const Biometric = registerPlugin<BiometricPlugin>('Biometric');

const PREF_KEY = 'vaultBiometric'; // '1' = on, '0' = off, absent = not decided yet

/** True only on the Android app when a fingerprint/face is enrolled and usable. */
export const biometricAvailable = async (): Promise<boolean> => {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return !!(await Biometric.isAvailable())?.available;
  } catch {
    return false;
  }
};

/** Shows the system fingerprint prompt. False on cancel, failure or "Use PIN". */
export const biometricAuthenticate = async (title: string, subtitle = ''): Promise<boolean> => {
  try {
    const res = await Biometric.authenticate({ title, subtitle });
    return !!res?.ok;
  } catch {
    return false;
  }
};

/** Per-device setting. Returns null when the user has not chosen yet. */
export const getBiometricPref = (): '1' | '0' | null => {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === '1' || v === '0' ? v : null;
  } catch {
    return null;
  }
};

export const setBiometricPref = (on: boolean) => {
  try {
    localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    /* storage blocked: the feature simply stays off */
  }
};
