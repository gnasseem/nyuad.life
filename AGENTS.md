# Git and deployment

- Commit completed changes, then deploy to production with `vercel deploy --prod --yes --global-config ~/.vercel-nyuad` from the
  repository root and verify the live site. The project (`nyuad.life`, team `george-s-projects-730f`) lives on its own Vercel
  account; `~/.vercel-nyuad` holds that account's CLI login, so the default login can stay on another account. Pass the same
  `--global-config` to every `vercel` command here (`vercel env ls`, `vercel logs`, …).
- Always deploy after a commit. Do not stop at the commit.
- Never push unless the user asks.
