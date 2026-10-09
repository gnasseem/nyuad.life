#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "$(git branch --show-current)" != main || -n "$(git status --porcelain)" ]]; then
  echo 'Start with a clean checkout on main.' >&2
  exit 1
fi
git fetch origin
git merge --ff-only origin/main

npm run scrape -- --only-comments "$@"
if git diff --quiet -- data/posts.jsonl; then
  echo 'The scraper saved no archive changes.'
  exit 0
fi

git add data/posts.jsonl
git commit -m 'Add newly captured group comments'
git push origin main
revision="$(git rev-parse HEAD)"

run_id=''
for ((attempt = 0; attempt < 30; attempt++)); do
  run_id="$(gh run list --workflow index.yml --commit "$revision" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
  [[ -n "$run_id" ]] && break
  sleep 5
done
if [[ -z "$run_id" ]]; then
  echo 'The search index workflow did not start.' >&2
  exit 1
fi
gh run watch "$run_id" --exit-status
git fetch origin
git merge --ff-only origin/main

if git diff --quiet "$revision" HEAD -- data/index; then
  echo 'The indexed archive did not change, so the live search data is already current.'
  exit 0
fi

npm run build
vercel --prod --yes
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
const expected = JSON.parse(readFileSync('data/index/meta.json', 'utf8'));
const response = await fetch('https://www.nyuad.life/api/health');
const health = await response.json();
if (!response.ok || !health.ok || health.archive?.builtAt !== expected.builtAt) {
  throw Error('Production did not serve the new search index.');
}
console.log(`Live archive: ${health.archive.posts} posts, ${health.archive.comments} useful comments.`);
JS
