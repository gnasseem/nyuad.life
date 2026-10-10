import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type CourseDetail, type CourseEntry, type CourseRating, type CourseReview, type ProfRating, type ScoreIndex } from '../api';
import { AdminRemove } from '../components/AdminRemove';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural, relativeDate } from '../format';
import { IconClose, IconSearch, IconStar } from '../icons';
import { useLatest, useMedia, usePresence } from '../motion';
import { navigate, useRoute } from '../router';

type View = 'courses' | 'professors';
type Sort = 'match' | 'top' | 'reviewed' | 'code';

const WIDE = '(min-width: 1240px)';
const PAGE_ROWS = 60;
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'courses', label: 'Courses' },
  { id: 'professors', label: 'Professors' },
];
const SORTS: Array<{ id: Sort; label: string }> = [
  { id: 'match', label: 'Best match' },
  { id: 'top', label: 'Top rated' },
  { id: 'reviewed', label: 'Most reviewed' },
  { id: 'code', label: 'By code' },
];
const SCALE = ['', 'Very light', 'Light', 'Moderate', 'Heavy', 'Very heavy'];
const HARDNESS = ['', 'Easy', 'Manageable', 'Moderate', 'Hard', 'Very hard'];

/** Every score written so far, loaded once a session and shared by both lists. */
function useScores(): ScoreIndex | null {
  const [scores, setScores] = useState<ScoreIndex | null>(null);
  useEffect(() => {
    api.courses
      .scores()
      .then(setScores)
      .catch(() => setScores({ courses: {}, profs: {}, students: {} }));
  }, []);
  return scores;
}

/** Courses and professors as students rate them: from the group's threads, and from reviews written here. */
export function CoursesPage({ view, code, professor }: { view: View; code?: string; professor?: string }) {
  const scores = useScores();
  return (
    <div className="page reviews-page">
      <Sign title="Reviews" ar="التقييمات" sub="Every course and professor in Albert, rated from what students said in the Room of Requirement and in reviews here.">
        <Segmented label="Reviews" value={view} onChange={(next) => navigate(next === 'professors' ? { name: 'professors' } : { name: 'courses' }, { replace: true })} options={VIEWS} />
      </Sign>
      {view === 'professors' ? <ProfessorSearch name={professor} scores={scores} /> : <CourseSearch code={code} scores={scores} />}
    </div>
  );
}

interface Filters {
  q: string;
  subject: string;
  core: boolean;
  rated: boolean;
  sort: Sort;
}

function readFilters(search: URLSearchParams): Filters {
  const sort = search.get('sort') as Sort | null;
  return { q: search.get('q') ?? '', subject: search.get('subject') ?? '', core: search.get('core') === '1', rated: search.get('rated') === '1', sort: sort && SORTS.some((entry) => entry.id === sort) ? sort : 'match' };
}

function writeFilters(filters: Filters): string {
  const search = new URLSearchParams();
  if (filters.q) search.set('q', filters.q);
  if (filters.subject) search.set('subject', filters.subject);
  if (filters.core) search.set('core', '1');
  if (filters.rated) search.set('rated', '1');
  if (filters.sort !== 'match') search.set('sort', filters.sort);
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

/** What a course is rated, all told: the AI score and students' own reviews, weighted by how many each rests on. */
function blended(scores: ScoreIndex | null, code: string): { score: number; n: number } | null {
  const ai = scores?.courses[code];
  const own = scores?.students[code];
  if (!ai && !own) return null;
  const aiWeight = ai ? Math.max(1, Math.min(ai.basis, 6)) : 0;
  const ownWeight = own?.n ?? 0;
  return { score: ((ai?.score ?? 0) * aiWeight + (own?.avg ?? 0) * ownWeight) / (aiWeight + ownWeight), n: (ai?.basis ?? 0) + ownWeight };
}

/** Courses that pass the filters, in the chosen order; best match first when there is a query. */
function filterCourses(rows: Indexed[], filters: Filters, scores: ScoreIndex | null): CourseEntry[] {
  const tokens = fold(filters.q).split(/\s+/).filter(Boolean);
  const scored: Array<{ course: CourseEntry; score: number }> = [];
  for (const entry of rows) {
    if (filters.subject && entry.course.subject !== filters.subject) continue;
    if (filters.core && !entry.course.core) continue;
    if (filters.rated && !blended(scores, entry.course.code)) continue;
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
  const byCode = (a: { course: CourseEntry }, b: { course: CourseEntry }) => a.course.code.localeCompare(b.course.code, undefined, { numeric: true });
  const rating = (code: string) => blended(scores, code);
  if (filters.sort === 'top') scored.sort((a, b) => (rating(b.course.code)?.score ?? 0) - (rating(a.course.code)?.score ?? 0) || (rating(b.course.code)?.n ?? 0) - (rating(a.course.code)?.n ?? 0) || byCode(a, b));
  else if (filters.sort === 'reviewed') scored.sort((a, b) => (rating(b.course.code)?.n ?? 0) - (rating(a.course.code)?.n ?? 0) || byCode(a, b));
  else if (filters.sort === 'code' || !tokens.length) scored.sort(byCode);
  else scored.sort((a, b) => b.score - a.score || byCode(a, b));
  return scored.map((entry) => entry.course);
}

function tone(score: number): string {
  return score >= 4 ? 'good' : score >= 3 ? 'mixed' : 'poor';
}

function CourseSearch({ code, scores }: { code?: string; scores: ScoreIndex | null }) {
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
  const shown = useMemo(() => filterCourses(indexed, filters, scores), [indexed, filters.q, filters.subject, filters.core, filters.rated, filters.sort, scores]); // eslint-disable-line react-hooks/exhaustive-deps
  const rated = useMemo(() => (courses ?? []).filter((course) => blended(scores, course.code)).length, [courses, scores]);
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
            <select className={`input chip-select${filters.sort !== 'match' ? ' on' : ''}`} value={filters.sort} onChange={(event) => set({ sort: event.target.value as Sort })} aria-label="Order">
              {SORTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <select className={`input chip-select${filters.subject ? ' on' : ''}`} value={filters.subject} onChange={(event) => set({ subject: event.target.value })} aria-label="Subject" disabled={!courses}>
              <option value="">All subjects</option>
              {subjects.map((subject) => (
                <option key={subject} value={subject}>
                  {subject}
                </option>
              ))}
            </select>
            <button type="button" className={`chip${filters.rated ? ' on' : ''}`} aria-pressed={filters.rated} onClick={() => set({ rated: !filters.rated })}>
              Rated{rated ? <span className="n">{rated}</span> : null}
            </button>
            <button type="button" className={`chip${filters.core ? ' on' : ''}`} aria-pressed={filters.core} onClick={() => set({ core: !filters.core })}>
              Core
            </button>
            {(filters.q || filters.subject || filters.core || filters.rated || filters.sort !== 'match') && (
              <button type="button" className="chip" onClick={() => set({ q: '', subject: '', core: false, rated: false, sort: 'match' })}>
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
              <CourseItem key={course.code} course={course} scores={scores} selected={course.code === code} onOpen={open} />
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
          <span className="pane-empty-mark" aria-hidden="true" />
          <h2>Pick a course</h2>
          <p>See how students rate it, who teaches it this term, and what people who took it wrote here.</p>
        </div>
      </DetailSlot>
    </div>
  );
}

/** A score as a station roundel: the ring takes the colour of how good it is. */
function ScoreBadge({ score, label }: { score: number; label: string }) {
  return (
    <span className={`score-badge ${tone(score)}`} title={label} aria-label={label}>
      {score.toFixed(1)}
    </span>
  );
}

/** Five stars filled to a score out of five. */
function StarRow({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span className="star-row" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((stop) => (
        <IconStar key={stop} amount={value - stop + 1} width={size} height={size} />
      ))}
    </span>
  );
}

function CourseItem({ course, scores, selected, onOpen }: { course: CourseEntry; scores: ScoreIndex | null; selected: boolean; onOpen(code: string): void }) {
  const ai = scores?.courses[course.code];
  const own = scores?.students[course.code];
  // A rating already written is free to read: start fetching it as the pointer arrives, so the pane opens filled in.
  const warm = () => {
    if (ai) void api.courses.rating(course.code).catch(() => null);
  };
  return (
    <a
      href={`/courses/${encodeURIComponent(course.code)}`}
      className={`row course-item${selected ? ' on' : ''}`}
      onPointerEnter={warm}
      onFocus={warm}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen(course.code);
      }}
    >
      <span className="course-main">
        <span className="course-top">
          <span className="code">{course.code}</span>
          {course.core && <span className="tag">Core</span>}
        </span>
        <span className="course-title">{course.title}</span>
        {(ai?.difficulty || ai?.workload || course.people.length > 0) && (
          <span className="course-sub">
            {[ai?.difficulty ? HARDNESS[ai.difficulty] : '', ai?.workload ? `${SCALE[ai.workload]!.toLowerCase()} work` : '', course.people.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
      <span className="course-scores">
        {own && (
          <span className="own-score" title={`${own.avg.toFixed(1)} from ${plural(own.n, 'review')} here`}>
            <IconStar width={13} height={13} /> {own.avg.toFixed(1)} <small>({own.n})</small>
          </span>
        )}
        {ai && <ScoreBadge score={ai.score} label={`Rated ${ai.score.toFixed(1)} from ${plural(ai.basis, 'student')} in the group`} />}
      </span>
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
  const [teachers, setTeachers] = useState<Map<string, ProfRating | null>>(new Map());
  const [teacherPending, setTeacherPending] = useState(false);
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

  useEffect(() => {
    if (!detail?.instructors.length) return;
    let live = true;
    let timer: number | undefined;
    const load = async (attempt: number) => {
      try {
        const result = await api.courses.profs(detail.instructors);
        if (!live) return;
        setTeachers(result.ratings);
        setTeacherPending(result.pending.length > 0 && attempt < 4);
        if (result.pending.length && attempt < 4) timer = window.setTimeout(() => void load(attempt + 1), 2500);
      } catch {
        if (live) setTeacherPending(false);
      }
    };
    setTeacherPending(true);
    void load(0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [detail]);

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
          <h2>{detail?.title ?? (error ? code : <span className="skeleton" style={{ display: 'block', height: 26, width: '70%' }} />)}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" data-autofocus>
          <IconClose />
        </button>
      </div>
      <div className="pane-body">
        {detail && (
          <div className="detail-actions">
            <button type="button" className="btn sm primary" onClick={() => navigate({ name: 'plan' }, { search: `add=${encodeURIComponent(detail.code)}` })}>
              Add to a plan
            </button>
            <button type="button" className="btn sm" onClick={ask}>
              Ask about it
            </button>
            <a className="btn sm ghost" href="#write-review" onClick={(event) => { event.preventDefault(); document.getElementById('write-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
              Write a review
            </a>
          </div>
        )}
        {error ? (
          <div className="alert error">{error}</div>
        ) : !rating.done ? (
          <RatingLoading />
        ) : rating.value ? (
          <Rating rating={rating.value} />
        ) : (
          <p className="rating-none">{rating.failed ? 'The rating could not be written right now. Try again in a minute.' : 'Nobody in the group has described taking this course yet. If you took it, your review below would be the first.'}</p>
        )}
        <StudentReviews code={code} />
        {detail && (
          <section className="detail-section" aria-label={`Professors this ${detail.currentTerm}`}>
            <h3>Teaching this {detail.currentTerm}</h3>
            {detail.instructors.length ? (
              <div className="teacher-list">
                {detail.instructors.map((name) => {
                  const score = teachers.get(name);
                  return (
                    <a
                      key={name}
                      href={`/professors/${encodeURIComponent(name)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate({ name: 'professors', nameQuery: name });
                      }}
                    >
                      <span>{name}</span>
                      {score ? <ScoreBadge score={score.score} label={`${score.score.toFixed(1)} out of 5`} /> : <small>{teacherPending && !teachers.has(name) ? 'Reading…' : 'No rating yet'}</small>}
                    </a>
                  );
                })}
              </div>
            ) : (
              <p className="muted">Albert does not list this course in {detail.currentTerm}.</p>
            )}
          </section>
        )}
        {detail?.description && (
          <details className="detail-section about">
            <summary>About the course</summary>
            <p>{detail.description}</p>
          </details>
        )}
      </div>
    </>
  );
}

/** A rating: the score, the verdict, how hard and how heavy, and what students liked and warned about. */
function Rating({ rating }: { rating: CourseRating }) {
  return (
    <div className="rating">
      <div className="rating-head">
        <div className={`rating-score ${tone(rating.score)}`} aria-label={`Rated ${rating.score} out of 5`}>
          <b>{rating.score.toFixed(1)}</b>
          <StarRow value={rating.score} />
        </div>
        <div className="rating-copy">
          {rating.verdict && <p className="rating-verdict">{rating.verdict}</p>}
        </div>
      </div>
      {(rating.difficulty || rating.workload) && (
        <div className="meters">
          {rating.difficulty ? <Meter label="Difficulty" value={rating.difficulty} word={HARDNESS[rating.difficulty]!} /> : null}
          {rating.workload ? <Meter label="Workload" value={rating.workload} word={SCALE[rating.workload]!} /> : null}
        </div>
      )}
      {(rating.pros.length > 0 || rating.cons.length > 0) && (
        <div className="rating-points">
          {rating.pros.slice(0, 3).map((point) => (
            <p key={`p-${point}`} className="point good">
              {point}
            </p>
          ))}
          {rating.cons.slice(0, 3).map((point) => (
            <p key={`c-${point}`} className="point warn">
              {point}
            </p>
          ))}
        </div>
      )}
      <p className="rating-basis">
        AI summary of {rating.basis === 1 ? 'one student' : `${rating.basis} students`} in the Room of Requirement{rating.confidence === 'low' ? ', so take it lightly' : ''}.
      </p>
      {rating.sources?.length > 0 && (
        <details className="rating-evidence">
          <summary>Read the threads ({rating.sources.length})</summary>
          {rating.sources.map((source, index) => (
            <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
              <b>{source.date || 'Undated'}</b> {source.excerpt.slice(0, 140)}
            </a>
          ))}
        </details>
      )}
    </div>
  );
}

function Meter({ label, value, word }: { label: string; value: number; word: string }) {
  return (
    <div className="meter" aria-label={`${label}: ${word}`}>
      <span>{label}</span>
      <span className="meter-bars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((stop) => (
          <i key={stop} className={stop <= value ? 'on' : undefined} />
        ))}
      </span>
      <b>{word}</b>
    </div>
  );
}

/** While a rating is read or written: the first person to open a course waits for it to be written, once. */
function RatingLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="rating loading" aria-busy="true">
      <div className="rating-head">
        <div className="skeleton rating-skeleton" />
        <div className="stack" style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 14, width: '90%' }} />
          <div className="skeleton" style={{ height: 14, width: '70%' }} />
        </div>
      </div>
      <p className="rating-basis" role="status">
        <span className="spinner" aria-hidden="true" /> {slow ? 'Nobody has opened this one yet, so its rating is being written from the threads. It is saved for everyone after this.' : 'Reading what students wrote about it…'}
      </p>
    </div>
  );
}

/** Reviews written here by students who took the course, and the form to write or change your own. */
function StudentReviews({ code }: { code: string }) {
  const { profile, toast } = useApp();
  const [reviews, setReviews] = useState<CourseReview[] | null>(null);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.board
      .reviews(code)
      .then((result) => {
        if (!live) return;
        setReviews(result.reviews);
        setOpen(result.open !== false);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load reviews.'));
    return () => {
      live = false;
    };
  }, [code]);
  const mine = reviews?.find((review) => review.mine);
  const others = (reviews ?? []).filter((review) => !review.mine);
  const average = reviews?.length ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length : 0;

  const remove = async () => {
    try {
      await api.board.unreview(code);
      setReviews((current) => current?.filter((review) => !review.mine) ?? null);
      toast('Review removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it.');
    }
  };

  return (
    <section className="detail-section reviews" id="write-review" aria-label="Reviews from students here">
      <div className="reviews-head">
        <h3>Reviews from students here</h3>
      </div>
      {reviews && reviews.length > 0 && (
        <div className="review-summary">
          <div className="review-average">
            <b>{average.toFixed(1)}</b>
            <StarRow value={average} size={15} />
            <span>{plural(reviews.length, 'review')}</span>
          </div>
          <ul className="review-spread" aria-label="How students rated it">
            {[5, 4, 3, 2, 1].map((stars) => {
              const n = reviews.filter((review) => review.rating === stars).length;
              return (
                <li key={stars}>
                  <span>{stars}</span>
                  <span className="spread-bar" aria-hidden="true">
                    <i style={{ width: `${(n / reviews.length) * 100}%` }} />
                  </span>
                  <span className="spread-n">{n}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {error && <div className="alert error">{error}</div>}
      {profile && open && (editing || (reviews && !mine)) ? (
        <ReviewForm
          code={code}
          initial={mine}
          onCancel={mine ? () => setEditing(false) : undefined}
          onSaved={(review) => {
            setReviews((current) => [review, ...(current ?? []).filter((entry) => !entry.mine)]);
            setEditing(false);
            toast(mine ? 'Review updated' : 'Thanks. Your review helps the next student choose.');
          }}
        />
      ) : null}
      {mine && !editing && <ReviewCard review={mine} onEdit={() => setEditing(true)} onRemove={() => void remove()} />}
      {reviews === null && !error && <div className="skeleton" style={{ height: 72 }} />}
      {others.map((review) => (
        <ReviewCard key={review.id} review={review} />
      ))}
      {reviews && reviews.length === 0 && (!profile || !open) && <p className="muted small">No reviews here yet.</p>}
    </section>
  );
}

function ReviewCard({ review, onEdit, onRemove }: { review: CourseReview; onEdit?(): void; onRemove?(): void }) {
  return (
    <article className={`review-card${review.mine ? ' mine' : ''}`}>
      <div className="review-top">
        <span className="review-stars" role="img" aria-label={`${review.rating} out of 5`}>
          <StarRow value={review.rating} />
        </span>
        {review.difficulty ? <span className="tag">{HARDNESS[review.difficulty]}</span> : null}
        {review.workload ? <span className="tag">{SCALE[review.workload]} work</span> : null}
        <span className="spacer" />
        {!review.mine && <AdminRemove type="review" id={review.id} label={review.text || `${review.rating} stars`} compact />}
      </div>
      {review.text && <p className="review-text">{review.text}</p>}
      <div className="review-by">
        {review.mine ? 'You' : review.authorName}, {review.authorMajor}
        {review.term ? ` · took it ${review.term}` : ''} · {relativeDate(review.updatedAt)}
        {review.mine && (
          <>
            {' '}
            <button type="button" className="link-btn" onClick={onEdit}>
              Edit
            </button>{' '}
            <button type="button" className="link-btn danger" onClick={onRemove}>
              Remove
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function ReviewForm({ code, initial, onSaved, onCancel }: { code: string; initial?: CourseReview; onSaved(review: CourseReview): void; onCancel?(): void }) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [difficulty, setDifficulty] = useState<number | null>(initial?.difficulty ?? null);
  const [workload, setWorkload] = useState<number | null>(initial?.workload ?? null);
  const [text, setText] = useState(initial?.text ?? '');
  const [term, setTerm] = useState(initial?.term ?? '');
  const [terms, setTerms] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(Boolean(initial));
  useEffect(() => {
    api.courses
      .terms()
      .then((result) => setTerms(result.terms.map((entry) => entry.name).filter((name) => Date.parse(result.terms.find((entry) => entry.name === name)!.start) < Date.now())))
      .catch(() => setTerms([]));
  }, []);

  const save = async () => {
    if (!rating || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.review({ code, rating, difficulty, workload, text: text.trim(), term });
      onSaved(result.review);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your review.');
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="review-prompt">
        <span>Took this course?</span>
        <div className="star-pick" role="radiogroup" aria-label="Your rating">
          {[1, 2, 3, 4, 5].map((stop) => (
            <button
              key={stop}
              type="button"
              role="radio"
              aria-checked={rating === stop}
              aria-label={`${stop} out of 5`}
              onClick={() => {
                setRating(stop);
                setOpen(true);
              }}
            >
              <IconStar amount={0} width={24} height={24} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="review-form">
      <div className="review-row">
        <span>Your rating</span>
        <div className="star-pick" role="radiogroup" aria-label="Your rating">
          {[1, 2, 3, 4, 5].map((stop) => (
            <button key={stop} type="button" role="radio" aria-checked={rating === stop} className={stop <= rating ? 'on' : undefined} aria-label={`${stop} out of 5`} onClick={() => setRating(stop)}>
              <IconStar amount={stop <= rating ? 1 : 0} width={24} height={24} />
            </button>
          ))}
        </div>
      </div>
      <ScalePick label="Difficulty" words={HARDNESS} value={difficulty} onChange={setDifficulty} />
      <ScalePick label="Workload" words={SCALE} value={workload} onChange={setWorkload} />
      <label className="review-row">
        <span>When you took it</span>
        <select className="input" value={term} onChange={(event) => setTerm(event.target.value)}>
          <option value="">Not saying</option>
          {terms.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <textarea className="input" rows={3} maxLength={600} value={text} onChange={(event) => setText(event.target.value)} placeholder="What should the next student know? The exams, the problem sets, the teaching…" aria-label="Your review" />
      {error && <div className="alert error">{error}</div>}
      <div className="review-actions">
        <span className="faint small">Shown with your first name and major.</span>
        <span className="spacer" />
        {onCancel && (
          <button type="button" className="btn ghost sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn primary sm" onClick={() => void save()} disabled={!rating || busy}>
          {busy ? 'Saving' : initial ? 'Update review' : 'Post review'}
        </button>
      </div>
    </div>
  );
}

function ScalePick({ label, words, value, onChange }: { label: string; words: string[]; value: number | null; onChange(value: number | null): void }) {
  return (
    <div className="review-row">
      <span>{label}</span>
      <div className="scale-pick" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((stop) => (
          <button key={stop} type="button" role="radio" aria-checked={value === stop} className={value === stop ? 'on' : undefined} title={words[stop]} onClick={() => onChange(value === stop ? null : stop)}>
            {stop}
          </button>
        ))}
        <small>{value ? words[value] : 'Optional'}</small>
      </div>
    </div>
  );
}

function ProfessorSearch({ name, scores }: { name?: string; scores: ScoreIndex | null }) {
  const wide = useMedia(WIDE);
  const [query, setQuery] = useState('');
  const [top, setTop] = useState(false);
  const [courses, setCourses] = useState<CourseEntry[] | null>(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_ROWS);
  useEffect(() => {
    api.courses
      .all()
      .then((result) => setCourses(result.courses))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load professors.'));
  }, []);
  const people = useMemo(() => {
    const found = new Map<string, string[]>();
    for (const course of courses ?? []) {
      for (const person of course.people) found.set(person, [...(found.get(person) ?? []), course.code]);
    }
    return [...found].sort(([a], [b]) => a.localeCompare(b));
  }, [courses]);
  const words = fold(query).split(/\s+/).filter(Boolean);
  const shown = useMemo(() => {
    const matching = people.filter(([person, codes]) => (!top || scores?.profs[person]) && words.every((word) => fold(`${person} ${codes.join(' ')}`).includes(word)));
    if (top) matching.sort(([a], [b]) => (scores?.profs[b]?.score ?? 0) - (scores?.profs[a]?.score ?? 0) || (scores?.profs[b]?.basis ?? 0) - (scores?.profs[a]?.basis ?? 0));
    return matching;
  }, [people, words.join(' '), top, scores]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => navigate({ name: 'professors' }, { replace: true, keepScroll: true });
  const panel = usePresence(Boolean(name) && !wide, 220);
  const selected = useLatest(name);
  const detail = name ? (
    <ProfessorDetail key={name} name={name} courses={people.find(([person]) => person === name)?.[1] ?? []} onClose={close} />
  ) : (
    <div className="pane-empty">
      <span className="pane-empty-mark" aria-hidden="true" />
      <h2>Pick a professor</h2>
      <p>See how students describe their teaching, and what they teach.</p>
    </div>
  );
  return (
    <div className="md">
      <div>
        <div className="course-controls">
          <div className="search-field big">
            <IconSearch />
            <input
              className="input"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(PAGE_ROWS);
              }}
              placeholder="Professor name or course code"
              aria-label="Search professors"
            />
          </div>
          <div className="filter-row">
            <button type="button" className={`chip${top ? ' on' : ''}`} aria-pressed={top} onClick={() => setTop(!top)}>
              Rated, best first
            </button>
          </div>
        </div>
        {error && <div className="alert error">{error}</div>}
        {!courses && !error && <div className="skeleton" style={{ height: 180 }} />}
        {courses && shown.length === 0 && <div className="empty">No professor matches.</div>}
        {shown.length > 0 && (
          <div className="list course-list">
            {shown.slice(0, limit).map(([person, codes]) => {
              const score = scores?.profs[person];
              return (
                <a
                  key={person}
                  href={`/professors/${encodeURIComponent(person)}`}
                  className={`row course-item${person === name ? ' on' : ''}`}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                    event.preventDefault();
                    navigate({ name: 'professors', nameQuery: person }, { keepScroll: true });
                  }}
                >
                  <span className="course-main">
                    <span className="course-title">{person}</span>
                    <span className="muted small">{codes.slice(0, 3).join(' · ')}</span>
                  </span>
                  <span className="course-scores">{score && <ScoreBadge score={score.score} label={`Rated ${score.score.toFixed(1)} from ${plural(score.basis, 'student')}`} />}</span>
                </a>
              );
            })}
          </div>
        )}
        {shown.length > limit && (
          <div className="load-more">
            <button type="button" className="btn" onClick={() => setLimit((current) => current + PAGE_ROWS)}>
              Show more
            </button>
          </div>
        )}
      </div>
      {wide ? (
        <aside className="md-pane">{detail}</aside>
      ) : panel.mounted && selected ? (
        <Sheet label={selected} closing={panel.closing} onClose={close}>
          <ProfessorDetail key={selected} name={selected} courses={people.find(([person]) => person === selected)?.[1] ?? []} onClose={close} />
        </Sheet>
      ) : null}
    </div>
  );
}

function ProfessorDetail({ name, courses, onClose }: { name: string; courses: string[]; onClose(): void }) {
  const [rating, setRating] = useState<ProfRating | null | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    const load = async (attempt: number) => {
      try {
        const result = await api.courses.profs([name]);
        if (!live) return;
        if (result.pending.includes(name) && attempt < 3) timer = window.setTimeout(() => void load(attempt + 1), 2500);
        else if (result.pending.includes(name)) setError('The rating is taking longer than usual. Open this professor again in a minute.');
        else setRating(result.ratings.get(name) ?? null);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'Could not load the rating.');
      }
    };
    void load(0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [name]);
  return (
    <>
      <div className="pane-head">
        <div className="grow">
          <h2>{name}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" data-autofocus>
          <IconClose />
        </button>
      </div>
      <div className="pane-body">
        {error && <div className="alert error">{error}</div>}
        {rating === undefined && !error && <RatingLoading />}
        {rating === null && <p className="rating-none">Nobody in the group has described being taught by them yet.</p>}
        {rating && (
          <div className="rating">
            <div className="rating-head">
              <div className={`rating-score ${tone(rating.score)}`} aria-label={`Rated ${rating.score} out of 5`}>
                <b>{rating.score.toFixed(1)}</b>
                <StarRow value={rating.score} />
              </div>
              <div className="rating-copy">
                <p className="rating-verdict">{rating.verdict}</p>
              </div>
            </div>
            <p className="rating-basis">
              AI summary of {rating.basis === 1 ? 'one student' : `${rating.basis} students`} in the Room of Requirement{rating.confidence === 'low' ? ', so take it lightly' : ''}.
            </p>
            {rating.sources?.length > 0 && (
              <details className="rating-evidence">
                <summary>Read the threads ({rating.sources.length})</summary>
                {rating.sources.map((source, index) => (
                  <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
                    <b>{source.date || 'Undated'}</b> {source.excerpt.slice(0, 140)}
                  </a>
                ))}
              </details>
            )}
          </div>
        )}
        {courses.length > 0 && (
          <section className="detail-section">
            <h3>Teaches</h3>
            <div className="teacher-list">
              {courses.slice(0, 8).map((course) => (
                <a
                  key={course}
                  href={`/courses/${encodeURIComponent(course)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate({ name: 'courses', code: course });
                  }}
                >
                  <span>{course}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
