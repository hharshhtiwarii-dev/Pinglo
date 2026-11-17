import React from 'react';
import { MapPin, Navigation, Copy, Check, Square } from 'lucide-react';
import { googleMapsUrl, formatCoords } from '../services/locationSharing';
import {
  isLiveLocationActive,
  formatLiveRemaining,
  osmEmbedUrl,
  type LiveLocationMessageData,
} from '../services/liveLocation';

interface Props {
  data: LiveLocationMessageData;
  /** Bubble ownership — own messages are dark green, others are light. */
  isMine: boolean;
  onToast?: (msg: string) => void;
  /**
   * Shown only while this live share is active AND I am the sharer.
   * The receiver never gets a stop button.
   */
  onStopSharing?: () => void;
  /**
   * False for saved copies: a saved live-location message is a snapshot —
   * its ticks never flow to the copy, so it must never render as "Live".
   * Default true (chat view).
   */
  live?: boolean;
}

function updatedAgo(updatedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 8) return 'updated just now';
  if (s < 60) return `updated ${s}s ago`;
  const m = Math.floor(s / 60);
  return m === 1 ? 'updated 1 min ago' : `updated ${m} min ago`;
}

/**
 * Renders a `type: 'live-location'` message.
 *
 * Active shares show a live OSM map (no API key), a pulsing "Live · X min
 * left" label that ticks every 30 s, and — for the sharer only — a Stop
 * button. Ended / expired shares show the last known position with
 * "Live location ended" and the time of the last update. Offline the map
 * iframe stays empty, but the coordinates + Google Maps link still work
 * (same fallback pattern as LocationMessageCard).
 *
 * Coordinates are plaintext on the message doc, exactly like static
 * `type: 'location'` messages — live location is not E2EE-encrypted.
 */
export default function LiveLocationCard({ data, isMine, onToast, onStopSharing, live = true }: Props) {
  const [copied, setCopied] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const { latitude, longitude, locationAccuracy, liveLocationExpiresAt, liveLocationUpdatedAt, liveLocationActive } = data;

  const hasCoords =
    typeof latitude === 'number' && typeof longitude === 'number' &&
    Number.isFinite(latitude) && Number.isFinite(longitude);

  const active = live && hasCoords && isLiveLocationActive(
    { liveLocationActive: !!liveLocationActive, liveLocationExpiresAt: liveLocationExpiresAt || 0 },
    now,
  );

  // Tick the "X min left" label while the share is live. The interval
  // dies with the card (unmount) and never starts for ended shares.
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [active]);

  const copyCoords = async () => {
    const text = formatCoords(latitude, longitude);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Android WebViews often refuse the async clipboard API.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    setCopied(true);
    onToast?.('Coordinates copied ✓');
    setTimeout(() => setCopied(false), 2000);
  };

  if (!hasCoords) {
    return (
      <div className="flex items-center gap-2 py-1 text-sm opacity-70">
        <MapPin className="h-4 w-4 flex-shrink-0" />
        <span>Live location unavailable</span>
      </div>
    );
  }

  return (
    <div className="min-w-[220px] max-w-xs">
      {/* Live status line */}
      <div className="flex items-center gap-2 mb-1.5">
        {active ? (
          <>
            <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
            <span className="text-xs font-bold text-green-600 dark:text-green-400">
              {formatLiveRemaining(liveLocationExpiresAt || 0, now)}
            </span>
          </>
        ) : (
          <>
            <span className="h-2.5 w-2.5 rounded-full bg-gray-400 flex-shrink-0" />
            <span className="text-xs font-semibold text-gray-500 dark:text-text-secondary">
              Live location ended
            </span>
          </>
        )}
      </div>

      {/* Map: OSM embed, no key. Offline it stays blank — the coords +
          Google Maps link below still work. */}
      <div className="block rounded-lg overflow-hidden mb-1.5 border border-black/10 dark:border-white/10">
        <iframe
          title="Live location map"
          src={osmEmbedUrl(latitude, longitude)}
          className="h-36 w-full border-0 block"
          loading="lazy"
        />
      </div>

      <div className="flex items-start gap-2">
        <Navigation className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary-green" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug break-words">
            {active ? 'Sharing live location' : 'Live location'}
          </p>
          <p className={`text-xs ${isMine ? 'text-green-100/80' : 'text-gray-500 dark:text-text-secondary'}`}>
            {formatCoords(latitude, longitude)}
            {typeof locationAccuracy === 'number' ? ` · ±${Math.round(locationAccuracy)} m` : ''}
          </p>
          <p className={`text-[11px] ${isMine ? 'text-green-100/70' : 'text-gray-400 dark:text-text-secondary'}`}>
            {active
              ? updatedAgo(liveLocationUpdatedAt || Date.now(), now)
              : liveLocationUpdatedAt
                ? `Last update ${new Date(liveLocationUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : 'Last known position'}
          </p>
        </div>
        <button
          type="button"
          onClick={copyCoords}
          className="p-1.5 rounded-full hover:bg-black/10 dark:hover:bg-white/10 flex-shrink-0"
          title="Copy coordinates"
        >
          {copied ? <Check className="h-4 w-4 text-primary-green" /> : <Copy className="h-4 w-4 opacity-70" />}
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-3">
        <a
          href={googleMapsUrl(latitude, longitude)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary-green hover:underline"
        >
          <MapPin className="h-3.5 w-3.5" /> Open in Google Maps
        </a>
        {active && onStopSharing && (
          <button
            type="button"
            onClick={onStopSharing}
            className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 hover:underline"
          >
            <Square className="h-3 w-3 fill-red-500" /> Stop sharing
          </button>
        )}
      </div>
    </div>
  );
}
