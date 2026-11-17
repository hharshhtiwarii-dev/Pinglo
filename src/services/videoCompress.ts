/**
 * Client-side video compression (Cluster C, Item 13a).
 *
 * Real re-encoding, no native plugin, no new dependency:
 * the source file is played through a <video> element, its frames are
 * drawn to a downscaled <canvas> at 30fps, and the canvas stream
 * (plus the original audio track, taken from the video element's own
 * captureStream) is re-recorded with MediaRecorder at a lower bitrate.
 * The output is a genuine new video file (WebM/VP8 or MP4 where the
 * browser supports it) — NOT a canvas frame extraction and NOT a
 * re-upload of the original bytes.
 *
 * Honest limits:
 * - Output codec depends on the browser (Chrome: webm/vp8 or vp9;
 *   Safari: mp4 if supported). The file extension follows the mime type.
 * - Quality is bitrate/resolution-capped, not a perceptual encoder
 *   preset; a very long video takes roughly real-time to transcode
 *   (we play it through once). Progress is reported via onProgress.
 * - Throws when MediaRecorder / captureStream / canvas captureStream
 *   is unavailable, so callers can fall back to sending the original
 *   (HD) with a toast instead of silently sending an uncompressed file
 *   labelled "compressed".
 */

export interface CompressVideoOptions {
  /** Long-edge cap for the output (default 640). */
  maxDimension?: number;
  /** Target video bitrate in bits/sec (default 1,000,000 ≈ 1 Mbps). */
  videoBitsPerSecond?: number;
  /** Called with 0..1 progress while transcoding. */
  onProgress?: (p: number) => void;
  /** Hard wall-clock cap (default 120s); aborts with an error past it. */
  timeoutMs?: number;
}

function pickMime(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const m of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m;
    } catch (err) {
      console.warn("[videoCompress] pickMime: if (typeof MediaRecorder !== 'undefined' && MediaRe...", err);
    }
  }
  return undefined;
}

export async function compressVideoFile(file: File, opts: CompressVideoOptions = {}): Promise<File> {
  const maxDimension = opts.maxDimension ?? 640;
  const videoBitsPerSecond = opts.videoBitsPerSecond ?? 1_000_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Video compression is not supported in this browser (no MediaRecorder).');
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // #204: fail fast with a specific reason when this browser cannot decode
  // the container at all (e.g. headless Chromium ships no H.264, so an
  // MP4 can never load there) — instead of burning the 15s load timeout
  // and reporting a generic "compression failed". A phone-recorded file
  // in a supported container is unaffected.
  if (file.type) {
    try {
      if (video.canPlayType(file.type) === '') {
        throw new Error("This video format can't be played on this device, so it can't be compressed.");
      }
    } catch (e) {
      if (e instanceof Error && /can't be played/.test(e.message)) throw e;
      // canPlayType itself threw — fall through to the normal load path.
    }
  }
  const url = URL.createObjectURL(file);
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Video load timed out')), 15000);
      video.onloadedmetadata = () => { clearTimeout(t); resolve(); };
      video.onerror = () => { clearTimeout(t); reject(new Error('Could not read this video file.')); };
    });

    const srcW = video.videoWidth || 0;
    const srcH = video.videoHeight || 0;
    if (!srcW || !srcH || !video.duration || !isFinite(video.duration)) {
      throw new Error('Could not read this video file.');
    }
    const scale = Math.min(1, maxDimension / Math.max(srcW, srcH));
    const outW = Math.max(2, Math.round((srcW * scale) / 2) * 2);
    const outH = Math.max(2, Math.round((srcH * scale) / 2) * 2);

    // If the source is already at/below target size and short, a bitrate-only
    // re-encode still helps; we always re-encode (the caller asked for it).
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable in this browser.');
    const canvasStream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream?.(30);
    if (!canvasStream) throw new Error('Canvas capture is not supported in this browser.');

    // Keep the original audio: take it from the video element's own stream.
    let audioTrack: MediaStreamTrack | undefined;
    try {
      const vs = (video as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
      audioTrack = vs?.getAudioTracks?.()[0];
    } catch (err) {
      console.warn("[videoCompress] compressVideoFile: const vs = (video as HTMLVideoElement & { ...", err);
    }
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
    if (audioTrack) tracks.push(audioTrack);
    const outStream = new MediaStream(tracks);

    const mime = pickMime();
    const recorder = new MediaRecorder(outStream, {
      ...(mime ? { mimeType: mime } : {}),
      videoBitsPerSecond,
      audioBitsPerSecond: 96000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

    const done = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
      recorder.onerror = () => reject(new Error('Video compression failed while recording.'));
      setTimeout(() => {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (err) { console.warn("[videoCompress] compressVideoFile: if (recorder.state !== 'inactive') recorde...", err); }
        reject(new Error('Video compression timed out.'));
      }, timeoutMs);
    });

    recorder.start(500);
    // Play the source through once, drawing each frame to the canvas.
    const start = performance.now();
    const draw = () => {
      if (video.ended || video.paused) return;
      try { ctx.drawImage(video, 0, 0, outW, outH); } catch (err) { console.warn("[videoCompress] compressVideoFile: ctx.drawImage(video, 0, 0, outW, outH) failed", err); }
      opts.onProgress?.(Math.min(1, video.currentTime / video.duration));
      requestAnimationFrame(draw);
    };
    await video.play();
    draw();
    await new Promise<void>((resolve) => {
      video.onended = () => resolve();
      // Safety: if 'ended' never fires (odd container), resolve on timeupdate near the end.
      const iv = setInterval(() => {
        if (video.currentTime >= video.duration - 0.05) { clearInterval(iv); resolve(); }
      }, 200);
      video.onended = () => { clearInterval(iv); resolve(); };
    });
    try { video.pause(); } catch (err) { console.warn("[videoCompress] compressVideoFile: video.pause() failed", err); }
    if (recorder.state !== 'inactive') recorder.stop();
    const blob = await done;
    void start;
    if (!blob.size) throw new Error('Compressed video came out empty.');
    const ext = (recorder.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
    const base = file.name.replace(/\.[^.]+$/, '') || 'video';
    return new File([blob], `${base}_compressed.${ext}`, { type: blob.type || 'video/webm' });
  } finally {
    URL.revokeObjectURL(url);
    try { video.pause(); } catch (err) { console.warn("[videoCompress] compressVideoFile: video.pause() failed", err); }
    video.removeAttribute('src');
  }
}

/** Rough size check helper for the quality sheet: is this video big enough to bother compressing? */
export function videoLooksCompressible(file: File): boolean {
  return file.type.startsWith('video/') && file.size > 2 * 1024 * 1024;
}
