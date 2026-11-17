import React, { useRef, useState } from 'react';
import { Play, Volume2, VolumeX } from 'lucide-react';

/**
 * Round video message bubble (Phase 4, Agent A) — Telegram-style circle
 * video. Tap the circle to play / pause; the video loops while open.
 * `posterUrl` is the captured poster frame (see uploadVideoPoster); when
 * absent the video element shows its own first frame once metadata loads.
 *
 * WA parity (DM audit row 85): like WhatsApp's instant video, it plays
 * MUTED by default (speaker button toggles sound) and shows a progress
 * ring around the circle while playing.
 */

interface RoundVideoPlayerProps {
  url: string;
  posterUrl?: string | null;
  duration?: number;
  isMine?: boolean;
}

const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

export default function RoundVideoPlayer({ url, posterUrl, duration, isMine = false }: RoundVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // WA parity (DM audit row 85): instant video plays muted; the speaker
  // button unmutes. `progress` drives the ring around the circle.
  const [muted, setMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  // r=78 circle on the 160px box: C = 2*pi*78 ≈ 490.
  const RING_C = 490;

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play()
        .then(() => setPlaying(true))
        .catch(() => {});
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  return (
    <div
      className="relative mb-1 h-40 w-40 shrink-0 cursor-pointer select-none"
      onClick={toggle}
      role="button"
      tabIndex={0}
      aria-label={playing ? 'Pause round video' : 'Play round video'}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
    >
      <video
        ref={videoRef}
        src={url}
        poster={posterUrl || undefined}
        playsInline
        loop
        muted={muted}
        preload="metadata"
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          if (v.duration > 0) setProgress(v.currentTime / v.duration);
        }}
        className="h-40 w-40 rounded-full object-cover bg-black"
      />
      {/* Progress ring around the circle while playing. */}
      <svg className="absolute inset-0 h-40 w-40 -rotate-90 pointer-events-none" viewBox="0 0 160 160" aria-hidden>
        <circle cx="80" cy="80" r="78" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
        <circle cx="80" cy="80" r="78" fill="none" stroke="#25D366" strokeWidth="3" strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - progress)} />
      </svg>
      <button
        type="button"
        aria-label={muted ? 'Unmute round video' : 'Mute round video'}
        onClick={(e) => { e.stopPropagation(); setMuted((m) => !m); }}
        className="absolute bottom-1 right-1 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white"
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>
      {!playing && (
        <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30">
          <span
            className={`h-12 w-12 rounded-full flex items-center justify-center shadow ${
              isMine ? 'bg-white text-dark-green' : 'bg-green-cta text-white'
            }`}
          >
            <Play className="h-5 w-5 fill-current ml-0.5" />
          </span>
        </div>
      )}
      {typeof duration === 'number' && duration > 0 && (
        <span className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[10px] font-mono px-2 py-0.5 rounded-full">
          {fmtSecs(duration)}
        </span>
      )}
    </div>
  );
}
