import React, { useState, useEffect } from 'react';
import { X, MapPin, LocateFixed, User, Phone } from 'lucide-react';
import {
  getCurrentPosition,
  geolocationErrorMessage,
  isValidLatLng,
  type LatLng,
} from '../services/locationSharing';
import { LIVE_LOCATION_DURATIONS, type LiveLocationDuration } from '../services/liveLocation';
import { avatarFallback } from '../utils/avatar';

/** Escape closes a bottom sheet. Shared by both modals in this file. */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

/* ── Location modal ─────────────────────────────────────────────── */

export interface LocationPayload extends LatLng {
  /** Optional label, e.g. a place name. */
  label?: string;
}

interface LocationModalProps {
  onClose: () => void;
  onSend: (payload: LocationPayload) => void;
  /**
   * W27 live location: when provided, the modal also offers a live share
   * (duration picker + "Share live location" button). The caller owns the
   * session (first fix, message doc, ticks, stop) — the modal only picks
   * the duration. Omitted → static-only modal (old callers unchanged).
   */
  onSendLive?: (duration: LiveLocationDuration) => void;
}

export function LocationShareModal({ onClose, onSend, onSendLive }: LocationModalProps) {
  useEscapeToClose(onClose);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [coords, setCoords] = useState<LatLng | null>(null);
  const [latInput, setLatInput] = useState('');
  const [lngInput, setLngInput] = useState('');
  const [label, setLabel] = useState('');
  const [liveDuration, setLiveDuration] = useState<LiveLocationDuration>('1h');

  const useCurrentLocation = async () => {
    setLocating(true);
    setError('');
    try {
      const pos = await getCurrentPosition();
      setCoords(pos);
      setLatInput(String(pos.latitude));
      setLngInput(String(pos.longitude));
    } catch (err) {
      setError(geolocationErrorMessage(err));
    } finally {
      setLocating(false);
    }
  };

  const manualLat = parseFloat(latInput);
  const manualLng = parseFloat(lngInput);
  const manualValid = isValidLatLng(manualLat, manualLng);
  const canSend = !!coords || manualValid;

  const handleSend = () => {
    if (coords) {
      onSend({ ...coords, label: label.trim() || undefined });
    } else if (manualValid) {
      onSend({ latitude: manualLat, longitude: manualLng, label: label.trim() || undefined });
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-end" onClick={onClose} role="dialog" aria-modal="true" aria-label="Share location">
      <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-bold">📍 Share Location</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <button
          onClick={useCurrentLocation}
          disabled={locating}
          className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green disabled:opacity-60 transition-all flex items-center justify-center gap-2"
        >
          <LocateFixed className="h-5 w-5" />
          {locating ? 'Getting your location…' : coords ? 'Refresh my location' : 'Use my current location'}
        </button>

        {coords && (
          <p className="text-xs text-center text-gray-500 dark:text-text-secondary">
            📍 {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
            {typeof coords.accuracy === 'number' ? ` (±${Math.round(coords.accuracy)} m)` : ''}
          </p>
        )}
        {error && (
          <p className="text-xs text-center text-red-500 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}

        <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide pt-1">
          Or enter coordinates manually
        </p>
        <div className="flex gap-2">
          <input
            type="number"
            step="any"
            value={latInput}
            onChange={e => { setLatInput(e.target.value); setCoords(null); }}
            placeholder="Latitude (e.g. 28.6139)"
            className="flex-1 min-w-0 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
          />
          <input
            type="number"
            step="any"
            value={lngInput}
            onChange={e => { setLngInput(e.target.value); setCoords(null); }}
            placeholder="Longitude (e.g. 77.2090)"
            className="flex-1 min-w-0 bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
          />
        </div>
        {latInput && lngInput && !manualValid && (
          <p className="text-xs text-red-500">Latitude must be −90…90 and longitude −180…180.</p>
        )}

        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Label (optional, e.g. Home, Office)"
          maxLength={80}
          className="w-full bg-gray-100 dark:bg-input-dark rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
        />

        <button
          onClick={handleSend}
          disabled={!canSend}
          className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green disabled:opacity-40 transition-all flex items-center justify-center gap-2"
        >
          <MapPin className="h-4 w-4" /> Send Location 📍
        </button>

        {/* W27 — Live location: same sheet, separate action (WhatsApp
            pattern). The caller takes the first fix and owns the session;
            this only picks the duration. */}
        {onSendLive && (
          <>
            <div className="flex items-center gap-3 pt-2">
              <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
              <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">
                Or share live location
              </p>
              <div className="flex-1 h-px bg-gray-200 dark:bg-white/10" />
            </div>
            <p className="text-xs text-center text-gray-500 dark:text-text-secondary">
              Your location updates in the chat until the time runs out or you stop it.
            </p>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Live location duration">
              {LIVE_LOCATION_DURATIONS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="radio"
                  aria-checked={liveDuration === d.id}
                  onClick={() => setLiveDuration(d.id)}
                  className={`py-2.5 rounded-xl text-sm font-semibold transition-all ${
                    liveDuration === d.id
                      ? 'bg-green-cta text-white'
                      : 'bg-gray-100 dark:bg-input-dark text-gray-700 dark:text-text-primary hover:bg-gray-200 dark:hover:bg-panel-dark'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => onSendLive(liveDuration)}
              className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green transition-all flex items-center justify-center gap-2"
            >
              <LocateFixed className="h-4 w-4" /> Share live location 📍
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Contact modal ──────────────────────────────────────────────── */

export interface ContactPayload {
  name: string;
  phone: string;
  avatar?: string;
  /** #89: uid of the picked APP user (from the quick-pick list). Present
   *  only when the contact was picked from app users — never guessed from
   *  a phone number. Manually typed contacts carry no uid and their cards
   *  get no Message button. */
  contactUid?: string;
}

interface ContactModalProps {
  /** App users (ChatScreen's `contactsList`) for quick-pick; may be empty. */
  contacts?: any[];
  onClose: () => void;
  onSend: (payload: ContactPayload) => void;
}

export function ContactShareModal({ contacts = [], onClose, onSend }: ContactModalProps) {
  useEscapeToClose(onClose);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pickedAvatar, setPickedAvatar] = useState('');
  // #89: uid of the app user picked from the list ('' = manual entry).
  const [pickedUid, setPickedUid] = useState('');

  const pickContact = (c: any) => {
    setName(c.displayName || c.username || '');
    // App users may not expose a phone number; leave the field editable.
    setPhone(c.phone || c.phoneNumber || '');
    setPickedAvatar(c.photoURL || '');
    // #89: carry the picked app-user's uid into the payload so the
    // shared card (and its saved copy) can open a DM with them.
    // Phone-only contacts carry no uid and get no button. Read `uid`
    // ONLY — manual entries carry a synthetic `id` (React key) that
    // must never become a contactUid (W27f, 100M-W27d-1).
    setPickedUid(c.uid || '');
  };

  // Editing the picked details by hand unlinks the app user — the typed
  // contact may no longer be that person, so never keep a stale uid.
  const onNameChange = (v: string) => { setName(v); setPickedUid(''); };
  const onPhoneChange = (v: string) => { setPhone(v); setPickedUid(''); };

  const canSend = name.trim().length > 0 && phone.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-end" onClick={onClose} role="dialog" aria-modal="true" aria-label="Share contact">
      <div className="w-full bg-panel-light dark:bg-panel-dark rounded-t-2xl p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-1">
          <h3 className="text-lg font-bold">Share Contact</h3>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-input-dark" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        {contacts.length > 0 && (
          <>
            <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide">From your chats</p>
            <div className="max-h-44 overflow-y-auto divide-y divide-gray-100 dark:divide-white/5 -mx-1 px-1">
              {contacts.map((c: any) => (
                <button
                  key={c.id || c.uid}
                  type="button"
                  onClick={() => pickContact(c)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-input-dark text-left transition-colors"
                >
                  <img
                    src={c.photoURL || avatarFallback(c.displayName || c.username || 'User', c.id || c.uid)}
                    alt=""
                    className="h-10 w-10 rounded-full object-cover"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate text-gray-900 dark:text-text-primary">{c.displayName || c.username}</p>
                    <p className="text-xs text-gray-400 truncate">@{c.username || 'user'}</p>
                  </div>
                  <span className="text-xs font-semibold text-primary-green">Select</span>
                </button>
              ))}
            </div>
            <p className="text-xs font-semibold text-gray-500 dark:text-text-secondary uppercase tracking-wide pt-1">
              Or enter manually
            </p>
          </>
        )}

        <div className="relative">
          <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            autoFocus={contacts.length === 0}
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder="Name"
            maxLength={80}
            className="w-full bg-gray-100 dark:bg-input-dark rounded-xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
          />
        </div>
        <div className="relative">
          <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="tel"
            value={phone}
            onChange={e => onPhoneChange(e.target.value)}
            placeholder="Phone number (e.g. +91 00000 00000)"
            maxLength={20}
            className="w-full bg-gray-100 dark:bg-input-dark rounded-xl pl-10 pr-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary-green text-gray-900 dark:text-text-primary"
          />
        </div>
        {pickedUid && (
          <p className="text-xs text-center text-primary-green">✓ App user selected — the shared card will have a Message button.</p>
        )}
        {/* 100M-C3: Send is disabled until both name and phone are set —
            say so instead of leaving a greyed button with no explanation. */}
        {name.trim().length > 0 && phone.trim().length === 0 && (
          <p className="text-xs text-center text-amber-600 dark:text-amber-400">
            {pickedUid
              ? 'This app user has no phone number — type one above to share this contact.'
              : 'Enter a phone number to send this contact.'}
          </p>
        )}

        <button
          onClick={() => canSend && onSend({ name: name.trim(), phone: phone.trim(), avatar: pickedAvatar || undefined, ...(pickedUid ? { contactUid: pickedUid } : {}) })}
          disabled={!canSend}
          className="w-full py-3 bg-green-cta text-white rounded-xl font-semibold hover:bg-dark-green disabled:opacity-40 transition-all"
        >
          Send Contact 👤
        </button>
      </div>
    </div>
  );
}
