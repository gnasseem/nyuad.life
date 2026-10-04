import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type CourseDetail, type CourseRow, type CourseSummary, type PostSummary, type SeatStatus, type Section, type Term } from '../api';
import { PostRow } from '../components/PostRow';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural } from '../format';
import { IconCheck, IconClose, IconCopy, IconExternal, IconSearch } from '../icons';
import { useLatest, useMedia, usePresence } from '../motion';
import { navigate, useRoute } from '../router';
import { ThreadSearch } from './Threads';

type View = 'courses' | 'threads';
type TimeOfDay = '' | 'morning' | 'afternoon' | 'evening';

const WIDE = '(min-width: 1240px)';
const PAGE_ROWS = 50;
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'courses', label: 'Course search' },
  { id: 'threads', label: 'Group threads' },
];
const TIMES: Array<{ id: TimeOfDay; label: string }> = [
  { id: '', label: 'Any time' },
  { id: 'morning', label: 'Mornings' },
  { id: 'afternoon', label: 'Afternoons' },
  { id: 'evening', label: 'Evenings' },
];
const SEAT_LABEL: Record<SeatStatus, string> = { open: 'Open', waitlist: 'Waitlist', closed: 'Closed', cancelled: 'Cancelled' };
// Recitations and labs hang off a lecture; the lecture or seminar says when the course really meets.
const SECONDARY = /recitation|laboratory|lab\b/i;

/** Courses from Albert's schedule, searchable by code, title, professor or topic, and the group's own threads beside them. */
export function CoursesPage({ view, code }: { view: View; code?: string }) {
  return (
    <div className="page">
      <Sign title="Courses" ar="المساقات" />
      <div className="tabs-wrap">
        <Segmented variant="tabs" label="Courses" value={view} onChange={(next) => navigate(next === 'threads' ? { name: 'threads' } : { name: 'courses' }, { replace: true })} options={VIEWS} />
      </div>
      {view === 'threads' ? <ThreadSearch /> : <CourseSearch code={code} />}
    </div>
  );
}

interface Filters {
  q: string;
  term: string;
  subject: string;
  open: boolean;
  core: boolean;
  time: TimeOfDay;
}

function readFilters(search: URLSearchParams): Filters {
  const time = search.get('time') ?? '';
  return {
    q: search.get('q') ?? '',
    term: search.get('term') ?? '',
    subject: search.get('subject') ?? '',
    open: search.get('open') === '1',
    core: search.get('core') === '1',
    time: TIMES.some((entry) => entry.id === time) ? (time as TimeOfDay) : '',
  };
}

function writeFilters(filters: Filters): string {
  const search = new URLSearchParams();
  if (filters.q) search.set('q', filters.q);
  if (filters.term) search.set('term', filters.term);
  if (filters.subject) search.set('subject', filters.subject);
  if (filters.open) search.set('open', '1');
  if (filters.core) search.set('core', '1');
  if (filters.time) search.set('time', filters.time);
  return search.toString();
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Sections that say when the course meets: lectures and seminars, or everything when it has nothing else. */
function primary(sections: Section[]): Section[] {
  const live = sections.filter((section) => section.status !== 'cancelled');
  const main = live.filter((section) => !SECONDARY.test(section.component));
  return main.length ? main : live;
}

function seatsOf(sections: Section[]): SeatStatus {
  const main = primary(sections);
  if (main.length === 0) return 'cancelled';
  if (main.some((section) => section.status === 'open')) return 'open';
  if (main.some((section) => section.status === 'waitlist')) return 'waitlist';
  return 'closed';
}

function inTime(section: Section, time: TimeOfDay): boolean {
  return section.meetings.some((meeting) => {
    if (!meeting.start) return false;
    if (time === 'morning') return meeting.start < '12:00';
    if (time === 'afternoon') return meeting.start >= '12:00' && meeting.start < '17:00';
    return meeting.start >= '17:00';
  });
}

interface Indexed {
  row: CourseRow;
  code: string;
  title: string;
  people: string;
  text: string;
  seats: SeatStatus;
}

function indexRows(rows: CourseRow[]): Indexed[] {
  return rows.map((row) => ({
    row,
    code: fold(row.code).replace(/[^a-z0-9]/g, ''),
    title: fold(row.title),
    people: fold(row.sections.flatMap((section) => section.instructors).join(' ')),
    text: fold(`${row.description} ${row.sections.map((section) => section.topic).join(' ')}`),
    seats: seatsOf(row.sections),
  }));
}

/** Rows that pass the filters, best match first when there is a query: code, then title, then professor, then topic. */
function filterRows(rows: Indexed[], filters: Filters): CourseRow[] {
  const tokens = fold(filters.q).split(/\s+/).filter(Boolean);
  const scored: Array<{ row: CourseRow; score: number }> = [];
  for (const entry of rows) {
    const { row } = entry;
    if (filters.subject && row.subject !== filters.subject) continue;
    if (filters.core && !row.core) continue;
    if (filters.open && entry.seats !== 'open') continue;
    if (filters.time && !primary(row.sections).some((section) => inTime(section, filters.time))) continue;
    let score = 0;
    let missed = false;
    for (const token of tokens) {
      const squashed = token.replace(/[^a-z0-9]/g, '');
      const hit = (squashed && entry.code.includes(squashed) ? 8 : 0) + (entry.title.includes(token) ? 4 : 0) + (entry.people.includes(token) ? 3 : 0) + (entry.text.includes(token) ? 1 : 0);
      if (!hit) {
        missed = true;
        break;
      }
      score += hit;
    }
    if (!missed) scored.push({ row, score });
  }
  if (tokens.length) scored.sort((a, b) => b.score - a.score || a.row.code.localeCompare(b.row.code, undefined, { numeric: true }));
  return scored.map((entry) => entry.row);
}

function CourseSearch({ code }: { code?: string }) {
  const { search } = useRoute();
  const wide = useMedia(WIDE);
  const filters = readFilters(search);
  const [terms, setTerms] = useState<{ terms: Term[]; current: string; scraped: string } | null>(null);
  const [rows, setRows] = useState<{ term: string; courses: CourseRow[] } | null>(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_ROWS);
  const term = filters.term || terms?.current || '';

  useEffect(() => {
    api.courses
      .terms()
      .then(setTerms)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the course list.'));
  }, []);

  useEffect(() => {
    if (!term) return;
    let live = true;
    setRows(null);
    api.courses
      .list(term)
      .then((result) => live && setRows(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the course list.'));
    return () => {
      live = false;
    };
  }, [term]);

  const set = (patch: Partial<Filters>) => {
    setLimit(PAGE_ROWS);
    navigate(code ? { name: 'courses', code } : { name: 'courses' }, { replace: true, keepScroll: true, search: writeFilters({ ...filters, ...patch }) });
  };

  const indexed = useMemo(() => indexRows(rows?.courses ?? []), [rows]);
  const subjects = useMemo(() => [...new Set((rows?.courses ?? []).map((row) => row.subject))].sort(), [rows]);
  const shown = useMemo(() => filterRows(indexed, filters), [indexed, filters.q, filters.subject, filters.core, filters.open, filters.time]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = Boolean(filters.q || filters.subject || filters.core || filters.open || filters.time);
  const listSearch = writeFilters(filters);

  const open = (next: string) => navigate({ name: 'courses', code: next }, { search: listSearch, keepScroll: true, state: { fromList: true } });
  const close = useCallback(() => {
    if ((window.history.state as { fromList?: boolean } | null)?.fromList) window.history.back();
    else navigate({ name: 'courses' }, { replace: true, keepScroll: true, search: listSearch });
  }, [listSearch]);
  const byInstructor = (name: string) => navigate({ name: 'courses' }, { replace: true, search: writeFilters({ ...filters, q: name, subject: '', open: false, core: false, time: '' }) });

  return (
    <div className="md">
      <div>
        <div className="course-controls">
          <div className="search-field big">
            <IconSearch />
            <input
              className="input"
              type="search"
              value={filters.q}
              onChange={(event) => set({ q: event.target.value })}
              placeholder="Code, title, professor or topic"
              aria-label="Search courses"
              enterKeyHint="search"
            />
          </div>
          <div className="filter-row">
            <select className="input chip-select" value={term} onChange={(event) => set({ term: event.target.value === terms?.current ? '' : event.target.value })} aria-label="Term" disabled={!terms}>
              {(terms?.terms ?? []).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                  {entry.name === terms?.current ? ' (now)' : ''}
                </option>
              ))}
            </select>
            <select className={`input chip-select${filters.subject ? ' on' : ''}`} value={filters.subject} onChange={(event) => set({ subject: event.target.value })} aria-label="Subject">
              <option value="">All subjects</option>
              {subjects.map((subject) => (
                <option key={subject} value={subject}>
                  {subject}
                </option>
              ))}
            </select>
            <button type="button" className={`chip${filters.open ? ' on' : ''}`} aria-pressed={filters.open} onClick={() => set({ open: !filters.open })}>
              Open seats
            </button>
            <button type="button" className={`chip${filters.core ? ' on' : ''}`} aria-pressed={filters.core} onClick={() => set({ core: !filters.core })}>
              Core
            </button>
            <select className={`input chip-select${filters.time ? ' on' : ''}`} value={filters.time} onChange={(event) => set({ time: event.target.value as TimeOfDay })} aria-label="Time of day">
              {TIMES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        {!rows && !error && (
          <div className="stack" aria-busy="true">
            <div className="skeleton" style={{ height: 92 }} />
            <div className="skeleton" style={{ height: 92 }} />
            <div className="skeleton" style={{ height: 92 }} />
          </div>
        )}
        {rows && (
          <div className="results-head">
            <span className="faint small">
              {filtered ? `${plural(shown.length, 'course')} of ${rows.courses.length}` : `${plural(rows.courses.length, 'course')} in ${rows.term}`}
            </span>
            {filtered && (
              <button type="button" className="link-btn small" onClick={() => set({ q: '', subject: '', open: false, core: false, time: '' })}>
                Clear filters
              </button>
            )}
          </div>
        )}
        {rows && shown.length === 0 && <div className="empty">No course matches. Try fewer words, or another term.</div>}
        {rows && shown.length > 0 && (
          <div className="list course-list">
            {shown.slice(0, limit).map((row) => (
              <CourseItem key={row.code} row={row} selected={row.code === code} onOpen={open} />
            ))}
          </div>
        )}
        {rows && shown.length > limit && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => setLimit((current) => current + PAGE_ROWS * 2)}>
              Show more
            </button>
          </div>
        )}
      </div>
      <DetailSlot code={code} wide={wide} term={term} onClose={close} onInstructor={byInstructor}>
        <div className="pane-empty">
          <h2>Pick a course to see its sections, who taught it and what students say.</h2>
        </div>
      </DetailSlot>
    </div>
  );
}

function meetingText(section: Section | undefined): string {
  const meeting = section?.meetings.find((entry) => entry.start) ?? section?.meetings[0];
  if (!meeting) return '';
  return `${meeting.days.join('/') || 'TBA'}${meeting.start ? ` ${meeting.start}` : ''}`;
}

function people(sections: Section[]): string {
  const names = [...new Set(primary(sections).flatMap((section) => section.instructors))];
  if (names.length === 0) return '';
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!;
}

function CourseItem({ row, selected, onOpen }: { row: CourseRow; selected: boolean; onOpen(code: string): void }) {
  const seats = seatsOf(row.sections);
  const main = primary(row.sections);
  const meta = [meetingText(main[0]), people(row.sections), row.credits ? `${row.credits} credits` : ''].filter(Boolean);
  return (
    <a
      href={`/courses/${encodeURIComponent(row.code)}`}
      className={`row course-item${selected ? ' on' : ''}`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen(row.code);
      }}
    >
      <span className="course-top">
        <span className="code">{row.code}</span>
        {row.core && <span className="tag">Core</span>}
        <span className={`seats ${seats}`}>{SEAT_LABEL[seats]}</span>
      </span>
      <span className="course-title">{row.title}</span>
      {meta.length > 0 && <span className="course-meta">{meta.join(' · ')}</span>}
    </a>
  );
}

/** On wide screens the course sits in a pane beside the list; on narrow ones it opens as a sheet over it. */
function DetailSlot({ code, wide, term, onClose, onInstructor, children }: { code?: string; wide: boolean; term: string; onClose(): void; onInstructor(name: string): void; children: ReactNode }) {
  const panel = usePresence(Boolean(code) && !wide, 220);
  const shown = useLatest(code);
  if (wide) {
    return <aside className="md-pane">{code ? <Detail key={code} code={code} term={term} onClose={onClose} onInstructor={onInstructor} /> : children}</aside>;
  }
  return panel.mounted && shown ? (
    <Sheet label={shown} closing={panel.closing} onClose={onClose}>
      <Detail key={shown} code={shown} term={term} onClose={onClose} onInstructor={onInstructor} />
    </Sheet>
  ) : null;
}

/** A dialog over the page: the page behind goes inert, so focus and the screen reader stay in the sheet. */
function Sheet({ label, closing, onClose, children }: { label: string; closing: boolean; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (closing) return;
    const app = document.querySelector<HTMLElement>('.app');
    const before = document.activeElement as HTMLElement | null;
    app?.setAttribute('inert', '');
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      app?.removeAttribute('inert');
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, [closing, onClose]);
  return createPortal(
    <div className={closing ? 'closing' : undefined} data-line="guide">
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={ref} className="drawer" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </aside>
    </div>,
    document.body,
  );
}

const COMPONENT_ORDER = ['Lecture', 'Seminar', 'Studio', 'Workshop'];

function sortSections(sections: Section[]): Section[] {
  const rank = (section: Section) => {
    const index = COMPONENT_ORDER.indexOf(section.component);
    return index < 0 ? COMPONENT_ORDER.length : index;
  };
  return [...sections].sort((a, b) => Number(a.status === 'cancelled') - Number(b.status === 'cancelled') || rank(a) - rank(b) || a.section.localeCompare(b.section, undefined, { numeric: true }));
}

function Detail({ code, term, onClose, onInstructor }: { code: string; term: string; onClose(): void; onInstructor(name: string): void }) {
  const { setAskPrefill } = useApp();
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState('');

  useEffect(() => {
    let live = true;
    api.courses
      .detail(code)
      .then((result) => live && setDetail(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load this course.'));
    return () => {
      live = false;
    };
  }, [code]);

  const offered = detail?.offerings ?? [];
  // The term chosen in the list when the course runs then; otherwise the newest term it ran.
  const shownTerm = picked || (offered.some((entry) => entry.term === term) ? term : (offered[0]?.term ?? ''));
  const offering = offered.find((entry) => entry.term === shownTerm);
  // Albert repeats a course-wide note on every section; shown once above them instead.
  const notes = new Set(offering?.sections.map((section) => section.notes) ?? []);
  const shared = notes.size === 1 && offering!.sections.length > 1 ? [...notes][0]! : '';
  const taught = offered.map((entry) => ({ term: entry.term, names: [...new Set(entry.sections.filter((section) => section.status !== 'cancelled').flatMap((section) => section.instructors))] }));

  const ask = () => {
    if (!detail) return;
    setAskPrefill({ question: `What do students say about ${detail.code} ${detail.title}?`, autoSend: true });
    navigate({ name: 'ask' });
  };

  return (
    <>
      <div className="pane-head">
        <div className="grow">
          <div className="crumbs">
            <span className="code">{code}</span>
            {detail?.core && <span className="tag">Core</span>}
            {detail?.credits && <span className="tag">{detail.credits} credits</span>}
          </div>
          <h2>{detail?.title ?? (error ? code : 'Loading')}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" data-autofocus>
          <IconClose />
        </button>
      </div>
      <div className="pane-body">
        {error && <div className="alert error">{error}</div>}
        {!detail && !error && (
          <div className="stack" aria-busy="true">
            <div className="skeleton" style={{ height: 16, width: '60%' }} />
            <div className="skeleton" style={{ height: 110 }} />
            <div className="skeleton" style={{ height: 110 }} />
          </div>
        )}
        {detail && (
          <>
            <div className="detail-actions">
              <button type="button" className="btn sm primary" onClick={ask}>
                Ask about this course
              </button>
              {detail.bulletin && (
                <a className="btn sm" href={detail.bulletin.url} target="_blank" rel="noreferrer">
                  <IconExternal /> Bulletin
                </a>
              )}
            </div>

            {offered.length > 0 ? (
              <>
                <div className="section-title">
                  Sections
                  {offered.length > 1 ? null : <span>{shownTerm}</span>}
                </div>
                {offered.length > 1 && (
                  <div className="chips scroll-x term-chips">
                    {offered.map((entry) => (
                      <button key={entry.term} type="button" className={`chip${entry.term === shownTerm ? ' on' : ''}`} onClick={() => setPicked(entry.term)}>
                        {entry.term}
                        {entry.term === detail.current ? ' (now)' : ''}
                      </button>
                    ))}
                  </div>
                )}
                {term && !offered.some((entry) => entry.term === term) && !picked && <p className="pane-note">Not offered in {term}. Showing {shownTerm}.</p>}
                {shared && (
                  <div className="sec-note">
                    <Folded text={shared} lines={3} />
                  </div>
                )}
                <div className="sections">{offering && sortSections(offering.sections).map((section) => <SectionCard key={section.classNumber} section={section} showNotes={!shared} onInstructor={onInstructor} />)}</div>
              </>
            ) : (
              <p className="pane-note">Not in the Albert schedule we have.</p>
            )}

            <h3 className="section-title">What students say</h3>
            <StudentSide code={code} />

            {taught.length > 0 && (
              <>
                <h3 className="section-title">Who taught it</h3>
                <div className="taught">
                  {taught.map((entry) => (
                    <div key={entry.term} className="taught-row">
                      <span className="when">{entry.term}</span>
                      <span className="who">
                        {entry.names.length === 0
                          ? 'Cancelled'
                          : entry.names.map((name, index) => (
                              <span key={name}>
                                {index > 0 && ', '}
                                <button type="button" className="link-btn" onClick={() => onInstructor(name)}>
                                  {name}
                                </button>
                              </span>
                            ))}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {detail.description && (
              <>
                <h3 className="section-title">About</h3>
                <Folded text={detail.description} />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function SectionCard({ section, showNotes, onInstructor }: { section: Section; showNotes: boolean; onInstructor(name: string): void }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(section.classNumber);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Could not copy');
    }
  };
  return (
    <div className={`sec${section.status === 'cancelled' ? ' cancelled' : ''}`}>
      <div className="sec-top">
        <b>
          {section.component} {section.section}
        </b>
        {section.session && <span className="tag">{section.session}</span>}
        <span className={`seats ${section.status}`}>
          {SEAT_LABEL[section.status]}
          {section.status === 'waitlist' && section.waitlist ? ` · ${section.waitlist}` : ''}
        </span>
      </div>
      {section.topic && <div className="sec-topic">{section.topic}</div>}
      {section.meetings.length === 0 ? (
        <div className="sec-when faint">No meeting times listed</div>
      ) : (
        section.meetings.map((meeting, index) => (
          <div key={index} className="sec-when">
            <b>{meeting.days.join(' ') || 'TBA'}</b>
            {meeting.start && (
              <span className="time">
                {meeting.start}–{meeting.end}
              </span>
            )}
            {meeting.room && <span className="room">{meeting.room}</span>}
          </div>
        ))
      )}
      <div className="sec-foot">
        <span className="sec-who">
          {section.instructors.length === 0
            ? 'Instructor not listed'
            : section.instructors.map((name, index) => (
                <span key={name}>
                  {index > 0 && ', '}
                  <button type="button" className="link-btn" onClick={() => onInstructor(name)}>
                    {name}
                  </button>
                </span>
              ))}
        </span>
        <button type="button" className="class-no" onClick={() => void copy()} title="Copy the class number for Albert">
          #{section.classNumber} {copied ? <IconCheck className="pop-in" /> : <IconCopy />}
        </button>
      </div>
      {showNotes && section.notes && <Folded text={section.notes} lines={2} />}
    </div>
  );
}

function Folded({ text, lines = 5 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 90;
  return (
    <div>
      <p className={`details${long && !open ? ' clamped' : ''}`} style={{ WebkitLineClamp: lines }}>
        {text}
      </p>
      {long && (
        <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}

const CONFIDENCE_LABEL = { medium: 'Partly sourced', low: 'Weakly sourced' };

/**
 * The group's threads about the course, then a summary of them written once per course and cached on the server. Both
 * load after the schedule, so a course opens at once.
 */
function StudentSide({ code }: { code: string }) {
  const [threads, setThreads] = useState<PostSummary[] | null>(null);
  const [summary, setSummary] = useState<{ value: CourseSummary | null; done: boolean }>({ value: null, done: false });
  useEffect(() => {
    let live = true;
    api.courses
      .threads(code)
      .then((result) => {
        if (!live) return;
        setThreads(result.threads);
        if (result.threads.length === 0) return setSummary({ value: null, done: true });
        return api.courses.summary(code).then((next) => live && setSummary({ value: next.summary, done: true }));
      })
      .catch(() => {
        if (!live) return;
        setThreads((current) => current ?? []);
        setSummary({ value: null, done: true });
      });
    return () => {
      live = false;
    };
  }, [code]);
  if (threads === null) return <Lines />;
  if (threads.length === 0) return <p className="pane-note">Nobody in the group has written about this course.</p>;
  return (
    <>
      {!summary.done ? <Lines /> : summary.value && <Summary summary={summary.value} />}
      <div className="thread-list">
        {threads.map((post) => (
          <PostRow key={post.id} post={post} />
        ))}
      </div>
    </>
  );
}

function Lines() {
  return (
    <div className="stack" aria-busy="true">
      <div className="skeleton" style={{ height: 14, width: '90%' }} />
      <div className="skeleton" style={{ height: 14, width: '75%' }} />
      <div className="skeleton" style={{ height: 14, width: '82%' }} />
    </div>
  );
}

function Summary({ summary }: { summary: CourseSummary }) {
  const { sources } = summary;
  const cite = (text: string) =>
    text.split(/(\[\d+(?:\]\[\d+)*\])/).map((part, index) => {
      if (!/^\[\d/.test(part)) return part;
      const numbers = [...new Set(part.match(/\d+/g) ?? [])];
      return numbers.map((n) => {
        const source = sources.find((entry) => entry.n === Number(n));
        const href = !source ? undefined : source.kind === 'official' ? source.url : `/post/${source.postId}`;
        return (
          <a
            key={`${index}-${n}`}
            className="cite"
            data-kind={source?.kind ?? 'archive'}
            title={source?.title}
            href={href}
            target={source?.kind === 'official' ? '_blank' : undefined}
            rel={source?.kind === 'official' ? 'noreferrer' : undefined}
            onClick={(event) => {
              if (!source || source.kind === 'official') return;
              event.preventDefault();
              navigate({ name: 'post', id: source.postId! });
            }}
          >
            {n}
          </a>
        );
      });
    });
  const sections: Array<[string, string[]]> = [
    ['From students', summary.students],
    ['Rules to know', summary.facts],
    ['Keep in mind', summary.keepInMind],
  ];
  return (
    <div className="summary">
      {summary.overview && <p className="overview">{cite(summary.overview)}</p>}
      {sections
        .filter(([, lines]) => lines.length > 0)
        .map(([heading, lines]) => (
          <div key={heading}>
            <h4>{heading}</h4>
            <ul>
              {lines.map((line, i) => (
                <li key={i}>{cite(line)}</li>
              ))}
            </ul>
          </div>
        ))}
      {summary.confidence !== 'high' && (
        <div className="meta">
          <span className={`pill confidence ${summary.confidence}`}>
            <span className="dot" /> {CONFIDENCE_LABEL[summary.confidence]}
          </span>
        </div>
      )}
    </div>
  );
}
