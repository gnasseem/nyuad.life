/**
 * The student board: questions that need a human, handed one at a time to students who want to help.
 * Storage is behind BoardStore (lib/board-store.ts); this file holds the rules: validation, who counts as which
 * year, how a question is tagged for the right helpers, and which question a helper sees next.
 */
import { createHash } from 'node:crypto';
import { generateJson, type GeminiConfig } from './gemini.ts';
import { ApiError } from './http.ts';
import { bm25Query, buildBm25 } from './search.ts';
import { collapseWhitespace, extractCourseCodes, tokenize } from './text.ts';
import { classifyTopics, TOPICS } from './topics.ts';

export const MAJORS = [
  'Arab Crossroads Studies', 'Art and Art History', 'Bioengineering', 'Biology', 'Business, Organizations and Society', 'Chemistry', 'Civil Engineering',
  'Computer Engineering', 'Computer Science', 'Economics', 'Electrical Engineering', 'Film and New Media', 'General Engineering', 'History',
  'Interactive Media', 'Legal Studies', 'Literature and Creative Writing', 'Mathematics', 'Mechanical Engineering', 'Music', 'Philosophy', 'Physics',
  'Political Science', 'Psychology', 'Social Research and Public Policy', 'Theater', 'Undecided', 'Other',
] as const;

const STANDINGS = ['first-year', 'sophomore', 'junior', 'senior', 'alumni'] as const;
export type Standing = (typeof STANDINGS)[number];
export const STANDING_LABELS: Record<Standing, string> = { 'first-year': 'First year', sophomore: 'Sophomore', junior: 'Junior', senior: 'Senior', alumni: 'Alumni' };

export interface Profile {
  netId: string;
  name: string;
  major: string;
  classOf: number;
  answers: number;
  createdAt: string;
  lastSeenAt: string;
}

type QuestionStatus = 'open' | 'answered' | 'closed';

export interface Question {
  id: string;
  text: string;
  /** A short title the model writes for lists and for the flashcard header. */
  summary: string;
  topics: string[];
  courses: string[];
  /** Who is best placed to answer; empty means anyone. */
  majors: string[];
  years: Standing[];
  askerKey: string;
  askerName: string;
  status: QuestionStatus;
  views: number;
  skips: number;
  answers: number;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface Answer {
  id: string;
  questionId: string;
  text: string;
  helperNetId: string;
  helperName: string;
  helperMajor: string;
  helperYear: Standing;
  createdAt: string;
}

export type EventKind = 'view' | 'skip' | 'answer';

export interface BoardEvent {
  questionId: string;
  netId: string;
  kind: EventKind;
  createdAt: string;
}

const QUESTION_MIN = 12;
export const QUESTION_MAX = 600;
const ANSWER_MIN = 2;
const ANSWER_MAX = 1200;
/** Questions stop being handed out once this many people have answered. */
const ENOUGH_ANSWERS = 3;

/** The academic year turns over on 1 May: the class of 2026 graduates on 1 May 2026, and the class of 2030 is a first-year from then. */
export function academicYearOf(now = new Date()): number {
  const rolledOver = now.getUTCMonth() >= 4; // May onwards
  return rolledOver ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export function standingFor(classOf: number, now = new Date()): Standing {
  const academicYear = academicYearOf(now);
  const yearsLeft = classOf - academicYear;
  if (yearsLeft >= 3) return 'first-year';
  if (yearsLeft === 2) return 'sophomore';
  if (yearsLeft === 1) return 'junior';
  if (yearsLeft === 0) return 'senior';
  return 'alumni';
}

export function validateNetId(value: unknown): string {
  const netId = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-z]{1,8}\d{1,6}$/.test(netId)) throw new ApiError(400, 'Enter a NetID like abc1234.', 'bad_net_id');
  return netId;
}

export function validateProfile(body: Record<string, unknown>): Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'> {
  const netId = validateNetId(body.netId);
  const name = collapseWhitespace(String(body.name ?? '')).slice(0, 60);
  if (name.length < 2) throw new ApiError(400, 'Enter your name.', 'bad_name');
  const major = collapseWhitespace(String(body.major ?? '')).slice(0, 60);
  if (!major) throw new ApiError(400, 'Choose a major.', 'bad_major');
  const classOf = Number(body.classOf);
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(classOf) || classOf < thisYear - 15 || classOf > thisYear + 6) throw new ApiError(400, 'Choose a class year.', 'bad_class_of');
  return { netId, name, major, classOf };
}

export function validateQuestionText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < QUESTION_MIN) throw new ApiError(400, 'The question is too short.', 'question_too_short');
  if (text.length > QUESTION_MAX) throw new ApiError(400, `Keep questions under ${QUESTION_MAX} characters.`, 'question_too_long');
  return text;
}

export function validateAnswerText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (text.length < ANSWER_MIN) throw new ApiError(400, 'The answer is too short.', 'answer_too_short');
  if (text.length > ANSWER_MAX) throw new ApiError(400, `Keep answers under ${ANSWER_MAX} characters.`, 'answer_too_long');
  return text;
}

export function validateKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!/^[a-z0-9-]{8,64}$/i.test(key)) throw new ApiError(400, 'Missing asker key.', 'bad_key');
  return key;
}

interface QuestionTags {
  summary: string;
  topics: string[];
  courses: string[];
  majors: string[];
  years: Standing[];
}

const TAG_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    majors: { type: 'ARRAY', items: { type: 'STRING' } },
    years: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'topics', 'majors', 'years'],
};

/** Rule-based tags, used on their own when no model is configured and as the floor under the model's answer. */
export function tagByRules(text: string): QuestionTags {
  const firstLine = collapseWhitespace(text.split('\n')[0] ?? '');
  return { summary: firstLine.length > 90 ? `${firstLine.slice(0, 87).trimEnd()}…` : firstLine, topics: classifyTopics(text).filter((topic) => topic !== 'general'), courses: extractCourseCodes(text), majors: [], years: [] };
}

/** Asks the lite model who should see a question; falls back to the rules when the call fails. */
export async function tagQuestion(cfg: GeminiConfig | null, text: string): Promise<QuestionTags> {
  const rules = tagByRules(text);
  if (!cfg) return rules;
  try {
    const result = await generateJson<{ summary?: string; topics?: string[]; majors?: string[]; years?: string[] }>(
      cfg,
      {
        model: cfg.liteModels,
        temperature: 0,
        maxOutputTokens: 300,
        responseSchema: TAG_SCHEMA,
        system: [
          'You route questions from NYU Abu Dhabi students to the students best placed to answer them.',
          'Return: summary (a neutral title of at most 10 words), topics (from this list only: ' + TOPICS.map((topic) => topic.id).join(', ') + '),',
          'majors (from this list only, and only when the question really needs that background, otherwise empty: ' + MAJORS.filter((major) => major !== 'Other' && major !== 'Undecided').join('; ') + '),',
          'years (from: first-year, sophomore, junior, senior, alumni; only when experience of that stage is needed, e.g. capstone or grad school questions go to senior and alumni; otherwise empty).',
        ].join(' '),
        messages: [{ role: 'user', text }],
      },
      { retries: 0, timeoutMs: 10_000 },
    );
    const topicIds = new Set(TOPICS.map((topic) => topic.id));
    const majors = (result.majors ?? []).filter((major): major is string => typeof major === 'string' && (MAJORS as readonly string[]).includes(major));
    const years = (result.years ?? []).filter((year): year is Standing => (STANDINGS as readonly string[]).includes(year));
    const topics = (result.topics ?? []).filter((topic): topic is string => typeof topic === 'string' && topicIds.has(topic));
    const summary = collapseWhitespace(String(result.summary ?? '')).slice(0, 90);
    return {
      summary: summary || rules.summary,
      topics: topics.length ? [...new Set([...topics, ...rules.topics])].slice(0, 4) : rules.topics,
      courses: rules.courses,
      majors: majors.slice(0, 4),
      years: years.slice(0, 3),
    };
  } catch {
    return rules;
  }
}

interface HelperContext {
  profile: Profile;
  /** The helper's browser key, which is what their own questions carry, so they are never handed back to them. */
  askerKey?: string;
  /** Everything this helper has already done, so nothing is shown twice. */
  events: BoardEvent[];
  now?: Date;
  random?: () => number;
}

/**
 * Which question a helper sees next. Unanswered questions come first, then the ones fewest people have seen, with a
 * lift when the helper's major or year is what the question asked for and a penalty for questions many people
 * skipped. A little randomness keeps two helpers who open the page together from getting the same card.
 */
/** Questions this helper may still be shown: not closed, not answered enough, not their own, not already acted on. */
export function eligibleQuestions(questions: Question[], context: Pick<HelperContext, 'profile' | 'events' | 'askerKey'>): Question[] {
  const done = new Set(context.events.filter((event) => event.kind !== 'view').map((event) => event.questionId));
  const own = (question: Question) => question.askerKey === context.profile.netId || (context.askerKey !== undefined && question.askerKey === context.askerKey);
  return questions.filter((question) => question.status !== 'closed' && question.answers < ENOUGH_ANSWERS && !done.has(question.id) && !own(question));
}

export function pickNext(questions: Question[], context: HelperContext): Question | null {
  const now = context.now ?? new Date();
  const random = context.random ?? Math.random;
  const standing = standingFor(context.profile.classOf, now);
  const viewed = new Set(context.events.filter((event) => event.kind === 'view').map((event) => event.questionId));
  let best: { question: Question; score: number } | null = null;
  for (const question of eligibleQuestions(questions, context)) {
    const ageDays = Math.max(0, (now.getTime() - Date.parse(question.createdAt)) / 86_400_000);
    const need = question.answers === 0 ? 3 : question.answers === 1 ? 1.5 : 0.5;
    const majorFit = question.majors.length === 0 ? 0 : question.majors.includes(context.profile.major) ? 1.5 : -0.75;
    const yearFit = question.years.length === 0 ? 0 : question.years.includes(standing) ? 1 : -0.5;
    const exposure = -0.15 * question.views - 0.4 * question.skips;
    const patience = Math.min(1, ageDays / 2) * 0.5 * Math.exp(-ageDays / 45);
    const score = need + majorFit + yearFit + exposure + patience - (viewed.has(question.id) ? 1 : 0) + random() * 0.3;
    if (!best || score > best.score) best = { question, score };
  }
  return best?.question ?? null;
}

interface BoardHit {
  question: Question;
  answers: Answer[];
  score: number;
}

/**
 * Finds answered board questions that speak to a query: keyword match over the question and its answers, plus the
 * cosine similarity of stored question embeddings when the query was embedded the same way.
 */
export function searchBoard(entries: Array<{ question: Question; answers: Answer[] }>, query: string, queryVector?: Float32Array, limit = 3): BoardHit[] {
  const answered = entries.filter((entry) => entry.answers.length > 0);
  if (answered.length === 0) return [];
  const docs = answered.map((entry) => [entry.question.text, ...entry.answers.map((answer) => answer.text)].join('\n'));
  const lexical = bm25Query(buildBm25(docs), tokenize(query), 20);
  const scores = new Map<number, number>();
  const topLexical = lexical[0]?.score ?? 0;
  for (const { row, score } of lexical) if (topLexical > 0) scores.set(row, 0.6 * (score / topLexical));
  if (queryVector) {
    answered.forEach((entry, row) => {
      const vector = entry.question.embedding;
      if (!vector || vector.length !== queryVector.length) return;
      let dot = 0;
      for (let i = 0; i < vector.length; i++) dot += vector[i]! * queryVector[i]!;
      if (dot > 0.45) scores.set(row, (scores.get(row) ?? 0) + Math.min(1, (dot - 0.45) / 0.35));
    });
  }
  return [...scores.entries()]
    .filter(([, score]) => score >= 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([row, score]) => ({ question: answered[row]!.question, answers: answered[row]!.answers, score }));
}

/* ---------- Announcements ---------- */

const ANNOUNCEMENT_KINDS = ['event', 'deadline', 'opportunity', 'club', 'notice'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export interface Announcement {
  id: string;
  title: string;
  body: string;
  kind: AnnouncementKind;
  /** When it happens, for events and deadlines. */
  startsAt?: string;
  location: string;
  link: string;
  posterKey: string;
  posterNetId: string;
  posterName: string;
  /** Drops out of the feed after this. */
  expiresAt: string;
  createdAt: string;
}

const ANNOUNCEMENT_DAYS = 14;

export function validateAnnouncement(body: Record<string, unknown>, now = new Date()): Omit<Announcement, 'id' | 'createdAt' | 'posterKey' | 'posterNetId' | 'posterName'> {
  const title = collapseWhitespace(String(body.title ?? '')).slice(0, 120);
  if (title.length < 4) throw new ApiError(400, 'Enter a title.', 'bad_title');
  const text = String(body.body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 1500) throw new ApiError(400, 'Keep the details under 1,500 characters.', 'body_too_long');
  const kind = String(body.kind ?? 'notice') as AnnouncementKind;
  if (!ANNOUNCEMENT_KINDS.includes(kind)) throw new ApiError(400, 'Choose a kind.', 'bad_kind');
  let startsAt: string | undefined;
  if (body.startsAt) {
    const parsed = Date.parse(String(body.startsAt));
    if (Number.isNaN(parsed)) throw new ApiError(400, 'The date is invalid.', 'bad_date');
    if (parsed < now.getTime() - 86_400_000) throw new ApiError(400, 'The date is in the past.', 'past_date');
    startsAt = new Date(parsed).toISOString();
  }
  const location = collapseWhitespace(String(body.location ?? '')).slice(0, 80);
  const link = String(body.link ?? '').trim();
  if (link && !/^https?:\/\/[^\s]{3,300}$/i.test(link)) throw new ApiError(400, 'Links must start with http:// or https://.', 'bad_link');
  const expiresAt = new Date((startsAt ? Date.parse(startsAt) : now.getTime()) + (startsAt ? 1 : ANNOUNCEMENT_DAYS) * 86_400_000).toISOString();
  return { title, body: text, kind, startsAt, location, link, expiresAt };
}

/** Announcements that speak to a query, newest and soonest first among matches. */
export function searchAnnouncements(announcements: Announcement[], query: string, limit = 2): Array<{ announcement: Announcement; score: number }> {
  if (announcements.length === 0) return [];
  const docs = announcements.map((entry) => `${entry.title}\n${entry.body}\n${entry.location}`);
  const lexical = bm25Query(buildBm25(docs), tokenize(query), limit * 3);
  const top = lexical[0]?.score ?? 0;
  return lexical
    .filter(({ score }) => top > 0 && score / top >= 0.5)
    .slice(0, limit)
    .map(({ row, score }) => ({ announcement: announcements[row]!, score: score / top }));
}

/* ---------- Leaderboard ---------- */

export interface LeaderboardEntry {
  /** A stable handle for the row; not the NetID, which works as a login on this board. */
  id: string;
  /** Set when the entry is the helper who asked. */
  me: boolean;
  name: string;
  major: string;
  year: Standing;
  answers: number;
  /** Consecutive calendar weeks (Monday to Sunday) with at least one answer, ending this week or last week. */
  streak: number;
  lastAnswerAt: string;
}

/** Monday 00:00 UTC of the week a date falls in, as a day number. */
export function weekOf(iso: string): number {
  const day = Math.floor(Date.parse(iso) / 86_400_000);
  const weekday = (day + 3) % 7; // 1970-01-01 was a Thursday
  return day - weekday;
}

/** Ranks helpers by answers written, with a streak of consecutive weeks; the most recent answer breaks ties. */
export function leaderboard(answers: Answer[], now = new Date(), limit = 10, viewerNetId = ''): LeaderboardEntry[] {
  const byHelper = new Map<string, Answer[]>();
  for (const answer of answers) byHelper.set(answer.helperNetId, [...(byHelper.get(answer.helperNetId) ?? []), answer]);
  const thisWeek = weekOf(now.toISOString());
  const entries: LeaderboardEntry[] = [];
  for (const [netId, list] of byHelper) {
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const weeks = new Set(sorted.map((answer) => weekOf(answer.createdAt)));
    let streak = 0;
    let week = weeks.has(thisWeek) ? thisWeek : thisWeek - 7;
    while (weeks.has(week)) {
      streak++;
      week -= 7;
    }
    const latest = sorted[0]!;
    entries.push({ id: createHash('sha256').update(`helper:${netId}`).digest('hex').slice(0, 12), me: netId === viewerNetId, name: latest.helperName, major: latest.helperMajor, year: latest.helperYear, answers: list.length, streak, lastAnswerAt: latest.createdAt });
  }
  return entries.sort((a, b) => b.answers - a.answers || b.streak - a.streak || b.lastAnswerAt.localeCompare(a.lastAnswerAt)).slice(0, limit);
}

/* ---------- Exchanges: Falcons and Campus Dirhams ---------- */

export type OfferSide = 'sell' | 'buy';
/**
 * falcon: Falcon Dirhams, the Personal Support award spent on campus, traded in the thousands.
 * campus: Campus Dirhams, the meal-plan money for dining venues, a separate balance, often sold at about half price.
 */
export const OFFER_CURRENCIES = ['falcon', 'campus'] as const;
export type OfferCurrency = (typeof OFFER_CURRENCIES)[number];
export const CURRENCY_LABELS: Record<OfferCurrency, string> = { falcon: 'Falcons', campus: 'Campus Dirhams' };
const CONTACT_KINDS = ['whatsapp', 'instagram', 'email', 'phone'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface Offer {
  id: string;
  /** Which balance is traded. Offers from before Campus Dirhams existed are Falcons. */
  currency: OfferCurrency;
  /** sell: has the currency, wants AED. buy: has AED, wants the currency. */
  side: OfferSide;
  /** Units on offer or wanted. */
  amount: number;
  /** AED per unit, for example 0.85. */
  rate: number;
  contactKind: ContactKind;
  contact: string;
  note: string;
  posterKey: string;
  posterNetId: string;
  posterName: string;
  status: 'open' | 'done';
  expiresAt: string;
  createdAt: string;
}

const OFFER_DAYS = 5;
const OFFER_MIN = 5;
const OFFER_MAX = 20_000;

export function validateOffer(body: Record<string, unknown>, now = new Date()): Omit<Offer, 'id' | 'createdAt' | 'posterKey' | 'posterNetId' | 'posterName' | 'status'> {
  const currency = String(body.currency ?? 'falcon') as OfferCurrency;
  if (!OFFER_CURRENCIES.includes(currency)) throw new ApiError(400, 'Choose Falcons or Campus Dirhams.', 'bad_currency');
  const unit = CURRENCY_LABELS[currency];
  const side = String(body.side ?? '') as OfferSide;
  if (side !== 'sell' && side !== 'buy') throw new ApiError(400, 'Choose sell or buy.', 'bad_side');
  const amount = Math.round(Number(body.amount));
  if (!Number.isFinite(amount) || amount < OFFER_MIN || amount > OFFER_MAX) throw new ApiError(400, `Amount must be between ${OFFER_MIN} and ${OFFER_MAX.toLocaleString()} ${unit}.`, 'bad_amount');
  const rate = Math.round(Number(body.rate) * 100) / 100;
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 2) throw new ApiError(400, `The rate must be between 0.10 and 2.00 AED per ${currency === 'falcon' ? 'Falcon' : 'Campus Dirham'}.`, 'bad_rate');
  const { contactKind, contact } = validateContact(body);
  const note = collapseWhitespace(String(body.note ?? '')).slice(0, 200);
  const expiresAt = new Date(now.getTime() + OFFER_DAYS * 86_400_000).toISOString();
  return { currency, side, amount, rate, contactKind, contact, note, expiresAt };
}

/** How to reach whoever posted an offer or a listing; shown only when someone asks for it. */
export function validateContact(body: Record<string, unknown>): { contactKind: ContactKind; contact: string } {
  const contactKind = String(body.contactKind ?? 'whatsapp') as ContactKind;
  if (!CONTACT_KINDS.includes(contactKind)) throw new ApiError(400, 'Choose a contact method.', 'bad_contact_kind');
  const contact = collapseWhitespace(String(body.contact ?? '')).slice(0, 80);
  if (contact.length < 3) throw new ApiError(400, 'Enter your contact details.', 'bad_contact');
  if (contactKind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new ApiError(400, 'Enter a valid email address.', 'bad_contact');
  if ((contactKind === 'whatsapp' || contactKind === 'phone') && !/^\+?[\d\s()-]{7,20}$/.test(contact)) throw new ApiError(400, 'Use a phone number with the country code, like +971 50 123 4567.', 'bad_contact');
  return { contactKind, contact };
}

export interface MarketSummary {
  open: number;
  selling: number;
  buying: number;
  /** Best rate for someone buying (the lowest asking price) and for someone selling (the highest bid). */
  bestAsk: number | null;
  bestBid: number | null;
  medianRate: number | null;
  /** Units on offer in total. */
  volume: number;
}

/** One currency's book in figures; with no currency given, Falcons, which is what older clients read. */
export function summarizeMarket(offers: Offer[], currency: OfferCurrency = 'falcon'): MarketSummary {
  const open = offers.filter((offer) => offer.status === 'open' && (offer.currency ?? 'falcon') === currency);
  const asks = open.filter((offer) => offer.side === 'sell').map((offer) => offer.rate);
  const bids = open.filter((offer) => offer.side === 'buy').map((offer) => offer.rate);
  const rates = open.map((offer) => offer.rate).sort((a, b) => a - b);
  const median = rates.length === 0 ? null : rates.length % 2 ? rates[(rates.length - 1) / 2]! : (rates[rates.length / 2 - 1]! + rates[rates.length / 2]!) / 2;
  return {
    open: open.length,
    selling: asks.length,
    buying: bids.length,
    bestAsk: asks.length ? Math.min(...asks) : null,
    bestBid: bids.length ? Math.max(...bids) : null,
    medianRate: median === null ? null : Math.round(median * 100) / 100,
    volume: open.reduce((sum, offer) => sum + offer.amount, 0),
  };
}

/* ---------- Market: things for sale, wanted or free, shared rides, and lost and found ---------- */

const LISTING_KINDS = ['sell', 'want', 'free', 'ride', 'lost', 'found'] as const;
export type ListingKind = (typeof LISTING_KINDS)[number];

export interface Listing {
  id: string;
  kind: ListingKind;
  title: string;
  body: string;
  /** Asking price in AED for sell, budget for want; null when not given, 0 for free. */
  price: number | null;
  /** Pickup spot, where something was lost or found, or where a ride leaves from. */
  place: string;
  /** Where a ride goes. */
  destination: string;
  /** When a ride leaves, or when something was lost or found. */
  happensAt?: string;
  /** People a ride has room for. */
  seats: number | null;
  contactKind: ContactKind;
  contact: string;
  posterKey: string;
  posterNetId: string;
  posterName: string;
  status: 'open' | 'done';
  expiresAt: string;
  createdAt: string;
}

/** Days a listing stays up. Rides drop off three hours after they leave. */
const LISTING_DAYS: Record<Exclude<ListingKind, 'ride'>, number> = { sell: 21, want: 14, free: 7, lost: 21, found: 21 };
const RIDE_GRACE_MS = 3 * 3_600_000;
const PRICE_MAX = 100_000;

export function validateListing(body: Record<string, unknown>, now = new Date()): Omit<Listing, 'id' | 'createdAt' | 'posterKey' | 'posterNetId' | 'posterName' | 'status'> {
  const kind = String(body.kind ?? '') as ListingKind;
  if (!LISTING_KINDS.includes(kind)) throw new ApiError(400, 'Choose what kind of post this is.', 'bad_kind');
  const place = collapseWhitespace(String(body.place ?? '')).slice(0, 80);
  const destination = kind === 'ride' ? collapseWhitespace(String(body.destination ?? '')).slice(0, 80) : '';
  let title = collapseWhitespace(String(body.title ?? '')).slice(0, 100);
  if (kind === 'ride') {
    if (place.length < 2 || destination.length < 2) throw new ApiError(400, 'Say where the ride leaves from and where it goes.', 'bad_route');
    title = `${place} to ${destination}`;
  } else if (title.length < 3) throw new ApiError(400, 'Enter a title.', 'bad_title');
  const text = String(body.body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 1000) throw new ApiError(400, 'Keep the details under 1,000 characters.', 'body_too_long');

  let price: number | null = null;
  if (kind === 'free') price = 0;
  else if ((kind === 'sell' || kind === 'want') && body.price !== undefined && body.price !== null && String(body.price).trim() !== '') {
    price = Math.round(Number(body.price) * 100) / 100;
    if (!Number.isFinite(price) || price < 0 || price > PRICE_MAX) throw new ApiError(400, `The price must be between 0 and ${PRICE_MAX.toLocaleString()} AED.`, 'bad_price');
  }

  let happensAt: string | undefined;
  if (body.happensAt) {
    const parsed = Date.parse(String(body.happensAt));
    if (Number.isNaN(parsed)) throw new ApiError(400, 'The date is invalid.', 'bad_date');
    if (kind === 'ride' && parsed < now.getTime() - RIDE_GRACE_MS) throw new ApiError(400, 'That time has passed.', 'past_date');
    if (kind === 'ride' && parsed > now.getTime() + 60 * 86_400_000) throw new ApiError(400, 'Rides can be posted up to two months ahead.', 'far_date');
    if ((kind === 'lost' || kind === 'found') && parsed > now.getTime() + 3_600_000) throw new ApiError(400, 'That date is in the future.', 'future_date');
    if (kind === 'ride' || kind === 'lost' || kind === 'found') happensAt = new Date(parsed).toISOString();
  }
  if (kind === 'ride' && !happensAt) throw new ApiError(400, 'Say when the ride leaves.', 'bad_date');

  let seats: number | null = null;
  if (kind === 'ride' && body.seats !== undefined && body.seats !== null && String(body.seats).trim() !== '') {
    seats = Math.round(Number(body.seats));
    if (!Number.isFinite(seats) || seats < 1 || seats > 12) throw new ApiError(400, 'Seats must be between 1 and 12.', 'bad_seats');
  }

  const { contactKind, contact } = validateContact(body);
  const expiresAt = kind === 'ride' ? new Date(Date.parse(happensAt!) + RIDE_GRACE_MS).toISOString() : new Date(now.getTime() + LISTING_DAYS[kind] * 86_400_000).toISOString();
  return { kind, title, body: text, price, place, destination, happensAt, seats, contactKind, contact, expiresAt };
}
