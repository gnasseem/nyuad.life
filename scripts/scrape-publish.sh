#!/usr/bin/env bash
# Scrapes new comments, pushes the archive to the private Blob store, has the index workflow embed it, then deploys,
# checks that production serves the new index, and has the site read the new threads into the course and professor
# reviews. The archive never goes into git.
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "$(git branch --show-current)" != main || -n "$(git status --porcelain)" ]]; then
  echo 'Start with a clean checkout on main.' >&2
  exit 1
fi
git fetch origin
git merge --ff-only origin/main

npm run archive -- pull posts
cp data/posts.jsonl data/posts.jsonl.before
npm run scrape -- --only-comments "$@"
if cmp -s data/posts.jsonl data/posts.jsonl.before; then
  rm data/posts.jsonl.before
  echo 'The scraper saved no archive changes.'
  exit 0
fi
rm data/posts.jsonl.before
npm run archive -- push posts

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gh workflow run index.yml --ref main
run_id=''
for ((attempt = 0; attempt < 30; attempt++)); do
  run_id="$(gh run list --workflow index.yml --event workflow_dispatch --created ">=$started" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 5
done
if [[ -z "$run_id" ]]; then
  echo 'The search index workflow did not start.' >&2
  exit 1
fi
gh run watch "$run_id" --exit-status

rm -rf data/index
npm run archive -- pull index
vercel deploy --prod --yes --global-config ~/.vercel-nyuad
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const expected = JSON.parse(readFileSync('data/index/meta.json', 'utf8'));
const response = await fetch('https://www.nyuad.life/api/health');
const health = await response.json();
if (!response.ok || !health.ok || health.archive?.posts !== expected.posts || health.archive?.newestPost !== expected.newestPost) {
  throw Error('Production did not serve the new search index.');
}
console.log(`Live archive: ${expected.posts} posts, newest ${expected.newestPost}.`);
JS
npm run reviews -- --remote https://www.nyuad.life
