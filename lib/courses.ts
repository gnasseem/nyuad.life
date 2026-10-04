/**
 * The class schedule from Albert (data/classes.jsonl, written by scripts/scrape-albert.ts): every NYU Abu Dhabi course
 * per term with its sections, times, rooms, professors and seat status. It powers the course search and is the
 * authority Ask cites for who teaches what, when and where. Loaded once per process.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dataRoot } from './store.ts';
import { collapseWhitespace, truncate } from './text.ts';

interface Meeting {
  days: string[];
  startTime: string;
  endTime: string;
  room: string;
  startDate: string;
  endDate: string;
}

interface Section {
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
  for (const list of byCode.values()) list.sort((a, b) => termOrder(b.term) - termOrder(a.term));
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
  if (section.session === 'A71') return 'First 7 weeks';
  if (section.session === 'A72') return 'Second 7 weeks';
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
  meetings: Array<{ days: string[]; start: string; end: string; room: string }>;
  instructors: string[];
  notes: string;
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
    meetings: section.meetings.map((meeting) => ({ days: meeting.days, start: meeting.startTime, end: meeting.endTime, room: meeting.room })),
    instructors: section.instructors.map(displayName),
    notes: withNotes ? collapseWhitespace(section.notes) : '',
  };
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

export function courseHistory(catalog: Catalog, code: string): CourseHistory | null {
  const offerings = catalog.byCode.get(code);
  if (!offerings?.length) return null;
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

const TEACHING = /\b(?:prof|professor|professors|dr|teach|teaches|teaching|taught|instructor|lecturer|class|classes|course|courses|section|sections|take|taking|took)\b/;
// Surnames that are also ordinary English words students use in course questions.
const COMMON_WORDS = new Set(['young', 'long', 'love', 'hall', 'green', 'white', 'black', 'brown', 'king', 'rich', 'west', 'will', 'may', 'hope', 'early', 'case', 'park', 'wood', 'more', 'good', 'best', 'hill', 'field', 'stone', 'bell', 'lane', 'street', 'north', 'south', 'cook', 'baker', 'mason', 'price', 'grant', 'hunt', 'major', 'minor', 'core', 'data']);

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
    const suffix = match[3]!.toUpperCase();
    for (const candidate of [base + suffix, base, `${base}X`, `${base}J`]) {
      if (catalog.byCode.has(candidate)) {
        add(candidate);
        break;
      }
    }
  }
  const folded = ` ${fold(question)} `;
  const titled: Array<{ code: string; length: number }> = [];
  for (const [title, codes] of titleIndex(catalog)) {
    // "Capstone Project" is eight courses: naming it does not say which, so it picks none.
    if (codes.length === 1 && title.length >= 8 && folded.includes(` ${title} `)) titled.push({ code: codes[0]!, length: title.length });
  }
  // The longest titles first: "Multivariable Calculus" before "Calculus".
  titled.sort((a, b) => b.length - a.length);
  for (const entry of titled) {
    const title = fold(catalog.byCode.get(entry.code)![0]!.title);
    const inside = courses.some((code) => fold(catalog.byCode.get(code)![0]!.title).includes(title));
    if (!inside) add(entry.code);
  }

  const instructors: string[] = [];
  const teaching = TEACHING.test(folded);
  for (const [key, name] of catalog.instructors) {
    if (instructors.length >= limits.instructors) break;
    const parts = key.split(' ');
    const surname = parts.at(-1)!;
    const full = parts.length > 1 && folded.includes(` ${key} `);
    const bySurname = teaching && surname.length >= 4 && !COMMON_WORDS.has(surname) && folded.includes(` ${surname} `);
    if (full || bySurname) instructors.push(name);
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
    }
    titleIndexes.set(catalog, index);
  }
  return index;
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
  return `${row.component} ${row.section}${row.topic ? ` "${row.topic}"` : ''}${row.session ? ` (${row.session})` : ''}: ${when} · ${who} · ${statusText(row)} · class #${row.classNumber}`;
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
