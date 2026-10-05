/**
 * A cross-encoder reranker: reads the question and each candidate together and scores how well the candidate answers
 * it, which ranks far better than fused keyword and vector ranks. Voyage AI's, on the same key that embeds the index.
 * ROR_RERANKER=none switches it off, and callers fall back to their own ordering when it is missing or fails.
 */
import { postJson } from './embeddings.ts';

export interface Reranker {
  name: string;
  /** Relevance of each document to the query, between 0 and 1, in the documents' order. */
  rerank(query: string, documents: string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<number[]>;
}

const DEFAULT_VOYAGE_RERANK_MODEL = 'rerank-2.5';

export function rerankerFromEnv(env: NodeJS.ProcessEnv = process.env): Reranker | null {
  if ((env.ROR_RERANKER ?? '').trim().toLowerCase() === 'none') return null;
  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.VOYAGE_BASE_URL ?? 'https://api.voyageai.com/v1').replace(/\/$/, '');
  const model = env.VOYAGE_RERANK_MODEL?.trim() || DEFAULT_VOYAGE_RERANK_MODEL;
  return {
    name: model,
    async rerank(query, documents, options = {}) {
      if (documents.length === 0) return [];
      const json = (await postJson(
        `${baseUrl}/rerank`,
        { authorization: `Bearer ${apiKey}` },
        { query, documents, model, truncation: true },
        { retries: 1, timeoutMs: options.timeoutMs ?? 6_000, maxWaitMs: 1_500, signal: options.signal },
        'Voyage rerank',
      )) as { data?: Array<{ index?: number; relevance_score?: number }> };
      const scores = new Array<number>(documents.length).fill(0);
      let seen = 0;
      for (const item of json.data ?? []) {
        if (Number.isInteger(item.index) && item.index! >= 0 && item.index! < documents.length && typeof item.relevance_score === 'number') {
          scores[item.index!] = item.relevance_score;
          seen++;
        }
      }
      if (seen < documents.length) throw new Error(`Voyage rerank scored ${seen} of ${documents.length} documents.`);
      return scores;
    },
  };
}
