# Copilot loop operations

Canonical owner for operating the deterministic Copilot PR follow-up state machine — the operational reference for the routed `copilot_pr_followup`, `wait_watch`, `reviewer_fixer`, and `final_approval` paths behind `dev-loop`. The machine's states and transitions are defined by [Copilot Loop State Graph](./copilot-loop-state-graph.md).

Use it together with:
- [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md)
- [Public Dev Loop Contract](./public-dev-loop-contract.md)
- [Retrospective Checkpoint Contract](./retrospective-checkpoint-contract.md) when the current step depends on async start/resume/status or retrospective enforcement

## Deterministic orchestration authority

At each PR-follow-up/watch decision, use `detect-copilot-loop-state.mjs` or reviewer-side
`detect-reviewer-loop-state.mjs` for the current state, allowed transitions, next action
and stop condition. Their mappings are owned by [Copilot Loop State Graph](./copilot-loop-state-graph.md)
and [Reviewer Loop State Graph](./reviewer-loop-state-graph.md).

Resolve helpers using the main skill's asset layout: `../../scripts/` relative to
`skills/copilot-pr-followup/SKILL.md` in this source tree, or bundled `scripts/` inside
normalized installed skills. For MVP `story -> PR -> tracker sync`, follow
[Tracker-First Story-to-PR Contract](./tracker-first-loop-state.md), including its
inherited `#21` authority/link/reverse-sync rules and post-merge sync verification.

## Key guarantees from the state machine

These routing guarantees are owned by [Copilot Loop State Graph](./copilot-loop-state-graph.md); see `COPILOT-STATE-UNRESOLVED-PRIORITY`, `COPILOT-STATE-TERMINAL-STOP`, `COPILOT-STATE-REPLY-BEFORE-REREQUEST`, and `COPILOT-STATE-ACTIVE-REQUEST-WAIT` there for the routing rules driving `unresolvedThreadCount`, `copilotReviewRequestStatus`, and `agentFixStatus`.

## How to use the state machine in practice

1. Run `node <resolved-skill-scripts>/loop/detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`
   to get the current Copilot-loop state, decisive snapshot fields, and recommended next action.

2. After a separate `<resolved-skill-scripts>/github/request-copilot-review.mjs` call, apply `COPILOT-FOLLOWUP-REQUEST-BRANCHING` in the [follow-up skill](../copilot-pr-followup/SKILL.md), then refresh the detector normally. `--review-request-status` is unsupported. For combined detection/request/watch routing, use `copilot-pr-handoff.mjs` and consume its returned request/watch contract; it preserves its own request result, not an externally supplied override.

3. When the agent has applied a fix and wants to signal reply/resolve is next, build a snapshot
   with `agentFixStatus: "applied"` and use `--input <snapshot.json>` for interpretation.

4. Branch on the detector output instead of inventing a polling loop:
   - `state=waiting_for_copilot_review` with `snapshot.copilotReviewOnCurrentHead=false`: do **not** poll manually; either run `node <resolved-skill-scripts>/loop/run-watch-cycle.mjs --repo <owner/name> --pr <number>` for persistent async waiting or report the wait state and resume later after the single detector call
   - `state=waiting_for_ci` with `snapshot.ciStatus` in `{ "pending", "none" }`: do **not** poll manually by default; use `dev-loops loop watch-ci --repo <owner/name> --pr <number>` or `node <resolved-skill-scripts>/github/wait-pr-checks.mjs --repo <owner/name> --pr <number>` (settle-blocking with a 0/1/2 exit contract) to block-wait on the combined check/status state (provider-agnostic — CircleCI, GitHub Actions, and any external commit-status / check-run). `gh run watch <run-id>` is an Actions-only fallback when the current-head run id is already known and you know the gating checks are GitHub Actions. Either way, on `timeout`/`changed` report pending CI and resume later after the single detector refresh. Before considering the bounded exception, read [Zero-suite local-validation exception](./copilot-ci-status-contract.md#zero-suite-local-validation-exception), including its unavailable CLI input; these prerequisites cannot override a detector result of `none`.
   - `snapshot.ciStatus="failure"` remains a stop/fix state, never a wait loop

5. For reviewer-side draft-review work, run `node <resolved-skill-scripts>/loop/detect-reviewer-loop-state.mjs --repo <owner/name> --pr <number> [--local-state <path>]`.
   If the state reaches `draft_review_ready`, stage the pending review with
   `node <resolved-skill-scripts>/github/stage-reviewer-draft.mjs --repo <owner/name> --pr <number> --review-file <merged-review.json> --local-state-output <state.json>`,
   then re-run the detector with `--local-state <state.json>`.

6. Follow the `nextAction` from the machine output. For stop states (`review_request_unavailable`,
   `blocked_needs_user_decision`), report to the user and do not proceed.

7. After a converged Copilot review, a later head does not need another Copilot round by default.
   The latest submitted Copilot review decides. With zero unresolved threads and no outstanding
   request, a converged latest review on an earlier head stands for the current head, whatever the
   delta. `request-copilot-review.mjs` then returns `suppressed_post_convergence`, and the gate
   coordination detector routes to `run_pre_approval_gate`. `pre_approval_gate` reviews the current
   head. A later Copilot review, such as the ruleset review when a PR becomes ready, replaces the
   earlier one and decides again. To require a Copilot review for every significant post-convergence
   change, set `refinement.requireCopilotConvergenceAtLatestHead: true` in `.devloops`. That strict
   mode carries convergence only across a docs-only or integrate-only delta
   (`suppressed_post_convergence_docs_only`) and reopens the cycle at the round cap on a significant
   change. `COPILOT-STATE-CARRIED-CONVERGENCE` in [Copilot Loop State Graph](./copilot-loop-state-graph.md)
   owns the rule, and ADR 0090 records it.

## Judgment calls that remain in the agent layer

See [Copilot Loop State Graph](./copilot-loop-state-graph.md)'s "Agent judgment boundary" for the bounded list of decisions the state machine leaves to the agent.

## Workflow overview

```text
ready issue -> confirm scope -> Copilot branch/PR -> async review/watch -> Pi follow-up fixes -> validation -> confirm verdict/action -> merge when authorized
```

Route each decision through [Deterministic orchestration authority](#deterministic-orchestration-authority).

## Pre-follow-up working rules

> **Phase boundary:** Steps 1-4 apply when no PR exists yet (issue intake).
> If a PR already exists, skip to [Deterministic orchestration authority](#deterministic-orchestration-authority) —
> the state machine owns all post-PR routing.

### Step 1: Choose the work item

Prefer a GitHub issue over an ad hoc TODO, prioritizing `type:task` under the relevant
epic and `status:ready`. Inspect milestone, labels and acceptance criteria; check for
an existing PR before proposing execution.

Useful checks:
- `gh issue list --state open`
- `node scripts/github/view-issue.mjs --repo <owner/name> --issue <number>`
- `gh pr list --state open`

If the user asks for status/progress/readiness/merge-state/next-step (including “what is next”):
- resolve authoritative active artifact identity first (issue/PR, plus branch/head SHA when useful)
- for issue targets, resolve authoritative issue↔PR linkage via the startup resolver (`dev-loops loop startup --issue <number>`, run inside the `dev-loop` async subagent) rather than running `detect-linked-issue-pr.mjs` manually; the fail-closed-until-resolved requirement is owned by `FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED` in [Public Dev Loop Contract](./public-dev-loop-contract.md)
- resolve artifact state (`open`/`closed`/`merged`/`not_applicable`)
- resolve current loop state and next action from deterministic helper/state output
- include explicit resolved artifact identity in the answer
- if identity/state cannot be resolved confidently, stop with reconcile/unknown instead of guessing from chat context

### Step 2: Confirm issue scope before execution

Before Copilot handoff or follow-up fixes, summarize the issue number/title, parent
epic if present, milestone, labels, exact acceptance criteria, intended narrow scope
and non-goals inferred from the issue/plan.

If the work item is phase-like, ambiguous, or likely to shape more than one downstream step, default to a short fan-out / fan-in refinement pass before implementation:
- generate 2-3 plan variants in parallel when practical
- compare the variants explicitly
- merge them into one bounded execution plan
- only then proceed with GitHub execution

If the issue text is too vague, stop and ask a short clarification question rather than guessing.

### Step 3: Decide whether Copilot or Pi should act next

Use this heuristic:

#### Prefer Copilot when
- there is a ready implementation issue with clear acceptance criteria
- no PR exists yet for that issue
- the user wants the repository's normal GitHub/Copilot path
- the next step is “start work” rather than “finish this already-open PR right now”

#### Prefer Pi follow-up when
- a PR already exists
- Copilot has already pushed work and now needs review/fix follow-up
- there are unresolved comments or failing checks
- the user wants async in-session watching and response

#### Prefer plain analysis only when
- the user is asking what should happen next
- authorization for GitHub state changes has not been given yet
- the issue/PR state is unclear and needs inspection first

### Step 4: Copilot handoff rules

Use the GitHub issue as authority; preserve its acceptance criteria and narrow scope,
without adjacent backlog work. Prefer one issue per PR unless the user requests bundling.

Before any GitHub mutation such as assigning the issue, posting instructions, or changing labels, confirm first unless explicitly authorized.

Assign `copilot-swe-agent`, referencing the issue and acceptance criteria in
implementation-focused, test-aware instructions.

## PR description contract

This section governs tracker-backed (Copilot-handoff) PRs; issue-less/plan-file-backed PRs are governed by merge precondition 7 in merge-preconditions.md instead.

Follow the PR description contract (see [Agent Instructions](../../AGENTS.md) if present; otherwise use the structure below): detailed structured descriptions, not thin placeholders. At minimum include change summary, scope/context, explicit acceptance criteria, explicit definition of done, and explicit non-goals, and `Closes #N` (or `Fixes #N`) for the linked issue so GitHub auto-closes it on merge.

Checkbox rule: acceptance criteria, definition-of-done items, and any task list must be rendered as real GitHub markdown checkboxes inside list items (`- [ ]` / `- [x]`, also `* [ ]` / `* [x]`). Do not wrap checkbox markers (e.g. `[x]`) in backticks. Do not place checkbox markers inside table cells — task lists are not interactive there even with a leading `- `.

`validateTrackerBackedPrBodySpec` (`@dev-loops/core/loop/issue-refinement-artifact`,
reusing `validatePrBodySpec`) runs at BOTH ends of the lifecycle: `create-pr.mjs` fails
closed at PR-creation time on a non-conformant tracker-backed body, and `ready-for-review.mjs`
re-checks it at draft exit. One validator, run at both ends, never drifting — author the body
conformant up front instead of discovering it non-conformant when marking ready. For a PR
closing an issue, its OWN body must contain an Objective/why section, an In scope section,
Acceptance criteria and Definition of done checklists, explicit Non-goals, and
`Closes #N`/`Fixes #N`; otherwise it fails closed. A linked issue's criteria or reviewer
judgment cannot substitute. The canonical conformant skeleton lives at
[PR Body Skeleton](../dev-loop/templates/pr-body.md).

<!-- rule: OPS-PR-VALIDATION-STABLE-EVIDENCE -->
`OPS-PR-VALIDATION-STABLE-EVIDENCE`: For tracker-backed PRs, the PR description's Validation section MUST record each validation command or named check together with its stable pass/fail outcome. It MUST NOT include volatile aggregate test, assertion, or asset counts; skip counts; durations; timestamps; or incidental totals unless an explicit acceptance criterion makes that exact quantity behaviorally significant. Detailed totals MUST live in the head-stamped validation and gate artifacts, where they remain bound to the exact revision that produced them.

<!-- rule: OPS-DRAFT-FIRST-PR -->
`OPS-DRAFT-FIRST-PR`: New PRs MUST open as **draft** through `create-pr.mjs`, which
rejects `--ready`. Agents MUST NOT create ready PRs. The only draft-exit path is
`ready-for-review.mjs` (`gh pr ready`), gated on clean draft-gate evidence.
[TRACKER-PROJECTION-REQUIRED-METADATA](./tracker-first-loop-state.md#31-required-pr-metadata)
owns the corresponding tracker metadata requirement.

Use `create-pr.mjs` only after authoritative issue↔PR resolution finds no open linked
PR; otherwise reuse/update that PR. The wrapper preserves `gh pr create`'s output
contract and defaults to self-assignment (`--assignee @me`).

A session that creates the branch and PR itself MUST run the pre-PR review per
`PRE-PR-BEFORE-FIRST-PUSH` in [Pre-PR review contract](./pre-pr-review-contract.md)
before the branch's first push and before `create-pr.mjs`; until then, the session
and its sub-delegates commit locally and do not push.

MUST use `node <resolved-skill-scripts>/github/create-pr.mjs --repo <owner/name> --assignee @me --base <base> --head <head> --title "..." --body-file <body-file>` (always draft, self-assigned by default; `--assignee @me` is the default).

<!-- rule: CLOSING-REF-BRANCH-MISMATCH -->
`CLOSING-REF-BRANCH-MISMATCH`: `create-pr.mjs` and `edit-pr.mjs` MUST fail closed
when ANY closing reference in `--body`/`--body-file` disagrees with the expected issue.
Check every case-insensitive `close`/`closes`/`closed`, `fix`/`fixes`/`fixed`, and
`resolve`/`resolves`/`resolved` reference; a correct first reference cannot excuse
a wrong later one. Resolve the expected issue from `issue-<N>` or `dl/issue-<N>-*`:
creation uses `--head`, otherwise the current branch, with explicit `--issue <n>`
taking precedence; editing uses the PR head branch, otherwise `closingIssuesReferences`.
Matching references, no closing references, or no resolvable issue (issue-less
lightweight) pass. `--allow-cross-issue` records an intentional exception. The guard
only compares issue numbers: it never rewrites the body or changes GitHub auto-close
semantics. `validatePrBodySpec` still owns the draft-exit `Closes`/`Fixes` vocabulary.

## Timeout and watch policy

This workflow is intentionally long-lived, but one Copilot review watch boundary must still be capped.

Preferred defaults for this repo:
- poll interval for review/activity watchers: **1 minute** (derived from `packages/core/src/loop/policy-constants.mjs` DEFAULT_POLL_INTERVAL_MS)
- max watch timeout per Copilot review boundary: **30 minutes** (derived from `packages/core/src/loop/policy-constants.mjs` COPILOT_REVIEW_WAIT_TIMEOUT_MS)
- if that 30-minute watch budget expires, refresh authoritative state once; if the refreshed state still resolves `waiting_for_copilot_review`, stop with `watch timeout — PR #<number> needs manual attention`
- do not silently extend that 30-minute cap unless the user or conductor explicitly authorizes a longer watch budget for the active PR
- parent/subagent no-activity threshold for watcher-style runs: at least **15 minutes**
- active-long-running notice threshold for watcher-style runs: about **30 minutes**

These are the defaults built into `probe-copilot-review.mjs`, `run-watch-cycle.mjs`, and the `watchArgs` emitted by `copilot-pr-handoff.mjs`. Do not pass removed CLI policy flags (`--poll-interval-ms`, `--probe-only`): the scripts reject them as usage errors, but do not rely on that as a guaranteed hard stop in the `dev-loops gate …` path — the CLI retry-wrapper (`buildCorrectedArgs`) may strip an unrecognized/removed flag and silently retry with defaults, so passing one can quietly fall back to default behavior rather than failing. `probe-copilot-review.mjs` does accept `--timeout-ms` (watch budget in ms; `0` = single immediate idle check, no watch); timeouts and intervals are otherwise derived from `packages/core/src/loop/policy-constants.mjs`.

### Outer-loop checkpoint: canonical re-attachment artifact

The outer-loop checkpoint (`tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json`)
is the canonical re-attachment artifact for async subagent runs. It is written by
`outer-loop.mjs` at every conductor cycle and records:

| Field | Meaning |
|---|---|
| `pr` | PR number |
| `repo` | Repository slug (`owner/name`; lowercased by `outer-loop.mjs`) |
| `outerAction` | Next action: `continue_wait`, `reenter_copilot_loop`, `reenter_reviewer_loop`, `stop`, `done` |
| `copilotState` | Current copilot inner-loop state |
| `reviewerState` | Current reviewer inner-loop state |
| `reviewerScope` | Reviewer scope mode (always present; e.g. `all_reviewers` or `single_reviewer`) |
| `reviewerLogin` | Reviewer GitHub login (always present; `null` unless single-reviewer scope) |
| `reason` | Stop reason (`null` when `outerAction` is not `stop`) |
| `timestamp` | ISO 8601 timestamp of checkpoint write |
| `waitCycles` | Number of wait cycles accumulated |
| `headSha` | PR head SHA at checkpoint time (`null` when unavailable) |

### Re-attachment contract

When a fresh `dev-loop` async subagent starts on a PR that already has an outer-loop
checkpoint, it must read the checkpoint before entering any intake or follow-up procedure:

1. If `outerAction` is `continue_wait` or `reenter_copilot_loop`: auto-resume the loop
   rather than treating the start as fresh intake.
2. If `outerAction` is `reenter_reviewer_loop`: enter the reviewer-loop path.
3. If `outerAction` is `stop`: the loop is blocked or needs a human decision; report the `reason` and ask for direction.
4. If no checkpoint or `outerAction` is `done`: `done` means the PR is merged/closed; normal fresh startup.

The checkpoint is the only source of truth for re-attachment. Do not rely on chat context
or local notes to determine "where we left off."

## Hard rule: no agent-authored shell polling

Helper-owned sleep inside `run-watch-cycle.mjs`, `probe-copilot-review.mjs`, or `watch-initial-copilot-pr.mjs` is allowed. Agent-authored shell polling (`sleep`, `for`, `while`, `timeout` wrappers around tool invocations) is a contract breach. This rule applies to ALL repos using the dev-loop workflow, not just the source repo.

A watcher sleeping between polls is expected behavior, not a blocker.

## Hard rule: no inline interpreters

<!-- rule: OPS-NO-INLINE-INTERPRETER -->
`OPS-NO-INLINE-INTERPRETER`: Coordinator and agent flows MUST NOT invoke an inline interpreter (`node -e`/`node --eval`, `python3 -c`, `python3 - <<EOF` heredocs, or equivalent) to (a) parse any dev-loops tool output, or (b) mutate repository files. Sanctioned paths: a tool's `--jq`/`--silent` output flags (or `gh ... --jq`) for (a); the editor/patch tools, or `gh ... --body-file` composed from a `--jq` read, for (b). This rule applies to ALL repos using the dev-loop workflow, not just the source repo.

Post-watch read pattern: after a probe/watch settles, do not parse its output — re-read state via `detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`; read the unresolved thread bodies via `capture-review-threads.mjs --repo <owner/name> --pr <number> --unresolved --bodies` (the canonical working-set read, bodies pre-joined per thread) and the thread/comment ids for reply-resolve via `list-review-threads.mjs --repo <owner/name> --pr <number> --unresolved-only` (see [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md) Step 6).

If the polling interval is 1 minute, do not treat silence shorter than one full poll interval as suspicious, and do not configure needs-attention thresholds close to a few seconds for this loop.
