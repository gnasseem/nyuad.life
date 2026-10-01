import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Announcement, type AnnouncementKind } from '../api';
import { Modal } from '../components/Modal';
import { useApp } from '../context';
import { formatWhen, relativeDate } from '../format';
import { IconPlus } from '../icons';
import { askerKey, loadAnnounced, saveAnnounced } from '../store';

const KINDS: Array<{ id: AnnouncementKind; label: string }> = [
  { id: 'event', label: 'Event' },
  { id: 'deadline', label: 'Deadline' },
  { id: 'opportunity', label: 'Opportunity' },
  { id: 'club', label: 'Club' },
  { id: 'notice', label: 'General' },
];

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayDiff(when: Date, now: Date): number {
  return Math.round((startOfDay(when).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

interface Group {
  key: string;
  label: string;
  sub?: string;
  items: Announcement[];
}

/** Dated notices by day for the coming week, then "Next week" and "Later"; the input is already soonest first. */
function groupByDay(items: Announcement[], now: Date): Group[] {
  const groups: Group[] = [];
  for (const entry of items) {
    const when = new Date(entry.startsAt!);
    const diff = dayDiff(when, now);
    const key = diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : diff < 7 ? `day-${diff}` : diff < 14 ? 'next-week' : 'later';
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      const label = diff <= 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff < 7 ? when.toLocaleDateString('en-GB', { weekday: 'long' }) : diff < 14 ? 'Next week' : 'Later';
      const sub = diff < 7 ? when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : undefined;
      group = { key, label, sub, items: [] };
      groups.push(group);
    }
    group.items.push(entry);
  }
  return groups;
}

/** "In 40 min", "In 3 h", or "Now" for the first three hours after the start. */
function startsIn(when: Date, now: Date): { text: string; live: boolean } | null {
  const minutes = Math.round((when.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return minutes > -180 ? { text: 'Now', live: true } : null;
  if (minutes < 60) return { text: `In ${minutes} min`, live: false };
  const hours = Math.round(minutes / 60);
  return hours < 24 ? { text: `In ${hours} h`, live: false } : null;
}

export function AnnouncementsPage() {
  const { boardProblem, profile, requestProfile, toast } = useApp();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<AnnouncementKind | ''>('');
  const [composing, setComposing] = useState(false);
  const [mine, setMine] = useState<string[]>(loadAnnounced);
  const now = useMemo(() => new Date(), [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    if (boardProblem) return;
    api.board
      .announcements()
      .then((result) => {
        setItems(result.announcements);
        setError('');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load notices.'));
  }, [boardProblem]);

  useEffect(load, [load]);

  const startPosting = async () => {
    if (!profile && !(await requestProfile({ title: 'Your details', reason: 'Your name appears on the notice.' }))) return;
    setComposing(true);
  };

  const remove = async (id: string) => {
    if (!window.confirm('Remove this notice?')) return;
    try {
      await api.board.unannounce({ id, key: askerKey() });
      toast('Removed');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove the notice.');
    }
  };

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of items ?? []) map.set(entry.kind, (map.get(entry.kind) ?? 0) + 1);
    return map;
  }, [items]);
  const shown = (items ?? []).filter((entry) => !filter || entry.kind === filter);
  const dated = groupByDay(
    shown.filter((entry) => entry.startsAt),
    now,
  );
  const undated = shown.filter((entry) => !entry.startsAt);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Notices</h1>
        {!boardProblem && (
          <button type="button" className="btn primary" onClick={() => void startPosting()}>
            <IconPlus /> Post
          </button>
        )}
      </div>
      {boardProblem && <div className="alert">{boardProblem}</div>}
      {!boardProblem && items && items.length > 0 && (
        <div className="chips" style={{ marginBottom: 22 }}>
          <button type="button" className={`chip${filter ? '' : ' on'}`} onClick={() => setFilter('')}>
            All <span className="n">{items.length}</span>
          </button>
          {KINDS.filter((kind) => counts.has(kind.id)).map((kind) => (
            <button key={kind.id} type="button" className={`chip kind-${kind.id}${filter === kind.id ? ' on' : ''}`} onClick={() => setFilter(filter === kind.id ? '' : kind.id)}>
              <span className="dot" /> {kind.label}
              <span className="n">{counts.get(kind.id)}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      {!boardProblem && !items && !error && (
        <div className="stack" aria-busy="true">
          <div className="skeleton" style={{ height: 64 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </div>
      )}
      {items && shown.length === 0 && !error && (
        <div className="empty">
          Nothing on right now.
          <br />
          <button type="button" className="btn" onClick={() => void startPosting()}>
            Post a notice
          </button>
        </div>
      )}
      {dated.map((group) => (
        <section key={group.key} className="ann-group">
          <h2 className="section-title">
            {group.label}
            {group.sub && <span>{group.sub}</span>}
          </h2>
          <div className="list">
            {group.items.map((entry) => (
              <Item key={entry.id} entry={entry} now={now} mine={mine.includes(entry.id)} onRemove={() => void remove(entry.id)} />
            ))}
          </div>
        </section>
      ))}
      {undated.length > 0 && (
        <section className="ann-group">
          <h2 className="section-title">Undated</h2>
          <div className="list">
            {undated.map((entry) => (
              <Item key={entry.id} entry={entry} now={now} mine={mine.includes(entry.id)} onRemove={() => void remove(entry.id)} />
            ))}
          </div>
        </section>
      )}
      <Modal open={composing} onClose={() => setComposing(false)} title="New notice" width={560}>
        <Compose
          onDone={(announcement) => {
            const next = [...mine, announcement.id];
            setMine(next);
            saveAnnounced(next);
            setComposing(false);
            load();
            toast('Posted');
          }}
          onCancel={() => setComposing(false)}
        />
      </Modal>
    </div>
  );
}

function Item({ entry, now, mine, onRemove }: { entry: Announcement; now: Date; mine: boolean; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const when = entry.startsAt ? new Date(entry.startsAt) : null;
  const label = KINDS.find((kind) => kind.id === entry.kind)?.label ?? entry.kind;
  const long = entry.body.length > 220 || entry.body.split('\n').length > 3;
  const soon = when ? startsIn(when, now) : null;
  const hasTime = when ? when.getHours() !== 0 || when.getMinutes() !== 0 : false;
  return (
    <article className={`ann kind-${entry.kind}${when ? '' : ' undated'}`}>
      {when && (
        <div className="when">
          <span className="day">{when.getDate()}</span>
          <span className="mon">{when.toLocaleDateString('en-GB', { month: 'short' })}</span>
          {hasTime && <span className="time">{when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      )}
      <div className="ann-title">
        <h3>{entry.title}</h3>
        <span className="pill">
          <span className="dot" /> {label}
        </span>
        {soon && (
          <span className={`pill soon${soon.live ? ' now' : ''}`}>
            <span className="dot" /> {soon.text}
          </span>
        )}
      </div>
      {(when || entry.location) && (
        <div className="meta">
          {when && <span>{formatWhen(entry.startsAt!)}</span>}
          {entry.location && <span>{entry.location}</span>}
        </div>
      )}
      {entry.body && <div className={`details${long && !open ? ' clamped' : ''}`}>{entry.body}</div>}
      {long && !open && (
        <button type="button" className="link-btn small" style={{ justifySelf: 'start' }} onClick={() => setOpen(true)}>
          Read more
        </button>
      )}
      <div className="foot">
        <span>
          {entry.posterName}, {relativeDate(entry.createdAt)}
        </span>
        {entry.link && (
          <a href={entry.link} target="_blank" rel="noreferrer">
            Link
          </a>
        )}
        {mine && (
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        )}
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
      setError(err instanceof Error ? err.message : 'Could not post the notice.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="field">
        <label>Kind</label>
        <div className="chips" role="radiogroup" aria-label="Kind">
          {KINDS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={kind === entry.id} className={`chip kind-${entry.id}${kind === entry.id ? ' on' : ''}`} onClick={() => setKind(entry.id)}>
              <span className="dot" /> {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="an-title">Title</label>
        <input id="an-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="an-when">When{kind === 'notice' || kind === 'opportunity' ? ' (optional)' : ''}</label>
          <input id="an-when" className="input" type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="an-where">Location (optional)</label>
          <input id="an-where" className="input" value={location} onChange={(event) => setLocation(event.target.value)} maxLength={80} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="an-link">Link (optional)</label>
        <input id="an-link" className="input" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" inputMode="url" />
      </div>
      <div className="field">
        <label htmlFor="an-body">Details (optional)</label>
        <textarea id="an-body" className="input" value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={1500} />
        <span className="hint">Dated notices drop off the day after, undated ones after two weeks.</span>
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || title.trim().length < 4}>
          {busy ? 'Posting' : 'Post'}
        </button>
      </div>
    </div>
  );
}
