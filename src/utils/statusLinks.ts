/**
 * Status link sticker / @mention helpers (nightshift: status-link).
 *
 * SECURITY (critical): only `https:` URLs are ever tappable. Anything
 * else — `http:`, `javascript:`, `data:`, `intent:`, bare schemes, or
 * unparseable input — normalises to `null` and, if it ever reaches a
 * stored doc, renders as plain text. The viewer re-checks with
 * `isSafeHttpsUrl` at render time (defence in depth: never trust the
 * stored value, an older client or a hand-written doc could hold any
 * scheme). No `href` in this codebase is built from an unvalidated URL.
 *
 * Pure functions — no DOM, no Firestore — so they are the first
 * candidates for unit tests when a runner lands (tdd-guide).
 */

/** True only for a parseable URL whose protocol is exactly `https:`. */
export function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalise raw composer input to a tappable https URL, or `null`.
 * - `https://example.com` → as-is.
 * - `example.com/path` (bare domain, no scheme) → `https://example.com/path`.
 * - `http://…`, `javascript:…`, `data:…`, `ftp:…`, `//evil` → `null`.
 */
export function normalizeStatusLink(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  if (/^https:\/\//i.test(raw)) {
    return isSafeHttpsUrl(raw) ? raw : null;
  }
  // Any other explicit scheme is rejected — never auto-upgrade http:.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return null;
  // Bare domain: must look like host[/path] with a dot in the host.
  const candidate = `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname.includes('.')) return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Host label for the link-sticker chip (`example.com`). */
export function linkHostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface StatusMention {
  uid: string;
  username: string;
  displayName: string;
}

/** Split status text into plain / https-link / @mention segments. */
export type StatusTextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; url: string }
  | { kind: 'mention'; text: string; username: string };

export function parseStatusText(text: string): StatusTextSegment[] {
  if (!text) return [];
  const parts = text.split(/(https:\/\/[^\s]+|@[A-Za-z0-9_]+)/g);
  return parts
    .filter((p) => p.length > 0)
    .map((p) => {
      if (/^https:\/\//.test(p) && isSafeHttpsUrl(p)) return { kind: 'link', text: p, url: p } as const;
      if (/^@[A-Za-z0-9_]+$/.test(p)) return { kind: 'mention', text: p, username: p.slice(1) } as const;
      return { kind: 'text', text: p } as const;
    });
}
