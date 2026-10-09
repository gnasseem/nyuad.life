import { describe, expect, it } from 'vitest';
import { gatherSources, parseConfidence, poolHoursAnswer, searchQueries, systemPrompt } from './rag.ts';
import type { OfficialCorpus } from './official.ts';
import type { Archive } from './store.ts';
import { buildBm25 } from './search.ts';
import { emptyTable } from './vectors.ts';

describe('parseConfidence', () => {
  it('keeps the original query and expands campus aliases even without a rewrite model', () => {
    const variants = searchQueries('pool timings with my CS-UH 1001 schedule', 'indoor pool opening hours');
    expect(variants).toContain('pool timings with my CS-UH 1001 schedule');
    expect(variants.some((query) => query.includes('operational hours'))).toBe(true);
    expect(variants).toHaveLength(3);
  });
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

it('retrieves official pool hours through general RAG with no archive, models or vectors', async () => {
  const doc = { id: 'pool', title: 'Sports Facilities', url: 'https://nyuad.nyu.edu/en/facility-rentals/sports-facilities.html', section: 'campus', text: 'Indoor Pool operational hours: Monday-Friday 8am-2pm and 3-9pm.', fetchedAt: new Date().toISOString() };
  const chunk = { id: 'pool#1', postId: 'pool', n: 1, text: `Sports Facilities · Indoor Pool\n${doc.text}`, hash: 'pool' };
  const official = { docs: [doc], chunks: [chunk], chunkDoc: new Int32Array([0]), docPosition: new Map([['pool', 0]]), vectors: emptyTable(0), bm25: buildBm25([chunk.text]), meta: { model: 'none', dimensions: 0 } } as OfficialCorpus;
  const archive = { posts: [], chunks: [], chunkPost: new Int32Array(), vectors: emptyTable(0), bm25: buildBm25([]), meta: { model: 'none', dimensions: 0 } } as unknown as Archive;
  const result = await gatherSources(archive, 'pool timings', 'pool timings', { cfg: null, official, catalog: null, reranker: null, board: null });
  expect(result.cards).toHaveLength(1);
  expect(result.cards[0]?.kind).toBe('official');
  expect(result.cards[0]?.text).toContain('8am-2pm and 3-9pm');
});

describe('systemPrompt', () => {
  it('asks for the shape the client renders', () => {
    const prompt = systemPrompt(new Date('2026-09-29T00:00:00Z'), 'Fall 2026');
    expect(prompt).toContain('Today is 2026-09-29, a Tuesday, in Abu Dhabi; the term now is Fall 2026');
    expect(prompt).toContain('Confidence: high|medium|low');
  });
  it('dates the question in Abu Dhabi, four hours ahead of UTC', () => {
    expect(systemPrompt(new Date('2026-09-29T21:30:00Z'))).toContain('Today is 2026-09-30, a Wednesday');
  });
  it('keeps Falcons and Campus Dirhams apart', () => {
    const prompt = systemPrompt();
    expect(prompt).toContain('Campus Dirhams = the meal-plan money');
    expect(prompt).not.toMatch(/Falcons = campus dirhams/i);
  });
});

it('answers pool hours from the pool section without using the gym hours', () => {
  const corpus = { docs: [{ id: 'pool', url: 'https://nyuad.nyu.edu/en/facility-rentals/sports-facilities.html', title: 'Sports Facilities', section: 'campus', fetchedAt: '2026-10-08T00:00:00Z', text: 'Performance Gym\nOperational Hours\nMonday-Friday, 8am-10pm\nWeekends, 8am-8pm\nIndoor Pool\nOperational Hours\nMonday-Friday, 8am-2pm and 3-9pm\nWeekends, 8am-8pm\nSquash Courts\nOperational Hours\nMonday-Friday, 8am-10pm' }] } as OfficialCorpus;
  const result = poolHoursAnswer('pool timings at nyuad', corpus);
  expect(result?.answer).toContain('8am-2pm and 3-9pm');
  expect(result?.answer).not.toContain('8am-10pm');
  expect(result?.sources).toHaveLength(1);
  expect(result?.sources[0]?.url).toBe(corpus.docs[0]?.url);
  expect(poolHoursAnswer('pool reviews at nyuad', corpus)).toBeNull();
});
