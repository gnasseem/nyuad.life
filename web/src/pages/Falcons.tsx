import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ContactKind, type MarketSummary, type Offer, type OfferSide } from '../api';
import { Mark } from '../components/Logo';
import { Modal } from '../components/Modal';
import { useApp } from '../context';
import { initials, plural, relativeDate } from '../format';
import { IconCheck, IconInfo, IconPlus, IconTrash } from '../icons';
import { askerKey } from '../store';

const CONTACTS: Array<{ id: ContactKind; label: string; placeholder: string }> = [
  { id: 'whatsapp', label: 'WhatsApp', placeholder: '+971 50 123 4567' },
  { id: 'instagram', label: 'Instagram', placeholder: '@handle' },
  { id: 'email', label: 'Email', placeholder: 'abc1234@nyu.edu' },
  { id: 'phone', label: 'Phone', placeholder: '+971 50 123 4567' },
];

const aed = (value: number) => `${value.toFixed(2)} AED`;
const dirhams = (offer: Offer) => Math.round(offer.amount * offer.rate);

function contactHref(offer: Offer): string | null {
  const digits = offer.contact.replace(/[^\d+]/g, '');
  switch (offer.contactKind) {
    case 'whatsapp':
      return `https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(`Hi ${offer.posterName.split(' ')[0]}, about your Falcons offer on nyuad.life (${offer.amount} at ${offer.rate})`)}`;
    case 'instagram':
      return `https://instagram.com/${offer.contact.replace(/^@/, '')}`;
    case 'email':
      return `mailto:${offer.contact}?subject=${encodeURIComponent('Your Falcons offer on nyuad.life')}`;
    case 'phone':
      return `tel:${digits}`;
  }
}

/** Hours or days until an offer drops off. */
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
    if (!profile && !(await requestProfile({ title: 'Before you post an offer', reason: 'Your name goes on the offer so people know who they are dealing with. One time only.' }))) return;
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
      toast(err instanceof Error ? err.message : 'Could not change that.');
    }
  };

  const mineIds = useMemo(() => new Set((data?.mine ?? []).map((offer) => offer.id)), [data]);
  const selling = (data?.offers ?? []).filter((offer) => offer.side === 'sell').sort((a, b) => a.rate - b.rate || b.amount - a.amount);
  const buying = (data?.offers ?? []).filter((offer) => offer.side === 'buy').sort((a, b) => b.rate - a.rate || b.amount - a.amount);
  const mineOpen = (data?.mine ?? []).filter((offer) => offer.status === 'open' && Date.parse(offer.expiresAt) > Date.now());
  const market = data?.market;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Falcons</h1>
          <p>Campus dirhams, traded between students at whatever rate you set. Post what you have or want; people contact you directly. Offers drop off after five days.</p>
        </div>
        {!boardProblem && (
          <div className="actions">
            <button type="button" className="btn" onClick={() => void startPosting('buy')}>
              I want Falcons
            </button>
            <button type="button" className="btn primary" onClick={() => void startPosting('sell')}>
              <IconPlus /> Sell Falcons
            </button>
          </div>
        )}
      </div>
      {boardProblem && (
        <div className="alert warn">
          <IconInfo /> <span>{boardProblem}</span>
        </div>
      )}
      {error && <div className="alert">{error}</div>}
      {market && (
        <div className="stats market">
          <div className="stat">
            <b className="num">{market.bestAsk === null ? '–' : market.bestAsk.toFixed(2)}</b>
            <span>Cheapest to buy, AED per Falcon</span>
          </div>
          <div className="stat">
            <b className="num">{market.bestBid === null ? '–' : market.bestBid.toFixed(2)}</b>
            <span>Best offer if you sell</span>
          </div>
          <div className="stat">
            <b className="num">{market.open}</b>
            <span>Open offers</span>
          </div>
          <div className="stat">
            <b className="num">{market.volume.toLocaleString()}</b>
            <span>Falcons on offer</span>
          </div>
        </div>
      )}
      {!boardProblem && !data && !error && (
        <div className="ann-skeleton" aria-busy="true">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {data && data.offers.length === 0 && (
        <div className="empty">
          <Mark className="mark" />
          <h3>No open offers</h3>
          Be the first: say how many Falcons and at what rate.
          <button type="button" className="btn primary" onClick={() => void startPosting('sell')}>
            <IconPlus /> Post an offer
          </button>
        </div>
      )}
      {data && data.offers.length > 0 && (
        <div className="offers-cols">
          <OfferColumn title="Selling Falcons" hint="cheapest first" offers={selling} mineIds={mineIds} onClose={close} />
          <OfferColumn title="Buying Falcons" hint="best rate first" offers={buying} mineIds={mineIds} onClose={close} />
        </div>
      )}
      {mineOpen.length > 0 && (
        <>
          <h2 className="section-title">Your open offers</h2>
          <div className="list">
            {mineOpen.map((offer) => (
              <OfferRow key={offer.id} offer={offer} mine onClose={close} />
            ))}
          </div>
        </>
      )}
      <p className="faint xs" style={{ marginTop: 22 }}>
        Deals happen between the two of you: meet on campus, transfer Falcons at the dining hall or the Campus Center desk, and pay in cash or by bank transfer. The site only lists offers.
      </p>
      <Modal open={composing !== null} onClose={() => setComposing(null)} title={composing === 'buy' ? 'I want to buy Falcons' : 'I want to sell Falcons'} subtitle="Say how many and at what rate; people who are interested will message you." width={520}>
        {composing && (
          <Compose
            side={composing}
            market={market ?? null}
            onDone={() => {
              setComposing(null);
              load();
              toast('Offer posted');
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
      <div className="offers-col-head">
        <h2>{title}</h2>
        <span>
          {plural(offers.length, 'offer')} · {hint}
        </span>
      </div>
      {offers.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          Nothing here yet.
        </div>
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
        <span className="total">{aed(dirhams(offer))}</span>
      </div>
      {offer.note && <div className="note">{offer.note}</div>}
      <div className="offer-meta">
        <span className="who">
          <span className="avatar sm">{initials(offer.posterName)}</span> {offer.posterName}
        </span>
        <span>{relativeDate(offer.createdAt)}</span>
        <span>{expiresIn(offer.expiresAt)}</span>
        {mine && <span className="pill mine-badge">Yours</span>}
      </div>
      <div className="offer-actions">
        {mine ? (
          <>
            <button type="button" className="btn sm" onClick={() => onClose(offer, false)}>
              <IconCheck /> Mark done
            </button>
            <button type="button" className="btn sm ghost" onClick={() => onClose(offer, true)}>
              <IconTrash /> Remove
            </button>
          </>
        ) : revealed ? (
          <>
            <span className="contact-reveal">{offer.contact}</span>
            {href && (
              <a className="btn sm primary" href={href} target="_blank" rel="noreferrer">
                Open {label}
              </a>
            )}
          </>
        ) : (
          <button type="button" className="btn sm" onClick={() => setRevealed(true)}>
            Contact on {label}
          </button>
        )}
      </div>
    </div>
  );
}

function Compose({ side, market, onDone, onCancel }: { side: OfferSide; market: MarketSummary | null; onDone(): void; onCancel(): void }) {
  const { profile } = useApp();
  const suggested = side === 'sell' ? market?.bestBid ?? market?.medianRate ?? 0.8 : market?.bestAsk ?? market?.medianRate ?? 0.8;
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
      setError(err instanceof Error ? err.message : 'Could not post that.');
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
            <span className="suffix">AED / Falcon</span>
          </div>
          <span className="hint">{total > 0 ? `${total.toLocaleString()} AED in total.` : market?.medianRate ? `Offers today sit around ${market.medianRate.toFixed(2)}.` : 'Most trades sit between 0.70 and 0.95.'}</span>
        </div>
      </div>
      <div className="field">
        <label>How people reach you</label>
        <div className="chips" role="radiogroup" aria-label="Contact method">
          {CONTACTS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={contactKind === entry.id} className={`chip${contactKind === entry.id ? ' on' : ''}`} onClick={() => setContactKind(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <input className="input" value={contact} onChange={(event) => setContact(event.target.value)} placeholder={contactMeta.placeholder} aria-label={contactMeta.label} inputMode={contactKind === 'email' ? 'email' : contactKind === 'instagram' ? 'text' : 'tel'} />
        <span className="hint">Shown only to people who tap the contact button on your offer.</span>
      </div>
      <div className="field">
        <label htmlFor="of-note">Note (optional)</label>
        <input id="of-note" className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Cash only, can meet at D2 after 6" />
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 0 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !amount || !rate || contact.trim().length < 3}>
          {busy ? 'Posting' : side === 'sell' ? 'Post sell offer' : 'Post buy offer'}
        </button>
      </div>
    </div>
  );
}
