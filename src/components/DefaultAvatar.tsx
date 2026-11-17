import { useState } from 'react';
import { avatarColor, initialsFor } from '../utils/avatar';

interface DefaultAvatarProps {
  /** Display name — initials are derived from this. */
  name: string;
  /** Stable seed for the deterministic colour (uid / chat id). Defaults to name. */
  seed?: string;
  /** Real photo URL. When present the photo is shown; otherwise initials. */
  photoURL?: string | null;
  /** Diameter in px. Default 48 (list rows). Sizing comes from here, not from h-/w- classes. */
  size?: number;
  /** Extra classes on the outer circle: ring, border, cursor, grayscale… */
  className?: string;
  /** WhatsApp-style presence dot (ChatList rows). */
  presence?: 'online' | 'offline';
  /** Accessible label. Defaults to name. */
  alt?: string;
  onClick?: () => void;
}

/**
 * WhatsApp-style default avatar: the user's initials on a deterministic
 * colour (hash of uid/name, via utils/avatar), instead of a stock photo.
 *
 * Replaces every `avatarFallback(...)` data-URI `<img>` in the chat / calls /
 * status screens. The data-URI helper still exists for places that genuinely
 * need an <img> src, but a real element is better here: it scales cleanly,
 * supports a presence dot and a ring, and never issues a network request.
 * No stock-photo service or any other external image is used anywhere.
 */
export default function DefaultAvatar({
  name,
  seed,
  photoURL,
  size = 48,
  className = '',
  presence,
  alt,
  onClick,
}: DefaultAvatarProps) {
  const label = alt ?? name;
  const clickable = typeof onClick === 'function';
  // Phase 5 (integration): if a real photo URL 404s, fall back to initials
  // instead of showing a broken image.
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = !!photoURL && !photoFailed;

  return (
    <div
      className={`relative shrink-0 rounded-full ${className}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? label : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {showPhoto ? (
        <img
          src={photoURL}
          alt={label}
          className="h-full w-full rounded-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <div
          role="img"
          aria-label={label}
          title={name}
          className="flex h-full w-full select-none items-center justify-center rounded-full font-semibold text-white"
          style={{
            backgroundColor: avatarColor(seed || name),
            fontSize: Math.max(12, Math.round(size * 0.38)),
          }}
        >
          {initialsFor(name)}
        </div>
      )}
      {presence && (
        <span
          aria-hidden="true"
          className={`absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full border-2 border-bg-light dark:border-bg-dark ${
            presence === 'online' ? 'bg-primary-green' : 'bg-gray-400 dark:bg-gray-600'
          }`}
        />
      )}
    </div>
  );
}
