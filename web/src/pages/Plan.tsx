import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_RULES, minutes, solve, WEEKDAYS, type Choice, type Option, type Rules, type SolverCourse, type Want } from '../../../lib/schedule.ts';
import { api, ApiError, type CourseRating, type CourseRow, type Term } from '../api';
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
const STARTS = ['', '09:00', '10:00', '11:00', '12:00', '13:00'];
const ENDS = ['', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];
const DAY_LETTER: Record<string, string> = { Mon: 'M', Tue: 'T', Wed: 'W', Thu: 'Th', Fri: 'F', Sat: 'Sa', Sun: 'Su' };
const SHORT: Record<string, string> = { Lecture: 'Lec', Seminar: 'Sem', Recitation: 'Rec', Laboratory: 'Lab', Studio: 'Studio', Workshop: 'Wksp' };

/** The term students plan for: the newest fall or spring the schedule has, else the newest of any kind. */
function planTerm(terms: Term[]): string {
  return terms.find((term) => /^(fall|spring)/i.test(term.name))?.name ?? terms[0]?.name ?? '';
}

/** "MATH-UH 1012Q" and "MATH-UH 1012" are one course; the term's own code wins. */
function termCode(rows: CourseRow[], code: string): string | null {
  const base = (value: string) => value.replace(/^([A-Z]+-UH \d{4})[A-Z]*$/, '$1');
  return rows.find((row) => row.code === code)?.code ?? rows.find((row) => base(row.code) === base(code))?.code ?? null;
}

function clock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h! % 12 || 12}:${String(m).padStart(2, '0')}${h! < 12 ? 'am' : 'pm'}`;
}

/**
 * The schedule builder: say what you need in your own words or add courses one by one, set the rules, and see the
 * plans that fit as a week, best first. The planning runs in the browser (lib/schedule.ts); the model only reads the
 * request into courses and rules.
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
  const [index, setIndex] = useState(0);
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
  const result = useMemo(() => (rows && saved.wants.length ? solve(catalog, saved.wants, saved.rules) : null), [catalog, rows, saved.wants, saved.rules]);
  useEffect(() => setIndex(0), [result]);
  const option = result?.options[Math.min(index, result.options.length - 1)];

  const setRules = (patch: Partial<Rules>) => update({ rules: { ...saved.rules, ...patch } });
  const addCode = (code: string) => {
    if (saved.wants.some((want) => want.codes.length === 1 && want.codes[0] === code)) return;
    update({ wants: [...saved.wants, { id: uid(), label: '', codes: [code] }] });
  };
  const removeWant = (id: string) => update({ wants: saved.wants.filter((want) => want.id !== id) });

  const read = async () => {
    const request = text.trim();
    if (!request || reading || !term) return;
    setReading(true);
    setNotes([]);
    try {
      const plan = await api.plan.read({ term, text: request, current: { wants: saved.wants.map(({ label, codes }) => ({ label, codes })), rules: saved.rules }, major: profile?.major, year: profile?.year });
      // A reply with no courses at all is a misreading, not a request to empty the plan ("Start over" does that).
      const wants = plan.wants.length || saved.wants.length === 0 ? plan.wants.map((want) => ({ id: uid(), label: want.label, codes: want.codes })) : saved.wants;
      update({ wants, rules: { ...DEFAULT_RULES, ...plan.rules } });
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
                <span>Days off</span>
                <div className="day-toggles" role="group" aria-label="Days off">
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
              <div className="rule wide">
                <Segmented label="Shape of the week" value={saved.rules.shape} onChange={(shape) => setRules({ shape })} options={SHAPES} />
              </div>
              <div className="rule wide chips">
                <button type="button" className={`chip${saved.rules.lunch ? ' on' : ''}`} aria-pressed={saved.rules.lunch} onClick={() => setRules({ lunch: !saved.rules.lunch })}>
                  Lunch break
                </button>
                <button type="button" className={`chip${saved.rules.waitlisted ? ' on' : ''}`} aria-pressed={saved.rules.waitlisted} onClick={() => setRules({ waitlisted: !saved.rules.waitlisted })}>
                  Include waitlists
                </button>
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
            </div>
          </div>
        </div>

        <div className="plan-main" ref={mainRef}>
          {!rows && !error && <div className="skeleton" style={{ height: 420 }} />}
          {rows && saved.wants.length === 0 && (
            <div className="plan-empty">
              <WeekGrid option={null} />
            </div>
          )}
          {result && result.problems.length > 0 && (
            <div className="alert warn" role="status">
              {result.problems.map((problem) => (
                <p key={problem.text}>{problem.text}</p>
              ))}
            </div>
          )}
          {result && option && (
            <>
              <div className="option-bar">
                <button type="button" className="icon-btn" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={index === 0} aria-label="Previous plan">
                  <IconBack />
                </button>
                <div className="option-name">
                  <b>Plan {index + 1}</b>
                  <span>
                    of {result.options.length}
                    {result.partial ? '+' : ''} · {option.credits} credits · {option.days} {option.days === 1 ? 'day' : 'days'}
                  </span>
                </div>
                <button type="button" className="icon-btn" onClick={() => setIndex((current) => Math.min(result.options.length - 1, current + 1))} disabled={index >= result.options.length - 1} aria-label="Next plan">
                  <IconChevronRight />
                </button>
              </div>
              <WeekGrid option={option} />
              <PlanList option={option} wants={saved.wants} />
            </>
          )}
        </div>
      </div>
    </div>
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

interface Block {
  key: string;
  day: string;
  start: number;
  end: number;
  code: string;
  part: string;
  color: number;
  half: string;
  lane: number;
  lanes: number;
}

function halfOf(session: string): string {
  return session === 'First 7 weeks' ? '1st half' : session === 'Second 7 weeks' ? '2nd half' : '';
}

/** The week as a timetable, Monday to Friday; the two seven-week halves share a slot side by side. */
function WeekGrid({ option }: { option: Option | null }) {
  const blocks: Block[] = [];
  option?.choices.forEach((choice, color) => {
    for (const section of choice.sections) {
      for (const meeting of section.meetings) {
        if (!meeting.start) continue;
        for (const day of meeting.days) {
          blocks.push({ key: `${section.classNumber}-${day}-${meeting.start}`, day, start: minutes(meeting.start), end: minutes(meeting.end), code: choice.code, part: `${SHORT[section.component] ?? section.component} ${section.section}`, color, half: halfOf((section as { session?: string }).session ?? ''), lane: 0, lanes: 1 });
        }
      }
    }
  });
  const days = [...WEEKDAYS, ...(['Sat', 'Sun'] as const).filter((day) => blocks.some((block) => block.day === day))];
  for (const day of days) {
    const list = blocks.filter((block) => block.day === day).sort((a, b) => a.start - b.start);
    // Blocks that overlap (only ever the two halves of a term) split the column between them.
    for (const block of list) {
      const overlapping = list.filter((other) => other !== block && other.start < block.end && block.start < other.end);
      block.lanes = overlapping.length + 1;
      block.lane = overlapping.filter((other) => other.start < block.start || (other.start === block.start && list.indexOf(other) < list.indexOf(block))).length;
    }
  }
  const from = Math.min(8 * 60, ...blocks.map((block) => Math.floor(block.start / 60) * 60));
  const to = Math.max(19 * 60, ...blocks.map((block) => Math.ceil(block.end / 60) * 60));
  const hours = Array.from({ length: (to - from) / 60 }, (_, i) => from + i * 60);
  const span = to - from;
  const untimed = option?.choices.filter((choice) => choice.sections.every((section) => section.meetings.every((meeting) => !meeting.start))) ?? [];
  return (
    <div className="week-grid" style={{ '--days': days.length, '--hours': hours.length } as CSSProperties}>
      <div className="wg-head">
        <span />
        {days.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="wg-body">
        <div className="wg-times">
          {hours.map((hour) => (
            <span key={hour}>{clock(`${hour / 60}:00`).replace(':00', '')}</span>
          ))}
        </div>
        {days.map((day) => (
          <div key={day} className="wg-day">
            {blocks
              .filter((block) => block.day === day)
              .map((block) => (
                <div
                  key={block.key}
                  className="wg-block"
                  style={{ '--c': `var(--plan-${block.color % 6})`, top: `${((block.start - from) / span) * 100}%`, height: `${((block.end - block.start) / span) * 100}%`, left: `${(block.lane / block.lanes) * 100}%`, width: `${100 / block.lanes}%` } as CSSProperties}
                  title={`${block.code} ${block.part}${block.half ? `, ${block.half}` : ''}`}
                >
                  <div className="wg-card">
                    <b>{block.code.replace(/-UH/, '')}</b>
                    <span>{block.half || block.part}</span>
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
      {untimed.length > 0 && <p className="wg-note">No set time: {untimed.map((choice) => choice.code).join(', ')}</p>}
    </div>
  );
}

/** The plan as a list: each course's sections with their class numbers, ready for Albert's shopping cart. */
function PlanList({ option, wants }: { option: Option; wants: PlanWant[] }) {
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
        <ChoiceRow key={choice.code} choice={choice} color={wants.findIndex((want) => want.id === choice.want)} />
      ))}
      <button type="button" className="btn" onClick={() => void copy()}>
        {copied ? <IconCheck className="pop-in" /> : <IconCopy />} {copied ? 'Copied' : 'Copy class numbers'}
      </button>
    </div>
  );
}

function ChoiceRow({ choice, color }: { choice: Choice; color: number }) {
  const rating = useRating(choice.code);
  return (
    <div className="choice" style={{ '--c': `var(--plan-${Math.max(0, color) % 6})` } as CSSProperties}>
      <div className="choice-head">
        <a className="choice-title" href={`/courses/${encodeURIComponent(choice.code)}`} onClick={onLinkClick}>
          <span className="code">{choice.code}</span>
          <b>{choice.title}</b>
        </a>
        {rating && (
          <span className="choice-rating" title="AI rating from students in the group">
            {rating.score.toFixed(1)}
          </span>
        )}
      </div>
      {choice.sections.map((section) => (
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
          <span className="choice-who">{section.instructors.join(', ') || 'Instructor not listed'}</span>
          <span className="class-no">#{section.classNumber}</span>
        </div>
      ))}
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
