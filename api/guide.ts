/**
 * The guide: official NYUAD pages by section, every course the archive or the bulletin knows, and for any of them a
 * cached summary written from the official text plus what students said in the group.
 *
 *   GET /api/guide                          sections with counts, and whether official pages exist at all
 *   GET /api/guide?section=majors           the pages in a section
 *   GET /api/guide?section=courses[&q=]     courses, from the bulletin and from course codes mentioned in the group
 *   GET /api/guide?item=<id>                one official page, its neighbours, related threads and the summary
 *   GET /api/guide?course=CS-UH%201001      the same for a course
 */
import { boardStore } from '../lib/board-store.ts';
import { generateJson, geminiConfig, type GeminiConfig } from '../lib/gemini.ts';
import { ApiError, queryString, rateLimit, route, sendJson } from '../lib/http.ts';
import { normalizeCode } from '../lib/html.ts';
import { loadOfficial, OFFICIAL_SECTIONS, retrieveOfficial, SECTION_LABELS, type OfficialCorpus, type OfficialDoc, type OfficialSection } from '../lib/official.ts';
import { retrieve, sourcesBlock, toSourceCards } from '../lib/rag.ts';
import { loadArchive, summarizePost, type Archive } from '../lib/store.ts';
import { collapseWhitespace, truncate } from '../lib/text.ts';

export const config = { maxDuration: 60 };

/** Sections shown in the guide, in order. Faculty profiles and "other" stay out of the lists but still feed answers. */
const GUIDE_SECTIONS: OfficialSection[] = ['courses', 'majors', 'minors', 'core', 'study-away', 'academics', 'housing', 'money', 'visa', 'health', 'careers', 'research', 'campus', 'admissions', 'policies'];

export default route(['GET'], async (req, res) => {
  rateLimit(req, 60, 40, 'guide');
  const [archive, official] = await Promise.all([loadArchive(), loadOfficial()]);
  const section = queryString(req, 'section').trim() as OfficialSection | '';
  const item = queryString(req, 'item').trim();
  const course = queryString(req, 'course').trim();

  if (course) {
    sendJson(res, 200, await courseDetail(archive, official, normalizeCode(course)));
    return;
  }
  if (item) {
    const position = official.docPosition.get(item);
    if (position === undefined) throw new ApiError(404, 'No page with that id.', 'not_found');
    sendJson(res, 200, await pageDetail(archive, official, official.docs[position]!));
    return;
  }
  if (section === 'courses') {
    sendJson(res, 200, { section, items: courseList(archive, official, queryString(req, 'q').trim()) }, 300);
    return;
  }
  if (section) {
    if (!OFFICIAL_SECTIONS.includes(section)) throw new ApiError(404, 'No such section.', 'not_found');
    const docs = (official.bySection.get(section) ?? []).map((position) => official.docs[position]!);
    sendJson(res, 200, { section, label: SECTION_LABELS[section], items: listItems(docs) }, 300);
    return;
  }
  const sections = GUIDE_SECTIONS.map((id) => ({ id, label: SECTION_LABELS[id], count: id === 'courses' ? courseList(archive, official, '').length : (official.bySection.get(id) ?? []).length }));
  sendJson(res, 200, { official: { available: official.docs.length > 0, pages: official.docs.length, fetchedAt: official.meta.newestPost }, sections }, 300);
});

/**
 * A section's pages for the list. Many programme pages share a title ("Courses", "Learning Outcomes"), so those carry
 * the page they sit under, and the list is ordered so each programme's pages follow it.
 */
function listItems(docs: OfficialDoc[]) {
  const titles = new Map<string, number>();
  for (const doc of docs) titles.set(doc.title, (titles.get(doc.title) ?? 0) + 1);
  return docs
    .map((doc) => ({ id: doc.id, title: doc.title, url: doc.url, parent: titles.get(doc.title)! > 1 ? doc.breadcrumbs.filter((crumb) => crumb !== doc.title && crumb !== 'Home').at(-1) ?? '' : '' }))
    .sort((a, b) => (a.parent || a.title).localeCompare(b.parent || b.title) || Number(Boolean(a.parent)) - Number(Boolean(b.parent)) || a.title.localeCompare(b.title));
}

interface CourseItem {
  code: string;
  title: string;
  department: string;
  credits?: number;
  threads: number;
  official: boolean;
}

/** Every course code known: bulletin entries first, then codes students mentioned that the bulletin has not covered. */
function courseList(archive: Archive, official: OfficialCorpus, q: string): CourseItem[] {
  const items = new Map<string, CourseItem>();
  for (const [code, position] of official.byCode) {
    const doc = official.docs[position]!;
    items.set(code, { code, title: doc.title.replace(code, '').trim(), department: code.split('-')[0]!, credits: doc.credits, threads: archive.byCourse.get(code)?.length ?? 0, official: true });
  }
  for (const [code, positions] of archive.byCourse) {
    if (!items.has(code)) items.set(code, { code, title: '', department: code.split('-')[0]!, threads: positions.length, official: false });
  }
  const needle = q.toLowerCase();
  return [...items.values()]
    .filter((item) => !needle || item.code.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/* ---------- Details ---------- */

export interface GuideSummary {
  overview: string;
  facts: string[];
  students: string[];
  keepInMind: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
  createdAt: string;
  /** Source numbers refer to the `sources` list returned with the detail. */
}

async function courseDetail(archive: Archive, official: OfficialCorpus, code: string) {
  const position = official.byCode.get(code);
  const doc = position === undefined ? null : official.docs[position]!;
  const threadPositions = archive.byCourse.get(code) ?? [];
  if (!doc && threadPositions.length === 0) throw new ApiError(404, 'No information about that course.', 'not_found');
  const query = doc ? `${code} ${doc.title}` : `${code} course`;
  const retrieval = await retrieve(archive, query, { k: 8, filter: (post) => post.courses.includes(code) });
  const hits = retrieval.hits.length ? retrieval.hits : threadPositions.slice(0, 6).map((post) => ({ post, chunk: archive.postChunk[post]!, score: 0 }));
  const cards = toSourceCards(archive, hits.slice(0, 6), retrieval.terms, doc ? 2 : 1);
  const summary = await summarize(archive, official, { key: `course:${code}`, title: doc?.title ?? code, kind: 'course', doc, cards, freshness: doc?.fetchedAt });
  return {
    kind: 'course',
    id: code,
    code,
    title: doc?.title ?? code,
    section: 'courses',
    official: doc ? { url: doc.url, text: truncate(doc.text, 4000), fetchedAt: doc.fetchedAt, credits: doc.credits } : null,
    threads: hits.slice(0, 6).map((hit) => summarizePost(archive.posts[hit.post]!)),
    threadCount: threadPositions.length,
    sources: [...(doc ? [{ n: 1, kind: 'official', title: doc.title, url: doc.url }] : []), ...cards.map((card) => ({ n: card.n, kind: card.kind, title: card.title || truncate(card.text, 80), url: card.url, postId: card.postId }))],
    summary,
  };
}

async function pageDetail(archive: Archive, official: OfficialCorpus, doc: OfficialDoc) {
  const retrieval = await retrieve(archive, `${doc.title} ${truncate(doc.text, 200)}`, { k: 6 });
  const cards = toSourceCards(archive, retrieval.hits.slice(0, 5), retrieval.terms, 2);
  const siblings = (official.bySection.get(doc.section) ?? []).map((position) => official.docs[position]!).filter((other) => other.id !== doc.id);
  const related = await retrieveOfficial(official, doc.title, { k: 6, section: doc.section }).then(({ hits }) => hits.map((hit) => official.docs[hit.doc]!).filter((other) => other.id !== doc.id).slice(0, 5)).catch(() => siblings.slice(0, 5));
  const summary = await summarize(archive, official, { key: `page:${doc.id}`, title: doc.title, kind: 'page', doc, cards, freshness: doc.fetchedAt });
  return {
    kind: 'page',
    id: doc.id,
    title: doc.title,
    section: doc.section,
    breadcrumbs: doc.breadcrumbs,
    official: { url: doc.url, text: truncate(doc.text, 6000), fetchedAt: doc.fetchedAt },
    threads: retrieval.hits.slice(0, 5).map((hit) => summarizePost(archive.posts[hit.post]!)),
    threadCount: retrieval.hits.length,
    related: related.map((other) => ({ id: other.id, title: other.title })),
    sources: [{ n: 1, kind: 'official', title: doc.title, url: doc.url }, ...cards.map((card) => ({ n: card.n, kind: card.kind, title: card.title || truncate(card.text, 80), url: card.url, postId: card.postId }))],
    summary,
  };
}

/* ---------- Summaries ---------- */

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
const hot = new Map<string, GuideSummary>();

interface SummaryInput {
  key: string;
  title: string;
  kind: 'course' | 'page';
  doc: OfficialDoc | null;
  cards: ReturnType<typeof toSourceCards>;
  freshness?: string;
}

/** The cached entry when fresh, otherwise a new one from the lite model; null when no model key is set. */
async function summarize(archive: Archive, official: OfficialCorpus, input: SummaryInput): Promise<GuideSummary | null> {
  const store = boardStore();
  const cached = hot.get(input.key) ?? ((await store?.getSummary(input.key).catch(() => null))?.payload as GuideSummary | undefined);
  if (cached && Date.now() - Date.parse(cached.createdAt) < SUMMARY_TTL_MS && (!input.freshness || cached.createdAt >= input.freshness)) {
    hot.set(input.key, cached);
    return cached;
  }
  const cfg = geminiConfig();
  if (!cfg) return null;
  const summary = await write(cfg, archive, input);
  if (!summary) return cached ?? null;
  hot.set(input.key, summary);
  await store?.putSummary(input.key, summary).catch((error) => console.warn('[guide] could not cache the summary:', (error as Error).message));
  return summary;
}

async function write(cfg: GeminiConfig, archive: Archive, input: SummaryInput): Promise<GuideSummary | null> {
  const officialBlock = input.doc ? `[1] Official NYUAD page: ${input.doc.title} · ${input.doc.url}\n${truncate(collapseWhitespace(input.doc.text), 7000)}` : '';
  const threads = input.cards.length ? sourcesBlock(archive, input.cards) : '';
  if (!officialBlock && !threads) return null;
  try {
    const result = await generateJson<Partial<GuideSummary>>(
      cfg,
      {
        model: cfg.liteModel,
        temperature: 0.2,
        maxOutputTokens: 900,
        responseSchema: SUMMARY_SCHEMA,
        system: [
          `You write the guide entry for one ${input.kind === 'course' ? 'course' : 'topic'} at NYU Abu Dhabi, for students, from the numbered sources only.`,
          'overview: two or three plain sentences saying what it is and who it is for. Cite sources as [n] after facts.',
          'facts: up to six short bullets of hard facts from the official source (requirements, credits, prerequisites, deadlines, who to contact); empty if there is no official source.',
          'students: up to five short bullets of what students said in the group (workload, professors, tips, prices, how it really went), each citing its source; empty if none.',
          'keepInMind: up to three bullets: old advice, disagreements, things that change year to year. Give the year when a thread is old.',
          'confidence: high when the official page and several recent threads agree, medium when only one side exists, low when sources are thin or old.',
          'Never invent. No filler. No headings inside strings. Under 250 words in total.',
        ].join(' '),
        messages: [{ role: 'user', text: `Entry: ${input.title}\n\nSources:\n${[officialBlock, threads].filter(Boolean).join('\n\n')}` }],
      },
      { retries: 1, timeoutMs: 25_000 },
    );
    const list = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => collapseWhitespace(entry)).slice(0, max) : []);
    const level = String(result.confidence ?? 'medium').toLowerCase();
    return {
      overview: collapseWhitespace(String(result.overview ?? '')),
      facts: list(result.facts, 6),
      students: list(result.students, 5),
      keepInMind: list(result.keepInMind, 3),
      confidence: level === 'high' || level === 'low' ? level : 'medium',
      model: cfg.liteModel,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn('[guide] summary failed:', (error as Error).message);
    return null;
  }
}
