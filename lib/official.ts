/**
 * Official NYUAD pages (nyuad.nyu.edu, the student portal and the NYU bulletin for Abu Dhabi), crawled by
 * scripts/scrape-official.ts into data/official.jsonl and embedded into data/official-index. They are the authority
 * for requirements, policies and programme facts; the group archive supplies experience. Loaded once per process.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { chunkDocument } from './chunker.ts';
import { EmbeddingError, embedderForIndex, PROVIDER_LABELS, type Embedder } from './embeddings.ts';
import { bm25Query, buildBm25, denseQuery, type Bm25Index } from './search.ts';
import { dataRoot } from './store.ts';
import { bestWindow, collapseWhitespace, extractCourseCodes, tokenize, truncate } from './text.ts';
import type { Chunk, IndexMeta, SourceCard } from './types.ts';
import { concatTables, decodeTable, emptyTable, encodeTable, quantize, selectRows, type VectorTable } from './vectors.ts';

export const OFFICIAL_SECTIONS = [
  'majors', 'minors', 'core', 'courses', 'study-away', 'academics', 'admissions', 'housing', 'campus', 'health', 'money', 'visa', 'careers', 'research', 'policies', 'other',
] as const;
export type OfficialSection = (typeof OFFICIAL_SECTIONS)[number];

export const SECTION_LABELS: Record<OfficialSection, string> = {
  majors: 'Majors',
  minors: 'Minors',
  core: 'Core Curriculum',
  courses: 'Courses',
  'study-away': 'Study away',
  academics: 'Academics',
  admissions: 'Admissions',
  housing: 'Housing',
  campus: 'Campus life',
  health: 'Health & wellbeing',
  money: 'Money & financial aid',
  visa: 'Visa & travel',
  careers: 'Careers & internships',
  research: 'Research',
  policies: 'Policies',
  other: 'Other',
};

export interface OfficialDoc {
  /** Stable id derived from the URL. */
  id: string;
  url: string;
  title: string;
  section: OfficialSection;
  breadcrumbs: string[];
  text: string;
  /** Set for course entries parsed out of the bulletin, e.g. "CS-UH 1001". */
  code?: string;
  /** Credits, for course entries. */
  credits?: number;
  fetchedAt: string;
}

export function officialId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** Which guide section a page belongs to, from its URL and title. Order matters: the first match wins. */
export function classifySection(url: string, title = ''): OfficialSection {
  const haystack = `${url.toLowerCase()} ${title.toLowerCase()}`;
  const rules: Array<[OfficialSection, RegExp]> = [
    ['courses', /bulletins\.nyu\.edu\/.*\/courses|\/courses\/|course-list|course-catalog|course-descriptions/],
    ['minors', /minor/],
    ['majors', /major|programs?-of-study|degree-program/],
    ['core', /core-curriculum|\/core\b|colloqui/],
    ['study-away', /study-away|global-education|j-?term|global-network|studyaway/],
    ['admissions', /admission|apply|financial-aid-and-admission|candidate-weekend/],
    ['housing', /housing|residen|dorm|dining/],
    ['visa', /visa|immigration|travel|emirates-id|passport/],
    ['money', /financial|tuition|stipend|scholarship|bursar|money|banking/],
    ['health', /health|wellness|counsel|insurance|safety/],
    ['careers', /career|internship|cdc\b|employment|job/],
    ['research', /research|capstone|lab|fellowship|grant/],
    ['policies', /polic|conduct|academic-integrity|regulation|handbook/],
    ['campus', /campus-life|student-life|clubs?|sig\b|athletics|arts-center|community|events/],
    ['academics', /academic|registrar|registration|advising|curriculum|degree/],
  ];
  for (const [section, pattern] of rules) if (pattern.test(haystack)) return section;
  return 'other';
}

/* ---------- Files ---------- */

export function officialFile(): string {
  return process.env.ROR_OFFICIAL_FILE ?? path.join(dataRoot(), 'data', 'official.jsonl');
}

export function officialIndexDir(): string {
  return process.env.ROR_OFFICIAL_INDEX_DIR ?? path.join(dataRoot(), 'data', 'official-index');
}

export function readOfficialJsonl(file: string): OfficialDoc[] {
  if (!existsSync(file)) return [];
  const out: OfficialDoc[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const doc = JSON.parse(line) as OfficialDoc;
      if (doc.url && doc.text) out.push({ ...doc, id: doc.id || officialId(doc.url), section: OFFICIAL_SECTIONS.includes(doc.section) ? doc.section : classifySection(doc.url, doc.title) });
    } catch {
      // skip a broken line rather than lose the whole file
    }
  }
  return out;
}

export function writeOfficialJsonl(file: string, docs: OfficialDoc[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, docs.map((doc) => JSON.stringify(doc)).join('\n') + (docs.length ? '\n' : ''));
}

function chunkOfficial(docs: OfficialDoc[], options: { model: string; dimensions: number }): Chunk[] {
  return docs.flatMap((doc) => chunkDocument(doc.id, `${doc.title} (${SECTION_LABELS[doc.section]}, official NYUAD page)`, doc.text, options));
}

/* ---------- The loaded corpus ---------- */

export interface OfficialCorpus {
  meta: IndexMeta;
  docs: OfficialDoc[];
  docPosition: Map<string, number>;
  chunks: Chunk[];
  chunkDoc: Int32Array;
  vectors: VectorTable;
  bm25: Bm25Index;
  bySection: Map<OfficialSection, number[]>;
  /** Course code -> doc position, for bulletin course entries. */
  byCode: Map<string, number>;
  source: 'index' | 'official.jsonl' | 'none';
}

let cached: Promise<OfficialCorpus> | undefined;

export function loadOfficial(): Promise<OfficialCorpus> {
  if (!cached) {
    cached = Promise.resolve().then(load).catch((error) => {
      cached = undefined;
      throw error;
    });
  }
  return cached;
}

/** Test hook. */
export function resetOfficial(): void {
  cached = undefined;
}

function load(): OfficialCorpus {
  const dir = officialIndexDir();
  const metaFile = path.join(dir, 'meta.json');
  if (existsSync(metaFile) && existsSync(path.join(dir, 'docs.json.gz')) && existsSync(path.join(dir, 'chunks.json.gz'))) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as IndexMeta;
    const docs = JSON.parse(gunzipSync(readFileSync(path.join(dir, 'docs.json.gz'))).toString('utf8')) as OfficialDoc[];
    const chunks = JSON.parse(gunzipSync(readFileSync(path.join(dir, 'chunks.json.gz'))).toString('utf8')) as Chunk[];
    let vectors = emptyTable(meta.dimensions);
    const vectorFile = path.join(dir, 'vectors.bin');
    if (existsSync(vectorFile)) {
      vectors = decodeTable(readFileSync(vectorFile));
      if (vectors.count !== chunks.length) vectors = emptyTable(meta.dimensions);
    }
    return assemble(meta, docs, chunks, vectors, 'index');
  }
  const docs = readOfficialJsonl(officialFile());
  const chunks = chunkOfficial(docs, { model: 'none', dimensions: 0 });
  const meta = metaFor(docs, chunks, 'none', 0);
  return assemble(meta, docs, chunks, emptyTable(0), docs.length ? 'official.jsonl' : 'none');
}

function metaFor(docs: OfficialDoc[], chunks: Chunk[], model: string, dimensions: number): IndexMeta {
  const dates = docs.map((doc) => doc.fetchedAt).filter(Boolean).sort();
  return { version: 2, model, dimensions, builtAt: new Date().toISOString(), posts: docs.length, comments: 0, chunks: chunks.length, quantization: 'int8', newestPost: dates.at(-1) ?? '', oldestPost: dates[0] ?? '' };
}

function assemble(meta: IndexMeta, docs: OfficialDoc[], chunks: Chunk[], vectors: VectorTable, source: OfficialCorpus['source']): OfficialCorpus {
  const docPosition = new Map(docs.map((doc, index) => [doc.id, index]));
  const chunkDoc = new Int32Array(chunks.length);
  chunks.forEach((chunk, row) => {
    const position = docPosition.get(chunk.postId);
    if (position === undefined) throw new Error(`Official chunk ${chunk.id} refers to a missing document.`);
    chunkDoc[row] = position;
  });
  const bySection = new Map<OfficialSection, number[]>();
  const byCode = new Map<string, number>();
  docs.forEach((doc, index) => {
    bySection.set(doc.section, [...(bySection.get(doc.section) ?? []), index]);
    if (doc.code) byCode.set(doc.code, index);
  });
  return { meta, docs, docPosition, chunks, chunkDoc, vectors, bm25: buildBm25(chunks.map((chunk) => chunk.text)), bySection, byCode, source };
}

/* ---------- Retrieval ---------- */

interface OfficialHit {
  doc: number;
  chunk: number;
  score: number;
}

/** Hybrid search over official pages, grouped to one best chunk per page. `vector` is reused when the caller embedded the query already. */
export async function retrieveOfficial(corpus: OfficialCorpus, query: string, options: { k?: number; vector?: Float32Array; embedder?: Embedder | null; section?: OfficialSection } = {}): Promise<{ hits: OfficialHit[]; terms: string[] }> {
  const terms = tokenize(query);
  const k = options.k ?? 8;
  if (corpus.chunks.length === 0) return { hits: [], terms };
  const depth = Math.max(60, k * 6);
  const lexical = bm25Query(corpus.bm25, terms, depth);
  let dense: Array<{ row: number; score: number }> = [];
  if (corpus.vectors.count > 0 && corpus.meta.model !== 'none') {
    let vector = options.vector;
    if (!vector || vector.length !== corpus.meta.dimensions) {
      const embedder = options.embedder === undefined ? embedderForIndex(corpus.meta) : options.embedder;
      if (embedder) {
        try {
          [vector] = await embedder.embed([query], 'query', { retries: 1, timeoutMs: 12_000 });
        } catch {
          vector = undefined;
        }
      }
    }
    if (vector) dense = denseQuery(corpus.vectors, vector, depth);
  }
  const perChunk = new Map<number, number>();
  lexical.forEach(({ row }, rank) => perChunk.set(row, (perChunk.get(row) ?? 0) + 1 / (60 + rank + 1)));
  dense.forEach(({ row }, rank) => perChunk.set(row, (perChunk.get(row) ?? 0) + 1 / (60 + rank + 1)));
  const perDoc = new Map<number, OfficialHit>();
  for (const [chunk, score] of perChunk) {
    const doc = corpus.chunkDoc[chunk]!;
    if (options.section && corpus.docs[doc]!.section !== options.section) continue;
    const current = perDoc.get(doc);
    if (!current || score > current.score) perDoc.set(doc, { doc, chunk, score });
  }
  return { hits: [...perDoc.values()].sort((a, b) => b.score - a.score).slice(0, k), terms };
}

export function officialCards(corpus: OfficialCorpus, hits: OfficialHit[], terms: string[], startAt: number): SourceCard[] {
  return hits.map((hit, index) => {
    const doc = corpus.docs[hit.doc]!;
    const passage = corpus.chunks[hit.chunk]!.text.split('\n').slice(1).join(' ');
    return {
      n: startAt + index,
      kind: 'official',
      postId: doc.id,
      title: doc.title,
      url: doc.url,
      author: 'NYU Abu Dhabi',
      date: doc.fetchedAt.slice(0, 10),
      text: truncate(doc.text, 600),
      commentCount: 0,
      reactions: 0,
      topics: [doc.section],
      courses: doc.code ? [doc.code] : extractCourseCodes(doc.title),
      snippet: bestWindow(passage, terms, 300),
      score: Number(hit.score.toFixed(4)),
    };
  });
}

/** How an official page is rendered inside the model's sources block. */
export function officialSourceBlock(corpus: OfficialCorpus, card: SourceCard, chunkText?: string): string {
  const doc = corpus.docs[corpus.docPosition.get(card.postId)!]!;
  const body = chunkText ? collapseWhitespace(chunkText.split('\n').slice(1).join(' ')) : collapseWhitespace(doc.text);
  return [`[${card.n}] Official NYUAD page (${SECTION_LABELS[doc.section]}): ${doc.title} · ${doc.url} · fetched ${card.date}`, truncate(body, 3000)].join('\n');
}

/* ---------- Building the index ---------- */

interface OfficialBuildOptions {
  file: string;
  outDir: string;
  embedder: Embedder | null;
  batchSize?: number;
  concurrency?: number;
  log?: (message: string) => void;
}

export async function buildOfficialIndex(options: OfficialBuildOptions): Promise<{ docs: number; chunks: number; embedded: number; reused: number }> {
  const log = options.log ?? (() => {});
  const docs = readOfficialJsonl(options.file);
  if (docs.length === 0) throw new Error(`No official pages found in ${options.file}. Run npm run scrape:official first.`);
  const model = options.embedder?.model ?? 'none';
  const dimensions = options.embedder?.dimensions ?? 0;
  const chunks = chunkOfficial(docs, { model, dimensions });
  mkdirSync(options.outDir, { recursive: true });
  let table = emptyTable(dimensions);
  let embedded = 0;
  let reused = 0;
  if (options.embedder) {
    const known = loadKnown(options.outDir, model, dimensions);
    const missing = chunks.filter((chunk) => !known.rows.has(chunk.hash));
    reused = chunks.length - missing.length;
    log(`${docs.length} pages, ${chunks.length} chunks; ${reused} already embedded, ${missing.length} to embed with ${PROVIDER_LABELS[options.embedder.provider]} ${model}.`);
    if (missing.length) embedded = await embedAll(options.embedder, missing, known, options, log);
    table = selectRows(known.table, chunks.map((chunk) => known.rows.get(chunk.hash)!));
  } else {
    log(`${docs.length} pages, ${chunks.length} chunks, keyword-only.`);
  }
  const meta = metaFor(docs, chunks, model, dimensions);
  if (options.embedder) meta.provider = options.embedder.provider;
  writeFileSync(path.join(options.outDir, 'docs.json.gz'), gzipSync(JSON.stringify(docs)));
  writeFileSync(path.join(options.outDir, 'chunks.json.gz'), gzipSync(JSON.stringify(chunks)));
  if (table.count > 0) writeFileSync(path.join(options.outDir, 'vectors.bin'), encodeTable(table));
  writeFileSync(path.join(options.outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return { docs: docs.length, chunks: chunks.length, embedded, reused };
}

interface Known {
  rows: Map<string, number>;
  table: VectorTable;
}

/** The published index doubles as the embedding cache: chunks whose hash is already there are not embedded again. */
function loadKnown(dir: string, model: string, dimensions: number): Known {
  const metaFile = path.join(dir, 'meta.json');
  const chunksFile = path.join(dir, 'chunks.json.gz');
  const vectorsFile = path.join(dir, 'vectors.bin');
  if (existsSync(metaFile) && existsSync(chunksFile) && existsSync(vectorsFile)) {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as IndexMeta;
    if (meta.model === model && meta.dimensions === dimensions) {
      const chunks = JSON.parse(gunzipSync(readFileSync(chunksFile)).toString('utf8')) as Chunk[];
      const table = decodeTable(readFileSync(vectorsFile));
      if (table.count === chunks.length) return { rows: new Map(chunks.map((chunk, row) => [chunk.hash, row])), table };
    }
  }
  return { rows: new Map(), table: emptyTable(dimensions) };
}

async function embedAll(embedder: Embedder, missing: Chunk[], known: Known, options: OfficialBuildOptions, log: (message: string) => void): Promise<number> {
  const batchSize = Math.min(embedder.maxBatch, Math.max(1, options.batchSize ?? embedder.batchSize));
  const concurrency = Math.max(1, options.concurrency ?? embedder.concurrency);
  const batches: Chunk[][] = [];
  for (let i = 0; i < missing.length; i += batchSize) batches.push(missing.slice(i, i + batchSize));
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++]!;
      let vectors: Float32Array[] | undefined;
      for (let attempt = 0; !vectors; attempt++) {
        try {
          vectors = await embedder.embed(
            batch.map((chunk) => chunk.text),
            'document',
            { retries: 4 },
          );
        } catch (error) {
          if (!(error instanceof EmbeddingError) || !error.retryable || attempt > 20) throw error;
          const wait = Math.min(120_000, error.retryAfterMs ?? 5_000 * (attempt + 1));
          log(`${PROVIDER_LABELS[embedder.provider]} said "${error.message.slice(0, 100)}"; waiting ${Math.round(wait / 1000)}s.`);
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
      const start = known.table.count;
      known.table = concatTables(known.table, quantize(vectors, embedder.dimensions));
      batch.forEach((chunk, i) => known.rows.set(chunk.hash, start + i));
      done += batch.length;
      log(`Embedded ${done}/${missing.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return done;
}
