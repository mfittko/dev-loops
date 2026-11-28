# Copilot PR CI/check normalization contract

This document is the canonical bundled contract for deterministic interpretation of PR CI/check inputs used by Copilot PR follow-up flows.

Installed skill/runtime consumers should read this bundled `skills/docs/` copy via [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md) from the relevant skill directory. Repository-local docs may summarize or link this contract, but they should not redefine it.

## Entry points

Implementation: `@dev-loops/core/loop/copilot-ci-status` (`packages/core/src/loop/copilot-ci-status.mjs`).

- `normalizeHeadScopedCiContract({ checkRunsStatus, commitStatus })` normalizes explicit current-head check-runs/commit-status refreshes.
- `deriveLoopCiStatusFromRollup(statusCheckRollup)` excludes loop-derived checks and returns `{ status, excludedFailureDetails }`.

`normalizeHeadScopedCiContract` returns the shared machine-readable shape documented below.

## Loop-derived check exclusion

Exclude all FOUR `.github/workflows/gate-evidence.yml` surfaces before deriving loop CI: the `gate-evidence` commit `StatusContext` (`.context`), the `gate-evidence-runner` detector check run, the `gate-evidence-reporter` reporter check run, and the `head-declared-keys` check run. `LOOP_DERIVED_CI_CHECK_NAME` names the first; `LOOP_DERIVED_CI_CHECK_NAMES` contains all four. Workflow tests require every job id to belong to the full set.

These are derived from loop progress, not independent build/test signals. Missing current-head evidence fails closed to definitive `failure`; that evidence, unresolved threads, stale runners and genuine gate violations remain independently tracked in the loop snapshot. Exclusion applies regardless of conclusion, including historical pending entries and definitive failures; the workflow never posts pending. It also excludes cancelled superseded runner checks without treating cancellation of real CI as green.

`partitionEntriesByCheckName` accepts one name or a set. Both rollup fallback and current-head refresh apply the same exclusion. The detector (`scripts/loop/detect-copilot-loop-state.mjs`) and CI prober (`scripts/github/probe-ci-status.mjs`, `fetchHeadCiState`) exclude the full set from check-runs and the single status name from commit statuses. `watchCiStatus`, `node <dev-loops-package-root>/cli/index.mjs loop watch-ci`, and its thin `scripts/github/wait-pr-checks.mjs` wrapper therefore do not wait on loop-derived entries.

With independent checks green, exclusion yields ordinary `"success"`, never `"crediblyGreen"`. A genuinely failing neighboring check still yields `"failure"` and remains in `failedChecks`; excluded failures remain visible in `excludedFailureDetails`. Shared-fixture tests pin detector/prober agreement on this exclusion rule.

### PR wait check-state mismatch diagnostic

The PR-scoped `watchCiStatus` result, including `probe-ci-status.mjs --pr` and
`wait-pr-checks.mjs`, optionally includes `checkStateMismatches`. Each entry is
`{ name, status, conclusion, completed_at, reason }`, preserving the provider's
fields for a visible, non-loop-derived current-head check run whose status is
`in_progress`, conclusion is `success`, and `completed_at` is a parseable ISO
UTC timestamp (`YYYY-MM-DDTHH:mm:ss[.fraction]Z`). A missing or invalid name is
reported as `unknown`. The reason explains that the check remains
pending because GitHub still reports it as in progress. The list is omitted
when empty; ordinary running checks and completed successes do not produce it.

The diagnostic uses the same head and visible checks as the existing PR wait.
It carries no settlement or approval authority: a mixed check remains pending
even with a green commit-status aggregate, and a single mixed check with no
failures still yields `settled: false`, `ciStatus: "pending"`, no failed checks,
and exit 2 from `wait-pr-checks.mjs --timeout 0`. It does not authenticate an
Actions workflow run or attempt, change normalization, or affect commit-scoped
probing, polling budgets, exit codes, or gate evidence.

### Zero-suite local-validation exception

No detector path produces `"crediblyGreen"`, and gate-evidence exclusion never produces it. The value is valid only in a supplied `--input` snapshot. These facts do not authorize self-certifying CI or overriding `none`. If a refresh returns `none`, follow the existing wait/reconciliation policy.

## Inputs

### `normalizeHeadScopedCiContract({ checkRunsStatus, commitStatus })`

- `checkRunsStatus` — normalized head-scoped check-runs status (`success` | `failure` | `pending` | `none`)
- `commitStatus` — normalized head-scoped commit-status status (`success` | `failure` | `pending` | `none`)
- optional `checkRunsUnsupportedCompleted` — `true` when the current-head check-runs probe observed an unsupported/non-success completed conclusion (for example `CANCELLED`); see the merged current-head exception below

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

Merged current-head exception: when `checkRunsUnsupportedCompleted=true` and `checkRunsStatus` is `"none"`, the merged `overallStatus` stays `none` even if `commitStatus` is `success`.
