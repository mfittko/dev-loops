# Shared script area

This directory is reserved for deterministic workflow entrypoints.

Scripts here should prefer:

1. native `gh ... watch` support when it matches the exact wait condition,
2. shared package helpers for pure parsing and state logic,
3. stable machine-readable JSON output for skills and async workflows.

In this source-loaded workspace repo, root scripts may consume shared package helpers through a thin local adapter rather than a published package import path so the checkout remains runnable without an install step.

## Authority note

For the script surfaces documented here:
- code, tests, and the helper entrypoints themselves are authoritative for shipped runtime behavior
- this README summarizes those contracts for operators and maintainers; if behavior changes, update the code/tests and then sync this document
- use the more specific state-graph and contract docs under `docs/` when a helper family has a narrower machine-readable contract that this README is summarizing

## Scripts

### `scripts/docs/validate-links.mjs`

Validate repo-owned markdown relative links for the shipped docs / skills / agent surface.

Usage:
- `node scripts/docs/validate-links.mjs`

Optional:
- `--root <path>` — override the repo root to scan (used by deterministic tests and local dry-runs against another checkout)

Contract:
- scans these markdown sources only: `README.md`, `PLAN.md`, `AGENTS.md`, `scripts/README.md`, `extension/README.md`, `docs/**/*.md` (excluding `docs/archive/**`), `skills/**/*.md`, and `agents/**/*.md`
- validates inline relative markdown links after resolving them from the containing file
- strips any `#fragment` before checking the filesystem
- treats existing files and directories as valid targets
- ignores external URLs, `mailto:`, fragment-only links, image links, and links inside fenced code blocks
- supports a checked-in narrow ignore list through repo-root `.linkcheckignore` for intentional symbolic placeholder targets (for example `docs/phases/phase-x.md`)
- prints actionable broken-link output with source file, line, raw target, resolved path, and a suggestion only when one clear candidate exists

Failure behavior:
- exits `0` when all validated links resolve
- exits `1` when one or more broken links are found
- exits non-zero (other than `1`) for usage/runtime failures

### `scripts/github/capture-review-threads.mjs`

Capture and normalize PR review-thread JSON from all reviewers.

Supported inputs:
- `--input <path>`
- stdin JSON
- live GitHub capture with `--repo <owner/name> --pr <number>`

Optional:
- `--output <path>` writes the same success JSON emitted on stdout
- `--unresolved --bodies` (only valid together) selects the fix-loop working-set view: only unresolved threads, each as `{ threadId, path, line, isOutdated, bodies: [...] }` with comment bodies joined in thread order; the `comments[]` array is absent in this mode

Contract:
- live capture loads review threads from all reviewers; no author filter is applied, and pagination walks past 100 threads

Success output shape (default mode):
- `{ "ok": true, "source": { ... }, "summary": { ... }, "threads": [...], "comments": [...] }`
- normalized `comments[]` preserve both the GraphQL comment node id (`id`) and the REST-safe numeric review-comment id (`databaseId`) when available
- normalized `threads[]` include `commentDatabaseIds` and `actionableCommentDatabaseIds` so follow-up helpers can pair `--comment-id` and `--thread-id` from the same fresh snapshot
- when `--output` is used, success output also includes `"outputPath"`

Failure behavior:
- malformed arguments, invalid JSON, and `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero
- live capture is only allowed when both `--repo` and `--pr` are present

### `scripts/github/create-pr.mjs`

Canonical wrapper around `gh pr create`. Every PR opened through this tool is ALWAYS a draft and is always assigned — self-assigned by default (`--assignee @me` when none is given), while still honoring an explicit `--assignee <login>`. Never call raw `gh pr create` to open a PR. (`dev-loops pr create` dispatches here; the legacy `dev-loops pr create-draft` subcommand still works as a deprecated alias.)

Usage:
- `node scripts/github/create-pr.mjs [gh pr create args...]`
- `node <resolved-skill-scripts>/github/create-pr.mjs [gh pr create args...]`

Contract:
- injects exactly one `--draft` when the caller did not already supply it (draft is the only mode)
- self-assigns by default (defaults `--assignee @me` when no `--assignee` is provided); honors an explicit `--assignee <login>` when one is given
- rejects `--ready` before invoking `gh`; use `gh pr ready` later after draft-gate approval
- forwards every other argument to `gh pr create` unchanged and in order
- preserves the underlying `gh pr create` stdout, stderr, and exit code without wrapping success output
- stays intentionally narrow: this is the prevention layer for draft-first creation, while `scripts/github/reconcile-draft-gate.mjs` remains the separate recovery path for already-open non-draft PRs — that recovery only completes for a PR under the light-mode threshold (it posts an inline verdict); a larger PR must convert to draft and run the real fan-out gate instead

Failure behavior:
- wrapper-owned validation failures emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- when `gh pr create` itself exits non-zero, this wrapper preserves the original stdout/stderr and propagates the same exit code

### `scripts/github/request-copilot-review.mjs`

Request Copilot review on a PR and verify the request deterministically.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--force-rerequest-review` — bypass the round cap when new commits exist since the last Copilot review. Refused with `no_changes_since_last_review` when the PR head has not changed since the last review. No-op when the round cap has not been reached. Normal requests now automatically re-open at round cap when the head changed, all prior feedback is resolved, and current GitHub CI is green.

Contract:
- checks `requested_reviewers` first so an existing Copilot request is detected without mutating PR state again
- requests Copilot via `gh pr edit <pr> --repo <owner/name> --add-reviewer @copilot`
- is suitable both for the first request after ready-for-review and for later explicit re-requests after follow-up fix commits land on the PR head
- enforces a round cap (default: 5, configurable via `maxCopilotRounds` in settings); clean round-cap PRs with new commits, resolved threads, and green current GitHub CI automatically re-open for a normal re-request, while `--force-rerequest-review` remains the operator override for other new-commit cases
- should be paired with a fresh unresolved-thread check after Copilot posts again; requesting review alone does not complete the loop
- verifies the result through `gh api repos/<owner>/<name>/pulls/<pr>/requested_reviewers`
- does **not** rely on `gh pr view --json reviewRequests`, which can be incomplete for Copilot reviewer state
- normalizes known repository/tooling limitations into a machine-readable `unavailable` result instead of forcing callers to parse ad hoc stderr

Success output shape:
- `{ "ok": true, "status": "requested"|"already-requested"|"unavailable"|"suppressed_same_head_clean"|"blocked_by_copilot_comment"|"round_cap_reached"|"no_changes_since_last_review"|"suppressed_post_convergence_docs_only"|"suppressed_draft", "repo": "owner/name", "pr": 17, "reviewer": "Copilot", ... }`
- `unavailable` also includes a `detail` string with the normalized GitHub/CLI limitation
- `round_cap_reached` includes `completedRounds` and `maxRounds` fields
- `suppressed_post_convergence_docs_only`, like `round_cap_reached`, carries `completedRounds` and `maxRounds` and is a suppressed (non-request) outcome: at the round cap, the post-convergence head bump is a provable pure doc/prose delta since the last Copilot-reviewed head, so no fresh blocking round is forced
- `no_changes_since_last_review` is returned by `--force-rerequest-review` when the PR head SHA has not changed since the last Copilot review

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/detect-linked-issue-pr.mjs`

Detect whether an issue already has an open linked PR in the same repository.

Required:
- `--repo <owner/name>`
- `--issue <number>`

Contract:
- queries issue timeline linked-PR events (`CONNECTED_EVENT`, `CROSS_REFERENCED_EVENT`)
- pages through timeline items until `hasNextPage=false`
- keeps only open linked PRs in the same repository (`repository.nameWithOwner === <repo>`)
- also tracks closed-unmerged (state=`CLOSED`) same-repo linked PRs separately
- chooses deterministically when multiple candidates remain:
  1. prefer `CONNECTED_EVENT` candidates over `CROSS_REFERENCED_EVENT`
  2. then choose newest linked-event `createdAt`
  3. then stable fallback by PR number/url
- returns a machine-readable selection payload for skills/workflows; callers should not re-implement query/pagination/tie-break logic in markdown policy text

Success output shape:
- when `hasOpenLinkedPr: true`: `{ "ok": true, "repo": "owner/name", "issue": 85, "hasOpenLinkedPr": true, "prNumber": 90, "prUrl": "...", "selection": { "eventType": "...", "eventCreatedAt": "..." } }`
- when `hasOpenLinkedPr: false`: `{ "ok": true, "repo": "owner/name", "issue": 85, "hasOpenLinkedPr": false, "prNumber": null, "prUrl": null, "hasPriorClosedUnmergedPr": true|false, "priorClosedUnmergedPrNumber": 149|null, "priorClosedUnmergedPrUrl": "..."|null }`

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/resolve-tracker-local-spec.mjs`

Resolve the canonical spec bundle for tracker-backed local implementation from one
GitHub issue reference. This is the bounded GitHub-backed path for tracker-backed
local spec resolution; it does not create or read `docs/phases/phase-<n>.md`.

Allowed inputs:
- `--repo <owner/name>` with `--issue <number>`
- `--issue-url <github issue url>`

Contract:
- deterministically resolves exactly one repo slug + issue number pair
- reads the GitHub issue via `gh issue view <number> --repo <owner/name> --json number,title,body,url,state`
- treats the issue as canonical for tracker-backed local sessions
- always reports `localPhaseDocAllowed: false` so callers do not silently maintain a duplicate local phase doc for the same session
- leaves full tracker-sync policy to higher-level callers; this helper's bounded responsibility is spec resolution only

Success output shape:
- `{ "ok": true, "repo": "owner/name", "issue": 85, "issueUrl": "...", "state": "OPEN"|"CLOSED", "title": "...", "body": "...", "canonicalSpecSource": "tracker_issue", "localImplementationMode": "tracker_backed", "localPhaseDocAllowed": false, "stateSync": "tracker_issue_is_canonical" }`

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- unexpected `gh` failures and malformed `gh` JSON emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/manage-sub-issues.mjs`

Deterministic helper for reading, linking, ordering, and verifying GitHub sub-issue trees.
Use this for epic/umbrella issue decomposition. See [Sub-Issue Tree Contract](../skills/docs/sub-issue-tree-contract.md) for the full workflow.

Commands:
- `list` — list sub-issues of a parent issue in tree order
- `add` — attach a child issue to a parent as a real GitHub sub-issue
- `reorder` — set the execution order of sub-issues (highest priority first)
- `verify` — verify that the current sub-issue tree matches an expected set (and optionally order)

Required for all commands:
- `--repo <owner/name>`
- `--issue <number>` (parent issue)

`add` adds: `--child <number>`
`reorder` adds: `--order <n1,n2,...>` (comma-separated issue numbers in desired execution order)
`verify` adds: `--expected <n1,n2,...>` and optional `--ordered` flag

Contract:
- `add` resolves the child issue's internal GitHub id before calling the sub-issues REST endpoint
- `reorder` first lists current sub-issues to validate all specified numbers are already in the tree, then issues sequential priority-update API calls
- `verify` is read-only and exits 0 for mismatch-only results; `"verified": false` is a machine-readable signal, not a process failure. Argument errors and unexpected `gh`/runtime failures still exit non-zero
- do not re-implement sub-issue management ad hoc or bypass this helper

Success output shapes:
- `list`: `{ "ok": true, "repo": "owner/name", "issue": N, "command": "list", "subIssues": [{ "number": M, "title": "...", "state": "...", "id": ID }, ...] }`
- `add`: `{ "ok": true, "repo": "owner/name", "issue": N, "command": "add", "child": M }`
- `reorder`: `{ "ok": true, "repo": "owner/name", "issue": N, "command": "reorder", "order": [n1, n2, ...] }`
- `verify`: `{ "ok": true, ..., "command": "verify", "verified": true|false, "expected": [...], "actual": [...], "missing": [...], "unexpected": [...] }` (plus `"orderMismatch": true` when `--ordered` and only the order differs)

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero
- argument errors also include `"usage"` in the error payload

### `scripts/refine/verify.mjs`

Verify epic-tree refinement structure and contracts in one pass.

Usage:
- `node scripts/refine/verify.mjs --issue <number> [--repo <owner/name>] [--json]`
- `node scripts/refine/verify.mjs --input <path> [--json]`

Contract:
- runs four deterministic checkers:
  - `prose-linkage-detector` (forbidden prose parent/child/dependency markers + missing API links + duplicate child checklists)
  - `scope-boundary-cross-checker` (mutual-exclusion gaps + duplicate sibling ownership)
  - `refinement-completeness-checker` (AC/DoD/non-goals/matrix presence + explicit scope boundary)
  - `tree-integrity-validator` (parent links, orphan detection, cycles, max depth 3)
- online mode (`--issue`) walks GitHub sub-issues API from the root issue
- offline mode (`--input`) validates a local refinement tree JSON snapshot
- default output is human-readable text; `--json` emits machine-readable output for CI

Failure behavior:
- checker findings are process-failing (`exit 1`) because verification did not pass
- malformed arguments and runtime errors emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/stage-reviewer-draft.mjs`

Stage a pending reviewer-side draft review from a merged deterministic review package.

Required:
- `--repo <owner/name>`
- `--pr <number>`
- `--review-file <path>`

Optional:
- `--local-state-output <path>` writes/merges deterministic draft-review metadata for later
  `detect-reviewer-loop-state.mjs --local-state` use

Contract:
- reads a merged reviewer result JSON file (for example output derived from `mergeReviewerResults`)
- builds a deterministic pending-review payload pinned to the review package `headSha`
- posts the pending review to `repos/<owner>/<name>/pulls/<pr>/reviews` without an `event` field so GitHub keeps it pending
- returns the draft review id/url/commit sha
- optionally writes bounded local reviewer-loop metadata including `draftReviewPosted`, `draftReviewId`, `draftReviewUrl`, `draftReviewCommitSha`, and `draftReviewNotificationStatus`

Success output shape:
- `{ "ok": true, "repo": "owner/name", "pr": 17, "reviewId": 456, "reviewUrl": "...", "reviewState": "PENDING", "commitSha": "abc123", "localStatePath": "..."|null }`

Failure behavior:
- malformed arguments, invalid review JSON, missing `headSha`, unexpected `gh` failures, and malformed review-create responses emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/reply-resolve-review-thread.mjs`

Reply to a PR review comment and resolve the associated review thread deterministically.

Required:
- `--repo <owner/name>`
- `--pr <number>`
- `--comment-id <number>`
- `--thread-id <node-id>`
- `--body-file <path>`

Contract:
- reads the reply body from a file so shell quoting does not become part of the workflow logic
- validates the live PR thread snapshot before mutating GitHub so `--comment-id` and `--thread-id` must refer to the same thread on the target PR
- posts the reply to `repos/<owner>/<name>/pulls/<pr>/comments/<comment-id>/replies`
- resolves the thread with the GraphQL `resolveReviewThread` mutation
- fails if the thread does not report resolved after the mutation

Success output shape:
- `{ "ok": true, "repo": "owner/name", "pr": 17, "commentId": 123, "threadId": "...", "replyId": 456, "replyUrl": "...", "resolved": true }`

Failure behavior:
- malformed arguments, empty body files, missing threads, missing comments, comment/thread mismatches, unexpected `gh` failures, and unsuccessful resolve responses emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/reply-resolve-review-threads.mjs`

Reply to all matching unresolved review threads on one PR and optionally resolve them with one bounded note.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--author <login>` (default `all`)
- `--message <text>` or stdin: the single shared reply body for every matched thread. Mutually exclusive with `--message-map`
- `--message-map <path>`: a JSON file mapping threadId to that thread's distinct reply body, so each thread's resolving reply names the change that fixed it. Every matched thread must have an entry, or the run fails closed listing the unmapped thread ids before any mutation; stdin is never read in this mode. Mutually exclusive with `--message`
- `--resolve`

Contract:
- captures one authoritative review-thread snapshot via `capture-review-threads.mjs`
- filters to unresolved threads containing at least one comment by the selected author
- chooses the newest matching author-authored comment in each matched thread as the REST reply target
- with `--message-map`, validates full coverage of every matched thread before sending any reply/resolve mutation, and fails closed listing the unmapped thread ids otherwise
- processes matched threads sequentially in deterministic snapshot order
- reuses the shared single-thread reply/resolve primitives instead of duplicating GitHub mutation logic
- with `--resolve`, re-captures the review-thread snapshot at the end and fails closed if any newly-targeted thread remains unresolved
- zero-match runs are deterministic no-ops with success JSON

Success output shape:
- `{ "ok": true, "repo": "owner/name", "pr": 17, "author": "all", "resolve": true|false, "matchedThreadCount": 2, "repliedThreadCount": 2, "resolvedThreadCount": 2, "skippedThreadCount": 1, "results": [{ "threadId": "...", "commentId": 123, "replyId": 456, "replyUrl": "...", "resolved": true }] }`

Failure behavior:
- malformed arguments, empty/conflicting message input, malformed thread snapshots, unexpected `gh` failures, reply failures, resolve failures, and failed post-resolve verification emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero
- when partial progress exists, stderr JSON also includes `partialProgress`

For new GitHub mutation helpers in this repo, do not stop at fixture-only confidence when a real PR is available and mutation is authorized. Run a bounded real-PR smoke check before depending on the helper inside a longer async review/fix loop.

### `scripts/github/probe-copilot-review.mjs`

Watch for fresh Copilot-authored review activity on a PR.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--poll-interval-ms <positive-integer>` (default `60000`, i.e. 1 minute)
- `--timeout-ms <non-negative-integer>` (default `1800000`, i.e. 30 minutes)

Contract:
- captures a baseline snapshot, then performs a bounded number of follow-up polls
- returns `changed` for any fresh Copilot-authored review-thread comments, PR review summaries, or PR issue comments that were not present in the baseline snapshot
- ignores fresh non-Copilot review activity across those same surfaces
- `--timeout-ms 0` performs a single immediate recheck and returns `idle` if unchanged

Success output shape:
- `{ "ok": true, "status": "changed"|"timeout"|"idle", "repo": "owner/name", "pr": 17, "attempts": 1, "newComments": [...], "newReviews": [...], "newIssueComments": [...] }`

Failure behavior:
- malformed arguments and `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/detect-initial-copilot-pr-state.mjs`

Detect the post-assignment issue-to-linked-PR seam for Copilot handoff.

Required:
- `--repo <owner/name>`
- `--issue <number>`

Contract:
- uses `scripts/github/detect-linked-issue-pr.mjs` as the authoritative linked-PR selector
- returns exactly one deterministic state:
  - `no_linked_pr`
  - `prior_linked_pr_closed_unmerged`
  - `copilot_session_active`
  - `waiting_for_initial_copilot_implementation`
  - `linked_pr_ready_for_followup`
- uses `scripts/loop/detect-copilot-session-activity.mjs` on the linked PR head branch for Copilot-authored draft PRs
- while `activity=active`, emits `copilot_session_active` regardless of commit/file-count heuristics
- approval-gated `action_required` Copilot/Actions runs are treated as observational (non-active) for this bootstrap seam
- for non-bootstrap linked PRs, falls back to the existing substantive PR heuristics when session activity is `idle` or `concluded`
- if the session-activity check itself fails, the helper fails closed instead of pretending session state was unavailable
- classifies `prior_linked_pr_closed_unmerged` when there is no open linked PR but a same-repo linked PR was previously closed without merging; this is a terminal non-wait state requiring human reconciliation
- classifies `waiting_for_initial_copilot_implementation` only for the bounded bootstrap-only draft shape:
  - open same-repo linked PR
  - draft
  - Copilot-authored (`Copilot`, `copilot-swe-agent`, `app/copilot-swe-agent`, or `copilot-swe-agent[bot]`)
  - exactly 1 commit
  - sole commit headline exactly `Initial plan`
  - exactly 0 changed files
- fails closed with explicit error output when required PR facts cannot be fetched

Success output shape:
- `{ "ok": true, "repo": "owner/name", "issue": 59, "state": "...", "prNumber": 79|null, "prUrl": "..."|null, "headBranch": "..."|null, "authorLogin": "Copilot"|null, "isDraft": true|false|null, "changedFiles": 0|null, "commitCount": 1|null, "soleCommitHeadline": "Initial plan"|null, "sessionActivity": "active"|"concluded"|"idle"|null, "sessionRunId": 123|null, "sessionRunName": "..."|null, "sessionRunStatus": "..."|null, "sessionRunConclusion": string|null, "sessionRunCreatedAt": "..."|null, "sessionConfidence": "high"|null }`

### `scripts/loop/run-conductor-cycle.mjs`

Poll all open PRs, detect gate state, and emit an ordered action queue.

Output `actions[]` entries include:
- `requiresSubagent`
- `requiresApproval`
- `handoffContract` with:
  - `ownership`
  - `stopBoundary`
  - `resumePolicy`

The handoff contract is recorded on each action so parent, child, and resume
actions can share one explicit stop/resume boundary.

Contract values:
- `ownership`: `subagent`, `parent`, `human`, or `terminal`
- `stopBoundary`: `subagent_exit`, `watch_boundary`, `approval_boundary`,
  `merge_boundary`, `conflict_boundary`, or `terminal_boundary`
- `resumePolicy`: `resume_after_subagent_exit`,
  `resume_after_state_refresh`, `resume_after_human_approval`,
  `resume_after_merge_authorization`, `manual_attention`, or `none`

`run-conductor-cycle.mjs` emits the contract-boundary values above. The parser
also accepts `PR_CHECKPOINT` values when reading recorded artifacts so older
recorded handoff notes can still be validated fail-closed.

### `scripts/loop/conductor-monitor.mjs`

Aggregate the current Copilot-loop status for every open PR in one repository.

Required:
- `--repo <owner/name>`

Optional:
- `--auto-resume` — inspect documented pi-subagents async/session artifacts on disk, detect orphaned open PR follow-up runs, and emit deterministic resume plans without executing `subagent({ action: "resume" })`
- `--skip-status-check` — skip the cheap GitHub-status pre-flight that gates `--auto-resume` (also skipped via `DEVLOOPS_SKIP_GITHUB_STATUS_CHECK=1`). The pre-flight curls the GitHub status API and bails before listing PRs when GitHub is degraded, so an auto-resume schedule firing during a GitHub outage costs near-zero instead of burning a dev-loop startup (#1633).

Contract:
- lists all open PRs via `gh pr list --state open --limit 1000` to avoid GitHub CLI default truncation
- reuses `detect-copilot-loop-state.mjs` logic for each PR instead of inventing a second state classifier
- reports one queue-level summary with per-PR loop state, next action, and whether human follow-up is needed now
- reports `queue_complete` when the open-PR queue is empty
- keeps the current implementation human-in-the-loop; fully autonomous monitor ownership is a follow-up slice
- when `--auto-resume` is present, scans documented async evidence sources only:
  - pi-subagents async run dirs under `<tmpdir>/pi-subagents-*/async-subagent-runs/<runId>/`
    (`status.json`, `events.jsonl`, `output-<n>.log`)
  - pi-subagents async result artifacts under
    `<tmpdir>/pi-subagents-*/async-subagent-results/`
  - persisted session/subagent artifacts under the Pi sessions tree (for example
    `~/.pi/agent/sessions/.../subagent-artifacts/*_dev-loop_*_meta.json` and
    `~/.pi/agent/sessions/.../subagent-artifacts/*_dev-loop_*_output.md`
    plus matching `run-<n>/session.jsonl` files)
- ignores non-`dev-loop` agents, other repositories, merged PRs, and any exited run superseded by a newer matching `running` or `queued` run
- matches exited runs to open PRs only by PR number parsed from artifact text; branch names, issue numbers, or worktree paths alone are never sufficient identity
- fail-closes to `needsManualAttention` when PR identity, artifact state, or resume inputs are missing, contradictory, or ambiguous
- `--auto-resume` remains single-shot only; it does not poll, sleep, watch, or execute the resume itself
- when `--auto-resume` is present and the status check is not skipped, a degraded GitHub status (anything other than `good`) bails with `queueStatus: "github_degraded"`, `githubDegraded: true`, a `githubStatus: { status, detail }` field, and zero resume plans, so the auto-resume schedule never dispatches a dev-loop run during an outage (#1633); a status-endpoint fetch error is fail-open (the normal `listOpenPrs` flow is the backstop)
- `DEVLOOPS_GITHUB_STATUS_URL` overrides the GitHub status endpoint (default `https://api.github.com/status`); `DEVLOOPS_SKIP_GITHUB_STATUS_CHECK=1` skips the pre-flight entirely

Success output shape:
- default:
  - `{ "ok": true, "repo": "owner/name", "checkedAt": "...", "prCount": 2, "queueStatus": "queue_complete"|"monitoring"|"attention_needed"|"github_degraded", "needsAttentionCount": 0, "summary": { "waiting": 0, "needsAttention": 0, "blocked": 0, "done": 0 }, "prs": [...] }`
- with `--auto-resume`:
  - adds
    `{ "autoResumeRequested": true, "orphanedPrCount": 1, "resumePlanCount": 1, "manualAttentionCount": 0, "resumePlans": [...], "needsManualAttention": [...] }`

`resumePlans[]` fields:
- `pr`
- `runId`
- `runState` (`completed` | `failed` | `paused`)
- `artifactPath`
- `sessionPath` when known
- `parsedArtifactState`
- `parsedLoopState`
- `livePrState`
- `resumeAction`
- `handoffContract`
- `recordedHandoffContract` when the artifact explicitly records one
- `resumeMessage`
- `resumeCommandPreview`
- `staleWorktree`

If a recorded handoff contract is present, it must include explicit
`Handoff ownership`, `Stop boundary`, and `Resume policy` lines. The monitor
fails closed when those fields are partial, invalid, or conflict with the
live-derived resume plan.

`needsManualAttention[]` fields:
- `pr` when known
- `runId` when known
- `reason`
- `evidence`
- `suggestedNextStep`

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/detect-copilot-session-activity.mjs`

Detect deterministic Copilot workflow session activity on a branch.

Required:
- `--repo <owner/name>`
- `--branch <name>`

Optional:
- `--limit <positive-integer>` (default `20`)

Contract:
- uses `gh run list --branch <branch>` as the primary signal
- pattern-matches known Copilot run names (`Copilot coding for issue`, `Addressing comment on PR`, `Addressing review on PR`)
- classifies activity as:
  - `active` when a matching run is currently in progress
  - `concluded` when the most recent matching run is completed
  - `concluded` (non-blocking observational) when a matching run is approval-gated in `action_required`; the payload still preserves the raw `runStatus` / `runConclusion` strings for debugging
  - `idle` when no matching runs are found

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/copilot-pr-handoff.mjs`

Thin high-level helper for the common Copilot PR follow-up handoff path.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--watch-status <changed|timeout|idle>` — refresh deterministic state after a prior watcher observation; this readback mode never requests review again

Contract:
- this helper is the source of truth for normal request/re-request/watch routing on Copilot PR follow-up
- emits deterministic `action` + `nextAction` + `reviewRequestStatus` and a helper-owned `requestWatchContract` envelope for status interpretation
- enters watch only when request state is confirmed (`requested` or `already-requested`) and emits exact `watchArgs` + `watchTimeoutPolicy`
- watch refresh (`--watch-status`) is observational-only; rely on refreshed `loopDisposition` + `terminal` to decide whether to continue or stop
- explicit stop/blocked routing is machine-readable via `action: "stop"` plus `requestWatchContract.stopState`
- when `DEVLOOPS_RUN_ID` is set to a non-empty value, the helper enforces one-runner-per-PR ownership and returns `runnerOwnership` details when a conflicting or displaced run must stop

Success output shape:
- `{ "ok": true, "action": "watch"|"fix"|"stop", "state": "...", "allowedTransitions": [...], "nextAction": "...", "snapshot": {...}, "reviewRequestStatus"?: "...", "watchStatus"?: "...", "autoRerequestEligible": true|false, "sameHeadCleanConverged": true|false, "loopDisposition": "...", "terminal": true|false, "requestWatchContract": { "action": "...", "nextAction": "...", "requestStatus": "requested"|"already-requested"|"unavailable"|"failed"|"none", "routingState": "copilot_request_confirmed_waiting"|"ready_state_needs_copilot_request"|"draft_reset_requires_ready_state_reentry"|"non_ready_state", "watchEntryConfirmed": true|false, "watchArgs": { ... }|null, "stopState"?: "unavailable"|"blocked"|"draft_requires_ready_state_reentry"|"no_automatic_next_step" }, "watchTimeoutPolicy"?: { "classification": "external_healthy_wait", "minimumTimeoutMs": 1800000, "defaultTimeoutMs": 1800000 }, "watchArgs"?: { ... } }`

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/pr-runner-coordination.mjs`

Durable one-runner-per-PR coordination helper.

Subcommands:
- `status` — inspect current ownership record for one PR
- `claim` — claim ownership when no active runner exists; otherwise fail closed with machine-readable conflict details
- `takeover` — explicit replacement path that records prior/new run ids
- `assert` — verify the current run still owns the PR; `--require-existing` fails closed when async pre-merge ownership proof is missing
- `release` — clear ownership when the active run is done

State path:
- `.pi/runner-coordination/<owner>/<repo>/pr-<number>.json`
- this is local coordination state under `.pi/`; keep it uncommitted like other repo-local runtime artifacts

Integration notes:
- `copilot-pr-handoff.mjs` uses this surface for async run ownership checks
- `detect-checkpoint-evidence.mjs` uses strict ownership assertion before async merge-time gate evaluation

Release-on-death & dead-claim supersession (#1706):
- A run that ends without an explicit `release` still must not leave a leaky lock that blocks the
  next legitimately-dispatched run. `_pr-runner-coordination.mjs` exposes an exit-signal record
  (`recordExitSignalForRunner`) plus a process-exit sweep (`releaseRunClaimsOnExit`) that the
  headless dev-loop driver invokes after its spawned run terminates (completed/killed/timed out/
  crashed).
- `ensureAsyncRunnerOwnership(..., { supersedeStale: true })` — used by `copilot-pr-handoff` — takes
  over a competing claim whose owning run is **confirmed dead** (exit signal recorded) or past the
  stale-max-age window, so pre-flight handoff proceeds instead of returning a blocking stop against a
  leaked lock. A genuinely live owner still stands the handoff down (one-runner-per-PR preserved);
  only confirmed-dead or stale claims are superseded.
- Anti-trap: a fresh heartbeat on a runner-coordination claim/lock is not proof of a live driver. The
  claim may be held by a completed/control run that claimed at takeover then ended without releasing,
  yet the heartbeat still reads fresh — which this rc.6 drive saw as repeated false "live owner /
  standing down" stalls. LIVE means a subagent run verified via `subagent status` (a harness command,
  not a repo script or CLI) showing an actively-updating `EXECUTING` child (a workflow child active
  now with a recent update). Before any stand-down or dispatch decision, confirm real execution via
  `subagent status`; never trust the claim heartbeat alone. Only genuinely-executing runs count as a
  live owner.

### `scripts/loop/detect-agent-stall.mjs`

Agent-level stall probe (#1669). Detects whether a dev-loop child has stalled — no turn progress for
N minutes with no pending supervisor request — without falsely bailing a sanctioned long watch (an
active tool call that heartbeats its runner claim).

Required: `--repo <owner/name>`

Optional: `--pr <n>` (read sanctioned-watch heartbeat from runner-coordination state), `--status <path>`
(until `status.json` `lastActivityAt`/`lastUpdate`), `--session <path>` (session.jsonl mtime when no
`--status`), `--threshold-min <n>` (default 5), `--pending-request`, `--pending-marker <path>`,
`--run-id <id>`, `--cwd <path>`, `--last-action <text>`.

Verdict statuses: `stalled` | `not_stalled` | `no_evidence`. Emits a structured verdict plus a
recovery brief for a fresh-context dispatch. Pure detector lives in
`@dev-loops/core/loop/agent-stall`; config surface is `workflow.stallDetection`. See
`skills/docs/agent-stall-detection.md`.

### `scripts/loop/run-watch-cycle.mjs`

Deterministic handoff → watch helper for one Copilot wait-cycle boundary.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--probe-only` — use a single immediate recheck (`timeoutMs: 0`) for explicit status probes only

Contract:
- runs `copilot-pr-handoff.mjs` first and preserves its current state / next action / watch args
- when handoff stays in watch mode, checks Copilot session activity on the PR head branch via `detect-copilot-session-activity.mjs`
- when activity is `active`, blocks on `gh run watch <run-id>` and then continues with the same emitted persistent watch budget instead of silently degrading to a zero-timeout probe
- when handoff returns `action: "watch"`, runs `probe-copilot-review.mjs` with the emitted `watchArgs`; zero-timeout probes are reserved for explicit `--probe-only` status checks
- treats `waiting_for_copilot_review` as a persistence boundary, not a completion boundary
- for explicit async loop entry/continuation, `cycleDisposition: "pending"` with `terminal: false` means stay attached and run another watch boundary rather than exiting as clean success
- after a follow-up fix / reply-resolve / re-request path returns to `waiting_for_copilot_review`, resume this helper again instead of treating the re-request handoff as completion
- handoff-only behavior must be explicitly requested; do not silently reinterpret async loop entry as one-step transition behavior
- preserves the shared Copilot-loop `loopDisposition` contract from the handoff/state-machine output (`pending`, `unresolved_feedback`, `clean_converged`, `blocked`, `action_required`, `done`)
- exposes the helper's coarser wait-cycle summary separately as `cycleDisposition`
- reports `cycleDisposition: "pending"` for quiet watch results (`timeout` or explicit probe `idle`) instead of pretending the loop concluded cleanly
- reserves zero-timeout `idle` probes for explicit status/reattach checks; normal async waiting should use the emitted non-zero watch timeout
- returns `cycleDisposition: "needs_followup"` when fresh Copilot activity appears or handoff already routed directly to `fix`
- returns `cycleDisposition: "terminal"` only when handoff routed to `stop`

Success output shape:
- `{ "ok": true, "handoffAction": "watch"|"fix"|"stop", "state": "...", "allowedTransitions": [...], "nextAction": "...", "snapshot": {...}, "reviewRequestStatus"?: "...", "watchArgs"?: { ... }, "watchTimeoutPolicy"?: { "classification": "external_healthy_wait", "minimumTimeoutMs": 1800000, "defaultTimeoutMs": 1800000 }, "watchStatus"?: "changed"|"timeout"|"idle", "watch"?: { ... }, "loopDisposition": "pending"|"unresolved_feedback"|"clean_converged"|"blocked"|"action_required"|"done", "cycleDisposition": "pending"|"needs_followup"|"terminal", "terminal": true|false }`

Failure behavior:
- malformed arguments and unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/detect-copilot-loop-state.mjs`

Deterministic Copilot-loop state detector. Captures current loop state from observable PR/GitHub
facts and interprets the snapshot into one explicit current state, allowed next transitions, and
a recommended next action. This script is the orchestration authority for the async Copilot
review/fix loop; see [Copilot Loop State Graph](../skills/docs/copilot-loop-state-graph.md) for the full state-graph design.

Two modes:

- **Auto-detect**: `--repo <owner/name> --pr <number>`
  Fetches PR state, Copilot review request status, review threads, and CI checks from GitHub,
  builds a snapshot, and interprets it. PR CI/check normalization is owned by
  [Copilot CI Status Contract](../skills/docs/copilot-ci-status-contract.md).

- **Snapshot interpretation**: `--input <path>`
  Reads a pre-built snapshot JSON and interprets it without any `gh` calls. Use this mode when
  the caller has already gathered facts — for example, to incorporate the `status` field from a
  prior `scripts/github/request-copilot-review.mjs` run, which can report `unavailable` or
  `failed` statuses that are not observable from static GitHub state alone.

Optional (auto-detect mode only):
- `--steering-state-file <path>`
  Overlay the detected state with the current persisted steering contract state.
  The detector stays read-only: it does not promote queued steering or write the
  steering file. This is available only in `--repo/--pr` mode; snapshot `--input`
  mode does not accept steering files because repo/pr target identity cannot be
  proven from the snapshot alone.
- `--review-request-status <requested|already-requested|unavailable|none|failed>`
  Override the Copilot review-request status with a known prior result. Skips the
  `requested_reviewers` API call and injects the provided value directly into the snapshot.
  Use when the caller already ran `request-copilot-review.mjs` and wants to inject its output
  status without re-probing the reviewers endpoint.

Snapshot schema (`--input` mode or `snapshot` field in success output):
- `prExists` {boolean} — whether a PR was found
- `prNumber` {number|null} — PR number if prExists, otherwise null
- `prDraft` {boolean} — whether the PR is in draft state
- `prMerged` {boolean} — whether the PR has been merged
- `prClosed` {boolean} — whether the PR was closed without merge; merged PRs set `prMerged=true` instead of reusing `prClosed`
- `copilotReviewRequestStatus` {"requested"|"already-requested"|"unavailable"|"none"|"failed"} — current known Copilot review-request state
- `copilotReviewPresent` {boolean} — whether at least one Copilot review exists on the PR
- `copilotReviewOnCurrentHead` {boolean} — whether a submitted (non-PENDING) Copilot review exists for the current head commit
- `unresolvedThreadCount` {number} — total unresolved review-thread count
- `actionableThreadCount` {number} — unresolved threads with non-bot actionable comments
- `copilotReviewRoundCount` {number} — completed Copilot review rounds observed on the PR
- `ciStatus` {"success"|"failure"|"pending"|"none"} — contract-owned current-head CI/check rollup
  from [Copilot CI Status Contract](../skills/docs/copilot-ci-status-contract.md); `none` means no usable readiness signal yet
- `agentFixStatus` {"applied"|null} — agent-provided: "applied" when code has been fixed

Success output shape:
- `{ "ok": true, "snapshot": { ... }, "state": "...", "allowedTransitions": [...], "nextAction": "...", "autoRerequestEligible": true|false, "sameHeadCleanConverged": true|false, "loopDisposition": "...", "terminal": true|false }`
- `state` is one of the stable state names defined in [Copilot Loop State Graph](../skills/docs/copilot-loop-state-graph.md)
- `allowedTransitions` is the list of states reachable from `state`
- `nextAction` is a human-readable recommended next step
- `autoRerequestEligible` is `true` only when a meaningful remediation event has made automatic re-request valid again
- `sameHeadCleanConverged` is `true` when the current head has clean convergence (a submitted Copilot review, zero unresolved and actionable threads, and CI not blocked), suppressing automatic same-head re-request
- `loopDisposition` is the high-level refreshed classification: `pending`, `unresolved_feedback`, `clean_converged`, `blocked`, `action_required`, or `done`
- `terminal` is `true` only for clean-converged, blocked, or done states; watcher timeout/idle must be treated as non-terminal until a refreshed detector output proves `terminal=true`

Failure behavior:
- Malformed arguments, unexpected `gh` failures, and review-thread detection failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

Key behavioral guarantees:
- When `unresolvedThreadCount > 0`, the state is always in the fix/reply-resolve family — never `waiting_for_copilot_review` or any wait state
- When `copilotReviewRequestStatus` is `unavailable` or `failed`, the state is a terminal stop/report state with no allowed transitions
- When `agentFixStatus` is `"applied"` and unresolved threads exist, the state is `already_fixed_needs_reply_resolve`, and `allowedTransitions` includes only `ready_to_rerequest_review`
- When the current head has clean convergence (a submitted Copilot review, zero unresolved and actionable threads, and CI not blocked), automatic same-head re-request is suppressed until a meaningful remediation event occurs
- If review-thread state cannot be determined during auto-detect, the script fails closed instead of assuming zero unresolved threads
- When `--steering-state-file` is provided, steering is surfaced as a read-only overlay;
  queued steering promotion/persistence is owned explicitly by `steer-loop.mjs promote`

### `scripts/github/upsert-checkpoint-verdict.mjs`

Creates or updates the visible gate-review PR comment for one `gate + headSha` pair.
Use this at the `draft_gate` / `pre_approval_gate` boundaries so same-head reruns
remain idempotent: the helper updates an existing same-head marker in place when
correction is needed and suppresses duplicate reposts when the visible comment
already matches the requested contract fields. The rendered visible comment uses compact readable labels (`Gate review`, `Reviewed head SHA`, `Verdict`, `Findings summary`, `Next action`). When a gate pass needed corrective changes before reaching `clean`, pass a truthful `--findings-summary` that briefly states the gap, the change, and why the current head is now acceptable instead of defaulting to `no issues found`. Verbose multiline `--findings-summary` input is compacted before posting so visible gate comments keep validation reporting bounded: raw passing output is omitted, command/count/CI signals are preferred, and any failure excerpt uses a deterministic retained-prefix limit plus a short truncation marker suffix when needed.

Required:
- `--repo <owner/name>`
- `--pr <number>`
- `--gate <draft_gate|pre_approval_gate>`
- `--head-sha <sha>` — the FULL current head commit SHA (40 or 64 hex chars); a short prefix is rejected (the gate marker is keyed by it and the pre-merge check resolves the full head SHA)
- `--verdict <clean|findings_present|blocked>`
- `--findings-summary <text>`
- `--next-action <text>`

Optional:
- `--local-validation-head-sha <sha>` — reuse the bounded `crediblyGreen` exception when GitHub created zero current-head suites/statuses and local verification already passed for that exact head
- `--force --force-reason <text>` — narrow operator-authorized CI override for the helper-local gate-entry refusal only; `--force-reason` is required with `--force`, `--force-reason` without `--force` is rejected, and the reason text is whitespace-normalized for machine-readable output

Success output shape:
- standard path: `{ "ok": true, "action": "created"|"updated"|"noop", "repo": "owner/repo", "pr": 17, "gate": "draft_gate", "headSha": "abc1234", "currentHeadSha": "abc1234", "commentId": 101, "commentUrl": "https://github.com/owner/repo/pull/17#issuecomment-101" }`
- forced CI-override path: the same shape plus `{ "forced": true, "forceReason": "CI failed due to transient infrastructure", "forceBypass": "ci_blocked_needs_user_decision" }`

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- contradictory head-SHA requests or unexpected `gh` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero
- gate upserts still fail closed when `detect-pr-gate-coordination-state.mjs` reports that the requested gate action is illegal for the current head
- when that refusal is specifically `lifecycleState=blocked_needs_user_decision` plus current-head `ciStatus="failure"`, the unforced error now points operators to `--force --force-reason` as the explicit CI-only escape hatch
- `--force` does **not** bypass stale-head protection, non-draft `draft_gate` refusal, unresolved-feedback / unsettled-review `pre_approval_gate` refusal, merge-conflict handling, or closed/merged PR protection

Use `--force` only after the user explicitly authorizes ignoring the current-head CI failure for this one gate-comment upsert. Prefer the normal paths first: green current-head CI, `--local-validation-head-sha` for the bounded `crediblyGreen` case, or the draft-gate policy knob from issue #351 when the desired behavior is a durable draft-gate policy rather than a one-off override.

### `scripts/loop/run-refinement-audit.mjs`

Runs one deterministic bounded refinement audit over explicit repo paths and emits one machine-readable planning artifact.
Use this before refiner fan-out when a local phase or GitHub issue would benefit from scoped slop-risk discovery.

Required:
- exactly one of:
  - `--paths <comma-separated path list>`
  - `--paths-file <file>`

Optional:
- `--root <path>` — override the repo root (defaults to `git rev-parse --show-toplevel`)
- `--max-lines <n>` — oversized-file threshold (default `1000`)
- `--duplicate-window-lines <n>` — duplicate-block window size (default `4`)
- `--branch-threshold <n>` — branching-hotspot threshold (default `25` control-flow tokens)
- `--thin-wrapper-max-lines <n>` — thin-wrapper threshold (default `40`)
- `--output <path>` — writes the same success JSON emitted on stdout

Success output shape:
- `{ "ok": true, "repoRoot": "/repo", "paths": ["AGENTS.md"], "auditedFiles": [...], "findings": [...], "highestValueFollowUpCandidates": [...], "scopeBoundary": { "mode": "bounded_paths_only", "fullRepoScan": false } }`
- `auditedFiles[]` reports per-file line count, branch-token count, duplicate-block match count, thin-wrapper classification, and deterministic skip notes for binary/unreadable files
- `findings[]` uses bounded heuristic ids: `oversized_file`, `duplicate_block_candidate`, `branching_hotspot`, `thin_wrapper_candidate`
- `highestValueFollowUpCandidates[]` is the concise planning handoff surface for refiner fan-out/fan-in; findings are planning inputs, not auto-authorized rewrites

Failure behavior:
- malformed arguments, blank paths, invalid thresholds, unreadable `--paths-file` input, or zero auditable files after tracked-file expansion emit `{ "ok": false, "error": "...", ... }` on stderr and exit non-zero
- findings do **not** fail the process; findings return exit `0`
- `--paths*` is required; the helper never silently scans the whole repo

### `scripts/loop/detect-pr-gate-coordination-state.mjs`

Fetches the live PR facts needed to answer which gate/transition is legal next for a pull request. It combines the shared Copilot loop-state machine with visible `draft_gate` / `pre_approval_gate` evidence, GitHub `mergeStateStatus`, and local `git -c core.quotepath=false status --porcelain=v1 -z --untracked-files=no` conflict detection, then emits one explicit gate boundary, allowed/forbidden next actions, and a single recommended next step. Use this before entering `pre_approval_gate` and when deciding whether a ready PR should request Copilot review, keep waiting, stay in feedback resolution, or stop for conflict resolution.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Success output shape:
- `{ "ok": true, "repo": "owner/repo", "pr": 266, "currentHeadSha": "...", "mergeStateStatus": string|null, "conflictFiles": ["path"]|[], "lifecycleState": string, "loopDisposition": string, "gateBoundary": string, "draftGate": { ... }, "preApprovalGate": { ... }, "draftGateAlreadySatisfied": true, "allowedNextActions": [ ... ], "forbiddenActions": [ ... ], "nextAction": string, "reason": "..." }`
- `draftGate` / `preApprovalGate` report both latest visible evidence (`visible`, `headSha`, `verdict`, `findingsSummary`, `nextAction`) and whether the evidence is current-head + contract-complete (`currentHead`, `contractComplete`, `currentHeadClean`)
- `mergeStateStatus` preserves the current GitHub `gh pr view` signal in helper output even when the PR is not in the conflict boundary; `DIRTY` and explicit `CONFLICTING` inputs are treated as conflict-required states
- `conflictFiles` lists unmerged local paths from `git -c core.quotepath=false status --porcelain=v1 -z --untracked-files=no` when local conflict reconciliation is already in progress
- when `mergeStateStatus` is conflicted or `conflictFiles` is non-empty, the evaluator emits `gateBoundary=conflict_resolution`, `nextAction=resolve_merge_conflicts`, and forbids gate/approval/merge progression until reconciliation completes
- `draftGateAlreadySatisfied` — true when the draft→ready transition was already recorded (non-draft + clean evidence exists); callers must skip draft gate when this is true
- `forbiddenActions` includes `run_pre_approval_gate` whenever the post-draft review cycle has not yet settled for the current head, and conflicted PRs keep it forbidden until reconciliation is complete
- non-draft PRs do not need visible `draft_gate` evidence to progress through post-draft review or `pre_approval_gate`; `draftGateAlreadySatisfied` is informational only, and downstream legality comes from `gateBoundary`, `allowedNextActions`, and `forbiddenActions`
- if the PR head changes while gate/conflict facts are loading, the helper still fails closed rather than evaluating mixed-head evidence

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- `gh` failures and malformed `gh` JSON emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/github/detect-checkpoint-evidence.mjs`

Fetches the live PR head SHA plus visible PR issue comments, then summarizes the
latest valid `draft_gate` and `pre_approval_gate` checkpoint verdict comments.
Use this when a fresh session needs authoritative visible gate evidence for the
current head before running `gh pr ready` or declaring final-approval readiness.
When `DEVLOOPS_RUN_ID` is set to a non-empty value, it also enforces async runner ownership before reading GitHub facts, so stale/displaced runs fail closed before merge.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--skip-fanout-ledger-check` — skips only the fan-out findings-log
  ledger/provenance/angle-coverage layer of `gates.requireFanoutEvidence`
  enforcement (that ledger is a gitignored, worktree-local `tmp/` file, invisible
  to a stateless remote verifier); the comment-derived executionMode/inlineReason
  check (including the light-mode inline exception) still applies. Used by the
  `gate-evidence` CI check (`.github/workflows/gate-evidence.yml`); client-side
  callers should omit it.

When the `gh` binary is not on PATH, gh calls fall back to GitHub's REST/GraphQL
API directly, given a `GH_TOKEN`/`GITHUB_TOKEN` in the environment — so a gh-less
session can still read gate evidence instead of having no option but to bypass
the check.

Success output shape:
- `{ "ok": true, "repo": "owner/repo", "pr": 17, "currentHeadSha": "abc1234", "draftGate": { ... }, "preApprovalGate": { ... }, "draftGateMarker": { ... }, "preApprovalGateMarker": { ... } }`
- each gate summary includes `visible`, `headSha`, `verdict`, `findingsSummary`, `nextAction`, `commentId`, `commentUrl`, and `updatedAt`
- when no valid visible comment exists for a gate, its summary is emitted with `visible=false` and the other fields set to `null`
- each marker summary includes `visible`, `headSha`, `verdict`, `findingsSummary`, `nextAction`, `contractComplete`, `commentId`, `commentUrl`, and `updatedAt`
- marker summaries track the newest visible marker for the current head (`gate + currentHeadSha`) even if contract fields are partial, enabling same-head rerun idempotency without posting duplicate visible markers

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- `gh` failures and malformed `gh` JSON emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/detect-tracker-pr-state.mjs`

Deterministic tracker-first story-to-PR state detector. Interprets a pre-built
tracker/PR lifecycle snapshot into one explicit current state, allowed next
transitions, a recommended next action, and the canonical reverse-sync action.
This helper is intentionally snapshot-only: tracker-adapter lookups and live
GitHub discovery remain outside this CLI.

Required:
- `--input <path>`

Snapshot schema (`--input` JSON):
- `trackerItemExists` {boolean} — whether a tracker work item was found
- `trackerItemId` {string|null} — tracker item identifier if present
- `prExists` {boolean} — whether a PR exists for the tracker item
- `prNumber` {number|null} — PR number if known; `prNumber` with `prExists=false` is contradictory and blocked
- `prDraft` {boolean} — whether the PR is still draft
- `prMerged` {boolean} — whether the PR has been merged
- `prClosed` {boolean} — whether the PR is closed on GitHub (merged PRs are also closed); `pr_closed_unmerged` is derived from `prClosed && !prMerged`

Unlike the Copilot/reviewer loop snapshots, this tracker snapshot uses `prClosed` for the raw GitHub closed state. Merged PRs therefore set both `prMerged=true` and `prClosed=true`, while `pr_closed_unmerged` is derived from `prClosed && !prMerged`.

This snapshot surface is intentionally limited to tracker identity plus PR lifecycle facts. It does not encode tracker-native workflow readiness/blocking/done state; higher-level callers must combine tracker-owned state separately when deciding whether opening a PR is appropriate.

Success output shape:
- `{ "ok": true, "snapshot": { ... }, "state": "...", "allowedTransitions": [...], "nextAction": "...", "reverseSyncAction": "..." }`

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "...", "usage": "..." }`
  on stderr and exit non-zero
- unreadable input files, invalid JSON, and invalid snapshot objects emit
  `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/detect-reviewer-loop-state.mjs`

Deterministic reviewer-loop state detector. Captures reviewer-side PR loop state from observable
GitHub facts plus optional local reviewer-loop metadata and interprets that snapshot into one
explicit current state, allowed next transitions, and a recommended next action. See
[Reviewer Loop State Graph](../skills/docs/reviewer-loop-state-graph.md) for the full reviewer-loop state graph and contracts.

Two modes:

- **Auto-detect**: `--repo <owner/name> --pr <number>`
  Fetches PR/open-head state, review-request status, and pending/submitted review surfaces from
  GitHub and interprets them into deterministic reviewer-loop state. When `--reviewer-login` is
  omitted, this uses aggregate all-reviewer scope for the PR.

- **Snapshot interpretation**: `--input <path>`
  Reads a pre-built snapshot JSON and interprets it without any `gh` calls.

Optional (auto-detect mode only):
- `--reviewer-login <login>`
  Scope review-request and review-surface detection to a single reviewer identity. Success output
  snapshots include `reviewerScope` (`"all_reviewers"` or `"single_reviewer"`) plus
  `reviewerLogin` (`string|null`) so callers can tell whether the detector used aggregate or
  single-reviewer scope.
- `--review-requested <true|false>`
  Override review-request detection with a known prior result.
- `--local-state <path>`
  Inject local reviewer-loop metadata (planning/run/merge/draft-notification status) used for
  deterministic planning/running/merge-ready and draft lifecycle transitions.

Success output shape:
- `{ "ok": true, "snapshot": { ... }, "state": "...", "allowedTransitions": [...], "nextAction": "..." }`
- reviewer snapshots preserve the latest submitted review metadata via `submittedReviewPresent`, `submittedReviewCommitSha`, and `submittedReviewState`
- together those fields let read-only inspection UIs distinguish submitted-verdict handoff boundaries from active reviewer-pass states

Failure behavior:
- malformed arguments, unexpected `gh` failures, and invalid input/local-state JSON emit
  `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/outer-loop.mjs`

Thin deterministic outer-loop wrapper for the Copilot PR remediation path. It combines
the existing Copilot and reviewer inner-loop detectors into one machine-readable outer
action so bounded external waits remain owned by the same remediation family instead of
looking like terminal run endpoints.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--reviewer-login <login>`
- `--checkpoint-dir <path>`
- `--copilot-input <path>`
- `--reviewer-input <path>`

Reviewer-scope contract:
- omitting `--reviewer-login` means aggregate all-reviewer scope for the PR
- providing `--reviewer-login` means single-reviewer scope for that login
- `--reviewer-input` cannot be combined with `--reviewer-login`

Contract:
- auto-detect mode calls both inner detectors, interprets their current states, and emits one
  outer action: `continue_wait`, `reenter_copilot_loop`, `reenter_reviewer_loop`, `stop`, or `done`
- treats draft PRs as a re-entry point into owned draft-stage follow-up rather than a terminal stop
- treats `waiting_for_copilot_review`, `waiting_for_ci`, and reviewer `submitted_review`
  as outer-loop-owned `continue_wait` states at explicit external/handoff boundaries
- preserves compatibility for reviewer `waiting_for_author_followup` and `waiting_for_re_request`
  as legacy named external-wait boundaries
- when the next step needs local execution or mutation and the checkout is dirty or detached, preserves the loop-family handoff and marks `conductorRouting.handoffEnvelope.requiresLocalIsolation=true` so callers can continue from an isolated checkout/worktree instead of treating the boundary as terminal
- for PR-local re-entry actions, verifies local branch/HEAD identity against the active PR head;
  when an isolation-managed handoff is already in effect, it enriches the handoff with `headRefName` / `headRefOid` for the target PR head instead of failing the handoff on the parent checkout's expected mismatch
- otherwise stops with `unsafe_local_branch_mismatch_requires_reconcile` or
  `unsafe_local_head_mismatch_requires_reconcile` when checkout identity is not aligned
- when that PR-local identity gate trips, the emitted `conductorRouting` result is also fail-closed
  to a stop outcome with no handoff entrypoint, so consumers cannot keep following a stale handoff envelope
- persists bounded checkpoint state to `tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json` for
  async continuation and false-positive wakeup detection
- emits an additive `conductorRouting` field with the conductor-owned routing outcome, derived
  outer action, stop reason when relevant, and any machine-readable handoff envelope
- supports snapshot-input mode for deterministic gh-free testing

Success output shape:
- `{ "ok": true, "outerAction": "...", "copilotState": "...", "reviewerState": "...", "reviewerScope": { "mode": "all_reviewers"|"single_reviewer", "reviewerLogin": "..."|null }, "reason"?: "...", "branchIdentity"?: { ... }, "conductorRouting": { "routingOutcome": "...", "outerAction": "...", "stopReason": null|"...", "handoffEnvelope": { ... } }, "checkpoint": { ... } }`

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- unexpected `gh` or `git` failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/inspect-run.mjs`

Read-only inspection entrypoint for one explicit Copilot PR outer-loop target.
It composes current inner-loop facts into one JSON snapshot without attaching to
an active worker or mutating local/runtime state.

Required:
- `--repo <owner/name>`
- `--pr <number>`

Optional:
- `--steering-state-file <path>`
- `--reviewer-login <login>` — narrows live reviewer detection to one reviewer identity; when omitted, inspection uses aggregate all-reviewer scope for the PR
- `--copilot-input <path>`
- `--reviewer-input <path>` — cannot be combined with `--reviewer-login`

Contract:
- is strictly read-only: it does not write checkpoints, mutate GitHub state, or create local artifacts
- returns a stable top-level inspection shape with target identity, derived `runId`, authoritative `outerState`, conditional top-level `allowedTransitions`, compatibility `outerAction`, active family state,
  status class, trust/source semantics, evidence, markers, and best-effort drill-down layers
- only derives top-level `outerState` / `allowedTransitions` / `outerAction` / `activeFamilyState` / `statusClass` when inspection has a complete current inner-loop picture, whether from live detectors and/or caller-supplied snapshot inputs
- when inspection falls back to checkpoint-only data or mixed live + checkpoint evidence, checkpoint-backed drill-down layers and checkpoint evidence paths remain available as advisory context while the top-level state stays `"unknown"`
- reports not-found or unavailable targets as structured success output with `statusClass: "unknown"`
  rather than by throwing a synthetic blocked-run error
- looks for checkpoints at the repo-qualified default path `tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json`
- during transition, may read the legacy default path `tmp/copilot-loop/pr-<n>/outer-loop-state.json` only when the checkpoint file's embedded `repo` and `pr` match the explicit target
- surfaces steering as a best-effort drill-down layer when `--steering-state-file` is provided,
  including latest acknowledgement plus queued/effective stop summaries for the current run,
  without exposing full steering history/detail or raw steering-file locator paths
- when live GitHub PR facts are available, surfaces a deterministic `loopIterations` summary for the
  remote Copilot review/fix loop (completed rounds, pending round indicator, Copilot review comments,
  current resolved/unresolved review-thread counts, and fix commits after feedback)
- keeps `loopIterations` unavailable in snapshot-only / non-live inspection paths instead of
  inventing local phase-loop iteration semantics
- rejects mismatched steering-state files from the targeted repo/pr instead of projecting their state onto the inspected run

Success output shape:
- `{ "ok": true, "schemaVersion": 1, "target": { "repo": "...", "pr": 17 }, "runId": "pr-17", "inspectedAt": "...", "activeStateFamily": "copilot-pr-outer-loop", "outerState": "...", "allowedTransitions"?: [...], "outerAction": "...", "activeFamilyState": "...", "statusClass": "...", "needsAttention": false, "sourceMode": "...", "trust": "...", "evidence": { ... }, "markers": { ... }, "loopIterations": { "available": true|false, ... }, "layers": { "reviewer": { "currentState": "...", "scope": { "mode": "all_reviewers"|"single_reviewer", "reviewerLogin": "..."|null }, ... }, ... } }`

Failure behavior:
- malformed arguments emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero
- unexpected runtime failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero

### `scripts/loop/inspect-run-viewer.mjs`

Owned read-only local/operator inspection dashboard layered on `inspect-run`.
`inspect-run` remains authoritative for inspection/status state; the viewer owns local inbox discovery and read-only presentation/prioritization.

Primary local lifecycle UX now lives in the Pi extension under:
- `/dev-loops inspect open [--repo <owner/name>]`
- `/dev-loops inspect resume [--repo <owner/name>]`
- `/dev-loops inspect status [--repo <owner/name>]`
- `/dev-loops inspect stop [--repo <owner/name>]`
- `/dev-loops inspect restart [--repo <owner/name>]`

The extension-managed seam stores one narrow repo-local managed-instance record at:
- `.pi/ui-servers/inspect-run-viewer.json`

Ownership split for this slice:
- extension owns lifecycle UX, URL discovery, liveness checks, reattach logic, stop/restart, and best-effort browser opening
- when a repo-scoped command reuses an inbox-first managed viewer, the surfaced URL may include `?scope=<owner/name>` to pre-scope the inbox without replacing the managed instance
- viewer script still owns HTTP server behavior, rendering, inbox/query behavior, and snapshot loading

Optional:
- `--repo <owner/name>` (repo-scope the inbox; otherwise the viewer starts in inbox-first mode)
- `--host <host>` (default: `127.0.0.1`; non-loopback binds require `--allow-non-localhost`)
- `--port <port>` (default: `4311`)
- `--allow-non-localhost` (explicit opt-in for non-loopback binds such as `0.0.0.0` or LAN IPs)
- `--restart` (manual/debug convenience only; requires `lsof` / POSIX support and sends `SIGTERM` to every listener already bound to that port)
- `--steering-state-file <path>` (pass-through to `inspect-run`)
- `--reviewer-login <login>` (pass-through to `inspect-run`)
- `--copilot-input <path>` (pass-through to `inspect-run`)
- `--reviewer-input <path>` (pass-through to `inspect-run`; cannot be combined with `--reviewer-login`)

Contract:
- current-slice posture: kept/promoted as an explicitly owned local/operator inspection dashboard (not a second public workflow entrypoint)
- read-only: no GitHub mutations, no checkpoint writes, no steering writes, no worker attachment
- ownership boundary: `inspect-run` owns authoritative inspection/status state; viewer owns local inbox discovery plus read-only operator presentation/prioritization
- extension-managed lifecycle remains loopback-first and local-only; no remote/public hosting support
- the script fallback still requires explicit `--allow-non-localhost` opt-in for non-loopback binds; do not expose inspection state on the network by default
- GitHub-first launch boundary: repo scope is optional and PR selection happens through the viewer URL/query state, not a CLI `--pr` flag
- uses one adapter module (`scripts/loop/_inspect-run-viewer-adapter.mjs`) to load the normalized inspection snapshot
- adapter is the only viewer integration seam that calls the existing `inspect-run` contract in this source-loaded workspace
- serves two explicit read-only endpoints:
  - `/` → operator-facing HTML with an assigned-PR inbox shell and, when a PR is selected via URL or sidebar, the Mermaid-first graph plus current-PR-state banner and supporting textual summary/evidence
  - `/snapshot.json` → the full authoritative inspection snapshot JSON for the currently selected PR/query target
- HTML includes a visible link to `/snapshot.json` so machine-readable state no longer depends on an inline full-snapshot dump in the page itself
- `/snapshot.json` returns `application/json; charset=utf-8` on success and deterministic JSON error output with non-2xx status when snapshot loading throws or yields no snapshot
- unsupported paths return deterministic `404` without loading a snapshot (even for unsupported methods on unknown paths); `/favicon.ico` returns deterministic `204`; unsupported methods on supported routes return `405 Allow: GET`
- both primary endpoints send `Cache-Control: no-store` to match the manual-reload workflow
- the script-local `--restart` flag remains a manual/debug fallback only; the extension-managed path must not depend on killing unknown listeners
- manual reload only (`window.location.reload()`); no polling/watch/timeout/control semantics

Local manual verification path:
1. Preferred extension-managed path:
   - `/dev-loops inspect open`
   - `/dev-loops inspect status`
   - `/dev-loops inspect resume`
   - `/dev-loops inspect stop`
2. Script fallback for manual/debug verification:
   - `node scripts/loop/inspect-run-viewer.mjs`
   - `node scripts/loop/inspect-run-viewer.mjs --repo <owner/name>`
3. Open the printed/resolved URL in a local browser and verify the human-oriented `/` page
4. Select a PR via the sidebar or by adding `?repo=<owner/name>&pr=<number>` to the viewer URL
5. Open `/snapshot.json` for that selected/query-targeted PR and verify it returns the matching full inspection snapshot JSON
6. Use browser refresh or the reload button for point-in-time re-inspection

Local WebKit/Playwright smoke path:
1. Install the Safari/WebKit browser runtime once:
   - `npx playwright install webkit`
2. Run the viewer smoke suite:
   - `npm run test:playwright:viewer`
3. Review screenshots/traces under `test-results/` and the HTML report under `playwright-report/ui-smoke/inspect-run-viewer/`
4. Optionally hit `/favicon.ico` or an unsupported path to confirm those paths stay deterministic and do not perform snapshot rendering
5. For deterministic/local test mode, pass `--copilot-input` and `--reviewer-input` fixtures to viewer; these are forwarded to `inspect-run`

### `scripts/loop/steer-loop.mjs`

Mid-flight operator steering CLI for active dev loops.

Subcommands:
- `submit` — submit a steering directive to a specific run
- `promote` — explicitly promote queued steering for a specific run at a known loop state
- `status` — inspect the current steering state for a run

Contract:
- persists steering state to a JSON file (default: `.pi/steering/<owner>/<repo>/pr-<n>.json` for operator-facing `--repo/--pr` mode; `.pi/steering/<run-id>.json` for low-level `--run-id` mode)
- operator-facing `submit` resolves one explicit `repo` + `pr` target through the read-only
  inspection surface and derives `runId: pr-<number>` from that target while persisting repo-qualified target metadata alongside the steering state
- explicit queued-steering promotion/persistence belongs to `promote`; detector-shaped helpers stay read-only
- operator-facing `submit` is intentionally limited to `stop_at_next_safe_gate`; other directive
  kinds remain low-level/internal and are rejected on the external submit path
- operator-facing `submit` fails closed when inspection is partial, checkpoint-only, unavailable,
  stale, or conflicting
- low-level/testing mode may still accept injected loop-state inputs for deterministic tests
- returns deterministic acknowledgement/result payloads for `submit` and deterministic state
  readback for `status`
- rejected operator-facing submits leave any trusted durable steering file unchanged; when the
  persisted file is malformed or target-mismatched, the response may include a fresh synthetic
  target-scoped `steeringState` for deterministic readback without trusting broken persisted data

Success output shape:
- `submit`: `{ "ok": true, "acknowledgement": { ... }, "result": { ... }, "steeringState": { ... } }`
- `promote`: `{ "ok": true, "promotedCount": <n>, "promoted": [ ... ], "steeringState": { ... } }`
- `status`: `{ "ok": true, "status": { ... } }`

Failure behavior:
- argument/usage errors emit `{ "ok": false, "error": "...", "usage": "..." }` on stderr and exit non-zero
- runtime failures emit `{ "ok": false, "error": "..." }` on stderr and exit non-zero
