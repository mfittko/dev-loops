# Copilot PR CI/check normalization contract

This document is the canonical bundled contract for deterministic interpretation of PR CI/check inputs used by Copilot PR follow-up flows.

Installed skill/runtime consumers should read this bundled `skills/docs/` copy via [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md) from the relevant skill directory. Repository-local docs may summarize or link this contract, but they should not redefine it.

Implementation surface:
- `@dev-loops/core/loop/copilot-ci-status`
- source file: `packages/core/src/loop/copilot-ci-status.mjs`

## Entry points

- `normalizeStatusCheckRollupContract(statusCheckRollup)` — normalizes the PR `statusCheckRollup` snapshot from `gh pr view`
- `normalizeHeadScopedCiContract({ checkRunsStatus, commitStatus })` — normalizes current-head refresh inputs after explicit `check-runs` / commit-status probes
- `deriveLoopCiStatusFromRollup(statusCheckRollup)` — same rollup input as above, but excludes the loop's own `LOOP_DERIVED_CI_CHECK_NAME` (`gate-evidence`) check before computing the status, returning `{ status, excludedFailureDetails }`. `status` is `"crediblyGreen"` (never masked as a plain `"success"`) when every OTHER check is green and `gate-evidence` was the only excluded failure; a genuinely failing check right beside it still yields `"failure"`.

Both `normalizeStatusCheckRollupContract` and `normalizeHeadScopedCiContract` return the same machine-readable contract shape.

## Loop-derived check exclusion

`gate-evidence` (`.github/workflows/gate-evidence.yml`) is a server-side check whose conclusion is DERIVED from the loop's own progress (a clean current-head `pre_approval_gate` verdict) — not an independent build/test signal. The dev-loop must never let it block the very step (posting `pre_approval_gate`) that would turn it green. `LOOP_DERIVED_CI_CHECK_NAME` is the single exported constant naming this check; `partitionEntriesByCheckName` and `promoteExcludedCleanCiStatus` are the shared primitives `deriveLoopCiStatusFromRollup` composes from, and the check-runs-shaped equivalent in `scripts/loop/detect-copilot-loop-state.mjs` reuses the same constant and promotion rule so the fallback (rollup) and refresh (check-runs) derivation paths never disagree.

## Inputs

### `normalizeStatusCheckRollupContract(statusCheckRollup)`

- `statusCheckRollup` — the raw PR `statusCheckRollup` array from `gh pr view`; entries may be CheckRun-like (`status` + `conclusion`) or legacy StatusContext-like (`state`)

### `normalizeHeadScopedCiContract({ checkRunsStatus, commitStatus })`

- `checkRunsStatus` — normalized head-scoped check-runs status (`success` | `failure` | `pending` | `none`)
- `commitStatus` — normalized head-scoped commit-status status (`success` | `failure` | `pending` | `none`)
- optional `checkRunsUnsupportedCompleted` — `true` when the current-head check-runs probe observed an unsupported/non-success completed conclusion (for example `CANCELLED`) that must keep the merged result non-green even if commit status separately reports success

## Output

The returned object always includes:

- `overallStatus` (`success` | `failure` | `pending` | `none`)
- `rollup` (`success`/`failure`/`pending`/`none` booleans; exactly one true)
- `semantics.wait` (`true` when `overallStatus` is `pending` or `none`)
- `semantics.blocked` (`true` when `overallStatus` is `failure`)
- `semantics.timeoutDisposition` (`remain_waiting` for `pending`/`none`; otherwise `not_applicable`)

## Deterministic precedence

The rollup precedence is fixed and policy-agnostic for ordinary normalized status values:
1. `failure`
2. `pending`
3. `success`
4. `none`

Completed `SKIPPED` and `NEUTRAL` check-run conclusions count as non-blocking success-like signals. A completed `CANCELLED` check does not count as a successful readiness signal by itself; cancelled-only snapshots normalize to `none` so CI-dependent gates do not advance on cancelled work. Legacy successful `StatusContext` rollup entries also normalize to `success` instead of being mistaken for pending work.

Merged current-head exception:
- when `checkRunsUnsupportedCompleted=true`, a `checkRunsStatus: "none"` result caused by unsupported/non-success completed check-runs must remain non-green even if `commitStatus` is `success`
- in that specific case, the merged `overallStatus` stays `none` rather than letting `success` mask the unsupported completed check-run signal
