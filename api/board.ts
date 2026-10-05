/**
 * The student board, the announcements feed and the market, on one route so the function count stays small:
 *   GET  /api/board?op=stats | question&id= | recent | mine&key= | announcements | offers[&key=] | listings[&key=] | contact&type=offer|listing&id= | leaderboard[&netId=]
 *   (offers covers both currencies, Falcons and Campus Dirhams; each offer says which)
 *   POST /api/board { op: profile | ask | next | answer | skip | announce | unannounce | offer | offer_done | unoffer
 *                       | listing | listing_done | unlisting, ... }
 */
import {
  eligibleQuestions,
  leaderboard,
  pickNext,
  searchBoard,
  standingFor,
  tagQuestion,
  validateAnnouncement,
  validateAnswerText,
  validateKey,
  validateListing,
  summarizeMarket,
  validateNetId,
  validateOffer,
  CURRENCY_LABELS,
  validateProfile,
  validateQuestionText,
  type Announcement,
  type Answer,
  type Listing,
  type Offer,
  type Profile,
  type Question,
} from '../lib/board.ts';
import { createHash } from 'node:crypto';
import { boardStore, type BoardStore } from '../lib/board-store.ts';
import { detectRedirect } from '../lib/domains.ts';
import { embedderForIndex } from '../lib/embeddings.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, queryString, rateLimit, readJson, route, sendJson } from '../lib/http.ts';
import { screenPost, type PostKind } from '../lib/moderation.ts';
import { retrieve } from '../lib/rag.ts';
import { loadArchive, summarizePost } from '../lib/store.ts';
import { collapseWhitespace } from '../lib/text.ts';

type Body = Record<string, unknown>;

export default route(['GET', 'POST'], async (req, res) => {
  const store = boardStore();
  if (!store) throw new ApiError(503, 'The board is not set up on this server.', 'board_unavailable');
  const body: Body = req.method === 'POST' ? await readJson<Body>(req) : {};
  const op = String(req.method === 'POST' ? body.op ?? '' : queryString(req, 'op')).trim();

  switch (op) {
    case 'stats':
      rateLimit(req, 60, 60, 'board-read');
      sendJson(res, 200, await store.stats());
      return;
    case 'announcements':
      rateLimit(req, 60, 60, 'board-read');
      sendJson(res, 200, { announcements: (await store.listAnnouncements(new Date())).map(publicAnnouncement) });
      return;
    case 'offers': {
      rateLimit(req, 60, 60, 'board-read');
      const key = queryString(req, 'key').trim();
      const open = await store.listOffers(new Date());
      const mine = key && /^[a-z0-9-]{8,64}$/i.test(key) ? await store.listOffersByPoster(key) : [];
      // `market` is the Falcon book, which clients from before Campus Dirhams read; `markets` has both.
      sendJson(res, 200, { offers: open.map(publicOffer), mine: mine.map(publicOffer), market: summarizeMarket(open, 'falcon'), markets: { falcon: summarizeMarket(open, 'falcon'), campus: summarizeMarket(open, 'campus') } });
      return;
    }
    case 'listings': {
      rateLimit(req, 60, 60, 'board-read');
      const key = queryString(req, 'key').trim();
      const open = await store.listListings(new Date());
      const mine = key && /^[a-z0-9-]{8,64}$/i.test(key) ? await store.listListingsByPoster(key) : [];
      sendJson(res, 200, { listings: open.map(publicListing), mine: mine.map(publicListing) });
      return;
    }
    case 'recent': {
      rateLimit(req, 60, 60, 'board-read');
      const questions = await store.listAnswered(12);
      const answers = await store.listAnswers(questions.map((question) => question.id));
      sendJson(res, 200, {
        questions: questions.map((question) => ({ ...publicQuestion(question), answers: answers.filter((answer) => answer.questionId === question.id).map(publicAnswer) })),
      });
      return;
    }
    case 'contact': {
      // A handful a minute is plenty for a person and slow for a scraper.
      rateLimit(req, 12, 4, 'board-contact');
      const id = queryString(req, 'id').trim();
      const type = queryString(req, 'type').trim();
      if (type !== 'offer' && type !== 'listing') throw new ApiError(400, 'type must be offer or listing.', 'bad_type');
      const found = await store.getContact(type, id, new Date());
      if (!found) throw new ApiError(404, 'That post is closed or gone.', 'not_found');
      sendJson(res, 200, found);
      return;
    }
    case 'leaderboard': {
      rateLimit(req, 60, 60, 'board-read');
      sendJson(res, 200, { helpers: leaderboard(await store.listRecentAnswers(3000), new Date(), 10, queryString(req, 'netId').trim().toLowerCase()) });
      return;
    }
    case 'question': {
      rateLimit(req, 60, 60, 'board-read');
      const question = await store.getQuestion(queryString(req, 'id').trim());
      if (!question) throw new ApiError(404, 'No question with that id.', 'not_found');
      sendJson(res, 200, { question: publicQuestion(question), answers: (await store.listAnswers([question.id])).map(publicAnswer) });
      return;
    }
    case 'mine': {
      rateLimit(req, 60, 60, 'board-read');
      const key = validateKey(queryString(req, 'key'));
      const questions = await store.listByAsker(key);
      const answers = await store.listAnswers(questions.map((question) => question.id));
      sendJson(res, 200, {
        questions: questions.map((question) => ({ ...publicQuestion(question), answers: answers.filter((answer) => answer.questionId === question.id).map(publicAnswer) })),
      });
      return;
    }
    case 'profile': {
      rateLimit(req, 10, 10, 'board-profile');
      const draft = validateProfile(body);
      allow('name', draft.name, draft.major);
      const owner = ownerOf(body.key);
      const existing = await store.getProfile(draft.netId);
      if (existing?.ownerKey && existing.ownerKey !== owner) throw new ApiError(403, NETID_TAKEN, 'netid_taken');
      const profile = await store.upsertProfile(draft, owner);
      sendJson(res, 200, { profile: publicProfile(profile) });
      return;
    }
    case 'offer': {
      rateLimit(req, 10, 4, 'board-offer');
      const profile = await requireProfile(store, body.netId, body.key);
      const posterKey = validateKey(body.key);
      const draft = validateOffer(body);
      allow('offer', draft.note);
      const open = (await store.listOffersByPoster(posterKey)).filter((offer) => offer.status === 'open' && offer.currency === draft.currency && Date.parse(offer.expiresAt) > Date.now());
      if (open.length >= 3) throw new ApiError(400, `You already have three open ${CURRENCY_LABELS[draft.currency]} offers.`, 'too_many_offers');
      const offer = await store.createOffer({ ...draft, posterKey, posterNetId: profile.netId, posterName: profile.name, status: 'open' });
      sendJson(res, 200, { offer: publicOffer(offer) });
      return;
    }
    case 'offer_done':
    case 'unoffer': {
      rateLimit(req, 30, 30, 'board-offer');
      const changed = await store.closeOffer(String(body.id ?? ''), validateKey(body.key), op === 'unoffer');
      if (!changed) throw new ApiError(404, 'Only the person who posted an offer can change it.', 'not_found');
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'listing': {
      rateLimit(req, 10, 4, 'board-listing');
      const profile = await requireProfile(store, body.netId, body.key);
      const posterKey = validateKey(body.key);
      const open = (await store.listListingsByPoster(posterKey)).filter((listing) => listing.status === 'open' && Date.parse(listing.expiresAt) > Date.now());
      if (open.length >= 8) throw new ApiError(400, 'You already have eight open posts. Mark one done first.', 'too_many_listings');
      const draft = validateListing(body);
      allow('listing', draft.title, draft.body, draft.place, draft.destination);
      const listing = await store.createListing({ ...draft, posterKey, posterNetId: profile.netId, posterName: profile.name, status: 'open' });
      sendJson(res, 200, { listing: publicListing(listing) });
      return;
    }
    case 'listing_done':
    case 'unlisting': {
      rateLimit(req, 30, 30, 'board-listing');
      const changed = await store.closeListing(String(body.id ?? ''), validateKey(body.key), op === 'unlisting');
      if (!changed) throw new ApiError(404, 'Only the person who posted it can change it.', 'not_found');
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'ask':
      rateLimit(req, 5, 3, 'board-ask');
      sendJson(res, 200, await askQuestion(store, body));
      return;
    case 'next': {
      rateLimit(req, 40, 30, 'board-help');
      const profile = await requireProfile(store, body.netId, body.key);
      const [questions, events] = await Promise.all([store.listOpen(300), store.listEventsByHelper(profile.netId)]);
      const askerKey = typeof body.key === 'string' && /^[a-z0-9-]{8,64}$/i.test(body.key) ? body.key : undefined;
      const question = pickNext(questions, { profile, events, askerKey });
      const remaining = eligibleQuestions(questions, { profile, events, askerKey }).length;
      if (question) {
        await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'view' }), store.bump(question.id, { views: 1 }), store.touchProfile(profile.netId, false)]);
      }
      sendJson(res, 200, { question: question ? publicQuestion(question) : null, remaining, answered: profile.answers });
      return;
    }
    case 'answer': {
      rateLimit(req, 20, 15, 'board-help');
      const profile = await requireProfile(store, body.netId, body.key);
      const question = await store.getQuestion(String(body.questionId ?? ''));
      if (!question || question.status === 'closed') throw new ApiError(404, 'That question is no longer open.', 'not_found');
      const text = validateAnswerText(body.text);
      allow('answer', text);
      const answer = await store.createAnswer({ questionId: question.id, text, helperNetId: profile.netId, helperName: profile.name, helperMajor: profile.major, helperYear: standingFor(profile.classOf) });
      await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'answer' }), store.bump(question.id, { answers: 1 }), store.touchProfile(profile.netId, true)]);
      sendJson(res, 200, { answer: publicAnswer(answer), answered: profile.answers + 1 });
      return;
    }
    case 'skip': {
      rateLimit(req, 60, 60, 'board-help');
      const profile = await requireProfile(store, body.netId, body.key);
      const question = await store.getQuestion(String(body.questionId ?? ''));
      if (question) await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'skip' }), store.bump(question.id, { skips: 1 })]);
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'announce': {
      rateLimit(req, 8, 3, 'board-announce');
      const profile = await requireProfile(store, body.netId, body.key);
      const posterKey = validateKey(body.key);
      const draft = validateAnnouncement(body);
      allow('notice', draft.title, draft.body, draft.location, draft.link);
      const announcement = await store.createAnnouncement({ ...draft, posterKey, posterNetId: profile.netId, posterName: profile.name });
      sendJson(res, 200, { announcement: publicAnnouncement(announcement) });
      return;
    }
    case 'unannounce': {
      rateLimit(req, 20, 20, 'board-announce');
      const removed = await store.deleteAnnouncement(String(body.id ?? ''), validateKey(body.key));
      if (!removed) throw new ApiError(404, 'Only the person who posted it can remove it.', 'not_found');
      sendJson(res, 200, { ok: true });
      return;
    }
    default:
      throw new ApiError(400, 'Unknown board operation.', 'bad_op');
  }
});

/**
 * Refuses a post that the safety screen stops (lib/moderation.ts), with a message that says why. Someone who wrote
 * about hurting themselves gets where to find help instead.
 */
function allow(kind: PostKind, ...parts: Array<string | null | undefined>): void {
  const screened = screenPost(kind, ...parts);
  if (screened) throw new ApiError(422, screened.message, `blocked_${screened.reason}`);
}

const NETID_TAKEN = 'This NetID is already set up in another browser. Use the browser you first signed up in.';

/**
 * A NetID is bound to the browser that set it up: its key, hashed (the key itself also removes that browser's posts,
 * so it is never stored). Without this, anyone could answer, post or trade under any student's NetID.
 */
function ownerOf(key: unknown): string {
  return createHash('sha256').update(`ror-owner:${validateKey(key)}`).digest('hex').slice(0, 40);
}

/** The profile behind a NetID, if this browser may act as it; a profile no browser has claimed yet becomes this one's. */
async function requireProfile(store: BoardStore, netId: unknown, key: unknown): Promise<Profile> {
  const profile = await store.getProfile(validateNetId(netId));
  if (!profile) throw new ApiError(404, 'Add your details first.', 'no_profile');
  const owner = ownerOf(key);
  // Undefined: the database predates the owner column (see upsertProfile), so there is nothing to check against.
  if (profile.ownerKey === null) await store.claimProfile(profile.netId, owner);
  else if (profile.ownerKey !== undefined && profile.ownerKey !== owner) throw new ApiError(403, NETID_TAKEN, 'netid_taken');
  return profile;
}

/** Posts a question; also returns what the archive and the board already know, so nobody waits for an answer they had. */
async function askQuestion(store: BoardStore, body: Body) {
  const text = validateQuestionText(body.text);
  const askerKey = validateKey(body.key);
  const askerName = collapseWhitespace(String(body.name ?? '')).slice(0, 40);
  allow('question', text);
  allow('name', askerName);
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

/** Lists leave the contact out; it is fetched one post at a time (op=contact), so the board cannot be scraped in one call. */
function publicOffer(offer: Offer) {
  const { posterKey: _key, posterNetId: _netId, contact: _contact, ...rest } = offer;
  return rest;
}

function publicListing(listing: Listing) {
  const { posterKey: _key, posterNetId: _netId, contact: _contact, ...rest } = listing;
  return rest;
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
