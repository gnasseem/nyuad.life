import { describe, expect, it } from 'vitest';
import { enrichPost, mergePosts, normalizeDate, normalizePost } from './posts.ts';

describe('normalizePost', () => {
  it('cleans whitespace, dates and comment counts', () => {
    const post = normalizePost({ id: ' 1 ', author: '  Ana  Lee ', date: '2026-04-01T10:00:00Z', text: 'hi \r\nthere\n\n\n\nok', comments: [{ author: 'B', date: '1712000000', text: ' yo ' }], commentCount: 0 });
    expect(post).toMatchObject({ id: '1', author: 'Ana Lee', date: '2026-04-01', text: 'hi\nthere\n\nok', commentCount: 1 });
    expect(post.comments[0]).toEqual({ author: 'B', date: '2024-04-01', text: 'yo' });
  });
  it('maps unknown dates to empty strings', () => {
    expect(normalizeDate('unknown date')).toBe('');
    expect(normalizeDate('March 3, 2025')).toBe('2025-03-03');
  });
});

describe('mergePosts', () => {
  it('adds new posts and unions comments of existing ones', () => {
    const existing = [{ id: '1', url: 'u', author: 'A', date: '2026-01-01', text: 'short', comments: [{ author: 'X', date: '', text: 'one' }] }];
    const incoming = [
      { id: '1', url: '', author: 'A', date: '', text: 'short but longer', comments: [{ author: 'X', date: '', text: 'one' }, { author: 'Y', date: '', text: 'two' }] },
      { id: '2', url: 'v', author: 'B', date: '2026-02-01', text: 'new', comments: [] },
    ];
    const merged = mergePosts(existing, incoming);
    expect(merged.added).toBe(1);
    expect(merged.updated).toBe(1);
    expect(merged.posts.map((post) => post.id)).toEqual(['2', '1']);
    const first = merged.posts.find((post) => post.id === '1')!;
    expect(first.text).toBe('short but longer');
    expect(first.url).toBe('u');
    expect(first.date).toBe('2026-01-01');
    expect(first.comments.map((comment) => comment.text)).toEqual(['one', 'two']);
  });
  it('leaves a post untouched when a re-scrape only brings a new timestamp', () => {
    const existing = [{ id: '1', url: 'u', author: 'A', date: '2026-01-01', text: 'same', comments: [], commentCount: 0, scrapedAt: '2026-01-02T00:00:00.000Z' }];
    const same = mergePosts(existing, [{ ...existing[0]!, scrapedAt: '2026-09-01T00:00:00.000Z' }]);
    expect(same.updated).toBe(0);
    expect(same.posts[0]!.scrapedAt).toBe('2026-01-02T00:00:00.000Z');
    const changed = mergePosts(existing, [{ ...existing[0]!, text: 'same, edited later', scrapedAt: '2026-09-01T00:00:00.000Z' }]);
    expect(changed.updated).toBe(1);
    expect(changed.posts[0]!.scrapedAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('enrichment', () => {
  it('tags topics and courses', () => {
    const post = enrichPost({ id: '1', url: '', author: 'S', date: '', text: 'Anyone taken CS-UH 1001 with a good professor? Which section is best for the course?', comments: [] });
    expect(post.courses).toEqual(['CS-UH 1001']);
    expect(post.topics).toContain('courses');
    expect(post.topics).toContain('professors');
  });
});
