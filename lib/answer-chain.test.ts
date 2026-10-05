/**
 * The answer survives a model that is down: Gemini overloaded (503) moves to the next Gemini model, then to the free
 * backup providers over the OpenAI-compatible API, and a repeated question is answered from the cache with no model
 * call. Fake Gemini and fake backup servers over real HTTP.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { answerKey, resetAnswerCache } from './answer-cache.ts';
import { MemoryBoardStore } from './board-store.ts';
import { geminiConfig, resetModelState } from './gemini.ts';
import { buildIndex } from './indexer.ts';
import { markFailed, ProviderError, providersFromEnv, resetProviderState, ThinkFilter, usable, type Provider } from './providers.ts';
import { answerWriters, ask } from './rag.ts';
import { loadArchive, resetArchive, type Archive } from './store.ts';

const posts = [
  { id: 'p1', url: 'https://fb/p1', author: 'Ana', date: '2026-04-01', text: 'Who is the best professor for Calculus? Thinking about MATH-UH 1012.', comments: [{ author: 'Ben', date: '2026-04-01', text: 'Take it with Dania, she explains everything clearly and grades fairly.' }, { author: 'Cy', date: '2026-04-02', text: 'Agreed, Dania is great. Avoid the 8am section though.' }], reactions: 12, commentCount: 2 },
  { id: 'p2', url: 'https://fb/p2', author: 'Dee', date: '2026-03-10', text: 'Housing question: is A2 quieter than A5? Roommate situation matters to me.', comments: [{ author: 'Eli', date: '2026-03-10', text: 'A5 is the party building, A2 is chill.' }] },
];

const ANSWER = 'Take it with **Dania** [1].\n\n- **Teaching:** clear and fair [1].\n\nConfidence: medium – one thread';

/** What the fake Gemini does per model: answer, or fail with this status. */
let geminiBehaviour: Record<string, number> = {};
const geminiSeen: string[] = [];
/** What the fake backup does per model: answer (optionally wrapped in <think>), or fail with this status. */
let backupBehaviour: Record<string, number | 'think'> = {};
const backupSeen: Array<{ model: string; chars: number; body: Record<string, unknown> }> = [];
let gemini: Server;
let backup: Server;
let backupUrl = '';
let dataRoot = '';
let archive: Archive;

beforeAll(async () => {
  gemini = createServer(async (req, res) => {
    for await (const _ of req);
    const url = req.url ?? '';
    const model = /models\/([^:]+):/.exec(url)?.[1] ?? '';
    geminiSeen.push(`${model}:${url.includes('stream') ? 'stream' : 'call'}`);
    const status = geminiBehaviour[model];
    if (status) {
      res.statusCode = status;
      res.end(JSON.stringify({ error: { code: status, message: status === 503 ? 'The model is overloaded. Please try again later.' : 'You exceeded your current quota, limit: 250 per day', status: 'UNAVAILABLE' } }));
      return;
    }
    if (url.includes(':streamGenerateContent')) {
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] })}\n\n`);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"questions":["Is the 8am section bad?"]}' }] }, finishReason: 'STOP' }] }));
  });
  backup = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; stream: boolean; messages: Array<{ content: string }> };
    backupSeen.push({ model: body.model, chars: body.messages.reduce((sum, message) => sum + message.content.length, 0), body });
    if (req.headers.authorization !== 'Bearer groq-key') {
      res.statusCode = 401;
      res.end('{"error":{"message":"Invalid API Key"}}');
      return;
    }
    const behaviour = backupBehaviour[body.model];
    if (typeof behaviour === 'number') {
      res.statusCode = behaviour;
      res.end(JSON.stringify({ error: { message: behaviour === 404 ? `The model ${body.model} does not exist` : 'Rate limit reached for requests per minute' } }));
      return;
    }
    const text = behaviour === 'think' ? `<think>Let me weigh the threads…</think>\n\n${ANSWER}` : ANSWER;
    if (!body.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'Who teaches Calculus this term?\nIs the 8am section bad?' } }] }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    // Split mid-tag, as streams do.
    for (const piece of [text.slice(0, 4), text.slice(4, 30), text.slice(30)]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => gemini.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => backup.listen(0, '127.0.0.1', resolve));
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(gemini.address() as { port: number }).port}/v1beta`;
  // The tests walk a fixed chain; the defaults themselves are checked in gemini.test.ts.
  process.env.GEMINI_CHAT_MODEL = 'gemini-3.5-flash';
  process.env.GEMINI_CHAT_FALLBACK_MODELS = 'gemini-3-flash-preview,gemini-2.5-flash';
  process.env.GEMINI_LITE_MODEL = 'gemini-3.1-flash-lite';
  process.env.GEMINI_LITE_FALLBACK_MODELS = 'gemini-2.5-flash-lite';
  backupUrl = `http://127.0.0.1:${(backup.address() as { port: number }).port}/openai/v1`;

  dataRoot = mkdtempSync(path.join(tmpdir(), 'ror-chain-'));
  process.env.ROR_DATA_ROOT = dataRoot;
  const dataDir = path.join(dataRoot, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'posts.jsonl'), posts.map((post) => JSON.stringify(post)).join('\n') + '\n');
  await buildIndex({ postsFile: path.join(dataDir, 'posts.jsonl'), outDir: path.join(dataDir, 'index'), embedder: null });
  resetArchive();
  archive = await loadArchive();
});

afterAll(async () => {
  await new Promise((resolve) => gemini?.close(resolve));
  await new Promise((resolve) => backup?.close(resolve));
  rmSync(dataRoot, { recursive: true, force: true });
  delete process.env.ROR_DATA_ROOT;
});

beforeEach(() => {
  geminiBehaviour = {};
  backupBehaviour = {};
  geminiSeen.length = 0;
  backupSeen.length = 0;
  resetModelState();
  resetProviderState();
  resetAnswerCache();
});

function groq(models = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'], maxPromptChars = 20_000): Provider {
  return { id: 'groq', label: 'Groq', baseUrl: backupUrl, apiKey: 'groq-key', models, liteModels: ['llama-3.1-8b-instant'], maxPromptChars, maxOutputTokens: 1_600 };
}

const context = { catalog: null, reranker: null, cache: false } as const;

describe('the answer model chain', () => {
  it('moves to the next Gemini model when the first is overloaded (503)', async () => {
    geminiBehaviour['gemini-3.5-flash'] = 503;
    const statuses: string[] = [];
    const result = await ask(archive, geminiConfig()!, { question: 'best calculus professor?', stream: true }, { status: (message) => statuses.push(message) }, undefined, { ...context, backups: [] });
    expect(result.answer).toContain('Dania');
    expect(result.model).toBe('gemini-3-flash-preview');
    expect(statuses).toContain('Switching to a backup model');
    // The overloaded model rests for a minute instead of being tried on every question.
    expect(answerWriters({ gemini: geminiConfig(), chatgpt: null, backups: [], order: ['gemini'] }).map((writer) => writer.name)[0]).toBe('gemini-3-flash-preview');
  });

  it('falls back to a free backup provider when every Gemini model is down, and fits its small prompt', async () => {
    for (const model of ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']) geminiBehaviour[model] = 503;
    backupBehaviour['openai/gpt-oss-120b'] = 429;
    const result = await ask(archive, geminiConfig()!, { question: 'best calculus professor?', stream: true }, {}, undefined, { ...context, backups: [groq(undefined, 9_000)] });
    expect(result.answer).toContain('Dania');
    expect(result.model).toBe('groq:llama-3.3-70b-versatile');
    const answerCalls = backupSeen.filter((call) => call.body.stream);
    expect(answerCalls.map((call) => call.model)).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
    expect(Math.max(...answerCalls.map((call) => call.chars))).toBeLessThanOrEqual(9_000);
    // Reasoning models are asked to think briefly; the others get no reasoning setting.
    expect(answerCalls[0]!.body.reasoning_effort).toBe('low');
    expect(answerCalls[1]!.body.reasoning_effort).toBeUndefined();
    // Gemini's lite models stay last, behind the backups.
    expect(answerWriters({ gemini: geminiConfig(), chatgpt: null, backups: [groq()], order: ['gemini', 'groq'] }).map((writer) => writer.name).slice(-2)).toEqual(['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
  });

  it('puts the backups first when ROR_MODEL_ORDER says so', async () => {
    const names = answerWriters({ gemini: geminiConfig(), chatgpt: null, backups: [groq()], order: ['groq', 'gemini'] }).map((writer) => writer.name);
    expect(names.slice(0, 3)).toEqual(['groq:openai/gpt-oss-120b', 'groq:llama-3.3-70b-versatile', 'gemini-3.5-flash']);
  });

  it('leaves out thinking a backup model writes into its answer', async () => {
    for (const model of ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']) geminiBehaviour[model] = 503;
    backupBehaviour['openai/gpt-oss-120b'] = 'think';
    const result = await ask(archive, geminiConfig()!, { question: 'best calculus professor?', stream: true }, {}, undefined, { ...context, backups: [groq()] });
    expect(result.answer).not.toContain('think');
    expect(result.answer).not.toContain('weigh the threads');
    expect(result.answer.startsWith('Take it with')).toBe(true);
  });

  it('says answers are busy, in plain words, when every model is overloaded', async () => {
    for (const model of ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']) geminiBehaviour[model] = 503;
    backupBehaviour['openai/gpt-oss-120b'] = 503;
    backupBehaviour['llama-3.3-70b-versatile'] = 503;
    const error = await ask(archive, geminiConfig()!, { question: 'best calculus professor?', stream: true }, {}, undefined, { ...context, backups: [groq()] }).then(
      () => null,
      (thrown: unknown) => thrown as { code: string; message: string },
    );
    expect(error).toMatchObject({ code: 'busy' });
    expect(error!.message).not.toMatch(/gemini|503/i);
  });

  it('answers with backups alone when there is no Gemini key', async () => {
    const result = await ask(archive, null, { question: 'is A2 quieter than A5?', stream: true }, {}, undefined, { ...context, backups: [groq()] });
    expect(result.model).toBe('groq:openai/gpt-oss-120b');
  });
});

describe('the answer cache', () => {
  it('answers a repeated opening question without a model call, whatever its case and punctuation', async () => {
    const board = new MemoryBoardStore();
    const first = await ask(archive, geminiConfig()!, { question: 'Best calculus professor?', stream: true }, {}, undefined, { ...context, board, cache: true, backups: [] });
    expect(first.cached).toBeUndefined();
    const calls = geminiSeen.length;
    const deltas: string[] = [];
    const again = await ask(archive, geminiConfig()!, { question: 'best   Calculus professor', stream: true }, { delta: (text) => deltas.push(text) }, undefined, { ...context, board, cache: true, backups: [] });
    expect(again.cached).toBe(true);
    expect(again.answer).toBe(first.answer);
    expect(again.sources.map((source) => source.n)).toEqual(first.sources.map((source) => source.n));
    expect(deltas.join('')).toBe(first.answer);
    expect(geminiSeen.length).toBe(calls);
    // Kept in the board store too, so other instances share it.
    expect(await board.getSummary(answerKey('best calculus professor'))).not.toBeNull();
  });

  it('never answers a follow-up from the cache', async () => {
    const board = new MemoryBoardStore();
    await ask(archive, geminiConfig()!, { question: 'Best calculus professor?', stream: true }, {}, undefined, { ...context, board, cache: true, backups: [] });
    const followup = await ask(archive, geminiConfig()!, { question: 'Best calculus professor?', history: [{ role: 'user', content: 'hi' }, { role: 'model', content: 'hello' }], stream: true }, {}, undefined, { ...context, board, cache: true, backups: [] });
    expect(followup.cached).toBeUndefined();
  });
});

describe('backup providers', () => {
  it('are read from the environment in the configured order', () => {
    const providers = providersFromEnv({ GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'o', MISTRAL_API_KEY: 'm', ROR_MODEL_ORDER: 'openrouter,gemini', GROQ_MODELS: 'a, b' });
    expect(providers.map((provider) => provider.id)).toEqual(['openrouter', 'groq', 'mistral']);
    expect(providers.find((provider) => provider.id === 'groq')!.models).toEqual(['a', 'b']);
    expect(providersFromEnv({})).toEqual([]);
  });

  it('rest a model after a failure, for as long as the failure deserves', () => {
    const provider = groq(['gone', 'busy', 'spent', 'big', 'ok']);
    const now = 1_000_000;
    markFailed(provider, 'gone', new ProviderError('Groq 404: The model gone does not exist', 404), now);
    markFailed(provider, 'busy', new ProviderError('Groq 429: Rate limit reached for requests per minute', 429), now);
    markFailed(provider, 'spent', new ProviderError('Groq 429: Rate limit reached for tokens per day (TPD)', 429), now);
    markFailed(provider, 'big', new ProviderError('Groq 413: Request too large', 413), now);
    expect(usable(provider, provider.models, now + 1)).toEqual(['big', 'ok']);
    expect(usable(provider, provider.models, now + 61_000)).toEqual(['busy', 'big', 'ok']);
    expect(usable(provider, provider.models, now + 3_600_001)).toEqual(['busy', 'spent', 'big', 'ok']);
    // A refused key rests the whole provider.
    markFailed(provider, 'ok', new ProviderError('Groq 401: Invalid API Key', 401), now);
    expect(usable(provider, provider.models, now + 1)).toEqual([]);
  });

  it('drop <think> blocks even when a tag is split across chunks', () => {
    const filter = new ThinkFilter();
    const out = ['<thi', 'nk>planning', '…</th', 'ink>\n\nThe answer', ' is **yes**.\n\n- one', '\n- two <', 'b>'].map((chunk) => filter.push(chunk)).join('') + filter.flush();
    expect(out).toBe('The answer is **yes**.\n\n- one\n- two <b>');
    const plain = new ThinkFilter();
    expect(['Para one.', '\n\n', 'Para two.'].map((chunk) => plain.push(chunk)).join('') + plain.flush()).toBe('Para one.\n\nPara two.');
  });
});
