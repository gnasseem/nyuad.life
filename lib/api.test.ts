/**
 * End-to-end test of the API routes over real HTTP with a fake Gemini server:
 * builds an index from a small synthetic archive, then searches, browses and asks (streaming).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAnswerCache } from './answer-cache.ts';
import { createApiServer } from './devserver.ts';
import { embedderFromEnv } from './embeddings.ts';
import { geminiConfig, normalize } from './gemini.ts';
import { buildIndex } from './indexer.ts';
import { ask } from './rag.ts';
import { loadArchive, resetArchive } from './store.ts';

const DIMS = 16;
const posts = [
  { id: 'p1', url: 'https://fb/p1', author: 'Ana', date: '2026-04-01', text: 'Who is the best professor for Calculus? Thinking about MATH-UH 1012.', comments: [{ author: 'Ben', date: '2026-04-01', text: 'Take it with Dania, she explains everything clearly and grades fairly.' }, { author: 'Cy', date: '2026-04-02', text: 'Agreed, Dania is great. Avoid the 8am section though.' }, { author: 'Ana', date: '2026-04-03', text: 'bump' }], reactions: 12, commentCount: 3 },
  { id: 'p2', url: 'https://fb/p2', author: 'Dee', date: '2026-03-10', text: 'Housing question: is A2 quieter than A5? Roommate situation matters to me.', comments: [{ author: 'Eli', date: '2026-03-10', text: 'A5 is the party building, A2 is chill.' }] },
  { id: 'p3', url: 'https://fb/p3', author: 'Fay', date: '2025-11-20', text: 'Visa renewal timeline? Mine took two weeks last year.', comments: [] },
  { id: 'p4', url: 'https://fb/p4', author: 'Gus', date: '2026-05-05', text: 'Calculus with Dania or with the new professor? CS-UH 1001 also on my plate.', comments: [{ author: 'Hal', date: '2026-05-05', text: 'Dania. The new professor is fine too but moves fast.' }] },
  { id: 'p5', url: 'https://fb/p5', author: 'Ivy', date: '', text: 'Selling a mini fridge, 150 AED, pick up from A1.', comments: [] },
  { id: 'p6', url: 'https://fb/p6', author: 'Yas Island', date: '2026-01-01', text: 'Kids go free! Book now, T&Cs apply.', comments: [] },
];

/** Deterministic "embedding": a bag-of-words hash projection, good enough for search tests. */
function fakeEmbed(text: string): number[] {
  const out = new Float32Array(DIMS);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const digest = createHash('md5').update(token).digest();
    for (let i = 0; i < DIMS; i++) out[i] = out[i]! + (digest[i]! - 128) / 128;
  }
  return Array.from(normalize(out));
}

const classes = [
  {
    term: 'Fall 2026',
    code: 'MATH-UH 1012',
    title: 'Calculus',
    description: 'Limits, derivatives and integrals.',
    sections: [
      { classNumber: '101', section: '001', component: 'Lecture', topic: '', units: '4', status: 'Open', session: 'AD', startDate: '2026-08-24', endDate: '2026-12-14', grading: '', mode: 'In-Person', location: 'Abu Dhabi', instructors: ['Dania, Rana'], meetings: [{ days: ['Mon', 'Wed'], startTime: '10:00', endTime: '11:15', room: 'Social Science C2 Room 001', startDate: '2026-08-24', endDate: '2026-12-14' }], notes: '' },
    ],
    scraped: '2026-10-02T00:00:00.000Z',
  },
];

let fakeGemini: Server;
let api: Server;
let apiUrl = '';
let dataRoot = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const geminiCalls: Array<{ url: string; prompt: string; body: any }> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (url: string, init?: RequestInit): Promise<any> => (await fetch(url, init)).json();

beforeAll(async () => {
  fakeGemini = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const url = req.url ?? '';
    geminiCalls.push({ url, prompt: String(body.contents?.at?.(-1)?.parts?.[0]?.text ?? ''), body });
    if (req.headers['x-goog-api-key'] !== 'test-key') {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { code: 403, message: 'bad key' } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (url.includes(':batchEmbedContents')) {
      const requests = body.requests as Array<{ content: { parts: Array<{ text: string }> }; outputDimensionality: number; taskType: string }>;
      expect(requests[0]!.outputDimensionality).toBe(DIMS);
      res.end(JSON.stringify({ embeddings: requests.map((r) => ({ values: fakeEmbed(r.content.parts[0]!.text) })) }));
      return;
    }
    if (url.includes(':streamGenerateContent')) {
      // The newest model has been shut down and the next is out of quota for the day: the API must walk down to 2.5 Flash.
      if (url.includes('gemini-3.5-flash:')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 404, message: 'models/gemini-3.5-flash is not found for API version v1beta', status: 'NOT_FOUND' } }));
        return;
      }
      if (url.includes('gemini-3-flash-preview:')) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota: generate_content_free_tier_requests, limit: 250 per day', status: 'RESOURCE_EXHAUSTED' } }));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      const prompt = body.contents.at(-1).parts[0].text as string;
      if (prompt.includes('Question: take your time')) {
        // A model that writes slower than the deadline allows.
        for (let i = 0; i < 20 && !res.destroyed; i++) {
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `part ${i}. ` }] } }] })}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        res.end();
        return;
      }
      expect(prompt).toContain('Sources:');
      expect(body.systemInstruction.parts[0].text).toContain('Room of Requirement');
      const pieces = ['**Dania** is the favourite', ' [1][4].', '\n\n- 3 of 3 commenters recommend her [1][4].', '\n\nConfidence: high – three people agree, all this year.'];
      for (const piece of pieces) res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: piece }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } })}\n\n`);
      res.end();
      return;
    }
    if (url.includes(':generateContent')) {
      const schema = body.generationConfig?.responseSchema;
      const prompt = body.contents.at(-1).parts[0].text as string;
      let text: string;
      if (schema?.properties?.scores) {
        const count = (prompt.match(/^\[\d+\]/gm) ?? []).length;
        text = JSON.stringify({ scores: Array.from({ length: count }, (_, i) => ({ i, s: i < 2 ? 9 : 5 })) });
      } else if (schema?.properties?.questions) {
        text = JSON.stringify({ questions: ['How is her grading?', 'Which section is best?', 'What about the new professor?'] });
      } else if (schema?.properties?.basis) {
        text = JSON.stringify({ score: 4.26, difficulty: 3, workload: null, verdict: 'Hard but fair [1].', pros: ['Dania explains clearly [1][4]', ''], cons: [], tips: [], basis: 3, confidence: 'high' });
      } else if (schema?.properties?.daysOff) {
        text = JSON.stringify({ wants: [{ label: 'Calculus', codes: ['MATH-UH 1012Q'] }, { label: 'an Arts Core', codes: ['CADT-UH 9999'] }], missing: [], earliest: '9:00', latest: null, daysOff: ['Fri', 'Sat'], lunch: true, shape: 'compact', waitlisted: false, prefer: ['Prof. Dania'], avoid: ['Nobody Here'] });
      } else if (schema?.properties?.verdict) {
        text = JSON.stringify({ verdict: 'ok' });
      } else if (schema?.properties?.majors) {
        text = JSON.stringify({ summary: 'Calculus section choice', topics: ['courses', 'bogus'], majors: ['Mathematics', 'Not a major'], years: ['senior'] });
      } else {
        text = 'best calculus professor Dania';
      }
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => fakeGemini.listen(0, '127.0.0.1', resolve));
  const geminiPort = (fakeGemini.address() as { port: number }).port;
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${geminiPort}/v1beta`;
  // The tests walk a fixed chain; the defaults themselves are checked in gemini.test.ts.
  process.env.GEMINI_CHAT_MODEL = 'gemini-3.5-flash';
  process.env.GEMINI_CHAT_FALLBACK_MODELS = 'gemini-3-flash-preview,gemini-2.5-flash';
  process.env.GEMINI_LITE_MODEL = 'gemini-3.1-flash-lite';
  process.env.GEMINI_LITE_FALLBACK_MODELS = 'gemini-2.5-flash-lite';
  process.env.GEMINI_EMBED_DIMENSIONS = String(DIMS);

  dataRoot = mkdtempSync(path.join(tmpdir(), 'ror-test-'));
  process.env.ROR_DATA_ROOT = dataRoot;
  const dataDir = path.join(dataRoot, 'data');
  require('node:fs').mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'posts.jsonl'), posts.map((post) => JSON.stringify(post)).join('\n') + '\n');
  writeFileSync(path.join(dataDir, 'classes.jsonl'), classes.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const embedder = embedderFromEnv()!;
  expect(embedder.provider).toBe('gemini');
  const result = await buildIndex({ postsFile: path.join(dataDir, 'posts.jsonl'), outDir: path.join(dataDir, 'index'), embedder, batchSize: 2, concurrency: 2 });
  expect(result.meta.posts).toBe(4); // the sponsored post and the fridge listing are dropped
  expect(result.meta.provider).toBe('gemini');
  expect(result.embedded).toBeGreaterThan(0);

  // A second build reuses the cache and embeds nothing.
  const again = await buildIndex({ postsFile: path.join(dataDir, 'posts.jsonl'), outDir: path.join(dataDir, 'index'), embedder });
  expect(again.embedded).toBe(0);
  expect(again.reused).toBe(result.meta.chunks);

  resetArchive();
  api = createApiServer({ root: process.cwd(), distDir: path.join(dataRoot, 'no-dist') });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api?.close(resolve));
  await new Promise((resolve) => fakeGemini?.close(resolve));
  rmSync(dataRoot, { recursive: true, force: true });
});

const headers = { 'content-type': 'application/json' };

describe('api', () => {
  // Each test asks afresh; the cache has its own test.
  beforeEach(() => {
    process.env.ROR_ANSWER_CACHE = '0';
    resetAnswerCache();
  });

  it('reports health, including which embedding provider the index needs', async () => {
    const health = await getJson(`${apiUrl}/api/health`);
    expect(health.ok).toBe(true);
    expect(health.archive).toMatchObject({ source: 'index', posts: 4, vectors: true, dimensions: DIMS });
    expect(health.embeddings).toMatchObject({ provider: 'gemini', keyConfigured: true, semanticSearch: true });
    expect(health.gemini).toMatchObject({ configured: true, chatModel: 'gemini-3.5-flash', chatFallbacks: ['gemini-3-flash-preview', 'gemini-2.5-flash'], liteModel: 'gemini-3.1-flash-lite' });
    expect(health).not.toHaveProperty('accessCode');
  });

  it('serves every route without any credentials', async () => {
    for (const path of ['/api/search?q=calculus', '/api/post?id=p1']) {
      const response = await fetch(`${apiUrl}${path}`);
      expect(response.status, path).toBe(200);
    }
    const ask = await fetch(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'calculus professor', stream: false }) });
    expect(ask.status).toBe(200);
  });

  it('searches with hybrid retrieval and filters', async () => {
    const result = await getJson(`${apiUrl}/api/search?q=calculus+professor`, { headers });
    expect(result.dense).toBe(true);
    expect(result.results.slice(0, 2).map((r: { id: string }) => r.id).sort()).toEqual(['p1', 'p4']);
    expect(result.results[0].snippet.toLowerCase()).toContain('calculus');

    const housing = await getJson(`${apiUrl}/api/search?topic=housing`, { headers });
    const housingIds = housing.results.map((r: { id: string }) => r.id);
    expect(housingIds).toContain('p2');
    expect(housingIds).not.toContain('p1');

    const dated = await getJson(`${apiUrl}/api/search?from=2026-04&sort=oldest`, { headers });
    expect(dated.results.map((r: { id: string }) => r.id)).toEqual(['p1', 'p4']);

    const bad = await fetch(`${apiUrl}/api/search?q=x`, { headers });
    expect(bad.status).toBe(400);
  });

  it('returns a post with comments and related posts', async () => {
    const result = await getJson(`${apiUrl}/api/post?id=p1`, { headers });
    expect(result.post.comments).toHaveLength(2); // the "bump" is gone
    expect(result.post.commentCount).toBe(2);
    expect(result.post.courses).toEqual(['MATH-UH 1012']);
    expect(result.related.map((r: { id: string }) => r.id)).toContain('p4');
    expect((await fetch(`${apiUrl}/api/post?id=nope`, { headers })).status).toBe(404);
  });

  it('answers with streaming events', async () => {
    const response = await fetch(`${apiUrl}/api/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question: 'Who is the best calculus professor?', history: [{ role: 'user', content: 'hi' }, { role: 'model', content: 'hello' }] }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const raw = await response.text();
    const events = raw
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const [eventLine, dataLine] = block.split('\n');
        return { event: eventLine!.replace('event: ', ''), data: JSON.parse(dataLine!.replace('data: ', '')) };
      });
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('status');
    expect(names).toContain('sources');
    expect(names).not.toContain('followups');
    expect(names.at(-1)).toBe('done');
    const sources = events.find((e) => e.event === 'sources')!.data.sources;
    expect(sources[0].n).toBe(1);
    expect(sources.map((s: { postId: string }) => s.postId)).toContain('p1');
    const answer = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    expect(answer).toContain('Dania');
    expect(events.at(-1)!.data.confidence).toEqual({ level: 'high', reason: 'three people agree, all this year' });
    // 3.5 Flash is gone (404) and 3 Flash is out of quota (429), so the answer came from 2.5 Flash.
    expect(events.at(-1)!.data.model).toBe('gemini-2.5-flash');
    expect(events.at(-1)!.data.truncated).toBe(false);
    expect(geminiCalls.some((call) => call.url.includes('gemini-3.5-flash:streamGenerateContent'))).toBe(true);
    expect(geminiCalls.some((call) => call.url.includes('gemini-3-flash-preview:streamGenerateContent'))).toBe(true);
    // Thinking is capped so it cannot eat the answer's token budget, and utility calls do not think at all where they can.
    const answerCall = geminiCalls.find((call) => call.url.includes('gemini-2.5-flash:streamGenerateContent'))!;
    expect(answerCall.body.generationConfig).toMatchObject({ maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 1024 } });
    const utilityCall = geminiCalls.find((call) => call.url.includes(':generateContent'))!;
    expect(utilityCall.url).toContain('gemini-3.1-flash-lite:generateContent');
    expect(utilityCall.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
    // The follow-up rewrite saw the conversation, and the answer was generated by streaming.
    expect(geminiCalls.some((call) => call.url.includes(':generateContent') && call.prompt.includes('Latest message:'))).toBe(true);
    expect(geminiCalls.some((call) => call.url.includes(':streamGenerateContent'))).toBe(true);
  });

  it('answers as plain JSON when streaming is off', async () => {
    const result = await getJson(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'calculus professor', stream: false }) });
    expect(result.answer).toContain('Dania');
    expect(result.answer).not.toMatch(/confidence:/i);
    expect(result.confidence.level).toBe('high');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.retrieval.reranked).toBe(true);
    // Models that failed are skipped for a while rather than tried on every question.
    const answers = geminiCalls.filter((call) => call.url.includes(':streamGenerateContent'));
    expect(answers.at(-1)!.url).toContain('gemini-2.5-flash:');
    expect(answers.filter((call) => call.url.includes('gemini-3.5-flash:'))).toHaveLength(1);
  });

  it('cites the Albert schedule for a course the question names', async () => {
    const result = await getJson(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'Who teaches MATH-UH 1012 this term?', stream: false }) });
    const schedule = result.sources.find((source: { kind: string }) => source.kind === 'schedule');
    expect(schedule).toMatchObject({ postId: 'MATH-UH 1012', title: 'MATH-UH 1012 Calculus' });
    const prompt = geminiCalls.filter((call) => call.url.includes(':streamGenerateContent')).at(-1)!.prompt;
    expect(prompt).toContain('Albert class schedule: MATH-UH 1012 Calculus (4 credits)');
    expect(prompt).toContain('Lecture 001: Mon/Wed 10:00–11:15, Social Science C2 Room 001 · Rana Dania · open');
  });

  it('ends a slow answer at the deadline and says it was cut short', async () => {
    const archive = await loadArchive();
    const started = Date.now();
    const result = await ask(archive, geminiConfig()!, { question: 'take your time with the calculus professor', stream: false }, {}, undefined, { catalog: null, reranker: null, deadline: Date.now() + 1_500 });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.truncated).toBe(true);
    expect(result.answer).toMatch(/^part 0\. part 1\./);
  });

  it('orders threads by the cross-encoder when there is one', async () => {
    const archive = await loadArchive();
    const reranker = { name: 'fake', rerank: async (_query: string, documents: string[]) => documents.map((doc) => (doc.includes('new professor') ? 0.9 : doc.includes('Dania') ? 0.7 : 0.05)) };
    const result = await ask(archive, geminiConfig()!, { question: 'calculus professor', stream: false }, {}, undefined, { reranker, catalog: null });
    expect(result.retrieval.reranked).toBe(true);
    expect(result.sources.map((source) => source.postId).slice(0, 2)).toEqual(['p4', 'p1']);
  });

  it('keeps contacts out of the lists and hands them out one post at a time', async () => {
    const post = (body: Record<string, unknown>) => getJson(`${apiUrl}/api/board`, { method: 'POST', headers, body: JSON.stringify(body) });
    await post({ op: 'profile', netId: 'abc1234', key: 'key-12345678', name: 'Sara Ali', major: 'Computer Science', classOf: 2027 });
    const { listing } = await post({ op: 'listing', netId: 'abc1234', key: 'key-12345678', kind: 'sell', title: 'Mini fridge', price: 150, contactKind: 'instagram', contact: '@sara' });
    const { offer } = await post({ op: 'offer', netId: 'abc1234', key: 'key-12345678', currency: 'campus', side: 'sell', amount: 360, rate: 0.5, contactKind: 'instagram', contact: '@sara' });
    const listings = await getJson(`${apiUrl}/api/board?op=listings`);
    const offers = await getJson(`${apiUrl}/api/board?op=offers`);
    expect(JSON.stringify([listings, offers])).not.toContain('@sara');
    expect(offers.markets.campus).toMatchObject({ open: 1, bestAsk: 0.5 });
    expect(await getJson(`${apiUrl}/api/board?op=contact&type=listing&id=${listing.id}`)).toEqual({ contactKind: 'instagram', contact: '@sara' });
    expect(await getJson(`${apiUrl}/api/board?op=contact&type=offer&id=${offer.id}`)).toEqual({ contactKind: 'instagram', contact: '@sara' });
    expect((await fetch(`${apiUrl}/api/board?op=contact&type=offer&id=nope`)).status).toBe(404);
    expect((await fetch(`${apiUrl}/api/board?op=contact&type=user&id=${offer.id}`)).status).toBe(400);
  });

  it('lets only the browser that set a NetID up act as it', async () => {
    const post = (body: Record<string, unknown>) => fetch(`${apiUrl}/api/board`, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ op: 'profile', netId: 'vic1234', key: 'victim-key-1', name: 'Vic Tim', major: 'Economics', classOf: 2027 })).status).toBe(200);
    // Someone else's browser can neither take the NetID over nor post as it.
    const takeover = await post({ op: 'profile', netId: 'vic1234', key: 'mallory-key', name: 'Mallory', major: 'Economics', classOf: 2027 });
    expect(takeover.status).toBe(403);
    expect(((await takeover.json()) as { error: string }).error).toBe('netid_taken');
    expect((await post({ op: 'announce', netId: 'vic1234', key: 'mallory-key', title: 'Free food at D2', body: 'Come by', kind: 'event' })).status).toBe(403);
    // The owner still can.
    expect((await post({ op: 'profile', netId: 'vic1234', key: 'victim-key-1', name: 'Vic Tim', major: 'Economics', classOf: 2028 })).status).toBe(200);
  });

  it('screens what students post', async () => {
    const post = (body: Record<string, unknown>) => fetch(`${apiUrl}/api/board`, { method: 'POST', headers, body: JSON.stringify(body) });
    await post({ op: 'profile', netId: 'sel1234', key: 'seller-key-1', name: 'Sam Seller', major: 'Economics', classOf: 2027 });
    const blocked = await post({ op: 'listing', netId: 'sel1234', key: 'seller-key-1', kind: 'sell', title: 'Selling vapes', body: 'elf bars, dm me', price: 40, contactKind: 'instagram', contact: '@sam' });
    expect(blocked.status).toBe(422);
    expect(((await blocked.json()) as { error: string }).error).toBe('blocked_prohibited');
    const crisis = await post({ op: 'ask', key: 'asker-key-1', text: 'I want to kill myself and I do not know who to talk to' });
    expect(((await crisis.json()) as { message: string }).message).toContain('Wellness Exchange');
  });

  it('serves the course search and spends nothing on codes that are not courses', async () => {
    const terms = await getJson(`${apiUrl}/api/courses`);
    expect(terms.terms.map((term: { name: string }) => term.name)).toEqual(['Fall 2026']);
    const list = await getJson(`${apiUrl}/api/courses?term=Fall%202026`);
    expect(list.courses.map((row: { code: string }) => row.code)).toEqual(['MATH-UH 1012']);
    const detail = await getJson(`${apiUrl}/api/courses?code=MATH-UH%201012`);
    expect(detail).toMatchObject({ code: 'MATH-UH 1012', title: 'Calculus', credits: '4' });
    expect(detail).not.toHaveProperty('offerings');
    const all = await getJson(`${apiUrl}/api/courses?all=1`);
    expect(all.courses).toEqual([expect.objectContaining({ code: 'MATH-UH 1012', title: 'Calculus', core: false })]);
    const calls = geminiCalls.length;
    for (const suffix of ['', '&rating=1']) expect((await fetch(`${apiUrl}/api/courses?code=ZZ-UH%209999${suffix}`)).status).toBe(404);
    expect(geminiCalls.length).toBe(calls);
    const { rating } = await getJson(`${apiUrl}/api/courses?code=MATH-UH%201012&rating=1`);
    expect(rating).toMatchObject({ score: 4.3, difficulty: 3, workload: null, basis: 3, confidence: 'high' });
    // Citations the model wrote anyway are taken out.
    expect(rating.pros).toEqual(['Dania explains clearly']);
    const ratingCall = geminiCalls.at(-1)!;
    expect(ratingCall.prompt).toContain('What students wrote:');
    expect(ratingCall.url).toMatch(/gemini-[\d.]+-flash(?:-preview)?:generateContent/);
  });

  it('reads a plan request into codes the term has and rules the planner can use', async () => {
    const post = (body: Record<string, unknown>) => fetch(`${apiUrl}/api/plan`, { method: 'POST', headers, body: JSON.stringify(body) });
    const response = await post({ term: 'Fall 2026', text: 'calc with Dania, an arts core, nothing before 9, fridays off, lunch', current: { wants: [{ label: 'Calculus', codes: ['MATH-UH 1012'] }] } });
    expect(response.status).toBe(200);
    const plan = (await response.json()) as { wants: unknown; missing: unknown; rules: unknown };
    // The Q-suffixed code finds this term's course; a code the term does not have is dropped and said to be missing.
    expect(plan.wants).toEqual([{ label: '', codes: ['MATH-UH 1012'] }]);
    expect(plan.missing).toEqual(['an Arts Core', 'Nobody Here is not teaching this term']);
    expect(plan.rules).toEqual({ earliest: '09:00', latest: '', daysOff: ['Fri'], lunch: true, shape: 'compact', waitlisted: false, prefer: ['Rana Dania'], avoid: [] });
    const call = geminiCalls.at(-1)!;
    expect(call.prompt).toContain('MATH-UH 1012 · Calculus');
    expect(call.prompt).toContain('Current plan:\n- Calculus: MATH-UH 1012');
    expect((await post({ term: 'Fall 1999', text: 'calc' })).status).toBe(404);
    expect((await post({ term: 'Fall 2026', text: ' ' })).status).toBe(400);
  });

  it('validates questions', async () => {
    const empty = await fetch(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: '  ' }) });
    expect(empty.status).toBe(400);
  });
});
