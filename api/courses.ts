/**
 * Courses from Albert's schedule, and for one course an AI rating written from what students said about it in the
 * group, cached per course.
 *
 *   GET /api/courses                               the terms, and which one is current
 *   GET /api/courses?term=Fall%202026               every course offered that term, with sections (the planner)
 *   GET /api/courses?all=1                          every course once, for the course list
 *   GET /api/courses?code=CS-UH%201001              one course: title, credits, description
 *   GET /api/courses?code=CS-UH%201001&rating=1     the rating, written once and cached (slow the first time)
 */
import { boardStore } from '../lib/board-store.ts';
import { allCourses, courseHistory, courseRows, loadCatalog, type Catalog } from '../lib/courses.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, queryString, rateLimit, route, sendJson } from '../lib/http.ts';
import { normalizeCode } from '../lib/html.ts';
import { loadOfficial, type OfficialCorpus, type OfficialDoc } from '../lib/official.ts';
import { providersFromEnv, siteJson } from '../lib/providers.ts';
import { retrieve, sourcesBlock, toSourceCards } from '../lib/rag.ts';
import { rerankerFromEnv } from '../lib/rerank.ts';
import type { Hit } from '../lib/search.ts';
import { loadArchive, type Archive } from '../lib/store.ts';
import { collapseWhitespace, formatDate, truncate } from '../lib/text.ts';

export const config = { maxDuration: 60 };

export default route(['GET'], async (req, res) => {
  rateLimit(req, 60, 40, 'courses');
  const catalog = loadCatalog();
  const code = queryString(req, 'code').trim();
  const term = queryString(req, 'term').trim();

  if (code) {
    const normalized = normalizeCode(code);
    const official = await loadOfficial().catch(() => null);
    // Ratings cost embedding and model calls and are cached per code: only real courses get them.
    if (!catalog.byCode.has(normalized) && !bulletinEntry(official, normalized)) throw new ApiError(404, 'No course with that code.', 'not_found');
    if (queryString(req, 'rating')) {
      const known = await savedRating(normalized);
      // Writing a rating costs a search and a model call: a few a minute per person, so walking every code cannot spend
      // the day's model quota. Reading one already written is free.
      if (known === undefined) rateLimit(req, 8, 3, 'course-rating');
      sendJson(res, 200, { rating: known === undefined ? await courseRating(await loadArchive(), official, catalog, normalized) : known });
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
    sendJson(res, 200, { term, courses: courseRows(catalog, term) }, 3600);
    return;
  }
  sendJson(res, 200, { terms: catalog.terms, current: catalog.current, scraped: catalog.scraped }, 3600);
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
  return {
    code,
    title: titleOf(catalog, official, code) || code,
    credits: history?.credits || (doc?.credits ? String(doc.credits) : ''),
    core: history?.core ?? false,
    description: history?.description || (doc ? truncate(collapseWhitespace(doc.text), 1500) : ''),
  };
}

const threadCache = new Map<string, { at: number; hits: Hit[] }>();
const THREAD_TTL_MS = 30 * 60_000;
const MAX_THREADS = 8;

/**
 * The group's threads about a course. Students rarely write the code ("intro to CS", "calc 2"), so this searches by
 * title and code like Ask does, keeps what the cross-encoder judges to be about the course, and always keeps threads
 * that name the code.
 */
async function courseThreads(archive: Archive, catalog: Catalog, official: OfficialCorpus | null, code: string): Promise<Hit[]> {
  const cached = threadCache.get(code);
  if (cached && Date.now() - cached.at < THREAD_TTL_MS) return cached.hits;
  const title = titleOf(catalog, official, code);
  const mentioned = new Set([...(archive.byCourse.get(code) ?? []), ...(archive.byCourse.get(bareCode(code)) ?? [])]);
  const retrieval = await retrieve(archive, `${title} ${bareCode(code)}`.trim(), { k: 24 });
  let hits = retrieval.hits;
  const reranker = rerankerFromEnv();
  let judged = false;
  if (reranker && hits.length && title) {
    try {
      const documents = hits.map((hit) => truncate(`${formatDate(archive.posts[hit.post]!.date)}. ${collapseWhitespace(archive.chunks[hit.chunk]!.text)}`, 2000));
      const scores = await reranker.rerank(`What students say about the NYU Abu Dhabi course ${code} ${title}`, documents, { timeoutMs: 8_000 });
      hits = hits.map((hit, i) => ({ ...hit, score: scores[i]! })).filter((hit) => hit.score >= 0.35 || mentioned.has(hit.post)).sort((a, b) => b.score - a.score);
      judged = true;
    } catch (error) {
      console.warn('[courses] rerank unavailable:', (error as Error).message);
    }
  }
  // Without a judge, keep only threads both keyword and meaning search agree on, or that name the code.
  if (!judged) hits = hits.filter((hit) => mentioned.has(hit.post) || (hit.lexicalRank !== undefined && hit.denseRank !== undefined) || !retrieval.dense);
  const kept = hits.slice(0, MAX_THREADS);
  for (const post of mentioned) {
    if (kept.length >= MAX_THREADS) break;
    if (!kept.some((hit) => hit.post === post)) kept.push({ post, chunk: archive.postChunk[post]!, score: 0 });
  }
  threadCache.set(code, { at: Date.now(), hits: kept });
  return kept;
}

/* ---------- The rating ---------- */

interface CourseRating {
  /** 1.0 to 5.0: how students rate taking it. */
  score: number;
  /** 1 (easy) to 5 (very hard); null when students do not say. */
  difficulty: number | null;
  /** 1 (light) to 5 (heavy); null when students do not say. */
  workload: number | null;
  verdict: string;
  pros: string[];
  cons: string[];
  tips: string[];
  /** How many students' first-hand accounts it rests on. */
  basis: number;
  confidence: 'high' | 'medium' | 'low';
  model: string;
  createdAt: string;
}

const RATING_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'NUMBER' },
    difficulty: { type: 'INTEGER', nullable: true },
    workload: { type: 'INTEGER', nullable: true },
    verdict: { type: 'STRING' },
    pros: { type: 'ARRAY', items: { type: 'STRING' } },
    cons: { type: 'ARRAY', items: { type: 'STRING' } },
    tips: { type: 'ARRAY', items: { type: 'STRING' } },
    basis: { type: 'INTEGER' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['score', 'difficulty', 'workload', 'verdict', 'pros', 'cons', 'tips', 'basis', 'confidence'],
};

const RATING_SYSTEM = [
  'You rate one NYU Abu Dhabi course for students, from what students wrote about it in the Room of Requirement Facebook group (the threads below) and its bulletin entry. Some threads may be about other courses: use only what is about this one.',
  'Return:',
  'score: how students rate taking it, 1.0 to 5.0 with one decimal: would they recommend it, is it worth the work, did they enjoy it. Use the whole range: 4.5 and up when students love it, 2 and below when they warn others off it, 3.0 only when they are truly split. Judge from what students say, never from the description.',
  'difficulty: 1 (easy A) to 5 (very hard), and workload: 1 (light) to 5 (heavy), estimated from what students say about exams, grading, problem sets and hours; null only when the threads give nothing to go on.',
  'verdict: one plain sentence on what taking it is like and who it suits.',
  'pros: up to 4 things students liked. cons: up to 4 things students complained about. tips: up to 3 practical tips students gave.',
  'basis: how many different students gave a first-hand account of taking it (count people, not threads). 0 when the threads say nothing about what taking it is like.',
  'confidence: high when several recent first-hand accounts agree, medium when there are few or older ones, low when they are thin, very old or split.',
  'Every point must be specific to this course: name the thing (the final, weekly problem sets, the lab reports, the group project, a professor and what students said about their teaching). Never write vague points like "some professors are good" or "experiences vary". If students only say something general, leave it out.',
  'Each point under 16 words, plain words, no citations, source numbers or thread references. Report complaints as plainly as praise.',
  'About professors, only how they teach, grade or run the class, as students reported it ("students found her exams fair"); nothing personal, no rumours. When a point held only in one year or with one professor, say so in a few words.',
  'Never invent anything.',
].join('\n');

const RATING_TTL_MS = 30 * 86_400_000;
const hot = new Map<string, CourseRating | null>();

function ratingKey(code: string): string {
  return `course-rating:v2:${code}`;
}

/** A fresh rating already written (null: students have not written enough), or undefined when one has to be written. */
async function savedRating(code: string): Promise<CourseRating | null | undefined> {
  const key = ratingKey(code);
  const remembered = hot.get(key);
  if (remembered !== undefined && (!remembered || Date.now() - Date.parse(remembered.createdAt) < RATING_TTL_MS)) return remembered;
  const saved = (await boardStore()?.getSummary(key).catch(() => null))?.payload as CourseRating | null | undefined;
  if (saved && Date.now() - Date.parse(saved.createdAt) < RATING_TTL_MS) {
    hot.set(key, saved);
    return saved;
  }
  return undefined;
}

/** A new rating; null when students have not written enough to rate the course. An old one stands in when this fails. */
async function courseRating(archive: Archive, official: OfficialCorpus | null, catalog: Catalog, code: string): Promise<CourseRating | null> {
  const key = ratingKey(code);
  const store = boardStore();
  const saved = (await store?.getSummary(key).catch(() => null))?.payload as CourseRating | null | undefined;
  const gemini = geminiConfig();
  const backups = providersFromEnv();
  if (!gemini && backups.length === 0) {
    if (saved) return saved;
    throw new ApiError(503, 'Ratings are off on this server.', 'no_model');
  }
  const hits = await courseThreads(archive, catalog, official, code);
  if (hits.length === 0) {
    hot.set(key, null);
    return null;
  }
  const doc = bulletinEntry(official, code);
  const history = courseHistory(catalog, code);
  const title = titleOf(catalog, official, code) || code;
  const bulletin = doc ? `Bulletin entry:\n${truncate(collapseWhitespace(doc.text), 2500)}` : history?.description ? `Description: ${truncate(history.description, 800)}` : '';
  const threads = sourcesBlock(archive, toSourceCards(archive, hits.slice(0, 7), [], 1));
  let rating: CourseRating | null;
  try {
    const result = await siteJson<Partial<CourseRating>>(gemini, backups, {
      system: RATING_SYSTEM,
      prompt: `Course: ${code} ${title}\n${bulletin}\n\nWhat students wrote:\n${threads}`,
      schema: RATING_SCHEMA,
      tier: 'main',
      temperature: 0.2,
      maxOutputTokens: 2048,
      timeoutMs: 25_000,
    });
    rating = cleanRating(result, gemini?.chatModel ?? backups[0]?.models[0] ?? '');
  } catch (error) {
    console.warn('[courses] rating failed:', (error as Error).message);
    if (saved) return saved;
    throw new ApiError(503, 'The rating could not be written right now.', 'busy');
  }
  hot.set(key, rating);
  // Only a real rating is kept; a course students have not described yet is looked at again after the next cold start.
  if (rating) await store?.putSummary(key, rating).catch((error) => console.warn('[courses] could not cache the rating:', (error as Error).message));
  return rating;
}

function cleanRating(raw: Partial<CourseRating>, model: string): CourseRating | null {
  const basis = Math.max(0, Math.round(Number(raw.basis) || 0));
  const score = Math.round(Math.min(5, Math.max(1, Number(raw.score) || 0)) * 10) / 10;
  if (basis === 0 || !Number.isFinite(score)) return null;
  const scale = (value: unknown) => (Number.isFinite(Number(value)) && value !== null ? Math.min(5, Math.max(1, Math.round(Number(value)))) : null);
  // Citations are not shown, so any the model writes anyway are taken out.
  const tidy = (value: unknown) => collapseWhitespace(String(value ?? '').replace(/\s*\[\d+\](?:\[\d+\])*/g, ''));
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value.map(tidy).filter((entry) => entry.length > 2).slice(0, max) : []);
  const level = String(raw.confidence ?? '').toLowerCase();
  return {
    score,
    difficulty: scale(raw.difficulty),
    workload: scale(raw.workload),
    verdict: tidy(raw.verdict),
    pros: list(raw.pros, 4),
    cons: list(raw.cons, 4),
    tips: list(raw.tips, 3),
    basis,
    confidence: level === 'high' || level === 'low' ? level : 'medium',
    model,
    createdAt: new Date().toISOString(),
  };
}
