/**
 * The student board and the announcements feed, on one route so the function count stays small:
 *   GET  /api/board?op=stats | question&id= | mine&key= | announcements
 *   POST /api/board { op: profile | ask | next | answer | skip | announce | unannounce, ... }
 */
import {
  eligibleQuestions,
  pickNext,
  searchBoard,
  standingFor,
  tagQuestion,
  validateAnnouncement,
  validateAnswerText,
  validateKey,
  validateNetId,
  validateProfile,
  validateQuestionText,
  type Announcement,
  type Answer,
  type Profile,
  type Question,
} from '../lib/board.ts';
import { boardStore, type BoardStore } from '../lib/board-store.ts';
import { detectRedirect } from '../lib/domains.ts';
import { embedderForIndex } from '../lib/embeddings.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, queryString, rateLimit, readJson, route, sendJson, type ApiRequest } from '../lib/http.ts';
import { retrieve } from '../lib/rag.ts';
import { loadArchive, summarizePost } from '../lib/store.ts';
import { collapseWhitespace } from '../lib/text.ts';

type Body = Record<string, unknown>;

export default route(['GET', 'POST'], async (req, res) => {
  const store = boardStore();
  if (!store) throw new ApiError(503, 'The board is not set up on this server yet.', 'board_unavailable');
  const body: Body = req.method === 'POST' ? await readJson<Body>(req) : {};
  const op = String(req.method === 'POST' ? body.op ?? '' : queryString(req, 'op')).trim();

  switch (op) {
    case 'stats':
      rateLimit(req, 60, 60);
      sendJson(res, 200, await store.stats());
      return;
    case 'announcements':
      rateLimit(req, 60, 60);
      sendJson(res, 200, { announcements: (await store.listAnnouncements(new Date())).map(publicAnnouncement) });
      return;
    case 'question': {
      rateLimit(req, 60, 60);
      const question = await store.getQuestion(queryString(req, 'id').trim());
      if (!question) throw new ApiError(404, 'That question is gone.', 'not_found');
      sendJson(res, 200, { question: publicQuestion(question), answers: (await store.listAnswers([question.id])).map(publicAnswer) });
      return;
    }
    case 'mine': {
      rateLimit(req, 60, 60);
      const key = validateKey(queryString(req, 'key'));
      const questions = await store.listByAsker(key);
      const answers = await store.listAnswers(questions.map((question) => question.id));
      sendJson(res, 200, {
        questions: questions.map((question) => ({ ...publicQuestion(question), answers: answers.filter((answer) => answer.questionId === question.id).map(publicAnswer) })),
      });
      return;
    }
    case 'profile': {
      rateLimit(req, 10, 10);
      const profile = await store.upsertProfile(validateProfile(body));
      sendJson(res, 200, { profile: publicProfile(profile) });
      return;
    }
    case 'ask':
      rateLimit(req, 5, 3);
      sendJson(res, 200, await askQuestion(store, body));
      return;
    case 'next': {
      rateLimit(req, 40, 30);
      const profile = await requireProfile(store, body.netId);
      const [questions, events] = await Promise.all([store.listOpen(300), store.listEventsByHelper(profile.netId)]);
      const question = pickNext(questions, { profile, events });
      const remaining = eligibleQuestions(questions, { profile, events }).length;
      if (question) {
        await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'view' }), store.bump(question.id, { views: 1 }), store.touchProfile(profile.netId, false)]);
      }
      sendJson(res, 200, { question: question ? publicQuestion(question) : null, remaining, answered: profile.answers });
      return;
    }
    case 'answer': {
      rateLimit(req, 20, 15);
      const profile = await requireProfile(store, body.netId);
      const question = await store.getQuestion(String(body.questionId ?? ''));
      if (!question || question.status === 'closed') throw new ApiError(404, 'That question is no longer open.', 'not_found');
      const text = validateAnswerText(body.text);
      const answer = await store.createAnswer({ questionId: question.id, text, helperNetId: profile.netId, helperName: profile.name, helperMajor: profile.major, helperYear: standingFor(profile.classOf) });
      await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'answer' }), store.bump(question.id, { answers: 1 }), store.touchProfile(profile.netId, true)]);
      sendJson(res, 200, { answer: publicAnswer(answer), answered: profile.answers + 1 });
      return;
    }
    case 'skip': {
      rateLimit(req, 60, 60);
      const profile = await requireProfile(store, body.netId);
      const question = await store.getQuestion(String(body.questionId ?? ''));
      if (question) await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'skip' }), store.bump(question.id, { skips: 1 })]);
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'announce': {
      rateLimit(req, 5, 3);
      const profile = await requireProfile(store, body.netId);
      const posterKey = validateKey(body.key);
      const announcement = await store.createAnnouncement({ ...validateAnnouncement(body), posterKey, posterNetId: profile.netId, posterName: profile.name });
      sendJson(res, 200, { announcement: publicAnnouncement(announcement) });
      return;
    }
    case 'unannounce': {
      rateLimit(req, 20, 20);
      const removed = await store.deleteAnnouncement(String(body.id ?? ''), validateKey(body.key));
      if (!removed) throw new ApiError(404, 'Only the person who posted it can remove it.', 'not_found');
      sendJson(res, 200, { ok: true });
      return;
    }
    default:
      throw new ApiError(400, 'Unknown board operation.', 'bad_op');
  }
});

async function requireProfile(store: BoardStore, netId: unknown): Promise<Profile> {
  const profile = await store.getProfile(validateNetId(netId));
  if (!profile) throw new ApiError(404, 'Tell us who you are first.', 'no_profile');
  return profile;
}

/** Posts a question; also returns what the archive and the board already know, so nobody waits for an answer they had. */
async function askQuestion(store: BoardStore, body: Body) {
  const text = validateQuestionText(body.text);
  const askerKey = validateKey(body.key);
  const askerName = collapseWhitespace(String(body.name ?? '')).slice(0, 40);
  const redirect = detectRedirect(text);
  if (redirect) return { redirect };

  const archive = await loadArchive();
  const cfg = geminiConfig();
  const [tags, retrieval] = await Promise.all([tagQuestion(cfg, text), retrieve(archive, text, { k: 3 })]);
  let embedding: number[] | undefined;
  const embedder = embedderForIndex(archive.meta);
  if (embedder) {
    try {
      const [vector] = await embedder.embed([text], 'document', { retries: 0, timeoutMs: 8_000 });
      embedding = Array.from(vector!, (value) => Number(value.toFixed(4)));
    } catch (error) {
      console.warn('[board] could not embed the question:', (error as Error).message);
    }
  }
  const question = await store.createQuestion({ text, ...tags, askerKey, askerName, status: 'open', views: 0, skips: 0, answers: 0, embedding });

  const answered = await store.listAnswered(200);
  const answers = await store.listAnswers(answered.map((entry) => entry.id));
  const similar = searchBoard(
    answered.map((entry) => ({ question: entry, answers: answers.filter((answer) => answer.questionId === entry.id) })),
    text,
    retrieval.vector,
    3,
  ).map((hit) => ({ ...publicQuestion(hit.question), answers: hit.answers.map(publicAnswer) }));
  const related = retrieval.hits.map((hit) => summarizePost(archive.posts[hit.post]!));
  return { question: publicQuestion(question), similar, related };
}

function publicProfile(profile: Profile) {
  return { netId: profile.netId, name: profile.name, major: profile.major, classOf: profile.classOf, year: standingFor(profile.classOf), answers: profile.answers };
}

function publicQuestion(question: Question) {
  const { askerKey: _key, embedding: _embedding, ...rest } = question;
  return rest;
}

function publicAnswer(answer: Answer) {
  const { helperNetId: _netId, ...rest } = answer;
  return rest;
}

function publicAnnouncement(announcement: Announcement) {
  const { posterKey: _key, posterNetId: _netId, ...rest } = announcement;
  return rest;
}

export type { ApiRequest };
