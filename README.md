# nyuad.life

Answers for NYU Abu Dhabi students. A question is answered from four sources, with citations and a confidence
level: threads from the Room of Requirement Facebook group, official NYUAD pages, the Albert class schedule, and answers
other students wrote here.

Everyone signs up once (name, NetID, major and year) after a short animated tour of the site; the API refuses answers,
archive browsing, plan reading and contacts to anyone who has not.

- **Ask.** Original questions and focused campus aliases searched together with keyword coverage. Campus services use keyword retrieval and local passage matching; student experience questions also use archive vectors and Voyage's bounded cross-encoder, with the same bounded fallback when a keyword search finds no evidence. `ROR_RETRIEVAL=keyword` or `hybrid` forces either approach for comparison. Official retrieval keeps several candidate passages per page so an FAQ cannot hide a timetable; extracted service sidebars and reference links remain available to the answer.
  Answers are checked against supporting passages before any answer text reaches the browser. Unknown citations, invented passage references and unsupported review years are rejected; a failed check leaves the sources available with a clear verification message. Review summaries retain dates, and course-specific threads are read ahead of general professor discussions.
  Answers are written by Gemini, with backup models when Gemini is overloaded or spent, or on the student's own ChatGPT plan
  when they sign in with ChatGPT. Past conversations are listed down the left, as in a chat app. A question about a course or a professor gets the Albert schedule first (course codes
  in any spelling, titles the way students say them, "calc", "intro to cs", or a subject for "classes about machine
  learning"), plus every thread that names that course or professor the way students write it (the code, the title,
  "linalg", "MVC", "Prof Gandolfi", or a surname nobody else in the schedule or the group carries; `lib/entities.ts`),
  ranked by how much each says about it and read by the reranker ahead of keyword matches. Newer threads are lifted, more so for questions about
  how things are now, and a thread the reranker finds unrelated is left out rather than padding the answer. Answers lead
  with the answer itself, integrate drawbacks into the verdict, and use at most 110 words without forced sections.
- **Questions.** When the archive falls short, a question goes to students: a feed of every question with its answers,
  newest first, that anyone can answer in place, filtered to the ones for your major and year, the unanswered ones or
  your own; the + button asks a new one. Nobody can answer their own question or answer one twice. Answered questions
  are cited by Ask. The Ask home page puts the questions you are most likely to know first, answerable right there,
  and says when one of your own questions got a new answer.
- **Events.** Scheduled campus gatherings with required dates, locations and host details, browsed by day with calendar downloads. Events drop off one day after starting. Service requests and general notices are rejected.
- **Market.** What the group is mostly used for besides questions: things for sale (up for three weeks), wanted (two)
  or free (one), offers to buy or sell Falcons and Campus Dirhams (two separate balances, each with its own order book;
  five days) and shared rides by day (gone three hours after they leave). Contact details are fetched one post at a
  time, on tap. Lost & found posts stay up for two weeks in their own market tab. Ask routes lost-item notices here,
  while replacement and procedural questions still get an answer. Live requests go to Questions; Ask never sends students to a group chat.
- **Reviews.** Every course in Albert's schedule once, searchable by code, title or professor, filtered by subject, Core
  or rated, and sortable by rating. Picking one shows what the group said about it (a score out of five, difficulty and
  workload, what students like and what they warn about, how many posts and comments were good, bad or neutral, and the
  same split for each professor who taught it), who teaches it this term, and reviews students wrote here: stars,
  difficulty, workload, when they took it and a line of advice, one per student and course. Professors are a second
  tab. Everything shown comes from review digests built offline (below), so opening a course or professor never calls
  a model.
- **Plan.** A schedule builder after [Horarium](https://github.com/Phoenix-3139/Horarium). Choose any school or study
  away site in Albert, then say what you need ("calc, intro to CS, any Arts Core, nothing before 10, Fridays off"). A
  model reads the request against that site's real course list and rules. Students compare its course options with Albert
  descriptions before building the week, or add a course from its page in Reviews. The week's rules (local class hours,
  teaching days, days off, classes a day, shape, breaks,
  waitlists) are set beside the courses. The browser then finds every combination where no two classes meet at once
  (`lib/schedule.ts`): one section of every component, lectures paired with their own recitation or lab, seven-week
  halves sharing a slot, closed and waitlisted sections only when allowed. Hard rules (hours, days off, classes a day,
  no back-to-back, professors to avoid) always hold; within them plans are ranked by how students rate the professors
  (from the same review digests as Reviews) and, for "any of" slots, the courses,
  then by days on campus, gaps, early starts, preferred professors and seats. Each plan is drawn as a week, summed up in
  a line ("Top-rated professors · 3 days on campus · Fridays free") and listed with class numbers to copy into Albert.
  When nothing fits it says which rule or which courses are in the way and offers the change that would make it fit.

Everything is TypeScript in one repository: `api/` and `lib/` are Vercel serverless functions, `web/` is a Vite and
React app, `scripts/` holds the scraper, the crawler and the indexer, and `supabase/schema.sql` is the board schema.
The group archive and its search index are not in the repository (see "Data and privacy").

## Data and privacy

- **Where the data comes from.** The archive is posts and comments from the Room of Requirement, the NYU Abu Dhabi
  student Facebook group, read by `scripts/scrape.ts` from the group as a member sees it. Official pages
  (`data/official.jsonl`) and the Albert class schedule (`data/classes.jsonl`) are public university pages and stay in
  the repository.
- **Where it is kept.** The posts (`posts.jsonl`) and the search index built from them live in a private Vercel Blob
  store, never in git; the build pulls the index from there. Phone numbers and personal email addresses are taken out
  before anything is served.
- **Who sees it.** Only signed-in NYU Abu Dhabi students: an account needs a code sent to a `@nyu.edu` address, and
  the API refuses answers and archive browsing to anyone without one.
- **Removing your posts.** Email gnn9245@nyu.edu from your NYU address with a link to the post, or ask for everything
  you wrote, and it is taken out within a week. Removals are kept in `removed.json` in the private store (post ids and
  author names): `npm run archive -- pull posts`, add the entry to `data/removed.json`
  (`{"posts": ["<id>"], "authors": ["<name>"]}`), `npm run archive -- push removed`, then run the index workflow and
  deploy. A listed author's posts and comments are left out of every index from then on, even when the scraper reads
  them again.

## Deploy

1. Import the repository into Vercel. `vercel.json` sets the build and output.
2. Add environment variables:

   | Variable | Needed for |
   | --- | --- |
   | `GEMINI_API_KEY` | Answers for students not signed in with ChatGPT, question tagging, course summaries. Several keys from different Google projects, separated by commas, multiply the free quota. |
   | `ZAI_API_KEY`, `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `AI_GATEWAY_API_KEY` | Backup models when Gemini is overloaded or out of quota (below). Any or all; each variable takes several keys separated by commas, subject to shared account limits. |
   | `ROR_ADMIN_NETIDS` | Comma-separated verified administrator NetIDs, for example `gnn9245`. |
   | `RESEND_API_KEY`, `RESEND_FROM`, `SESSION_SECRET` | NYU email login: a verified Resend sender and a 32+ character session secret. |
   | `OPENAI_CLIENT_ID`, `SESSION_SECRET`, `ROR_SITE_URL` | Sign in with ChatGPT: answers on each student's own plan (below). |
   | `VOYAGE_API_KEY` | Semantic search (must be the provider that built the index) and the reranker. |
   | `BLOB_READ_WRITE_TOKEN` | The private Blob store holding the archive and its index, which the build pulls. Connecting a private Blob store to the project sets it. |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | The board: questions, notices, offers, listings, course summaries. |

3. Deploy. `GET /api/health` reports what is active: the whole report (model chain, index, database) to an
   administrator's session, and only what the site itself needs to everyone else. In Settings, admin mode's "Check models" sends one tiny request
   to every model and shows what each one said: the quickest way to tell a wrong key from a spent quota. "Model keys"
   below it shows what every key did today across all instances (calls that worked and failed per model, the last
   error, and the requests left when the provider says, as Groq does), its free tier, and the week's totals. `board.ok`
   comes from a real probe of the database and `board.problem` says what is wrong when it is false.

Routes: `GET /api/health`, `/api/search` (`q=`, `topic=`, `sort=`, `page=`), `/api/post?id=`, `/api/courses` (`term=`,
`all=1`, `code=`, `code=&rating=1`, `profs=A|B`, `ratings=1`); `POST /api/ask` (server-sent events), `POST /api/plan`;
`GET|POST /api/board` (`op=stats|question|recent|feed|mine|announcements|offers|listings|contact|leaderboard` on GET,
`profile|ask|next|answer|skip|announce|unannounce|offer|offer_done|unoffer|listing|listing_done|unlisting` on POST). Ask,
search, courses, plan and the board are rate-limited per IP.

## Keeping answers up for free

Free model tiers can be overloaded (503), rate-limited (429) or just slow. Ask moves down a chain before writing any
text, and does not wait on a slow model: when the model writing an answer has not written a word within three and a
half seconds, the next one starts beside it (at most three at once) and the first to write wins, the others are
stopped. A model beaten that way is left out of the chain for ten minutes, so the next questions go straight to the
quicker one.

1. Gemini 3.5 Flash-Lite and Gemini 3.1 Flash-Lite, the models that answered the production probe. Each is tried on
   every configured key before the next model; keys from the same Google project share its quota.
2. Groq (gpt-oss 120B, Qwen 3.8 27B, gpt-oss 20B), then Cloudflare Workers AI (gpt-oss 120B, GLM 4.7 Flash).
3. Z.ai's free GLM 4.7 Flash. It repeatedly exceeded the answer hedge in the production probe, so it follows the
   faster options. The router allows one local request per key and skips busy keys, including the last fallback.
   A concurrency error from another instance rests the key for 15 seconds.
4. OpenRouter's free models (Nemotron, gpt-oss), Mistral and Vercel AI Gateway. Groq's free tier caps
   tokens per minute, so its prompts are shortened to fit; a prompt still too long for a provider skips it.

Gemma is not called anywhere: on Gemini's and OpenRouter's free tiers it accepted requests and never answered, so every
question waited out a timeout before moving on. Built-in lists leave it out and a listing that offers it as a stand-in
is ignored; only a model list set in the environment can name it.

Query rewrites, follow-ups, model reranking, moderation and plan reading prefer Groq's gpt-oss 20B, then Gemini
Flash-Lite, Cloudflare's gpt-oss 20B, Z.ai, Mistral, OpenRouter and Gateway. This saves the larger answer models and
OpenRouter's small daily allowance. Explicit provider order
overrides still apply; `ROR_LITE_MODEL_ORDER` can override only the small tasks.

Small text calls and JSON calls up to 1K output tokens start a second provider after 1.5 seconds of silence;
larger JSON calls hedge after six seconds. At most two providers race. Each backup model gets 2.5 seconds
for a small task or eight for larger outputs, within the provider step and overall deadline. Empty,
malformed or truncated JSON falls through to the next model. Plan reading keeps its requested 4K output allowance,
instead of inheriting the shorter prose-answer cap.

Instances also learn from each other: every couple of minutes each one reads today's usage (below) and rests the
models and keys that failed elsewhere and have not worked since (a spent Gemini model, a refused key, a retired
model), from when the failure happened, so a fresh instance does not spend its first questions finding out again.

Every key variable takes several keys separated by commas, with no spaces needed (`GEMINI_API_KEY=AIza…1,AIza…2`,
`GROQ_API_KEY=gsk_a,gsk_b`), tried model by model across the keys. Quotas belong to Google projects, organizations or
accounts; rotating keys in the same quota pool adds no capacity. Reasoning models are asked to think
little or not at all, so answers start quickly. A JSON call (ratings, plan reading, moderation) has one deadline for
the whole chain, so falling back from model to model cannot outlast the function.

Model names go stale fast (Google shut 2.5 Flash to new keys, Groq retired its Llama models in August 2026), so each
instance asks Gemini and each provider which models its key can actually use (`GET /models`, cached for six hours),
and drops the ones it cannot. A model that answers "no free tier"
(`limit: 0`) or "out of today's quota" is skipped for hours rather than tried on every question.

A model that failed rests for a while (usually a minute when overloaded, an hour when its day's quota is spent, hours
when it no longer exists), and one that has not started writing within 15 seconds is given up on while there is time
for the next. `Retry-After` durations and HTTP dates are honored. OpenRouter platform limits rest every model on the key;
upstream limits rest only the affected model. OpenRouter and Cloudflare daily exhaustion rests until midnight UTC
unless the provider supplies a reset. A spent credit balance rests the whole key. Groq response headers supply both
daily request counts and a minute token budget, so calls that cannot fit are skipped without another network request.
Daily header values are retained even on errors. Known exhausted answer models are never revived just because every
other model is resting. Model discovery and shared-usage learning wait at most 250ms on user requests (admin checks
can wait longer).
If every model is down, the student is told answers are busy and offered a retry, and every NetID on
`ROR_ADMIN_NETIDS` gets an email at its NYU address (through Resend, the login sender) saying what each key did today;
at most one every three hours. Settings has a button to send a test. `GET /api/health` shows the chain as it stands
(`answers.chain`).

Every model call is counted in `lib/model-usage.ts`: each instance keeps its counts in memory and saves them after
each response as its own row in `guide_summaries` (`models:usage:<day>:<instance>`), so no schema change is needed and
instances never overwrite each other. Rows older than eight days are removed.

| Provider | Free tier, roughly (they change) | Key |
| --- | --- | --- |
| Gemini | per model/project; RPM, input TPM and RPD; daily reset at midnight Pacific; active amounts in AI Studio | [limits](https://ai.google.dev/gemini-api/docs/rate-limits) |
| Groq | current gpt-oss/Qwen defaults: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD per model, organization-wide | [limits and reset headers](https://console.groq.com/docs/rate-limits) |
| Mistral | Free mode; included usage and per-model TPS/TPM limits belong to the organization and vary | [usage and limits](https://docs.mistral.ai/admin/billing-usage/usage-limits) |
| OpenRouter | `:free` models typically 50 requests/day, 1,000 after the qualifying credit purchase; account-wide, actual counter in `GET /api/v1/key` | [limits](https://openrouter.ai/docs/api_reference/limits) |
| Cloudflare | 10,000 neurons/day/account across models; reset 00:00 UTC; answers per day depend on model and token lengths | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Z.ai | GLM 4.7 Flash and 4.5 Flash free; actual concurrency/rate limits depend on the account | [pricing](https://docs.z.ai/guides/overview/pricing), [error codes](https://docs.z.ai/api-reference/api-code) |
| Vercel AI Gateway | $5/month for free-tier accounts; purchasing credits ends the monthly free credit | [pricing](https://vercel.com/docs/ai-gateway/pricing) |

Limits checked against official documentation on 2026-10-15. Production keys are non-exportable Vercel secrets, so
local tests use fake providers; an administrator can run Settings → Check models for current live latency and availability.

Opening questions are also cached for six hours (`lib/answer-cache.ts`): the same question asked again, in any case or
punctuation, is answered from the cache with no model call. Registration-week questions are asked many times a day, so
this saves much of the quota. The cache lives in memory and in the board's `guide_summaries` table when Supabase is set
up, so every serverless instance shares it; expired entries are removed.

Settings: `ROR_MODEL_ORDER=zai,gemini` puts GLM before Gemini (the default is
`gemini,groq,cloudflare,zai,openrouter,mistral,gateway`); `ROR_LITE_MODEL_ORDER` selects a separate small-task order;
`ROR_MODEL_DISCOVERY=0` turns the model listing off; `<PROVIDER>_MODELS` and `<PROVIDER>_LITE_MODELS` (for
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
`--delay 2`, `--chrome`, `--debug`.

The archive is not in git: it lives in the project's private Vercel Blob store. `vercel env pull --global-config
~/.vercel-nyuad` writes the store's `BLOB_READ_WRITE_TOKEN` to `.env.local`; then `npm run archive -- pull posts` before
a scrape and `npm run archive -- push posts` after it (a file with fewer posts than the store's is refused without
`--force`). The scraper will not start without `data/posts.jsonl` unless given `--new-archive`. `npm run scrape:publish`
does all of it: pulls, scrapes new comments, pushes, runs the index workflow, deploys and checks production.

## Scrape Albert

Classes come from Albert's Course Search, read with your own NetID in a Chromium window on your laptop.

```bash
npm run scrape:albert                       # the newest academic year
npm run scrape:albert -- --all               # every school in Albert's selector
npm run scrape:albert -- --year 2025-2026   # an earlier year Albert still lists
```

Sign in when the window asks; the login is kept in `.albert-profile/`. The course search and Ask read the file directly. Each selected school's subjects are searched once,
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

Automatic: add the key and `BLOB_READ_WRITE_TOKEN` as repository secrets. Every push to `main` that changes `lib/`,
and every `npm run scrape:publish`, runs `.github/workflows/index.yml`, which pulls the posts and the last index from
the Blob store, embeds only the chunks that changed and pushes the new index back. The build (`npm run build`) pulls
the index from the store into `data/index/`, so the next deploy serves it. The same embedding key must be set on Vercel
so questions can be embedded.

Manual: `cp .env.example .env`, add the key, `npm run archive -- pull posts`, `npm run index`, `npm run archive -- push
index`. Options: `--provider`, `--fresh`, `--limit 300`, `--no-embed`.

Nothing built from the posts may be committed: `.gitignore` leaves out `data/posts*.jsonl`, `data/index/`,
`data/removed.json` and `data/scrape-state.json`, and `.github/workflows/no-archive.yml` fails any push or pull request
whose tree or history holds one of them.

## Course and professor reviews

`npm run reviews` (scripts/reviews.ts) reads every archive thread that names a NYUAD course (by code, title or
nickname) or professor (lib/entities.ts) and records one mention for each post or comment that says what taking the
course or being taught by the professor is like: its sentiment, the professor or course it pairs with, a term,
difficulty and workload when stated, and a short paraphrase without the student's name. Each mention counts as one
rating. Mentions go into `review_mentions`, and the posts and comments read into `review_threads`. Then each course and
professor with new mentions, or new reviews written here, gets its `review_digests` row brought up to date: counts,
a score where a rating two years old weighs half as much as one from today, difficulty, workload, the per-professor
(or per-course) split, and a verdict, likes and warnings that a model folds forward from the old ones with only the
new mentions. Courses go under the code they carry now, so "MATH-UH 1012Q" and "MATH-UH 1012" share one.

The model keys live on Vercel, so the work normally runs there: `npm run reviews -- --remote https://www.nyuad.life`
starts one slice at a time (`POST /api/admin` with `op=reviews`, about three and a half minutes of reading each,
inside the function's five-minute limit) until nothing is left. It authenticates with a token derived from the
Supabase service key (`reviewsJobToken` in lib/reviews.ts), so it needs only `SUPABASE_SERVICE_ROLE_KEY` in `.env`, or
`REVIEWS_JOB_TOKEN` (a GitHub Actions secret) in CI. Plain `npm run reviews` runs it on this machine instead, with
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, the archive's index (`npm run archive -- pull index`) and free model keys.
`REVIEWS_MODELS` names the providers it may call, in order (default `zai,groq,cloudflare,mistral`: GLM first; Gemini and
OpenRouter are left to Ask unless named).

Work is saved thread by thread, so it can be stopped, crash or run out of quota at any point and the next run carries
on; a second run straight after a finished one makes no model calls. Digests are folded only once every thread is
read. `--minutes N` stops it starting new work after N minutes, `--workers N` sets how many calls run at once, and
`--limit N` reads only the N newest unread threads (one slice with `--remote`). The index workflow starts it after
every index build, and `npm run scrape:publish` again after its deploy, so a scrape updates the reviews by itself.

## The board

1. Create a Supabase project and run the whole of `supabase/schema.sql` in its SQL editor. It is safe to run again, and
   running it again is how an existing project gets new columns and tables (Campus Dirham offers need the `currency`
   column, verified accounts need `owner_key` and `auth_email_codes`, admin mode needs `board_bans` and `admin_audit`, and
   course and professor ratings need `review_mentions`, `review_threads` and `review_digests`).
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
and complete NYU sign-in in the browser once. Subsequent runs can use `--portal-browser --browser-channel chrome` with the saved
`.portal-profile` login (`--portal-profile PATH` reuses another NYU browser profile). Login pages, personal
records, account widgets and student directories are excluded. Refresh and reindex after deadlines change;
stale pages are not treated as evidence for a current deadline. No credentials are sent to the deployed app. Authenticated crawls prioritize shared services and discover navigation links as well as article links. Dining counter tables keep their venue, day and posted term; linked reference timetables are extracted with `pdftotext` (install Poppler locally). Public CI refreshes retain protected snapshots and warn when they cannot refresh them.

Retrieval preserves full names and course codes during query rewriting, searches the original and expanded queries
(opening questions need no rewrite model call), keeps only threads naming the person asked about (full name, a
surname no other professor or group member carries, or "Prof <surname>"; never a first name alone), and reranks all
source kinds with a bounded cross-encoder call, falling back to local term coverage and proximity. Threads naming the course or person asked about clear the reranker on a
lower bar, since "thoughts on Gandolfi?" with five replies is the review a student wants. Keyword
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
Admins can remove posts and bar or unbar accounts from any page; actions are recorded in `admin_audit`. Shared admin
codes are no longer accepted.

The admin page (`/admin`, the Admin badge in the bar) has four tabs:

- **Usage:** members, members active today, sign-ups, requests and Ask answers today on a departure board; active
  members, sign-ups and requests per day for 30 days; requests by hour today; what students did (Ask answers, cached and
  failed, questions to students, answers, reviews, plans, ratings, listings, offers, events, logins, sign-ups) today,
  this week and this month; the busiest routes with their average time and failures; and what is on the board.
- **Members:** the newest members with when they joined and were last seen, and the spread of majors and years.
- **Models:** what every model key did today, the model check, and the outage email test.
- **Moderation:** barred accounts and the latest admin actions.

Sign-ups and "last seen" come from `board_profiles` (`created_at`, and `last_seen_at`, which opening the site updates at
most every half hour). Requests, active members per day and what students did are counted in `lib/app-usage.ts` like the
model usage: each instance counts in memory and saves its own row per day in `guide_summaries`
(`app:usage:<day>:<instance>`), at most every 15 seconds, with members and devices kept as short keyed hashes. Rows are
kept 60 days. No schema change is needed.

Routes: `GET /api/admin?op=me|stats|audit|bans|models|usage`, `POST /api/admin {op: remove|unban|alert-test}`.
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
