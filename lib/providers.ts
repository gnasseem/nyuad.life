/**
 * Backup models over the OpenAI-compatible chat completions API. Each provider whose key is set joins the chain after
 * Gemini, so an overloaded or spent Gemini moves the answer to the next model instead of failing. Free tiers are
 * counted per provider, and mostly per model, so every key and every model adds capacity.
 *
 *   GEMINI_EXTRA_KEYS            more Google AI Studio keys (from other projects), each with its own free quota.
 *   GROQ_API_KEY                 console.groq.com: 1,000 requests and 200,000 tokens a day per model, no card.
 *   CLOUDFLARE_API_TOKEN         Workers AI (with CLOUDFLARE_ACCOUNT_ID): 10,000 free neurons a day, about 90 answers.
 *   NVIDIA_API_KEY               build.nvidia.com: about 40 requests a minute, no card.
 *   ZAI_API_KEY                  z.ai: GLM Flash models free, one request at a time.
 *   OPENROUTER_API_KEY           openrouter.ai, models ending in ":free": 50 requests a day in all (1,000 after $10).
 *   MISTRAL_API_KEY              console.mistral.ai "Experiment" plan.
 *   AI_GATEWAY_API_KEY           Vercel AI Gateway: a monthly free credit.
 *   DEEPSEEK_API_KEY             platform.deepseek.com, paid but cheap: about $0.002 an answer. Last, as the safety net.
 *
 * Any key variable may hold several keys separated by commas: each is a separate free quota, tried in turn.
 * `<PROVIDER>_MODELS` overrides a provider's answer models and `<PROVIDER>_LITE_MODELS` its models for small calls.
 * `ROR_MODEL_ORDER` (default below) sets which goes first; put `deepseek` first to answer on the paid model.
 */
import { discoverGeminiModels, geminiConfig, generateJson, generateText, type GeminiConfig, type Message } from './gemini.ts';

export interface Provider {
  /** Unique per key: "groq", then "groq-2" for a second Groq key. */
  id: string;
  /** Which preset it is, whatever the key: "groq". */
  family: string;
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
  /** Charged per token rather than free, so it is shown as such. */
  paid?: boolean;
}

interface Preset {
  id: string;
  label: string;
  key: string;
  /** The API's base URL; a function when it depends on another variable (Cloudflare's account). Null: not usable. */
  baseUrl: string | ((env: NodeJS.ProcessEnv) => string | null);
  models: string[];
  liteModels: string[];
  maxPromptChars: number;
  maxOutputTokens: number;
  paid?: boolean;
  /** Whether GET /models lists what the key can use; when it does, names it does not list are dropped. */
  listsModels: boolean;
  /** When the provider lists none of the default models (they were renamed), the listed ones to use instead. */
  fallbackPattern?: RegExp;
  /** Request fields a model needs, mostly to keep reasoning short or off so answers start quickly. */
  extra?(model: string): Record<string, unknown>;
}

// Newest and strongest first. Providers rename and retire models often: each one with a /models listing is checked
// against it at runtime (discoverProviderModels), a model that answers 404 is skipped for hours, and the lists can be
// replaced from the environment. Groq retired its Llama models for free keys on 2026-08-16.
const PRESETS: Preset[] = [
  // More AI Studio keys, through Gemini's OpenAI-compatible endpoint: each Google project has its own free quota.
  { id: 'gemini2', label: 'Gemini (extra key)', key: 'GEMINI_EXTRA_KEYS', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-3.5-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'], liteModels: ['gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it'], maxPromptChars: 80_000, maxOutputTokens: 2_000, listsModels: false, extra: (model) => (/^gemini/.test(model) ? { reasoning_effort: 'low' } : {}) },
  { id: 'groq', label: 'Groq', key: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'], liteModels: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-120b'], maxPromptChars: 16_000, maxOutputTokens: 1_400, listsModels: true, fallbackPattern: /gpt-oss|qwen/i, extra: (model) => (/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : /qwen/.test(model) ? { reasoning_effort: 'none' } : {}) },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    key: 'CLOUDFLARE_API_TOKEN',
    baseUrl: (env) => {
      const account = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
      return /^[a-f0-9]{32}$/i.test(account) ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1` : null;
    },
    // Gemma 4 costs about a quarter of the neurons Llama 3.3 did, so the free day lasts about three times longer.
    models: ['@cf/google/gemma-4-26b-a4b-it', '@cf/openai/gpt-oss-120b', '@cf/zai-org/glm-4.7-flash'],
    liteModels: ['@cf/zai-org/glm-4.7-flash', '@cf/google/gemma-4-26b-a4b-it'],
    maxPromptChars: 40_000,
    maxOutputTokens: 1_600,
    listsModels: false,
    extra: (model) => (/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}),
  },
  // NVIDIA's listing names its whole catalogue, not what is hosted for free, so it is not used to drop models.
  { id: 'nvidia', label: 'NVIDIA', key: 'NVIDIA_API_KEY', baseUrl: 'https://integrate.api.nvidia.com/v1', models: ['nvidia/nemotron-3-super-120b-a12b', 'google/gemma-4-31b-it', 'moonshotai/kimi-k2.6'], liteModels: ['nvidia/nemotron-3.5-lightning-30b-a3b', 'openai/gpt-oss-20b'], maxPromptChars: 60_000, maxOutputTokens: 2_000, listsModels: false, extra: (model) => (/nemotron/.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}) },
  { id: 'zai', label: 'Z.ai', key: 'ZAI_API_KEY', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-4.7-flash'], liteModels: ['glm-4.5-flash', 'glm-4.7-flash'], maxPromptChars: 60_000, maxOutputTokens: 2_000, listsModels: false, extra: () => ({ thinking: { type: 'disabled' } }) },
  { id: 'openrouter', label: 'OpenRouter', key: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', models: ['nvidia/nemotron-3-super-120b-a12b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free'], liteModels: ['google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3-super-120b-a12b:free'], maxPromptChars: 60_000, maxOutputTokens: 2_000, listsModels: true, fallbackPattern: /:free$/, extra: (model) => (/gpt-oss|nemotron|inkling/.test(model) ? { reasoning: { effort: 'low', exclude: true } } : {}) },
  { id: 'mistral', label: 'Mistral', key: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-medium-latest', 'mistral-small-latest'], liteModels: ['mistral-small-latest'], maxPromptChars: 60_000, maxOutputTokens: 2_000, listsModels: true, fallbackPattern: /^mistral-(medium|small)/i },
  { id: 'gateway', label: 'Vercel AI Gateway', key: 'AI_GATEWAY_API_KEY', baseUrl: 'https://ai-gateway.vercel.sh/v1', models: ['openai/gpt-oss-120b', 'google/gemma-4-31b-it'], liteModels: ['openai/gpt-oss-20b'], maxPromptChars: 80_000, maxOutputTokens: 2_000, listsModels: false, extra: (model) => (/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {}) },
  // DeepSeek V4.1 Flash: about $0.15 per million tokens in and $0.60 out off-peak (double at peak), so an answer costs
  // about a fifth of a cent. "deepseek-chat" was retired in July 2026.
  { id: 'deepseek', label: 'DeepSeek', key: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash', 'deepseek-v4-flash'], liteModels: ['deepseek-flash', 'deepseek-v4-flash'], maxPromptChars: 80_000, maxOutputTokens: 2_000, paid: true, listsModels: true, fallbackPattern: /flash|chat/i },
];

export const DEFAULT_ORDER = ['gemini', 'gemini2', 'groq', 'cloudflare', 'nvidia', 'zai', 'openrouter', 'mistral', 'gateway', 'deepseek'];
const ALL_IDS = ['gemini', ...PRESETS.map((preset) => preset.id)];

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

/* ---------- What each key can use ---------- */

/** Provider id -> the model ids its /models listed, when last asked (null when that failed). */
const listed = new Map<string, { at: number; models: Set<string> | null; pending?: Promise<void> }>();
const LISTING_TTL_MS = 6 * 3_600_000;
const LISTING_RETRY_MS = 10 * 60_000;

/**
 * A preset's models narrowed to the ones the provider lists. When it lists none of them (renamed again), the listed
 * models that look like the right family stand in; when the listing is unknown or matches nothing, the list stands.
 */
export function refineModels(models: string[], available: Set<string> | null | undefined, pattern?: RegExp): string[] {
  if (!available || available.size === 0) return models;
  const kept = models.filter((model) => available.has(model));
  if (kept.length) return kept;
  const alike = pattern ? [...available].filter((model) => pattern.test(model)).sort().reverse().slice(0, 3) : [];
  return alike.length ? alike : models;
}

/**
 * Asks each provider that has a model listing which models its key can use, at most every few hours per instance,
 * waiting up to `waitMs`; providersFromEnv() uses the answers from then on.
 */
export async function discoverProviderModels(providers: Provider[] = providersFromEnv(), waitMs = 2_500): Promise<void> {
  if (process.env.VITEST || process.env.ROR_MODEL_DISCOVERY === '0') return;
  const waits: Array<Promise<void>> = [];
  for (const provider of providers) {
    const preset = PRESETS.find((entry) => entry.id === provider.family);
    if (!preset?.listsModels) continue;
    const entry = listed.get(provider.id);
    if (entry?.pending) {
      waits.push(entry.pending);
      continue;
    }
    if (entry && Date.now() - entry.at < (entry.models ? LISTING_TTL_MS : LISTING_RETRY_MS)) continue;
    const pending = fetch(`${provider.baseUrl}/models`, { headers: { authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(6_000) })
      .then(async (response) => {
        if (!response.ok) throw await toError(provider, response);
        const json = (await response.json()) as { data?: Array<{ id?: string }> };
        listed.set(provider.id, { at: Date.now(), models: new Set((json.data ?? []).map((model) => String(model.id ?? '')).filter(Boolean)) });
      })
      .catch((error: unknown) => {
        if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) console.error(`[models] ${provider.label} refused the key (${error.status}); check ${preset.key}.`);
        else console.warn(`[models] could not list ${provider.label} models:`, (error as Error).message);
        listed.set(provider.id, { at: Date.now(), models: entry?.models ?? null });
      });
    listed.set(provider.id, { at: entry?.at ?? 0, models: entry?.models ?? null, pending });
    waits.push(pending);
  }
  if (waits.length) await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())]);
}

/** Test hook. */
export function resetProviderListings(): void {
  listed.clear();
}

/**
 * Brings every model list up to date with what the keys can use (Gemini's and each provider's listing), waiting up to
 * `waitMs`. Cheap after the first call on an instance; call it before geminiConfig() and providersFromEnv().
 */
export async function warmModels(waitMs = 2_500): Promise<void> {
  await Promise.all([discoverGeminiModels(geminiConfig(), waitMs), discoverProviderModels(providersFromEnv(), waitMs)]);
}

/** The order to try writers in: `gemini` and the provider ids, from ROR_MODEL_ORDER, with any left out appended. */
export function modelOrder(env: NodeJS.ProcessEnv = process.env): string[] {
  const chosen = list(env.ROR_MODEL_ORDER, DEFAULT_ORDER)
    .map((id) => id.toLowerCase())
    .filter((id) => ALL_IDS.includes(id));
  return [...new Set([...chosen, ...DEFAULT_ORDER])];
}

/** Every provider with a key set, one per key, in the configured order. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const order = modelOrder(env);
  return PRESETS.flatMap((preset): Provider[] => {
    if (!order.includes(preset.id)) return [];
    const keys = [...new Set((env[preset.key] ?? '').split(/[\s,]+/).map((key) => key.trim()).filter(Boolean))];
    if (!keys.length) return [];
    const upper = preset.id.toUpperCase();
    const baseUrl = env[`${upper}_BASE_URL`] ?? (typeof preset.baseUrl === 'function' ? preset.baseUrl(env) : preset.baseUrl);
    if (!baseUrl) return [];
    // Lists set in the environment are taken as written; the built-in ones are checked against the first key's listing.
    const available = listed.get(preset.id)?.models;
    const models = env[`${upper}_MODELS`] ? list(env[`${upper}_MODELS`], preset.models) : refineModels(preset.models, available, preset.fallbackPattern);
    const liteModels = env[`${upper}_LITE_MODELS`] ? list(env[`${upper}_LITE_MODELS`], preset.liteModels) : refineModels(preset.liteModels, available, preset.fallbackPattern);
    return keys.map((apiKey, i) => ({
      id: i === 0 ? preset.id : `${preset.id}-${i + 1}`,
      family: preset.id,
      label: i === 0 ? preset.label : `${preset.label} ${i + 1}`,
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      apiKey,
      models,
      liteModels,
      maxPromptChars: preset.maxPromptChars,
      maxOutputTokens: preset.maxOutputTokens,
      ...(preset.paid ? { paid: true } : {}),
    }));
  }).sort((a, b) => order.indexOf(a.family) - order.indexOf(b.family));
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
    console.error(`[models] ${provider.label} refused the key (${status}); check ${PRESETS.find((preset) => preset.id === provider.family)?.key ?? provider.family}.`);
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
  if (noReasoning.has(`${provider.id}:${model}`)) return {};
  return PRESETS.find((preset) => preset.id === provider.family)?.extra?.(model) ?? {};
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
  if (failure.status === 400 && /reasoning|thinking|chat_template|unrecognized|unknown (?:field|parameter)/i.test(failure.message) && Object.keys(reasoning(provider, model)).length) {
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
  const signal = params.signal ?? AbortSignal.timeout(params.timeoutMs ?? 12_000);
  const size = params.system.length + params.messages.reduce((sum, message) => sum + message.text.length, 0);
  let lastError: unknown = new ProviderError('No backup model is set up.', 503);
  for (const provider of providers) {
    // A prompt over this provider's per-request limit would only be refused (Groq's free tier, for long ones).
    if (size > provider.maxPromptChars) continue;
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
  // One deadline for the whole chain, so falling back from model to model cannot outlast the function's time limit.
  const signal = AbortSignal.timeout(params.timeoutMs ?? 15_000);
  // The lists this call got were built before the instance knew what the keys can use; the next calls will.
  void warmModels(0).catch(() => undefined);
  const viaGemini = async () => {
    const cfg = gemini!;
    const model = params.tier === 'main' ? [cfg.chatModel, ...cfg.chatFallbacks] : cfg.liteModels;
    return generateJson<T>(cfg, { model, system: params.system, messages: [{ role: 'user', text: params.prompt }], responseSchema: params.schema, temperature, maxOutputTokens }, { retries: 0, signal, timeoutMs: params.timeoutMs ?? 15_000 });
  };
  const viaBackups = async () => {
    const text = await liteChat(backups, { system: `${params.system}\nReply with one JSON object and nothing else.`, messages: [{ role: 'user', text: params.prompt }], json: true, temperature, maxOutputTokens, signal, tier: params.tier });
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')) as T;
  };
  const steps = [gemini ? viaGemini : null, backups.length ? viaBackups : null].filter((step): step is () => Promise<T> => step !== null);
  if (modelOrder().indexOf('gemini') > 0) steps.reverse();
  let lastError: unknown = new ProviderError('No model is set up.', 503);
  for (const step of steps) {
    if (signal.aborted) break;
    try {
      return await step();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/* ---------- For admins: which models answer right now ---------- */

export interface ModelCheck {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  paid?: boolean;
}

/**
 * Sends one tiny request to every model the site can use and says which answered and what the others said: the
 * quickest way to tell a wrong key from a spent quota from a retired model. Costs one request per model.
 */
export async function checkModels(gemini: GeminiConfig | null, backups: Provider[]): Promise<ModelCheck[]> {
  const ask: Message[] = [{ role: 'user', text: 'Reply with the word OK.' }];
  const jobs: Array<{ name: string; paid?: boolean; run(signal: AbortSignal): Promise<unknown> }> = [];
  if (gemini) {
    for (const model of new Set([gemini.chatModel, ...gemini.chatFallbacks, ...gemini.liteModels])) {
      jobs.push({ name: `gemini:${model}`, run: (signal) => generateText(gemini, { model, messages: ask, maxOutputTokens: 64 }, { retries: 0, signal, timeoutMs: 15_000, waitOutQuota: false }) });
    }
  }
  for (const provider of backups) {
    for (const model of new Set([...provider.models, ...provider.liteModels])) {
      jobs.push({ name: `${provider.id}:${model}`, paid: provider.paid, run: (signal) => post(provider, model, { system: 'Be brief.', messages: ask, maxOutputTokens: 64, signal }, false).then((response) => response.json()) });
    }
  }
  return Promise.all(
    jobs.map(async (job): Promise<ModelCheck> => {
      const started = Date.now();
      const paid = job.paid ? { paid: true } : {};
      try {
        await job.run(AbortSignal.timeout(15_000));
        return { name: job.name, ok: true, ms: Date.now() - started, ...paid };
      } catch (error) {
        return { name: job.name, ok: false, ms: Date.now() - started, error: String((error as Error).message ?? error).slice(0, 240), ...paid };
      }
    }),
  );
}
