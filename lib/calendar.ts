/**
 * The undergraduate academic calendar as dated events. The official page lists rows like "Sep 11 (Fri) | Add/drop
 * deadline for 14-week courses" under term headings, without years, and a search passage holds one term of it at most:
 * "when is fall break" used to get the Winter Break rows. Here the whole year is read once per corpus, each row gets its
 * year from the academic year the page names, and a question gets the rows it is about, marked as passed or coming up.
 */
import type { OfficialCorpus, OfficialDoc } from './official.ts';
import { collapseWhitespace, dayNumber, truncate } from './text.ts';

/** The registrar's calendar comes first: the bulletin's own calendar page sends readers to it for deadlines. */
export const CALENDAR_PAGES = [
  'https://nyuad.nyu.edu/en/academics/undergraduate/academic-calendar.html',
  'https://bulletins.nyu.edu/undergraduate/abu-dhabi/academic-calendar/',
];

export type CalendarTerm = 'fall' | 'jterm' | 'spring' | 'summer';

export interface CalendarEvent {
  /** YYYY-MM-DD. */
  start: string;
  end: string;
  label: string;
  /** The heading it is listed under, e.g. "Fall Semester 2" or "January Term 2027 · For Courses in Global Locations". */
  section: string;
  term: CalendarTerm;
}

export interface AcademicCalendar {
  doc: OfficialDoc;
  /** "2026–2027". */
  year: string;
  events: CalendarEvent[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})\\*?(?:\\s*[-–]\\s*(?:${MONTH}\\s+)?(\\d{1,2})\\*?)?(?:\\s*\\(([a-z/ -]+)\\))?`, 'i');
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function month(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function iso(year: number, monthNumber: number, day: number): string {
  return `${year}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** August to December fall in the first year of "2026–2027", January to July in the second. */
function yearOf(monthNumber: number, startYear: number): number {
  return monthNumber >= 8 ? startYear : startYear + 1;
}

function termOf(section: string, monthNumber: number): CalendarTerm {
  if (/summer/i.test(section)) return 'summer';
  if (/january|j-?term/i.test(section)) return 'jterm';
  if (/spring/i.test(section)) return 'spring';
  if (/fall|orientation|winter/i.test(section)) return 'fall';
  return monthNumber >= 8 ? 'fall' : 'spring';
}

/** A cell that holds a date (and nothing much besides a weekday or a heading word), as start and end. */
function parseDate(cell: string, startYear: number): { start: string; end: string; month: number } | null {
  const match = DATE.exec(cell);
  if (!match) return null;
  // "Spring Break March 8-12 (Mon-Fri)" is a date; a sentence that mentions one is not.
  if (cell.replace(match[0], '').trim().split(/\s+/).filter(Boolean).length > 3) return null;
  const startMonth = month(match[1]!);
  const startDay = Number(match[2]);
  const endMonth = match[3] ? month(match[3]) : startMonth;
  const endDay = match[4] ? Number(match[4]) : startDay;
  if (!startMonth || !endMonth || startDay < 1 || startDay > 31 || endDay < 1 || endDay > 31) return null;
  const start = iso(yearOf(startMonth, startYear), startMonth, startDay);
  const end = iso(yearOf(endMonth, startYear), endMonth, endDay);
  return { start, end: end < start ? start : end, month: startMonth };
}

/** The rows of one section of the page: date cells each followed by the event they date. */
function sectionEvents(title: string, text: string, startYear: number): CalendarEvent[] {
  const cells = text.split(/\s*\|\s*|\n{2,}/).map((cell) => collapseWhitespace(cell)).filter(Boolean);
  const events: CalendarEvent[] = [];
  let group = '';
  let pending: ReturnType<typeof parseDate> = null;
  for (const cell of cells) {
    const date = parseDate(cell, startYear);
    if (date) {
      pending = date;
      continue;
    }
    if (pending) {
      const section = group ? `${title} · ${group}` : title;
      events.push({ start: pending.start, end: pending.end, label: cell.replace(/\*+$/, '').trim(), section, term: termOf(section, pending.month) });
      pending = null;
    } else if (/^for (?:courses|students)\b/i.test(cell)) {
      // "For Courses in Global Locations": the rows after it are for that group.
      group = cell;
    } else if (/^(?:am|pm|note):/i.test(cell) && events.length) {
      // "AM: Orientation" on a line of its own goes on with the row above it.
      const last = events[events.length - 1]!;
      last.label = `${last.label}; ${cell}`;
    }
    // Anything else between rows ("Spring Break" above its own row, "All summer classes are in Abu Dhabi") is a caption.
  }
  return events;
}

/** Reads one calendar page; null when it does not look like one. */
export function parseCalendar(doc: OfficialDoc): AcademicCalendar | null {
  const span = /\b(20\d\d)\s*[–-]\s*(20\d\d)\b/.exec(`${doc.sections?.map((section) => section.title).join(' ') ?? ''} ${doc.text}`);
  if (!span || Number(span[2]) !== Number(span[1]) + 1) return null;
  const startYear = Number(span[1]);
  const parts = doc.sections?.length ? doc.sections : [{ title: doc.title, text: doc.text }];
  const seen = new Set<string>();
  const events: CalendarEvent[] = [];
  for (const part of parts) {
    // The bulletin repeats the year in every heading: "2026–2027 · Fall Semester I".
    const title = part.title.replace(/^\s*20\d\d\s*[–-]\s*20\d\d\s*·?\s*/, '').trim() || part.title;
    for (const event of sectionEvents(title, part.text, startYear)) {
      // The registrar's page lists "Spring 2027 schedule published" under both fall and spring.
      const key = `${event.start}|${event.end}|${event.label.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }
  if (events.length < 10) return null;
  return { doc, year: `${span[1]}–${span[2]}`, events: events.sort((a, b) => a.start.localeCompare(b.start)) };
}

const calendars = new WeakMap<OfficialCorpus, AcademicCalendar | null>();

/** The calendar from the official pages, the registrar's page first; null when neither parses. */
export function academicCalendar(corpus: OfficialCorpus | null | undefined): AcademicCalendar | null {
  if (!corpus) return null;
  if (calendars.has(corpus)) return calendars.get(corpus)!;
  let found: AcademicCalendar | null = null;
  for (const url of CALENDAR_PAGES) {
    const doc = corpus.docs.find((entry) => entry.url === url);
    found = doc ? parseCalendar(doc) : null;
    if (found) break;
  }
  calendars.set(corpus, found);
  return found;
}

/* ---------- Which rows a question is about ---------- */

/**
 * What a question can ask the calendar about, and the rows that answer it. A general topic (a term starting or ending,
 * any break) is left out when the question also names something specific: "when does add/drop end" is about add/drop.
 */
const TOPICS: Array<{ question: RegExp | ((question: string) => boolean); event: RegExp; general?: boolean }> = [
  { question: /\b(?:add(?:ing)?|drop(?:ping|ped)?|add\s*\/\s*drop|swap(?:ping)?)\b/i, event: /\badd\b|\bdrop\b|add\s*\/\s*drop|\bswap\b/i },
  // Dropping after add/drop is withdrawing; "add drop deadline" is not asking about that.
  { question: (question) => /\b(?:withdr\w*|too late|w grade)\b/i.test(question) || (/\bdrop/i.test(question) && !/\badd/i.test(question)), event: /withdr/i },
  { question: /\b(?:pass\s*\/?\s*fail|p\s*\/\s*f|grading basis|grade basis)\b/i, event: /pass\s*\/\s*fail|grading basis/i },
  { question: /\b(?:exams?|finals?|midterms?|reading days?)\b/i, event: /exam|reading day/i },
  { question: /\bfall break\b/i, event: /fall break/i },
  { question: /\bspring break\b/i, event: /spring break/i },
  { question: /\b(?:winter break|christmas|new year'?s?)\b/i, event: /winter break/i },
  { question: /\b(?:national day|commemoration day)\b/i, event: /national (?:day|holiday)|commemoration/i },
  { question: /\b(?:eid|ramadan|prophet|islamic new year|hijri)\b/i, event: /eid|ramadan|prophet|hijri/i },
  { question: /\b(?:breaks?|holidays?|days? off|no class(?:es)?|vacation|long weekend)\b/i, event: /break|holiday|no classes|eid|national day|prophet/i, general: true },
  { question: /\b(?:start|starts|starting|begin|begins|beginning|first day|arriv\w*|move in|moving in|marhaba|orientation|resume|resumes|come back)\b/i, event: /first day|begin|classes resume|arriv|marhaba|orientation/i, general: true },
  { question: /\b(?:last day|ends?|ending|over|finish(?:es)?|leave|depart\w*|move out)\b/i, event: /last day|depart|final exams/i, general: true },
  { question: /\b(?:commencement|graduation|graduate|graduating|convocation|diplomas?|conferral)\b/i, event: /commencement|conferral|graduat|diploma/i },
  { question: /\b(?:regist\w*|shopping cart|enroll\w*|schedule (?:comes out|come out|released?|published|out))\b/i, event: /schedule published|shopping cart|regist|enrollment/i },
  { question: /\b(?:grades? (?:due|out|released|posted|come out)|when (?:do|will|are) (?:we|i|my)? ?(?:get )?(?:my )?grades)\b/i, event: /grades? due/i },
  { question: /\b(?:legislative days?|make-?up days?)\b/i, event: /legislative/i },
];

function asks(topic: (typeof TOPICS)[number], question: string): boolean {
  return typeof topic.question === 'function' ? topic.question(question) : topic.question.test(question);
}
/** Asking when something happens, or whether it still can. */
const WHEN = /\b(?:when|what (?:day|date|time)|which (?:day|date)|dates?|deadlines?|last day|first day|due|until|till|by when|still|yet|too late|how long|how many days|calendar|start|starts|begin|begins|end|ends|over|is there|are there|do we have|do i have|is it)\b/i;

const TERM_WORDS: Array<[CalendarTerm, RegExp]> = [
  ['jterm', /\b(?:j-?term|january term)\b/i],
  ['summer', /\bsummer\b/i],
  ['spring', /\bspring\b(?!\s+break)/i],
  ['fall', /\bfall\b(?!\s+break)/i],
];

/** The term a date falls in, or the next one to start when it falls between terms. */
function termAt(calendar: AcademicCalendar, today: string): CalendarTerm {
  const bounds = new Map<CalendarTerm, { start: string; end: string }>();
  for (const event of calendar.events) {
    const span = bounds.get(event.term);
    bounds.set(event.term, { start: span && span.start < event.start ? span.start : event.start, end: span && span.end > event.end ? span.end : event.end });
  }
  const order: CalendarTerm[] = ['fall', 'jterm', 'spring', 'summer'];
  return order.find((term) => bounds.has(term) && today <= bounds.get(term)!.end) ?? 'summer';
}

const NEXT_TERM: Record<CalendarTerm, CalendarTerm> = { fall: 'spring', jterm: 'spring', spring: 'fall', summer: 'fall' };

/** The terms a question names, "this semester" and "next semester" included; empty when it names none. */
function askedTerms(question: string, current: CalendarTerm): CalendarTerm[] {
  const named = TERM_WORDS.filter(([, pattern]) => pattern.test(question)).map(([term]) => term);
  if (/\b(?:this|current) (?:semester|term)\b/i.test(question)) named.push(current);
  if (/\bnext (?:semester|term)\b/i.test(question)) named.push(NEXT_TERM[current]);
  return [...new Set(named)];
}

/** Whether a question asks the calendar something: a date it lists, or whether a deadline has passed. */
export function asksCalendar(question: string): boolean {
  return WHEN.test(question) && TOPICS.some((topic) => asks(topic, question));
}

/** The rows a question is about, in date order; empty when it is not a calendar question. */
export function calendarEvents(calendar: AcademicCalendar, question: string, today: string): CalendarEvent[] {
  if (!WHEN.test(question)) return [];
  const asked = TOPICS.filter((topic) => asks(topic, question));
  const specific = asked.filter((topic) => !topic.general);
  const patterns = (specific.length ? specific : asked).map((topic) => topic.event);
  if (patterns.length === 0) return [];
  const matching = calendar.events.filter((event) => patterns.some((pattern) => pattern.test(event.label)));
  // A question that names no term is about this one and the next ("when is the add drop deadline" in October).
  const current = termAt(calendar, today);
  const named = askedTerms(question, current);
  const terms = named.length ? named : [current, ...(current === 'fall' ? ['jterm' as const] : []), NEXT_TERM[current]];
  const inTerms = matching.filter((event) => terms.includes(event.term));
  return (inTerms.length ? inTerms : matching).slice(0, 24);
}

function weekdayDate(date: string): string {
  const day = new Date(dayNumber(date) * 86_400_000);
  return day.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function when(event: CalendarEvent): string {
  return event.end === event.start ? weekdayDate(event.start) : `${weekdayDate(event.start)} to ${weekdayDate(event.end)}`;
}

function status(event: CalendarEvent, today: string): string {
  if (event.end < today) return 'passed';
  if (event.start <= today) return 'now';
  const days = Math.round(dayNumber(event.start) - dayNumber(today));
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** The rows as the model reads them: full dates with weekdays and years, each marked passed, now or how far off. */
export function calendarText(calendar: AcademicCalendar, events: CalendarEvent[], today: string): string {
  const fourPm = /4\s*(?::00)?\s*pm/i.test(calendar.doc.text) ? ' Registration deadlines are at 4pm Abu Dhabi time on the day listed.' : '';
  const lines = events.map((event) => `- ${when(event)} (${status(event, today)}): ${truncate(event.label, 220)} [${event.section}]`);
  return [
    `Official NYUAD undergraduate academic calendar ${calendar.year} · ${calendar.doc.url} · fetched ${calendar.doc.fetchedAt.slice(0, 10)}. Today is ${weekdayDate(today)}; years and weekdays are worked out from the calendar's academic year.${fourPm} The rows this question is about:`,
    ...lines,
  ].join('\n');
}

/** Whether the calendar covers a day: it is read for the academic year it lists, not for how long ago it was fetched. */
export function calendarCovers(calendar: AcademicCalendar, today: string): boolean {
  const first = calendar.events[0]?.start ?? '';
  const last = calendar.events.at(-1)?.end ?? '';
  return first !== '' && dayNumber(today) >= dayNumber(first) - 120 && today <= last;
}
