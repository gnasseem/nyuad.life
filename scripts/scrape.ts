/**
 * Walks the Room of Requirement Facebook group with YOUR logged-in browser and saves every post and comment
 * to data/posts.jsonl. Runs on your laptop, never on the server.
 *
 *   npm run scrape                      newest posts until it meets posts it already has (incremental)
 *   npm run scrape -- --full            keep scrolling to the very first post of the group
 *   npm run scrape -- --max-posts 300   stop after 300 new or updated posts
 *   npm run scrape -- --only-comments   only fetch missing comments for posts already saved
 *   npm run scrape -- --no-comments     feed only, do not open permalinks
 *   npm run scrape -- --headless        no window (only after you logged in once with a window)
 *   npm run scrape -- --debug           save raw responses to .scraper-debug/ for fixing selectors
 *
 * First run: a Chromium window opens on facebook.com; log in there (the profile is kept in .scraper-profile/).
 * Ctrl+C at any time: progress is saved and the next run resumes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { loadDotEnv } from '../lib/env.ts';
import { embeddedJsonFromHtml, extractComments, extractStories, parseJsonDocuments, toSourcePosts, type CommentRecord, type StoryRecord } from '../lib/facebook.ts';
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
const PROFILE_DIR = path.resolve(process.env.ROR_BROWSER_PROFILE ?? '.scraper-profile');
const STATE_FILE = path.join(path.dirname(postsFile()), 'scrape-state.json');
const DEBUG_DIR = path.resolve('.scraper-debug');
const FULL = flag('full');
const HEADLESS = flag('headless');
const DEBUG = flag('debug');
const FETCH_COMMENTS = !flag('no-comments');
const ONLY_COMMENTS = flag('only-comments');
const MAX_POSTS = Number(value('max-posts', '0')) || Infinity;
const STOP_AFTER_KNOWN = Number(value('stop-after-known', '40')) || 40;
const DELAY = Number(value('delay', '1')) || 1;

interface State {
  pendingComments: string[];
  completedFeed: boolean;
  lastRun: string;
}

if (!GROUP_SLUG) {
  console.error(`Could not read a group slug from ${GROUP_URL}.`);
  process.exit(1);
}

const stories = new Map<string, StoryRecord>();
const comments = new Map<string, CommentRecord>();
let currentPostId = '';
let responseCounter = 0;

function log(message: string): void {
  console.log(`[scrape ${new Date().toLocaleTimeString('en-GB')}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function polite(baseMs: number): Promise<void> {
  return sleep(baseMs * DELAY + Math.random() * baseMs * 0.6 * DELAY);
}

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
    writeFileSync(path.join(DEBUG_DIR, `${String(++responseCounter).padStart(5, '0')}-${origin}.json`), JSON.stringify(docs, null, 1));
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
  context.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/graphql')) return;
    try {
      const body = await response.text();
      ingest(parseJsonDocuments(body), 'graphql');
    } catch {
      // Body already consumed or navigation interrupted; ignore.
    }
  });
}

async function ingestPage(page: Page): Promise<void> {
  try {
    ingest(embeddedJsonFromHtml(await page.content()), 'page');
  } catch {
    // Page navigated away mid-read.
  }
}

async function ensureLoggedIn(page: Page): Promise<void> {
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded' });
  await polite(2500);
  const deadline = Date.now() + 15 * 60_000;
  let warned = false;
  while (Date.now() < deadline) {
    const url = page.url();
    const loggedOut = /\/login|\/checkpoint|\/recover/.test(url) || (await page.locator('input[name="email"], form[action*="login"]').count()) > 0;
    if (!loggedOut && url.includes(GROUP_PATH)) return;
    if (!warned) {
      log(HEADLESS ? 'Not logged in. Run once without --headless and sign in to Facebook in the window that opens.' : 'Please log in to Facebook in the browser window (and open the group). Waiting…');
      warned = true;
      if (HEADLESS) process.exit(2);
    }
    await sleep(3000);
    if (!page.url().includes(GROUP_PATH) && !loggedOut) await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  throw new Error('Timed out waiting for a Facebook login.');
}

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
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function needsComments(post: SourcePost): boolean {
  return (post.commentCount ?? 0) > post.comments.length;
}

async function main(): Promise<void> {
  const file = postsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  let archive = await readPostsJsonl(file);
  const known = new Map(archive.map((post) => [post.id, post]));
  const state = loadState();
  log(`${archive.length} posts on disk (${archive.filter(needsComments).length} missing comments). Group: ${GROUP_URL}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    locale: 'en-GB',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  attachResponseListener(context);
  const page = context.pages()[0] ?? (await context.newPage());
  let stopping = false;
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

  try {
    await ensureLoggedIn(page);
    log('Logged in.');

    if (!ONLY_COMMENTS && !stopping) {
      await walkFeed(page, known, state, () => stopping);
      await persist();
    }

    if (FETCH_COMMENTS && !stopping) {
      const queue = new Set<string>(state.pendingComments);
      for (const post of archive) if (needsComments(post)) queue.add(post.id);
      const ordered = sortNewestFirst(archive).filter((post) => queue.has(post.id)).map((post) => post.id);
      log(`${ordered.length} posts need comments.`);
      let failures = 0;
      let processed = 0;
      for (const id of ordered) {
        if (stopping) break;
        const post = known.get(id)!;
        try {
          await fetchComments(page, post);
          failures = 0;
        } catch (error) {
          failures++;
          log(`Could not load comments for ${id}: ${(error as Error).message}`);
          if (failures >= 5) {
            log('Five permalinks in a row failed; Facebook may be rate limiting. Stopping for now.');
            break;
          }
        }
        queue.delete(id);
        state.pendingComments = [...queue];
        if (++processed % 10 === 0) {
          const changed = await persist();
          log(`Saved (${changed} posts changed this run).`);
        }
        await polite(2000);
      }
      state.pendingComments = [...queue];
    }
  } finally {
    const changed = await persist();
    const total = archive.reduce((sum, post) => sum + post.comments.length, 0);
    log(`Done. ${archive.length} posts and ${total} comments on disk; ${changed} changed in this run.`);
    await context.close().catch(() => {});
  }
}

async function walkFeed(page: Page, known: Map<string, SourcePost>, state: State, shouldStop: () => boolean): Promise<void> {
  const url = `${GROUP_URL}?sorting_setting=CHRONOLOGICAL`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await polite(3000);
  await ingestPage(page);

  const seen = new Set<string>();
  let consecutiveKnown = 0;
  let idleScrolls = 0;
  let collected = 0;
  let lastCount = 0;
  log(FULL ? 'Walking the whole group, newest first. This takes a while; leave it running.' : `Collecting new posts until ${STOP_AFTER_KNOWN} already-saved posts in a row.`);

  while (!shouldStop()) {
    for (const story of stories.values()) {
      if (seen.has(story.id)) continue;
      seen.add(story.id);
      const existing = known.get(story.id);
      const unchanged = existing && !needsComments(existing) && (story.commentCount ?? 0) <= existing.comments.length && existing.text.length >= story.text.length;
      if (unchanged) {
        consecutiveKnown++;
      } else {
        consecutiveKnown = 0;
        collected++;
        if ((story.commentCount ?? 0) > 0) state.pendingComments.push(story.id);
      }
    }
    if (!FULL && consecutiveKnown >= STOP_AFTER_KNOWN) {
      log(`Reached ${consecutiveKnown} known posts in a row; the feed is up to date.`);
      break;
    }
    if (collected >= MAX_POSTS) {
      log(`Reached --max-posts ${MAX_POSTS}.`);
      break;
    }
    if (stories.size === lastCount) {
      idleScrolls++;
      if (idleScrolls >= 12) {
        log('No new posts after 12 scrolls; assuming the end of the group.');
        state.completedFeed = true;
        break;
      }
      if (idleScrolls % 4 === 0) await page.evaluate('window.scrollBy(0, -800)').catch(() => {});
    } else {
      idleScrolls = 0;
      lastCount = stories.size;
      if (seen.size % 25 < 5) log(`${stories.size} posts seen, ${collected} new or changed.`);
    }
    await page.mouse.wheel(0, 2500).catch(() => {});
    await polite(1800);
  }
  state.pendingComments = [...new Set(state.pendingComments)];
}

const EXPANDERS = /view (\d+ )?more (comments|replies)|view all \d+ (comments|replies)|^\d+ (more )?repl(y|ies)$|^see more$|more comments/i;

async function fetchComments(page: Page, post: SourcePost): Promise<void> {
  currentPostId = post.id;
  const url = post.url || `https://www.facebook.com/groups/${GROUP_SLUG}/posts/${post.id}/`;
  const before = countCommentsFor(post.id);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await polite(2500);
  await ingestPage(page);
  await switchToAllComments(page);

  let quietRounds = 0;
  for (let round = 0; round < 60 && quietRounds < 2; round++) {
    const target = post.commentCount ?? 0;
    if (target > 0 && countCommentsFor(post.id) >= target) break;
    const buttons = page.getByRole('button', { name: EXPANDERS });
    const count = await buttons.count().catch(() => 0);
    let clicked = false;
    for (let i = 0; i < count && !clicked; i++) {
      const button = buttons.nth(i);
      if (await button.isVisible().catch(() => false)) {
        await button.scrollIntoViewIfNeeded().catch(() => {});
        await button.click({ timeout: 5000 }).catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) {
      const links = page.getByText(EXPANDERS);
      const linkCount = await links.count().catch(() => 0);
      for (let i = 0; i < linkCount && !clicked; i++) {
        const link = links.nth(i);
        if (await link.isVisible().catch(() => false)) {
          await link.click({ timeout: 5000 }).catch(() => {});
          clicked = true;
        }
      }
    }
    if (!clicked) {
      await page.mouse.wheel(0, 1500).catch(() => {});
      quietRounds++;
    } else {
      quietRounds = 0;
    }
    await polite(1500);
  }
  const got = countCommentsFor(post.id);
  log(`${post.id}: ${got} comments (${before} before, Facebook says ${post.commentCount ?? '?'}).`);
  currentPostId = '';
}

async function switchToAllComments(page: Page): Promise<void> {
  try {
    const sorter = page.getByRole('button', { name: /most relevant|top comments|newest|most recent/i }).first();
    if (await sorter.isVisible({ timeout: 1500 })) {
      await sorter.click();
      await polite(800);
      const option = page.getByRole('menuitem', { name: /all comments/i }).first();
      if (await option.isVisible({ timeout: 1500 })) {
        await option.click();
        await polite(1500);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
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

main().catch((error) => {
  console.error('[scrape] Failed:', error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
