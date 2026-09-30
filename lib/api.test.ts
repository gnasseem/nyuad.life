/**
 * End-to-end test of the API routes over real HTTP with a fake Gemini server:
 * builds an index from a small synthetic archive, then searches, browses and asks (streaming).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer } from './devserver.ts';
import { embedderFromEnv } from './embeddings.ts';
import { normalize } from './gemini.ts';
import { buildIndex } from './indexer.ts';
import { resetArchive } from './store.ts';

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

let fakeGemini: Server;
let api: Server;
let apiUrl = '';
let dataRoot = '';
const geminiCalls: Array<{ url: string; prompt: string }> = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJson = async (url: string, init?: RequestInit): Promise<any> => (await fetch(url, init)).json();

beforeAll(async () => {
  fakeGemini = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const url = req.url ?? '';
    geminiCalls.push({ url, prompt: String(body.contents?.at?.(-1)?.parts?.[0]?.text ?? '') });
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
      // The main chat model is "out of quota for the day": the API must fall back to the lite model.
      if (url.includes('gemini-2.5-flash:')) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota: generate_content_free_tier_requests, limit: 250 per day', status: 'RESOURCE_EXHAUSTED' } }));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      const prompt = body.contents.at(-1).parts[0].text as string;
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
  process.env.GEMINI_EMBED_DIMENSIONS = String(DIMS);

  dataRoot = mkdtempSync(path.join(tmpdir(), 'ror-test-'));
  process.env.ROR_DATA_ROOT = dataRoot;
  const dataDir = path.join(dataRoot, 'data');
  require('node:fs').mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'posts.jsonl'), posts.map((post) => JSON.stringify(post)).join('\n') + '\n');
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
  it('reports health, including which embedding provider the index needs', async () => {
    const health = await getJson(`${apiUrl}/api/health`);
    expect(health.ok).toBe(true);
    expect(health.archive).toMatchObject({ source: 'index', posts: 4, vectors: true, dimensions: DIMS });
    expect(health.embeddings).toMatchObject({ provider: 'gemini', keyConfigured: true, semanticSearch: true });
    expect(health.gemini).toMatchObject({ configured: true, chatModel: 'gemini-2.5-flash', chatFallbacks: ['gemini-2.5-flash-lite'] });
    expect(health).not.toHaveProperty('accessCode');
  });

  it('serves every route without any credentials', async () => {
    for (const path of ['/api/home', '/api/search?q=calculus', '/api/post?id=p1', '/api/courses']) {
      const response = await fetch(`${apiUrl}${path}`);
      expect(response.status, path).toBe(200);
    }
    const ask = await fetch(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'calculus professor', stream: false }) });
    expect(ask.status).toBe(200);
  });

  it('serves the home payload', async () => {
    const home = await getJson(`${apiUrl}/api/home`, { headers });
    expect(home.stats.posts).toBe(4);
    expect(home.stats.semantic).toBe(true);
    expect(home.suggestions).toHaveLength(3);
    expect(home.courses.map((c: { code: string }) => c.code).sort()).toEqual(['CS-UH 1001', 'MATH-UH 1012']);
    expect(home.topics.find((t: { id: string }) => t.id === 'housing')).toBeTruthy();
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

  it('lists courses and their posts', async () => {
    const list = await getJson(`${apiUrl}/api/courses?q=MATH`, { headers });
    expect(list.courses).toEqual([{ code: 'MATH-UH 1012', department: 'MATH', count: 1, latest: '2026-04-01' }]);
    const detail = await getJson(`${apiUrl}/api/courses?code=cs-uh1001`, { headers });
    expect(detail.code).toBe('CS-UH 1001');
    expect(detail.posts.map((p: { id: string }) => p.id)).toEqual(['p4']);
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
    expect(names).toContain('followups');
    expect(names.at(-1)).toBe('done');
    const sources = events.find((e) => e.event === 'sources')!.data.sources;
    expect(sources[0].n).toBe(1);
    expect(sources.map((s: { postId: string }) => s.postId)).toContain('p1');
    const answer = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    expect(answer).toContain('Dania');
    expect(events.at(-1)!.data.confidence).toEqual({ level: 'high', reason: 'three people agree, all this year' });
    // gemini-2.5-flash answered 429 (daily quota), so the answer came from the fallback model.
    expect(events.at(-1)!.data.model).toBe('gemini-2.5-flash-lite');
    expect(geminiCalls.some((call) => call.url.includes('gemini-2.5-flash:streamGenerateContent'))).toBe(true);
    expect(events.find((e) => e.event === 'followups')!.data.questions).toHaveLength(3);
    // The follow-up rewrite saw the conversation, and the answer was generated by streaming.
    expect(geminiCalls.some((call) => call.url.includes(':generateContent') && call.prompt.includes('Latest message:'))).toBe(true);
    expect(geminiCalls.some((call) => call.url.includes(':streamGenerateContent'))).toBe(true);
  });

  it('answers as plain JSON when streaming is off', async () => {
    const result = await getJson(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: 'calculus professor', stream: false }) });
    expect(result.answer).toContain('Dania');
    expect(result.answer).not.toMatch(/confidence:/i);
    expect(result.confidence.level).toBe('high');
    expect(result.model).toBe('gemini-2.5-flash-lite');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.retrieval.reranked).toBe(true);
  });

  it('validates questions', async () => {
    const empty = await fetch(`${apiUrl}/api/ask`, { method: 'POST', headers, body: JSON.stringify({ question: '  ' }) });
    expect(empty.status).toBe(400);
  });
});
