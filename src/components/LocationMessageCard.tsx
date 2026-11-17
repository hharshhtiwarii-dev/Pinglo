import React from 'react';
import { MapPin, Navigation, Copy, Check } from 'lucide-react';
import { googleMapsUrl, formatCoords } from '../services/locationSharing';
import { osmEmbedUrl } from '../services/liveLocation';

export interface LocationMessageData {
  latitude: number;
  longitude: number;
  /** Optional free-text label, e.g. "Home" or a place name. */
  locationLabel?: string;
  /** Accuracy in metres, when reported. */
  locationAccuracy?: number;
}

interface Props {
  data: LocationMessageData;
  /** Bubble ownership — own messages are dark green, others are light. */
  isMine: boolean;
  onToast?: (msg: string) => void;
}

/**
 * Renders a `type: 'location'` message as a map card.
 * Real map, no SDK / API key needed: an OpenStreetMap embed (same pattern
 * as LiveLocationCard) centred on the point, plus a Google Maps link-out,
 * and the coordinates shown (and copyable) as a plain-text fallback so the
 * message is still useful offline or when the embed cannot load.
 */
export default function LocationMessageCard({ data, isMine, onToast }: Props) {
  const [copied, setCopied] = React.useState(false);
  const { latitude, longitude, locationLabel, locationAccuracy } = data;
  const hasCoords =
    typeof latitude === 'number' && typeof longitude === 'number' &&
    Number.isFinite(latitude) && Number.isFinite(longitude);

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
        <span>Location unavailable</span>
      </div>
    );
  }

  return (
    <div className="min-w-[220px] max-w-xs">
      {/* Mini-map: real OSM embed, gradient backdrop while it loads.
          Offline the iframe stays empty — the coords + "Open in Maps"
          button below still work. */}
      <a
        href={googleMapsUrl(latitude, longitude)}
        target="_blank"
        rel="noreferrer"
        className="block rounded-lg overflow-hidden mb-1.5 border border-black/10 dark:border-white/10"
        title="Open in Google Maps"
      >
        <div className="relative h-28 bg-gradient-to-br from-[#a8d8a8] via-[#cfe8c9] to-[#8fbf8f] dark:from-[#1d3a2a] dark:via-[#24402e] dark:to-[#16281d]">
          {/* WA parity (verify dm-4 row 73): a real map (OSM embed, no
              API key — same helper as the live card), not the drawn
              gradient that used to be the whole preview. The gradient
              stays behind as the loading/offline backdrop. */}
          <iframe
            title="Location map"
            src={osmEmbedUrl(latitude, longitude)}
            className="absolute inset-0 h-full w-full border-0 block"
            loading="lazy"
          />
          <span className="absolute bottom-1.5 right-2 text-[10px] font-medium text-gray-600 dark:text-gray-300 bg-white/70 dark:bg-black/40 px-1.5 py-0.5 rounded">
            Google Maps ↗
          </span>
        </div>
      </a>

      <div className="flex items-start gap-2">
        <Navigation className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary-green" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug break-words">
            {locationLabel || 'Shared location'}
          </p>
          <p className={`text-xs ${isMine ? 'text-green-100/80' : 'text-gray-500 dark:text-text-secondary'}`}>
            {formatCoords(latitude, longitude)}
            {typeof locationAccuracy === 'number' ? ` · ±${Math.round(locationAccuracy)} m` : ''}
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

      {/* H25: the saved-location card used to show only a small "Open in
          Google Maps" text link, which the hunt probe (and users) could
          not find as a button. This is now a prominent full-width
          "Open in Maps" pill button (same href) — unmissable on the
          saved card and, because the card is shared, on the chat card
          too. The real OSM map preview sits above it. */}
      <a
        href={googleMapsUrl(latitude, longitude)}
        target="_blank"
        rel="noreferrer"
        aria-label="Open in Maps"
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#00A884] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#008069] active:bg-[#075E54]"
        title="Open in Maps"
      >
        <MapPin className="h-3.5 w-3.5" /> Open in Maps
      </a>
    </div>
  );
}
