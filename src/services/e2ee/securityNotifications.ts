/**
 * Security notifications (Wave-2 C3, Settings #16b).
 *
 * WA's Account row reads "Security notifications, account info": when a
 * contact's security code changes — they reinstall, switch phones, or
 * reset their identity key — WA raises an alert so the user can
 * re-verify the safety number before trusting the chat again.
 *
 * The detection lives in `keyExchange.handleIncomingKeyExchange`, which
 * already computes `peerKeyChanged`; when the change is real and the
 * Settings → Account toggle is on, it records one alert here. This
 * module is the alert store: a capped localStorage list (newest first)
 * plus a `dt:security-code-changed` window event so any mounted screen
 * (Settings → Account) can refresh live. The record is per-device and
 * local-only — no server round-trip, no message contents.
 *
 * Alerts are raised only while the toggle is on (the hook gates on the
 * pref). Turning the toggle off stops future alerts; already-raised
 * alerts stay listed until dismissed — they already happened.
 */

export interface SecurityCodeChangeAlert {
  /** Conversation (DM) id whose peer key changed. */
  chatId: string;
  /** Uid of the peer whose identity key changed. */
  peerUid: string;
  /** Short fingerprint of the NEW peer key (16 hex chars). */
  peerKeyId: string;
  /** Client timestamp (ms) the change was detected. */
  at: number;
}

export const SECURITY_CODE_CHANGED_EVENT = 'dt:security-code-changed';
export const SECURITY_CODE_CHANGES_KEY = 'dt_security_code_changes';

/** Cap: only the most recent changes are kept (old ones age out). */
const MAX_ALERTS = 20;

/** Read the stored alerts, newest first. Never throws. */
export function listSecurityCodeChanges(): SecurityCodeChangeAlert[] {
  try {
    const raw = localStorage.getItem(SECURITY_CODE_CHANGES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (a): a is SecurityCodeChangeAlert =>
          !!a && typeof a === 'object' &&
          typeof (a as SecurityCodeChangeAlert).chatId === 'string' &&
          typeof (a as SecurityCodeChangeAlert).peerUid === 'string' &&
          typeof (a as SecurityCodeChangeAlert).at === 'number',
      )
      .slice(0, MAX_ALERTS);
  } catch {
    return [];
  }
}

/**
 * Record a peer security-code change. A repeat announce of the SAME new
 * key (re-delivery / second pass) refreshes the existing alert instead
 * of stacking a duplicate. Returns the recorded alert, or null when
 * storage is unavailable. Never throws — an alert must never break key
 * exchange.
 */
export function recordSecurityCodeChange(
  chatId: string,
  peerUid: string,
  peerKeyId: string,
): SecurityCodeChangeAlert | null {
  try {
    if (!chatId || !peerUid) return null;
    const alert: SecurityCodeChangeAlert = {
      chatId,
      peerUid,
      peerKeyId: peerKeyId || '',
      at: Date.now(),
    };
    const rest = listSecurityCodeChanges().filter(
      (a) => !(a.chatId === chatId && a.peerKeyId === alert.peerKeyId),
    );
    const next = [alert, ...rest].slice(0, MAX_ALERTS);
    localStorage.setItem(SECURITY_CODE_CHANGES_KEY, JSON.stringify(next));
    try {
      window.dispatchEvent(
        new CustomEvent<SecurityCodeChangeAlert>(SECURITY_CODE_CHANGED_EVENT, { detail: alert }),
      );
    } catch {
      // Non-DOM context (or a listener threw) — the stored alert stands.
    }
    return alert;
  } catch {
    return null;
  }
}

/** Dismiss one alert (by chat + key; without a key, all alerts for the chat). */
export function dismissSecurityCodeChange(chatId: string, peerKeyId?: string): void {
  try {
    const next = listSecurityCodeChanges().filter(
      (a) => !(a.chatId === chatId && (peerKeyId === undefined || a.peerKeyId === peerKeyId)),
    );
    localStorage.setItem(SECURITY_CODE_CHANGES_KEY, JSON.stringify(next));
  } catch {
    // Dismiss is best-effort; a stale alert is harmless.
  }
}

/** Clear all recorded alerts. */
export function clearSecurityCodeChanges(): void {
  try {
    localStorage.removeItem(SECURITY_CODE_CHANGES_KEY);
  } catch {
    // Best-effort.
  }
}
