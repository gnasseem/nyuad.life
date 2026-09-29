/**
 * Runs the real scraper (as a child process, headless) against the fake Facebook in fake-facebook.ts:
 * logs in through a page that submits itself mid-poll, gets past the "save your login info?" screen on its own,
 * pages through the feed with cursors (including one rate-limited page), expands comments, saves, and resumes
 * an interrupted --full walk. Skipped when no Chromium is available.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPostsJsonl } from '../lib/posts.ts';
import { makePosts, startFakeFacebook, type FakeFacebook } from './fake-facebook.ts';

function browserExecutable(): string | undefined {
  if (process.env.ROR_BROWSER_EXECUTABLE) return process.env.ROR_BROWSER_EXECUTABLE;
  try {
    const bundled = chromium.executablePath();
    if (existsSync(bundled)) return bundled;
  } catch {
    // no bundled browser
  }
  const fallback = process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : '';
  return fallback && existsSync(fallback) ? fallback : undefined;
}

const executable = browserExecutable();
const posts = makePosts(64, 12);
let fake: FakeFacebook;
let workDir = '';

function runScraper(extra: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/scrape.ts', '--headless', '--group', `${fake.url}/groups/testgroup`, ...extra], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ROR_POSTS_FILE: path.join(workDir, 'posts.jsonl'),
        ROR_BROWSER_PROFILE: path.join(workDir, 'profile'),
        ROR_BROWSER_EXECUTABLE: executable,
        ROR_SCRAPE_DELAY: '0.12',
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ code, output }));
  });
}

const state = () => JSON.parse(readFileSync(path.join(workDir, 'scrape-state.json'), 'utf8')) as { completedFeed: boolean; feedCursor?: string; pendingComments: string[] };

describe.skipIf(!executable)('scraper against a fake Facebook', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'ror-scrape-'));
    // The second page the scraper asks for itself (count >= 10 marks its own requests) is rate limited once.
    let largeRequests = 0;
    fake = await startFakeFacebook({ slug: 'testgroup', posts, pageSize: 3, loginDelayMs: 1500, failFeedRequest: ({ count }) => count >= 10 && ++largeRequests === 2 });
  });
  afterAll(async () => {
    await fake?.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('logs in without closing, pages the feed with cursors, saves comments and resumes a --full walk', async () => {
    // First run: the browser starts logged out, the login page submits itself while the scraper is polling,
    // and the walk is cut short by --max-posts so there is a saved position to resume from.
    const first = await runScraper(['--full', '--max-posts', '20', '--stop-after-known', '8']);
    expect(first.output, first.output).toContain('Logged in and inside the group.');
    expect(first.output).toContain('Not logged in'); // it waited through the login instead of quitting
    expect(first.output).toMatch(/Retrying in \d+s \(1\/4\)/); // the rate-limited page was retried, not fatal
    expect(first.output).toContain('Reached --max-posts 20');
    expect(first.code, first.output).toBe(0);
    expect(fake.calls.logins).toBe(1);

    const afterFirst = await readPostsJsonl(path.join(workDir, 'posts.jsonl'));
    expect(afterFirst.length).toBeGreaterThanOrEqual(20);
    expect(afterFirst.length).toBeLessThan(posts.length);
    const commented = afterFirst.filter((post) => (post.commentCount ?? 0) > 0);
    expect(commented.length).toBeGreaterThan(0);
    for (const post of commented) expect(post.comments.map((comment) => comment.text).sort()).toEqual(['Reply 1', 'Reply 2', 'Reply 3'].map((text) => `${text} on post ${posts.findIndex((p) => p.id === post.id)}`));
    expect(afterFirst[0]!.url).toBe(`${fake.url}/groups/testgroup/posts/${posts[0]!.id}/`);
    expect(afterFirst[0]!.date).toBe('2026-09-20');
    expect(state().completedFeed).toBe(false);
    expect(state().feedCursor).toMatch(/^c:\d+$/);

    // Second run: already logged in (the profile kept the cookie), picks up new posts at the top, then continues
    // from the saved cursor to the very first post of the group.
    const feedPagesBefore = fake.calls.feedPages;
    const second = await runScraper(['--full', '--stop-after-known', '8']);
    expect(second.code, second.output).toBe(0);
    expect(second.output).not.toContain('Please log in');
    expect(second.output).toContain('Picking up new posts first');
    expect(second.output).toContain('Reached the first post of the group.');
    expect(fake.calls.logins).toBe(1);
    expect(fake.calls.feedPages).toBeGreaterThan(feedPagesBefore);

    const all = await readPostsJsonl(path.join(workDir, 'posts.jsonl'));
    expect(all.map((post) => post.id).sort()).toEqual(posts.map((post) => post.id).sort());
    expect(all.every((post) => post.comments.length === (post.commentCount ?? 0))).toBe(true);
    expect(state().completedFeed).toBe(true);
    expect(state().feedCursor).toBeUndefined();
    expect(state().pendingComments).toEqual([]);

    // Third run, incremental: nothing new, stops as soon as it has seen enough known posts, changes nothing.
    const third = await runScraper(['--stop-after-known', '8']);
    expect(third.code, third.output).toBe(0);
    expect(third.output).toMatch(/known posts in a row; the feed is up to date/);
    expect(third.output).toMatch(/0 changed in this run/);
  }, 240_000);
});
