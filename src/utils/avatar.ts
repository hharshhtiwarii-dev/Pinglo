/**
 * Avatar fallback — WhatsApp-style initials instead of a random stock photo.
 *
 * Previously every user without a profile photo got a random stock photo
 * from an external service, which looked unprofessional (a stranger's photo
 * for every contact). Now the fallback
 * is a deterministic local SVG data-URI: the contact's initials on a
 * colour derived from their id, so the same person always gets the same
 * colour and no network request is made.
 */

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function initialsFor(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Deterministic background colour for a seed (user/chat id). */
export function avatarColor(seed: string): string {
  const hue = hashSeed(seed || 'user') % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

/**
 * Local SVG data-URI avatar with initials. Safe to use anywhere an <img>
 * `src` is expected; no external request is made.
 */
export function avatarFallback(name: string, seed?: string, size = 200): string {
  const displayName = (name || '').trim() || 'User';
  const initials = initialsFor(displayName);
  const bg = avatarColor(seed || displayName);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="${bg}"/>` +
    `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(size * 0.38)}" font-weight="600" fill="#ffffff">${initials}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Real photo when present, otherwise the initials fallback. */
export function avatarSrc(photoURL: string | undefined | null, name: string, seed?: string): string {
  return photoURL || avatarFallback(name, seed);
}
