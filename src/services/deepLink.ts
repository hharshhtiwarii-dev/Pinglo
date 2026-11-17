/**
 * QR deep-link handling (Cluster C, Item 15a) — AUDIT-2 B17 rework.
 *
 * Formats (all parsed by parseDeepLink, all routed by routeDeepLink):
 *   pinglo://user/<uid>                          → open the DM with that user  (/chat/<uid>)
 *   pinglo://group/<id>                          → open that group chat        (/chat/<id>)
 *   pinglo://chat/<id>?type=community&inv=<tok>  → invite link (same as https form)
 *   pinglo://call/<uid>?t=<token>                → call link
 *   https://dtchats.app/chat/<id>?type=community&inv=<tok>[&join=1]
 *                                                  → invite link (built by
 *                                                    buildInviteLink in groupAdmin.ts)
 *   https://dtchats.app/call/<uid>?t=<token>       → call link
 *   https://dtchats.app/user/<uid> | /group/<id>  → profile / group link
 *
 * B17 — what was broken: invite links were built from
 * window.location.origin (https://localhost on Android/Capacitor), and
 * the parser below had NO matcher for the /chat/<id>?type=community&inv=
 * shape at all, so a generated link pasted back into the app routed
 * nowhere. Both are fixed here: the builder uses the canonical
 * https://dtchats.app host and the parser matches the exact shape it
 * generates (plus the pinglo:// twin).
 *
 * Native handling: @capacitor/app IS installed, so on Android/iOS the
 * `appUrlOpen` listener below fires when the OS delivers a pinglo://
 * link to the app — the AndroidManifest now declares the VIEW
 * intent-filters (pinglo:// scheme + https://dtchats.app App Link,
 * autoVerify). One server-side piece remains: dtchats.app must host
 * .well-known/assetlinks.json or Android will not verify the App Link
 * and https links open in the browser instead (backend follow-up, see
 * BACKEND-PLAN.md — do NOT fake it). Web fallback: a shared link opened
 * in the browser as `/?link=pinglo://user/<uid>` (or `#link=...`) is
 * picked up on load and routed the same way.
 */

import { App } from '@capacitor/app';

export type DeepLink =
  | { kind: 'user'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'invite'; id: string; token?: string; join?: boolean }
  | { kind: 'call'; id: string; token?: string };

/** Pull ?inv= / ?join= / ?t= out of a query string (no URL constructor — the input may be a bare scheme URL). */
function queryParam(query: string | undefined, name: string): string | undefined {
  if (!query) return undefined;
  for (const part of query.split('&')) {
    const [k, v] = part.split('=');
    if (k === name && v !== undefined) {
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return undefined;
}

export function parseDeepLink(raw: string | null | undefined): DeepLink | null {
  if (!raw) return null;
  const text = raw.trim();
  // pinglo://user/<uid> or pinglo://group/<id>
  let m = text.match(/^pinglo:\/\/(user|group)\/([A-Za-z0-9._\-~%]+)/);
  if (m) return { kind: m[1] as 'user' | 'group', id: decodeURIComponent(m[2]) };
  // pinglo://chat/<id>?type=community&inv=<token>[&join=1] — invite link.
  m = text.match(/^pinglo:\/\/chat\/([A-Za-z0-9._\-~%]+)(?:\?(.*))?$/);
  if (m) {
    return {
      kind: 'invite',
      id: decodeURIComponent(m[1]),
      token: queryParam(m[2], 'inv'),
      join: queryParam(m[2], 'join') === '1',
    };
  }
  // pinglo://call/<uid>?t=<token> — call link.
  m = text.match(/^pinglo:\/\/call\/([A-Za-z0-9._\-~%]+)(?:\?(.*))?$/);
  if (m) return { kind: 'call', id: decodeURIComponent(m[1]), token: queryParam(m[2], 't') };
  // https://dtchats.app/chat/<id>?type=community&inv=<token>[&join=1] — invite link.
  m = text.match(/^https?:\/\/dtchats\.app\/chat\/([A-Za-z0-9._\-~%]+)(?:\?(.*))?$/);
  if (m) {
    return {
      kind: 'invite',
      id: decodeURIComponent(m[1]),
      token: queryParam(m[2], 'inv'),
      join: queryParam(m[2], 'join') === '1',
    };
  }
  // Web form of a call link (also covers a pasted https link).
  m = text.match(/^https?:\/\/dtchats\.app\/call\/([A-Za-z0-9._\-~%]+)(?:\?.*)?$/);
  if (m) {
    let token: string | undefined;
    try { token = new URL(text).searchParams.get('t') || undefined; } catch (err) { console.warn("[deepLink] parseDeepLink: token = new URL(text).searchParams.get('t') || unde...", err); }
    return { kind: 'call', id: decodeURIComponent(m[1]), token };
  }
  // Web form of a profile/group link.
  m = text.match(/^https?:\/\/dtchats\.app\/(user|group)\/([A-Za-z0-9._\-~%]+)/);
  if (m) return { kind: m[1] as 'user' | 'group', id: decodeURIComponent(m[2]) };
  return null;
}

/** Route a parsed link with react-router's navigate. Returns true when routed. */
export function routeDeepLink(link: DeepLink, navigate: (path: string) => void): boolean {
  if (link.kind === 'user' || link.kind === 'group') {
    navigate(`/chat/${link.id}`);
    return true;
  }
  if (link.kind === 'invite') {
    // ChatScreen consumes exactly this shape: ?type=community gates the
    // group join flow, ?inv= is validated against the stored token, and
    // ?join=1 auto-joins (approval-aware). Preserve all three.
    const q = `?type=community${link.token ? `&inv=${encodeURIComponent(link.token)}` : ''}${link.join ? '&join=1' : ''}`;
    navigate(`/chat/${link.id}${q}`);
    return true;
  }
  if (link.kind === 'call') {
    navigate(`/call/${link.id}${link.token ? `?t=${link.token}` : ''}`);
    return true;
  }
  return false;
}

/**
 * Register the app-start deep-link listeners. Call once, inside the Router
 * (it needs `navigate`). Handles:
 *  1. Capacitor `appUrlOpen` (native pinglo:// links, once the native
 *     intent-filter/URL-scheme is declared — see header note).
 *  2. Web `?link=pinglo://...` / `#link=pinglo://...` on first load.
 * Returns a cleanup function.
 */
export function registerDeepLinkListener(navigate: (path: string) => void): () => void {
  let removeNative: (() => void) | undefined;
  try {
    const maybeHandle: any = App.addListener('appUrlOpen', (event: { url: string }) => {
      const link = parseDeepLink(event?.url);
      if (link) routeDeepLink(link, navigate);
    });
    if (maybeHandle && typeof maybeHandle.then === 'function') {
      maybeHandle.then((h: any) => { removeNative = () => { try { void h.remove(); } catch (err) { console.warn("[deepLink] registerDeepLinkListener: void h.remove() failed", err); } }; }).catch((err) => console.warn("[deepLink] registerDeepLinkListener: remove(...) failed", err));
    } else if (maybeHandle && typeof maybeHandle.remove === 'function') {
      removeNative = () => { try { void maybeHandle.remove(); } catch (err) { console.warn("[deepLink] registerDeepLinkListener: void maybeHandle.remove() failed", err); } };
    }
  } catch (err) {
    console.warn("[deepLink] registerDeepLinkListener: const maybeHandle: any = App.addListener...", err);
  }

  // Web fallback: ?link= / #link= on load.
  try {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const raw = params.get('link') || hash.get('link');
    const link = parseDeepLink(raw);
    if (link) {
      routeDeepLink(link, navigate);
      // Clean the param so a refresh doesn't re-route.
      try {
        const u = new URL(window.location.href);
        u.searchParams.delete('link');
        window.history.replaceState(null, '', u.pathname + u.search);
      } catch (err) {
        console.warn("[deepLink] registerDeepLinkListener: const u = new URL(window.location.href) ...", err);
      }
    }
  } catch (err) {
    console.warn("[deepLink] registerDeepLinkListener: const params = new URLSearchParams(windo...", err);
  }

  return () => { try { removeNative?.(); } catch (err) { console.warn("[deepLink] registerDeepLinkListener: removeNative?.() failed", err); } };
}
