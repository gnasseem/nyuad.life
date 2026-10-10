/**
 * Where the board lives. Supabase (Postgres through PostgREST, with the service key kept on the server) in
 * production; an in-memory store for local development and tests. `boardStore()` picks one from the environment.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ENOUGH_ANSWERS, isListingKind, type Announcement, type Answer, type BoardEvent, type CourseReview, type EventKind, type Listing, type Offer, type Profile, type Question, type Standing } from './board.ts';
import { ApiError } from './http.ts';
import { supabaseConfig, type SupabaseConfig } from './supabase.ts';

interface BoardStats {
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
  reserveOtp(netId: string, digest: string): Promise<boolean>;
  consumeOtp(netId: string, digest: string): Promise<boolean>;
  rebindProfile(netId: string, owner: string, key: string): Promise<void>;
  getProfile(netId: string): Promise<Profile | null>;
  /** Saves a profile; `ownerKey` binds the NetID to its verified account (see Profile.ownerKey). */
  upsertProfile(profile: Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'>, ownerKey?: string): Promise<Profile>;
  /** Binds a profile that has no owner yet to this browser; leaves one that has an owner alone. */
  claimProfile(netId: string, ownerKey: string): Promise<void>;
  /** Removes this browser's posts and profile, then frees its NetID. */
  deleteProfile(netId: string, ownerKey: string, browserKey: string): Promise<boolean>;
  touchProfile(netId: string, answered: boolean): Promise<void>;
  createQuestion(question: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>): Promise<Question>;
  getQuestion(id: string): Promise<Question | null>;
  /** Questions still worth handing out (not closed, fewer than ENOUGH_ANSWERS answers), newest first. */
  listOpen(limit: number): Promise<Question[]>;
  listByAsker(askerKey: string): Promise<Question[]>;
  /** Questions with at least one answer, newest first, for the answer engine. */
  listAnswered(limit: number): Promise<Question[]>;
  listAnswers(questionIds: string[]): Promise<Answer[]>;
  /** The newest answers across the board, for the leaderboard. */
  listRecentAnswers(limit: number): Promise<Answer[]>;
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
  createOffer(offer: Omit<Offer, 'id' | 'createdAt'>): Promise<Offer>;
  /** Open, unexpired offers, newest first. */
  listOffers(now: Date): Promise<Offer[]>;
  /** The contact on one open, unexpired offer or listing, or null. Read one row at a time so contacts cannot be listed. */
  getContact(type: 'offer' | 'listing', id: string, now: Date): Promise<Pick<Offer, 'contactKind' | 'contact'> | null>;
  listOffersByPoster(posterKey: string): Promise<Offer[]>;
  /** Marks an offer done or removes it; only the poster's key works. Returns whether anything changed. */
  closeOffer(id: string, posterKey: string, remove: boolean): Promise<boolean>;
  createListing(listing: Omit<Listing, 'id' | 'createdAt'>): Promise<Listing>;
  /** Open, unexpired listings, newest first. */
  listListings(now: Date): Promise<Listing[]>;
  listListingsByPoster(posterKey: string): Promise<Listing[]>;
  /** Marks a listing done or removes it; only the poster's key works. Returns whether anything changed. */
  closeListing(id: string, posterKey: string, remove: boolean): Promise<boolean>;
  /** A cached AI summary for the guide, or null. */
  getSummary(key: string): Promise<{ payload: unknown; createdAt: string } | null>;
  putSummary(key: string, payload: unknown): Promise<void>;
  /** Drops cached entries whose key starts with `prefix` and that were written before `before` (an ISO time). */
  deleteSummaries(prefix: string, before: string): Promise<void>;
  /** Cached entries whose key starts with `prefix`, with only the named top-level payload fields: the course list's scores. */
  listSummaryFields(prefix: string, fields: string[]): Promise<Array<{ key: string; createdAt: string; fields: Record<string, unknown> }>>;
  /** Counts one hit against `bucket`, across every instance, and says whether it went over `max` in the window. */
  hit(bucket: string, max: number, windowSeconds: number): Promise<boolean>;
  listReviews(code: string): Promise<CourseReview[]>;
  /** One review per student and course: writing again replaces it. */
  upsertReview(review: Omit<CourseReview, 'id' | 'createdAt' | 'updatedAt'>): Promise<CourseReview>;
  deleteReview(code: string, netId: string): Promise<boolean>;
  /** Every review's course and rating, for the averages on the course list. */
  listReviewScores(): Promise<Array<{ code: string; rating: number }>>;

  /** Questions that are not closed, newest first, older than `before` (an ISO time) when given: the Questions feed. */
  listFeed(limit: number, before?: string): Promise<Question[]>;
  /** The profile a browser set up, by the hash of its key (Profile.ownerKey). */
  findProfileByOwner(ownerKey: string): Promise<Profile | null>;
  /** Whether an admin barred this NetID from posting. */
  isBanned(netId: string): Promise<boolean>;
  setBan(netId: string, banned: boolean, reason?: string): Promise<void>;
  listBans(): Promise<Ban[]>;
  /** Removes one post of any kind, whoever wrote it; returns what was removed, or null when there was nothing. */
  adminDelete(type: AdminTarget, id: string): Promise<Record<string, unknown> | null>;
  /** Keeps a record of what an admin did. Best effort: a missing table is not an error. */
  recordAudit(entry: { action: string; target: string; snapshot?: unknown; ip: string }): Promise<void>;
  /** The newest admin actions, for the admin page. */
  listAudit(limit: number): Promise<AuditEntry[]>;
  /** For the admins' dashboard: every member with when they joined and were last seen, newest first, and board counts. */
  adminOverview(now: Date): Promise<AdminOverview>;
}

export interface AuditEntry {
  action: string;
  target: string;
  createdAt: string;
}

export interface AdminMember {
  netId: string;
  name: string;
  major: string;
  classOf: number;
  answers: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface AdminOverview {
  members: AdminMember[];
  counts: { questions: number; openQuestions: number; answers: number; reviews: number; listings: number; offers: number; events: number; bans: number };
}

export type AdminTarget = 'question' | 'answer' | 'notice' | 'listing' | 'offer' | 'review';

export interface Ban {
  netId: string;
  reason: string;
  createdAt: string;
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
  private offers = new Map<string, Offer>();
  private listings = new Map<string, Listing>();
  private summaries = new Map<string, { payload: unknown; createdAt: string }>();

  private otps = new Map<string, { digest: string; sent: number; window: number; count: number; attempts: number; consumed: boolean }>();
  async reserveOtp(netId: string, digest: string): Promise<boolean> {
    const now = Date.now();
    const old = this.otps.get(netId);
    if (old && (now - old.sent < 60_000 || (now - old.window < 3_600_000 && old.count >= 5))) return false;
    const sameWindow = old && now - old.window < 3_600_000;
    this.otps.set(netId, { digest, sent: now, window: sameWindow ? old.window : now, count: sameWindow ? old.count + 1 : 1, attempts: 0, consumed: false });
    return true;
  }
  async consumeOtp(netId: string, digest: string): Promise<boolean> {
    const otp = this.otps.get(netId);
    if (!otp || otp.consumed || otp.attempts >= 5 || Date.now() - otp.sent >= 600_000) return false;
    otp.attempts++;
    if (otp.digest !== digest) return false;
    otp.consumed = true;
    return true;
  }
  async rebindProfile(netId: string, owner: string, key: string): Promise<void> {
    const profile = this.profiles.get(netId);
    if (!profile) return;
    for (const question of this.questions.values()) {
      const hash = createHash('sha256').update(`ror-owner:${question.askerKey}`).digest('hex').slice(0, 40);
      if (hash === profile.ownerKey) question.askerKey = key;
    }
    for (const post of [...this.announcements.values(), ...this.offers.values(), ...this.listings.values()]) if (post.posterNetId === netId) post.posterKey = key;
    profile.ownerKey = owner;
  }
  async getProfile(netId: string): Promise<Profile | null> {
    return this.profiles.get(netId) ?? null;
  }
  async upsertProfile(profile: Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'>, ownerKey?: string): Promise<Profile> {
    const now = new Date().toISOString();
    const current = this.profiles.get(profile.netId);
    const next: Profile = { ...profile, answers: current?.answers ?? 0, createdAt: current?.createdAt ?? now, lastSeenAt: now, ownerKey: ownerKey ?? current?.ownerKey ?? null };
    this.profiles.set(profile.netId, next);
    return next;
  }
  async claimProfile(netId: string, ownerKey: string): Promise<void> {
    const profile = this.profiles.get(netId);
    if (profile && !profile.ownerKey) profile.ownerKey = ownerKey;
  }
  async deleteProfile(netId: string, ownerKey: string, browserKey: string): Promise<boolean> {
    if (this.profiles.get(netId)?.ownerKey !== ownerKey) return false;
    for (const [id, question] of this.questions) if (question.askerKey === browserKey) this.questions.delete(id);
    this.answers = this.answers.filter((answer) => answer.helperNetId !== netId && this.questions.has(answer.questionId));
    this.events = this.events.filter((event) => event.netId !== netId && this.questions.has(event.questionId));
    for (const [id, post] of this.announcements) if (post.posterNetId === netId) this.announcements.delete(id);
    for (const [id, post] of this.offers) if (post.posterNetId === netId) this.offers.delete(id);
    for (const [id, post] of this.listings) if (post.posterNetId === netId) this.listings.delete(id);
    this.profiles.delete(netId);
    return true;
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
      .filter((question) => question.status !== 'closed' && question.answers < ENOUGH_ANSWERS)
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
  async listRecentAnswers(limit: number): Promise<Answer[]> {
    return [...this.answers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
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
    return sortAnnouncements([...this.announcements.values()].filter((entry) => entry.kind === 'event' && Boolean(entry.startsAt) && Date.parse(entry.expiresAt) > now.getTime()));
  }
  async deleteAnnouncement(id: string, posterKey: string): Promise<boolean> {
    const entry = this.announcements.get(id);
    if (!entry || entry.posterKey !== posterKey) return false;
    this.announcements.delete(id);
    return true;
  }
  async createOffer(offer: Omit<Offer, 'id' | 'createdAt'>): Promise<Offer> {
    const created: Offer = { ...offer, id: randomUUID(), createdAt: new Date().toISOString() };
    this.offers.set(created.id, created);
    return created;
  }
  async listOffers(now: Date): Promise<Offer[]> {
    return [...this.offers.values()].filter((offer) => offer.status === 'open' && Date.parse(offer.expiresAt) > now.getTime()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async getContact(type: 'offer' | 'listing', id: string, now: Date): Promise<Pick<Offer, 'contactKind' | 'contact'> | null> {
    const found = type === 'offer' ? this.offers.get(id) : this.listings.get(id);
    if (!found || found.status !== 'open' || Date.parse(found.expiresAt) <= now.getTime() || ('kind' in found && !isListingKind(found.kind))) return null;
    return { contactKind: found.contactKind, contact: found.contact };
  }
  async listOffersByPoster(posterKey: string): Promise<Offer[]> {
    return [...this.offers.values()].filter((offer) => offer.posterKey === posterKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async closeOffer(id: string, posterKey: string, remove: boolean): Promise<boolean> {
    const offer = this.offers.get(id);
    if (!offer || offer.posterKey !== posterKey) return false;
    if (remove) this.offers.delete(id);
    else offer.status = 'done';
    return true;
  }
  async createListing(listing: Omit<Listing, 'id' | 'createdAt'>): Promise<Listing> {
    const created: Listing = { ...listing, id: randomUUID(), createdAt: new Date().toISOString() };
    this.listings.set(created.id, created);
    return created;
  }
  async listListings(now: Date): Promise<Listing[]> {
    return [...this.listings.values()].filter((listing) => isListingKind(listing.kind) && listing.status === 'open' && Date.parse(listing.expiresAt) > now.getTime()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listListingsByPoster(posterKey: string): Promise<Listing[]> {
    return [...this.listings.values()].filter((listing) => isListingKind(listing.kind) && listing.posterKey === posterKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async closeListing(id: string, posterKey: string, remove: boolean): Promise<boolean> {
    const listing = this.listings.get(id);
    if (!listing || listing.posterKey !== posterKey) return false;
    if (remove) this.listings.delete(id);
    else listing.status = 'done';
    return true;
  }
  async getSummary(key: string): Promise<{ payload: unknown; createdAt: string } | null> {
    return this.summaries.get(key) ?? null;
  }
  async putSummary(key: string, payload: unknown): Promise<void> {
    this.summaries.set(key, { payload, createdAt: new Date().toISOString() });
  }
  async deleteSummaries(prefix: string, before: string): Promise<void> {
    for (const [key, entry] of this.summaries) if (key.startsWith(prefix) && entry.createdAt < before) this.summaries.delete(key);
  }
  async listSummaryFields(prefix: string, fields: string[]): Promise<Array<{ key: string; createdAt: string; fields: Record<string, unknown> }>> {
    return [...this.summaries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ key, createdAt: entry.createdAt, fields: Object.fromEntries(fields.map((field) => [field, (entry.payload as Record<string, unknown> | null)?.[field] ?? null])) }));
  }
  private hits = new Map<string, { count: number; start: number }>();
  async hit(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    const entry = this.hits.get(bucket);
    const fresh = !entry || now - entry.start >= windowSeconds * 1000;
    const next = fresh ? { count: 1, start: now } : { count: entry.count + 1, start: entry.start };
    this.hits.set(bucket, next);
    return next.count > max;
  }
  private reviews = new Map<string, CourseReview>();
  async listReviews(code: string): Promise<CourseReview[]> {
    return [...this.reviews.values()].filter((review) => review.code === code).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async upsertReview(review: Omit<CourseReview, 'id' | 'createdAt' | 'updatedAt'>): Promise<CourseReview> {
    const key = `${review.code}|${review.netId}`;
    const now = new Date().toISOString();
    const old = this.reviews.get(key);
    const saved = { ...review, id: old?.id ?? randomUUID(), createdAt: old?.createdAt ?? now, updatedAt: now };
    this.reviews.set(key, saved);
    return saved;
  }
  async deleteReview(code: string, netId: string): Promise<boolean> {
    return this.reviews.delete(`${code}|${netId}`);
  }
  async listReviewScores(): Promise<Array<{ code: string; rating: number }>> {
    return [...this.reviews.values()].map((review) => ({ code: review.code, rating: review.rating }));
  }
  private bans = new Map<string, Ban>();
  readonly audit: Array<{ action: string; target: string; snapshot?: unknown; ip: string; createdAt: string }> = [];
  async listFeed(limit: number, before?: string): Promise<Question[]> {
    return this.sorted()
      .filter((question) => question.status !== 'closed' && (!before || question.createdAt < before))
      .slice(0, limit);
  }
  async findProfileByOwner(ownerKey: string): Promise<Profile | null> {
    return [...this.profiles.values()].find((profile) => profile.ownerKey === ownerKey) ?? null;
  }
  async isBanned(netId: string): Promise<boolean> {
    return this.bans.has(netId);
  }
  async setBan(netId: string, banned: boolean, reason = ''): Promise<void> {
    if (banned) this.bans.set(netId, { netId, reason, createdAt: new Date().toISOString() });
    else this.bans.delete(netId);
  }
  async listBans(): Promise<Ban[]> {
    return [...this.bans.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async listAudit(limit: number): Promise<AuditEntry[]> {
    return [...this.audit].reverse().slice(0, limit).map(({ action, target, createdAt }) => ({ action, target, createdAt }));
  }
  async adminOverview(now: Date): Promise<AdminOverview> {
    const live = (expiresAt: string) => Date.parse(expiresAt) > now.getTime();
    const stats = await this.stats();
    return {
      members: [...this.profiles.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(memberFrom),
      counts: {
        questions: this.questions.size,
        openQuestions: stats.open,
        answers: this.answers.length,
        reviews: this.reviews.size,
        listings: [...this.listings.values()].filter((listing) => isListingKind(listing.kind) && listing.status === 'open' && live(listing.expiresAt)).length,
        offers: [...this.offers.values()].filter((offer) => offer.status === 'open' && live(offer.expiresAt)).length,
        events: [...this.announcements.values()].filter((entry) => live(entry.expiresAt)).length,
        bans: this.bans.size,
      },
    };
  }
  async adminDelete(type: AdminTarget, id: string): Promise<Record<string, unknown> | null> {
    if (type === 'question') {
      const question = this.questions.get(id);
      if (!question) return null;
      this.questions.delete(id);
      this.answers = this.answers.filter((answer) => answer.questionId !== id);
      this.events = this.events.filter((event) => event.questionId !== id);
      return { ...question };
    }
    if (type === 'answer') {
      const answer = this.answers.find((entry) => entry.id === id);
      if (!answer) return null;
      this.answers = this.answers.filter((entry) => entry.id !== id);
      await this.bump(answer.questionId, { answers: -1 });
      return { ...answer };
    }
    if (type === 'review') {
      const found = [...this.reviews].find(([, review]) => review.id === id);
      if (!found) return null;
      this.reviews.delete(found[0]);
      return { ...found[1] };
    }
    const table = type === 'notice' ? this.announcements : type === 'listing' ? this.listings : this.offers;
    const found = table.get(id);
    if (!found) return null;
    table.delete(id);
    return { ...found };
  }
  async recordAudit(entry: { action: string; target: string; snapshot?: unknown; ip: string }): Promise<void> {
    this.audit.push({ ...entry, createdAt: new Date().toISOString() });
  }
  private sorted(): Question[] {
    return [...this.questions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function sortAnnouncements(entries: Announcement[]): Announcement[] {
  return [...entries].sort((a, b) => {
    if (a.startsAt && b.startsAt) return a.startsAt.localeCompare(b.startsAt);
    if (a.startsAt || b.startsAt) return a.startsAt ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/* ---------- Supabase (PostgREST) ---------- */

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
  const missingColumn = code === 'PGRST204' || code === '42703' || /could not find the '[^']+' column|column .* does not exist/i.test(message);
  if (missingColumn && !missingTable) {
    return new ApiError(503, 'The board schema is out of date: run supabase/schema.sql again in this Supabase project.', 'board_schema_outdated');
  }
  const missingFunction = code === 'PGRST202' || code === '42883' || /could not find the function/i.test(message);
  if (missingTable || missingFunction) {
    return new ApiError(
      503,
      'The board tables are missing: run supabase/schema.sql in this Supabase project.',
      'board_schema_missing',
    );
  }
  if (status === 401 || status === 403 || code === '42501' || code === 'PGRST301' || /row-level security|invalid api key|jwt|permission denied|apikey/i.test(message)) {
    return new ApiError(
      503,
      'Supabase rejected the board key: SUPABASE_SERVICE_ROLE_KEY must be the service_role key of the project at SUPABASE_URL.',
      'board_key_rejected',
    );
  }
  if (status === 404 && !code) {
    return new ApiError(503, 'SUPABASE_URL is not a Supabase project URL like https://abcdefghijklmnopqrst.supabase.co.', 'board_url_wrong');
  }
  if (status >= 500 || /paused|not available|unavailable/i.test(message)) {
    return new ApiError(
      503,
      `Supabase is not answering (${status}${message ? `: ${message}` : ''}), which usually means the project is paused.`,
      'board_unreachable',
    );
  }
  return new ApiError(502, `The board database refused the request (${status}${message ? `: ${message}` : ''}).`, 'board_storage');
}

type Row = Record<string, unknown>;

/** Ids are uuid columns: anything else would make Postgres answer 400 instead of "not found". */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The listing kinds still served; the table's check constraint also allows the retired lost and found. */
const LISTED_KINDS = 'sell,want,free,ride';
/** Everything about a question but its embedding (a thousand floats): only the answer engine reads that. */
const QUESTION_COLUMNS = 'select=id,text,summary,topics,courses,majors,years,asker_key,asker_name,status,views,skips,answers,created_at,updated_at';

export class SupabaseBoardStore implements BoardStore {
  readonly persistent = true;
  constructor(private readonly cfg: SupabaseConfig) {}

  /** One cheap read and one function call: enough to tell a missing schema, a wrong key or a paused project apart. */
  async check(): Promise<BoardCheck> {
    if (keyRole(this.cfg.serviceKey) === 'anon') {
      return {
        ok: false,
        code: 'board_key_rejected',
        problem: 'SUPABASE_SERVICE_ROLE_KEY is the anon key, not the service_role key.',
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

  async reserveOtp(netId: string, digest: string): Promise<boolean> {
    return Boolean(await this.rpc('auth_reserve_otp', { p_net_id: netId, p_digest: digest }));
  }
  async consumeOtp(netId: string, digest: string): Promise<boolean> {
    return Boolean(await this.rpc('auth_consume_otp', { p_net_id: netId, p_digest: digest }));
  }
  async rebindProfile(netId: string, owner: string, key: string): Promise<void> {
    await this.rpc('auth_rebind_profile', { p_net_id: netId, p_owner: owner, p_key: key });
  }
  async getProfile(netId: string): Promise<Profile | null> {
    const rows = await this.select('board_profiles', `net_id=eq.${enc(netId)}&limit=1`);
    return rows[0] ? profileFrom(rows[0]) : null;
  }
  async upsertProfile(profile: Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'>, ownerKey?: string): Promise<Profile> {
    const row = { net_id: profile.netId, name: profile.name, major: profile.major, class_of: profile.classOf, last_seen_at: new Date().toISOString() };
    const save = (body: Record<string, unknown>) => this.write('POST', 'board_profiles?on_conflict=net_id', body, 'resolution=merge-duplicates,return=representation');
    if (!ownerKey || this.ownerColumn === false) return profileFrom((await save(row))[0]!);
    try {
      return profileFrom((await save({ ...row, owner_key: ownerKey }))[0]!);
    } catch (error) {
      // A project whose schema predates owner_key keeps working, without the binding, until schema.sql is run again.
      if (!(error instanceof ApiError) || error.code !== 'board_schema_outdated') throw error;
      this.ownerColumn = false;
      console.warn('[board] board_profiles has no owner_key column; run supabase/schema.sql again so NetIDs are bound to a browser.');
      return profileFrom((await save(row))[0]!);
    }
  }
  /** False once the database turned out to have no owner_key column. */
  private ownerColumn: boolean | undefined;
  async claimProfile(netId: string, ownerKey: string): Promise<void> {
    if (this.ownerColumn === false) return;
    await this.write('PATCH', `board_profiles?net_id=eq.${enc(netId)}&owner_key=is.null`, { owner_key: ownerKey }, 'return=minimal');
  }
  async deleteProfile(netId: string, ownerKey: string, browserKey: string): Promise<boolean> {
    const owned = await this.select('board_profiles', `net_id=eq.${enc(netId)}&owner_key=eq.${enc(ownerKey)}&select=net_id&limit=1`);
    if (!owned.length) return false;
    // Delete dependent rows before the profile: Postgres keeps their foreign keys strict.
    for (const [table, filter] of [
      ['board_questions', `asker_key=eq.${enc(browserKey)}`],
      ['board_answers', `helper_net_id=eq.${enc(netId)}`],
      ['board_events', `net_id=eq.${enc(netId)}`],
      ['board_announcements', `poster_net_id=eq.${enc(netId)}`],
      ['board_offers', `poster_net_id=eq.${enc(netId)}`],
      ['board_listings', `poster_net_id=eq.${enc(netId)}`],
      ['course_reviews', `net_id=eq.${enc(netId)}`],
    ]) await this.call(`${table}?${filter}`, { method: 'DELETE', headers: this.headers('return=minimal') });
    const removed = (await this.call(`board_profiles?net_id=eq.${enc(netId)}&owner_key=eq.${enc(ownerKey)}`, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null;
    return Boolean(removed?.length);
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
    if (!UUID.test(id)) return null;
    const rows = await this.select('board_questions', `${QUESTION_COLUMNS}&id=eq.${enc(id)}&limit=1`);
    return rows[0] ? questionFrom(rows[0]) : null;
  }
  async listOpen(limit: number): Promise<Question[]> {
    // Fully answered questions are left out here, or once there were enough of them, older open ones would never be reached.
    return (await this.select('board_questions', `${QUESTION_COLUMNS}&status=neq.closed&answers=lt.${ENOUGH_ANSWERS}&order=created_at.desc&limit=${limit}`)).map(questionFrom);
  }
  async listByAsker(askerKey: string): Promise<Question[]> {
    return (await this.select('board_questions', `${QUESTION_COLUMNS}&asker_key=eq.${enc(askerKey)}&order=created_at.desc&limit=100`)).map(questionFrom);
  }
  async listAnswered(limit: number): Promise<Question[]> {
    return (await this.select('board_questions', `answers=gt.0&order=created_at.desc&limit=${limit}`)).map(questionFrom);
  }
  async listAnswers(questionIds: string[]): Promise<Answer[]> {
    if (questionIds.length === 0) return [];
    const batches: Array<Promise<Row[]>> = [];
    for (let offset = 0; offset < questionIds.length; offset += 75) {
      const ids = questionIds.slice(offset, offset + 75);
      batches.push(this.select('board_answers', `question_id=in.(${ids.map(enc).join(',')})&order=created_at.asc`));
    }
    return (await Promise.all(batches)).flat().map(answerFrom).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async listRecentAnswers(limit: number): Promise<Answer[]> {
    return (await this.select('board_answers', `select=id,question_id,helper_net_id,helper_name,helper_major,helper_year,created_at&order=created_at.desc&limit=${limit}`)).map(answerFrom);
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
    // Answers and skips are read in full, so a busy helper's old ones never drop out; views only matter when recent.
    const [done, views] = await Promise.all([
      this.select('board_events', `net_id=eq.${enc(netId)}&kind=neq.view&order=created_at.desc&limit=5000`),
      this.select('board_events', `net_id=eq.${enc(netId)}&kind=eq.view&order=created_at.desc&limit=200`),
    ]);
    return [...done, ...views].map((row) => ({
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
    return sortAnnouncements((await this.select('board_announcements', `kind=eq.event&starts_at=not.is.null&expires_at=gt.${enc(now.toISOString())}&order=starts_at.asc&limit=200`)).map(announcementFrom));
  }
  async deleteAnnouncement(id: string, posterKey: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const rows = (await this.call(`board_announcements?id=eq.${enc(id)}&poster_key=eq.${enc(posterKey)}`, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null;
    return Array.isArray(rows) && rows.length > 0;
  }
  async createOffer(offer: Omit<Offer, 'id' | 'createdAt'>): Promise<Offer> {
    const rows = await this.write('POST', 'board_offers', {
      // Only sent when it is not the column's default, so Falcon offers still work on a database without the column.
      ...(offer.currency !== 'falcon' ? { currency: offer.currency } : {}),
      side: offer.side,
      amount: offer.amount,
      rate: offer.rate,
      contact_kind: offer.contactKind,
      contact: offer.contact,
      note: offer.note,
      poster_key: offer.posterKey,
      poster_net_id: offer.posterNetId,
      poster_name: offer.posterName,
      status: offer.status,
      expires_at: offer.expiresAt,
    });
    return offerFrom(rows[0]!);
  }
  async listOffers(now: Date): Promise<Offer[]> {
    return (await this.select('board_offers', `status=eq.open&expires_at=gt.${enc(now.toISOString())}&order=created_at.desc&limit=300`)).map(offerFrom);
  }
  async getContact(type: 'offer' | 'listing', id: string, now: Date): Promise<Pick<Offer, 'contactKind' | 'contact'> | null> {
    if (!UUID.test(id)) return null;
    const table = type === 'offer' ? 'board_offers' : 'board_listings';
    const rows = await this.select(table, `id=eq.${enc(id)}&status=eq.open&expires_at=gt.${enc(now.toISOString())}${type === 'listing' ? `&kind=in.(${LISTED_KINDS})` : ''}&select=contact_kind,contact&limit=1`);
    return rows[0] ? { contactKind: String(rows[0].contact_kind) as Offer['contactKind'], contact: String(rows[0].contact) } : null;
  }
  async listOffersByPoster(posterKey: string): Promise<Offer[]> {
    return (await this.select('board_offers', `poster_key=eq.${enc(posterKey)}&order=created_at.desc&limit=50`)).map(offerFrom);
  }
  async closeOffer(id: string, posterKey: string, remove: boolean): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const path = `board_offers?id=eq.${enc(id)}&poster_key=eq.${enc(posterKey)}`;
    const rows = remove
      ? ((await this.call(path, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null)
      : await this.write('PATCH', path, { status: 'done' });
    return Array.isArray(rows) && rows.length > 0;
  }
  async createListing(listing: Omit<Listing, 'id' | 'createdAt'>): Promise<Listing> {
    const rows = await this.write('POST', 'board_listings', {
      kind: listing.kind,
      title: listing.title,
      body: listing.body,
      price: listing.price,
      place: listing.place,
      destination: listing.destination,
      happens_at: listing.happensAt ?? null,
      seats: listing.seats,
      contact_kind: listing.contactKind,
      contact: listing.contact,
      poster_key: listing.posterKey,
      poster_net_id: listing.posterNetId,
      poster_name: listing.posterName,
      status: listing.status,
      expires_at: listing.expiresAt,
    });
    return listingFrom(rows[0]!);
  }
  async listListings(now: Date): Promise<Listing[]> {
    return (await this.select('board_listings', `status=eq.open&kind=in.(${LISTED_KINDS})&expires_at=gt.${enc(now.toISOString())}&order=created_at.desc&limit=400`)).map(listingFrom);
  }
  async listListingsByPoster(posterKey: string): Promise<Listing[]> {
    return (await this.select('board_listings', `poster_key=eq.${enc(posterKey)}&kind=in.(${LISTED_KINDS})&order=created_at.desc&limit=50`)).map(listingFrom);
  }
  async closeListing(id: string, posterKey: string, remove: boolean): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const path = `board_listings?id=eq.${enc(id)}&poster_key=eq.${enc(posterKey)}`;
    const rows = remove
      ? ((await this.call(path, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null)
      : await this.write('PATCH', path, { status: 'done' });
    return Array.isArray(rows) && rows.length > 0;
  }
  async getSummary(key: string): Promise<{ payload: unknown; createdAt: string } | null> {
    const rows = await this.select('guide_summaries', `key=eq.${enc(key)}&limit=1`);
    return rows[0] ? { payload: rows[0].payload, createdAt: String(rows[0].created_at) } : null;
  }
  async putSummary(key: string, payload: unknown): Promise<void> {
    await this.write('POST', 'guide_summaries?on_conflict=key', { key, payload, created_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
  }
  async deleteSummaries(prefix: string, before: string): Promise<void> {
    await this.call(`guide_summaries?key=like.${enc(`${prefix}*`)}&created_at=lt.${enc(before)}`, { method: 'DELETE', headers: this.headers('return=minimal') });
  }
  async listSummaryFields(prefix: string, fields: string[]): Promise<Array<{ key: string; createdAt: string; fields: Record<string, unknown> }>> {
    const columns = fields.filter((field) => /^[a-z]+$/i.test(field)).map((field) => `${field}:payload->${field}`);
    const rows = await this.select('guide_summaries', `select=key,created_at,${columns.join(',')}&key=like.${enc(`${prefix}*`)}&limit=10000`);
    return rows.map((row) => ({ key: String(row.key), createdAt: String(row.created_at), fields: Object.fromEntries(fields.map((field) => [field, row[field] ?? null])) }));
  }
  async hit(bucket: string, max: number, windowSeconds: number): Promise<boolean> {
    // The admin attempt counter locks a bucket on the hit that reaches its limit, so it is asked for one more than allowed.
    const locked = await this.rpc('admin_register_failure', { p_bucket: bucket.slice(0, 200), p_max: max + 1, p_window_seconds: windowSeconds });
    return typeof locked === 'string' && Date.parse(locked) > Date.now();
  }
  async listReviews(code: string): Promise<CourseReview[]> {
    return (await this.select('course_reviews', `code=eq.${enc(code)}&order=updated_at.desc&limit=200`)).map(reviewFrom);
  }
  async upsertReview(review: Omit<CourseReview, 'id' | 'createdAt' | 'updatedAt'>): Promise<CourseReview> {
    const rows = await this.write('POST', 'course_reviews?on_conflict=code,net_id', {
      code: review.code,
      net_id: review.netId,
      author_name: review.authorName,
      author_major: review.authorMajor,
      author_year: review.authorYear,
      rating: review.rating,
      difficulty: review.difficulty,
      workload: review.workload,
      text: review.text,
      term: review.term,
      updated_at: new Date().toISOString(),
    }, 'resolution=merge-duplicates,return=representation');
    return reviewFrom(rows[0]!);
  }
  async deleteReview(code: string, netId: string): Promise<boolean> {
    const rows = (await this.call(`course_reviews?code=eq.${enc(code)}&net_id=eq.${enc(netId)}`, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null;
    return Boolean(rows?.length);
  }
  async listReviewScores(): Promise<Array<{ code: string; rating: number }>> {
    return (await this.select('course_reviews', 'select=code,rating&limit=20000')).map((row) => ({ code: String(row.code), rating: Number(row.rating) }));
  }

  async listFeed(limit: number, before?: string): Promise<Question[]> {
    const older = before && !Number.isNaN(Date.parse(before)) ? `&created_at=lt.${enc(new Date(before).toISOString())}` : '';
    return (await this.select('board_questions', `${QUESTION_COLUMNS}&status=neq.closed${older}&order=created_at.desc&limit=${limit}`)).map(questionFrom);
  }

  /** Bans, read whole and kept for a minute: every post checks them, and there are few. */
  private banCache: { at: number; bans: Ban[] } | null = null;
  async listBans(): Promise<Ban[]> {
    if (this.banCache && Date.now() - this.banCache.at < 60_000) return this.banCache.bans;
    try {
      const rows = await this.select('board_bans', 'order=created_at.desc&limit=1000');
      this.banCache = { at: Date.now(), bans: rows.map((row) => ({ netId: String(row.net_id), reason: String(row.reason ?? ''), createdAt: String(row.created_at) })) };
    } catch (error) {
      // A project that has not run the new schema yet has no bans table: nobody is banned, and that is looked at again later.
      if (!(error instanceof ApiError) || error.code !== 'board_schema_missing') throw error;
      this.banCache = { at: Date.now() + 9 * 60_000, bans: [] };
    }
    return this.banCache.bans;
  }
  async findProfileByOwner(ownerKey: string): Promise<Profile | null> {
    if (this.ownerColumn === false || !/^[a-f0-9]{40}$/.test(ownerKey)) return null;
    const rows = await this.select('board_profiles', `owner_key=eq.${enc(ownerKey)}&limit=1`);
    return rows[0] ? profileFrom(rows[0]) : null;
  }
  async isBanned(netId: string): Promise<boolean> {
    return (await this.listBans()).some((ban) => ban.netId === netId);
  }
  async setBan(netId: string, banned: boolean, reason = ''): Promise<void> {
    if (banned) await this.write('POST', 'board_bans?on_conflict=net_id', { net_id: netId, reason }, 'resolution=merge-duplicates,return=minimal');
    else await this.call(`board_bans?net_id=eq.${enc(netId)}`, { method: 'DELETE', headers: this.headers('return=minimal') });
    this.banCache = null;
  }
  async adminDelete(type: AdminTarget, id: string): Promise<Record<string, unknown> | null> {
    if (!UUID.test(id)) return null;
    const table = { question: 'board_questions', answer: 'board_answers', notice: 'board_announcements', listing: 'board_listings', offer: 'board_offers', review: 'course_reviews' }[type];
    // Answers and events go with their question (on delete cascade).
    const rows = (await this.call(`${table}?id=eq.${enc(id)}`, { method: 'DELETE', headers: this.headers('return=representation') })) as Row[] | null;
    const removed = Array.isArray(rows) ? rows[0] : undefined;
    if (!removed) return null;
    if (type === 'answer') await this.bump(String(removed.question_id), { answers: -1 }).catch(() => undefined);
    const { embedding: _embedding, ...snapshot } = removed;
    return snapshot;
  }
  async recordAudit(entry: { action: string; target: string; snapshot?: unknown; ip: string }): Promise<void> {
    await this.write('POST', 'admin_audit', { action: entry.action, target: entry.target, snapshot: entry.snapshot ?? null, ip: entry.ip }, 'return=minimal').catch((error) => console.warn('[admin] could not write the audit log (run supabase/schema.sql again?):', (error as Error).message));
  }
  async listAudit(limit: number): Promise<AuditEntry[]> {
    const rows = await this.select('admin_audit', `select=action,target,created_at&order=created_at.desc&limit=${Math.min(200, limit)}`).catch(() => []);
    return rows.map((row) => ({ action: String(row.action), target: String(row.target ?? ''), createdAt: String(row.created_at) }));
  }
  async adminOverview(now: Date): Promise<AdminOverview> {
    const live = enc(now.toISOString());
    const [members, stats, questions, reviews, listings, offers, events, bans] = await Promise.all([
      this.select('board_profiles', 'select=net_id,name,major,class_of,answers,created_at,last_seen_at&order=created_at.desc&limit=10000'),
      this.stats(),
      this.count('board_questions', ''),
      this.count('course_reviews', ''),
      this.count('board_listings', `status=eq.open&kind=in.(${LISTED_KINDS})&expires_at=gt.${live}`),
      this.count('board_offers', `status=eq.open&expires_at=gt.${live}`),
      this.count('board_announcements', `expires_at=gt.${live}`),
      this.listBans().catch(() => []),
    ]);
    return {
      members: members.map((row) => memberFrom(profileFrom(row))),
      counts: { questions, openQuestions: stats.open, answers: stats.answers, reviews, listings, offers, events, bans: bans.length },
    };
  }
  /** How many rows match, from PostgREST's count header, without reading them; 0 when the table is missing. */
  private async count(table: string, filter: string): Promise<number> {
    try {
      const response = await fetch(`${this.cfg.url}/rest/v1/${table}?select=*${filter ? `&${filter}` : ''}`, { method: 'HEAD', headers: this.headers('count=exact'), signal: AbortSignal.timeout(8_000) });
      return Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1] ?? 0);
    } catch {
      return 0;
    }
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
        throw new ApiError(503, `Could not reach Supabase at ${new URL(this.cfg.url).host} (${reason}).`, 'board_unreachable');
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
    ownerKey: 'owner_key' in row ? ((row.owner_key as string | null) ?? null) : undefined,
  };
}

function memberFrom(profile: Profile): AdminMember {
  return { netId: profile.netId, name: profile.name, major: profile.major, classOf: profile.classOf, answers: profile.answers, createdAt: profile.createdAt, lastSeenAt: profile.lastSeenAt };
}

function offerFrom(row: Row): Offer {
  return {
    id: String(row.id),
    // A database not yet migrated has no currency column: everything in it is Falcons.
    currency: row.currency === 'campus' ? 'campus' : 'falcon',
    side: String(row.side) as Offer['side'],
    amount: Number(row.amount),
    rate: Number(row.rate),
    contactKind: String(row.contact_kind) as Offer['contactKind'],
    contact: String(row.contact),
    note: String(row.note ?? ''),
    posterKey: String(row.poster_key),
    posterNetId: String(row.poster_net_id),
    posterName: String(row.poster_name),
    status: String(row.status) as Offer['status'],
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
  };
}

function listingFrom(row: Row): Listing {
  return {
    id: String(row.id),
    kind: String(row.kind) as Listing['kind'],
    title: String(row.title),
    body: String(row.body ?? ''),
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    place: String(row.place ?? ''),
    destination: String(row.destination ?? ''),
    happensAt: row.happens_at ? String(row.happens_at) : undefined,
    seats: row.seats === null || row.seats === undefined ? null : Number(row.seats),
    contactKind: String(row.contact_kind) as Listing['contactKind'],
    contact: String(row.contact),
    posterKey: String(row.poster_key),
    posterNetId: String(row.poster_net_id),
    posterName: String(row.poster_name),
    status: String(row.status) as Listing['status'],
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
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

function reviewFrom(row: Row): CourseReview {
  const scale = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: String(row.id),
    code: String(row.code),
    netId: String(row.net_id),
    authorName: String(row.author_name ?? ''),
    authorMajor: String(row.author_major ?? ''),
    authorYear: String(row.author_year ?? '') as Standing,
    rating: Number(row.rating),
    difficulty: scale(row.difficulty),
    workload: scale(row.workload),
    text: String(row.text ?? ''),
    term: String(row.term ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  };
}

function answerFrom(row: Row): Answer {
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    text: String(row.text ?? ''),
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
  if (env.ROR_BOARD_STORE === 'memory') shared = new MemoryBoardStore();
  else if (cfg) shared = new SupabaseBoardStore(cfg);
  else if (env.NODE_ENV !== 'production' && env.VERCEL !== '1') shared = new MemoryBoardStore();
  else shared = null;
  return shared;
}
