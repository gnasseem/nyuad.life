import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertModelsDown } from './admin.ts';
import { geminiConfig, generateText, resetModelState } from './gemini.ts';
import { mergeRows, modelUsage, recordModelCall, resetModelUsage, usageState, type UsageRow } from './model-usage.ts';
import { liteChat, modelKeys, providersFromEnv, resetProviderState } from './providers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetModelUsage();
  resetModelState();
  resetProviderState();
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('model usage', () => {
  it('tells a refused key from a spent day, a rate limit and an overload; the last thing that happened decides', () => {
    const failed = (lastStatus: number, lastError: string) => usageState({ ok: 1, failed: 1, lastOkAt: '2026-10-10T08:00:00Z', lastErrorAt: '2026-10-10T09:00:00Z', lastStatus, lastError });
    expect(failed(401, 'Invalid API Key')).toBe('refused');
    expect(failed(400, 'Gemini 400: API key not valid.')).toBe('refused');
    expect(failed(429, 'Gemini 429: quota [GenerateRequestsPerDayPerProjectPerModel-FreeTier]')).toBe('spent');
    expect(failed(429, 'Rate limit exceeded: free-models-per-day')).toBe('spent');
    expect(failed(429, 'Rate limit reached for model on tokens per minute')).toBe('limited');
    expect(failed(503, 'The model is overloaded')).toBe('overloaded');
    expect(usageState({ ok: 2, failed: 1, lastOkAt: '2026-10-10T10:00:00Z', lastErrorAt: '2026-10-10T09:00:00Z', lastStatus: 503, lastError: '' })).toBe('ok');
    expect(usageState({ ok: 0, failed: 0, lastOkAt: null, lastErrorAt: null, lastStatus: null, lastError: null })).toBe('idle');
  });

  it("adds up every instance's rows, keeping the latest error and quota reading", () => {
    const row = (fields: Partial<UsageRow>): UsageRow => ({ key: 'groq', provider: 'groq', hint: 'abcd', model: 'm', ok: 0, failed: 0, lastOkAt: null, lastErrorAt: null, lastStatus: null, lastError: null, remaining: null, limit: null, limitAt: null, ...fields });
    const [merged] = mergeRows([
      row({ ok: 3, failed: 1, lastErrorAt: '2026-10-10T08:00:00Z', lastStatus: 503, lastError: 'old', remaining: 900, limit: 1000, limitAt: '2026-10-10T08:00:00Z' }),
      row({ ok: 2, failed: 2, lastErrorAt: '2026-10-10T09:00:00Z', lastStatus: 429, lastError: 'new', remaining: 880, limit: 1000, limitAt: '2026-10-10T09:00:00Z' }),
    ]);
    expect(merged).toMatchObject({ ok: 5, failed: 3, lastStatus: 429, lastError: 'new', remaining: 880 });
  });

  it('counts each Gemini key and backup provider apart, with what the provider says is left', async () => {
    const gemini = geminiConfig({ GEMINI_API_KEY: 'gem-key-1111,gem-key-2222', GEMINI_CHAT_MODEL: 'gemini-a', GEMINI_CHAT_FALLBACK_MODELS: '' })!;
    const groq = providersFromEnv({ GROQ_API_KEY: 'gsk-3333', ROR_MODEL_DISCOVERY: '0' });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.includes('groq')) return json(200, { choices: [{ message: { content: 'hi' } }] }, { 'x-ratelimit-remaining-requests': '987', 'x-ratelimit-limit-requests': '1000' });
      if ((init.headers as Record<string, string>)['x-goog-api-key'] === 'gem-key-1111') return json(429, { error: { message: 'Quota exceeded for metric: free_tier_requests, limit: 20', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
      return json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    });
    await generateText(gemini, { model: ['gemini-a'], messages: [{ role: 'user', text: 'q' }] }, { retries: 0 });
    await liteChat(groq, { system: 's', messages: [{ role: 'user', text: 'q' }] });
    const report = await modelUsage(modelKeys(gemini, groq));
    const byKey = Object.fromEntries(report.keys.map((key) => [key.key, key]));
    expect(byKey.gemini).toMatchObject({ hint: '1111', state: 'spent', failed: 1 });
    expect(byKey.gemini!.models.find((model) => model.model === 'gemini-a')).toMatchObject({ remaining: 0, limit: 20 });
    expect(byKey['gemini-2']).toMatchObject({ hint: '2222', state: 'ok', ok: 1 });
    const used = byKey.groq!.models.find((model) => model.ok);
    expect(used).toMatchObject({ state: 'ok', remaining: 987, limit: 1000 });
  });

  it('emails the administrators once about an outage, with what each key did', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'nyuad.life <alerts@nyuad.life>');
    vi.stubEnv('ROR_ADMIN_NETIDS', 'gnn9245');
    vi.stubEnv('GEMINI_API_KEY', 'gem-key-1111');
    const sent: Array<{ headers: Record<string, string>; body: { to: string[]; text: string } }> = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return json(200, { id: 'email' });
    });
    const now = Date.parse('2026-10-10T10:00:00Z');
    // Counted on the day of the outage, whatever day the test runs.
    recordModelCall({ key: 'gemini', provider: 'gemini', hint: '1111', model: 'gemini-3.5-flash-lite', ok: false, status: 503, error: 'Gemini 503: The model is overloaded.' }, now);
    await alertModelsDown('Answers are busy right now.', now);
    await alertModelsDown('Answers are busy right now.', now + 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.to).toEqual(['gnn9245@nyu.edu']);
    expect(sent[0]!.headers['idempotency-key']).toBe('models-down-2026-10-10-4');
    expect(sent[0]!.body.text).toContain('gemini-3.5-flash-lite: overloaded, 0 ok, 1 failed');
  });
});
