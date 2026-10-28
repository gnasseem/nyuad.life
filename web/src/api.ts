import type { AdminData } from '../../lib/types';
/** Typed client for the API, including the streaming /api/ask protocol and the student board. */
import type { Rules } from '../../lib/schedule.ts';
import { askerKey, loadProfile } from './store';

export interface PostSummary {
  id: string;
  url: string;
  author: string;
  date: string;
  text: string;
  preview: string;
  snippet: string;
  commentCount: number;
  facebookCommentCount?: number;
  scrapedCommentCount?: number;
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

type SourceKind = 'archive' | 'board' | 'announcement' | 'official' | 'schedule' | 'review';

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


/** The parts of /api/health the client reads. */
export interface Health {
  ok: boolean;
  gemini: { configured: boolean; chatModel?: string };
  /** Whether any model (Gemini or a free backup) can write answers; older servers leave it out. */
  answers?: { available: boolean };
  embeddings?: { semanticSearch: boolean; provider?: string | null };
  archive?: { posts: number; comments: number; newestPost: string };
  official?: { pages: number; courses?: number; fetchedAt?: string; hint?: string };
  /** `ok` comes from a real probe of the database; `problem` says what is wrong when it is not. */
  board: { configured: boolean; persistent?: boolean; ok?: boolean; code?: string; problem?: string; hint?: string };
}

/** Sign in with ChatGPT: whether it is set up here, whether answers require it, and who is connected. */
export interface ChatGPTStatus {
  available: boolean;
  required: boolean;
  connected: boolean;
  name: string;
  email: string;
  plan: string;
}

/** Where the "Sign in with ChatGPT" button goes; the server redirects to ChatGPT and back to `returnTo`. */
export function chatgptSignInUrl(returnTo = window.location.pathname + window.location.search): string {
  return `${apiBase()}/api/chatgpt?op=start&returnTo=${encodeURIComponent(returnTo)}`;
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
  helperYear: Standing | '';
  createdAt: string;
}

/** A question with its answers in place of the count of them. */
export type QuestionWithAnswers = Omit<Question, 'answers'> & { answers: Answer[] };

/** What an admin can remove. */
export type AdminTarget = 'question' | 'answer' | 'notice' | 'listing' | 'offer' | 'review';

export interface ModelCheck {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/** working | not used today | key refused | day's quota spent | rate limited | model retired | overloaded | failing */
export type UsageState = 'ok' | 'idle' | 'refused' | 'spent' | 'limited' | 'gone' | 'overloaded' | 'failing';

export interface ModelUsage {
  model: string;
  state: UsageState;
  ok: number;
  failed: number;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  remaining: number | null;
  limit: number | null;
}

export interface KeyUsage {
  key: string;
  label: string;
  hint: string;
  freeTier: string;
  state: UsageState;
  ok: number;
  failed: number;
  week: { ok: number; failed: number };
  models: ModelUsage[];
}

export interface UsageReport {
  day: string;
  keys: KeyUsage[];
  shared: boolean;
  alerts: { to: string[]; last: { at: string; reason: string } | null };
}

/** One day of site usage across every server instance (lib/app-usage.ts), with that day's sign-ups. */
export interface UsageDayStats {
  day: string;
  requests: number;
  errors: number;
  rejected: number;
  limited: number;
  avgMs: number;
  people: number;
  devices: number;
  signups: number;
  events: Partial<Record<'ask' | 'ask_cached' | 'ask_failed' | 'login' | 'signup' | 'question' | 'answer' | 'review' | 'listing' | 'offer' | 'event' | 'plan' | 'rating', number>>;
}

export interface AdminMember {
  netId: string;
  name: string;
  major: string;
  classOf: number;
  answers: number;
  createdAt: string;
  lastSeenAt: string;
  standing: string;
}

/** One Ask question in the admins' log (lib/app-usage.ts), with what the student did with the answer. */
export interface AskLogRow {
  id: string;
  at: string;
  question: string;
  followUp: boolean | null;
  outcome: 'answered' | 'missing' | 'truncated' | 'screened' | 'redirect' | 'failed' | 'stopped' | null;
  model: string | null;
  confidence: string | null;
  sources: string[] | null;
  cached: boolean | null;
  missing: boolean | null;
  firstMs: number | null;
  answer: string | null;
  error: string | null;
  vote: 'up' | 'down' | null;
  asked: boolean | null;
  reported: boolean | null;
}

/** The admin page's numbers (lib/admin.ts dashboard). */
export interface AdminDashboard {
  day: string;
  members: { total: number; today: number; week: number; month: number };
  active: { today: number; week: number; month: number };
  days: UsageDayStats[];
  routes: Array<{ name: string; n: number; err: number; avgMs: number }>;
  hours: number[];
  shared: boolean;
  newest: AdminMember[];
  directory: AdminMember[];
  majors: Array<{ name: string; n: number }>;
  standings: Array<{ name: string; n: number }>;
  board: { questions: number; openQuestions: number; answers: number; reviews: number; listings: number; offers: number; events: number; bans: number };
}

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
  startDate: string;
  endDate: string;
  meetings: Meeting[];
  instructors: string[];
  notes: string;
}

export interface Term {
  name: string;
  start: string;
  end: string;
  courses?: number;
}

export interface PlanSchool { id: string; label: string; group: 'Campus' | 'School' | 'Study away' }

export interface CourseRow {
  code: string;
  title: string;
  subject: string;
  credits: string;
  core: boolean;
  description: string;
  sections: Section[];
}

/** A course once, for the course list. */
export interface CourseEntry {
  code: string;
  title: string;
  subject: string;
  core: boolean;
  people: string[];
  currentPeople: string[];
}

export interface CourseDetail {
  code: string;
  title: string;
  credits: string;
  core: boolean;
  description: string;
  currentTerm: string;
  instructors: string[];
  professors: string[];
}

export interface CourseRating {
  score: number;
  difficulty: number | null;
  workload: number | null;
  verdict: string;
  pros: string[];
  cons: string[];
  tips: string[];
  /** How many posts and comments it rests on: each is one student rating. */
  basis: number;
  confidence: 'high' | 'medium' | 'low';
  counts: RatingCounts;
  /** The course's professors, most discussed first, with how many ratings it got under each (professors are not scored). */
  professors: Array<{ name: string; count: number }>;
  /** The oldest and newest rating, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface RatingCounts {
  positive: number;
  negative: number;
  neutral: number;
}

/** Every course's and professor's score and one-line verdict, from the digests (which count the reviews written here). */
export interface ScoreIndex {
  courses: Record<string, { score: number; basis: number; difficulty: number | null; workload: number | null; verdict: string }>;
  /** Professors are never shown a score; rank (3 to 5, below average raised to average) only orders plans. */
  profs: Record<string, { rank: number; basis: number; verdict: string }>;
}

/** A course's page: the course, its rating, and its professors with theirs. */
export interface CourseView extends Omit<CourseDetail, 'professors'> {
  rating: CourseRating | null;
  professors: Array<{ name: string; basis: number; verdict: string; here: { count: number } | null; teachingNow: boolean; lastTerm: string }>;
  /** Who taught it each term up to now, newest first. */
  offerings: Array<{ term: string; professors: string[] }>;
}

/** A professor's page: their rating and what they teach, this term first. */
export interface ProfView {
  name: string;
  currentTerm: string;
  rating: ProfRating | null;
  courses: Array<{ code: string; title: string; score: number | null; here: { count: number } | null; teachingNow: boolean; lastTerm: string; terms: string[] }>;
}

/** What writing or removing a review changed: the course's and its professors' ratings, recounted. */
export interface Recount {
  course?: CourseRating | null;
  profs?: Record<string, ProfRating | null>;
}

/** A review a student wrote here about a course they took. */
export interface CourseReview {
  id: string;
  code: string;
  authorName: string;
  authorMajor: string;
  authorYear: Standing | '';
  /** The course's stars; null when the student rated only the professor. */
  rating: number | null;
  /** The professor's stars, when given. */
  profRating: number | null;
  difficulty: number | null;
  workload: number | null;
  text: string;
  professor: string;
  courseRated: boolean;
  term: string;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
}

/** What students say a professor's classes are like: how hard, how heavy, the grading. Professors are not scored. */
export interface ProfRating {
  verdict: string;
  /** How many posts and comments it rests on: each is one student rating. */
  basis: number;
  confidence: 'high' | 'medium' | 'low';
  difficulty: number | null;
  workload: number | null;
  likes: string[];
  warnings: string[];
  /** Their courses, most discussed first, with how many ratings each got. */
  courses: Array<{ code: string; count: number }>;
  from: string;
  to: string;
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

/**
 * Lets a developer point the web app at another API origin from the browser console (localStorage "room.apiBase").
 * Development builds only: in production a pasted "fix" could otherwise send everyone's key elsewhere.
 */
function apiBase(): string {
  if (!import.meta.env.DEV) return '';
  try {
    return localStorage.getItem('room.apiBase') ?? '';
  } catch {
    return '';
  }
}

/** Who is asking: the NetID signed up in this browser and the browser's key, in headers (never in the address). */
function identity(): Record<string, string> {
  const profile = loadProfile();
  return profile ? { 'x-ror-netid': profile.netId, 'x-ror-key': askerKey() } : { 'x-ror-key': askerKey() };
}

const signupListeners = new Set<() => void>();
/** Called whenever the server says the visitor has to sign up first (their details are missing or not theirs). */
export function onSignupRequired(listener: () => void): () => void {
  signupListeners.add(listener);
  return () => signupListeners.delete(listener);
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
  if (code === 'signup_required') signupListeners.forEach((listener) => listener());
  return new ApiError(response.status, code, message);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, { ...init, credentials: 'include', headers: { ...identity(), ...(init.headers as Record<string, string> | undefined) } });
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

const RATED_KEY = 'room.rated';

/**
 * A course or professor page is cached at the edge for a minute or so; one this browser has just rated is asked for
 * past that cache for a few minutes, so a reload shows the new score.
 */
function freshness(key: string): string {
  try {
    const at = (JSON.parse(localStorage.getItem(RATED_KEY) ?? '{}') as Record<string, number>)[key] ?? 0;
    return Date.now() - at < 600_000 ? `&v=${at}` : '';
  } catch {
    return '';
  }
}

const recountListeners = new Set<(code: string, result: Recount) => void>();

/** Called whenever this browser writes or removes a review, wherever on the site it happened, with what it changed. */
export function onRecount(listener: (code: string, result: Recount) => void): () => void {
  recountListeners.add(listener);
  return () => recountListeners.delete(listener);
}

/** Takes a recount in: the session's list scores and cached ratings, and the pages to ask for fresh. */
function recounted(code: string, result: Recount): void {
  recountListeners.forEach((listener) => listener(code, result));
  memo.delete('my-reviews');
  const keys = [code, ...Object.keys(result.profs ?? {}).map((name) => `prof:${name}`)];
  try {
    const stamps = JSON.parse(localStorage.getItem(RATED_KEY) ?? '{}') as Record<string, number>;
    for (const key of Object.keys(stamps)) if (Date.now() - stamps[key]! > 600_000) delete stamps[key];
    for (const key of keys) stamps[key] = Date.now();
    localStorage.setItem(RATED_KEY, JSON.stringify(stamps));
  } catch {
    // Storage may be off: the page still shows the new score from the recount.
  }
  const scores = memo.get('scores') as Promise<ScoreIndex> | undefined;
  void scores?.then((index) => {
    if (result.course === null) delete index.courses[code];
    else if (result.course) index.courses[code] = { score: result.course.score, basis: result.course.basis, difficulty: result.course.difficulty, workload: result.course.workload, verdict: result.course.verdict };
    for (const [name, rating] of Object.entries(result.profs ?? {})) {
      if (rating) index.profs[name] = { rank: index.profs[name]?.rank ?? 3, basis: rating.basis, verdict: rating.verdict };
      else delete index.profs[name];
    }
  }).catch(() => undefined);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export const api = {
  health: () => request<Health>('/api/health'),
  feedback: (message: string, page: string, rating?: number) => post<{ ok: true }>('/api/feedback', { message, page, rating }),
  reportAnswer: (question: string, answer: string, reason: string, sources: string[], logId?: string) => post<{ ok: true }>('/api/feedback', { kind: 'ask-report', question, answer, message: reason, sources, logId }),
  /** What the student did with an answer, for the admins' Ask log. */
  markAnswer: (logId: string, marks: { vote?: 'up' | 'down' | null; asked?: true }) => post<{ ok: boolean }>('/api/feedback', { kind: 'ask-mark', logId, ...marks }),
  chatgpt: {
    me: () => request<ChatGPTStatus>('/api/chatgpt?op=me'),
    logout: () => post<{ ok: true }>('/api/chatgpt', { op: 'logout' }),
  },
  search: (params: { q?: string; topic?: string; sort?: string; page?: number }) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) query.set(key, String(value));
    return request<SearchResult>(`/api/search?${query}`);
  },
  post: (id: string) => request<{ post: PostDetail; related: PostSummary[] }>(`/api/post?id=${encodeURIComponent(id)}`),
  auth: {
    me: () => request<{ netId: string; key: string; profile: Profile | null }>('/api/board?op=auth_me'),
    send: (email: string) => post<{ email: string }>('/api/board', { op: 'auth_send', email }),
    verify: (email: string, code: string) => post<{ netId: string; key: string; profile: Profile | null }>('/api/board', { op: 'auth_verify', email, code }),
    logout: () => post<{ ok: boolean }>('/api/board', { op: 'auth_logout' }),
  },
  board: {
    data: () => request<AdminData>('/api/admin?op=data'),
    resolveReport: (id: string, resolved: boolean) => post<{ ok: true }>('/api/admin', { op: 'resolve-report', id, resolved }),
    stats: () => request<{ open: number; answered: number; answers: number; helpers: number }>('/api/board?op=stats'),
    mine: (_key?: string) => request<{ questions: QuestionWithAnswers[] }>('/api/board?op=mine'),
    announcements: () => request<{ announcements: Announcement[] }>('/api/board?op=announcements'),
    // The browser key goes with everything done as a NetID: the server only lets the browser that set a NetID up act as it.
    profile: (body: { netId: string; name: string; major: string; classOf: number }) => post<{ profile: Profile }>('/api/board', { op: 'profile', key: askerKey(), ...body }),
    deleteProfile: (netId: string) => post<{ ok: true }>('/api/board', { op: 'delete_profile', netId, key: askerKey() }),
    ask: (body: { text: string; key: string; name?: string }) => post<{ question?: Question; similar?: QuestionWithAnswers[]; related?: PostSummary[]; redirect?: Redirect }>('/api/board', { op: 'ask', ...body }),
    next: (netId: string, key: string) => post<{ question: Question | null; remaining: number; answered: number }>('/api/board', { op: 'next', netId, key }),
    answer: (body: { netId: string; questionId: string; text: string; anonymous?: boolean }) => post<{ answer: Answer; answered: number }>('/api/board', { op: 'answer', key: askerKey(), ...body }),
    skip: (body: { netId: string; questionId: string }) => post<{ ok: true }>('/api/board', { op: 'skip', key: askerKey(), ...body }),
    announce: (body: { netId: string; key: string; title: string; body: string; kind: AnnouncementKind; startsAt?: string; location?: string; link?: string }) => post<{ announcement: Announcement }>('/api/board', { op: 'announce', ...body }),
    unannounce: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unannounce', ...body }),
    offers: (_key?: string) => request<{ offers: Offer[]; mine: Offer[]; market: MarketSummary; markets?: Record<OfferCurrency, MarketSummary> }>('/api/board?op=offers'),
    offer: (body: { netId: string; key: string; currency: OfferCurrency; side: OfferSide; amount: number; rate: number; contactKind: ContactKind; contact: string; note?: string }) => post<{ offer: Offer }>('/api/board', { op: 'offer', ...body }),
    offerDone: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'offer_done', ...body }),
    unoffer: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unoffer', ...body }),
    listings: (_key?: string) => request<{ listings: Listing[]; mine: Listing[] }>('/api/board?op=listings'),
    listing: (body: ListingDraft & { netId: string; key: string }) => post<{ listing: Listing }>('/api/board', { op: 'listing', ...body }),
    listingDone: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'listing_done', ...body }),
    unlisting: (body: { id: string; key: string }) => post<{ ok: true }>('/api/board', { op: 'unlisting', ...body }),
    reviews: (code: string) => request<{ reviews: CourseReview[]; open?: boolean }>(`/api/board?op=reviews&code=${encodeURIComponent(code)}`),
    profReviews: (name: string) => request<{ reviews: CourseReview[] }>(`/api/board?op=prof_reviews&name=${encodeURIComponent(name)}`),
    review: async (body: { code: string; rating: number | null; profRating: number | null; difficulty: number | null; workload: number | null; text: string; term: string; professor: string; anonymous: boolean }) => {
      const result = await post<{ review: CourseReview } & Recount>('/api/board', { op: 'review', ...body });
      recounted(body.code, result);
      return result;
    },
    unreview: async (code: string) => {
      const result = await post<{ ok: true } & Recount>('/api/board', { op: 'unreview', code });
      recounted(code, result);
      return result;
    },
    myReviews: () => cached('my-reviews', () => request<{ reviews: Array<{ code: string; term: string; professor: string }>; prompted: string[]; off: boolean }>('/api/board?op=my_reviews')),
    prompted: (body: { code?: string; off?: boolean }) => post<{ ok: true }>('/api/board', { op: 'prompted', ...body }),
    contact: (type: 'offer' | 'listing', id: string) => request<{ contactKind: ContactKind; contact: string }>(`/api/board?op=contact&type=${type}&id=${encodeURIComponent(id)}`),
  },
  admin: {
    me: () => request<{ available: boolean; admin: boolean }>('/api/admin?op=me'),
    remove: (body: { type: AdminTarget; id: string; ban?: boolean; reason?: string }) => post<{ ok: true; banned: string | null }>('/api/admin', { op: 'remove', ...body }),
    bans: () => request<{ bans: Array<{ netId: string; reason: string; createdAt: string }> }>('/api/admin?op=bans'),
    unban: (netId: string) => post<{ ok: true }>('/api/admin', { op: 'unban', netId }),
    models: () => request<{ geminiKeyProblem: string | null; results: ModelCheck[] }>('/api/admin?op=models'),
    usage: () => request<UsageReport>('/api/admin?op=usage'),
    alertTest: () => post<{ ok: true; to: string[] }>('/api/admin', { op: 'alert-test' }),
    data: () => request<AdminData>('/api/admin?op=data'),
    resolveReport: (id: string, resolved: boolean) => post<{ ok: true }>('/api/admin', { op: 'resolve-report', id, resolved }),
    stats: () => request<AdminDashboard>('/api/admin?op=stats'),
    audit: () => request<{ audit: Array<{ action: string; target: string; createdAt: string }> }>('/api/admin?op=audit'),
    askLog: () => request<{ questions: AskLogRow[] }>('/api/admin?op=ask-log'),
    askReports: () => request<{ reports: Array<{ id: string; createdAt: string; question: string; answer: string; reason: string; sources: string[]; resolvedAt: string | null }> }>('/api/admin?op=ask-reports'),
  },
  plan: {
    read: (body: { term: string; school: string; text: string; history?: Array<{ role: 'user' | 'assistant'; text: string }>; current: { wants: Array<{ label: string; codes: string[]; sessions?: Array<'71' | '72'> }>; rules: Rules }; major?: string; year?: string }) =>
      post<{ wants: Array<{ label: string; codes: string[]; sessions?: Array<'71' | '72'> }>; rules: Rules; missing: string[]; reply?: string }>('/api/plan', body),
  },
  courses: {
    terms: (school?: string) => cached(`terms:${school ?? ''}`, () => request<{ terms: Term[]; current: string; scraped: string; schools?: PlanSchool[] }>(`/api/courses${school ? `?school=${encodeURIComponent(school)}` : ''}`)),
    list: (term: string, school?: string) => cached(`courses:${term}:${school ?? ''}`, () => request<{ term: string; courses: CourseRow[] }>(`/api/courses?term=${encodeURIComponent(term)}${school ? `&school=${encodeURIComponent(school)}` : ''}`)),
    all: () => cached('courses:all:3', () => request<{ courses: CourseEntry[] }>('/api/courses?all=3')),
    detail: (code: string) => request<CourseDetail>(`/api/courses?code=${encodeURIComponent(code)}`),
    scores: () => cached('scores', () => request<ScoreIndex>('/api/courses?ratings=1')),
    view: (code: string) => request<CourseView>(`/api/courses?code=${encodeURIComponent(code)}&view=1${freshness(code)}`),
    prof: (name: string) => request<ProfView>(`/api/courses?prof=${encodeURIComponent(name)}${freshness(`prof:${name}`)}`),
  },
};

interface AskHandlers {
  onStatus?(message: string): void;
  onRedirect?(redirect: Redirect): void;
  onSources?(sources: SourceCard[]): void;
  onDelta?(text: string): void;
  /** The answer shown so far is replaced: the source check corrected it. */
  onReplace?(text: string): void;
  onDone?(info: { model: string; confidence: Confidence | null; truncated: boolean }): void;
  /** The key the server keeps this question under in the admins' Ask log. */
  onLog?(logId: string): void;
}

let warmedAt = 0;

/**
 * Asks the server to load the archive while the student is still typing, so their question does not wait for a cold
 * instance. At most every two minutes; failures do not matter.
 */
export function warmAsk(): void {
  if (Date.now() - warmedAt < 120_000) return;
  warmedAt = Date.now();
  void fetch(`${apiBase()}/api/ask`, { credentials: 'include' }).catch(() => undefined);
}

/**
 * Streams an answer. Resolves with the full text and whether it is complete: the server sent `done` and did not stop
 * early. A stream that simply ends (the function was cut off, the connection dropped) resolves as incomplete, so a
 * half answer is never saved as a whole one.
 */
export async function askStream(question: string, history: ChatTurn[], handlers: AskHandlers, signal?: AbortSignal): Promise<{ answer: string; complete: boolean }> {
  const response = await fetch(`${apiBase()}/api/ask`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...identity() },
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
      case 'replace':
        answer = String(payload.text ?? '');
        handlers.onReplace?.(answer);
        break;
      case 'done':
        finished = true;
        if (typeof payload.logId === 'string') handlers.onLog?.(payload.logId);
        truncated = payload.truncated === true;
        handlers.onDone?.({ model: String(payload.model ?? ''), confidence: (payload.confidence as Confidence | null) ?? null, truncated });
        break;
      case 'error':
        if (typeof payload.logId === 'string') handlers.onLog?.(payload.logId);
        streamError = new ApiError(500, String(payload.code ?? 'stream_error'), String(payload.message ?? 'The answer failed.'));
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
