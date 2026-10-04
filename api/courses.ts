/**
 * The course search: every NYU Abu Dhabi course in a term from Albert's schedule, and for one course its sections,
 * who taught it before, the bulletin entry, the group's threads about it and a cached summary of what students say.
 *
 *   GET /api/courses                               the terms, and which one is current
 *   GET /api/courses?term=Fall%202026               every course offered that term, with sections, for the list
 *   GET /api/courses?code=CS-UH%201001              one course: every term's sections and the bulletin entry
 *   GET /api/courses?code=CS-UH%201001&threads=1    the group's threads about it
 *   GET /api/courses?code=CS-UH%201001&summary=1    what students say, written once and cached (slow the first time)
 *
 * The schedule parts never touch the archive, so the list and a course open at once; threads and the summary follow.
 */
import { boardStore } from '../lib/board-store.ts';
import { courseHistory, courseRows, loadCatalog, type Catalog } from '../lib/courses.ts';
import { generateJson, geminiConfig, type GeminiConfig } from '../lib/gemini.ts';
import { ApiError, queryString, rateLimit, route, sendJson } from '../lib/http.ts';
import { normalizeCode } from '../lib/html.ts';
import { loadOfficial, type OfficialCorpus, type OfficialDoc } from '../lib/official.ts';
import { retrieve, sourcesBlock, toSourceCards } from '../lib/rag.ts';
import { rerankerFromEnv } from '../lib/rerank.ts';
import type { Hit } from '../lib/search.ts';
import { loadArchive, summarizePost, type Archive } from '../lib/store.ts';
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
    if (queryString(req, 'threads')) {
      const archive = await loadArchive();
      const hits = await courseThreads(archive, catalog, official, normalized);
      sendJson(res, 200, { threads: hits.map((hit) => summarizePost(archive.posts[hit.post]!)) }, 600);
      return;
    }
    if (queryString(req, 'summary')) {
      sendJson(res, 200, { summary: await courseSummary(await loadArchive(), official, catalog, normalized) });
      return;
    }
    sendJson(res, 200, courseDetail(official, catalog, normalized), 600);
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
    description: history?.description || (doc ? collapseWhitespace(doc.text) : ''),
    offerings: history?.offerings ?? [],
    bulletin: doc ? { url: doc.url, text: truncate(doc.text, 4000) } : null,
    current: catalog.current,
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

/* ---------- What students say ---------- */

interface CourseSummary {
  overview: string;
  facts: string[];
  students: string[];
  keepInMind: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
  createdAt: string;
  sources: Array<{ n: number; kind: string; title: string; url: string; postId?: string }>;
}

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overview: { type: 'STRING' },
    facts: { type: 'ARRAY', items: { type: 'STRING' } },
    students: { type: 'ARRAY', items: { type: 'STRING' } },
    keepInMind: { type: 'ARRAY', items: { type: 'STRING' } },
    confidence: { type: 'STRING' },
  },
  required: ['overview', 'facts', 'students', 'keepInMind', 'confidence'],
};

const SUMMARY_TTL_MS = 30 * 86_400_000;
const hot = new Map<string, CourseSummary>();

/** The cached summary when fresh, otherwise a new one from the lite model; null when there is nothing to summarise. */
async function courseSummary(archive: Archive, official: OfficialCorpus | null, catalog: Catalog, code: string): Promise<CourseSummary | null> {
  const key = `course:v2:${code}`;
  const store = boardStore();
  const cached = hot.get(key) ?? ((await store?.getSummary(key).catch(() => null))?.payload as CourseSummary | undefined);
  if (cached && Date.now() - Date.parse(cached.createdAt) < SUMMARY_TTL_MS) {
    hot.set(key, cached);
    return cached;
  }
  const cfg = geminiConfig();
  if (!cfg) return null;
  const doc = bulletinEntry(official, code);
  const history = courseHistory(catalog, code);
  const title = titleOf(catalog, official, code) || code;
  const hits = await courseThreads(archive, catalog, official, code);
  const cards = toSourceCards(archive, hits.slice(0, 6), [], doc ? 2 : 1);
  const summary = await write(cfg, archive, { title: `${code} ${title}`, doc, description: history?.description ?? '', cards });
  if (!summary) return cached ?? null;
  hot.set(key, summary);
  await store?.putSummary(key, summary).catch((error) => console.warn('[courses] could not cache the summary:', (error as Error).message));
  return summary;
}

async function write(cfg: GeminiConfig, archive: Archive, input: { title: string; doc: OfficialDoc | null; description: string; cards: ReturnType<typeof toSourceCards> }): Promise<CourseSummary | null> {
  const officialBlock = input.doc ? `[1] Bulletin entry: ${input.doc.title} · ${input.doc.url}\n${truncate(collapseWhitespace(input.doc.text), 5000)}` : '';
  const threads = input.cards.length ? sourcesBlock(archive, input.cards) : '';
  if (!threads) return null;
  try {
    const result = await generateJson<Partial<CourseSummary>>(
      cfg,
      {
        model: cfg.liteModels,
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseSchema: SUMMARY_SCHEMA,
        system: [
          'You write the "what students say" panel for one NYU Abu Dhabi course, from the numbered sources only. The schedule, credits and description are shown elsewhere; do not repeat them.',
          'overview: one or two plain sentences on what taking the course is like, according to students. Cite sources as [n] after facts.',
          'facts: up to three short bullets of rules from the bulletin entry that students trip on (prerequisites, who may take it, what it counts towards); empty if none.',
          'students: up to five short bullets of what students said: workload, exams and grading, professors, tips, how it really went. Each cites its source and gives the year when it is older than a year.',
          'keepInMind: up to two bullets: disagreements, or things that change with the professor or year.',
          'confidence: high when several recent threads agree, medium when there are few or older ones, low when they are thin or disagree.',
          'Never invent. No filler. No headings inside strings. Under 200 words in total.',
        ].join(' '),
        messages: [{ role: 'user', text: `Course: ${input.title}\n${input.description ? `Description: ${truncate(input.description, 600)}\n` : ''}\nSources:\n${[officialBlock, threads].filter(Boolean).join('\n\n')}` }],
      },
      { retries: 1, timeoutMs: 25_000 },
    );
    const list = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => collapseWhitespace(entry)).slice(0, max) : []);
    const level = String(result.confidence ?? 'medium').toLowerCase();
    return {
      overview: collapseWhitespace(String(result.overview ?? '')),
      facts: list(result.facts, 3),
      students: list(result.students, 5),
      keepInMind: list(result.keepInMind, 2),
      confidence: level === 'high' || level === 'low' ? level : 'medium',
      model: cfg.liteModel,
      createdAt: new Date().toISOString(),
      sources: [
        ...(input.doc ? [{ n: 1, kind: 'official', title: 'Bulletin entry', url: input.doc.url }] : []),
        ...input.cards.map((card) => ({ n: card.n, kind: card.kind, title: card.title || truncate(card.text, 80), url: card.url, postId: card.postId })),
      ],
    };
  } catch (error) {
    console.warn('[courses] summary failed:', (error as Error).message);
    return null;
  }
}
