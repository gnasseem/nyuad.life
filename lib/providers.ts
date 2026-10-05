/**
 * Backup models with free tiers, over the OpenAI-compatible chat completions API. Each provider whose key is set joins
 * the chain after Gemini, so an overloaded or spent Gemini moves the answer to the next model instead of failing. Free
 * tiers are counted per provider, and mostly per model, so every key and every model adds capacity.
 *
 *   GROQ_API_KEY         console.groq.com: about 1,000 requests a day per model, no card.
 *   MISTRAL_API_KEY      console.mistral.ai, free "Experiment" plan: generous monthly tokens, phone check.
 *   OPENROUTER_API_KEY   openrouter.ai, models ending in ":free": 50 requests a day without paying anything.
 *
 * `<PROVIDER>_MODELS` overrides a provider's answer models and `<PROVIDER>_LITE_MODELS` its models for small calls.
 * `ROR_MODEL_ORDER` (default `gemini,groq,mistral,openrouter`) sets which goes first.
 */
import { generateJson, type GeminiConfig, type Message } from './gemini.ts';

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  /** Models that write answers, tried in order. */
  models: string[];
  /** Models for follow-ups and query rewrites, tried in order. */
  liteModels: string[];
  /**
   * The most prompt, in characters, one request may carry. Groq's free tier caps tokens per minute at about 8,000,
   * so the sources are cut down to fit rather than the request being refused.
   */
  maxPromptChars: number;
  maxOutputTokens: number;
}

interface Preset {
  id: string;
  label: string;
  key: string;
  baseUrl: string;
  models: string[];
  liteModels: string[];
  maxPromptChars: number;
  maxOutputTokens: number;
}

// Newest and strongest first. Providers rename and retire free models often; a model that answers 404 is skipped for
// hours, so a stale name costs one request, and the lists can be replaced from the environment.
const PRESETS: Preset[] = [
  { id: 'groq', label: 'Groq', key: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'], liteModels: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant'], maxPromptChars: 20_000, maxOutputTokens: 1_600 },
  { id: 'mistral', label: 'Mistral', key: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-medium-latest', 'mistral-small-latest'], liteModels: ['mistral-small-latest'], maxPromptChars: 60_000, maxOutputTokens: 2_000 },
  { id: 'openrouter', label: 'OpenRouter', key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-26b-a4b-it:free'], liteModels: ['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'], maxPromptChars: 60_000, maxOutputTokens: 2_000 },
];

export const DEFAULT_ORDER = ['gemini', ...PRESETS.map((preset) => preset.id)];

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

/** The order to try writers in: `gemini` and the provider ids, from ROR_MODEL_ORDER, with any left out appended. */
export function modelOrder(env: NodeJS.ProcessEnv = process.env): string[] {
  const chosen = list(env.ROR_MODEL_ORDER, DEFAULT_ORDER)
    .map((id) => id.toLowerCase())
    .filter((id) => DEFAULT_ORDER.includes(id));
  return [...new Set([...chosen, ...DEFAULT_ORDER])];
}

/** Every provider with a key set, in the configured order. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const order = modelOrder(env);
  return PRESETS.map((preset): Provider | null => {
    const apiKey = (env[preset.key] ?? '').trim();
    if (!apiKey) return null;
    const upper = preset.id.toUpperCase();
    return {
      id: preset.id,
      label: preset.label,
      baseUrl: (env[`${upper}_BASE_URL`] ?? preset.baseUrl).trim().replace(/\/+$/, ''),
      apiKey,
      models: list(env[`${upper}_MODELS`], preset.models),
      liteModels: list(env[`${upper}_LITE_MODELS`], preset.liteModels),
      maxPromptChars: preset.maxPromptChars,
      maxOutputTokens: preset.maxOutputTokens,
    };
  })
    .filter((provider): provider is Provider => provider !== null)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/* ---------- Which models are worth trying ---------- */

/** `provider:model` (or `provider:*` for the whole provider) -> until when to skip it. */
const unavailable = new Map<string, number>();
/** Models that rejected the reasoning setting; called without it from then on. */
const noReasoning = new Set<string>();

export function usable(provider: Provider, models: string[], now = Date.now()): string[] {
  if ((unavailable.get(`${provider.id}:*`) ?? 0) > now) return [];
  return models.filter((model) => (unavailable.get(`${provider.id}:${model}`) ?? 0) <= now);
}

/**
 * Skips a model, or the whole provider, for a while after a failure: hours when the model is gone, an hour when the
 * key is refused or the day's quota is spent, a minute for overload and rate limits (or what the provider asks for).
 * A request too large for this model's limit is not held against it.
 */
export function markFailed(provider: Provider, model: string, error: unknown, now = Date.now()): void {
  if (!(error instanceof ProviderError)) return void unavailable.set(`${provider.id}:${model}`, now + 30_000);
  const { status } = error;
  if (status === 401 || status === 403) {
    console.error(`[models] ${provider.label} refused the key (${status}); check ${provider.id.toUpperCase()}_API_KEY.`);
    unavailable.set(`${provider.id}:*`, now + 3_600_000);
  } else if (status === 404 || (status === 400 && /model/i.test(error.message) && /not|exist|decommission|deprecat|support|invalid/i.test(error.message))) {
    unavailable.set(`${provider.id}:${model}`, now + 6 * 3_600_000);
  } else if (status === 413) {
    return;
  } else if (status === 429 && /per ?day|daily|tokens per day|requests per day|\bRPD\b|\bTPD\b/i.test(error.message)) {
    unavailable.set(`${provider.id}:${model}`, now + 3_600_000);
  } else {
    unavailable.set(`${provider.id}:${model}`, now + Math.max(10_000, Math.min(error.retryAfterMs ?? 60_000, 10 * 60_000)));
  }
}

/** Test hook. */
export function resetProviderState(): void {
  unavailable.clear();
  noReasoning.clear();
}

/* ---------- Calls ---------- */

interface ChatParams {
  system: string;
  messages: Message[];
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Ask for a JSON object back (small calls only). */
  json?: boolean;
}

export interface ChatEvent {
  text?: string;
  /** The model stopped at its token limit. */
  truncated?: boolean;
}

/** Reasoning models think before they answer; a little is enough here and keeps answers fast. */
function reasoning(provider: Provider, model: string): Record<string, unknown> {
  const key = `${provider.id}:${model}`;
  if (noReasoning.has(key) || !/gpt-oss/i.test(model)) return {};
  return provider.id === 'openrouter' ? { reasoning: { effort: 'low', exclude: true } } : { reasoning_effort: 'low' };
}

function body(provider: Provider, model: string, params: ChatParams, stream: boolean, withReasoning: boolean): string {
  return JSON.stringify({
    model,
    messages: [{ role: 'system', content: params.system }, ...params.messages.map((message) => ({ role: message.role === 'model' ? 'assistant' : 'user', content: message.text }))],
    stream,
    temperature: params.temperature ?? 0.3,
    max_tokens: Math.min(params.maxOutputTokens ?? provider.maxOutputTokens, provider.maxOutputTokens),
    ...(params.json ? { response_format: { type: 'json_object' } } : {}),
    ...(withReasoning ? reasoning(provider, model) : {}),
  });
}

async function post(provider: Provider, model: string, params: ChatParams, stream: boolean): Promise<Response> {
  const send = (withReasoning: boolean) =>
    fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.apiKey}`,
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        // OpenRouter shows these on its dashboard; others ignore them.
        'x-title': 'nyuad.life',
        'http-referer': process.env.ROR_SITE_URL || 'https://nyuad.life',
      },
      body: body(provider, model, params, stream, withReasoning),
      signal: params.signal,
    });
  let response: Response;
  try {
    response = await send(true);
  } catch (error) {
    if (params.signal?.aborted) throw new ProviderError('Request cancelled.', 499);
    throw new ProviderError(`${provider.label} could not be reached: ${(error as Error).message}`, 503);
  }
  if (response.ok) return response;
  let failure = await toError(provider, response);
  // A model that does not take the reasoning setting is called once more without it, and without it from then on.
  if (failure.status === 400 && /reasoning/i.test(failure.message) && Object.keys(reasoning(provider, model)).length) {
    noReasoning.add(`${provider.id}:${model}`);
    response = await send(false);
    if (response.ok) return response;
    failure = await toError(provider, response);
  }
  throw failure;
}

async function toError(provider: Provider, response: Response): Promise<ProviderError> {
  const text = await response.text().catch(() => '');
  let message = text.slice(0, 300);
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    message = (typeof json.error === 'string' ? json.error : json.error?.message) ?? json.message ?? message;
  } catch {
    // not JSON
  }
  const header = Number(response.headers.get('retry-after'));
  return new ProviderError(`${provider.label} ${response.status}: ${message}`, response.status, header > 0 ? Math.min(600_000, header * 1000) : undefined);
}

/** Streams one answer from one model, yielding text as it arrives. Thinking a model writes inline is left out. */
export async function* streamChat(provider: Provider, model: string, params: ChatParams): AsyncGenerator<ChatEvent> {
  const response = await post(provider, model, params, true);
  if (!response.body) throw new ProviderError(`${provider.label} returned an empty stream.`, 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const thoughts = new ThinkFilter();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event: { choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>; error?: { message?: string; code?: number | string } };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.error) throw new ProviderError(`${provider.label}: ${event.error.message ?? 'stream error'}`, typeof event.error.code === 'number' ? event.error.code : 502);
        const choice = event.choices?.[0];
        const text = thoughts.push(choice?.delta?.content ?? '');
        if (text) yield { text };
        if (choice?.finish_reason === 'length') yield { truncated: true };
      }
    }
    const rest = thoughts.flush();
    if (rest) yield { text: rest };
  } finally {
    reader.releaseLock();
  }
}

/**
 * A short whole answer (a query rewrite, a moderation verdict) from the first provider and model that can give one.
 * `tier: 'main'` uses the providers' answer models, for work that needs more judgement than a rewrite.
 */
export async function liteChat(providers: Provider[], params: ChatParams & { timeoutMs?: number; tier?: 'lite' | 'main' }): Promise<string> {
  const signal = AbortSignal.timeout(params.timeoutMs ?? 12_000);
  let lastError: unknown = new ProviderError('No backup model is set up.', 503);
  for (const provider of providers) {
    for (const model of usable(provider, params.tier === 'main' ? provider.models : provider.liteModels)) {
      try {
        const response = await post(provider, model, { ...params, signal }, false);
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const filter = new ThinkFilter();
        const text = filter.push(json.choices?.[0]?.message?.content ?? '') + filter.flush();
        if (text.trim()) return text;
      } catch (error) {
        if (signal.aborted) throw error;
        markFailed(provider, model, error);
        lastError = error;
      }
    }
  }
  throw lastError;
}

/**
 * Drops `<think>…</think>` blocks that some open models (Qwen, DeepSeek) write into the answer itself, even when the
 * tags arrive split across stream chunks.
 */
export class ThinkFilter {
  private inside = false;
  private pending = '';
  /** Just past a closing tag: the blank lines after it are dropped too. */
  private trimStart = false;

  push(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = '';
    let out = '';
    while (text) {
      if (this.inside) {
        const end = text.indexOf('</think>');
        if (end < 0) {
          this.pending = text.slice(-7);
          break;
        }
        text = text.slice(end + 8);
        this.inside = false;
        this.trimStart = true;
        continue;
      }
      const start = text.indexOf('<think>');
      if (start >= 0) {
        out += this.emit(text.slice(0, start));
        text = text.slice(start + 7);
        this.inside = true;
        continue;
      }
      // Hold back what could be the start of a tag split across chunks.
      const partial = partialTag(text);
      out += this.emit(text.slice(0, text.length - partial));
      this.pending = text.slice(text.length - partial);
      break;
    }
    return out;
  }

  /** What is left at the end of the stream. */
  flush(): string {
    const rest = this.inside ? '' : this.emit(this.pending);
    this.pending = '';
    return rest;
  }

  private emit(text: string): string {
    if (!this.trimStart) return text;
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed) this.trimStart = false;
    return trimmed;
  }
}

function partialTag(text: string): number {
  for (let n = Math.min(6, text.length); n > 0; n--) if ('<think>'.startsWith(text.slice(-n))) return n;
  return 0;
}

/**
 * A JSON object from the site's own models: Gemini (lite models, or the answer models for `tier: 'main'`) with the
 * schema, then the backups in JSON mode, or the other way round per ROR_MODEL_ORDER. Throws when none gives valid JSON.
 */
export async function siteJson<T>(
  gemini: GeminiConfig | null,
  backups: Provider[],
  params: { system: string; prompt: string; schema: Record<string, unknown>; tier?: 'lite' | 'main'; maxOutputTokens?: number; temperature?: number; timeoutMs?: number },
): Promise<T> {
  const temperature = params.temperature ?? 0;
  const maxOutputTokens = params.maxOutputTokens ?? 1024;
  const viaGemini = async () => {
    const cfg = gemini!;
    const model = params.tier === 'main' ? [cfg.chatModel, ...cfg.chatFallbacks] : cfg.liteModels;
    return generateJson<T>(cfg, { model, system: params.system, messages: [{ role: 'user', text: params.prompt }], responseSchema: params.schema, temperature, maxOutputTokens }, { retries: 0, timeoutMs: params.timeoutMs ?? 15_000 });
  };
  const viaBackups = async () => {
    const text = await liteChat(backups, { system: `${params.system}\nReply with one JSON object and nothing else.`, messages: [{ role: 'user', text: params.prompt }], json: true, temperature, maxOutputTokens, timeoutMs: params.timeoutMs, tier: params.tier });
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')) as T;
  };
  const steps = [gemini ? viaGemini : null, backups.length ? viaBackups : null].filter((step): step is () => Promise<T> => step !== null);
  if (modelOrder().indexOf('gemini') > 0) steps.reverse();
  let lastError: unknown = new ProviderError('No model is set up.', 503);
  for (const step of steps) {
    try {
      return await step();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
