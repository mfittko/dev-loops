# 0043. Gate-evidence re-fires on gate-verdict comments and evaluates trusted default-branch code

## Status

Accepted — 2026-07-29 ([PR 1483](https://github.com/mfittko/dev-loops/pull/1483))

## Context

The server-side `gate-evidence` required check ([0034](./0034-server-side-gate-evidence-required-check.md)) re-fired on push, ready-for-review, submitted reviews, and standalone review comments — the stale-GREEN direction (a newly-appearing unresolved thread). But gate verdicts themselves are posted as PR issue comments, and `issue_comment` was not a trigger, so posting a clean current-head `pre_approval_gate` verdict never re-evaluated the check: the required status stayed at whatever the pre-verdict run computed, and an otherwise-satisfied PR was unmergeable until an unrelated review event fired (the stale-PENDING direction; observed as a live merge deadlock on three consecutive PRs). Separately, review-comment-class triggers run in the base-repo context with `statuses: write`, which makes the choice of checkout ref security-relevant: evaluating the PR head's tree in such a run would let a fork PR substitute the detector (or an `npm ci` lifecycle script) and forge the required check.

## Decision

The workflow also triggers on `issue_comment` (`created`, `edited`), gated at the job level to PR-attached comments whose body carries the gate-comment marker (`### Gate review:`) so ordinary discussion never starts a run; because `issue_comment` payloads carry no `pull_request` object, a Resolve-PR-facts step resolves number/draft/head SHA once for all downstream steps. Evaluation always checks out the DEFAULT BRANCH (trusted code, `persist-credentials: false`); the resolved PR head SHA is used only as the explicit status target. Runs coalesce per PR through a job-level concurrency group (job-level deliberately: a workflow-level group would be joined by marker-skipped runs, letting ordinary comments cancel live evaluations), with superseded runs cancelled and barred from posting via `!cancelled()`. Recovery for a lost run when the verdict comment already exists is editing that comment (the `edited` event); `gh run rerun` is documented as a non-recovery because it replays the stale original payload.

## Consequences

Posting a gate verdict is now itself the deterministic re-fire, closing the stale-PENDING deadlock without manual review-event nudges. Trusted-base evaluation closes 0034's "self-reported / head-provenance" forge caveat for all comment-class triggers — the detector that computes the verdict can no longer be supplied by the PR under evaluation — at the cost that detector changes take effect for these runs only once merged. Two bounded residuals are accepted: a transient failure of the facts step's single (retried) API call ends the run with no status, leaving the prior status standing until the next verdict post/edit; and a gate-comment on a draft PR can join the concurrency group and cancel an in-flight evaluation while itself posting nothing, re-established by the next verdict event.
