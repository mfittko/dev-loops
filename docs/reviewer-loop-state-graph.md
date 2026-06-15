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
| `waiting_for_review_request` | No active reviewer loop for this PR/head |
| `review_requested` | Review has been requested for the active reviewer |
| `determine_review_plan` | Review angles are being selected |
| `reviews_running` | Bounded local review passes are running |
| `merge_results` | Local review runs completed; merged synthesis pending |
| `draft_review_ready` | Merged review package is ready to stage |
| `draft_review_posted` | Pending GitHub review exists for current head but link not yet surfaced |
| `waiting_for_user_submit` | Pending review link is surfaced; wait for submission |
| `submitted_review` | Internal reviewer pass reached a submitted outcome/verdict; handoff boundary to remediation/fix follow-up |
| `waiting_for_author_followup` | Legacy external-wait compatibility state (named actor boundary: author/Copilot follow-up), not an internal reviewer-pass completion target |
| `waiting_for_re_request` | Legacy external-wait compatibility state (named actor boundary: author/Copilot re-request action), not an internal reviewer-pass completion target |
| `review_invalidated` | Pending draft review is stale for current head SHA |
| `blocked_needs_user_decision` | Failure state requiring explicit user decision |

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

For `dev-loops`, the default pre-approval gate before calling a branch/PR
review-complete, approval-ready, merge-ready, or ready for final handoff uses
review angles resolved from config (`resolveGateAngles(config, "preApproval")`
from `@dev-loops/core/config`). Default config ships `dry`, `kiss`, `yagni`.
These are workflow lenses that reviewer
runs must cover for the change; they do not replace the state machine's supported
review-angle taxonomy (`correctness`, `tests`, `maintainability`, `security`,
`scope`). Instead, map the config-resolved lens passes onto that existing taxonomy when
planning or merging reviewer runs so the workflow gate stays aligned with the
deterministic review-plan contract. Run those lens passes in fresh context and in
parallel when practical. If true parallelism is impractical, all configured
angles still require coverage and the limitation must be explicitly recorded in
the merged review artifact/verdict.

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

- A pure internal reviewer pass must end in a concrete review result boundary (`submitted_review`) rather than generic post-review waiting.
- After submission, author/Copilot remediation belongs to a separate remediation/fix loop handoff boundary (see broader remediation-loop work in #26).
- A new review request after fixes starts a new reviewer-pass context (`review_requested`) rather than extending the old pass indefinitely.
- A newly opened or still-forming draft PR head is not automatically review-ready; while the intended initial slice is still being authored, treat that as external follow-up/remediation boundary work, not a formal reviewer-verdict moment.
- If a wait state is used, it must be an explicit named external-participant boundary (for example author/Copilot follow-up, human approval wait, or external Copilot review wait), never a catch-all continuation state for internal reviewer logic.
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

- planning/running/merge-ready states are explicitly represented
- draft-ready vs draft-posted vs waiting-for-submit vs submitted are distinct
- pending draft reviews are invalidated when `draftReviewCommitSha !== prHeadSha`
- submitted review is the internal reviewer-loop terminal/handoff boundary
- review re-entry requires an explicit re-request in a new review pass context
- `waiting_for_author_followup` / `waiting_for_re_request` are legacy external-wait compatibility states, not preferred internal loop terminals
- unexpected failures fail closed into `blocked_needs_user_decision`
