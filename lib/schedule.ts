/**
 * The schedule builder's solver, after Horarium's (github.com/Phoenix-3139/Horarium). Each course a student wants
 * becomes the ways to take it: one section of every component it has, a lecture paired with its own recitation or lab
 * where Albert numbers them alike, and only sections that fit the student's hard rules (seats, days off, hours,
 * professors to avoid). A backtracking search, the most constrained course first, finds the combinations where no two
 * classes meet at the same time in overlapping weeks (so first and second seven-week halves never clash), within the
 * rules about the whole week (classes a day, breaks between them), and ranks them by the student's soft preferences
 * and by how students rate the professors and courses. When nothing fits it says why, and which change to the rules
 * or which course to drop would fix it. Pure, so the browser runs it on every edit.
 */

export type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export const WEEKDAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAYS: string[] = [...WEEKDAYS, 'Sat', 'Sun'];
export const DAY_NAMES: Record<string, string> = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

export interface SolverMeeting {
  days: string[];
  /** HH:MM, or empty when Albert lists no time. */
  start: string;
  end: string;
}

export interface SolverSection {
  classNumber: string;
  section: string;
  component: string;
  topic: string;
  status: 'open' | 'waitlist' | 'closed' | 'cancelled';
  instructors: string[];
  meetings: SolverMeeting[];
  /** YYYY-MM-DD; seven-week halves and study-away sessions cover part of the term. Empty when unknown. */
  startDate: string;
  endDate: string;
}

export interface SolverCourse {
  code: string;
  title: string;
  credits: string;
  sections: SolverSection[];
}

/** One slot in the plan, filled by any one of these courses. */
export interface Want {
  id: string;
  codes: string[];
  /** What the student called a slot with several courses ("an Arts Core"), for messages. */
  label?: string;
}

export interface Rules {
  /** No class starting before this (HH:MM), or empty. */
  earliest: string;
  /** No class ending after this (HH:MM), or empty. */
  latest: string;
  daysOff: string[];
  /** The most classes on any one day, or 0 for no limit. */
  maxPerDay: number;
  /** A break of at least BREAK minutes between classes of different courses. */
  noBackToBack: boolean;
  /** compact: fewer days on campus; spread: lighter days. */
  shape: 'any' | 'compact' | 'spread';
  /** Waitlisted and closed sections count too. */
  waitlisted: boolean;
  /** Rank by how students rate the professors, and the courses when a slot has several. */
  bestRated: boolean;
  /** Professors to keep out of the plan, and to look for. Matched on every word of the name. */
  avoid: string[];
  prefer: string[];
}

export const DEFAULT_RULES: Rules = { earliest: '', latest: '', daysOff: [], maxPerDay: 0, noBackToBack: false, shape: 'any', waitlisted: false, bestRated: true, avoid: [], prefer: [] };

/** Back to back at NYUAD is the 10 minutes between slots; a break is anything longer. */
export const BREAK = 15;

/** Rules saved by any version of the page, made whole: missing fields get their defaults, retired ones (lunch) go. */
export function normalizeRules(raw: unknown): Rules {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const time = (entry: unknown) => (typeof entry === 'string' && /^\d{2}:\d{2}$/.test(entry) ? entry : '');
  const names = (entry: unknown) => (Array.isArray(entry) ? [...new Set(entry.filter((name): name is string => typeof name === 'string' && name.trim() !== ''))].slice(0, 12) : []);
  const most = Number(value.maxPerDay);
  return {
    earliest: time(value.earliest),
    latest: time(value.latest),
    daysOff: Array.isArray(value.daysOff) ? DAYS.filter((day) => (value.daysOff as unknown[]).includes(day)) : [],
    maxPerDay: Number.isInteger(most) && most >= 1 && most <= 6 ? most : 0,
    noBackToBack: value.noBackToBack === true,
    shape: value.shape === 'compact' || value.shape === 'spread' ? value.shape : 'any',
    waitlisted: value.waitlisted === true,
    bestRated: value.bestRated !== false,
    avoid: names(value.avoid),
    prefer: names(value.prefer),
  };
}

/** How students rate professors and courses, 1 to 5; anyone or anything missing counts as average. */
export interface Quality {
  /** By the name Albert lists, as on the sections. */
  profs: Map<string, number>;
  /** By course code. */
  courses: Map<string, number>;
}

const AVERAGE = 3;
/** Points a whole star of the main professor is worth: more than an 8:30 twice a week or an hour's gap on two days, far less than a rule. */
const PROF_WEIGHT = 24;
/** A recitation or lab leader counts for about a third of the lecturer. */
const SECONDARY_WEIGHT = 0.35;
const COURSE_WEIGHT = 14;

/** One course in a plan, with the sections that make it up. */
export interface Choice {
  want: string;
  code: string;
  title: string;
  credits: number;
  sections: SolverSection[];
}

export interface Option {
  choices: Choice[];
  score: number;
  credits: number;
  days: number;
}

/** A change that would let more fit: a rule to loosen or a course to drop. */
export interface Fix {
  /** What to do, short enough for a button: "Include waitlists", "Allow Friday classes". */
  label: string;
  rules?: Partial<Rules>;
  /** The want to drop. */
  drop?: string;
  /** What it lets in, when that is one section: "MATH-UH 1012 Lecture 002 (Tue Thu 8:30am) is waitlisted". */
  detail?: string;
}

export interface Problem {
  /** The want it is about, or empty when it is about the plan as a whole. */
  want: string;
  text: string;
  fixes: Fix[];
}

export interface Solved {
  options: Option[];
  problems: Problem[];
  /** The search stopped at its time limit, so better options may exist. */
  partial: boolean;
}

/** The components a course is built around; recitations and labs go with them. */
export const PRIMARY = ['Lecture', 'Seminar', 'Studio', 'Workshop'];

export function minutes(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

/** "13:05" or 785 -> "1:05pm"; a whole hour is "1pm". */
export function clock(time: string | number): string {
  const total = typeof time === 'number' ? time : minutes(time);
  if (!Number.isFinite(total)) return '';
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${hour < 12 ? 'am' : 'pm'}`;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** "A", "A and B", "A, B and C". */
function list(items: string[], joiner = 'and'): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`;
}

/** Whether a professor rule ("potsch", "Prof. Thomas Pötsch") names one of these instructors: every word of it must appear. */
export function namesPerson(instructors: string[], rule: string): boolean {
  const words = fold(rule)
    .split(/[\s,.]+/)
    .filter((word) => word.length > 1 && !['prof', 'professor', 'dr'].includes(word));
  if (words.length === 0) return false;
  return instructors.some((name) => {
    const folded = fold(name);
    return words.every((word) => folded.includes(word));
  });
}

type Blocker = 'seats' | 'days' | 'hours' | 'professor';

/**
 * Why a section is out under the hard rules, or null when it fits them. The student's own rules come before seats: a
 * full section on a day off is out because of the day, and freeing the day is the change that would matter.
 */
function blocker(section: SolverSection, rules: Rules): Blocker | null {
  if (section.meetings.some((meeting) => meeting.days.some((day) => rules.daysOff.includes(day)))) return 'days';
  const earliest = rules.earliest ? minutes(rules.earliest) : NaN;
  const latest = rules.latest ? minutes(rules.latest) : NaN;
  if (section.meetings.some((meeting) => meeting.start && (minutes(meeting.start) < earliest || minutes(meeting.end) > latest))) return 'hours';
  if (rules.avoid.some((rule) => namesPerson(section.instructors, rule))) return 'professor';
  if (section.status !== 'open' && !rules.waitlisted) return 'seats';
  return null;
}

/** Whether a section can be in a plan under these rules. */
export function sectionFits(section: SolverSection, rules: Rules): boolean {
  return section.status !== 'cancelled' && blocker(section, rules) === null;
}

function offDays(sections: SolverSection[], rules: Rules): string[] {
  return DAYS.filter((day) => rules.daysOff.includes(day) && sections.some((section) => section.meetings.some((meeting) => meeting.days.includes(day))));
}

/** Why a course is out, said of the course or, when only its recitation or lab fails, of that component. */
function why(kind: Blocker, component: string | null, sections: SolverSection[], rules: Rules): string {
  const part = component?.toLowerCase();
  const every = `has every ${part ?? 'section'}`;
  if (kind === 'seats') return part ? `has no ${part} with open seats` : 'has no open seats';
  if (kind === 'days') {
    const days = offDays(sections, rules);
    return `${every} on ${list(days.map((day) => DAY_NAMES[day]!), 'or')}, your ${days.length > 1 ? 'days' : 'day'} off`;
  }
  if (kind === 'hours') {
    const early = !!rules.earliest && sections.some((section) => section.meetings.some((meeting) => meeting.start && minutes(meeting.start) < minutes(rules.earliest)));
    const late = !!rules.latest && sections.some((section) => section.meetings.some((meeting) => meeting.end && minutes(meeting.end) > minutes(rules.latest)));
    if (early && late) return `${every} starting before ${clock(rules.earliest)} or ending after ${clock(rules.latest)}`;
    return early ? `${every} starting before ${clock(rules.earliest)}` : `${every} ending after ${clock(rules.latest)}`;
  }
  const names = [...new Set(sections.flatMap((section) => section.instructors.filter((name) => rules.avoid.some((rule) => namesPerson([name], rule)))))];
  return `${part ? `${every}` : 'is only'} taught by ${list(names, 'or')}, who you asked to avoid`;
}

/** Why some of a course's sections are out, when they are out for different reasons: "2 meet on Friday, your day off". */
function some(kind: Blocker, sections: SolverSection[], rules: Rules): string {
  const one = sections.length === 1;
  const count = one ? 'one' : String(sections.length);
  if (kind === 'seats') return `${count} ${one ? 'is' : 'are'} full`;
  if (kind === 'days') {
    const days = offDays(sections, rules);
    return `${count} ${one ? 'meets' : 'meet'} on ${list(days.map((day) => DAY_NAMES[day]!), 'or')}, your ${days.length > 1 ? 'days' : 'day'} off`;
  }
  if (kind === 'hours') {
    const early = !!rules.earliest && sections.some((section) => section.meetings.some((meeting) => meeting.start && minutes(meeting.start) < minutes(rules.earliest)));
    return early ? `${count} ${one ? 'starts' : 'start'} before ${clock(rules.earliest)}` : `${count} ${one ? 'ends' : 'end'} after ${clock(rules.latest)}`;
  }
  const names = [...new Set(sections.flatMap((section) => section.instructors.filter((name) => rules.avoid.some((rule) => namesPerson([name], rule)))))];
  return `${count} ${one ? 'is' : 'are'} taught by ${list(names, 'or')}`;
}

/** "Tue Thu 8:30am", or "no set time". */
function when(section: SolverSection): string {
  const timed = section.meetings.filter((meeting) => meeting.start);
  return timed.length ? timed.map((meeting) => `${meeting.days.join(' ')} ${clock(meeting.start)}`).join(', ') : 'no set time';
}

/** "001" and "REC1" -> 1; "LAB" -> null. */
function number(section: SolverSection): number | null {
  const match = /(\d+)$/.exec(section.section);
  return match ? Number(match[1]) : null;
}

function datesOverlap(a: SolverSection, b: SolverSection): boolean {
  if (!a.startDate || !a.endDate || !b.startDate || !b.endDate) return true;
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/** Whether two sections meet at once in some week, or within `gap` minutes of each other. */
function sectionsClash(a: SolverSection, b: SolverSection, gap = 0): boolean {
  if (!datesOverlap(a, b)) return false;
  for (const x of a.meetings) {
    if (!x.start) continue;
    for (const y of b.meetings) {
      if (!y.start || !x.days.some((day) => y.days.includes(day))) continue;
      if (minutes(x.start) < minutes(y.end) + gap && minutes(y.start) < minutes(x.end) + gap) return true;
    }
  }
  return false;
}

function choicesClash(a: Choice, b: Choice, gap = 0): boolean {
  for (const x of a.sections) for (const y of b.sections) if (sectionsClash(x, y, gap)) return true;
  return false;
}

interface Block {
  day: string;
  start: number;
  end: number;
  /** The weeks it runs, for telling the seven-week halves apart. */
  from: string;
  to: string;
}

const blockCache = new WeakMap<Choice, Block[]>();

function choiceBlocks(choice: Choice): Block[] {
  let out = blockCache.get(choice);
  if (out) return out;
  out = [];
  for (const section of choice.sections) {
    for (const meeting of section.meetings) {
      if (!meeting.start) continue;
      for (const day of meeting.days) out.push({ day, start: minutes(meeting.start), end: minutes(meeting.end), from: section.startDate || '0000', to: section.endDate || '9999' });
    }
  }
  blockCache.set(choice, out);
  return out;
}

function blocks(choices: Choice[]): Block[] {
  return choices.flatMap(choiceBlocks);
}

/** The most classes on one day of any one week: a first-half and a second-half class are never on the same day. */
function busiest(list: Block[], days?: Set<string>): number {
  let most = 0;
  for (const a of list) {
    if (days && !days.has(a.day)) continue;
    let count = 0;
    for (const b of list) if (b.day === a.day && b.from <= a.from && a.from <= b.to) count++;
    most = Math.max(most, count);
  }
  return most;
}

/**
 * Every way to take a course under the rules: one section of each component, as a cartesian product, except that a
 * recitation or lab numbered like the lectures (001 with REC1, 003 with LAB3) goes with its own lecture. With none,
 * the reason, judged on the sections Albert lists.
 */
export function waysToTake(course: SolverCourse, want: string, rules: Rules): { ways: Choice[]; why: string | null } {
  const live = course.sections.filter((section) => section.status !== 'cancelled');
  if (live.length === 0) return { ways: [], why: course.sections.length ? 'is cancelled this term' : 'has no sections this term' };
  const byComponent = new Map<string, SolverSection[]>();
  for (const section of live) byComponent.set(section.component, [...(byComponent.get(section.component) ?? []), section]);
  const components = [...byComponent.keys()].sort((a, b) => rank(a) - rank(b));
  const fitting = new Map<string, SolverSection[]>();
  for (const component of components) {
    const all = byComponent.get(component)!;
    const kept = all.filter((section) => blocker(section, rules) === null);
    if (kept.length === 0) {
      const counts = new Map<Blocker, SolverSection[]>();
      for (const section of all) {
        const kind = blocker(section, rules)!;
        counts.set(kind, [...(counts.get(kind) ?? []), section]);
      }
      const part = component === components[0] ? null : component;
      const reasons = [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
      if (reasons.length === 1) return { ways: [], why: why(reasons[0]![0], part, reasons[0]![1], rules) };
      return { ways: [], why: `has no ${part?.toLowerCase() ?? 'section'} that fits: ${reasons.map(([kind, sections]) => some(kind, sections, rules)).join('; ')}` };
    }
    fitting.set(component, kept);
  }
  const primary = components[0]!;
  const primaryNumbers = new Set(byComponent.get(primary)!.map(number));
  const paired = (component: string) => {
    const numbers = byComponent.get(component)!.map(number);
    return !primaryNumbers.has(null) && numbers.every((n) => n !== null) && numbers.length === primaryNumbers.size && numbers.every((n) => primaryNumbers.has(n));
  };
  let combos: SolverSection[][] = fitting.get(primary)!.map((section) => [section]);
  for (const component of components.slice(1)) {
    const linked = paired(component);
    const next: SolverSection[][] = [];
    for (const combo of combos) {
      for (const section of fitting.get(component)!) {
        if (linked && number(section) !== number(combo[0]!)) continue;
        next.push([...combo, section]);
      }
    }
    combos = next;
  }
  const credits = parseFloat(course.credits) || 0;
  const together = combos.filter((sections) => !sections.some((a, i) => sections.slice(i + 1).some((b) => sectionsClash(a, b)))).map((sections) => ({ want, code: course.code, title: course.title, credits, sections }));
  const ways = rules.maxPerDay ? together.filter((way) => busiest(choiceBlocks(way)) <= rules.maxPerDay) : together;
  if (ways.length) return { ways, why: null };
  if (together.length) return { ways, why: `needs more than ${rules.maxPerDay} ${rules.maxPerDay === 1 ? 'class' : 'classes'} on one day` };
  return { ways, why: `has no ${list(components.map((component) => component.toLowerCase()))} that fit together` };
}

function rank(component: string): number {
  const index = PRIMARY.indexOf(component);
  return index < 0 ? PRIMARY.length : index;
}

/** How students rate a section's professors (the mean of those rated), or null when none of them is. */
export function profScore(section: SolverSection, quality: Quality | undefined): number | null {
  if (!quality) return null;
  const known = section.instructors.map((name) => quality.profs.get(name)).filter((value): value is number => value !== undefined);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

/**
 * Lower is better: the student's soft preferences, a mild dislike of gaps, 8:30s, evenings and waitlists, and, when
 * they rank by ratings, how students rate the professors (the lecturer most) and the course. Hard rules never get
 * here: a section that breaks one is not in any plan.
 */
export function score(choices: Choice[], rules: Rules, quality?: Quality): number {
  const byDay = new Map<string, Block[]>();
  for (const block of blocks(choices)) byDay.set(block.day, [...(byDay.get(block.day) ?? []), block]);
  let total = 0;
  const loads: number[] = [];
  for (const dayBlocks of byDay.values()) {
    const sorted = dayBlocks.sort((a, b) => a.start - b.start);
    let load = 0;
    for (let i = 0; i < sorted.length; i++) {
      const block = sorted[i]!;
      load += block.end - block.start;
      if (i > 0) {
        const gap = block.start - sorted[i - 1]!.end;
        if (gap > BREAK) total += gap / (rules.shape === 'compact' ? 4 : 10);
      }
      if (!rules.earliest && block.start < 9 * 60) total += 8;
      if (!rules.latest && block.end > 18 * 60 + 30) total += 5;
    }
    loads.push(load);
  }
  if (rules.shape === 'compact') total += 45 * byDay.size;
  if (rules.shape === 'spread' && loads.length) {
    const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length;
    total += loads.reduce((sum, load) => sum + (load - mean) ** 2, 0) / loads.length / 200 + 30 * Math.max(0, 4 - byDay.size);
  }
  for (const choice of choices) {
    choice.sections.forEach((section, i) => {
      if (section.status === 'waitlist') total += 40;
      if (section.status === 'closed') total += 80;
      if (rules.prefer.some((rule) => namesPerson(section.instructors, rule))) total -= 60;
      const prof = rules.bestRated ? profScore(section, quality) : null;
      // The first section is the lecture or seminar: its professor is who students mean.
      if (prof !== null) total -= (prof - AVERAGE) * PROF_WEIGHT * (i === 0 ? 1 : SECONDARY_WEIGHT);
    });
    const course = rules.bestRated ? quality?.courses.get(choice.code) : undefined;
    if (course !== undefined) total -= (course - AVERAGE) * COURSE_WEIGHT;
  }
  return Math.round(total * 10) / 10;
}

function label(want: Want): string {
  if (want.codes.length === 1) return want.codes[0]!;
  if (want.label) return want.label;
  if (want.codes.length <= 3) return want.codes.join(' or ');
  return `Any of ${want.codes.length} courses`;
}

/** Every way to fill a want under the rules, its own best first; with none, why each course is out. */
function domain(catalog: Map<string, SolverCourse>, want: Want, rules: Rules, quality?: Quality): { ways: Choice[]; reasons: string[] } {
  const ways: Choice[] = [];
  const reasons: string[] = [];
  for (const code of want.codes) {
    const course = catalog.get(code);
    if (!course) {
      reasons.push(`${code} is not offered this term`);
      continue;
    }
    const result = waysToTake(course, want.id, rules);
    ways.push(...result.ways);
    if (result.why) reasons.push(`${code} ${result.why}`);
  }
  // Each course's own best ways first, so the first plans found are already good ones.
  const scores = new Map(ways.map((way) => [way, score([way], rules, quality)]));
  return { ways: ways.sort((a, b) => scores.get(a)! - scores.get(b)!), reasons };
}

/** The loosenings worth trying, least drastic first. */
function relaxations(rules: Rules): Fix[] {
  const out: Fix[] = [];
  if (rules.maxPerDay && rules.maxPerDay < 6) out.push({ label: `Allow ${rules.maxPerDay + 1} classes a day`, rules: { maxPerDay: rules.maxPerDay + 1 } });
  if (rules.maxPerDay) out.push({ label: 'Any number of classes a day', rules: { maxPerDay: 0 } });
  if (rules.noBackToBack) out.push({ label: 'Allow back-to-back classes', rules: { noBackToBack: false } });
  if (!rules.waitlisted) out.push({ label: 'Include waitlists', rules: { waitlisted: true } });
  for (const day of rules.daysOff) out.push({ label: `Allow ${DAY_NAMES[day] ?? day} classes`, rules: { daysOff: rules.daysOff.filter((entry) => entry !== day) } });
  if (rules.earliest) out.push({ label: `Allow classes before ${clock(rules.earliest)}`, rules: { earliest: '' } });
  if (rules.latest) out.push({ label: `Allow classes after ${clock(rules.latest)}`, rules: { latest: '' } });
  for (const name of rules.avoid) out.push({ label: `Allow ${name}`, rules: { avoid: rules.avoid.filter((entry) => entry !== name) } });
  return out;
}

/** The first section a looser plan lets in, said plainly: "MATH-UH 1012 Lecture 002 (Tue Thu 8:30am) is waitlisted". */
function detail(choices: Choice[], rules: Rules): string | undefined {
  for (const choice of choices) {
    for (const section of choice.sections) {
      const kind = blocker(section, rules);
      if (!kind) continue;
      const name = `${choice.code} ${section.component} ${section.section} (${when(section)})`;
      if (kind === 'seats') return `${name} is ${section.status === 'closed' ? 'closed' : 'waitlisted'}`;
      if (kind === 'days') return `${name} meets on ${list(offDays([section], rules).map((day) => DAY_NAMES[day]!))}`;
      if (kind === 'professor') return `${name} is taught by ${list(section.instructors)}`;
      const timed = section.meetings.filter((meeting) => meeting.start);
      const early = rules.earliest && timed.some((meeting) => minutes(meeting.start) < minutes(rules.earliest));
      return early ? `${name} starts at ${clock(Math.min(...timed.map((meeting) => minutes(meeting.start))))}` : `${name} ends at ${clock(Math.max(...timed.map((meeting) => minutes(meeting.end))))}`;
    }
  }
  return undefined;
}

/** Two loosenings as one: freeing Monday and freeing Tuesday frees both. */
function both(a: Fix, b: Fix): Fix {
  const rules = { ...a.rules, ...b.rules };
  if (a.rules?.daysOff && b.rules?.daysOff) rules.daysOff = a.rules.daysOff.filter((day) => b.rules!.daysOff!.includes(day));
  if (a.rules?.avoid && b.rules?.avoid) rules.avoid = a.rules.avoid.filter((name) => b.rules!.avoid!.includes(name));
  return { label: `${a.label} and ${b.label.charAt(0).toLowerCase()}${b.label.slice(1)}`, rules };
}

/**
 * Up to two fixes that `works` accepts, each one change to the rules; failing that, when `pairs` is set (the check is
 * cheap), two changes together.
 */
function findFixes(rules: Rules, works: (relaxed: Rules) => Choice[] | null, deadline = Infinity, pairs = false): Fix[] {
  const fixes: Fix[] = [];
  const singles = relaxations(rules);
  const candidates = [...singles];
  if (pairs) for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) if (singles[i]!.rules?.maxPerDay === undefined || singles[j]!.rules?.maxPerDay === undefined) candidates.push(both(singles[i]!, singles[j]!));
  for (const [i, fix] of candidates.entries()) {
    if (fixes.length === 2 || Date.now() > deadline) break;
    // Two changes are only worth saying when no one change is enough, and no limit at all only when one more is not.
    if (i >= singles.length && fixes.length) break;
    if (fix.rules?.maxPerDay === 0 && fixes.some((found) => found.rules?.maxPerDay !== undefined)) continue;
    const example = works({ ...rules, ...fix.rules });
    if (example) fixes.push({ ...fix, detail: detail(example, rules) });
  }
  return fixes;
}

interface Limits {
  options: number;
  ms: number;
}

/** The backtracking search: the most constrained want first, keeping the best few hundred plans found. */
function search(wants: Want[], domains: Choice[][], rules: Rules, quality: Quality | undefined, limits: Limits): { found: Option[]; partial: boolean } {
  const order = domains.map((_, i) => i).sort((a, b) => domains[a]!.length - domains[b]!.length);
  const gap = rules.noBackToBack ? BREAK : 0;
  const started = Date.now();
  const found: Option[] = [];
  const picked: Choice[] = [];
  let partial = false;
  let steps = 0;

  const overloaded = (way: Choice): boolean => {
    const own = choiceBlocks(way);
    if (own.length === 0) return false;
    return busiest([...blocks(picked), ...own], new Set(own.map((block) => block.day))) > rules.maxPerDay;
  };

  const step = (depth: number): void => {
    if (partial) return;
    if (++steps % 512 === 0 && Date.now() - started > limits.ms) {
      partial = true;
      return;
    }
    if (depth === order.length) {
      const choices = [...picked].sort((a, b) => wants.findIndex((want) => want.id === a.want) - wants.findIndex((want) => want.id === b.want));
      found.push({ choices, score: score(choices, rules, quality), credits: choices.reduce((sum, choice) => sum + choice.credits, 0), days: new Set(blocks(choices).map((block) => block.day)).size });
      // Keeping only the best few hundred keeps sorting cheap when a plan has thousands of answers.
      if (found.length >= limits.options * 8) {
        found.sort((a, b) => a.score - b.score);
        found.length = limits.options * 4;
      }
      return;
    }
    for (const way of domains[order[depth]!]!) {
      if (picked.some((choice) => choice.code === way.code || choicesClash(choice, way, gap))) continue;
      if (rules.maxPerDay && overloaded(way)) continue;
      picked.push(way);
      step(depth + 1);
      picked.pop();
      if (partial) return;
    }
  };
  step(0);
  found.sort((a, b) => a.score - b.score);
  return { found: found.slice(0, limits.options), partial };
}

/** Whether two wants can sit side by side, with an example pair when they can. */
function pairFits(a: Choice[], b: Choice[], rules: Rules): Choice[] | null {
  const gap = rules.noBackToBack ? BREAK : 0;
  for (const x of a) {
    for (const y of b) {
      if (x.code === y.code || choicesClash(x, y, gap)) continue;
      if (rules.maxPerDay && busiest([...choiceBlocks(x), ...choiceBlocks(y)]) > rules.maxPerDay) continue;
      return [x, y];
    }
  }
  return null;
}

/** When every want fits alone but no plan has them all: which ones are in each other's way, and what would fix it. */
function diagnose(catalog: Map<string, SolverCourse>, wants: Want[], domains: Choice[][], rules: Rules, quality: Quality | undefined, deadline: number): Problem[] {
  const problems: Problem[] = [];
  for (let i = 0; i < wants.length; i++) {
    for (let j = i + 1; j < wants.length; j++) {
      if (pairFits(domains[i]!, domains[j]!, rules)) continue;
      const fixes = findFixes(rules, (relaxed) => pairFits(domain(catalog, wants[i]!, relaxed).ways, domain(catalog, wants[j]!, relaxed).ways, relaxed), deadline, true);
      const pair = `${label(wants[i]!)} and ${label(wants[j]!)}`;
      problems.push({ want: wants[j]!.id, text: fixes.length ? `${pair} clash under your rules.` : `${pair} meet at the same time in every section, so only one fits.`, fixes });
    }
  }
  if (problems.length) return problems;

  // No two clash, so three or more do together, or a rule about the whole week is in the way.
  const quick = { options: 1, ms: 150 };
  const fixes = findFixes(
    rules,
    (relaxed) => {
      const looser = wants.map((want) => domain(catalog, want, relaxed, quality).ways);
      return looser.some((ways) => ways.length === 0) ? null : (search(wants, looser, relaxed, quality, quick).found[0]?.choices ?? null);
    },
    deadline,
  );
  // The wants in the way are the ones without which the rest fits.
  const culprits = wants.filter((_, k) => Date.now() < deadline && search(wants.filter((__, i) => i !== k), domains.filter((__, i) => i !== k), rules, quality, quick).found.length > 0);
  const who = culprits.length >= 2 ? list(culprits.map(label)) : 'These courses';
  if (fixes.length === 0) fixes.push(...culprits.slice(0, 2).map((want) => ({ label: `Drop ${label(want)}`, drop: want.id })));
  return [{ want: '', text: `${who} cannot all fit together${fixes.some((fix) => fix.rules) ? ' under your rules' : ''}.`, fixes }];
}

/**
 * The best plans for these wants under these rules, at most `limits.options` of them, best first; and when there is
 * none, what stands in the way and what would fix it. Stops after `limits.ms` with the best found so far.
 */
export function solve(catalog: Map<string, SolverCourse>, wants: Want[], rules: Rules, quality?: Quality, limits: Limits = { options: 40, ms: 1200 }): Solved {
  const problems: Problem[] = [];
  const domains: Choice[][] = [];
  for (const want of wants) {
    const { ways, reasons } = domain(catalog, want, rules, quality);
    if (ways.length === 0) {
      const text = want.codes.length === 1 ? `${reasons[0] ?? `${want.codes[0]} is not offered this term`}.` : `${want.label ? `No course for "${want.label}"` : `None of ${label(want)}`} fits: ${reasons.slice(0, 2).join('; ')}.`;
      const fixes = findFixes(
        rules,
        (relaxed) => {
          const looser = domain(catalog, want, relaxed).ways;
          return looser.length ? looser.slice(0, 1) : null;
        },
        Infinity,
        true,
      );
      problems.push({ want: want.id, text, fixes });
    }
    domains.push(ways);
  }
  if (wants.length === 0 || problems.length) return { options: [], problems, partial: false };
  const { found, partial } = search(wants, domains, rules, quality, limits);
  if (found.length) return { options: found, problems: [], partial };
  return { options: [], problems: diagnose(catalog, wants, domains, rules, quality, Date.now() + 700), partial };
}

/** What makes a plan worth a look, in a few words each, the most telling first: "top-rated professors", "Fridays free". */
export function highlights(option: Option, rules: Rules, quality?: Quality): string[] {
  const parts: string[] = [];
  const all = blocks(option.choices);
  if (rules.bestRated) {
    const rated = option.choices.map((choice) => profScore(choice.sections[0]!, quality)).filter((value): value is number => value !== null);
    const mean = rated.reduce((sum, value) => sum + value, 0) / (rated.length || 1);
    if (rated.length && mean >= 4.2) parts.push('top-rated professors');
    else if (rated.length && mean >= 3.6) parts.push('well-rated professors');
  }
  const preferred = rules.prefer.filter((rule) => option.choices.some((choice) => choice.sections.some((section) => namesPerson(section.instructors, rule))));
  if (preferred.length) parts.push(`with ${list(preferred)}`);
  if (all.length) {
    const days = new Set(all.map((block) => block.day));
    parts.push(`${days.size} ${days.size === 1 ? 'day' : 'days'} on campus`);
    const free = WEEKDAYS.filter((day) => !days.has(day) && !rules.daysOff.includes(day));
    if (free.length && free.length <= 2) parts.push(`${list(free.map((day) => `${DAY_NAMES[day]}s`))} free`);
    const first = Math.min(...all.map((block) => block.start));
    const early = new Set(all.filter((block) => block.start < 9 * 60).map((block) => block.day));
    if (first >= 9 * 60) parts.push(`nothing before ${clock(first)}`);
    else parts.push(`${clock(first)} starts on ${early.size === 1 ? DAY_NAMES[[...early][0]!] : `${early.size} days`}`);
  }
  const waiting = option.choices.flatMap((choice) => choice.sections).filter((section) => section.status !== 'open').length;
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'section' : 'sections'} waitlisted`);
  let longest = { gap: 0, day: '' };
  for (const day of new Set(all.map((block) => block.day))) {
    const sorted = all.filter((block) => block.day === day).sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]!.start - Math.max(...sorted.slice(0, i).map((block) => block.end));
      if (gap > longest.gap) longest = { gap, day };
    }
  }
  if (longest.gap >= 150) parts.push(`a ${Math.floor(longest.gap / 60)}h${longest.gap % 60 ? ` ${longest.gap % 60}m` : ''} gap on ${DAY_NAMES[longest.day]}`);
  else if (all.length > new Set(all.map((block) => block.day)).size && longest.gap <= BREAK) parts.push('no gaps');
  return parts.slice(0, 4);
}

/**
 * Side-by-side columns for a day's blocks that overlap in time (in a plan only the two seven-week halves can): each
 * block takes the first column free when it starts, every block in a run of overlapping blocks gets the width the run
 * needs, and a block widens over the columns to its right that nothing overlapping it uses. So A over B and B over C,
 * with A and C apart, takes two columns, not three.
 */
export function lanes(items: Array<{ start: number; end: number }>): Array<{ lane: number; lanes: number; span: number }> {
  const out = items.map(() => ({ lane: 0, lanes: 1, span: 1 }));
  const order = items.map((_, i) => i).sort((a, b) => items[a]!.start - items[b]!.start || items[b]!.end - items[a]!.end);
  const overlap = (i: number, j: number) => items[i]!.start < items[j]!.end && items[j]!.start < items[i]!.end;
  let run: number[] = [];
  let columns: number[] = [];
  let runEnd = -Infinity;
  const close = () => {
    for (const i of run) {
      const entry = out[i]!;
      entry.lanes = columns.length;
      while (entry.lane + entry.span < columns.length && !run.some((j) => j !== i && out[j]!.lane === entry.lane + entry.span && overlap(i, j))) entry.span++;
    }
    run = [];
    columns = [];
    runEnd = -Infinity;
  };
  for (const i of order) {
    const item = items[i]!;
    if (run.length && item.start >= runEnd) close();
    let lane = columns.findIndex((end) => end <= item.start);
    if (lane < 0) lane = columns.push(item.end) - 1;
    else columns[lane] = item.end;
    out[i]!.lane = lane;
    run.push(i);
    runEnd = Math.max(runEnd, item.end);
  }
  close();
  return out;
}
