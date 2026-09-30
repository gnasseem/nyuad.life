# nyuad.life

Answers for NYU Abu Dhabi students. A question is answered from three sources, with citations and a confidence
level: threads from the Room of Requirement Facebook group, official NYUAD pages, and answers other students wrote here.

- **Ask.** Hybrid keyword and vector search over the archive and the official pages, reranked and written up by Gemini.
- **Questions.** When the archive falls short, a question goes to students. Helpers give a name, NetID, major and class
  year once, then get questions one at a time, matched by major and year. Answered questions are cited by Ask.
- **Notices.** Events, deadlines and opportunities posted by students. Dated ones drop off the day after, undated ones
  after two weeks.
- **Falcons.** Offers to buy or sell campus dirhams, with a contact method revealed on tap. Offers expire after five days.
- **Guide.** Official pages by section and every course with a code, each with a cached summary written from the
  official text and the group's threads.

Everything is TypeScript in one repository: `api/` and `lib/` are Vercel serverless functions, `web/` is a Vite and
React app, `scripts/` holds the scraper, the crawler and the indexer, and `supabase/schema.sql` is the board schema.

## Deploy

1. Import the repository into Vercel. `vercel.json` sets the build and output.
2. Add environment variables:

   | Variable | Needed for |
   | --- | --- |
   | `GEMINI_API_KEY` | Answers, reranking, question tagging, follow-ups, guide summaries. |
   | `VOYAGE_API_KEY` | Semantic search. Must be the provider that built the index. |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | The board: questions, notices, offers, guide summaries. |
   | `ROR_GROUP_URL` | Where listings and rides are sent. Defaults to the group. |

3. Deploy. `GET /api/health` reports what is active. `board.ok` comes from a real probe of the database and
   `board.problem` says what is wrong when it is false.

Routes: `GET /api/health`, `/api/home`, `/api/search`, `/api/post?id=`, `/api/courses`, `/api/guide`
(`section=`, `item=`, `course=`); `POST /api/ask` (server-sent events); `GET|POST /api/board`
(`op=stats|question|mine|announcements|offers|leaderboard` on GET, `profile|ask|next|answer|skip|announce|unannounce|offer|offer_done|unoffer`
on POST). Every route is rate-limited per IP.

## Scrape the group

The scraper drives a Chromium window where you are logged in as yourself and reads the JSON Facebook's own client loads.
It runs on your laptop, never on the server.

```bash
npm install
npx playwright install chromium
npm run scrape -- --login       # open the window, log in once, exit
npm run scrape -- --all-time    # first time: every month of the group through search (hours)
npm run scrape                  # later: only new posts and threads whose comment counts changed
```

The login is kept in `.scraper-profile/`. Progress is saved every few minutes and on Ctrl+C, and the next run resumes.
`--all-time` searches a few common words per month back to `--from` (default `2010-01`); months already done are
skipped, `--restart-feed` forgets them. Other options: `--max-posts N`, `--no-comments`, `--only-comments`,
`--delay 2`, `--chrome`, `--debug`. Commit `data/posts.jsonl` when a run finishes.

## Index

Indexing drops feed ads, Falcon trades, bare listings and noise comments (`lib/filters.ts`), then embeds what is left.

| Provider | Keys |
| --- | --- |
| Voyage AI (default) | `VOYAGE_API_KEY` |
| Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Gemini | `GEMINI_API_KEY` |

Automatic: add the key as a repository secret. Every push to `main` that changes `data/posts.jsonl` or `lib/` runs
`.github/workflows/index.yml`, which embeds only the chunks that changed and commits `data/index/`. The same key must
be set on Vercel so questions can be embedded.

Manual: `cp .env.example .env`, add the key, `npm run index`, commit `data/index/`. Options: `--provider`, `--fresh`,
`--limit 300`, `--no-embed`.

## The board

1. Create a Supabase project and run the whole of `supabase/schema.sql` in its SQL editor. It is safe to run again.
   Row level security is on with no policies, so only the service role, which the API holds, can read or write.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on Vercel and in `.env`, then redeploy.

If the pages say the board tables are missing, the schema was not run in the project `SUPABASE_URL` points at. If they
say the key was rejected, the anon key was pasted instead of the service role key. Locally, with nothing set, the board
runs in memory.

How questions are handed out (`lib/board.ts`): a helper never sees their own question or one they answered or skipped,
or one that already has three answers. Unanswered questions come first, then the least seen; a question tagged for the
helper's major or year gets a lift, and one many people skipped sinks.

## Official pages

`npm run scrape:official` crawls nyuad.nyu.edu, the student portal and the bulletin into `data/official.jsonl`; the
bulletin's course listings become one document per course. `npm run index:official` embeds them into
`data/official-index/`. `.github/workflows/official.yml` does both every Sunday and on demand. Official pages become
numbered sources ahead of the threads, and the prompt makes them the authority on rules while threads are the
authority on experience.

## Run locally

```bash
npm install
cp .env.example .env            # GEMINI_API_KEY at least
npm run dev                     # API on http://localhost:8787, serving dist/ when built
npx vite                        # web app with hot reload on http://localhost:5173
npm run check                   # typecheck, tests, production build
```

Without a Gemini key the API still serves the guide and keyword search. The tests run the whole API against a fake
Gemini, the board schema against PGlite, and the scraper against a fake Facebook (skipped without Playwright's Chromium).
