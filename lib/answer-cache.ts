/**
 * Answers to opening questions, kept for a few hours so the same question asked again (a suggestion on the home page,
 * the question everyone has in registration week) is answered without a model call. Kept in memory per instance, and
 * in the board's summary table when the board is set up, so every instance shares them. Follow-ups are never cached:
 * their answer depends on the conversation before them.
 */
import { createHash } from 'node:crypto';
import type { BoardStore } from './board-store.ts';
import { truncate } from './text.ts';
import type { AskResponse } from './types.ts';

/** Long enough to absorb a busy day, short enough that new notices, listings and board answers show up. */
export const ANSWER_TTL_MS = 6 * 3_600_000;
/** Bumped whenever the prompt changes, so answers written under the old one are not served. */
const VERSION = 'v4';
const PREFIX = `answer:${VERSION}:`;
const MAX_HOT = 500;

export type CachedAnswer = Pick<AskResponse, 'answer' | 'sources' | 'model' | 'confidence'> & { createdAt: string };

const hot = new Map<string, CachedAnswer>();
let lastSweep = 0;

/** Case, punctuation and spacing do not make a different question. */
export function answerKey(question: string): string {
  const normalized = question.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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
