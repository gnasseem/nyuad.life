import { describe, expect, it } from 'vitest';
import { bm25Query, buildBm25, fuse } from './search.ts';
import { tokenize } from './text.ts';

describe('bm25', () => {
  const docs = [
    'Post by A on 2026-01-01. The professor for calculus is amazing and explains everything.',
    'Post by B on 2026-01-02. Housing in A2 is loud but the roommates are nice.',
    'Post by C on 2026-01-03. Calculus calculus calculus: which professor should I pick?',
    'Post by D on 2026-01-04. Visa renewal took two weeks.',
  ];
  const index = buildBm25(docs);

  it('ranks documents with the query terms first', () => {
    const rows = bm25Query(index, tokenize('calculus professor'), 3).map((hit) => hit.row);
    expect(rows.slice(0, 2).sort()).toEqual([0, 2]);
    expect(rows).not.toContain(3);
  });

  it('returns nothing for unknown terms', () => {
    expect(bm25Query(index, tokenize('zzzz'), 3)).toEqual([]);
  });
});

describe('fuse', () => {
  const chunkPost = Int32Array.from([0, 0, 1, 2]);
  const dates = ['2026-06-01', '2020-01-01', ''];
  const today = Date.UTC(2026, 8, 1) / 86_400_000;

  it('keeps the best chunk per post and merges both rankings', () => {
    const hits = fuse([{ row: 0, score: 1 }, { row: 2, score: 0.5 }], [{ row: 1, score: 0.9 }, { row: 2, score: 0.8 }], { chunkPost, dates, today });
    expect(hits.map((hit) => hit.post)).toEqual([1, 0]);
    expect(hits[0]!.chunk).toBe(2);
    expect(hits[0]!.lexicalRank).toBe(2);
    expect(hits[0]!.denseRank).toBe(2);
  });

  it('breaks ties in favour of recent posts', () => {
    const hits = fuse([{ row: 1, score: 1 }, { row: 3, score: 1 }], [], { chunkPost, dates, today });
    expect(hits.map((hit) => hit.post)).toEqual([0, 2]);
  });
});
