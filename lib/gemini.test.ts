import { afterEach, describe, expect, it } from 'vitest';
import { GeminiError, geminiConfig, markUnavailable, resetModelState, thinkingFor, usableModels, withDiscovered } from './gemini.ts';

afterEach(() => resetModelState());

describe('geminiConfig', () => {
  it('starts answers with the free models that work on the production key', () => {
    const cfg = geminiConfig({ GEMINI_API_KEY: 'k' })!;
    expect([cfg.chatModel, ...cfg.chatFallbacks]).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it']);
    expect(cfg.liteModels).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it']);
  });
  it('keeps the default fallbacks behind a pinned model, unless fallbacks are set too', () => {
    expect(geminiConfig({ GEMINI_API_KEY: 'k', GEMINI_CHAT_MODEL: 'gemini-3.5-flash' })!.chatFallbacks).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-26b-a4b-it']);
    expect(geminiConfig({ GEMINI_API_KEY: 'k', GEMINI_CHAT_MODEL: 'a', GEMINI_CHAT_FALLBACK_MODELS: 'b, c' })!.chatFallbacks).toEqual(['b', 'c']);
    expect(geminiConfig({ GEMINI_API_KEY: 'k', GEMINI_CHAT_FALLBACK_MODELS: '' })!.chatFallbacks).toEqual([]);
  });
});

describe('withDiscovered', () => {
  it('drops models the key cannot use and puts newer Flash models in front', () => {
    const listed = new Set(['gemini-3.9-flash', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemma-4-31b-it', 'gemini-3.9-flash-lite', 'gemini-3.5-flash-lite', 'gemini-embedding-001']);
    expect(withDiscovered(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemma-4-31b-it'], listed, 'flash')).toEqual(['gemini-3.9-flash', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemma-4-31b-it']);
    expect(withDiscovered(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], listed, 'lite')).toEqual(['gemini-3.9-flash-lite', 'gemini-3.5-flash-lite']);
    // A listing that has none of them is more likely wrong than the list.
    expect(withDiscovered(['gemini-3.8-flash'], new Set(['text-bison']), 'flash')).toEqual(['gemini-3.8-flash']);
    expect(withDiscovered(['gemini-3.5-flash-lite', 'gemma-4-26b-a4b-it'], listed, 'flash')).toEqual(['gemini-3.5-flash-lite']);
  });
});

describe('model availability', () => {
  it('reads a spent day, and a model with no free tier, from the error details', () => {
    const now = 1_000_000;
    markUnavailable('none', new GeminiError('Gemini 429: Quota exceeded for metric: free_tier_requests, limit: 0, model: x', 429, 20_000), now);
    markUnavailable('day', new GeminiError('Gemini 429: You exceeded your current quota [GenerateRequestsPerDayPerProjectPerModel-FreeTier]', 429, 20_000), now);
    expect(usableModels(['none', 'day', 'ok'], now + 3_000_000)).toEqual(['ok']);
    expect(usableModels(['none', 'day', 'ok'], now + 3_700_000)).toEqual(['day', 'ok']);
  });

  it('skips a removed model for hours and a model out of daily quota for an hour', () => {
    const now = 1_000_000;
    markUnavailable('gone', new GeminiError('Gemini 404: not found', 404), now);
    markUnavailable('spent', new GeminiError('Gemini 429: limit: 250 per day', 429), now);
    markUnavailable('busy', new GeminiError('Gemini 429: per minute', 429, 5_000), now);
    expect(usableModels(['gone', 'spent', 'busy', 'ok'], now + 1)).toEqual(['ok']);
    expect(usableModels(['gone', 'spent', 'busy', 'ok'], now + 11_000)).toEqual(['busy', 'ok']);
    expect(usableModels(['gone', 'spent', 'busy', 'ok'], now + 3_600_001)).toEqual(['spent', 'busy', 'ok']);
    // With nothing left, everything is tried again rather than nothing.
    expect(usableModels(['gone'], now + 1)).toEqual(['gone']);
  });
});

describe('thinkingFor', () => {
  it('caps or turns off thinking per model family', () => {
    expect(thinkingFor('gemini-2.5-flash', 'none')).toEqual({ thinkingBudget: 0 });
    expect(thinkingFor('models/gemini-2.5-flash-lite', 'low')).toEqual({ thinkingBudget: 1024 });
    expect(thinkingFor('gemini-2.5-pro', 'none')).toEqual({ thinkingBudget: 128 });
    expect(thinkingFor('gemini-3.5-flash', 'low')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingFor('gemini-2.0-flash', 'low')).toBeUndefined();
  });
});
