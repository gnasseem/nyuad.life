# Hall of Requirement

Answers for NYU Abu Dhabi students. The name is a nod to the Room of Requirement group, one size up, and lives in one
constant (`web/src/brand.ts`) so it is easy to change.

Three things happen here:

- **Ask.** A question goes to the archive of the Room of Requirement Facebook group (hybrid keyword + vector search,
  reranked by Gemini) and comes back as a short, plain answer that cites the threads it used, says how sure it is, and
  flags advice that is old or disputed. Answers students wrote on the board and current announcements are cited too.
- **Questions.** When the archive falls short, the question goes to people. Students who want to help give their name,
  NetID, major and class year once, then get questions one at a time, flashcard style: answer or skip. Questions are
  tagged by the lite model for the majors and years best placed to answer, and handed out least-seen first, with views,
  skips and answers tracked. Answered questions feed straight back into Ask.
- **Announcements.** Events, deadlines, opportunities, club notices. Dated ones drop off the day after; undated ones
  after two weeks.

Small things that know what time of year it is: the starter questions on Ask lead with what is in season (registration,
housing, internships, finals); on 1 May everyone's class year rolls over, the app says so with confetti the next
time they open it, and the board starts routing questions to them as the sophomore, junior, senior or alumni they now
are; a helper's first, tenth, twenty-fifth, fiftieth and hundredth answers get the same treatment.

What the site refuses to be: a marketplace. Feed ads, Falcon-dirham trades and bare listings are filtered out of the
archive, and so are the "bump", tag-a-friend and emoji comments. A question that is really a trade, a listing, a ride
or a lost-and-found request is sent to Falcon Market or to the group itself instead of being answered from old posts.

Everything is TypeScript in one repository:

| Piece | Where | What it is |
| --- | --- | --- |
| API | `api/`, `lib/` | Vercel serverless functions. Holds the keys, the archive and the board. |
| Web app | `web/` | Vite + React. Sidebar shell, works on phones. |
| Scraper | `scripts/scrape.ts` | Pulls posts and comments out of the Facebook group with your own login (runs on your laptop). |
| Indexer | `scripts/index.ts`, `.github/workflows/index.yml` | Cleans and embeds posts, locally or in GitHub Actions. |
| Board schema | `supabase/schema.sql` | Tables and functions for questions, answers, profiles and announcements. |

## 1. Deploy on Vercel

1. Import this repository into Vercel (Add New → Project). `vercel.json` already sets the build and output.
2. Add environment variables under Settings → Environment Variables:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | yes | Google AI Studio key. Writes answers, reranks threads, tags board questions, suggests follow-ups. |
   | `VOYAGE_API_KEY` | for semantic search | Embeds each question the way the index was embedded (section 3). |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | for the board | Section 4. Without them the Questions and Announcements pages say the board is not set up. |
   | `ROR_GROUP_URL` | no | Where listings, rides and lost-and-found requests are sent. Defaults to the group. |
   | `GEMINI_CHAT_MODEL`, `GEMINI_CHAT_FALLBACK_MODELS`, `GEMINI_LITE_MODEL` | no | Defaults: `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-flash-lite`. |

3. Deploy. `GET /api/health` shows what is active: `embeddings.semanticSearch`, `gemini.configured`,
   `board.configured`.

Routes: `GET /api/health`, `GET /api/home`, `GET /api/search`, `GET /api/post?id=`, `GET /api/courses`,
`POST /api/ask` (server-sent events: `status`, `redirect`, `sources`, `delta`, `followups`, `done`, `error`), and
`GET|POST /api/board` (`op=stats|question|mine|announcements` on GET; `profile|ask|next|answer|skip|announce|unannounce`
on POST). Every route is rate-limited per IP and per purpose.

## 2. Scrape the group (runs on your laptop)

The scraper drives a real Chromium window where you are logged in as yourself. It reads the JSON Facebook's own web
client loads, so it does not depend on fragile page selectors, and it is incremental and resumable.

```bash
npm install
npx playwright install chromium
npm run scrape -- --login       # optional: just open the window, log in once, and exit
npm run scrape -- --all-time    # first time: the whole group, every year, month by month (hours; leave it running)
npm run scrape                  # later: only new posts and threads whose comment counts changed
```

Log in in the window that opens; the login is kept in `.scraper-profile/` (git-ignored). Progress is saved every few
minutes and on Ctrl+C, and an interrupted run continues where it stopped.

Facebook's group feed stops paging after a year or two of posts and then claims there are no more, so `--full`
(walk the feed by cursor) never reaches an old group's first post. `--all-time` uses the group's search page instead,
whose "date posted" filter reaches any month: for every month back to `--from` (default `2010-01`) it searches a
handful of very common words (`--terms a,the,...` to change them) and pages through all the results. Every post found
is saved or refreshed whether or not it was already on disk; months that are finished are skipped by the next
`--all-time` run, and `--restart-feed` forgets them. Other options: `--max-posts 200`, `--no-comments`, `--delay 2`,
`--chrome`, `--debug`, `--only-comments` (also retries threads that still looked incomplete after two visits).
This is your personal export of a group you belong to; don't share the raw file outside the community. When a run
finishes, commit and push `data/posts.jsonl`.

## 3. Index (cleaning and semantic search)

Indexing applies the noise filters (`lib/filters.ts`) and embeds what is left. The same filters run again whenever an
older index is loaded, so the site is clean even before the next build. Keyword search finds posts that contain your
words; embeddings let "who is chill for calc" find "Dania is very relaxed about deadlines".

| Provider | Key(s) | Free allowance |
| --- | --- | --- |
| Voyage AI (default) | `VOYAGE_API_KEY` | 200M tokens per account. `voyage-3.5`, 1024 dims. |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | 10,000 neurons a day. |
| Gemini | `GEMINI_API_KEY` | Small; kept for compatibility. |

**Automatic:** add the provider's key as a repository secret (Settings → Secrets and variables → Actions). Every push
to `main` that changes `data/posts.jsonl` or `lib/` runs `.github/workflows/index.yml`, which embeds only the chunks
that changed and commits `data/index/`. The same key must be set on Vercel so questions can be embedded.

**Manual:** `cp .env.example .env`, put the key in it, `npm run index`, then commit `data/index/`. Options:
`--provider`, `--fresh`, `--limit 300`, `--batch 64 --concurrency 2`, `--no-embed` (keyword-only).

## 4. The board (Supabase)

1. Create a Supabase project. In the dashboard open **SQL Editor → New query**.
2. Paste the whole of `supabase/schema.sql` (copy it from the raw file, not from a diff view) and press **Run**. It
   creates `board_profiles`, `board_questions`, `board_answers`, `board_events` and `board_announcements`, with row
   level security on and no public policies: only the service role, which the API holds, can read or write, so every
   request passes through the app's validation and rate limits. The file is safe to run more than once, and the test
   suite applies it to a real Postgres (PGlite) on every run.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project → Settings → API) on Vercel and in `.env`, then
   redeploy. `GET /api/health` reports `board.configured: true` once both are in place.

Locally, with nothing set, the board runs in memory so `npm run dev` works without a database (nothing survives a
restart). In production it is switched off until the two variables exist, rather than silently losing questions.

How questions are handed out (`lib/board.ts`): a helper never sees their own question, or one they answered or
skipped, or one that already has three answers. Among the rest, unanswered questions rank first, then the ones fewest
people have seen; a question tagged for the helper's major or year gets a lift, a question many people skipped sinks,
and a little randomness keeps two helpers from getting the same card at the same moment.

## 5. Run everything locally

```bash
npm install
cp .env.example .env            # GEMINI_API_KEY at least
npm run dev                     # API on http://localhost:8787 (serves dist/ too, if built)
npx vite                        # web app with hot reload on http://localhost:5173, proxying /api
npm run check                   # typecheck + tests + production build
```

Without a Gemini key the API still serves browsing and keyword search; asking needs the key. The tests run the whole
API against a fake Gemini, including the board and the scraper (the scraper test needs Playwright's Chromium and skips
itself otherwise).

## How answers are produced

1. Off-platform requests are caught first (`lib/domains.ts`): Falcon trades go to Falcon Market; listings, rides,
   lost-and-found and "does anyone have X right now" go to the group.
2. Follow-ups are rewritten into standalone queries; NYUAD shorthand (D2, A5, core, J-Term) is expanded for search.
3. Retrieval fuses BM25 over chunks with cosine similarity over the embeddings (reciprocal-rank fusion, small recency
   prior). The lite model scores the 30 best threads for usefulness, preferring recent and well-discussed ones; the
   strongest 5–14 become numbered sources. Each source carries its age and how much discussion it had.
4. Answered board questions (keyword match plus stored embeddings) and current announcements that fit the question are
   added as further numbered sources.
5. `gemini-2.5-flash` streams the answer: one or two plain sentences first, then specifics with a `[n]` after every
   claim, a "keep in mind" line when advice is old or disputed, and a final confidence line (high, medium, low with a
   reason) that the client shows as a badge. When its daily quota is used up the fallback model answers instead.
6. Three follow-up questions are suggested in parallel. A medium or low answer offers "Ask students", which carries the
   question to the board.
