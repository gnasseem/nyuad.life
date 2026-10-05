import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ContactKind, type Listing, type ListingKind, type Offer, type OfferCurrency, type OfferSide } from '../api';
import { ContactFields, ContactReveal } from '../components/Contact';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { PageHeader } from '../components/PageHeader';
import { Segmented } from '../components/Segmented';
import { useApp } from '../context';
import { formatTime, groupByDay, plural, shortDate, startsIn } from '../format';
import { IconArrow, IconBag, IconPin, IconPlus, IconQuestions, IconSearch } from '../icons';
import { useNow } from '../motion';
import { navigate, type MarketTab } from '../router';
import { askerKey, loadContact, saveContact } from '../store';
import { CURRENCIES, OfferCompose, OffersTab, type OffersData } from './Offers';

type Composer = { kind: ListingKind } | { side: OfferSide; currency: OfferCurrency };

const TABS: Array<{ id: MarketTab; label: string }> = [
  { id: 'items', label: 'Items' },
  { id: 'falcons', label: 'Falcons' },
  { id: 'campus', label: 'Campus Dirhams' },
  { id: 'rides', label: 'Rides' },
  { id: 'lost', label: 'Lost & found' },
];

const ITEM_KINDS: Array<{ id: ListingKind; label: string }> = [
  { id: 'sell', label: 'For sale' },
  { id: 'want', label: 'Wanted' },
  { id: 'free', label: 'Free' },
];

const LOST_KINDS: Array<{ id: ListingKind; label: string }> = [
  { id: 'lost', label: 'Lost' },
  { id: 'found', label: 'Found' },
];

const KIND_CLASS: Record<ListingKind, string> = { sell: 'tone-slate', want: 'tone-slate', free: 'tone-ok', ride: 'tone-slate', lost: 'tone-alert', found: 'tone-ok' };

function tabOf(kind: ListingKind): MarketTab {
  return kind === 'ride' ? 'rides' : kind === 'lost' || kind === 'found' ? 'lost' : 'items';
}

/** Things for sale, wanted or free, Falcons and Campus Dirhams, shared rides, and lost and found: what students post to each other. */
export function MarketPage({ tab }: { tab: MarketTab }) {
  const { boardProblem, profile, requestProfile, toast } = useApp();
  const [listings, setListings] = useState<{ listings: Listing[]; mine: Listing[] } | null>(null);
  const [listingError, setListingError] = useState<ApiError | Error | null>(null);
  const [offers, setOffers] = useState<OffersData | null>(null);
  const [offerError, setOfferError] = useState('');
  const [composer, setComposer] = useState<Composer | null>(null);

  const loadListings = useCallback(() => {
    if (boardProblem) return;
    api.board
      .listings(askerKey())
      .then((result) => {
        setListings(result);
        setListingError(null);
      })
      .catch((err) => setListingError(err instanceof Error ? err : new Error('Could not load the market.')));
  }, [boardProblem]);

  const loadOffers = useCallback(() => {
    if (boardProblem) return;
    api.board
      .offers(askerKey())
      .then((result) => {
        // A server from before Campus Dirhams only sends the Falcon book.
        const empty = { open: 0, selling: 0, buying: 0, bestAsk: null, bestBid: null, medianRate: null, volume: 0 };
        setOffers({ offers: result.offers, mine: result.mine, markets: result.markets ?? { falcon: result.market, campus: empty } });
        setOfferError('');
      })
      .catch((err) => setOfferError(err instanceof Error ? err.message : 'Could not load offers.'));
  }, [boardProblem]);

  useEffect(() => {
    loadListings();
    loadOffers();
  }, [loadListings, loadOffers]);

  const startPosting = async (next: Composer) => {
    if (!profile && !(await requestProfile())) return;
    setComposer(next);
  };

  const closeListing = async (listing: Listing, remove: boolean) => {
    if (remove && !window.confirm('Remove this post?')) return;
    try {
      if (remove) await api.board.unlisting({ id: listing.id, key: askerKey() });
      else await api.board.listingDone({ id: listing.id, key: askerKey() });
      toast(remove ? 'Removed' : 'Marked done');
      loadListings();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the post.');
    }
  };

  const closeOffer = async (offer: Offer, remove: boolean) => {
    if (remove && !window.confirm('Remove this offer?')) return;
    try {
      if (remove) await api.board.unoffer({ id: offer.id, key: askerKey() });
      else await api.board.offerDone({ id: offer.id, key: askerKey() });
      toast(remove ? 'Removed' : 'Marked done');
      loadOffers();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the offer.');
    }
  };

  const all = listings?.listings ?? [];
  const mineIds = useMemo(() => new Set((listings?.mine ?? []).map((listing) => listing.id)), [listings]);
  const defaultKind: ListingKind = tab === 'rides' ? 'ride' : tab === 'lost' ? 'lost' : 'sell';
  const notReady = listingError instanceof ApiError && listingError.code === 'board_schema_missing';

  const currency: OfferCurrency | null = tab === 'falcons' ? 'falcon' : tab === 'campus' ? 'campus' : null;
  const body = (() => {
    if (currency) {
      if (offerError) return <div className="alert error">{offerError}</div>;
      if (!offers) return <Loading />;
      return <OffersTab key={currency} currency={currency} data={offers} onClose={(offer, remove) => void closeOffer(offer, remove)} onPost={(side) => void startPosting({ side, currency })} />;
    }
    if (notReady) return <EmptyState icon={<IconBag />} title="Not open yet" />;
    if (listingError) return <div className="alert error">{listingError.message}</div>;
    if (!listings) return <Loading />;
    const props = { listings: all, mineIds, onClose: (listing: Listing, remove: boolean) => void closeListing(listing, remove), onPost: (kind: ListingKind) => void startPosting({ kind }) };
    if (tab === 'rides') return <RidesTab {...props} />;
    if (tab === 'lost') return <LostTab {...props} />;
    return <ItemsTab {...props} />;
  })();

  return (
    <div className="page">
      <PageHeader title="Market" description="Buy, sell and share rides with other students.">
        {!boardProblem &&
          (currency ? (
            <>
              <button type="button" className="btn" onClick={() => void startPosting({ side: 'buy', currency })}>
                Buy
              </button>
              <button type="button" className="btn primary" onClick={() => void startPosting({ side: 'sell', currency })}>
                <IconPlus /> Sell
              </button>
            </>
          ) : (
            !notReady && (
              <button type="button" className="btn primary" onClick={() => void startPosting({ kind: defaultKind })}>
                <IconPlus /> {tab === 'rides' ? 'Post a ride' : tab === 'lost' ? 'Post lost or found' : 'List something'}
              </button>
            )
          ))}
      </PageHeader>
      <div className="tabs-wrap">
        <Segmented
          variant="tabs"
          label="Market"
          value={tab}
          onChange={(next) => navigate({ name: 'market', tab: next }, { replace: true, keepScroll: true })}
          options={TABS}
        />
      </div>
      {boardProblem ? (
        <div className="alert">{boardProblem}</div>
      ) : (
        <div className="tab-body" key={tab}>
          {body}
        </div>
      )}
      <Modal
        open={composer !== null}
        onClose={() => setComposer(null)}
        title={composer && 'side' in composer ? `${composer.side === 'buy' ? 'Buy' : 'Sell'} ${CURRENCIES[composer.currency].name}` : composer?.kind === 'ride' ? 'Offer or find a ride' : composer && tabOf(composer.kind) === 'lost' ? 'Lost or found something' : 'New listing'}
        width={520}
      >
        {composer &&
          ('side' in composer ? (
            <OfferCompose
              currency={composer.currency}
              side={composer.side}
              market={offers?.markets[composer.currency] ?? null}
              onDone={() => {
                setComposer(null);
                loadOffers();
                toast('Posted');
              }}
              onCancel={() => setComposer(null)}
            />
          ) : (
            <ListingCompose
              initialKind={composer.kind}
              onDone={(listing) => {
                setComposer(null);
                loadListings();
                toast('Posted');
                if (tabOf(listing.kind) !== tab) navigate({ name: 'market', tab: tabOf(listing.kind) }, { replace: true, keepScroll: true });
              }}
              onCancel={() => setComposer(null)}
            />
          ))}
      </Modal>
    </div>
  );
}

function Loading() {
  return (
    <div className="items" aria-busy="true">
      <div className="skeleton" style={{ height: 180 }} />
      <div className="skeleton" style={{ height: 180 }} />
      <div className="skeleton" style={{ height: 180 }} />
    </div>
  );
}

/** A pickup or a sighting: campus building codes (A2, C3, D2) read as a small badge, anything else as a pin and words. */
function Place({ place }: { place: string }) {
  const match = /^([A-H]\d{1,2}[A-C]?)\b[\s,]*(.*)$/i.exec(place.trim());
  if (match) {
    return (
      <span className="place">
        <span className="building">{match[1]!.toUpperCase()}</span>
        {match[2]}
      </span>
    );
  }
  return (
    <span className="place">
      <IconPin /> {place}
    </span>
  );
}

interface TabProps {
  listings: Listing[];
  mineIds: Set<string>;
  onClose(listing: Listing, remove: boolean): void;
  onPost(kind: ListingKind): void;
}

/** Only kinds that have posts get a chip, and with a single kind there is nothing to filter. */
function KindFilter({ kinds, value, counts, onChange }: { kinds: Array<{ id: ListingKind; label: string }>; value: ListingKind | ''; counts: Map<string, number>; onChange(value: ListingKind | ''): void }) {
  const present = kinds.filter((kind) => counts.has(kind.id));
  if (present.length < 2) return null;
  return (
    <div className="chips">
      <button type="button" className={`chip${value ? '' : ' on'}`} onClick={() => onChange('')}>
        All
      </button>
      {present.map((kind) => (
        <button key={kind.id} type="button" className={`chip${value === kind.id ? ' on' : ''}`} onClick={() => onChange(value === kind.id ? '' : kind.id)}>
          {kind.label}
        </button>
      ))}
    </div>
  );
}

function countKinds(listings: Listing[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const listing of listings) counts.set(listing.kind, (counts.get(listing.kind) ?? 0) + 1);
  return counts;
}

function ItemsTab({ listings, mineIds, onClose, onPost }: TabProps) {
  const [kind, setKind] = useState<ListingKind | ''>('');
  const [q, setQ] = useState('');
  const items = listings.filter((listing) => tabOf(listing.kind) === 'items');
  const needle = q.trim().toLowerCase();
  const shown = items.filter((listing) => (!kind || listing.kind === kind) && (!needle || `${listing.title} ${listing.body} ${listing.place}`.toLowerCase().includes(needle)));

  if (items.length === 0) {
    return (
      <EmptyState icon={<IconBag />} title="Nothing listed yet">
        <button type="button" className="btn" onClick={() => onPost('want')}>
          Ask for something
        </button>
        <button type="button" className="btn primary" onClick={() => onPost('sell')}>
          List an item
        </button>
      </EmptyState>
    );
  }
  return (
    <>
      <div className="toolbar">
        <KindFilter kinds={ITEM_KINDS} value={kind} counts={countKinds(items)} onChange={setKind} />
        {items.length > 5 && (
          <div className="search-field">
            <IconSearch />
            <input className="input" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search listings" aria-label="Search listings" />
          </div>
        )}
      </div>
      {shown.length === 0 ? (
        <div className="empty">Nothing matches.</div>
      ) : (
        <div className="items">
          {shown.map((listing) => (
            <ItemRow key={listing.id} listing={listing} mine={mineIds.has(listing.id)} onClose={onClose} />
          ))}
        </div>
      )}
    </>
  );
}

function Price({ listing }: { listing: Listing }) {
  if (listing.kind === 'free') return <span className="price free">Free</span>;
  if (listing.price === null) return <span className="price muted">{listing.kind === 'want' ? 'Any price' : 'Make an offer'}</span>;
  const amount = listing.price.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  return (
    <span className="price" title={listing.kind === 'want' ? 'Budget' : 'Price'}>
      {listing.kind === 'want' && <small className="lead">up to</small>}
      {amount}
      <small>AED</small>
    </span>
  );
}

function ItemRow({ listing, mine, onClose }: { listing: Listing; mine: boolean; onClose(listing: Listing, remove: boolean): void }) {
  const label = ITEM_KINDS.find((entry) => entry.id === listing.kind)?.label ?? listing.kind;
  return (
    <article className="item">
      <div className="item-top">
        <h3>{listing.title}</h3>
        <Price listing={listing} />
      </div>
      <div className="item-meta">
        <span className={`pill ${KIND_CLASS[listing.kind]}`}>
          <span className="dot" /> {label}
        </span>
        {listing.place && <Place place={listing.place} />}
        <span>{listing.posterName}</span>
      </div>
      {listing.body ? <Details text={listing.body} /> : <span />}
      <ListingActions listing={listing} mine={mine} onClose={onClose} />
    </article>
  );
}

function ListingActions({ listing, mine, onClose }: { listing: Listing; mine: boolean; onClose(listing: Listing, remove: boolean): void }) {
  return (
    <div className="item-actions">
      {mine ? (
        <>
          <span className="pill">Yours</span>
          <button type="button" className="btn sm" onClick={() => onClose(listing, false)}>
            {listing.kind === 'lost' || listing.kind === 'found' ? 'Mark returned' : listing.kind === 'ride' ? 'Mark full' : 'Mark done'}
          </button>
          <button type="button" className="btn sm ghost" onClick={() => onClose(listing, true)}>
            Remove
          </button>
        </>
      ) : (
        <ContactReveal type="listing" id={listing.id} kind={listing.contactKind} about={listing.title || `the ride to ${listing.destination}`} />
      )}
    </div>
  );
}

function Details({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160 || text.split('\n').length > 3;
  return (
    <div>
      <p className={`details${long && !open ? ' clamped' : ''}`}>{text}</p>
      {long && !open && (
        <button type="button" className="link-btn small" onClick={() => setOpen(true)}>
          Read more
        </button>
      )}
    </div>
  );
}

function RidesTab({ listings, mineIds, onClose, onPost }: TabProps) {
  const now = useNow();
  const rides = listings.filter((listing) => listing.kind === 'ride' && listing.happensAt).sort((a, b) => a.happensAt!.localeCompare(b.happensAt!));
  if (rides.length === 0) {
    return (
      <EmptyState icon={<IconArrow />} title="No rides yet">
        <button type="button" className="btn primary" onClick={() => onPost('ride')}>
          Post a ride
        </button>
      </EmptyState>
    );
  }
  return (
    <>
      {groupByDay(rides, (ride) => new Date(ride.happensAt!), now).map((group) => (
        <section key={group.key} className="day-group" aria-label={`Rides ${group.label}`}>
          <div className="day-head">
            <h2>{group.label}</h2>
            {group.sub && <span>{group.sub}</span>}
          </div>
          <div className="list">
            {group.items.map((ride) => {
              const boarding = startsIn(new Date(ride.happensAt!), now, 60)?.live;
              return (
                <article key={ride.id} className="ride">
                  <div className="ride-time">{formatTime(ride.happensAt!)}</div>
                  <div className="ride-main">
                    <b className="ride-route">
                      {ride.place} <IconArrow /> {ride.destination}
                    </b>
                    <span className="meta">{[ride.seats !== null ? plural(ride.seats, 'seat') : '', ride.posterName].filter(Boolean).join(' · ')}</span>
                    {ride.body && <Details text={ride.body} />}
                  </div>
                  <div className="ride-side">
                    {boarding && (
                      <span className="pill tone-ok">
                        <span className="dot" /> Boarding
                      </span>
                    )}
                    <ListingActions listing={ride} mine={mineIds.has(ride.id)} onClose={onClose} />
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

function LostTab({ listings, mineIds, onClose, onPost }: TabProps) {
  const [kind, setKind] = useState<ListingKind | ''>('');
  const items = listings.filter((listing) => tabOf(listing.kind) === 'lost');
  const shown = items.filter((listing) => !kind || listing.kind === kind);
  if (items.length === 0) {
    return (
      <EmptyState icon={<IconQuestions />} title="Nothing lost or found">
        <button type="button" className="btn" onClick={() => onPost('found')}>
          I found something
        </button>
        <button type="button" className="btn primary" onClick={() => onPost('lost')}>
          I lost something
        </button>
      </EmptyState>
    );
  }
  return (
    <>
      <div className="toolbar">
        <KindFilter kinds={LOST_KINDS} value={kind} counts={countKinds(items)} onChange={setKind} />
      </div>
      <div className="items">
        {shown.map((listing) => (
          <article key={listing.id} className="item">
            <div className="item-top">
              <h3>{listing.title}</h3>
            </div>
            <div className="item-meta">
              <span className={`pill ${KIND_CLASS[listing.kind]}`}>
                <span className="dot" /> {listing.kind === 'lost' ? 'Lost' : 'Found'}
                {listing.happensAt ? ` ${shortDate(listing.happensAt)}` : ''}
              </span>
              {listing.place && <Place place={listing.place} />}
              <span>{listing.posterName}</span>
            </div>
            {listing.body ? <Details text={listing.body} /> : <span />}
            <ListingActions listing={listing} mine={mineIds.has(listing.id)} onClose={onClose} />
          </article>
        ))}
      </div>
    </>
  );
}

function localInput(date: Date, withTime: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

function ListingCompose({ initialKind, onDone, onCancel }: { initialKind: ListingKind; onDone(listing: Listing): void; onCancel(): void }) {
  const { profile } = useApp();
  const saved = loadContact();
  const [kind, setKind] = useState<ListingKind>(initialKind);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [place, setPlace] = useState(initialKind === 'ride' ? 'Campus' : '');
  const [destination, setDestination] = useState('');
  const [when, setWhen] = useState('');
  const [seats, setSeats] = useState('');
  const [body, setBody] = useState('');
  const [contactKind, setContactKind] = useState<ContactKind>(saved.contactKind);
  const [contact, setContact] = useState(saved.contact);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const group = tabOf(kind);
  const now = new Date();

  const ready =
    contact.trim().length >= 3 &&
    (kind === 'ride' ? place.trim().length >= 2 && destination.trim().length >= 2 && Boolean(when) : title.trim().length >= 3);

  const submit = async () => {
    if (!profile || !ready) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.listing({
        netId: profile.netId,
        key: askerKey(),
        kind,
        title: title.trim(),
        body: body.trim(),
        price: (kind === 'sell' || kind === 'want') && price ? Number(price) : undefined,
        place: place.trim(),
        destination: destination.trim(),
        // A date input ("2026-10-04") parses as UTC midnight, four hours ahead of Abu Dhabi; a date and time parses as local.
        happensAt: when ? new Date(when.includes('T') ? when : `${when}T00:00`).toISOString() : undefined,
        seats: kind === 'ride' && seats ? Number(seats) : undefined,
        contactKind,
        contact: contact.trim(),
      });
      saveContact({ contactKind, contact: contact.trim() });
      onDone(result.listing);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post.');
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
      {group !== 'rides' && (
        <Segmented<ListingKind> value={kind} onChange={setKind} label="Kind" options={group === 'lost' ? LOST_KINDS : ITEM_KINDS} />
      )}
      {kind === 'ride' ? (
        <>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ls-from">From</label>
              <input id="ls-from" className="input" value={place} onChange={(event) => setPlace(event.target.value)} maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="ls-to">To</label>
              <input id="ls-to" className="input" data-autofocus value={destination} onChange={(event) => setDestination(event.target.value)} maxLength={80} placeholder="Dubai Mall" />
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="ls-when">Leaving</label>
              <input id="ls-when" className="input" type="datetime-local" value={when} min={localInput(now, true)} onChange={(event) => setWhen(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ls-seats">Seats</label>
              <input id="ls-seats" className="input" inputMode="numeric" value={seats} onChange={(event) => setSeats(event.target.value.replace(/[^\d]/g, '').slice(0, 2))} placeholder="3" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="ls-title">{group === 'lost' ? 'What is it' : 'What'}</label>
            <input
              id="ls-title"
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={100}
              placeholder={group === 'lost' ? 'Black AirPods case' : kind === 'want' ? 'Desk lamp' : 'Mini fridge'}
            />
          </div>
          <div className="form-grid">
            {kind === 'sell' || kind === 'want' ? (
              <div className="field">
                <label htmlFor="ls-price">{kind === 'want' ? 'Budget' : 'Price'}</label>
                <div className="input-group">
                  <input id="ls-price" className="input" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value.replace(/[^\d.]/g, ''))} placeholder="150" />
                  <span className="suffix">AED</span>
                </div>
              </div>
            ) : group === 'lost' ? (
              <div className="field">
                <label htmlFor="ls-date">When</label>
                <input id="ls-date" className="input" type="date" value={when} max={localInput(now, false)} onChange={(event) => setWhen(event.target.value)} />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="ls-place">{group === 'lost' ? 'Where' : 'Pickup'}</label>
              <input id="ls-place" className="input" value={place} onChange={(event) => setPlace(event.target.value)} maxLength={80} placeholder={group === 'lost' ? 'Library, 2nd floor' : 'A2, or any building code'} />
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor="ls-body">Details</label>
        <textarea
          id="ls-body"
          className="input"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={kind === 'ride' ? 'Splitting a Careem, back Sunday night' : group === 'lost' ? 'Any detail that helps tell it apart' : 'Condition, size, when you can hand it over'}
        />
      </div>
      <ContactFields kind={contactKind} contact={contact} onKind={setContactKind} onContact={setContact} />
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={busy || !ready}>
          {busy ? 'Posting' : 'Post'}
        </button>
      </div>
    </form>
  );
}
