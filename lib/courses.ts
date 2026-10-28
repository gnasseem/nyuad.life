/**
 * The class schedule from Albert (data/classes.jsonl, written by scripts/scrape-albert.ts): courses across NYU schools
 * per term with its sections, times, rooms, professors and seat status. It powers the course search and is the
 * authority Ask cites for who teaches what, when and where. Loaded once per process.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sessionHalf } from './schedule.ts';
import { dataRoot } from './store.ts';
import { collapseWhitespace, tokenize, truncate } from './text.ts';

interface Meeting {
  days: string[];
  startTime: string;
  endTime: string;
  room: string;
  startDate: string;
  endDate: string;
}

interface Section {
  school?: string;
  classNumber: string;
  section: string;
  component: string;
  topic: string;
  units: string;
  status: string;
  session: string;
  startDate: string;
  endDate: string;
  grading: string;
  mode: string;
  location: string;
  instructors: string[];
  meetings: Meeting[];
  notes: string;
}

/** One course in one term, as the scraper stores it. */
export interface Offering {
  school?: string;
  term: string;
  code: string;
  title: string;
  description: string;
  sections: Section[];
  scraped: string;
}

export interface TermInfo {
  name: string;
  start: string;
  end: string;
}

export interface Catalog {
  /** Newest first. */
  terms: TermInfo[];
  /** The term in session today, else the next one, else the latest. */
  current: string;
  /** Code -> offerings, newest term first. */
  byCode: Map<string, Offering[]>;
  /** Normalised instructor name -> display name. */
  instructors: Map<string, string>;
  scraped: string;
}

/** Subjects of the Core Curriculum: colloquia and the four pillars. */
export const CORE_SUBJECTS = new Set(['CCOL', 'CADT', 'CCEA', 'CDAD', 'CSTS']);
const SEASONS: Record<string, number> = { january: 1, spring: 2, summer: 3, fall: 4 };

export function classesFile(): string {
  return process.env.ROR_CLASSES_FILE ?? path.join(dataRoot(), 'data', 'classes.jsonl');
}

let cached: Catalog | undefined;

export function loadCatalog(): Catalog {
  cached ??= buildCatalog(readOfferings(classesFile()));
  return cached;
}

/** Test hook. */
export function resetCatalog(): void {
  cached = undefined;
}

function readOfferings(file: string): Offering[] {
  if (!existsSync(file)) return [];
  const out: Offering[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Offering;
      if (row.code && row.term && Array.isArray(row.sections)) out.push(row);
    } catch {
      // a broken line costs one course, not the file
    }
  }
  return out;
}

/** "Fall 2026" -> 20264, so terms sort in calendar order. */
export function termOrder(term: string): number {
  const [season = '', year = ''] = term.toLowerCase().split(/\s+/);
  return Number(year) * 10 + (SEASONS[season] ?? 0);
}

/** Today's date in Abu Dhabi as YYYY-MM-DD. */
export function abuDhabiDate(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
}

export function buildCatalog(offerings: Offering[], now = new Date()): Catalog {
  const byCode = new Map<string, Offering[]>();
  const spans = new Map<string, { start: string; end: string }>();
  const instructors = new Map<string, string>();
  let scraped = '';
  for (const offering of offerings) {
    byCode.set(offering.code, [...(byCode.get(offering.code) ?? []), offering]);
    if (offering.scraped > scraped) scraped = offering.scraped;
    const span = spans.get(offering.term) ?? { start: '9999', end: '' };
    for (const section of offering.sections) {
      if (section.startDate && section.startDate < span.start) span.start = section.startDate;
      if (section.endDate && section.endDate > span.end) span.end = section.endDate;
      for (const name of section.instructors) instructors.set(normalizeName(name), displayName(name));
    }
    spans.set(offering.term, span);
  }
  for (const [code, list] of byCode) {
    const byTerm = new Map<string, Offering>();
    for (const offering of list) {
      const previous = byTerm.get(offering.term);
      byTerm.set(offering.term, previous ? { ...previous, sections: [...previous.sections, ...offering.sections] } : offering);
    }
    byCode.set(code, [...byTerm.values()].sort((a, b) => termOrder(b.term) - termOrder(a.term)));
  }
  const terms = [...spans.entries()].map(([name, span]) => ({ name, start: span.start === '9999' ? '' : span.start, end: span.end })).sort((a, b) => termOrder(b.name) - termOrder(a.name));
  return { terms, current: currentTerm(terms, abuDhabiDate(now)), byCode, instructors, scraped };
}

/** The term in session on `today`; failing that the next to start; failing that the latest. */
export function currentTerm(terms: TermInfo[], today: string): string {
  const running = terms.filter((term) => term.start && term.start <= today && term.end >= today);
  // Summer and January sit inside or beside the long terms; the long term wins while both run.
  const long = running.find((term) => /^(fall|spring)/i.test(term.name));
  if (long) return long.name;
  if (running[0]) return running[0].name;
  const upcoming = terms.filter((term) => term.start > today).sort((a, b) => a.start.localeCompare(b.start));
  return upcoming[0]?.name ?? terms[0]?.name ?? '';
}

/** Terms from the current one on, oldest first: what students can still take. */
export function liveTerms(catalog: Catalog): string[] {
  const from = termOrder(catalog.current);
  return catalog.terms.map((term) => term.name).filter((name) => termOrder(name) >= from).sort((a, b) => termOrder(a) - termOrder(b));
}

/* ---------- Shapes for the course search ---------- */

export type SeatStatus = 'open' | 'waitlist' | 'closed' | 'cancelled';

export function seatStatus(status: string): { status: SeatStatus; waitlist?: number } {
  const wait = /wait\s*list\s*\((\d+)\)/i.exec(status);
  if (wait) return { status: 'waitlist', waitlist: Number(wait[1]) };
  if (/^open/i.test(status)) return { status: 'open' };
  if (/cancel/i.test(status)) return { status: 'cancelled' };
  return { status: 'closed' };
}

/** AD is the whole term; A71 and A72 are its first and second seven weeks. */
function sessionLabel(section: Section): string {
  if (sessionHalf(section.session) === '71') return 'First 7 weeks';
  if (sessionHalf(section.session) === '72') return 'Second 7 weeks';
  if (section.session === 'AD' || !section.session) return '';
  return section.startDate && section.endDate ? `${section.startDate.slice(5)} to ${section.endDate.slice(5)}` : '';
}

export interface SectionRow {
  classNumber: string;
  section: string;
  component: string;
  topic: string;
  status: SeatStatus;
  waitlist?: number;
  session: string;
  /** The weeks it runs, YYYY-MM-DD: seven-week halves cover part of the term. */
  startDate: string;
  endDate: string;
  meetings: Array<{ days: string[]; start: string; end: string; room: string }>;
  instructors: string[];
  notes: string;
  /** Where it is taught, for a section away from Abu Dhabi ("NYU Paris (Global)"): its room alone may not say. */
  location?: string;
}

export interface CourseRow {
  code: string;
  title: string;
  subject: string;
  credits: string;
  core: boolean;
  description: string;
  sections: SectionRow[];
}

function sectionRow(section: Section, withNotes: boolean): SectionRow {
  const seats = seatStatus(section.status);
  return {
    classNumber: section.classNumber,
    section: section.section,
    component: section.component,
    topic: section.topic,
    ...seats,
    session: sessionLabel(section),
    startDate: section.startDate,
    endDate: section.endDate,
    meetings: section.meetings.map((meeting) => ({ days: meeting.days, start: meeting.startTime, end: meeting.endTime, room: meeting.room })),
    instructors: section.instructors.map(displayName),
    notes: withNotes ? collapseWhitespace(section.notes) : '',
    ...(section.location && !section.location.startsWith('Abu Dhabi') ? { location: section.location } : {}),
  };
}

/** An NYU Abu Dhabi course ("CS-UH 1001"): the only kind Reviews shows and takes reviews for. */
export function isCampusCode(code: string): boolean {
  return /^[A-Z]+-UH /.test(code);
}

export function subjectOf(code: string): string {
  return code.split('-')[0] ?? code;
}

/** Every course offered in a term, in code order, for the list. Descriptions are trimmed: the list searches them. */
export function courseRows(catalog: Catalog, term: string): CourseRow[] {
  const rows: CourseRow[] = [];
  for (const [code, offerings] of catalog.byCode) {
    const offering = offerings.find((entry) => entry.term === term);
    if (!offering) continue;
    rows.push({
      code,
      title: offering.title,
      subject: subjectOf(code),
      credits: offering.sections.find((section) => section.units)?.units ?? '',
      core: CORE_SUBJECTS.has(subjectOf(code)),
      description: truncate(collapseWhitespace(offering.description), 240),
      sections: offering.sections.map((section) => sectionRow(section, false)),
    });
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

export interface CourseHistory {
  code: string;
  title: string;
  subject: string;
  credits: string;
  core: boolean;
  description: string;
  /** Every term in the data, newest first, with full sections. */
  offerings: Array<{ term: string; sections: SectionRow[] }>;
}

/**
 * "MATH-UH 1012Q" -> "MATH-UH 1012". Albert's trailing letters mark attributes (Q, X, E, J…) and were dropped from
 * many codes in Fall 2026, so one course can carry two codes over the years.
 */
export function baseCode(code: string): string {
  return code.replace(/^([A-Z]+-UH \d{4})[A-Z]*$/, '$1');
}

const variantIndexes = new WeakMap<Catalog, Map<string, string[]>>();

/** Every code sharing this one's base, the one offered most recently first. */
export function codeVariants(catalog: Catalog, code: string): string[] {
  let index = variantIndexes.get(catalog);
  if (!index) {
    index = new Map();
    for (const key of catalog.byCode.keys()) index.set(baseCode(key), [...(index.get(baseCode(key)) ?? []), key]);
    for (const list of index.values()) list.sort((a, b) => termOrder(catalog.byCode.get(b)![0]!.term) - termOrder(catalog.byCode.get(a)![0]!.term));
    variantIndexes.set(catalog, index);
  }
  return index.get(baseCode(code)) ?? (catalog.byCode.has(code) ? [code] : []);
}

/**
 * A course's offerings under every code it has carried with the same title, newest first. A variant's term is only
 * added when the code itself has no offering that term, so two different courses sharing a number never mix.
 */
function mergedOfferings(catalog: Catalog, code: string): Offering[] {
  const own = catalog.byCode.get(code);
  if (!own?.length) return [];
  const title = fold(own[0]!.title);
  const terms = new Set(own.map((offering) => offering.term));
  const merged = [...own];
  for (const variant of codeVariants(catalog, code)) {
    if (variant === code) continue;
    for (const offering of catalog.byCode.get(variant)!) {
      if (fold(offering.title) !== title || terms.has(offering.term)) continue;
      terms.add(offering.term);
      merged.push(offering);
    }
  }
  return merged.sort((a, b) => termOrder(b.term) - termOrder(a.term));
}

/** The code a course goes by now: the variant offered most recently, so "MATH-UH 1012Q" finds this term's sections. */
export function currentCode(catalog: Catalog, code: string): string {
  const title = fold(catalog.byCode.get(code)?.[0]?.title ?? '');
  return codeVariants(catalog, code).find((variant) => fold(catalog.byCode.get(variant)![0]!.title) === title) ?? code;
}

export function courseHistory(catalog: Catalog, code: string): CourseHistory | null {
  const offerings = mergedOfferings(catalog, code);
  if (!offerings.length) return null;
  const latest = offerings[0]!;
  return {
    code,
    title: latest.title,
    subject: subjectOf(code),
    credits: latest.sections.find((section) => section.units)?.units ?? '',
    core: CORE_SUBJECTS.has(subjectOf(code)),
    description: collapseWhitespace(offerings.find((entry) => entry.description)?.description ?? ''),
    offerings: offerings.map((offering) => ({ term: offering.term, sections: offering.sections.map((section) => sectionRow(section, true)) })),
  };
}

export interface CourseEntry {
  code: string;
  title: string;
  subject: string;
  core: boolean;
  /** Who taught it lately; searched, not shown. */
  people: string[];
  /** Who teaches it in the current term, shown on the course card. */
  currentPeople: string[];
}

/** Every course in the schedule once, under the code it goes by now, for the course list. */
export function allCourses(catalog: Catalog): CourseEntry[] {
  const seen = new Set<string>();
  const out: CourseEntry[] = [];
  for (const code of catalog.byCode.keys()) {
    const current = currentCode(catalog, code);
    if (seen.has(current)) continue;
    seen.add(current);
    const offerings = mergedOfferings(catalog, current);
    const people = new Set(offerings.slice(0, 4).flatMap((offering) => offering.sections.flatMap((section) => section.instructors.map(displayName))));
    const currentOffering = offerings.find((offering) => offering.term === catalog.current);
    const currentPeople = [...new Set((currentOffering?.sections ?? [])
      .filter((section) => section.status.toLowerCase() !== 'cancelled' && section.component !== 'Recitation' && section.component !== 'Laboratory')
      .flatMap((section) => section.instructors.map(displayName)))];
    out.push({ code: current, title: offerings[0]!.title, subject: subjectOf(current), core: CORE_SUBJECTS.has(subjectOf(current)), people: [...people].slice(0, 8), currentPeople });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/* ---------- Finding what a question is about ---------- */

/** "Pötsch, Thomas" -> "Thomas Pötsch". */
export function displayName(name: string): string {
  const [last, first] = name.split(',').map((part) => part.trim());
  return first ? `${first} ${last}` : (last ?? name);
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeName(name: string): string {
  return fold(displayName(name));
}

const TEACHING = /\b(?:prof|professor|professors|dr|teach|teaches|teaching|taught|instructor|lecturer|lectures|class|classes|course|courses|section|sections|take|taking|took|with|reviews|grading)\b/;
// Surnames that are also ordinary English words students use in course questions.
export const COMMON_WORDS = new Set(['young', 'long', 'love', 'hall', 'green', 'white', 'black', 'brown', 'king', 'rich', 'west', 'will', 'may', 'hope', 'early', 'case', 'park', 'wood', 'more', 'good', 'best', 'hill', 'field', 'stone', 'bell', 'lane', 'street', 'north', 'south', 'cook', 'baker', 'mason', 'price', 'grant', 'hunt', 'major', 'minor', 'core', 'data', 'mark', 'marks', 'grade', 'grades']);

export interface ScheduleMatch {
  courses: string[];
  instructors: string[];
}

/**
 * Courses and professors a question names: course codes in any spelling ("CS-UH 1001", "cs 1001", "CS1001"), course
 * titles quoted in full, and professors by full name, or by surname next to a word like "professor" or "class".
 */
export function matchSchedule(catalog: Catalog, question: string, limits = { courses: 3, instructors: 2 }): ScheduleMatch {
  if (catalog.byCode.size === 0) return { courses: [], instructors: [] };
  const courses: string[] = [];
  const add = (code: string) => !courses.includes(code) && courses.push(code);
  for (const match of question.matchAll(/\b([A-Za-z]{2,6})[\s-]?(?:UH[\s-]?)?(\d{4})([A-Za-z]{0,2})\b/gi)) {
    const base = `${match[1]!.toUpperCase()}-UH ${match[2]}`;
    const exact = base + match[3]!.toUpperCase();
    const found = catalog.byCode.has(exact) ? exact : codeVariants(catalog, base)[0];
    if (found) add(currentCode(catalog, found));
  }
  const folded = ` ${fold(question)} `;
  const titled: Array<{ code: string; title: string }> = [];
  for (const [title, codes] of titleIndex(catalog)) {
    // "Capstone Project" is eight courses: naming it does not say which, so it picks none.
    if (codes.length === 1 && title.length >= 8 && folded.includes(` ${title} `) && (title.includes(' ') || namedAlone(question, title))) titled.push({ code: codes[0]!, title });
  }
  // The longest titles first: "Multivariable Calculus" before "Calculus".
  titled.sort((a, b) => b.title.length - a.title.length);
  let rest = folded;
  for (const entry of titled) {
    if (!rest.includes(` ${entry.title} `)) continue;
    rest = rest.replaceAll(` ${entry.title} `, ' | ');
    add(currentCode(catalog, entry.code));
  }
  // How students actually name courses: "calculus", "intro to cs", "linear algebra workload". Read in what the full
  // titles left, so "discrete math, data structures and MVC" finds all three.
  const listed = /,| and | or | vs | plus /.test(` ${question} `);
  if (!courses.length || listed) for (const code of matchTitleHeads(catalog, rest.replaceAll(' | ', ' '), question, listed ? 6 : 3)) add(code);

  const instructors: string[] = [];
  const teaching = TEACHING.test(folded);
  const said = folded.trim().split(' ');
  for (const [key, name] of catalog.instructors) {
    if (instructors.length >= limits.instructors) break;
    const parts = key.split(' ');
    const surname = parts.at(-1)!;
    // "Yves Le Jan": a surname of two words is distinctive on its own.
    const long = parts.length > 2 ? parts.slice(1).join(' ') : '';
    // Albert prints "Carpano, Davide", and students paste it that way.
    const full = parts.length > 1 && (folded.includes(` ${key} `) || folded.includes(` ${[surname, ...parts.slice(0, -1)].join(' ')} `));
    const bySurname = teaching && surname.length >= 4 && !COMMON_WORDS.has(surname) && folded.includes(` ${surname} `);
    // A first name misspelt beside the right surname ("Eves Le Jan").
    const misspelt = parts.length > 1 && parts[0]!.length >= 4 && said.some((word, i) => word.length >= 3 && editDistance(word, parts[0]!) <= 1 && ` ${said.slice(i + 1).join(' ')} `.startsWith(` ${parts.slice(1).join(' ')} `));
    if (full || bySurname || misspelt || (long.length >= 5 && folded.includes(` ${long} `))) instructors.push(name);
  }
  // A short title initialism is usable when a named teacher makes it unambiguous; bare initials may name a city.
  if (!courses.length && teaching) {
    const initials = new Set(question.match(/\b[A-Z]{2,4}\b/g) ?? []);
    const matches = [...catalog.byCode].filter(([, offerings]) => offerings.some((offering) => {
      const head = offering.title.split(/\s+(?:with|for)\s+|:/i)[0]!;
      const initial = head.split(/\s+/).map((word) => word[0]).join('').toUpperCase();
      return initials.has(initial) && offering.sections.some((section) => section.instructors.some((raw) => {
        const name = displayName(raw), first = fold(name).split(' ')[0]!;
        return instructors.includes(name) || first.length >= 4 && !COMMON_WORDS.has(first) && folded.includes(` ${first} `);
      }));
    })).map(([code]) => currentCode(catalog, code));
    if (new Set(matches).size === 1) add(matches[0]!);
  }
  // A first name can identify a professor once the course has narrowed the roster ("Nizar's MVC for Econ").
  const courseTeachers = courses.flatMap((code) => (catalog.byCode.get(code) ?? []).flatMap((offering) => offering.sections.filter((section) => section.status !== 'Cancelled').flatMap((section) => section.instructors.map(displayName))));
  const firstMatches = [...new Set(courseTeachers)].filter((name) => {
    const first = fold(name).split(' ')[0]!;
    return first.length >= 4 && (!COMMON_WORDS.has(first) || new RegExp(`\\b(?:with|prof(?:essor)?) ${first}\\b`).test(folded)) && folded.includes(` ${first} `);
  });
  // A surname misspelt by a letter once the course has narrowed the roster ("Data Analysis with Kauffman").
  if (!instructors.length && !firstMatches.length) {
    const close = [...new Set(courseTeachers)].filter((name) => {
      const surname = fold(name).split(' ').at(-1)!;
      return surname.length >= 5 && said.some((word) => word.length >= 5 && editDistance(word, surname) <= 1);
    });
    if (close.length === 1) instructors.push(close[0]!);
  }
  if (firstMatches.length === 1) {
    if (!instructors.includes(firstMatches[0]!)) instructors.push(firstMatches[0]!);
    if (courses.length > 1 && !/\b(?:or|versus|vs|compare|between)\b/i.test(question)) {
      const taught = courses.filter((code) => (catalog.byCode.get(code) ?? []).some((offering) => offering.sections.some((section) => section.instructors.some((name) => displayName(name) === firstMatches[0]))));
      if (taught.length) courses.splice(0, courses.length, ...taught);
    }
  }
  return { courses: courses.slice(0, limits.courses), instructors };
}

const titleIndexes = new WeakMap<Catalog, Map<string, string[]>>();

/** Folded title -> the codes that carry it now. */
function titleIndex(catalog: Catalog): Map<string, string[]> {
  let index = titleIndexes.get(catalog);
  if (!index) {
    index = new Map();
    for (const [code, offerings] of catalog.byCode) {
      const title = fold(offerings[0]!.title);
      index.set(title, [...(index.get(title) ?? []), code]);
      // "FYWS: Graphic Violence" is named "Graphic Violence" too.
      const after = /^[A-Z]{2,6}:\s+(.+)$/.exec(offerings[0]!.title)?.[1];
      if (after) index.set(fold(after), [...(index.get(fold(after)) ?? []), code]);
    }
    titleIndexes.set(catalog, index);
  }
  return index;
}

/**
 * Whether a one-word title ("Thinking", "Violence", "Chance") or the one word naming a course ("calculus") is meant as
 * the course: capitalised inside the sentence, next to a word like "class", "with" or "midterm", or what the question
 * asks about ("is mechanics a hard class"). "I'm thinking about taking" and "available seats" name no course.
 */
function namedAlone(question: string, title: string): boolean {
  for (const match of question.matchAll(new RegExp(`\\b${title}\\w*`, 'gi'))) {
    const before = question.slice(0, match.index).trim().split(/\s+/).at(-1) ?? '';
    const after = question.slice(match.index! + match[0].length).trim().split(/\s+/)[0] ?? '';
    if (/^\p{Lu}/u.test(match[0]) && before && !/[.!?:]$/.test(before)) return true;
    if (/^(?:the|core|colloquium|course|class|took|take|taking|fyws)$/i.test(before) || /^(?:course|class|colloquium|core|with|midterms?|finals?|exams?|quiz\w*|workload|grading|homework|hw|syllabus|textbook|prof\w*)\b/i.test(after)) return true;
    // "is mechanics a hard class", "how's chance": the word the question is about.
    if (/^(?:is|hows|how's|about)$/i.test(before) && !/^(?:about|of|that|to|it|you|i)$/i.test(after) && COURSE_INTENT.test(question)) return true;
  }
  return false;
}

/** Letters to change, add or drop to turn one word into another. */
export function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}

/** Words students shorten. Expanded before matching titles. */
const ALIASES: Record<string, string> = {
  mvc: 'multivariable calculus',
  calc: 'calculus',
  math: 'mathematics',
  maths: 'mathematics',
  multivar: 'multivariable',
  linalg: 'linear algebra',
  orgo: 'organic chemistry',
  ochem: 'organic chemistry',
  cs: 'computer science',
  cso: 'computer systems organization',
  compsci: 'computer science',
  econ: 'economics',
  stats: 'statistics',
  probs: 'probability',
  psych: 'psychology',
  bio: 'biology',
  chem: 'chemistry',
  phys: 'physics',
  polisci: 'political science',
  macro: 'macroeconomics',
  micro: 'microeconomics',
  algo: 'algorithms',
  algos: 'algorithms',
  diffeq: 'differential equations',
  ode: 'ordinary differential equations',
};
/** Title words that say nothing about which course it is. */
const TITLE_FILLER = new Set(['introduction', 'intro', 'topic', 'special', 'seminar', 'part', 'ii', 'iii', 'fundamental', 'foundation', 'principle', 'advanced', 'applications', 'application']);
/** Words that make a question about courses, so a one-word title ("Space", "Chance") may be meant as a course. */
const COURSE_INTENT = /\b(?:prof|professors?|dr|teach(?:es|ing)?|taught|instructors?|lecturers?|class(?:es)?|courses?|sections?|take|taking|took|hard|easy|workload|grad(?:e|es|ing)|exams?|midterms?|finals?|syllabus|credits?|core|electives?|requirements?|prereq(?:uisite)?s?|waitlist(?:ed)?|regist(?:er|ration)|semester|worth)\b/i;

export function isCourseQuestion(question: string): boolean {
  return COURSE_INTENT.test(question);
}

function expandAliases(text: string): string {
  return fold(text)
    .split(' ')
    .map((word) => ALIASES[word] ?? word)
    .join(' ');
}

interface TitleEntry {
  code: string;
  title: string;
  head: string[];
  words: Set<string>;
  live: boolean;
}

const headIndexes = new WeakMap<Catalog, TitleEntry[]>();

/** Each course offered from the current term on, or in the last year, with the words that name it. */
function titleEntries(catalog: Catalog): TitleEntry[] {
  let entries = headIndexes.get(catalog);
  if (!entries) {
    const live = new Set(liveTerms(catalog));
    const recent = termOrder(catalog.current) - 10;
    entries = [];
    for (const [code, offerings] of catalog.byCode) {
      if (termOrder(offerings[0]!.term) < recent || currentCode(catalog, code) !== code) continue;
      const title = offerings[0]!.title;
      // "Calculus with Applications to Economics" is named by "Calculus"; "Introduction to Computer Science" by "Computer Science".
      // Spelt out as questions are ("Discrete Math" is "discrete mathematics" there too).
      const head = tokenize(expandAliases(title.split(/\s+(?:with|for|in|through)\s+|:|\s[-–]\s/i)[0]!)).filter((word) => !TITLE_FILLER.has(word));
      if (head.length === 0) continue;
      entries.push({ code, title: fold(title), head, words: new Set(tokenize(expandAliases(title))), live: offerings.some((offering) => live.has(offering.term)) });
    }
    headIndexes.set(catalog, entries);
  }
  return entries;
}

/**
 * Courses whose title a question names in its own words: every word of the title's head is in the question
 * (abbreviations expanded), more of the full title breaks ties, and a one-word title only counts in a question about
 * courses. "Multivariable calculus" wins over "Calculus"; courses still offered come first. At most three.
 */
export function matchTitleHeads(catalog: Catalog, question: string, original = question, limit = 3): string[] {
  const words = new Set(tokenize(expandAliases(question)));
  const intent = COURSE_INTENT.test(question);
  const hits = titleEntries(catalog)
    .filter((entry) => entry.head.every((word) => words.has(word)) && (entry.head.length > 1 || (intent && entry.head[0]!.length >= 4 && (namedAlone(original, entry.head[0]!) || namedAlone(expandAliases(original), entry.head[0]!)))))
    .map((entry) => ({ entry, score: entry.head.length * 2 + [...entry.words].filter((word) => words.has(word)).length + (entry.live ? 0.5 : 0) }));
  if (hits.length === 0) return [];
  // A longer head that matched means the shorter ones inside it were not what the student meant.
  const within = (hit: (typeof hits)[number]) => hits.some((other) => other.entry.head.length > hit.entry.head.length && hit.entry.head.every((word) => other.entry.head.includes(word)));
  // "Capstone Project" is the full title of a dozen courses: naming it does not say which. ("Calculus with
  // Applications to Economics" and "… to Science" share only a head, and both are worth showing.)
  const titles = new Map<string, number>();
  for (const hit of hits) titles.set(hit.entry.title, (titles.get(hit.entry.title) ?? 0) + 1);
  let best = hits.filter((hit) => !within(hit) && titles.get(hit.entry.title) === 1);
  // The two MVC courses share a head, but "MVC for Econ" names the Economics version specifically.
  const variant = (hit: (typeof hits)[number]) => best.some((other) => other !== hit && other.entry.head.join(' ') === hit.entry.head.join(' '));
  const pick = (title: string) => {
    if (best.some((hit) => variant(hit) && hit.entry.title.includes(title))) best = best.filter((hit) => !variant(hit) || hit.entry.title.includes(title));
  };
  if (words.has('economic') && !words.has('science') && !words.has('engineer')) pick('economics');
  if ((words.has('science') || words.has('engineer')) && !words.has('economic')) pick('science');
  if (best.length > limit) return [];
  // "Discrete math" is Discrete Mathematics before Fundamentals of Discrete Math: fewer title words left unsaid first.
  const unsaid = (hit: (typeof hits)[number]) => [...hit.entry.words].filter((word) => !words.has(word) && !TITLE_FILLER.has(word)).length;
  return best
    .sort((a, b) => unsaid(a) - unsaid(b) || b.score - a.score)
    .map((hit) => hit.entry.code);
}

/** Words that say a question is about courses without saying which. */
const SEARCH_FILLER = new Set(tokenize('core course courses class classes professor prof take taking took elective electives credit credits semester term requirement requirements major minor recommend recommendation recommendations easy hard good best interesting fun workload grading about any which what nyuad uh offered offer teach teaches taught next this fall spring summer january'));

/** "arabic" names ARABL, "music" MUSIC, "film" FILMM, "history" HIST; short subject codes have to match whole. */
function namesSubject(term: string, subject: string): boolean {
  if (subject.length < 4 || term.length < 4) return term === subject;
  return subject.slice(0, 4) === term.slice(0, 4);
}

/**
 * A keyword search over the courses offered from the current term on, for questions that ask about a subject rather
 * than a course ("classes about machine learning"). A title word counts three times a description word.
 */
export function searchCatalog(catalog: Catalog, question: string, limit = 3): string[] {
  const terms = [...new Set(tokenize(expandAliases(question)))].filter((term) => !SEARCH_FILLER.has(term));
  if (terms.length === 0) return [];
  const live = new Set(liveTerms(catalog));
  let docs: Array<{ code: string; title: Set<string>; body: Set<string> }> = [];
  for (const [code, offerings] of catalog.byCode) {
    const offering = offerings.find((entry) => live.has(entry.term));
    if (!offering) continue;
    docs.push({ code, title: new Set(tokenize(offering.title)), body: new Set(tokenize(offerings.find((entry) => entry.description)?.description ?? '')) });
  }
  // A word that names a department ("arabic" for ARABL, "music", "film") keeps the search to that department.
  const named = new Set(docs.map((doc) => subjectOf(doc.code).toLowerCase()).filter((subject) => terms.some((term) => namesSubject(term, subject))));
  if (named.size) docs = docs.filter((doc) => named.has(subjectOf(doc.code).toLowerCase()));
  const idf = (term: string) => Math.log(1 + docs.length / (1 + docs.filter((doc) => doc.title.has(term) || doc.body.has(term)).length));
  const weights = new Map(terms.map((term) => [term, idf(term)]));
  return docs
    .map((doc) => {
      let score = 0;
      let inTitle = 0;
      let inBody = 0;
      for (const term of terms) {
        if (doc.title.has(term)) {
          score += 3 * weights.get(term)!;
          inTitle++;
        } else if (doc.body.has(term)) {
          score += weights.get(term)!;
          inBody++;
        }
      }
      return { code: doc.code, score, covered: inTitle + inBody, enough: inTitle > 0 || inBody >= 2 };
    })
    .filter((hit) => hit.enough && hit.score > 0)
    // The courses that cover more of the question first, then the stronger matches among them.
    .sort((a, b) => b.covered - a.covered || b.score - a.score)
    .filter((hit, _, all) => hit.covered === all[0]!.covered)
    // Only courses close to the best match: one shared word out of three is not the subject asked about.
    .filter((hit, _, all) => hit.score >= all[0]!.score * 0.6)
    .slice(0, limit)
    .map((hit) => hit.code);
}

/* ---------- What the answer model reads ---------- */

function meetingText(meeting: { days: string[]; start: string; end: string; room: string }): string {
  const days = meeting.days.length ? meeting.days.join('/') : 'days to be announced';
  const time = meeting.start ? ` ${meeting.start}–${meeting.end}` : '';
  return `${days}${time}${meeting.room ? `, ${meeting.room}` : ''}`;
}

function statusText(row: SectionRow): string {
  if (row.status === 'waitlist') return `waitlist (${row.waitlist ?? 0} waiting)`;
  return row.status;
}

function sectionLine(row: SectionRow): string {
  const when = row.meetings.length ? row.meetings.map(meetingText).join('; ') : 'no meeting times listed';
  const who = row.instructors.length ? row.instructors.join(', ') : 'instructor not listed';
  return `${row.component} ${row.section}${row.topic ? ` "${row.topic}"` : ''}${row.session ? ` (${row.session})` : ''}: ${when} · ${who} · ${statusText(row)}${row.location ? ` · taught at ${row.location}` : ''} · class #${row.classNumber}`;
}

/** A course's schedule for the answer model: the terms students can still take in full, earlier terms as who taught it. */
export function courseScheduleText(catalog: Catalog, code: string): string {
  const history = courseHistory(catalog, code);
  if (!history) return '';
  const live = new Set(liveTerms(catalog));
  const lines = [`Albert class schedule: ${code} ${history.title}${history.credits ? ` (${history.credits} credits)` : ''}${history.core ? ', a Core Curriculum course' : ''}. Read from Albert on ${catalog.scraped.slice(0, 10)}; the term now is ${catalog.current}.`];
  const shown = history.offerings.filter((offering) => live.has(offering.term));
  for (const offering of shown) {
    const active = offering.sections.filter((row) => row.status !== 'cancelled');
    const cancelled = offering.sections.length - active.length;
    lines.push(`${offering.term}${active.length === 0 ? ': every section cancelled' : ':'}`);
    for (const row of active.slice(0, 8)) lines.push(`- ${sectionLine(row)}`);
    if (active.length > 8) lines.push(`- and ${active.length - 8} more sections`);
    if (cancelled && active.length) lines.push(`- ${cancelled} cancelled ${cancelled === 1 ? 'section' : 'sections'} not shown`);
  }
  if (shown.length === 0) lines.push(`Not on the schedule for ${[...live].join(' or ') || 'the current term'}.`);
  const earlier = history.offerings.filter((offering) => !live.has(offering.term)).slice(0, 6);
  if (earlier.length) {
    lines.push(
      `Earlier terms: ${earlier
        .map((offering) => {
          const names = [...new Set(offering.sections.filter((row) => row.status !== 'cancelled').flatMap((row) => row.instructors))];
          return `${offering.term} (${names.length ? names.join(', ') : 'cancelled'})`;
        })
        .join('; ')}.`,
    );
  }
  if (history.description) lines.push(`Description: ${truncate(history.description, 600)}`);
  return lines.join('\n');
}

/**
 * Every class of some subjects in one term, one line each with who teaches it and its seats, for "CSTS for spring
 * 2027" or "which SOCSC classes still have seats in Fall 2". A half ('71', '72') keeps the classes running in it.
 */
export function subjectScheduleText(catalog: Catalog, subjects: string[], term: string, half: '71' | '72' | '' = ''): string {
  const lines: string[] = [];
  for (const row of courseRows(catalog, term)) {
    if (!subjects.includes(row.subject)) continue;
    const sections = row.sections.filter((section) => section.status !== 'cancelled' && section.component !== 'Recitation' && section.component !== 'Laboratory' && (!half || section.session === (half === '71' ? 'First 7 weeks' : 'Second 7 weeks')));
    if (!sections.length) continue;
    const who = [...new Set(sections.flatMap((section) => section.instructors))];
    const seats = (['open', 'waitlist', 'closed'] as const).map((status) => [status, sections.filter((section) => section.status === status).length] as const).filter(([, count]) => count > 0).map(([status, count]) => `${count} ${status}`);
    const weeks = [...new Set(sections.map((section) => section.session).filter(Boolean))];
    lines.push(`- ${row.code} ${row.title}${row.credits ? ` (${row.credits} credits)` : ''}: ${who.length ? who.join(', ') : 'instructor not listed'}${weeks.length ? ` · ${weeks.join(', ')}` : ''} · ${plural(sections.length, 'section')}: ${seats.join(', ')}`);
  }
  const which = `${subjects.map((subject) => `${subject}-UH`).join(', ')} classes in ${term}${half ? ` (${half === '71' ? 'first' : 'second'} seven weeks)` : ''}`;
  if (!lines.length) return `Albert class schedule, read on ${catalog.scraped.slice(0, 10)}: no ${which}.`;
  return [`Albert class schedule: every ${which}, with seats as Albert showed them on ${catalog.scraped.slice(0, 10)} (open, waitlist or closed per section):`, ...lines].join('\n');
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Everything a professor teaches or taught, by term, for the answer model. */
export function instructorScheduleText(catalog: Catalog, name: string): string {
  const byTerm = new Map<string, string[]>();
  for (const [code, offerings] of catalog.byCode) {
    for (const offering of offerings) {
      const sections = offering.sections.filter((section) => section.status !== 'Cancelled' && section.instructors.some((entry) => displayName(entry) === name));
      if (sections.length === 0) continue;
      const parts = sections.map((section) => `${section.component} ${section.section}${section.meetings[0] ? ` ${meetingText({ days: section.meetings[0].days, start: section.meetings[0].startTime, end: section.meetings[0].endTime, room: '' })}` : ''}`);
      byTerm.set(offering.term, [...(byTerm.get(offering.term) ?? []), `${code} ${offering.title} (${parts.join('; ')})`]);
    }
  }
  if (byTerm.size === 0) return '';
  const terms = [...byTerm.keys()].sort((a, b) => termOrder(b) - termOrder(a)).slice(0, 6);
  return [`Albert class schedule: classes taught by ${name}, by term (the term now is ${catalog.current}).`, ...terms.map((term) => `${term}: ${byTerm.get(term)!.join(' · ')}`)].join('\n');
}
