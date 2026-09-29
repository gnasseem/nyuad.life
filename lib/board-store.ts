/**
 * Where the board lives. Supabase (Postgres through PostgREST, with the service key kept on the server) in
 * production; an in-memory store for local development and tests. `boardStore()` picks one from the environment.
 */
import { randomUUID } from 'node:crypto';
import type { Announcement, Answer, BoardEvent, EventKind, Profile, Question } from './board.ts';
import { ApiError } from './http.ts';

export interface BoardStats {
  open: number;
  answered: number;
  answers: number;
  helpers: number;
}

export interface BoardStore {
  /** False for the in-memory store: nothing survives a restart. */
  readonly persistent: boolean;
  getProfile(netId: string): Promise<Profile | null>;
  upsertProfile(profile: Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'>): Promise<Profile>;
  touchProfile(netId: string, answered: boolean): Promise<void>;
  createQuestion(question: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question>;
  getQuestion(id: string): Promise<Question | null>;
  /** Questions still worth handing out, newest first. */
  listOpen(limit: number): Promise<Question[]>;
  listByAsker(askerKey: string): Promise<Question[]>;
  /** Questions with at least one answer, newest first, for the answer engine. */
  listAnswered(limit: number): Promise<Question[]>;
  listAnswers(questionIds: string[]): Promise<Answer[]>;
  listAnswersByHelper(netId: string): Promise<Answer[]>;
  createAnswer(answer: Omit<Answer, 'id' | 'createdAt'>): Promise<Answer>;
  recordEvent(event: Omit<BoardEvent, 'createdAt'>): Promise<void>;
  listEventsByHelper(netId: string): Promise<BoardEvent[]>;
  bump(questionId: string, delta: { views?: number; skips?: number; answers?: number }): Promise<void>;
  stats(): Promise<BoardStats>;
  createAnnouncement(announcement: Omit<Announcement, 'id' | 'createdAt'>): Promise<Announcement>;
  /** Announcements that have not expired: dated ones soonest first, then undated ones newest first. */
  listAnnouncements(now: Date): Promise<Announcement[]>;
  /** Deletes when the key matches the poster's; returns whether anything was removed. */
  deleteAnnouncement(id: string, posterKey: string): Promise<boolean>;
}

/* ---------- In memory ---------- */

export class MemoryBoardStore implements BoardStore {
  readonly persistent = false;
  private profiles = new Map<string, Profile>();
  private questions = new Map<string, Question>();
  private answers: Answer[] = [];
  private events: BoardEvent[] = [];
  private announcements = new Map<string, Announcement>();

  async getProfile(netId: string): Promise<Profile | null> {
    return this.profiles.get(netId) ?? null;
  }
  async upsertProfile(profile: Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'>): Promise<Profile> {
    const now = new Date().toISOString();
    const current = this.profiles.get(profile.netId);
    const next: Profile = { ...profile, answers: current?.answers ?? 0, createdAt: current?.createdAt ?? now, lastSeenAt: now };
    this.profiles.set(profile.netId, next);
    return next;
  }
  async touchProfile(netId: string, answered: boolean): Promise<void> {
    const profile = this.profiles.get(netId);
    if (!profile) return;
    profile.lastSeenAt = new Date().toISOString();
    if (answered) profile.answers += 1;
  }
  async createQuestion(question: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question> {
    const now = new Date().toISOString();
    const created: Question = { ...question, id: randomUUID(), createdAt: now, updatedAt: now };
    this.questions.set(created.id, created);
    return created;
  }
  async getQuestion(id: string): Promise<Question | null> {
    return this.questions.get(id) ?? null;
  }
  async listOpen(limit: number): Promise<Question[]> {
    return this.sorted()
      .filter((question) => question.status !== 'closed')
      .slice(0, limit);
  }
  async listByAsker(askerKey: string): Promise<Question[]> {
    return this.sorted().filter((question) => question.askerKey === askerKey);
  }
  async listAnswered(limit: number): Promise<Question[]> {
    return this.sorted()
      .filter((question) => question.answers > 0)
      .slice(0, limit);
  }
  async listAnswers(questionIds: string[]): Promise<Answer[]> {
    const wanted = new Set(questionIds);
    return this.answers.filter((answer) => wanted.has(answer.questionId));
  }
  async listAnswersByHelper(netId: string): Promise<Answer[]> {
    return this.answers.filter((answer) => answer.helperNetId === netId);
  }
  async createAnswer(answer: Omit<Answer, 'id' | 'createdAt'>): Promise<Answer> {
    const created: Answer = { ...answer, id: randomUUID(), createdAt: new Date().toISOString() };
    this.answers.push(created);
    return created;
  }
  async recordEvent(event: Omit<BoardEvent, 'createdAt'>): Promise<void> {
    this.events.push({ ...event, createdAt: new Date().toISOString() });
  }
  async listEventsByHelper(netId: string): Promise<BoardEvent[]> {
    return this.events.filter((event) => event.netId === netId);
  }
  async bump(questionId: string, delta: { views?: number; skips?: number; answers?: number }): Promise<void> {
    const question = this.questions.get(questionId);
    if (!question) return;
    question.views += delta.views ?? 0;
    question.skips += delta.skips ?? 0;
    question.answers += delta.answers ?? 0;
    if (question.answers > 0 && question.status === 'open') question.status = 'answered';
    question.updatedAt = new Date().toISOString();
  }
  async stats(): Promise<BoardStats> {
    const all = [...this.questions.values()];
    return {
      open: all.filter((question) => question.status === 'open').length,
      answered: all.filter((question) => question.answers > 0).length,
      answers: this.answers.length,
      helpers: new Set(this.answers.map((answer) => answer.helperNetId)).size,
    };
  }
  async createAnnouncement(announcement: Omit<Announcement, 'id' | 'createdAt'>): Promise<Announcement> {
    const created: Announcement = { ...announcement, id: randomUUID(), createdAt: new Date().toISOString() };
    this.announcements.set(created.id, created);
    return created;
  }
  async listAnnouncements(now: Date): Promise<Announcement[]> {
    return sortAnnouncements([...this.announcements.values()].filter((entry) => Date.parse(entry.expiresAt) > now.getTime()));
  }
  async deleteAnnouncement(id: string, posterKey: string): Promise<boolean> {
    const entry = this.announcements.get(id);
    if (!entry || entry.posterKey !== posterKey) return false;
    this.announcements.delete(id);
    return true;
  }
  private sorted(): Question[] {
    return [...this.questions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export function sortAnnouncements(entries: Announcement[]): Announcement[] {
  return [...entries].sort((a, b) => {
    if (a.startsAt && b.startsAt) return a.startsAt.localeCompare(b.startsAt);
    if (a.startsAt || b.startsAt) return a.startsAt ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/* ---------- Supabase (PostgREST) ---------- */

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export function supabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | null {
  const url = (env.SUPABASE_URL ?? '').trim().replace(/\/$/, '');
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? '').trim();
  return url && serviceKey ? { url, serviceKey } : null;
}

type Row = Record<string, unknown>;

export class SupabaseBoardStore implements BoardStore {
  readonly persistent = true;
  constructor(private readonly cfg: SupabaseConfig) {}

  async getProfile(netId: string): Promise<Profile | null> {
    const rows = await this.select('board_profiles', `net_id=eq.${enc(netId)}&limit=1`);
    return rows[0] ? profileFrom(rows[0]) : null;
  }
  async upsertProfile(profile: Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'>): Promise<Profile> {
    const rows = await this.write('POST', 'board_profiles?on_conflict=net_id', { net_id: profile.netId, name: profile.name, major: profile.major, class_of: profile.classOf, last_seen_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=representation');
    return profileFrom(rows[0]!);
  }
  async touchProfile(netId: string, answered: boolean): Promise<void> {
    await this.rpc('board_touch_profile', { p_net_id: netId, p_answered: answered });
  }
  async createQuestion(question: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question> {
    const rows = await this.write('POST', 'board_questions', {
      text: question.text,
      summary: question.summary,
      topics: question.topics,
      courses: question.courses,
      majors: question.majors,
      years: question.years,
      asker_key: question.askerKey,
      asker_name: question.askerName,
      status: question.status,
      embedding: question.embedding ?? null,
    });
    return questionFrom(rows[0]!);
  }
  async getQuestion(id: string): Promise<Question | null> {
    const rows = await this.select('board_questions', `id=eq.${enc(id)}&limit=1`);
    return rows[0] ? questionFrom(rows[0]) : null;
  }
  async listOpen(limit: number): Promise<Question[]> {
    return (await this.select('board_questions', `status=neq.closed&order=created_at.desc&limit=${limit}`)).map(questionFrom);
  }
  async listByAsker(askerKey: string): Promise<Question[]> {
    return (await this.select('board_questions', `asker_key=eq.${enc(askerKey)}&order=created_at.desc&limit=100`)).map(questionFrom);
  }
  async listAnswered(limit: number): Promise<Question[]> {
    return (await this.select('board_questions', `answers=gt.0&order=created_at.desc&limit=${limit}`)).map(questionFrom);
  }
  async listAnswers(questionIds: string[]): Promise<Answer[]> {
    if (questionIds.length === 0) return [];
    return (await this.select('board_answers', `question_id=in.(${questionIds.map(enc).join(',')})&order=created_at.asc`)).map(answerFrom);
  }
  async listAnswersByHelper(netId: string): Promise<Answer[]> {
    return (await this.select('board_answers', `helper_net_id=eq.${enc(netId)}&order=created_at.desc&limit=200`)).map(answerFrom);
  }
  async createAnswer(answer: Omit<Answer, 'id' | 'createdAt'>): Promise<Answer> {
    const rows = await this.write('POST', 'board_answers', {
      question_id: answer.questionId,
      text: answer.text,
      helper_net_id: answer.helperNetId,
      helper_name: answer.helperName,
      helper_major: answer.helperMajor,
      helper_year: answer.helperYear,
    });
    return answerFrom(rows[0]!);
  }
  async recordEvent(event: Omit<BoardEvent, 'createdAt'>): Promise<void> {
    await this.write('POST', 'board_events', { question_id: event.questionId, net_id: event.netId, kind: event.kind }, 'return=minimal');
  }
  async listEventsByHelper(netId: string): Promise<BoardEvent[]> {
    return (await this.select('board_events', `net_id=eq.${enc(netId)}&order=created_at.desc&limit=2000`)).map((row) => ({
      questionId: String(row.question_id),
      netId: String(row.net_id),
      kind: String(row.kind) as EventKind,
      createdAt: String(row.created_at),
    }));
  }
  async bump(questionId: string, delta: { views?: number; skips?: number; answers?: number }): Promise<void> {
    await this.rpc('board_bump', { q_id: questionId, d_views: delta.views ?? 0, d_skips: delta.skips ?? 0, d_answers: delta.answers ?? 0 });
  }
  async stats(): Promise<BoardStats> {
    const row = (await this.rpc('board_stats', {})) as Row | Row[] | null;
    const stats = (Array.isArray(row) ? row[0] : row) ?? {};
    return { open: Number(stats.open ?? 0), answered: Number(stats.answered ?? 0), answers: Number(stats.answers ?? 0), helpers: Number(stats.helpers ?? 0) };
  }

  async createAnnouncement(announcement: Omit<Announcement, 'id' | 'createdAt'>): Promise<Announcement> {
    const rows = await this.write('POST', 'board_announcements', {
      title: announcement.title,
      body: announcement.body,
      kind: announcement.kind,
      starts_at: announcement.startsAt ?? null,
      location: announcement.location,
      link: announcement.link,
      poster_key: announcement.posterKey,
      poster_net_id: announcement.posterNetId,
      poster_name: announcement.posterName,
      expires_at: announcement.expiresAt,
    });
    return announcementFrom(rows[0]!);
  }
  async listAnnouncements(now: Date): Promise<Announcement[]> {
    return sortAnnouncements((await this.select('board_announcements', `expires_at=gt.${enc(now.toISOString())}&order=created_at.desc&limit=200`)).map(announcementFrom));
  }
  async deleteAnnouncement(id: string, posterKey: string): Promise<boolean> {
    const response = await fetch(`${this.cfg.url}/rest/v1/board_announcements?id=eq.${enc(id)}&poster_key=eq.${enc(posterKey)}`, { method: 'DELETE', headers: this.headers('return=representation') });
    const rows = (await this.parse(response)) as Row[] | null;
    return Array.isArray(rows) && rows.length > 0;
  }

  private headers(prefer?: string): Record<string, string> {
    const headers: Record<string, string> = { apikey: this.cfg.serviceKey, authorization: `Bearer ${this.cfg.serviceKey}`, 'content-type': 'application/json' };
    if (prefer) headers.prefer = prefer;
    return headers;
  }
  private async select(table: string, query: string): Promise<Row[]> {
    const response = await fetch(`${this.cfg.url}/rest/v1/${table}?${query}`, { headers: this.headers() });
    return (await this.parse(response)) as Row[];
  }
  private async write(method: 'POST' | 'PATCH', path: string, body: unknown, prefer = 'return=representation'): Promise<Row[]> {
    const response = await fetch(`${this.cfg.url}/rest/v1/${path}`, { method, headers: this.headers(prefer), body: JSON.stringify(body) });
    const parsed = await this.parse(response);
    return Array.isArray(parsed) ? (parsed as Row[]) : [];
  }
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${this.cfg.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(args) });
    return this.parse(response);
  }
  private async parse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 300);
      try {
        const json = JSON.parse(text) as { message?: string; hint?: string };
        message = json.message ?? message;
      } catch {
        // keep the raw body
      }
      console.error(`[board] Supabase ${response.status}: ${message}`);
      throw new ApiError(502, 'The board database is not answering. Try again in a moment.', 'board_storage');
    }
    return text ? JSON.parse(text) : null;
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function profileFrom(row: Row): Profile {
  return {
    netId: String(row.net_id),
    name: String(row.name),
    major: String(row.major),
    classOf: Number(row.class_of),
    answers: Number(row.answers ?? 0),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function questionFrom(row: Row): Question {
  return {
    id: String(row.id),
    text: String(row.text),
    summary: String(row.summary ?? ''),
    topics: (row.topics as string[] | null) ?? [],
    courses: (row.courses as string[] | null) ?? [],
    majors: (row.majors as string[] | null) ?? [],
    years: ((row.years as string[] | null) ?? []) as Question['years'],
    askerKey: String(row.asker_key),
    askerName: String(row.asker_name ?? ''),
    status: String(row.status) as Question['status'],
    views: Number(row.views ?? 0),
    skips: Number(row.skips ?? 0),
    answers: Number(row.answers ?? 0),
    embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function answerFrom(row: Row): Answer {
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    text: String(row.text),
    helperNetId: String(row.helper_net_id),
    helperName: String(row.helper_name),
    helperMajor: String(row.helper_major),
    helperYear: String(row.helper_year) as Answer['helperYear'],
    createdAt: String(row.created_at),
  };
}

function announcementFrom(row: Row): Announcement {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body ?? ''),
    kind: String(row.kind) as Announcement['kind'],
    startsAt: row.starts_at ? String(row.starts_at) : undefined,
    location: String(row.location ?? ''),
    link: String(row.link ?? ''),
    posterKey: String(row.poster_key),
    posterNetId: String(row.poster_net_id),
    posterName: String(row.poster_name),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  };
}

/* ---------- Selection ---------- */

let shared: BoardStore | null | undefined;

/**
 * Supabase when configured. Otherwise an in-memory board outside production (so `npm run dev` works with no
 * database), and no board at all in production, where a memory store would silently lose everything.
 */
export function boardStore(env: NodeJS.ProcessEnv = process.env): BoardStore | null {
  if (shared !== undefined) return shared;
  const cfg = supabaseConfig(env);
  if (cfg) shared = new SupabaseBoardStore(cfg);
  else if (env.ROR_BOARD_STORE === 'memory' || (env.NODE_ENV !== 'production' && env.VERCEL !== '1')) shared = new MemoryBoardStore();
  else shared = null;
  return shared;
}

/** Test hook. */
export function resetBoardStore(): void {
  shared = undefined;
}
