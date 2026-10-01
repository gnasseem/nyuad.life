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
    <div className="page wide">
      <div className="page-head">
        <h1>Falcons</h1>
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
        <div className="strip">
          <div>
            <b>{market.bestAsk === null ? '–' : market.bestAsk.toFixed(2)}</b>
            <span>Cheapest sell, AED per Falcon</span>
          </div>
          <div>
            <b>{market.bestBid === null ? '–' : market.bestBid.toFixed(2)}</b>
            <span>Best buy, AED per Falcon</span>
          </div>
          <div>
            <b>{market.open}</b>
            <span>Open offers</span>
          </div>
          <div>
            <b>{market.volume.toLocaleString()}</b>
            <span>Falcons on offer</span>
          </div>
        </div>
      )}
      {!boardProblem && !data && !error && (
        <div className="stack" aria-busy="true">
          <div className="skeleton" style={{ height: 64 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </div>
      )}
      {data && data.offers.length === 0 && (
        <div className="empty">
          No open offers.
          <br />
          <button type="button" className="btn" onClick={() => void startPosting('sell')}>
            Post the first one
          </button>
        </div>
      )}
      {data && data.offers.length > 0 && (
        <div className="offers-cols">
          <OfferColumn title="Selling" hint="cheapest first" offers={selling} mineIds={mineIds} onClose={close} />
          <OfferColumn title="Buying" hint="best rate first" offers={buying} mineIds={mineIds} onClose={close} />
        </div>
      )}
      <p className="faint small" style={{ marginTop: 24 }}>
        The site only lists offers. The trade happens between the two of you, on campus. Offers expire after five days.
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

function OfferColumn({ title, hint, offers, mineIds, onClose }: { title: string; hint: string; offers: Offer[]; mineIds: Set<string>; onClose(offer: Offer, remove: boolean): void }) {
  return (
    <section>
      <h2 className="section-title">
        {title}
        <span>{offers.length ? `${plural(offers.length, 'offer')}, ${hint}` : ''}</span>
      </h2>
      {offers.length === 0 ? (
        <div className="empty">Nothing here yet.</div>
      ) : (
        <div className="list">
          {offers.map((offer) => (
            <OfferRow key={offer.id} offer={offer} mine={mineIds.has(offer.id)} onClose={onClose} />
          ))}
        </div>
      )}
    </section>
  );
}

function OfferRow({ offer, mine, onClose }: { offer: Offer; mine: boolean; onClose(offer: Offer, remove: boolean): void }) {
  const [revealed, setRevealed] = useState(false);
  const href = contactHref(offer);
  const label = CONTACTS.find((entry) => entry.id === offer.contactKind)?.label ?? offer.contactKind;
  return (
    <div className="offer">
      <div className="offer-main">
        <span className="amount">
          {offer.amount.toLocaleString()}
          <small>Falcons</small>
        </span>
        <span className="rate">
          at <b>{offer.rate.toFixed(2)}</b> AED each
        </span>
        <span className="total">{Math.round(offer.amount * offer.rate).toLocaleString()} AED</span>
      </div>
      {offer.note && <div className="note">{offer.note}</div>}
      <div className="meta">
        <span>{offer.posterName}</span>
        <span>{relativeDate(offer.createdAt)}</span>
        <span>{expiresIn(offer.expiresAt)}</span>
        {mine && (
          <span className="pill k-accent">
            <span className="dot" /> Yours
          </span>
        )}
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
              <a className="btn sm primary" href={href} target="_blank" rel="noreferrer">
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
          {total > 0 && <span className="hint">{total.toLocaleString()} AED in total.</span>}
        </div>
      </div>
      <div className="field">
        <label>Contact by</label>
        <div className="chips" role="radiogroup" aria-label="Contact method">
          {CONTACTS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={contactKind === entry.id} className={`chip${contactKind === entry.id ? ' on' : ''}`} onClick={() => setContactKind(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <input className="input" value={contact} onChange={(event) => setContact(event.target.value)} placeholder={contactMeta.placeholder} aria-label={contactMeta.label} inputMode={contactKind === 'email' ? 'email' : contactKind === 'instagram' ? 'text' : 'tel'} />
        <span className="hint">Shown only when someone taps Show on your offer.</span>
      </div>
      <div className="field">
        <label htmlFor="of-note">Note (optional)</label>
        <input id="of-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
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
