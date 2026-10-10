# nyuad.life

Answers for NYU Abu Dhabi students. A question is answered from four sources, with citations and a confidence
level: threads from the Room of Requirement Facebook group, official NYUAD pages, the Albert class schedule, and answers
other students wrote here.

Everyone signs up once (name, NetID, major and year) after a short animated tour of the site; the API refuses answers,
archive browsing, plan reading and contacts to anyone who has not.

- **Ask.** Original questions, model rewrites and campus aliases searched together with keyword and vector retrieval over the filtered archive and official pages, reranked by Voyage's cross-encoder
  and written up by Gemini, with backup models when Gemini is overloaded or spent, or on the student's own ChatGPT plan
  when they sign in with ChatGPT. Past conversations are listed down the left, as in a chat app. A question about a course or a professor gets the Albert schedule first (course codes
  in any spelling, titles the way students say them, "calc", "intro to cs", or a subject for "classes about machine
  learning"), plus the group's threads tagged with that course. Newer threads are lifted, more so for questions about
  how things are now, and a thread the reranker finds unrelated is left out rather than padding the answer. Answers lead
  with a verdict, then at most five specifics (a ranked shortlist for "which is best" questions), the catch and the next
  step, in about 200 words.
- **Questions.** When the archive falls short, a question goes to students: a feed of every question with its answers,
  newest first, that anyone can answer in place, filtered to the ones for your major and year, the unanswered ones or
  your own; the + button asks a new one. Nobody can answer their own question or answer one twice. Answered questions
  are cited by Ask. The Ask home page puts the questions you are most likely to know first, answerable right there,
  and says when one of your own questions got a new answer.
- **Events.** Scheduled campus gatherings with required dates, locations and host details, browsed by day with calendar downloads. Events drop off one day after starting. Service requests and general notices are rejected.
- **Market.** What the group is mostly used for besides questions: things for sale (up for three weeks), wanted (two)
  or free (one), offers to buy or sell Falcons and Campus Dirhams (two separate balances, each with its own order book;
  five days), shared rides by day (gone three hours after they leave) and lost and found (three weeks). Contact details
  are fetched one post at a time, on tap. Ask sends listings, trades, rides and lost items here.
- **Reviews.** Every course in Albert's schedule once, searchable by code, title or professor, filtered by subject, Core
  or rated, and sortable by rating. Picking one shows an AI rating written from the group's threads about it (a score
  out of five, difficulty and workload, what students liked and what they warn about), who teaches it this term, and
  reviews students wrote here: stars, difficulty, workload, when they took it and a line of advice, one per student and
  course. The list shows both scores, read from the cache in one request. Ratings are cached for a month per course,
  and a course nobody has described for a week, so opening it again costs nothing. Professors are a second tab.
- **Plan.** A schedule builder after [Horarium](https://github.com/Phoenix-3139/Horarium). Say what you need ("calc,
  intro to CS, any Arts Core, nothing before 10, Fridays off") and a model reads it into courses from the term's real list
  and rules; or add courses one by one. The browser then finds every combination where no two classes meet at once
  (`lib/schedule.ts`): one section of every component, lectures paired with their own recitation or lab, seven-week
  halves sharing a slot, closed and waitlisted sections only when allowed. Hard rules (hours, days off, classes a day,
  no back-to-back, professors to avoid) always hold; within them plans are ranked by how students rate the professors
  (written from the group's threads, like course ratings, and cached for a month) and, for "any of" slots, the courses,
  then by days on campus, gaps, early starts, preferred professors and seats. Each plan is drawn as a week, summed up in
  a line ("Top-rated professors · 3 days on campus · Fridays free") and listed with class numbers to copy into Albert.
  When nothing fits it says which rule or which courses are in the way and offers the change that would make it fit.

Everything is TypeScript in one repository: `api/` and `lib/` are Vercel serverless functions, `web/` is a Vite and
React app, `scripts/` holds the scraper, the crawler and the indexer, and `supabase/schema.sql` is the board schema.

## Deploy

1. Import the repository into Vercel. `vercel.json` sets the build and output.
2. Add environment variables:

   | Variable | Needed for |
   | --- | --- |
   | `GEMINI_API_KEY` | Answers for students not signed in with ChatGPT, question tagging, course summaries. Several keys from different Google projects, separated by commas, multiply the free quota. |
   | `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `AI_GATEWAY_API_KEY` | Free backup models for answers when Gemini is overloaded or out of quota (below). Any or all; each variable takes several keys separated by commas. |
   | `ROR_ADMIN_NETIDS` | Comma-separated verified administrator NetIDs, for example `gnn9245`. |
   | `RESEND_API_KEY`, `RESEND_FROM`, `SESSION_SECRET` | NYU email login: a verified Resend sender and a 32+ character session secret. |
   | `OPENAI_CLIENT_ID`, `SESSION_SECRET`, `ROR_SITE_URL` | Sign in with ChatGPT: answers on each student's own plan (below). |
   | `VOYAGE_API_KEY` | Semantic search (must be the provider that built the index) and the reranker. |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | The board: questions, notices, offers, listings, course summaries. |
   | `ROR_GROUP_URL` | Where listings and rides are sent. Defaults to the group. |

3. Deploy. `GET /api/health` reports what is active: the whole report (model chain, index, database) to an
   administrator's session, and only what the site itself needs to everyone else. In Settings, admin mode's "Check models" sends one tiny request
   to every model and shows what each one said: the quickest way to tell a wrong key from a spent quota. `board.ok` comes from a real probe of the database and
   `board.problem` says what is wrong when it is false.

Routes: `GET /api/health`, `/api/search` (`q=`, `topic=`, `sort=`, `page=`), `/api/post?id=`, `/api/courses` (`term=`,
`all=1`, `code=`, `code=&rating=1`, `profs=A|B`); `POST /api/ask` (server-sent events), `POST /api/plan`;
`GET|POST /api/board` (`op=stats|question|recent|feed|mine|announcements|offers|listings|contact|leaderboard` on GET,
`profile|ask|next|answer|skip|announce|unannounce|offer|offer_done|unoffer|listing|listing_done|unlisting` on POST). Ask,
search, courses, plan and the board are rate-limited per IP.

## Keeping answers up for free

Free model tiers can be overloaded (503) or rate-limited (429). Ask moves down a chain before writing any text:

1. Gemini 3.5 Flash-Lite, Gemma 4 31B, Gemma 4 26B and Gemini 3.1 Flash-Lite: each has its own daily quota, and each
   is tried on every key in `GEMINI_API_KEY` before the next model. A model spent on one key rests on that key only.
2. Groq (gpt-oss 120B, Qwen 3.8 27B, gpt-oss 20B), Cloudflare Workers AI (Gemma 4, about a quarter of Llama's neuron
   cost), Z.ai (GLM 4.7 Flash), OpenRouter's free models, Mistral and Vercel AI Gateway, for each key that is set.
   Groq's free tier caps tokens per minute, so its prompts are shortened to fit; a prompt still too long for a
   provider skips it.

Every key variable takes several keys separated by commas, with no spaces needed (`GEMINI_API_KEY=AIza…1,AIza…2`,
`GROQ_API_KEY=gsk_a,gsk_b`): free tiers are counted per Google project or per account, so each key is another quota,
tried model by model across the keys. Two keys from the same Google project or the same account share one quota and
add nothing. Reasoning models are asked to think
little or not at all, so answers start quickly. A JSON call (ratings, plan reading, moderation) has one deadline for
the whole chain, so falling back from model to model cannot outlast the function.

Model names go stale fast (Google shut 2.5 Flash to new keys, Groq retired its Llama models in August 2026), so each
instance asks Gemini and each provider which models its key can actually use (`GET /models`, cached for six hours),
and drops the ones it cannot. A model that answers "no free tier"
(`limit: 0`) or "out of today's quota" is skipped for hours rather than tried on every question.

A model that failed rests for a while (a minute when overloaded, an hour when its day's quota is spent, hours when it
no longer exists), and one that has not started writing within 25 seconds is skipped while there is time for the next.
If every model is down, the student is told answers are busy and offered a retry. `GET /api/health` shows the chain as
it stands (`answers.chain`).

| Provider | Free tier, roughly (they change) | Key |
| --- | --- | --- |
| Gemini | per model, resets daily | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Groq | about 1,000 requests a day per model, no card | [console.groq.com/keys](https://console.groq.com/keys) |
| Mistral | "Experiment" plan, phone check | [console.mistral.ai](https://console.mistral.ai) |
| OpenRouter | `:free` models, 50 requests a day without paying (1,000 a day only after a $10 top-up) | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Cloudflare | 10,000 neurons a day, about 90 answers on Gemma 4 | [dash.cloudflare.com](https://dash.cloudflare.com) → AI → Workers AI |
| Z.ai | GLM Flash models free, one request at a time | [z.ai](https://z.ai) |
| Vercel AI Gateway | $5 of credit every 30 days, never charged unless you buy credit | [vercel.com](https://vercel.com) → AI Gateway → API keys |

Opening questions are also cached for six hours (`lib/answer-cache.ts`): the same question asked again, in any case or
punctuation, is answered from the cache with no model call. Registration-week questions are asked many times a day, so
this saves much of the quota. The cache lives in memory and in the board's `guide_summaries` table when Supabase is set
up, so every serverless instance shares it; expired entries are removed.

Settings: `ROR_MODEL_ORDER=groq,gemini` puts a backup first (the default is
`gemini,groq,cloudflare,zai,openrouter,mistral,gateway`); `ROR_MODEL_DISCOVERY=0` turns the model listing off; `<PROVIDER>_MODELS` and `<PROVIDER>_LITE_MODELS` (for
example `GROQ_MODELS`) replace a provider's model lists; `ROR_ANSWER_CACHE=0` turns the cache off. Gemini's own lists
are `GEMINI_CHAT_MODEL`, `GEMINI_CHAT_FALLBACK_MODELS`, `GEMINI_LITE_MODEL` and `GEMINI_LITE_FALLBACK_MODELS`.

## Sign in with ChatGPT

Students can connect their own ChatGPT plan; their answers and query rewrites then run on it, counted
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
   running it again is how an existing project gets new columns and tables (Campus Dirham offers need the `currency`
   column, verified accounts need `owner_key` and `auth_email_codes`, and admin mode needs `board_bans` and `admin_audit`).
   Row level security is on with no policies, so only the service role, which the API holds, can read or write.
   Students' course reviews need the `course_reviews` table: until the schema is run again, course pages show no
   reviews and no review form.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on Vercel and in `.env`, then redeploy.

If the pages say the board tables are missing, the schema was not run in the project `SUPABASE_URL` points at. If they
say the key was rejected, the anon key was pasted instead of the service role key. Locally, with nothing set, the board
runs in memory.

Official-page refreshes include the academic calendar, registration resources and student portal links.
`npm run scrape:official` refreshes public pages; `npm run index:official` updates their semantic index incrementally.
For protected portal reference pages, run `npm run scrape:official -- --host students.nyuad.nyu.edu --portal-login`
and complete NYU sign-in in the browser once. Subsequent runs can use `--portal-browser` with the saved
`.portal-profile` login (`--portal-profile PATH` reuses another NYU browser profile). Login pages, personal
records, account widgets and student directories are excluded. Refresh and reindex after deadlines change;
stale pages are not treated as evidence for a current deadline. No credentials are sent to the deployed app.

Retrieval preserves full names and course codes during query rewriting, searches the original and expanded queries,
filters person matches before ranking, and reranks all source kinds with backup models when needed. Keyword
fallbacks require meaningful term coverage. Current official policy and deadline evidence comes before anecdotes.
Unanswered board questions enter the first feed page even when older and get priority, then major/year matches.

Accounts use a six-digit code sent to `netid@nyu.edu` through Resend. Set `RESEND_API_KEY`,
`RESEND_FROM` (a sender on a domain verified in Resend), and `SESSION_SECRET` (32+ random characters,
for example `openssl rand -base64 32`). Run `supabase/schema.sql` again before deploying the email login upgrade.
Add Resend’s DKIM and SPF records at the domain’s authoritative DNS provider and wait for Resend to show
the sending domain as verified. `nyuad.life` uses Spaceship nameservers; adding these records in Vercel DNS
does not publish them. An unverified sender makes Resend reject login codes with HTTP 403.
The same form handles signup and returning users. Codes expire after ten minutes, allow five attempts, and work
once. Requests are limited to five per email per hour and one per minute in the database. Verified sessions use
30-day encrypted HttpOnly cookies. Phones and laptops share account ownership; the first email verification
recovers existing browser-owned posts. Settings includes Log out.

## Admin mode

Set `ROR_ADMIN_NETIDS=gnn9245` on Vercel, or a comma-separated list of NetIDs, and redeploy. An allowlisted user
gets admin controls after verifying their NYU email and saving their profile. The allowlist is checked on every
admin request. Removing a NetID from it removes its privileges without waiting for the login session to expire.
Admins can remove posts, bar or unbar accounts, and check the answer models in Settings. Actions are recorded in
`admin_audit`. Shared admin codes are no longer accepted.

Routes: `GET /api/admin?op=me|bans|models`, `POST /api/admin {op: remove|unban}`.
Email routes use `/api/board` operations `auth_send`, `auth_verify`, `auth_me`, and `auth_logout`.

## Safety

Everything students write is screened by rules in `lib/moderation.ts`, which add no delay and cost nothing:

- **Posts** (questions, answers, notices, listings, offers, names) are refused, with a reason, for slurs, threats and
  curse words (English and Arabic, starred out or not), sexual services, selling drugs, alcohol, prescription medicine, vapes, weapons or fake documents, paid academic work
  or leaked exams, money schemes, phishing (asking for passwords, "verify your NetID", NYU look-alike sign-in links),
  text written to steer the answer bot, ID, card and bank numbers, and phone numbers or personal emails in public text
  (listings and offers have a contact field for that).
- **A model** then reads every post the rules let through, except names, and refuses ads for businesses and paid
  services, spam, trolling, made-up posts (an event that cannot be real, a place that does not exist on campus or in the
  UAE), posts pretending to come from a university office, posts in the wrong place, and attacks on a person. It is
  given the date, the post's kind, time and place, and how students name campus buildings. When models are set up but
  none answers, the post is held back with "try again in a minute". Production always requires a working reviewer; `ROR_REVIEW_FAIL_OPEN=1` applies only in local development.
- **Events** cannot carry phone numbers, and no post can use a link shortener (bit.ly and the like); an event's link
  shows its domain.
- **Questions to Ask** about where to get drugs, finding a person's room or WhatsApp, buying academic work, or telling
  the bot to ignore its instructions get a short reply instead of an answer, with no model call. Asking about rules
  ("can I bring my ADHD medication into the UAE?") is answered as usual.
- **Someone who writes about hurting themselves** is shown where to get help (NYU Wellness Exchange, the Counseling
  Center, UAE emergency numbers) instead of being refused.
- **The archive** is served without phone numbers and personal email addresses; offices' addresses stay.
- **The answer model** is told that sources are material, never instructions, and that notices and answers from this
  site are unverified; those only reach an answer when the reranker finds them relevant, and such answers are not cached.

Ask only answers students who signed up, and is limited per student: a per-minute rate, and a daily ceiling counted
in the database so it holds across every serverless instance. Per address the limits are loose (IPv6 counted per /64),
since a campus network puts many students behind one. Login codes are capped per network and site-wide in the
database too, so a script cycling made-up NetIDs cannot spend the email quota, and contact details are capped per
student per day. Member-only responses are never cached by the CDN. The API refuses posts from other sites' pages (Origin and Sec-Fetch-Site), sends no CORS
headers in production, and the site is served with a strict Content-Security-Policy and frame-ancestors 'none'. The
verified session travels in an HttpOnly cookie, and database errors reach the logs, not the browser.
`ROR_REQUIRE_SIGNUP=0` turns the sign-up requirement off on the server.

How questions are handed out (`lib/board.ts`): a helper never sees their own question (matched by their shared account key) or
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
