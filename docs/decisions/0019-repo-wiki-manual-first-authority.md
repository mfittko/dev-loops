# 0019. Keep source files authoritative and treat the generated repo wiki as pinned, manual-first navigation output

## Status

Accepted — 2026-06-13 ([PR 776](https://github.com/mfittko/dev-loops/pull/776))

## Context

Adding an LLM-compiled GitHub Wiki export ([issue 130](https://github.com/mfittko/dev-loops/issues/130), landed via [PR 776](https://github.com/mfittko/dev-loops/pull/776)) raised two questions at once: what counts as the documentation source of truth, and how tightly to couple this repository to the external `@mfittko/repo-wiki` tool. The compiler ingests checked-in docs (`README.md`, contracts, skill docs per `.llmwiki/config.json`) and emits derived pages under `.llmwiki/`, so an unclear authority boundary would invite edits to generated output that the next compile silently overwrites. The tool lives outside this repository, so an unpinned dependency would let upstream drift break the doc pipeline without any change here. CI publishing to the GitHub Wiki followed in [PR 779](https://github.com/mfittko/dev-loops/pull/779), which forced the coupling and trigger policy to be settled explicitly; the manual-first stance is documented in `docs/repo-wiki-manual-first.md`.

## Decision

Repository source files remain authoritative: generated output under `.llmwiki/run/`, `.llmwiki/wiki/`, and `.llmwiki/search/` is gitignored navigation output, never source of truth, while only the consumer config (`.llmwiki/config.json`) and schema reference are checked in. External coupling is dual-path and pinned in `scripts/repo-wiki.mjs` — the primary path proxies the published npm package at a pinned version (`@mfittko/repo-wiki@0.2.6`), and the fallback builds a local checkout at a pinned source commit — rejecting both a floating "latest" dependency and a vendored copy of the tool. CI compiles deterministically by default; LLM compile mode is an explicit operator opt-in via the `LLMWIKI_COMPILER_MODE` variable, so the default pipeline needs no API key. The workflow publishes to the GitHub Wiki only from pushes to `main` (or an explicit `workflow_dispatch` opt-in), and we scoped scheduled sync out rather than automating a cadence for a navigation aid.

## Consequences

The generated wiki can never be edited as if it were documentation — gitignoring the output makes such edits unmergeable by construction, and doc changes must land in the authoritative source files that the compiler ingests. The doc pipeline cannot break on upstream tool drift, because both install paths resolve to pinned artifacts; the cost is that every upstream improvement requires a manual version or commit bump in the wrapper. The deterministic-by-default compile keeps CI reproducible and secret-free unless an operator deliberately enables LLM mode. Without scheduled sync, the published wiki only refreshes on pushes to `main` or manual dispatch, which is acceptable for output that is explicitly navigation, not truth.
