import { registerPlugin, Capacitor } from '@capacitor/core';

/**
 * Native call audio routing (Android) + web output routing.
 *
 * Report 3 #15: the old bridge swallowed every failure with empty
 * `catch (_) {}` and never reported the real route, so a failed route
 * change looked like success in the UI. Every function here now returns
 * a result object ({ ok, device?, error? }) — callers surface `error`
 * honestly instead of pretending the route changed.
 *
 * Report 3 #18: on the web there is no native plugin, so the Speaker
 * control was a silent no-op. The web path below uses
 * `HTMLMediaElement.setSinkId` / `AudioContext.setSinkId` where the
 * browser supports them, and reports `{ ok: false, error }` with a
 * plain-English reason where it does not — never a silent no-op.
 */

export type AudioDeviceKind = 'earpiece' | 'speaker' | 'bluetooth' | 'wired' | 'unknown';

export interface AudioDevice {
  id: string;
  kind: AudioDeviceKind;
  /** Human name from the platform ("Pixel Buds Pro", "Earpiece"…). May be '' on web before mic permission. */
  name: string;
}

export interface AudioRouteResult {
  ok: boolean;
  /** The device actually active right now (read back from the platform), when known. */
  device?: AudioDevice | null;
  /** All available outputs, when the platform could list them. */
  devices?: AudioDevice[];
  /** True when BLUETOOTH_CONNECT was denied (Android 12+): Bluetooth devices are hidden by the OS. */
  bluetoothDenied?: boolean;
  /** Plain-English reason when ok === false. Never swallowed. */
  error?: string;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Unknown error';
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) || 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

function asDevice(raw: any): AudioDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind;
  return {
    id: String(raw.id ?? ''),
    kind: kind === 'earpiece' || kind === 'speaker' || kind === 'bluetooth' || kind === 'wired' ? kind : 'unknown',
    name: typeof raw.name === 'string' ? raw.name : '',
  };
}

function asDevices(raw: any): AudioDevice[] {
  if (!Array.isArray(raw)) return [];
  const out: AudioDevice[] = [];
  for (const d of raw) {
    const dev = asDevice(d);
    if (dev && dev.id) out.push(dev);
  }
  return out;
}

interface AudioRoutePlugin {
  start(): Promise<{ device?: any; bluetoothDenied?: boolean }>;
  setSpeaker(options: { on: boolean }): Promise<{ speaker: boolean; device?: any; bluetoothDenied?: boolean }>;
  getDevices(): Promise<{ devices?: any[]; current?: any; bluetoothDenied?: boolean }>;
  setDevice(options: { deviceId: string }): Promise<{ device?: any; bluetoothDenied?: boolean }>;
  getCurrentDevice(): Promise<{ device?: any; bluetoothDenied?: boolean }>;
  ensureBluetoothPermission(): Promise<{ granted: boolean; notNeeded?: boolean }>;
  stop(): Promise<void>;
  addListener(event: 'audioRouteChanged', cb: (e: { device?: any; bluetoothDenied?: boolean }) => void): Promise<{ remove: () => void }>;
}

const AudioRoute = registerPlugin<AudioRoutePlugin>('AudioRoute');

/** Start call-audio routing (MODE_IN_COMMUNICATION + auto-route to a headset if one is connected). */
export async function audioRouteStart(): Promise<AudioRouteResult> {
  if (!isNative()) return { ok: false, error: 'Audio routing is handled by the browser on web — use the web output picker instead.' };
  try {
    const res = await AudioRoute.start();
    return { ok: true, device: asDevice(res?.device), bluetoothDenied: res?.bluetoothDenied };
  } catch (err) {
    console.warn('[audioRoute] start failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/**
 * Legacy two-way toggle. Speaker OFF now means "auto-route" (headset if
 * present, else earpiece) instead of forcing the earpiece — the old
 * behaviour could never reach Bluetooth. Prefer cycleAudioOutput /
 * setAudioOutput (callService) which pick from the real device list.
 */
export async function audioRouteSetSpeaker(on: boolean): Promise<AudioRouteResult> {
  if (!isNative()) {
    // Report 3 #108 — the legacy two-way toggle used to hard-fail on the
    // web ("Speaker routing needs the Android app") although the web
    // output path (setSinkId via setWebAudioOutput) works fine. ON routes
    // to the default speaker output, OFF to the browser default
    // (auto-route — the web has no earpiece to force). The sink itself
    // is applied by CallModal's #18 effect from the service's
    // currentAudioDevice; this resolves + remembers the real choice and
    // returns its real result, never a blanket failure.
    try {
      if (!on) return setWebAudioOutput('default');
      const outs = await getWebAudioOutputs();
      if (!outs.ok) return outs;
      const speaker = outs.devices?.find((d) => d.kind === 'speaker');
      return setWebAudioOutput(speaker?.id ?? 'default');
    } catch (err) {
      console.warn('[audioRoute] setSpeaker (web) failed:', err);
      return { ok: false, error: errMessage(err) };
    }
  }
  try {
    const res = await AudioRoute.setSpeaker({ on });
    return { ok: true, device: asDevice(res?.device), bluetoothDenied: res?.bluetoothDenied };
  } catch (err) {
    console.warn('[audioRoute] setSpeaker failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** The real list of call-audio outputs (native) — earpiece/speaker/headset names included. */
export async function audioRouteGetDevices(): Promise<AudioRouteResult> {
  if (!isNative()) return getWebAudioOutputs();
  try {
    const res = await AudioRoute.getDevices();
    return { ok: true, devices: asDevices(res?.devices), device: asDevice(res?.current), bluetoothDenied: res?.bluetoothDenied };
  } catch (err) {
    console.warn('[audioRoute] getDevices failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** Route to one explicit device from getDevices() (or 'speaker' / 'earpiece'). */
export async function audioRouteSetDevice(deviceId: string): Promise<AudioRouteResult> {
  if (!isNative()) return setWebAudioOutput(deviceId);
  try {
    const res = await AudioRoute.setDevice({ deviceId });
    return { ok: true, device: asDevice(res?.device), bluetoothDenied: res?.bluetoothDenied };
  } catch (err) {
    console.warn('[audioRoute] setDevice failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** Read back the device actually active right now. */
export async function audioRouteGetCurrentDevice(): Promise<AudioRouteResult> {
  if (!isNative()) return { ok: false, error: 'No native audio route on web.' };
  try {
    const res = await AudioRoute.getCurrentDevice();
    return { ok: true, device: asDevice(res?.device), bluetoothDenied: res?.bluetoothDenied };
  } catch (err) {
    console.warn('[audioRoute] getCurrentDevice failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/**
 * Request BLUETOOTH_CONNECT at runtime (Android 12+). Returns
 * { granted: false } when the user denies — the call still works on
 * earpiece/speaker; callers must show the honest reason, not silence.
 */
export async function audioRouteEnsureBluetoothPermission(): Promise<{ granted: boolean; notNeeded?: boolean; error?: string }> {
  if (!isNative()) return { granted: false, error: 'Bluetooth permission only applies in the Android app.' };
  try {
    return await AudioRoute.ensureBluetoothPermission();
  } catch (err) {
    console.warn('[audioRoute] ensureBluetoothPermission failed:', err);
    return { granted: false, error: errMessage(err) };
  }
}

export async function audioRouteStop(): Promise<AudioRouteResult> {
  if (!isNative()) return { ok: true };
  try {
    await AudioRoute.stop();
    return { ok: true };
  } catch (err) {
    console.warn('[audioRoute] stop failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** Mid-call device changes from the native side (headset plugged/unplugged). */
export async function audioRouteOnChange(cb: (e: AudioRouteResult) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  try {
    const handle = await AudioRoute.addListener('audioRouteChanged', (e) => {
      cb({ ok: true, device: asDevice(e?.device), bluetoothDenied: e?.bluetoothDenied });
    });
    return () => {
      try {
        handle.remove();
      } catch (err) {
        console.warn('[audioRoute] removing audioRouteChanged listener failed:', err);
      }
    };
  } catch (err) {
    console.warn('[audioRoute] audioRouteChanged listener failed:', err);
    return () => {};
  }
}

// ── Web output routing (#18) ──────────────────────────────────────────
// The web has no native AudioManager; the only real output switch is
// setSinkId (Chrome/Edge). Firefox/Safari do not support it — that is
// reported honestly instead of faking a switch.

export function webAudioOutputSupported(): boolean {
  try {
    return typeof HTMLMediaElement !== 'undefined'
      && typeof (HTMLMediaElement.prototype as any).setSinkId === 'function';
  } catch {
    return false;
  }
}

/** Web audio outputs via enumerateDevices (labels need mic permission first). */
export async function getWebAudioOutputs(): Promise<AudioRouteResult> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { ok: false, error: 'This browser cannot list audio outputs.' };
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outputs = all.filter((d) => d.kind === 'audiooutput');
    const devices: AudioDevice[] = outputs.map((d, i) => ({
      id: d.deviceId || `web-output-${i}`,
      kind: i === 0 ? 'speaker' : 'unknown',
      name: d.label || (i === 0 ? 'Default output' : `Output ${i + 1}`),
    }));
    if (devices.length === 0) {
      return { ok: false, error: 'No audio outputs found.' };
    }
    return { ok: true, devices };
  } catch (err) {
    console.warn('[audioRoute] enumerateDevices failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** Web audio inputs (for mic selection, #19) — labels need mic permission first. */
export async function getWebAudioInputs(): Promise<AudioDevice[]> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, kind: 'unknown' as AudioDeviceKind, name: d.label || `Microphone ${i + 1}` }))
      .filter((d) => d.id);
  } catch (err) {
    console.warn('[audioRoute] enumerateDevices (inputs) failed:', err);
    return [];
  }
}

/**
 * Route a media element (the remote-call <audio>) to a web output device.
 * Returns ok:false with a reason when setSinkId is unsupported — the
 * caller shows that instead of pretending the output changed.
 */
export async function applyWebSinkId(el: HTMLMediaElement | null | undefined, deviceId: string | null | undefined): Promise<AudioRouteResult> {
  if (!el) return { ok: false, error: 'No audio element to route.' };
  if (!deviceId || deviceId === 'default') {
    // 'default' = the browser's default output; nothing to set.
    return { ok: true, device: { id: 'default', kind: 'speaker', name: 'Default output' } };
  }
  const setSinkId = (el as any).setSinkId;
  if (typeof setSinkId !== 'function') {
    return { ok: false, error: 'This browser cannot switch audio output (setSinkId is not supported here). Use the Android app, or change the output in your system settings.' };
  }
  try {
    await setSinkId.call(el, deviceId);
    return { ok: true, device: { id: deviceId, kind: 'unknown', name: '' } };
  } catch (err) {
    console.warn('[audioRoute] setSinkId failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** Route a web AudioContext (ringtone) to an output device where supported. */
export async function applyWebSinkIdToContext(ctx: AudioContext | null | undefined, deviceId: string | null | undefined): Promise<AudioRouteResult> {
  if (!ctx) return { ok: false, error: 'No audio context to route.' };
  if (!deviceId || deviceId === 'default') return { ok: true };
  const setSinkId = (ctx as any).setSinkId;
  if (typeof setSinkId !== 'function') {
    return { ok: false, error: 'This browser cannot route the ringtone to a different output.' };
  }
  try {
    await setSinkId.call(ctx, deviceId);
    return { ok: true };
  } catch (err) {
    console.warn('[audioRoute] AudioContext.setSinkId failed:', err);
    return { ok: false, error: errMessage(err) };
  }
}

/** Route to a web output device by id (used when the native plugin is absent). */
export async function setWebAudioOutput(deviceId: string): Promise<AudioRouteResult> {
  if (!webAudioOutputSupported()) {
    return { ok: false, error: 'This browser cannot switch audio output (setSinkId is not supported here). Use the Android app, or change the output in your system settings.' };
  }
  // The element lives in CallModal; the service applies the sink to the
  // remote <audio> via applyWebSinkId and to the ringtone context via
  // applyWebSinkIdToContext. Remember the choice so both can use it.
  try {
    localStorage.setItem('dt_call_web_output', deviceId);
  } catch (err) {
    console.warn('[audioRoute] could not remember web output choice:', err);
  }
  return { ok: true, device: { id: deviceId, kind: 'unknown', name: '' } };
}

export function getStoredWebOutputId(): string | null {
  try {
    return localStorage.getItem('dt_call_web_output');
  } catch {
    return null;
  }
}
