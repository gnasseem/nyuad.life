/**
 * The student board, the announcements feed and the market, on one route so the function count stays small:
 *   GET  /api/board?op=stats | question&id= | recent | feed[&before=] | mine | announcements | offers | listings | contact&type=offer|listing&id= | leaderboard
 *   (the browser key and NetID travel in the x-ror-key and x-ror-netid headers; older clients put the key in &key=)
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
  validateReview,
  type Announcement,
  type Answer,
  type CourseReview,
  type Listing,
  type Offer,
  type Profile,
  type Question,
} from '../lib/board.ts';
import { boardStore, type BoardStore } from '../lib/board-store.ts';
import { loadCatalog } from '../lib/courses.ts';
import { detectRedirect } from '../lib/domains.ts';
import { normalizeCode } from '../lib/html.ts';
import { embedderForIndex } from '../lib/embeddings.ts';
import { geminiConfig } from '../lib/gemini.ts';
import { ApiError, clientIp, clientKey, queryString, rateLimit, readJson, route, sendJson, type ApiRequest } from '../lib/http.ts';
import { accountKey, clearEmailSession, emailNetId, emailSession, otpDigest, requireEmailSession, sendLoginCode, setEmailSession } from '../lib/auth.ts';
import { claimedIdentity, limitDurably, NETID_TAKEN, ownerOf, requireMember, requireProfile } from '../lib/identity.ts';
import { reviewPost, screenPost, type PostKind, type ReviewedKind } from '../lib/moderation.ts';
import { providersFromEnv, warmModels } from '../lib/providers.ts';
import { retrieve } from '../lib/rag.ts';
import { loadArchive, summarizePost } from '../lib/store.ts';
import { collapseWhitespace } from '../lib/text.ts';

type Body = Record<string, unknown>;

export default route(['GET', 'POST'], async (req, res) => {
  const store = boardStore();
  if (!store) throw new ApiError(503, 'The board is not set up on this server.', 'board_unavailable');
  const body: Body = req.method === 'POST' ? await readJson<Body>(req) : {};
  const op = String(req.method === 'POST' ? body.op ?? '' : queryString(req, 'op')).trim();
  if (['auth_send', 'auth_verify', 'auth_logout'].includes(op) && req.method !== 'POST') throw new ApiError(405, 'Use POST for login operations.', 'method_not_allowed');
  if (op === 'auth_send') {
    rateLimit(req, 10, 2, 'email-send');
    const netId = emailNetId(body.email);
    // Codes are limited per NetID in the database; these keep a script cycling made-up NetIDs from spending the
    // site's email quota (and its sender reputation) for everyone.
    await limitDurably(store, `send-ip:${clientKey(clientIp(req))}`, 30, 3_600, 'Too many login codes from this network. Try again in an hour.');
    await limitDurably(store, 'send-all', 600, 86_400, 'Login emails are paused for today. Try again tomorrow.');
    await sendLoginCode(store, netId);
    sendJson(res, 200, { email: `${netId}@nyu.edu` });
    return;
  }
  if (op === 'auth_verify') {
    rateLimit(req, 15, 5, 'email-verify');
    const netId = emailNetId(body.email);
    const code = String(body.code ?? '').trim();
    if (!/^\d{6}$/.test(code) || !await store.consumeOtp(netId, otpDigest(netId, code))) throw new ApiError(400, 'That code is incorrect or expired. Request a new code after five tries.', 'bad_otp');
    if (await store.isBanned(netId)) throw new ApiError(403, 'This account can no longer use the site.', 'banned');
    const key = accountKey(netId);
    await store.rebindProfile(netId, ownerOf(key), key);
    const profile = await store.getProfile(netId);
    setEmailSession(req, res, netId);
    sendJson(res, 200, { netId, key, profile: profile ? publicProfile(profile) : null });
    return;
  }
  if (op === 'auth_me') {
    const session = emailSession(req);
    const profile = session && !await store.isBanned(session.netId) ? await store.getProfile(session.netId) : null;
    sendJson(res, 200, { netId: session?.netId ?? '', key: profile ? session!.key : '', profile: profile ? publicProfile(profile) : null });
    return;
  }
  if (op === 'auth_logout') {
    clearEmailSession(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }
  const publicReads = ['stats', 'announcements', 'offers', 'listings', 'recent', 'feed', 'leaderboard', 'question', 'reviews'];
  if (req.method === 'POST' || !publicReads.includes(op)) {
    const session = requireEmailSession(req);
    if (body.netId && body.netId !== session.netId) throw new ApiError(403, 'Use the account you logged in with.', 'identity_mismatch');
    body.netId = session.netId;
    body.key = session.key;
  }
  // Ownership comes from the verified session, including on another device.
  const headerKey = emailSession(req)?.key ?? '';

  switch (op) {
    case 'stats':
      rateLimit(req, 60, 60, 'board-read');
      sendJson(res, 200, await boardStats(store));
      return;
    case 'announcements':
      rateLimit(req, 60, 60, 'board-read');
      sendJson(res, 200, { announcements: (await store.listAnnouncements(new Date())).map(publicAnnouncement) });
      return;
    case 'offers': {
      rateLimit(req, 60, 60, 'board-read');
      const key = headerKey;
      const open = await store.listOffers(new Date());
      const mine = key && /^[a-z0-9-]{8,64}$/i.test(key) ? await store.listOffersByPoster(key) : [];
      // `market` is the Falcon book, which clients from before Campus Dirhams read; `markets` has both.
      sendJson(res, 200, { offers: open.map(publicOffer), mine: mine.map(publicOffer), market: summarizeMarket(open, 'falcon'), markets: { falcon: summarizeMarket(open, 'falcon'), campus: summarizeMarket(open, 'campus') } });
      return;
    }
    case 'listings': {
      rateLimit(req, 60, 60, 'board-read');
      const key = headerKey;
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
    case 'feed': {
      rateLimit(req, 60, 60, 'board-read');
      const before = queryString(req, 'before').trim();
      const page = await store.listFeed(FEED_PAGE, before || undefined);
      const pending = before ? [] : await store.listOpen(300);
      const questions = [...new Map([...pending, ...page].map((entry) => [entry.id, entry])).values()];
      const me = emailSession(req)?.netId;
      const [answers, events] = await Promise.all([store.listAnswers(questions.map((question) => question.id)), me ? store.listEventsByHelper(me) : Promise.resolve([])]);
      const key = /^[a-z0-9-]{8,64}$/i.test(headerKey) ? headerKey : '';
      // What this student already did with each question, so the feed and the home page stop offering it to them.
      const byMe = new Map<string, 'answer' | 'skip'>();
      for (const event of events) if (event.kind !== 'view' && byMe.get(event.questionId) !== 'answer') byMe.set(event.questionId, event.kind);
      sendJson(res, 200, {
        questions: questions.map((question) => ({ ...publicQuestion(question), mine: Boolean(key) && question.askerKey === key, byMe: byMe.get(question.id), answers: answers.filter((answer) => answer.questionId === question.id).map(publicAnswer) })),
        more: page.length === FEED_PAGE,
        next: page.at(-1)?.createdAt ?? null,
      });
      return;
    }
    case 'contact': {
      // A handful a minute is plenty for a person and slow for a scraper; and only members see contacts at all.
      rateLimit(req, 12, 4, 'board-contact');
      const viewer = await requireMember(req, store);
      // Contacts are read one at a time and only by members; this keeps one account from collecting all of them.
      if (viewer) await limitDurably(store, `contact:${viewer.netId}`, 60, 86_400, 'You have opened a lot of contacts today. Try again tomorrow.');
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
      // "You" is only marked for the NetID this browser owns: marking any NetID asked about would let anyone find which
      // NetID belongs to which name on the board.
      const me = await ownNetId(store, req);
      sendJson(res, 200, { helpers: leaderboard(await recentAnswers(store), new Date(), 10, me) });
      return;
    }
    case 'question': {
      rateLimit(req, 60, 60, 'board-read');
      const question = await store.getQuestion(queryString(req, 'id').trim());
      if (!question) throw new ApiError(404, 'No question with that id.', 'not_found');
      sendJson(res, 200, { question: publicQuestion(question), answers: (await store.listAnswers([question.id])).map(publicAnswer) });
      return;
    }
    case 'reviews': {
      rateLimit(req, 60, 60, 'board-read');
      const code = courseCode(queryString(req, 'code'));
      const me = emailSession(req)?.netId;
      // Until supabase/schema.sql has been run again there is no reviews table: the course page shows none yet.
      let open = true;
      const reviews = await store.listReviews(code).catch((error: unknown) => {
        if (!(error instanceof ApiError) || error.code !== 'board_schema_missing') throw error;
        open = false;
        return [];
      });
      sendJson(res, 200, { reviews: reviews.map((entry) => publicReview(entry, me)), open });
      return;
    }
    case 'review': {
      rateLimit(req, 10, 4, 'board-review');
      const profile = await requireProfile(store, body.netId, body.key);
      const code = courseCode(body.code);
      const draft = validateReview(body);
      allow('review', draft.text);
      if (draft.text) await review('review', `Course: ${code}`, `Rating: ${draft.rating} of 5`, `Review: ${draft.text}`);
      const saved = await store.upsertReview({ ...draft, code, netId: profile.netId, authorName: profile.name.split(' ')[0] ?? profile.name, authorMajor: profile.major, authorYear: standingFor(profile.classOf) }).catch((error: unknown) => {
        if (error instanceof ApiError && error.code === 'board_schema_missing') throw new ApiError(503, 'Course reviews are not open yet. Try again soon.', 'reviews_unavailable');
        throw error;
      });
      sendJson(res, 200, { review: publicReview(saved, profile.netId) });
      return;
    }
    case 'unreview': {
      rateLimit(req, 10, 4, 'board-review');
      const profile = await requireProfile(store, body.netId, body.key);
      if (!await store.deleteReview(courseCode(body.code), profile.netId)) throw new ApiError(404, 'You have not reviewed this course.', 'not_found');
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'mine': {
      rateLimit(req, 60, 60, 'board-read');
      const key = validateKey(headerKey);
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
      if (await store.isBanned(draft.netId)) throw new ApiError(403, 'This account can no longer use the site.', 'banned');
      allow('name', draft.name, draft.major);
      const owner = ownerOf(body.key);
      const existing = await store.getProfile(draft.netId);
      if (existing?.ownerKey && existing.ownerKey !== owner) throw new ApiError(403, NETID_TAKEN, 'netid_taken');
      const profile = await store.upsertProfile(draft, owner);
      sendJson(res, 200, { profile: publicProfile(profile) });
      return;
    }
    case 'delete_profile': {
      rateLimit(req, 5, 2, 'board-profile');
      const profile = await requireProfile(store, body.netId, body.key);
      const key = validateKey(body.key);
      if (!await store.deleteProfile(profile.netId, ownerOf(key), key)) throw new ApiError(403, NETID_TAKEN, 'netid_taken');
      clearEmailSession(req, res);
      sendJson(res, 200, { ok: true });
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
      await review('offer', `Currency: ${draft.currency}`, `Side: ${draft.side}`, `Amount: ${draft.amount}`, `Rate: ${draft.rate} AED per unit`, `Note: ${draft.note}`);
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
      await review('listing', `Kind: ${draft.kind}`, `Title: ${draft.title}`, draft.price !== null ? `Price: ${draft.price} AED` : '', draft.place ? `${draft.kind === 'ride' ? 'From' : 'Place'}: ${draft.place}` : '', draft.destination ? `To: ${draft.destination}` : '', draft.happensAt ? `When: ${localTime(draft.happensAt)}` : '', draft.body ? `Details: ${draft.body}` : '');
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
    case 'ask': {
      rateLimit(req, 5, 3, 'board-ask');
      const asker = await requireMember(req, store);
      // The name shown is the asker's own first name or none, never whatever the request says.
      body.name = body.name && asker ? asker.name.split(' ')[0] : '';
      sendJson(res, 200, await askQuestion(store, body));
      return;
    }
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
      if (question.askerKey === body.key) throw new ApiError(400, "You can't answer your own question. Others will see it in the feed.", 'own_question');
      const events = await store.listEventsByHelper(profile.netId);
      if (events.some((event) => event.questionId === question.id && event.kind === 'answer')) throw new ApiError(400, 'You already answered this one.', 'already_answered');
      const text = validateAnswerText(body.text);
      allow('answer', text);
      await review('answer', `Question: ${question.text}`, `Answer: ${text}`);
      const answer = await store.createAnswer({ questionId: question.id, text, helperNetId: profile.netId, helperName: profile.name, helperMajor: profile.major, helperYear: standingFor(profile.classOf) });
      await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'answer' }), store.bump(question.id, { answers: 1 }), store.touchProfile(profile.netId, true)]);
      answersMemo = null;
      statsMemo = null;
      sendJson(res, 200, { answer: publicAnswer(answer), answered: profile.answers + 1 });
      return;
    }
    case 'skip': {
      rateLimit(req, 60, 60, 'board-help');
      const profile = await requireProfile(store, body.netId, body.key);
      const question = await store.getQuestion(String(body.questionId ?? ''));
      // One skip per person and question counts, so nobody can bury a question by skipping it over and over.
      const skipped = question ? (await store.listEventsByHelper(profile.netId)).some((event) => event.questionId === question.id && event.kind === 'skip') : true;
      if (question && !skipped) await Promise.all([store.recordEvent({ questionId: question.id, netId: profile.netId, kind: 'skip' }), store.bump(question.id, { skips: 1 })]);
      sendJson(res, 200, { ok: true });
      return;
    }
    case 'announce': {
      rateLimit(req, 8, 3, 'board-announce');
      const profile = await requireProfile(store, body.netId, body.key);
      const posterKey = validateKey(body.key);
      const draft = validateAnnouncement(body);
      allow('notice', draft.title, draft.body, draft.location, draft.link);
      await review('notice', `Kind: ${draft.kind}`, `Title: ${draft.title}`, draft.startsAt ? `When: ${localTime(draft.startsAt)}` : '', draft.location ? `Where: ${draft.location}` : '', draft.link ? `Link: ${draft.link}` : '', draft.body ? `Details: ${draft.body}` : '');
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

/** The model's read of a post the rules let through (lib/moderation.ts); refuses it the same way. */
async function review(kind: ReviewedKind, ...parts: Array<string | null | undefined>): Promise<void> {
  await warmModels(1_500);
  const screened = await reviewPost({ gemini: geminiConfig(), backups: providersFromEnv() }, kind, ...parts);
  if (screened) throw new ApiError(screened.reason === 'unreviewed' ? 503 : 422, screened.message, `blocked_${screened.reason}`);
}

const FEED_PAGE = 30;

/** The leaderboard and the counts change slowly and are read on every visit: each instance keeps them a minute. */
let answersMemo: { at: number; answers: Promise<Answer[]> } | null = null;
let statsMemo: { at: number; stats: ReturnType<BoardStore['stats']> } | null = null;
const MEMO_MS = 60_000;

function recentAnswers(store: BoardStore): Promise<Answer[]> {
  if (!answersMemo || Date.now() - answersMemo.at > MEMO_MS) {
    answersMemo = { at: Date.now(), answers: store.listRecentAnswers(3000) };
    answersMemo.answers.catch(() => (answersMemo = null));
  }
  return answersMemo.answers;
}

function boardStats(store: BoardStore): ReturnType<BoardStore['stats']> {
  if (!statsMemo || Date.now() - statsMemo.at > MEMO_MS) {
    statsMemo = { at: Date.now(), stats: store.stats() };
    statsMemo.stats.catch(() => (statsMemo = null));
  }
  return statsMemo.stats;
}

/** A time as students on campus read it, for the reviewer to judge whether it makes sense. */
function localTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** The NetID this browser has set up, judged by its headers; empty when it has none or the headers do not hold up. */
async function ownNetId(store: BoardStore, req: ApiRequest): Promise<string> {
  const { netId, key } = claimedIdentity(req);
  if (!netId || !key) return '';
  try {
    return (await requireProfile(store, netId, key)).netId;
  } catch {
    return '';
  }
}

/** Posts a question; also returns what the archive and the board already know, so nobody waits for an answer they had. */
async function askQuestion(store: BoardStore, body: Body) {
  const text = validateQuestionText(body.text);
  const askerKey = validateKey(body.key);
  const askerName = collapseWhitespace(String(body.name ?? '')).slice(0, 40);
  allow('question', text);
  allow('name', askerName);
  await review('question', text);
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

function publicReview(entry: CourseReview, me?: string) {
  const { netId, ...rest } = entry;
  return { ...rest, mine: Boolean(me) && netId === me };
}

/** A course code from the request, refused unless Albert lists it, so reviews cannot pile up under made-up codes. */
function courseCode(value: unknown): string {
  const code = normalizeCode(String(value ?? ''));
  if (!code || !loadCatalog().byCode.has(code)) throw new ApiError(404, 'No course with that code.', 'not_found');
  return code;
}

function publicAnnouncement(announcement: Announcement) {
  const { posterKey: _key, posterNetId: _netId, ...rest } = announcement;
  return rest;
}
