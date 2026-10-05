/**
 * The schedule builder's solver, after Horarium's (github.com/Phoenix-3139/Horarium). Each course a student wants
 * becomes the ways to take it: one section of every component it has, a lecture paired with its own recitation or lab
 * where Albert numbers them alike, and only sections that fit the student's hard rules (seats, days off, hours,
 * professors to avoid). A backtracking search, the most constrained course first, finds the combinations where no two
 * classes meet at the same time in overlapping weeks (so first and second seven-week halves never clash), and ranks
 * them by the student's soft preferences. When nothing fits it says why. Pure, so the browser runs it on every edit.
 */

export type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export const WEEKDAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

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
}

export interface Rules {
  /** No class starting before this (HH:MM), or empty. */
  earliest: string;
  /** No class ending after this (HH:MM), or empty. */
  latest: string;
  daysOff: string[];
  lunch: boolean;
  /** compact: fewer days on campus; spread: lighter days. */
  shape: 'any' | 'compact' | 'spread';
  /** Waitlisted and closed sections count too. */
  waitlisted: boolean;
  /** Professors to keep out of the plan, and to look for. Matched on every word of the name. */
  avoid: string[];
  prefer: string[];
}

export const DEFAULT_RULES: Rules = { earliest: '', latest: '', daysOff: [], lunch: false, shape: 'any', waitlisted: false, avoid: [], prefer: [] };

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

export interface Problem {
  /** The want it is about, or empty when it is about the plan as a whole. */
  want: string;
  text: string;
}

export interface Solved {
  options: Option[];
  problems: Problem[];
  /** The search stopped at its time limit, so better options may exist. */
  partial: boolean;
}

const PRIMARY = ['Lecture', 'Seminar', 'Studio', 'Workshop'];

export function minutes(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
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

/** Why a section is out, or null when it fits the hard rules. */
function sectionProblem(section: SolverSection, rules: Rules): 'seats' | 'days' | 'hours' | 'professor' | null {
  if (section.status !== 'open' && !rules.waitlisted) return 'seats';
  const earliest = rules.earliest ? minutes(rules.earliest) : NaN;
  const latest = rules.latest ? minutes(rules.latest) : NaN;
  for (const meeting of section.meetings) {
    if (meeting.days.some((day) => rules.daysOff.includes(day))) return 'days';
    if (!meeting.start) continue;
    if (minutes(meeting.start) < earliest || minutes(meeting.end) > latest) return 'hours';
  }
  if (rules.avoid.some((rule) => namesPerson(section.instructors, rule))) return 'professor';
  return null;
}

/** Why a course is out, said of the course or, when only its recitation or lab fails, of that component. */
function why(problem: NonNullable<ReturnType<typeof sectionProblem>>, component: string | null): string {
  const part = component?.toLowerCase();
  if (problem === 'seats') return part ? `has no ${part} with open seats` : 'has no open seats';
  if (problem === 'days') return part ? `only has a ${part} on your days off` : 'only meets on your days off';
  if (problem === 'hours') return part ? `has no ${part} in your hours` : 'has no section in your hours';
  return 'is only taught by a professor you asked to avoid';
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

function sectionsClash(a: SolverSection, b: SolverSection): boolean {
  if (!datesOverlap(a, b)) return false;
  for (const x of a.meetings) {
    if (!x.start) continue;
    for (const y of b.meetings) {
      if (!y.start || !x.days.some((day) => y.days.includes(day))) continue;
      if (minutes(x.start) < minutes(y.end) && minutes(y.start) < minutes(x.end)) return true;
    }
  }
  return false;
}

function choicesClash(a: Choice, b: Choice): boolean {
  for (const x of a.sections) for (const y of b.sections) if (sectionsClash(x, y)) return true;
  return false;
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
    const kept = all.filter((section) => sectionProblem(section, rules) === null);
    if (kept.length === 0) {
      // The reason the most sections share is the one worth saying.
      const counts = new Map<string, number>();
      for (const section of all) {
        const problem = sectionProblem(section, rules)!;
        counts.set(problem, (counts.get(problem) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0] as NonNullable<ReturnType<typeof sectionProblem>>;
      return { ways: [], why: why(top, component === components[0] ? null : component) };
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
  const credits = Number(course.credits) || 0;
  const ways = combos.filter((sections) => !sections.some((a, i) => sections.slice(i + 1).some((b) => sectionsClash(a, b)))).map((sections) => ({ want, code: course.code, title: course.title, credits, sections }));
  return { ways, why: ways.length ? null : 'has no lecture and recitation pair that fits' };
}

function rank(component: string): number {
  const index = PRIMARY.indexOf(component);
  return index < 0 ? PRIMARY.length : index;
}

interface Block {
  day: string;
  start: number;
  end: number;
}

function blocks(choices: Choice[]): Block[] {
  const out: Block[] = [];
  for (const choice of choices) {
    for (const section of choice.sections) {
      for (const meeting of section.meetings) {
        if (!meeting.start) continue;
        for (const day of meeting.days) out.push({ day, start: minutes(meeting.start), end: minutes(meeting.end) });
      }
    }
  }
  return out;
}

/** Lower is better: the student's soft preferences, plus a mild dislike of gaps, 8:30s and waitlists. */
export function score(choices: Choice[], rules: Rules): number {
  const byDay = new Map<string, Block[]>();
  for (const block of blocks(choices)) byDay.set(block.day, [...(byDay.get(block.day) ?? []), block]);
  let total = 0;
  const loads: number[] = [];
  for (const dayBlocks of byDay.values()) {
    const sorted = dayBlocks.sort((a, b) => a.start - b.start);
    let load = 0;
    let free = 11 * 60 + 30;
    let lunch = false;
    for (let i = 0; i < sorted.length; i++) {
      const block = sorted[i]!;
      load += block.end - block.start;
      if (i > 0) {
        const gap = block.start - sorted[i - 1]!.end;
        if (gap > 15) total += gap / (rules.shape === 'compact' ? 4 : 10);
      }
      if (!rules.earliest && block.start < 9 * 60) total += 8;
      if (Math.min(block.start, 14 * 60) - free >= 30) lunch = true;
      if (block.start < 14 * 60) free = Math.max(free, block.end);
    }
    if (14 * 60 - free >= 30) lunch = true;
    if (rules.lunch && !lunch) total += 60;
    loads.push(load);
  }
  if (rules.shape === 'compact') total += 45 * byDay.size;
  if (rules.shape === 'spread' && loads.length) {
    const mean = loads.reduce((sum, load) => sum + load, 0) / loads.length;
    total += loads.reduce((sum, load) => sum + (load - mean) ** 2, 0) / loads.length / 200 + 30 * Math.max(0, 4 - byDay.size);
  }
  for (const choice of choices) {
    for (const section of choice.sections) {
      if (section.status === 'waitlist') total += 40;
      if (section.status === 'closed') total += 80;
      if (rules.prefer.some((rule) => namesPerson(section.instructors, rule))) total -= 60;
    }
  }
  return Math.round(total * 10) / 10;
}

function label(want: Want): string {
  if (want.codes.length === 1) return want.codes[0]!;
  if (want.codes.length <= 3) return want.codes.join(' or ');
  return `Any of ${want.codes.length} courses`;
}

/**
 * The best plans for these wants under these rules, at most `limits.options` of them, best first; and when there is
 * none, what stands in the way. Stops after `limits.ms` with the best found so far.
 */
export function solve(catalog: Map<string, SolverCourse>, wants: Want[], rules: Rules, limits = { options: 40, ms: 1200 }): Solved {
  const problems: Problem[] = [];
  const domains: Choice[][] = [];
  for (const want of wants) {
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
    if (ways.length === 0) problems.push({ want: want.id, text: want.codes.length === 1 ? `${reasons[0] ?? `${want.codes[0]} is not offered this term`}.` : `None of ${label(want)} fits: ${reasons.slice(0, 2).join('; ')}.` });
    // Each course's own best ways first, so the first plans found are already good ones.
    domains.push(ways.sort((a, b) => score([a], rules) - score([b], rules)));
  }
  if (wants.length === 0 || problems.length) return { options: [], problems, partial: false };

  const order = domains.map((_, i) => i).sort((a, b) => domains[a]!.length - domains[b]!.length);
  const started = Date.now();
  const found: Option[] = [];
  const picked: Choice[] = [];
  let partial = false;
  let steps = 0;

  const search = (depth: number): void => {
    if (partial) return;
    if (++steps % 512 === 0 && Date.now() - started > limits.ms) {
      partial = true;
      return;
    }
    if (depth === order.length) {
      const choices = [...picked].sort((a, b) => wants.findIndex((want) => want.id === a.want) - wants.findIndex((want) => want.id === b.want));
      found.push({ choices, score: score(choices, rules), credits: choices.reduce((sum, choice) => sum + choice.credits, 0), days: new Set(blocks(choices).map((block) => block.day)).size });
      // Keeping only the best few hundred keeps sorting cheap when a plan has thousands of answers.
      if (found.length >= limits.options * 8) {
        found.sort((a, b) => a.score - b.score);
        found.length = limits.options * 4;
      }
      return;
    }
    for (const way of domains[order[depth]!]!) {
      if (picked.some((choice) => choice.code === way.code || choicesClash(choice, way))) continue;
      picked.push(way);
      search(depth + 1);
      picked.pop();
      if (partial) return;
    }
  };
  search(0);

  if (found.length === 0) {
    for (let i = 0; i < wants.length; i++) {
      for (let j = i + 1; j < wants.length; j++) {
        const fits = domains[i]!.some((a) => domains[j]!.some((b) => a.code !== b.code && !choicesClash(a, b)));
        if (!fits) problems.push({ want: wants[j]!.id, text: `${label(wants[i]!)} and ${label(wants[j]!)} always clash.` });
      }
    }
    if (problems.length === 0) problems.push({ want: '', text: 'These courses cannot all fit together. Drop one, or loosen a rule.' });
    return { options: [], problems, partial };
  }
  found.sort((a, b) => a.score - b.score);
  return { options: found.slice(0, limits.options), problems: [], partial };
}
