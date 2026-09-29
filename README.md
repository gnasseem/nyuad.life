# ROR Answers

Ask the NYU Abu Dhabi **Room of Requirement** archive. Students type a question, the backend finds the threads that
answer it (hybrid keyword + Gemini vector search), and Gemini writes a short answer that cites the actual posts.
Every citation opens the original thread with all its comments.

Three pieces live in this repository:

| Piece | Where | What it is |
| --- | --- | --- |
| Backend API | `api/`, `lib/` | Vercel serverless functions (TypeScript). Holds the Gemini key and the archive. |
| Web app | `web/` | Vite + React app for students, deployed with the API on Vercel. |
| Native app | `shared/`, `desktopApp/`, `androidApp/` | Compose Multiplatform client (desktop + Android) that talks to the same API. |

Plus two local tools: `scripts/scrape.ts` (pulls posts and comments out of the Facebook group with your own login)
and `scripts/index.ts` (embeds them with Gemini).

## 1. Deploy the backend + web app on Vercel

1. Import this repository into Vercel (Add New → Project). The `vercel.json` already sets the build (`npm run build`)
   and output (`dist/`); no framework preset is needed.
2. Add environment variables under Settings → Environment Variables:

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `GEMINI_API_KEY` | yes | Google AI Studio key. Used for embeddings, reranking and answers. |
   | `ROR_ACCESS_CODE` | recommended | A shared code students enter once. Without it the private archive is open to anyone with the URL. |
   | `GEMINI_CHAT_MODEL` | no | Defaults to `gemini-flash-latest`. |
   | `GEMINI_LITE_MODEL` | no | Defaults to `gemini-flash-lite-latest` (rerank, follow-ups, query rewriting). |
   | `GEMINI_EMBED_MODEL` / `GEMINI_EMBED_DIMENSIONS` | no | Defaults to `gemini-embedding-001` at 768 dimensions. |

3. Deploy. The build creates a keyword-only index from `data/posts.jsonl` if `data/index/` is not committed, so the
   site works immediately; commit a real index (step 3) for semantic search.

Routes: `GET /api/health`, `GET /api/home`, `GET /api/search`, `GET /api/post?id=`, `GET /api/courses`,
`POST /api/ask` (server-sent events: `status`, `sources`, `delta`, `followups`, `done`, `error`). Protected routes
need the `x-ror-code` header when `ROR_ACCESS_CODE` is set.

## 2. Scrape the whole group (runs on your laptop)

The scraper drives a real Chromium window where you are logged in as yourself. It intercepts the JSON Facebook's
own web client loads, so it does not depend on fragile page selectors, and it is incremental and resumable.

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

## 3. Embed with Gemini and publish the index

```bash
cp .env.example .env            # put GEMINI_API_KEY in it
npm run index                   # embeds only chunks that changed since the last run
git add data/index && git commit -m "Update archive index" && git push
```

`data/index/` holds `posts.json.gz`, `chunks.json.gz`, `meta.json` and `vectors.bin` (int8-quantised, about 0.8 KB per
chunk). Embedding cache files (`data/index/cache-*`) stay local so re-indexing after a new scrape only embeds new
posts. Options: `--fresh` re-embeds everything, `--limit 300` indexes only the newest 300 posts, `--batch 50 --concurrency 2`
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

## 5. Native app (Compose Multiplatform)

The desktop and Android apps are thin clients: open Settings, enter the server address (for example your Vercel URL)
and the access code, then use Ask, Browse and Courses exactly as on the web.

```bash
./gradlew :desktopApp:run        # desktop
./gradlew :shared:jvmTest        # shared unit tests
./gradlew :androidApp:installDebug   # Android, when ANDROID_HOME points at an SDK
```

Settings are stored in `~/.ror-answers/settings.properties` on desktop and in SharedPreferences on Android.

## How answers are produced

1. Follow-up questions are rewritten into standalone queries using the conversation.
2. Retrieval fuses BM25 over chunks with cosine similarity over Gemini embeddings (reciprocal-rank fusion, small recency prior).
3. The lite model scores the 40 best threads for usefulness; the strongest 6–16 become numbered sources.
4. `gemini-flash-latest` streams a Markdown answer that must cite `[n]` after each claim, tally opinions and flag stale advice.
5. In parallel, three follow-up questions are suggested.

Posts are tagged with topics (courses, professors, housing, study away, visas, jobs, …) and course codes such as
`CS-UH 1001` at index time, which powers Browse filters and the Courses page.
