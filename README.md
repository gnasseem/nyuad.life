# ROR Answers

Ask the NYU Abu Dhabi **Room of Requirement** archive. Students type a question, the backend finds the threads that
answer it (hybrid keyword + Gemini vector search), and Gemini writes a short answer that cites the actual posts.
Every citation opens the original thread with all its comments.

Everything is TypeScript, in one repository:

| Piece | Where | What it is |
| --- | --- | --- |
| Backend API | `api/`, `lib/` | Vercel serverless functions. Holds the Gemini key and the archive. |
| Web app | `web/` | Vite + React app for students. Installs to the phone home screen like a native app. |
| Scraper | `scripts/scrape.ts` | Pulls posts and comments out of the Facebook group with your own login (runs on your laptop). |
| Indexer | `scripts/index.ts`, `.github/workflows/index.yml` | Embeds posts with Gemini, locally or automatically in GitHub Actions. |

## 1. Deploy on Vercel

1. Import this repository into Vercel (Add New → Project). `vercel.json` already sets the build and output; no
   framework preset is needed.
2. Add environment variables under Settings → Environment Variables:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | yes | Google AI Studio key. Used for embeddings, reranking and answers. |
   | `ROR_ACCESS_CODE` | recommended | A password you make up. Students type it once; without it anyone with the URL can read the private group's content and spend your Gemini quota. |
   | `GEMINI_CHAT_MODEL` | no | Defaults to `gemini-flash-latest`. |
   | `GEMINI_LITE_MODEL` | no | Defaults to `gemini-flash-lite-latest` (rerank, follow-ups, query rewriting). |
   | `GEMINI_EMBED_MODEL` / `GEMINI_EMBED_DIMENSIONS` | no | Defaults to `gemini-embedding-001` at 768 dimensions. |

3. Deploy. If `data/index/` is not committed yet, the build makes a keyword-only index from `data/posts.jsonl`, so the
   site works immediately; semantic search switches on as soon as an embedded index is committed (section 3).

Routes: `GET /api/health`, `GET /api/home`, `GET /api/search`, `GET /api/post?id=`, `GET /api/courses`,
`POST /api/ask` (server-sent events: `status`, `sources`, `delta`, `followups`, `done`, `error`). Protected routes
need the `x-ror-code` header when `ROR_ACCESS_CODE` is set; the web app adds it after the student enters the code.

## 2. Scrape the whole group (runs on your laptop)

The scraper drives a real Chromium window where you are logged in as yourself. It reads the JSON Facebook's own
web client loads, so it does not depend on fragile page selectors, and it is incremental and resumable.

```bash
npm install
npx playwright install chromium
npm run scrape -- --full        # first time: walk the group back to its first post (hours; leave it running)
npm run scrape                  # later: only new posts and threads whose comment counts changed
```

- A window opens on facebook.com. Log in once; the profile is kept in `.scraper-profile/` (git-ignored).
- Progress is saved to `data/posts.jsonl` every 10 threads and on Ctrl+C. Re-running resumes.
- `--only-comments` revisits threads that are missing comments. `--max-posts 200` limits a run.
  `--debug` dumps raw responses to `.scraper-debug/` if Facebook changes something and captures look wrong.
- Keep the pace polite (`--delay 2` doubles all waits). This is your personal export of a group you belong to;
  don't share the raw file outside the community.

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
cp .env.example .env            # GEMINI_API_KEY (and optionally ROR_ACCESS_CODE)
npm run dev                     # API on http://localhost:8787 (serves dist/ too, if built)
npx vite                        # web app with hot reload on http://localhost:5173, proxying /api
npm run check                   # typecheck + tests + production build
```

Without a Gemini key the API still serves browsing and keyword search; asking needs the key.

## 5. Install it as an app

On a phone, open the site and choose "Add to Home Screen" (Safari share menu on iOS, browser menu on Android). It
opens full-screen with its own icon, and the app shell keeps working on flaky wifi. Desktop Chrome and Edge offer
"Install" in the address bar.

## How answers are produced

1. Follow-up questions are rewritten into standalone queries using the conversation.
2. Retrieval fuses BM25 over chunks with cosine similarity over Gemini embeddings (reciprocal-rank fusion, small recency prior).
3. The lite model scores the 40 best threads for usefulness; the strongest 6–16 become numbered sources.
4. `gemini-flash-latest` streams a Markdown answer that must cite `[n]` after each claim, tally opinions and flag stale advice.
5. In parallel, three follow-up questions are suggested.

Posts are tagged with topics (courses, professors, housing, study away, visas, jobs, …) and course codes such as
`CS-UH 1001` at index time, which powers Browse filters and the Courses page.
