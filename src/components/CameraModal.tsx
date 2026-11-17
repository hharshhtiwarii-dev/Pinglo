import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Video, Zap, ZapOff, SwitchCamera, Image as ImageIcon } from 'lucide-react';

/**
 * In-app camera viewfinder (Cluster C, Item 13b).
 *
 * Live getUserMedia preview (rear camera by default on mobile), photo
 * capture via canvas snapshot, short video recording via MediaRecorder
 * (max 60s, same cap as round videos). Flash/torch toggle is shown ONLY
 * when the active video track reports a `torch` capability — otherwise it
 * is hidden, never a dead button. Front/rear switch is offered when the
 * device reports more than one video input.
 *
 * Graceful degradation: no camera / permission denied / getUserMedia
 * missing → an inline error state with "Choose from gallery" (calls
 * onFallback, the caller's file picker) instead of a blank modal.
 * Nothing here touches the existing OS-picker camera input; ChatScreen
 * keeps it as the fallback path.
 */

interface CameraModalProps {
  open: boolean;
  onClose: () => void;
  /** Photo captured in the viewfinder (JPEG file). */
  onPhoto: (file: File) => void;
  /** Video recorded in the viewfinder (webm/mp4 file). */
  onVideo: (file: File, durationSecs: number) => void;
  /** User chose the gallery fallback (or camera is unavailable). */
  onFallback: () => void;
}

const MAX_VIDEO_SECS = 60;

export default function CameraModal({ open, onClose, onPhoto, onVideo, onFallback }: CameraModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const secsRef = useRef(0);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [multiCamera, setMultiCamera] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [busy, setBusy] = useState(false);

  const stopStream = () => {
    try { if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop(); } catch { /* intentionally ignored */}
    recorderRef.current = null;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsRecording(false);
    setRecSecs(0);
    secsRef.current = 0;
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError('');
    setStarting(true);
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This device/browser has no in-app camera. Use the gallery instead.');
        setStarting(false);
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
        if (!cancelled) setMultiCamera(devices.filter((d) => d.kind === 'videoinput').length > 1);
      } catch { /* intentionally ignored */}
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        try {
          const caps = (track?.getCapabilities?.() || {}) as MediaTrackCapabilities & { torch?: boolean };
          setTorchSupported(!!caps.torch);
        } catch { setTorchSupported(false); }
        setTimeout(() => {
          if (videoRef.current && !cancelled) videoRef.current.srcObject = stream;
        }, 30);
        setStarting(false);
      } catch {
        if (!cancelled) {
          setError('Camera could not be opened — permission denied or no camera on this device.');
          setStarting(false);
        }
      }
    })();
    return () => { cancelled = true; stopStream(); };
  }, [open, facing]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch { /* intentionally ignored */}
  };

  const takePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        setBusy(false);
        if (!blob) return;
        const file = new File([blob], `camera_${Date.now()}.jpg`, { type: 'image/jpeg' });
        stopStream();
        onPhoto(file);
      }, 'image/jpeg', 0.9);
    } catch { setBusy(false); }
  };

  const pickMime = (): string | undefined => {
    for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* intentionally ignored */}
    }
    return undefined;
  };

  const startVideo = () => {
    const stream = streamRef.current;
    if (!stream || isRecording) return;
    chunksRef.current = [];
    const mime = pickMime();
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'video/webm' });
      const secs = secsRef.current;
      if (blob.size) {
        const ext = (mr.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `camera_video_${Date.now()}.${ext}`, { type: blob.type || 'video/webm' });
        stopStream();
        onVideo(file, secs);
      }
    };
    recorderRef.current = mr;
    mr.start(500);
    secsRef.current = 0;
    setRecSecs(0);
    setIsRecording(true);
    timerRef.current = setInterval(() => {
      secsRef.current += 1;
      setRecSecs(secsRef.current);
      if (secsRef.current >= MAX_VIDEO_SECS) stopVideo();
    }, 1000);
  };

  const stopVideo = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setIsRecording(false);
    try { recorderRef.current?.stop(); } catch { /* intentionally ignored */}
  };

  if (!open) return null;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 z-[80] bg-black flex flex-col" role="dialog" aria-modal="true" aria-label="Camera">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button onClick={() => { stopStream(); onClose(); }} className="p-2 rounded-full hover:bg-white/10" aria-label="Close camera">
          <X className="h-6 w-6" />
        </button>
        <span className="text-sm font-medium">{isRecording ? `● Recording ${fmt(recSecs)} / ${fmt(MAX_VIDEO_SECS)}` : 'Camera'}</span>
        <div className="flex items-center gap-1">
          {torchSupported && (
            <button onClick={toggleTorch} className={`p-2 rounded-full ${torchOn ? 'bg-yellow-400/20 text-yellow-300' : 'hover:bg-white/10'}`} aria-label={torchOn ? 'Turn flash off' : 'Turn flash on'} aria-pressed={torchOn} title="Flash">
              {torchOn ? <Zap className="h-5 w-5" /> : <ZapOff className="h-5 w-5" />}
            </button>
          )}
          {multiCamera && !isRecording && (
            <button onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))} className="p-2 rounded-full hover:bg-white/10" aria-label="Switch camera" title="Switch camera">
              <SwitchCamera className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
        {error ? (
          <div className="px-8 text-center text-white/80">
            <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm leading-relaxed">{error}</p>
            <button
              onClick={() => { stopStream(); onFallback(); }}
              className="mt-5 flex items-center gap-2 mx-auto px-5 py-2.5 bg-green-cta text-white rounded-full text-sm font-semibold"
            >
              <ImageIcon className="h-4 w-4" /> Choose from gallery instead
            </button>
          </div>
        ) : starting ? (
          <div className="flex flex-col items-center gap-2 text-white/70">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white border-t-transparent" />
            <p className="text-sm">Starting camera…</p>
          </div>
        ) : (
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        )}
        {isRecording && (
          <span className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-red-600 text-white text-xs font-semibold px-3 py-1 rounded-full">
            <span className="h-2 w-2 rounded-full bg-white animate-pulse" /> {fmt(recSecs)}
          </span>
        )}
      </div>

      {!error && !starting && (
        <div className="flex items-center justify-center gap-10 py-5 bg-black">
          <button
            onClick={takePhoto}
            disabled={isRecording || busy}
            className="h-16 w-16 rounded-full border-4 border-white bg-white/10 flex items-center justify-center text-white disabled:opacity-40"
            aria-label="Take photo"
            title="Take photo"
          >
            <Camera className="h-7 w-7" />
          </button>
          <button
            onClick={isRecording ? stopVideo : startVideo}
            disabled={busy}
            className={`h-16 w-16 rounded-full border-4 flex items-center justify-center text-white disabled:opacity-40 ${isRecording ? 'border-red-500 bg-red-500/30' : 'border-white bg-white/10'}`}
            aria-label={isRecording ? 'Stop recording' : 'Record video'}
            title={isRecording ? 'Stop recording' : 'Record video (up to 60s)'}
          >
            <Video className="h-7 w-7" />
          </button>
        </div>
      )}
    </div>
  );
}
