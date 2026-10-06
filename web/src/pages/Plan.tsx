import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { clock, DEFAULT_RULES, highlights, lanes, minutes, normalizeRules, PRIMARY, sectionFits, solve, WEEKDAYS, type Choice, type Fix, type Option, type Quality, type Rules, type SolverCourse, type Want } from '../../../lib/schedule.ts';
import { api, ApiError, type CourseRating, type CourseRow, type ProfRating, type Term } from '../api';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { IconArrow, IconBack, IconCheck, IconChevronRight, IconClose, IconCopy, IconSearch } from '../icons';
import { navigate, onLinkClick, useRoute } from '../router';
import { loadPlan, savePlan, uid, type SavedPlan } from '../store';

type PlanWant = Want & { label: string };

const SHAPES: Array<{ id: Rules['shape']; label: string }> = [
  { id: 'any', label: 'Any' },
  { id: 'compact', label: 'Fewer days' },
  { id: 'spread', label: 'Lighter days' },
];
const SHAPE_HELP: Record<Rules['shape'], string> = {
  any: 'No preference: fewer gaps and early starts come first.',
  compact: 'Packs classes into as few days on campus as it can, even with gaps.',
  spread: 'Spreads classes over the week so no day is long.',
};
const STARTS = ['', '09:00', '10:00', '11:00', '12:00', '13:00'];
const ENDS = ['', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];
const PER_DAY = [0, 1, 2, 3, 4];
const DAY_LETTER: Record<string, string> = { Mon: 'M', Tue: 'T', Wed: 'W', Thu: 'Th', Fri: 'F', Sat: 'Sa', Sun: 'Su' };
const SHORT: Record<string, string> = { Lecture: 'Lec', Seminar: 'Sem', Recitation: 'Rec', Laboratory: 'Lab', Studio: 'Studio', Workshop: 'Wksp' };
/** How far a rating counts, by how sure it is: a thin one is pulled toward average. */
const TRUST: Record<ProfRating['confidence'], number> = { high: 1, medium: 0.8, low: 0.55 };
/** NYUAD's usual load is 16 credits a term; under 12 or over 18 is unusual. */
const LOAD = { usual: 16, low: 12, high: 18 };

/** The term students plan for: the newest fall or spring the schedule has, else the newest of any kind. */
function planTerm(terms: Term[]): string {
  return terms.find((term) => /^(fall|spring)/i.test(term.name))?.name ?? terms[0]?.name ?? '';
}

/** "MATH-UH 1012Q" and "MATH-UH 1012" are one course; the term's own code wins. */
function termCode(rows: CourseRow[], code: string): string | null {
  const base = (value: string) => value.replace(/^([A-Z]+-UH \d{4})[A-Z]*$/, '$1');
  return rows.find((row) => row.code === code)?.code ?? rows.find((row) => base(row.code) === base(code))?.code ?? null;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Which plan this is, by its class numbers, so it can be found again after the list is ranked anew. */
function signature(option: Option): string {
  return option.choices.flatMap((choice) => choice.sections.map((section) => section.classNumber)).join(',');
}

function weigh(rating: { score: number; confidence: ProfRating['confidence'] }): number {
  return 3 + (rating.score - 3) * TRUST[rating.confidence];
}

/**
 * The schedule builder: say what you need in your own words or add courses one by one, set the rules, and see the
 * plans that fit as a week, best first. The planning runs in the browser (lib/schedule.ts), ranked by what students
 * wrote about the professors as their ratings come in; the model only reads the request into courses and rules.
 */
export function PlanPage() {
  const { search } = useRoute();
  const { profile, toast } = useApp();
  const [saved, setSaved] = useState<SavedPlan>(loadPlan);
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [rows, setRows] = useState<{ term: string; courses: CourseRow[] } | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [viewing, setViewing] = useState<{ key: string; index: number } | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const term = saved.term && terms?.some((entry) => entry.name === saved.term) ? saved.term : planTerm(terms ?? []);

  const update = (patch: Partial<SavedPlan>) =>
    setSaved((current) => {
      const next = { ...current, ...patch };
      savePlan(next);
      return next;
    });

  useEffect(() => {
    api.courses
      .terms()
      .then((result) => setTerms(result.terms))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the terms.'));
  }, []);

  useEffect(() => {
    if (!term) return;
    let live = true;
    setRows(null);
    api.courses
      .list(term)
      .then((result) => live && setRows(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the courses.'));
    return () => {
      live = false;
    };
  }, [term]);

  // "Add to a plan" from a course: add it once the term's courses are in, then take it out of the address.
  const adding = search.get('add');
  useEffect(() => {
    if (!adding || !rows) return;
    const code = termCode(rows.courses, adding);
    if (!code) toast(`${adding} is not offered in ${rows.term}.`);
    else if (!saved.wants.some((want) => want.codes.length === 1 && want.codes[0] === code)) update({ wants: [...saved.wants, { id: uid(), label: '', codes: [code] }] });
    navigate({ name: 'plan' }, { replace: true, keepScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, rows]);

  const catalog = useMemo(() => new Map((rows?.courses ?? []).map((row) => [row.code, row as SolverCourse])), [rows]);
  const titles = useMemo(() => new Map((rows?.courses ?? []).map((row) => [row.code, row.title])), [rows]);

  // Who could teach in a plan: the professors of every section the rules allow, lecturers of named courses first.
  const candidates = useMemo(() => {
    const lead: string[] = [];
    const rest: string[] = [];
    for (const want of [...saved.wants].sort((a, b) => a.codes.length - b.codes.length)) {
      for (const code of want.codes) {
        for (const section of catalog.get(code)?.sections ?? []) if (sectionFits(section, saved.rules)) (PRIMARY.includes(section.component) ? lead : rest).push(...section.instructors);
      }
    }
    return [...new Set([...lead, ...rest])];
  }, [catalog, saved.wants, saved.rules]);
  // Courses worth comparing: the options of a slot with several that the rules allow.
  const options = useMemo(() => [...new Set(saved.wants.filter((want) => want.codes.length > 1).flatMap((want) => want.codes.filter((code) => catalog.get(code)?.sections.some((section) => sectionFits(section, saved.rules)))))], [catalog, saved.wants, saved.rules]);
  const profRatings = useProfRatings(candidates);
  const courseRatings = useCourseRatings(options);
  const quality = useMemo<Quality>(
    () => ({
      profs: new Map([...profRatings].flatMap(([name, rating]) => (rating ? [[name, weigh(rating)] as const] : []))),
      courses: new Map([...courseRatings].flatMap(([code, rating]) => (rating ? [[code, weigh(rating)] as const] : []))),
    }),
    [profRatings, courseRatings],
  );
  // Ratings arrive a few at a time: the plans are ranked again once a burst has landed, not on every one.
  const settled = useSettled(quality, 600);
  const result = useMemo(() => (rows && saved.wants.length ? solve(catalog, saved.wants, saved.rules, settled) : null), [catalog, rows, saved.wants, saved.rules, settled]);

  // A new request starts at the best plan; new ratings keep the plan being looked at, wherever it now ranks.
  useEffect(() => setViewing(null), [saved.wants, saved.rules, term]);
  const index = useMemo(() => {
    if (!result?.options.length || !viewing) return 0;
    const found = result.options.findIndex((option) => signature(option) === viewing.key);
    return found >= 0 ? found : Math.min(viewing.index, result.options.length - 1);
  }, [result, viewing]);
  const option = result?.options[index];
  const go = (to: number) => result?.options[to] && setViewing({ key: signature(result.options[to]), index: to });
  const why = option ? highlights(option, saved.rules, settled).join(' · ') : '';

  const setRules = (patch: Partial<Rules>) => update({ rules: { ...saved.rules, ...patch } });
  const addCode = (code: string) => {
    if (saved.wants.some((want) => want.codes.length === 1 && want.codes[0] === code)) return;
    update({ wants: [...saved.wants, { id: uid(), label: '', codes: [code] }] });
  };
  const removeWant = (id: string) => update({ wants: saved.wants.filter((want) => want.id !== id) });
  const applyFix = (fix: Fix) =>
    update({
      ...(fix.drop ? { wants: saved.wants.filter((want) => want.id !== fix.drop) } : {}),
      ...(fix.rules ? { rules: { ...saved.rules, ...fix.rules } } : {}),
    });
  const person = (name: string, as: 'prefer' | 'avoid') => {
    const prefer = saved.rules.prefer.filter((entry) => entry !== name);
    const avoid = saved.rules.avoid.filter((entry) => entry !== name);
    setRules(as === 'prefer' ? { prefer: [...prefer, name], avoid } : { prefer, avoid: [...avoid, name] });
  };

  const credits = useMemo(() => {
    if (option) return { low: option.credits, high: option.credits };
    let low = 0;
    let high = 0;
    for (const want of saved.wants) {
      const values = want.codes.map((code) => catalog.get(code)).filter((course): course is SolverCourse => !!course).map((course) => parseFloat(course.credits) || 0);
      if (!values.length) continue;
      low += Math.min(...values);
      high += Math.max(...values);
    }
    return { low, high };
  }, [option, saved.wants, catalog]);

  const read = async () => {
    const request = text.trim();
    if (!request || reading || !term) return;
    setReading(true);
    setNotes([]);
    try {
      const plan = await api.plan.read({ term, text: request, current: { wants: saved.wants.map(({ label, codes }) => ({ label, codes })), rules: saved.rules }, major: profile?.major, year: profile?.year });
      // A reply with no courses at all is a misreading, not a request to empty the plan ("Start over" does that).
      const wants = plan.wants.length || saved.wants.length === 0 ? plan.wants.map((want) => ({ id: uid(), label: want.label, codes: want.codes })) : saved.wants;
      update({ wants, rules: normalizeRules(plan.rules) });
      setNotes(plan.missing);
      setText('');
      // On a phone the week is below the rules: bring it up once there is one to see.
      if (plan.wants.length && !window.matchMedia('(min-width: 1081px)').matches) window.setTimeout(() => mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
    } catch (err) {
      setNotes([err instanceof ApiError || err instanceof Error ? err.message : 'Could not read that.']);
    } finally {
      setReading(false);
    }
  };

  const clear = () => {
    update({ wants: [], rules: DEFAULT_RULES });
    setNotes([]);
  };

  const rated = candidates.filter((name) => profRatings.get(name)).length;
  const unread = candidates.filter((name) => !profRatings.has(name)).length;

  return (
    <div className="page">
      <Sign title="Plan" ar="الجدول">
        {terms && terms.length > 0 && (
          <select className="input sign-select" value={term} onChange={(event) => update({ term: event.target.value })} aria-label="Term">
            {terms.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
      </Sign>
      {error && <div className="alert error">{error}</div>}
      <div className="plan">
        <div className="plan-side">
          <div className="plan-ask">
            <textarea
              className="input"
              rows={3}
              value={text}
              maxLength={600}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void read();
                }
              }}
              placeholder={saved.wants.length ? 'Change it: "swap calc for linear algebra, Fridays off"' : 'What do you need? "Calc, intro to CS, any Arts Core, nothing before 10"'}
              aria-label="Describe your plan"
            />
            <button type="button" className="btn primary" onClick={() => void read()} disabled={!text.trim() || reading || !rows}>
              {reading ? <span className="spinner" /> : <IconArrow />}
              {saved.wants.length ? 'Update' : 'Plan it'}
            </button>
          </div>
          {notes.length > 0 && (
            <ul className="plan-notes" role="status">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}

          <div className="plan-block">
            <div className="plan-block-head">
              <h2>Courses</h2>
              {saved.wants.length > 0 && (
                <button type="button" className="link-btn small" onClick={clear}>
                  Start over
                </button>
              )}
            </div>
            {saved.wants.length > 0 && (
              <div className="wants">
                {saved.wants.map((want, i) => (
                  <WantRow key={want.id} want={want} color={i} titles={titles} problem={result?.problems.find((problem) => problem.want === want.id)?.text} onRemove={() => removeWant(want.id)} />
                ))}
              </div>
            )}
            <CoursePicker rows={rows?.courses ?? null} taken={new Set(saved.wants.flatMap((want) => want.codes))} onPick={addCode} />
            {saved.wants.length > 0 && <Load low={credits.low} high={credits.high} />}
          </div>

          <div className="plan-block">
            <div className="plan-block-head">
              <h2>Rules</h2>
            </div>
            <div className="rules">
              <label className="rule">
                <span>Start after</span>
                <select className="input" value={saved.rules.earliest} onChange={(event) => setRules({ earliest: event.target.value })}>
                  {[...new Set([...STARTS, saved.rules.earliest])].map((time) => (
                    <option key={time} value={time}>
                      {time ? clock(time) : 'Any time'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="rule">
                <span>Done by</span>
                <select className="input" value={saved.rules.latest} onChange={(event) => setRules({ latest: event.target.value })}>
                  {[...new Set([...ENDS, saved.rules.latest])].map((time) => (
                    <option key={time} value={time}>
                      {time ? clock(time) : 'Any time'}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rule">
                <span id="days-off">Days off</span>
                <div className="day-toggles" role="group" aria-labelledby="days-off">
                  {WEEKDAYS.map((day) => {
                    const off = saved.rules.daysOff.includes(day);
                    return (
                      <button key={day} type="button" className={`day-toggle${off ? ' on' : ''}`} aria-pressed={off} aria-label={`${day} off`} onClick={() => setRules({ daysOff: off ? saved.rules.daysOff.filter((entry) => entry !== day) : [...saved.rules.daysOff, day] })}>
                        {DAY_LETTER[day]}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className="rule">
                <span>Classes a day</span>
                <select className="input" value={saved.rules.maxPerDay} onChange={(event) => setRules({ maxPerDay: Number(event.target.value) })}>
                  {PER_DAY.map((most) => (
                    <option key={most} value={most}>
                      {most ? `At most ${most}` : 'Any number'}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rule wide">
                <span>Shape of the week</span>
                <Segmented label="Shape of the week" value={saved.rules.shape} onChange={(shape) => setRules({ shape })} options={SHAPES} />
                <small className="rule-help">{SHAPE_HELP[saved.rules.shape]}</small>
              </div>
              <div className="rule wide switches">
                <Switch on={saved.rules.bestRated} onChange={(bestRated) => setRules({ bestRated })} label="Best-rated professors">
                  Professors students praise in the group come first; unrated ones count as average.
                  {saved.rules.bestRated && candidates.length > 0 && (unread > 0 ? ` Reading about ${unread} more…` : rated ? ` ${rated} of ${candidates.length} rated.` : ' None rated yet.')}
                </Switch>
                <Switch on={saved.rules.noBackToBack} onChange={(noBackToBack) => setRules({ noBackToBack })} label="No back-to-back">
                  A real break between two classes, not just the 10 minutes to walk.
                </Switch>
                <Switch on={saved.rules.waitlisted} onChange={(waitlisted) => setRules({ waitlisted })} label="Include waitlists">
                  Plans with full sections too, for when you would join the waitlist.
                </Switch>
              </div>
              <div className="rule wide">
                <span>Professors</span>
                {(saved.rules.prefer.length > 0 || saved.rules.avoid.length > 0) && (
                  <div className="chips">
                    {saved.rules.prefer.map((name) => (
                      <button key={`p-${name}`} type="button" className="chip on" onClick={() => setRules({ prefer: saved.rules.prefer.filter((entry) => entry !== name) })} aria-label={`Stop preferring ${name}`}>
                        With {name} <IconClose />
                      </button>
                    ))}
                    {saved.rules.avoid.map((name) => (
                      <button key={`a-${name}`} type="button" className="chip on avoid" onClick={() => setRules({ avoid: saved.rules.avoid.filter((entry) => entry !== name) })} aria-label={`Stop avoiding ${name}`}>
                        Not {name} <IconClose />
                      </button>
                    ))}
                  </div>
                )}
                <ProfPicker rows={rows?.courses ?? null} plan={new Set(candidates)} ratings={profRatings} taken={new Set([...saved.rules.prefer, ...saved.rules.avoid])} onPick={person} />
                <small className="rule-help">With: plans with them come first. Not: they are left out.</small>
              </div>
            </div>
          </div>
        </div>

        <div className="plan-main" ref={mainRef}>
          {!rows && !error && <div className="skeleton" style={{ height: 420 }} />}
          {rows && saved.wants.length === 0 && <WeekGrid option={null} daysOff={saved.rules.daysOff} empty="Your week shows up here. Add a course, or say what you need." />}
          {result && result.problems.length > 0 && (
            <>
              <div className="alert warn plan-problems" role="status">
                {result.problems.map((problem) => (
                  <div key={problem.text} className="plan-problem">
                    <p>{problem.text}</p>
                    {problem.fixes.length > 0 && (
                      <ul className="plan-fixes">
                        {problem.fixes.map((fix) => (
                          <li key={fix.label}>
                            <button type="button" className="btn sm" onClick={() => applyFix(fix)}>
                              {fix.label}
                            </button>
                            {fix.detail && <span>{fix.detail}.</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
              <WeekGrid option={null} daysOff={saved.rules.daysOff} empty="Nothing fits yet." />
            </>
          )}
          {result && option && (
            <>
              <div className="option-bar">
                <button type="button" className="icon-btn" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous plan">
                  <IconBack />
                </button>
                <div className="option-name">
                  <div className="option-title">
                    <b>Plan {index + 1}</b>
                    <span>
                      of {result.options.length}
                      {result.partial ? '+' : ''} · {option.credits} credits
                    </span>
                  </div>
                  {why && <p className="option-why">{why.charAt(0).toUpperCase() + why.slice(1)}</p>}
                </div>
                <button type="button" className="icon-btn" onClick={() => go(index + 1)} disabled={index >= result.options.length - 1} aria-label="Next plan">
                  <IconChevronRight />
                </button>
              </div>
              <WeekGrid option={option} daysOff={saved.rules.daysOff} />
              <PlanList option={option} wants={saved.wants} profs={profRatings} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** A value that changes only once it has held still for a moment. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Ratings for these professors, asked for in batches: the server answers the ones it has and writes a couple more
 * each time, so this asks again while it is making progress, and backs off when it is not (busy, or out of budget).
 */
function useProfRatings(names: string[]): Map<string, ProfRating | null> {
  const [ratings, setRatings] = useState<Map<string, ProfRating | null>>(() => new Map());
  const key = names.join('|');
  useEffect(() => {
    if (!names.length) return;
    let live = true;
    let timer = 0;
    let had = -1;
    let stalls = 0;
    const round = async () => {
      try {
        const { ratings: known } = await api.courses.profs(names);
        if (!live) return;
        setRatings((current) => (current.size === known.size && [...known].every(([name, rating]) => current.get(name) === rating) ? current : known));
        if (known.size >= names.length) return;
        stalls = known.size > had ? 0 : stalls + 1;
        had = known.size;
        if (stalls <= 3) timer = window.setTimeout(() => void round(), stalls ? 20_000 : 400);
      } catch {
        if (live && ++stalls <= 3) timer = window.setTimeout(() => void round(), 20_000);
      }
    };
    void round();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ratings;
}

/** Ratings for the courses a slot could be filled with, two at a time; the first refusal (busy, rate limited, off) stops the rest. */
function useCourseRatings(codes: string[]): Map<string, CourseRating | null> {
  const [ratings, setRatings] = useState<Map<string, CourseRating | null>>(() => new Map());
  const key = codes.join('|');
  useEffect(() => {
    if (!codes.length) return;
    let live = true;
    const queue = [...codes];
    const next = async (): Promise<void> => {
      const code = queue.shift();
      if (!code || !live) return;
      try {
        const { rating } = await api.courses.rating(code);
        if (live) setRatings((current) => (current.has(code) ? current : new Map(current).set(code, rating)));
      } catch {
        queue.length = 0;
        return;
      }
      await next();
    };
    void Promise.all([next(), next()]);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ratings;
}

function Load({ low, high }: { low: number; high: number }) {
  const amount = low === high ? `${low}` : `${low} to ${high}`;
  const note = high < LOAD.low ? `A light load: most students take ${LOAD.usual}, and under ${LOAD.low} is unusual.` : low > LOAD.high ? `A heavy load: most students take ${LOAD.usual}, and over ${LOAD.high} is unusual.` : '';
  return (
    <p className={`plan-load${note ? ' off' : ''}`}>
      <b>{amount} credits</b>
      {note && <span>{note}</span>}
    </p>
  );
}

function Switch({ on, onChange, label, children }: { on: boolean; onChange(on: boolean): void; label: string; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch-track" aria-hidden="true" />
      <span className="switch-text">
        <b>{label}</b>
        <small>{children}</small>
      </span>
    </button>
  );
}

function WantRow({ want, color, titles, problem, onRemove }: { want: PlanWant; color: number; titles: Map<string, string>; problem?: string; onRemove(): void }) {
  const single = want.codes.length === 1;
  return (
    <div className={`want${problem ? ' stuck' : ''}`} style={{ '--c': `var(--plan-${color % 6})` } as CSSProperties}>
      <span className="want-dot" aria-hidden="true" />
      <div className="want-body">
        {single ? (
          <>
            <span className="code">{want.codes[0]}</span>
            <b>{titles.get(want.codes[0]!) ?? want.codes[0]}</b>
          </>
        ) : (
          <>
            <b>{want.label || 'One of these'}</b>
            <span className="want-any" title={want.codes.map((code) => `${code} ${titles.get(code) ?? ''}`).join('\n')}>
              Any of {want.codes.length}: {want.codes.slice(0, 3).join(', ')}
              {want.codes.length > 3 ? '…' : ''}
            </span>
          </>
        )}
        {problem && <span className="want-problem">{problem}</span>}
      </div>
      <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove">
        <IconClose />
      </button>
    </div>
  );
}

/** A search over the term's courses that adds the one you pick. */
function CoursePicker({ rows, taken, onPick }: { rows: CourseRow[] | null; taken: Set<string>; onPick(code: string): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!rows || words.length === 0) return [];
    return rows
      .filter((row) => !taken.has(row.code) && row.sections.some((section) => section.status !== 'cancelled'))
      .map((row) => {
        const code = row.code.toLowerCase().replace(/[^a-z0-9]/g, '');
        const title = row.title.toLowerCase();
        let score = 0;
        for (const word of words) {
          const hit = (code.includes(word.replace(/[^a-z0-9]/g, '')) ? 3 : 0) + (title.includes(word) ? 2 : 0);
          if (!hit) return null;
          score += hit;
        }
        return { row, score };
      })
      .filter((entry): entry is { row: CourseRow; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((entry) => entry.row);
  }, [rows, query, taken]);
  const pick = (code: string) => {
    onPick(code);
    setQuery('');
    setActive(0);
  };
  return (
    <div className="picker">
      <div className="search-field">
        <IconSearch />
        <input
          className="input"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setActive((current) => Math.min(matches.length - 1, current + 1));
            else if (event.key === 'ArrowUp') setActive((current) => Math.max(0, current - 1));
            else if (event.key === 'Enter' && matches[active]) pick(matches[active]!.code);
            else if (event.key === 'Escape') setQuery('');
            else return;
            event.preventDefault();
          }}
          placeholder="Add a course"
          aria-label="Add a course"
          disabled={!rows}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls="picker-list"
          aria-autocomplete="list"
        />
      </div>
      {matches.length > 0 && (
        <div className="picker-list" id="picker-list" role="listbox">
          {matches.map((row, i) => (
            <button key={row.code} type="button" role="option" aria-selected={i === active} className={i === active ? 'on' : undefined} onMouseEnter={() => setActive(i)} onClick={() => pick(row.code)}>
              <span className="code">{row.code}</span>
              <span>{row.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A search over the term's professors, to plan with or without one; the ones who could be in this plan come first. */
function ProfPicker({ rows, plan, ratings, taken, onPick }: { rows: CourseRow[] | null; plan: Set<string>; ratings: Map<string, ProfRating | null>; taken: Set<string>; onPick(name: string, as: 'prefer' | 'avoid'): void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const people = useMemo(() => {
    const teaching = new Map<string, Set<string>>();
    for (const row of rows ?? []) {
      for (const section of row.sections) {
        if (section.status === 'cancelled') continue;
        for (const name of section.instructors) teaching.set(name, (teaching.get(name) ?? new Set()).add(row.code));
      }
    }
    return teaching;
  }, [rows]);
  const matches = useMemo(() => {
    const words = fold(query).split(/[\s,.]+/).filter(Boolean);
    if (words.length === 0) return [];
    return [...people.keys()]
      .filter((name) => !taken.has(name) && words.every((word) => fold(name).includes(word)))
      .sort((a, b) => Number(plan.has(b)) - Number(plan.has(a)) || (ratings.get(b)?.score ?? 0) - (ratings.get(a)?.score ?? 0) || a.localeCompare(b))
      .slice(0, 6);
  }, [people, query, taken, plan, ratings]);
  const pick = (name: string, as: 'prefer' | 'avoid') => {
    onPick(name, as);
    setQuery('');
    setActive(0);
  };
  return (
    <div className="picker">
      <div className="search-field">
        <IconSearch />
        <input
          className="input"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setActive((current) => Math.min(matches.length - 1, current + 1));
            else if (event.key === 'ArrowUp') setActive((current) => Math.max(0, current - 1));
            else if (event.key === 'Enter' && matches[active]) pick(matches[active]!, event.shiftKey ? 'avoid' : 'prefer');
            else if (event.key === 'Escape') setQuery('');
            else return;
            event.preventDefault();
          }}
          placeholder="Prefer or avoid a professor"
          aria-label="Prefer or avoid a professor"
          disabled={!rows}
        />
      </div>
      {matches.length > 0 && (
        <ul className="picker-list prof-list" aria-label="Professors">
          {matches.map((name, i) => {
            const codes = [...(people.get(name) ?? [])];
            const rating = ratings.get(name);
            return (
              <li key={name} className={i === active ? 'on' : undefined} onMouseEnter={() => setActive(i)}>
                <span className="prof-name">
                  <b>
                    {name}
                    {rating && <span className="prof-score">{rating.score.toFixed(1)}</span>}
                  </b>
                  <small>{codes.slice(0, 3).join(', ') + (codes.length > 3 ? '…' : '')}</small>
                </span>
                <button type="button" className="btn sm" onClick={() => pick(name, 'prefer')}>
                  With
                </button>
                <button type="button" className="btn sm" onClick={() => pick(name, 'avoid')}>
                  Not
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface Block {
  key: string;
  day: string;
  start: number;
  end: number;
  code: string;
  part: string;
  color: number;
  half: string;
  title: string;
  lane: number;
  lanes: number;
  span: number;
}

function halfOf(session: string): string {
  return session === 'First 7 weeks' ? '1st half' : session === 'Second 7 weeks' ? '2nd half' : '';
}

const DAY_START = 8 * 60;
const DAY_END = 19 * 60;

/**
 * The week as a timetable, Monday to Friday and the weekend when a class meets then, with days off shaded. Blocks that
 * overlap (only ever the two seven-week halves) share the column in lanes; sections with no set time are listed below.
 */
function WeekGrid({ option, daysOff, empty }: { option: Option | null; daysOff: string[]; empty?: string }) {
  const blocks: Block[] = [];
  const untimed: string[] = [];
  option?.choices.forEach((choice, color) => {
    for (const section of choice.sections) {
      const part = `${SHORT[section.component] ?? section.component} ${section.section}`;
      const half = halfOf((section as { session?: string }).session ?? '');
      const timed = section.meetings.filter((meeting) => meeting.start && meeting.end && meeting.days.length);
      if (timed.length === 0) {
        const days = [...new Set(section.meetings.flatMap((meeting) => meeting.days))];
        untimed.push(`${choice.code} ${part}${days.length ? ` (${days.join(' ')})` : ''}`);
        continue;
      }
      timed.forEach((meeting, m) => {
        const room = (meeting as { room?: string }).room;
        for (const day of meeting.days) {
          blocks.push({
            key: `${section.classNumber}-${m}-${day}`,
            day,
            start: minutes(meeting.start),
            end: minutes(meeting.end),
            code: choice.code,
            part,
            color,
            half,
            title: [`${choice.code} ${section.component} ${section.section}`, `${day} ${clock(meeting.start)}–${clock(meeting.end)}`, half, room].filter(Boolean).join(' · '),
            lane: 0,
            lanes: 1,
            span: 1,
          });
        }
      });
    }
  });
  const days = [...WEEKDAYS, ...(['Sat', 'Sun'] as const).filter((day) => blocks.some((block) => block.day === day))];
  for (const day of days) {
    const list = blocks.filter((block) => block.day === day);
    lanes(list).forEach((place, i) => Object.assign(list[i]!, place));
  }
  const from = Math.min(DAY_START, ...blocks.map((block) => Math.floor(block.start / 60) * 60));
  const to = Math.max(DAY_END, ...blocks.map((block) => Math.ceil(block.end / 60) * 60));
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);
  const span = to - from;
  return (
    <div className={`week-grid${option ? '' : ' blank'}`} style={{ '--days': days.length, '--hours': hours.length } as CSSProperties}>
      <div className="wg-head">
        <span />
        {days.map((day) => (
          <span key={day} className={daysOff.includes(day) ? 'off' : undefined}>
            {day}
          </span>
        ))}
      </div>
      <div className="wg-body">
        <div className="wg-times" aria-hidden="true">
          {hours.map((hour) => (
            <span key={hour}>{clock(hour)}</span>
          ))}
        </div>
        {days.map((day) => (
          <div key={day} className={`wg-day${daysOff.includes(day) ? ' off' : ''}`}>
            {blocks
              .filter((block) => block.day === day)
              .map((block) => (
                <div
                  key={block.key}
                  className="wg-block"
                  style={{ '--c': `var(--plan-${block.color % 6})`, top: `${((block.start - from) / span) * 100}%`, height: `${((block.end - block.start) / span) * 100}%`, left: `${(block.lane / block.lanes) * 100}%`, width: `${(block.span / block.lanes) * 100}%` } as CSSProperties}
                  title={block.title}
                >
                  <div className="wg-card">
                    <b>
                      <span>{block.code.split(' ')[0]!.replace(/-UH$/, '')}</span> <span>{block.code.split(' ')[1]}</span>
                    </b>
                    {block.half && (
                      <span className="wg-half">
                        <span className="long">{block.half}</span>
                        <span className="short">{block.half.startsWith('1') ? 'H1' : 'H2'}</span>
                      </span>
                    )}
                    <span className="wg-part">{block.part}</span>
                    <span className="wg-time">
                      {clock(block.start)}–{clock(block.end)}
                    </span>
                  </div>
                </div>
              ))}
          </div>
        ))}
        {empty && (
          <p className="wg-empty">
            <span>{empty}</span>
          </p>
        )}
      </div>
      {untimed.length > 0 && <p className="wg-note">No set time: {untimed.join(', ')}</p>}
    </div>
  );
}

/** The plan as a list: each course's sections with their class numbers, ready for Albert's shopping cart. */
function PlanList({ option, wants, profs }: { option: Option; wants: PlanWant[]; profs: Map<string, ProfRating | null> }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const numbers = option.choices.flatMap((choice) => choice.sections.map((section) => section.classNumber));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(numbers.join(', '));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast('Could not copy');
    }
  };
  return (
    <div className="plan-list">
      {option.choices.map((choice) => (
        <ChoiceRow key={choice.code} choice={choice} color={wants.findIndex((want) => want.id === choice.want)} profs={profs} />
      ))}
      <button type="button" className="btn" onClick={() => void copy()}>
        {copied ? <IconCheck className="pop-in" /> : <IconCopy />} {copied ? 'Copied' : 'Copy class numbers'}
      </button>
    </div>
  );
}

function ChoiceRow({ choice, color, profs }: { choice: Choice; color: number; profs: Map<string, ProfRating | null> }) {
  const rating = useRating(choice.code);
  // Which professor's verdict is open, as "class number:name".
  const [open, setOpen] = useState('');
  return (
    <div className="choice" style={{ '--c': `var(--plan-${Math.max(0, color) % 6})` } as CSSProperties}>
      <div className="choice-head">
        <a className="choice-title" href={`/courses/${encodeURIComponent(choice.code)}`} onClick={onLinkClick}>
          <span className="code">{choice.code}</span>
          <b>{choice.title}</b>
        </a>
        {rating && (
          <span className="choice-rating" title="AI rating of the course from students in the group">
            {rating.score.toFixed(1)}
          </span>
        )}
      </div>
      {choice.sections.map((section) => {
        const shown = open.startsWith(`${section.classNumber}:`) ? profs.get(open.slice(section.classNumber.length + 1)) : null;
        return (
          <div key={section.classNumber} className="choice-sec">
            <span className="choice-part">
              {section.component} {section.section}
              {section.topic && <span className="choice-topic">{section.topic}</span>}
              {section.status !== 'open' && <em className={`seats ${section.status}`}>{section.status === 'waitlist' ? 'Waitlist' : 'Closed'}</em>}
            </span>
            <span className="choice-when">
              {section.meetings.length === 0 || !section.meetings.some((meeting) => meeting.start)
                ? 'No set time'
                : section.meetings
                    .filter((meeting) => meeting.start)
                    .map((meeting) => `${meeting.days.join(' ')} ${clock(meeting.start)}–${clock(meeting.end)}`)
                    .join(' · ')}
              {halfOf((section as { session?: string }).session ?? '') && ` · ${halfOf((section as { session?: string }).session ?? '')}`}
            </span>
            <span className="choice-who">
              {section.instructors.length === 0
                ? 'Instructor not listed'
                : section.instructors.map((name, i) => {
                    const prof = profs.get(name);
                    const id = `${section.classNumber}:${name}`;
                    return (
                      <Fragment key={name}>
                        {i > 0 && ', '}
                        <span className="prof">
                          {name}
                          {prof && (
                            <button type="button" className={`prof-score${open === id ? ' on' : ''}`} onClick={() => setOpen(open === id ? '' : id)} aria-expanded={open === id} aria-label={`${name}: rated ${prof.score.toFixed(1)} by students. What they say`}>
                              {prof.score.toFixed(1)}
                            </button>
                          )}
                        </span>
                      </Fragment>
                    );
                  })}
            </span>
            {shown && (
              <p className="prof-verdict">
                {shown.verdict}{' '}
                <span>
                  From {shown.basis} {shown.basis === 1 ? 'student' : 'students'} in the group{shown.confidence === 'low' ? ', so take it lightly' : ''}.
                </span>
              </p>
            )}
            <span className="class-no">#{section.classNumber}</span>
          </div>
        );
      })}
    </div>
  );
}

/** A course's AI rating, if students have written enough about it; the client asks once per course a session. */
function useRating(code: string): CourseRating | null {
  const [rating, setRating] = useState<CourseRating | null>(null);
  useEffect(() => {
    let live = true;
    setRating(null);
    api.courses
      .rating(code)
      .then((result) => live && setRating(result.rating))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, [code]);
  return rating;
}
