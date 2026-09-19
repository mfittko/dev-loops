# Copilot PR CI/check normalization contract

This document is the canonical bundled contract for deterministic interpretation of PR CI/check inputs used by Copilot PR follow-up flows.

Installed skill/runtime consumers should read this bundled `skills/docs/` copy via [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md) from the relevant skill directory. Repository-local docs may summarize or link this contract, but they should not redefine it.

## Entry points

Implementation: `@dev-loops/core/loop/copilot-ci-status` (`packages/core/src/loop/copilot-ci-status.mjs`).

- `normalizeStatusCheckRollupContract(statusCheckRollup)` normalizes the `gh pr view` rollup.
- `normalizeHeadScopedCiContract({ checkRunsStatus, commitStatus })` normalizes explicit current-head check-runs/commit-status refreshes.
- `deriveLoopCiStatusFromRollup(statusCheckRollup)` excludes loop-derived checks and returns `{ status, excludedFailureDetails }`.

The first two return the shared machine-readable shape documented below.

## Loop-derived check exclusion

Exclude BOTH `.github/workflows/gate-evidence.yml` surfaces before deriving loop CI: the `gate-evidence` commit `StatusContext` (`.context`) and the `gate-evidence-runner` check run. `LOOP_DERIVED_CI_CHECK_NAME` names the former; `LOOP_DERIVED_CI_CHECK_NAMES` contains both. Workflow tests require every job id to belong to the full set.

These are derived from loop progress, not independent build/test signals. Letting them block `pre_approval_gate` would prevent the verdict needed to make them green. Missing current-head evidence fails closed to definitive `failure`; that evidence, unresolved threads, stale runners and genuine gate violations remain independently tracked in the loop snapshot. Exclusion applies regardless of conclusion, including historical pending entries and definitive failures; the workflow never posts pending. It also excludes cancelled superseded runner checks without treating cancellation of real CI as green.

`partitionEntriesByCheckName` accepts one name or a set. Both rollup fallback and current-head refresh apply the same exclusion. The detector (`scripts/loop/detect-copilot-loop-state.mjs`) and CI prober (`scripts/github/probe-ci-status.mjs`, `fetchHeadCiState`) exclude the full set from check-runs and the single status name from commit statuses. `watchCiStatus`, `dev-loops loop watch-ci`, and its thin `scripts/github/wait-pr-checks.mjs` wrapper therefore do not wait on loop-derived entries.

With independent checks green, exclusion yields ordinary `"success"`, never `"crediblyGreen"`. A genuinely failing neighboring check still yields `"failure"` and remains in `failedChecks`; excluded failures remain visible in `excludedFailureDetails`. Shared-fixture tests pin detector/prober agreement on this exclusion rule.

### Zero-suite local-validation exception

`"crediblyGreen"` is reserved for the bounded zero-suite local-validation exception, never produced by gate-evidence exclusion. Its prerequisites remain: zero current-head suites/statuses, previous-head green, and local `bun run verify` passed for that same head. These facts do not authorize self-certifying CI or overriding `none`; refresh the detector and proceed under this exception only on authoritative current-head `crediblyGreen` evidence.

The CLI rejects the removed `--local-validation-head-sha` flag and supplies no local-validation evidence input, so an ordinary refresh cannot activate this exception. If the result remains `none`, follow the existing wait/reconciliation policy. The internal promotion helper additionally requires matching local-validation/head identity, successful fallback rollup, a current-head submitted Copilot review and zero unresolved/actionable threads; those checks do not make the missing CLI input available.

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
