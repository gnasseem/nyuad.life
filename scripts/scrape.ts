/**
 * Walks the Room of Requirement Facebook group with YOUR logged-in browser and saves every post and comment
 * to data/posts.jsonl. Runs on your laptop, never on the server.
 *
 *   npm run scrape                      newest posts until it meets posts it already has (incremental)
 *   npm run scrape -- --full            walk back to the very first post of the group (resumes where it stopped)
 *   npm run scrape -- --login           only open the window so you can log in, then exit
 *   npm run scrape -- --max-posts 300   stop after 300 new or updated posts
 *   npm run scrape -- --only-comments   only fetch missing comments for posts already saved
 *   npm run scrape -- --no-comments     feed only, do not open threads
 *   npm run scrape -- --restart-feed    with --full: ignore the saved position and start again from the newest post
 *   npm run scrape -- --chrome          drive your installed Google Chrome instead of Playwright's Chromium
 *   npm run scrape -- --delay 2         double every wait (gentler on Facebook)
 *   npm run scrape -- --headless        no window (only after you logged in once with a window; Facebook may refuse)
 *   npm run scrape -- --debug           save raw responses to .scraper-debug/
 *
 * How it works: the scraper reads the JSON Facebook's own web client loads, so it does not depend on page
 * selectors. After the first scroll it has seen the exact request the client uses for "more posts", and from
 * then on it asks for the next page itself, cursor by cursor. That is fast and does not degrade as the page
 * grows the way scrolling does; if it ever fails, scrolling is the fallback. Comments are collected by opening
 * each thread and expanding it. Progress is saved regularly and on Ctrl+C, and the next run resumes.
 *
 * First run: a Chromium window opens on facebook.com. Log in there; the profile is kept in .scraper-profile/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'playwright';
import { loadDotEnv } from '../lib/env.ts';
import {
  embeddedJsonFromHtml,
  extractComments,
  extractFeedPageInfo,
  extractStories,
  graphqlErrors,
  isFeedPaginationRequest,
  parseGraphqlForm,
  parseJsonDocuments,
  toSourcePosts,
  withGraphqlVariables,
  type CommentRecord,
  type PageInfo,
  type StoryRecord,
} from '../lib/facebook.ts';
import { mergePosts, readPostsJsonl, sortNewestFirst, writePostsJsonl } from '../lib/posts.ts';
import { postsFile } from '../lib/store.ts';
import type { SourcePost } from '../lib/types.ts';

loadDotEnv();

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
};

const GROUP_URL = value('group', process.env.ROR_GROUP_URL ?? 'https://www.facebook.com/groups/nyuad.room.of.requirement').replace(/\/$/, '');
const GROUP_SLUG = /\/groups\/([^/?#]+)/.exec(GROUP_URL)?.[1] ?? '';
const GROUP_PATH = `/groups/${GROUP_SLUG}`;
const GROUP_ORIGIN = (() => {
  try {
    return new URL(GROUP_URL).origin;
  } catch {
    return 'https://www.facebook.com';
  }
})();
const FEED_URL = `${GROUP_URL}?sorting_setting=CHRONOLOGICAL`;
const PROFILE_DIR = path.resolve(process.env.ROR_BROWSER_PROFILE ?? '.scraper-profile');
/** Optional path to a Chrome/Chromium binary (ROR_BROWSER_EXECUTABLE), for machines where Playwright's download is not usable. */
const BROWSER_EXECUTABLE = process.env.ROR_BROWSER_EXECUTABLE || undefined;
const STATE_FILE = path.join(path.dirname(postsFile()), 'scrape-state.json');
const DEBUG_DIR = path.resolve('.scraper-debug');
const FULL = flag('full');
const LOGIN_ONLY = flag('login');
const HEADLESS = flag('headless');
const CHROME = flag('chrome');
const DEBUG = flag('debug');
const RESTART_FEED = flag('restart-feed');
const FETCH_COMMENTS = !flag('no-comments');
const ONLY_COMMENTS = flag('only-comments');
const MAX_POSTS = Number(value('max-posts', '0')) || Infinity;
const STOP_AFTER_KNOWN = Number(value('stop-after-known', '40')) || 40;
const DELAY = Number(value('delay', process.env.ROR_SCRAPE_DELAY ?? '1')) || 1;
const LOGIN_MINUTES = HEADLESS ? 1.5 : 30;
const LOGIN_FORM = 'input[name="email"], input[name="pass"], form[action*="login"], [data-testid="royal_login_form"]';

interface State {
  pendingComments: string[];
  completedFeed: boolean;
  lastRun: string;
  /** Where an interrupted --full walk continues from, and how old the posts were at that point. */
  feedCursor?: string;
  feedCursorOldest?: string;
  /** How often each thread was opened for comments; threads that still look incomplete after two visits are left alone. */
  commentTries?: Record<string, number>;
}

/** The request Facebook's client used to load more posts, replayed with new cursors. Lives in memory only (it holds session tokens). */
interface FeedTemplate {
  url: string;
  body: string;
  headers: Record<string, string>;
  friendlyName: string;
}

if (!GROUP_SLUG) {
  console.error(`Could not read a group slug from ${GROUP_URL}.`);
  process.exit(1);
}

const stories = new Map<string, StoryRecord>();
const comments = new Map<string, CommentRecord>();
const feedCapture: { template: FeedTemplate | null; nextCursor: string | null; version: number } = { template: null, nextCursor: null, version: 0 };
let currentPostId = '';
let responseCounter = 0;
let stopping = false;
let browserGone = false;

function log(message: string): void {
  console.log(`[scrape ${new Date().toLocaleTimeString('en-GB')}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function polite(baseMs: number): Promise<void> {
  return sleep(baseMs * DELAY + Math.random() * baseMs * 0.6 * DELAY);
}

const noop = (): void => {};

/* ---------- Ingesting Facebook's JSON ---------- */

function ingest(docs: unknown[], origin: string): { stories: number; comments: number } {
  let newStories = 0;
  let newComments = 0;
  for (const doc of docs) {
    for (const story of extractStories(doc, { groupPath: GROUP_PATH })) {
      const existing = stories.get(story.id);
      if (!existing) newStories++;
      stories.set(story.id, existing ? mergeStories(existing, story) : story);
    }
    for (const comment of extractComments(doc)) {
      if (!comment.postId && currentPostId) comment.postId = currentPostId;
      if (!comments.has(comment.id)) {
        comments.set(comment.id, comment);
        newComments++;
      }
    }
  }
  if (DEBUG && docs.length) {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const name = origin.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'response';
    writeFileSync(path.join(DEBUG_DIR, `${String(++responseCounter).padStart(5, '0')}-${name}.json`), JSON.stringify(docs, null, 1));
  }
  return { stories: newStories, comments: newComments };
}

function mergeStories(a: StoryRecord, b: StoryRecord): StoryRecord {
  return {
    id: a.id,
    url: a.url || b.url,
    author: a.author || b.author,
    date: a.date || b.date,
    text: b.text.length > a.text.length ? b.text : a.text,
    reactions: Math.max(a.reactions ?? 0, b.reactions ?? 0) || (a.reactions ?? b.reactions),
    commentCount: Math.max(a.commentCount ?? 0, b.commentCount ?? 0) || (a.commentCount ?? b.commentCount),
  };
}

function attachResponseListener(context: BrowserContext): void {
  context.on('response', (response) => {
    void handleResponse(response);
  });
}

async function handleResponse(response: Response): Promise<void> {
  if (!response.url().includes('/api/graphql')) return;
  const request = response.request();
  let requestHeaders: Record<string, string> = {};
  try {
    requestHeaders = await request.allHeaders();
  } catch {
    requestHeaders = request.headers();
  }
  if (requestHeaders['x-ror-replay']) return; // our own page fetches are ingested by the replay loop
  let body: string;
  try {
    body = await response.text();
  } catch {
    return; // body already gone (navigation); nothing to do
  }
  const docs = parseJsonDocuments(body);
  const parsed = request.method() === 'POST' ? parseGraphqlForm(request.postData()) : null;
  ingest(docs, parsed?.friendlyName || 'graphql');
  if (!parsed || !isFeedPaginationRequest(parsed)) return;

  const current = feedCapture.template;
  const better = !current || (/RegularStories/i.test(parsed.friendlyName) && !/RegularStories/i.test(current.friendlyName)) || current.friendlyName === parsed.friendlyName;
  if (!better) return;
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(requestHeaders)) {
    const lower = key.toLowerCase();
    if (lower === 'content-type' || lower.startsWith('x-fb-') || lower === 'x-asbd-id') headers[lower] = headerValue;
  }
  feedCapture.template = { url: response.url(), body: request.postData() ?? '', headers, friendlyName: parsed.friendlyName };
  feedCapture.version++;
  const info = extractFeedPageInfo(docs);
  // Continue after the page the client just loaded; if that load failed, start from the page it was asking for.
  if (info) feedCapture.nextCursor = info.hasNextPage ? info.endCursor || null : null;
  else if (typeof parsed.variables.cursor === 'string') feedCapture.nextCursor = parsed.variables.cursor;
  if (DEBUG) log(`Captured the feed request (${parsed.friendlyName}).`);
}

async function ingestPage(page: Page): Promise<void> {
  try {
    ingest(embeddedJsonFromHtml(await page.content()), 'page');
  } catch {
    // Page navigated away mid-read.
  }
}

/* ---------- Browser plumbing that never throws on a navigation or a closed tab ---------- */

async function launchBrowser(): Promise<BrowserContext> {
  const options = {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    locale: 'en-GB',
    args: ['--disable-blink-features=AutomationControlled'],
    executablePath: BROWSER_EXECUTABLE,
  };
  if (CHROME) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel: 'chrome' });
    } catch (error) {
      log(`Could not start Google Chrome (${(error as Error).message.split('\n')[0]}); using Playwright's Chromium instead.`);
    }
  }
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, options);
  } catch (error) {
    const message = (error as Error).message;
    if (/Executable doesn't exist|install/i.test(message)) {
      throw new Error("Playwright's Chromium is not installed. Run `npx playwright install chromium` once, then try again.");
    }
    if (/ProcessSingleton|profile.*in use|already running/i.test(message)) {
      throw new Error(`Another browser is already using ${PROFILE_DIR}. Close it (or wait for the other scrape to finish) and try again.`);
    }
    throw error;
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

async function gotoSafe(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    return true;
  } catch (error) {
    if (DEBUG) log(`Navigation to ${url} did not finish: ${(error as Error).message.split('\n')[0]}`);
    return false;
  }
}

async function countSafe(page: Page, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return -1; // mid-navigation; ask again later
  }
}

/** The tab to keep working in: the given one, another open Facebook tab, or a fresh one. */
async function livePage(context: BrowserContext, page: Page): Promise<Page> {
  if (!page.isClosed()) return page;
  const open = context.pages().filter((candidate) => !candidate.isClosed());
  const next = open.find((candidate) => candidate.url().includes('facebook.com')) ?? open.at(-1);
  if (next) {
    log('Continuing in another tab.');
    return next;
  }
  try {
    log('The tab was closed; opening a new one.');
    return await context.newPage();
  } catch {
    browserGone = true;
    stopping = true;
    throw new Error('The browser window was closed. Run the command again; your login is kept in .scraper-profile/.');
  }
}

async function hasSession(context: BrowserContext): Promise<boolean> {
  try {
    const cookies = await context.cookies([...new Set([GROUP_ORIGIN, 'https://www.facebook.com', 'https://web.facebook.com', 'https://m.facebook.com'])]);
    return cookies.some((cookie) => cookie.name === 'c_user' && cookie.value !== '');
  } catch {
    return false;
  }
}

/**
 * Waits until the browser is logged in and showing the group. Nothing in here can throw because of a page
 * navigation: the login flow moves through several pages (password, code, "save this browser?") and every
 * one of those used to be able to end the run, which closed the window right after clicking "Log in".
 */
async function ensureLoggedIn(context: BrowserContext, page: Page): Promise<Page> {
  page = await livePage(context, page);
  await gotoSafe(page, GROUP_URL);
  const deadline = Date.now() + LOGIN_MINUTES * 60_000;
  let announced = false;
  let lastNudge = 0;
  while (Date.now() < deadline) {
    if (stopping) throw new Error(browserGone ? 'The browser window was closed before the login finished. Run the command again and log in in the window it opens.' : 'Stopped before the login finished.');
    page = await livePage(context, page);
    const session = await hasSession(context);
    const url = safeUrl(page);
    const onGroup = url.includes(GROUP_PATH);
    const wall = session && onGroup ? await countSafe(page, LOGIN_FORM) : -1;
    if (session && onGroup && wall === 0) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(noop);
      return page;
    }
    if (!announced) {
      announced = true;
      if (HEADLESS && !session) log('Not logged in, and there is no window to log in with. Run once without --headless and sign in to Facebook in the window that opens.');
      else if (!session) {
        log(`Please log in to Facebook in the browser window. The scraper waits here (up to ${LOGIN_MINUTES} minutes) and carries on by itself once you are in.`);
        log('If Facebook asks for a code or whether to save the browser, just finish those steps. Press Ctrl+C to quit.');
      } else log('Logged in; opening the group…');
    }
    // "Save your login info?" (login/save-device) is safe to skip; every other login page needs the user.
    const inAuthFlow = /\/checkpoint|\/recover|\/two_step|\/confirm|\/auth/.test(url) || (/\/login/.test(url) && !/save-device/.test(url));
    const now = Date.now();
    if (session && !inAuthFlow && !onGroup && now - lastNudge > 8_000) {
      lastNudge = now;
      await gotoSafe(page, GROUP_URL);
    } else if (session && onGroup && wall > 0 && now - lastNudge > 25_000) {
      lastNudge = now;
      await gotoSafe(page, GROUP_URL);
    }
    await sleep(2_000);
  }
  if (HEADLESS) process.exitCode = 2;
  throw new Error(`Waited ${LOGIN_MINUTES} minutes for a Facebook login. Run the command again${HEADLESS ? ' without --headless' : ' when you are ready'}.`);
}

/* ---------- State on disk ---------- */

function loadState(): State {
  if (existsSync(STATE_FILE)) {
    try {
      return { pendingComments: [], completedFeed: false, lastRun: '', ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<State>) };
    } catch {
      // corrupt state, start over
    }
  }
  return { pendingComments: [], completedFeed: false, lastRun: '' };
}

function saveState(state: State): void {
  state.lastRun = new Date().toISOString();
  state.pendingComments = [...new Set(state.pendingComments)];
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function needsComments(post: SourcePost): boolean {
  return (post.commentCount ?? 0) > post.comments.length;
}

/* ---------- The feed walk ---------- */

/** Bookkeeping shared by the cursor walk and the scrolling fallback: which stories are new, and when the feed is "up to date". */
class StoryTracker {
  readonly seen = new Set<string>();
  consecutiveKnown = 0;
  collected = 0;
  oldestDate = '';

  constructor(
    private readonly known: Map<string, SourcePost>,
    private readonly state: State,
  ) {}

  get knownCount(): number {
    return this.known.size;
  }

  /** Looks at stories ingested since the last call. Returns how many were new to this run. */
  absorb(): number {
    let fresh = 0;
    for (const story of stories.values()) {
      if (this.seen.has(story.id)) continue;
      this.seen.add(story.id);
      fresh++;
      if (story.date && (!this.oldestDate || story.date < this.oldestDate)) this.oldestDate = story.date;
      const existing = this.known.get(story.id);
      const unchanged = existing && !needsComments(existing) && (story.commentCount ?? 0) <= existing.comments.length && existing.text.length >= story.text.length;
      if (unchanged) {
        this.consecutiveKnown++;
      } else {
        this.consecutiveKnown = 0;
        this.collected++;
        if ((story.commentCount ?? 0) > 0) this.state.pendingComments.push(story.id);
      }
    }
    return fresh;
  }

  progress(): string {
    return `${stories.size} posts seen, ${this.collected} new or changed${this.oldestDate ? `, oldest so far ${this.oldestDate}` : ''}.`;
  }
}

type WalkOutcome = 'end' | 'done' | 'stopped' | 'fallback';

interface WalkContext {
  context: BrowserContext;
  page: Page;
  tracker: StoryTracker;
  state: State;
  persist(): Promise<number>;
}

async function walkFeed(walk: WalkContext): Promise<void> {
  const { tracker, state } = walk;
  await gotoSafe(walk.page, FEED_URL);
  await polite(3000);
  await ingestPage(walk.page);
  tracker.absorb();

  const template = await captureTemplate(walk, 10);
  if (stories.size === 0) {
    log(`No posts are visible at ${FEED_URL}. Are you a member of the group? Open it in the window to check, then run again.`);
    return;
  }
  if (!template) {
    log('Could not see how Facebook loads more posts; scrolling instead.');
    await scrollWalk(walk, !FULL);
    return;
  }

  const resume = FULL && !RESTART_FEED && state.feedCursor && tracker.knownCount > 0 ? state.feedCursor : null;
  if (resume) log(`A previous --full run stopped at posts older than ${state.feedCursorOldest || 'unknown'}. Picking up new posts first, then continuing from there (use --restart-feed to start over).`);
  else if (FULL) log('Walking the whole group, newest first. This takes a while; leave it running. Ctrl+C saves progress and the next --full run continues from the same spot.');
  else log(`Collecting new posts until ${STOP_AFTER_KNOWN} already-saved posts in a row.`);

  const first = await cursorWalk(walk, template, { cursor: feedCapture.nextCursor, stopOnKnown: !FULL || Boolean(resume), trackCursor: FULL && !resume });
  if (first === 'fallback') {
    await scrollWalk(walk, !FULL);
    return;
  }
  if (resume && first !== 'stopped' && tracker.collected < MAX_POSTS && !stopping) {
    const fresh = feedCapture.template ?? template;
    log(`Continuing the full walk from posts older than ${state.feedCursorOldest || 'unknown'}.`);
    const second = await cursorWalk(walk, fresh, { cursor: resume, stopOnKnown: false, trackCursor: true });
    if (second === 'fallback') log('Could not continue from the saved position. Run again with --full --restart-feed to walk from the newest post.');
  }
}

/** Scrolls the feed a little until Facebook's client reveals the request it uses to load more posts. */
async function captureTemplate(walk: WalkContext, maxScrolls: number): Promise<FeedTemplate | null> {
  for (let i = 0; i < maxScrolls && !stopping && !feedCapture.template; i++) {
    await scrollDown(walk.page);
    await polite(1800);
    walk.tracker.absorb();
  }
  return feedCapture.template;
}

async function scrollDown(page: Page): Promise<void> {
  await page.mouse.wheel(0, 2500).catch(noop);
  await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)').catch(noop);
}

interface CursorOptions {
  cursor: string | null;
  stopOnKnown: boolean;
  /** Remember the position in the state file so an interrupted --full run resumes. */
  trackCursor: boolean;
}

async function cursorWalk(walk: WalkContext, template: FeedTemplate, options: CursorOptions): Promise<WalkOutcome> {
  const { tracker, state } = walk;
  let cursor = options.cursor;
  let failures = 0;
  let recaptures = 0;
  let emptyPages = 0;
  let pages = 0;
  let largerPages = true;
  let lastSave = Date.now();

  const finish = (outcome: WalkOutcome, reason: string): WalkOutcome => {
    log(`${reason} ${tracker.progress()}`);
    return outcome;
  };

  while (!stopping) {
    if (!cursor) {
      if (options.trackCursor) {
        state.completedFeed = true;
        delete state.feedCursor;
        delete state.feedCursorOldest;
      }
      return finish('end', 'Reached the first post of the group.');
    }
    walk.page = await livePage(walk.context, walk.page);
    const result = await fetchFeedPage(walk.page, template, cursor, largerPages);
    if (!result.ok) {
      if (largerPages && pages === 0) {
        largerPages = false; // maybe Facebook did not like the bigger page size; try the client's own
        continue;
      }
      failures++;
      if (/logged out|login/i.test(result.error) || !(await hasSession(walk.context))) {
        log('Facebook logged the browser out. Log in again in the window to continue.');
        walk.page = await ensureLoggedIn(walk.context, walk.page);
      }
      if (failures <= 4) {
        const wait = [5, 15, 45, 120][failures - 1]! * DELAY;
        log(`Loading more posts failed (${result.error}). Retrying in ${Math.round(wait)}s (${failures}/4).`);
        await sleep(wait * 1000);
        continue;
      }
      if (recaptures >= 2) return finish('fallback', 'Facebook keeps refusing to page the feed.');
      recaptures++;
      log('Reloading the group to pick up a fresh session token…');
      const fresh = await recaptureTemplate(walk);
      if (!fresh) return finish('fallback', 'Could not capture the feed request again.');
      template = fresh;
      failures = 0;
      continue;
    }

    failures = 0;
    pages++;
    const before = stories.size;
    ingest(result.docs, 'feed-page');
    const added = stories.size - before;
    tracker.absorb();
    emptyPages = added === 0 ? emptyPages + 1 : 0;

    if (!result.pageInfo) {
      failures++;
      if (failures > 3) return finish('fallback', 'Facebook stopped sending page cursors.');
      await sleep(5000);
      continue;
    }
    cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor || null : null;
    if (options.trackCursor && cursor) {
      state.feedCursor = cursor;
      state.feedCursorOldest = tracker.oldestDate;
    }
    if (options.stopOnKnown && tracker.consecutiveKnown >= STOP_AFTER_KNOWN) return finish('done', `Reached ${tracker.consecutiveKnown} known posts in a row; the feed is up to date.`);
    if (tracker.collected >= MAX_POSTS) return finish('done', `Reached --max-posts ${MAX_POSTS}.`);
    if (emptyPages >= 8) {
      if (options.trackCursor) state.completedFeed = true;
      return finish('end', 'Eight pages in a row without posts; assuming the end of the group.');
    }
    if (pages % 20 === 0) log(tracker.progress());
    if (pages % 40 === 0 || Date.now() - lastSave > 180_000) {
      const changed = await walk.persist();
      lastSave = Date.now();
      if (DEBUG) log(`Saved (${changed} posts changed so far).`);
    }
    await polite(1600);
  }
  return finish('stopped', 'Stopping.');
}

type FeedPage = { ok: true; docs: unknown[]; pageInfo: PageInfo | null } | { ok: false; error: string };

/** Asks Facebook for the next page of the feed with the exact request its own client uses, from inside the page. */
async function fetchFeedPage(page: Page, template: FeedTemplate, cursor: string, largerPages: boolean): Promise<FeedPage> {
  const parsed = parseGraphqlForm(template.body);
  if (!parsed) return { ok: false, error: 'the captured request is unreadable' };
  const variables: Record<string, unknown> = { ...parsed.variables, cursor };
  if (largerPages && typeof variables.count === 'number' && variables.count < 10) variables.count = 10;
  const body = withGraphqlVariables(template.body, variables);
  try {
    const result = await page.evaluate(
      async ({ url, body, headers }) => {
        const response = await fetch(url, { method: 'POST', body, headers, credentials: 'include' });
        return { status: response.status, text: await response.text() };
      },
      { url: template.url, body, headers: { ...template.headers, 'x-ror-replay': '1' } },
    );
    if (result.status >= 400) return { ok: false, error: `HTTP ${result.status}` };
    const docs = parseJsonDocuments(result.text);
    if (docs.length === 0) return { ok: false, error: /login/i.test(result.text.slice(0, 500)) ? 'logged out' : 'empty response' };
    const pageInfo = extractFeedPageInfo(docs);
    const errors = graphqlErrors(docs);
    if (errors.length && !pageInfo) return { ok: false, error: errors[0]! };
    return { ok: true, docs, pageInfo };
  } catch (error) {
    return { ok: false, error: (error as Error).message.split('\n')[0] ?? 'unknown error' };
  }
}

async function recaptureTemplate(walk: WalkContext): Promise<FeedTemplate | null> {
  walk.page = await livePage(walk.context, walk.page);
  if (!(await hasSession(walk.context))) walk.page = await ensureLoggedIn(walk.context, walk.page);
  const version = feedCapture.version;
  await gotoSafe(walk.page, FEED_URL);
  await polite(3000);
  await ingestPage(walk.page);
  walk.tracker.absorb();
  for (let i = 0; i < 12 && !stopping && feedCapture.version === version; i++) {
    await scrollDown(walk.page);
    await polite(1800);
    walk.tracker.absorb();
  }
  return feedCapture.version > version ? feedCapture.template : null;
}

/** Fallback: keep scrolling the feed page. Slower and the page gets heavy after a few hundred posts, but needs nothing else. */
async function scrollWalk(walk: WalkContext, stopOnKnown: boolean): Promise<void> {
  const { tracker, state } = walk;
  let idle = 0;
  let lastCount = stories.size;
  let rounds = 0;
  let lastSave = Date.now();
  log(stopOnKnown ? `Scrolling for new posts until ${STOP_AFTER_KNOWN} already-saved posts in a row.` : 'Scrolling through the whole group, newest first. Leave it running.');
  while (!stopping) {
    walk.page = await livePage(walk.context, walk.page);
    tracker.absorb();
    if (stopOnKnown && tracker.consecutiveKnown >= STOP_AFTER_KNOWN) {
      log(`Reached ${tracker.consecutiveKnown} known posts in a row; the feed is up to date.`);
      break;
    }
    if (tracker.collected >= MAX_POSTS) {
      log(`Reached --max-posts ${MAX_POSTS}.`);
      break;
    }
    if (stories.size === lastCount) {
      idle++;
      if (idle >= 20) {
        log(`No new posts after 20 scrolls; assuming the end of the group. ${tracker.progress()}`);
        state.completedFeed = true;
        break;
      }
      if (idle % 5 === 0) {
        await walk.page.evaluate('window.scrollBy(0, -1500)').catch(noop);
        await polite(1200);
      }
    } else {
      idle = 0;
      lastCount = stories.size;
    }
    if (++rounds % 15 === 0) log(tracker.progress());
    if (Date.now() - lastSave > 180_000) {
      await walk.persist();
      lastSave = Date.now();
    }
    await scrollDown(walk.page);
    await polite(1800);
  }
}

/* ---------- Comments ---------- */

const EXPANDERS = /^(view|see|show) (\d+ |all \d+ |more |previous )?(more )?(comments?|repl(y|ies))\b|^\d+ (more )?repl(y|ies)$|previous comments|more comments|more replies/i;

async function collectComments(walk: WalkContext, archive: SourcePost[], known: Map<string, SourcePost>): Promise<void> {
  const { state } = walk;
  const tries = (state.commentTries ??= {});
  const queue = new Set<string>(state.pendingComments);
  for (const post of archive) if (needsComments(post)) queue.add(post.id);
  const wanted = sortNewestFirst(archive).filter((post) => queue.has(post.id));
  const ordered = wanted.filter((post) => ONLY_COMMENTS || (tries[post.id] ?? 0) < 2).map((post) => post.id);
  const skipped = wanted.length - ordered.length;
  log(`${ordered.length} threads need comments${skipped ? ` (${skipped} more were already opened twice and still look incomplete; --only-comments retries them)` : ''}.`);
  let failures = 0;
  let processed = 0;
  for (const id of ordered) {
    if (stopping) break;
    const post = known.get(id);
    if (!post) {
      queue.delete(id);
      continue;
    }
    walk.page = await livePage(walk.context, walk.page);
    if (processed % 25 === 0 && !(await hasSession(walk.context))) {
      log('Facebook logged the browser out. Log in again in the window to continue.');
      walk.page = await ensureLoggedIn(walk.context, walk.page);
    }
    try {
      const complete = await fetchComments(walk.page, post);
      failures = 0;
      if (complete) delete tries[id];
      else tries[id] = (tries[id] ?? 0) + 1;
    } catch (error) {
      failures++;
      tries[id] = (tries[id] ?? 0) + 1;
      const message = (error as Error).message;
      log(`Could not load comments for ${id}: ${message}`);
      if (/logged out/.test(message)) {
        log('Facebook logged the browser out. Log in again in the window to continue.');
        walk.page = await ensureLoggedIn(walk.context, walk.page);
      } else if (failures === 5) {
        log('Five threads in a row failed; Facebook may be rate limiting. Pausing for three minutes before trying again.');
        await sleep(180_000);
      } else if (failures >= 10) {
        log('Still failing after the pause. Stopping for now; run again later to continue.');
        break;
      }
    }
    queue.delete(id);
    state.pendingComments = [...queue];
    if (++processed % 10 === 0) {
      const changed = await walk.persist();
      log(`Saved (${changed} posts changed this run, ${ordered.length - processed} threads to go).`);
    }
    await polite(2000);
  }
  state.pendingComments = [...queue];
}

/** Opens one thread, switches to "All comments" and expands it until Facebook's count is reached. Returns true when complete. */
async function fetchComments(page: Page, post: SourcePost): Promise<boolean> {
  currentPostId = post.id;
  try {
    const url = post.url || `${GROUP_ORIGIN}${GROUP_PATH}/posts/${post.id}/`;
    const before = countCommentsFor(post.id);
    if (!(await gotoSafe(page, url))) throw new Error('the thread did not load');
    await polite(2200);
    if (/\/login|\/checkpoint/.test(safeUrl(page))) throw new Error('logged out');
    await ingestPage(page);
    await switchToAllComments(page);

    const target = post.commentCount ?? 0;
    let quiet = 0;
    for (let round = 0; round < 80 && quiet < 4 && !stopping; round++) {
      if (target > 0 && countCommentsFor(post.id) >= target) break;
      if (await clickExpander(page)) {
        quiet = 0;
        await waitForGraphql(page, 7000);
      } else {
        quiet++;
        await page.evaluate('window.scrollBy(0, Math.max(1200, window.innerHeight))').catch(noop);
      }
      await polite(900);
    }
    const got = countCommentsFor(post.id);
    log(`${post.id}: ${got} comments (${before} before, Facebook says ${post.commentCount ?? '?'}).`);
    return target === 0 || got >= target;
  } finally {
    currentPostId = '';
  }
}

async function clickExpander(page: Page): Promise<boolean> {
  const candidates = [page.getByRole('button', { name: EXPANDERS }), page.getByText(EXPANDERS)];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 12); i++) {
      const element = locator.nth(i);
      if (!(await element.isVisible().catch(() => false))) continue;
      await element.scrollIntoViewIfNeeded().catch(noop);
      const clicked = await element
        .click({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) return true;
    }
  }
  return false;
}

async function waitForGraphql(page: Page, timeout: number): Promise<void> {
  await page.waitForResponse((response) => response.url().includes('/api/graphql'), { timeout }).catch(noop);
  await sleep(400); // let the response listener finish reading the body
}

async function switchToAllComments(page: Page): Promise<void> {
  try {
    const sorter = page.getByRole('button', { name: /most relevant|top comments|newest|most recent/i }).first();
    if (await sorter.isVisible({ timeout: 1500 })) {
      await sorter.click({ timeout: 4000 });
      await polite(800);
      const option = page.getByRole('menuitem', { name: /all comments/i }).first();
      if (await option.isVisible({ timeout: 1500 })) {
        await option.click({ timeout: 4000 });
        await waitForGraphql(page, 5000);
        await polite(1000);
      } else {
        await page.keyboard.press('Escape').catch(noop);
      }
    }
  } catch {
    // Sorting menu not present; fine.
  }
}

function countCommentsFor(postId: string): number {
  let count = 0;
  for (const comment of comments.values()) if (comment.postId === postId) count++;
  return count;
}

/* ---------- Main ---------- */

async function main(): Promise<void> {
  const file = postsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  let archive = await readPostsJsonl(file);
  const known = new Map(archive.map((post) => [post.id, post]));
  const state = loadState();
  log(`${archive.length} posts on disk (${archive.filter(needsComments).length} missing comments). Group: ${GROUP_URL}`);
  if (HEADLESS) log('Note: Facebook often refuses headless browsers. If this fails, run without --headless.');

  const context = await launchBrowser();
  context.on('close', () => {
    browserGone = true;
    stopping = true;
  });
  attachResponseListener(context);
  const page = context.pages()[0] ?? (await context.newPage());
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('Stopping after the current step; progress is being saved.');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const persist = async (): Promise<number> => {
    const fresh = toSourcePosts([...stories.values()], [...comments.values()]);
    const merged = mergePosts(archive, fresh);
    archive = merged.posts;
    for (const post of archive) known.set(post.id, post);
    await writePostsJsonl(file, archive);
    saveState(state);
    return merged.added + merged.updated;
  };

  const walk: WalkContext = { context, page, tracker: new StoryTracker(known, state), state, persist };
  try {
    walk.page = await ensureLoggedIn(context, page);
    log('Logged in and inside the group.');
    if (LOGIN_ONLY) {
      log(`Login saved in ${path.relative(process.cwd(), PROFILE_DIR)}/. Run \`npm run scrape -- --full\` to start the scrape.`);
      return;
    }
    if (!ONLY_COMMENTS && !stopping) {
      await walkFeed(walk);
      await persist();
    }
    if (FETCH_COMMENTS && !stopping) await collectComments(walk, archive, known);
  } finally {
    const changed = await persist();
    const total = archive.reduce((sum, post) => sum + post.comments.length, 0);
    log(`Done. ${archive.length} posts and ${total} comments on disk; ${changed} changed in this run.`);
    if (browserGone) log('The browser window was closed. Run the command again to continue where this run stopped.');
    else if (state.feedCursor && FULL) log(`The full walk is not finished yet (oldest post so far ${state.feedCursorOldest || 'unknown'}). Run \`npm run scrape -- --full\` again to continue.`);
    await context.close().catch(noop);
  }
}

main().catch((error) => {
  console.error('[scrape] Failed:', error instanceof Error ? error.message : error);
  if (DEBUG && error instanceof Error && error.stack) console.error(error.stack);
  process.exit(process.exitCode ?? 1);
});
