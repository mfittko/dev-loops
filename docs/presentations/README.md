# Presentation decks

Public-audience talks on dev-loops. Each deck has a Slidev source (`*-presentation.md`)
and a self-contained, CSP-safe HTML render (`*.html`) — the HTML is the source of
truth for publishing.

| Deck | HTML render | Topic |
| --- | --- | --- |
| Applied dev-loops — Eliminating Coordination Delay | [`applied-dev-loops.html`](applied-dev-loops.html) | Turning review/merge handoffs into a parallel, fail-closed pipeline. |
| Process Observability — Make the Waiting Visible | [`process-observability.html`](process-observability.html) | Measuring how long work waits, not how fast you write code. |

The self-contained `.html` files inline all CSS and diagrams (no Slidev runtime,
no CDN, no remote resources) and ship a strict `Content-Security-Policy`, so they
open directly in a browser and publish as static files.

## View locally

Open the HTML file directly:

```sh
open docs/presentations/applied-dev-loops.html   # macOS
```

Or serve the assembled site (mirrors what GitHub Pages publishes):

```sh
node scripts/pages/build-site.mjs          # writes ./site/ (gitignored)
npx http-server site                       # or: python3 -m http.server -d site
```

`scripts/pages/build-site.mjs` copies the deck HTML into `site/` and generates
`site/index.html` linking both decks. `site/` is assembled, never hand-maintained,
and is gitignored — only the script and workflow are committed.

## GitHub Pages deploy

`.github/workflows/pages.yml` runs the standard Pages pipeline
(`configure-pages` + `upload-pages-artifact` + `deploy-pages`):

- The **build** job assembles `site/` via the build script and uploads the
  artifact (`upload-pages-artifact`).
- The **deploy** job runs `configure-pages` + `deploy-pages` on every push to
  `main` (scoped via `if: github.ref == 'refs/heads/main'`), so a merge
  **auto-publishes**. A manual `workflow_dispatch` deploys only when run against
  `main`; dispatching any other branch/tag still builds but skips deploy. The
  published URL appears on the deploy job and the Pages settings page.

Pages is enabled (repo **Settings → Pages → Source: GitHub Actions**), so no
manual step is needed — merging to `main` deploys. The audience is public.

### Private-repo caveat

This repo is private. A **public** Pages site from a private repo requires a
plan that permits it (GitHub Pro/Team/Enterprise). Pages is currently enabled;
if it is ever disabled, the deploy job will fail until it is re-enabled (the
build job, which makes no Pages API call, still succeeds).
