# 0057. A stuck gate-evidence status self-heals via a loop-side reconcile re-fire

## Status

Accepted — 2026-09-04 (issue #1935)

## Context

The server-side `gate-evidence` required check ([0034](./0034-server-side-gate-evidence-required-check.md)) re-fires when a gate verdict is posted ([0043](./0043-gate-evidence-verdict-comment-refire.md)), so posting a clean current-head `pre_approval_gate` verdict is normally its own re-evaluation. That native re-fire is racy at one seam. The gate-evidence job runs under a job-level concurrency group with `cancel-in-progress: true`, so a verdict-post run can be CANCELLED when a superseding event (another review, a review comment, a same-round thread reply) lands right after it; a cancelled run posts nothing (`!cancelled()`). A run can also evaluate before the just-posted verdict is API-visible (read-after-write) and post `failure`. Either way the required status can stay `failure` on the current head even though a clean current-head verdict now exists, and no further event re-fires it — the merge stays `mergeStateStatus: UNSTABLE`.

Observed on PR #1934 (2026-09-03 fresh-context retro): push `d5642cf1` landed at 21:28:12Z; the verdict-post run `33809424228` (event `pull_request_review`, head `d5642cf1`) was CANCELLED (attempt 1), leaving the prior `failure` status standing; `gh pr merge --squash` failed on `UNSTABLE`. Recovery was manual: `gh run rerun 33809424228 --failed`, which re-evaluated the now-visible evidence and posted `success` (attempt 2).

The loop deliberately excludes `gate-evidence` from its own CI convergence wait (`LOOP_DERIVED_CI_CHECK_NAMES`, `probe-ci-status.mjs`) to avoid the circularity that the check only goes green after the verdict the loop itself posts. That exclusion is why the loop never notices, and never heals, a stuck gate-evidence status. So the stale status survived to the human merge step.

## Decision

Automate the exact manual recovery as a deterministic loop-side reconcile, run at merge-readiness after the post-drive gate-evidence audit. `scripts/github/reconcile-gate-evidence-status.mjs` reads the authoritative evidence the same way the CI check does (`detect-checkpoint-evidence.mjs --skip-fanout-ledger-check`) and the `gate-evidence` commit status on the current head. The pure decision (`resolveGateEvidenceStatusReconcile` in `packages/core/src/loop/gate-evidence-reconcile.mjs`) separates the only two cases that matter:

- evidence genuinely satisfied AND the status is stuck non-green → re-fire the concrete run that posted the stale status (`gh run rerun <id>`, the run id parsed from the status `target_url`). The rerun re-checks out the trusted default branch and re-evaluates LIVE evidence, which is now satisfied, so it posts `success` to the current head. The status is on the current head, so the replayed payload targets the correct SHA.
- evidence NOT satisfied → do nothing. A head that truly lacks a clean current-head verdict keeps failing closed, unchanged.

The reconcile never posts a status itself — that would bypass the trusted server-side detector ([0043](./0043-gate-evidence-verdict-comment-refire.md)); it only re-triggers the CI run, so the evaluation still runs on GitHub's own trusted-base checkout.

## Consequences

A stuck gate-evidence status caused purely by "verdict not yet visible / re-fire cancelled for the current head" now self-heals at merge-readiness without a human `gh run rerun`, closing the observed `UNSTABLE` deadlock. The fail-closed direction is preserved and test-pinned: the reconcile re-fires only when the evidence is genuinely satisfied, so it can never turn a real "verdict missing" failure green. `gh run rerun` — documented in [0043](./0043-gate-evidence-verdict-comment-refire.md) as a non-recovery because it replays the stale event payload — IS a valid recovery in this specific case: the head has not moved (the reconcile runs at merge-readiness, no new push), so the replayed head SHA is still current, and the evaluation reads live evidence rather than the payload. One residual remains: if the head moves between the reconcile and the merge, a new verdict/evaluation is required, exactly as before.
