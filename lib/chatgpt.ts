/**
 * Sign in with ChatGPT: a student connects their own ChatGPT plan (Plus, Pro, Edu…) and their answers run on it,
 * counted against that plan's limits instead of the site's model quota. OpenAI's Sign in with ChatGPT is a public
 * OAuth client with PKCE; the access token it issues is used directly as the bearer for api.openai.com/v1/responses.
 *
 *   OPENAI_CLIENT_ID       the client ID OpenAI issued to this site (oaiapp_…). Without it the feature is off.
 *   SESSION_SECRET         32+ random characters; encrypts the tokens kept in the student's cookie.
 *   ROR_SITE_URL           the public origin, e.g. https://nyuad.life, so the redirect URI matches the registered one.
 *   OPENAI_CLIENT_SECRET   only if OpenAI issued one; public clients have none.
 *
 * Tokens never reach the browser's JavaScript: they live in an encrypted, httpOnly cookie, split across a few cookies
 * when they are long. Requests with a plan token must not carry `temperature` or `max_output_tokens`, which it rejects.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const RESOURCE = 'https://api.openai.com/v1';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const CALLBACK_PATH = '/api/chatgpt-callback';

// Newest first; a model the plan cannot use is skipped for the rest of the process (see the fallback in rag.ts).
const DEFAULT_CHAT_MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5'];
const DEFAULT_LITE_MODELS = ['gpt-6-luna', 'gpt-5.4-mini'];
// Refresh this long before the real expiry, so a request never starts with a token about to lapse.
const EXPIRY_MARGIN_MS = 3 * 60_000;

export interface ChatGPTConfig {
  clientId: string;
  clientSecret: string;
  key: Buffer;
  siteUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  chatModels: string[];
  liteModels: string[];
  /** Ask only answers students who connected ChatGPT; the site's Gemini key is not used for answers. */
  required: boolean;
}

function list(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

/** The feature's settings, or null when it is not set up (no client ID, or no secret to encrypt sessions with). */
export function chatgptConfig(env: NodeJS.ProcessEnv = process.env): ChatGPTConfig | null {
  const clientId = (env.OPENAI_CLIENT_ID ?? '').trim();
  const secret = (env.SESSION_SECRET ?? '').trim();
  if (!clientId || secret.length < 32) return null;
  return {
    clientId,
    clientSecret: (env.OPENAI_CLIENT_SECRET ?? '').trim(),
    key: createHash('sha256').update(`ror-chatgpt-session:${secret}`).digest(),
    siteUrl: (env.ROR_SITE_URL ?? '').trim().replace(/\/+$/, ''),
    authorizeUrl: (env.OPENAI_AUTHORIZE_URL ?? AUTHORIZE_URL).trim(),
    tokenUrl: (env.OPENAI_TOKEN_URL ?? TOKEN_URL).trim(),
    apiBase: (env.OPENAI_API_BASE ?? RESOURCE).trim().replace(/\/+$/, ''),
    chatModels: list(env.OPENAI_CHAT_MODELS, DEFAULT_CHAT_MODELS),
    liteModels: list(env.OPENAI_LITE_MODELS, DEFAULT_LITE_MODELS),
    required: env.ROR_REQUIRE_CHATGPT === '1' || env.ROR_REQUIRE_CHATGPT === 'true',
  };
}

/* ---------- Sealed cookies ---------- */

/** AES-256-GCM, base64url: the cookie cannot be read or altered without SESSION_SECRET. */
export function seal(key: Buffer, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function unseal<T>(key: Buffer, sealed: string): T | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 29) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function readCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    // Other cookies on the domain can be anything ("promo=50%off"); one that does not decode must not break the request.
    try {
      out.set(part.slice(0, eq).trim(), decodeURIComponent(part.slice(eq + 1).trim()));
    } catch {
      continue;
    }
  }
  return out;
}

function secure(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  return proto === 'https' || (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
}

function cookie(req: IncomingMessage, name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure(req) ? '; Secure' : ''}`;
}

/** Appends Set-Cookie lines without dropping ones already set on the response. */
export function addCookies(res: ServerResponse, lines: string[]): void {
  const existing = res.getHeader('set-cookie');
  const before = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
  res.setHeader('set-cookie', [...before, ...lines]);
}

const SESSION_COOKIE = 'ror_cg';
const LOGIN_COOKIE = 'ror_cg_login';
const CHUNK = 3800;
const MAX_CHUNKS = 4;
const SESSION_DAYS = 30;

export interface ChatGPTSession {
  access: string;
  refresh: string;
  /** When to refresh, in ms since the epoch (a few minutes before the token really expires). */
  expires: number;
  name: string;
  email: string;
  /** The plan the ID token names (plus, pro, edu…), when it names one. */
  plan: string;
}

export function readSession(cfg: ChatGPTConfig, req: IncomingMessage): ChatGPTSession | null {
  const cookies = readCookies(req);
  let sealed = '';
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const part = cookies.get(`${SESSION_COOKIE}${i}`);
    if (part === undefined) break;
    sealed += part;
  }
  if (!sealed) return null;
  const session = unseal<ChatGPTSession>(cfg.key, sealed);
  return session && typeof session.access === 'string' && typeof session.refresh === 'string' ? session : null;
}

/** The session as Set-Cookie lines, split so no cookie passes the browsers' 4 KB limit; null clears it. */
export function sessionCookies(cfg: ChatGPTConfig, req: IncomingMessage, session: ChatGPTSession | null): string[] {
  const sealed = session ? seal(cfg.key, session) : '';
  const parts = sealed ? (sealed.match(new RegExp(`.{1,${CHUNK}}`, 'g')) ?? []) : [];
  if (parts.length > MAX_CHUNKS) throw new Error('The ChatGPT session is too large to keep in cookies.');
  const lines = parts.map((part, i) => cookie(req, `${SESSION_COOKIE}${i}`, part, SESSION_DAYS * 86_400));
  for (let i = parts.length; i < MAX_CHUNKS; i++) {
    if (readCookies(req).has(`${SESSION_COOKIE}${i}`) || !session) lines.push(cookie(req, `${SESSION_COOKIE}${i}`, '', 0));
  }
  return lines;
}

/* ---------- The sign-in ---------- */

interface PendingLogin {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
  redirectUri: string;
  at: number;
}

/** The public origin: ROR_SITE_URL when set (it must match the redirect URI registered with OpenAI), else the request's. */
export function siteOrigin(cfg: ChatGPTConfig, req: IncomingMessage): string {
  if (cfg.siteUrl) return cfg.siteUrl;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0]!.trim();
  return `${secure(req) ? 'https' : 'http'}://${host}`;
}

/**
 * Only paths on this site: a login must not be usable to bounce someone to another domain. The path is judged after
 * the browser would normalise it, since "/.//evil.example" becomes "//evil.example", which leaves the site.
 */
export function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.length > 300) return '/';
  let url: URL;
  try {
    url = new URL(value, 'http://site');
  } catch {
    return '/';
  }
  if (url.origin !== 'http://site' || url.pathname.startsWith('//') || url.pathname.includes('\\')) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Starts a sign-in: remembers the PKCE verifier, state and nonce in a short-lived sealed cookie and returns the URL. */
export function beginLogin(cfg: ChatGPTConfig, req: IncomingMessage, returnTo: string): { url: string; cookie: string } {
  const verifier = randomBytes(32).toString('base64url');
  const pending: PendingLogin = {
    verifier,
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    returnTo: safeReturnTo(returnTo),
    redirectUri: `${siteOrigin(cfg, req)}${CALLBACK_PATH}`,
    at: Date.now(),
  };
  const url = new URL(cfg.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: pending.redirectUri,
    resource: RESOURCE,
    scope: SCOPE,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), cookie: cookie(req, LOGIN_COOKIE, seal(cfg.key, pending), 600) };
}

export class ChatGPTError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = 'chatgpt_error',
  ) {
    super(message);
    this.name = 'ChatGPTError';
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
}

async function requestToken(cfg: ChatGPTConfig, params: Record<string, string>): Promise<TokenResponse> {
  const body = new URLSearchParams({ ...params, client_id: cfg.clientId, resource: RESOURCE, ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}) });
  const response = await fetch(cfg.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) throw new ChatGPTError(`ChatGPT sign-in failed (${response.status}): ${text.slice(0, 200)}`, response.status === 400 || response.status === 401 ? 401 : 502, 'chatgpt_token');
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new ChatGPTError('ChatGPT sign-in returned something that is not JSON.', 502, 'chatgpt_token');
  }
}

/** The ID token's claims. It came straight from the token endpoint over TLS, so its signature is not re-checked. */
export function idTokenClaims(idToken: unknown): Record<string, unknown> {
  if (typeof idToken !== 'string') return {};
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sessionFrom(token: TokenResponse, previous?: ChatGPTSession, nonce?: string): ChatGPTSession {
  const scopes = String(token.scope ?? '').split(/\s+/);
  if (!scopes.includes(PLAN_SCOPE)) throw new ChatGPTError('ChatGPT did not grant use of your plan. Sign in again and allow it.', 403, 'chatgpt_scope');
  if (typeof token.access_token !== 'string' || !token.access_token) throw new ChatGPTError('ChatGPT sign-in returned no access token.', 502, 'chatgpt_token');
  const claims = idTokenClaims(token.id_token);
  if (nonce !== undefined && claims.nonce !== undefined && claims.nonce !== nonce) throw new ChatGPTError('The sign-in did not match the one started here. Try again.', 400, 'chatgpt_state');
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const seconds = typeof token.expires_in === 'number' && token.expires_in > 0 ? token.expires_in : 3600;
  return {
    access: token.access_token,
    refresh: typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : (previous?.refresh ?? ''),
    expires: Date.now() + seconds * 1000 - EXPIRY_MARGIN_MS,
    name: typeof claims.name === 'string' ? claims.name : (previous?.name ?? ''),
    email: typeof claims.email === 'string' ? claims.email : (previous?.email ?? ''),
    plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : (previous?.plan ?? ''),
  };
}

/** Finishes a sign-in from the callback: checks the state against the pending login, trades the code for tokens. */
export async function completeLogin(cfg: ChatGPTConfig, req: IncomingMessage, query: URLSearchParams): Promise<{ session: ChatGPTSession; returnTo: string; clearLogin: string }> {
  const clearLogin = cookie(req, LOGIN_COOKIE, '', 0);
  const pending = unseal<PendingLogin>(cfg.key, readCookies(req).get(LOGIN_COOKIE) ?? '');
  if (!pending || Date.now() - pending.at > 600_000) throw new ChatGPTError('The sign-in took too long or was started in another browser. Try again.', 400, 'chatgpt_state');
  const error = query.get('error');
  if (error) throw new ChatGPTError(error === 'access_denied' ? 'You did not allow the connection.' : `ChatGPT said: ${query.get('error_description') ?? error}`, 400, 'chatgpt_denied');
  if (!query.get('state') || query.get('state') !== pending.state) throw new ChatGPTError('The sign-in did not match the one started here. Try again.', 400, 'chatgpt_state');
  const code = query.get('code');
  if (!code) throw new ChatGPTError('ChatGPT sent no authorization code.', 400, 'chatgpt_state');
  const token = await requestToken(cfg, { grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
  return { session: sessionFrom(token, undefined, pending.nonce), returnTo: pending.returnTo, clearLogin };
}

/** A session whose token is still good, refreshing it first when it is about to expire. `changed` means re-set the cookie. */
export async function freshSession(cfg: ChatGPTConfig, session: ChatGPTSession, now = Date.now()): Promise<{ session: ChatGPTSession; changed: boolean }> {
  if (session.expires > now) return { session, changed: false };
  if (!session.refresh) throw new ChatGPTError('Your ChatGPT sign-in has expired. Sign in again.', 401, 'chatgpt_expired');
  try {
    const token = await requestToken(cfg, { grant_type: 'refresh_token', refresh_token: session.refresh });
    return { session: sessionFrom(token, session), changed: true };
  } catch (error) {
    if (error instanceof ChatGPTError && error.status === 401) throw new ChatGPTError('Your ChatGPT sign-in has expired. Sign in again.', 401, 'chatgpt_expired');
    throw error;
  }
}

/* ---------- Calling the model on the student's plan ---------- */

export interface ChatTurnInput {
  role: 'user' | 'model';
  text: string;
}

interface StreamOptions {
  model: string;
  instructions: string;
  input: ChatTurnInput[];
  signal?: AbortSignal;
  /** Reasoning effort; plan tokens reject temperature and max_output_tokens, so this is the only dial. */
  effort?: 'low' | 'medium';
}

export interface StreamEvent {
  text?: string;
  /** "max_output_tokens" and the like when the response stopped short. */
  incomplete?: string;
}

/** Why a request failed, in terms the caller acts on. */
export function chatgptFailure(status: number, body: string): ChatGPTError {
  let code = '';
  let message = body.slice(0, 300);
  try {
    const json = JSON.parse(body) as { error?: { code?: string; message?: string; type?: string } };
    code = json.error?.code ?? json.error?.type ?? '';
    message = json.error?.message ?? message;
  } catch {
    // not JSON
  }
  if (code === 'subscription_sharing_usage_limit_exceeded' || /usage_limit/.test(code)) {
    return new ChatGPTError(`You have used this site's share of your ChatGPT plan for now. See your usage at ${USAGE_URL}, or try again later.`, 429, 'chatgpt_limit');
  }
  if (status === 401) return new ChatGPTError('Your ChatGPT sign-in has expired. Sign in again.', 401, 'chatgpt_expired');
  if (status === 404 || code === 'model_not_found' || (status === 400 && /model/i.test(message)) || (status === 403 && /model/i.test(message))) {
    return new ChatGPTError(`ChatGPT cannot use this model: ${message}`, 404, 'chatgpt_model');
  }
  if (status === 403) return new ChatGPTError(`Your ChatGPT plan cannot be used here: ${message}`, 403, 'chatgpt_plan');
  if (status === 429) return new ChatGPTError('ChatGPT is busy right now. Try again in a minute.', 429, 'chatgpt_busy');
  return new ChatGPTError(`ChatGPT answered ${status}: ${message}`, status >= 500 ? 502 : status, 'chatgpt_error');
}

/** Streams a Responses API answer with the student's token, yielding text as it arrives. */
export async function* streamResponse(cfg: ChatGPTConfig, token: string, options: StreamOptions): AsyncGenerator<StreamEvent> {
  const response = await fetch(`${cfg.apiBase}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      model: options.model,
      instructions: options.instructions,
      input: options.input.map((turn) => ({ role: turn.role === 'model' ? 'assistant' : 'user', content: turn.text })),
      reasoning: { effort: options.effort ?? 'low' },
      stream: true,
      store: false,
    }),
    signal: options.signal,
  });
  if (!response.ok || !response.body) throw chatgptFailure(response.status, await response.text().catch(() => ''));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let event: { type?: string; delta?: string; response?: { incomplete_details?: { reason?: string }; error?: { code?: string; message?: string } }; error?: { code?: string; message?: string }; code?: string; message?: string };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') yield { text: event.delta };
        else if (event.type === 'response.incomplete') yield { incomplete: event.response?.incomplete_details?.reason ?? 'incomplete' };
        else if (event.type === 'response.failed' || event.type === 'error') {
          const error = event.response?.error ?? event.error ?? { code: event.code, message: event.message };
          throw chatgptFailure(error?.code === 'subscription_sharing_usage_limit_exceeded' ? 429 : 502, JSON.stringify({ error }));
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Models this site's client may not use, learned from 404s and model errors; skipped for the life of the process. */
const unusableModels = new Set<string>();

export function usableChatGPTModels(models: string[]): string[] {
  const live = models.filter((model) => !unusableModels.has(model));
  return live.length ? live : models;
}

export function markChatGPTModelUnusable(model: string): void {
  unusableModels.add(model);
}

/** Test hook. */
export function resetChatGPTModels(): void {
  unusableModels.clear();
}

/** A whole short answer (follow-ups, query rewrites), streamed and joined, on the first model the plan can use. */
export async function liteText(cfg: ChatGPTConfig, token: string, instructions: string, text: string, timeoutMs = 12_000): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  let lastError: unknown;
  for (const model of usableChatGPTModels(cfg.liteModels)) {
    try {
      return await completeText(cfg, token, { model, instructions, input: [{ role: 'user', text }], signal });
    } catch (error) {
      if (!(error instanceof ChatGPTError) || error.code !== 'chatgpt_model') throw error;
      markChatGPTModelUnusable(model);
      lastError = error;
    }
  }
  throw lastError;
}

/** A whole short answer (follow-ups, query rewrites), streamed and joined. */
export async function completeText(cfg: ChatGPTConfig, token: string, options: StreamOptions): Promise<string> {
  let text = '';
  for await (const event of streamResponse(cfg, token, options)) if (event.text) text += event.text;
  return text;
}
