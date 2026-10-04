import { useState } from 'react';
import { api, type ContactKind, type MarketSummary, type Offer, type OfferCurrency, type OfferSide } from '../api';
import { ContactFields, ContactReveal } from '../components/Contact';
import { Flap } from '../components/Flap';
import { EmptyState } from '../components/EmptyState';
import { useApp } from '../context';
import { IconCoins } from '../icons';
import { askerKey, loadContact, saveContact } from '../store';

export interface OffersData {
  offers: Offer[];
  mine: Offer[];
  markets: Record<OfferCurrency, MarketSummary>;
}

/** What each currency is called, what it is, and the rate people usually ask, for an empty composer. */
export const CURRENCIES: Record<OfferCurrency, { name: string; one: string; short: string; about: string; typicalRate: number }> = {
  falcon: { name: 'Falcons', one: 'Falcon', short: 'Falcons', about: 'Falcon Dirhams: the Personal Support award, spent on campus.', typicalRate: 0.8 },
  campus: { name: 'Campus Dirhams', one: 'Campus Dirham', short: 'Campus Dh', about: 'Campus Dirhams: the meal-plan money for the Library Cafe, the Marketplace and other dining spots. A separate balance from Falcons.', typicalRate: 0.5 },
};

export function currencyOf(offer: Offer): OfferCurrency {
  return offer.currency ?? 'falcon';
}

/** One currency's offers: the board up top, then the order book, cheapest sell and best buy first, each with its depth behind it. */
export function OffersTab({ currency, data, onClose, onPost }: { currency: OfferCurrency; data: OffersData; onClose(offer: Offer, remove: boolean): void; onPost(side: OfferSide): void }) {
  const info = CURRENCIES[currency];
  const offers = data.offers.filter((offer) => currencyOf(offer) === currency);
  const mineIds = new Set(data.mine.map((offer) => offer.id));
  const selling = offers.filter((offer) => offer.side === 'sell').sort((a, b) => a.rate - b.rate || b.amount - a.amount);
  const buying = offers.filter((offer) => offer.side === 'buy').sort((a, b) => b.rate - a.rate || b.amount - a.amount);
  const market = data.markets[currency];
  const deepest = Math.max(1, ...offers.map((offer) => offer.amount));

  if (offers.length === 0) {
    return (
      <EmptyState icon={<IconCoins />} title="No offers yet" text={info.about}>
        <button type="button" className="btn" onClick={() => onPost('buy')}>
          Buy {info.name}
        </button>
        <button type="button" className="btn primary" onClick={() => onPost('sell')}>
          Sell {info.name}
        </button>
      </EmptyState>
    );
  }

  return (
    <>
      <p className="currency-note">{info.about}</p>
      <div className="ticker">
        <div className="sell">
          <b>
            <Flap text={market.bestAsk === null ? '–' : market.bestAsk.toFixed(2)} />
          </b>
          <span>Lowest sell, AED</span>
        </div>
        <div className="buy">
          <b>
            <Flap text={market.bestBid === null ? '–' : market.bestBid.toFixed(2)} />
          </b>
          <span>Highest buy, AED</span>
        </div>
      </div>
      <div className="book">
        <OfferColumn currency={currency} side="sell" title="Selling" offers={selling} deepest={deepest} mineIds={mineIds} onClose={onClose} />
        <OfferColumn currency={currency} side="buy" title="Buying" offers={buying} deepest={deepest} mineIds={mineIds} onClose={onClose} />
      </div>
    </>
  );
}

function OfferColumn({ currency, side, title, offers, deepest, mineIds, onClose }: { currency: OfferCurrency; side: OfferSide; title: string; offers: Offer[]; deepest: number; mineIds: Set<string>; onClose(offer: Offer, remove: boolean): void }) {
  return (
    <section className={`book-side ${side}`}>
      <h2>{title}</h2>
      {offers.length === 0 ? (
        <div className="empty small">None yet.</div>
      ) : (
        <div className="list">
          {offers.map((offer) => (
            <OfferRow key={offer.id} currency={currency} offer={offer} depth={(offer.amount / deepest) * 100} mine={mineIds.has(offer.id)} onClose={onClose} />
          ))}
        </div>
      )}
    </section>
  );
}

function OfferRow({ currency, offer, depth, mine, onClose }: { currency: OfferCurrency; offer: Offer; depth: number; mine: boolean; onClose(offer: Offer, remove: boolean): void }) {
  const info = CURRENCIES[currency];
  return (
    <div className="order">
      <div className="order-main">
        <span className="rate">
          {offer.rate.toFixed(2)}
          <small>AED</small>
        </span>
        <span className="total">{Math.round(offer.amount * offer.rate).toLocaleString()} AED total</span>
      </div>
      <div className="qty">
        <i style={{ '--depth': `${depth.toFixed(1)}%` } as React.CSSProperties} aria-hidden="true" />
        {offer.amount.toLocaleString()} {info.short}
      </div>
      {offer.note && <div className="note">{offer.note}</div>}
      <div className="meta">
        <span>{offer.posterName}</span>
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
          <ContactReveal kind={offer.contactKind} contact={offer.contact} about={`${offer.amount} ${info.name} at ${offer.rate.toFixed(2)}`} />
        )}
      </div>
    </div>
  );
}

export function OfferCompose({ currency, side, market, onDone, onCancel }: { currency: OfferCurrency; side: OfferSide; market: MarketSummary | null; onDone(): void; onCancel(): void }) {
  const { profile } = useApp();
  const info = CURRENCIES[currency];
  const suggested = (side === 'sell' ? market?.bestBid : market?.bestAsk) ?? market?.medianRate ?? info.typicalRate;
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
      await api.board.offer({ netId: profile.netId, key: askerKey(), currency, side, amount: Number(amount), rate: Number(rate), contactKind, contact: contact.trim(), note: note.trim() || undefined });
      saveContact({ contactKind, contact: contact.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the offer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      style={{ gap: 14 }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor="of-amount">{side === 'sell' ? `${info.name} to sell` : `${info.name} wanted`}</label>
          <div className="input-group">
            <input id="of-amount" className="input" inputMode="numeric" data-autofocus value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ''))} placeholder={currency === 'campus' ? '300' : '500'} />
            <span className="suffix">{info.short}</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="of-rate">Rate</label>
          <div className="input-group">
            <input id="of-rate" className="input" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value.replace(/[^\d.]/g, ''))} placeholder={info.typicalRate.toFixed(2)} />
            <span className="suffix">AED each</span>
          </div>
          <span className="hint">{total > 0 ? `${total.toLocaleString()} AED total` : ' '}</span>
        </div>
      </div>
      <ContactFields kind={contactKind} contact={contact} onKind={setContactKind} onContact={setContact} />
      <div className="field">
        <label htmlFor="of-note">Note</label>
        <input id="of-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Pay by transfer, meet at D2" />
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={busy || !amount || !rate || contact.trim().length < 3}>
          {busy ? 'Posting' : 'Post'}
        </button>
      </div>
    </form>
  );
}
