import { useCallback, useEffect, useState } from 'react';
import { api, type Announcement } from '../api';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { Sign } from '../components/Sign';
import { AdminRemove, onAdminRemoved } from '../components/AdminRemove';
import { useApp } from '../context';
import { groupByDay, startsIn } from '../format';
import { IconCalendar, IconExternal, IconMegaphone, IconPlus } from '../icons';
import { useNow } from '../motion';
import { askerKey, loadAnnounced, saveAnnounced } from '../store';

/** A timed one-hour calendar entry; UTC stamps preserve Abu Dhabi times on every device. */
function calendarFile(entry: Announcement): string {
  const start = new Date(entry.startsAt!);
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const escape = (text: string) => text.replace(/[\\;,]/g, (match) => `\\${match}`).replace(/\n/g, '\\n');
  const end = new Date(start.getTime() + 3_600_000);
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//nyuad.life//events//EN',
    'BEGIN:VEVENT',
    `UID:${entry.id}@nyuad.life`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(entry.title)}`,
    entry.location ? `LOCATION:${escape(entry.location)}` : '',
    entry.body || entry.link ? `DESCRIPTION:${escape([entry.body, entry.link].filter(Boolean).join('\n\n'))}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function addToCalendar(entry: Announcement): void {
  const url = URL.createObjectURL(new Blob([calendarFile(entry)], { type: 'text/calendar' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${entry.title.replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'event'}.ics`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function AnnouncementsPage() {
  const { boardProblem, profile, requestProfile, toast } = useApp();
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [composing, setComposing] = useState(false);
  const [mine, setMine] = useState<string[]>(loadAnnounced);
  const now = useNow();
  const load = useCallback(() => {
    if (boardProblem) return;
    api.board.announcements().then((result) => {
      setItems(result.announcements.filter((entry) => entry.kind === 'event' && entry.startsAt).sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!)));
      setError('');
    }).catch((err) => setError(err instanceof Error ? err.message : 'Could not load events.'));
  }, [boardProblem]);
  useEffect(load, [load]);
  useEffect(() => onAdminRemoved(load), [load]);
  const startPosting = async () => {
    if (!profile && !(await requestProfile())) return;
    setComposing(true);
  };
  const remove = async (id: string) => {
    if (!window.confirm('Remove this event?')) return;
    try {
      await api.board.unannounce({ id, key: askerKey() });
      toast('Removed');
      load();
    } catch (err) { toast(err instanceof Error ? err.message : 'Could not remove the event.'); }
  };
  const shown = (items ?? []).filter((entry) => !selected || dateKey(new Date(entry.startsAt!)) === selected);
  const dated = groupByDay(shown, (entry) => new Date(entry.startsAt!), now);
  const week = Array.from({ length: 7 }, (_, diff) => {
    const date = new Date(now.getTime() + diff * 86_400_000);
    const key = dateKey(date);
    return { date, key, diff, count: (items ?? []).filter((entry) => dateKey(new Date(entry.startsAt!)) === key).length };
  });
  return (
    <div className="page events-page">
      <Sign title="Events" ar="الفعاليات">
        {!boardProblem && <button type="button" className="btn primary" onClick={() => void startPosting()}><IconPlus /> Post an event</button>}
      </Sign>
      <div className="events-intro"><p>Find your next campus gathering.</p><span>All times in Abu Dhabi</span></div>
      {boardProblem && <div className="alert">{boardProblem}</div>}
      {error && <div className="alert error">{error} <button type="button" className="link-btn" onClick={load}>Try again</button></div>}
      {!boardProblem && items && <>
        <div className="week" role="group" aria-label="Events this week">
          {week.map(({ date, key, diff, count }) => <button key={key} type="button" className={`day-btn${count ? ' has' : ''}${diff === 0 ? ' today' : ''}${selected === key ? ' selected' : ''}`} onClick={() => setSelected(selected === key ? '' : key)} aria-pressed={selected === key} aria-label={`${date.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'long', day: 'numeric', month: 'long' })}, ${count} events`}>
            <span className="dn">{diff === 0 ? 'Today' : date.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short' })}</span>
            <span className="dd">{date.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric' })}</span>
            <span className="day-count">{count ? `${count} event${count === 1 ? '' : 's'}` : '—'}</span>
          </button>)}
        </div>
        <div className="events-heading"><h2>{selected ? 'On this day' : 'Upcoming events'}</h2>{selected && <button type="button" className="link-btn" onClick={() => setSelected('')}>Show all events</button>}<span className="faint">{shown.length} event{shown.length === 1 ? '' : 's'}</span></div>
      </>}
      {!boardProblem && !items && !error && <div className="stack" aria-busy="true"><div className="skeleton" style={{ height: 100 }} /><div className="skeleton" style={{ height: 140 }} /></div>}
      {!boardProblem && items && !shown.length && !error && <EmptyState icon={<IconMegaphone />} title={selected ? 'No events on this day' : 'The calendar is open'}>
        {selected ? <button type="button" className="btn" onClick={() => setSelected('')}>See upcoming events</button> : <button type="button" className="btn primary" onClick={() => void startPosting()}>Post the first event</button>}
      </EmptyState>}
      <div className="agenda">{dated.map((group) => <section key={group.key} className="agenda-day">
        <div className="agenda-head"><h2>{group.label}</h2>{group.sub && <span>{group.sub}</span>}</div>
        <div className="agenda-items">{group.items.map((entry) => <Item key={entry.id} entry={entry} now={now} mine={mine.includes(entry.id)} onRemove={() => void remove(entry.id)} />)}</div>
      </section>)}</div>
      <Modal open={composing} onClose={() => setComposing(false)} title="New event" width={560}>
        <Compose onDone={(announcement) => {
          const next = [...mine, announcement.id];
          setMine(next); saveAnnounced(next); setComposing(false); setSelected(''); load(); toast('Event posted');
        }} onCancel={() => setComposing(false)} />
      </Modal>
    </div>
  );
}

/** Where a link goes, so nobody follows a notice's link blind. */
function linkHost(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

function Item({ entry, now, mine, onRemove }: { entry: Announcement; now: Date; mine: boolean; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const when = entry.startsAt ? new Date(entry.startsAt) : null;
  const long = entry.body.length > 220 || entry.body.split('\n').length > 3;
  const soon = when ? startsIn(when, now) : null;

  return (
    <article className={`ann${when ? '' : ' undated'}`}>
      {when && (
        <div className="when">
          <b>{when.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' })}</b>
        </div>
      )}
      <div className="ann-title">
        <h3>{entry.title}</h3>
        {soon?.live && (
          <span className="pill soon now live">
            <span className="dot" /> {soon.text}
          </span>
        )}
      </div>
      {entry.location && (
        <div className="meta">
          <span>{entry.location}</span>
        </div>
      )}
      {entry.body && <div className={`details${long && !open ? ' clamped' : ''}`}>{entry.body}</div>}
      {long && !open && (
        <button type="button" className="link-btn small" style={{ justifySelf: 'start' }} onClick={() => setOpen(true)}>
          Read more
        </button>
      )}
      <div className="foot">
        <span>{entry.posterName}</span>
        {entry.link && (
          <a href={entry.link} target="_blank" rel="noreferrer noopener" title={entry.link}>
            <IconExternal /> {linkHost(entry.link)}
          </a>
        )}
        {when && (
          <button type="button" onClick={() => addToCalendar(entry)}>
            <IconCalendar /> Calendar
          </button>
        )}
        {mine && (
          <button type="button" onClick={onRemove}>
            Remove
          </button>
        )}
        <AdminRemove type="notice" id={entry.id} label={entry.title} />
      </div>
    </article>
  );
}

function Compose({ onDone, onCancel }: { onDone(announcement: Announcement): void; onCancel(): void }) {
  const { profile } = useApp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [location, setLocation] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!profile || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.announce({
        netId: profile.netId,
        key: askerKey(),
        title: title.trim(),
        body: body.trim(),
        kind: 'event',
        startsAt: startsAt ? new Date(`${startsAt}+04:00`).toISOString() : undefined,
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
      <p className="muted">Share a real gathering, with a host, a time and a place. Items and service requests belong in Market.</p>
      <div className="field">
        <label htmlFor="an-title">Title</label>
        <input id="an-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="an-when">When · Abu Dhabi time</label>
          <input id="an-when" className="input" type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="an-where">Location</label>
          <input id="an-where" className="input" value={location} onChange={(event) => setLocation(event.target.value)} required maxLength={80} placeholder="e.g. Arts Center, Black Box · or Zoom" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="an-link">Link</label>
        <input id="an-link" className="input" value={link} onChange={(event) => setLink(event.target.value)} placeholder="https://" inputMode="url" />
      </div>
      <div className="field">
        <label htmlFor="an-body">Details</label>
        <textarea id="an-body" className="input" value={body} onChange={(event) => setBody(event.target.value)} rows={4} minLength={12} maxLength={1500} placeholder="What is happening, who is hosting, and how can students join?" />
      </div>
      {error && <div className="alert error">{error}</div>}
      <div className="modal-actions" style={{ marginTop: 4 }}>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="spacer" />
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || title.trim().length < 4 || body.trim().length < 12 || !startsAt || location.trim().length < 2}>
          {busy ? 'Posting' : 'Post'}
        </button>
      </div>
    </div>
  );
}
