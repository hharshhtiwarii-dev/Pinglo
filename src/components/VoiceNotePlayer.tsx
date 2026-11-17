import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Play, Pause, Download, Upload, Check, Loader2 } from 'lucide-react';
import { getWaveformPeaks, WAVEFORM_BARS } from '../services/waveform';
import { saveRemoteFile } from '../services/fileSave';
import { resolveLocalMediaUrl, isLocalMediaUrl } from '../aws/storage';

interface VoiceNotePlayerProps {
  url: string;
  duration?: number;
  isMine?: boolean;
  /** Real peaks captured at record time (getWaveformPeaks, stored on the message). */
  waveform?: number[];
  /** #220: id of the message/status owning this note — seeds the fallback
   *  bars so two old notes never share one identical pattern. */
  seed?: string;
  /** View-once voice: fired when playback ends, so the bubble can flip
   *  to "opened" (a view-once note plays exactly once). */
  onEnded?: () => void;
  /** WA parity Media V11: re-upload / retry-upload handler for this
   *  note's audio. When absent (e.g. the recording preview, which is
   *  not uploaded yet) the Upload button is not rendered. */
  onUpload?: () => void | Promise<void>;
  /** True while an upload retry is in flight — the Upload button spins. */
  uploading?: boolean;
  /** WA parity Media V11: hide the Download button (view-once voice
   *  must not be downloadable — it plays once, then disappears).
   *  Defaults to true. */
  allowDownload?: boolean;
}

/** #220: deterministic per-note fallback bars (FNV-1a + xorshift). Old
 *  notes without stored peaks used to share ONE identical pattern; seeding
 *  from the message id gives every note its own stable shape. Heights
 *  match the old fallback's display range (6–20px). */
function seededFallbackBars(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  // WA parity (V8): same bar count as stored peaks (WAVEFORM_BARS = 32),
  // so an old note without stored peaks renders the same width as a new one.
  return Array.from({ length: WAVEFORM_BARS }, () => 6 + Math.floor(next() * 15));
}

export default function VoiceNotePlayer({ url, duration = 0, isMine = false, waveform, seed, onEnded: onEndedProp, onUpload, uploading = false, allowDownload = true }: VoiceNotePlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(duration);
  const [playbackSpeed, setPlaybackSpeed] = useState<1 | 1.5 | 2>(1);
  // WA parity Media V11: transient download state for the Download button.
  const [downloadState, setDownloadState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Real waveform peaks when available, otherwise null (fallback bars below).
  const [peaks, setPeaks] = useState<number[] | null>(null);
  // 100M-H6: a `local-media:<id>` url is a reference into the IndexedDB
  // blob store (storage.ts), not something <audio> can play — resolve it
  // to a blob: URL first. S3 / data: URLs pass through unchanged.
  // The object URL is revoked when the url changes or the player unmounts.
  // A local ref starts with NO src (never the raw reference — that would
  // fire an audio error event and a wasted fetch); a plain URL starts
  // with itself, and a ref keeps the previous playable URL until its
  // blob resolves, so playback never points at an unplayable value.
  const [playableUrl, setPlayableUrl] = useState(() => (isLocalMediaUrl(url) ? '' : url));
  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    if (!isLocalMediaUrl(url)) {
      setPlayableUrl(url);
      return;
    }
    resolveLocalMediaUrl(url)
      .then((resolved) => {
        if (!alive) {
          URL.revokeObjectURL(resolved);
          return;
        }
        objectUrl = resolved;
        setPlayableUrl(resolved);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setTotalDuration(Math.round(audio.duration));
      }
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      onEndedProp?.();
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, []);

  // ── Phase 4: real waveform ──
  // Prefer peaks stored on the message (captured at record time). For older
  // notes without stored peaks, decode the audio URL in the background;
  // any failure (CORS, decode error, abort) keeps the fallback bars.
  useEffect(() => {
    const stored = (waveform || []).filter((n) => Number.isFinite(n));
    if (stored.length > 0) {
      setPeaks(stored);
      return;
    }
    let alive = true;
    const ctrl = new AbortController();
    // No playable URL yet (local ref still resolving) — nothing to decode.
    if (!playableUrl) return;
    // 100M-H6: decode the RESOLVED url — fetching a `local-media:<id>`
    // reference would fail; the blob: URL (or S3 / data: URL) decodes.
    fetch(playableUrl, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('fetch failed'))))
      .then((blob) => getWaveformPeaks(blob))
      .then((p) => {
        if (alive && p.length > 0) setPeaks(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [playableUrl, waveform]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const cycleSpeed = () => {
    const audio = audioRef.current;
    const nextSpeed = playbackSpeed === 1 ? 1.5 : playbackSpeed === 1.5 ? 2 : 1;
    setPlaybackSpeed(nextSpeed);
    if (audio) audio.playbackRate = nextSpeed;
  };

  // WA parity Media V11 — "Download voice message"
  // (`testid: ptt_audio_download`): saves this note's audio. Uses the
  // resolved playable URL, so `local-media:` refs download too.
  const handleDownload = async () => {
    if (!playableUrl || downloadState === 'saving') return;
    setDownloadState('saving');
    const ok = await saveRemoteFile(playableUrl, `voice-message-${seed || 'note'}.webm`);
    setDownloadState(ok ? 'saved' : 'failed');
    window.setTimeout(() => setDownloadState('idle'), 2500);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !totalDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const newTime = ratio * totalDuration;
    audio.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const fmt = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const progressPct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  // Phase 4: real peaks (0..1) when available, else the old fallback bars.
  // Peak heights: 4px minimum so silence is still visible, up to 20px.
  // WA parity (V8): 32 bars here too, matching WAVEFORM_BARS / stored peaks.
  const FALLBACK_BARS = [4, 7, 3, 9, 6, 8, 4, 10, 5, 8, 3, 7, 9, 5, 8, 4, 10, 6, 3, 7, 5, 8, 4, 6, 9, 5, 7, 4, 8, 6, 10, 5];
  // #220: the fallback is seeded per note (see `seed`) instead of one
  // shared constant — two undecodable old notes no longer look identical.
  const fallbackBars = useMemo(
    () => (seed ? seededFallbackBars(seed) : FALLBACK_BARS.map((h) => h * 2)),
    [seed],
  );
  const barHeights: number[] =
    peaks && peaks.length > 0 ? peaks.map((p) => 4 + Math.round(Math.max(0, Math.min(1, p)) * 16)) : fallbackBars;

  return (
    <div className="flex items-center gap-2.5 py-1 px-1 min-w-[210px] select-none">
      <audio ref={audioRef} src={playableUrl} preload="metadata" />

      {/* Circular Play / Pause Button */}
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? 'Pause voice note' : 'Play voice note'}
        className={`h-11 w-11 min-h-[44px] min-w-[44px] rounded-full flex items-center justify-center flex-shrink-0 transition-transform active:scale-90 shadow-sm ${
          isMine ? 'bg-white text-dark-green' : 'bg-green-cta text-white'
        }`}
      >
        {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current ml-0.5" />}
      </button>

      {/* Waveform Scrubber & Timer */}
      <div className="flex-1 flex flex-col gap-1 min-w-0">
        <div
          className="relative h-5 flex items-center gap-[2.5px] cursor-pointer"
          onClick={handleSeek}
          role="slider"
          tabIndex={0}
          aria-label="Voice note progress slider"
          aria-valuemin={0}
          aria-valuemax={totalDuration || 0}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${fmt(currentTime)}/${fmt(totalDuration || duration)}`}
          onKeyDown={(e) => {
            const audio = audioRef.current;
            if (!audio || !totalDuration) return;
            if (e.key === 'ArrowRight') { audio.currentTime = Math.min(totalDuration, audio.currentTime + 5); setCurrentTime(audio.currentTime); }
            if (e.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - 5); setCurrentTime(audio.currentTime); }
          }}
        >
          {/* WA parity (V8): bar colours are WA's --ptt-waveform-* tokens
              (wa-client CSS): outgoing played #99beb7/#728977, unplayed
              #b0ceae/#4d8d81; incoming played #a6abad/#858a8d, unplayed
              #ced0d1/#636b70 (light/dark). */}
          {barHeights.map((h, i) => {
            // WA parity (V8): strict `<` — with `<=`, bar 0 (barPos 0)
            // rendered in the PLAYED colour at 0% progress (probe:
            // unplayed bars read as #a6abad/#99beb7 before any play).
            const barPos = (i / barHeights.length) * 100;
            const isFilled = barPos < progressPct;
            return (
              <div
                key={i}
                style={{ height: `${h}px` }}
                className={`w-[3px] rounded-full transition-colors ${
                  isFilled
                    ? isMine ? 'bg-[#99beb7] dark:bg-[#728977]' : 'bg-[#a6abad] dark:bg-[#858a8d]'
                    : isMine ? 'bg-[#b0ceae] dark:bg-[#4d8d81]' : 'bg-[#ced0d1] dark:bg-[#636b70]'
                }`}
              />
            );
          })}
          {/* WA parity (V8): progress thumb — WA defines --ptt-thumb-*
              tokens: played #53bdeb/#4fc3f7 (both sides); unplayed
              outgoing #d1d7db/#6f8171, incoming #09d261. The thumb turns
              blue once any of the note has played (progressPct > 0). */}
          <span
            data-voice-thumb
            aria-hidden="true"
            style={{ left: `${progressPct}%` }}
            className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full shadow pointer-events-none ${
              progressPct > 0
                ? 'bg-[#53bdeb] dark:bg-[#4fc3f7]'
                : isMine ? 'bg-[#d1d7db] dark:bg-[#6f8171]' : 'bg-[#09d261]'
            }`}
          />
        </div>

        {/* Timers & Speed */}
        <div className="flex justify-between items-center text-[10px] font-mono opacity-80 leading-none">
          {/* WA parity (V13): show the paused position, not the total — the
              timer only falls back to the total when nothing has played yet.
              onEnded resets currentTime to 0, so the total returns then. */}
          <span>{fmt(currentTime > 0 || isPlaying ? currentTime : (totalDuration || duration))}</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              // WA exact string: "Change playback speed, currently 1×" (1.5× / 2×).
              aria-label={`Change playback speed, currently ${playbackSpeed}×`}
              onClick={cycleSpeed}
              className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${
                isMine ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-black/10 dark:bg-white/10 hover:bg-black/20'
              }`}
            >
              {playbackSpeed}×
            </button>
            {/* WA parity Media V11: "Download voice message"
                (`testid: ptt_audio_download`) and "Upload voice message"
                (`testid: ptt_audio_upload`, retry-upload when the
                bubble passes `onUpload`). */}
            {allowDownload && (
              <button
                type="button"
                data-testid="ptt_audio_download"
                aria-label="Download voice message"
                title={downloadState === 'saved' ? 'Saved to Downloads ✓' : downloadState === 'failed' ? 'Could not save file — tap to retry' : 'Download voice message'}
                onClick={handleDownload}
                disabled={!playableUrl || downloadState === 'saving'}
                className={`h-6 w-6 rounded-full flex items-center justify-center ${
                  isMine ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-black/10 dark:bg-white/10 hover:bg-black/20'
                } ${downloadState === 'saved' ? 'text-green-500' : ''} ${downloadState === 'failed' ? 'text-red-400' : ''} disabled:opacity-40`}
              >
                {/* WA parity Media V11: the button shows its own state —
                    spinner while saving, ✓ when saved — because
                    saveRemoteFile reports no % (anchor download on web,
                    native bridge on device), so a % would be invented. */}
                {downloadState === 'saving' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : downloadState === 'saved' ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
              </button>
            )}
            {onUpload && (
              <button
                type="button"
                data-testid="ptt_audio_upload"
                aria-label="Upload voice message"
                title={uploading ? 'Uploading voice message…' : 'Upload voice message'}
                onClick={() => void onUpload()}
                disabled={uploading}
                className={`h-6 w-6 rounded-full flex items-center justify-center ${
                  isMine ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-black/10 dark:bg-white/10 hover:bg-black/20'
                } disabled:opacity-40`}
              >
                <Upload className={`h-3.5 w-3.5 ${uploading ? 'animate-pulse' : ''}`} />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
