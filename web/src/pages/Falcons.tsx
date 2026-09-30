import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ContactKind, type MarketSummary, type Offer, type OfferSide } from '../api';
import { Modal } from '../components/Modal';
import { useApp } from '../context';
import { plural, relativeDate } from '../format';
import { IconPlus } from '../icons';
import { askerKey } from '../store';

const CONTACTS: Array<{ id: ContactKind; label: string; placeholder: string }> = [
  { id: 'whatsapp', label: 'WhatsApp', placeholder: '+971 50 123 4567' },
  { id: 'instagram', label: 'Instagram', placeholder: '@handle' },
  { id: 'email', label: 'Email', placeholder: 'abc1234@nyu.edu' },
  { id: 'phone', label: 'Phone', placeholder: '+971 50 123 4567' },
];

function contactHref(offer: Offer): string | null {
  const digits = offer.contact.replace(/[^\d+]/g, '');
  switch (offer.contactKind) {
    case 'whatsapp':
      return `https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(`About your Falcons offer on nyuad.life: ${offer.amount} at ${offer.rate}`)}`;
    case 'instagram':
      return `https://instagram.com/${offer.contact.replace(/^@/, '')}`;
    case 'email':
      return `mailto:${offer.contact}?subject=${encodeURIComponent('Your Falcons offer on nyuad.life')}`;
    case 'phone':
      return `tel:${digits}`;
  }
}

function expiresIn(iso: string): string {
  const hours = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3_600_000));
  return hours < 24 ? `${hours} h left` : `${Math.round(hours / 24)} d left`;
}

export function FalconsPage() {
  const { boardProblem, profile, requestProfile, toast } = useApp();
  const [data, setData] = useState<{ offers: Offer[]; mine: Offer[]; market: MarketSummary } | null>(null);
  const [error, setError] = useState('');
  const [composing, setComposing] = useState<OfferSide | null>(null);

  const load = useCallback(() => {
    if (boardProblem) return;
    api.board
      .offers(askerKey())
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load offers.'));
  }, [boardProblem]);

  useEffect(load, [load]);

  const startPosting = async (side: OfferSide) => {
    if (!profile && !(await requestProfile({ title: 'Your details', reason: 'Your name appears on the offer.' }))) return;
    setComposing(side);
  };

  const close = async (offer: Offer, remove: boolean) => {
    if (remove && !window.confirm('Remove this offer?')) return;
    try {
      if (remove) await api.board.unoffer({ id: offer.id, key: askerKey() });
      else await api.board.offerDone({ id: offer.id, key: askerKey() });
      toast(remove ? 'Removed' : 'Marked done');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the offer.');
    }
  };

  const mineIds = useMemo(() => new Set((data?.mine ?? []).map((offer) => offer.id)), [data]);
  const selling = (data?.offers ?? []).filter((offer) => offer.side === 'sell').sort((a, b) => a.rate - b.rate || b.amount - a.amount);
  const buying = (data?.offers ?? []).filter((offer) => offer.side === 'buy').sort((a, b) => b.rate - a.rate || b.amount - a.amount);
  const market = data?.market;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Falcons</h1>
          <p>Buy and sell Falcons with other students. Offers expire after five days.</p>
        </div>
        {!boardProblem && (
          <div className="actions">
            <button type="button" className="btn" onClick={() => void startPosting('buy')}>
              Buy
            </button>
            <button type="button" className="btn primary" onClick={() => void startPosting('sell')}>
              <IconPlus /> Sell
            </button>
          </div>
        )}
      </div>
      {boardProblem && <div className="alert">{boardProblem}</div>}
      {error && <div className="alert error">{error}</div>}
      {market && market.open > 0 && (
        <div className="meta" style={{ marginBottom: 16 }}>
          {market.bestAsk !== null && <span>Cheapest sell {market.bestAsk.toFixed(2)} AED</span>}
          {market.bestBid !== null && <span>Best buy {market.bestBid.toFixed(2)} AED</span>}
          <span>{plural(market.open, 'open offer')}</span>
          <span>{market.volume.toLocaleString()} Falcons on offer</span>
        </div>
      )}
      {!boardProblem && !data && !error && (
        <div className="stack" aria-busy="true">
          <div className="skeleton" style={{ height: 56 }} />
          <div className="skeleton" style={{ height: 56 }} />
        </div>
      )}
      {data && data.offers.length === 0 && <div className="empty">No open offers.</div>}
      {selling.length > 0 && (
        <>
          <h2 className="section-title">Selling, cheapest first</h2>
          <div className="list">
            {selling.map((offer) => (
              <OfferRow key={offer.id} offer={offer} mine={mineIds.has(offer.id)} onClose={close} />
            ))}
          </div>
        </>
      )}
      {buying.length > 0 && (
        <>
          <h2 className="section-title">Buying, best rate first</h2>
          <div className="list">
            {buying.map((offer) => (
              <OfferRow key={offer.id} offer={offer} mine={mineIds.has(offer.id)} onClose={close} />
            ))}
          </div>
        </>
      )}
      <p className="label" style={{ marginTop: 20 }}>
        The site only lists offers. The trade happens between the two of you, on campus.
      </p>
      <Modal open={composing !== null} onClose={() => setComposing(null)} title={composing === 'buy' ? 'Buy Falcons' : 'Sell Falcons'} width={480}>
        {composing && (
          <Compose
            side={composing}
            market={market ?? null}
            onDone={() => {
              setComposing(null);
              load();
              toast('Posted');
            }}
            onCancel={() => setComposing(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function OfferRow({ offer, mine, onClose }: { offer: Offer; mine: boolean; onClose(offer: Offer, remove: boolean): void }) {
  const [revealed, setRevealed] = useState(false);
  const href = contactHref(offer);
  const label = CONTACTS.find((entry) => entry.id === offer.contactKind)?.label ?? offer.contactKind;
  return (
    <div className="offer">
      <div className="offer-main">
        <b>{offer.amount.toLocaleString()} Falcons</b>
        <span>at {offer.rate.toFixed(2)} AED each</span>
        <span className="total">{Math.round(offer.amount * offer.rate).toLocaleString()} AED</span>
      </div>
      {offer.note && <div className="note">{offer.note}</div>}
      <div className="meta">
        <span>{offer.posterName}</span>
        <span>{relativeDate(offer.createdAt)}</span>
        <span>{expiresIn(offer.expiresAt)}</span>
        {mine && <span className="tag">Yours</span>}
      </div>
      <div className="offer-actions">
        {mine ? (
          <>
            <button type="button" className="btn sm" onClick={() => onClose(offer, false)}>
              Mark done
            </button>
            <button type="button" className="btn sm ghost" onClick={() => onClose(offer, true)}>
              Remove
            </button>
          </>
        ) : revealed ? (
          <>
            <span className="contact">{offer.contact}</span>
            {href && (
              <a className="btn sm" href={href} target="_blank" rel="noreferrer">
                Open {label}
              </a>
            )}
          </>
        ) : (
          <button type="button" className="btn sm" onClick={() => setRevealed(true)}>
            Show {label}
          </button>
        )}
      </div>
    </div>
  );
}

function Compose({ side, market, onDone, onCancel }: { side: OfferSide; market: MarketSummary | null; onDone(): void; onCancel(): void }) {
  const { profile } = useApp();
  const suggested = (side === 'sell' ? market?.bestBid : market?.bestAsk) ?? market?.medianRate ?? 0.8;
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState(suggested.toFixed(2));
  const [contactKind, setContactKind] = useState<ContactKind>('whatsapp');
  const [contact, setContact] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const contactMeta = CONTACTS.find((entry) => entry.id === contactKind)!;
  const total = Number(amount) > 0 && Number(rate) > 0 ? Math.round(Number(amount) * Number(rate)) : 0;

  const submit = async () => {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      await api.board.offer({ netId: profile.netId, key: askerKey(), side, amount: Number(amount), rate: Number(rate), contactKind, contact: contact.trim(), note: note.trim() || undefined });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the offer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="of-amount">Falcons</label>
          <input id="of-amount" className="input" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d]/g, ''))} placeholder="500" />
        </div>
        <div className="field">
          <label htmlFor="of-rate">AED per Falcon</label>
          <input id="of-rate" className="input" inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value.replace(/[^\d.]/g, ''))} placeholder="0.85" />
          {total > 0 && <span className="hint">{total.toLocaleString()} AED in total.</span>}
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="of-kind">Contact by</label>
          <select id="of-kind" className="input" value={contactKind} onChange={(event) => setContactKind(event.target.value as ContactKind)}>
            {CONTACTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="of-contact">{contactMeta.label}</label>
          <input id="of-contact" className="input" value={contact} onChange={(event) => setContact(event.target.value)} placeholder={contactMeta.placeholder} inputMode={contactKind === 'email' ? 'email' : contactKind === 'instagram' ? 'text' : 'tel'} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="of-note">Note (optional)</label>
        <input id="of-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
        <span className="hint">Your contact is shown only when someone taps Show on your offer.</span>
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
