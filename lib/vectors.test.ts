import { describe, expect, it } from 'vitest';
import { normalize } from './gemini.ts';
import { concatTables, decodeTable, dot, dotRows, encodeTable, quantize, selectRows, topK } from './vectors.ts';

function randomVector(dims: number, seed: number): Float32Array {
  const out = new Float32Array(dims);
  let state = seed;
  for (let i = 0; i < dims; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state / 0x7fffffff - 0.5;
  }
  return normalize(out);
}

describe('int8 vector table', () => {
  const dims = 64;
  const vectors = Array.from({ length: 50 }, (_, i) => randomVector(dims, i + 1));
  const table = quantize(vectors, dims);

  it('round-trips through the binary encoding', () => {
    const decoded = decodeTable(encodeTable(table));
    expect(decoded.count).toBe(50);
    expect(decoded.dims).toBe(dims);
    expect(Array.from(decoded.data)).toEqual(Array.from(table.data));
    expect(Array.from(decoded.scales)).toEqual(Array.from(table.scales));
  });

  it('approximates the float dot product closely', () => {
    const query = randomVector(dims, 999);
    vectors.forEach((vector, row) => {
      let exact = 0;
      for (let i = 0; i < dims; i++) exact += vector[i]! * query[i]!;
      expect(Math.abs(dot(table, row, query) - exact)).toBeLessThan(0.02);
    });
    expect(dotRows(table, 3, 3)).toBeCloseTo(1, 1);
  });

  it('topK matches a brute-force sort', () => {
    const query = randomVector(dims, 4242);
    const brute = vectors
      .map((vector, row) => ({ row, score: dot(table, row, query) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((entry) => entry.row);
    expect(topK(table, query, 5).map((entry) => entry.row)).toEqual(brute);
  });

  it('concatenates and selects rows', () => {
    const extra = quantize([randomVector(dims, 77)], dims);
    const joined = concatTables(table, extra);
    expect(joined.count).toBe(51);
    const picked = selectRows(joined, [50, 0]);
    expect(Array.from(picked.data.subarray(0, dims))).toEqual(Array.from(extra.data));
    expect(picked.scales[1]).toBe(table.scales[0]);
  });

  it('rejects corrupt files', () => {
    expect(() => decodeTable(Buffer.from('nope'))).toThrow();
  });
});
