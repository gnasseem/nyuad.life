/** Typed client for the ROR Answers API, including the streaming /api/ask protocol. */

export interface PostSummary {
  id: string;
  url: string;
  author: string;
  date: string;
  text: string;
  preview: string;
  snippet: string;
  commentCount: number;
  reactions: number;
  topics: string[];
  courses: string[];
  score?: number;
}

export interface Comment {
  author: string;
  date: string;
  text: string;
}

export interface PostDetail extends PostSummary {
  comments: Comment[];
}

export interface SourceCard {
  n: number;
  postId: string;
  url: string;
  author: string;
  date: string;
  text: string;
  commentCount: number;
  reactions: number;
  topics: string[];
  courses: string[];
  snippet: string;
  score: number;
}

export interface HomePayload {
  stats: { posts: number; comments: number; chunks: number; newestPost: string; oldestPost: string; builtAt: string; semantic: boolean };
  suggestions: Array<{ topic: string; question: string }>;
  trending: PostSummary[];
  latest: PostSummary[];
  topics: Array<{ id: string; label: string; emoji: string; count: number }>;
  courses: Array<{ code: string; count: number }>;
}

export interface SearchParams {
  q?: string;
  topic?: string;
  course?: string;
  author?: string;
  from?: string;
  to?: string;
  sort?: 'relevance' | 'newest' | 'oldest' | 'discussed';
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  dense: boolean;
  terms: string[];
  results: PostSummary[];
}

export interface ChatTurn {
  role: 'user' | 'model';
  content: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const BASE_KEY = 'ror.apiBase';

/** Lets a developer point the web app at another API origin from the browser console (localStorage "ror.apiBase"). */
export function apiBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) ?? '';
  } catch {
    return '';
  }
}

async function failure(response: Response, fallback: string): Promise<ApiError> {
  let code = 'error';
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    code = body.error ?? code;
    message = body.message ?? message;
  } catch {
    // not JSON
  }
  return new ApiError(response.status, code, message);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, init);
  if (!response.ok) throw await failure(response, `Request failed (${response.status}).`);
  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; archive: Record<string, unknown>; gemini: { configured: boolean } }>('/api/health'),
  home: () => request<HomePayload>('/api/home'),
  search: (params: SearchParams) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    return request<SearchResult>(`/api/search?${query.toString()}`);
  },
  post: (id: string) => request<{ post: PostDetail; related: PostSummary[] }>(`/api/post?id=${encodeURIComponent(id)}`),
  courses: (q = '') => request<{ total: number; courses: Array<{ code: string; department: string; count: number; latest: string }> }>(`/api/courses?q=${encodeURIComponent(q)}&limit=300`),
  course: (code: string, page = 1) => request<{ code: string; total: number; page: number; pageSize: number; posts: PostSummary[] }>(`/api/courses?code=${encodeURIComponent(code)}&page=${page}&pageSize=30`),
};

export interface AskHandlers {
  onStatus?(message: string): void;
  onSources?(sources: SourceCard[]): void;
  onDelta?(text: string): void;
  onFollowups?(questions: string[]): void;
  onDone?(info: { model: string; retrieval: { candidates: number; reranked: boolean; ms: number } }): void;
}

/** Streams an answer; resolves with the full text once the server sends `done`. */
export async function askStream(question: string, history: ChatTurn[], handlers: AskHandlers, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${apiBase()}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, history, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) throw await failure(response, `The server answered ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let streamError: Error | undefined;
  const handle = (event: string, data: string) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (event) {
      case 'status':
        handlers.onStatus?.(String(payload.message ?? ''));
        break;
      case 'sources':
        handlers.onSources?.((payload.sources as SourceCard[]) ?? []);
        break;
      case 'delta':
        answer += String(payload.text ?? '');
        handlers.onDelta?.(String(payload.text ?? ''));
        break;
      case 'followups':
        handlers.onFollowups?.((payload.questions as string[]) ?? []);
        break;
      case 'done':
        handlers.onDone?.(payload as { model: string; retrieval: { candidates: number; reranked: boolean; ms: number } });
        break;
      case 'error':
        streamError = new ApiError(500, 'stream_error', String(payload.message ?? 'The answer failed.'));
        break;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) handle(event, dataLines.join('\n'));
    }
  }
  if (streamError) throw streamError;
  return answer;
}
