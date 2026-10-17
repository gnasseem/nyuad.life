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
const limit = Number(value('limit')) || undefined;
const remote = value('remote');
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
  let idle = 0;
  let failures = 0;
  // One slice at a time: each reads threads for a few minutes and says what is left. A slice that got no model to
  // answer is followed by a pause; half an hour of them ends the run, and the next run carries on.
  while (Date.now() < deadline) {
    const response = await fetch(`${remote.replace(/\/+$/, '')}/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ op: 'reviews', workers, limit }),
      signal: AbortSignal.timeout(330_000),
    }).catch((error: Error) => error);
    if (response instanceof Error || !response.ok) {
      const reason = response instanceof Error ? response.message : `${response.status} ${(await response.text()).slice(0, 200)}`;
      if (++failures >= 4) {
        console.error(`[reviews] The job failed four times in a row (${reason}).`);
        process.exit(1);
      }
      log(`The job failed (${reason}); trying again in a minute.`);
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      continue;
    }
    failures = 0;
    const result = (await response.json()) as ReviewResult;
    calls += result.calls;
    log(`Slice: ${result.threads.read} threads read, ${result.threads.left} left of ${result.threads.named}; ${result.mentions} mentions; ${result.calls} model calls${result.digests ? `; digests ${result.digests.written} written, ${result.digests.unchanged} unchanged, ${result.digests.left} left` : ''}.`);
    // A trial (--limit) is one slice.
    if (result.done || limit) {
      report(result);
      break;
    }
    if (result.calls === 0 && (result.threads.left > 0 || (result.digests?.left ?? 0) > 0)) {
      if (++idle >= 6) {
        log('No model answered for half an hour; stopping. Run again later to carry on.');
        break;
      }
      log('No model answered in that slice; waiting five minutes.');
      await new Promise((resolve) => setTimeout(resolve, 300_000));
    } else idle = 0;
  }
  log(`${calls} model calls in ${Math.round((Date.now() - started) / 60_000)} minutes.`);
} else {
  const store = boardStore();
  if (!store || (!store.persistent && process.env.ROR_BOARD_STORE !== 'memory')) {
    console.error('[reviews] Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: the mentions and digests live in Supabase.');
    process.exit(1);
  }
  try {
    const result = await runReviews({ store, archive: await loadArchive(), catalog: loadCatalog(), deadline, end: deadline + 300_000, workers, limit, log });
    report(result);
    log(`${result.calls} model calls in ${Math.round((Date.now() - started) / 60_000)} minutes${result.exhausted ? '; stopped early because no model answered' : result.done ? '' : '; stopped at the time limit, run again to carry on'}.`);
  } catch (error) {
    console.error(`[reviews] ${(error as Error).message}`);
    process.exit(1);
  }
  await saveModelUsage().catch(() => undefined);
}
