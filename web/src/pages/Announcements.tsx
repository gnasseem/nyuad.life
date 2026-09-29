import { useCallback, useEffect, useState } from 'react';
import { api, type Announcement, type AnnouncementKind } from '../api';
import { ProfileGate } from '../components/ProfileGate';
import { useApp } from '../context';
import { formatWhen, relativeDate } from '../format';
import { IconExternal, IconPlus, IconTrash } from '../icons';
import { askerKey } from '../store';

const KINDS: Array<{ id: AnnouncementKind; label: string }> = [
  { id: 'event', label: 'Event' },
  { id: 'deadline', label: 'Deadline' },
  { id: 'opportunity', label: 'Opportunity' },
  { id: 'club', label: 'Club' },
  { id: 'notice', label: 'Notice' },
];

const MINE_KEY = 'room.announced';

function myAnnouncements(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MINE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function rememberMine(ids: string[]): void {
  try {
    localStorage.setItem(MINE_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // ignore
  }
}

export function AnnouncementsPage() {
  const { health, profile, toast } = useApp();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<AnnouncementKind | ''>('');
  const [composing, setComposing] = useState(false);
  const [mine, setMine] = useState<string[]>(myAnnouncements);
  const unavailable = health && !health.board.configured;

  const load = useCallback(() => {
    api.board
      .announcements()
      .then((result) => setItems(result.announcements))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load announcements.'));
  }, []);

  useEffect(load, [load]);

  const remove = async (id: string) => {
    if (!window.confirm('Remove this announcement?')) return;
    try {
      await api.board.unannounce({ id, key: askerKey() });
      toast('Removed');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it.');
    }
  };

  const shown = (items ?? []).filter((entry) => !filter || entry.kind === filter);
  const dated = shown.filter((entry) => entry.startsAt);
  const undated = shown.filter((entry) => !entry.startsAt);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Announcements</h1>
          <p>Events, deadlines and opportunities, posted by students. Everything here drops off once it has passed.</p>
        </div>
        {!unavailable && (
          <button type="button" className="btn primary" onClick={() => setComposing((value) => !value)}>
            <IconPlus /> Post
          </button>
        )}
      </div>
      {unavailable && <div className="alert note">Announcements are not set up on this server yet.</div>}
      {composing && !unavailable && (
        <div className="card" style={{ marginBottom: 28 }}>
          {profile ? (
            <Compose
              onDone={(announcement) => {
                const next = [...mine, announcement.id];
                setMine(next);
                rememberMine(next);
                setComposing(false);
                load();
                toast('Posted');
              }}
              onCancel={() => setComposing(false)}
            />
          ) : (
            <ProfileGate title="Before you post" reason="Your name goes on the announcement so people know who to ask. One time only." />
          )}
        </div>
      )}
      <div className="chips" style={{ marginBottom: 18 }}>
        <button type="button" className={`chip${filter ? '' : ' on'}`} onClick={() => setFilter('')}>
          All
        </button>
        {KINDS.map((kind) => (
          <button key={kind.id} type="button" className={`chip${filter === kind.id ? ' on' : ''}`} onClick={() => setFilter(filter === kind.id ? '' : kind.id)}>
            {kind.label}
          </button>
        ))}
      </div>
      {error && <div className="alert">{error}</div>}
      {items && shown.length === 0 && !error && (
        <div className="empty">
          <h3>Nothing on right now</h3>
          Know of something happening? Post it.
        </div>
      )}
      {dated.length > 0 && (
        <>
          <h2 className="section-title" style={{ marginTop: 6 }}>
            Coming up
          </h2>
          <div className="ann-list">
            {dated.map((entry) => (
              <Item key={entry.id} entry={entry} mine={mine.includes(entry.id)} onRemove={() => void remove(entry.id)} />
            ))}
          </div>
        </>
      )}
      {undated.length > 0 && (
        <>
          <h2 className="section-title">Notices</h2>
          <div className="ann-list">
            {undated.map((entry) => (
              <Item key={entry.id} entry={entry} mine={mine.includes(entry.id)} onRemove={() => void remove(entry.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Item({ entry, mine, onRemove }: { entry: Announcement; mine: boolean; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const when = entry.startsAt ? new Date(entry.startsAt) : null;
  const label = KINDS.find((kind) => kind.id === entry.kind)?.label ?? entry.kind;
  const long = entry.body.length > 220 || entry.body.split('\n').length > 3;
  return (
    <article className="ann">
      <div className="when">
        {when ? (
          <>
            <span className="day">{when.getDate()}</span>
            <span className="mon">{when.toLocaleDateString('en-GB', { month: 'short' })}</span>
            {(when.getHours() !== 0 || when.getMinutes() !== 0) && <span className="time">{when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
          </>
        ) : (
          <span className={`tag kind-${entry.kind}`}>{label}</span>
        )}
      </div>
      <div className="ann-body">
        <div className="row wrap" style={{ gap: 8 }}>
          <h3>{entry.title}</h3>
          {when && <span className={`tag kind-${entry.kind}`}>{label}</span>}
        </div>
        {(when || entry.location) && (
          <div className="muted small">
            {when ? formatWhen(entry.startsAt!) : ''}
            {when && entry.location ? ' · ' : ''}
            {entry.location}
          </div>
        )}
        {entry.body && (
          <div className={`details${long && !open ? ' clamped' : ''}`} onClick={() => long && setOpen(true)}>
            {entry.body}
          </div>
        )}
        {long && !open && (
          <button type="button" className="link-btn small" style={{ justifySelf: 'start' }} onClick={() => setOpen(true)}>
            Read more
          </button>
        )}
        <div className="foot">
          <span>{entry.posterName}</span>
          <span>{relativeDate(entry.createdAt)}</span>
          {entry.link && (
            <a href={entry.link} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>
              Link <IconExternal style={{ width: 12, height: 12 }} />
            </a>
          )}
          {mine && (
            <button type="button" className="link-btn" style={{ color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={onRemove}>
              <IconTrash style={{ width: 13, height: 13 }} /> Remove
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function Compose({ onDone, onCancel }: { onDone(announcement: Announcement): void; onCancel(): void }) {
  const { profile } = useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<AnnouncementKind>('event');
  const [startsAt, setStartsAt] = useState('');
  const [location, setLocation] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.announce({
        netId: profile.netId,
        key: askerKey(),
        title: title.trim(),
        body: body.trim(),
        kind,
        startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
        location: location.trim() || undefined,
        link: link.trim() || undefined,
      });
      onDone(result.announcement);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="field">
        <label htmlFor="an-title">Title</label>
        <input id="an-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} placeholder="What is happening" />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="an-kind">Kind</label>
          <select id="an-kind" className="input" value={kind} onChange={(event) => setKind(event.target.value as AnnouncementKind)}>
            {KINDS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="an-when">When (optional)</label>
          <input id="an-when" className="input" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="an-where">Where (optional)</label>
          <input id="an-where" className="input" value={location} onChange={(event) => setLocation(event.target.value)} maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor="an-link">Link (optional)</label>
          <input id="an-link" className="input" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" inputMode="url" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="an-body">Details (optional)</label>
        <textarea id="an-body" className="input" value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={1500} />
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || title.trim().length < 4}>
          {busy ? 'Posting' : 'Post announcement'}
        </button>
      </div>
    </div>
  );
}
