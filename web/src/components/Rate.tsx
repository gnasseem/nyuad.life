import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, onRecount, type CourseReview, type CourseView, type Profile, type Term } from '../api';
import { useApp } from '../context';
import { IconClose, IconStar } from '../icons';
import { useRoute } from '../router';
import { loadPlanned } from '../store';
import { Modal } from './Modal';

export const SCALE = ['', 'Very light', 'Light', 'Moderate', 'Heavy', 'Very heavy'];
export const HARDNESS = ['', 'Easy', 'Manageable', 'Moderate', 'Hard', 'Very hard'];

/** What to rate: a course, or a professor through one of the courses they taught. */
export interface RateTarget {
  code: string;
  /** Stars already chosen, from the prompt or a page's star row. */
  stars?: number;
  /** Rating a professor first: their name, and the courses of theirs to choose from. */
  prof?: { name: string; courses: Array<{ code: string; title: string; terms: string[] }> };
}

const today = () => new Date().toISOString().slice(0, 10);

/** The term a student most likely took a course in: the one they planned it for, else the latest that has begun. */
function defaultTerm(offered: string[], planned: string[], terms: Term[]): string {
  const started = (name: string) => {
    const term = terms.find((entry) => entry.name === name);
    return !term?.start || term.start <= today();
  };
  return offered.find((term) => planned.includes(term) && started(term)) ?? offered.find(started) ?? offered[0] ?? '';
}

/** Who taught them: the professor of the section they planned, else the only one teaching it that term. */
function defaultProfessor(teachers: string[], planned: string[]): string {
  return teachers.find((name) => planned.includes(name)) ?? (teachers.length === 1 ? teachers[0]! : '');
}

/** "last spring", "in Fall 2024": how long ago a term was, as a student would say it. */
export function whenTaken(term: string, terms: Term[]): string {
  const end = terms.find((entry) => entry.name === term)?.end;
  const [season] = term.split(' ');
  if (end && end <= today() && Date.parse(today()) - Date.parse(end) < 300 * 86_400_000) return season === 'January' ? 'in January' : `last ${season!.toLowerCase()}`;
  return `in ${term}`;
}

/**
 * Rating in a few taps: the stars first, then, all optional, who taught it and when (both filled in from the schedule
 * and the student's plan), the professor's own stars, difficulty, workload and one line. Rating a professor works the
 * same way, through the course they took with them.
 */
export function RateSheet({ target, onClose }: { target: RateTarget | null; onClose(): void }) {
  return (
    <Modal open={Boolean(target)} onClose={onClose} title={target?.prof ? `Rate ${target.prof.name}` : target ? `Rate ${target.code}` : ''} width={480}>
      {target && <RateForm key={`${target.code}|${target.prof?.name ?? ''}`} target={target} onClose={onClose} />}
    </Modal>
  );
}

function RateForm({ target, onClose }: { target: RateTarget; onClose(): void }) {
  const { profile, toast, requestProfile } = useApp();
  const prof = target.prof;
  const [code, setCode] = useState(target.code);
  const [view, setView] = useState<CourseView | null>(null);
  const [mine, setMine] = useState<CourseReview | null | undefined>();
  const [terms, setTerms] = useState<Term[]>([]);
  const [rating, setRating] = useState<number | null>(prof ? null : target.stars ?? null);
  const [profRating, setProfRating] = useState<number | null>(prof ? target.stars ?? null : null);
  const [term, setTerm] = useState('');
  const [professor, setProfessor] = useState(prof?.name ?? '');
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [workload, setWorkload] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.courses.terms().then((result) => setTerms(result.terms)).catch(() => undefined);
  }, []);

  // The course chosen: its terms and teachers, and the student's own review of it to start from.
  useEffect(() => {
    let live = true;
    setView(null);
    setMine(undefined);
    api.courses.view(code).then((result) => live && setView(result)).catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the course.'));
    api.board.reviews(code).then((result) => live && setMine(result.reviews.find((review) => review.mine) ?? null)).catch(() => live && setMine(null));
    return () => {
      live = false;
    };
  }, [code]);

  const planned = useMemo(() => Object.entries(loadPlanned()).filter(([, courses]) => courses[code]), [code]);
  const offered = useMemo(() => {
    const all = view?.offerings ?? [];
    return prof ? all.filter((offering) => offering.professors.includes(prof.name)) : all;
  }, [view, prof]);

  // Once both are in, fill in what is known: the student's own review, else the plan and the schedule.
  useEffect(() => {
    if (!view || mine === undefined) return;
    const chosen = mine?.term && offered.some((offering) => offering.term === mine.term) ? mine.term : defaultTerm(offered.map((offering) => offering.term), planned.map(([name]) => name), terms);
    setTerm(chosen);
    if (!prof) setProfessor(mine?.professor || defaultProfessor(offered.find((offering) => offering.term === chosen)?.professors ?? [], planned.find(([name]) => name === chosen)?.[1][code] ?? []));
    if (mine) {
      if (!prof && target.stars === undefined && mine.rating) setRating(mine.rating);
      if (prof && mine.rating) setRating(mine.rating);
      if (mine.profRating && (!prof || target.stars === undefined)) setProfRating(mine.profRating);
      setDifficulty(mine.difficulty);
      setWorkload(mine.workload);
      setText(mine.text);
      setAnonymous(mine.authorName === 'Anonymous');
    }
  }, [view, mine, terms.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const teachers = offered.find((offering) => offering.term === term)?.professors ?? [];
  const pickTerm = (next: string) => {
    setTerm(next);
    if (prof) return;
    const now = offered.find((offering) => offering.term === next)?.professors ?? [];
    if (!now.includes(professor)) setProfessor(defaultProfessor(now, planned.find(([name]) => name === next)?.[1][code] ?? []));
  };

  const ready = prof ? Boolean(profRating) : Boolean(rating);
  const save = async () => {
    if (!profile) {
      requestProfile({ title: 'Log in to rate', reason: 'Ratings come from NYU students: log in with your NYU email first. You can still post anonymously.' });
      return;
    }
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.board.review({ code, rating, profRating: professor ? profRating : null, difficulty, workload, text: text.trim(), term, professor, anonymous });
      const score = prof ? result.profs?.[prof.name]?.score : result.course?.score;
      toast(score ? `Thanks. ${prof ? prof.name : code} is now ${score.toFixed(1)}.` : 'Thanks. Your rating helps the next student choose.');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your rating.');
    } finally {
      setBusy(false);
    }
  };

  const first = prof?.name.split(' ')[0] ?? '';
  return (
    <div className="rate-form">
      <div className="rate-stars">
        <span>{prof ? `How was ${first} as a teacher?` : view ? `How was ${view.title}?` : 'How was it?'}</span>
        <StarPick value={prof ? profRating : rating} onChange={prof ? setProfRating : setRating} size={34} autofocus />
      </div>
      {prof && (
        <label className="review-row">
          <span>Course you took with {first}</span>
          <select className="input" value={code} onChange={(event) => setCode(event.target.value)}>
            {prof.courses.map((course) => <option key={course.code} value={course.code}>{course.code} {course.title}</option>)}
          </select>
        </label>
      )}
      {offered.length > 0 && (
        <label className="review-row">
          <span>When you took it</span>
          <select className="input" value={term} onChange={(event) => pickTerm(event.target.value)}>
            {offered.map((offering) => <option key={offering.term} value={offering.term}>{offering.term}</option>)}
            <option value="">Not saying</option>
          </select>
        </label>
      )}
      {!prof && (
        <label className="review-row">
          <span>Professor</span>
          <select className="input" value={professor} onChange={(event) => setProfessor(event.target.value)}>
            {[...new Set([...teachers, ...(professor && !teachers.includes(professor) ? [professor] : [])])].map((name) => <option key={name} value={name}>{name}</option>)}
            {(view?.professors ?? []).filter((entry) => !teachers.includes(entry.name) && entry.name !== professor && entry.lastTerm).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
            <option value="">Not saying</option>
          </select>
        </label>
      )}
      {!prof && professor && (
        <div className="review-row">
          <span>And {professor.split(' ')[0]}?</span>
          <StarPick value={profRating} onChange={setProfRating} size={24} />
        </div>
      )}
      {prof && (
        <div className="review-row">
          <span>And the course?</span>
          <StarPick value={rating} onChange={setRating} size={24} />
        </div>
      )}
      <ScalePick label="Difficulty" words={HARDNESS} value={difficulty} onChange={setDifficulty} />
      <ScalePick label="Workload" words={SCALE} value={workload} onChange={setWorkload} />
      <input className="input" maxLength={600} value={text} onChange={(event) => setText(event.target.value)} placeholder="One line for the next student (optional)" aria-label="One line about it" />
      <label className="check">
        <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /> Post anonymously
      </label>
      {error && <div className="alert error">{error}</div>}
      <div className="review-actions">
        <span className="spacer" />
        <button type="button" className="btn ghost sm" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary sm" onClick={() => void save()} disabled={!ready || busy}>
          {busy ? 'Saving' : mine ? 'Update rating' : 'Post rating'}
        </button>
      </div>
    </div>
  );
}

export function StarPick({ value, onChange, size = 24, autofocus = false }: { value: number | null; onChange(value: number): void; size?: number; autofocus?: boolean }) {
  return (
    <div className="star-pick" role="radiogroup" aria-label="Stars">
      {[1, 2, 3, 4, 5].map((stop) => (
        <button key={stop} type="button" role="radio" aria-checked={value === stop} className={value && stop <= value ? 'on' : undefined} aria-label={`${stop} out of 5`} data-autofocus={autofocus && stop === 1 ? true : undefined} onClick={() => onChange(stop)} style={{ width: size + 12, height: size + 12 }}>
          <IconStar amount={value && stop <= value ? 1 : 0} width={size} height={size} />
        </button>
      ))}
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

/* ---------- Asking students how a course went ---------- */

/** The Abu Dhabi subjects each major's own courses are in. */
const MAJOR_SUBJECTS: Record<string, string[]> = {
  'Arab Crossroads Studies': ['ACS'], 'Art and Art History': ['ARTH', 'VISAR'], Bioengineering: ['ENGR', 'BIOL'], Biology: ['BIOL'],
  'Business, Organizations and Society': ['BUSOR'], Chemistry: ['CHEM'], 'Civil Engineering': ['ENGR'], 'Computer Engineering': ['ENGR', 'CS'],
  'Computer Science': ['CS'], Economics: ['ECON'], 'Electrical Engineering': ['ENGR'], 'Film and New Media': ['FILMM'], 'General Engineering': ['ENGR'],
  History: ['HIST'], 'Interactive Media': ['IM'], 'Legal Studies': ['LAW'], 'Literature and Creative Writing': ['LITCW'], Mathematics: ['MATH'],
  'Mechanical Engineering': ['ENGR'], Music: ['MUSIC'], Philosophy: ['PHIL'], Physics: ['PHYS'], 'Political Science': ['POLSC'], Psychology: ['PSYCH'],
  'Social Research and Public Policy': ['SRPP'], Theater: ['THEAT'],
};

const subjectOf = (code: string) => code.split('-')[0] ?? '';
const levelOf = (code: string) => Number(/\d{4}/.exec(code)?.[0] ?? 0);

interface Took {
  code: string;
  /** The term they planned it for, when that is how we know. */
  term: string;
}

/**
 * Whether a student likely took this course. Planned it here for a term well under way or over: yes, that term. Past
 * their first year, an introductory course in their major's subject, or in a subject they have rated an advanced
 * course in: probably, term unknown.
 */
function likelyTook(code: string, profile: Profile, rated: string[], terms: Term[]): Took | null {
  const begun = (name: string) => {
    const start = terms.find((term) => term.name === name)?.start;
    return Boolean(start) && Date.parse(today()) - Date.parse(start!) > 56 * 86_400_000;
  };
  const term = Object.entries(loadPlanned()).filter(([name, courses]) => courses[code] && begun(name)).sort(([a], [b]) => (terms.findIndex((entry) => entry.name === a) - terms.findIndex((entry) => entry.name === b)))[0]?.[0];
  if (term) return { code, term };
  if (profile.year === 'first-year' || levelOf(code) >= 2000 || !levelOf(code)) return null;
  const subjects = new Set([...(MAJOR_SUBJECTS[profile.major] ?? []), ...rated.filter((entry) => levelOf(entry) >= 2000).map(subjectOf)]);
  return subjects.has(subjectOf(code)) ? { code, term: '' } : null;
}

/** A course planned here for a term that has ended, not rated or asked about yet: the newest such term first. */
function endedTerm(asked: Set<string>, terms: Term[]): Took | null {
  const ended = terms.filter((term) => term.end && term.end < today());
  for (const term of ended) {
    const code = Object.keys(loadPlanned()[term.name] ?? {}).find((entry) => !asked.has(entry));
    if (code) return { code, term: term.name };
  }
  return null;
}

let promptedThisVisit = false;

/**
 * A small card asking how a course went: after a term the student planned here ends, or a while after they open a
 * course they likely took. Once per course, ever (it is marked asked as it shows), at most once a visit, and "Don't ask
 * again" turns it off for good.
 */
export function RatePrompt() {
  const { profile } = useApp();
  const { route } = useRoute();
  const [mine, setMine] = useState<{ asked: Set<string>; rated: string[]; off: boolean } | null>(null);
  const [terms, setTerms] = useState<Term[]>([]);
  const [shown, setShown] = useState<(Took & { title: string }) | null>(null);
  const [rating, setRating] = useState<RateTarget | null>(null);
  const page = route.name === 'courses' ? route.code ?? '' : '';

  useEffect(() => {
    if (!profile) return;
    let live = true;
    Promise.all([api.board.myReviews(), api.courses.terms()])
      .then(([reviews, result]) => {
        if (!live) return;
        const rated = reviews.reviews.map((review) => review.code);
        setMine({ asked: new Set([...rated, ...reviews.prompted]), rated, off: reviews.off });
        setTerms(result.terms);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [profile]);

  // Rated somewhere on the site: never ask about that course.
  useEffect(() => onRecount((code) => setMine((current) => current && { ...current, asked: new Set([...current.asked, code]), rated: [...current.rated, code] })), []);

  useEffect(() => {
    if (!profile || !mine || mine.off || promptedThisVisit || shown || rating) return;
    const took = page ? (!mine.asked.has(page) ? likelyTook(page, profile, mine.rated, terms) : null) : endedTerm(mine.asked, terms);
    if (!took) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api.courses
        .view(took.code)
        .then((view) => {
          if (!live || promptedThisVisit) return;
          promptedThisVisit = true;
          setShown({ ...took, title: view.title });
          setMine((current) => current && { ...current, asked: new Set([...current.asked, took.code]) });
          void api.board.prompted({ code: took.code }).catch(() => undefined);
        })
        .catch(() => undefined);
    }, page ? 9_000 : 4_000);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [profile, mine, terms, page, shown, rating]);

  const stop = () => {
    setShown(null);
    setMine((current) => current && { ...current, off: true });
    void api.board.prompted({ off: true }).catch(() => undefined);
  };

  return (
    <>
      {shown && createPortal(
        <div className="review-nudge" data-line="guide" role="dialog" aria-label="How was the course?">
          <button type="button" className="icon-btn" onClick={() => setShown(null)} aria-label="Dismiss">
            <IconClose />
          </button>
          <b>{shown.term ? `You took ${shown.code} ${whenTaken(shown.term, terms)}. How was it?` : `Took ${shown.code}? How was it?`}</b>
          <p>{shown.title}</p>
          <StarPick
            value={null}
            size={28}
            onChange={(stars) => {
              setRating({ code: shown.code, stars });
              setShown(null);
            }}
          />
          <div className="review-nudge-actions">
            <button type="button" className="link-btn" onClick={() => setShown(null)}>
              {shown.term ? 'Not now' : 'I didn’t take it'}
            </button>
            <button type="button" className="link-btn" onClick={stop}>
              Don’t ask again
            </button>
          </div>
        </div>,
        document.body,
      )}
      <RateSheet target={rating} onClose={() => setRating(null)} />
    </>
  );
}
