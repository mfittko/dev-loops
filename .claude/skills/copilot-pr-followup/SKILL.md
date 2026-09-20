---
name: "copilot-pr-followup"
description: "Internal routed strategy behind `dev-loop` for GitHub-first Copilot-owned PR follow-up: inspect the canonical PR state, request or re-request Copilot when appropriate, wait deterministically for new review activity, run narrow Pi fix/reply/resolve passes, verify gate evidence, and stop for explicit human approval before merge."
allowed-tools: Read Bash Edit Write Agent
user-invocable: false
---
<!-- GENERATED from skills/copilot-pr-followup/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# Copilot PR Follow-up

Canonical internal owner of post-PR mechanics behind public `dev-loop`: discovery,
watch, fix/reply/resolve/re-request, gates, final approval and merge readiness.

## Route ownership

Use this skill whenever the public router lands on any PR-follow-up path that shares the same
post-PR mechanics:
- `copilot_pr_followup`
- `external_pr_followup`
- `reviewer_fixer`
- `wait_watch` uses the separate [Wait / Watch Procedure](../docs/wait-watch-procedure.md);
  load this full follow-up skill only when a fresh envelope selects follow-up.

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

> Under the Claude Code harness, run this loop **inline in a single agent**: the helper-owned wait tools (`dev-loops-run cli/index.mjs loop watch-cycle`, `gh run watch`, `dev-loops-run cli/index.mjs gate probe-copilot`) block inline and return — when `cycleDisposition` is `pending` and `terminal` is `false`, run the next watch cycle yourself. Do not exit on the wait boundary to have a parent re-dispatch the loop; keep driving it in this agent until a terminal state or the watch budget expires. (Delegating a bounded fix to the `fixer` agent, per Step 6, is still fine — that is task delegation, not re-dispatching the watch loop.)

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

Resolve helper and contract paths from the running skill's installation layout, not the target repository.

Use this rule:
- if the skill is installed as a normalized standalone copy, the required bundled contract docs live under the shared `../docs/` directory next to the installed skill directories. <!-- rule: ASSET-PATH-INSTALLED-NO-ASSUME --> `ASSET-PATH-INSTALLED-NO-ASSUME`: Agents MUST NOT assume helper scripts are bundled unless that installed layout actually contains them.
- if you are working in the `dev-loops` source repository, this skill file lives under `skills/copilot-pr-followup/`, so source-repo helper scripts live two levels up at `../../scripts/`, while required bundled contract docs live one level up at `../docs/`
- when in doubt, resolve helper paths relative to this [skill file](./SKILL.md) first, then verify the target file exists before running it

Required bundled runtime contract docs for installed copies of this skill:
- [Public Dev Loop Contract](../docs/public-dev-loop-contract.md)
- [Retrospective Checkpoint Contract](../docs/retrospective-checkpoint-contract.md)
- [Issue Intake Procedure](../docs/issue-intake-procedure.md)
- [Copilot Loop Operations](../docs/copilot-loop-operations.md)

Read the bundled `../docs/` files. A missing required contract is a packaging/installer bug; do not assume a source checkout is available.
<!-- rule: ASSET-PATH-SOURCE-NO-REPO-LOCAL --> `ASSET-PATH-SOURCE-NO-REPO-LOCAL`: Agents MUST NOT assume `scripts/...` is repo-local to the target codebase they are operating on.

### Stale-installed-CLI: prefer worktree-source verdict/ledger tooling (#1661)

Before running verdict/ledger tooling, resolve its source with this helper. An older installed CLI can lack the gate-evidence CI exclusion and block a `pre_approval_gate` verdict on `WAITING_FOR_CI`.

```sh
node <resolved-skill-scripts>/loop/resolve-verdict-ledger-source.mjs --jq .preferredSource
```

- When `preferredSource` is `worktree`, run the verdict/ledger tooling (`upsert-checkpoint-verdict.mjs`, `write-gate-findings-log.mjs`, `detect-checkpoint-evidence.mjs`, and their gate helpers) from the worktree/source `scripts/` layout instead of the installed layout.
- When `preferredSource` is `installed`, run them from the resolved skill-scripts layout (installed) as usual.
- The helper compares the installed dev-loops CLI version against the current source/worktree version (bounded candidate detection); it never changes the gate-evidence CI-exclusion logic itself (`#1661` non-goal) and fails soft to the canonical installed layout when a version cannot be read.

This selection changes the tooling source, not gate behavior.

### Source files under review vs. helper-script paths

Helper-script resolution applies to tooling you run. For skill/doc content under review (`skills/<name>/SKILL.md`, `skills/docs/...`, `docs/...`), installed copies can lag the PR and produce findings against text already fixed.

When reviewing skill/doc source:

1. Read from the worktree under review, using the cwd on the briefing prefix's `worktree:` line. Never review an installed copy.
2. Before citing a line, check it against `git show HEAD:<path>` at the reviewed head. If it is absent, the installed-copy citation is stale.
3. Continue to resolve helper scripts you run from the installation layout above.

`GATE-EXEC-SOURCE-READ-WORKTREE` and its briefing-prefix wiring are owned by [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md).

## Authority and safety rules

Source code, tests, CI, and config are authoritative. Generated wiki is navigation aid only. See [Confirmation Rules](../docs/confirmation-rules.md), [Stop Conditions](../docs/stop-conditions.md), and [Merge Preconditions](../docs/merge-preconditions.md) for authorization boundaries.

## Structural quality

Apply [Structural Quality](../docs/structural-quality.md) standards from the `deep` review angle during implementation and follow-up fixes.

## Step 5: PR discovery and interpretation

Treat the PR as the main working artifact once it exists.

Before invoking `resolve-dev-loop-startup.mjs --pr <number>` to continue an externally-created PR (one `create-pr` did not just self-assign), claim ownership: `dev-loops-run scripts/github/edit-pr.mjs --repo <owner/name> --pr <number> --add-assignee @me` (skip if already assigned to the viewer). The resolver's single-contributor ownership gate fails closed on a foreign or unclaimed assignee, or a linked issue assigned to another human — see [Public Dev Loop Contract](../docs/public-dev-loop-contract.md#single-contributor-ownership-gate-resolve-dev-loop-startup).

Inspect: PR body/title (must satisfy [PR description contract](../docs/copilot-loop-operations.md)), closing reference (operator-controlled; subagents must NOT modify), author, review summaries, unresolved comments, latest commits, CI results.

At the issue-assignment seam, use `detect-initial-copilot-pr-state.mjs` and keep waiting when `waiting_for_initial_copilot_implementation`.

<!-- rule: COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY -->
`COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY`: Copilot review requests MUST go through `request-copilot-review.mjs` (see [Operational cookbook](#operational-cookbook)); the agent MUST NOT request Copilot by posting literal `/copilot` or `/copilot re-review` PR comments, and MUST NOT rely solely on `gh pr view --json reviewRequests` to confirm a request. After draft→ready or fix push, explicitly decide whether another pass is desired; if yes, ensure green/credibly green posture first.

<!-- rule: COPILOT-FOLLOWUP-REQUEST-BRANCHING -->
`COPILOT-FOLLOWUP-REQUEST-BRANCHING`: The agent MUST branch on the `request-copilot-review.mjs` machine-readable result exactly as follows, and MUST NOT treat an attempted request as equivalent to a confirmed request:
- `requested`: if another Copilot pass is actually desired, immediately re-baseline with `detect-copilot-loop-state.mjs` and follow its `nextAction` (enter persistent wait only through `dev-loops-run cli/index.mjs loop watch-cycle` or `gh run watch`)
- `already-requested`: apply the same detector-first rebasing and wait branching as `requested`
- `suppressed_same_head_clean`: report clean-converged state and stop unless `--force-rerequest-review` bypass is intentionally authorized
- `suppressed_post_convergence_docs_only`: at the round cap, the post-convergence head bump was a provable pure doc/prose delta since the last Copilot-reviewed head, so no fresh blocking round was forced (the prior converged Copilot review still stands). Do NOT enter a Copilot wait seam; treat the PR as converged and proceed to `pre_approval_gate`. Any code/test/config/CI or unclassifiable delta re-opens the round as normal
- `unavailable`: report the limitation and stop
- `blocked_by_copilot_comment`: no request was placed. Delete the violating `violationCommentIds` (or confirm they only quote the rule inside a code span/fenced block, which does not arm the guard) and re-run; do NOT treat this as a placed request and do NOT enter a wait seam
- non-zero / unexpected failure: stop and report error

Branch on `status`, never on `ok`/exit-code truthiness alone: `ok: true` means the helper ran without error, not that a review was placed. Under `--silent`, the exit code is 0 only for `requested`; every other status (including `blocked_by_copilot_comment`) exits non-zero.

### Re-attachment guard (check for existing loop state first)

Before intake normalization or asking for PR direction, read the canonical re-attachment
artifact `tmp/copilot-loop/<owner>/<repo>/pr-<n>/outer-loop-state.json` without mutating it.
Never run `outer-loop.mjs` for this guard: it rewrites `timestamp` and may increment `waitCycles`.
Apply this guard on every same-PR resume:

| `outerAction` | Action |
| --- | --- |
| `continue_wait` | Resume from the checkpoint. Under Claude Code, run the next watch cycle inline. |
| `reenter_copilot_loop` | Run `copilot-pr-handoff.mjs` and follow its next step. |
| `reenter_reviewer_loop` | Enter the reviewer-loop path. |
| `stop` | Report `reason` and ask for direction. |
| `done` or no checkpoint | Continue normal step sequencing. |

## Step 6: Async watch behavior

Start every wait seam with a detector refresh: `detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`.

<!-- rule: COPILOT-FOLLOWUP-WAIT-TOOLS -->
`COPILOT-FOLLOWUP-WAIT-TOOLS`: The agent MUST wait only through allowed deterministic tools: `detect-copilot-loop-state.mjs` (one-shot), `dev-loops-run cli/index.mjs loop watch-cycle` (persistent), `copilot-pr-handoff.mjs --watch-status` (refresh after timeout/idle), `dev-loops-run cli/index.mjs loop watch-ci --repo <owner/name> --pr <number>` (provider-agnostic CI: CircleCI / Actions / external commit-status), `scripts/github/wait-pr-checks.mjs --repo <owner/name> --pr <number>` (same provider-agnostic CI wait, with a direct 0/1/2 process-exit-code contract for shell/scripted callers instead of a JSON `status` field), `gh run watch <run-id> --repo <owner/name>` (Actions-only fallback when the run id is known); otherwise exit and resume later from a fresh detector call. Under the Claude Code harness the wait MUST run in the FOREGROUND (a bounded inline probe with an explicit `--timeout`/`--timeout-ms`; `0` = a single immediate check); a backgrounded `until`/`while … sleep … done` poll loop or bare-`&` backgrounding of a probe/wait script is forbidden and mechanically denied by the PreToolUse Bash-gate (`commandContainsDetachedWaitTool` / `decideBashGate`) for the coordinator and every subagent — Claude Code has no async wake, so a backgrounded wait is never joined and orphans past the stop.

<!-- rule: SUBAGENT-STOP-REAP -->
`SUBAGENT-STOP-REAP`: under the Claude Code harness, the `SubagentStop` hook (`.claude/hooks/subagent-stop-reaper.mjs`, deciding via `decideSubagentStopReap`) reaps the agent's own background wait/poll shells before allowing the stop — a safety net for anything that slipped past the `COPILOT-FOLLOWUP-WAIT-TOOLS` prevention. It signals ONLY the agent's own process group members (excluding itself and the session leader), mirroring the `ui-review-teardown` `process.kill(-pgid)` pattern; it never touches unrelated processes, other sessions, or git/worktree state (the uncommitted-work guard owns that). It fails closed on non-POSIX (win32 cannot signal a process group) and never blocks the stop. Prevention (the bare-`&` Bash-gate deny) is the root-cause fix; this reaper is the net.

<!-- rule: COPILOT-FOLLOWUP-REREQUEST-AFTER-PUSH -->
`COPILOT-FOLLOWUP-REREQUEST-AFTER-PUSH`:
After ANY push that advances the head of a PR Copilot has already reviewed — a gate fix, a
Copilot-thread fix, a rebase, a docs touch-up — the agent MUST run
`request-copilot-review.mjs` for the new head and branch on its machine-readable result
(`COPILOT-FOLLOWUP-REQUEST-BRANCHING`) BEFORE entering any watch. Copilot does not re-review
a new head on its own, so a watch entered without that explicit request waits on a review
that was never requested until the budget expires. The green-posture precondition
(`COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE`) and the round cap
(`COPILOT-FOLLOWUP-ROUND-CAP`) still decide WHETHER the request is made; when either blocks
it, or the result is a suppression, stop and report instead of entering a watch.

Practical rules: do not poll manually. `waiting_for_copilot_review` → `run-watch-cycle.mjs` or report-and-resume. `waiting_for_ci` with pending/none CI → `dev-loops-run cli/index.mjs loop watch-ci --repo <owner/name> --pr <number>` (provider-agnostic; covers CircleCI / Actions / external commit-status) or report-and-resume; `gh run watch <run-id>` is an Actions-only fallback. `dev-loops-run cli/index.mjs loop watch-cycle` also auto-routes a `waiting_for_ci` boundary to this CI watcher. Before considering the bounded CI exception, read [Zero-suite local-validation exception](../docs/copilot-ci-status-contract.md#zero-suite-local-validation-exception), including its unavailable CLI input; never self-certify `none` as green. `ciStatus=failure` → stop/fix, never wait.

Preferred approach:
- route decisions through `copilot-pr-handoff.mjs` output; enter watcher only on `action: "watch"` with `watchEntryConfirmed=true`; prefer `dev-loops-run cli/index.mjs loop watch-cycle` for deterministic handoff → watch
- `changed` → refresh startup, build and validate the new envelope, and load its
  `requiredReads` before entering the selected follow-up (Step 7 when fixing);
  do not stop after one watch cycle
- `timeout`/`idle` → re-run `copilot-pr-handoff.mjs --watch-status <status>` once to refresh state; if still `waiting_for_copilot_review` after 30-minute watch budget exhausted, hard stop with `watch timeout — PR #<number> needs manual attention`
- zero-timeout `idle` probes are for explicit one-shot status/reattach checks only; they are not the normal async wait mechanism
- after a successful fix / reply-resolve / re-request cycle, returning to `waiting_for_copilot_review` is a persistence boundary: resume the watcher instead of reporting completion
- dispatch fix findings to the `fixer` agent; do not run inline fix passes in-watcher
- do not report completion while unresolved Copilot feedback remains
- once a watch/probe settles, do not parse its raw output: re-read via `detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`, and read the unresolved working set via `capture-review-threads.mjs --repo <owner/name> --pr <number> --unresolved --bodies` (joined bodies; the canonical re-entry read) or `list-review-threads.mjs --repo <owner/name> --pr <number> --unresolved-only` (thread/comment ids for reply-resolve) — inline interpreters are barred by `OPS-NO-INLINE-INTERPRETER` in [Copilot loop operations](../docs/copilot-loop-operations.md)

### Canonical async dispatch wording

Every async dev-loop dispatch task body must include this clause verbatim so fresh-context subagents inherit the gate requirement:

> Before reporting merge-ready or stopping at the human approval checkpoint, you must complete the pre_approval_gate procedure and verify that a visible clean checkpoint verdict comment exists on the PR for the current head SHA. Do not stop or report completion without this evidence.

Key rules:
- helper-owned sleep inside `dev-loops-run cli/index.mjs loop watch-cycle`, `dev-loops-run cli/index.mjs gate probe-copilot`, or `dev-loops-run cli/index.mjs loop watch-initial` is allowed
- agent-authored shell polling is forbidden: do not use `nohup`, detached shell jobs, `tmux`, `screen`, or ad hoc `for i in $(seq ...)`, `while true`, `until ...; do sleep ...; done`, or `sleep`-retry bash loops
- do not wrap repeated `gh pr view`, `gh pr checks`, `gh api`, or `detect-copilot-loop-state.mjs` calls inside shell polling loops
- do not bypass session-based async notifications with detached shell automation
- if the designated async follow-up skill is not appropriate or available, stop and report rather than improvising a shell watcher
- the async-start contract is enforced in code: `outer-loop.mjs` fails closed without a visible async run id when `workflow.asyncStartMode: required` (relaxed automatically under the Claude Code harness — see #830)

### Async delegation guard rules (#524)

All async PR-followup dispatch MUST follow the public skill's [Guard rules](../dev-loop/SKILL.md#guard-rules).

## Step 7: Pi review/fix follow-up loop

This step covers four responsibilities: the draft gate right before `gh pr ready`, the narrower post-review follow-up loop once unresolved feedback exists, the pre-approval gate before calling the PR merge-ready, and the final approval / merge boundary.

### Follow-up loop when unresolved feedback exists

When unresolved feedback exists, use a narrow follow-up loop:

A gate-authored `medium` review thread still inside its gate's round window
(`GATE-EXEC-THREAD-DISPOSITION` in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md#finding-threads-and-disposition))
is unresolved feedback exactly like an external Copilot comment, and closes through this
same fix → reply-with-resolving-commit → resolve path, not a separate one. A gate-authored
`question` thread is answered (never deferred) through the same loop, and an unanswered
question is likewise unresolved feedback.

1. inspect unresolved comments/threads and failing checks
   - the canonical loop re-entry read for the working set (all currently-unresolved thread bodies, e.g. after a fix push, a resolve pass, or a crash) is `scripts/github/capture-review-threads.mjs --repo <owner/name> --pr <number> --unresolved --bodies` — it emits only unresolved threads as `{ threadId, path, line, isOutdated, bodies }` with the comment bodies already joined, so no capture-then-parse step (and no inline interpreter) is ever needed to read them
   - enumerate unresolved threads (with the thread/comment ids the reply-resolve helpers below need) via `scripts/github/list-review-threads.mjs --repo <owner/name> --pr <number> --unresolved-only` rather than a hand-written `gh api graphql` query
2. before the first local file write in each fixer pass on a Copilot-assigned PR, run `node <resolved-skill-scripts>/loop/pre-write-remote-freshness-guard.mjs --branch <headRefName>` as a required fail-closed guard
   - source `<headRefName>` from authoritative PR state (`headRefName`), not from a local branch guess
   - if the guard exits non-zero (`remote_ahead`), stop writing locally, reconcile to the refreshed remote head, then restart the fixer pass
3. classify findings:
   - high: blocks gate; always fixed
   - medium: blocks gate when `blockCleanOnFindingSeverities` includes it; a LOCATABLE finding is also fixed through round 3 of the gate's chain even when not blocking (then deferred), while a NON-LOCATABLE one is deferred immediately (`GATE-EXEC-BLOCKING-ONLY-FIX` in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md#phase-4--fix))
   - low / non-blocking / disagree (defer is the fixer's disposition for these, not a severity)
   - question: never deferred; answer it (promoting to a defect severity if the answer reveals one, or escalating to the author when unanswerable) — an unanswered question blocks gate-close exactly like an open defect (unresolved feedback, same as a high finding), so it is never a thread to sweep past unanswered
   - nit: cosmetic, non-defect; resolved-with-rationale immediately, no fixer action on the severity axis (judge-acted nits excepted), and NEVER filed to a tracked follow-up issue (net-reduction disposition policy, #1846)
4. apply only the accepted narrow fixes
5. run the smallest validation that honestly proves the fix
6. if files changed, run `node <resolved-skill-scripts>/loop/pre-commit-branch-guard.mjs --expected-branch <headRefName>` immediately before every `git add && git commit` sequence as a required fail-closed guard
   - source `<headRefName>` from authoritative PR state (`headRefName`), not from a local branch guess
   - if the guard exits non-zero (`branch_mismatch`), stop and realign to the expected branch before staging or committing
   - this guard reads the CURRENT branch, which is itself cwd-relative; `WORKTREE-DEFAULT-USE` in [worktree-guidance.md](../docs/worktree-guidance.md#default-rule-use-a-worktree-for-mutating-local-work) additionally mandates addressing the tree explicitly (`git -C <absolute-worktree-path> …`) for the `add`/`commit`/`push` themselves
7. if files changed, push the resolving commit before any thread reply claims the fix is present
8. <!-- rule: COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER --> `COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER`: When a comment or thread is actually addressed, the agent MUST reply on GitHub with a short resolution note that references the resolving commit SHA or commit URL when applicable, using the deterministic helpers below rather than ad hoc thread mutations:
   - each thread's resolving reply states the specific change (file or behavior) that fixed THAT thread, with the resolving commit; a shared body across threads is permitted only when one shared root cause genuinely fixed them all, and the reply must name that shared cause
   - for one thread, must use the deterministic helper `reply-resolve-review-thread.mjs` from the resolved skill scripts directory
   - for multiple matching unresolved threads, use `reply-resolve-review-threads.mjs --message-map <path>` (a JSON file mapping threadId to its distinct resolution body) instead of ad hoc inline `gh api` / `gh api graphql` mutations; `--message` alone is only for the shared-root-cause case above
   - when using the single-thread helper, pair `--comment-id` and `--thread-id` from the same fresh PR thread snapshot rather than mixing ids across review rounds
   - use a body file under `tmp/` rather than inline shell text for the single-thread reply body (via `--message` or stdin); the batch helper takes its per-thread bodies from `--message-map <path>` — a JSON file, never stdin — so there is no separate stdin body file to prefer there
   - when the intent is GitHub linkability, keep commit SHAs and issue/PR refs as plain text (for example 3ee82fc and owner/repo#70) and do not wrap them in backticks
   - keep backticks for actual code/path/CLI literals only
   - if either helper was newly added or recently changed, smoke-check it against one real thread before assuming the rest of the loop can rely on it
9. <!-- rule: COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE --> `COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE`: before resolving an addressed review thread, run a post-fix verification checkpoint
   - confirm the GitHub reply actually exists on the intended thread/comment, not only in local notes or helper stdout
   - confirm the pushed current-head diff genuinely addresses the reviewer concern on the flagged lines or pattern; if the concern is only partially addressed, leave the thread open and explain what remains
   - refresh the API-backed thread snapshot via `dev-loops-run cli/index.mjs gate capture-threads` and use that refreshed data — including the unresolved thread count — for follow-up decisions rather than prose assumptions
   - if any verification check fails, do **not** resolve the thread; leave it open, add a short explanation when needed, and re-enter the fix/reply loop
10. <!-- rule: COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY --> `COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY`: resolve the addressed review thread only after the reply is attached successfully, the verification checkpoint passes, and the concern is genuinely addressed
    - do not stop at a local fix if GitHub-side reply/resolve is authorized
11. after completing reply/resolve for a pass, verify zero unresolved threads remain via `dev-loops-run cli/index.mjs gate capture-threads` before proceeding
    - if the refreshed snapshot reports unresolved threads, re-enter the reply/resolve loop for the missed threads
    - this thread-count check is necessary but not sufficient: `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` (in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md#finding-threads-and-disposition)) additionally fails closed on a THREAD the fixer's own handoff marks tackled whose fixing commit is not contained by the observed PR head, or whose reply/resolve/re-verify step is otherwise incomplete — a zero unresolved-thread count alone does not waive it, and it forbids requesting or re-requesting Copilot review (and every gate-dispatch action) until `scripts/github/verify-fixer-disposition.mjs` reports the tackled set complete
12. <!-- rule: COPILOT-FOLLOWUP-ROUND-CAP --> `COPILOT-FOLLOWUP-ROUND-CAP`: The agent MUST decide whether another Copilot pass is desired, applying the round-cap/signal-gating rules below, only after GitHub-side reply/resolve work is done for the addressed threads and the refreshed thread snapshot proves zero unresolved threads remain
    - resolve the review-round cap from config via `resolveRefinementConfig(config, "maxCopilotRounds")` from `@dev-loops/core/config`; default config ships `maxCopilotRounds: 5`. For a light-dispatched PR, resolve `resolveEffectiveCopilotRoundCap(config, { lightweight: true })` instead — `min(localImplementation.lightMode.maxCopilotRounds ?? 1, maxCopilotRounds)` (default lightweight cap: 1) — see the [Artifact Authority Contract](../docs/artifact-authority-contract.md) lightweight section (issue #1210)
    - for a light-dispatched PR, pass `--lightweight` on every round-cap-consuming helper invocation — `detect-copilot-loop-state.mjs`, `copilot-pr-handoff.mjs`, `detect-pr-gate-coordination-state.mjs`, `request-copilot-review.mjs`, and `upsert-checkpoint-verdict.mjs` — otherwise those tools resolve the full-PR cap and the composed lightweight cap is never enforced
    - **light-dispatched is a gate-dispatch fact, not a startup fact:** a PR is light-dispatched only when `resolveGateDispatchMode` resolves `inline` for it (scope under the light-mode threshold, no `gate:full` label). A PR started via `--lightweight` (PR-body-as-spec, including issue-less PR-first under `localImplementation.issueless`) whose scope is over the threshold is NOT light-dispatched: do not pass `--lightweight` to the round-cap-consuming helpers for it — it takes the full fan-out and the full-PR round cap
    - **Opt out entirely:** `maxCopilotRounds: 0` disables the external Copilot review gate for the repo — the loop runs `draft_gate → pre_approval_gate` with the local harness only, never requesting or waiting on Copilot. Use this when the repo has no Copilot reviewer configured or prefers local-harness-only review.
    - use the completed Copilot review-round count from `detect-copilot-loop-state.mjs` / `copilot-pr-handoff.mjs` as the current PR's review-round count
    - if completed review rounds have reached the resolved round cap above, do **not** re-request Copilot review within that concluded cycle
    - if the loop already converged and then significant post-convergence changes land on a newer head (new/changed product or test logic, not doc/message/comment-only edits), treat that as a NEW cycle and re-request Copilot review when regular rounds are already > 0 (the prior cycle's cap does not suppress this new-cycle request)
    - the inverse — a pure doc/prose post-convergence head bump must NOT force a fresh blocking Copilot round — is now enforced in code: at the round cap, `request-copilot-review.mjs` consults `resolveConvergenceCarryForward` (`@dev-loops/core/loop/gate-carry-forward`) on the delta since the last Copilot-reviewed head and returns `suppressed_post_convergence_docs_only` when that delta is a provable pure-doc bump, even under `--force-rerequest-review`. The guard is fail-closed: any code/test/config/CI or unclassifiable file, a rename/copy, a non-linear (rebased/amended) advance, or an unavailable compare re-opens the round exactly as before
    - **below the cap**, that same carry-forward proof is NOT applied automatically — a below-cap head-advanced bump is normally expected to get a real Copilot pass. The one exception is an explicit, human-only operator withdrawal (issue 1441): see the "Head-advanced sibling case" in [Merge Preconditions](../docs/merge-preconditions.md) for the escape hatch and the marker it records; never invoke it as an automated substitute for a real re-request
    - when the round limit is reached **and** the refreshed thread snapshot proves zero unresolved threads **and** current-head CI is green (a real `success`), treat that clean state as eligible for `pre_approval_gate` fallback instead of deadlocking on another Copilot rerequest. `crediblyGreen` does NOT qualify here: at the pre-approval/final boundary it fails closed to `BLOCKED_NEEDS_USER_DECISION` (unconfirmed CI, #552), so the fallback waits for CI to settle to a real green
    - when using that fallback, add a short round-exhaustion note to the visible `pre_approval_gate` gate evidence so the PR records why no further Copilot rerequest occurred
    - if the round cap is reached before the PR is thread-clean or before CI is a real green `success`, reply-resolve any remaining intentionally deferred threads with a short `deferred to follow-up` note, then stop and report that the Copilot round limit was reached
    - **Signal-gated re-request suppression:** the `detect-copilot-loop-state.mjs` state machine classifies review-thread comments by signal level (High/Mid/Low). High-signal (bugs, security, contract violations) always re-requests; Low-signal (cosmetic nits) never re-requests. When low-signal detection is enabled and thresholds are met, the machine returns a low-signal-converged terminal state routing to `pre_approval_gate` without further re-requests. See [Copilot Loop Operations](../docs/copilot-loop-operations.md) for full signal-level semantics.
    - if that local validation is still known red, continue remediation instead of re-requesting Copilot
    - after a fix push advances the PR head SHA, re-run `detect-copilot-loop-state.mjs` for the new head and apply the [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md). Previous-head CI is stale; only current-head results unblock CI-dependent steps. if GitHub CI/checks for the updated head are known red for a fixable issue, continue remediation instead of re-requesting Copilot. <!-- rule: COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE --> `COPILOT-FOLLOWUP-REREQUEST-GREEN-GATE`: only once the updated head is green or credibly green, explicitly re-request Copilot review for the new head. Always use `request-copilot-review.mjs` — never `gh api POST repos/.../requested_reviewers` directly.
    - only enter a wait/watch loop if the request result is confirmed as `requested` or `already-requested`
    - for `requested` / `already-requested`, immediately re-baseline with `detect-copilot-loop-state.mjs`; if the returned state is `waiting_for_copilot_review`, use `dev-loops-run cli/index.mjs loop watch-cycle` or stop/resume later, and if the returned state is `waiting_for_ci`, use `dev-loops-run cli/index.mjs loop watch-ci` (provider-agnostic CI wait; `gh run watch` is an Actions-only fallback) or stop/resume later after that single detector refresh
    - if the request result is `unavailable`, report that limitation and stop unless the user explicitly wants passive waiting anyway
    - if the request command fails unexpectedly, stop and report the error rather than sleeping and hoping for a new review
13. after a confirmed re-requested Copilot pass, refresh PR thread state again before reporting completion; if fresh Copilot threads exist, return to this follow-up loop rather than stopping at `review requested`
14. after a confirmed re-request returns the PR to `waiting_for_copilot_review`, jump back to Step 6 and keep the same session alive; do not exit on `review requested` alone
15. if scope has broadened, stop and ask before continuing

Do not treat `fix applied locally` as the end of the loop when the workflow also requires GitHub-side reviewer follow-up. If comment/reply authorization is withheld, report explicitly that the code may be fixed while the PR conversation state remains unresolved.

### Mandatory gate-comment command contract

<!-- rule: COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL -->
`COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL`: For every `draft_gate` or `pre_approval_gate` verdict, agents MUST run `upsert-checkpoint-verdict.mjs`, never `gh pr comment`, `gh api`, or `gh pr review`. The helper owns the single COMMENT review, finding placement, markers and digest (`GATE-COMMENT-SINGLE-SURFACE`).

For fan-out/fan-in, use the structured results and true, unbudgeted `severityCounts` returned by the SAME single sanctioned call: `dev-loops-run cli/index.mjs gate consolidate-fanin --repo <owner/name> --pr <n> --findings-dir <dir> --head-sha <headSha> --gate <gate> --out <path> --ledger-out <ledger-path> --jq '.severityCounts'`. Its inputs are the reviewers' current-head `tmp/gate-reviews/<repo-slug>/pr-<N>/<gate>-<headSha>/<angle>.json` artifacts (`GATE-EXEC-ARTIFACT-HEAD-STAMP`). Never hand-author or mutate its output with an inline interpreter, invoke consolidation again to extract another shape, or substitute all-zero severity counts.

```sh
node <resolved-skill-scripts>/github/upsert-checkpoint-verdict.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <current_head_sha> \
  --verdict <clean|findings_present|blocked> \
  --findings-json <path-to-per-angle-results.json> \
  --findings-ledger <findings-log-path> \
  --next-action "<next action>" --findings-severity-counts '<consolidate-fanin severityCounts>' \
  --execution-mode fanout_fanin
```

Pass `--findings-ledger` on EVERY round: use the durable log path returned by `write-gate-findings-log.mjs` (`tmp/gate-findings/<owner-name>/pr-<N>/<gate>-<headSha>.json`), NOT the flat `consolidate-fanin --ledger-out` file, which lacks the required repo/pr/gate/headSha identity. Without it there is no finding surface or finding threads. The helper, not the conductor, handles inline versus body-filed findings, suppression markers and rendered counts.

`--findings-json` accepts per-angle results (`[{angle, verdict?, findings:[{severity, summary, file?, line?, disposition?}]}]`) or flat findings (`[{severity, summary, angle?, ...}]`, grouped by angle); unrecognized non-empty input fails closed. Use the sanctioned fan-in `--out`. If a withheld round removed or never wrote it, DO NOT substitute the unbudgeted `--ledger-out` file: that can exceed the render budget. Instead pass `--findings-summary "<summary>"` PLUS the durable `--findings-ledger <findings-log-path>`, never summary alone. [Phase 3 — Consolidation](../docs/gate-review-sub-loop-contract.md#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger) owns provenance-based mandatory-angle proof and refusal when neither proof artifact is supplied.

For an inline round without structured results:

```sh
node <resolved-skill-scripts>/github/upsert-checkpoint-verdict.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <current_head_sha> \
  --verdict <clean|findings_present|blocked> \
  --findings-summary "<summary>" \
  --findings-ledger <findings-log-path> \
  --next-action "<next action>" --findings-severity-counts '<true severity counts tallied for this round>' \
  --execution-mode inline_single_agent --inline-reason "<why>"
```

Use the inline round's actually tallied counts, never an all-zero placeholder; see `--help` for when counts are required. Always pass `--execution-mode` explicitly. Inline requires `--execution-mode inline_single_agent --inline-reason "<why>"` with a non-empty reason and emits a warning. The mode defaults to inline, so omitting both flags fails. `detect-checkpoint-evidence.mjs` exposes the recorded mode; `gates.requireFanoutEvidence` governs its admissibility.

`--force --force-reason` on `upsert-checkpoint-verdict.mjs` is a narrow operator-authorized CI override for the helper itself, not the default gate path. Use it only when the helper refuses gate entry solely because the current head is `blocked_needs_user_decision` with `ciStatus="failure"`, and only after the user explicitly authorizes ignoring that current-head CI failure for this one gate-comment upsert. It does **not** bypass stale-head checks, unresolved-thread / unsettled-review refusal, non-draft `draft_gate` refusal, merge conflicts, or other legality checks.

For a `pre_approval_gate` verdict, ALWAYS compute the size budget first and thread it into the upsert via `--size-budget-json`:

```sh
# check-size-budget.mjs exits 0 (pass) or 1 (escalate|block) for a VALID
# outcome — both leave <size-budget-json-path> populated. Only exit 2 means
# an arg/runtime error with no usable JSON, so abort on that alone. Capture
# the exit status via the `if` condition, not a bare `$?` after the command:
# under `set -e` a bare command followed by `status=$?` never reaches the
# capture, because the shell exits on the command's own nonzero status first.
if node <resolved-skill-scripts>/loop/check-size-budget.mjs --base origin/<base-branch> --head <current_head_sha> > <size-budget-json-path>; then
  check_size_budget_status=0
else
  check_size_budget_status=$?
fi
if [ "$check_size_budget_status" -eq 2 ]; then
  echo "check-size-budget.mjs failed (exit 2); aborting before upsert" >&2
  exit 2
fi
node <resolved-skill-scripts>/github/upsert-checkpoint-verdict.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate pre_approval_gate \
  --head-sha <current_head_sha> \
  --verdict <clean|findings_present|blocked> \
  ... \
  --size-budget-json <size-budget-json-path>
```

Reuse `check-size-budget.mjs`; never reimplement `computeSizeBudget`/`evaluatePrSizeBudget`. Explicit JSON reuses the computed result. If omitted, the helper auto-derives only for `pre_approval_gate`, failing closed when the base/diff cannot be resolved and naming `--size-budget-json` as the escape hatch. Draft/review do not auto-derive; their absent size evidence has no size-budget merge-gate effect because that gate reads only pre-approval evidence.

### Gate fan-out/fan-in procedure (agent-orchestrated)

Before executing this procedure, read and follow the complete [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md). Its phases, branches and evidence requirements are mandatory; the checklist below is not a substitute for that owner.

Every sanctioned fan-out round passes the emitter's keyed plan to BOTH Phase 3
consumers: use `--emit-plan <emit-plan-path>` on `consolidate-fanin.mjs` and the
later `write-gate-findings-log.mjs --provenance <json>` call. At the shared
provenance-write seam the plan only guards correspondence to emitted units; it
never supplies findings or provenance. Omission stays backward-compatible for
callers outside this sanctioned path.

Both gates run this same checkpoint review chain, owned end-to-end by [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md) (`GATE-EXEC-BUILD-ONCE-SEED`, `GATE-EXEC-BRIEFING-PREFIX`, `GATE-EXEC-SEPARATE-CHAINS`, `GATE-EXEC-POST-BEFORE-FIX`, `GATE-EXEC-REGATE-MANDATORY`, `GATE-EXEC-ANGLE-CARRY-FORWARD`, `GATE-EXEC-LIGHT-ESCALATION`); this section owns only this skill's dispatch of that chain. It is an **agent-orchestrated skill procedure** — a node script cannot spawn the per-angle reviewers, so the conductor agent drives the fan-out and uses the pure `@dev-loops/core/loop/gate-fanin` helpers only for consolidation, batching, and ledger mapping.

1. **Context (Phase 1):** run
   `node <resolved-skill-scripts>/loop/run-gate-validation.mjs --repo <owner/name> --pr <number> --gate <gate> --head-sha <current_head_sha>`
   ONCE per round before building context (`GATE-EXEC-VALIDATION-ARTIFACT`). Build/read the artifact through `scripts/github/write-gate-context.mjs`, passing `--validation-results <path>` and, for a `gate:full` PR, `--full-label`. Consume `tmp/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json`: its resolved angles, full diff at `scope.diffPath`, and `adjacentCode` are the build-once reviewer seed; do not re-derive them per reviewer (`GATE-EXEC-BUILD-ONCE-SEED`). Reviewers consume the recorded validation instead of rerunning its suites. Let the CLI resolve the PR body and every closing issue/body; pass `--pr-body`/`--issue-body`/`--acceptance-criteria` only to override live values. Failed GitHub reads fail closed with no artifact.
2. **Carry-forward (Phase 1.2):** Skip this step on a gate's first round. Otherwise, before dispatch, run `node <resolved-skill-scripts>/github/resolve-angle-carry-forward.mjs --repo <owner/name> --pr <number> --gate <gate> --prev-head <prior_head_sha> --head-sha <current_head_sha> --spec-authority <identity-path>` from the current-head worktree. Use FULL 40-character SHAs; abbreviated keys cannot locate the prior log. `--prev-head` MUST be this same conductor's most recently recorded head for this gate, retained from the immediately preceding round in run state, never guessed or discovered by scanning for a preferable older log.

   Follow `GATE-EXEC-ANGLE-CARRY-FORWARD` in the mandatory [owner](../docs/gate-review-sub-loop-contract.md#angle-carry-forward-fail-closed): `clean` and `findings_present` are eligible, subject to every surface, attribution and mandatory-angle guard. Carried open findings stay open and blocking as before; preserve their prior reviewer identity, `carriedVerdict` and `carriedFromHead`, never a fabricated fresh review. On success `{ carried, mustRerun }`, subtract, never substitute: dispatch every current-head resolved angle minus the plan's `carried` angles. `mustRerun` is informational, not the dispatch set; newly resolved angles absent from both lists still run. On ANY non-zero exit, including parse/usage failure, fan out every resolved angle; never treat exit 1 as "nothing to re-run" or search older logs to evade refusal.
3. **Cache primer (Phase 1.5, MANDATORY):** follow `GATE-EXEC-PRIME`, including its request-envelope and ordering-evidence duties. Default: **one-reviewer-as-primer**; dispatch one reviewer first and release the rest after its prefix write lands (first streamed token if available, otherwise completion, never an unobservable "start"). A dedicated angle-less primer is an alternative. This establishes ordering, not a measured cache hit; there is no cache-hit verification pass when the harness exposes no cache telemetry.
4. **Fan-out (Phase 2):** read and follow the owner's [Phase 2](../docs/gate-review-sub-loop-contract.md#phase-2--fan-out-independent-reviewers-seeded-with-the-neutral-bundle), including `GATE-EXEC-FANOUT-DISPATCH-EMIT` and `GATE-EXEC-BRIEFING-PREFIX`. Rebuild the context after carry-forward with `--carried-angles <json> --prev-head <prior_head_sha>`, then run `node <resolved-skill-scripts>/github/emit-fanout-dispatch.mjs --repo <owner/name> --pr <n> --gate <gate> --head-sha <sha> --pending --carry-forward-plan <json>` using the resolver’s complete carry plan. This includes all-carried rounds: consume the keyed zero-unit plan in fan-in and ledger writing, without dispatching a reviewer. For full fallback (`carried: []`), rebuild with `--prev-head` alone and emit without `--pending`. Dispatch one collectable fresh-context `review` agent per emitted unit using its `promptPath` bytes verbatim; obey the emitted `maxConcurrent`, not the unsplit context's wave plan. If all angles in a unit share one non-`full` scope, additionally seed its matching `briefingVariants[scope]` after the invariant prefix; mixed/`full` units use the invariant prefix alone. The reviewer runs its fresh-context guard once per unit: `--scope <gate>-group-<name>` for a group, `<gate>-<angle>` for a singleton. Record actual reviewer identities and each emitted `group` for fan-in. Each reviewer writes one current-head artifact per angle, not one per group. Do not re-derive prompts, groups or personas in the conductor.
   Preserve the emitted `group` even on a one-angle split tail; its angle-shaped scope does not make it an ungrouped resolved unit (ADR0072).
   <!-- rule: COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING -->
   `COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING`: Each reviewer MUST be briefed to review like an external code reviewer hunting real bugs: read the FULL diff (from `scope.diffPath`, or `git diff` when null) and the bundled adjacent code (callers, callees, imports) rather than re-deriving them, then review adversarially for concrete defects (edge cases, input validation, numeric coercion incl. NaN/Infinity/floats/negatives, null/undefined, boundary conditions, mismatched caller/callee contracts, dedup/identity bugs) with `file:line` + the failing scenario — not process nits like "no test exists". Reviewers MAY widen scope (open adjacent repo files beyond the bundle) only when their angle genuinely needs more, recording in the optional `contextWidened` field only the widening that moved their judgment. This angle-specific text is what the conductor supplies as `scripts/github/compose-reviewer-prompt.mjs --angle-suffix-file` (issue #1852) — the SANCTIONED way this briefing is actually assembled into one reviewer prompt, right after the same step's `resolve-angle-carry-forward.mjs`/`verify-fresh-review-context.mjs` calls and before spawning the reviewer, never a hand-assembled per-group preamble. The LAYOUT of this briefing — invariant block first, this adversarial angle prompt last, so every reviewer's prompt shares one byte-identical cache-aligned prefix (the pointer line itself, when a harness seeds via a file pointer rather than inline bytes) — the composer, and the `--prefix-hash`/`--prefix-file` sentinel recording, are owned by `GATE-EXEC-BRIEFING-PREFIX` — not restated here.
   Each reviewer's briefing also carries a known-findings block, appended AFTER this
   angle-specific prompt and never into the byte-identical prefix `GATE-EXEC-BRIEFING-PREFIX`
   hashes, listing every currently open or resolved finding thread regardless of author so the
   reviewer does not re-raise what a thread already covers; build the block from
   `dev-loops-run scripts/github/capture-review-threads.mjs --repo <owner/name> --pr <number>` output
   (the full-bodies read, not `list-review-threads.mjs`'s 200-char listing excerpt), never
   an ad-hoc GraphQL call. The block's content, dedupe contract, and prefix-hash non-interference
   are owned by `GATE-EXEC-FINDING-THREADS` in
   [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md#finding-threads-and-disposition).
5. **Fan-in (Phase 3):** read and follow the owner's [Phase 3](../docs/gate-review-sub-loop-contract.md#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger) and [disposition-ledger contract](../docs/gate-review-sub-loop-contract.md#disposition-ledger-and-durable-logging). Consolidate once:
   `dev-loops-run cli/index.mjs gate consolidate-fanin --repo <owner/name> --pr <n> --findings-dir <dir> --head-sha <current_head_sha> --gate <gate> --expected-dispatch-units <n> --out <findings-json-path> --ledger-out <ledger-path> --emit-plan <emit-plan-path> --jq '.severityCounts'`.
   Use the actual emitted-and-dispatched unit count for `<n>`; omit that flag when zero. Capture the returned true severity totals for the verdict; do not invoke consolidation again to extract them. When Phase 1.2 returned a plan, pass both `--carried-angles <json>` and `--carry-forward-plan <json>`; omit both on the first round. Any non-zero result stops the pass, regardless of existing output files.

   Before the durable write, follow the owner's [Phase 3.5](../docs/gate-review-sub-loop-contract.md#phase-35--judge-relevance-disposition-1525): dispatch the judge with prior-round history and current spec/head/content identity, then consume its relevance and spec-authority verdicts. Write `--ledger-out` directly through `write-gate-findings-log.mjs --findings-file <ledger-path> --judge-verdict <judge-verdict-path> --emit-plan <emit-plan-path> --provenance '<json>' --execution-mode fanout_fanin`, before the visible verdict. Provenance is `{ distinctReviewers: <int>, perAngle: [...] }`: cover every resolved angle with actual fresh identities and emitted group names, plus each carried entry's `carriedFromHead` and all prior `reviewer`/`dispatchId`/`model` fields. Do not use the carry plan's explanatory `reason` as provenance. On `gate:full`, also pass `--full-label` to the ledger writer. Thread the round's spec-authority identity through both writers as required by the owner's Spec-context seam. Only if `gates.postFindingsComments` is explicitly enabled, also run `node <resolved-skill-scripts>/github/post-gate-findings.mjs --repo <owner/name> --pr <number> --gate <gate> --head-sha <current_head_sha> --findings-file <ledger-path>`; that command accepts no `--provenance`.

   Run `dev-loops-run cli/index.mjs gate judge-pass --repo <owner/name> --pr <number> --gate <gate> --head-sha <current_head_sha> --findings-file <ledger-path> --judge-verdict <judge-verdict-path> --out <act-list-path> --ledger-out <enriched-ledger-path> --spec-file <spec-path> --content-digest <content-digest> --spec-authority-verdict <spec-authority-verdict-path>`, adding the owner's required re-entry flags. Pass only its `act` list to the fixer (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`), never the unfiltered ledger. A failed bridge requires a current-head judge rerun; it never authorizes severity-only fallback or skipped spec authority. Keep the enriched ledger for verdict/disposition evidence.
6. **Verdict (Phase 4):** post through the [Gate comment command](#mandatory-gate-comment-command-contract) with `--execution-mode fanout_fanin` and the same durable log as `--findings-ledger <findings-log-path>` (`GATE-EXEC-FINDING-THREADS`). Check whether fan-in's `--out` exists: if present, use its same-round `--findings-json <path>`; a withheld round deletes `--out`, so use `--findings-summary "<summary>"` PLUS `--findings-ledger`, never summary alone. Follow the command contract's accepted shapes and coverage-proof requirements. Do NOT run `close-gate-findings.mjs` until after step 7's fixer triage (#1585).
7. **Retry / fixer triage (Phase 5):** on EVERY round, including a clean verdict, apply the owner's Phase 4 and `GATE-EXEC-THREAD-DISPOSITION` to all findings. The judge controls relevance; fixer work receives only the `act` list and retains reproduction-based rejection. Within that list, triage high/medium/low defects and answer locatable question threads (answer, promote to a defect, or escalate); body-filed findings retain the owner's non-locatable disposition rules. Defects may be fixed cheaply in the same commit when already touching that code, otherwise deferred where permitted. Low findings may defer from round 1; the medium fix window is unchanged. Nits require no severity-axis fixer cycle; a judge `act` on a nit is the exception and reaches the fixer through the severity-blind act filter. Drive high/in-window-medium blocking findings through Step 7's fix → reply-with-resolving-commit → resolve loop.

   After triage, at EVERY gate close (clean or not), run
   `node <resolved-skill-scripts>/github/close-gate-findings.mjs --ledger <findings-log-path> --allowed-refs <governing-issue>`
   against the same ledger. Resolve `<governing-issue>` deterministically from Phase 1's `closingIssuesReferences` / `Closes #N`; pass all closing issue numbers as CSV for an umbrella PR, never a hardcoded literal. Omit the flag only when the PR closes no issue. This permits bare references to governing issues only; unrelated issue references remain fail-closed.

   The sweep only dispositions threads; it posts no verdict and never fix-closes. It resolves remaining low/nit/out-of-window-medium threads, leaving high/question/in-window-medium unresolved. Resolution does not imply filing or a `disposition=deferred` stamp: out-of-window medium always gets both; low only when its own marker carries explicit `operatorVisible: true` (absent/false means resolve-with-rationale, never file/stamp); nit never. Its reported `unresolvedGateThreadCount` must be zero for downstream gate-close assertions.

   Then re-enter the chain at Phase 1 for the fixed head — [Phase 1.2](../docs/gate-review-sub-loop-contract.md#angle-carry-forward-fail-closed) decides what re-runs, including eligible findings-present angles whose open findings and provenance carry unchanged. Context-builder and fan-in always re-run. Repeat until the consolidated verdict is `clean` for the current head SHA AND 0 unresolved gate-authored threads remain (`GATE-EXEC-REGATE-MANDATORY`, `GATE-EXEC-THREAD-DISPOSITION`).

### Draft gate contract (before marking PR ready for review)

The canonical checkpoint verdict comment contract is [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This section summarizes the procedural integration only.

- **Gate name:** Draft gate
- **Trigger / boundary:** right before running `gh pr ready` (draft → ready for review)
- **Skip rule:** before entering the draft gate, run `detect-pr-gate-coordination-state.mjs` and check `draftGateAlreadySatisfied`. If `true`, skip the draft gate entirely — the draft→ready transition was already recorded. `draft_gate` is a one-time gate; do not re-post on new heads once clean draft-gate evidence exists for the transition record. (While the PR is still draft, advancing the head SHA does require a new draft-gate comment for the new head.) This skip rule applies only to the draft boundary.
- **Execution directive:** run the [Gate fan-out/fan-in procedure](#gate-fan-outfan-in-procedure-agent-orchestrated) (the agent-orchestrated chain defined in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md)) with the draft gate inspection angles resolved from config.
- **Review angles:** resolved at runtime from config via `resolveGateAngles(config, "draft")` from `@dev-loops/core/config`. Default config enables all configured draft gate angle families; consumer repos may opt out individual angles by setting `enabled: false` on that angle's entry. Do **not** apply angles from the other gate; each gate owns its own angle list from config.
- **CI prerequisite:** resolve the draft gate config first (`resolveGateConfig(config, "draft")`). When `requireCi=true` (default), wait for green current-head CI before entering `draft_gate`. When `requireCi=false`, the draft gate may proceed without green CI. This draft-only override does **not** relax `pre_approval_gate` — that gate has its own separate `gates.preApproval.requireCi` knob (default `true`), which when set `false` opts the pre-approval boundary out of the CI precondition independently.
- **Pass criteria:** all configured draft gate angles pass; all findings at severities in `blockCleanOnFindingSeverities` are addressed; validation passes; no unrelated files are included.
- **Next step after passing:** mark the PR ready for review via `scripts/github/ready-for-review.mjs` — never a raw `gh pr ready` call or the GitHub UI's "Ready for review" button, both of which bypass its gate-authored-thread guard (`RAW-GH-PR-READY-BYPASS` in [Anti-patterns](../docs/anti-patterns.md)).
- **Board status sync (built-in, after ready-for-review):** the In-Progress board move is now performed automatically as a deterministic tail of `ready-for-review.mjs` — marking the PR ready couples the board move to the ready transition (#1069), so no separate `sync-item-status` step is needed. It stays best-effort and NON-FATAL: it uses local `gh` auth (no CI/PAT), exits 0 when the board is not configured / the item is not on the board / the API fails, and never blocks marking the PR ready.
- **Non-substitution rule:** a clean `draft_gate` comment only authorizes the draft → ready-for-review transition for that head SHA; cross-gate non-substitution is owned by `GATE-COMMENT-NON-SUBSTITUTION` in [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This skill does not restate that rule.
- **Required PR comment:** post a visible checkpoint verdict comment using the mandatory [Gate comment command](#mandatory-gate-comment-command-contract). Comment field content and validation-reporting format are owned by `GATE-COMMENT-VALIDATION-REPORTING`; the draft-boundary comment requirement is owned by `GATE-COMMENT-DRAFT-REQUIREMENTS`; posting-failure fail-closed behavior is owned by `GATE-COMMENT-FAIL-CLOSED` — all in [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This skill does not restate those field/format/fail-closed rules.

### Pre-approval gate contract

This is the default pre-approval gate for this workflow boundary. The canonical checkpoint verdict comment contract is [Gate Review Comment Contract](../docs/gate-review-comment-contract.md). This section summarizes the procedural integration only.

- **Gate name:** Pre-approval gate
- **Trigger / boundary:** right before calling a PR/branch review-complete, approval-ready, merge-ready, or ready for final handoff
- **Execution directive:** run the [Gate fan-out/fan-in procedure](#gate-fan-outfan-in-procedure-agent-orchestrated) (the agent-orchestrated chain defined in [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md)) with the pre-approval gate inspection angles resolved from config. The `acceptance-criteria` angle is mandatory for this gate (see `.devloops` `gates.preApproval.angles` — the `acceptance-criteria` entry sets `mandatory: true`) and always survives dynamic resolution. Retry rule: in subsequent cycles, [Phase 1.2](../docs/gate-review-sub-loop-contract.md#angle-carry-forward-fail-closed) decides what re-runs.
- **Review angles:** resolved at runtime from config via `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config`. Default config enables all configured pre-approval gate angle families; consumer repos may opt out individual angles by setting `enabled: false` on that angle's entry.
- **Persona mapping:** each angle resolves to a reviewer persona via `resolveReviewerRole(config, angle)` from `@dev-loops/core/config`. Include this prompt in each reviewer's briefing so the reviewer knows exactly what to look for.
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

`mergeStateStatus: CLEAN` alone is not enough to resume approval or merge claims. Every [merge-ready precondition](../docs/merge-preconditions.md#required-before-merge) still applies.

### Merge-ready preconditions

See [Merge Preconditions](../docs/merge-preconditions.md). Verify: zero unresolved threads (via `dev-loops-run cli/index.mjs gate capture-threads`), visible clean `draft_gate` + current-head `pre_approval_gate`, green CI. Fresh-context review follows [Gate Review Sub-Loop Contract](../docs/gate-review-sub-loop-contract.md).

### Human approval checkpoint

After merge-ready preconditions pass, verify [Merge Preconditions](../docs/merge-preconditions.md) authoritatively before reporting merge-ready. Stop at the human approval checkpoint by default. Cross-check via `dev-loops-run cli/index.mjs gate capture-threads` (not prose assertion).
Follow [Merge Preconditions](../docs/merge-preconditions.md): stop at `waiting_for_merge_authorization` after approval unless merge explicitly authorized. When authorized, merge through the sanctioned wrapper `dev-loops-run scripts/github/merge-pr.mjs --repo <owner/name> --pr <number> --human-approved-by <login>` — it runs the full pre-merge precondition set fail-closed before merging; a raw `gh pr merge` is forbidden.

When `approval.enabled` is set, don't just park silently at this stop: run `dev-loops-run cli/index.mjs gate offer-human-handoff --repo <owner/name> --pr <number>` to surface candidate reviewers/assignees, then **offer** them to the operator. Only on operator confirmation, route the PR with `--assign <login>` / `--request-review <login>`. This is OFFER-only — never auto-assign. See the `approval` section in [Merge Preconditions](../docs/merge-preconditions.md); it pairs with `autonomy.humanMergeOnly`.

### Mechanical pre-merge gate evidence check

The sanctioned merge wrapper is the canonical merge path and runs this check
internally, fail-closed, before it merges:

```sh
node <resolved-skill-scripts>/github/merge-pr.mjs \
  --repo <owner/name> \
  --pr <number> \
  --human-approved-by <login>
```

The wrapper reuses `detect-checkpoint-evidence.mjs` (always-on: it reads both verdict
surfaces — the PR review stream, primary per `GATE-COMMENT-SINGLE-SURFACE`, and visible
PR issue comments for legacy/fallback verdicts — and fails closed unless both required
gate verdicts are visible: a clean `draft_gate` and a clean current-head
`pre_approval_gate`). You may also run `detect-checkpoint-evidence.mjs --repo <owner/name>
--pr <number>` standalone for a read-only pre-merge check. Resolved threads, green CI,
clean Copilot rereview, or local notes never substitute for the wrapper's fail-closed
verdict. A raw `gh pr merge` is forbidden (`RAW-GH-PR-MERGE-BYPASS`); if a final approval
or merge boundary sees a raw `gh pr merge`, treat that as a workflow violation and stop.

### Stale runner-coordination lock held by a completed run

The pre-merge check fails closed on `.pi/runner-coordination/<owner>/<name>/pr-<n>.json`:
a competing new run receives `ownership_lost`, or `stale_runner` after max age.
The auto-loop releases its own claim best-effort at terminal stops (clean-converged,
blocked, done, including human approval); release never blocks stopping or clears
an active competitor's claim. The headless driver also releases claims still owned
by its run when the process exits.

`copilot-pr-handoff` uses `supersedeStale: true` to take over only confirmed-dead
(recorded exit signal) or max-age-expired claims. A genuinely live owner still blocks.
Before standing down or deciding dispatch, verify actual execution with the harness's
`subagent status`: LIVE means an actively updating `EXECUTING` workflow child.
A fresh claim heartbeat alone is insufficient; a completed/control run may have left it.

Manual takeover remains for older leaks or an unreleasable edge:

If a stale claim still blocks the merge because the completing run could not release (crash, killed process, or a pre-#1109 run), the sanctioned recovery for a lock held by a COMPLETED run is an explicit takeover by the merge run:

```sh
node <resolved-skill-scripts>/loop/pr-runner-coordination.mjs takeover \
  --repo <owner/name> --pr <number>
```

`takeover` seizes ownership for the current run id and records the displaced run under `previousRun`. Only take over when the prior owner is genuinely completed/dead. A genuinely active (non-stale) run must still be allowed to block — do not take over to race a live run.

### Mandatory post-merge retrospective checkpoint write

After merge (or an authorized retrospective skip), write the durable checkpoint before
exiting. Under `RETRO-FRESH-CONTEXT-MANDATORY` in [Retrospective Checkpoint Contract](../docs/retrospective-checkpoint-contract.md),
the retrospective MUST be an independent fresh-context pass over the cycle's full
agent/subagent tool-call record, dispatched like a gate reviewer, never self-authored inline.
Both `complete` and `skipped` MUST carry this cycle's `--repo`, `--pr` and full
`--merge-commit` oid (obtain it with `node <resolved-skill-scripts>/github/view-pr.mjs --repo <owner/name> --pr <n> --json mergeCommit --jq .pr.mergeCommit.oid`).
The next loop checks that identity against base-branch ancestry; absent identity is
unverifiable/stale. `complete` also MUST carry fresh-context provenance; the CLI rejects
`inline` and identity-less complete/skipped records:

```sh
node <resolved-skill-scripts>/loop/checkpoint-contract.mjs --state complete --notes "<one-line retrospective summary>" \
  --retro-context fresh --record-source <path to the seeded agent/subagent tool-call record> \
  --repo <owner/name> --pr <number> --merge-commit <full merge commit oid>
```

For an explicit skip:

```sh
node <resolved-skill-scripts>/loop/checkpoint-contract.mjs --state skipped --reason "<why retrospective is skipped>" \
  --repo <owner/name> --pr <number> --merge-commit <full merge commit oid>
```

Do not report completion or advance to the next PR queue item until `.pi/dev-loop-retrospective-checkpoint.json` is updated to `complete` or `skipped` carrying this cycle's identity.

### Post-merge board sync (best-effort)

After the retrospective checkpoint write, run the post-merge board sync and archive as standard steps of the post-merge hook (see [Merge Preconditions](../docs/merge-preconditions.md) "Post-merge"):

```sh
dev-loops-run cli/index.mjs queue sync-status --repo <owner/name> --pr <number> --item <linked-issue> --logical-column done || true
node <resolved-skill-scripts>/projects/archive-done-items.mjs --repo <owner/name> || true
```

Run from the main checkout before worktree removal: `queue sync-status` resolves
`.devloops` from cwd and has no `--repo-root`. `queue.statusColumns` maps `done` to
the configured column; omit `--item` for a PR queue item (empty also falls back to `--pr`).
Board/archive settings are `tracker.board` and `queue.archiveOlderThanDays` (default 7d),
using local `gh` auth, no CI/cron/PAT. Both steps are best-effort and NON-FATAL; retain
both `|| true` guards. Sync reports board/API skips in JSON with exit 0; usage errors
exit 1, invalid `--jq` exits 2 and falsy `--silent` is non-zero. Archive exits 1 for
usage, 2 for API/`--jq` errors and 3 for project-not-found. Neither failure blocks
merge or retrospective.

`dev-loops-run cli/index.mjs queue reconcile` (idempotent, run best-effort at loop startup) is the fallback convergence path when the sync above is ever skipped or missed — it re-derives every item's column from live GitHub state, so a merge that could not run this hook still lands on Done at the next startup.

The post-merge hook also fast-forwards the main checkout's local `main` to `origin/main` (#1596) so read-only gate scripts run current code; see [Merge Preconditions](../docs/merge-preconditions.md) "Post-merge" for the canonical step. Best-effort and non-blocking (`--ff-only` refuses a diverged main without rewriting history).

## Validation policy

Follow [Validation Policy](../docs/validation-policy.md). Default: `bun run verify` before PR creation, gate entry, and merge. For repo-local examples: `bun run test:dev-loop` for skill scripts, contract tests for templates, `git diff --check` for docs. When CI runs exist, use `gh run watch` or `detect-copilot-loop-state.mjs` instead of `sleep`-based polling. Distinguish: locally validated, full PR-equivalent checks, awaiting CI.

## Confirmation checkpoints

See [Confirmation Rules](../docs/confirmation-rules.md). Stop and ask before GitHub mutations (edits, assignments, labels, comments, reviews, thread resolution, commits, pushes, merges, workflows) unless explicitly authorized.

## Stop conditions

Follow [Stop Conditions](../docs/stop-conditions.md). Genuine stops: `blocked` state, `done`, `approval_ready` without merge auth, ambiguous state, scope drift. Non-stops: `waiting` watcher states, quiet observations.

## Anti-patterns

Follow [Anti-patterns](../docs/anti-patterns.md) and this skill's request, wait,
reply/resolve, gate-comment and merge boundaries. A conflicted PR never authorizes a
blind `gh pr merge`, `gh pr update-branch` or unapproved rebase.

## Output expectations

Report the inspected issue/PR, current state, next recommended action and any required
authorization concisely.
