import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { courseWords } from '../../../lib/plan-request.ts';
import { api, onRecount, type CourseEntry, type CourseReview, type CourseView, type ProfView, type ScoreIndex } from '../api';
import { AdminRemove } from '../components/AdminRemove';
import { HARDNESS, RateSheet, SCALE, StarPick, type RateTarget } from '../components/Rate';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { plural, relativeDate } from '../format';
import { IconClose, IconSearch, IconStar } from '../icons';
import { useLatest, useMedia, usePresence } from '../motion';
import { navigate, useRoute } from '../router';
import { loadPlanned } from '../store';

const WIDE = '(min-width: 1240px)';
const PAGE_ROWS = 40;

/* ---------- One search over courses and professors ---------- */

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

const squash = (text: string) => fold(text).replace(/[^a-z0-9]/g, '');

/** What students call courses besides their titles. */
function nicknames(title: string): string {
  return [/multivariable calculus/i.test(title) ? 'mvc multivar' : '', /^calculus/i.test(title) ? 'calc' : '', /economics/i.test(title) ? 'econ' : '', /linear algebra/i.test(title) ? 'linalg lin alg' : '', /introduction to computer science/i.test(title) ? 'ics intro cs' : '', /data structures/i.test(title) ? 'ds' : ''].join(' ');
}

interface Entry {
  kind: 'course' | 'prof';
  /** The course code or the professor's name: what the page is opened by. */
  id: string;
  title: string;
  /** Course codes a professor taught, or who taught a course lately. */
  related: string[];
  /** An Abu Dhabi course, or a professor who taught one: what students here mean first. */
  local: boolean;
  /** titleWords: the title as the Plan reads it, so "cso", "probs and stats" and "French 1" find their courses here too. */
  search: { code: string; words: string; titleWords: string[]; aliases: string; related: string };
}

interface Hit {
  entry: Entry;
  rank: number;
}

/** Every course and every professor once, ready to search. */
function useEntries(courses: CourseEntry[] | null, scores: ScoreIndex | null): Entry[] {
  return useMemo(() => {
    const out: Entry[] = [];
    const taught = new Map<string, string[]>();
    for (const course of courses ?? []) {
      out.push({ kind: 'course', id: course.code, title: course.title, local: course.code.includes('-UH '), related: course.currentPeople.length ? course.currentPeople : course.people.slice(0, 3), search: { code: squash(course.code), words: ` ${fold(course.title)}`, titleWords: courseWords(course.title), aliases: fold(nicknames(course.title)), related: fold(course.people.join(' ')) } });
      for (const person of course.people) taught.set(person, [...(taught.get(person) ?? []), course.code]);
    }
    for (const name of Object.keys(scores?.profs ?? {})) if (!taught.has(name)) taught.set(name, []);
    for (const [name, codes] of taught) out.push({ kind: 'prof', id: name, title: name, local: !codes.length || codes.some((code) => code.includes('-UH ')), related: [...codes].sort((a, b) => Number(b.includes('-UH ')) - Number(a.includes('-UH '))), search: { code: '', words: ` ${fold(name)}`, titleWords: [], aliases: '', related: squash(codes.join(' ')) } });
    return out;
  }, [courses, scores]);
}

function scoreOf(entry: Entry, scores: ScoreIndex | null): { score: number; basis: number; verdict: string } | undefined {
  return entry.kind === 'course' ? scores?.courses[entry.id] : scores?.profs[entry.id];
}

/**
 * Courses and professors ranked together: every word must match somewhere; a code, a nickname or the start of a name
 * counts most, Abu Dhabi courses and their professors come before other campuses', and between equal matches the more
 * rated comes first. With no words, the most rated of both.
 */
function rank(entries: Entry[], query: string, scores: ScoreIndex | null): Hit[] {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  const whole = squash(query);
  const hits: Hit[] = [];
  for (const entry of entries) {
    const rated = scoreOf(entry, scores);
    if (!tokens.length) {
      if (rated) hits.push({ entry, rank: rated.basis });
      continue;
    }
    let total = 0;
    let missed = false;
    for (const token of tokens) {
      const bare = token.replace(/[^a-z0-9]/g, '');
      const said = courseWords(token);
      const hit = Math.max(
        bare && entry.search.code.includes(bare) ? 8 : 0,
        entry.search.words.includes(` ${token}`) ? (entry.kind === 'prof' ? 7 : 5) : entry.search.words.includes(token) ? 3 : 0,
        entry.search.aliases.split(' ').includes(token) ? 6 : 0,
        entry.kind === 'course' && said.length && said.every((word) => entry.search.titleWords.includes(word)) ? 5 : 0,
        bare.length > 2 && entry.search.related.includes(bare.length > 3 ? bare : ` ${bare}`) ? 1 : 0,
        entry.kind === 'course' && entry.search.related.includes(token) ? 1 : 0,
      );
      if (!hit) {
        missed = true;
        break;
      }
      total += hit;
    }
    if (missed) continue;
    if (entry.search.code && entry.search.code === whole) total += 30;
    if (squash(entry.title) === whole) total += entry.kind === 'prof' ? 30 : 10;
    else if (entry.search.words.startsWith(` ${tokens.join(' ')}`)) total += 3;
    if (entry.local) total += 6;
    hits.push({ entry, rank: total + Math.min(0.9, Math.log2(1 + (rated?.basis ?? 0)) * 0.25) });
  }
  return hits.sort((a, b) => b.rank - a.rank || a.entry.id.localeCompare(b.entry.id, undefined, { numeric: true }));
}

type Open = { kind: 'course'; id: string } | { kind: 'prof'; id: string };

/** Courses and professors as students rate them, in the Room of Requirement and in ratings written here. */
export function CoursesPage({ code, professor }: { code?: string; professor?: string }) {
  const { search } = useRoute();
  const wide = useMedia(WIDE);
  const query = search.get('q') ?? '';
  const [courses, setCourses] = useState<CourseEntry[] | null>(null);
  const [scores, setScores] = useState<ScoreIndex | null>(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_ROWS);
  const [, setTick] = useState(0);

  useEffect(() => {
    api.courses.all().then((result) => setCourses(result.courses)).catch((err) => setError(err instanceof Error ? err.message : 'Could not load the courses.'));
    api.courses.scores().then(setScores).catch(() => setScores({ courses: {}, profs: {} }));
  }, []);
  // A rating written anywhere lands in the shared score list a moment later: show it.
  useEffect(() => onRecount(() => window.setTimeout(() => setTick((tick) => tick + 1), 0)), []);

  const entries = useEntries(courses, scores);
  const hits = useMemo(() => rank(entries, query, scores), [entries, query, scores]); // eslint-disable-line react-hooks/exhaustive-deps
  const open: Open | null = code ? { kind: 'course', id: code } : professor ? { kind: 'prof', id: professor } : null;
  const listSearch = query ? `q=${encodeURIComponent(query)}` : '';

  const setQuery = (next: string) => {
    setLimit(PAGE_ROWS);
    navigate(code ? { name: 'courses', code } : professor ? { name: 'professors', nameQuery: professor } : { name: 'courses' }, { replace: true, keepScroll: true, search: next ? `q=${encodeURIComponent(next)}` : '' });
  };
  const show = (next: Open) => navigate(next.kind === 'course' ? { name: 'courses', code: next.id } : { name: 'professors', nameQuery: next.id }, { search: listSearch, keepScroll: true, state: { fromList: true } });
  const close = useCallback(() => {
    if ((window.history.state as { fromList?: boolean } | null)?.fromList) window.history.back();
    else navigate({ name: 'courses' }, { replace: true, keepScroll: true, search: listSearch });
  }, [listSearch]);

  return (
    <div className="page reviews-page">
      <Sign title="Reviews" ar="التقييمات" sub="Every course and professor at NYUAD, rated by students: from the Room of Requirement and from ratings here." />
      <div className="md">
        <div>
          <div className="course-controls">
            <div className="search-field big">
              <IconSearch />
              <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Course, code, nickname or professor" aria-label="Search courses and professors" enterKeyHint="search" />
            </div>
          </div>
          {error && <div className="alert error">{error}</div>}
          {!courses && !error && (
            <div className="stack" aria-busy="true">
              <div className="skeleton" style={{ height: 72 }} />
              <div className="skeleton" style={{ height: 72 }} />
              <div className="skeleton" style={{ height: 72 }} />
            </div>
          )}
          {courses && hits.length === 0 && <div className="empty">{query ? 'Nothing matches. Try a code like CS-UH 1001, or fewer words.' : 'No ratings yet.'}</div>}
          {hits.length > 0 && (
            <>
              {!query && <p className="results-label">Most rated</p>}
              <div className="list course-list">
                {hits.slice(0, limit).map(({ entry }) => (
                  <ResultRow key={`${entry.kind}:${entry.id}`} entry={entry} rated={scoreOf(entry, scores)} selected={open?.kind === entry.kind && open.id === entry.id} onOpen={() => show({ kind: entry.kind, id: entry.id })} />
                ))}
              </div>
            </>
          )}
          {hits.length > limit && (
            <div className="load-more">
              <button type="button" className="btn" onClick={() => setLimit((current) => current + PAGE_ROWS * 2)}>
                Show more
              </button>
            </div>
          )}
        </div>
        <DetailSlot open={open} wide={wide} onClose={close} />
      </div>
    </div>
  );
}

function ResultRow({ entry, rated, selected, onOpen }: { entry: Entry; rated?: { score: number; basis: number; verdict: string }; selected: boolean; onOpen(): void }) {
  const href = entry.kind === 'course' ? `/courses/${encodeURIComponent(entry.id)}` : `/professors/${encodeURIComponent(entry.id)}`;
  const related = entry.related.slice(0, 3).join(', ');
  return (
    <a
      href={href}
      className={`row course-item${selected ? ' on' : ''}`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <span className="course-main">
        <span className="course-top">
          {entry.kind === 'course' ? <span className="code">{entry.id}</span> : <span className="tag prof-tag">Professor</span>}
          {related && <span className="course-sub">{entry.kind === 'course' ? related : `Teaches ${related}`}</span>}
        </span>
        <span className="course-title">{entry.title}</span>
        <span className={`result-verdict${rated?.verdict ? '' : ' none'}`}>{rated?.verdict || 'No ratings yet'}</span>
      </span>
      <span className="course-scores">{rated && <ScoreBadge score={rated.score} label={`Rated ${rated.score.toFixed(1)} from ${plural(rated.basis, 'rating')}`} />}</span>
    </a>
  );
}

function tone(score: number): string {
  return score >= 4 ? 'good' : score >= 3 ? 'mixed' : 'poor';
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

/* ---------- The page beside the list, or over it on a phone ---------- */

function DetailSlot({ open, wide, onClose }: { open: Open | null; wide: boolean; onClose(): void }) {
  const panel = usePresence(Boolean(open) && !wide, 220);
  const shown = useLatest(open ?? undefined);
  const page = (which: Open) => (which.kind === 'course' ? <CourseDetail key={`c:${which.id}`} code={which.id} onClose={onClose} /> : <ProfDetail key={`p:${which.id}`} name={which.id} onClose={onClose} />);
  if (wide) {
    return (
      <aside className="md-pane">
        {open ? page(open) : (
          <div className="pane-empty">
            <span className="pane-empty-mark" aria-hidden="true" />
            <h2>Pick a course or a professor</h2>
            <p>See how students rate it, who teaches it, and what people who took it said.</p>
          </div>
        )}
      </aside>
    );
  }
  return panel.mounted && shown ? (
    <Sheet label={shown.id} closing={panel.closing} onClose={onClose}>
      {page(shown)}
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
    // A rating sheet open over this one takes Escape for itself.
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !document.querySelector('.modal-scrim') && onClose();
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

function PaneHead({ crumbs, title, onClose }: { crumbs: ReactNode; title: ReactNode; onClose(): void }) {
  return (
    <div className="pane-head">
      <div className="grow">
        <div className="crumbs">{crumbs}</div>
        <h2>{title}</h2>
      </div>
      <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" data-autofocus>
        <IconClose />
      </button>
    </div>
  );
}

const loadingTitle = <span className="skeleton" style={{ display: 'block', height: 26, width: '70%' }} />;

/** Reviews written here, kept fresh when this browser rates something. */
function useReviews(load: () => Promise<{ reviews: CourseReview[] }>, key: string, matches: (code: string) => boolean) {
  const [reviews, setReviews] = useState<CourseReview[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => onRecount((code) => matches(code) && setVersion((value) => value + 1)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true;
    load().then((result) => live && setReviews(result.reviews)).catch(() => live && setReviews([]));
    return () => {
      live = false;
    };
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return reviews;
}

function CourseDetail({ code, onClose }: { code: string; onClose(): void }) {
  const { setAskPrefill, toast } = useApp();
  const [view, setView] = useState<CourseView | null>(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState<RateTarget | null>(null);
  const reviews = useReviews(() => api.board.reviews(code), code, (changed) => changed === code);

  useEffect(() => {
    let live = true;
    api.courses.view(code).then((result) => live && setView(result)).catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load this course.'));
    return () => {
      live = false;
    };
  }, [code]);
  // A rating written here moves the score at once, from the recount the server sends back.
  useEffect(() => onRecount((changed, result) => {
    if (changed !== code || result.course === undefined) return;
    setView((current) => current && {
      ...current,
      rating: result.course ?? null,
      professors: current.professors.map((entry) => {
        const recounted = result.profs?.[entry.name];
        const part = result.course?.professors.find((item) => item.name === entry.name);
        return {
          ...entry,
          ...(recounted === undefined ? {} : { score: recounted?.score ?? null, basis: recounted?.basis ?? 0 }),
          here: part ? { score: part.score, count: part.positive + part.negative + part.neutral } : null,
        };
      }),
    });
  }), [code]);

  const mine = reviews?.find((review) => review.mine);
  const remove = async () => {
    try {
      await api.board.unreview(code);
      toast('Rating removed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove it.');
    }
  };
  const ask = () => {
    if (!view) return;
    setAskPrefill({ question: `What do students say about ${view.code} ${view.title}?`, autoSend: true });
    navigate({ name: 'ask' });
  };

  return (
    <>
      <PaneHead onClose={onClose} title={view?.title ?? (error ? code : loadingTitle)} crumbs={<>
        <span className="code">{code}</span>
        {view?.core && <span className="tag">Core</span>}
        {view?.credits && <span className="tag">{view.credits} credits</span>}
      </>} />
      <div className="pane-body">
        {error && <div className="alert error">{error}</div>}
        {!view && !error && <SummaryLoading />}
        {view && (
          <>
            <Summary
              rating={view.rating && { score: view.rating.score, basis: view.rating.basis, verdict: view.rating.verdict, likes: view.rating.pros, warnings: view.rating.cons, difficulty: view.rating.difficulty, workload: view.rating.workload }}
              empty="Nobody has rated this course yet."
              onRate={(stars) => setRating({ code, stars })}
              mine={Boolean(mine)}
            />
            <div className="detail-actions">
              <button type="button" className="btn sm primary" onClick={() => setRating({ code })}>
                {mine ? 'Change your rating' : 'Rate this course'}
              </button>
              <button type="button" className="btn sm" onClick={() => navigate({ name: 'plan' }, { search: `add=${encodeURIComponent(view.code)}` })}>
                Add to a plan
              </button>
              <button type="button" className="btn sm ghost" onClick={ask}>
                Ask about it
              </button>
            </div>
            {view.professors.length > 0 && (
              <section className="detail-section" aria-label="Professors">
                <h3>Professors</h3>
                <div className="teacher-list">
                  {view.professors.map((entry) => {
                    const score = entry.here?.score ?? entry.score;
                    return (
                      <a key={entry.name} href={`/professors/${encodeURIComponent(entry.name)}`} onClick={(event) => {
                        event.preventDefault();
                        navigate({ name: 'professors', nameQuery: entry.name }, { search: window.location.search.slice(1), keepScroll: true, state: { fromList: true } });
                      }}>
                        <span className="teacher-main">
                          <span>{entry.name}</span>
                          <small>
                            {[entry.teachingNow ? `Teaching ${view.currentTerm}` : entry.lastTerm ? `Last taught ${entry.lastTerm}` : '', entry.here ? `${entry.here.score.toFixed(1)} in this course from ${plural(entry.here.count, 'rating')}` : entry.score !== null ? `${entry.score.toFixed(1)} overall` : 'Not rated yet'].filter(Boolean).join(' · ')}
                          </small>
                        </span>
                        {score !== null && <ScoreBadge score={score} label={`${score.toFixed(1)} out of 5`} />}
                      </a>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
        <ReviewList reviews={reviews} title="Ratings from students here" show="professor" onEdit={() => setRating({ code })} onRemove={() => void remove()} />
        {view?.description && (
          <details className="detail-section about">
            <summary>About the course</summary>
            <p>{view.description}</p>
          </details>
        )}
      </div>
      <RateSheet target={rating} onClose={() => setRating(null)} />
    </>
  );
}

function ProfDetail({ name, onClose }: { name: string; onClose(): void }) {
  const { setAskPrefill } = useApp();
  const [view, setView] = useState<ProfView | null>(null);
  const [error, setError] = useState('');
  const [rating, setRating] = useState<RateTarget | null>(null);
  // Any rating this browser writes may name them, whichever course it is for: their list is read again.
  const reviews = useReviews(() => api.board.profReviews(name), name, () => true);

  useEffect(() => {
    let live = true;
    api.courses.prof(name).then((result) => live && setView(result)).catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load this professor.'));
    return () => {
      live = false;
    };
  }, [name]);
  useEffect(() => onRecount((code, result) => {
    const recounted = result.profs?.[view?.name ?? name];
    setView((current) => current && {
      ...current,
      rating: recounted === undefined ? current.rating : recounted,
      courses: current.courses.map((course) => (course.code === code && result.course !== undefined ? { ...course, score: result.course?.score ?? null } : course)),
    });
  }), [name, view?.name]);

  // Rating them goes through a course they taught up to now, this term's first.
  const rateable = (view?.courses ?? []).filter((course) => course.terms.length > 0);
  const rate = (stars?: number) => {
    if (!rateable.length) return;
    // The course the student planned with them, if they did; else the one they taught most recently.
    const planned = Object.values(loadPlanned()).flatMap((courses) => Object.entries(courses)).find(([code, profs]) => profs.includes(view!.name) && rateable.some((course) => course.code === code))?.[0];
    setRating({ code: planned ?? rateable[0]!.code, stars, prof: { name: view!.name, courses: rateable } });
  };
  const ask = () => {
    setAskPrefill({ question: `What do students say about Professor ${view?.name ?? name}?`, autoSend: true });
    navigate({ name: 'ask' });
  };
  const now = view?.courses.filter((course) => course.teachingNow) ?? [];
  const before = view?.courses.filter((course) => !course.teachingNow) ?? [];

  return (
    <>
      <PaneHead onClose={onClose} title={view?.name ?? name} crumbs={<span className="tag prof-tag">Professor</span>} />
      <div className="pane-body">
        {error && <div className="alert error">{error}</div>}
        {!view && !error && <SummaryLoading />}
        {view && (
          <>
            <Summary
              rating={view.rating && { score: view.rating.score, basis: view.rating.basis, verdict: view.rating.verdict, likes: view.rating.likes, warnings: view.rating.warnings, difficulty: null, workload: null }}
              empty={`Nobody has rated ${view.name} yet.`}
              onRate={rateable.length ? (stars) => rate(stars) : undefined}
              mine={Boolean(reviews?.some((review) => review.mine))}
            />
            <div className="detail-actions">
              {rateable.length > 0 && (
                <button type="button" className="btn sm primary" onClick={() => rate()}>
                  Rate {view.name.split(' ')[0]}
                </button>
              )}
              <button type="button" className="btn sm ghost" onClick={ask}>
                Ask about them
              </button>
            </div>
            {[{ label: `Teaching ${view.currentTerm}`, list: now }, { label: now.length ? 'Taught before' : 'Teaches', list: before }].filter((group) => group.list.length).map((group) => (
              <section key={group.label} className="detail-section" aria-label={group.label}>
                <h3>{group.label}</h3>
                <div className="teacher-list">
                  {group.list.map((course) => {
                    const score = course.here?.score ?? course.score;
                    return (
                      <a key={course.code} href={`/courses/${encodeURIComponent(course.code)}`} onClick={(event) => {
                        event.preventDefault();
                        navigate({ name: 'courses', code: course.code }, { search: window.location.search.slice(1), keepScroll: true, state: { fromList: true } });
                      }}>
                        <span className="teacher-main">
                          <span><b className="code">{course.code}</b> {course.title}</span>
                          <small>
                            {[course.teachingNow ? '' : course.lastTerm ? `Last taught ${course.lastTerm}` : '', course.here ? `${course.here.score.toFixed(1)} with ${view.name.split(' ')[0]} from ${plural(course.here.count, 'rating')}` : course.score !== null ? `${course.score.toFixed(1)} overall` : 'Not rated yet'].filter(Boolean).join(' · ')}
                          </small>
                        </span>
                        {score !== null && <ScoreBadge score={score} label={`${score.toFixed(1)} out of 5`} />}
                      </a>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}
        <ReviewList reviews={reviews} title="Ratings from students here" show="course" profName={view?.name ?? name} onEdit={(code) => rateable.length && setRating({ code, prof: { name: view!.name, courses: rateable } })} onRemove={undefined} />
      </div>
      <RateSheet target={rating} onClose={() => setRating(null)} />
    </>
  );
}

/* ---------- The digest, and the ratings written here ---------- */

interface Summed {
  score: number;
  basis: number;
  verdict: string;
  likes: string[];
  warnings: string[];
  difficulty: number | null;
  workload: number | null;
}

/** The score, the verdict, how hard and how heavy, and what students liked and warned about. */
function Summary({ rating, empty, onRate, mine }: { rating: Summed | null; empty: string; onRate?(stars: number): void; mine: boolean }) {
  if (!rating) {
    return (
      <div className="rating-none rate-first">
        <p>{empty}{onRate ? ' Took it? Be the first:' : ''}</p>
        {onRate && <StarPick value={null} onChange={onRate} size={26} />}
      </div>
    );
  }
  return (
    <div className="rating">
      <div className="rating-head">
        <div className={`rating-score ${tone(rating.score)}`} aria-label={`Rated ${rating.score} out of 5`}>
          <b>{rating.score.toFixed(1)}</b>
          <StarRow value={rating.score} />
        </div>
        <div className="rating-copy">
          {rating.verdict && <p className="rating-verdict">{rating.verdict}</p>}
          <p className="rating-basis">From {plural(rating.basis, 'student rating')}{mine ? ', yours among them' : ''}.</p>
        </div>
      </div>
      {(rating.difficulty || rating.workload) && (
        <div className="meters">
          {rating.difficulty ? <Meter label="Difficulty" value={rating.difficulty} word={HARDNESS[rating.difficulty]!} /> : null}
          {rating.workload ? <Meter label="Workload" value={rating.workload} word={SCALE[rating.workload]!} /> : null}
        </div>
      )}
      {(rating.likes.length > 0 || rating.warnings.length > 0) && (
        <div className="rating-points">
          {rating.likes.slice(0, 3).map((point) => (
            <p key={`p-${point}`} className="point good">
              {point}
            </p>
          ))}
          {rating.warnings.slice(0, 3).map((point) => (
            <p key={`c-${point}`} className="point warn">
              {point}
            </p>
          ))}
        </div>
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

function SummaryLoading() {
  return (
    <div className="rating loading" aria-busy="true">
      <div className="rating-head">
        <div className="skeleton rating-skeleton" />
        <div className="stack" style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 14, width: '90%' }} />
          <div className="skeleton" style={{ height: 14, width: '70%' }} />
        </div>
      </div>
    </div>
  );
}

function ReviewList({ reviews, title, show, profName, onEdit, onRemove }: { reviews: CourseReview[] | null; title: string; show: 'professor' | 'course'; profName?: string; onEdit(code: string): void; onRemove?(): void }) {
  if (reviews === null) return <div className="skeleton" style={{ height: 72, marginBottom: 26 }} />;
  if (!reviews.length) return null;
  const mine = reviews.filter((review) => review.mine);
  const others = reviews.filter((review) => !review.mine);
  return (
    <section className="detail-section reviews" aria-label={title}>
      <h3>
        {title} <span className="muted">({reviews.length})</span>
      </h3>
      {[...mine, ...others].map((review) => (
        <ReviewCard key={review.id} review={review} show={show} stars={show === 'course' && profName ? review.profRating ?? review.rating : review.rating} onEdit={review.mine ? () => onEdit(review.code) : undefined} onRemove={review.mine ? onRemove : undefined} />
      ))}
    </section>
  );
}

function ReviewCard({ review, show, stars, onEdit, onRemove }: { review: CourseReview; show: 'professor' | 'course'; stars: number | null; onEdit?(): void; onRemove?(): void }) {
  return (
    <article className={`review-card${review.mine ? ' mine' : ''}`}>
      <div className="review-top">
        {stars ? (
          <span className="review-stars" role="img" aria-label={`${stars} out of 5`}>
            <StarRow value={stars} />
          </span>
        ) : null}
        {show === 'course' && <span className="code">{review.code}</span>}
        {show === 'professor' && review.professor && review.profRating ? <span className="tag">{review.professor.split(' ')[0]}: {review.profRating}★</span> : null}
        {review.difficulty ? <span className="tag">{HARDNESS[review.difficulty]}</span> : null}
        {review.workload ? <span className="tag">{SCALE[review.workload]} work</span> : null}
        <span className="spacer" />
        {!review.mine && <AdminRemove type="review" id={review.id} label={review.text || `${review.rating ?? review.profRating} stars`} compact />}
      </div>
      {review.text && <p className="review-text">{review.text}</p>}
      <div className="review-by">
        {review.mine ? 'You' : review.authorName}
        {review.authorMajor ? `, ${review.authorMajor}` : ''}
        {show === 'professor' && review.professor ? ` · with ${review.professor}` : ''}
        {review.term ? ` · ${review.term}` : ''} · {relativeDate(review.updatedAt)}
        {review.mine && (
          <>
            {' '}
            {onEdit && (
              <button type="button" className="link-btn" onClick={onEdit}>
                Edit
              </button>
            )}{' '}
            {onRemove && (
              <button type="button" className="link-btn danger" onClick={onRemove}>
                Remove
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}
