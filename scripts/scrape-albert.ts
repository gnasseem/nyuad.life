/**
 * Reads every NYU Abu Dhabi class from Albert's Course Search with YOUR signed-in browser and saves it to
 * data/classes.jsonl, one line per course and term: its sections with their times, rooms, professors and
 * open, closed or waitlist status. Runs on your laptop, never on the server.
 *
 *   npm run scrape:albert                       the newest academic year in Albert
 *   npm run scrape:albert -- --year 2025-2026   another year Albert still lists
 *
 * A Chromium window opens on Albert. Sign in there with your NetID if it asks; the login is kept in .albert-profile/
 * and the scraper carries on by itself. It reads the signed-in Course Search, which has no reCAPTCHA. If Albert
 * ever shows one, the run stops rather than getting around it. A run is one search per subject (about 45), a couple
 * of seconds apart.
 *
 * Each subject is saved as soon as it is read. Its rows for the terms it returned replace the earlier ones and
 * everything else in the file is kept, so an interrupted run loses nothing and past terms stay as a record of who
 * taught what.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const args = process.argv.slice(2);
const YEAR = args.includes('--year') ? args[args.indexOf('--year') + 1] : undefined;

const PROFILE_DIR = path.resolve('.albert-profile');
const OUT_FILE = path.resolve('data/classes.jsonl');
const SIGN_IN_URL = 'https://sis.portal.nyu.edu/psp/ihprod/EMPLOYEE/EMPL/?cmd=start';
const SEARCH_URL = 'https://sis.nyu.edu/psc/csprod/EMPLOYEE/SA/c/NYU_SR.NYU_CLS_SRCH.GBL';
const SCHOOL = 'NYU Abu Dhabi';
const SIGN_IN_MINUTES = 15;

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
  /** Open, Closed, Cancelled or "Wait List (n)". */
  status: string;
  /** AD is the full term; A71 and A72 are the first and second seven weeks. */
  session: string;
  startDate: string;
  endDate: string;
  grading: string;
  mode: string;
  location: string;
  /** "Last, First", in Albert's order. */
  instructors: string[];
  meetings: Meeting[];
  notes: string;
}

interface Course {
  term: string;
  code: string;
  title: string;
  description: string;
  sections: Section[];
  scraped: string;
}

interface RawCourse {
  heading: string;
  description: string;
  terms: { term: string; classes: string[] }[];
}

/** Runs inside Albert's results page: every course with its terms and the visible text of each class. */
const EXTRACT = `[...document.querySelectorAll('[id^="win0divSELECT_COURSE_row$"]')].map((course) => {
  const head = course.querySelector('[id^="win0divNYU_CLS_DERIVED_HTMLAREA$"]');
  const description = head?.querySelector('[id^="fullDescription_"] p') ?? head?.querySelector('p');
  return {
    heading: head?.querySelector('b')?.innerText ?? '',
    description: description?.textContent ?? '',
    terms: [...course.querySelectorAll('[id^="win0divSELECT_TERM_row$"]')].map((term) => ({
      term: term.querySelector('[id^="NYU_CLS_TRM_DESCR"]')?.textContent.trim() ?? '',
      classes: [...term.querySelectorAll('[id^="win0divSELECT_CLASS_row$"]')].map((row) => row.innerText),
    })),
  };
})`;

/**
 * One meeting line, e.g. "08/31/2026 - 12/14/2026 Mon,Wed 8.30 AM - 11.10 AM at Campus Center Room W006 with
 * Pötsch, Thomas; Zeeshan, Faisal". Days, times, room and professors can each be missing, and Albert sometimes
 * glues "No Room Required" straight onto the time.
 */
const MEETING =
  /^(\d\d\/\d\d\/\d{4}) - (\d\d\/\d\d\/\d{4})(?: ([A-Z][a-z]{2}(?:,[A-Z][a-z]{2})*))?(?: (\d{1,2}\.\d\d [AP]M) - (\d{1,2}\.\d\d [AP]M))?(?: at (.+?)| ?No Room Required)?(?: with (.+))?$/;

/** Meeting lines the pattern did not match, reported at the end so a change in Albert's format is noticed. */
const unparsed: string[] = [];

function log(message: string): void {
  console.log(`[albert ${new Date().toLocaleTimeString('en-GB')}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "08/31/2026" to "2026-08-31". */
function isoDate(date: string): string {
  const [month, day, year] = date.split('/');
  return year ? `${year}-${month}-${day}` : '';
}

/** "8.30 AM" to "08:30", "3.20 PM" to "15:20". */
function clock(time: string): string {
  const [, hour = '0', minute = '00', half] = /^(\d{1,2})\.(\d\d) ([AP]M)$/.exec(time) ?? [];
  const hours = (Number(hour) % 12) + (half === 'PM' ? 12 : 0);
  return `${String(hours).padStart(2, '0')}:${minute}`;
}

function parseSection(text: string): Section | null {
  const field = (label: string) => new RegExp(`^${label}:[ \\t]*(.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
  const classNumber = field('Class#');
  if (!classNumber) return null;
  const [, session = '', from = '', to = ''] = /^(\S+) (\S+) - (\S+)$/.exec(field('Session')) ?? [];
  const meetings: Meeting[] = [];
  const instructors: string[] = [];
  const notes: string[] = [];
  let units = '';
  for (const line of text.split('\n').map((part) => part.trim()).filter(Boolean)) {
    const meeting = MEETING.exec(line);
    if (meeting) {
      const [, startDate = '', endDate = '', days, start, end, room = '', names = ''] = meeting;
      meetings.push({
        days: days ? days.split(',') : [],
        startTime: start ? clock(start) : '',
        endTime: end ? clock(end) : '',
        room,
        startDate: isoDate(startDate),
        endDate: isoDate(endDate),
      });
      for (const name of names.split(';').map((part) => part.trim())) {
        if (name && !instructors.includes(name)) instructors.push(name);
      }
      continue;
    }
    if (/^\d\d\/\d\d\/\d{4} - /.test(line)) {
      unparsed.push(line);
      continue;
    }
    // The class's own heading, "CS-UH 1001 | 4 units" (recitations and labs carry no units).
    const heading = /^[A-Z]+-[A-Z]+ \S+(?: \| (.+?) units?)?$/.exec(line);
    if (heading) {
      units ||= heading[1] ?? '';
      continue;
    }
    if (/^(Class#|Session|Section|Class Status|Grading|Instruction Mode|Course Location|Component|Topic):/.test(line)) continue;
    if (line === 'Visit the Bookstore') continue;
    notes.push(line.replace(/^Notes:\s*/, ''));
  }
  return {
    classNumber,
    section: field('Section'),
    component: field('Component'),
    topic: field('Topic'),
    units,
    status: field('Class Status'),
    session,
    startDate: isoDate(from),
    endDate: isoDate(to),
    grading: field('Grading'),
    mode: field('Instruction Mode'),
    location: field('Course Location'),
    instructors,
    meetings,
    notes: notes.join('\n'),
  };
}

function toCourses(raw: RawCourse[], scraped: string): Course[] {
  return raw.flatMap((course) => {
    // Special topics put the topic on a second line of the heading; each class repeats it as "Topic:".
    const firstLine = (course.heading.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
    const [, code = '', title = ''] = /^([A-Z]+-[A-Z]+ \S+)\s+(.*)$/.exec(firstLine) ?? [];
    const description = course.description.replace(/(?:less|more) description for .*$/s, '').replace(/\s+/g, ' ').trim();
    return course.terms.map((term) => ({
      term: term.term,
      code,
      title,
      description,
      sections: term.classes.map(parseSection).filter((section): section is Section => section !== null),
      scraped,
    }));
  });
}

/** "January 2027" before "Spring 2027" before "Summer 2027" before "Fall 2027". */
function termOrder(term: string): number {
  const [season = '', year = '0'] = term.split(' ');
  const index = ['January', 'Spring', 'Summer', 'Fall'].indexOf(season);
  return Number(year) * 10 + (index < 0 ? 9 : index);
}

function readCourses(): Course[] {
  if (!existsSync(OUT_FILE)) return [];
  return readFileSync(OUT_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Course);
}

/** Replaces the rows of each subject and term in `courses` and keeps every other row in the file. */
function save(courses: Course[]): void {
  const key = (course: Course) => `${course.term}|${course.code.split(' ')[0]}`;
  const replaced = new Set(courses.map(key));
  const all = [...readCourses().filter((course) => !replaced.has(key(course))), ...courses];
  all.sort((a, b) => termOrder(a.term) - termOrder(b.term) || a.code.localeCompare(b.code));
  writeFileSync(OUT_FILE, all.map((course) => JSON.stringify(course)).join('\n') + '\n');
}

/** Clicks or selects something on the Course Search and waits for Albert's answer to it. */
async function act(page: Page, action: () => Promise<unknown>): Promise<void> {
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'POST' && response.url().startsWith(SEARCH_URL), {
      timeout: 90_000,
    }),
    action(),
  ]);
  await sleep(500);
}

/** Waits on the NetID sign-in until Albert's home page shows. */
async function signIn(page: Page): Promise<void> {
  await page.goto(SIGN_IN_URL, { waitUntil: 'domcontentloaded' });
  const started = Date.now();
  let asked = false;
  while (!/^https:\/\/sis\.portal\.nyu\.edu\/psp\/ihprod\/EMPLOYEE\/EMPL\/h\//.test(page.url())) {
    if (page.isClosed()) throw new Error('The browser window was closed before the sign-in finished.');
    if (Date.now() - started > SIGN_IN_MINUTES * 60_000) throw new Error(`Waited ${SIGN_IN_MINUTES} minutes for the Albert sign-in. Run the command again when you are ready.`);
    // A kept login passes through the NetID pages on its own within a few seconds; only ask when it does not.
    if (!asked && Date.now() - started > 8_000) {
      asked = true;
      log('Sign in to Albert in the browser window with your NetID. The scraper carries on by itself once you are in.');
    }
    await sleep(2_000);
  }
}

async function openSearch(page: Page): Promise<void> {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' });
  const ready = await page
    .locator('#NYU_CLS_DERIVED_DESCR100')
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (ready) return;
  if (/recaptcha/i.test(await page.content())) throw new Error('Albert showed a reCAPTCHA on the Course Search, so the run stops here.');
  throw new Error(`The Course Search did not load (${page.url()}).`);
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: { width: 1280, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  const scraped = new Date().toISOString();
  const read: Course[] = [];
  try {
    await signIn(page);
    await openSearch(page);

    const years = (await page.locator('a.ps-link').allInnerTexts()).map((text) => text.trim()).filter((text) => /^\d{4}-\d{4}$/.test(text));
    const year = YEAR ?? [...years].sort().at(-1);
    if (!year || !years.includes(year)) throw new Error(`Albert lists ${years.join(', ') || 'no academic years'}${YEAR ? `, not ${YEAR}` : ''}.`);
    await act(page, () => page.getByRole('link', { name: year, exact: true }).click());
    await act(page, () => page.selectOption('select[id^="NYU_CLS_WRK2_DESCR254"]', SCHOOL));

    const subjects = (await page.locator('a').allInnerTexts())
      .map((text) => text.replace(/\s+/g, ' ').trim())
      .filter((text) => /\([A-Z]+-[A-Z]+\)$/.test(text));
    if (subjects.length === 0) throw new Error(`Albert listed no subjects for ${SCHOOL} in ${year}.`);
    log(`${year}: ${subjects.length} ${SCHOOL} subjects.`);

    for (const [index, subject] of subjects.entries()) {
      const code = /\(([A-Z]+-[A-Z]+)\)$/.exec(subject)?.[1] ?? '';
      await act(page, () => page.getByRole('link', { name: subject, exact: true }).click());
      const shown = await page
        .waitForFunction(`(document.querySelector('#RESULT_COUNTlbl')?.textContent ?? '').includes('for: ${code}')`, null, { timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      if (shown) {
        const header = (await page.locator('#RESULT_COUNTlbl').textContent()) ?? '';
        const courses = toCourses((await page.evaluate(EXTRACT)) as RawCourse[], scraped);
        const classes = courses.reduce((sum, course) => sum + course.sections.length, 0);
        const total = Number(/Total Class Count: (\d+)/.exec(header)?.[1] ?? classes);
        if (classes !== total) log(`${code}: read ${classes} classes but Albert counts ${total}.`);
        save(courses);
        read.push(...courses);
        log(`${code}: ${courses.length} courses, ${classes} classes (${index + 1}/${subjects.length})`);
      } else {
        log(`${code}: no results.`);
      }
      if (await page.locator('#NYU_CLS_DERIVED_BACK').count()) await act(page, () => page.click('#NYU_CLS_DERIVED_BACK'));
      await sleep(1_500);
    }

    const sections = read.flatMap((course) => course.sections).filter((section) => section.status !== 'Cancelled');
    const terms = [...new Set(read.map((course) => course.term))].join(', ');
    log(`Done: ${sections.length} classes (${terms}), ${sections.filter((section) => section.instructors.length === 0).length} without a professor yet. Saved to ${path.relative(process.cwd(), OUT_FILE)}.`);
    if (unparsed.length) log(`${unparsed.length} meeting lines did not parse, e.g. "${unparsed[0]}". Their times and professors are missing.`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('[albert] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
