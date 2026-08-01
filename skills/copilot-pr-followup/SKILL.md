---
name: copilot-pr-followup
description: >-
  Internal routed strategy behind `dev-loop` for GitHub-first Copilot-owned PR
  follow-up: inspect the canonical PR state, request or re-request Copilot when
  appropriate, wait deterministically for new review activity, run narrow Pi
  fix/reply/resolve passes, verify gate evidence, and stop for explicit human
  approval before merge.
compatibility: Internal routed strategy for Copilot PR follow-up. Needs gh auth for PR-followup automation.
allowed-tools: read bash edit write subagent review_loop
user-invocable: false
---

# Copilot PR Follow-up

Canonical owner for the internal `copilot_pr_followup` route behind the public `dev-loop` façade.

It is also the canonical internal owner of the shared post-PR mechanics used by this repo:
PR discovery and interpretation, async watch behavior, fix / reply-resolve / re-request flow,
gate sequencing, final approval, and merge-ready preconditions.

## Route ownership

Use this skill whenever the public router lands on any PR-follow-up path that shares the same
post-PR mechanics:
- `copilot_pr_followup`
- `external_pr_followup`
- `reviewer_fixer`
- `wait_watch`

Route-specific companion docs:
- routed `issue_intake` work is implemented through this skill plus [Copilot Loop Operations](../docs/copilot-loop-operations.md) and [Issue Intake Procedure](../docs/issue-intake-procedure.md)
- routed `final_approval` work is implemented through this skill's **Human approval checkpoint** section; [Final Approval](../final-approval/SKILL.md) is now a thin redirect to that canonical section
- the deterministic state-machine/operator guide lives in [Copilot Loop Operations](../docs/copilot-loop-operations.md)

## Operational cookbook

All commands use the resolved skill scripts directory (see [Skill asset path resolution](#skill-asset-path-resolution) below).

**1. Detect current loop state**
```sh
node <resolved-skill-scripts>/loop/detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>
```
Emits JSON including `{ ok: true, state, allowedTransitions, nextAction, snapshot }`. Follow `nextAction`.

**2. One-step detect → request → emit watch params (preferred handoff contract)**
```sh
node <resolved-skill-scripts>/loop/copilot-pr-handoff.mjs --repo <owner/name> --pr <number>
```
Use this helper output as source of truth for the normal routing seam. Interpret:
- `requestWatchContract.routingState` for request-vs-watch posture
- `requestWatchContract.requestStatus` and top-level `action` / `nextAction`
- `watchArgs` only when `action: "watch"` and `requestWatchContract.watchEntryConfirmed=true`
- `requestWatchContract.stopState` for explicit blocked/stop handling

**3. Preferred async wait-boundary helper**
```sh
node <resolved-skill-scripts>/loop/run-watch-cycle.mjs --repo <owner/name> --pr <number>
```
Persistent async watch/fix loop, not handoff-only behavior: `watch → detect → if threads found, fix + reply + resolve → re-request → watch again → … → pre_approval_gate → merge`. A single returned watch cycle is never completion by itself.

<!-- pi-only -->
**PERSISTENCE MODEL: Subagents do bounded implementation tasks and exit on external wait. The main session drives the loop and re-dispatches when continuation is feasible.** If `cycleDisposition` is `pending` and `terminal` is `false`, the subagent exits on the wait boundary; the main session re-dispatches another watch boundary.
<!-- /pi-only -->

> Under the Claude Code harness, run this loop **inline in a single agent**: the helper-owned wait tools (`dev-loops loop watch-cycle`, `gh run watch`, `dev-loops gate probe-copilot`) block inline and return — when `cycleDisposition` is `pending` and `terminal` is `false`, run the next watch cycle yourself. Do not exit on the wait boundary to have a parent re-dispatch the loop; keep driving it in this agent until a terminal state or the watch budget expires. (Delegating a bounded fix to the `fixer` agent, per Step 6, is still fine — that is task delegation, not re-dispatching the watch loop.)

Max watch timeout: **30 minutes** (from `policy-constants.mjs` COPILOT_REVIEW_WAIT_TIMEOUT_MS); expired budget + still `waiting_for_copilot_review` = hard stop. If the user explicitly asks for async handoff-only behavior, say that out loud and stop after the handoff boundary.

**4. Low-level helpers**
```sh
node <resolved-skill-scripts>/github/request-copilot-review.mjs --help
node <resolved-skill-scripts>/github/probe-copilot-review.mjs --help
node <resolved-skill-scripts>/github/list-review-threads.mjs --help
node <resolved-skill-scripts>/github/wait-pr-checks.mjs --help
node <resolved-skill-scripts>/loop/detect-copilot-loop-state.mjs --help
```

For detailed machine guarantees, judgment calls, pre-follow-up planning rules, PR description rules, and timeout defaults, use [Copilot Loop Operations](../docs/copilot-loop-operations.md).

## Required startup reads

Read the canonical entrypoint briefing first: [Entrypoint Strategies](../docs/entrypoint-strategies.md#copilot-pr-follow-up). Then read only the contract docs needed for the current step:

- [Agent Instructions](../../AGENTS.md) (repo constitution)
- [Public Dev Loop Contract](../docs/public-dev-loop-contract.md) (always)
- [Retrospective Checkpoint Contract](../docs/retrospective-checkpoint-contract.md) (when async state/resume applies)
- Active GitHub issue/PR
- Task-relevant source, tests, config, and CI

Route-dependent: see [Copilot Loop Operations](../docs/copilot-loop-operations.md) and [Issue Intake Procedure](../docs/issue-intake-procedure.md) when relevant.
Verify all material claims against source, tests, configuration, and CI.

## Skill asset path resolution

When this skill refers to helper paths such as `scripts/...` or `docs/...`, resolve them from the actual skill installation layout you are running, not from the active target repository checkout.

Use this rule:
- if the skill is installed as a normalized standalone copy, the required bundled contract docs live under the shared `../docs/` directory next to the installed skill directories. <!-- rule: ASSET-PATH-INSTALLED-NO-ASSUME --> `ASSET-PATH-INSTALLED-NO-ASSUME`: Agents MUST NOT assume helper scripts are bundled unless that installed layout actually contains them.
- if you are working in the `dev-loops` source repository, this skill file lives under `skills/copilot-pr-followup/`, so source-repo helper scripts live two levels up at `../../scripts/`, while required bundled contract docs live one level up at `../docs/`
- when in doubt, resolve helper paths relative to this [skill file](./SKILL.md) first, then verify the target file exists before running it

Required bundled runtime contract docs for installed copies of this skill:
- [Public Dev Loop Contract](../docs/public-dev-loop-contract.md)
- [Retrospective Checkpoint Contract](../docs/retrospective-checkpoint-contract.md)
- [Issue Intake Procedure](../docs/issue-intake-procedure.md)
- [Copilot Loop Operations](../docs/copilot-loop-operations.md)

Read those bundled `../docs/` files from the installed skill layout instead of assuming the source repository checkout is present. If any required bundled contract doc is missing from the installed skill layout, treat that as a packaging/installer bug.
<!-- rule: ASSET-PATH-SOURCE-NO-REPO-LOCAL --> `ASSET-PATH-SOURCE-NO-REPO-LOCAL`: Agents MUST NOT assume `scripts/...` is repo-local to the target codebase they are operating on.

## Authority and safety rules

Source code, tests, CI, and config are authoritative. Generated wiki is navigation aid only. See [Confirmation Rules](../docs/confirmation-rules.md), [Stop Conditions](../docs/stop-conditions.md), and [Merge Preconditions](../docs/merge-preconditions.md) for authorization boundaries.

## Structural quality

Apply [Structural Quality](../docs/structural-quality.md) standards from the `deep` review angle during implementation and follow-up fixes.

## Step 5: PR discovery and interpretation

Treat the PR as the main working artifact once it exists.

Before invoking `resolve-dev-loop-startup.mjs --pr <number>` to continue an externally-created PR (one `create-pr` did not just self-assign), claim ownership: `node scripts/github/edit-pr.mjs --repo <owner/name> --pr <number> --add-assignee @me` (skip if already assigned to the viewer). The resolver's single-contributor ownership gate fails closed on a foreign or unclaimed assignee, or a linked issue assigned to another human — see [Public Dev Loop Contract](../docs/public-dev-loop-contract.md#single-contributor-ownership-gate-resolve-dev-loop-startup).

Inspect: PR body/title (must satisfy [PR description contract](../docs/copilot-loop-operations.md)), closing reference (operator-controlled; subagents must NOT modify), author, review summaries, unresolved comments, latest commits, CI results.

At the issue-assignment seam, use `detect-initial-copilot-pr-state.mjs` and keep waiting when `waiting_for_initial_copilot_implementation`.

<!-- rule: COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY -->
`COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY`: Copilot review requests MUST go through `request-copilot-review.mjs` (see [Operational cookbook](#operational-cookbook)); the agent MUST NOT request Copilot by posting literal `/copilot` or `/copilot re-review` PR comments, and MUST NOT rely solely on `gh pr view --json reviewRequests` to confirm a request. After draft→ready or fix push, explicitly decide whether another pass is desired; if yes, ensure green/credibly green posture first.

<!-- rule: COPILOT-FOLLOWUP-REQUEST-BRANCHING -->
`COPILOT-FOLLOWUP-REQUEST-BRANCHING`: The agent MUST branch on the `request-copilot-review.mjs` machine-readable result exactly as follows, and MUST NOT treat an attempted request as equivalent to a confirmed request:
- `requested`: if another Copilot pass is actually desired, immediately re-baseline with `detect-copilot-loop-state.mjs` and follow its `nextAction` (enter persistent wait only through `dev-loops loop watch-cycle` or `gh run watch`)
- `already-requested`: apply the same detector-first rebasing and wait branching as `requested`
- `suppressed_same_head_clean`: report clean-converged state and stop unless `--force-rerequest-review` bypass is intentionally authorized
- `suppressed_post_convergence_docs_only`: at the round cap, the post-convergence head bump was a provable pure doc/prose delta since the last Copilot-reviewed head, so no fresh blocking round was forced (the prior converged Copilot review still stands). Do NOT enter a Copilot wait seam; treat the PR as converged and proceed to `pre_approval_gate`. Any code/test/config/CI or unclassifiable delta re-opens the round as normal
- `unavailable`: report the limitation and stop
- `blocked_by_copilot_comment`: no request was placed. Delete the violating `violationCommentIds` (or confirm they only quote the rule inside a code span/fenced block, which does not arm the guard) and re-run; do NOT treat this as a placed request and do NOT enter a wait seam
- non-zero / unexpected failure: stop and report error

Branch on `status`, never on `ok`/exit-code truthiness alone: `ok: true` means the helper ran without error, not that a review was placed. Under `--silent`, the exit code is 0 only for `requested`; every other status (including `blocked_by_copilot_comment`) exits non-zero.

### Re-attachment guard (check for existing loop state first)

Before entering issue-intake normalization or asking "what should we do" for a PR that
already has an outer-loop checkpoint, check whether the checkpoint implies an auto-resume:

1. Read the existing outer-loop checkpoint from
   `tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json`.
   Do **not** run `outer-loop.mjs` for this guard — it always rewrites the checkpoint
   (including `timestamp` and potentially incrementing `waitCycles`).
   Read the on-disk artifact without mutating it.
2. If `outerAction` is `continue_wait`:
   - The loop was waiting; resume it from the checkpoint.
     <!-- pi-only -->Under Pi the subagent exits and the main session re-dispatches a fresh
     `dev-loop` async subagent that resumes from the checkpoint.<!-- /pi-only -->
     Under the Claude Code harness, continue the wait inline (run the next watch cycle yourself).
3. If `outerAction` is `reenter_copilot_loop`:
   - The copilot inner loop needs action. Run `copilot-pr-handoff.mjs` to determine the
     exact next step and proceed.
4. If `outerAction` is `reenter_reviewer_loop`:
   - The reviewer inner loop needs action. Enter the reviewer-loop path.
5. If `outerAction` is `stop`:
   - Report the `reason` field and ask for direction.
6. If no checkpoint exists or `outerAction` is `done`:
   - Continue with normal step sequencing.

Do not skip this guard when resuming work on the same PR<!-- pi-only --> (under Pi, between async subagent runs)<!-- /pi-only -->.
The outer-loop checkpoint is the canonical re-attachment artifact.

## Step 6: Async watch behavior

Start every wait seam with a detector refresh: `detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`.

<!-- rule: COPILOT-FOLLOWUP-WAIT-TOOLS -->
`COPILOT-FOLLOWUP-WAIT-TOOLS`: The agent MUST wait only through allowed deterministic tools: `detect-copilot-loop-state.mjs` (one-shot), `dev-loops loop watch-cycle` (persistent), `copilot-pr-handoff.mjs --watch-status` (refresh after timeout/idle), `dev-loops loop watch-ci --repo <owner/name> --pr <number>` (provider-agnostic CI: CircleCI / Actions / external commit-status), `scripts/github/wait-pr-checks.mjs --repo <owner/name> --pr <number>` (same provider-agnostic CI wait, with a direct 0/1/2 process-exit-code contract for shell/scripted callers instead of a JSON `status` field), `gh run watch <run-id> --repo <owner/name>` (Actions-only fallback when the run id is known); otherwise exit and resume later from a fresh detector call.

Practical rules: do not poll manually. `waiting_for_copilot_review` → `run-watch-cycle.mjs` or report-and-resume. `waiting_for_ci` with pending/none CI → `dev-loops loop watch-ci --repo <owner/name> --pr <number>` (provider-agnostic; covers CircleCI / Actions / external commit-status) or report-and-resume; `gh run watch <run-id>` is an Actions-only fallback. `dev-loops loop watch-cycle` also auto-routes a `waiting_for_ci` boundary to this CI watcher. Bounded CI exception: zero current-head suites + previous-head green + local `npm run verify` passed → rerun detector with `--local-validation-head-sha` for `crediblyGreen` promotion. `ciStatus=failure` → stop/fix, never wait.

Preferred approach:
- route decisions through `copilot-pr-handoff.mjs` output; enter watcher only on `action: "watch"` with `watchEntryConfirmed=true`; prefer `dev-loops loop watch-cycle` for deterministic handoff → watch
- `changed` → re-enter Step 7 fix/reply-resolve/validate immediately; do not stop after one watch cycle
- `timeout`/`idle` → re-run `copilot-pr-handoff.mjs --watch-status <status>` once to refresh state; if still `waiting_for_copilot_review` after 30-minute watch budget exhausted, hard stop with `watch timeout — PR #<number> needs manual attention`
- zero-timeout `idle` probes are for explicit one-shot status/reattach checks only; they are not the normal async wait mechanism
- after a successful fix / reply-resolve / re-request cycle, returning to `waiting_for_copilot_review` is a persistence boundary: resume the watcher instead of reporting completion
<!-- pi-only -->
- if a child async run exits and the refreshed state remains non-terminal (for example `waiting_for_copilot_review`) before merge and without a hard stop, treat that as early exit and the main session re-dispatches the same-PR follow-up path when feasible (the subagent exits on external wait)
<!-- /pi-only -->
- dispatch fix findings to the `fixer` agent; do not run inline fix passes in-watcher
- do not report completion while unresolved Copilot feedback remains
- once a watch/probe settles, do not parse its raw output: re-read via `detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>` and `list-review-threads.mjs --repo <owner/name> --pr <number> --unresolved-only` — inline interpreters are barred by `OPS-NO-INLINE-INTERPRETER` in [Copilot loop operations](../docs/copilot-loop-operations.md)

### Canonical async dispatch wording

Every async dev-loop dispatch task body must include this clause verbatim so fresh-context subagents inherit the gate requirement:

> Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA. Do not stop or report completion without this evidence.

Key rules:
- helper-owned sleep inside `dev-loops loop watch-cycle`, `dev-loops gate probe-copilot`, or `dev-loops loop watch-initial` is allowed
- agent-authored shell polling is forbidden: do not use `nohup`, detached shell jobs, `tmux`, `screen`, or ad hoc `for i in $(seq ...)`, `while true`, `until ...; do sleep ...; done`, or `sleep`-retry bash loops
- do not wrap repeated `gh pr view`, `gh pr checks`, `gh api`, or `detect-copilot-loop-state.mjs` calls inside shell polling loops
- do not bypass session-based async notifications with detached shell automation
- if the designated async follow-up skill is not appropriate or available, stop and report rather than improvising a shell watcher
- the async-start contract is enforced in code: `outer-loop.mjs` fails closed without a visible async run id when `workflow.asyncStartMode: required` (relaxed automatically under the Claude Code harness — see #830)

### Async delegation guard rules (#524)

See [Async delegation guard rules](../dev-loop/SKILL.md#async-delegation-guard-rules-524) in the public `dev-loop` skill. Those rules are authoritative and apply to all async subagent dispatch in the PR-followup pipeline. The dev-loop skill is the single source of truth; this section exists only to ensure the rules are visible when this skill is loaded standalone.

## Step 7: Pi review/fix follow-up loop

This step covers four responsibilities: the draft gate right before `gh pr ready`, the narrower post-review follow-up loop once unresolved feedback exists, the pre-approval gate before calling the PR merge-ready, and the final approval / merge boundary.

### Follow-up loop when unresolved feedback exists

When unresolved feedback exists, use a narrow follow-up loop:

1. inspect unresolved comments/threads and failing checks
   - enumerate unresolved threads (with the thread/comment ids the reply-resolve helpers below need) via `scripts/github/list-review-threads.mjs --repo <owner/name> --pr <number> --unresolved-only` rather than a hand-written `gh api graphql` query
2. before the first local file write in each fixer pass on a Copilot-assigned PR, run `node <resolved-skill-scripts>/loop/pre-write-remote-freshness-guard.mjs --branch <headRefName>` as a required fail-closed guard
   - source `<headRefName>` from authoritative PR state (`headRefName`), not from a local branch guess
   - if the guard exits non-zero (`remote_ahead`), stop writing locally, reconcile to the refreshed remote head, then restart the fixer pass
3. classify findings:
   - must-fix: blocks gate; always fixed
   - worth-fixing-now: blocks gate when `blockCleanOnFindingSeverities` includes it; fixed when blocking
   - defer / non-blocking / disagree
4. apply only the accepted narrow fixes
5. run the smallest validation that honestly proves the fix
6. if files changed, run `node <resolved-skill-scripts>/loop/pre-commit-branch-guard.mjs --expected-branch <headRefName>` immediately before every `git add && git commit` sequence as a required fail-closed guard
   - source `<headRefName>` from authoritative PR state (`headRefName`), not from a local branch guess
   - if the guard exits non-zero (`branch_mismatch`), stop and realign to the expected branch before staging or committing
7. if files changed, push the resolving commit before any thread reply claims the fix is present
8. <!-- rule: COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER --> `COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER`: When a comment or thread is actually addressed, the agent MUST reply on GitHub with a short resolution note that references the resolving commit SHA or commit URL when applicable, using the deterministic helpers below rather than ad hoc thread mutations:
   - for one thread, must use the deterministic helper `reply-resolve-review-thread.mjs` from the resolved skill scripts directory
   - when the same bounded resolution note applies to multiple matching unresolved threads, use `reply-resolve-review-threads.mjs` instead of ad hoc inline `gh api` / `gh api graphql` mutations
   - when using the single-thread helper, pair `--comment-id` and `--thread-id` from the same fresh PR thread snapshot rather than mixing ids across review rounds
   - use a body file under `tmp/` rather than inline shell text for the single-thread reply body; for the batch helper, prefer stdin from that same `tmp/` body file rather than inline shell text
   - when the intent is GitHub linkability, keep commit SHAs and issue/PR refs as plain text (for example 3ee82fc and owner/repo#70) and do not wrap them in backticks
   - keep backticks for actual code/path/CLI literals only
   - if either helper was newly added or recently changed, smoke-check it against one real thread before assuming the rest of the loop can rely on it
9. <!-- rule: COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE --> `COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE`: before resolving an addressed review thread, run a post-fix verification checkpoint
   - confirm the GitHub reply actually exists on the intended thread/comment, not only in local notes or helper stdout
   - confirm the pushed current-head diff genuinely addresses the reviewer concern on the flagged lines or pattern; if the concern is only partially addressed, leave the thread open and explain what remains
   - refresh the API-backed thread snapshot via `dev-loops gate capture-threads` and use that refreshed data — including the unresolved thread count — for follow-up decisions rather than prose assumptions
   - if any verification check fails, do **not** resolve the thread; leave it open, add a short explanation when needed, and re-enter the fix/reply loop
10. <!-- rule: COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY --> `COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY`: resolve the addressed review thread only after the reply is attached successfully, the verification checkpoint passes, and the concern is genuinely addressed
    - do not stop at a local fix if GitHub-side reply/resolve is authorized
11. after completing reply/resolve for a pass, verify zero unresolved threads remain via `dev-loops gate capture-threads` before proceeding
    - if the refreshed snapshot reports unresolved threads, re-enter the reply/resolve loop for the missed threads
12. <!-- rule: COPILOT-FOLLOWUP-ROUND-CAP --> `COPILOT-FOLLOWUP-ROUND-CAP`: The agent MUST decide whether another Copilot pass is desired, applying the round-cap/signal-gating rules below, only after GitHub-side reply/resolve work is done for the addressed threads and the refreshed thread snapshot proves zero unresolved threads remain
    - resolve the review-round cap from config via `resolveRefinementConfig(config, "maxCopilotRounds")` from `@dev-loops/core/config`; default config ships `maxCopilotRounds: 5`. For a light-dispatched PR, resolve `resolveEffectiveCopilotRoundCap(config, { lightweight: true })` instead — `min(localImplementation.lightMode.maxCopilotRounds ?? 1, maxCopilotRounds)` (default lightweight cap: 1) — see the [Artifact Authority Contract](../docs/artifact-authority-contract.md) lightweight section (issue #1210)
    - for a light-dispatched PR, pass `--lightweight` on every round-cap-consuming helper invocation — `detect-copilot-loop-state.mjs`, `copilot-pr-handoff.mjs`, `detect-pr-gate-coordination-state.mjs`, `request-copilot-review.mjs`, and `upsert-checkpoint-verdict.mjs` — otherwise those tools resolve the full-PR cap and the composed lightweight cap is never enforced
    - **light-dispatched is a gate-dispatch fact, not a startup fact:** a PR is light-dispatched only when `resolveGateDispatchMode` resolves `inline` for it (scope under the light-mode threshold, no `gate:full` label). A PR started via `--lightweight` (PR-body-as-spec, including issue-less PR-first under `localImplementation.issueless`) whose scope is over the threshold is NOT light-dispatched: do not pass `--lightweight` to the round-cap-consuming helpers for it — it takes the full fan-out and the full-PR round cap
    - **Opt out entirely:** `maxCopilotRounds: 0` disables the external Copilot review gate for the repo — the loop runs `draft_gate → pre_approval_gate` with the local harness only, never requesting or waiting on Copilot. Use this when the repo has no Copilot reviewer configured or prefers local-harness-only review.
    - use the completed Copilot review-round count from `detect-copilot-loop-state.mjs` / `copilot-pr-handoff.mjs` as the current PR's review-round count
    - if completed review rounds have reached the resolved round cap above, do **not** re-request Copilot review within that concluded cycle
    - if the loop already converged and then significant post-convergence changes land on a newer head (new/changed product or test logic, not doc/message/comment-only edits), treat that as a NEW cycle and re-request Copilot review when regular rounds are already > 0 (the prior cycle's cap does not suppress this new-cycle request)
    - the inverse — a pure doc/prose post-convergence head bump must NOT force a fresh blocking Copilot round — is now enforced in code: at the round cap, `request-copilot-review.mjs` consults `resolveConvergenceCarryForward` (`@dev-loops/core/loop/gate-carry-forward`) on the delta since the last Copilot-reviewed head and returns `suppressed_post_convergence_docs_only` when that delta is a provable pure-doc bump, even under `--force-rerequest-review`. The guard is fail-closed: any code/test/config/CI or unclassifiable file, a rename/copy, a non-linear (rebased/amended) advance, or an unavailable compare re-opens the round exactly as before
    - when the round limit is reached **and** the refreshed thread snapshot proves zero unresolved threads **and** current-head CI is green (a real `success`), treat that clean state as eligible for `pre_approval_gate` fallback instead of deadlocking on another Copilot rerequest. `crediblyGreen` does NOT qualify here: at the pre-approval/final boundary it fails closed to `BLOCKED_NEEDS_USER_DECISION` (unconfirmed CI, #552), so the fallback waits for CI to settle to a real green
    - when using that fallback, add a short round-exhaustion note to the visible `pre_approval_gate` gate evidence so the PR records why no further Copilot rerequest occurred
    - if the round cap is reached before the PR is thread-clean or before CI is a real green `success`, reply-resolve any remaining intentionally deferred threads with a short `deferred to follow-up` note, then stop and report that the Copilot round limit was reached
    - **Signal-gated re-request suppression:** the `detect-copilot-loop-state.mjs` state machine classifies review-thread comments by signal level (High/Mid/Low). High-signal (bugs, security, contract violations) always re-requests; Low-signal (cosmetic nits) never re-requests. When low-signal detection is enabled and thresholds are met, the machine returns a low-signal-converged terminal state routing to `pre_approval_gate` without further re-requests. See [Copilot Loop Operations](../docs/copilot-loop-operations.md) for full signal-level semantics.
    - if that local validation is still known red, continue remediation instead of re-requesting Copilot
    - after a fix push advances the PR head SHA, re-run `detect-copilot-loop-state.mjs` for the new head and apply the [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md). Previous-head CI is stale; only current-head results unblock CI-dependent steps. if GitHub CI/checks for the updated head are known red for a fixable issue, continue remediation instead of re-requesting Copilot. <!-- rule: COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE --> `COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE`: only once the updated head is green or credibly green, explicitly re-request Copilot review for the new head. Always use `request-copilot-review.mjs` — never `gh api POST repos/.../requested_reviewers` directly.
    - only enter a wait/watch loop if the request result is confirmed as `requested` or `already-requested`
    - for `requested` / `already-requested`, immediately re-baseline with `detect-copilot-loop-state.mjs`; if the returned state is `waiting_for_copilot_review`, use `dev-loops loop watch-cycle` or stop/resume later, and if the returned state is `waiting_for_ci`, use `dev-loops loop watch-ci` (provider-agnostic CI wait; `gh run watch` is an Actions-only fallback) or stop/resume later after that single detector refresh
    - if the request result is `unavailable`, report that limitation and stop unless the user explicitly wants passive waiting anyway
    - if the request command fails unexpectedly, stop and report the error rather than sleeping and hoping for a new review
13. after a confirmed re-requested Copilot pass, refresh PR thread state again before reporting completion; if fresh Copilot threads exist, return to this follow-up loop rather than stopping at `review requested`
14. after a confirmed re-request returns the PR to `waiting_for_copilot_review`, jump back to Step 6 and keep the same session alive; do not exit on `review requested` alone
15. if scope has broadened, stop and ask before continuing

Do not treat `fix applied locally` as the end of the loop when the workflow also requires GitHub-side reviewer follow-up. If comment/reply authorization is withheld, report explicitly that the code may be fixed while the PR conversation state remains unresolved.

### Mandatory gate-comment command contract

<!-- rule: COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL -->
`COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL`: For every `draft_gate` or `pre_approval_gate` comment, agents MUST run `upsert-checkpoint-verdict.mjs` and MUST NOT use `gh pr comment`, `gh api`, or `gh pr review` for gate comments.

Per `COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL` above, run:

For a gate that ran via the fan-out/fan-in sub-loop, pass the structured per-angle review results via `--findings-json` (NOT the wall-of-text `--findings-summary`). That JSON file comes from the sanctioned fan-in CLI — `dev-loops gate consolidate-fanin --findings-dir <dir> --gate <gate> --out <path> --ledger-out <ledger-path>` — which consolidates the per-angle artifacts the fan-out reviewers wrote (`tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/<angle>.json`) into exactly the nested shape `--findings-json` accepts; never hand-author or mutate it with an inline interpreter. The helper renders a readable per-angle breakdown and derives the single-line `**Findings summary:**` digest itself:

```sh
node <resolved-skill-scripts>/github/upsert-checkpoint-verdict.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <current_head_sha> \
  --verdict <clean|findings_present|blocked> \
  --findings-json <path-to-per-angle-results.json> \
  --next-action "<next action>" --findings-severity-counts '<consolidate-fanin severityCounts>' \
  --execution-mode fanout_fanin
```

Substitute `<consolidate-fanin severityCounts>` with the fan-in CLI's own `severityCounts` field (its output's true, unbudgeted totals) — never a literal all-zero placeholder. `buildStructuredFindingsDigest` only lets this value RAISE the posted `**Findings summary:**` total above `--findings-json`'s own count, never lower it, but a placeholder that always sums to 0 defeats the point of passing it at all and, more importantly, must never be typed in by hand for a `findings_present`/`blocked` round.

`--findings-json` accepts the per-angle review-results array (`[{ angle, verdict?, findings:[{severity, summary, file?, line?, disposition?}] }]`, the primary shape that feeds `consolidateFanin`); it also accepts the flat per-finding array that `consolidateFanin`/`toFindingsLogShape` produce (`[{ severity, summary, angle?, ... }]`), grouping it by each finding's `.angle`. A non-empty input matching neither shape is rejected rather than silently rendering all-clean. If the structured results are not available (an inline run), fall back to `--findings-summary "<summary>"`. A `fanout_fanin` `consolidate-fanin` round withheld to tier 4 has neither shape available: `--out` was never written (or was removed), and the `--ledger-out` flat file is unbudgeted and MUST NOT be substituted for it — passing that file to `--findings-json` can itself exceed the render budget. Post that round with `--findings-summary "<summary>"` only (see the sub-loop contract's [Execution mode and fan-out evidence enforcement](../docs/gate-review-sub-loop-contract.md#execution-mode-and-fan-out-evidence-enforcement)).

For a gate that ran inline (single agent, not via the sub-loop):

```sh
node <resolved-skill-scripts>/github/upsert-checkpoint-verdict.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <current_head_sha> \
  --verdict <clean|findings_present|blocked> \
  --findings-summary "<summary>" \
  --next-action "<next action>" --findings-severity-counts '<true severity counts tallied for this round>' \
  --execution-mode inline_single_agent --inline-reason "<why>"
```

When passing `--findings-severity-counts` for an inline round, substitute the counts you actually tallied, never a copy-pasted all-zero literal — an inline run has no fan-in to source a placeholder from. See `--help` for when it is required.

`--execution-mode <fanout_fanin|inline_single_agent>` records how the gate inspection ran (default `inline_single_agent`). When the gate did not run via the fan-out/fan-in sub-loop ([Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md)), you MUST pass `--execution-mode inline_single_agent --inline-reason "<why>"` — silent inline runs are no longer allowed: inline mode requires a non-empty `--inline-reason` and emits a stderr warning. Because inline is the default mode, a bare call with neither flag now fails with an argument error, so always pass `--execution-mode` explicitly (and `--inline-reason` for inline). The recorded `executionMode` is surfaced by `detect-checkpoint-evidence.mjs` and gated by `gates.requireFanoutEvidence`.

`--force --force-reason` on `upsert-checkpoint-verdict.mjs` is a narrow operator-authorized CI override for the helper itself, not the default gate path. Use it only when the helper refuses gate entry solely because the current head is `blocked_needs_user_decision` with `ciStatus="failure"`, and only after the user explicitly authorizes ignoring that current-head CI failure for this one gate-comment upsert. It does **not** bypass stale-head checks, unresolved-thread / unsettled-review refusal, non-draft `draft_gate` refusal, merge conflicts, or other legality checks.

### Gate fan-out/fan-in procedure (agent-orchestrated)

Both gates run this same checkpoint review chain, owned end-to-end by [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md) (`GATE-EXEC-BUILD-ONCE-SEED`, `GATE-EXEC-BRIEFING-PREFIX`, `GATE-EXEC-SEPARATE-CHAINS`, `GATE-EXEC-POST-BEFORE-FIX`, `GATE-EXEC-REGATE-MANDATORY`, `GATE-EXEC-LIGHT-ESCALATION`); this section owns only this skill's dispatch of that chain. It is an **agent-orchestrated skill procedure** — a node script cannot spawn the per-angle reviewers, so the conductor agent drives the fan-out and uses the pure `@dev-loops/core/loop/gate-fanin` helpers only for consolidation, batching, and ledger mapping.

1. **Context (Phase 1):** build/read the gate-context artifact via `scripts/github/write-gate-context.mjs` (`buildGateContext` resolves the angle set through `resolveGateAnglesDynamic`; mandatory angles always survive). Consume the resulting `tmp/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json` artifact: the FULL diff at `scope.diffPath` plus the top-level adjacent-code bundle (`adjacentCode`) are the build-once seed every reviewer uses verbatim — see `GATE-EXEC-BUILD-ONCE-SEED` for the bundle contract; do not re-derive them per reviewer.
2. **Cache primer (Phase 1.5, MANDATORY):** every fan-out primes the shared prefix (`GATE-EXEC-PRIME`). Default form = **one-reviewer-as-primer** (zero extra cost): dispatch one reviewer first, release the rest once its prefix write has landed (on its first streamed token if the harness streams, else await its completion — never off an unobservable "start") so they cache-read that write — turning the cold-cache race into 1-write-N-reads. (A dedicated angle-less primer is an alternative when preferred.) No verification pass (agent harnesses own caching; nothing to read or pin).
3. **Fan-out (Phase 2):** plan batches with `planFanoutBatches(angles, cap)` using the `gates.maxFanoutReviewers` cap (default 8); spawn one scoped `review` agent per resolved angle (plain Agent tool), parallel up to the cap, sequential for overflow (record any degradation in the gate evidence). Each reviewer follows [review agent scoped angle-review mode](../../agents/review.md): fresh context, single angle, read-only, writing its per-angle findings artifact to `tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/<angle>.json`.
   <!-- rule: COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING -->
   `COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING`: Each reviewer MUST be briefed to review like an external code reviewer hunting real bugs: read the FULL diff (from `scope.diffPath`, or `git diff` when null) and the bundled adjacent code (callers, callees, imports) rather than re-deriving them, then review adversarially for concrete defects (edge cases, input validation, numeric coercion incl. NaN/Infinity/floats/negatives, null/undefined, boundary conditions, mismatched caller/callee contracts, dedup/identity bugs) with `file:line` + the failing scenario — not process nits like "no test exists". Reviewers MAY widen scope (open adjacent repo files beyond the bundle) only when their angle genuinely needs more, recording that in the optional `contextWidened` field on their findings artifact. The LAYOUT of this briefing (invariant block first, this adversarial angle prompt last) and the `--prefix-hash`/`--prefix-file` sentinel recording are owned by `GATE-EXEC-BRIEFING-PREFIX` — not restated here.
4. **Fan-in (Phase 3):** before consolidating, run `scripts/github/verify-briefing-prefixes.mjs --head-sha <current_head_sha>` and stop the pass on a fail-closed result (`GATE-EXEC-BRIEFING-PREFIX` owns this check). Then consolidate via the sanctioned fan-in CLI — its behavior (blocking severities, emitted shapes, fail-closed cases) is owned by [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md) Phase 3, not restated here: `dev-loops gate consolidate-fanin --findings-dir <dir> --gate <gate> --out <findings-json-path> --ledger-out <ledger-path>` (`scripts/loop/consolidate-fanin.mjs`). Write the disposition ledger via `write-gate-findings-log.mjs --findings-file <ledger-path>` (the CLI's `--ledger-out` file, passed straight through — no improvised extraction) before the visible comment (`GATE-EXEC-DISPOSITION-LEDGER`, `GATE-EXEC-POST-BEFORE-FIX` own that ordering and the ledger's opt-out-proof durability). When `resolveGatePostFindingsComments(config)` is true (default), post via `node <resolved-skill-scripts>/github/post-gate-findings.mjs --repo <owner/name> --pr <number> --gate <gate> --head-sha <current_head_sha> --findings-file <ledger-path>`.
5. **Verdict (Phase 4):** post via the [Gate comment command](#mandatory-gate-comment-command-contract) using `--execution-mode fanout_fanin` and `--findings-json <path>` built from the same per-angle artifacts consolidated in Phase 3 — that flag's accepted shapes are owned by the Gate comment command section above; do not restate them here.
6. **Retry (Phase 5):** on blocking findings, drive each internal fan-out finding through the SAME fix → reply-with-resolving-commit → resolve loop used for external Copilot review comments (Step 7 above); re-run only the `findings_present` angles from the previous pass (context-builder and fan-in always re-run); repeat until the consolidated verdict is `clean` for the current head SHA (`GATE-EXEC-REGATE-MANDATORY`).

### Draft gate contract (before marking PR ready for review)

The canonical checkpoint verdict comment contract is [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This section summarizes the procedural integration only.

- **Gate name:** Draft gate
- **Trigger / boundary:** right before running `gh pr ready` (draft → ready for review)
- **Skip rule:** before entering the draft gate, run `detect-pr-gate-coordination-state.mjs` and check `draftGateAlreadySatisfied`. If `true`, skip the draft gate entirely — the draft→ready transition was already recorded. `draft_gate` is a one-time gate; do not re-post on new heads once clean draft-gate evidence exists for the transition record. (While the PR is still draft, advancing the head SHA does require a new draft-gate comment for the new head.) This skip rule applies only to the draft boundary.
- **Execution directive:** run the [Gate fan-out/fan-in procedure](#gate-fan-outfan-in-procedure-agent-orchestrated) (the agent-orchestrated chain defined in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md)) with the draft gate inspection angles resolved from config.
- **Review angles:** resolved at runtime from config via `resolveGateAngles(config, "draft")` from `@dev-loops/core/config`. Default config enables all configured draft gate angle families; consumer repos may opt out individual angles by setting `enabled: false` on that angle's entry. Do **not** apply angles from the other gate; each gate owns its own angle list from config.
- **CI prerequisite:** resolve the draft gate config first (`resolveGateConfig(config, "draft")`). When `requireCi=true` (default), wait for green current-head CI before entering `draft_gate`. When `requireCi=false`, the draft gate may proceed without green CI. This draft-only override does **not** relax `pre_approval_gate` — that gate has its own separate `gates.preApproval.requireCi` knob (default `true`), which when set `false` opts the pre-approval boundary out of the CI precondition independently.
- **Pass criteria:** all configured draft gate angles pass; all findings at severities in `blockCleanOnFindingSeverities` are addressed; validation passes; no unrelated files are included.
- **Next step after passing:** mark the PR ready for review.
- **Board status sync (built-in, after ready-for-review):** the In-Progress board move is now performed automatically as a deterministic tail of `ready-for-review.mjs` — marking the PR ready couples the board move to the ready transition (#1069), so no separate `sync-item-status` step is needed. It stays best-effort and NON-FATAL: it uses local `gh` auth (no CI/PAT), exits 0 when the board is not configured / the item is not on the board / the API fails, and never blocks marking the PR ready.
- **Non-substitution rule:** a clean `draft_gate` comment only authorizes the draft → ready-for-review transition for that head SHA; cross-gate non-substitution is owned by `GATE-COMMENT-NON-SUBSTITUTION` in [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This skill does not restate that rule.
- **Required PR comment:** post a visible checkpoint verdict comment using the mandatory [Gate comment command](#mandatory-gate-comment-command-contract). Comment field content and validation-reporting format are owned by `GATE-COMMENT-VALIDATION-REPORTING`; the draft-boundary comment requirement is owned by `GATE-COMMENT-DRAFT-REQUIREMENTS`; posting-failure fail-closed behavior is owned by `GATE-COMMENT-FAIL-CLOSED` — all in [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This skill does not restate those field/format/fail-closed rules.

### Pre-approval gate contract

This is the default pre-approval gate for this workflow boundary. The canonical checkpoint verdict comment contract is [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This section summarizes the procedural integration only.

- **Gate name:** Pre-approval gate
- **Trigger / boundary:** right before calling a PR/branch review-complete, approval-ready, merge-ready, or ready for final handoff
- **Execution directive:** run the [Gate fan-out/fan-in procedure](#gate-fan-outfan-in-procedure-agent-orchestrated) (the agent-orchestrated chain defined in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md)) with the pre-approval gate inspection angles resolved from config. The `acceptance-criteria` angle is mandatory for this gate (see `.devloops` `gates.preApproval.angles` — the `acceptance-criteria` entry sets `mandatory: true`) and always survives dynamic resolution. Retry rule: in subsequent cycles, only re-run reviewers that produced `findings_present` in the previous pass.
- **Review angles:** resolved at runtime from config via `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config`. Default config enables all configured pre-approval gate angle families; consumer repos may opt out individual angles by setting `enabled: false` on that angle's entry.
- **Persona mapping:** each angle resolves to a reviewer persona via `resolveReviewerRole(config, angle)` from `@dev-loops/core/config`. Include this prompt in each reviewer's briefing so the reviewer knows exactly what to look for.
<!-- pi-only -->
- **Model tier:** resolve each reviewer's model via `resolveRoleModel(config, { role: angle, harness: "pi", kind: "angle" })` from `@dev-loops/core/config` — `kind: "angle"` forces the review (high) tier for the gate activity even when the angle name collides with a routine role (the `docs` angle resolves high, not the `docs` writer role's low tier) — and pass it at dispatch **only when non-null** — a no-op on Pi until an operator sets `models.tiers.<alias>.pi`.
<!-- /pi-only -->
- **Pass criteria:** the sub-loop completes with verdict `clean`; all configured angles pass, following the sequential-fallback rule owned by `GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK` in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md).
- **Acceptance criteria verification:** follow the canonical procedure in [Acceptance Criteria Verification](../docs/acceptance-criteria-verification.md) before posting the `pre_approval_gate` comment. After a clean verification this also ticks the verified PR-body checkboxes via `scripts/github/tick-verified-checkboxes.mjs`, so the merged PR shows checked AC.
- **Next step after passing:** continue the Step 7 flow and then proceed to the human approval checkpoint below.
- **Non-substitution rule:** a clean `pre_approval_gate` comment governs final-approval readiness for that head SHA and is separate from `draft_gate` evidence; cross-gate non-substitution is owned by `GATE-COMMENT-NON-SUBSTITUTION` in [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This skill does not restate that rule.
- **Required PR comment:** post a visible checkpoint verdict comment using the mandatory [Gate comment command](#mandatory-gate-comment-command-contract). Comment field content and validation-reporting format are owned by `GATE-COMMENT-VALIDATION-REPORTING`; the pre-approval-boundary comment requirement is owned by `GATE-COMMENT-PREAPPROVAL-REQUIREMENTS`; posting-failure fail-closed behavior is owned by `GATE-COMMENT-FAIL-CLOSED` — all in [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This skill does not restate those field/format/fail-closed rules.
- <!-- rule: GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE --> `GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE`: Skipping the gate MUST NOT be treated as recoverable by asserting convergence.

### Conflict-resolution gate

Before any merge-ready or final-approval claim, run `detect-pr-gate-coordination-state.mjs` for the current PR. If it reports `gateBoundary=conflict_resolution` or `mergeStateStatus` is conflicted, stop the normal gate path immediately and use this recovery flow:

1. fetch fresh `origin/main`, confirm the current PR head SHA, and summarize the conflict scope from `mergeStateStatus` plus any reported `conflictFiles`
2. ask for explicit authorization before any merge commit or other branch-state-changing reconciliation command
3. after authorization, reconcile locally on the PR branch; default to a merge commit (`git merge origin/main`) per the behind-branch integration policy in [Local Implementation Skill](../local-implementation/SKILL.md#branch--review--merge-policy), unless the operator explicitly chooses another conflict-resolution command
4. auto-resolve simple conflicts when the correct fix is mechanical and clearly in scope; report complex conflicts explicitly and fix them manually only for in-scope files
5. rerun the smallest honest local validation for the touched conflict slice
6. rerun `detect-pr-gate-coordination-state.mjs` for the new head
7. because the head changed, rerun `pre_approval_gate` for the new head before any approval-ready or merge-ready claim
8. wait for current-head CI again before retrying merge evaluation
9. if the chosen reconciliation rewrote branch history (rebase only — merge commits push as a normal fast-forward), ask for explicit authorization before `git push --force-with-lease` (`--force-with-lease` only, never bare `--force`), then continue the loop on the updated head

`mergeStateStatus: CLEAN` alone is not enough to resume approval or merge claims. The existing merge-ready preconditions still apply: zero unresolved review threads, a clean current-head `pre_approval_gate`, and green current-head CI.

### Merge-ready preconditions

See [Merge Preconditions](../docs/merge-preconditions.md). Verify: zero unresolved threads (via `dev-loops gate capture-threads`), visible clean `draft_gate` + current-head `pre_approval_gate`, green CI. Fresh-context review follows [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md).

### Human approval checkpoint

After merge-ready preconditions pass, verify [Merge Preconditions](../docs/merge-preconditions.md) authoritatively before reporting merge-ready. Stop at the human approval checkpoint by default. Cross-check via `dev-loops gate capture-threads` (not prose assertion).
Follow [Merge Preconditions](../docs/merge-preconditions.md): stop at `waiting_for_merge_authorization` after approval unless merge explicitly authorized. Run pre-merge gate evidence check before any `gh pr merge`.

When `approval.enabled` is set, don't just park silently at this stop: run `dev-loops gate offer-human-handoff --repo <owner/name> --pr <number>` to surface candidate reviewers/assignees, then **offer** them to the operator. Only on operator confirmation, route the PR with `--assign <login>` / `--request-review <login>`. This is OFFER-only — never auto-assign. See the `approval` section in [Merge Preconditions](../docs/merge-preconditions.md); it pairs with `autonomy.humanMergeOnly`.

### Mechanical pre-merge gate evidence check

Immediately before any `gh pr merge`, run:

```sh
node <resolved-skill-scripts>/github/detect-checkpoint-evidence.mjs \
  --repo <owner/name> \
  --pr <number>
```

This helper is always-on: it uses `gh api` to fetch visible PR issue comments and fails closed unless both required gate comments exist: a clean `draft_gate` comment for the one-time draft boundary and a clean current-head `pre_approval_gate` comment. Do not run `gh pr merge` if this command exits non-zero. There is no opt-out flag. Resolved threads, green CI, clean Copilot rereview, or local notes do not substitute for this successful helper output. If a final approval or merge boundary sees `gh pr merge` without a same-boundary successful check, treat that as a workflow violation and stop.

### Stale runner-coordination lock held by a completed run

The pre-merge gate evidence check fails closed on the PR's runner-coordination claim (`.pi/runner-coordination/<owner>/<name>/pr-<n>.json`): a fresh merge re-dispatch (new run id) is refused with `ownership_lost`, or `stale_runner` once the claim ages past the max-age window.

The auto-loop now releases its claim best-effort when a run reaches a terminal stop (clean-converged, blocked, or done — including the stop at the human approval checkpoint), so a merge-authorized re-dispatch normally inherits a cleared claim and proceeds. The release is non-fatal: it never blocks the stop, and it never clears a claim owned by a genuinely active competing run.

If a stale claim still blocks the merge because the completing run could not release (crash, killed process, or a pre-#1109 run), the sanctioned recovery for a lock held by a COMPLETED run is an explicit takeover by the merge run:

```sh
node <resolved-skill-scripts>/loop/pr-runner-coordination.mjs takeover \
  --repo <owner/name> --pr <number>
```

`takeover` seizes ownership for the current run id and records the displaced run under `previousRun`. Only take over when the prior owner is genuinely completed/dead. A genuinely active (non-stale) run must still be allowed to block — do not take over to race a live run.

### Mandatory post-merge retrospective checkpoint write

After a merge succeeds (or an explicit retrospective skip is authorized), write the durable retrospective checkpoint before exiting the subagent session:

```sh
node <resolved-skill-scripts>/loop/checkpoint-contract.mjs --state complete --notes "<one-line retrospective summary>"
```

For an explicit skip:

```sh
node <resolved-skill-scripts>/loop/checkpoint-contract.mjs --state skipped --reason "<why retrospective is skipped>"
```

Do not report completion or advance to the next PR queue item until `.pi/dev-loop-retrospective-checkpoint.json` is updated to `complete` or `skipped`.

### Post-merge board sync (best-effort)

After the retrospective checkpoint write, run the post-merge board sync and archive as standard steps of the post-merge hook (see [Merge Preconditions](../docs/merge-preconditions.md) "Post-merge"):

```sh
node <resolved-skill-scripts>/github/post-merge-board-sync.mjs --repo <owner/name> --pr <number> --issue <linked-issue> || true
node <resolved-skill-scripts>/projects/archive-done-items.mjs --repo <owner/name> || true
```

`post-merge-board-sync.mjs` (issue #1458) moves the merged item's board Status to the configured Done column right after merge — omit `--issue` when the merged PR is itself the queue item (issue-less / PR-is-the-queue-item case). It must run from the main checkout, before the worktree-removal step below — it resolves `.devloops` relative to `cwd` and has no `--repo-root` flag, so running it afterwards would leave it with no cwd at all. Board and threshold resolve from `.devloops` (`tracker.board`/`queue.board`, `queue.archiveOlderThanDays`, default 7d), using local `gh` auth — no CI, cron, or PAT. Both steps are best-effort and NON-FATAL, but their exit contracts differ: `post-merge-board-sync.mjs` exits 0 on any parsed invocation, including every board/API failure (a skip/failure logs a warning to stderr instead) — only a usage/argument error (exit 1), an invalid `--jq` filter (exit 2), or a falsy `--silent` predicate is non-zero, which the `|| true` above guards against. `archive-done-items.mjs` exits non-zero on a usage/argument error (1), a GitHub API error or invalid `--jq` filter (2), or a project-not-found (3) — its own `|| true` is load-bearing, not redundant, and masks those failures deliberately so a failed archive run never blocks the merge. Neither step blocks the merge or the retrospective.

`dev-loops queue reconcile` (idempotent, run best-effort at loop startup) is the fallback convergence path when the sync above is ever skipped or missed — it re-derives every item's column from live GitHub state, so a merge that could not run this hook still lands on Done at the next startup.

## Validation policy

Follow [Validation Policy](../docs/validation-policy.md). Default: `npm run verify` before PR creation, gate entry, and merge. For repo-local examples: `npm run test:dev-loop` for skill scripts, contract tests for templates, `git diff --check` for docs. When CI runs exist, use `gh run watch` or `detect-copilot-loop-state.mjs` instead of `sleep`-based polling. Distinguish: locally validated, full PR-equivalent checks, awaiting CI.

## Confirmation checkpoints

See [Confirmation Rules](../docs/confirmation-rules.md). Stop and ask before GitHub mutations (edits, assignments, labels, comments, reviews, thread resolution, commits, pushes, merges, workflows) unless explicitly authorized.

## Stop conditions

Follow [Stop Conditions](../docs/stop-conditions.md). Genuine stops: `blocked` state, `done`, `approval_ready` without merge auth, ambiguous state, scope drift. Non-stops: `waiting` watcher states, quiet observations.

## Anti-patterns

See [Anti-patterns](../docs/anti-patterns.md). Key repo-specific additions:
- Use `reply-resolve-review-thread.mjs` / `reply-resolve-review-threads.mjs` helpers instead of ad hoc `gh api`/`gh api graphql` thread-mutation commands. Do NOT use `gh pr comment`, `gh api`, or `gh pr review` for gate comments (use `upsert-checkpoint-verdict.mjs`).
- Use `list-review-threads.mjs` and `wait-pr-checks.mjs` instead of ad hoc `gh api graphql` review-thread queries or `gh pr checks` shell-pipe polling loops.
- Do not declare merge-ready without visible `pre_approval_gate` comment on current head SHA. Do not declare merge-ready based solely on `mergeable_state: clean` + CI green without gate evidence. CI green + resolved threads alone is insufficient.
- Do not blind-run `gh pr merge`/`gh pr update-branch`/unapproved rebase when conflicted. Do not dispatch async dev-loop tasks that omit the pre-approval gate requirement.
- Do not assume generated wiki is authoritative over code or CI.

## Output expectations

When using this skill, keep user-facing summaries concise and operational.

A good status update should say:
- what issue or PR you inspected
- current state
- what the next recommended action is
- whether authorization is needed before taking it
