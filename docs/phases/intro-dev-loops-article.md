---
prNumber: 971
---
# Introducing dev-loops — public intro article

## Status
Promoted — in PR review (#971). Refined and promoted through the local-first flow; the acceptance criteria and definition of done below are met (see the coverage matrix).

## Objective
Publish a top-of-funnel public article that introduces dev-loops to a general engineering audience: what it is, why it exists, and how to start using it. The two existing articles (eliminating-coordination-delay, make-the-waiting-visible) are concept deep-dives; there is no single "what / why / how-do-I-start" entry point, and this fills that gap. The piece shows off the approach with concrete, verified evidence from this repository's own history and then hands the reader a path to adopt dev-loops in their project with Pi or Claude Code.

- A generic public introduction to the underlying concepts: the coordination-delay problem in brief, the manual-coordination-compounding argument, and the verified aggregate throughput (~100 merged PRs in ~14 days, every one gated and human-merged) used to show the straightforward, repeatable process the loop produces. Concepts and aggregate data only — no internal PR/issue numbers, script paths, contract names, or phase labels in the prose.
- Concrete setup instructions: drop dev-loops into a project with Pi or Claude Code (the Claude Code plugin slash commands, `pi install`), the plain-language `start/auto/continue dev loop` entrypoint, and the config forks — start local (`strategy.default: local-first`) vs issue-intake (`github-first`), `inputSource.default` tracker vs phase-docs, Copilot reviews on/off (`refinement.maxCopilotRounds`, `0` to disable), human-merge-only (`autonomy.humanMergeOnly`).
- Every cited number, config key, flag, and command verified against shipped code/history (not prose).
- Deliverables: a Markdown source under `docs/articles/`, a CSP-safe self-contained HTML rendering for the Artifact/Pages surface, and publication as a Claude artifact.
- A/B-contrast deslop step applied; the piece reads as human-written and stays neutral while stating the full truth.

## Explicit non-goals
- A deep dive into any single mechanism (the existing concept articles and the spike-mode write-up are the deep dives; this links down to them).
- A full configuration reference (the artifact-authority contract and config docs own that; the article links to them).
- Changing runtime behavior, schema, or defaults — this is a content deliverable. The one script touched is `scripts/pages/build-site.mjs`, only to publish the article as the Pages landing page (no product/runtime behavior changes).
- Marketing superlatives or competitor comparisons; the evidence carries the piece.

## Acceptance criteria

- The article ships as `docs/articles/introducing-dev-loops.md` plus a CSP-safe self-contained HTML rendering under `docs/articles/`, and is published as a Claude artifact.
- It is a generic public introduction to the underlying concepts (per the operator steering): no internal PR/issue numbers, script paths, contract names, or phase labels in the prose.
- The proof section cites verified aggregate numbers (~100 merged PRs in ~14 days, ~7/day, ~7-in-8 tracked, every PR gated and human-merged) and uses them to show the straightforward, repeatable process the loop produces, including the manual-coordination-compounding argument; concrete examples of what the gate catches are described for a general audience without numbers.
- The adoption section gives concrete setup instructions naming the real shipped surfaces: the Claude Code plugin slash commands and `pi install`, the plain-language `start/auto/continue dev loop` entrypoint, and the config forks — `strategy.default` local-first vs github-first, `inputSource.default` tracker vs phase-docs, Copilot reviews on/off (`refinement.maxCopilotRounds`, `0` disables), human-merge-only (`autonomy.humanMergeOnly`).
- The intro article is the GitHub Pages landing page: `scripts/pages/build-site.mjs` publishes it as `site/index.html`, with the two deep-dive articles and two decks reachable through a shared navigation bar.
- Every cited number, config key, flag, and command is verified against shipped code/history.
- The A/B-contrast deslop step is applied; the piece reads as human-written and stays neutral.

## Definition of done

- Markdown + CSP-safe HTML committed under `docs/articles/`; artifact published and the link handed to the operator.
- Cross-linked from `docs/index.md` and from the two existing concept articles (which become the deep dives beneath it).
- `npm run test:docs` green (link-check + no-duplicate-rules) and `npm run verify` green.
- CHANGELOG entry under Added, matching the sibling article PRs (#942/#943).

## Coverage matrix

| Item | Type | Status | Evidence |
|---|---|---|---|
| MD + HTML under docs/articles/ + artifact published | AC | Met | files added; artifact link handed to operator |
| Generic public intro — no PR numbers / script paths / phase labels | AC | Met | prose reviewed; gh-verified aggregate figures only |
| Proof section uses aggregate data to show the repeatable process + compounding argument | AC | Met | ~100 PRs/14d, ~7/day, ~7-in-8 tracked, human-merged |
| Concrete setup instructions naming real surfaces | AC | Met | plugin/pi install + entrypoint + config forks, vs README/config.mjs |
| Intro is the Pages landing page (build-site → index.html) + nav | AC | Met | scripts/pages/build-site.mjs + test/pages/build-site.test.mjs |
| Every citation verified against code/history | AC | Met | grep/gh-verified surfaces |
| A/B-contrast deslop applied | AC | Met | docs/ab-contrast-deslop-step.md sweep, zero tells |
| Cross-linked + test:docs + verify green | DoD | Met | docs/index.md + CI |
| CHANGELOG entry (article + Pages change) | DoD | Met | CHANGELOG Added section |

## Docs-grill findings

- None recorded; the docs-grill step ran and surfaced no findings.
