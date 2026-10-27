/**
 * Courses from Albert's schedule, and how students rate them and their professors: the review digests that
 * scripts/reviews.ts builds offline from the Room of Requirement archive and the reviews written here. Nothing here
 * calls a model; a course or professor nobody has written about simply has no rating yet.
 *
 *   GET /api/courses                               the terms, and which one is current
 *   GET /api/courses?term=Fall%202026               every course offered that term, with sections (the planner)
 *   GET /api/courses?all=1                          every course once, for the course list
 *   GET /api/courses?code=CS-UH%201001              one course: title, credits, description
 *   GET /api/courses?code=CS-UH%201001&rating=1     its rating, from its digest
 *   GET /api/courses?code=CS-UH%201001&view=1       its page: the course, its rating, its professors and their scores
 *   GET /api/courses?prof=Thomas%20P%C3%B6tsch       a professor's page: their rating and the courses they teach
 *   GET /api/courses?ratings=1                     every score and one-line verdict, for the search
 */
import { courseRating, level, profRating, type Digest } from '../lib/board.ts';
import { boardStore } from '../lib/board-store.ts';
import { allCourses, courseHistory, courseRows, currentCode, displayName, loadCatalog, termOrder, type Catalog } from '../lib/courses.ts';
import { courseKey, profKey } from '../lib/entities.ts';
import { ApiError, queryString, rateLimit, route, sendJson } from '../lib/http.ts';
import { normalizeCode } from '../lib/html.ts';
import { loadOfficial, type OfficialCorpus, type OfficialDoc } from '../lib/official.ts';
import { schoolRows } from '../lib/plan-school.ts';
import { isPlanSchool, planSchools } from '../lib/plan-schools.ts';
import { collapseWhitespace, truncate } from '../lib/text.ts';

export const config = { maxDuration: 60 };

export default route(['GET'], async (req, res) => {
  rateLimit(req, 60, 40, 'courses');
  const catalog = loadCatalog();
  const code = queryString(req, 'code').trim();
  const term = queryString(req, 'term').trim();
  const school = queryString(req, 'school').trim();

  const prof = collapseWhitespace(queryString(req, 'prof'));
  if (prof) {
    sendJson(res, 200, await profView(catalog, prof), 60);
    return;
  }
  if (queryString(req, 'ratings')) {
    sendJson(res, 200, await scoreIndex(), 120);
    return;
  }
  if (code) {
    const normalized = normalizeCode(code);
    const official = await loadOfficial().catch(() => null);
    if (!catalog.byCode.has(normalized) && !bulletinEntry(official, normalized)) throw new ApiError(404, 'No course with that code.', 'not_found');
    if (queryString(req, 'rating')) {
      const [digest] = (await boardStore()?.getDigests([courseKey(catalog, normalized)]).catch(() => [])) ?? [];
      sendJson(res, 200, { rating: courseRating(digest) }, 300);
      return;
    }
    if (queryString(req, 'view')) {
      sendJson(res, 200, await courseView(official, catalog, normalized), 60);
      return;
    }
    sendJson(res, 200, courseDetail(official, catalog, normalized), 600);
    return;
  }
  if (queryString(req, 'all')) {
    sendJson(res, 200, { courses: allCourses(catalog) }, 3600);
    return;
  }
  if (term) {
    if (!catalog.terms.some((entry) => entry.name === term)) throw new ApiError(404, 'No such term.', 'not_found');
    if (school && !isPlanSchool(catalog, school)) throw new ApiError(400, 'Choose a school or study away site.', 'bad_school');
    sendJson(res, 200, { term, courses: school ? schoolRows(catalog, term, school) : courseRows(catalog, term) }, 3600);
    return;
  }
  if (school) {
    if (!isPlanSchool(catalog, school)) throw new ApiError(400, 'Choose a school or study away site.', 'bad_school');
    const terms = catalog.terms.map((entry) => ({ ...entry, courses: schoolRows(catalog, entry.name, school).filter((row) => row.sections.some((section) => section.status !== 'cancelled')).length })).filter((entry) => entry.courses > 0);
    sendJson(res, 200, { terms, current: terms.find((entry) => entry.name === catalog.current)?.name ?? terms[0]?.name ?? '', scraped: catalog.scraped }, 3600);
    return;
  }
  sendJson(res, 200, { terms: catalog.terms, current: catalog.current, scraped: catalog.scraped, schools: planSchools(catalog) }, 3600);
});

function bulletinEntry(official: OfficialCorpus | null, code: string): OfficialDoc | null {
  if (!official) return null;
  const position = official.byCode.get(code) ?? official.byCode.get(bareCode(code));
  return position === undefined ? null : official.docs[position]!;
}

/** "ACS-UH 1010X" -> "ACS-UH 1010": students and the bulletin often drop the cross-listing letters. */
function bareCode(code: string): string {
  return code.replace(/(\d{4})[A-Z]+$/, '$1');
}

function titleOf(catalog: Catalog, official: OfficialCorpus | null, code: string): string {
  return catalog.byCode.get(code)?.[0]?.title ?? bulletinEntry(official, code)?.title.replace(code, '').trim() ?? '';
}

function courseDetail(official: OfficialCorpus | null, catalog: Catalog, code: string) {
  const history = courseHistory(catalog, code);
  const doc = bulletinEntry(official, code);
  if (!history && !doc) throw new ApiError(404, 'No course with that code.', 'not_found');
  const current = history?.offerings.find((offering) => offering.term === catalog.current);
  const primary = current?.sections.filter((section) => section.component !== 'Recitation' && section.component !== 'Laboratory') ?? [];
  return {
    code,
    title: titleOf(catalog, official, code) || code,
    credits: history?.credits || (doc?.credits ? String(doc.credits) : ''),
    core: history?.core ?? false,
    description: history?.description || (doc ? truncate(collapseWhitespace(doc.text), 1500) : ''),
    currentTerm: catalog.current,
    instructors: [...new Set((primary.length ? primary : current?.sections ?? []).flatMap((section) => section.instructors))],
    professors: [...new Set((history?.offerings ?? []).flatMap((offering) => offering.sections.filter((section) => section.status !== 'cancelled' && section.component !== 'Recitation' && section.component !== 'Laboratory').flatMap((section) => section.instructors)))],
  };
}

/* ---------- The course and professor pages ---------- */

const PRIMARY = (component: string) => component !== 'Recitation' && component !== 'Laboratory';

/** Who taught a course each term up to now, newest first: what a student rating it picks from. */
function taughtBy(catalog: Catalog, code: string): Array<{ term: string; professors: string[] }> {
  const now = termOrder(catalog.current);
  return (courseHistory(catalog, code)?.offerings ?? [])
    .filter((offering) => termOrder(offering.term) <= now)
    .map((offering) => ({ term: offering.term, professors: [...new Set(offering.sections.filter((section) => section.status !== 'cancelled' && PRIMARY(section.component)).flatMap((section) => section.instructors))] }))
    .filter((offering) => offering.professors.length > 0);
}

async function courseView(official: OfficialCorpus | null, catalog: Catalog, code: string) {
  const detail = courseDetail(official, catalog, code);
  const offerings = taughtBy(catalog, code);
  const names = [...new Set([...detail.instructors, ...offerings.flatMap((offering) => offering.professors)])];
  const key = courseKey(catalog, code);
  const digests = new Map(((await boardStore()?.getDigests([key, ...names.map(profKey)]).catch(() => [])) ?? []).map((digest) => [digest.entity, digest]));
  const rating = courseRating(digests.get(key));
  const withThem = new Map((rating?.professors ?? []).map((part) => [profKey(part.name), part]));
  const lastTerm = (name: string) => offerings.find((offering) => offering.professors.includes(name))?.term ?? '';
  const professors = [...new Set([...names, ...(rating?.professors ?? []).map((part) => part.name)])].map((name) => {
    const own = profRating(digests.get(profKey(name)));
    const here = withThem.get(profKey(name));
    return { name, basis: own?.basis ?? 0, verdict: own?.verdict ?? '', here: here ? { count: here.count } : null, teachingNow: detail.instructors.includes(name), lastTerm: lastTerm(name) };
  });
  // Teaching this term first, then the most talked about with this course, then the most recent.
  professors.sort((a, b) => Number(b.teachingNow) - Number(a.teachingNow) || (b.here?.count ?? 0) - (a.here?.count ?? 0) || termOrder(b.lastTerm) - termOrder(a.lastTerm) || a.name.localeCompare(b.name));
  return { ...detail, rating, professors: professors.slice(0, 16), offerings: offerings.slice(0, 12) };
}

const profIndexes = new WeakMap<Catalog, Map<string, { name: string; courses: Map<string, { title: string; terms: string[] }> }>>();

/** Everyone who taught a lecture or seminar, by profKey, with what they taught and when (newest first). */
function profIndex(catalog: Catalog) {
  let index = profIndexes.get(catalog);
  if (index) return index;
  index = new Map();
  for (const [code, offerings] of catalog.byCode) {
    const current = currentCode(catalog, code);
    for (const offering of offerings) {
      for (const section of offering.sections) {
        if (!PRIMARY(section.component) || section.status.toLowerCase() === 'cancelled') continue;
        for (const raw of section.instructors) {
          const name = displayName(raw);
          const entry = index.get(profKey(name)) ?? index.set(profKey(name), { name, courses: new Map() }).get(profKey(name))!;
          const course = entry.courses.get(current) ?? entry.courses.set(current, { title: offering.title, terms: [] }).get(current)!;
          if (!course.terms.includes(offering.term)) course.terms.push(offering.term);
        }
      }
    }
  }
  for (const entry of index.values()) for (const course of entry.courses.values()) course.terms.sort((a, b) => termOrder(b) - termOrder(a));
  profIndexes.set(catalog, index);
  return index;
}

async function profView(catalog: Catalog, asked: string) {
  const key = profKey(asked);
  const entry = profIndex(catalog).get(key);
  const [digest] = (await boardStore()?.getDigests([key]).catch(() => [])) ?? [];
  if (!entry && !digest) throw new ApiError(404, 'No professor by that name.', 'not_found');
  const name = entry?.name ?? digest!.name;
  const rating = profRating(digest);
  const now = termOrder(catalog.current);
  const withThem = new Map((rating?.courses ?? []).map((part) => [part.code, part]));
  const codes = [...new Set([...(entry?.courses.keys() ?? []), ...withThem.keys()])];
  const courseDigests = new Map(((await boardStore()?.getDigests(codes.map((code) => courseKey(catalog, code))).catch(() => [])) ?? []).map((found) => [found.entity, found]));
  const courses = codes.map((code) => {
    const taught = entry?.courses.get(code);
    const own = courseRating(courseDigests.get(courseKey(catalog, code)));
    // The course page's split by professor, when it has one, so both pages show the same count for them in it.
    const here = own?.professors.find((part) => profKey(part.name) === key) ?? withThem.get(code);
    const terms = (taught?.terms ?? []).filter((term) => termOrder(term) <= now);
    return { code, title: taught?.title ?? catalog.byCode.get(code)?.[0]?.title ?? '', score: own?.score ?? null, here: here ? { count: here.count } : null, teachingNow: Boolean(taught?.terms.includes(catalog.current)), lastTerm: terms[0] ?? taught?.terms[0] ?? '', terms: terms.slice(0, 8) };
  });
  courses.sort((a, b) => Number(b.teachingNow) - Number(a.teachingNow) || termOrder(b.lastTerm) - termOrder(a.lastTerm) || (b.here?.count ?? 0) - (a.here?.count ?? 0) || a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { name, currentTerm: catalog.current, rating, courses: courses.slice(0, 24) };
}

/* ---------- Every score at once, for the lists ---------- */

interface ScoreIndex {
  courses: Record<string, { score: number; basis: number; difficulty: number | null; workload: number | null; verdict: string }>;
  /** Professors are never shown a score; rank (3 to 5) only orders plans. */
  profs: Record<string, { rank: number; basis: number; verdict: string }>;
}

let scoreCache: { at: number; index: ScoreIndex } | null = null;
const SCORE_TTL_MS = 60_000;
/** The verdict as one line on a search result. */
const oneLine = (verdict: unknown) => truncate(collapseWhitespace(String(verdict ?? '')), 150);

/** Every digest's score and verdict, cached a minute. Digests count the reviews written here, as they are written. */
async function scoreIndex(): Promise<ScoreIndex> {
  if (scoreCache && Date.now() - scoreCache.at < SCORE_TTL_MS) return scoreCache.index;
  const store = boardStore();
  const index: ScoreIndex = { courses: {}, profs: {} };
  if (!store) return index;
  for (const digest of await store.listDigestScores().catch(() => [])) {
    const basis = digest.positive + digest.negative + digest.neutral;
    if (!basis) continue;
    if (digest.kind === 'course') index.courses[digest.entity.slice('course:'.length)] = { score: digest.score, basis, difficulty: level(digest.difficulty), workload: level(digest.workload), verdict: oneLine(digest.verdict) };
    // Plans rank by it, and only upward: below average reads as average, so nothing here marks a professor as bad.
    else index.profs[digest.name] = { rank: Math.max(3, digest.score), basis, verdict: oneLine(digest.verdict) };
  }
  scoreCache = { at: Date.now(), index };
  return index;
}
