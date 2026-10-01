import { useState } from 'react';
import { api, type ContactKind, type MarketSummary, type Offer, type OfferSide } from '../api';
import { ContactFields, ContactReveal } from '../components/Contact';
import { Flap } from '../components/Flap';
import { EmptyState } from '../components/EmptyState';
import { useApp } from '../context';
import { plural, relativeDate } from '../format';
import { IconCoins } from '../icons';
import { askerKey, loadContact, saveContact } from '../store';

export interface OffersData {
  offers: Offer[];
  mine: Offer[];
  market: MarketSummary;
}

export function expiresIn(iso: string): string {
  const hours = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3_600_000));
  return hours < 24 ? `${hours} h left` : `${Math.round(hours / 24)} d left`;
}

/** Offers to sell or buy Falcons: the board up top, then the order book, cheapest sell and best buy first, each order with its depth behind it. */
export function FalconsTab({ data, onClose, onPost }: { data: OffersData; onClose(offer: Offer, remove: boolean): void; onPost(side: OfferSide): void }) {
  const mineIds = new Set(data.mine.map((offer) => offer.id));
  const selling = data.offers.filter((offer) => offer.side === 'sell').sort((a, b) => a.rate - b.rate || b.amount - a.amount);
  const buying = data.offers.filter((offer) => offer.side === 'buy').sort((a, b) => b.rate - a.rate || b.amount - a.amount);
  const { market } = data;
  const deepest = Math.max(1, ...data.offers.map((offer) => offer.amount));

  if (data.offers.length === 0) {
    return (
      <EmptyState icon={<IconCoins />} title="No open offers" text="Post how many Falcons you have or want, and at what rate. People reach you directly.">
        <button type="button" className="btn" onClick={() => onPost('buy')}>
          Buy Falcons
        </button>
        <button type="button" className="btn primary" onClick={() => onPost('sell')}>
          Sell Falcons
        </button>
      </EmptyState>
    );
  }

  return (
    <>
      <div className="ticker">
        <div>
          <b>
            <Flap text={market.bestAsk === null ? '–' : market.bestAsk.toFixed(2)} />
          </b>
          <span>Cheapest sell, AED per Falcon</span>
        </div>
        <div>
          <b>
            <Flap text={market.bestBid === null ? '–' : market.bestBid.toFixed(2)} />
          </b>
          <span>Best buy, AED per Falcon</span>
        </div>
        <p className="ticker-note">
          <span>{plural(market.open, 'open offer')}</span>
          <span>{market.volume.toLocaleString()} Falcons on offer</span>
        </p>
      </div>
      <div className="book">
        <OfferColumn side="sell" title="Selling" hint="cheapest first" offers={selling} deepest={deepest} mineIds={mineIds} onClose={onClose} />
        <OfferColumn side="buy" title="Buying" hint="best rate first" offers={buying} deepest={deepest} mineIds={mineIds} onClose={onClose} />
      </div>
      <p className="market-note">The trade happens between the two of you, on campus. Offers expire after five days.</p>
    </>
  );
}

function OfferColumn({ side, title, hint, offers, deepest, mineIds, onClose }: { side: OfferSide; title: string; hint: string; offers: Offer[]; deepest: number; mineIds: Set<string>; onClose(offer: Offer, remove: boolean): void }) {
  return (
    <section className={`book-side ${side}`}>
      <h2>
        {title}
        <span>{offers.length ? `${plural(offers.length, 'offer')}, ${hint}` : ''}</span>
      </h2>
      {offers.length === 0 ? (
        <div className="empty small">Nothing here yet.</div>
      ) : (
        <div className="list">
          {offers.map((offer) => (
            <OfferRow key={offer.id} offer={offer} depth={(offer.amount / deepest) * 100} mine={mineIds.has(offer.id)} onClose={onClose} />
          ))}
        </div>
      )}
    </section>
  );
}

function OfferRow({ offer, depth, mine, onClose }: { offer: Offer; depth: number; mine: boolean; onClose(offer: Offer, remove: boolean): void }) {
  return (
    <div className="order">
      <div className="order-main">
        <span className="rate">
          {offer.rate.toFixed(2)}
          <small>AED</small>
        </span>
        <span className="total">{Math.round(offer.amount * offer.rate).toLocaleString()} AED in all</span>
      </div>
      <div className="qty">
        <i style={{ '--depth': `${depth.toFixed(1)}%` } as React.CSSProperties} aria-hidden="true" />
        {offer.amount.toLocaleString()} Falcons
      </div>
      {offer.note && <div className="note">{offer.note}</div>}
      <div className="meta">
        <span>{offer.posterName}</span>
        <span>{relativeDate(offer.createdAt)}</span>
        <span>{expiresIn(offer.expiresAt)}</span>
        {mine && (
          <span className="pill tone-line">
            <span className="dot" /> Yours
          </span>
        )}
      </div>
      <div className="order-actions">
        {mine ? (
          <>
            <button type="button" className="btn sm" onClick={() => onClose(offer, false)}>
              Mark done
            </button>
            <button type="button" className="btn sm ghost" onClick={() => onClose(offer, true)}>
              Remove
            </button>
          </>
        ) : (
          <ContactReveal kind={offer.contactKind} contact={offer.contact} about={`${offer.amount} Falcons at ${offer.rate.toFixed(2)}`} />
        )}
      </div>
    </div>
  );
}

export function FalconCompose({ side, market, onDone, onCancel }: { side: OfferSide; market: MarketSummary | null; onDone(): void; onCancel(): void }) {
  const { profile } = useApp();
  const suggested = (side === 'sell' ? market?.bestBid : market?.bestAsk) ?? market?.medianRate ?? 0.8;
  const saved = loadContact();
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(suggested.toFixed(2));
  const [contactKind, setContactKind] = useState<ContactKind>(saved.contactKind);
  const [contact, setContact] = useState(saved.contact);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const total = Number(amount) > 0 && Number(rate) > 0 ? Math.round(Number(amount) * Number(rate)) : 0;

  const submit = async () => {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      await api.board.offer({ netId: profile.netId, key: askerKey(), side, amount: Number(amount), rate: Number(rate), contactKind, contact: contact.trim(), note: note.trim() || undefined });
      saveContact({ contactKind, contact: contact.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the offer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="of-amount">{side === 'sell' ? 'Falcons to sell' : 'Falcons wanted'}</label>
          <div className="input-group">
            <input id="of-amount" className="input" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ''))} placeholder="500" />
            <span className="suffix">Falcons</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="of-rate">Rate</label>
          <div className="input-group">
            <input id="of-rate" className="input" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value.replace(/[^\d.]/g, ''))} placeholder="0.85" />
            <span className="suffix">AED each</span>
          </div>
          <span className="hint">{total > 0 ? `${total.toLocaleString()} AED in total.` : ' '}</span>
        </div>
      </div>
      <ContactFields kind={contactKind} contact={contact} onKind={setContactKind} onContact={setContact} />
      <div className="field">
        <label htmlFor="of-note">Note (optional)</label>
        <input id="of-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Pay by transfer, meet at D2" />
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !amount || !rate || contact.trim().length < 3}>
          {busy ? 'Posting' : 'Post'}
        </button>
      </div>
    </div>
  );
}
