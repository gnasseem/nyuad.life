/** Shared data shapes for the scraper, indexer, API and clients. */

export interface SourceComment {
  author: string;
  date: string;
  text: string;
}

/** One Room of Requirement post as stored in data/posts.jsonl. */
export interface SourcePost {
  id: string;
  url: string;
  author: string;
  /** ISO date (YYYY-MM-DD) or "" when unknown. */
  date: string;
  text: string;
  comments: SourceComment[];
  reactions?: number;
  commentCount?: number;
  scrapedAt?: string;
}

/** A post enriched at index time. */
export interface IndexedPost extends SourcePost {
  topics: string[];
  courses: string[];
}

/** A retrievable unit of text: a whole short post, or a slice of a long one with its header repeated. */
export interface Chunk {
  id: string;
  postId: string;
  n: number;
  text: string;
  /** sha256 of text + embedding model + dimensions; lets the indexer skip unchanged chunks. */
  hash: string;
}

export interface IndexMeta {
  version: number;
  /** Embedding model that produced vectors.bin, or "none" for a keyword-only index. */
  model: string;
  /** Which API the model belongs to; missing on indexes built before providers other than Gemini existed. */
  provider?: 'voyage' | 'cloudflare' | 'gemini';
  dimensions: number;
  builtAt: string;
  posts: number;
  comments: number;
  chunks: number;
  quantization: 'int8';
  newestPost: string;
  oldestPost: string;
}

export type SourceKind = 'archive' | 'board' | 'announcement' | 'official';

/** What the API returns as a citation: an archive thread, a board answer, an announcement, or an official NYUAD page. */
export interface SourceCard {
  n: number;
  kind: SourceKind;
  /** Archive post id, board question id or announcement id, depending on kind. */
  postId: string;
  /** Board question or announcement title; empty for archive threads. */
  title: string;
  url: string;
  author: string;
  date: string;
  /** The post body (trimmed). */
  text: string;
  commentCount: number;
  reactions: number;
  topics: string[];
  courses: string[];
  /** The best matching passage for this question. */
  snippet: string;
  score: number;
}

export interface ChatTurn {
  role: 'user' | 'model';
  content: string;
}

export interface AskRequest {
  question: string;
  history?: ChatTurn[];
  stream?: boolean;
}

type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Confidence {
  level: ConfidenceLevel;
  reason: string;
}

export interface AskResponse {
  answer: string;
  sources: SourceCard[];
  followups: string[];
  model: string;
  confidence: Confidence | null;
  /** Set when the question belongs somewhere else; then there is no answer to speak of. */
  redirect?: { domain: string; title: string; message: string; link: { url: string; label: string } };
  retrieval: {
    candidates: number;
    reranked: boolean;
    ms: number;
  };
}
