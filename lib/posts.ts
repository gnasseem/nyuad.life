/** Reading, normalising and enriching the posts file that the scraper writes and the indexer reads. */
import { createReadStream, existsSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { classifyTopics } from './topics.ts';
import { collapseWhitespace, dayNumber, extractCourseCodes } from './text.ts';
import type { IndexedPost, SourceComment, SourcePost } from './types.ts';

export async function readPostsJsonl(file: string): Promise<SourcePost[]> {
  if (!existsSync(file)) return [];
  const posts: SourcePost[] = [];
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    try {
      posts.push(normalizePost(JSON.parse(line) as Partial<SourcePost>));
    } catch (error) {
      throw new Error(`Invalid JSON on ${file} line ${lineNumber}: ${(error as Error).message}`);
    }
  }
  return posts;
}

/** Writes atomically so a crash mid-write never leaves a truncated archive behind. */
export async function writePostsJsonl(file: string, posts: SourcePost[]): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, posts.map((post) => JSON.stringify(post)).join('\n') + '\n', 'utf8');
  await rename(tmp, file);
}

export function normalizePost(raw: Partial<SourcePost>): SourcePost {
  const comments = (raw.comments ?? [])
    .map(normalizeComment)
    .filter((comment) => comment.text || comment.author);
  const post: SourcePost = {
    id: String(raw.id ?? '').trim(),
    url: String(raw.url ?? '').trim(),
    author: collapseWhitespace(String(raw.author ?? '')),
    date: normalizeDate(String(raw.date ?? '')),
    text: String(raw.text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    comments,
  };
  if (typeof raw.reactions === 'number') post.reactions = raw.reactions;
  post.commentCount = Math.max(typeof raw.commentCount === 'number' ? raw.commentCount : 0, comments.length);
  if (raw.scrapedAt) post.scrapedAt = raw.scrapedAt;
  return post;
}

function normalizeComment(raw: Partial<SourceComment>): SourceComment {
  return {
    author: collapseWhitespace(String(raw.author ?? '')),
    date: normalizeDate(String(raw.date ?? '')),
    text: String(raw.text ?? '').replace(/\r\n?/g, '\n').trim(),
  };
}

/** Accepts ISO dates, ISO timestamps and unix seconds; anything else becomes "". */
export function normalizeDate(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /unknown/i.test(trimmed)) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (iso) return iso[1]!;
  if (/^\d{9,10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000).toISOString().slice(0, 10);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return '';
  // Date-only strings like "March 3, 2025" parse as local midnight, so read the local calendar day back out.
  const local = new Date(parsed);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
}

/** Merges a new batch into an existing archive: newer scrapes win, comments are unioned. */
export function mergePosts(existing: SourcePost[], incoming: SourcePost[]): { posts: SourcePost[]; added: number; updated: number } {
  const byId = new Map(existing.map((post) => [post.id, post]));
  let added = 0;
  let updated = 0;
  for (const post of incoming) {
    if (!post.id) continue;
    const current = byId.get(post.id);
    if (!current) {
      byId.set(post.id, post);
      added++;
      continue;
    }
    const merged: SourcePost = {
      ...current,
      ...post,
      text: post.text.length >= current.text.length ? post.text : current.text,
      date: post.date || current.date,
      url: post.url || current.url,
      comments: unionComments(current.comments, post.comments),
      // Compared without the timestamp so a re-scrape that found nothing new leaves the line untouched.
      scrapedAt: current.scrapedAt,
    };
    merged.commentCount = Math.max(current.commentCount ?? 0, post.commentCount ?? 0, merged.comments.length);
    merged.reactions = Math.max(current.reactions ?? 0, post.reactions ?? 0) || undefined;
    if (JSON.stringify(merged) === JSON.stringify(current)) continue;
    updated++;
    if (post.scrapedAt) merged.scrapedAt = post.scrapedAt;
    byId.set(post.id, merged);
  }
  return { posts: sortNewestFirst([...byId.values()]), added, updated };
}

function unionComments(a: SourceComment[], b: SourceComment[]): SourceComment[] {
  const seen = new Set<string>();
  const out: SourceComment[] = [];
  for (const comment of [...a, ...b]) {
    const key = `${comment.author}|${collapseWhitespace(comment.text).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(comment);
  }
  return out;
}

export function sortNewestFirst<T extends SourcePost>(posts: T[]): T[] {
  return [...posts].sort((a, b) => {
    const da = dayNumber(a.date);
    const db = dayNumber(b.date);
    if (Number.isNaN(da) && Number.isNaN(db)) return 0;
    if (Number.isNaN(da)) return 1;
    if (Number.isNaN(db)) return -1;
    return db - da;
  });
}

export function enrichPost(post: SourcePost): IndexedPost {
  const commentTexts = post.comments.map((comment) => comment.text);
  return {
    ...post,
    topics: classifyTopics(post.text, commentTexts),
    courses: extractCourseCodes([post.text, ...commentTexts].join('\n')),
  };
}
