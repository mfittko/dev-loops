# Copilot PR CI/check normalization contract

This document is the canonical bundled contract for deterministic interpretation of PR CI/check inputs used by Copilot PR follow-up flows.

Installed skill/runtime consumers should read this bundled `skills/docs/` copy via [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md) from the relevant skill directory. Repository-local docs may summarize or link this contract, but they should not redefine it.

Implementation surface:
- `@dev-loops/core/loop/copilot-ci-status`
- source file: `packages/core/src/loop/copilot-ci-status.mjs`

## Entry points

- `normalizeStatusCheckRollupContract(statusCheckRollup)` — normalizes the PR `statusCheckRollup` snapshot from `gh pr view`
- `normalizeHeadScopedCiContract({ checkRunsStatus, commitStatus })` — normalizes current-head refresh inputs after explicit `check-runs` / commit-status probes
- `deriveLoopCiStatusFromRollup(statusCheckRollup)` — same rollup input as above, but excludes the loop's own derived entries (`LOOP_DERIVED_CI_CHECK_NAMES`: the `gate-evidence` commit status and the workflow's own `gate-evidence-runner` check run) before computing the status, returning `{ status, excludedFailureDetails }`. `status` is a plain `"success"` (not an "unconfirmed" `crediblyGreen`) when every OTHER check is green and `gate-evidence` was the only excluded non-green entry (whether it read `pending` or `failure`) — every reason gate-evidence can be non-green is independently tracked elsewhere in the loop snapshot, so excluding it loses no signal; `excludedFailureDetails` still lists it (when failing) for transparency. A genuinely failing check right beside it still yields `"failure"` (never masked).

Both `normalizeStatusCheckRollupContract` and `normalizeHeadScopedCiContract` return the same machine-readable contract shape.

## Loop-derived check exclusion

`gate-evidence` (`.github/workflows/gate-evidence.yml`) is a server-side check whose conclusion is DERIVED from the loop's own progress (a clean current-head `pre_approval_gate` verdict) — not an independent build/test signal. The dev-loop must never let it block the very step (posting `pre_approval_gate`) that would turn it green, and must not treat it as "unconfirmed" CI either: every reason it can be non-green — evidence not yet established for the current head (fail-closed to a definitive `failure`, per #1702), unresolved threads, a stale runner, or a genuine current-head `pre_approval_gate` violation (reported as `failure`) — is independently tracked elsewhere in the loop snapshot. The exclusion applies regardless of the definitive `failure` the context reports (gate-evidence never posts `pending`). The workflow surfaces in TWO shapes and both must be excluded: the explicit commit `StatusContext` named `gate-evidence` (matched by `.context`), and the workflow's own check run, named after its job id `gate-evidence-runner`. `LOOP_DERIVED_CI_CHECK_NAME` names the status context; `LOOP_DERIVED_CI_CHECK_NAMES` is the full set, and the workflow contract test pins every job id in `gate-evidence.yml` into it, because a check run named after an unexcluded job re-creates the deadlock: once the workflow cancels a superseded run for concurrency, a cancelled run is deliberately not read as green, so one routine cancellation makes the whole head read `none` and the loop waits on CI forever.

`partitionEntriesByCheckName` is the shared primitive `deriveLoopCiStatusFromRollup` composes from (it accepts one name or a set), and the same exclusion rule is applied by every CI-status consumer in the loop:

- the current-head refresh in `scripts/loop/detect-copilot-loop-state.mjs` applies it on both refresh probes — the check-runs probe passes the full set (`LOOP_DERIVED_CI_CHECK_NAMES`), the commit-status probe passes the single status name (`LOOP_DERIVED_CI_CHECK_NAME`; a check run can never appear in a commit-status payload) — so the fallback (rollup) and refresh (check-runs + commit-status) derivation paths never disagree;
- the provider-agnostic CI wait in `scripts/github/probe-ci-status.mjs` (`fetchHeadCiState`, consumed by `watchCiStatus`) applies the same partition to both its check-runs and commit-status inputs before computing the merged status, so `dev-loops loop watch-ci` and `scripts/github/wait-pr-checks.mjs` (a thin front over the same `watchCiStatus` engine) never block-wait on the gate-evidence entry the loop itself derives.

The prober and the detector cannot disagree about whether the loop may proceed: both partition out the loop-derived entries before computing status, and a contract test pins them against one shared rollup fixture. A genuinely failing check beside a red gate-evidence still blocks and is still reported in `failedChecks`; the excluded entry stays visible in `excludedFailureDetails` so a reader can tell "green apart from gate-evidence" from "green".

Note: `"crediblyGreen"` is a distinct, unrelated CI status reserved for the bounded zero-suite local-validation exception (`--local-validation-head-sha`, #740/#1338) — it is never produced by the gate-evidence exclusion above.

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
