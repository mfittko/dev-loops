# Reviewer Loop State Graph

This document defines the deterministic reviewer-side PR loop state machine.

## Overview

The reviewer loop captures observable PR/GitHub facts plus explicit local reviewer-loop metadata (planning/run/merge status) into one snapshot and deterministically maps that snapshot to exactly one current state.

This document defines the reviewer-side review production/submission boundary. The broader family-local PR lifecycle that consumes this boundary is defined in [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md).

Implementation:

- Pure logic: `packages/core/src/loop/reviewer-loop-state.mjs`
- Detector CLI: `scripts/loop/detect-reviewer-loop-state.mjs`
- Draft-review staging helper: `scripts/github/stage-reviewer-draft.mjs`

## State Definitions

| State | Meaning |
|---|---|
| <!-- term: state:waiting_for_review_request --> `waiting_for_review_request` | No active reviewer loop for this PR/head |
| `review_requested` | Review has been requested for the active reviewer |
| `determine_review_plan` | Review angles are being selected |
| `reviews_running` | Bounded local review passes are running |
| `merge_results` | Local review runs completed; merged synthesis pending |
| `draft_review_ready` | Merged review package is ready to stage |
| `draft_review_posted` | Pending GitHub review exists for current head but link not yet surfaced |
| <!-- term: state:waiting_for_user_submit --> `waiting_for_user_submit` | Pending review link is surfaced; wait for submission |
| `submitted_review` | Internal reviewer pass reached a submitted outcome/verdict; handoff boundary to remediation/fix follow-up |
| <!-- term: state:waiting_for_author_followup --> `waiting_for_author_followup` | Legacy external-wait compatibility state (named actor boundary: author/Copilot follow-up), not an internal reviewer-pass completion target |
| <!-- term: state:waiting_for_re_request --> `waiting_for_re_request` | Legacy external-wait compatibility state (named actor boundary: author/Copilot re-request action), not an internal reviewer-pass completion target |
| `review_invalidated` | Pending draft review is stale for current head SHA |
| `blocked_needs_user_decision` | Failure state requiring explicit user decision |

## Required transitions

Terminal state with no outgoing transitions: `blocked_needs_user_decision`.

- `waiting_for_review_request` -> `review_requested`
  - explicit review request received
- any active reviewer-pass state -> `blocked_needs_user_decision`
  - unexpected failure in planning, local review runs, or merge synthesis; "any active reviewer-pass state" means the five states `review_requested`, `determine_review_plan`, `reviews_running`, `merge_results`, and `draft_review_ready`
- `draft_review_posted` -> `blocked_needs_user_decision`
  - review submission fails (`reviewSubmissionStatus: "failed"`) before the surfaced-link wait is observed
- `waiting_for_user_submit` -> `blocked_needs_user_decision`
  - review submission fails (`reviewSubmissionStatus: "failed"`) after the draft link is surfaced
- `review_invalidated` -> `blocked_needs_user_decision`
  - review submission fails while the pending draft is already stale for the current head; the failure signal outranks invalidation handling
- `submitted_review` -> `blocked_needs_user_decision`
  - a submission-failure signal arrives alongside a recorded submitted review; fail closed pending explicit user decision
- `waiting_for_review_request` -> `blocked_needs_user_decision`
  - a lingering failure signal (planning, run, merge, or submission `failed`) on an open non-draft PR fails closed even with no otherwise-active pass
- `waiting_for_review_request` -> `submitted_review`
  - a recorded submitted outcome (`reviewSubmissionStatus: "submitted"`) settles with no other active pass signal
- `review_requested` -> `submitted_review`
  - a recorded submitted outcome outranks the request signal until an explicit new pass begins
- `determine_review_plan` -> `submitted_review`
  - a recorded submitted outcome outranks stale planning metadata
- `reviews_running` -> `submitted_review`
  - a recorded submitted outcome outranks stale run metadata
- `merge_results` -> `submitted_review`
  - a recorded submitted outcome outranks stale merge metadata
- `draft_review_ready` -> `submitted_review`
  - a recorded submitted outcome outranks a stale prepared-draft signal
- `review_requested` -> `determine_review_plan`
  - review angles are being selected
- `determine_review_plan` -> `reviews_running`
  - bounded local review passes start
- `reviews_running` -> `merge_results`
  - all bounded local review runs complete
- `merge_results` -> `draft_review_ready`
  - merged review package is ready to stage
- `draft_review_ready` -> `draft_review_posted`
  - pending GitHub draft review is created
- `draft_review_posted` -> `waiting_for_user_submit`
  - pending review link is surfaced
- `draft_review_posted` -> `review_invalidated`
  - draft review commit SHA no longer matches the PR head SHA
- `draft_review_posted` -> `submitted_review`
  - review submission settles as submitted before the surfaced-link wait is observed
- `waiting_for_user_submit` -> `submitted_review`
  - review submission settles as submitted
- `waiting_for_user_submit` -> `review_invalidated`
  - draft review commit SHA no longer matches the PR head SHA
- `submitted_review` -> `review_requested`
  - author/Copilot pushed a new head and a fresh review was explicitly re-requested
- `submitted_review` -> `waiting_for_review_request`
  - no active re-request yet
- `review_invalidated` -> `review_requested`
  - stale pending draft review is discarded and a new pass restarts
- `waiting_for_author_followup` -> `submitted_review`
  - legacy compatibility re-entry
- `waiting_for_author_followup` -> `review_requested`
  - legacy compatibility re-entry
- `waiting_for_author_followup` -> `waiting_for_review_request`
  - legacy compatibility re-entry
- `waiting_for_re_request` -> `review_requested`
  - legacy compatibility re-entry
- `waiting_for_re_request` -> `submitted_review`
  - legacy compatibility re-entry

`waiting_for_author_followup` and `waiting_for_re_request` are legacy external-wait
compatibility states: they are not produced by `interpretReviewerLoopState`, so the five
re-entry transitions above are owned by the outer-loop compatibility layer that consumes
this graph, not by this reviewer-loop machine itself.

## Snapshot Contract

`normalizeReviewerSnapshot` canonicalizes this schema:

- PR/observable: `prExists`, `prNumber`, `prDraft`, `prMerged`, `prClosed`, `prHeadSha`, `reviewRequested`
- reviewer-scope metadata: `reviewerScope`, `reviewerLogin`
- local planning/run/merge status: `localPlanningStatus`, `localReviewRunsStatus`, `localMergeStatus`, `draftReviewPrepared`
- staged draft review state: `draftReviewPosted`, `draftReviewId`, `draftReviewUrl`, `draftReviewCommitSha`, `draftReviewNotificationStatus`
- submitted review state: `submittedReviewPresent`, `submittedReviewCommitSha`, `submittedReviewState`
- explicit prior action-result state: `reviewSubmissionStatus`

`reviewerScope` is explicit machine-readable contract, not an inferred side note:
- `single_reviewer` means detection was scoped to one reviewer identity and `reviewerLogin` is that normalized login
- `all_reviewers` means `--reviewer-login` was omitted and the detector intentionally aggregated reviewer state across the PR

The contract separates observable current state (`submittedReviewPresent`, `submittedReviewCommitSha`, `submittedReviewState`, `draftReviewPosted`, `reviewRequested`) from prior action-result state (`reviewSubmissionStatus`) to avoid overloading one field.

## Deterministic Review Plan Contract

`selectReviewerPlan` produces bounded parallel review plans:

- supported angles: `correctness`, `tests`, `maintainability`, `security`, `scope`
- max fan-out is capped to 4
- default fan-out is 3
- output is deterministic (`runId` sequence + angle ordering)

<!-- rule: REVIEWER-STATE-GATE-ANGLE-MAPPING -->
`REVIEWER-STATE-GATE-ANGLE-MAPPING`: For `dev-loops`, the default pre-approval gate before calling a branch/PR
review-complete, approval-ready, merge-ready, or ready for final handoff uses
review angles resolved from config (`resolveGateAngles(config, "preApproval")`
from `@dev-loops/core/config`). Default config ships `dry`, `kiss`, `yagni`.
These are workflow lenses that reviewer runs must cover for the change; they do
not replace the state machine's supported review-angle taxonomy (`correctness`,
`tests`, `maintainability`, `security`, `scope`). The config-resolved lens
passes MUST map onto that existing taxonomy when planning or merging reviewer
runs so the workflow gate stays aligned with the deterministic review-plan
contract. Run those lens passes in fresh context and in parallel when
practical; if true parallelism is impractical, all configured angles MUST
still be covered and the limitation MUST be explicitly recorded in the merged
review artifact/verdict.

## Deterministic Merge/Synthesis Contract

`mergeReviewerResults` merges parallel review run outputs into one bounded machine-readable package:

- deduplicates findings by `path|line|message`
- classifies findings into `inlineComments` vs `summaryFindings`
- emits one deterministic verdict: `APPROVE`, `COMMENT`, or `REQUEST_CHANGES`
- preserves `headSha`, `runsMerged`, and `totalFindings`

`buildDraftReviewPayload` converts a merged review package into a deterministic pending-review payload:

- pins the pending review to `headSha`
- renders one deterministic summary body including verdict, totals, and summary findings
- emits only bounded inline comments with `path`, `line`, `body`, and `side: "RIGHT"`
- keeps draft-review creation separate from final review submission

## Reviewer-Boundary Contract (Review vs Remediation)

<!-- rule: REVIEWER-BOUNDARY-CONTRACT -->
`REVIEWER-BOUNDARY-CONTRACT`: A pure internal reviewer pass MUST end in a concrete review result boundary (`submitted_review`) rather than generic post-review waiting. After submission, author/Copilot remediation belongs to a separate remediation/fix loop handoff boundary (see broader remediation-loop work in #26). A new review request after fixes MUST start a new reviewer-pass context (`review_requested`) rather than extending the old pass indefinitely. If a wait state is used, it MUST be an explicit named external-participant boundary (for example author/Copilot follow-up, human approval wait, or external Copilot review wait), never a catch-all continuation state for internal reviewer logic. See [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) for the family-local lifecycle that consumes this boundary.

- A newly opened or still-forming draft PR head is not automatically review-ready; while the intended initial slice is still being authored, treat that as external follow-up/remediation boundary work, not a formal reviewer-verdict moment.
- Default forward-progress rule at this boundary: continue to the next relevant approval gate or explicit handoff boundary. Early stop is only valid for one of:
  - `blocked_needs_user_decision`
  - true external wait with named actor boundary
  - missing authorization
  - tooling failure
  - explicit human stop

## Detector CLI Contract

`node scripts/loop/detect-reviewer-loop-state.mjs` supports:

- `--input <path>` (snapshot interpretation only)
- `--repo <owner/name> --pr <number>` (auto-detect)
- optional: `--reviewer-login <login>`
- optional: `--review-requested <true|false>` (inject known request result)
- optional: `--local-state <path>` (inject local planning/run/merge metadata)

Reviewer-scope contract:
- with `--reviewer-login`, detection is for that single reviewer identity
- without `--reviewer-login`, detection intentionally aggregates across all reviewers on the PR
- success output snapshots always expose that choice through `snapshot.reviewerScope` and `snapshot.reviewerLogin`

Success output:

- `{ "ok": true, "snapshot": { ... }, "state": "...", "allowedTransitions": [...], "nextAction": "..." }`

Failure output:

- `{ "ok": false, "error": "..." }` on stderr with non-zero exit

## Key Deterministic Guarantees

State distinctness, invalidation, terminal/handoff boundary, and fail-closed guarantees are
defined by [State Definitions](#state-definitions), [Required transitions](#required-transitions),
and `REVIEWER-BOUNDARY-CONTRACT` above; this section does not restate them.

- round-cap exhaustion in a concluded Copilot cycle is not a blanket stop: significant post-convergence logic/test changes on a newer head open a new Copilot cycle and require re-request before pre-approval
