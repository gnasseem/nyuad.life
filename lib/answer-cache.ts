/**
 * Answers to opening questions, kept for a few hours so the same question asked again (a suggestion on the home page,
 * the question everyone has in registration week) is answered without a model call. Kept in memory per instance, and
 * in the board's summary table when the board is set up, so every instance shares them. Follow-ups are never cached:
 * their answer depends on the conversation before them.
 */
import { createHash } from 'node:crypto';
import type { BoardStore } from './board-store.ts';
import { stem, truncate } from './text.ts';
import type { AskResponse } from './types.ts';

/**
 * A day: questions come a few dozen a day, so a shorter life caught almost nothing. Answers built on posts from this
 * site are never kept (lib/rag.ts), so new notices and board answers still show up at once.
 */
export const ANSWER_TTL_MS = 24 * 3_600_000;
/** Bumped whenever the prompt changes, so answers written under the old one are not served. */
const VERSION = 'v13';
const PREFIX = `answer:${VERSION}:`;
const MAX_HOT = 500;

export type CachedAnswer = Pick<AskResponse, 'answer' | 'sources' | 'model' | 'confidence'> & { createdAt: string };

const hot = new Map<string, CachedAnswer>();
let lastSweep = 0;

/**
 * Words that never change what is asked. Question words, negations and everything else stay: "when does the gym open"
 * and "where is the gym" are different questions, and so are "is it open" and "is it not open".
 */
const FILLER = new Set('a an the is are am was be do does did please pls plz hey hi hello guys anyone anybody someone somebody know tell me i my you your can could would will to of for in on at so just actually currently quick question'.split(' '));

/**
 * Near-duplicates are one question: case, punctuation, spacing, word order, plurals and filler ("hey, does anyone know
 * …", "please") do not make a different one.
 */
export function answerKey(question: string): string {
  const words = question.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter((word) => word && !FILLER.has(word));
  const normalized = [...new Set(words.map(stem))].sort().join(' ');
  return PREFIX + createHash('sha256').update(normalized).digest('base64url').slice(0, 32);
}

function fresh(entry: CachedAnswer | null | undefined, now: number): entry is CachedAnswer {
  return !!entry && typeof entry.answer === 'string' && Array.isArray(entry.sources) && now - Date.parse(entry.createdAt) < ANSWER_TTL_MS;
}

export async function cachedAnswer(store: BoardStore | null, question: string, now = Date.now()): Promise<CachedAnswer | null> {
  const key = answerKey(question);
  const local = hot.get(key);
  if (fresh(local, now)) return local;
  hot.delete(key);
  if (!store) return null;
  const stored = (await store.getSummary(key).catch(() => null))?.payload as CachedAnswer | undefined;
  if (!fresh(stored, now)) return null;
  remember(key, stored);
  return stored;
}

export async function saveAnswer(store: BoardStore | null, question: string, response: AskResponse, now = Date.now()): Promise<void> {
  const key = answerKey(question);
  // Source cards carry long excerpts; the answer page only shows the start of them.
  const sources = response.sources.map((card) => ({ ...card, text: truncate(card.text, 300), snippet: truncate(card.snippet, 300) }));
  const entry: CachedAnswer = { answer: response.answer, sources, model: response.model, confidence: response.confidence, createdAt: new Date(now).toISOString() };
  remember(key, entry);
  if (!store) return;
  try {
    await store.putSummary(key, entry);
    // Now and then, clear out what has expired, so the table does not grow without end.
    if (now - lastSweep > 3_600_000) {
      lastSweep = now;
      await store.deleteSummaries(PREFIX, new Date(now - ANSWER_TTL_MS).toISOString());
    }
  } catch (error) {
    console.warn('[ask] could not cache the answer:', (error as Error).message);
  }
}

function remember(key: string, entry: CachedAnswer): void {
  hot.delete(key);
  hot.set(key, entry);
  if (hot.size > MAX_HOT) hot.delete(hot.keys().next().value!);
}

/** Test hook. */
export function resetAnswerCache(): void {
  hot.clear();
  lastSweep = 0;
}
