/**
 * Compact on-disk format for document embeddings: int8 quantised rows with a per-row float32 scale.
 * A 768-dimension vector costs 772 bytes instead of 3,072, and the dot product stays a plain integer loop.
 */

const MAGIC = 0x56524f52; // "RORV"
const VERSION = 1;
const HEADER_BYTES = 16;

export interface VectorTable {
  count: number;
  dims: number;
  scales: Float32Array;
  data: Int8Array;
}

export function emptyTable(dims: number): VectorTable {
  return { count: 0, dims, scales: new Float32Array(0), data: new Int8Array(0) };
}

/** Quantises normalised float vectors. */
export function quantize(vectors: Float32Array[], dims: number): VectorTable {
  const count = vectors.length;
  const scales = new Float32Array(count);
  const data = new Int8Array(count * dims);
  for (let row = 0; row < count; row++) {
    const vector = vectors[row]!;
    if (vector.length !== dims) throw new Error(`Vector ${row} has ${vector.length} dims; expected ${dims}.`);
    let max = 0;
    for (let i = 0; i < dims; i++) max = Math.max(max, Math.abs(vector[i]!));
    const scale = max === 0 ? 1 : max / 127;
    scales[row] = scale;
    const offset = row * dims;
    for (let i = 0; i < dims; i++) data[offset + i] = Math.round(vector[i]! / scale);
  }
  return { count, dims, scales, data };
}

export function encodeTable(table: VectorTable): Buffer {
  const buffer = Buffer.alloc(HEADER_BYTES + table.count * 4 + table.count * table.dims);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt32LE(VERSION, 4);
  buffer.writeUInt32LE(table.count, 8);
  buffer.writeUInt32LE(table.dims, 12);
  for (let i = 0; i < table.count; i++) buffer.writeFloatLE(table.scales[i]!, HEADER_BYTES + i * 4);
  Buffer.from(table.data.buffer, table.data.byteOffset, table.data.byteLength).copy(buffer, HEADER_BYTES + table.count * 4);
  return buffer;
}

export function decodeTable(buffer: Buffer): VectorTable {
  if (buffer.length < HEADER_BYTES || buffer.readUInt32LE(0) !== MAGIC) throw new Error('Not a ROR vector file.');
  const version = buffer.readUInt32LE(4);
  if (version !== VERSION) throw new Error(`Unsupported vector file version ${version}.`);
  const count = buffer.readUInt32LE(8);
  const dims = buffer.readUInt32LE(12);
  const expected = HEADER_BYTES + count * 4 + count * dims;
  if (buffer.length !== expected) throw new Error(`Vector file is ${buffer.length} bytes; expected ${expected}.`);
  const scales = new Float32Array(count);
  for (let i = 0; i < count; i++) scales[i] = buffer.readFloatLE(HEADER_BYTES + i * 4);
  const start = HEADER_BYTES + count * 4;
  const data = new Int8Array(count * dims);
  data.set(buffer.subarray(start, start + count * dims));
  return { count, dims, scales, data };
}

/** Appends rows from `extra` to `base` (both must share dims). */
export function concatTables(base: VectorTable, extra: VectorTable): VectorTable {
  if (base.dims !== extra.dims) throw new Error('Cannot concatenate vector tables with different dims.');
  const scales = new Float32Array(base.count + extra.count);
  scales.set(base.scales, 0);
  scales.set(extra.scales, base.count);
  const data = new Int8Array((base.count + extra.count) * base.dims);
  data.set(base.data, 0);
  data.set(extra.data, base.count * base.dims);
  return { count: base.count + extra.count, dims: base.dims, scales, data };
}

/** Picks rows by index, preserving order. */
export function selectRows(table: VectorTable, rows: number[]): VectorTable {
  const scales = new Float32Array(rows.length);
  const data = new Int8Array(rows.length * table.dims);
  rows.forEach((row, i) => {
    scales[i] = table.scales[row]!;
    data.set(table.data.subarray(row * table.dims, (row + 1) * table.dims), i * table.dims);
  });
  return { count: rows.length, dims: table.dims, scales, data };
}

/** Cosine-like similarity of a normalised float query against row `row`. */
export function dot(table: VectorTable, row: number, query: Float32Array): number {
  const { dims, data } = table;
  const offset = row * dims;
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += query[i]! * data[offset + i]!;
  return sum * table.scales[row]!;
}

/** Similarity between two stored rows (used for "related posts" without an API call). */
export function dotRows(table: VectorTable, a: number, b: number): number {
  const { dims, data } = table;
  const offsetA = a * dims;
  const offsetB = b * dims;
  let sum = 0;
  for (let i = 0; i < dims; i++) sum += data[offsetA + i]! * data[offsetB + i]!;
  return sum * table.scales[a]! * table.scales[b]!;
}

/** Returns the top-k rows by similarity to a float query. */
export function topK(table: VectorTable, query: Float32Array, k: number): Array<{ row: number; score: number }> {
  if (table.count === 0 || k <= 0) return [];
  if (query.length !== table.dims) throw new Error(`Query has ${query.length} dims; index has ${table.dims}.`);
  const heap: Array<{ row: number; score: number }> = [];
  for (let row = 0; row < table.count; row++) {
    const score = dot(table, row, query);
    if (heap.length < k) {
      heap.push({ row, score });
      if (heap.length === k) heap.sort((x, y) => x.score - y.score);
    } else if (score > heap[0]!.score) {
      heap[0] = { row, score };
      let i = 0;
      while (i + 1 < heap.length && heap[i]!.score > heap[i + 1]!.score) {
        [heap[i], heap[i + 1]] = [heap[i + 1]!, heap[i]!];
        i++;
      }
    }
  }
  return heap.sort((x, y) => y.score - x.score);
}
