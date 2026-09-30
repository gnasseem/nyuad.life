import { createHash } from 'node:crypto';
import type { Chunk, SourcePost } from './types.ts';
import { collapseWhitespace } from './text.ts';

/** Longest chunk the embedder sees; well under gemini-embedding's 2,048-token input limit. */
export const CHUNK_LIMIT = 1800;
const CONTEXT_BODY = 240;

interface ChunkOptions {
  model: string;
  dimensions: number;
}

/** Renders a post (header, body, comments) into one or more embeddable chunks that each repeat the post context. */
export function chunkPost(post: SourcePost, options: ChunkOptions): Chunk[] {
  const body = collapseWhitespace(post.text ?? '');
  const comments = (post.comments ?? [])
    .map((comment) => {
      const text = collapseWhitespace(comment.text ?? '');
      return text ? `Comment by ${display(comment.author)}: ${text}` : '';
    })
    .filter(Boolean);
  if (!body && comments.length === 0) return [];

  const author = display(post.author);
  const date = (post.date ?? '').trim() || 'unknown date';
  const header = `Post by ${author} on ${date}. ${comments.length} comments.`;
  const rendered = [header, body, ...comments].filter(Boolean).join('\n');

  const make = (text: string, n: number): Chunk => ({
    id: `${post.id}#${n}`,
    postId: post.id,
    n,
    text,
    hash: chunkHash(text, options),
  });

  if (rendered.length <= CHUNK_LIMIT) return [make(rendered, 1)];

  const context = [header, body.slice(0, CONTEXT_BODY)].filter(Boolean).join('\n');
  const payloadLimit = Math.max(400, CHUNK_LIMIT - context.length - 1);
  const parts = [...splitAtSentences(body, payloadLimit)];
  for (const comment of comments) parts.push(...splitAtSentences(comment, payloadLimit));
  return pack(parts, payloadLimit).map((payload, index) => make(`${context}\n${payload}`, index + 1));
}

export function chunkPosts(posts: SourcePost[], options: ChunkOptions): Chunk[] {
  return posts.flatMap((post) => chunkPost(post, options));
}

/** Chunks any document: a header repeated on every chunk, then the body split at sentences and packed to the limit. */
export function chunkDocument(id: string, header: string, body: string, options: ChunkOptions): Chunk[] {
  const clean = collapseWhitespace(body);
  if (!clean) return [];
  const make = (text: string, n: number): Chunk => ({ id: `${id}#${n}`, postId: id, n, text, hash: chunkHash(text, options) });
  const whole = `${header}\n${clean}`;
  if (whole.length <= CHUNK_LIMIT) return [make(whole, 1)];
  const payloadLimit = Math.max(400, CHUNK_LIMIT - header.length - 1);
  return pack(splitAtSentences(clean, payloadLimit), payloadLimit).map((payload, index) => make(`${header}\n${payload}`, index + 1));
}

function chunkHash(text: string, options: ChunkOptions): string {
  return createHash('sha256').update(`${options.model}|${options.dimensions}|${text}`).digest('hex').slice(0, 24);
}

function splitAtSentences(text: string, limit: number): string[] {
  if (!text) return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim())
    .flatMap((sentence) => hardSplit(sentence.trim(), limit));
}

function hardSplit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const space = rest.lastIndexOf(' ', limit);
    const breakAt = space > limit / 2 ? space : limit;
    out.push(rest.slice(0, breakAt).trim());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function pack(parts: string[], limit: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current && current.length + 1 + part.length > limit) {
      out.push(current);
      current = '';
    }
    current = current ? `${current}\n${part}` : part;
  }
  if (current) out.push(current);
  return out;
}

function display(value: string | undefined): string {
  return (value ?? '').trim() || 'Unknown';
}
