import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { matchingCourses } from '../../../lib/plan-request.ts';
import { clock, DAYS, DAY_NAMES, DEFAULT_RULES, highlights, lanes, minutes, normalizeRules, PRIMARY, sectionFits, sessionHalf, solve, WEEKDAYS, type Choice, type Fix, type Option, type Quality, type Rules, type SolverCourse, type Want } from '../../../lib/schedule.ts';
import { api, ApiError, type CourseRating, type CourseRow, type PlanSchool, type ProfRating, type Term } from '../api';
import { Segmented } from '../components/Segmented';
import { Sign } from '../components/Sign';
import { useApp } from '../context';
import { IconArrow, IconBack, IconBolt, IconCheck, IconChevronRight, IconClose, IconCopy } from '../icons';
import { navigate, onLinkClick, useRoute } from '../router';
import { loadPlan, savePlan, uid, type PlanMessage, type SavedPlan } from '../store';

type PlanWant = Want & { label: string };

const SHAPES: Array<{ id: Rules['shape']; label: string }> = [
  { id: 'any', label: 'Any' },
  { id: 'compact', label: 'Fewer days' },
  { id: 'spread', label: 'Lighter days' },
];
const SHAPE_HELP: Record<Rules['shape'], string> = {
  any: 'Balances gaps and class times.',
  compact: 'Packs classes into as few days on campus as it can, even with gaps.',
  spread: 'Spreads classes over the week so no day is long.',
};
const MOST_PER_DAY = 4;
const SHORT: Record<string, string> = { Lecture: 'Lec', Seminar: 'Sem', Recitation: 'Rec', Laboratory: 'Lab', Studio: 'Studio', Workshop: 'Wksp' };
/** How far a rating counts, by how sure it is: a thin one is pulled toward average. */
const TRUST: Record<ProfRating['confidence'], number> = { high: 1, medium: 0.8, low: 0.55 };
/** NYUAD's usual load is 16 credits a term; under 12 or over 18 is unusual. */
const LOAD = { usual: 16, low: 12, high: 18 };

interface SiteTimes { starts: string[]; ends: string[]; from: number; to: number; days: string[] }

function siteTimes(courses: CourseRow[], primary = false): SiteTimes {
  const meetings = courses.flatMap((course) => course.sections.filter((section) => section.status !== 'cancelled').flatMap((section) => section.meetings.filter((meeting) => meeting.days.length && meeting.start && meeting.end)));
  const lectures = primary ? courses.flatMap((course) => course.sections.filter((section) => section.status !== 'cancelled' && PRIMARY.includes(section.component)).flatMap((section) => section.meetings.filter((meeting) => meeting.days.length && meeting.start && meeting.end))) : [];
  const controls = lectures.length ? lectures : meetings;
  // Start with the site's recurring lecture slots; once courses are added, show all their actual meeting times.
  const slots = (field: 'start' | 'end') => {
    const counts = new Map<string, number>();
    for (const meeting of controls) counts.set(meeting[field], (counts.get(meeting[field]) ?? 0) + 1);
    const regular = primary ? [...counts].filter(([, count]) => count >= 5).map(([time]) => time) : [];
    return (regular.length ? regular : [...counts.keys()]).filter(Boolean).sort();
  };
  const starts = slots('start');
  const ends = slots('end');
  const from = starts.length ? Math.floor(minutes(starts[0]!) / 60) * 60 : 8 * 60;
  const to = ends.length ? Math.ceil(minutes(ends.at(-1)!) / 60) * 60 : 20 * 60;
  const taught = new Set(meetings.flatMap((meeting) => meeting.days));
  return { starts, ends, from, to: Math.max(to, from + 60), days: taught.size ? DAYS.filter((day) => taught.has(day)) : [...WEEKDAYS] };
}

/** Only regular semesters have the weekly schedule this planner models. */
function regularTerms(terms: Term[]): Term[] {
  return terms.filter((term) => /^(fall|spring)\b/i.test(term.name));
}

/** The term students plan for: the newest regular semester in the schedule. */
function planTerm(terms: Term[]): string {
  return regularTerms(terms)[0]?.name ?? '';
}

/** Albert sometimes drops trailing code attributes in a later term; the term's own code wins. */
function termCode(rows: CourseRow[], code: string): string | null {
  const base = (value: string) => value.replace(/^(\S+ \d+)[A-Z]+$/, '$1');
  return rows.find((row) => row.code === code)?.code ?? rows.find((row) => base(row.code) === base(code))?.code ?? null;
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
  const [schools, setSchools] = useState<PlanSchool[]>([]);
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [scraped, setScraped] = useState('');
  const [rows, setRows] = useState<{ term: string; courses: CourseRow[] } | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [viewing, setViewing] = useState<{ key: string; index: number } | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [courseQuery, setCourseQuery] = useState('');
  const requestRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const chat = saved.chat ?? [];
  const lastReply = chat.at(-1)?.role === 'assistant' ? chat.at(-1) : undefined;

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [chat.length, reading, showChat]);

  useEffect(() => {
    const element = requestRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(160, element.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    requestId.current++;
    setReading(false);
    return () => { requestId.current++; };
  }, [saved.term, saved.school]);
  const term = saved.term && regularTerms(terms ?? []).some((entry) => entry.name === saved.term) ? saved.term : planTerm(terms ?? []);

  const update = (patch: Partial<SavedPlan>) =>
    setSaved((current) => {
      const next = { ...current, ...patch };
      savePlan(next);
      return next;
    });

  useEffect(() => {
    api.courses.terms().then((result) => setSchools(result.schools ?? [])).catch((err) => setError(err instanceof Error ? err.message : 'Could not load the schools.'));
  }, []);

  useEffect(() => {
    if (schools.length && saved.school && !schools.some((school) => school.id === saved.school)) update({ school: '', term: '', wants: [], chat: [], rules: DEFAULT_RULES });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schools, saved.school]);

  useEffect(() => {
    if (!saved.school) { setTerms(null); return; }
    let live = true;
    setTerms(null);
    setError('');
    api.courses
      .terms(saved.school)
      .then((result) => { if (live) { setTerms(result.terms); setScraped(result.scraped); } })
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the terms.'));
    return () => { live = false; };
  }, [saved.school]);

  useEffect(() => {
    if (!term || !saved.school) { setRows(null); return; }
    let live = true;
    setRows(null);
    setError('');
    api.courses
      .list(term, saved.school)
      .then((result) => live && setRows(result))
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not load the courses.'));
    return () => {
      live = false;
    };
  }, [term, saved.school]);

  // "Add to a plan" from a course: add it once the term's courses are in, then take it out of the address.
  const adding = search.get('add');
  useEffect(() => {
    if (adding && !saved.school) update({ school: 'Abu Dhabi' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding, saved.school]);
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
  const courseMatches = useMemo(() => matchingCourses(rows?.courses ?? [], courseQuery, true), [rows, courseQuery]);
  const timing = useMemo(() => {
    const wanted = new Set(saved.wants.flatMap((want) => want.codes));
    const courses = rows?.courses ?? [];
    const selected = courses.filter((course) => wanted.has(course.code));
    return siteTimes(selected.length ? selected : courses, saved.school === 'Abu Dhabi' && selected.length === 0);
  }, [rows, saved.wants, saved.school]);

  // Who could teach in a plan: the professors of every section the rules allow, lecturers of named courses first.
  const candidates = useMemo(() => {
    const lead: string[] = [];
    const rest: string[] = [];
    for (const want of [...saved.wants].sort((a, b) => a.codes.length - b.codes.length)) {
      for (const code of want.codes) {
        for (const section of catalog.get(code)?.sections ?? []) if (sectionFits(section, saved.rules) && (!want.sessions?.length || want.sessions.some((half) => half === sessionHalf(section.session)))) (PRIMARY.includes(section.component) ? lead : rest).push(...section.instructors);
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
  const result = useMemo(() => (rows && saved.wants.length ? solve(catalog, saved.wants, saved.rules, settled, { options: 3, ms: 1200 }) : null), [catalog, rows, saved.wants, saved.rules, settled]);

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
  const removeWant = (id: string) => update({ wants: saved.wants.filter((want) => want.id !== id) });
  const applyFix = (fix: Fix) =>
    update({
      ...(fix.drop ? { wants: saved.wants.filter((want) => want.id !== fix.drop) } : {}),
      ...(fix.rules ? { rules: { ...saved.rules, ...fix.rules } } : {}),
    });

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

  const read = async (value = text) => {
    const request = value.trim();
    if (!request || reading || !term || !saved.school || !rows?.courses.length) return;
    const id = ++requestId.current;
    const conversation: PlanMessage[] = [...chat, { role: 'user' as const, text: request }].slice(-23);
    update({ chat: conversation });
    setText('');
    setReading(true);
    try {
      const plan = await api.plan.read({ term, school: saved.school, text: request, history: chat.slice(-8), current: { wants: saved.wants.map(({ label, codes, sessions }) => ({ label, codes, sessions })), rules: saved.rules }, major: profile?.major, year: profile?.year });
      if (requestId.current !== id) return;
      // A reply with no courses at all is a misreading, not a request to empty the plan ("Start over" does that).
      const wants = plan.wants.length || saved.wants.length === 0 ? plan.wants.map((want) => ({ id: uid(), label: want.label, codes: want.codes, sessions: want.sessions })) : saved.wants;
      const names = wants.map((want) => want.label || titles.get(want.codes[0]!) || want.codes[0]);
      const rules = normalizeRules(plan.rules);
      const summary = [
        names.length ? `Your plan includes ${names.join(', ')}.` : 'Your preferences are saved. Add a course to build your week.',
        rules.earliest ? `No classes before ${clock(rules.earliest)}.` : '',
        rules.latest ? `Done by ${clock(rules.latest)}.` : '',
        rules.daysOff.length ? `${rules.daysOff.join(', ')} off.` : '',
        ...wants.filter((want) => want.sessions?.length).map((want) => `${want.label || titles.get(want.codes[0]!) || want.codes[0]}: ${want.sessions!.join(' or ')} (${want.sessions!.length === 2 ? 'either seven-week half' : want.sessions![0] === '71' ? 'first seven weeks' : 'second seven weeks'}).`),
        ...plan.missing,
      ].filter(Boolean).join(' ');
      const reply = plan.reply ? [plan.reply, ...plan.missing.filter((note) => !plan.reply!.includes(note))].join(' ') : summary;
      update({ wants, rules, chat: [...conversation, { role: 'assistant', text: reply }] });
    } catch (err) {
      if (requestId.current === id) {
        setText((current) => current || request);
        update({ chat: [...conversation, { role: 'assistant', text: err instanceof ApiError || err instanceof Error ? err.message : 'Could not read that. Try again.' }] });
      }
    } finally {
      if (requestId.current === id) setReading(false);
    }
  };

  const clear = () => {
    update({ wants: [], rules: DEFAULT_RULES, chat: [] });
    setShowChat(false);
  };

  const rated = candidates.filter((name) => profRatings.get(name)).length;
  const unread = candidates.filter((name) => !profRatings.has(name)).length;

  return (
    <div className="page plan-page">
      <Sign title="Plan" ar="الجدول" sub="Add your courses and see the weeks that fit. Change anything in plain language.">
        {saved.school && terms && terms.length > 0 && (
          <label className="term-pick">
            <span className="sr-only">Semester</span>
            <select className="input" value={term} onChange={(event) => { setRows(null); setText(''); update({ term: event.target.value, wants: [], chat: [] }); }} aria-label="Semester">
              {regularTerms(terms).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.name}{entry.courses !== undefined ? ` · ${entry.courses} ${entry.courses === 1 ? 'course' : 'courses'}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {(saved.wants.length > 0 || chat.length > 0) && (
          <button type="button" className="btn ghost sm" onClick={clear}>
            Start over
          </button>
        )}
      </Sign>
      {error && <div className="alert error">{error}</div>}

      <div className="plan-school">
        <div>
          <label htmlFor="plan-school">Where are you studying?</label>
          <p>Only classes taught there appear. Times are local to the selected site.{scraped && saved.school ? ` Catalog updated: ${new Date(scraped).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : ''}</p>
        </div>
        <select id="plan-school" className="input" value={saved.school} onChange={(event) => { setRows(null); setText(''); update({ school: event.target.value, wants: [], chat: [], rules: DEFAULT_RULES }); }}>
          <option value="">Choose a school or site</option>
          {(['Campus', 'School', 'Study away'] as const).map((group) => <optgroup key={group} label={group === 'Campus' ? 'Degree campuses' : group === 'School' ? 'Schools' : 'Study away sites'}>{schools.filter((school) => school.group === group).map((school) => <option key={school.id} value={school.id}>{school.label}</option>)}</optgroup>)}
        </select>
      </div>
      {saved.school && terms && regularTerms(terms).length === 0 && <div className="alert">No regular semester classes for this school or site are in the catalog yet.</div>}
      {saved.school && rows?.courses.length === 0 && <div className="alert">No classes for this school or site are in the catalog for {term}. Try another semester.</div>}
      {saved.school && rows?.courses.length ? <>

      <section className="assistant" aria-label="Plan assistant">
        <div className="composer assistant-bar">
          <span className="assistant-mark" aria-hidden="true">
            <IconBolt />
          </span>
          <textarea
            ref={requestRef}
            id="plan-request"
            rows={1}
            value={text}
            maxLength={600}
            disabled={reading}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void read();
              }
            }}
            placeholder={saved.wants.length ? 'Change anything: "no 8:30am or 5pm classes"' : 'CSO, Algo, French1, Probs and Stats…'}
            aria-label="Tell the plan assistant what you need"
            enterKeyHint="send"
          />
          <button type="button" className="send" onClick={() => void read()} disabled={!text.trim() || reading || !rows?.courses.length} aria-label="Send to the plan assistant">
            <IconArrow />
          </button>
        </div>
        {reading ? (
          <p className="assistant-reply thinking" role="status">
            <span className="spinner" aria-hidden="true" /> Reading your request…
          </p>
        ) : lastReply ? (
          <div className="assistant-reply">
            <p>{lastReply.text}</p>
            {chat.length > 2 && (
              <button type="button" className="link-btn" onClick={() => setShowChat((current) => !current)} aria-expanded={showChat}>
                {showChat ? 'Hide conversation' : `Show conversation (${chat.filter((message) => message.role === 'user').length})`}
              </button>
            )}
          </div>
        ) : (
          <div className="assistant-ideas" aria-label="Try">
            {IDEAS.map((idea) => (
              <button
                key={idea}
                type="button"
                disabled={reading}
                onClick={() => void read(idea)}
              >
                {idea}
              </button>
            ))}
          </div>
        )}
        {showChat && chat.length > 2 && (
          <div className="assistant-log" ref={chatRef} role="log" aria-label="Planning conversation">
            {chat.slice(0, -1).map((message, i) => (
              <div key={i} className={`plan-message ${message.role}`}>
                {message.text}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className={`plan${option ? ' has-plan' : ''}`}>
        <fieldset className="plan-side" disabled={reading}>
          <section className="plan-block" aria-labelledby="plan-courses">
            <div className="plan-block-head">
              <h2 id="plan-courses">Courses</h2>
              {saved.wants.length > 0 && <Load low={credits.low} high={credits.high} />}
            </div>
            {saved.wants.length > 0 ? (
              <div className="wants">
                {saved.wants.map((want, i) => (
                  <WantRow key={want.id} want={want} color={i} titles={titles} problem={result?.problems.find((problem) => problem.want === want.id)?.text} onRemove={() => removeWant(want.id)} onChoose={(code) => update({ wants: saved.wants.map((entry) => entry.id === want.id ? { ...entry, label: '', codes: [code] } : entry) })} />
                ))}
              </div>
            ) : (
              <p className="plan-empty-note">
                Search below to add a course, or type your course list above.
              </p>
            )}
            <label className="wf-field" htmlFor="plan-course-search">
              <span>Add a course</span>
              <input id="plan-course-search" className="input" value={courseQuery} placeholder="Course name, code or CSO…" onChange={(event) => setCourseQuery(event.target.value)} type="search" autoComplete="off" />
            </label>
            {courseQuery.trim() && <div className="plan-course-results" aria-label="Matching courses">
              {courseMatches.slice(0, 8).map((course) => {
                const added = saved.wants.some((want) => want.codes.length === 1 && want.codes[0] === course.code);
                return <button key={course.code} type="button" disabled={added || saved.wants.length >= 8} onClick={() => {
                  update({ wants: [...saved.wants, { id: uid(), label: '', codes: [course.code] }] });
                  setCourseQuery('');
                }}><span><b>{course.title}</b><small>{course.code} · {course.credits} credits</small></span>{added ? <IconCheck /> : <IconArrow />}</button>;
              })}
              {!courseMatches.length && <p className="plan-empty-note">No matching course in {term} at this site. Try another name or semester.</p>}
            </div>}
            {(saved.rules.prefer.length > 0 || saved.rules.avoid.length > 0) && (
              <div className="chips plan-people" aria-label="Professors you asked for">
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
          </section>

          <WeekFilter rules={saved.rules} timing={timing} onChange={setRules} ratings={saved.rules.bestRated && candidates.length > 0 ? (unread > 0 ? `Reading about ${unread} more professors…` : rated ? `${rated} of ${candidates.length} professors rated.` : 'No professor rated yet.') : 'From what students wrote about them.'} />
        </fieldset>

        <div className="plan-main">
          {!rows && !error && <div className="skeleton" style={{ height: 420 }} />}
          {rows && saved.wants.length === 0 && <WeekGrid option={null} timing={timing} daysOff={saved.rules.daysOff} empty="Add courses to see your week." />}
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
              <WeekGrid option={null} timing={timing} daysOff={saved.rules.daysOff} empty="Nothing fits yet." />
            </>
          )}
          {result && option && (
            <>
              <div className="option-bar">
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
                <div className="option-nav">
                  <button type="button" className="icon-btn" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous plan">
                    <IconBack />
                  </button>
                  <button type="button" className="icon-btn" onClick={() => go(index + 1)} disabled={index >= result.options.length - 1} aria-label="Next plan">
                    <IconChevronRight />
                  </button>
                </div>
              </div>
              <WeekGrid option={option} timing={timing} daysOff={saved.rules.daysOff} />
              <PlanList option={option} wants={saved.wants} profs={profRatings} />
            </>
          )}
        </div>
      </div>
      </> : null}
    </div>
  );
}

const IDEAS = ['Nothing before 10, Fridays off', 'No 8:30am or 5pm classes', 'At most two classes a day'];

/** The week's rules in a line, for the folded preferences. */
function rulesSummary(rules: Rules): string {
  return [
    rules.earliest ? `From ${clock(rules.earliest)}` : '',
    rules.latest ? `done by ${clock(rules.latest)}` : '',
    rules.requiredStarts.length ? `include ${rules.requiredStarts.map(clock).join(' and ')} starts` : '',
    rules.avoidStarts.length ? `no ${rules.avoidStarts.map(clock).join(' or ')} starts` : '',
    rules.daysOff.length ? `${rules.daysOff.join(', ')} off` : '',
    rules.maxPerDay ? `max ${rules.maxPerDay} a day` : '',
    rules.shape === 'compact' ? 'fewer days' : rules.shape === 'spread' ? 'lighter days' : '',
    rules.noBackToBack ? 'breaks between' : '',
    rules.waitlisted ? 'waitlists ok' : '',
  ]
    .filter(Boolean)
    .join(' · ')
    .replace(/^./, (first) => first.toUpperCase());
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

/**
 * The week's rules, always in view: a bar of the teaching day with the hours you keep free hatched, the start and end
 * that set it, the days you want off, how many classes a day, the shape of the week and three switches.
 */
function WeekFilter({ rules, timing, onChange, ratings }: { rules: Rules; timing: SiteTimes; onChange(patch: Partial<Rules>): void; ratings: string }) {
  const { from, to } = timing;
  const start = rules.earliest ? minutes(rules.earliest) : from;
  const end = rules.latest ? minutes(rules.latest) : to;
  const share = (time: number) => `${((Math.min(to, Math.max(from, time)) - from) / (to - from)) * 100}%`;
  const changed = rules.earliest || rules.latest || rules.requiredStarts.length || rules.avoidStarts.length || rules.daysOff.length || rules.maxPerDay || rules.shape !== 'any' || rules.noBackToBack || rules.waitlisted || !rules.bestRated;
  const summary = rulesSummary(rules);
  return (
    <section className="plan-block week-filter" aria-labelledby="plan-week">
      <div className="plan-block-head">
        <h2 id="plan-week">Your week</h2>
        {changed ? (
          <button type="button" className="link-btn small" onClick={() => onChange({ ...DEFAULT_RULES, avoid: rules.avoid, prefer: rules.prefer })}>
            Reset
          </button>
        ) : null}
      </div>
      <p className="wf-summary">{summary || 'Any time, any day.'}</p>

      <div className="wf-window" aria-hidden="true">
        <div className="wf-track">
          <span className="wf-band" style={{ left: share(start), right: `calc(100% - ${share(end)})` }} />
          {Array.from({ length: Math.floor((to - from) / 60) - 1 }, (_, index) => from + (index + 1) * 60).map((time) => <i key={time} style={{ left: share(time) }} />)}
        </div>
        <div className="wf-ends">
          <span>{clock(from)}</span>
          <span>{clock(to)}</span>
        </div>
      </div>
      <div className="wf-times">
        <label className="wf-field">
          <span>Earliest start</span>
          <select className="input" value={rules.earliest} onChange={(event) => onChange({ earliest: event.target.value })}>
            {['', ...new Set([...timing.starts, rules.earliest].filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((time) => (
              <option key={time} value={time}>
                {time ? clock(time) : 'Any time'}
              </option>
            ))}
          </select>
        </label>
        <label className="wf-field">
          <span>Done by</span>
          <select className="input" value={rules.latest} onChange={(event) => onChange({ latest: event.target.value })}>
            {['', ...new Set([...timing.ends, rules.latest].filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((time) => (
              <option key={time} value={time}>
                {time ? clock(time) : 'Any time'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <details className="plan-starts">
        <summary>Specific class starts{rules.requiredStarts.length + rules.avoidStarts.length ? ` (${rules.requiredStarts.length + rules.avoidStarts.length})` : ''}</summary>
        <p className="rule-help">Choose a time once to include it, again to avoid it, and again to clear.</p>
        <div className="chips" aria-label="Specific class starts">
          {[...new Set([...timing.starts, ...rules.requiredStarts, ...rules.avoidStarts])].sort().map((time) => {
            const wanted = rules.requiredStarts.includes(time);
            const avoided = rules.avoidStarts.includes(time);
            return <button key={time} type="button" className={`chip${wanted ? ' on' : avoided ? ' on avoid' : ''}`} aria-label={`${clock(time)}: ${wanted ? 'required' : avoided ? 'avoided' : 'any'}`} onClick={() => onChange({ requiredStarts: wanted || avoided ? rules.requiredStarts.filter((entry) => entry !== time) : [...rules.requiredStarts, time], avoidStarts: wanted ? [...rules.avoidStarts, time] : rules.avoidStarts.filter((entry) => entry !== time) })}>{wanted ? 'Include ' : avoided ? 'Avoid ' : ''}{clock(time)}</button>;
          })}
        </div>
      </details>

      <div className="wf-row">
        <span className="wf-label" id="wf-days">
          Days on campus
        </span>
        <div className="wf-days" role="group" aria-labelledby="wf-days">
          {timing.days.map((day) => {
            const off = rules.daysOff.includes(day);
            return (
              <button key={day} type="button" className={`wf-day${off ? ' off' : ''}`} aria-pressed={off} aria-label={`${DAY_NAMES[day]}: ${off ? 'off' : 'on campus'}`} onClick={() => onChange({ daysOff: off ? rules.daysOff.filter((entry) => entry !== day) : [...rules.daysOff, day] })}>
                <b>{day}</b>
                <small>{off ? 'Off' : 'On'}</small>
              </button>
            );
          })}
        </div>
      </div>

      <div className="wf-row wf-inline">
        <span className="wf-label" id="wf-most">
          Classes a day
        </span>
        <div className="stepper" role="group" aria-labelledby="wf-most">
          <button type="button" onClick={() => onChange({ maxPerDay: Math.max(0, (rules.maxPerDay || MOST_PER_DAY + 1) - 1) })} disabled={rules.maxPerDay === 1} aria-label="Fewer classes a day">
            −
          </button>
          <output aria-live="polite">{rules.maxPerDay ? `At most ${rules.maxPerDay}` : 'Any'}</output>
          <button type="button" onClick={() => onChange({ maxPerDay: rules.maxPerDay && rules.maxPerDay < MOST_PER_DAY ? rules.maxPerDay + 1 : 0 })} disabled={rules.maxPerDay === 0} aria-label="More classes a day">
            +
          </button>
        </div>
      </div>

      <div className="wf-row">
        <span className="wf-label">Shape</span>
        <Segmented label="Shape of the week" value={rules.shape} onChange={(shape) => onChange({ shape })} options={SHAPES} />
        <small className="rule-help">{SHAPE_HELP[rules.shape]}</small>
      </div>

      <div className="switches">
        <Switch on={rules.bestRated} onChange={(bestRated) => onChange({ bestRated })} label="Best-rated professors first">
          {ratings}
        </Switch>
        <Switch on={rules.noBackToBack} onChange={(noBackToBack) => onChange({ noBackToBack })} label="No back-to-back">
          Leave a break between classes.
        </Switch>
        <Switch on={rules.waitlisted} onChange={(waitlisted) => onChange({ waitlisted })} label="Include waitlists">
          Full sections you could waitlist.
        </Switch>
      </div>
    </section>
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

function WantRow({ want, color, titles, problem, onRemove, onChoose }: { want: PlanWant; color: number; titles: Map<string, string>; problem?: string; onRemove(): void; onChoose(code: string): void }) {
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
            <details className="plan-starts">
              <summary>Choose a specific course</summary>
              <div className="plan-course-results">{want.codes.map((code) => <button key={code} type="button" onClick={() => onChoose(code)}><span><b>{titles.get(code) ?? code}</b><small>{code}</small></span><IconArrow /></button>)}</div>
            </details>
          </>
        )}
        {want.sessions?.length ? <span className="want-any">7 weeks · {want.sessions.join(' or ')}</span> : null}
        {problem && <span className="want-problem">{problem}</span>}
      </div>
      <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove">
        <IconClose />
      </button>
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
