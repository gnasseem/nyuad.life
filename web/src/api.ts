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

type SourceKind = 'archive' | 'board' | 'announcement' | 'official';

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

/** The parts of /api/home the client reads. */
export interface HomePayload {
  stats: { posts: number; comments: number; newestPost: string };
  suggestions: Array<{ topic: string; question: string }>;
}

/** The parts of /api/health the client reads. */
export interface Health {
  ok: boolean;
  gemini: { configured: boolean };
  embeddings?: { semanticSearch: boolean };
  official?: { pages: number };
  /** `ok` comes from a real probe of the database; `problem` says what is wrong when it is not. */
  board: { configured: boolean; ok?: boolean; problem?: string };
}

/** Why the board cannot be used right now, in a sentence for the screen, or null when it is fine. */
export function boardProblem(health: Health | null): string | null {
  if (!health) return null;
  if (!health.board.configured) return 'The board is not set up on this server.';
  if (health.board.ok === false) return health.board.problem ?? 'The board database is not answering.';
  return null;
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
  /** Weekly email of open questions; undefined on profiles saved before it existed (treated as on). */
  digest?: boolean;
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

export type OfferSide = 'sell' | 'buy';
export type ContactKind = 'whatsapp' | 'instagram' | 'email' | 'phone';

export interface Offer {
  id: string;
  side: OfferSide;
  amount: number;
  rate: number;
  contactKind: ContactKind;
  contact: string;
  note: string;
  posterName: string;
  status: 'open' | 'done';
  expiresAt: string;
  createdAt: string;
}

export interface MarketSummary {
  open: number;
  selling: number;
  buying: number;
  bestAsk: number | null;
  bestBid: number | null;
  medianRate: number | null;
  volume: number;
}

export interface LeaderboardEntry {
  netId: string;
  name: string;
  major: string;
  year: Standing;
  answers: number;
  streak: number;
  lastAnswerAt: string;
}

/* ---------- Guide ---------- */

export interface GuideSection {
  id: string;
  label: string;
  blurb: string;
  count: number;
}

export interface GuideItem {
  id: string;
  title: string;
  url: string;
  blurb: string;
  breadcrumbs: string[];
  code?: string;
}

export interface GuideCourse {
  code: string;
  title: string;
  department: string;
  credits?: number;
  threads: number;
  official: boolean;
}

interface GuideSummary {
  overview: string;
  facts: string[];
  students: string[];
  keepInMind: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
  createdAt: string;
}

export interface GuideDetail {
  kind: 'course' | 'page';
  id: string;
  code?: string;
  title: string;
  section: string;
  breadcrumbs?: string[];
  official: { url: string; text: string; fetchedAt: string; credits?: number } | null;
  threads: PostSummary[];
  threadCount: number;
  related?: Array<{ id: string; title: string }>;
  sources: Array<{ n: number; kind: SourceKind; title: string; url: string; postId?: string }>;
  summary: GuideSummary | null;
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

/** Lets a developer point the web app at another API origin from the browser console (localStorage "room.apiBase"). */
function apiBase(): string {
  try {
    return localStorage.getItem('room.apiBase') ?? '';
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
  post: (id: string) => request<{ post: PostDetail; related: PostSummary[] }>(`/api/post?id=${encodeURIComponent(id)}`),
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
    offers: (key: string) => request<{ offers: Offer[]; mine: Offer[]; market: MarketSummary }>(`/api/board?op=offers&key=${encodeURIComponent(key)}`),
    offer: (body: { netId: string; key: string; side: OfferSide; amount: number; rate: number; contactKind: ContactKind; contact: string; note?: string }) => post<{ offer: Offer }>('/api/board', { op: 'offer', ...body }),
    offerDone: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'offer_done', ...body }),
    unoffer: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unoffer', ...body }),
    leaderboard: () => request<{ helpers: LeaderboardEntry[] }>('/api/board?op=leaderboard'),
    digest: (body: { netId: string; on: boolean }) => post<{ ok: true; digest: boolean }>('/api/board', { op: 'digest', ...body }),
  },
  guide: {
    sections: () => request<{ official: { available: boolean; pages: number; fetchedAt: string }; sections: GuideSection[] }>('/api/guide'),
    section: (id: string) => request<{ section: string; label: string; items: GuideItem[] }>(`/api/guide?section=${encodeURIComponent(id)}`),
    courses: (q = '') => request<{ section: 'courses'; items: GuideCourse[] }>(`/api/guide?section=courses&q=${encodeURIComponent(q)}`),
    item: (id: string) => request<GuideDetail>(`/api/guide?item=${encodeURIComponent(id)}`),
    course: (code: string) => request<GuideDetail>(`/api/guide?course=${encodeURIComponent(code)}`),
  },
};

interface AskHandlers {
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
