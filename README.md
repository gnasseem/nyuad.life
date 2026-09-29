# ROR Answers

Ask the NYU Abu Dhabi **Room of Requirement** archive. Students type a question, the backend finds the threads that
answer it (hybrid keyword + Gemini vector search), and Gemini writes a short answer that cites the actual posts.
Every citation opens the original thread with all its comments. The site is open: no login and no access code.

Everything is TypeScript, in one repository:

| Piece | Where | What it is |
| --- | --- | --- |
| Backend API | `api/`, `lib/` | Vercel serverless functions. Holds the Gemini key and the archive. |
| Web app | `web/` | Vite + React website for students; works on phones and laptops. |
| Scraper | `scripts/scrape.ts` | Pulls posts and comments out of the Facebook group with your own login (runs on your laptop). |
| Indexer | `scripts/index.ts`, `.github/workflows/index.yml` | Embeds posts with Gemini, locally or automatically in GitHub Actions. |

## 1. Deploy on Vercel

1. Import this repository into Vercel (Add New → Project). `vercel.json` already sets the build and output; no
   framework preset is needed.
2. Add environment variables under Settings → Environment Variables:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | yes | Google AI Studio key. Used for embeddings, reranking and answers. |
   | `GEMINI_CHAT_MODEL` | no | Defaults to `gemini-flash-latest`. |
   | `GEMINI_LITE_MODEL` | no | Defaults to `gemini-flash-lite-latest` (rerank, follow-ups, query rewriting). |
   | `GEMINI_EMBED_MODEL` / `GEMINI_EMBED_DIMENSIONS` | no | Defaults to `gemini-embedding-001` at 768 dimensions. |

3. Deploy. If `data/index/` is not committed yet, the build makes a keyword-only index from `data/posts.jsonl`, so the
   site works immediately; semantic search switches on as soon as an embedded index is committed (section 3).

Routes: `GET /api/health`, `GET /api/home`, `GET /api/search`, `GET /api/post?id=`, `GET /api/courses`,
`POST /api/ask` (server-sent events: `status`, `sources`, `delta`, `followups`, `done`, `error`). Asking is
rate-limited per IP so one visitor cannot burn through the Gemini quota.

## 2. Scrape the whole group (runs on your laptop)

The scraper drives a real Chromium window where you are logged in as yourself. It reads the JSON Facebook's own
web client loads, so it does not depend on fragile page selectors, and it is incremental and resumable.

```bash
npm install
npx playwright install chromium
npm run scrape -- --login       # optional: just open the window, log in once, and exit
npm run scrape -- --full        # first time: walk the group back to its first post (hours; leave it running)
npm run scrape                  # later: only new posts and threads whose comment counts changed
```

What to expect:

- A window opens on facebook.com. Log in there (codes, "save this browser?" and so on are fine); the scraper waits
  up to 30 minutes and carries on by itself once it can see the group. The login is kept in `.scraper-profile/`
  (git-ignored), so you only do this once.
- After the first scroll the scraper knows the request Facebook's client uses to load more posts and asks for the
  next pages itself, cursor by cursor. That is much faster than scrolling and does not slow down as the page grows.
  If Facebook refuses, it falls back to scrolling.
- Progress is saved every few minutes, every 10 threads and on Ctrl+C. An interrupted `--full` run continues from
  where it stopped the next time you run `--full` (new posts at the top are picked up first). `--restart-feed`
  starts again from the newest post.
- Comments are collected by opening each thread and expanding it. Threads that still look incomplete after two
  visits (Facebook counts deleted comments) are skipped until you run `--only-comments`.

Options: `--max-posts 200` limits a run, `--no-comments` skips threads, `--delay 2` doubles every wait (gentler
on Facebook), `--chrome` drives your installed Google Chrome instead of Playwright's Chromium, `--debug` dumps raw
responses to `.scraper-debug/` if Facebook changes something and captures look wrong. `ROR_BROWSER_EXECUTABLE`
points at a specific Chrome/Chromium binary. This is your personal export of a group you belong to; don't share the
raw file outside the community.

When a run finishes, commit and push `data/posts.jsonl`.

## 3. Embedding (semantic search)

Keyword search finds posts that contain your words. Embeddings let the search understand meaning, so
"who is chill for calc" still finds "Dania is very relaxed about deadlines". Embedding the archive is a one-off job
per post, so it runs separately from deploys and only new posts are embedded each time.

**Automatic (recommended):** add a repository secret `GEMINI_API_KEY` on GitHub (Settings → Secrets and variables →
Actions). From then on, every push that changes `data/posts.jsonl` runs `.github/workflows/index.yml`, which embeds
the new posts and commits `data/index/`. Vercel redeploys with it.

**Manual:**

```bash
cp .env.example .env            # put GEMINI_API_KEY in it
npm run index                   # embeds only chunks that changed since the last run
git add data/index && git commit -m "Update archive index" && git push
```

`data/index/` holds `posts.json.gz`, `chunks.json.gz`, `meta.json` and `vectors.bin` (int8-quantised, about 0.8 KB per
chunk). Options: `--fresh` re-embeds everything, `--limit 300` indexes only the newest 300 posts, `--batch 50 --concurrency 2`
tune throughput against your Gemini quota (429s are retried automatically with the delay Google asks for).

## 4. Run everything locally

```bash
npm install
cp .env.example .env            # GEMINI_API_KEY
npm run dev                     # API on http://localhost:8787 (serves dist/ too, if built)
npx vite                        # web app with hot reload on http://localhost:5173, proxying /api
npm run check                   # typecheck + tests + production build
```

Without a Gemini key the API still serves browsing and keyword search; asking needs the key. The test suite includes
an end-to-end run of the scraper against a fake Facebook (`scripts/fake-facebook.ts`); it needs the Playwright
Chromium and skips itself when that is not installed.

## How answers are produced

1. Follow-up questions are rewritten into standalone queries using the conversation.
2. Retrieval fuses BM25 over chunks with cosine similarity over Gemini embeddings (reciprocal-rank fusion, small recency prior).
3. The lite model scores the 40 best threads for usefulness; the strongest 6–16 become numbered sources.
4. `gemini-flash-latest` streams a Markdown answer that must cite `[n]` after each claim, tally opinions and flag stale advice.
5. In parallel, three follow-up questions are suggested.

Posts are tagged with topics (courses, professors, housing, study away, visas, jobs, …) and course codes such as
`CS-UH 1001` at index time, which powers Browse filters and the Courses page.
