/**
 * Embedding providers behind one interface. The index remembers which provider and model produced its vectors, and
 * a query must be embedded the same way, so the API picks the provider from the index and only needs that one key.
 *
 *   voyage      VOYAGE_API_KEY                                  200M free tokens per account, generous rate limits
 *   cloudflare  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID    10,000 free neurons a day (about 9M tokens with bge-m3)
 *   gemini      GEMINI_API_KEY                                  small free quota (30k tokens a minute, 1,000 requests a day)
 *
 * ROR_EMBED_PROVIDER forces one; otherwise the first provider with a key wins, in the order above.
 */
import { DEFAULT_DIMENSIONS, DEFAULT_EMBED_MODEL, embedTexts, geminiConfig, GeminiError, normalize, type GeminiConfig } from './gemini.ts';
import type { IndexMeta } from './types.ts';

type EmbeddingProviderId = 'voyage' | 'cloudflare' | 'gemini';
type EmbeddingKind = 'document' | 'query';

interface EmbedOptions {
  retries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Embedder {
  provider: EmbeddingProviderId;
  model: string;
  dimensions: number;
  /** Most texts one request may carry. */
  maxBatch: number;
  /** Sensible indexing defaults for this provider's rate limits. */
  batchSize: number;
  concurrency: number;
  embed(texts: string[], kind: EmbeddingKind, options?: EmbedOptions): Promise<Float32Array[]>;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
  get retryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

export const PROVIDER_LABELS: Record<EmbeddingProviderId, string> = { voyage: 'Voyage AI', cloudflare: 'Cloudflare Workers AI', gemini: 'Gemini' };
const DEFAULT_VOYAGE_MODEL = 'voyage-3.5';
const DEFAULT_CLOUDFLARE_MODEL = '@cf/baai/bge-m3';

interface Override {
  model: string;
  dimensions: number;
}

/** The provider to embed with, from the environment. `preferred` (or ROR_EMBED_PROVIDER) forces one. */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env, preferred?: string): Embedder | null {
  const wanted = (preferred ?? env.ROR_EMBED_PROVIDER ?? '').trim().toLowerCase();
  const order: string[] = wanted ? [wanted] : ['voyage', 'cloudflare', 'gemini'];
  for (const id of order) {
    const embedder = build(id, env);
    if (embedder) return embedder;
  }
  return null;
}

/** Which provider a stored model name belongs to (older indexes did not record it). */
export function providerForModel(model: string): EmbeddingProviderId | null {
  if (!model || model === 'none') return null;
  if (/^voyage/i.test(model)) return 'voyage';
  if (/^@cf\/|bge/i.test(model)) return 'cloudflare';
  if (/gemini|embedding/i.test(model)) return 'gemini';
  return null;
}

/** The embedder that matches an existing index (same provider, model and size), or null when its key is not set. */
export function embedderForIndex(meta: Pick<IndexMeta, 'model' | 'dimensions'> & { provider?: EmbeddingProviderId }, env: NodeJS.ProcessEnv = process.env): Embedder | null {
  if (!meta.model || meta.model === 'none' || !meta.dimensions) return null;
  const provider = meta.provider ?? providerForModel(meta.model);
  return provider ? build(provider, env, { model: meta.model, dimensions: meta.dimensions }) : null;
}

/** Names of the environment variables a provider needs; used for error messages. */
export function keysFor(provider: EmbeddingProviderId): string {
  return provider === 'voyage' ? 'VOYAGE_API_KEY' : provider === 'cloudflare' ? 'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID' : 'GEMINI_API_KEY';
}

function build(id: string, env: NodeJS.ProcessEnv, override?: Override): Embedder | null {
  switch (id) {
    case 'voyage': {
      const apiKey = env.VOYAGE_API_KEY?.trim();
      if (!apiKey) return null;
      return voyageEmbedder({
        apiKey,
        baseUrl: (env.VOYAGE_BASE_URL ?? 'https://api.voyageai.com/v1').replace(/\/$/, ''),
        model: override?.model ?? (env.VOYAGE_EMBED_MODEL?.trim() || DEFAULT_VOYAGE_MODEL),
        dimensions: override?.dimensions ?? (Number(env.VOYAGE_EMBED_DIMENSIONS) || 1024),
      });
    }
    case 'cloudflare': {
      const token = env.CLOUDFLARE_API_TOKEN?.trim();
      const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
      if (!token || !account) return null;
      return cloudflareEmbedder({
        token,
        baseUrl: (env.CLOUDFLARE_AI_BASE_URL ?? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`).replace(/\/$/, ''),
        model: override?.model ?? (env.CLOUDFLARE_EMBED_MODEL?.trim() || DEFAULT_CLOUDFLARE_MODEL),
        dimensions: override?.dimensions ?? (Number(env.CLOUDFLARE_EMBED_DIMENSIONS) || 1024),
      });
    }
    case 'gemini': {
      const cfg = geminiConfig(env);
      if (!cfg) return null;
      return geminiEmbedder(override ? { ...cfg, embedModel: override.model, dimensions: override.dimensions } : { ...cfg, embedModel: cfg.embedModel || DEFAULT_EMBED_MODEL, dimensions: cfg.dimensions || DEFAULT_DIMENSIONS });
    }
    default:
      return null;
  }
}

/* ---------- Voyage AI: POST /v1/embeddings ---------- */

function voyageEmbedder(cfg: { apiKey: string; baseUrl: string; model: string; dimensions: number }): Embedder {
  return {
    provider: 'voyage',
    model: cfg.model,
    dimensions: cfg.dimensions,
    maxBatch: 128,
    batchSize: 64,
    concurrency: 2,
    async embed(texts, kind, options = {}) {
      if (texts.length === 0) return [];
      const json = (await postJson(
        `${cfg.baseUrl}/embeddings`,
        { authorization: `Bearer ${cfg.apiKey}` },
        { input: texts, model: cfg.model, input_type: kind, output_dimension: cfg.dimensions, truncation: true },
        options,
        'Voyage',
      )) as { data?: Array<{ index?: number; embedding?: number[] }> };
      const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((item) => item.embedding);
      return toVectors(rows, texts.length, cfg.dimensions, 'Voyage');
    },
  };
}

/* ---------- Cloudflare Workers AI: POST /accounts/{id}/ai/run/{model} ---------- */

function cloudflareEmbedder(cfg: { token: string; baseUrl: string; model: string; dimensions: number }): Embedder {
  return {
    provider: 'cloudflare',
    model: cfg.model,
    dimensions: cfg.dimensions,
    maxBatch: 100,
    batchSize: 50,
    concurrency: 2,
    async embed(texts, _kind, options = {}) {
      if (texts.length === 0) return [];
      const json = (await postJson(`${cfg.baseUrl}/${cfg.model}`, { authorization: `Bearer ${cfg.token}` }, { text: texts }, options, 'Cloudflare')) as {
        success?: boolean;
        errors?: Array<{ message?: string }>;
        result?: { data?: number[][] };
      };
      if (json.success === false) throw new EmbeddingError(`Cloudflare: ${json.errors?.map((error) => error.message).join('; ') || 'request failed'}`, 502);
      return toVectors(json.result?.data ?? [], texts.length, cfg.dimensions, 'Cloudflare');
    },
  };
}

/* ---------- Gemini (wraps lib/gemini.ts) ---------- */

function geminiEmbedder(cfg: GeminiConfig): Embedder {
  return {
    provider: 'gemini',
    model: cfg.embedModel,
    dimensions: cfg.dimensions,
    maxBatch: 100,
    batchSize: 50,
    // The free tier allows 30k tokens a minute, so one request at a time and let the retry logic pace it.
    concurrency: 1,
    async embed(texts, kind, options = {}) {
      try {
        return await embedTexts(cfg, texts, kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', options);
      } catch (error) {
        if (error instanceof GeminiError) throw new EmbeddingError(error.message, error.status, error.retryAfterMs);
        throw error;
      }
    },
  };
}

/* ---------- Shared plumbing ---------- */

function toVectors(rows: Array<number[] | undefined>, count: number, dimensions: number, label: string): Float32Array[] {
  if (rows.length !== count) throw new EmbeddingError(`${label} returned ${rows.length} embeddings for ${count} texts.`, 502);
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== dimensions) {
      throw new EmbeddingError(`${label} embedding ${index} has ${row?.length ?? 0} values; expected ${dimensions}. Check the configured dimensions.`, 502);
    }
    return normalize(Float32Array.from(row));
  });
}

/** POSTs JSON with retries on 429 and 5xx; shared by the embedding providers and the reranker. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, options: EmbedOptions, label: string): Promise<unknown> {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 60_000;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
      if (response.ok) return await response.json();
      const error = await toError(response, label);
      if (!error.retryable || attempt >= retries) throw error;
      await sleep(error.retryAfterMs ?? backoff(attempt));
    } catch (thrown) {
      if (thrown instanceof EmbeddingError) {
        if (!thrown.retryable || attempt >= retries) throw thrown;
        await sleep(thrown.retryAfterMs ?? backoff(attempt));
      } else if (options.signal?.aborted) {
        throw new EmbeddingError('Request cancelled.', 499);
      } else if (attempt >= retries) {
        throw new EmbeddingError(`${label} request failed: ${(thrown as Error).message}`, 503);
      } else {
        await sleep(backoff(attempt));
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

async function toError(response: Response, label: string): Promise<EmbeddingError> {
  const text = await response.text();
  let message = text.slice(0, 300);
  try {
    const json = JSON.parse(text) as { detail?: string; error?: { message?: string } | string; errors?: Array<{ message?: string }>; message?: string };
    message = json.detail ?? (typeof json.error === 'string' ? json.error : json.error?.message) ?? json.errors?.map((error) => error.message).join('; ') ?? json.message ?? message;
  } catch {
    // not JSON
  }
  const header = response.headers.get('retry-after');
  const retryAfterMs = header ? Math.min(120_000, Number(header) * 1000 || 0) || undefined : undefined;
  return new EmbeddingError(`${label} ${response.status}: ${message}`, response.status, retryAfterMs);
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
