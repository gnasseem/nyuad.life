/**
 * Sign in with ChatGPT end to end, against a fake OpenAI (its authorization server and the Responses API): the PKCE
 * sign-in, the sealed session cookie, an answer written on the student's plan, model fallback, refresh, and the
 * errors a student can hit.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chatgptConfig, readSession, resetChatGPTModels, safeReturnTo, seal, sessionCookies, unseal, type ChatGPTSession } from './chatgpt.ts';
import { createApiServer } from './devserver.ts';
import { resetArchive } from './store.ts';

const SECRET = 'x'.repeat(40);
let openai: Server;
let api: Server;
let openaiUrl = '';
let apiUrl = '';
let dataRoot = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seen: { token: any[]; responses: Array<{ auth: string; body: any }> } = { token: [], responses: [] };
const fake = { limitReached: false, accessToken: 'plan-token-1', expiresIn: 3600 };

function idToken(claims: Record<string, unknown>): string {
  return ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let lastNonce = '';
let lastChallenge = '';

beforeAll(async () => {
  openai = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(await body(req));
      seen.token.push(Object.fromEntries(form));
      res.setHeader('content-type', 'application/json');
      const access = form.get('grant_type') === 'refresh_token' ? 'plan-token-refreshed' : fake.accessToken;
      res.end(JSON.stringify({ access_token: access, refresh_token: 'refresh-1', expires_in: fake.expiresIn, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', id_token: idToken({ email: 'sara@nyu.edu', name: 'Sara Ali', nonce: lastNonce, 'https://api.openai.com/auth': { chatgpt_plan_type: 'edu' } }) }));
      return;
    }
    if (url.pathname === '/v1/responses') {
      const json = JSON.parse(await body(req));
      seen.responses.push({ auth: String(req.headers.authorization), body: json });
      if (json.model === 'gpt-6.1-sol') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'The model gpt-6.1-sol does not exist or you do not have access to it.' } }));
        return;
      }
      if (fake.limitReached) {
        res.statusCode = 429;
        res.end(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit reached for this app.' } }));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      const text = json.instructions.includes('follow-up questions') ? 'How hard is the midterm?\nWho grades fairest?\nWhen is office hours?' : 'Take **Dania** [1].\n\nConfidence: high – everyone agrees';
      for (const piece of text.match(/.{1,12}/gs) ?? []) res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: piece })}\n\n`);
      res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => openai.listen(0, '127.0.0.1', resolve));
  openaiUrl = `http://127.0.0.1:${(openai.address() as { port: number }).port}`;

  dataRoot = mkdtempSync(path.join(tmpdir(), 'ror-chatgpt-'));
  mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
  writeFileSync(path.join(dataRoot, 'data', 'posts.jsonl'), JSON.stringify({ id: 'p1', url: 'https://fb/p1', author: 'Ana', date: '2026-04-01', text: 'Who is the best professor for Calculus?', comments: [{ author: 'Ben', date: '2026-04-01', text: 'Take it with Dania, she grades fairly.' }] }) + '\n');
  Object.assign(process.env, {
    ROR_DATA_ROOT: dataRoot,
    ROR_INDEX_DIR: path.join(dataRoot, 'no-index'),
    ROR_OFFICIAL_INDEX_DIR: path.join(dataRoot, 'no-official'),
    ROR_OFFICIAL_FILE: path.join(dataRoot, 'no-official.jsonl'),
    OPENAI_CLIENT_ID: 'oaiapp_test',
    SESSION_SECRET: SECRET,
    ROR_SITE_URL: 'https://nyuad.life',
    OPENAI_AUTHORIZE_URL: `${openaiUrl}/oauth/authorize`,
    OPENAI_TOKEN_URL: `${openaiUrl}/oauth/token`,
    OPENAI_API_BASE: `${openaiUrl}/v1`,
    ROR_BOARD_STORE: 'memory',
    ROR_RERANKER: 'none',
  });
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  resetArchive();
  api = createApiServer({ root: process.cwd(), distDir: path.join(dataRoot, 'no-dist') });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => api?.close(resolve));
  await new Promise((resolve) => openai?.close(resolve));
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fake.limitReached = false;
  fake.accessToken = 'plan-token-1';
  fake.expiresIn = 3600;
  delete process.env.ROR_REQUIRE_CHATGPT;
  resetChatGPTModels();
});

/** Cookies from Set-Cookie lines, as a browser would send them back. */
function jar(response: Response, previous = ''): string {
  const cookies = new Map(previous ? previous.split('; ').map((pair) => pair.split('=', 2) as [string, string]) : []);
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, value] = [pair!.slice(0, pair!.indexOf('=')), pair!.slice(pair!.indexOf('=') + 1)];
    if (/Max-Age=0/.test(line)) cookies.delete(name);
    else cookies.set(name, value);
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function signIn(returnTo = '/courses'): Promise<string> {
  const start = await fetch(`${apiUrl}/api/chatgpt?op=start&returnTo=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  lastNonce = authorize.searchParams.get('nonce')!;
  lastChallenge = authorize.searchParams.get('code_challenge')!;
  const cookies = jar(start);
  const callback = await fetch(`${apiUrl}/api/chatgpt-callback?code=code-123&state=${authorize.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: cookies } });
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe(`${returnTo}?chatgpt=connected`);
  return jar(callback, cookies);
}

async function askStream(cookie: string, question = 'Who is the best calculus professor?') {
  const response = await fetch(`${apiUrl}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ question }) });
  const raw = await response.text();
  const events = raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine!.replace('event: ', ''), data: JSON.parse(dataLine!.replace('data: ', '')) };
    });
  return { response, events };
}

describe('sealed cookies', () => {
  it('round-trips, and rejects tampering or another key', () => {
    const key = chatgptConfig({ OPENAI_CLIENT_ID: 'a', SESSION_SECRET: SECRET })!.key;
    const sealed = seal(key, { a: 1 });
    expect(unseal(key, sealed)).toEqual({ a: 1 });
    expect(unseal(key, sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA'))).toBeNull();
    expect(unseal(chatgptConfig({ OPENAI_CLIENT_ID: 'a', SESSION_SECRET: 'y'.repeat(40) })!.key, sealed)).toBeNull();
  });
  it('splits a long session across cookies and reads it back', () => {
    const cfg = chatgptConfig({ OPENAI_CLIENT_ID: 'a', SESSION_SECRET: SECRET })!;
    const session: ChatGPTSession = { access: 'a'.repeat(5000), refresh: 'r', expires: 1, name: '', email: '', plan: '' };
    const req = { headers: {}, socket: {} } as IncomingMessage;
    const lines = sessionCookies(cfg, req, session);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.split(';')[0]!.length < 4000 && /HttpOnly; SameSite=Lax/.test(line))).toBe(true);
    const cookie = lines.map((line) => line.split(';')[0]).join('; ');
    expect(readSession(cfg, { headers: { cookie } } as IncomingMessage)?.access).toBe(session.access);
  });
  it('is off without a client ID or a long enough secret', () => {
    expect(chatgptConfig({ SESSION_SECRET: SECRET })).toBeNull();
    expect(chatgptConfig({ OPENAI_CLIENT_ID: 'a', SESSION_SECRET: 'short' })).toBeNull();
  });
  it('only returns to paths on this site', () => {
    expect(safeReturnTo('/courses?q=x')).toBe('/courses?q=x');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
  });
});

describe('Sign in with ChatGPT', () => {
  it('starts a PKCE sign-in with the plan scopes and the registered redirect URI', async () => {
    const start = await fetch(`${apiUrl}/api/chatgpt?op=start`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location')!);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'oaiapp_test',
      response_type: 'code',
      redirect_uri: 'https://nyuad.life/api/chatgpt-callback',
      resource: 'https://api.openai.com/v1',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      code_challenge_method: 'S256',
    });
    expect(start.headers.getSetCookie()[0]).toMatch(/^ror_cg_login=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600/);
  });

  it('signs in, then answers on the student’s plan without the fields plan tokens reject', async () => {
    seen.token.length = 0;
    const cookie = await signIn();
    const exchange = seen.token[0];
    expect(exchange).toMatchObject({ grant_type: 'authorization_code', code: 'code-123', client_id: 'oaiapp_test', redirect_uri: 'https://nyuad.life/api/chatgpt-callback', resource: 'https://api.openai.com/v1' });
    // The verifier sent with the code is the one whose hash went out with this sign-in.
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(lastChallenge);

    const me = await (await fetch(`${apiUrl}/api/chatgpt?op=me`, { headers: { cookie } })).json();
    expect(me).toEqual({ available: true, required: false, connected: true, name: 'Sara Ali', email: 'sara@nyu.edu', plan: 'edu' });

    seen.responses.length = 0;
    const { events } = await askStream(cookie);
    const answer = events.filter((entry) => entry.event === 'delta').map((entry) => entry.data.text).join('');
    expect(answer).toContain('Take **Dania** [1].');
    const done = events.at(-1)!;
    expect(done.event).toBe('done');
    // 6.1 Sol is not available to this client, so the answer came from the next model.
    expect(done.data.model).toBe('chatgpt:gpt-6-sol');
    expect(done.data.confidence).toEqual({ level: 'high', reason: 'everyone agrees' });
    expect(events.find((entry) => entry.event === 'followups')!.data.questions).toEqual(['How hard is the midterm?', 'Who grades fairest?', 'When is office hours?']);
    const calls = seen.responses;
    expect(calls.every((call) => call.auth === 'Bearer plan-token-1')).toBe(true);
    for (const call of calls) {
      expect(call.body).not.toHaveProperty('temperature');
      expect(call.body).not.toHaveProperty('max_output_tokens');
      expect(call.body).toMatchObject({ stream: true, store: false });
    }
  });

  it('says so when the student has used this site’s share of their plan', async () => {
    const cookie = await signIn();
    fake.limitReached = true;
    const { events } = await askStream(cookie);
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'chatgpt_limit' } });
    expect(events.at(-1)!.data.message).toContain('chatgpt.com/settings/usage');
  });

  it('refreshes an expired token before answering and keeps the new one', async () => {
    fake.expiresIn = 60; // shorter than the refresh margin: already due
    const cookie = await signIn();
    seen.responses.length = 0;
    const { response, events } = await askStream(cookie);
    expect(events.at(-1)!.event).toBe('done');
    expect(seen.responses.at(-1)!.auth).toBe('Bearer plan-token-refreshed');
    expect(response.headers.getSetCookie().some((line) => line.startsWith('ror_cg0='))).toBe(true);
  });

  it('asks students to connect when answers require it, or when the site has no model of its own', async () => {
    const response = await fetch(`${apiUrl}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'calculus?' }) });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe('chatgpt_required');
  });

  it('rejects a callback that does not match the sign-in started here', async () => {
    const start = await fetch(`${apiUrl}/api/chatgpt?op=start`, { redirect: 'manual' });
    const callback = await fetch(`${apiUrl}/api/chatgpt-callback?code=x&state=forged`, { redirect: 'manual', headers: { cookie: jar(start) } });
    expect(callback.headers.get('location')).toBe('/?chatgpt=error&reason=chatgpt_state');
    expect(callback.headers.getSetCookie().some((line) => line.startsWith('ror_cg0='))).toBe(false);
  });

  it('signs out', async () => {
    const cookie = await signIn();
    const out = await fetch(`${apiUrl}/api/chatgpt`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ op: 'logout' }) });
    const after = jar(out, cookie);
    expect(after).not.toContain('ror_cg0=');
    const me = (await (await fetch(`${apiUrl}/api/chatgpt?op=me`, { headers: { cookie: after } })).json()) as { connected: boolean };
    expect(me.connected).toBe(false);
  });
});
