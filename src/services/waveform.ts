/**
 * Waveform helper (Phase 3, Agent C).
 *
 * Captures REAL waveform peaks from a recorded voice-note blob at record
 * time (decoding with AudioContext) and encodes them as a small number
 * array — replacing the old 24 hardcoded bars. Screens should call
 * `getWaveformPeaks(blob)` right after MediaRecorder stops and store the
 * result on the message (`waveform: number[]`); VoiceNotePlayer can then
 * render the true shape instead of a fake one.
 *
 * Everything is best-effort: a decode failure resolves to [] (never throws),
 * so recording/sending can never break because the waveform failed.
 */

/** Number of peaks per voice note by default. Small enough to store on the message doc. */
export const WAVEFORM_BARS = 32;

/**
 * Decode an audio blob and return `bars` normalised peaks (0..1), one per
 * equal slice of the recording. Returns [] when decoding is unavailable
 * or fails.
 */
export async function getWaveformPeaks(blob: Blob, bars: number = WAVEFORM_BARS): Promise<number[]> {
  try {
    if (!blob || blob.size === 0 || bars <= 0) return [];
    const AudioContextClass =
      window.AudioContext ||
      (window as any).webkitAudioContext;
    if (!AudioContextClass) return [];
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = new AudioContextClass();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      return peaksFromAudioBuffer(audioBuffer, bars);
    } finally {
      try {
        await ctx.close();
      } catch { /* intentionally ignored */}
    }
  } catch {
    return [];
  }
}

/** Pure peak extraction from an already-decoded AudioBuffer (testable without a Blob). */
export function peaksFromAudioBuffer(buffer: AudioBuffer, bars: number = WAVEFORM_BARS): number[] {
  try {
    const channel = buffer.getChannelData(0);
    if (!channel || channel.length === 0 || bars <= 0) return [];
    const blockSize = Math.max(1, Math.floor(channel.length / bars));
    const peaks: number[] = [];
    let max = 0;
    for (let i = 0; i < bars; i++) {
      const start = i * blockSize;
      let peak = 0;
      for (let j = start; j < Math.min(start + blockSize, channel.length); j++) {
        const v = Math.abs(channel[j]);
        if (v > peak) peak = v;
      }
      peaks.push(peak);
      if (peak > max) max = peak;
    }
    if (max <= 0) return peaks.map(() => 0);
    return peaks.map((p) => Math.round((p / max) * 100) / 100);
  } catch {
    return [];
  }
}

/** Compact string encoding of peaks (e.g. for a query param / log). Round-trips via decodeWaveformPeaks. */
export function encodeWaveformPeaks(peaks: number[]): string {
  return (peaks || []).map((p) => Math.max(0, Math.min(1, Number(p) || 0)).toFixed(2)).join(',');
}

export function decodeWaveformPeaks(encoded: string): number[] {
  if (!encoded) return [];
  return encoded
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0, Math.min(1, n)));
}
