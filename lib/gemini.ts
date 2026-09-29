/**
 * Minimal Gemini Developer API client over fetch (no SDK), covering the three calls this app needs:
 * batch embeddings, JSON-mode generation and SSE streaming generation. Retries 429/5xx with backoff.
 */

export interface GeminiConfig {
  apiKey: string;
  baseUrl: string;
  embedModel: string;
  chatModel: string;
  liteModel: string;
  dimensions: number;
}

export const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';
export const DEFAULT_CHAT_MODEL = 'gemini-flash-latest';
export const DEFAULT_LITE_MODEL = 'gemini-flash-lite-latest';
export const DEFAULT_DIMENSIONS = 768;

/** Reads GEMINI_API_KEY and the optional model overrides; returns null when no key is configured. */
export function geminiConfig(env: NodeJS.ProcessEnv = process.env): GeminiConfig | null {
  const apiKey = (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
    embedModel: env.GEMINI_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL,
    chatModel: env.GEMINI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL,
    liteModel: env.GEMINI_LITE_MODEL?.trim() || DEFAULT_LITE_MODEL,
    dimensions: Number(env.GEMINI_EMBED_DIMENSIONS) || DEFAULT_DIMENSIONS,
  };
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

export type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY';

export interface RequestOptions {
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
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

export async function embedQuery(cfg: GeminiConfig, text: string, options?: RequestOptions): Promise<Float32Array> {
  const [vector] = await embedTexts(cfg, [text], 'RETRIEVAL_QUERY', options);
  return vector!;
}

export interface Message {
  role: 'user' | 'model';
  text: string;
}

export interface GenerateParams {
  model?: string;
  system?: string;
  messages: Message[];
  temperature?: number;
  maxOutputTokens?: number;
  /** When set, asks for application/json output that matches this schema. */
  responseSchema?: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerateResult {
  text: string;
  usage: Usage;
  finishReason: string;
  model: string;
}

export async function generateText(cfg: GeminiConfig, params: GenerateParams, options: RequestOptions = {}): Promise<GenerateResult> {
  const model = qualify(params.model ?? cfg.chatModel);
  const json = (await call(cfg, `${model}:generateContent`, requestBody(params), options)) as GenerateResponse;
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

export interface StreamEvent {
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
  const model = qualify(params.model ?? cfg.chatModel);
  const response = await fetchWithRetry(cfg, `${model}:streamGenerateContent?alt=sse`, requestBody(params), options);
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

function requestBody(params: GenerateParams): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    temperature: params.temperature ?? 0.3,
    maxOutputTokens: params.maxOutputTokens ?? 2048,
  };
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
      if (!error.retryable || attempt >= retries) throw error;
      await sleep(error.retryAfterMs ?? backoff(attempt));
    } catch (thrown) {
      if (thrown instanceof GeminiError) {
        if (!thrown.retryable || attempt >= retries) throw thrown;
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
