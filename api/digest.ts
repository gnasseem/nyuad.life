/**
 * The weekly roundup: every Monday, each helper who opted in gets the open questions their major and year are best
 * placed to answer, by email to their NetID address. Vercel's cron calls this with the CRON_SECRET; `?dry=1` composes
 * the mails without sending them, which is also what happens when no RESEND_API_KEY is set.
 */
import { eligibleQuestions, pickNext, standingFor, STANDING_LABELS, type Profile, type Question } from '../lib/board.ts';
import { boardStore } from '../lib/board-store.ts';
import { ApiError, queryString, route, sendJson } from '../lib/http.ts';
import { collapseWhitespace, truncate } from '../lib/text.ts';

const SITE = () => (process.env.ROR_SITE_URL ?? 'https://nyuad.life').replace(/\/$/, '');

export default route(['GET', 'POST'], async (req, res) => {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim() || queryString(req, 'key').trim();
  if (secret && given !== secret) throw new ApiError(401, 'This route is for the scheduler.', 'unauthorized');
  if (!secret && process.env.VERCEL === '1') throw new ApiError(503, 'Set CRON_SECRET on the server to enable the weekly email.', 'no_secret');
  const store = boardStore();
  if (!store) throw new ApiError(503, 'The board is not set up on this server.', 'board_unavailable');

  const dry = queryString(req, 'dry') === '1' || !process.env.RESEND_API_KEY;
  const now = new Date();
  const [questions, helpers] = await Promise.all([store.listOpen(400), store.listDigestProfiles(3000)]);
  const open = questions.filter((question) => question.status !== 'closed' && question.answers < 3);
  const mails: Array<{ to: string; subject: string; text: string; html: string; count: number }> = [];
  for (const helper of helpers) {
    const events = await store.listEventsByHelper(helper.netId);
    const picks = pickFor(open, helper, events, now);
    if (picks.length === 0) continue;
    mails.push(compose(helper, picks, open.length));
  }
  let sent = 0;
  const failures: string[] = [];
  if (!dry) {
    for (const mail of mails) {
      try {
        await sendMail(mail);
        sent++;
      } catch (error) {
        failures.push(`${mail.to}: ${(error as Error).message}`);
      }
    }
  }
  sendJson(res, 200, { openQuestions: open.length, helpers: helpers.length, composed: mails.length, sent, dry, failures, preview: mails.slice(0, 3).map(({ to, subject, text }) => ({ to, subject, text })) });
});

/** Up to five questions for one helper, best fit first, using the same scoring as the flashcards. */
function pickFor(open: Question[], helper: Profile, events: Awaited<ReturnType<import('../lib/board-store.ts').BoardStore['listEventsByHelper']>>, now: Date): Question[] {
  let pool = eligibleQuestions(open, { profile: helper, events });
  const picks: Question[] = [];
  const random = () => 0;
  while (picks.length < 5 && pool.length) {
    const next = pickNext(pool, { profile: helper, events, now, random });
    if (!next) break;
    picks.push(next);
    pool = pool.filter((question) => question.id !== next.id);
  }
  return picks;
}

function compose(helper: Profile, picks: Question[], openTotal: number) {
  const standing = STANDING_LABELS[standingFor(helper.classOf)].toLowerCase();
  const first = helper.name.split(/\s+/)[0] ?? helper.name;
  const lines = picks.map((question, i) => `${i + 1}. ${truncate(collapseWhitespace(question.text), 220)}${question.courses.length ? ` (${question.courses.join(', ')})` : ''}`);
  const url = `${SITE()}/questions?tab=help`;
  const intro = `${picks.length} of the ${openTotal} open questions on nyuad.life fit a ${helper.major} ${standing}:`;
  const outro = `Sent on Mondays while the weekly email is on in Settings at ${SITE()}/settings.`;
  const text = [`Hi ${first},`, '', intro, '', ...lines, '', `Answer them here: ${url}`, '', outro].join('\n');
  const html = [
    `<p>Hi ${escape(first)},</p>`,
    `<p>${escape(intro)}</p>`,
    `<ol>${picks.map((question) => `<li>${escape(truncate(collapseWhitespace(question.text), 220))}${question.courses.length ? ` (${escape(question.courses.join(', '))})` : ''}</li>`).join('')}</ol>`,
    `<p><a href="${url}">Answer them</a></p>`,
    `<p style="color:#777;font-size:12px">${escape(outro)}</p>`,
  ].join('');
  return { to: `${helper.netId}@nyu.edu`, subject: `${picks.length} open question${picks.length === 1 ? '' : 's'} for a ${helper.major} ${standing}`, text, html, count: picks.length };
}

function escape(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);
}

async function sendMail(mail: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.DIGEST_FROM ?? 'nyuad.life <roundup@nyuad.life>', to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Resend answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
}
