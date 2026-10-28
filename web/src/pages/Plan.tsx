import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type UIEvent } from 'react';
import { clock, DAY_NAMES, DAYS, DEFAULT_RULES, highlights, lanes, minutes, normalizeRules, PRIMARY, sessionHalf, solve, WEEKDAYS, type Choice, type Fix, type Option, type Quality, type Rules, type SolverCourse, type Want } from '../../../lib/schedule.ts';
import { api, ApiError, type CourseRow, type PlanSchool, type ScoreIndex, type Term } from '../api';
import { useApp } from '../context';
import { IconArrow, IconBack, IconCheck, IconChevron, IconChevronRight, IconClose, IconCopy, IconPlus } from '../icons';
import { navigate, onLinkClick, useRoute } from '../router';
import { loadPlan, rememberPlanned, savePlan, uid, type PlanMessage, type SavedPlan } from '../store';

type PlanWant = Want & { label: string };

/** Every profile on the site is an NYU Abu Dhabi student, so plans start there; the place pill changes it. */
const HOME_SCHOOL = 'Abu Dhabi';
const OPTIONS = 6;
const SHORT: Record<string, string> = { Lecture: 'Lec', Seminar: 'Sem', Recitation: 'Rec', Laboratory: 'Lab', Studio: 'Studio', Workshop: 'Wksp' };
/** NYUAD's usual load is 16 credits a term; under 12 or over 18 is unusual. */
const LOAD = { usual: 16, low: 12, high: 18 };
const PLACEHOLDER = 'calc, intro to CS, any Arts Core, nothing before 10, Fridays off';
const EXAMPLES = ['CSO, Algorithms and a CS elective, no 8:30s', 'Computer Programming for Engineers, Digital Logic and Multivariable Calculus', 'Microeconomics, Statistics and two Core courses, at most two classes a day'];

interface SiteTimes { from: number; to: number; days: string[] }

/** The hours and days the site teaches, for the week view's frame. */
function siteTimes(courses: CourseRow[]): SiteTimes {
  const meetings = courses.flatMap((course) => course.sections.filter((section) => section.status !== 'cancelled').flatMap((section) => section.meetings.filter((meeting) => meeting.days.length && meeting.start && meeting.end)));
  const starts = meetings.map((meeting) => minutes(meeting.start));
  const ends = meetings.map((meeting) => minutes(meeting.end));
  const from = starts.length ? Math.floor(Math.min(...starts) / 60) * 60 : 8 * 60;
  const to = ends.length ? Math.ceil(Math.max(...ends) / 60) * 60 : 20 * 60;
  const taught = new Set(meetings.flatMap((meeting) => meeting.days));
  return { from, to: Math.max(to, from + 60), days: taught.size ? DAYS.filter((day) => taught.has(day)) : [...WEEKDAYS] };
}

/** Only regular semesters have the weekly schedule this planner models. */
function regularTerms(terms: Term[]): Term[] {
  return terms.filter((term) => /^(fall|spring)\b/i.test(term.name));
}

/** Albert sometimes drops trailing code attributes in a later term; the term's own code wins. */
function termCode(rows: CourseRow[], code: string): string | null {
  const base = (value: string) => value.replace(/^(\S+ \d+)[A-Z]+$/, '$1');
  return rows.find((row) => row.code === code)?.code ?? rows.find((row) => base(row.code) === base(code))?.code ?? null;
}

/** "Pötsch, Thomas" and "Thomas Potsch" alike, as the review digests key professors. */
function personKey(name: string): string {
  const [last, first] = name.split(',').map((part) => part.trim());
  return (first ? `${first} ${last}` : name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A rating counts by how many students it rests on: a thin one is pulled toward average. */
function weigh(entry: { score: number; basis: number }): number {
  const trust = entry.basis >= 10 ? 1 : entry.basis >= 4 ? 0.8 : 0.55;
  return 3 + (entry.score - 3) * trust;
}

/**
 * The schedule builder as a conversation: one box takes the whole request ("calc, intro to CS, any Arts Core, nothing
 * before 10, Fridays off") and later changes ("move the lab to Tuesday", "no 9am"); the plans that fit come back as
 * weeks to swipe through, best first. The model reads the words into courses and rules (api/plan.ts), the browser
 * plans (lib/schedule.ts), ranked by the review digests' ratings of the professors and courses. What it understood
 * sits under the box as chips, each one removable.
 */
export function PlanPage() {
  const { search } = useRoute();
  const { profile, toast } = useApp();
  const [saved, setSaved] = useState<SavedPlan>(loadPlan);
  const [schools, setSchools] = useState<PlanSchool[]>([]);
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [rows, setRows] = useState<{ term: string; courses: CourseRow[] } | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [where, setWhere] = useState(false);
  const scores = useScores();
  const requestRef = useRef<HTMLTextAreaElement>(null);
  const requestId = useRef(0);
  const chat = saved.chat ?? [];
  const lastReply = chat.at(-1)?.role === 'assistant' ? chat.at(-1)!.text : '';
  const school = saved.school || HOME_SCHOOL;

  const update = (patch: Partial<SavedPlan>) =>
    setSaved((current) => {
      const next = { ...current, ...patch };
      savePlan(next);
      return next;
    });

  useEffect(() => {
    const element = requestRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(160, element.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    api.courses.terms().then((result) => setSchools(result.schools ?? [])).catch((err) => setError(err instanceof Error ? err.message : 'Could not load the schools.'));
  }, []);

  useEffect(() => {
    let live = true;
    setTerms(null);
    setError('');
    api.courses
      .terms(school)
      .then((result) => live && setTerms(result.terms))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the terms.'));
    return () => {
      live = false;
    };
  }, [school]);
  const regular = regularTerms(terms ?? []);
  const term = saved.term && regular.some((entry) => entry.name === saved.term) ? saved.term : regular[0]?.name ?? '';

  useEffect(() => {
    if (!term) {
      setRows(null);
      return;
    }
    let live = true;
    setRows(null);
    api.courses
      .list(term, school)
      .then((result) => live && setRows(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the courses.'));
    return () => {
      live = false;
    };
  }, [term, school]);

  // A request in flight is for the term and school it was sent with.
  useEffect(() => {
    requestId.current++;
    setReading(false);
  }, [term, school]);

  // Moving to another term or school keeps the courses offered there and says which ones are not.
  useEffect(() => {
    if (!rows || rows.term !== term) return;
    const kept: PlanWant[] = [];
    const gone: string[] = [];
    for (const want of saved.wants) {
      const codes = [...new Set(want.codes.map((code) => termCode(rows.courses, code)).filter((code): code is string => !!code))];
      if (codes.length) kept.push(codes.join() === want.codes.join() ? want : { ...want, codes });
      else gone.push(want.label || want.codes[0]!);
    }
    if (kept.length === saved.wants.length && kept.every((want, i) => want === saved.wants[i])) return;
    update({ wants: kept, chat: gone.length ? [...chat, { role: 'assistant', text: `Not offered at ${schoolLabel(schools, school)} in ${term}: ${gone.join(', ')}.` }] : chat });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // "Add to a plan" from a course page: add it once the term's courses are in, then take it out of the address.
  const adding = search.get('add');
  useEffect(() => {
    if (!adding || !rows) return;
    const code = termCode(rows.courses, adding);
    if (!code) toast(`${adding} is not offered in ${rows.term}.`);
    else if (!saved.wants.some((want) => want.codes.includes(code))) update({ wants: [...saved.wants, { id: uid(), label: '', codes: [code] }] });
    navigate({ name: 'plan' }, { replace: true, keepScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, rows]);

  const catalog = useMemo(() => new Map((rows?.courses ?? []).map((row) => [row.code, row as SolverCourse])), [rows]);
  const titles = useMemo(() => new Map((rows?.courses ?? []).map((row) => [row.code, row.title])), [rows]);
  const timing = useMemo(() => siteTimes(rows?.courses ?? []), [rows]);
  const quality = useMemo<Quality>(() => {
    const byPerson = new Map(Object.entries(scores?.profs ?? {}).map(([name, entry]) => [personKey(name), entry]));
    const profs = new Map<string, number>();
    for (const row of rows?.courses ?? []) {
      for (const section of row.sections) {
        for (const name of section.instructors) {
          const entry = byPerson.get(personKey(name));
          if (entry && !profs.has(name)) profs.set(name, weigh({ score: entry.rank, basis: entry.basis }));
        }
      }
    }
    const courses = new Map(Object.entries(scores?.courses ?? {}).map(([code, entry]) => [code, weigh(entry)]));
    return { profs, courses };
  }, [scores, rows]);
  const result = useMemo(() => (rows && saved.wants.length ? solve(catalog, saved.wants, saved.rules, quality, { options: OPTIONS, ms: 1200 }) : null), [catalog, rows, saved.wants, saved.rules, quality]);
  const [index, setIndex] = useState(0);
  const option = result?.options[Math.min(index, result.options.length - 1)];

  // The plan in view is remembered for its term, with its sections' professors, so once the term is over the site can
  // ask how each course went and who taught it.
  useEffect(() => {
    if (!term || !rows) return;
    const courses: Record<string, string[]> = {};
    if (option) for (const choice of option.choices) courses[choice.code] = [...new Set(choice.sections.filter((section) => PRIMARY.includes(section.component)).flatMap((section) => section.instructors))];
    else for (const want of saved.wants) if (want.codes.length === 1) courses[want.codes[0]!] = [];
    rememberPlanned(term, courses);
  }, [option, term, rows, saved.wants]);

  const setRules = (patch: Partial<Rules>) => update({ rules: { ...saved.rules, ...patch } });
  const applyFix = (fix: Fix) =>
    update({
      ...(fix.drop ? { wants: saved.wants.filter((want) => want.id !== fix.drop) } : {}),
      ...(fix.rules ? { rules: { ...saved.rules, ...fix.rules } } : {}),
    });

  const read = async (value = text) => {
    const request = value.trim();
    if (!request || reading || !term || !rows?.courses.length) return;
    const id = ++requestId.current;
    const conversation: PlanMessage[] = [...chat, { role: 'user' as const, text: request }].slice(-23);
    update({ chat: conversation });
    setText('');
    setReading(true);
    try {
      const plan = await api.plan.read({ term, school, text: request, history: chat.slice(-8), current: { wants: saved.wants.map(({ label, codes, sessions }) => ({ label, codes, sessions })), rules: saved.rules }, major: profile?.major, year: profile?.year });
      if (requestId.current !== id) return;
      // A reply with no courses at all is a misreading, not a request to empty the plan ("New plan" does that).
      const wants = plan.wants.length || saved.wants.length === 0 ? plan.wants.map((want) => ({ id: saved.wants.find((known) => known.codes.join() === want.codes.join())?.id ?? uid(), label: want.label, codes: want.codes, sessions: want.sessions })) : saved.wants;
      const names = wants.map((want) => want.label || titles.get(want.codes[0]!) || want.codes[0]);
      const reply = plan.reply ? [plan.reply, ...plan.missing.filter((note) => !plan.reply!.includes(note))].join(' ') : [names.length ? `Planning ${names.join(', ')}.` : 'Saved. Name a course to build your week.', ...plan.missing].join(' ');
      update({ wants, rules: normalizeRules(plan.rules), chat: [...conversation, { role: 'assistant', text: reply }] });
      setIndex(0);
    } catch (err) {
      if (requestId.current === id) {
        setText((current) => current || request);
        update({ chat: [...conversation, { role: 'assistant', text: err instanceof ApiError || err instanceof Error ? err.message : 'Could not read that. Try again.' }] });
      }
    } finally {
      if (requestId.current === id) setReading(false);
    }
  };

  const startOver = () => {
    requestId.current++;
    setReading(false);
    update({ wants: [], rules: DEFAULT_RULES, chat: [] });
    setIndex(0);
    requestRef.current?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void read();
    }
  };

  const toggleWhere = useCallback(() => setWhere((current) => !current), []);
  const ready = Boolean(rows?.courses.length);
  const empty = saved.wants.length === 0 && chat.length === 0;
  const place = (
    <WherePill
      open={where}
      onToggle={toggleWhere}
      schools={schools}
      school={school}
      terms={regular}
      term={term}
      onSchool={(next) => update({ school: next, term: '' })}
      onTerm={(next) => update({ term: next })}
    />
  );

  return (
    <div className={`page plan-page${empty ? ' plan-empty' : ''}`}>
      <section className="plan-ask" aria-label="Plan assistant">
        {empty ? <h1 className="plan-title">Plan a semester in one sentence</h1> : (
          <div className="plan-head">
            <h1>Plan</h1>
            <button type="button" className="btn sm" onClick={startOver}>
              <IconPlus /> <span>New plan</span>
            </button>
          </div>
        )}
        {place}
        <div className={`composer${empty ? ' big' : ''}`}>
          <textarea
            ref={requestRef}
            id="plan-request"
            rows={1}
            value={text}
            maxLength={600}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKey}
            placeholder={empty ? PLACEHOLDER : 'Change anything: "move the lab to Tuesday", "no 9am"'}
            aria-label="What you need this semester"
            enterKeyHint="send"
            autoFocus={empty && window.matchMedia('(min-width: 900px)').matches}
          />
          <button type="button" className="send" onClick={() => void read()} disabled={!text.trim() || reading || !ready} aria-label="Plan">
            <IconArrow />
          </button>
        </div>
        {error && <div className="alert error">{error}</div>}
        {terms && regular.length === 0 && <div className="alert">No regular semester classes for {schoolLabel(schools, school)} are in the catalog yet. Choose another place above.</div>}
        {rows && rows.courses.length === 0 && <div className="alert">No classes for {schoolLabel(schools, school)} are in the catalog for {term}. Choose another semester above.</div>}
        {!empty && <Understood wants={saved.wants} rules={saved.rules} titles={titles} onWants={(wants) => update({ wants })} onRules={setRules} />}
        {reading ? (
          <p className="plan-reply thinking" role="status">
            <span className="spinner" aria-hidden="true" /> Reading your request…
          </p>
        ) : lastReply ? (
          <p className="plan-reply" role="status">{lastReply}</p>
        ) : null}
        {empty && (
          <div className="prompts" aria-label="Try">
            {EXAMPLES.map((example, i) => (
              <button type="button" key={example} style={{ '--i': i } as CSSProperties} disabled={!ready || reading} onClick={() => void read(example)}>
                {example}
              </button>
            ))}
          </div>
        )}
      </section>

      {!empty && !rows && !error && <div className="skeleton" style={{ height: 420 }} />}
      {result && result.problems.length > 0 && <Blocked problems={result.problems} onFix={applyFix} />}
      {result && result.options.length > 0 && (
        <Deck options={result.options} partial={result.partial} index={Math.min(index, result.options.length - 1)} onIndex={setIndex} rules={saved.rules} quality={quality} wants={saved.wants} timing={timing} scores={scores} />
      )}
    </div>
  );
}

function schoolLabel(schools: PlanSchool[], id: string): string {
  return schools.find((school) => school.id === id)?.label ?? id;
}

/** Where and when the plan is for, changed in this one place: a pill that opens the school and the semester. */
function WherePill({ open, onToggle, schools, school, terms, term, onSchool, onTerm }: { open: boolean; onToggle(): void; schools: PlanSchool[]; school: string; terms: Term[]; term: string; onSchool(id: string): void; onTerm(name: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  // A tap anywhere else, or Escape, folds it away.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => !box.current?.contains(event.target as Node) && onToggle();
    const escape = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && onToggle();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open, onToggle]);
  return (
    <div className="plan-where" ref={box}>
      <button type="button" className="where-pill" onClick={onToggle} aria-expanded={open} aria-controls="plan-where">
        {schoolLabel(schools, school)}
        {term && <span>· {term}</span>}
        <IconChevron className={open ? 'up' : undefined} />
      </button>
      {open && (
        <div className="where-sheet" id="plan-where">
          <label>
            <span>Where</span>
            <select className="input" value={school} onChange={(event) => onSchool(event.target.value)}>
              {!schools.some((entry) => entry.id === school) && <option value={school}>{school}</option>}
              {(['Campus', 'School', 'Study away'] as const).map((group) => (
                <optgroup key={group} label={group === 'Campus' ? 'Degree campuses' : group === 'School' ? 'Schools' : 'Study away sites'}>
                  {schools.filter((entry) => entry.group === group).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            <span>Semester</span>
            <select className="input" value={term} onChange={(event) => onTerm(event.target.value)} disabled={!terms.length}>
              {terms.map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

interface Chip {
  key: string;
  label: string;
  /** The course's colour in the week, for course chips. */
  color?: number;
  remove(): void;
}

/** What the planner understood, as chips under the box: the courses, then the rules, each one a tap to take away. */
function Understood({ wants, rules, titles, onWants, onRules }: { wants: PlanWant[]; rules: Rules; titles: Map<string, string>; onWants(wants: PlanWant[]): void; onRules(patch: Partial<Rules>): void }) {
  const without = <T,>(list: T[], item: T) => list.filter((entry) => entry !== item);
  const chips: Chip[] = [
    ...wants.map((want, i) => ({
      key: `want-${want.id}`,
      label: `${want.codes.length === 1 ? titles.get(want.codes[0]!) ?? want.codes[0]! : want.label || `One of ${want.codes.length}`}${want.sessions?.length === 1 ? (want.sessions[0] === '71' ? ', first 7 weeks' : ', second 7 weeks') : want.sessions?.length ? ', 7 weeks' : ''}`,
      color: i,
      remove: () => onWants(wants.filter((entry) => entry.id !== want.id)),
    })),
    ...(rules.earliest ? [{ key: 'earliest', label: `Nothing before ${clock(rules.earliest)}`, remove: () => onRules({ earliest: '' }) }] : []),
    ...(rules.latest ? [{ key: 'latest', label: `Done by ${clock(rules.latest)}`, remove: () => onRules({ latest: '' }) }] : []),
    ...rules.daysOff.map((day) => ({ key: `off-${day}`, label: `${DAY_NAMES[day] ?? day}s off`, remove: () => onRules({ daysOff: without(rules.daysOff, day) }) })),
    ...rules.avoidStarts.map((time) => ({ key: `avoid-${time}`, label: `No ${clock(time)} starts`, remove: () => onRules({ avoidStarts: without(rules.avoidStarts, time) }) })),
    ...rules.requiredStarts.map((time) => ({ key: `need-${time}`, label: `A ${clock(time)} class`, remove: () => onRules({ requiredStarts: without(rules.requiredStarts, time) }) })),
    ...(rules.maxPerDay ? [{ key: 'most', label: `At most ${rules.maxPerDay} a day`, remove: () => onRules({ maxPerDay: 0 }) }] : []),
    ...(rules.noBackToBack ? [{ key: 'gap', label: 'Breaks between classes', remove: () => onRules({ noBackToBack: false }) }] : []),
    ...(rules.shape !== 'any' ? [{ key: 'shape', label: rules.shape === 'compact' ? 'Fewer days on campus' : 'Lighter days', remove: () => onRules({ shape: 'any' }) }] : []),
    ...(rules.waitlisted ? [{ key: 'wait', label: 'Waitlists are fine', remove: () => onRules({ waitlisted: false }) }] : []),
    ...(!rules.bestRated ? [{ key: 'rated', label: 'Ratings ignored', remove: () => onRules({ bestRated: true }) }] : []),
    ...rules.prefer.map((name) => ({ key: `with-${name}`, label: `With ${name}`, remove: () => onRules({ prefer: without(rules.prefer, name) }) })),
    ...rules.avoid.map((name) => ({ key: `not-${name}`, label: `Not ${name}`, remove: () => onRules({ avoid: without(rules.avoid, name) }) })),
    ...rules.place.map((placed) => ({ key: `place-${placed.code}-${placed.component}`, label: `${placed.code} ${(SHORT[placed.component] ?? placed.component).toLowerCase()} on ${placed.days.join('/')}`, remove: () => onRules({ place: without(rules.place, placed) }) })),
  ];
  if (!chips.length) return null;
  return (
    <ul className="plan-chips" aria-label="What the plan follows">
      {chips.map((chip) => (
        <li key={chip.key} className={chip.color !== undefined ? 'course' : undefined} style={chip.color !== undefined ? ({ '--c': `var(--plan-${chip.color % 6})` } as CSSProperties) : undefined}>
          <span>{chip.label}</span>
          <button type="button" onClick={chip.remove} aria-label={`Remove ${chip.label}`}>
            <IconClose />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Nothing fits: what is in the way, and the changes that would let it fit, each a tap. */
function Blocked({ problems, onFix }: { problems: Array<{ text: string; fixes: Fix[] }>; onFix(fix: Fix): void }) {
  return (
    <section className="plan-blocked" role="status">
      <h2>Nothing fits yet</h2>
      {problems.map((problem) => (
        <div key={problem.text} className="blocked-item">
          <p>{problem.text}</p>
          {problem.fixes.length > 0 && (
            <div className="blocked-fixes">
              {problem.fixes.map((fix) => (
                <button key={fix.label} type="button" onClick={() => onFix(fix)} title={fix.detail}>
                  {fix.label}
                  {fix.detail && <small>{fix.detail}</small>}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

/** The plans that fit, best first, one week to a card: swipe or use the arrows to see the others. */
function Deck({ options, partial, index, onIndex, rules, quality, wants, timing, scores }: { options: Option[]; partial: boolean; index: number; onIndex(index: number): void; rules: Rules; quality: Quality; wants: PlanWant[]; timing: SiteTimes; scores: ScoreIndex | null }) {
  const track = useRef<HTMLDivElement>(null);
  const settling = useRef(false);
  // New plans start at the best one.
  const first = options.map((entry) => entry.choices.flatMap((choice) => choice.sections.map((section) => section.classNumber)).join()).join('|');
  useEffect(() => {
    track.current?.scrollTo({ left: 0 });
  }, [first]);

  const go = (to: number) => {
    const element = track.current;
    if (!element || to < 0 || to >= options.length) return;
    settling.current = true;
    element.scrollTo({ left: to * element.clientWidth, behavior: 'smooth' });
    onIndex(to);
    window.setTimeout(() => (settling.current = false), 450);
  };
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    if (settling.current) return;
    const element = event.currentTarget;
    const at = Math.round(element.scrollLeft / Math.max(1, element.clientWidth));
    if (at !== index) onIndex(at);
  };

  return (
    <section className="plan-deck" aria-label="Plans that fit" aria-roledescription="carousel">
      <div className="deck-bar">
        <div>
          <b>{index === 0 ? 'Best plan' : `Plan ${index + 1}`}</b>
          <span>
            {' '}
            of {options.length}
            {partial ? '+' : ''} that fit
          </span>
        </div>
        <div className="deck-nav">
          <button type="button" className="icon-btn" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous plan">
            <IconBack />
          </button>
          <span className="deck-dots" aria-hidden="true">
            {options.map((_, i) => (
              <i key={i} className={i === index ? 'on' : undefined} />
            ))}
          </span>
          <button type="button" className="icon-btn" onClick={() => go(index + 1)} disabled={index >= options.length - 1} aria-label="Next plan">
            <IconChevronRight />
          </button>
        </div>
      </div>
      <div className="deck-track" ref={track} onScroll={onScroll}>
        {options.map((option, i) => (
          <article key={i} className="deck-slide" aria-roledescription="slide" aria-label={`Plan ${i + 1} of ${options.length}`} inert={i !== index}>
            <PlanSummary option={option} rules={rules} quality={quality} />
            <WeekGrid option={option} timing={framed(timing, option)} daysOff={rules.daysOff} />
            <PlanList option={option} wants={wants} scores={scores} />
          </article>
        ))}
      </div>
    </section>
  );
}

/** The week framed on the plan's own hours, with an hour either side, so a phone shows classes, not empty mornings. */
function framed(timing: SiteTimes, option: Option): SiteTimes {
  const meetings = option.choices.flatMap((choice) => choice.sections.flatMap((section) => section.meetings.filter((meeting) => meeting.start && meeting.end && meeting.days.length)));
  if (!meetings.length) return timing;
  const from = Math.max(timing.from, Math.floor(Math.min(...meetings.map((meeting) => minutes(meeting.start))) / 60) * 60 - 60);
  const to = Math.min(timing.to, Math.ceil(Math.max(...meetings.map((meeting) => minutes(meeting.end))) / 60) * 60 + 60);
  return { ...timing, from, to: Math.max(to, from + 120) };
}

function PlanSummary({ option, rules, quality }: { option: Option; rules: Rules; quality: Quality }) {
  const why = highlights(option, rules, quality).join(' · ');
  const load = option.credits < LOAD.low ? `a light load (most take ${LOAD.usual})` : option.credits > LOAD.high ? `a heavy load (most take ${LOAD.usual})` : '';
  return (
    <p className="plan-summary">
      <b>{option.credits} credits</b>
      {load && <span className="off"> · {load}</span>}
      {why && <span> · {why}</span>}
    </p>
  );
}

/** The review digests' scores and verdicts for every course and professor, read once. */
function useScores(): ScoreIndex | null {
  const [scores, setScores] = useState<ScoreIndex | null>(null);
  useEffect(() => {
    api.courses
      .scores()
      .then(setScores)
      .catch(() => setScores({ courses: {}, profs: {} }));
  }, []);
  return scores;
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
  return sessionHalf(session) === '71' ? '1st half' : sessionHalf(session) === '72' ? '2nd half' : '';
}

/**
 * The week as a timetable, Monday to Friday and the weekend when a class meets then, with days off shaded. Blocks that
 * overlap (only ever the two seven-week halves) share the column in lanes; sections with no set time are listed below.
 */
function WeekGrid({ option, timing, daysOff, empty }: { option: Option | null; timing: SiteTimes; daysOff: string[]; empty?: string }) {
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
  const days = timing.days;
  for (const day of days) {
    const list = blocks.filter((block) => block.day === day);
    lanes(list).forEach((place, i) => Object.assign(list[i]!, place));
  }
  const from = Math.min(timing.from, ...blocks.map((block) => block.start));
  const to = Math.max(timing.to, ...blocks.map((block) => block.end));
  const ticks = Array.from({ length: Math.ceil((to - from) / 60) }, (_, index) => Math.ceil(from / 60) * 60 + index * 60).filter((time) => time >= from && time < to);
  const span = to - from;
  return (
    <div className={`week-grid${option ? '' : ' blank'}`} style={{ '--days': days.length, '--hours': span / 60 } as CSSProperties}>
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
          {ticks.map((time) => (
            <span key={time} style={{ top: `${((time - from) / span) * 100}%` }}>{`${String(Math.floor(time / 60)).padStart(2, '0')}:${String(time % 60).padStart(2, '0')}`}</span>
          ))}
        </div>
        {ticks.map((time) => <span key={`line-${time}`} className="wg-tick" style={{ top: `${((time - from) / span) * 100}%` }} aria-hidden="true" />)}
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
function PlanList({ option, wants, scores }: { option: Option; wants: PlanWant[]; scores: ScoreIndex | null }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const numbers = option.choices.flatMap((choice) => choice.sections.map((section) => section.classNumber));
  const byPerson = useMemo(() => new Map(Object.entries(scores?.profs ?? {}).map(([name, entry]) => [personKey(name), entry])), [scores]);
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
      <div className="class-numbers">
        <span>
          Class numbers <b>{numbers.join(', ')}</b>
        </span>
        <button type="button" className="btn primary sm" onClick={() => void copy()}>
          {copied ? <IconCheck className="pop-in" /> : <IconCopy />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {option.choices.map((choice) => (
        <ChoiceRow key={choice.code} choice={choice} color={wants.findIndex((want) => want.id === choice.want)} course={scores?.courses[choice.code]} profs={byPerson} />
      ))}
    </div>
  );
}

function ChoiceRow({ choice, color, course, profs }: { choice: Choice; color: number; course?: ScoreIndex['courses'][string]; profs: Map<string, ScoreIndex['profs'][string]> }) {
  // Which professor's verdict is open, as "class number:name".
  const [open, setOpen] = useState('');
  return (
    <div className="choice" style={{ '--c': `var(--plan-${Math.max(0, color) % 6})` } as CSSProperties}>
      <div className="choice-head">
        {/^[A-Z]+-UH /.test(choice.code) ? (
          <a className="choice-title" href={`/courses/${encodeURIComponent(choice.code)}`} onClick={onLinkClick}>
            <span className="code">{choice.code}</span>
            <b>{choice.title}</b>
          </a>
        ) : (
          <span className="choice-title">
            <span className="code">{choice.code}</span>
            <b>{choice.title}</b>
          </span>
        )}
        {course && (
          <span className="choice-rating" title={course.verdict || `Rated by ${course.basis} students in the group`}>
            {course.score.toFixed(1)}
          </span>
        )}
      </div>
      {choice.sections.map((section) => {
        const shown = open.startsWith(`${section.classNumber}:`) ? profs.get(personKey(open.slice(section.classNumber.length + 1))) : undefined;
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
                    const prof = profs.get(personKey(name));
                    const id = `${section.classNumber}:${name}`;
                    return (
                      <Fragment key={name}>
                        {i > 0 && ', '}
                        <span className="prof">
                          {name}
                          {prof?.verdict && (
                            <button type="button" className={`prof-score${open === id ? ' on' : ''}`} onClick={() => setOpen(open === id ? '' : id)} aria-expanded={open === id} aria-label={`${name}: what students say`}>
                              Reviews
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
                  From {shown.basis} {shown.basis === 1 ? 'student' : 'students'} in the group{shown.basis < 4 ? ', so take it lightly' : ''}.
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
