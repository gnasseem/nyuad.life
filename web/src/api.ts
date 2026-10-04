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

type SourceKind = 'archive' | 'board' | 'announcement' | 'official' | 'schedule';

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
  suggestions: Array<{ topic: string; question: string }>;
}

/** The parts of /api/health the client reads. */
export interface Health {
  ok: boolean;
  gemini: { configured: boolean; chatModel?: string };
  embeddings?: { semanticSearch: boolean; provider?: string | null };
  archive?: { posts: number; comments: number; newestPost: string };
  official?: { pages: number; courses?: number; fetchedAt?: string; hint?: string };
  /** `ok` comes from a real probe of the database; `problem` says what is wrong when it is not. */
  board: { configured: boolean; persistent?: boolean; ok?: boolean; code?: string; problem?: string; hint?: string };
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
/** falcon: Falcon Dirhams, the Personal Support award. campus: Campus Dirhams, the meal-plan money. */
export type OfferCurrency = 'falcon' | 'campus';
export type ContactKind = 'whatsapp' | 'instagram' | 'email' | 'phone';

export interface Offer {
  id: string;
  /** Missing on servers from before Campus Dirhams, where every offer is Falcons. */
  currency?: OfferCurrency;
  side: OfferSide;
  amount: number;
  rate: number;
  contactKind: ContactKind;
  /** Only on your own posts; anyone else's is fetched with board.contact. */
  contact?: string;
  note: string;
  posterName: string;
  status: 'open' | 'done';
  expiresAt: string;
  createdAt: string;
}

export type ListingKind = 'sell' | 'want' | 'free' | 'ride' | 'lost' | 'found';

export interface Listing {
  id: string;
  kind: ListingKind;
  title: string;
  body: string;
  price: number | null;
  place: string;
  destination: string;
  happensAt?: string;
  seats: number | null;
  contactKind: ContactKind;
  /** Only on your own posts; anyone else's is fetched with board.contact. */
  contact?: string;
  posterName: string;
  status: 'open' | 'done';
  expiresAt: string;
  createdAt: string;
}

export interface ListingDraft {
  kind: ListingKind;
  title?: string;
  body?: string;
  price?: number;
  place?: string;
  destination?: string;
  happensAt?: string;
  seats?: number;
  contactKind: ContactKind;
  contact: string;
}

export interface SearchResult {
  total: number;
  page: number;
  terms: string[];
  results: PostSummary[];
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
  id: string;
  /** This row is the helper who asked. */
  me: boolean;
  name: string;
  major: string;
  year: Standing;
  answers: number;
  lastAnswerAt: string;
}

/* ---------- Courses ---------- */

export type SeatStatus = 'open' | 'waitlist' | 'closed' | 'cancelled';

export interface Meeting {
  days: string[];
  start: string;
  end: string;
  room: string;
}

export interface Section {
  classNumber: string;
  section: string;
  component: string;
  topic: string;
  status: SeatStatus;
  waitlist?: number;
  /** "First 7 weeks", "Second 7 weeks", a date range, or empty for the whole term. */
  session: string;
  meetings: Meeting[];
  instructors: string[];
  notes: string;
}

export interface Term {
  name: string;
  start: string;
  end: string;
}

export interface CourseRow {
  code: string;
  title: string;
  subject: string;
  credits: string;
  core: boolean;
  description: string;
  sections: Section[];
}

export interface CourseSummary {
  overview: string;
  facts: string[];
  students: string[];
  keepInMind: string[];
  confidence: 'high' | 'medium' | 'low';
  sources: Array<{ n: number; kind: SourceKind; title: string; url: string; postId?: string }>;
}

export interface CourseDetail {
  code: string;
  title: string;
  credits: string;
  core: boolean;
  description: string;
  /** Every term in the schedule, newest first. */
  offerings: Array<{ term: string; sections: Section[] }>;
  bulletin: { url: string; text: string } | null;
  current: string;
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

const memo = new Map<string, Promise<unknown>>();

/** One request per session for lists that rarely change (the terms, a term's courses); a failure is forgotten. */
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = memo.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load().catch((error: unknown) => {
      memo.delete(key);
      throw error;
    });
    memo.set(key, hit);
  }
  return hit;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export const api = {
  health: () => request<Health>('/api/health'),
  home: () => request<HomePayload>('/api/home'),
  search: (params: { q?: string; topic?: string; sort?: string; page?: number }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, String(value));
    return request<SearchResult>(`/api/search?${query}`);
  },
  post: (id: string) => request<{ post: PostDetail; related: PostSummary[] }>(`/api/post?id=${encodeURIComponent(id)}`),
  board: {
    stats: () => request<{ open: number; answered: number; answers: number; helpers: number }>('/api/board?op=stats'),
    recent: () => request<{ questions: QuestionWithAnswers[] }>('/api/board?op=recent'),
    question: (id: string) => request<{ question: Question; answers: Answer[] }>(`/api/board?op=question&id=${encodeURIComponent(id)}`),
    mine: (key: string) => request<{ questions: QuestionWithAnswers[] }>(`/api/board?op=mine&key=${encodeURIComponent(key)}`),
    announcements: () => request<{ announcements: Announcement[] }>('/api/board?op=announcements'),
    profile: (body: { netId: string; name: string; major: string; classOf: number }) => post<{ profile: Profile }>('/api/board', { op: 'profile', ...body }),
    ask: (body: { text: string; key: string; name?: string }) => post<{ question?: Question; similar?: QuestionWithAnswers[]; related?: PostSummary[]; redirect?: Redirect }>('/api/board', { op: 'ask', ...body }),
    next: (netId: string, key: string) => post<{ question: Question | null; remaining: number; answered: number }>('/api/board', { op: 'next', netId, key }),
    answer: (body: { netId: string; questionId: string; text: string }) => post<{ answer: Answer; answered: number }>('/api/board', { op: 'answer', ...body }),
    skip: (body: { netId: string; questionId: string }) => post<{ ok: true }>('/api/board', { op: 'skip', ...body }),
    announce: (body: { netId: string; key: string; title: string; body: string; kind: AnnouncementKind; startsAt?: string; location?: string; link?: string }) => post<{ announcement: Announcement }>('/api/board', { op: 'announce', ...body }),
    unannounce: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unannounce', ...body }),
    offers: (key: string) => request<{ offers: Offer[]; mine: Offer[]; market: MarketSummary; markets?: Record<OfferCurrency, MarketSummary> }>(`/api/board?op=offers&key=${encodeURIComponent(key)}`),
    offer: (body: { netId: string; key: string; currency: OfferCurrency; side: OfferSide; amount: number; rate: number; contactKind: ContactKind; contact: string; note?: string }) => post<{ offer: Offer }>('/api/board', { op: 'offer', ...body }),
    offerDone: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'offer_done', ...body }),
    unoffer: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unoffer', ...body }),
    listings: (key: string) => request<{ listings: Listing[]; mine: Listing[] }>(`/api/board?op=listings&key=${encodeURIComponent(key)}`),
    listing: (body: ListingDraft & { netId: string; key: string }) => post<{ listing: Listing }>('/api/board', { op: 'listing', ...body }),
    listingDone: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'listing_done', ...body }),
    unlisting: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unlisting', ...body }),
    leaderboard: (netId?: string) => request<{ helpers: LeaderboardEntry[] }>(`/api/board?op=leaderboard${netId ? `&netId=${encodeURIComponent(netId)}` : ''}`),
    contact: (type: 'offer' | 'listing', id: string) => request<{ contactKind: ContactKind; contact: string }>(`/api/board?op=contact&type=${type}&id=${encodeURIComponent(id)}`),
  },
  courses: {
    terms: () => cached('terms', () => request<{ terms: Term[]; current: string; scraped: string }>('/api/courses')),
    list: (term: string) => cached(`courses:${term}`, () => request<{ term: string; courses: CourseRow[] }>(`/api/courses?term=${encodeURIComponent(term)}`)),
    detail: (code: string) => request<CourseDetail>(`/api/courses?code=${encodeURIComponent(code)}`),
    threads: (code: string) => cached(`threads:${code}`, () => request<{ threads: PostSummary[] }>(`/api/courses?code=${encodeURIComponent(code)}&threads=1`)),
    summary: (code: string) => cached(`summary:${code}`, () => request<{ summary: CourseSummary | null }>(`/api/courses?code=${encodeURIComponent(code)}&summary=1`)),
  },
};

interface AskHandlers {
  onStatus?(message: string): void;
  onRedirect?(redirect: Redirect): void;
  onSources?(sources: SourceCard[]): void;
  onDelta?(text: string): void;
  onFollowups?(questions: string[]): void;
  onDone?(info: { model: string; confidence: Confidence | null; truncated: boolean }): void;
}

/**
 * Streams an answer. Resolves with the full text and whether it is complete: the server sent `done` and did not stop
 * early. A stream that simply ends (the function was cut off, the connection dropped) resolves as incomplete, so a
 * half answer is never saved as a whole one.
 */
export async function askStream(question: string, history: ChatTurn[], handlers: AskHandlers, signal?: AbortSignal): Promise<{ answer: string; complete: boolean }> {
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
  let finished = false;
  let truncated = false;
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
        finished = true;
        truncated = payload.truncated === true;
        handlers.onDone?.({ model: String(payload.model ?? ''), confidence: (payload.confidence as Confidence | null) ?? null, truncated });
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
  return { answer, complete: finished && !truncated };
}
