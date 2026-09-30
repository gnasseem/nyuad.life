/** Typed client for the API, including the streaming /api/ask protocol and the student board. */

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

export type SourceKind = 'archive' | 'board' | 'announcement';

export interface SourceCard {
  n: number;
  kind: SourceKind;
  postId: string;
  title: string;
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

export interface Confidence {
  level: 'high' | 'medium' | 'low';
  reason: string;
}

export interface Redirect {
  domain: string;
  title: string;
  message: string;
  link: { url: string; label: string };
}

export interface HomePayload {
  stats: { posts: number; comments: number; chunks: number; newestPost: string; oldestPost: string; builtAt: string; semantic: boolean };
  suggestions: Array<{ topic: string; question: string }>;
  trending: PostSummary[];
  latest: PostSummary[];
  topics: Array<{ id: string; label: string; emoji: string; count: number }>;
  courses: Array<{ code: string; count: number }>;
}

export interface Health {
  ok: boolean;
  gemini: { configured: boolean; chatModel?: string };
  embeddings?: { semanticSearch: boolean; provider?: string | null };
  archive?: { posts: number; comments: number; newestPost: string };
  /** `ok` comes from a real probe of the database; `problem` says what is wrong when it is not. */
  board: { configured: boolean; persistent?: boolean; ok?: boolean; code?: string; problem?: string; hint?: string };
}

/** Why the board cannot be used right now, in a sentence for the screen, or null when it is fine. */
export function boardProblem(health: Health | null): string | null {
  if (!health) return null;
  if (!health.board.configured) return 'The board is not set up on this server yet, so questions and announcements are switched off. ' + (health.board.hint ?? '');
  if (health.board.ok === false) return health.board.problem ?? 'The board database is not answering.';
  return null;
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
  redirect: Redirect | null;
  results: PostSummary[];
}

export interface ChatTurn {
  role: 'user' | 'model';
  content: string;
}

/* ---------- Board ---------- */

export type Standing = 'first-year' | 'sophomore' | 'junior' | 'senior' | 'alumni';

export interface Profile {
  netId: string;
  name: string;
  major: string;
  classOf: number;
  year: Standing;
  answers: number;
}

export interface Question {
  id: string;
  text: string;
  summary: string;
  topics: string[];
  courses: string[];
  majors: string[];
  years: Standing[];
  askerName: string;
  status: 'open' | 'answered' | 'closed';
  views: number;
  skips: number;
  answers: number;
  createdAt: string;
  updatedAt: string;
}

export interface Answer {
  id: string;
  questionId: string;
  text: string;
  helperName: string;
  helperMajor: string;
  helperYear: Standing;
  createdAt: string;
}

export type QuestionWithAnswers = Question & { answers: Answer[] };

export type AnnouncementKind = 'event' | 'deadline' | 'opportunity' | 'club' | 'notice';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  kind: AnnouncementKind;
  startsAt?: string;
  location: string;
  link: string;
  posterName: string;
  expiresAt: string;
  createdAt: string;
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

const BASE_KEY = 'room.apiBase';

/** Lets a developer point the web app at another API origin from the browser console (localStorage "room.apiBase"). */
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

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export const api = {
  health: () => request<Health>('/api/health'),
  home: () => request<HomePayload>('/api/home'),
  search: (params: SearchParams) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '' && value !== null) query.set(key, String(value));
    return request<SearchResult>(`/api/search?${query.toString()}`);
  },
  post: (id: string) => request<{ post: PostDetail; related: PostSummary[] }>(`/api/post?id=${encodeURIComponent(id)}`),
  courses: (q = '') => request<{ total: number; courses: Array<{ code: string; department: string; count: number; latest: string }> }>(`/api/courses?q=${encodeURIComponent(q)}&limit=300`),
  course: (code: string, page = 1) => request<{ code: string; total: number; page: number; pageSize: number; posts: PostSummary[] }>(`/api/courses?code=${encodeURIComponent(code)}&page=${page}&pageSize=30`),
  board: {
    stats: () => request<{ open: number; answered: number; answers: number; helpers: number }>('/api/board?op=stats'),
    question: (id: string) => request<{ question: Question; answers: Answer[] }>(`/api/board?op=question&id=${encodeURIComponent(id)}`),
    mine: (key: string) => request<{ questions: QuestionWithAnswers[] }>(`/api/board?op=mine&key=${encodeURIComponent(key)}`),
    announcements: () => request<{ announcements: Announcement[] }>('/api/board?op=announcements'),
    profile: (body: { netId: string; name: string; major: string; classOf: number }) => post<{ profile: Profile }>('/api/board', { op: 'profile', ...body }),
    ask: (body: { text: string; key: string; name?: string }) => post<{ question?: Question; similar?: QuestionWithAnswers[]; related?: PostSummary[]; redirect?: Redirect }>('/api/board', { op: 'ask', ...body }),
    next: (netId: string) => post<{ question: Question | null; remaining: number; answered: number }>('/api/board', { op: 'next', netId }),
    answer: (body: { netId: string; questionId: string; text: string }) => post<{ answer: Answer; answered: number }>('/api/board', { op: 'answer', ...body }),
    skip: (body: { netId: string; questionId: string }) => post<{ ok: true }>('/api/board', { op: 'skip', ...body }),
    announce: (body: { netId: string; key: string; title: string; body: string; kind: AnnouncementKind; startsAt?: string; location?: string; link?: string }) => post<{ announcement: Announcement }>('/api/board', { op: 'announce', ...body }),
    unannounce: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unannounce', ...body }),
  },
};

export interface AskHandlers {
  onStatus?(message: string): void;
  onRedirect?(redirect: Redirect): void;
  onSources?(sources: SourceCard[]): void;
  onDelta?(text: string): void;
  onFollowups?(questions: string[]): void;
  onDone?(info: { model: string; confidence: Confidence | null }): void;
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
      case 'redirect':
        handlers.onRedirect?.(payload as unknown as Redirect);
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
        handlers.onDone?.({ model: String(payload.model ?? ''), confidence: (payload.confidence as Confidence | null) ?? null });
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
