---
name: "copilot-pr-followup"
description: "Internal routed strategy behind `dev-loop` for GitHub-first Copilot-owned PR follow-up: inspect the canonical PR state, request or re-request Copilot when appropriate, wait deterministically for new review activity, run narrow Pi fix/reply/resolve passes, verify gate evidence, and stop for explicit human approval before merge."
allowed-tools: Read Bash Edit Write Agent
user-invocable: false
---
<!-- GENERATED from skills/copilot-pr-followup/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# Copilot PR Follow-up

This skill is the canonical internal `copilot_pr_followup` route behind the public `dev-loop` façade.

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

> Under the Claude Code harness, run this loop **inline in a single agent**: the helper-owned wait tools (`dev-loops loop watch-cycle`, `gh run watch`, `dev-loops gate probe-copilot`) block inline and return — when `cycleDisposition` is `pending` and `terminal` is `false`, run the next watch cycle yourself. Do not exit on the wait boundary or dispatch a separate subagent; keep looping until a terminal state or the watch budget expires.

Max watch timeout: **30 minutes** (from `policy-constants.mjs` COPILOT_REVIEW_WAIT_TIMEOUT_MS); expired budget + still `waiting_for_copilot_review` = hard stop. If the user explicitly asks for async handoff-only behavior, say that out loud and stop after the handoff boundary.

**4. Low-level helpers**
```sh
node <resolved-skill-scripts>/github/request-copilot-review.mjs --help
node <resolved-skill-scripts>/github/probe-copilot-review.mjs --help
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
- if the skill is installed as a normalized standalone copy, the required bundled contract docs live under the shared `../docs/` directory next to the installed skill directories; do not assume helper scripts are bundled unless that installed layout actually contains them
- if you are working in the `dev-loops` source repository, this skill file lives under `skills/copilot-pr-followup/`, so source-repo helper scripts live two levels up at `../../scripts/`, while required bundled contract docs live one level up at `../docs/`
- when in doubt, resolve helper paths relative to this [skill file](./SKILL.md) first, then verify the target file exists before running it

Required bundled runtime contract docs for installed copies of this skill:
- [Public Dev Loop Contract](../docs/public-dev-loop-contract.md)
- [Retrospective Checkpoint Contract](../docs/retrospective-checkpoint-contract.md)
- [Issue Intake Procedure](../docs/issue-intake-procedure.md)
- [Copilot Loop Operations](../docs/copilot-loop-operations.md)

Read those bundled `../docs/` files from the installed skill layout instead of assuming the source repository checkout is present. If any required bundled contract doc is missing from the installed skill layout, treat that as a packaging/installer bug.
Do not assume `scripts/...` is repo-local to the target codebase you are operating on.

## Authority and safety rules

Source code, tests, CI, and config are authoritative. Generated wiki is navigation aid only. See [Confirmation Rules](../docs/confirmation-rules.md), [Stop Conditions](../docs/stop-conditions.md), and [Merge Preconditions](../docs/merge-preconditions.md) for authorization boundaries.

## Structural quality

Apply [Structural Quality](../docs/structural-quality.md) standards from the `deep` review angle during implementation and follow-up fixes.

## Step 5: PR discovery and interpretation

Treat the PR as the main working artifact once it exists.

Inspect: PR body/title (must satisfy [PR description contract](../docs/copilot-loop-operations.md)), closing reference (operator-controlled; subagents must NOT modify), author, review summaries, unresolved comments, latest commits, CI results.

At the issue-assignment seam, use `detect-initial-copilot-pr-state.mjs` and keep waiting when `waiting_for_initial_copilot_implementation`.

When confirming whether Copilot is requested as a reviewer, do not rely solely on `gh pr view --json reviewRequests`. Use `request-copilot-review.mjs` (see [Operational cookbook](#operational-cookbook)). Do **not** request Copilot by posting literal `/copilot` or `/copilot re-review` PR comments. After draft→ready or fix push, explicitly decide whether another pass is desired; if yes, ensure green/credibly green posture first.

Branch on the `request-copilot-review.mjs` machine-readable result:
- `requested`: if another Copilot pass is actually desired, immediately re-baseline with `detect-copilot-loop-state.mjs` and follow its `nextAction` (enter persistent wait only through `dev-loops loop watch-cycle` or `gh run watch`)
- `already-requested`: apply the same detector-first rebasing and wait branching as `requested`
- `suppressed_same_head_clean`: report clean-converged state and stop unless `--force-rerequest-review` bypass is intentionally authorized
- `unavailable`: report the limitation and stop
- non-zero / unexpected failure: stop and report error

Do not treat an attempted request as equivalent to a confirmed request.

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

Do not skip this guard when resuming work on the same PR (under Pi, between async subagent runs).
The outer-loop checkpoint is the canonical re-attachment artifact.

## Step 6: Async watch behavior

Start every wait seam with a detector refresh: `detect-copilot-loop-state.mjs --repo <owner/name> --pr <number>`.

Allowed wait tools: `detect-copilot-loop-state.mjs` (one-shot), `dev-loops loop watch-cycle` (persistent), `copilot-pr-handoff.mjs --watch-status` (refresh after timeout/idle), `gh run watch <run-id> --repo <owner/name>` (CI with known run id). Otherwise exit and resume later from fresh detector call.

Practical rules: do not poll manually. `waiting_for_copilot_review` → `run-watch-cycle.mjs` or report-and-resume. `waiting_for_ci` with pending/none CI → `gh run watch <run-id> --repo <owner/name>` (known run id) or report-and-resume. Bounded CI exception: zero current-head suites + previous-head green + local `npm run verify` passed → rerun detector with `--local-validation-head-sha` for `crediblyGreen` promotion. `ciStatus=failure` → stop/fix, never wait.

Preferred approach:
- route decisions through `copilot-pr-handoff.mjs` output; enter watcher only on `action: "watch"` with `watchEntryConfirmed=true`; prefer `dev-loops loop watch-cycle` for deterministic handoff → watch
- `changed` → re-enter Step 7 fix/reply-resolve/validate immediately; do not stop after one watch cycle
- `timeout`/`idle` → re-run `copilot-pr-handoff.mjs --watch-status <status>` once to refresh state; if still `waiting_for_copilot_review` after 30-minute watch budget exhausted, hard stop with `watch timeout — PR #<number> needs manual attention`
- zero-timeout `idle` probes are for explicit one-shot status/reattach checks only; they are not the normal async wait mechanism
- after a successful fix / reply-resolve / re-request cycle, returning to `waiting_for_copilot_review` is a persistence boundary: resume the watcher instead of reporting completion
- dispatch fix findings to the `fixer` agent; do not run inline fix passes in-watcher
- do not report completion while unresolved Copilot feedback remains

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
8. when a comment or thread is actually addressed, reply on GitHub with a short resolution note that references the resolving commit SHA or commit URL when applicable
   - for one thread, must use the deterministic helper `reply-resolve-review-thread.mjs` from the resolved skill scripts directory
   - when the same bounded resolution note applies to multiple matching unresolved threads, use `reply-resolve-review-threads.mjs` instead of ad hoc inline `gh api` / `gh api graphql` mutations
   - when using the single-thread helper, pair `--comment-id` and `--thread-id` from the same fresh PR thread snapshot rather than mixing ids across review rounds
   - use a body file under `tmp/` rather than inline shell text for the single-thread reply body; for the batch helper, prefer stdin from that same `tmp/` body file rather than inline shell text
   - when the intent is GitHub linkability, keep commit SHAs and issue/PR refs as plain text (for example 3ee82fc and owner/repo#70) and do not wrap them in backticks
   - keep backticks for actual code/path/CLI literals only
   - if either helper was newly added or recently changed, smoke-check it against one real thread before assuming the rest of the loop can rely on it
9. before resolving an addressed review thread, run a post-fix verification checkpoint
   - confirm the GitHub reply actually exists on the intended thread/comment, not only in local notes or helper stdout
   - confirm the pushed current-head diff genuinely addresses the reviewer concern on the flagged lines or pattern; if the concern is only partially addressed, leave the thread open and explain what remains
   - refresh the API-backed thread snapshot via `dev-loops gate capture-threads` and use that refreshed data — including the unresolved thread count — for follow-up decisions rather than prose assumptions
   - if any verification check fails, do **not** resolve the thread; leave it open, add a short explanation when needed, and re-enter the fix/reply loop
10. resolve the addressed review thread only after the reply is attached successfully, the verification checkpoint passes, and the concern is genuinely addressed
    - do not stop at a local fix if GitHub-side reply/resolve is authorized
11. after completing reply/resolve for a pass, verify zero unresolved threads remain via `dev-loops gate capture-threads` before proceeding
    - if the refreshed snapshot reports unresolved threads, re-enter the reply/resolve loop for the missed threads
12. only after GitHub-side reply/resolve work is done for the addressed threads and the refreshed thread snapshot proves zero unresolved threads remain, decide whether another Copilot pass is desired
    - resolve the review-round cap from config via `resolveRefinementConfig(config, "maxCopilotRounds")` from `@dev-loops/core/config`; default config ships `maxCopilotRounds: 5`
    - **Opt out entirely:** `maxCopilotRounds: 0` disables the external Copilot review gate for the repo — the loop runs `draft_gate → pre_approval_gate` with the local harness only, never requesting or waiting on Copilot. Use this when the repo has no Copilot reviewer configured or prefers local-harness-only review.
    - use the completed Copilot review-round count from `detect-copilot-loop-state.mjs` / `copilot-pr-handoff.mjs` as the current PR's review-round count
    - if completed review rounds have reached the maximum (default: 5), do **not** re-request Copilot review
    - when the round limit is reached **and** the refreshed thread snapshot proves zero unresolved threads **and** current-head CI is green or credibly green, treat that clean state as eligible for `pre_approval_gate` fallback instead of deadlocking on another Copilot rerequest
    - when using that fallback, add a short round-exhaustion note to the visible `pre_approval_gate` gate evidence so the PR records why no further Copilot rerequest occurred
    - if the round cap is reached before the PR is thread-clean or before CI is green/credibly green, reply-resolve any remaining intentionally deferred threads with a short `deferred to follow-up` note, then stop and report that the Copilot round limit was reached
    - **Signal-gated re-request suppression:** the `detect-copilot-loop-state.mjs` state machine classifies review-thread comments by signal level (High/Mid/Low). High-signal (bugs, security, contract violations) always re-requests; Low-signal (cosmetic nits) never re-requests. When low-signal detection is enabled and thresholds are met, the machine returns a low-signal-converged terminal state routing to `pre_approval_gate` without further re-requests. See [Copilot Loop Operations](../docs/copilot-loop-operations.md) for full signal-level semantics.
    - if that local validation is still known red, continue remediation instead of re-requesting Copilot
    - after a fix push advances the PR head SHA, re-run `detect-copilot-loop-state.mjs` for the new head and apply the [Copilot CI Status Contract](../docs/copilot-ci-status-contract.md). Previous-head CI is stale; only current-head results unblock CI-dependent steps. if GitHub CI/checks for the updated head are known red for a fixable issue, continue remediation instead of re-requesting Copilot. only once the updated head is green or credibly green, explicitly re-request Copilot review for the new head. Always use `request-copilot-review.mjs` — never `gh api POST repos/.../requested_reviewers` directly.
    - only enter a wait/watch loop if the request result is confirmed as `requested` or `already-requested`
    - for `requested` / `already-requested`, immediately re-baseline with `detect-copilot-loop-state.mjs`; if the returned state is `waiting_for_copilot_review`, use `dev-loops loop watch-cycle` or stop/resume later, and if the returned state is `waiting_for_ci`, use `gh run watch` for a known run id or stop/resume later after that single detector refresh
    - if the request result is `unavailable`, report that limitation and stop unless the user explicitly wants passive waiting anyway
    - if the request command fails unexpectedly, stop and report the error rather than sleeping and hoping for a new review
13. after a confirmed re-requested Copilot pass, refresh PR thread state again before reporting completion; if fresh Copilot threads exist, return to this follow-up loop rather than stopping at `review requested`
14. after a confirmed re-request returns the PR to `waiting_for_copilot_review`, jump back to Step 6 and keep the same session alive; do not exit on `review requested` alone
15. if scope has broadened, stop and ask before continuing

Do not treat `fix applied locally` as the end of the loop when the workflow also requires GitHub-side reviewer follow-up. If comment/reply authorization is withheld, report explicitly that the code may be fixed while the PR conversation state remains unresolved.

### Mandatory gate-comment command contract

For every `draft_gate` or `pre_approval_gate` comment, you MUST run:

```sh
node <resolved-skill-scripts>/github/upsert-checkpoint-verdict.mjs \
  --repo <owner/name> \
  --pr <number> \
  --gate <draft_gate|pre_approval_gate> \
  --head-sha <current_head_sha> \
  --verdict <clean|findings_present|blocked> \
  --findings-summary "<summary>" \
  --next-action "<next action>" --findings-severity-counts '{"must-fix":0,"worth-fixing-now":0,"defer":0}'
```

Do NOT use `gh pr comment`, `gh api`, or `gh pr review` for gate comments.

`--force --force-reason` on `upsert-checkpoint-verdict.mjs` is a narrow operator-authorized CI override for the helper itself, not the default gate path. Use it only when the helper refuses gate entry solely because the current head is `blocked_needs_user_decision` with `ciStatus="failure"`, and only after the user explicitly authorizes ignoring that current-head CI failure for this one gate-comment upsert. It does **not** bypass stale-head checks, unresolved-thread / unsettled-review refusal, non-draft `draft_gate` refusal, merge conflicts, or other legality checks.

### Draft gate contract (before marking PR ready for review)

The canonical checkpoint verdict comment contract is [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md). This section summarizes the procedural integration only.

- **Gate name:** Draft gate
- **Trigger / boundary:** right before running `gh pr ready` (draft → ready for review)
- **Skip rule:** before entering the draft gate, run `detect-pr-gate-coordination-state.mjs` and check `draftGateAlreadySatisfied`. If `true`, skip the draft gate entirely — the draft→ready transition was already recorded. `draft_gate` is a one-time gate; do not re-post on new heads once clean draft-gate evidence exists for the transition record. (While the PR is still draft, advancing the head SHA does require a new draft-gate comment for the new head.) This skip rule applies only to the draft boundary.
- **Execution directive:** run the checkpoint review chain defined in [Gate Review Sub-Loop Contract](../../docs/gate-review-sub-loop-contract.md) with the draft gate inspection angles resolved from config.
- **Review angles:** resolved at runtime from config via `resolveGateAngles(config, "draft")` from `@dev-loops/core/config`. Default config enables all configured draft gate angle families; consumer repos may opt out individual angles via `excludeAngles`. Do **not** apply angles from the other gate; each gate owns its own angle list from config.
- **CI prerequisite:** resolve the draft gate config first (`resolveGateConfig(config, "draft")`). When `requireCi=true` (default), wait for green current-head CI before entering `draft_gate`. When `requireCi=false`, the draft gate may proceed without green CI. This draft-only override does **not** relax `pre_approval_gate`; final approval and merge readiness still require green current-head CI.
- **Pass criteria:** all configured draft gate angles pass; all findings at severities in `blockCleanOnFindingSeverities` are addressed; validation passes; no unrelated files are included.
- **Next step after passing:** mark the PR ready for review.
- **Non-substitution rule:** a clean `draft_gate` comment only authorizes the draft → ready-for-review transition for that head SHA. It does **not** satisfy `pre_approval_gate`, final-approval readiness, or merge-ready requirements.
- **Required PR comment:** post a visible checkpoint verdict comment using the mandatory [Gate comment command](#mandatory-gate-comment-command-contract). Keep validation reporting concise: include command names with pass/fail status. Do **not** paste raw passing test output into the visible gate comment. If you include a failing validation excerpt, keep it focused and truncate it to a deterministic retained-prefix length before posting the comment. See [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md). Do not run `gh pr ready` unless a visible `clean` `draft_gate` checkpoint verdict comment exists for the current head SHA. A checkpoint verdict comment for an older head SHA does not satisfy this requirement for the current head. If findings exist, the PR stays draft and needs fixes before retry. If fixes advance the head SHA while still draft, post a new checkpoint verdict comment for the new head. If the checkpoint verdict comment cannot be posted, fail closed and do not run `gh pr ready`.

### Pre-approval gate contract

This is the default pre-approval gate for this workflow boundary. The canonical checkpoint verdict comment contract is [Gate Review Comment Contract](../../docs/gate-review-comment-contract.md). This section summarizes the procedural integration only.

- **Gate name:** Pre-approval gate
- **Trigger / boundary:** right before calling a PR/branch review-complete, approval-ready, merge-ready, or ready for final handoff
- **Execution directive:** run the checkpoint review chain defined in [Gate Review Sub-Loop Contract](../../docs/gate-review-sub-loop-contract.md) with the pre-approval gate inspection angles resolved from config. Retry rule: in subsequent cycles, only re-run reviewers that produced `findings_present` in the previous pass.
- **Review angles:** resolved at runtime from config via `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config`. Default config enables all configured pre-approval gate angle families; consumer repos may opt out individual angles via `excludeAngles`.
- **Persona mapping:** each angle resolves to a reviewer persona via `resolveReviewerRole(config, angle)` from `@dev-loops/core/config`. Include this prompt in each reviewer's briefing so the reviewer knows exactly what to look for.
- **Pass criteria:** the sub-loop completes with verdict `clean`; all configured angles pass; if parallel execution is impractical, still run all configured lenses and explicitly record the limitation.
- **Acceptance criteria verification:** follow the canonical procedure in [Acceptance Criteria Verification](../docs/acceptance-criteria-verification.md) before posting the `pre_approval_gate` comment.
- **Next step after passing:** continue the Step 7 flow and then proceed to the human approval checkpoint below.
- **Non-substitution rule:** a clean `pre_approval_gate` comment is separate from `draft_gate` evidence. It governs final-approval readiness for that head SHA; it does **not** replace the required `draft_gate` evidence for leaving draft.
- **Required PR comment:** post a visible checkpoint verdict comment using the mandatory [Gate comment command](#mandatory-gate-comment-command-contract). Keep validation reporting concise: include command names with pass/fail status. Do **not** paste raw passing test output into the visible gate comment. If you include a failing validation excerpt, keep it focused and truncate it to a deterministic retained-prefix length before posting the comment. Do not declare final-approval readiness unless a visible `clean` `pre_approval_gate` checkpoint verdict comment exists for the current head SHA. Final-approval readiness must not rely only on local or hidden artifacts; the visible PR comment is the required auditable evidence. If the checkpoint verdict comment cannot be posted, fail closed and do not declare final-approval readiness. A checkpoint verdict comment for an older head SHA does not satisfy this requirement for the current head. If findings exist, follow-up fixes are required before final approval. The `pre_approval_gate` procedure must be entered and completed (visible comment posted) before any merge-ready or approval-ready declaration. Skipping the gate is not recoverable by asserting convergence. If fixes advance the head SHA, post a new checkpoint verdict comment for the new head.

### Conflict-resolution gate

Before any merge-ready or final-approval claim, run `detect-pr-gate-coordination-state.mjs` for the current PR. If it reports `gateBoundary=conflict_resolution` or `mergeStateStatus` is conflicted, stop the normal gate path immediately and use this recovery flow:

1. fetch fresh `origin/main`, confirm the current PR head SHA, and summarize the conflict scope from `mergeStateStatus` plus any reported `conflictFiles`
2. ask for explicit authorization before any rebase or other branch-state-changing reconciliation command
3. after authorization, reconcile locally on the PR branch; default to rebase onto latest `origin/main`, unless the operator explicitly chooses another conflict-resolution command
4. auto-resolve simple conflicts when the correct fix is mechanical and clearly in scope; report complex conflicts explicitly and fix them manually only for in-scope files
5. rerun the smallest honest local validation for the touched conflict slice
6. rerun `detect-pr-gate-coordination-state.mjs` for the new head
7. because the head changed, rerun `pre_approval_gate` for the new head before any approval-ready or merge-ready claim
8. wait for current-head CI again before retrying merge evaluation
9. if the chosen reconciliation rewrote branch history (for example rebase), ask for explicit authorization before `git push --force-with-lease`, then continue the loop on the updated head

`mergeStateStatus: CLEAN` alone is not enough to resume approval or merge claims. The existing merge-ready preconditions still apply: zero unresolved review threads, a clean current-head `pre_approval_gate`, and green current-head CI.

### Merge-ready preconditions

See [Merge Preconditions](../docs/merge-preconditions.md). Verify: zero unresolved threads (via `dev-loops gate capture-threads`), visible clean `draft_gate` + current-head `pre_approval_gate`, green CI. Fresh-context review follows [Gate Review Sub-Loop Contract](../../docs/gate-review-sub-loop-contract.md).

### Human approval checkpoint

After merge-ready preconditions pass, verify [Merge Preconditions](../docs/merge-preconditions.md) authoritatively before reporting merge-ready. Stop at the human approval checkpoint by default. Cross-check via `dev-loops gate capture-threads` (not prose assertion).
Follow [Merge Preconditions](../docs/merge-preconditions.md): stop at `waiting_for_merge_authorization` after approval unless merge explicitly authorized. Run pre-merge gate evidence check before any `gh pr merge`.

### Mechanical pre-merge gate evidence check

Immediately before any `gh pr merge`, run:

```sh
node <resolved-skill-scripts>/github/detect-checkpoint-evidence.mjs \
  --repo <owner/name> \
  --pr <number>
```

This helper is always-on: it uses `gh api` to fetch visible PR issue comments and fails closed unless both required gate comments exist: a clean `draft_gate` comment for the one-time draft boundary and a clean current-head `pre_approval_gate` comment. Do not run `gh pr merge` if this command exits non-zero. There is no opt-out flag. Resolved threads, green CI, clean Copilot rereview, or local notes do not substitute for this successful helper output. If a final approval or merge boundary sees `gh pr merge` without a same-boundary successful check, treat that as a workflow violation and stop.

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

## Validation policy

Follow [Validation Policy](../docs/validation-policy.md). Default: `npm run verify` before PR creation, gate entry, and merge. For repo-local examples: `npm run test:dev-loop` for skill scripts, contract tests for templates, `git diff --check` for docs. When CI runs exist, use `gh run watch` or `detect-copilot-loop-state.mjs` instead of `sleep`-based polling. Distinguish: locally validated, full PR-equivalent checks, awaiting CI.

## Confirmation checkpoints

See [Confirmation Rules](../docs/confirmation-rules.md). Stop and ask before GitHub mutations (edits, assignments, labels, comments, reviews, thread resolution, commits, pushes, merges, workflows) unless explicitly authorized.

## Stop conditions

Follow [Stop Conditions](../docs/stop-conditions.md). Genuine stops: `blocked` state, `done`, `approval_ready` without merge auth, ambiguous state, scope drift. Non-stops: `waiting` watcher states, quiet observations.

## Anti-patterns

See [Anti-patterns](../docs/anti-patterns.md). Key repo-specific additions:
- Use `reply-resolve-review-thread.mjs` / `reply-resolve-review-threads.mjs` helpers instead of ad hoc `gh api`/`gh api graphql` thread-mutation commands. Do NOT use `gh pr comment`, `gh api`, or `gh pr review` for gate comments (use `upsert-checkpoint-verdict.mjs`).
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
