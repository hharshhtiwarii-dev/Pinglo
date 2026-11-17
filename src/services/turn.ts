import { generateClient } from 'aws-amplify/api';
import { isAwsConfigured } from '../aws/config';

/**
 * Short-lived TURN credentials from the backend (Lambda behind AppSync).
 * Needed when a call has to relay through the server (strict NATs, mobile networks).
 * Falls back to STUN-only if the request fails.
 *
 * Worker C (phone-issues fix):
 * - The credential fetch is capped at 8 s: the old code awaited it with no
 *   timeout inside callService.init(), so a hung AppSync request delayed
 *   the call-signalling subscription indefinitely and incoming calls
 *   never rang.
 * - TCP/TLS variants are added for the same coturn host. The Lambda
 *   historically returns a bare `turn:<host>:3478` (UDP) URL; on many
 *   mobile carriers and public wifi UDP 3478 is blocked while TCP works
 *   (the host answers on TCP 3478 and TCP 5349 — probed 2026-11-14).
 *   Extra candidates are harmless: ICE tries each server and ignores
 *   the ones that fail, so a `turns:` entry that the server does not
 *   actually serve cannot break the UDP path.
 * - #3 (Report 3): TURN refresh path verified — expandTurnUrls() adds
 *   `turn:<host>:3478?transport=tcp` and `turns:<host>:5349?transport=tcp`
 *   for every bare UDP url, so a carrier blocking UDP 3478 still gets a
 *   TCP/TLS relay path. No port-443 variant is added: 443 was never
 *   probed/confirmed served by this coturn host, and inventing an
 *   unserved URL would only add a dead candidate (harmless but
 *   dishonest to claim as a fallback). The Lambda must return the bare
 *   UDP url; expansion happens client-side on every fetch.
 */
const TURN_QUERY = `query TurnCredentials {
  turnCredentials { username credential urls }
}`;

const TURN_FETCH_TIMEOUT_MS = 8_000;

/** Add `?transport=tcp` + `turns:` variants for a bare UDP TURN url (deduped). */
export function expandTurnUrls(urls: string[]): string[] {
  const out: string[] = [...urls];
  const seen = new Set(out);
  const add = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  for (const u of urls) {
    const m = /^turns?:([^:/?#]+)(?::(\d+))?/i.exec(u);
    if (!m) continue;
    const host = m[1];
    // Only expand plain UDP entries; never invent a different host.
    if (/^turn:/i.test(u) && !/[?&]transport=/i.test(u)) {
      add(`turn:${host}:3478?transport=tcp`);
    }
    add(`turns:${host}:5349?transport=tcp`);
  }
  return out;
}

/**
 * #5 — why the last TURN fetch produced no servers, or null when the
 * last fetch succeeded / was skipped (no backend in local/mock mode).
 * Read immediately after fetchTurnServers() resolves; a later fetch
 * overwrites it.
 */
let lastTurnError: string | null = null;
export function getLastTurnError(): string | null {
  return lastTurnError;
}

export async function fetchTurnServers(): Promise<RTCIceServer[]> {
  // RETEST-1: no backend in local mode — skip the AppSync call entirely
  // (generateClient() throws without Amplify config) and use STUN only.
  // This is NOT a failure: lastTurnError stays null so callers can tell
  // "no backend configured" apart from "backend fetch failed" (#5).
  if (!isAwsConfigured()) {
    lastTurnError = null;
    return [];
  }
  try {
    const fetchP = (async () => {
      const client: any = generateClient();
      const res: any = await client.graphql({ query: TURN_QUERY });
      return res?.data?.turnCredentials;
    })();
    const timeoutP = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), TURN_FETCH_TIMEOUT_MS),
    );
    const t = await Promise.race([fetchP, timeoutP]);
    if (!t) {
      // #5: an 8 s timeout used to read as "no TURN" with no trace.
      lastTurnError = `TURN credential fetch timed out after ${TURN_FETCH_TIMEOUT_MS / 1000}s`;
      console.warn('TURN credentials unavailable, using STUN only:', lastTurnError);
      return [];
    }
    if (!Array.isArray(t.urls) || t.urls.length === 0) {
      lastTurnError = 'TURN credential fetch returned no relay URLs';
      console.warn('TURN credentials unavailable, using STUN only:', lastTurnError);
      return [];
    }
    lastTurnError = null;
    return [{ urls: expandTurnUrls(t.urls), username: t.username, credential: t.credential }];
  } catch (e) {
    // #5: the fetch failure is recorded (not swallowed) so callService
    // can surface it at dial time instead of silently going STUN-only.
    lastTurnError = e instanceof Error ? e.message : String(e);
    console.warn('TURN credentials unavailable, using STUN only:', e);
    return [];
  }
}
