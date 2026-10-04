/**
 * Minimal Gemini Developer API client over fetch (no SDK), covering the three calls this app needs:
 * batch embeddings, JSON-mode generation and SSE streaming generation. Retries 429/5xx with backoff.
 */

export interface GeminiConfig {
  apiKey: string;
  baseUrl: string;
  embedModel: string;
  /** Model that writes answers. */
  chatModel: string;
  /** Models to try, in order, when the answer model is gone or out of quota (free tiers reset daily). */
  chatFallbacks: string[];
  /** Cheaper model for reranking, follow-ups and query rewriting: the first of `liteModels`. */
  liteModel: string;
  /** The lite model and the ones to fall back to, in order. */
  liteModels: string[];
  dimensions: number;
}

export const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';
// Newest first. Google retires models on short notice (the 2.5 family is being shut down in October 2026) and the free
// tier is granted per model, so each call walks down its list and skips, for a while, any model that answered 404 or
// ran out of quota. Pinned names rather than "-latest" aliases, which can move to a model without a free tier.
const DEFAULT_CHAT_MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
const DEFAULT_LITE_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
export const DEFAULT_DIMENSIONS = 768;

function modelList(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value.split(',').map((model) => model.trim()).filter(Boolean);
}

/** A primary model, then the fallbacks: those set in the environment, or the defaults the primary is not already. */
function chain(primary: string | undefined, fallbacks: string[] | null, defaults: string[]): string[] {
  const first = primary?.trim() || defaults[0]!;
  const rest = fallbacks ?? defaults;
  return [first, ...rest.filter((model) => model !== first)].filter((model, index, all) => all.indexOf(model) === index);
}

/** Reads GEMINI_API_KEY and the optional model overrides; returns null when no key is configured. */
export function geminiConfig(env: NodeJS.ProcessEnv = process.env): GeminiConfig | null {
  const apiKey = (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const chat = chain(env.GEMINI_CHAT_MODEL, modelList(env.GEMINI_CHAT_FALLBACK_MODELS), DEFAULT_CHAT_MODELS);
  const lite = chain(env.GEMINI_LITE_MODEL, modelList(env.GEMINI_LITE_FALLBACK_MODELS), DEFAULT_LITE_MODELS);
  return {
    apiKey,
    baseUrl: (env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
    embedModel: env.GEMINI_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
    chatModel: chat[0]!,
    chatFallbacks: chat.slice(1),
    liteModel: lite[0]!,
    liteModels: lite,
    dimensions: Number(env.GEMINI_EMBED_DIMENSIONS) || DEFAULT_DIMENSIONS,
  };
}

/* ---------- Which models are worth trying ---------- */

/** Model -> until when to skip it. Per process, so a cold start tries everything once. */
const unavailable = new Map<string, number>();
/** Models that rejected a thinking setting; they are called without one from then on. */
const noThinking = new Set<string>();

/** The models still worth trying, in order; all of them again when every one is marked unavailable. */
export function usableModels(models: string[], now = Date.now()): string[] {
  const live = models.filter((model) => (unavailable.get(model) ?? 0) <= now);
  return live.length ? live : models;
}

/** Whether an error means "try the next model": the model is gone (404) or out of quota (429). */
export function isModelUnavailable(error: unknown): error is GeminiError {
  return error instanceof GeminiError && (error.status === 404 || error.status === 429);
}

/** Skips a model for a while: hours when it no longer exists, an hour when its daily quota is spent, else its retry delay. */
export function markUnavailable(model: string, error: GeminiError, now = Date.now()): void {
  const ms = error.status === 404 ? 6 * 3_600_000 : /per ?day|perday|daily/i.test(error.message) ? 3_600_000 : Math.max(60_000, error.retryAfterMs ?? 60_000);
  unavailable.set(model, now + ms);
}

/** Test hook. */
export function resetModelState(): void {
  unavailable.clear();
  noThinking.clear();
}

type Effort = 'none' | 'low';

/**
 * Thinking settings per model family. Thinking tokens count against maxOutputTokens, so a 2.5 Flash answer with
 * default (dynamic) thinking could spend most of its budget thinking and stop mid-sentence. Utility calls turn it off
 * where the model allows; answers get a small, fixed budget.
 */
export function thinkingFor(model: string, effort: Effort): Record<string, unknown> | undefined {
  const name = model.replace(/^models\//, '');
  if (noThinking.has(name)) return undefined;
  if (/^gemini-2\.5-flash/.test(name)) return { thinkingBudget: effort === 'none' ? 0 : 1024 };
  if (/^gemini-2\.5-pro/.test(name)) return { thinkingBudget: effort === 'none' ? 128 : 1024 };
  if (/^gemini-(?:[3-9]|\d\d)/.test(name)) return { thinkingLevel: 'low' };
  return undefined;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
  get retryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY';

interface RequestOptions {
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
  /** False: a 429 is thrown at once (so the caller can move to another model) instead of waited out. Default true. */
  waitOutQuota?: boolean;
}

/** Embeds up to 100 texts in one batchEmbedContents call; vectors are L2-normalised. */
export async function embedTexts(
  cfg: GeminiConfig,
  texts: string[],
  taskType: TaskType,
  options: RequestOptions = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (texts.length > 100) throw new Error('Gemini batchEmbedContents accepts at most 100 texts per call.');
  const model = qualify(cfg.embedModel);
  const body = {
    requests: texts.map((text) => ({
      model,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: cfg.dimensions,
    })),
  };
  const json = await call(cfg, `${model}:batchEmbedContents`, body, options);
  const embeddings = (json as { embeddings?: Array<{ values?: number[] }> }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
    throw new GeminiError(`Gemini returned ${embeddings?.length ?? 0} embeddings for ${texts.length} texts.`, 502);
  }
  return embeddings.map((item, index) => {
    const values = item.values;
    if (!Array.isArray(values) || values.length !== cfg.dimensions) {
      throw new GeminiError(`Embedding ${index} has ${values?.length ?? 0} values; expected ${cfg.dimensions}.`, 502);
    }
    return normalize(Float32Array.from(values));
  });
}

export interface Message {
  role: 'user' | 'model';
  text: string;
}

interface GenerateParams {
  /** One model, or several to try in order (see usableModels). Defaults to the chat model. */
  model?: string | string[];
  /** How much the model may think before answering; thinking tokens count against maxOutputTokens. Default none. */
  thinking?: Effort;
  system?: string;
  messages: Message[];
  temperature?: number;
  maxOutputTokens?: number;
  /** When set, asks for application/json output that matches this schema. */
  responseSchema?: Record<string, unknown>;
}

interface Usage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface GenerateResult {
  text: string;
  usage: Usage;
  finishReason: string;
  model: string;
}

/**
 * One generateContent call. With a list of models, each usable one is tried in turn, moving on when a model is gone or
 * out of quota; the result says which one answered.
 */
export async function generateText(cfg: GeminiConfig, params: GenerateParams, options: RequestOptions = {}): Promise<GenerateResult> {
  const models = Array.isArray(params.model) ? params.model : [params.model ?? cfg.chatModel];
  if (models.length === 1) return generateOnce(cfg, models[0]!, params, options);
  let lastError: unknown;
  for (const model of usableModels(models)) {
    try {
      return await generateOnce(cfg, model, params, { ...options, waitOutQuota: false });
    } catch (error) {
      if (!isModelUnavailable(error)) throw error;
      markUnavailable(model, error);
      lastError = error;
    }
  }
  throw lastError;
}

async function generateOnce(cfg: GeminiConfig, name: string, params: GenerateParams, options: RequestOptions): Promise<GenerateResult> {
  const model = qualify(name);
  const json = (await withThinkingFallback(name, (thinking) => call(cfg, `${model}:generateContent`, requestBody(params, name, thinking), options))) as GenerateResponse;
  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (!text && json.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`, 422);
  }
  return { text, usage: usage(json), finishReason: candidate?.finishReason ?? 'UNKNOWN', model: model.replace(/^models\//, '') };
}

/** Parses a JSON-mode answer; throws a GeminiError when the model returned something unparseable. */
export async function generateJson<T>(cfg: GeminiConfig, params: GenerateParams, options?: RequestOptions): Promise<T> {
  const result = await generateText(cfg, params, options);
  const text = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError(`Gemini returned invalid JSON: ${text.slice(0, 200)}`, 502);
  }
}

interface StreamEvent {
  text?: string;
  usage?: Usage;
  finishReason?: string;
}

/** Streams generation with server-sent events, yielding text deltas and a final usage event. */
export async function* generateStream(
  cfg: GeminiConfig,
  params: GenerateParams,
  options: RequestOptions = {},
): AsyncGenerator<StreamEvent> {
  const name = Array.isArray(params.model) ? params.model[0]! : (params.model ?? cfg.chatModel);
  const model = qualify(name);
  const response = await withThinkingFallback(name, (thinking) => fetchWithRetry(cfg, `${model}:streamGenerateContent?alt=sse`, requestBody(params, name, thinking), options));
  if (!response.body) throw new GeminiError('Gemini returned an empty stream.', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: GenerateResponse | undefined;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json: GenerateResponse;
        try {
          json = JSON.parse(payload) as GenerateResponse;
        } catch {
          continue;
        }
        last = json;
        if (json.error) throw new GeminiError(json.error.message ?? 'Gemini stream error', json.error.code ?? 502);
        const candidate = json.candidates?.[0];
        const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
        if (text) yield { text };
        if (candidate?.finishReason && candidate.finishReason !== 'STOP') yield { finishReason: candidate.finishReason };
        if (!candidate && json.promptFeedback?.blockReason) {
          throw new GeminiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`, 422);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { usage: usage(last ?? {}), finishReason: last?.candidates?.[0]?.finishReason ?? 'STOP' };
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

/** Runs a request with the model's thinking setting, and once more without it if the model rejects that setting. */
async function withThinkingFallback<T>(model: string, run: (thinking: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(true);
  } catch (error) {
    if (!(error instanceof GeminiError) || error.status !== 400 || !/thinking/i.test(error.message) || noThinking.has(model)) throw error;
    console.warn(`[gemini] ${model} rejected its thinking setting; calling it without one.`);
    noThinking.add(model);
    return run(false);
  }
}

function requestBody(params: GenerateParams, model: string, withThinking = true): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: params.temperature ?? 0.3,
    maxOutputTokens: params.maxOutputTokens ?? 2048,
  };
  const thinking = withThinking ? thinkingFor(model, params.thinking ?? 'none') : undefined;
  if (thinking) generationConfig.thinkingConfig = thinking;
  if (params.responseSchema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = params.responseSchema;
  }
  const body: Record<string, unknown> = {
    contents: params.messages.map((message) => ({ role: message.role, parts: [{ text: message.text }] })),
    generationConfig,
  };
  if (params.system) body.systemInstruction = { parts: [{ text: params.system }] };
  return body;
}

function usage(json: GenerateResponse): Usage {
  const meta = json.usageMetadata ?? {};
  return {
    promptTokens: meta.promptTokenCount ?? 0,
    outputTokens: meta.candidatesTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
  };
}

function qualify(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

async function call(cfg: GeminiConfig, path: string, body: unknown, options: RequestOptions): Promise<unknown> {
  const response = await fetchWithRetry(cfg, path, body, options);
  return response.json();
}

async function fetchWithRetry(cfg: GeminiConfig, path: string, body: unknown, options: RequestOptions): Promise<Response> {
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(`${cfg.baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.ok) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        return response;
      }
      const error = await toError(response);
      if (!error.retryable || attempt >= retries || (error.status === 429 && options.waitOutQuota === false)) throw error;
      await sleep(error.retryAfterMs ?? backoff(attempt));
    } catch (thrown) {
      if (thrown instanceof GeminiError) {
        if (!thrown.retryable || attempt >= retries || (thrown.status === 429 && options.waitOutQuota === false)) throw thrown;
        await sleep(thrown.retryAfterMs ?? backoff(attempt));
      } else if (options.signal?.aborted) {
        throw new GeminiError('Request cancelled.', 499);
      } else if (attempt >= retries) {
        throw new GeminiError(`Gemini request failed: ${(thrown as Error).message}`, 503);
      } else {
        await sleep(backoff(attempt));
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    attempt++;
  }
}

async function toError(response: Response): Promise<GeminiError> {
  const text = await response.text();
  let message = text.slice(0, 400);
  let retryAfterMs: number | undefined;
  try {
    const json = JSON.parse(text) as { error?: { message?: string; details?: Array<{ '@type'?: string; retryDelay?: string }> } };
    message = json.error?.message ?? message;
    const delay = json.error?.details?.find((detail) => detail.retryDelay)?.retryDelay;
    if (delay) retryAfterMs = Math.min(60_000, Math.ceil(parseFloat(delay) * 1000));
  } catch {
    // Not JSON; keep the raw snippet.
  }
  const header = response.headers.get('retry-after');
  if (header && !retryAfterMs) retryAfterMs = Math.min(60_000, Number(header) * 1000 || 0) || undefined;
  return new GeminiError(`Gemini ${response.status}: ${message}`, response.status, retryAfterMs);
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt) + Math.random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i]! / magnitude;
  return vector;
}
