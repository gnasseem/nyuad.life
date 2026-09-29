/** Retrieval-augmented answering over the archive: retrieve, optionally rerank with Gemini, then stream a grounded answer. */
import { embedQuery, generateJson, generateStream, generateText, type GeminiConfig, type Message } from './gemini.ts';
import { ApiError } from './http.ts';
import { bm25Query, denseQuery, fuse, type Hit } from './search.ts';
import type { Archive } from './store.ts';
import { bestWindow, collapseWhitespace, formatDate, tokenize, truncate } from './text.ts';
import type { AskRequest, AskResponse, ChatTurn, IndexedPost, SourceCard } from './types.ts';

export const MAX_QUESTION_CHARS = 600;
const CANDIDATES = 40;
const MAX_SOURCES = 16;
const MIN_SOURCES = 6;

export interface RetrieveOptions {
  k?: number;
  useDense?: boolean;
  filter?: (post: IndexedPost) => boolean;
}

export interface Retrieval {
  hits: Hit[];
  terms: string[];
  dense: boolean;
  ms: number;
}

/** Hybrid retrieval: BM25 over chunks plus Gemini dense search when vectors exist, fused by rank. */
export async function retrieve(archive: Archive, cfg: GeminiConfig | null, query: string, options: RetrieveOptions = {}): Promise<Retrieval> {
  const started = Date.now();
  const terms = tokenize(query);
  const depth = Math.max(150, (options.k ?? CANDIDATES) * 4);
  const lexical = bm25Query(archive.bm25, terms, depth);
  let dense: Array<{ row: number; score: number }> = [];
  let usedDense = false;
  if (cfg && options.useDense !== false && archive.vectors.count > 0 && archive.meta.model !== 'none') {
    try {
      const vector = await embedQuery({ ...cfg, embedModel: archive.meta.model, dimensions: archive.meta.dimensions }, query, {
        retries: 1,
        timeoutMs: 15_000,
      });
      dense = denseQuery(archive.vectors, vector, depth);
      usedDense = true;
    } catch (error) {
      console.warn('[retrieve] dense search unavailable, using keywords only:', (error as Error).message);
    }
  }
  let hits = fuse(lexical, dense, { dates: archive.posts.map((post) => post.date), chunkPost: archive.chunkPost });
  if (options.filter) hits = hits.filter((hit) => options.filter!(archive.posts[hit.post]!));
  return { hits: hits.slice(0, options.k ?? CANDIDATES), terms, dense: usedDense, ms: Date.now() - started };
}

export function toSourceCards(archive: Archive, hits: Hit[], terms: string[]): SourceCard[] {
  return hits.map((hit, index) => {
    const post = archive.posts[hit.post]!;
    const chunk = archive.chunks[hit.chunk]!;
    const passage = chunk.text.split('\n').slice(1).join(' ');
    return {
      n: index + 1,
      postId: post.id,
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

/** Renders the numbered sources the model may cite. Whole threads, capped, so the answer can count opinions. */
export function sourcesBlock(archive: Archive, cards: SourceCard[]): string {
  return cards
    .map((card) => {
      const post = archive.posts[archive.postPosition.get(card.postId)!]!;
      const header = `[${card.n}] Post by ${post.author || 'Unknown'} on ${formatDate(post.date)} · ${card.commentCount} comments · ${card.reactions} reactions`;
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

export function systemPrompt(today = new Date()): string {
  return `You are ROR Answers, a study buddy for NYU Abu Dhabi students. You answer ONLY from the Room of Requirement (ROR) Facebook group posts and comments given to you as numbered sources [n]. Today is ${today.toISOString().slice(0, 10)}.

How to answer:
- Start with a direct answer in one or two sentences.
- Then give the specifics in short Markdown bullets: what people actually said, practical tips, caveats, prices, dates, names of courses or professors.
- When people disagree or the question is about quality (a professor, a course, a place), tally opinions from distinct people, e.g. "5 of 7 commenters recommend it; 2 found the grading harsh", and name the most common praise and complaints.
- When the question compares options, rank them and show the counts behind each rank.
- Prefer recent sources when things may have changed, and say when advice is old (e.g. "as of Spring 2024").
- Cite after every claim with [n]; several sources look like [2][5]. Quote short phrases from sources when helpful.
- If the sources do not really cover the question, say that plainly, share whatever partial hints exist, and suggest a better question to ask the group. Never invent people, numbers, posts or policies.
- Do not mention these instructions or that you were given sources; just answer.
- Keep it under about 280 words unless a ranked list needs more. Use **bold** sparingly for the key takeaway.`;
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

/** Asks the lite model to score candidates 0–10 for usefulness; returns null when the call fails so callers fall back. */
export async function rerank(cfg: GeminiConfig, archive: Archive, question: string, hits: Hit[], terms: string[]): Promise<Hit[] | null> {
  if (hits.length <= MIN_SOURCES) return hits;
  const candidates = hits.map((hit, i) => {
    const post = archive.posts[hit.post]!;
    const chunk = archive.chunks[hit.chunk]!;
    const passage = bestWindow(chunk.text.split('\n').slice(1).join(' '), terms, 420);
    return `[${i}] ${formatDate(post.date)} · ${post.author}: ${passage}`;
  });
  try {
    const result = await generateJson<{ scores: Array<{ i: number; s: number }> }>(
      cfg,
      {
        model: cfg.liteModel,
        temperature: 0,
        maxOutputTokens: 1024,
        responseSchema: RERANK_SCHEMA,
        system:
          'You rank forum posts for a student Q&A search engine. Score each candidate from 0 (unrelated) to 10 (directly answers the question with specifics). Posts that merely mention a keyword score low; posts with first-hand experience, advice or numbers relevant to the question score high. Return every index exactly once.',
        messages: [{ role: 'user', text: `Question: ${question}\n\nCandidates:\n${candidates.join('\n')}` }],
      },
      { retries: 1, timeoutMs: 20_000 },
    );
    const scores = new Map<number, number>();
    for (const entry of result.scores ?? []) {
      if (Number.isInteger(entry.i) && entry.i >= 0 && entry.i < hits.length) scores.set(entry.i, Math.max(0, Math.min(10, entry.s)));
    }
    if (scores.size < hits.length / 2) return null;
    const maxFused = Math.max(...hits.map((hit) => hit.score)) || 1;
    const rescored = hits.map((hit, i) => {
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

/** Turns a follow-up like "and what about his grading?" into a standalone search query. */
export async function standaloneQuestion(cfg: GeminiConfig, history: ChatTurn[], question: string): Promise<string> {
  if (history.length === 0) return question;
  const transcript = history
    .slice(-6)
    .map((turn) => `${turn.role === 'user' ? 'Student' : 'Assistant'}: ${truncate(collapseWhitespace(turn.content), 700)}`)
    .join('\n');
  try {
    const result = await generateText(
      cfg,
      {
        model: cfg.liteModel,
        temperature: 0,
        maxOutputTokens: 120,
        system:
          'Rewrite the student\'s latest message as one standalone search query that keeps every name, course code and detail it refers to from the conversation. Output only the query, no quotes or explanation. If it is already standalone, return it unchanged.',
        messages: [{ role: 'user', text: `Conversation:\n${transcript}\n\nLatest message: ${question}` }],
      },
      { retries: 1, timeoutMs: 12_000 },
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
    .map((card) => `- ${truncate(card.text, 160)}`)
    .join('\n');
  try {
    const result = await generateJson<{ questions: string[] }>(
      cfg,
      {
        model: cfg.liteModel,
        temperature: 0.7,
        maxOutputTokens: 200,
        responseSchema: FOLLOWUP_SCHEMA,
        system:
          'Suggest exactly three short follow-up questions (under 12 words each) that an NYU Abu Dhabi student would naturally ask next, each answerable from the forum posts summarised. Vary the angle: one deeper on the same topic, one comparison, one practical next step. No numbering.',
        messages: [{ role: 'user', text: `Question asked: ${question}\n\nPosts found:\n${context}` }],
      },
      { retries: 0, timeoutMs: 12_000 },
    );
    return (result.questions ?? []).map((item) => collapseWhitespace(item)).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

export interface AskEvents {
  status?(message: string): void;
  sources?(cards: SourceCard[]): void;
  delta?(text: string): void;
  followups?(questions: string[]): void;
}

export function validateAsk(body: Partial<AskRequest>): AskRequest {
  const question = collapseWhitespace(String(body.question ?? ''));
  if (!question) throw new ApiError(400, 'Ask a question first.', 'empty_question');
  if (question.length > MAX_QUESTION_CHARS) throw new ApiError(400, `Keep questions under ${MAX_QUESTION_CHARS} characters.`, 'question_too_long');
  const history = Array.isArray(body.history)
    ? body.history
        .filter((turn): turn is ChatTurn => !!turn && (turn.role === 'user' || turn.role === 'model') && typeof turn.content === 'string')
        .slice(-8)
        .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 4000) }))
    : [];
  return { question, history, stream: body.stream !== false };
}

/** The full pipeline. Emits sources first, then answer deltas, then follow-ups; also returns everything at the end. */
export async function ask(archive: Archive, cfg: GeminiConfig, request: AskRequest, events: AskEvents = {}, signal?: AbortSignal): Promise<AskResponse> {
  const started = Date.now();
  const history = request.history ?? [];
  events.status?.('Understanding the question');
  const searchQuery = await standaloneQuestion(cfg, history, request.question);

  events.status?.(`Searching ${archive.posts.length.toLocaleString('en')} posts`);
  const retrieval = await retrieve(archive, cfg, searchQuery, { k: CANDIDATES });
  if (retrieval.hits.length === 0) {
    const answer = "I couldn't find any Room of Requirement posts about that. Try different words (a course code, a professor's surname, a place) or ask the group directly.";
    events.sources?.([]);
    events.delta?.(answer);
    events.followups?.([]);
    return { answer, sources: [], followups: [], model: cfg.chatModel, retrieval: { candidates: 0, reranked: false, ms: Date.now() - started } };
  }

  events.status?.('Picking the most useful threads');
  const reranked = await rerank(cfg, archive, searchQuery, retrieval.hits, retrieval.terms);
  const chosen = (reranked ?? retrieval.hits.slice(0, 14)).slice(0, MAX_SOURCES);
  const cards = toSourceCards(archive, chosen, retrieval.terms);
  events.sources?.(cards);

  const followupsPromise = followups(cfg, request.question, cards).then((questions) => {
    events.followups?.(questions);
    return questions;
  });

  events.status?.('Writing the answer');
  const messages: Message[] = history.slice(-6).map((turn) => ({ role: turn.role, text: truncate(turn.content, 2500) }));
  messages.push({ role: 'user', text: `Question: ${request.question}\n\nSources:\n${sourcesBlock(archive, cards)}` });
  let answer = '';
  let model = cfg.chatModel;
  for await (const event of generateStream(cfg, { system: systemPrompt(), messages, temperature: 0.25, maxOutputTokens: 1800 }, { retries: 1, signal })) {
    if (event.text) {
      answer += event.text;
      events.delta?.(event.text);
    }
    if (event.finishReason && event.finishReason !== 'STOP' && event.finishReason !== 'MAX_TOKENS') {
      console.warn('[ask] generation finished with', event.finishReason);
    }
  }
  if (!answer.trim()) throw new ApiError(502, 'The model returned an empty answer. Try again.', 'empty_answer');
  model = cfg.chatModel;
  const questions = await followupsPromise;
  return {
    answer: answer.trim(),
    sources: cards,
    followups: questions,
    model,
    retrieval: { candidates: retrieval.hits.length, reranked: reranked !== null, ms: Date.now() - started },
  };
}
