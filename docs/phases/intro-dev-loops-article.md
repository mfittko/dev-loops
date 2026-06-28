---
prNumber: 968
---
# Introducing dev-loops — public intro article

## Status
Draft. Authored locally as a plan file (local-first), to be refined and promoted through the dev-loop itself — the article documents the same flow that produced it.

## Objective
Publish a top-of-funnel public article that introduces dev-loops to a general engineering audience: what it is, why it exists, and how to start using it. The two existing articles (eliminating-coordination-delay, make-the-waiting-visible) are concept deep-dives; there is no single "what / why / how-do-I-start" entry point, and this fills that gap. The piece shows off the approach with concrete, verified evidence from this repository's own history and then hands the reader a path to adopt dev-loops in their project with Pi or Claude Code.

## In scope
- One article, two acts. Act 1 — why + proof: the coordination-delay problem in brief, the verified throughput (100 merged PRs in ~14 days, every one through the same gate), and a handful of concrete worked examples from this repo (the local-first epic as a waterfall; the docs-grill catching real code-vs-doc drift; Copilot rounds converging under a round cap; the gate catching a real defect; dogfooding surfacing its own tooling bug).
- Act 2 — hands-on adoption: drop dev-loops into a project with Pi or Claude Code; the config forks — start local (`strategy.default: local-first`) vs issue-intake (`github-first`), `inputSource` tracker vs phase-docs, the waterfall refinement (epic → phase tree), Copilot reviews on/off (`refinement.maxCopilotRounds`, `0` to disable), human-merge-only.
- Every cited number, config key, flag, and script verified against shipped code/history (not prose).
- Deliverables: a Markdown source under `docs/articles/`, a CSP-safe self-contained HTML rendering for the Artifact/Pages surface, and publication as a Claude artifact.
- A/B-contrast deslop step applied; the piece reads as human-written and stays neutral while stating the full truth.

## Explicit non-goals
- A deep dive into any single mechanism (the existing concept articles and the spike-mode write-up are the deep dives; this links down to them).
- A full configuration reference (the artifact-authority contract and config docs own that; the article links to them).
- Changing any code, schema, defaults, or scripts — this is a content deliverable.
- Marketing superlatives or competitor comparisons; the evidence carries the piece.

## Acceptance criteria

- The article ships as `docs/articles/introducing-dev-loops.md` plus a CSP-safe self-contained HTML rendering under `docs/articles/`, and is published as a Claude artifact.
- Act 1 (why + proof) cites verified numbers — ~100 merged PRs in ~14 days, every PR through the same draft → Copilot → pre-approval gate — and at least three concrete repo examples, each naming its PR/issue numbers.
- Act 2 (hands-on adoption) covers, each naming the real shipped config key: start-local (`strategy.default: local-first`) vs issue-intake (`github-first`); `inputSource.default` tracker vs phase-docs; the waterfall refinement (epic → phase tree); Copilot reviews on/off (`refinement.maxCopilotRounds`, `0` disables); human-merge-only (`autonomy.humanMergeOnly`).
- Every cited number, config key, flag, and script is verified against shipped code/history, not prose.
- The A/B-contrast deslop step is applied; the piece reads as human-written and stays neutral.

## Definition of done

- Markdown + CSP-safe HTML committed under `docs/articles/`; artifact published and the link handed to the operator.
- Cross-linked from `docs/index.md` and from the two existing concept articles (which become the deep dives beneath it).
- `npm run test:docs` green (link-check + no-duplicate-rules) and `npm run verify` green.
- CHANGELOG entry under Added, matching the sibling article PRs (#942/#943).

## Coverage matrix

| Item | Type | Status | Evidence |
|---|---|---|---|
| MD + HTML under docs/articles/ + artifact published | AC | Planned | files added in the promoted PR |
| Act 1 verified numbers + 3 concrete examples | AC | Planned | research report (100 PRs/14d; epic #947, docs-grill #948/#958, gate catches #938/#854, bug #963) |
| Act 2 config forks each name the real key | AC | Planned | extension-defaults.yaml + config.mjs key names |
| Every citation verified against code/history | AC | Planned | grep-verified surface list from research |
| A/B-contrast deslop applied | AC | Planned | docs/ab-contrast-deslop-step.md sweep |
| Cross-linked + test:docs + verify green | DoD | Planned | docs/index.md + CI |
| CHANGELOG entry | DoD | Planned | CHANGELOG Added section |

## Docs-grill findings

- None recorded; the docs-grill step ran and surfaced no findings.
