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
 *   GET /api/courses?profs=Thomas%20P%C3%B6tsch|... ratings of up to 24 professors
 *   GET /api/courses?ratings=1                     every score, and students' own review averages, for the lists
 */
import type { Digest } from '../lib/board.ts';
import { boardStore } from '../lib/board-store.ts';
import { allCourses, courseHistory, courseRows, loadCatalog, type Catalog } from '../lib/courses.ts';
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
  const profs = queryString(req, 'profs');

  if (profs) {
    sendJson(res, 200, await profRatings(profs), 300);
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
      sendJson(res, 200, { rating: digest ? courseRating(digest) : await oldCourse(courseKey(catalog, normalized).slice('course:'.length)) }, 300);
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

/* ---------- Ratings, from the digests ---------- */

/** How sure a digest can be: several recent ratings agreeing is high, a few is medium, one or two is low. */
function confidenceOf(digest: Digest): 'high' | 'medium' | 'low' {
  const total = digest.positive + digest.negative + digest.neutral;
  if (total >= 6 && digest.recent >= 2) return 'high';
  return total >= 3 ? 'medium' : 'low';
}

const level = (value: number | null) => (value === null ? null : Math.min(5, Math.max(1, Math.round(value))));

function courseRating(digest: Digest) {
  return {
    score: digest.score,
    difficulty: level(digest.difficulty),
    workload: level(digest.workload),
    verdict: digest.verdict,
    pros: digest.likes,
    cons: digest.warnings,
    tips: [] as string[],
    basis: digest.positive + digest.negative + digest.neutral,
    confidence: confidenceOf(digest),
    counts: { positive: digest.positive, negative: digest.negative, neutral: digest.neutral },
    professors: digest.breakdown.map(({ name, positive, negative, neutral, score }) => ({ name, positive, negative, neutral, score })),
    from: digest.firstDate,
    to: digest.lastDate,
    sources: digest.sources,
  };
}

function profRating(digest: Digest) {
  return {
    score: digest.score,
    basis: digest.positive + digest.negative + digest.neutral,
    verdict: digest.verdict,
    confidence: confidenceOf(digest),
    likes: digest.likes,
    warnings: digest.warnings,
    counts: { positive: digest.positive, negative: digest.negative, neutral: digest.neutral },
    courses: digest.breakdown.map(({ name, positive, negative, neutral, score }) => ({ code: name, positive, negative, neutral, score })),
    from: digest.firstDate,
    to: digest.lastDate,
    sources: digest.sources,
  };
}

const MAX_PROFS = 24;

/** Ratings of these professors by the names the schedule gives them; null for one nobody has written about. */
async function profRatings(param: string) {
  const names = [...new Set(param.split('|').map((name) => collapseWhitespace(name)).filter(Boolean))].slice(0, MAX_PROFS);
  const digests = new Map(((await boardStore()?.getDigests(names.map(profKey)).catch(() => [])) ?? []).map((digest) => [digest.entity, digest]));
  const ratings: Record<string, ReturnType<typeof profRating> | null> = {};
  for (const name of names) {
    const digest = digests.get(profKey(name));
    ratings[name] = digest ? profRating(digest) : await oldProf(name);
  }
  return { ratings, pending: [] as string[] };
}

/* ---------- Every score at once, for the lists ---------- */

interface ScoreIndex {
  courses: Record<string, { score: number; basis: number; difficulty: number | null; workload: number | null }>;
  profs: Record<string, { score: number; basis: number }>;
  students: Record<string, { n: number; avg: number }>;
}

let scoreCache: { at: number; index: ScoreIndex } | null = null;
const SCORE_TTL_MS = 60_000;

/** Every digest's score, and students' review averages, cached a minute. */
async function scoreIndex(): Promise<ScoreIndex> {
  if (scoreCache && Date.now() - scoreCache.at < SCORE_TTL_MS) return scoreCache.index;
  const store = boardStore();
  const index: ScoreIndex = { courses: {}, profs: {}, students: {} };
  if (!store) return index;
  const [digests, reviews] = await Promise.all([store.listDigestScores().catch(() => []), store.listReviewScores().catch(() => [])]);
  for (const digest of digests) {
    const basis = digest.positive + digest.negative + digest.neutral;
    if (digest.kind === 'course') index.courses[digest.entity.slice('course:'.length)] = { score: digest.score, basis, difficulty: level(digest.difficulty), workload: level(digest.workload) };
    else index.profs[digest.name] = { score: digest.score, basis };
  }
  await addOldScores(index);
  const sums = new Map<string, { n: number; total: number }>();
  for (const review of reviews) {
    const entry = sums.get(review.code) ?? { n: 0, total: 0 };
    entry.n++;
    entry.total += review.rating;
    sums.set(review.code, entry);
  }
  for (const [code, entry] of sums) index.students[code] = { n: entry.n, avg: Math.round((entry.total / entry.n) * 10) / 10 };
  scoreCache = { at: Date.now(), index };
  return index;
}

/* ---------- Until the review digests are filled ---------- */

// The ratings that used to be written when someone opened a course or professor, read as they are (nothing writes
// them any more), for whatever has no digest yet while the first run of scripts/reviews.ts fills review_digests.

const OLD_COURSE = 'course-rating:v6:';
const OLD_PROF = 'prof-rating:v5:';

interface OldRating {
  score: number;
  difficulty?: number | null;
  workload?: number | null;
  verdict: string;
  pros?: string[];
  cons?: string[];
  basis: number;
  confidence: 'high' | 'medium' | 'low';
  sources: Array<{ url: string; date: string; excerpt: string }>;
}

async function oldRating(key: string): Promise<OldRating | null> {
  const saved = (await boardStore()?.getSummary(key).catch(() => null))?.payload as (OldRating & { none?: boolean }) | undefined;
  return saved && !saved.none && typeof saved.score === 'number' ? saved : null;
}

const none = { positive: 0, negative: 0, neutral: 0 };

async function oldCourse(code: string): Promise<ReturnType<typeof courseRating> | null> {
  const old = await oldRating(`${OLD_COURSE}${code}`);
  return old && { score: old.score, difficulty: old.difficulty ?? null, workload: old.workload ?? null, verdict: old.verdict, pros: old.pros ?? [], cons: old.cons ?? [], tips: [], basis: old.basis, confidence: old.confidence, counts: none, professors: [], from: '', to: '', sources: old.sources };
}

async function oldProf(name: string): Promise<ReturnType<typeof profRating> | null> {
  const old = await oldRating(`${OLD_PROF}${profKey(name).slice('prof:'.length)}`);
  return old && { score: old.score, basis: old.basis, verdict: old.verdict, confidence: old.confidence, likes: [], warnings: [], counts: none, courses: [], from: '', to: '', sources: old.sources };
}

async function addOldScores(index: ScoreIndex): Promise<void> {
  const store = boardStore();
  if (!store) return;
  const [courses, profs] = await Promise.all([store.listSummaryFields(OLD_COURSE, ['score', 'basis', 'difficulty', 'workload', 'none']).catch(() => []), store.listSummaryFields(OLD_PROF, ['score', 'basis', 'none']).catch(() => [])]);
  const named = new Set(Object.keys(index.profs).map((name) => profKey(name)));
  for (const row of courses) {
    const code = row.key.slice(OLD_COURSE.length);
    if (row.fields.none || typeof row.fields.score !== 'number' || index.courses[code]) continue;
    index.courses[code] = { score: row.fields.score, basis: Number(row.fields.basis) || 0, difficulty: level(row.fields.difficulty as number | null), workload: level(row.fields.workload as number | null) };
  }
  for (const row of profs) {
    if (row.fields.none || typeof row.fields.score !== 'number' || named.has(`prof:${row.key.slice(OLD_PROF.length)}`)) continue;
    // The old keys hold the folded name; the lists look professors up by the name the schedule gives them.
    const name = loadCatalog().instructors.get(row.key.slice(OLD_PROF.length));
    if (name) index.profs[name] = { score: row.fields.score, basis: Number(row.fields.basis) || 0 };
  }
}
