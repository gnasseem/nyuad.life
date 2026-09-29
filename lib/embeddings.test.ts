/**
 * The embedding providers against fake Voyage and Cloudflare servers: request shapes, auth, retries, and that a
 * search over an index built with one provider embeds the question with the same provider.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embedderForIndex, embedderFromEnv, EmbeddingError, providerForModel } from './embeddings.ts';
import { normalize } from './gemini.ts';
import { buildIndex } from './indexer.ts';
import { retrieve } from './rag.ts';
import { loadArchive, resetArchive } from './store.ts';

const DIMS = 8;

function fakeEmbed(text: string): number[] {
  const out = new Float32Array(DIMS);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const digest = createHash('md5').update(token).digest();
    for (let i = 0; i < DIMS; i++) out[i] = out[i]! + (digest[i]! - 128) / 128;
  }
  return Array.from(normalize(out));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

interface Seen {
  url: string;
  auth: string;
  body: Record<string, unknown>;
}

let voyage: Server;
let cloudflare: Server;
let voyageUrl = '';
let cloudflareUrl = '';
const voyageSeen: Seen[] = [];
const cloudflareSeen: Seen[] = [];
let voyageFailuresLeft = 1;

beforeAll(async () => {
  voyage = createServer(async (req, res) => {
    const body = await readJson(req);
    voyageSeen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body });
    if (voyageFailuresLeft > 0) {
      voyageFailuresLeft--;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ detail: 'rate limited, slow down' }));
      return;
    }
    const input = body.input as string[];
    res.setHeader('content-type', 'application/json');
    // Voyage returns items with an index; shuffle to prove the client orders them.
    const data = input.map((text, index) => ({ object: 'embedding', index, embedding: fakeEmbed(text) })).reverse();
    res.end(JSON.stringify({ object: 'list', data, model: body.model, usage: { total_tokens: 42 } }));
  });
  cloudflare = createServer(async (req, res) => {
    const body = await readJson(req);
    cloudflareSeen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '', body });
    const texts = body.text as string[];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, errors: [], messages: [], result: { shape: [texts.length, DIMS], data: texts.map(fakeEmbed) } }));
  });
  await Promise.all([new Promise<void>((resolve) => voyage.listen(0, '127.0.0.1', resolve)), new Promise<void>((resolve) => cloudflare.listen(0, '127.0.0.1', resolve))]);
  voyageUrl = `http://127.0.0.1:${(voyage.address() as { port: number }).port}/v1`;
  cloudflareUrl = `http://127.0.0.1:${(cloudflare.address() as { port: number }).port}/accounts/acc123/ai/run`;
});

afterAll(async () => {
  await new Promise((resolve) => voyage?.close(resolve));
  await new Promise((resolve) => cloudflare?.close(resolve));
});

const voyageEnv = () => ({ VOYAGE_API_KEY: 'vk-test', VOYAGE_BASE_URL: voyageUrl, VOYAGE_EMBED_DIMENSIONS: String(DIMS) });
const cloudflareEnv = () => ({ CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'acc123', CLOUDFLARE_AI_BASE_URL: cloudflareUrl, CLOUDFLARE_EMBED_DIMENSIONS: String(DIMS) });

describe('provider selection', () => {
  it('prefers Voyage, then Cloudflare, then Gemini, unless told otherwise', () => {
    expect(embedderFromEnv({})).toBeNull();
    expect(embedderFromEnv({ GEMINI_API_KEY: 'g' })!.provider).toBe('gemini');
    expect(embedderFromEnv({ GEMINI_API_KEY: 'g', ...cloudflareEnv() })!.provider).toBe('cloudflare');
    expect(embedderFromEnv({ GEMINI_API_KEY: 'g', ...cloudflareEnv(), ...voyageEnv() })!.provider).toBe('voyage');
    expect(embedderFromEnv({ GEMINI_API_KEY: 'g', ...voyageEnv(), ROR_EMBED_PROVIDER: 'gemini' })!.provider).toBe('gemini');
    expect(embedderFromEnv({ ...voyageEnv() }, 'cloudflare')).toBeNull();
    expect(embedderFromEnv({ CLOUDFLARE_API_TOKEN: 'only-token' })).toBeNull();
  });

  it('recognises the provider of an existing index and needs its key', () => {
    expect(providerForModel('voyage-3.5')).toBe('voyage');
    expect(providerForModel('@cf/baai/bge-m3')).toBe('cloudflare');
    expect(providerForModel('gemini-embedding-001')).toBe('gemini');
    expect(providerForModel('none')).toBeNull();
    const meta = { model: 'voyage-3.5-lite', dimensions: 512 };
    expect(embedderForIndex(meta, { GEMINI_API_KEY: 'g' })).toBeNull();
    const embedder = embedderForIndex(meta, { ...voyageEnv(), VOYAGE_EMBED_MODEL: 'voyage-3.5' })!;
    expect(embedder.provider).toBe('voyage');
    expect(embedder.model).toBe('voyage-3.5-lite'); // the index wins over the environment
    expect(embedder.dimensions).toBe(512);
    expect(embedderForIndex({ model: 'none', dimensions: 0 }, voyageEnv())).toBeNull();
  });
});

describe('Voyage', () => {
  it('sends the documented request, survives a 429 and keeps the order', async () => {
    const embedder = embedderFromEnv(voyageEnv())!;
    const vectors = await embedder.embed(['calculus professor', 'housing in A2'], 'document');
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0]!)).toEqual(fakeEmbed('calculus professor'));
    expect(Array.from(vectors[1]!)).toEqual(fakeEmbed('housing in A2'));
    const last = voyageSeen.at(-1)!;
    expect(voyageSeen.length).toBe(2); // one 429, one success
    expect(last.url).toBe('/v1/embeddings');
    expect(last.auth).toBe('Bearer vk-test');
    expect(last.body).toMatchObject({ model: 'voyage-3.5', input_type: 'document', output_dimension: DIMS, input: ['calculus professor', 'housing in A2'] });
    const [query] = await embedder.embed(['who teaches calc'], 'query');
    expect(query).toHaveLength(DIMS);
    expect(voyageSeen.at(-1)!.body.input_type).toBe('query');
  });

  it('rejects vectors of the wrong size instead of storing garbage', async () => {
    const embedder = embedderFromEnv({ ...voyageEnv(), VOYAGE_EMBED_DIMENSIONS: '16' })!;
    await expect(embedder.embed(['x'], 'document')).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe('Cloudflare Workers AI', () => {
  it('posts the texts to the model route with the account token', async () => {
    const embedder = embedderFromEnv(cloudflareEnv())!;
    const vectors = await embedder.embed(['visa renewal', 'best bank'], 'document');
    expect(vectors.map((vector) => Array.from(vector))).toEqual([fakeEmbed('visa renewal'), fakeEmbed('best bank')]);
    const seen = cloudflareSeen.at(-1)!;
    expect(seen.url).toBe('/accounts/acc123/ai/run/@cf/baai/bge-m3');
    expect(seen.auth).toBe('Bearer cf-token');
    expect(seen.body).toEqual({ text: ['visa renewal', 'best bank'] });
    expect(embedder.maxBatch).toBe(100);
  });
});

describe('index and search with Voyage', () => {
  let dataRoot = '';
  beforeAll(() => {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'ror-embed-'));
    mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
    const posts = [
      { id: 'a', url: '', author: 'Ana', date: '2026-04-01', text: 'Who is the best professor for Calculus? MATH-UH 1012.', comments: [{ author: 'Ben', date: '2026-04-01', text: 'Dania explains everything clearly.' }] },
      { id: 'b', url: '', author: 'Dee', date: '2026-03-10', text: 'Is A2 quieter than A5? Roommate question.', comments: [] },
      { id: 'c', url: '', author: 'Fay', date: '2025-11-20', text: 'Visa renewal timeline? Mine took two weeks.', comments: [] },
    ];
    writeFileSync(path.join(dataRoot, 'data', 'posts.jsonl'), posts.map((post) => JSON.stringify(post)).join('\n') + '\n');
  });
  afterAll(() => rmSync(dataRoot, { recursive: true, force: true }));

  it('embeds documents at index time and the question at query time with the same provider', async () => {
    const env = voyageEnv();
    const embedder = embedderFromEnv(env)!;
    const outDir = path.join(dataRoot, 'data', 'index');
    const first = await buildIndex({ postsFile: path.join(dataRoot, 'data', 'posts.jsonl'), outDir, embedder, batchSize: 2 });
    expect(first.meta.provider).toBe('voyage');
    expect(first.meta.model).toBe('voyage-3.5');
    expect(first.embedded).toBe(3);
    const again = await buildIndex({ postsFile: path.join(dataRoot, 'data', 'posts.jsonl'), outDir, embedder });
    expect(again.embedded).toBe(0);
    expect(again.reused).toBe(3);

    process.env.ROR_DATA_ROOT = dataRoot;
    resetArchive();
    const archive = await loadArchive();
    expect(archive.vectors.count).toBe(3);
    expect(archive.meta.provider).toBe('voyage');

    const before = voyageSeen.length;
    const withKey = await retrieve(archive, 'calculus professor', { embedder: embedderForIndex(archive.meta, env) });
    expect(withKey.dense).toBe(true);
    expect(withKey.hits[0]!.post).toBe(archive.postPosition.get('a'));
    expect(voyageSeen.length).toBe(before + 1);
    expect(voyageSeen.at(-1)!.body).toMatchObject({ input_type: 'query', input: ['calculus professor'], model: 'voyage-3.5' });

    // Without the Voyage key the search still works, keyword-only.
    const withoutKey = await retrieve(archive, 'calculus professor', { embedder: embedderForIndex(archive.meta, { GEMINI_API_KEY: 'g' }) });
    expect(withoutKey.dense).toBe(false);
    expect(withoutKey.hits.length).toBeGreaterThan(0);
    delete process.env.ROR_DATA_ROOT;
    resetArchive();
  });
});
