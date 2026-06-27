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
  artifact (`upload-pages-artifact`). It makes no Pages API call, so every push
  to `main` validates the assembly without turning the workflow red while Pages
  is disabled.
- The **deploy** job is gated to `workflow_dispatch` (`if: github.event_name == 'workflow_dispatch'`).
  It runs `configure-pages` + `deploy-pages`, which require Pages to be enabled,
  so an operator triggers it manually rather than letting a push to `main` turn
  the workflow red.

### One-time operator step

Enable Pages once: repo **Settings → Pages → Source: GitHub Actions**. Then run
the workflow from the **Actions** tab → "Deploy presentation decks to GitHub
Pages" → **Run workflow**. After that the published URL appears on the deploy
job and the Pages settings page. The audience is public.

### Private-repo caveat

This repo is private. A **public** Pages site from a private repo requires a
plan that permits it (GitHub Pro/Team/Enterprise). If the plan does not allow
it, leave Pages disabled — the workflow's deploy job is `workflow_dispatch`-only
and is never auto-triggered, so it stays a no-op until an operator enables Pages
and runs it. Pushes to `main` still build and validate the artifact regardless.
