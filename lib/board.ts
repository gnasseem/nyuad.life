/**
 * The student board: questions that need a human, handed one at a time to students who want to help.
 * Storage is behind BoardStore (lib/board-store.ts); this file holds the rules: validation, who counts as which
 * year, how a question is tagged for the right helpers, and which question a helper sees next.
 */
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

export const STANDINGS = ['first-year', 'sophomore', 'junior', 'senior', 'alumni'] as const;
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

export type QuestionStatus = 'open' | 'answered' | 'closed';

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

export const QUESTION_MIN = 12;
export const QUESTION_MAX = 600;
export const ANSWER_MIN = 2;
export const ANSWER_MAX = 1200;
/** Questions stop being handed out once this many people have answered. */
export const ENOUGH_ANSWERS = 3;

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
  if (!/^[a-z]{1,8}\d{1,6}$/.test(netId)) throw new ApiError(400, 'That does not look like a NetID (letters then digits, like abc1234).', 'bad_net_id');
  return netId;
}

export function validateProfile(body: Record<string, unknown>): Pick<Profile, 'netId' | 'name' | 'major' | 'classOf'> {
  const netId = validateNetId(body.netId);
  const name = collapseWhitespace(String(body.name ?? '')).slice(0, 60);
  if (name.length < 2) throw new ApiError(400, 'Add your name.', 'bad_name');
  const major = collapseWhitespace(String(body.major ?? '')).slice(0, 60);
  if (!major) throw new ApiError(400, 'Pick a major.', 'bad_major');
  const classOf = Number(body.classOf);
  const thisYear = new Date().getUTCFullYear();
  if (!Number.isInteger(classOf) || classOf < thisYear - 15 || classOf > thisYear + 6) throw new ApiError(400, 'Pick your class year.', 'bad_class_of');
  return { netId, name, major, classOf };
}

export function validateQuestionText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < QUESTION_MIN) throw new ApiError(400, 'Give people a little more to go on.', 'question_too_short');
  if (text.length > QUESTION_MAX) throw new ApiError(400, `Keep questions under ${QUESTION_MAX} characters.`, 'question_too_long');
  return text;
}

export function validateAnswerText(value: unknown): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (text.length < ANSWER_MIN) throw new ApiError(400, 'Write an answer first.', 'answer_too_short');
  if (text.length > ANSWER_MAX) throw new ApiError(400, `Keep answers under ${ANSWER_MAX} characters.`, 'answer_too_long');
  return text;
}

export function validateKey(value: unknown): string {
  const key = String(value ?? '').trim();
  if (!/^[a-z0-9-]{8,64}$/i.test(key)) throw new ApiError(400, 'Missing asker key.', 'bad_key');
  return key;
}

export interface QuestionTags {
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
        model: cfg.liteModel,
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

export interface HelperContext {
  profile: Profile;
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
export function eligibleQuestions(questions: Question[], context: Pick<HelperContext, 'profile' | 'events'>): Question[] {
  const done = new Set(context.events.filter((event) => event.kind !== 'view').map((event) => event.questionId));
  return questions.filter((question) => question.status !== 'closed' && question.answers < ENOUGH_ANSWERS && !done.has(question.id) && question.askerKey !== context.profile.netId);
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

export interface BoardHit {
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

export const ANNOUNCEMENT_KINDS = ['event', 'deadline', 'opportunity', 'club', 'notice'] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];
export const ANNOUNCEMENT_LABELS: Record<AnnouncementKind, string> = { event: 'Event', deadline: 'Deadline', opportunity: 'Opportunity', club: 'Club', notice: 'Notice' };

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

export const ANNOUNCEMENT_DAYS = 14;

export function validateAnnouncement(body: Record<string, unknown>, now = new Date()): Omit<Announcement, 'id' | 'createdAt' | 'posterKey' | 'posterNetId' | 'posterName'> {
  const title = collapseWhitespace(String(body.title ?? '')).slice(0, 120);
  if (title.length < 4) throw new ApiError(400, 'Give the announcement a title.', 'bad_title');
  const text = String(body.body ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > 1500) throw new ApiError(400, 'Keep the details under 1,500 characters.', 'body_too_long');
  const kind = String(body.kind ?? 'notice') as AnnouncementKind;
  if (!ANNOUNCEMENT_KINDS.includes(kind)) throw new ApiError(400, 'Pick what kind of announcement this is.', 'bad_kind');
  let startsAt: string | undefined;
  if (body.startsAt) {
    const parsed = Date.parse(String(body.startsAt));
    if (Number.isNaN(parsed)) throw new ApiError(400, 'That date did not make sense.', 'bad_date');
    if (parsed < now.getTime() - 86_400_000) throw new ApiError(400, 'That date is already in the past.', 'past_date');
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
