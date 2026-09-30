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

export interface BoardCheck {
  ok: boolean;
  /** One of: board_schema_missing | board_key_rejected | board_url_wrong | board_unreachable | board_storage. */
  code?: string;
  /** What is wrong and what to do about it, written for the person who set the server up. */
  problem?: string;
}

export interface BoardStore {
  /** False for the in-memory store: nothing survives a restart. */
  readonly persistent: boolean;
  /** Talks to the database once and says whether it is usable, and if not, why. */
  check(): Promise<BoardCheck>;
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
  async check(): Promise<BoardCheck> {
    return { ok: true };
  }
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
  const url = normalizeSupabaseUrl(env.SUPABASE_URL ?? '');
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? '').trim().replace(/^["']|["']$/g, '');
  return url && serviceKey ? { url, serviceKey } : null;
}

/**
 * Turns whatever was pasted into SUPABASE_URL into the REST origin: the project URL as given, the dashboard URL of
 * the project, a URL with /rest/v1 already on the end, or a bare project ref all become https://<ref>.supabase.co.
 */
export function normalizeSupabaseUrl(raw: string): string {
  let value = raw.trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  const dashboard = /supabase\.com\/dashboard\/project\/([a-z0-9]{20})/i.exec(value);
  if (dashboard) return `https://${dashboard[1]!.toLowerCase()}.supabase.co`;
  if (/^[a-z0-9]{20}$/i.test(value)) return `https://${value.toLowerCase()}.supabase.co`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
}

/** Which role a Supabase key carries: legacy keys are JWTs with a role claim, new keys say it in their prefix. */
export function keyRole(key: string): 'service_role' | 'anon' | 'unknown' {
  if (key.startsWith('sb_secret_')) return 'service_role';
  if (key.startsWith('sb_publishable_')) return 'anon';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { role?: string };
      if (payload.role === 'service_role' || payload.role === 'anon') return payload.role;
    } catch {
      // not a JWT
    }
  }
  return 'unknown';
}

/**
 * Reads a failed PostgREST response and says what is actually wrong, so the person running the server does not have
 * to guess: the schema was never run, the wrong key was pasted, the URL is not the REST API, or the project is down.
 */
export function storageError(status: number, body: string, what = 'request'): ApiError {
  let message = body.slice(0, 300);
  let code = '';
  try {
    const json = JSON.parse(body) as { message?: string; msg?: string; error?: string; code?: string | number; error_description?: string };
    message = json.message ?? json.msg ?? json.error_description ?? json.error ?? message;
    code = json.code === undefined ? '' : String(json.code);
  } catch {
    // keep the raw body
  }
  console.error(`[board] Supabase ${status} on ${what}: ${code ? `${code} ` : ''}${message}`);
  const missingTable = code === 'PGRST205' || code === '42P01' || /could not find the table|relation .* does not exist/i.test(message);
  const missingFunction = code === 'PGRST202' || code === '42883' || /could not find the function/i.test(message);
  if (missingTable || missingFunction) {
    return new ApiError(
      503,
      'The board tables are not in this Supabase project yet. Open the project in Supabase, go to SQL Editor → New query, paste the whole of supabase/schema.sql and run it, then try again.',
      'board_schema_missing',
    );
  }
  if (status === 401 || status === 403 || code === '42501' || code === 'PGRST301' || /row-level security|invalid api key|jwt|permission denied|apikey/i.test(message)) {
    return new ApiError(
      503,
      'Supabase rejected the board key. SUPABASE_SERVICE_ROLE_KEY must be the service_role (secret) key from Project → Settings → API, not the anon or publishable key, and SUPABASE_URL must be the same project.',
      'board_key_rejected',
    );
  }
  if (status === 404 && !code) {
    return new ApiError(503, 'SUPABASE_URL does not point at a Supabase REST API. Use the project URL from Project → Settings → API, which looks like https://abcdefghijklmnopqrst.supabase.co.', 'board_url_wrong');
  }
  if (status >= 500 || /paused|not available|unavailable/i.test(message)) {
    return new ApiError(
      503,
      `Supabase is not answering (${status}${message ? `: ${message}` : ''}). Free projects pause after a week without traffic: open the Supabase dashboard and restore the project.`,
      'board_unreachable',
    );
  }
  return new ApiError(502, `The board database refused that (${status}${message ? `: ${message}` : ''}).`, 'board_storage');
}

type Row = Record<string, unknown>;

export class SupabaseBoardStore implements BoardStore {
  readonly persistent = true;
  constructor(private readonly cfg: SupabaseConfig) {}

  /** One cheap read and one function call: enough to tell a missing schema, a wrong key or a paused project apart. */
  async check(): Promise<BoardCheck> {
    if (keyRole(this.cfg.serviceKey) === 'anon') {
      return {
        ok: false,
        code: 'board_key_rejected',
        problem: 'SUPABASE_SERVICE_ROLE_KEY holds the anon (public) key, which row level security stops from writing anything. Paste the service_role secret from Project → Settings → API instead.',
      };
    }
    try {
      await this.select('board_profiles', 'select=net_id&limit=1');
      await this.rpc('board_stats', {});
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, code: error.code, problem: error.message };
      return { ok: false, code: 'board_unreachable', problem: (error as Error).message };
    }
  }

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
    const rows = (await this.call(`board_announcements?id=eq.${enc(id)}&poster_key=eq.${enc(posterKey)}`, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null;
    return Array.isArray(rows) && rows.length > 0;
  }

  private headers(prefer?: string): Record<string, string> {
    const headers: Record<string, string> = { apikey: this.cfg.serviceKey, authorization: `Bearer ${this.cfg.serviceKey}`, 'content-type': 'application/json' };
    if (prefer) headers.prefer = prefer;
    return headers;
  }
  private async select(table: string, query: string): Promise<Row[]> {
    const rows = await this.call(`${table}?${query}`, { headers: this.headers() });
    return Array.isArray(rows) ? (rows as Row[]) : [];
  }
  private async write(method: 'POST' | 'PATCH', path: string, body: unknown, prefer = 'return=representation'): Promise<Row[]> {
    const parsed = await this.call(path, { method, headers: this.headers(prefer), body: JSON.stringify(body) });
    return Array.isArray(parsed) ? (parsed as Row[]) : [];
  }
  private async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call(`rpc/${name}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(args) });
  }
  /**
   * One PostgREST call with a timeout. A read that fails on the network or with a 5xx is tried once more, since a
   * serverless function often wakes the database up with its first request; a failed response becomes a specific
   * ApiError (see storageError) instead of a generic one.
   */
  private async call(path: string, init: RequestInit & { method?: string }): Promise<unknown> {
    const url = `${this.cfg.url}/rest/v1/${path}`;
    const what = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    const readOnly = !init.method || init.method === 'GET';
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
      } catch (error) {
        if (readOnly && attempt === 0) continue;
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[board] could not reach Supabase for ${what}: ${reason}`);
        throw new ApiError(503, `Could not reach Supabase at ${new URL(this.cfg.url).host} (${reason}). Check SUPABASE_URL and that the project is not paused.`, 'board_unreachable');
      }
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;
      if (readOnly && attempt === 0 && response.status >= 500) continue;
      throw storageError(response.status, text, what);
    }
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
