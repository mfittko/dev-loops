# Presentation decks

Public-audience talks on dev-loops. The four self-contained, CSP-safe HTML decks
listed below are the source of truth for publishing. Edit the `.html` for
anything that ships.

| Deck | HTML render | Topic |
| --- | --- | --- |
| Introducing dev-loops | [`introducing-dev-loops.html`](introducing-dev-loops.html) | Why delivery stalls between actions, how pullable next actions restore momentum, and how to start with one issue. |
| dev-loops: Control & Observability | [`dev-loops-deep-dive.html`](dev-loops-deep-dive.html) | Explicit delivery control (Act I) and measuring the waiting between actions (Act II). |
| The State Graph Is the Surface | [`state-graph-surface.html`](state-graph-surface.html) | How authoritative state, bounded loops, evidence, and human authority compose into one control surface. |
| How dev-loops Decided Itself Into Shape | [`how-dev-loops-decided-itself.html`](how-dev-loops-decided-itself.html) | The project's decision ledger, illustrated through two selected reversals from the larger recorded history. |

## Markdown presentation material

[`state-graph-surface-presentation.md`](state-graph-surface-presentation.md) is
the State Graph deck's headline companion. It mirrors headline-level changes,
but its body predates the HTML storytelling restructure and is not used to
generate the published deck.

[`applied-dev-loops-presentation.md`](applied-dev-loops-presentation.md) and
[`process-observability-presentation.md`](process-observability-presentation.md),
along with their `*-review-notes.md` files, are legacy Slidev sources and notes.
They remain as historical presentation material; they are not headline
companions for the publishable HTML decks and are not part of the Pages build.

The Introducing, Deep Dive, and History HTML decks have no corresponding
Markdown presentation source or headline companion.

The self-contained `.html` files inline all CSS and diagrams (no Slidev runtime,
no CDN, no remote resources) and ship a strict `Content-Security-Policy`, so they
open directly in a browser and publish as static files.

## View locally

Open the HTML file directly:

```sh
open docs/presentations/dev-loops-deep-dive.html   # macOS
```

Or serve the assembled site (mirrors what GitHub Pages publishes):

```sh
node scripts/pages/build-site.mjs          # writes ./site/ (gitignored)
npx http-server site                       # or: python3 -m http.server -d site
```

`scripts/pages/build-site.mjs` copies all four deck HTML files into `site/` and
generates `site/index.html` (the intro article) with a nav linking the deep-dive
article and every deck. `site/` is assembled, never hand-maintained, and is
gitignored — only the script and workflow are committed.

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
