# Copilot loop operations

This document is the canonical operational reference for the deterministic Copilot PR follow-up state machine used by the routed `copilot_pr_followup`, `wait_watch`, `reviewer_fixer`, and `final_approval` paths behind `dev-loop`.

Use it together with:
- [Copilot PR Follow-up Skill](../copilot-pr-followup/SKILL.md)
- [Public Dev Loop Contract](./public-dev-loop-contract.md)
- [Retrospective Checkpoint Contract](./retrospective-checkpoint-contract.md) when the current step depends on async start/resume/status or retrospective enforcement

## Deterministic orchestration authority

When operating in PR follow-up or async watch mode, use the deterministic state machines
as the authoritative source for:

- Copilot follow-up loop: `detect-copilot-loop-state.mjs` from the resolved skill scripts directory
- reviewer-side PR review loop: `detect-reviewer-loop-state.mjs` from the resolved skill scripts directory

Resolve those helper paths from the skill asset layout described by the main skill. In the `dev-loops`
source repository the skill scripts directory is `../../scripts/` relative to `skills/copilot-pr-followup/SKILL.md`; in normalized
installed copies it may instead be `scripts/` inside the installed skill directory when that layout bundles the helper scripts.

Use the machines to answer:
- what state the PR/loop is in right now
- what transitions are currently allowed
- what the next required action is
- when to stop instead of guessing

Each machine's snapshot-to-state mapping is defined in its owner doc (see the Overview of
[Copilot Loop State Graph](../../docs/copilot-loop-state-graph.md) and
[Reviewer Loop State Graph](../../docs/reviewer-loop-state-graph.md)), under `../../docs/`
relative to `skills/copilot-pr-followup/SKILL.md` in the `dev-loops` source repository. Treat
those links as source-repo references, not bundled installed-skill docs.

For tracker-first MVP `story -> PR -> tracker sync` work, the source-repo reference is [Tracker-First Story-to-PR Contract](../../docs/tracker-story-pr-contract.md). That source doc inherits source-of-truth ownership, the required work item <-> PR link, and reverse-sync semantics from `#21`; it only adds the mutually exclusive workflow-family states and post-merge sync-verification states for this narrower MVP slice.

## Key guarantees from the state machine

These routing guarantees are owned by [Copilot Loop State Graph](../../docs/copilot-loop-state-graph.md); see `COPILOT-STATE-UNRESOLVED-PRIORITY`, `COPILOT-STATE-TERMINAL-STOP`, `COPILOT-STATE-REPLY-BEFORE-REREQUEST`, and `COPILOT-STATE-ACTIVE-REQUEST-WAIT` there for the routing rules driving `unresolvedThreadCount`, `copilotReviewRequestStatus`, and `agentFixStatus`.

## How to use the state machine in practice

1. Run `node <resolved-skill-scripts>/loop/detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`
   to get the current Copilot-loop state, decisive snapshot fields, and recommended next action.

2. If you already ran `<resolved-skill-scripts>/github/request-copilot-review.mjs` and got a known status,
   inject it without re-probing: add `--review-request-status <status>`.

3. When the agent has applied a fix and wants to signal reply/resolve is next, build a snapshot
   with `agentFixStatus: "applied"` and use `--input <snapshot.json>` for interpretation.

4. Branch on the detector output instead of inventing a polling loop:
   - `state=waiting_for_copilot_review` with `snapshot.copilotReviewOnCurrentHead=false`: do **not** poll manually; either run `node <resolved-skill-scripts>/loop/run-watch-cycle.mjs --repo <owner/name> --pr <number>` for persistent async waiting or report the wait state and resume later after the single detector call
   - `state=waiting_for_ci` with `snapshot.ciStatus` in `{ "pending", "none" }`: do **not** poll manually by default; use `dev-loops loop watch-ci --repo <owner/name> --pr <number>` or `node <resolved-skill-scripts>/github/wait-pr-checks.mjs --repo <owner/name> --pr <number>` (settle-blocking with a 0/1/2 exit contract) to block-wait on the combined check/status state (provider-agnostic — CircleCI, GitHub Actions, and any external commit-status / check-run). `gh run watch <run-id>` is an Actions-only fallback when the current-head run id is already known and you know the gating checks are GitHub Actions. Either way, on `timeout`/`changed` report pending CI and resume later after the single detector refresh. Bounded exception: if GitHub created zero current-head check suites/statuses, the previous head rollup was green, and local `npm run verify` already passed for the same current head, rerun `detect-copilot-loop-state.mjs` with `--local-validation-head-sha <current-head-sha>` so the detector can promote that exact zero-suite case to `snapshot.ciStatus="crediblyGreen"` instead of waiting forever on raw `none`.
   - `snapshot.ciStatus="failure"` remains a stop/fix state, never a wait loop

5. For reviewer-side draft-review work, run `node <resolved-skill-scripts>/loop/detect-reviewer-loop-state.mjs --repo <owner/name> --pr <number> [--reviewer-login <login>] [--local-state <path>]`.
   If the state reaches `draft_review_ready`, stage the pending review with
   `node <resolved-skill-scripts>/github/stage-reviewer-draft.mjs --repo <owner/name> --pr <number> --review-file <merged-review.json> --local-state-output <state.json>`,
   then re-run the detector with `--local-state <state.json>`.

6. Follow the `nextAction` from the machine output. For stop states (`review_request_unavailable`,
   `blocked_needs_user_decision`), report to the user and do not proceed.

## Judgment calls that remain in the agent layer

See [Copilot Loop State Graph](../../docs/copilot-loop-state-graph.md)'s "Agent judgment boundary" for the bounded list of decisions the state machine leaves to the agent.

## Workflow overview

```text
ready issue -> confirm scope -> Copilot branch/PR -> async review/watch -> Pi follow-up fixes -> validation -> confirm verdict/action -> merge when authorized
```

Use the resolved `detect-copilot-loop-state.mjs` helper from the skill scripts directory at each
decision point in this flow to determine the current state and route to the correct next step
deterministically.

## Pre-follow-up working rules

> **Phase boundary:** Steps 1-4 apply when no PR exists yet (issue intake).
> If a PR already exists, skip to [Deterministic orchestration authority](#deterministic-orchestration-authority) —
> the state machine owns all post-PR routing.

### Step 1: Choose the work item

Prefer a GitHub issue over an ad hoc local TODO.

When selecting the next item:
- prefer `type:task` issues under the relevant epic
- prefer `status:ready`
- inspect milestone, labels, and acceptance criteria
- confirm whether a PR already exists for the issue before proposing new execution

Useful checks:
- `gh issue list --state open`
- `gh issue view <number>`
- `gh pr list --state open`

If the user asks for status/progress/readiness/merge-state/next-step (including “what is next”):
- resolve authoritative active artifact identity first (issue/PR, plus branch/head SHA when useful)
- for issue targets, resolve authoritative issue↔PR linkage via the startup resolver (`dev-loops loop startup --issue <number>`, run inside the `dev-loop` async subagent) rather than running `detect-linked-issue-pr.mjs` manually; the fail-closed-until-resolved requirement is owned by `FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED` in [Public Dev Loop Contract](./public-dev-loop-contract.md)
- resolve artifact state (`open`/`closed`/`merged`/`not_applicable`)
- resolve current loop state and next action from deterministic helper/state output
- include explicit resolved artifact identity in the answer
- if identity/state cannot be resolved confidently, stop with reconcile/unknown instead of guessing from chat context

### Step 2: Confirm issue scope before execution

Before handing work to Copilot or doing follow-up fixes, summarize:
- issue number and title
- parent epic if present
- milestone
- labels
- exact acceptance criteria
- intended narrow scope
- non-goals inferred from the issue and plan

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

When preparing work for Copilot:
- use the GitHub issue as the source of truth
- preserve the issue's acceptance criteria
- keep the requested scope narrow
- do not broaden into adjacent backlog items
- prefer one issue per PR unless the user explicitly wants bundling

Before any GitHub mutation such as assigning the issue, posting instructions, or changing labels, confirm first unless explicitly authorized.

When you do hand work to Copilot:
- assign `copilot-swe-agent`
- reference the issue number and acceptance criteria clearly
- keep instructions implementation-focused and test-aware

## PR description contract

Follow the PR description contract (see [Agent Instructions](../../AGENTS.md) if present; otherwise use the structure below): detailed structured descriptions, not thin placeholders. At minimum include change summary, scope/context, explicit acceptance criteria, explicit definition of done, and explicit non-goals, and `Closes #N` (or `Fixes #N`) for the linked issue so GitHub auto-closes it on merge.

Checkbox rule: acceptance criteria, definition-of-done items, and any task list must be rendered as real GitHub markdown checkboxes inside list items (`- [ ]` / `- [x]`, also `* [ ]` / `* [x]`). Do not wrap checkbox markers (e.g. `[x]`) in backticks. Do not place checkbox markers inside table cells — task lists are not interactive there even with a leading `- `.

<!-- rule: OPS-DRAFT-FIRST-PR -->
`OPS-DRAFT-FIRST-PR`: New PRs in this workflow MUST be opened as **draft** PRs first when the repository enables `.devloops` at repo root `workflow.requireDraftFirst` (the built-in shipped default remains permissive; this repo opts in) — mechanically enforced by the `create-pr.mjs` wrapper below. Agents MUST NOT create a fresh PR directly in ready-for-review state unless the user explicitly overrides that policy for the current PR scope. The draft gate inspection is a real workflow boundary, so a new PR must exist in draft before `gh pr ready` is even eligible.

Only use `node <resolved-skill-scripts>/github/create-pr.mjs` when authoritative issue↔PR resolution says there is no already-open linked PR. If a PR already exists, reuse/update that canonical PR instead of opening another one. This wrapper preserves the underlying `gh pr create` output contract while enforcing draft-first mechanically and self-assigning the PR by default (`--assignee @me`).

MUST use `node <resolved-skill-scripts>/github/create-pr.mjs --repo <owner/name> --assignee @me --base <base> --head <head> --title "..." --body-file <body-file>` (always draft, self-assigned by default; `--assignee @me` is the default).

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

If the polling interval is 1 minute, do not treat silence shorter than one full poll interval as suspicious, and do not configure needs-attention thresholds close to a few seconds for this loop.
