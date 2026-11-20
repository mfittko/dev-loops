# 0296. The base-merge verdict carry re-gates only for paths that can change a gate outcome

## Status

Accepted, 2026-11-20 ([issue 3306](https://github.com/mfittko/dev-loops/issues/3306)).

Amends [0096](./0096-integrate-base-before-every-gate-round.md) and [0156](./0156-carry-gate-verdict-across-base-only-merge.md). Records 0096 and 0156 stay unedited.

## Context

ADR 0096 keeps gate rounds on current gate tooling. The carry classifier of ADR 0156 enforced that with a broad path list: `skills/`, `scripts/`, `agents/`, `cli/`, `lib/`, `schemas/`, `extension/`, `commands/`, `.claude/`, `.pi/`, `packages/core/src/`, `.github/`, `AGENTS.md` and the lockfiles. In this repo nearly every merge to main touches one of these paths. Nearly every clean base merge therefore classified `full_regate`. On 2026-11-19 and 2026-11-20 base merges made in-flight PRs stale about ten times a day, and each one cost a full gate round with "nothing carried forward". A change to an unrelated script, a test helper or a lockfile cannot change a review outcome.

## Decision

`GATE_TOOLING_RE` in `packages/core/src/loop/base-merge-verdict-carry.mjs` keeps a single source list, now limited to outcome-relevant paths:

- the reviewer, judge, gate-coordinator and docs agent definitions and their `.claude/agents/` mirrors;
- the gate, judge and review contracts under `skills/docs/` (file names with a `gate`, `judge` or `review` token), `acceptance-criteria-verification.md`, `structural-quality.md`, `validation-policy.md`, `spec-authority-contract.md` and `copilot-loop-operations.md` (it owns `OPS-PR-VALIDATION-STABLE-EVIDENCE`, which reviewers and the judge apply), with their `.claude/` mirrors, and the `copilot-pr-followup`, `review`, `dev-loop` and `local-implementation` `SKILL.md` files;
- `scripts/github/build-adjacent-bundle.mjs` (it builds reviewer input);
- scripts (at any depth under `scripts/`) and `packages/core/src/loop/` modules whose file names hold one of the tokens `gate`, `fanin`, `fan-in`, `judge`, `verdict`, `carry`, `review`, `reviewer`, `finding`, `angle`, `dispatch`, `cluster`, `round-cap`, `prompt`, `unit-bound`, `disposition`, `evidence`, `checkpoint`, `convergence` or `pre-push-delta`, with an optional plural `s` on `gate`, `verdict`, `review`, `reviewer`, `finding`, `angle`, `cluster`, `prompt` and `disposition` only. A token matches as a whole word between `-`, `_` or `.`, so `navigate` or `preview` do not hit;
- `packages/core/src/loop/spec-authority.mjs` (it owns the judge disposition outcomes);
- `packages/core/src/analysis/diff-analyzer.mjs` (gate context uses `classifyFile` to choose the docs-only angle scope and the dispatch mode);
- `packages/core/src/analysis/change-classifier.mjs` (it owns the category-to-angle map and `resolveDynamicAngles`, which choose the reviewer angles);
- `packages/core/src/config/` (angle, persona, prompt and judge-track resolution);
- the dev-loops config (`isDevLoopConfigSourcePath`);
- the installed dev-loops version: `package.json` and `packages/*/package.json`.

Lockfiles and every other path in the base delta carry. `classifyBaseMergeCarry`, `validateBaseMergeCarryEvidence` and the `merge-pr.mjs` precondition share the one list, so they accept and refuse the same cases. The evidence record keeps `gateToolingPaths`, now holding outcome-relevant paths only. The PR-path overlap rule and the conflict-hunk rule are unchanged.

## Consequences

- A clean base merge after an unrelated main merge carries the verdict and saves about one full gate round per base merge.
- A path outside the list that in fact changes outcomes carries wrongly. The list is the single place to extend. `test/loop/base-merge-carry-import-graph.test.mjs` guards it: it walks the imports of `consolidate-fanin.mjs`, `judge-pass.mjs` and `emit-fanout-dispatch.mjs` through gate-tooling files and fails when a reached file under `scripts/` or `packages/core/src/` is neither tooling nor on its short, reasoned allowlist of generic utilities and coordinator procedure.
- `cli/index.mjs`, `main-agent-contract.md` and `anti-patterns.md` stay out of the list. They carry coordinator procedure, not review outcome, and change on most merges.
- A carried-heads record written under the old rule that no longer recomputes to the same evidence is a full re-gate, as before.
