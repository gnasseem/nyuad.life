import { describe, expect, it } from 'vitest';
import { parseConfidence, systemPrompt } from './rag.ts';

describe('parseConfidence', () => {
  it('splits the trailing confidence line off the answer', () => {
    const { text, confidence } = parseConfidence('Take Dania [1].\n\n- Everyone agreed [1][2].\n\nConfidence: high – four recent threads agree.');
    expect(text).toBe('Take Dania [1].\n\n- Everyone agreed [1][2].');
    expect(confidence).toEqual({ level: 'high', reason: 'four recent threads agree' });
  });
  it('copes with bold, dashes and missing reasons', () => {
    expect(parseConfidence('Answer.\n**Confidence: Medium** - only one thread, from 2024').confidence).toEqual({ level: 'medium', reason: 'only one thread, from 2024' });
    expect(parseConfidence('Answer.\nConfidence: low').confidence).toEqual({ level: 'low', reason: '' });
    expect(parseConfidence('No confidence line here.')).toEqual({ text: 'No confidence line here.', confidence: null });
  });
});

describe('systemPrompt', () => {
  it('asks for the shape the client renders', () => {
    const prompt = systemPrompt(new Date('2026-09-29T00:00:00Z'));
    expect(prompt).toContain('Today is 2026-09-29');
    expect(prompt).toContain('Confidence: high|medium|low');
    expect(prompt).toContain('Falcons = campus dirhams');
  });
});
