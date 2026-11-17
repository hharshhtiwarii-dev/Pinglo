import React from 'react';
import { Phone, User, MessageCircle, Download, Check } from 'lucide-react';

export interface ContactMessageData {
  contactName: string;
  contactPhone: string;
  /** Optional avatar URL (e.g. when sharing an app user). */
  contactAvatar?: string;
}

interface Props {
  data: ContactMessageData;
  /** Bubble ownership — only used for subtle text-colour tweaks. */
  isMine: boolean;
  /** Optional: open a 1:1 chat with this person (e.g. when the contact is an app user). */
  onMessage?: () => void;
  onToast?: (msg: string) => void;
}

/**
 * Renders a `type: 'contact'` message as a contact card.
 * Tap the phone number to call (tel: link). "Save contact" downloads a
 * .vcf vCard the phone's contacts app can import — no native Contacts
 * plugin or permission is required.
 */
export default function ContactMessageCard({ data, isMine, onMessage, onToast }: Props) {
  const [saved, setSaved] = React.useState(false);
  const { contactName, contactPhone, contactAvatar } = data;
  const name = (contactName || '').trim() || 'Unknown contact';
  const phone = (contactPhone || '').trim();
  const initial = name.charAt(0).toUpperCase() || '?';

  const saveVCard = () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${name}`,
      phone ? `TEL;TYPE=CELL:${phone}` : '',
      'END:VCARD',
    ].filter(Boolean).join('\r\n');
    try {
      const blob = new Blob([vcard], { type: 'text/vcard;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.vcf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSaved(true);
      onToast?.('Contact file downloaded — open it to save ✓');
      setTimeout(() => setSaved(false), 2500);
    } catch {
      onToast?.('Could not save contact');
    }
  };

  return (
    <div className="min-w-[220px] max-w-xs">
      <div className="flex items-center gap-3 py-1">
        {contactAvatar ? (
          <img
            src={contactAvatar}
            alt={name}
            className="h-12 w-12 rounded-full object-cover flex-shrink-0 ring-1 ring-black/10 dark:ring-white/10"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="h-12 w-12 rounded-full bg-green-cta text-white flex items-center justify-center text-xl font-bold flex-shrink-0">
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug break-words flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
            {name}
          </p>
          {phone ? (
            <a
              href={`tel:${phone.replace(/[\s()-]/g, '')}`}
              className={`text-xs break-all hover:underline ${isMine ? 'text-green-100/90' : 'text-primary-green'}`}
            >
              {phone}
            </a>
          ) : (
            <p className="text-xs opacity-60">No phone number</p>
          )}
        </div>
      </div>

      <div className="flex gap-2 mt-2">
        {phone && (
          <a
            href={`tel:${phone.replace(/[\s()-]/g, '')}`}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary-green/15 text-primary-green text-xs font-semibold hover:bg-primary-green/25 transition-colors"
          >
            <Phone className="h-3.5 w-3.5" /> Call
          </a>
        )}
        {onMessage && (
          <button
            type="button"
            onClick={onMessage}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary-green/15 text-primary-green text-xs font-semibold hover:bg-primary-green/25 transition-colors"
          >
            <MessageCircle className="h-3.5 w-3.5" /> Message
          </button>
        )}
        <button
          type="button"
          onClick={saveVCard}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/10 text-xs font-semibold hover:bg-black/10 dark:hover:bg-white/15 transition-colors"
        >
          {saved ? <Check className="h-3.5 w-3.5 text-primary-green" /> : <Download className="h-3.5 w-3.5" />}
          {saved ? 'Saved' : 'Save contact'}
        </button>
      </div>
    </div>
  );
}
