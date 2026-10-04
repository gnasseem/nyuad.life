import { afterEach, describe, expect, it } from 'vitest';
import { GeminiError, geminiConfig, markUnavailable, resetModelState, thinkingFor, usableModels } from './gemini.ts';

afterEach(() => resetModelState());

describe('geminiConfig', () => {
  it('defaults to the newest models with older ones behind them', () => {
    const cfg = geminiConfig({ GEMINI_API_KEY: 'k' })!;
    expect([cfg.chatModel, ...cfg.chatFallbacks]).toEqual(['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash']);
    expect(cfg.liteModels).toEqual(['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite']);
  });
  it('keeps the default fallbacks behind a pinned model, unless fallbacks are set too', () => {
    expect(geminiConfig({ GEMINI_API_KEY: 'k', GEMINI_CHAT_MODEL: 'gemini-2.5-flash' })!.chatFallbacks).toEqual(['gemini-3.5-flash', 'gemini-3-flash-preview']);
    expect(geminiConfig({ GEMINI_API_KEY: 'k', GEMINI_CHAT_MODEL: 'a', GEMINI_CHAT_FALLBACK_MODELS: 'b, c' })!.chatFallbacks).toEqual(['b', 'c']);
    expect(geminiConfig({ GEMINI_API_KEY: 'k', GEMINI_CHAT_FALLBACK_MODELS: '' })!.chatFallbacks).toEqual([]);
  });
});

describe('model availability', () => {
  it('skips a removed model for hours and a model out of daily quota for an hour', () => {
    const now = 1_000_000;
    markUnavailable('gone', new GeminiError('Gemini 404: not found', 404), now);
    markUnavailable('spent', new GeminiError('Gemini 429: limit: 250 per day', 429), now);
    markUnavailable('busy', new GeminiError('Gemini 429: per minute', 429, 5_000), now);
    expect(usableModels(['gone', 'spent', 'busy', 'ok'], now + 1)).toEqual(['ok']);
    expect(usableModels(['gone', 'spent', 'busy', 'ok'], now + 61_000)).toEqual(['busy', 'ok']);
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
