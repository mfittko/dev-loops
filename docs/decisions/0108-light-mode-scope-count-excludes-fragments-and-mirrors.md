# 0108. Light-mode scope count excludes changeset fragments and generated mirrors

## Status

Accepted — 2026-09-28 ([issue 2527](https://github.com/mfittko/dev-loops/issues/2527))

Amends [0026](./0026-light-mode-inline-micro-prs.md). It changes how light-mode scope is counted and moves this repo's cap from 2/20 to 2/40. The inline path, the merge-gate re-verify and the escalation rules of ADR 0026 are unchanged.

## Context

Almost no real PR in this repo qualified for light mode. The scope count included the required `changes/*.md` fragment and the generated `.claude` mirrors. These files carry no independent review risk. A one-file fix with its test and its fragment was already 3 files. PR 2522 (one script, one test, one fragment) therefore ran the full fan-out: 10 reviewers and 2 judges, 33.47M tokens and 26 minutes.

## Decision

`SCOPE_COUNT_EXCLUDE_GLOBS` in `packages/core/src/config/config.mjs` is a frozen, hard-coded set of four globs: `changes/*.md`, `.claude/skills/**`, `.claude/agents/**` and `.claude/commands/**`. No config field can change it. The shared measurement in `scripts/loop/detect-change-scope.mjs` applies it for both callers. `detectScope` feeds dispatch. `detectMergeBaseScope` feeds the merge-gate re-verify. Both measure with `git diff --numstat -z` and drop excluded paths from `filesChanged` and `linesChanged`. ADR 0026's "genuinely under threshold" now means the counted merge-base diff.

The mirrors are safe to skip. `test/contracts/claude-assets-reproducible.test.mjs` proves byte parity with their sources and rejects orphaned mirrors. `.claude/hooks/**` has no such proof and stays counted. A rename is skipped only when both its old and new paths are excluded. Otherwise it counts. Any git failure still returns `ok: false`.

This repo's `.devloops` moves to `maxFiles: 2`, `maxLines: 40`. The basis is the measurement from issue 2527. PR 2522 had 3 raw files, 2 counted files and 34 counted lines. It was the only light-eligible sample of four. The other three touched risk paths. The operator accepted this one-sample basis. Both values stay below the shipped defaults of 3 files and 200 lines.

## Consequences

The ADR 0071 floors stay unchanged: risk-path, size-budget, T1 and unavailable-evidence. They still see the full, unfiltered changed-file list. Diff-class tier matching (`resolveGateTier`) still uses the unfiltered diff; the exclusion applies only to the light-mode cap. A risk-path file plus a fragment still resolves to `full_fanout`. The `gate:full` override and `GATE-EXEC-LIGHT-ESCALATION` are unchanged. Validation stays as [0105](./0105-targeted-validation-and-full-run-authority.md) decides. Light mode saves reviewer and judge cost only. This ADR satisfies the `devloops-proportionality` tripwire from [0071](./0071-review-proportionality-non-overridable-floors.md).

The set is hard-coded and ships to consumer repos. A consumer repo may have no mirror-parity proof for `.claude/{skills,agents,commands}/**`, so hand-edited files there are uncounted. They still pass the risk-path floor and the size-budget floor, and a consumer can force full review with the `gate:full` label.

Rejected alternatives:

- Filter inside `resolveGateDispatchMode`. It receives only counts, and the merge-gate re-verify would count a different diff.
- Reuse `DEFAULT_DIFF_EXCLUDE_GLOBS`. That set serves reviewer diffs and changes for other reasons.
- Make the set configurable. A consumer could then exclude reviewable code from the count.
- Set `maxFiles: 3`. The fragment exclusion already admits the measured sample at 2.
