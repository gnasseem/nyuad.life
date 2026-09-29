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
  model: string;
  dimensions: number;
  builtAt: string;
  posts: number;
  comments: number;
  chunks: number;
  quantization: 'int8';
  newestPost: string;
  oldestPost: string;
}

/** What the API returns as a citation. */
export interface SourceCard {
  n: number;
  postId: string;
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

export interface AskResponse {
  answer: string;
  sources: SourceCard[];
  followups: string[];
  model: string;
  retrieval: {
    candidates: number;
    reranked: boolean;
    ms: number;
  };
}
