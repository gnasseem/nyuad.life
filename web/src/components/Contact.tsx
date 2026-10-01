import { useState } from 'react';
import type { ContactKind } from '../api';

export const CONTACTS: Array<{ id: ContactKind; label: string; placeholder: string }> = [
  { id: 'whatsapp', label: 'WhatsApp', placeholder: '+971 50 123 4567' },
  { id: 'instagram', label: 'Instagram', placeholder: '@handle' },
  { id: 'email', label: 'Email', placeholder: 'abc1234@nyu.edu' },
  { id: 'phone', label: 'Phone', placeholder: '+971 50 123 4567' },
];

export function contactLabel(kind: ContactKind): string {
  return CONTACTS.find((entry) => entry.id === kind)?.label ?? kind;
}

/** A link that opens the contact in its app, with a first message about what it is for. */
export function contactHref(kind: ContactKind, contact: string, about: string): string {
  const digits = contact.replace(/[^\d+]/g, '');
  switch (kind) {
    case 'whatsapp':
      return `https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(`Hi, about your post on nyuad.life: ${about}`)}`;
    case 'instagram':
      return `https://instagram.com/${contact.replace(/^@/, '')}`;
    case 'email':
      return `mailto:${contact}?subject=${encodeURIComponent(`Your post on nyuad.life: ${about}`)}`;
    case 'phone':
      return `tel:${digits}`;
  }
}

/** Contact details stay hidden until someone asks for them, so they are not scraped off the page in bulk. */
export function ContactReveal({ kind, contact, about }: { kind: ContactKind; contact: string; about: string }) {
  const [revealed, setRevealed] = useState(false);
  const label = contactLabel(kind);
  if (!revealed) {
    return (
      <button type="button" className="btn sm" onClick={() => setRevealed(true)}>
        Show {label}
      </button>
    );
  }
  return (
    <span className="reveal">
      <span className="contact">{contact}</span>
      <a className="btn sm primary" href={contactHref(kind, contact, about)} target="_blank" rel="noreferrer">
        Open {label}
      </a>
    </span>
  );
}

/** The "contact by" chips and the field under them, for any form that posts an offer or a listing. */
export function ContactFields({ kind, contact, onKind, onContact }: { kind: ContactKind; contact: string; onKind(kind: ContactKind): void; onContact(contact: string): void }) {
  const meta = CONTACTS.find((entry) => entry.id === kind)!;
  return (
    <div className="field">
      <label>Contact by</label>
      <div className="chips" role="radiogroup" aria-label="Contact method">
        {CONTACTS.map((entry) => (
          <button key={entry.id} type="button" role="radio" aria-checked={kind === entry.id} className={`chip${kind === entry.id ? ' on' : ''}`} onClick={() => onKind(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>
      <input
        className="input"
        value={contact}
        onChange={(event) => onContact(event.target.value)}
        placeholder={meta.placeholder}
        aria-label={meta.label}
        inputMode={kind === 'email' ? 'email' : kind === 'instagram' ? 'text' : 'tel'}
        autoComplete={kind === 'email' ? 'email' : kind === 'instagram' ? 'off' : 'tel'}
      />
    </div>
  );
}
