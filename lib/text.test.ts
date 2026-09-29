import { describe, expect, it } from 'vitest';
import { bestWindow, dayNumber, extractCourseCodes, stem, tokenize, truncate } from './text.ts';

describe('tokenize', () => {
  it('lower-cases, drops stopwords and stems plurals', () => {
    expect(tokenize('The Professors of CS-UH 1001 are great!')).toEqual(['professor', 'cs', 'uh', '1001', 'great']);
  });
  it('strips diacritics and apostrophes', () => {
    expect(tokenize("Zoë's café")).toEqual(['zoe', 'cafe']);
  });
  it('keeps digits (course numbers) intact', () => {
    expect(stem('1001')).toBe('1001');
    expect(stem('classes')).toBe('class');
    expect(stem('studies')).toBe('study');
    expect(stem('bus')).toBe('bus');
  });
});

describe('extractCourseCodes', () => {
  it('normalises spacing and case', () => {
    expect(extractCourseCodes('took cs-uh 1001 and CSTS-UH1125X, also SOCSC-UH 1310')).toEqual(['CS-UH 1001', 'CSTS-UH 1125X', 'SOCSC-UH 1310']);
  });
  it('ignores things that are not course codes', () => {
    expect(extractCourseCodes('UH 1001 and A1C dorm')).toEqual([]);
  });
});

describe('bestWindow', () => {
  it('returns the region with most query terms', () => {
    const text = 'x '.repeat(200) + 'The professor grades generously and the workload is light. ' + 'y '.repeat(200);
    const window = bestWindow(text, ['professor', 'workload'], 80);
    expect(window).toContain('professor');
    expect(window).toContain('workload');
    expect(window.length).toBeLessThanOrEqual(84);
  });
  it('truncates when there are no hits', () => {
    expect(bestWindow('short text', ['nothing'], 50)).toBe('short text');
  });
});

describe('dates and truncation', () => {
  it('parses ISO dates to day numbers', () => {
    expect(dayNumber('2026-01-02') - dayNumber('2026-01-01')).toBe(1);
    expect(Number.isNaN(dayNumber('unknown date'))).toBe(true);
  });
  it('truncates at a word boundary', () => {
    expect(truncate('one two three four', 9)).toBe('one two…');
  });
});
