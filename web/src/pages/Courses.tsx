import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type CourseDetail, type CourseEntry, type CourseRating } from '../api';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { IconClose, IconSearch } from '../icons';
import { useLatest, useMedia, usePresence } from '../motion';
import { navigate, useRoute } from '../router';
import { ThreadSearch } from './Threads';

type View = 'courses' | 'threads';

const WIDE = '(min-width: 1240px)';
const PAGE_ROWS = 60;
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'courses', label: 'Courses' },
  { id: 'threads', label: 'Group threads' },
];

/** Every course, and for the one you pick, what students make of it; the group's own threads beside them. */
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
  subject: string;
  core: boolean;
}

function readFilters(search: URLSearchParams): Filters {
  return { q: search.get('q') ?? '', subject: search.get('subject') ?? '', core: search.get('core') === '1' };
}

function writeFilters(filters: Filters): string {
  const search = new URLSearchParams();
  if (filters.q) search.set('q', filters.q);
  if (filters.subject) search.set('subject', filters.subject);
  if (filters.core) search.set('core', '1');
  return search.toString();
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

interface Indexed {
  course: CourseEntry;
  code: string;
  title: string;
  people: string;
}

/** Courses that pass the filters, best match first when there is a query: code, then title, then who taught it. */
function filterCourses(rows: Indexed[], filters: Filters): CourseEntry[] {
  const tokens = fold(filters.q).split(/\s+/).filter(Boolean);
  const scored: Array<{ course: CourseEntry; score: number }> = [];
  for (const entry of rows) {
    if (filters.subject && entry.course.subject !== filters.subject) continue;
    if (filters.core && !entry.course.core) continue;
    let score = 0;
    let missed = false;
    for (const token of tokens) {
      const squashed = token.replace(/[^a-z0-9]/g, '');
      const hit = (squashed && entry.code.includes(squashed) ? 8 : 0) + (entry.title.includes(token) ? 4 : 0) + (entry.people.includes(token) ? 2 : 0);
      if (!hit) {
        missed = true;
        break;
      }
      score += hit;
    }
    if (!missed) scored.push({ course: entry.course, score });
  }
  if (tokens.length) scored.sort((a, b) => b.score - a.score || a.course.code.localeCompare(b.course.code, undefined, { numeric: true }));
  return scored.map((entry) => entry.course);
}

function CourseSearch({ code }: { code?: string }) {
  const { search } = useRoute();
  const wide = useMedia(WIDE);
  const filters = readFilters(search);
  const [courses, setCourses] = useState<CourseEntry[] | null>(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_ROWS);

  useEffect(() => {
    api.courses
      .all()
      .then((result) => setCourses(result.courses))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the courses.'));
  }, []);

  const set = (patch: Partial<Filters>) => {
    setLimit(PAGE_ROWS);
    navigate(code ? { name: 'courses', code } : { name: 'courses' }, { replace: true, keepScroll: true, search: writeFilters({ ...filters, ...patch }) });
  };

  const indexed = useMemo(() => (courses ?? []).map((course) => ({ course, code: fold(course.code).replace(/[^a-z0-9]/g, ''), title: fold(course.title), people: fold(course.people.join(' ')) })), [courses]);
  const subjects = useMemo(() => [...new Set((courses ?? []).map((course) => course.subject))].sort(), [courses]);
  const shown = useMemo(() => filterCourses(indexed, filters), [indexed, filters.q, filters.subject, filters.core]); // eslint-disable-line react-hooks/exhaustive-deps
  const listSearch = writeFilters(filters);

  const open = (next: string) => navigate({ name: 'courses', code: next }, { search: listSearch, keepScroll: true, state: { fromList: true } });
  const close = useCallback(() => {
    if ((window.history.state as { fromList?: boolean } | null)?.fromList) window.history.back();
    else navigate({ name: 'courses' }, { replace: true, keepScroll: true, search: listSearch });
  }, [listSearch]);

  return (
    <div className="md">
      <div>
        <div className="course-controls">
          <div className="search-field big">
            <IconSearch />
            <input className="input" type="search" value={filters.q} onChange={(event) => set({ q: event.target.value })} placeholder="Course code, title or professor" aria-label="Search courses" enterKeyHint="search" />
          </div>
          <div className="filter-row">
            <select className={`input chip-select${filters.subject ? ' on' : ''}`} value={filters.subject} onChange={(event) => set({ subject: event.target.value })} aria-label="Subject" disabled={!courses}>
              <option value="">All subjects</option>
              {subjects.map((subject) => (
                <option key={subject} value={subject}>
                  {subject}
                </option>
              ))}
            </select>
            <button type="button" className={`chip${filters.core ? ' on' : ''}`} aria-pressed={filters.core} onClick={() => set({ core: !filters.core })}>
              Core
            </button>
            {(filters.q || filters.subject || filters.core) && (
              <button type="button" className="chip" onClick={() => set({ q: '', subject: '', core: false })}>
                Clear
              </button>
            )}
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        {!courses && !error && (
          <div className="stack" aria-busy="true">
            <div className="skeleton" style={{ height: 64 }} />
            <div className="skeleton" style={{ height: 64 }} />
            <div className="skeleton" style={{ height: 64 }} />
          </div>
        )}
        {courses && courses.length === 0 && <div className="empty">The course list has not been loaded on this server yet.</div>}
        {courses && courses.length > 0 && shown.length === 0 && <div className="empty">No course matches. Try fewer words.</div>}
        {shown.length > 0 && (
          <div className="list course-list">
            {shown.slice(0, limit).map((course) => (
              <CourseItem key={course.code} course={course} selected={course.code === code} onOpen={open} />
            ))}
          </div>
        )}
        {shown.length > limit && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => setLimit((current) => current + PAGE_ROWS * 2)}>
              Show more
            </button>
          </div>
        )}
      </div>
      <DetailSlot code={code} wide={wide} onClose={close}>
        <div className="pane-empty">
          <h2>Pick a course to see how students rate it.</h2>
        </div>
      </DetailSlot>
    </div>
  );
}

function CourseItem({ course, selected, onOpen }: { course: CourseEntry; selected: boolean; onOpen(code: string): void }) {
  return (
    <a
      href={`/courses/${encodeURIComponent(course.code)}`}
      className={`row course-item${selected ? ' on' : ''}`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen(course.code);
      }}
    >
      <span className="course-top">
        <span className="code">{course.code}</span>
        {course.core && <span className="tag">Core</span>}
      </span>
      <span className="course-title">{course.title}</span>
    </a>
  );
}

/** On wide screens the course sits in a pane beside the list; on narrow ones it opens as a sheet over it. */
function DetailSlot({ code, wide, onClose, children }: { code?: string; wide: boolean; onClose(): void; children: ReactNode }) {
  const panel = usePresence(Boolean(code) && !wide, 220);
  const shown = useLatest(code);
  if (wide) {
    return <aside className="md-pane">{code ? <Detail key={code} code={code} onClose={onClose} /> : children}</aside>;
  }
  return panel.mounted && shown ? (
    <Sheet label={shown} closing={panel.closing} onClose={onClose}>
      <Detail key={shown} code={shown} onClose={onClose} />
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

function Detail({ code, onClose }: { code: string; onClose(): void }) {
  const { setAskPrefill } = useApp();
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [rating, setRating] = useState<{ value: CourseRating | null; done: boolean; failed: boolean }>({ value: null, done: false, failed: false });
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.courses
      .detail(code)
      .then((result) => live && setDetail(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load this course.'));
    api.courses
      .rating(code)
      .then((result) => live && setRating({ value: result.rating, done: true, failed: false }))
      .catch(() => live && setRating({ value: null, done: true, failed: true }));
    return () => {
      live = false;
    };
  }, [code]);

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
        {error ? (
          <div className="alert error">{error}</div>
        ) : !rating.done ? (
          <RatingLoading />
        ) : rating.value ? (
          <Rating rating={rating.value} />
        ) : (
          <p className="rating-none">{rating.failed ? 'The rating could not be written right now. Try again in a minute.' : 'Not enough students have written about this course to rate it yet.'}</p>
        )}
        {detail && (
          <div className="detail-actions">
            <button type="button" className="btn sm primary" onClick={() => navigate({ name: 'plan' }, { search: `add=${encodeURIComponent(detail.code)}` })}>
              Add to a plan
            </button>
            <button type="button" className="btn sm" onClick={ask}>
              Ask about it
            </button>
          </div>
        )}
        {detail?.description && (
          <>
            <h3 className="section-title">About</h3>
            <Folded text={detail.description} />
          </>
        )}
      </div>
    </>
  );
}

const LEVELS: Record<'difficulty' | 'workload', string[]> = {
  difficulty: ['Easy', 'Fairly easy', 'Moderate', 'Hard', 'Very hard'],
  workload: ['Light', 'Fairly light', 'Moderate', 'Heavy', 'Very heavy'],
};

/** The score as one big number with five stops filling to it, the verdict, two meters and what students said. */
function Rating({ rating }: { rating: CourseRating }) {
  const groups: Array<{ label: string; tone: string; items: string[] }> = [
    { label: 'Students liked', tone: 'ok', items: rating.pros },
    { label: 'Watch out for', tone: 'alert', items: rating.cons },
    { label: 'Tips', tone: 'info', items: rating.tips },
  ];
  return (
    <div className="rating">
      <div className="rating-head">
        <div className="rating-score" aria-label={`Rated ${rating.score} out of 5`}>
          <b>{rating.score.toFixed(1)}</b>
          <span className="rating-stops" aria-hidden="true">
            {[1, 2, 3, 4, 5].map((stop) => (
              <i key={stop} style={{ '--fill': `${Math.round(Math.min(1, Math.max(0, rating.score - stop + 1)) * 100)}%` } as React.CSSProperties} />
            ))}
          </span>
        </div>
        {rating.verdict && <p className="rating-verdict">{rating.verdict}</p>}
      </div>
      {(rating.difficulty || rating.workload) && (
        <div className="rating-meters">
          {(['difficulty', 'workload'] as const).map((kind) =>
            rating[kind] ? (
              <div key={kind} className="meter">
                <span className="meter-label">{kind === 'difficulty' ? 'Difficulty' : 'Workload'}</span>
                <span className="meter-bar" aria-hidden="true">
                  {[1, 2, 3, 4, 5].map((step) => (
                    <i key={step} className={step <= rating[kind]! ? 'on' : undefined} />
                  ))}
                </span>
                <b>{LEVELS[kind][rating[kind]! - 1]}</b>
              </div>
            ) : null,
          )}
        </div>
      )}
      {groups
        .filter((group) => group.items.length > 0)
        .map((group) => (
          <div key={group.label} className={`rating-points tone-${group.tone}`}>
            <h4>{group.label}</h4>
            <ul>
              {group.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      <p className="rating-basis">
        AI rating from {rating.basis === 1 ? 'one student' : `${rating.basis} students`} in the group{rating.confidence === 'low' ? ', so take it lightly' : ''}.
      </p>
    </div>
  );
}

function RatingLoading() {
  return (
    <div className="rating" aria-busy="true">
      <div className="rating-head">
        <div className="skeleton" style={{ height: 64, width: 120 }} />
        <div className="stack" style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 14, width: '90%' }} />
          <div className="skeleton" style={{ height: 14, width: '70%' }} />
        </div>
      </div>
      <div className="skeleton" style={{ height: 14, width: '80%' }} />
      <div className="skeleton" style={{ height: 14, width: '85%' }} />
      <div className="skeleton" style={{ height: 14, width: '60%' }} />
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
