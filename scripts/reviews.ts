/**
 * Brings the course and professor review digests up to date (lib/reviews.ts): reads the archive threads not read yet,
 * then folds the new mentions, and reviews written on the site, into the digests /api/courses serves.
 *
 *   npm run reviews -- --remote https://www.nyuad.life
 *                                      run it on the site itself, where the model keys are, a slice of a few minutes
 *                                      at a time, until everything is read (needs SUPABASE_SERVICE_ROLE_KEY, or
 *                                      REVIEWS_JOB_TOKEN in CI)
 *   npm run reviews                    run it here (needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, the archive's index
 *                                      from npm run archive -- pull index, and ZAI_API_KEY or GROQ_API_KEY)
 *   npm run reviews -- --minutes 240   stop starting new work after four hours; the next run carries on
 *   npm run reviews -- --workers 3     model calls at once (default 3)
 *   npm run reviews -- --limit 20      only the 20 newest unread threads (a trial)
 *   npm run reviews -- --models all    call every model the site has, GLM first, not only the ones Ask leans on
 *                                      least (or name them: --models zai,groq,gemini)
 *   npm run reviews -- --rewrite       rewrite every digest from scratch under the current summary rules, instead of
 *                                      folding new ratings into what it says (with --remote or here)
 */
import { boardStore } from '../lib/board-store.ts';
import { loadCatalog } from '../lib/courses.ts';
import { loadDotEnv } from '../lib/env.ts';
import { saveModelUsage } from '../lib/model-usage.ts';
import { reviewsJobToken, runReviews, type ReviewResult } from '../lib/reviews.ts';
import { loadArchive } from '../lib/store.ts';

loadDotEnv();
const args = process.argv.slice(2);
const value = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const started = Date.now();
const deadline = started + (Number(value('minutes')) || 100_000) * 60_000;
const workers = Math.max(1, Number(value('workers')) || 3);
const models = value('models');
const limit = Number(value('limit')) || undefined;
const remote = value('remote');
// Every digest written before this run started is rewritten; a slice's own rewrites are newer, so the run finishes.
const rewriteBefore = args.includes('--rewrite') ? new Date(started).toISOString() : undefined;
const log = (message: string) => console.log(`[reviews] ${message}`);

function report(result: ReviewResult): void {
  if (result.totals) log(`Done: ${result.totals.courses} course digests, ${result.totals.profs} professor digests, ${result.totals.mentions} mentions.`);
}

if (remote) {
  const token = process.env.REVIEWS_JOB_TOKEN || (process.env.SUPABASE_SERVICE_ROLE_KEY ? reviewsJobToken(process.env.SUPABASE_SERVICE_ROLE_KEY) : '');
  if (!token) {
    console.error('[reviews] Set SUPABASE_SERVICE_ROLE_KEY (or REVIEWS_JOB_TOKEN) to start the job on the site.');
    process.exit(1);
  }
  let calls = 0;
  let failures = 0;
  // One slice at a time: each reads threads for a few minutes and says what is left. The free models run out (a day's
  // tokens) or get overloaded for hours, so a slice no model answered in is followed by a pause that grows to half an
  // hour; a failed request is tried again after a minute. Only --minutes ends the run early, and the next run carries on.
  while (Date.now() < deadline) {
    const response = await fetch(`${remote.replace(/\/+$/, '')}/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ op: 'reviews', workers, limit, models, rewriteBefore }),
      signal: AbortSignal.timeout(330_000),
    }).catch((error: Error) => error);
    const failed = response instanceof Error || !response.ok;
    if (!failed) {
      const result = (await response.json()) as ReviewResult;
      calls += result.calls;
      log(`Slice: ${result.threads.read} threads read, ${result.threads.left} left of ${result.threads.named}; ${result.mentions} mentions; ${result.calls} model calls${result.digests ? `; digests ${result.digests.written} written, ${result.digests.unchanged} unchanged, ${result.digests.left} left` : ''}.`);
      // A trial (--limit) is one slice.
      if (result.done || limit) {
        report(result);
        break;
      }
      if (result.calls > 0) {
        failures = 0;
        continue;
      }
    } else {
      const reason = response instanceof Error ? `${response.message}${(response.cause as { code?: string } | undefined)?.code ? ` (${(response.cause as { code: string }).code})` : ''}` : `${response.status} ${(await response.text()).slice(0, 200)}`;
      if (response instanceof Response && (response.status === 401 || response.status === 403)) process.exit(1);
      // The network or the site hiccupped: the slice may well have run anyway, so try again soon.
      log(`The job failed (${reason}); trying again in a minute.`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    const wait = Math.min(1_800_000, 60_000 * 2 ** failures++);
    log(`No model answered in that slice; trying again in ${Math.round(wait / 60_000)} minutes.`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  log(`${calls} model calls in ${Math.round((Date.now() - started) / 60_000)} minutes.`);
} else {
  const store = boardStore();
  if (!store || (!store.persistent && process.env.ROR_BOARD_STORE !== 'memory')) {
    console.error('[reviews] Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: the mentions and digests live in Supabase.');
    process.exit(1);
  }
  try {
    const result = await runReviews({ store, archive: await loadArchive(), catalog: loadCatalog(), deadline, end: deadline + 300_000, workers, models, limit, rewriteBefore, log });
    report(result);
    log(`${result.calls} model calls in ${Math.round((Date.now() - started) / 60_000)} minutes${result.exhausted ? '; stopped early because no model answered' : result.done ? '' : '; stopped at the time limit, run again to carry on'}.`);
  } catch (error) {
    console.error(`[reviews] ${(error as Error).message}`);
    process.exit(1);
  }
  await saveModelUsage().catch(() => undefined);
}
