/**
 * Courses from Albert's schedule, and AI ratings written from what students said in the group: for one course, and
 * for the professors a plan could have. Both are cached for a month.
 *
 *   GET /api/courses                               the terms, and which one is current
 *   GET /api/courses?term=Fall%202026               every course offered that term, with sections (the planner)
 *   GET /api/courses?all=1                          every course once, for the course list
 *   GET /api/courses?code=CS-UH%201001              one course: title, credits, description
 *   GET /api/courses?code=CS-UH%201001&rating=1     the rating, written once and cached (slow the first time)
 *   GET /api/courses?profs=Thomas%20P%C3%B6tsch|... ratings of up to 24 professors: the cached ones, plus a couple
 *                                                  newly written; the rest come back in `pending` to ask again
 */
import { boardStore } from '../lib/board-store.ts';
import { allCourses, courseHistory, courseRows, displayName, loadCatalog, termOrder, type Catalog } from '../lib/courses.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, queryString, rateLimit, route, sendJson, type ApiRequest } from '../lib/http.ts';
import { requireMember } from '../lib/identity.ts';
import { normalizeCode } from '../lib/html.ts';
import { loadOfficial, type OfficialCorpus, type OfficialDoc } from '../lib/official.ts';
import { providersFromEnv, siteJson } from '../lib/providers.ts';
import { retrieve, sourcesBlock, toSourceCards } from '../lib/rag.ts';
import { rerankerFromEnv } from '../lib/rerank.ts';
import type { Hit } from '../lib/search.ts';
import { loadArchive, type Archive } from '../lib/store.ts';
import { bestWindow, collapseWhitespace, formatDate, truncate } from '../lib/text.ts';

export const config = { maxDuration: 60 };

export default route(['GET'], async (req, res) => {
  rateLimit(req, 60, 40, 'courses');
  const catalog = loadCatalog();
  const code = queryString(req, 'code').trim();
  const term = queryString(req, 'term').trim();
  const profs = queryString(req, 'profs');

  if (profs) {
    sendJson(res, 200, await profRatings(req, catalog, profs));
    return;
  }
  if (code) {
    const normalized = normalizeCode(code);
    const official = await loadOfficial().catch(() => null);
    // Ratings cost embedding and model calls and are cached per code: only real courses get them.
    if (!catalog.byCode.has(normalized) && !bulletinEntry(official, normalized)) throw new ApiError(404, 'No course with that code.', 'not_found');
    if (queryString(req, 'rating')) {
      const known = await savedRating(normalized);
      // Writing a rating costs a search and a model call: a few a minute per person, so walking every code cannot spend
      // the day's model quota. Reading one already written is free.
      if (known === undefined) {
        rateLimit(req, 8, 3, 'course-rating');
        // Writing one costs model calls, so it is for students who signed up; reading a written one is for anyone.
        await requireMember(req);
      }
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
  sources: Array<{ url: string; date: string; excerpt: string }>;
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
    evidence: { type: 'ARRAY', items: { type: 'INTEGER' } },
  },
  required: ['score', 'difficulty', 'workload', 'verdict', 'pros', 'cons', 'tips', 'basis', 'confidence', 'evidence'],
};

const RATING_SYSTEM = [
  'You rate one NYU Abu Dhabi course for students, from what students wrote about it in the Room of Requirement Facebook group (the threads below) and its bulletin entry. Some threads may be about other courses: use only what is about this one.',
  'Return:',
  'score: how students rate taking it, 1.0 to 5.0 with one decimal: would they recommend it, is it worth the work, did they enjoy it. Use the whole range: 4.5 and up when students love it, 2 and below when they warn others off it, 3.0 only when they are truly split. Judge from what students say, never from the description.',
  'difficulty: 1 (easy A) to 5 (very hard), and workload: 1 (light) to 5 (heavy), estimated from what students say about exams, grading, problem sets and hours; null only when the threads give nothing to go on.',
  'verdict: one direct sentence. If most first-hand reviews are negative, lead with a warning to avoid it. Do not balance a bad course with token praise.',
  'pros and cons: at most one specific point each. Either may be empty. Never invent a positive point to balance a negative one, or vice versa. tips: leave empty.',
  'basis: how many different students gave a first-hand account of taking it (count people, not threads). 0 when the threads say nothing about what taking it is like.',
  'evidence: the numbers of the threads that directly support your verdict and points. Return only numbers from the supplied threads; leave empty if none directly support the rating.',
  'confidence: high when several recent first-hand accounts agree, medium when there are few or older ones, low when they are thin, very old or split. Read the dates on posts and comments; do not present old reviews as current.',
  'Every point must be specific to this course: name the thing (the final, weekly problem sets, the lab reports, the group project, a professor and what students said about their teaching). Never write vague points like "some professors are good" or "experiences vary". If students only say something general, leave it out.',
  'Each point under 16 words, plain words, no citations, source numbers or thread references. Report complaints as plainly as praise.',
  'About professors, only how they teach, grade or run the class, as students reported it ("students found her exams fair"); nothing personal, no rumours. When a point held only in one year or with one professor, say so in a few words.',
  'If fewer than two different students describe taking this course first-hand, set basis below 2. Never invent anything.',
].join('\n');

const RATING_TTL_MS = 30 * 86_400_000;
const hot = new Map<string, CourseRating>();

function ratingKey(code: string): string {
  return `course-rating:v4:${code}`;
}

/** A fresh rating already written (null: students have not written enough), or undefined when one has to be written. */
async function savedRating(code: string): Promise<CourseRating | null | undefined> {
  const key = ratingKey(code);
  const remembered = hot.get(key);
  if (remembered && Date.now() - Date.parse(remembered.createdAt) < RATING_TTL_MS) return remembered;
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
  if (hits.length === 0) return null;
  const title = titleOf(catalog, official, code) || code;
  const cards = toSourceCards(archive, hits.slice(0, 7), [], 1);
  const threads = sourcesBlock(archive, cards);
  let rating: CourseRating | null;
  try {
    const result = await siteJson<Partial<CourseRating> & { evidence?: number[] }>(gemini, backups, {
      system: RATING_SYSTEM,
      prompt: `Course: ${code} ${title}\n\nWhat students wrote:\n${threads}`,
      schema: RATING_SCHEMA,
      tier: 'main',
      temperature: 0.2,
      maxOutputTokens: 2048,
      timeoutMs: 25_000,
    });
    rating = cleanRating(result, cards, gemini?.chatModel ?? backups[0]?.models[0] ?? '');
  } catch (error) {
    console.warn('[courses] rating failed:', (error as Error).message);
    if (saved) return saved;
    throw new ApiError(503, 'The rating could not be written right now.', 'busy');
  }
  if (rating) hot.set(key, rating);
  // Only a real rating is kept; a course students have not described yet is looked at again after the next cold start.
  if (rating) await store?.putSummary(key, rating).catch((error) => console.warn('[courses] could not cache the rating:', (error as Error).message));
  return rating;
}

function cleanRating(raw: Partial<CourseRating> & { evidence?: number[] }, cards: ReturnType<typeof toSourceCards>, model: string): CourseRating | null {
  const basis = Math.max(0, Math.round(Number(raw.basis) || 0));
  const given = Number(raw.score);
  if (basis < 2 || !Number.isFinite(given) || given < 1 || given > 5) return null;
  const score = Math.round(given * 10) / 10;
  const evidence = [...new Set(raw.evidence ?? [])].filter((n) => Number.isInteger(n) && n >= 1 && n <= cards.length).slice(0, 3);
  if (!evidence.length || !raw.verdict?.trim()) return null;
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
    sources: evidence.map((n) => ({ url: cards[n - 1]!.url, date: cards[n - 1]!.date, excerpt: cards[n - 1]!.snippet })),
    model,
    createdAt: new Date().toISOString(),
  };
}

/* ---------- Professors ---------- */

/** How students rate being taught by someone, from what they wrote about it in the group. */
interface ProfRating {
  /** 1.0 to 5.0. */
  score: number;
  /** How many students' first-hand accounts it rests on. */
  basis: number;
  verdict: string;
  confidence: 'high' | 'medium' | 'low';
  model: string;
  createdAt: string;
}

/** What is kept for a professor: a rating, or that students have not written enough to give one. */
type SavedProf = ProfRating | { none: true; createdAt: string };

const MAX_PROFS = 24;
/** New ratings written per request: each is a search and a model call, and the client asks again for the rest. */
const NEW_PER_REQUEST = 2;
const PROF_TTL_MS = 30 * 86_400_000;
/** Someone students have not written about is looked at again sooner: new threads come in every day. */
const PROF_NONE_TTL_MS = 7 * 86_400_000;
const profHot = new Map<string, SavedProf>();

interface Teacher {
  name: string;
  /** As Albert gives it before the comma: "Pötsch, Thomas" -> "Pötsch". */
  surname: string;
  first: string;
  /** What they teach, newest first: "CS-UH 1001 Introduction to Computer Science". */
  courses: string[];
}

const teacherIndexes = new WeakMap<Catalog, Map<string, Teacher>>();

function foldName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Everyone who teaches or taught in the schedule, by folded display name. Only they can be rated. */
function teachers(catalog: Catalog): Map<string, Teacher> {
  const known = teacherIndexes.get(catalog);
  if (known) return known;
  const index = new Map<string, Teacher & { recent: Map<string, number> }>();
  for (const [code, offerings] of catalog.byCode) {
    for (const offering of offerings) {
      for (const section of offering.sections) {
        for (const raw of section.instructors) {
          const name = displayName(raw);
          const key = foldName(name);
          if (!key) continue;
          let teacher = index.get(key);
          if (!teacher) {
            const [last = '', first = ''] = raw.split(',').map((part) => part.trim());
            teacher = { name, surname: first ? last : (name.split(' ').at(-1) ?? name), first, courses: [], recent: new Map() };
            index.set(key, teacher);
          }
          const course = `${code} ${offering.title}`;
          teacher.recent.set(course, Math.max(teacher.recent.get(course) ?? 0, termOrder(offering.term)));
        }
      }
    }
  }
  for (const teacher of index.values()) teacher.courses = [...teacher.recent.entries()].sort((a, b) => b[1] - a[1]).map(([course]) => course).slice(0, 5);
  teacherIndexes.set(catalog, index);
  return index;
}

function profKey(name: string): string {
  return `prof-rating:v2:${foldName(name)}`;
}

function fresh(entry: SavedProf | null | undefined): entry is SavedProf {
  if (!entry || typeof entry !== 'object' || typeof entry.createdAt !== 'string') return false;
  if (!('none' in entry) && typeof entry.score !== 'number') return false;
  return Date.now() - Date.parse(entry.createdAt) < ('none' in entry ? PROF_NONE_TTL_MS : PROF_TTL_MS);
}

/** A fresh rating already written, or undefined when one has to be written. */
async function savedProf(name: string): Promise<SavedProf | undefined> {
  const key = profKey(name);
  const remembered = profHot.get(key);
  if (fresh(remembered)) return remembered;
  const saved = (await boardStore()?.getSummary(key).catch(() => null))?.payload as SavedProf | undefined;
  if (!fresh(saved)) return undefined;
  profHot.set(key, saved);
  return saved;
}

function publicProf(entry: SavedProf | null): { score: number; basis: number; verdict: string; confidence: ProfRating['confidence'] } | null {
  return !entry || 'none' in entry ? null : { score: entry.score, basis: entry.basis, verdict: entry.verdict, confidence: entry.confidence };
}

/**
 * Ratings for the professors the planner may put in a plan. Only names in the schedule count, so arbitrary strings
 * cannot spend model calls. Cached ratings are free; a couple of new ones are written per request, within a per-person
 * budget, and the rest come back in `pending` for the client to ask again.
 */
async function profRatings(req: ApiRequest, catalog: Catalog, param: string) {
  const index = teachers(catalog);
  const names = [...new Set(param.split('|').map((name) => collapseWhitespace(name)).filter(Boolean))].slice(0, MAX_PROFS);
  const real = names.filter((name) => index.has(foldName(name)));
  const ratings: Record<string, ReturnType<typeof publicProf>> = {};
  const unwritten: string[] = [];
  const saved = await Promise.all(real.map(savedProf));
  real.forEach((name, i) => {
    const entry = saved[i];
    if (entry) ratings[name] = publicProf(entry);
    else unwritten.push(name);
  });
  const gemini = geminiConfig();
  const backups = providersFromEnv();
  if (!gemini && backups.length === 0) {
    for (const name of unwritten) ratings[name] = null;
    return { ratings, pending: [] };
  }
  const writing: string[] = [];
  const pending: string[] = [];
  // New ratings cost model calls, so only students who signed up get them written; anyone gets the written ones.
  const member = unwritten.length > 0 && (await requireMember(req).then(() => true, () => false));
  for (const name of unwritten) {
    if (member && writing.length < NEW_PER_REQUEST && spend(req)) writing.push(name);
    else pending.push(name);
  }
  if (writing.length) {
    const archive = await loadArchive();
    const written = await Promise.all(
      writing.map((name) =>
        profRating(archive, index.get(foldName(name))!).catch((error: Error) => {
          console.warn('[courses] professor rating failed:', error.message);
          return undefined;
        }),
      ),
    );
    writing.forEach((name, i) => {
      const entry = written[i];
      if (entry === undefined) pending.push(name);
      else ratings[name] = publicProf(entry);
    });
  }
  return { ratings, pending };
}

/** Whether this person may have one more rating written now: a few a minute, like course ratings. */
function spend(req: ApiRequest): boolean {
  try {
    rateLimit(req, 12, 4, 'prof-rating');
    return true;
  } catch {
    return false;
  }
}

const TEACHING = /\b(?:prof|profs|professor|professors|dr|teach\w*|taught|class|classes|course|courses|lectures?|exams?|midterms?|finals?|grad(?:e|es|ed|ing)|syllabus|section|office hours)\b/;
const MAX_PROF_THREADS = 8;

/**
 * What students wrote about a professor: threads found by surname, with what they teach as context, kept only when
 * they name the surname and talk about teaching (or name the first name or one of their courses), cut down to the
 * post and the comments that mention them, with the reply after each.
 */
async function profThreads(archive: Archive, teacher: Teacher): Promise<string[]> {
  const surname = foldName(teacher.surname);
  if (surname.length < 3) return [];
  const named = new RegExp(`\\b${surname.replace(/ /g, '\\s+')}\\b`);
  const first = foldName(teacher.first).split(' ')[0] ?? '';
  const numbers = teacher.courses.map((course) => /\d{4}/.exec(course)?.[0]).filter((value): value is string => !!value);
  const title = teacher.courses[0]?.replace(/^\S+ \S+ /, '') ?? '';
  const [byName, byCourse] = await Promise.all([retrieve(archive, `professor ${teacher.surname} ${teacher.first}`, { k: 40, useDense: false }), retrieve(archive, `${teacher.surname} ${title}`, { k: 20, useDense: false })]);
  const seen = new Set<number>();
  const out: string[] = [];
  for (const hit of [...byName.hits, ...byCourse.hits]) {
    if (out.length >= MAX_PROF_THREADS) break;
    if (seen.has(hit.post)) continue;
    seen.add(hit.post);
    const post = archive.posts[hit.post]!;
    const folded = [post.text, ...post.comments.map((comment) => comment.text)].map(foldName);
    const all = folded.join(' ');
    if (!named.test(all)) continue;
    // A surname alone could be a student's: the thread has to be about teaching.
    if (!TEACHING.test(all) && !(first.length > 2 && all.includes(first)) && !numbers.some((value) => all.includes(value))) continue;
    const terms = [teacher.surname.toLowerCase(), surname];
    const lines = [`Post by ${post.author || 'a student'} on ${formatDate(post.date)}: ${named.test(folded[0]!) ? bestWindow(post.text, terms, 900) : truncate(collapseWhitespace(post.text), 400)}`];
    const shown = new Set<number>();
    post.comments.forEach((_, i) => {
      if (!named.test(folded[i + 1]!)) return;
      shown.add(i);
      if (i + 1 < post.comments.length) shown.add(i + 1);
    });
    for (const i of [...shown].sort((a, b) => a - b).slice(0, 8)) {
      const comment = post.comments[i]!;
      lines.push(`- ${comment.author || 'Someone'}${comment.date ? ` (${formatDate(comment.date)})` : ''}: ${bestWindow(comment.text, terms, 500)}`);
    }
    out.push(lines.join('\n'));
  }
  return out;
}

const PROF_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'NUMBER' },
    verdict: { type: 'STRING' },
    basis: { type: 'INTEGER' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
  },
  required: ['score', 'verdict', 'basis', 'confidence'],
};

const PROF_SYSTEM = [
  "You rate one NYU Abu Dhabi professor for students choosing classes, from what students wrote in the Room of Requirement Facebook group (the excerpts below). The excerpts were found by the professor's surname: some may be about someone else with that name, or about other professors in the same thread. Use only what is clearly about this professor's teaching.",
  'Return:',
  'score: how students rate being taught by them, 1.0 to 5.0 with one decimal: clear teaching, fair grading, a well-run class, help when students need it. Use the whole range: 4.5 and up when students praise them, 2 and below when they warn others off, 3.0 only when they are truly split.',
  'verdict: one plain sentence under 20 words on what their classes are like, as students describe them ("Clear lectures and fair exams, but the weekly problem sets take many hours.").',
  'basis: how many different students gave a first-hand account of being taught by them (count people, not threads). Questions with no answer, hearsay and their name alone count for nothing.',
  'confidence: high when several recent first-hand accounts agree, medium when there are few or older ones, low when they are thin, very old or split.',
  'Use the dates on posts and comments. State a bad teaching review directly; do not soften repeated complaints or treat an old review as current.',
  'Only teaching, grading and how they run the class, as students reported it. Nothing personal: nothing about their looks, private life or character outside class, and no rumours. No citations or thread references.',
  'Never invent anything. When the excerpts say nothing first-hand about their teaching, return basis 0.',
].join('\n');

/** A new rating, or null when students have not written enough first-hand; both are kept. Throws when the model fails. */
async function profRating(archive: Archive, teacher: Teacher): Promise<SavedProf> {
  const threads = await profThreads(archive, teacher);
  let rating: ProfRating | null = null;
  if (threads.length) {
    const gemini = geminiConfig();
    const backups = providersFromEnv();
    const result = await siteJson<Partial<ProfRating>>(gemini, backups, {
      system: PROF_SYSTEM,
      prompt: `Professor: ${teacher.name} (Albert lists "${teacher.surname}${teacher.first ? `, ${teacher.first}` : ''}"), who teaches ${teacher.courses.join('; ') || 'at NYU Abu Dhabi'}.\n\nWhat students wrote that mentions ${teacher.surname}:\n\n${threads.join('\n\n')}`,
      schema: PROF_SCHEMA,
      tier: 'main',
      temperature: 0.2,
      maxOutputTokens: 512,
      timeoutMs: 25_000,
    });
    rating = cleanProf(result, gemini?.chatModel ?? backups[0]?.models[0] ?? '');
  }
  const entry: SavedProf = rating ?? { none: true, createdAt: new Date().toISOString() };
  const key = profKey(teacher.name);
  profHot.set(key, entry);
  await boardStore()?.putSummary(key, entry).catch((error) => console.warn('[courses] could not cache the professor rating:', (error as Error).message));
  return entry;
}

function cleanProf(raw: Partial<ProfRating>, model: string): ProfRating | null {
  const basis = Math.max(0, Math.round(Number(raw.basis) || 0));
  const score = Math.round(Math.min(5, Math.max(1, Number(raw.score) || 0)) * 10) / 10;
  const verdict = collapseWhitespace(String(raw.verdict ?? '').replace(/\s*\[\d+\](?:\[\d+\])*/g, '')).slice(0, 220);
  if (basis === 0 || !Number.isFinite(score) || !verdict) return null;
  const level = String(raw.confidence ?? '').toLowerCase();
  return { score, basis, verdict, confidence: level === 'high' || level === 'low' ? level : 'medium', model, createdAt: new Date().toISOString() };
}
