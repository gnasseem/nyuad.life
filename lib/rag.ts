/**
 * Answering a question: retrieve archive threads and official pages, rerank them together with a cross-encoder, add
 * the Albert class schedule for any course or professor the question names and what the student board and the
 * announcements feed know, then stream a grounded answer that cites every claim and says how sure it is.
 */
import { searchAnnouncements, searchBoard, STANDING_LABELS, type Announcement, type Answer, type Question } from './board.ts';
import type { BoardStore } from './board-store.ts';
import { detectRedirect } from './domains.ts';
import { embedderForIndex, type Embedder } from './embeddings.ts';
import { abuDhabiDate, courseScheduleText, instructorScheduleText, loadCatalog, matchSchedule, type Catalog } from './courses.ts';
import { generateJson, generateStream, generateText, isModelUnavailable, markUnavailable, usableModels, type GeminiConfig, type Message } from './gemini.ts';
import { ApiError } from './http.ts';
import { officialCards, officialSourceBlock, retrieveOfficial, type OfficialCorpus } from './official.ts';
import { rerankerFromEnv, type Reranker } from './rerank.ts';
import { bm25Query, denseQuery, fuse, type Hit } from './search.ts';
import type { Archive } from './store.ts';
import { bestWindow, collapseWhitespace, dayNumber, formatDate, tokenize, truncate } from './text.ts';
import type { AskRequest, AskResponse, ChatTurn, Confidence, IndexedPost, SourceCard } from './types.ts';

const MAX_QUESTION_CHARS = 600;
const CANDIDATES = 40;
const RERANK_CANDIDATES = 30;
const MAX_SOURCES = 12;
const MIN_SOURCES = 4;
/**
 * Vercel stops the function at 60 seconds. Generation is cut here instead, so the answer ends with a note and a
 * proper "done" rather than mid-sentence with a dropped connection.
 */
const ANSWER_DEADLINE_MS = 54_000;

interface RetrieveOptions {
  k?: number;
  useDense?: boolean;
  filter?: (post: IndexedPost) => boolean;
  /** Overrides the embedder derived from the index (tests). */
  embedder?: Embedder | null;
}

export interface Retrieval {
  hits: Hit[];
  terms: string[];
  dense: boolean;
  /** The embedded query, when dense search ran, so callers can reuse it. */
  vector?: Float32Array;
  ms: number;
}

let warnedMissingKey = '';

/** Hybrid retrieval: BM25 over chunks plus dense search when vectors exist and the matching embedding key is set, fused by rank. */
export async function retrieve(archive: Archive, query: string, options: RetrieveOptions = {}): Promise<Retrieval> {
  const started = Date.now();
  const terms = tokenize(query);
  const depth = Math.max(150, (options.k ?? CANDIDATES) * 4);
  const lexical = bm25Query(archive.bm25, terms, depth);
  let dense: Array<{ row: number; score: number }> = [];
  let vector: Float32Array | undefined;
  if (options.useDense !== false && archive.vectors.count > 0 && archive.meta.model !== 'none') {
    const embedder = options.embedder === undefined ? embedderForIndex(archive.meta) : options.embedder;
    if (!embedder) {
      if (warnedMissingKey !== archive.meta.model) {
        warnedMissingKey = archive.meta.model;
        console.warn(`[retrieve] the index was embedded with ${archive.meta.model} but no key for that provider is set; using keywords only.`);
      }
    } else {
      try {
        [vector] = await embedder.embed([query], 'query', { retries: 1, timeoutMs: 15_000 });
        dense = denseQuery(archive.vectors, vector!, depth);
      } catch (error) {
        console.warn('[retrieve] dense search unavailable, using keywords only:', (error as Error).message);
      }
    }
  }
  let hits = fuse(lexical, dense, { dates: archive.posts.map((post) => post.date), chunkPost: archive.chunkPost });
  if (options.filter) hits = hits.filter((hit) => options.filter!(archive.posts[hit.post]!));
  return { hits: hits.slice(0, options.k ?? CANDIDATES), terms, dense: vector !== undefined, vector, ms: Date.now() - started };
}

export function toSourceCards(archive: Archive, hits: Hit[], terms: string[], startAt = 1): SourceCard[] {
  return hits.map((hit, index) => {
    const post = archive.posts[hit.post]!;
    const chunk = archive.chunks[hit.chunk]!;
    const passage = chunk.text.split('\n').slice(1).join(' ');
    return {
      n: startAt + index,
      kind: 'archive',
      postId: post.id,
      title: '',
      url: post.url,
      author: post.author,
      date: post.date,
      text: truncate(post.text, 600),
      commentCount: Math.max(post.commentCount ?? 0, post.comments.length),
      reactions: post.reactions ?? 0,
      topics: post.topics,
      courses: post.courses,
      snippet: bestWindow(passage, terms, 300),
      score: Number(hit.score.toFixed(4)),
    };
  });
}

/* ---------- Live sources: the student board and the announcements feed ---------- */

interface LiveSnapshot {
  entries: Array<{ question: Question; answers: Answer[] }>;
  announcements: Announcement[];
  fetchedAt: number;
}

let liveCache: { store: BoardStore; snapshot: Promise<LiveSnapshot> } | null = null;
const LIVE_TTL_MS = 60_000;

async function liveSnapshot(store: BoardStore): Promise<LiveSnapshot> {
  if (liveCache && liveCache.store === store) {
    const current = await liveCache.snapshot.catch(() => null);
    if (current && Date.now() - current.fetchedAt < LIVE_TTL_MS) return current;
  }
  const pending = (async (): Promise<LiveSnapshot> => {
    const [questions, announcements] = await Promise.all([store.listAnswered(300), store.listAnnouncements(new Date())]);
    const answers = await store.listAnswers(questions.map((question) => question.id));
    const byQuestion = new Map<string, Answer[]>();
    for (const answer of answers) byQuestion.set(answer.questionId, [...(byQuestion.get(answer.questionId) ?? []), answer]);
    return { entries: questions.map((question) => ({ question, answers: byQuestion.get(question.id) ?? [] })), announcements, fetchedAt: Date.now() };
  })();
  liveCache = { store, snapshot: pending };
  return pending;
}

interface LiveSource {
  card: SourceCard;
  question?: Question;
  answers?: Answer[];
  announcement?: Announcement;
  /** Pre-rendered block for an official page. */
  officialText?: string;
  /** Pre-rendered block for a course's or a professor's Albert schedule. */
  scheduleText?: string;
}

const MAX_OFFICIAL = 4;
const OFFICIAL_CANDIDATES = 8;

interface OfficialCandidates {
  corpus: OfficialCorpus;
  hits: Awaited<ReturnType<typeof retrieveOfficial>>['hits'];
  terms: string[];
}

/** Official NYUAD pages that might speak to the question, before reranking. */
async function officialCandidates(corpus: OfficialCorpus | null | undefined, query: string, vector: Float32Array | undefined): Promise<OfficialCandidates | null> {
  if (!corpus || corpus.chunks.length === 0) return null;
  try {
    const { hits, terms } = await retrieveOfficial(corpus, query, { k: OFFICIAL_CANDIDATES, vector });
    return hits.length ? { corpus, hits, terms } : null;
  } catch (error) {
    console.warn('[ask] official pages unavailable:', (error as Error).message);
    return null;
  }
}

/** Without a reranker: the pages whose fused score is close to the best one's. */
function strongOfficial(candidates: OfficialCandidates): OfficialCandidates['hits'] {
  const top = candidates.hits[0]?.score ?? 0;
  return candidates.hits.filter((hit) => hit.score >= Math.max(0.012, top * 0.45)).slice(0, MAX_OFFICIAL);
}

/** Official pages as numbered sources, ahead of everything else: they are the authority on facts. */
function officialSources(candidates: OfficialCandidates | null, hits: OfficialCandidates['hits'], startAt: number): LiveSource[] {
  if (!candidates || hits.length === 0) return [];
  const cards = officialCards(candidates.corpus, hits, candidates.terms, startAt);
  return cards.map((card, i) => ({ card, officialText: officialSourceBlock(candidates.corpus, card, candidates.corpus.chunks[hits[i]!.chunk]!.text) }));
}

/** The Albert schedule for the courses and professors the question names, as sources. */
function scheduleSources(catalog: Catalog | null, question: string, startAt: number): LiveSource[] {
  if (!catalog) return [];
  const match = matchSchedule(catalog, question);
  const out: LiveSource[] = [];
  const base = { kind: 'schedule' as const, url: '', author: 'Albert', date: catalog.scraped.slice(0, 10), commentCount: 0, reactions: 0, topics: ['courses'], snippet: '', score: 1 };
  for (const code of match.courses) {
    const text = courseScheduleText(catalog, code);
    const title = catalog.byCode.get(code)?.[0]?.title ?? code;
    if (text) out.push({ scheduleText: text, card: { ...base, n: startAt + out.length, postId: code, title: `${code} ${title}`, text: truncate(text, 600), courses: [code] } });
  }
  for (const name of match.instructors) {
    const text = instructorScheduleText(catalog, name);
    if (text) out.push({ scheduleText: text, card: { ...base, n: startAt + out.length, postId: `instructor:${name}`, title: `Classes taught by ${name}`, text: truncate(text, 600), courses: [] } });
  }
  return out;
}

/** Board answers and announcements that speak to the question, as cards numbered after the archive threads. */
async function liveSources(store: BoardStore | null, query: string, terms: string[], vector: Float32Array | undefined, startAt: number): Promise<LiveSource[]> {
  if (!store) return [];
  try {
    const snapshot = await liveSnapshot(store);
    const out: LiveSource[] = [];
    let n = startAt;
    for (const hit of searchBoard(snapshot.entries, query, vector, 3)) {
      const latest = hit.answers[hit.answers.length - 1]!;
      const text = hit.answers.map((answer) => answer.text).join('\n');
      out.push({
        question: hit.question,
        answers: hit.answers,
        card: {
          n: n++,
          kind: 'board',
          postId: hit.question.id,
          title: hit.question.summary || truncate(collapseWhitespace(hit.question.text), 90),
          url: '',
          author: hit.answers.length === 1 ? `${latest.helperName}, ${latest.helperMajor}` : `${hit.answers.length} students`,
          date: latest.createdAt.slice(0, 10),
          text: truncate(text, 600),
          commentCount: hit.answers.length,
          reactions: 0,
          topics: hit.question.topics,
          courses: hit.question.courses,
          snippet: bestWindow(text, terms, 300),
          score: Number(hit.score.toFixed(4)),
        },
      });
    }
    for (const hit of searchAnnouncements(snapshot.announcements, query, 2)) {
      const entry = hit.announcement;
      out.push({
        announcement: entry,
        card: {
          n: n++,
          kind: 'announcement',
          postId: entry.id,
          title: entry.title,
          url: entry.link,
          author: entry.posterName,
          date: (entry.startsAt ?? entry.createdAt).slice(0, 10),
          text: truncate(entry.body || entry.title, 600),
          commentCount: 0,
          reactions: 0,
          topics: [],
          courses: [],
          snippet: bestWindow(entry.body || entry.title, terms, 300),
          score: Number(hit.score.toFixed(4)),
        },
      });
    }
    return out;
  } catch (error) {
    console.warn('[ask] live sources unavailable:', (error as Error).message);
    return [];
  }
}

/* ---------- Prompting ---------- */

function age(date: string, today: number): string {
  const day = dayNumber(date);
  if (Number.isNaN(day)) return 'undated';
  const days = Math.max(0, Math.round(today - day));
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
}

/** Renders the numbered sources the model may cite: whole threads with their signals, board answers, announcements. */
export function sourcesBlock(archive: Archive, cards: SourceCard[], live: LiveSource[] = [], today = Date.now() / 86_400_000): string {
  const liveByN = new Map(live.map((entry) => [entry.card.n, entry]));
  return cards
    .map((card) => {
      const entry = liveByN.get(card.n);
      if (card.kind === 'official' && entry?.officialText) return entry.officialText;
      if (card.kind === 'schedule' && entry?.scheduleText) return `[${card.n}] ${entry.scheduleText}`;
      if (card.kind === 'board' && entry?.question) {
        const lines = entry.answers!.map((answer) => `- ${answer.helperName} (${answer.helperMajor}, ${STANDING_LABELS[answer.helperYear].toLowerCase()}, ${formatDate(answer.createdAt.slice(0, 10))}): ${truncate(collapseWhitespace(answer.text), 700)}`);
        return [`[${card.n}] Student answers on this site, to the question: "${truncate(collapseWhitespace(entry.question.text), 300)}"`, ...lines].join('\n');
      }
      if (card.kind === 'announcement' && entry?.announcement) {
        const a = entry.announcement;
        const when = a.startsAt ? `happens ${abuDhabiTime(a.startsAt)}` : `posted ${formatDate(abuDhabiDate(new Date(a.createdAt)))}`;
        return [`[${card.n}] Announcement (${a.kind}) by ${a.posterName}, ${when}${a.location ? `, at ${a.location}` : ''}: ${a.title}`, truncate(collapseWhitespace(a.body), 800), a.link ? `Link: ${a.link}` : ''].filter(Boolean).join('\n');
      }
      const post = archive.posts[archive.postPosition.get(card.postId)!]!;
      const header = `[${card.n}] Post by ${post.author || 'Unknown'} on ${formatDate(post.date)} (${age(post.date, today)}) · ${card.commentCount} comments · ${card.reactions} reactions`;
      const body = truncate(collapseWhitespace(post.text) || '(no text)', 2200);
      let budget = 4200 - header.length - body.length;
      const comments: string[] = [];
      for (const comment of post.comments) {
        const line = `- ${comment.author || 'Someone'}${comment.date ? ` (${formatDate(comment.date)})` : ''}: ${truncate(collapseWhitespace(comment.text), 500)}`;
        if (line.length + 1 > budget) {
          comments.push(`- (${post.comments.length - comments.length} more comments not shown)`);
          break;
        }
        comments.push(line);
        budget -= line.length + 1;
      }
      return [header, body, comments.length ? 'Comments:' : '', ...comments].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/** An instant as Abu Dhabi reads it: "Thu 9 Oct 2026, 19:30". */
function abuDhabiTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const GLOSSARY =
  'NYUAD shorthand: Falcons or Falcon Dirhams = the NYUAD Personal Support award students spend on campus (at the bookstore and elsewhere), traded between students in the thousands; ' +
  'Campus Dirhams = the meal-plan money deposited every two weeks and spent at dining venues such as the Library Cafe and the Marketplace, a separate balance from Falcons and often sold at about half price; ' +
  'meal swipes = full meals in the dining halls; D1 and D2 = the dining halls; A1 to A6 = residential buildings; core = Core Curriculum; ' +
  'J-Term = January term; seven-week courses run in the first or second half of a term; SIG = student interest group; CDC = Career Development Center; capstone = the senior-year project; ' +
  'Albert = NYU\'s registration system; ROR = the Room of Requirement Facebook group.';

export function systemPrompt(today = new Date(), term = ''): string {
  const date = abuDhabiDate(today);
  const weekday = today.toLocaleDateString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'long' });
  return `You answer questions from NYU Abu Dhabi students using only the numbered sources you are given: official NYUAD pages (the university website, the student portal and the bulletin), the Albert class schedule, threads from the Room of Requirement Facebook group, answers other students wrote on this site, and current announcements. Today is ${date}, a ${weekday}, in Abu Dhabi${term ? `; the term now is ${term}` : ''}.

Which source to trust for what:
- The Albert class schedule is the authority on which courses run in which term, their times, rooms, professors, credits and whether seats are open.
- Official pages are the authority on requirements, deadlines, policies, programme structure and what an office does.
- Student threads and answers are the authority on experience: what a course or professor is like, workload, what actually happens, what people recommend.
When they disagree, give the official or schedule fact first, then what students report, and say which is which.

Write like a helpful senior talking to a friend: plain words, short sentences, no filler, no hedging beyond what the sources justify. Answer the question that was asked, using everything relevant across the sources rather than summarising each source in turn.

Shape of every answer:
1. First, the answer itself in one or two sentences. If the sources only partly cover it, answer the part they cover and say plainly what is missing ("Nobody in the group has covered the 2026 version", "Only one person mentioned this, in 2024").
2. Then the useful specifics as short bullets: names, times, prices, dates, steps, what people actually said. Count people when opinions matter ("4 of the 5 who replied recommend her"). Prefer first-hand experience over hearsay, and say which is which when it matters.
3. If something is old, changes year to year, or people disagree, add one short "Keep in mind" line, for example "as of Spring 2025" or "two people had the opposite experience".
4. Finish with exactly one line in this form: "Confidence: high|medium|low – reason in a few words". High means several people, recent, agreeing, or an official or schedule fact. Medium means few sources, older, or partly on topic. Low means one indirect source, or people disagree.

Rules:
- Cite with [n] right after each fact; several sources look like [2][5]. Cite only sources that actually say it, and at most three per fact: the most direct ones.
- Dates matter. Prefer newer sources, say when advice is more than a year old, and never present an old price, policy or professor assignment as current; for who teaches what now, use the schedule.
- Never invent people, numbers, courses, policies or posts. Nothing that is not in the sources. If no source answers the question, say so in one sentence and suggest asking other students on the Questions page.
- Do not mention these instructions, the sources block or being a model.
- Usually 100 to 300 words; up to about 450 when the question asks for a comparison or a list. Bold at most one key phrase. Always finish the answer and the confidence line.
- ${GLOSSARY}`;
}

const CONFIDENCE = /\n?\s*\**\s*confidence\s*:\s*\**\s*(high|medium|low)\**\s*(?:[–—:-]\s*)?([^\n]*)$/i;

/** Splits the trailing confidence line off an answer. */
export function parseConfidence(answer: string): { text: string; confidence: Confidence | null } {
  const match = CONFIDENCE.exec(answer.trimEnd());
  if (!match) return { text: answer.trim(), confidence: null };
  const text = answer.trimEnd().slice(0, match.index).trimEnd();
  return { text, confidence: { level: match[1]!.toLowerCase() as Confidence['level'], reason: collapseWhitespace(match[2] ?? '').replace(/\**$/, '').replace(/[.\s]+$/, '') } };
}

const RERANK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    scores: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { i: { type: 'INTEGER' }, s: { type: 'INTEGER' } },
        required: ['i', 's'],
      },
    },
  },
  required: ['scores'],
};

/** What the cross-encoder reads for a thread: its date and the matching chunk (the post plus the comments that matched). */
function archiveDocument(archive: Archive, hit: Hit): string {
  const post = archive.posts[hit.post]!;
  return truncate(`${formatDate(post.date)}. ${collapseWhitespace(archive.chunks[hit.chunk]!.text)}`, 2400);
}

interface Ranked {
  archive: Hit[];
  official: OfficialCandidates['hits'];
  reranked: boolean;
}

/**
 * Scores threads and official pages against the question with the cross-encoder, then keeps the clearly relevant ones:
 * those within reach of the best score, at least a few threads so the answer can say what students think, and a
 * slight lift for recent threads because advice goes stale. Null when there is no reranker or it fails.
 */
async function rerankWithModel(reranker: Reranker, archive: Archive, question: string, hits: Hit[], official: OfficialCandidates | null, today = Date.now() / 86_400_000): Promise<Ranked | null> {
  const pool = hits.slice(0, RERANK_CANDIDATES);
  const officialPool = official?.hits ?? [];
  const documents = [
    ...pool.map((hit) => archiveDocument(archive, hit)),
    ...officialPool.map((hit) => truncate(collapseWhitespace(official!.corpus.chunks[hit.chunk]!.text), 2400)),
  ];
  if (documents.length === 0) return { archive: [], official: [], reranked: false };
  try {
    const scores = await reranker.rerank(question, documents, { timeoutMs: 10_000 });
    const best = Math.max(...scores);
    const floor = Math.max(0.25, best * 0.6);
    const archiveScored = pool
      .map((hit, i) => {
        const age = today - dayNumber(archive.posts[hit.post]!.date);
        const recency = Number.isNaN(age) ? 0.2 : Math.exp(-Math.max(0, age) / 730);
        return { hit: { ...hit, score: scores[i]! + 0.04 * recency }, relevance: scores[i]! };
      })
      .sort((a, b) => b.hit.score - a.hit.score);
    const strong = archiveScored.filter((entry) => entry.relevance >= floor).map((entry) => entry.hit);
    const chosen = strong.length >= MIN_SOURCES ? strong.slice(0, MAX_SOURCES) : archiveScored.slice(0, MIN_SOURCES).map((entry) => entry.hit);
    const officialChosen = officialPool
      .map((hit, i) => ({ hit: { ...hit, score: scores[pool.length + i]! }, relevance: scores[pool.length + i]! }))
      .filter((entry) => entry.relevance >= Math.max(0.4, floor))
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_OFFICIAL)
      .map((entry) => entry.hit);
    return { archive: chosen, official: officialChosen, reranked: true };
  } catch (error) {
    console.warn(`[rerank] ${reranker.name} unavailable, falling back:`, (error as Error).message);
    return null;
  }
}

/** Without a cross-encoder: the lite model scores thread snippets 0–10. Null when that fails too. */
async function rerankWithLite(cfg: GeminiConfig, archive: Archive, question: string, hits: Hit[], terms: string[]): Promise<Hit[] | null> {
  if (hits.length <= MIN_SOURCES) return hits;
  const pool = hits.slice(0, RERANK_CANDIDATES);
  const candidates = pool.map((hit, i) => {
    const post = archive.posts[hit.post]!;
    const chunk = archive.chunks[hit.chunk]!;
    const passage = bestWindow(chunk.text.split('\n').slice(1).join(' '), terms, 500);
    return `[${i}] ${formatDate(post.date)} · ${Math.max(post.commentCount ?? 0, post.comments.length)} comments · ${post.author}: ${passage}`;
  });
  try {
    const result = await generateJson<{ scores: Array<{ i: number; s: number }> }>(
      cfg,
      {
        model: cfg.liteModels,
        temperature: 0,
        maxOutputTokens: 2048,
        responseSchema: RERANK_SCHEMA,
        system:
          'You rank forum threads for a student Q&A search. Score each candidate from 0 (unrelated) to 10 (answers the question directly with specifics). ' +
          'Threads that merely share a keyword score low; first-hand experience, concrete advice, prices, names and numbers relevant to the question score high. ' +
          'Among equally relevant threads prefer the more recent and the more discussed. Return every index exactly once.',
        messages: [{ role: 'user', text: `Question: ${question}\n\nCandidates:\n${candidates.join('\n')}` }],
      },
      { retries: 1, timeoutMs: 12_000 },
    );
    const scores = new Map<number, number>();
    for (const entry of result.scores ?? []) {
      if (Number.isInteger(entry.i) && entry.i >= 0 && entry.i < pool.length) scores.set(entry.i, Math.max(0, Math.min(10, entry.s)));
    }
    if (scores.size < pool.length / 2) return null;
    const maxFused = Math.max(...pool.map((hit) => hit.score)) || 1;
    const rescored = pool.map((hit, i) => {
      const llm = scores.get(i) ?? 2;
      return { hit: { ...hit, score: 0.7 * (llm / 10) + 0.3 * (hit.score / maxFused) }, llm };
    });
    rescored.sort((a, b) => b.hit.score - a.hit.score);
    const strong = rescored.filter((entry) => entry.llm >= 4).map((entry) => entry.hit);
    if (strong.length >= MIN_SOURCES) return strong.slice(0, MAX_SOURCES);
    return rescored.slice(0, Math.max(MIN_SOURCES, strong.length)).map((entry) => entry.hit);
  } catch (error) {
    console.warn('[rerank] falling back to hybrid order:', (error as Error).message);
    return null;
  }
}

/** The cross-encoder when there is one, else the lite model for threads and fused scores for official pages. */
async function rank(cfg: GeminiConfig, archive: Archive, question: string, retrieval: Retrieval, official: OfficialCandidates | null, reranker: Reranker | null): Promise<Ranked> {
  if (reranker) {
    const ranked = await rerankWithModel(reranker, archive, question, retrieval.hits, official);
    if (ranked) return ranked;
  }
  const officialHits = official ? strongOfficial(official) : [];
  if (retrieval.hits.length === 0) return { archive: [], official: officialHits, reranked: false };
  const lite = await rerankWithLite(cfg, archive, question, retrieval.hits, retrieval.terms);
  return { archive: (lite ?? retrieval.hits.slice(0, 10)).slice(0, MAX_SOURCES), official: officialHits, reranked: lite !== null };
}

/** Turns a follow-up like "and what about his grading?" into a standalone search query. */
async function standaloneQuestion(cfg: GeminiConfig, history: ChatTurn[], question: string): Promise<string> {
  if (history.length === 0) return question;
  const transcript = history
    .slice(-6)
    .map((turn) => `${turn.role === 'user' ? 'Student' : 'Assistant'}: ${truncate(collapseWhitespace(turn.content), 700)}`)
    .join('\n');
  try {
    const result = await generateText(
      cfg,
      {
        model: cfg.liteModels,
        temperature: 0,
        maxOutputTokens: 512,
        system:
          "Rewrite the student's latest message as one standalone search query that keeps every name, course code and detail it refers to from the conversation. " +
          'Output only the query, no quotes or explanation. If it is already standalone, return it unchanged. ' +
          GLOSSARY,
        messages: [{ role: 'user', text: `Conversation:\n${transcript}\n\nLatest message: ${question}` }],
      },
      { retries: 1, timeoutMs: 8_000 },
    );
    const rewritten = collapseWhitespace(result.text).replace(/^["“]|["”]$/g, '');
    return rewritten && rewritten.length <= MAX_QUESTION_CHARS ? rewritten : question;
  } catch {
    return question;
  }
}

const FOLLOWUP_SCHEMA = {
  type: 'OBJECT',
  properties: { questions: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['questions'],
};

export async function followups(cfg: GeminiConfig, question: string, cards: SourceCard[]): Promise<string[]> {
  if (cards.length === 0) return [];
  const context = cards
    .slice(0, 8)
    .map((card) => `- ${card.title ? `${card.title}: ` : ''}${truncate(card.text, 160)}`)
    .join('\n');
  try {
    const result = await generateJson<{ questions: string[] }>(
      cfg,
      {
        model: cfg.liteModels,
        temperature: 0.7,
        maxOutputTokens: 1024,
        responseSchema: FOLLOWUP_SCHEMA,
        system:
          'Suggest exactly three short follow-up questions (under 12 words each) that an NYU Abu Dhabi student would naturally ask next, each answerable from the sources summarised. Vary the angle: one deeper on the same topic, one comparison, one practical next step. No numbering. ' +
          GLOSSARY,
        messages: [{ role: 'user', text: `Question asked: ${question}\n\nPosts found:\n${context}` }],
      },
      { retries: 0, timeoutMs: 12_000 },
    );
    return (result.questions ?? []).map((item) => collapseWhitespace(item)).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

interface AskEvents {
  status?(message: string): void;
  redirect?(redirect: NonNullable<AskResponse['redirect']>): void;
  sources?(cards: SourceCard[]): void;
  delta?(text: string): void;
  followups?(questions: string[]): void;
}

export function validateAsk(body: Partial<AskRequest>): AskRequest {
  const question = collapseWhitespace(String(body.question ?? ''));
  if (!question) throw new ApiError(400, 'The question is empty.', 'empty_question');
  if (question.length > MAX_QUESTION_CHARS) throw new ApiError(400, `Keep questions under ${MAX_QUESTION_CHARS} characters.`, 'question_too_long');
  const history = Array.isArray(body.history)
    ? body.history
        .filter((turn): turn is ChatTurn => !!turn && (turn.role === 'user' || turn.role === 'model') && typeof turn.content === 'string')
        .slice(-8)
        .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 4000) }))
    : [];
  return { question, history, stream: body.stream !== false };
}

interface AskContext {
  board?: BoardStore | null;
  official?: OfficialCorpus | null;
  /** The Albert class schedule; loaded from data/classes.jsonl when not given. Null switches it off. */
  catalog?: Catalog | null;
  /** The cross-encoder; taken from the environment when not given. Null switches it off. */
  reranker?: Reranker | null;
  /** When to stop writing, in ms since the epoch; defaults to ANSWER_DEADLINE_MS after the call starts. */
  deadline?: number;
}

function catalogOrNull(): Catalog | null {
  try {
    const catalog = loadCatalog();
    return catalog.byCode.size ? catalog : null;
  } catch (error) {
    console.warn('[ask] the class schedule could not be loaded:', (error as Error).message);
    return null;
  }
}

/** The full pipeline. Emits sources first, then answer deltas, then follow-ups; also returns everything at the end. */
export async function ask(archive: Archive, cfg: GeminiConfig, request: AskRequest, events: AskEvents = {}, signal?: AbortSignal, context: AskContext = {}): Promise<AskResponse> {
  const started = Date.now();
  const deadline = context.deadline ?? started + ANSWER_DEADLINE_MS;
  const history = request.history ?? [];
  const board = context.board ?? null;
  const catalog = context.catalog === undefined ? catalogOrNull() : context.catalog;
  const reranker = context.reranker === undefined ? rerankerFromEnv() : context.reranker;

  const redirect = history.length === 0 ? detectRedirect(request.question) : null;
  if (redirect) {
    events.redirect?.(redirect);
    events.sources?.([]);
    events.followups?.([]);
    return { answer: '', sources: [], followups: [], model: cfg.chatModel, confidence: null, redirect, retrieval: { candidates: 0, reranked: false, ms: Date.now() - started } };
  }

  events.status?.('Reading the question');
  const searchQuery = await standaloneQuestion(cfg, history, request.question);

  events.status?.('Searching');
  const retrieval = await retrieve(archive, searchQuery, { k: CANDIDATES });
  const officialPool = await officialCandidates(context.official, searchQuery, retrieval.vector);
  const ranked = retrieval.hits.length || officialPool ? await withStatus(events, 'Ranking sources', rank(cfg, archive, searchQuery, retrieval, officialPool, reranker)) : { archive: [], official: [], reranked: false };
  const official = officialSources(officialPool, ranked.official, 1);
  // The schedule is matched on the student's own words as well as the rewrite, which may drop a code they typed.
  const schedule = scheduleSources(catalog, `${request.question}\n${searchQuery}`, official.length + 1);
  const archiveCards = toSourceCards(archive, ranked.archive, retrieval.terms, official.length + schedule.length + 1);
  const live = await liveSources(board, searchQuery, retrieval.terms, retrieval.vector, official.length + schedule.length + archiveCards.length + 1);
  const cards = [...official.map((entry) => entry.card), ...schedule.map((entry) => entry.card), ...archiveCards, ...live.map((entry) => entry.card)];
  events.sources?.(cards);

  if (cards.length === 0) {
    const answer = 'No source covers this. Ask students on the Questions page.';
    events.delta?.(answer);
    events.followups?.([]);
    return { answer, sources: [], followups: [], model: cfg.chatModel, confidence: { level: 'low', reason: 'no matching threads' }, retrieval: { candidates: 0, reranked: false, ms: Date.now() - started } };
  }

  const followupsPromise = followups(cfg, request.question, cards).then((questions) => {
    events.followups?.(questions);
    return questions;
  });

  events.status?.('Writing');
  const messages: Message[] = history.slice(-6).map((turn) => ({ role: turn.role, text: truncate(turn.content, 2500) }));
  messages.push({ role: 'user', text: `Question: ${request.question}\n\nSources:\n${sourcesBlock(archive, cards, [...official, ...schedule, ...live])}` });
  const { answer, model, truncated } = await writeAnswer(cfg, messages, events, signal, deadline, catalog?.current ?? '');
  if (!answer.trim()) throw new ApiError(502, 'The model returned an empty answer.', 'empty_answer');
  const questions = await followupsPromise;
  const parsed = parseConfidence(answer);
  return {
    answer: parsed.text,
    sources: cards,
    followups: questions,
    model,
    confidence: parsed.confidence,
    ...(truncated ? { truncated: true } : {}),
    retrieval: { candidates: retrieval.hits.length, reranked: ranked.reranked, ms: Date.now() - started },
  };
}

async function withStatus<T>(events: AskEvents, message: string, work: Promise<T>): Promise<T> {
  events.status?.(message);
  return work;
}

const QUOTA_MESSAGE = 'Answers are paused: the free model quota is used up for now. Try again in a while, or search the threads in the meantime.';

/**
 * Streams the answer, moving down the model list when a model is gone or out of quota (free tiers are per model and
 * reset daily). Only switches before any text has been sent. Stops at the deadline, or when the model hits its token
 * limit, and says so rather than ending mid-sentence without a word.
 */
async function writeAnswer(cfg: GeminiConfig, messages: Message[], events: AskEvents, signal: AbortSignal | undefined, deadline: number, term: string): Promise<{ answer: string; model: string; truncated: boolean }> {
  const models = usableModels([cfg.chatModel, ...cfg.chatFallbacks]);
  const system = systemPrompt(new Date(), term);
  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    const last = i === models.length - 1;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1_000, deadline - Date.now()));
    let answer = '';
    let truncated = false;
    try {
      for await (const event of generateStream(cfg, { model, system, messages, temperature: 0.2, maxOutputTokens: 8192, thinking: 'low' }, { retries: last ? 1 : 0, signal: controller.signal, waitOutQuota: false })) {
        if (event.text) {
          answer += event.text;
          events.delta?.(event.text);
        }
        if (event.finishReason === 'MAX_TOKENS') truncated = true;
        else if (event.finishReason && event.finishReason !== 'STOP') console.warn('[ask] generation finished with', event.finishReason);
      }
      return { answer, model, truncated };
    } catch (error) {
      if (timedOut && !signal?.aborted) {
        console.warn(`[ask] ${model} ran past the deadline; ending the answer early.`);
        if (answer) return { answer, model, truncated: true };
        throw new ApiError(504, 'The answer took too long. Try again, or ask a narrower question.', 'timeout');
      }
      if (!isModelUnavailable(error) || answer) throw error;
      markUnavailable(model, error);
      if (last) throw new ApiError(503, QUOTA_MESSAGE, 'quota');
      console.warn(`[ask] ${model} unavailable (${error.message.slice(0, 100)}); trying ${models[i + 1]}.`);
      events.status?.('Switching to a backup model');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new ApiError(503, QUOTA_MESSAGE, 'quota');
}
