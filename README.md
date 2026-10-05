# nyuad.life

Answers for NYU Abu Dhabi students. A question is answered from four sources, with citations and a confidence
level: threads from the Room of Requirement Facebook group, official NYUAD pages, the Albert class schedule, and answers
other students wrote here.

- **Ask.** Hybrid keyword and vector search over the archive and the official pages, reranked by Voyage's cross-encoder
  and written up by Gemini, with free backup models when Gemini is overloaded, or on the student's own ChatGPT plan
  when they sign in with ChatGPT. A question that names a course or a professor also gets their Albert schedule as a
  source. Answers lead with a verdict, then the specifics, the catch, what may have changed and the next step.
- **Questions.** When the archive falls short, a question goes to students. Helpers give a name, NetID, major and class
  year once, then get questions one at a time, matched by major and year. Answered questions are cited by Ask.
- **Notices.** Events, deadlines and opportunities posted by students, by day, with a calendar file for dated ones.
  Dated notices drop off the day after, undated ones after two weeks.
- **Market.** What the group is mostly used for besides questions: things for sale (up for three weeks), wanted (two)
  or free (one), offers to buy or sell Falcons and Campus Dirhams (two separate balances, each with its own order book;
  five days), shared rides by day (gone three hours after they leave) and lost and found (three weeks). Contact details
  are fetched one post at a time, on tap. Ask sends listings, trades, rides and lost items here.
- **Courses.** Every course in Albert's schedule, searchable by code, title, professor or topic and filtered by term,
  subject, open seats, Core and time of day, with each course's sections, who taught it in earlier terms, the group's
  threads about it and a cached summary of what students say. The group's threads are a second tab, searchable by
  keyword and topic with no model involved.

Everything is TypeScript in one repository: `api/` and `lib/` are Vercel serverless functions, `web/` is a Vite and
React app, `scripts/` holds the scraper, the crawler and the indexer, and `supabase/schema.sql` is the board schema.

## Deploy

1. Import the repository into Vercel. `vercel.json` sets the build and output.
2. Add environment variables:

   | Variable | Needed for |
   | --- | --- |
   | `GEMINI_API_KEY` | Answers for students not signed in with ChatGPT, question tagging, course summaries. |
   | `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY` | Free backup models for answers when Gemini is overloaded or out of quota (below). Any or all. |
   | `OPENAI_CLIENT_ID`, `SESSION_SECRET`, `ROR_SITE_URL` | Sign in with ChatGPT: answers on each student's own plan (below). |
   | `VOYAGE_API_KEY` | Semantic search (must be the provider that built the index) and the reranker. |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | The board: questions, notices, offers, listings, course summaries. |
   | `ROR_GROUP_URL` | Where listings and rides are sent. Defaults to the group. |

3. Deploy. `GET /api/health` reports what is active. `board.ok` comes from a real probe of the database and
   `board.problem` says what is wrong when it is false.

Routes: `GET /api/health`, `/api/home`, `/api/search` (`q=`, `topic=`, `sort=`, `page=`), `/api/post?id=`,
`/api/courses` (`term=`, `code=`, `code=&threads=1`, `code=&summary=1`); `POST /api/ask` (server-sent events);
`GET|POST /api/board` (`op=stats|question|recent|mine|announcements|offers|listings|contact|leaderboard` on GET,
`profile|ask|next|answer|skip|announce|unannounce|offer|offer_done|unoffer|listing|listing_done|unlisting` on POST). Ask,
search, courses and the board are rate-limited per IP.

## Keeping answers up for free

Free model tiers fail in two ways: a model is overloaded (Gemini's 503 "The model is overloaded") or its daily quota is
spent (429). Ask handles both by moving down a chain of models before it has written a word:

1. Gemini 3.5 Flash, 3 Flash and 2.5 Flash.
2. Every backup provider with a key set, each with several models: Groq, Cerebras, Mistral and OpenRouter, over the
   OpenAI-compatible API (`lib/providers.ts`). Their free tiers are counted per provider and mostly per model, so each
   key adds capacity. Groq and Cerebras cap a request at about 8,000 tokens, so the sources are cut down to fit them.
3. Gemini's Flash-Lite models, as the last resort.

A model that failed rests for a while (a minute when overloaded, an hour when its day's quota is spent, hours when it
no longer exists), and one that has not started writing within 25 seconds is skipped while there is time for the next.
If every model is down, the student is told answers are busy and offered a retry. `GET /api/health` shows the chain as
it stands (`answers.chain`).

| Provider | Free tier, roughly (they change) | Key |
| --- | --- | --- |
| Gemini | per model, resets daily | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Groq | about 1,000 requests a day per model, no card | [console.groq.com/keys](https://console.groq.com/keys) |
| Cerebras | about a million tokens a day, no card | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| Mistral | "Experiment" plan, phone check | [console.mistral.ai](https://console.mistral.ai) |
| OpenRouter | `:free` models, 50 requests a day, 1,000 after a one-time $10 top-up | [openrouter.ai/keys](https://openrouter.ai/keys) |

Opening questions are also cached for six hours (`lib/answer-cache.ts`): the same question asked again, in any case or
punctuation, is answered from the cache with no model call. Suggestions on the home page and registration-week
questions are asked many times a day, so this saves much of the quota. The cache lives in memory and in the board's
`guide_summaries` table when Supabase is set up, so every serverless instance shares it; expired entries are removed.
Follow-ups are never cached.

Settings: `ROR_MODEL_ORDER=groq,gemini` puts a backup first; `<PROVIDER>_MODELS` and `<PROVIDER>_LITE_MODELS` (for
example `GROQ_MODELS`) replace a provider's model lists; `ROR_ANSWER_CACHE=0` turns the cache off. Gemini's own lists
are `GEMINI_CHAT_MODEL`, `GEMINI_CHAT_FALLBACK_MODELS`, `GEMINI_LITE_MODEL` and `GEMINI_LITE_FALLBACK_MODELS`.

## Sign in with ChatGPT

Students can connect their own ChatGPT plan; their answers, follow-ups and query rewrites then run on it, counted
against the limit they give this site in ChatGPT, and the site's Gemini key is not used for them. It is OpenAI's Sign
in with ChatGPT: OAuth with PKCE against `auth.openai.com`, then the issued token calls `api.openai.com/v1/responses`
directly (`lib/chatgpt.ts`). Tokens are kept encrypted in an httpOnly cookie, so no database is involved.

1. Register the site with OpenAI for Sign in with ChatGPT and get its client ID. The redirect URI is
   `https://<your domain>/api/chatgpt-callback`.
2. Set `OPENAI_CLIENT_ID`, `SESSION_SECRET` (32+ random characters) and `ROR_SITE_URL` on Vercel, then redeploy. A
   "Sign in with ChatGPT" link appears under the ask box and in Settings.
3. Optional: `ROR_REQUIRE_CHATGPT=1` answers only students who connected, so the site never pays for answers; without a
   Gemini key at all, connecting is required anyway. `OPENAI_CHAT_MODELS` and `OPENAI_LITE_MODELS` pick the models.

`GET /api/health` shows whether it is on. Routes: `GET /api/chatgpt?op=start|me`, `POST /api/chatgpt {op:"logout"}`,
`GET /api/chatgpt-callback`.

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

## Scrape Albert

Classes come from Albert's Course Search, read with your own NetID in a Chromium window on your laptop.

```bash
npm run scrape:albert                       # the newest academic year
npm run scrape:albert -- --year 2025-2026   # an earlier year Albert still lists
```

Sign in when the window asks; the login is kept in `.albert-profile/`. The course search and Ask read the file directly. Every NYU Abu Dhabi subject is searched once,
and each course and term becomes a line of `data/classes.jsonl` with its sections' class numbers, times, rooms,
professors, seven-week sessions and open, closed or waitlist status. A subject's rows replace its earlier rows for the
same term and everything else is kept. The run stops if Albert ever shows a reCAPTCHA. Commit `data/classes.jsonl`
when a run finishes.

## Index

Indexing drops feed ads, Falcon and Campus Dirham trades, bare listings and noise comments (`lib/filters.ts`), then
embeds what is left.

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

1. Create a Supabase project and run the whole of `supabase/schema.sql` in its SQL editor. It is safe to run again, and
   running it again is how an existing project gets new columns (Campus Dirham offers need the `currency` column).
   Row level security is on with no policies, so only the service role, which the API holds, can read or write.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on Vercel and in `.env`, then redeploy.

If the pages say the board tables are missing, the schema was not run in the project `SUPABASE_URL` points at. If they
say the key was rejected, the anon key was pasted instead of the service role key. Locally, with nothing set, the board
runs in memory.

How questions are handed out (`lib/board.ts`): a helper never sees their own question (matched by their browser key) or
one they answered or skipped,
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

Without any model key the API still serves the course search and keyword search. The tests run the whole API against a fake
Gemini, the board schema against PGlite, and the scraper against a fake Facebook (skipped without Playwright's Chromium).
