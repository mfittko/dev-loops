# Merge preconditions

Canonical owner for merge preconditions across all workflow families.

## Conflict-free (mergeable) is a precondition at every gate

A PR that conflicts with its base gets **no `pull_request` CI run**, so the gate would
stall. Conflict-free is therefore a required gate precondition, checked at **two seams**:
before requesting CI/Copilot, and again before merge.

- The PR's `mergeable` / `mergeStateStatus` drive it. A `CONFLICTING` /
  `DIRTY` / `BEHIND` PR does **not** pass any gate (`gateBoundary:
  conflict_resolution`, `nextAction: resolve_merge_conflicts`).
- A freshly-pushed head briefly reads `UNKNOWN`. The detect layer **re-polls a bounded
  number of times**; if it never settles, the gate **fails closed to a recheck**
  (`nextAction: wait_for_ci`). An unsettled merge state is never treated as clean.
- `loop info` surfaces a **Mergeable:** line (mergeStateStatus included). It also
  reads the repository rulesets for the base branch (classic branch protection
  required checks are not read). A required check with no entry at the head
  renders a `Required checks:` line, and green observed CI never reads as success
  beside it. Only the latest run of each required check counts, so a superseded
  run never reads as failed. A `BLOCKED` merge state never renders as
  mergeable: it names the missing, pending, or failed required checks and
  ruleset approvals it knows, and each approval also renders as an
  `Operator blocker:` line. The covered `pull_request` approval parameters are
  `required_approving_review_count`, `require_code_owner_review`,
  `require_last_push_approval`, and
  `require_extra_approval_for_unattributed_changes`; the first three are
  omitted when the PR `reviewDecision` is `APPROVED`. A failed rules lookup
  renders `INCOMPLETE` instead of a mergeable claim.
  `loop info --pr <n> --json` carries the same projection as a top-level
  `branchRules` object with keys `resolved`, `missingRequiredChecks`,
  `pendingRequiredChecks`, `failedRequiredChecks`, and `operatorApprovals`; it
  is `null` for a PR that is not `OPEN`.

### Deterministic auto-resolve (additive CHANGELOG only)

When a PR is behind/`CONFLICTING`, run the conservative resolver before resuming
the gate path:

```sh
node scripts/loop/resolve-pr-conflicts.mjs [--base <branch>] [--push]
```

It merges `origin/<base>` into the PR branch and resolves **only the safe additive
case**: a `CHANGELOG.md` conflict where both sides only ADD list/section entries
(keep BOTH sides, in order). It then runs `bun run test:docs` and (with `--push`)
pushes. **Any other conflicted path, or a non-additive CHANGELOG edit, FAILS
CLOSED** naming the conflicted paths; resolve those by hand.

## Required before merge

<!-- rule: MERGE-PRECOND-REQUIRED -->
Before merge, ALL of the following MUST hold:

1. ✅ Conflict-free with base (`mergeable: MERGEABLE`; not `CONFLICTING`/`DIRTY`/`BEHIND`/`UNKNOWN`)
2. ✅ CI green (`success`) on current head. The bounded zero-suite `crediblyGreen`
   exception never substitutes for this: `evaluatePrGateCoordination` fails it closed
   identically to a real CI failure at the pre-approval and final-approval boundaries
   (#552). It only extends the draft-gate wait until CI actually settles green.
3. ✅ Draft gate satisfied — clean `draft_gate` verdict per `GATE-COMMENT-VERDICT-VALUES` ([Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md))
4. ✅ Pre-approval gate satisfied — clean `pre_approval_gate` verdict on the current head, same rule
5. ✅ All review threads resolved
6. ✅ Merge authorization from the operator — explicit for the active scope, or a recorded standing authorization (see [Merge authorization](#merge-authorization))
7. ✅ Closing-reference state matches artifact backing, each arm owned by a different contract: tracker-backed work — PR body contains `Closes #N` or `Fixes #N` (owned by the PR description contract in [copilot-loop-operations.md](copilot-loop-operations.md)); issue-less lightweight (PR-body-as-spec, no backing issue) — the closing reference is absent by design and `node scripts/loop/validate-pr-body-spec.mjs --repo <owner/name> --pr <number> --no-issue` passes clean (owned by `ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS` in [Artifact Authority Contract](artifact-authority-contract.md)); plan-file promotion (P4) — the PR body carries the committed plan-doc path as the spec-of-record and, being issue-less by design (`buildPromotionPrBody` neutralizes closing keywords), the closing reference MUST NOT be present
8. ✅ PR **title** free of merge-blocking markers — see [Title markers](#title-markers) for the exact constructions that count
9. ✅ Size-budget human-approval requirement satisfied for an escalated/T1 PR — see [Size-budget merge gate](#size-budget-merge-gate-issue-1480)
10. ✅ Copilot convergence on the current head. `evaluateCopilotConvergence` reports one of three states. `current_head_clean`: the latest current-head Copilot review is `🟢 Approval recommended`, has no disposition header, or is `🔵 Needs a closer look`. A `🔵` is conductor-overridable. Item 5 still applies, so a `🔵` merges only with zero unresolved threads. `current_head_findings`: the latest current-head review is `🟡 Changes recommended` or has an unrecognized header, and the merge refuses fail-closed unless a trusted `copilot-body-disposition` record (`COPILOT-STATE-BODY-DISPOSITION-RECORD` in [Copilot Loop State Graph](copilot-loop-state-graph.md)) names that review for the current head. In both of these states the latest submitted Copilot review still decides: when it sits on an earlier commit (Copilot reviewed an older commit after the current head) and the carried-convergence predicate (`COPILOT-STATE-CARRIED-CONVERGENCE`, without its delta condition) does not find it converged, the merge refuses. `no_current_head_review`: no Copilot review exists on the current head. A review on an earlier head is stale and never counts as the current-head verdict. A Copilot error review (a headerless body that starts with `Copilot encountered an error`, disposition `review_error`) is no review. It never sets the latest review, the converged predicate, the round count or the current-head facts, so a head whose only Copilot reviews are error reviews reports `no_current_head_review` (ADR 0114). This state passes only through a disposition that `merge-pr` pins to the current head, in this order. `copilot_gate_disabled` applies first when the round cap is 0. `converged_once` applies in the default mode (`refinement.requireCopilotConvergenceAtLatestHead: false`) when the loop's carried-convergence predicate (`COPILOT-STATE-CARRIED-CONVERGENCE`) finds the latest Copilot review converged on an earlier head and no Copilot review is outstanding on the current head. The delta since that head is not checked; `pre_approval_gate` covers the current head (ADR 0090). `round_cap_clean_fallback` applies when the round cap is reached. It is refused when the last review converged and a significant change landed since. `docs_only_suppression` applies only with `refinement.requireCopilotConvergenceAtLatestHead: true`, when the same predicate carries the prior Copilot review across a docs-only or integrate-only delta, and no Copilot review is outstanding on the current head. `copilot_gate_disabled` also applies last when both the loop's detector and the `internalPathPatterns` that `merge-pr` loads classify the PR as internal-only. For a light-dispatched PR, pass `--lightweight` so `merge-pr` composes the lightweight round cap. The merge result records `copilotConvergenceState` and `copilotDisposition`, plus `copilotCarriedConvergence` (`{ source, sourceReviewId, sourceHeadSha, bodyDisposition }`, per `COPILOT-STATE-CARRIED-CONVERGENCE`) for `converged_once` and `docs_only_suppression`, and `copilotBodyDisposition` for a record-cleared current-head finding. A record clears a current-head finding only when it names the review that raised it. Pre-approval entry and merge read the current-head disposition through the same `evaluateCopilotConvergence` evaluator. Gate entry keeps its own absent-review handling.
11. ✅ Retrospective checkpoint (`retrospective_checkpoint`), only when `workflow.requireRetrospective` is `true`. The earlier qualifying merge MUST have a `complete` or `skipped` checkpoint. `merge-pr` calls the shared evaluator that startup also calls and refuses while it reports any `pendingRetrospectives` entry. The refusal names the PR number and full merge commit of each entry, or the reason code and recorded checkpoint state for an entry with no identity. With the flag unset or `false`, `merge-pr` reads no checkpoint file and adds no precondition entry. See [Retrospective checkpoint contract](retrospective-checkpoint-contract.md) and ADR 0125.
12. ✅ ADR tripwire (`adr_tripwire`), on every merge class. `merge-pr` fetches the PR head and evaluates the tripwire at `origin/<baseRefName>...<headRefOid>` against the current PR body. It refuses when the tripwire blocks, and fails closed when the tripwire cannot be evaluated. When the only cause is a stale standing-authorization waiver line (pinned to an older head, expired, or missing a current trigger from `paths=`), `merge-pr` re-issues the line through `waive-adr-tripwire` (which still runs every eligibility check), re-reads the body and re-evaluates. A writer refusal is quoted with its typed reason. See [Decision record contract](decision-record-contract.md) and ADR 0132.

> Runner-coordination lock: the pre-merge evidence check fails closed on a stale/foreign runner claim for the PR. A completing run releases its claim best-effort at every terminal stop: Copilot-loop terminal states (`loop handoff`, #1128) and gate-coordination terminal stops (`detect-pr-gate-coordination-state`: approval checkpoint / merge-ready / done / blocked, #1632). If a lock held by a completed/dead run still blocks the merge, take it over explicitly with `node <resolved-skill-scripts>/loop/pr-runner-coordination.mjs takeover --repo <owner/name> --pr <number>`. Never take over a genuinely active (non-stale) run.

> Stranded Copilot review request (human-only): Copilot never delivers a review requested on a head that already carries its own clean submitted review, so below the round cap the loop waits indefinitely and `pre_approval_gate` cannot post. At the cap the loop already routes to `round_cap_clean_fallback`. Withdraw the request explicitly with `node <resolved-skill-scripts>/github/withdraw-copilot-review-request.mjs --repo <owner/name> --pr <number> --reason <why>`. It is an exit-0 no-op when no request is pending, refuses unless Copilot has already submitted a review and no unresolved threads remain, and verifies the withdrawal; prefer it over a raw `gh pr edit --remove-reviewer`. It is deliberately NOT in the sanctioned-command set, and an agent must not invoke it.
>
> Head-advanced sibling case (issue 1441): the loop converged and the round's threads were reply-resolved on a NEW head, so `copilotReviewOnCurrentHead` is false. In the default mode the request tool already returns `suppressed_post_convergence` for a converged latest review. In strict mode (`refinement.requireCopilotConvergenceAtLatestHead: true`), or when the latest review has not converged, `withdraw-copilot-review-request.mjs` also covers this case, but only when the delta since Copilot's last SUBMITTED review is provably a pure doc/prose bump. It classifies the raw delta with `classifyDeltaSinceLastReview`, which is stricter than the base-relative `resolveConvergenceCarry`: an integrate-only base move still refuses here. Any code/test/config/CI or unclassifiable delta, a non-linear advance, or an unavailable compare also refuses. On success it records an operator-authorized suppression marker scoped to that exact head (`scripts/loop/_post-convergence-review-suppression.mjs`). `request-copilot-review.mjs` and the gate-coordination state (`detect-pr-gate-coordination-state.mjs`, `evaluatePrGateCoordination`'s `postConvergenceReviewSuppressed` input) honor that marker under the `COPILOT-STATE-CARRIED-CONVERGENCE` thread and delta checks in [Copilot Loop State Graph](copilot-loop-state-graph.md). Any further push invalidates the marker.

## Sanctioned merge wrapper (issue #1939)

The canonical agent-executed merge path is the sanctioned wrapper `scripts/github/merge-pr.mjs`
(`node scripts/github/merge-pr.mjs --repo <owner/name> --pr <n> --human-approved-by <login>`,
squash by default, `--method` configurable). It runs the full precondition list
above fail-closed and refuses with a non-zero, machine-readable reason naming the
failing precondition. Only when every precondition holds does it merge and return
`{ ok, merged, mergeCommit, approvedBy, mergeClass, approvalVia, ... }` under the standard
`--jq`/`--silent` base-CLI contract. It reuses `detect-checkpoint-evidence` for the
draft_gate / current-head pre_approval_gate / threads / runner-lock / fan-out-provenance set.

- The wrapper includes the `adr_tripwire` precondition: the ADR tripwire must pass at the PR head, and a stale head-pinned waiver is re-issued in-process through `waive-adr-tripwire`.
- Every merge passes `--human-approved-by <login>`, validated as a real GitHub login
  (not a bare boolean or free text) and stamped on the result and audit trail.
- **humanMergeOnly refuses the wrapper.** When `autonomy.humanMergeOnly` is set, merge is
  a human-only action: the wrapper refuses outright (the agent hands off, and does not run
  even the wrapper), regardless of any fresh approval.
- **Merge class.** A normal **drain** merge is satisfied by a recorded standing
  authorization OR a fresh operator approval. Config alone establishes no standing
  authorization (`autonomy.humanMergeOnly: false` authorizes nothing on its own): the
  orchestrator asserts a recorded standing authorization via `--standing-authorization`;
  absent that flag, a drain merge also requires a fresh operator approval. A
  **stable-release** (`--stable-release`), **size-escalated** (`gates.size` outcome
  `escalate`/`block`), or **T1-touching** merge is escalated: a standing
  authorization does NOT satisfy it — a fresh per-merge operator approval is required.
- **Head-pinned.** The merge mutation passes `--match-head-commit <headSha>`, so a push
  between the precondition reads and the merge fails closed. The gate-evidence head must
  also match the checked head, and CI-green excludes the separately-validated
  `gate-evidence` check.
- **Fresh per-merge approval** is verified against an agent-unforgeable, head-pinned
  record, in preference order: a genuine `APPROVED` review by `<login>` on the current
  head SHA (a Copilot/bot review never satisfies it), else a head-pinned operator comment
  marker `approve merge <headSha>` authored by `<login>`. No agent writes that marker:
  the comment wrappers (`comment-issue.mjs`, `edit-comment.mjs`) refuse any body line that
  opens with `approve merge` (`OPERATOR-OWNED-LINE`, no override). It fails closed on a stale
  (earlier-commit), agent/bot-authored, or wrong-login approval, and re-gates on every
  head bump.
- **Stable-release safety.** The wrapper only merges the PR to its base. It NEVER tags
  or publishes and does NOT satisfy the operator-owned stable-release approval gate;
  `--stable-release` only raises the approval requirement.
- Raw `gh pr merge` is forbidden — see `RAW-GH-PR-MERGE-BYPASS` in
  [Anti-patterns](anti-patterns.md).

### Items 3 and 4 apply to every path, not just the dev-loop tooling

Items 3 and 4 (clean `draft_gate` / current-head `pre_approval_gate` verdicts) are
enforced two ways, and both must be closed for the precondition to hold in
practice:

- **Client-side:** the PreToolUse Bash hook blocks an ungated `gh pr ready` and denies a
  raw `gh pr merge` outright, and `merge-pr.mjs` calls `detect-checkpoint-evidence.mjs`
  before merging.
- **Server-side:** the `gate-evidence` status check (`.github/workflows/gate-evidence.yml`)
  re-runs the same verdict check with GitHub's own token for every non-draft PR. It always
  evaluates the DEFAULT BRANCH's detector (trusted code); the resolved PR head SHA is only
  the status target.
  - It is **pre-merge-only** (#1702): `synchronize` is NOT a trigger. Triggers: PR
    opened/reopened, `ready_for_review`, a submitted or edited review, a standalone review
    comment, and a created/edited PR issue comment that starts with the gate-comment marker
    (`### Gate review:`) from a trusted author (`OWNER`/`MEMBER`/`COLLABORATOR`). A new
    round's verdict review (`GATE-COMMENT-SINGLE-SURFACE`) fires
    `pull_request_review [submitted]`; a same-head in-place correction fires
    `pull_request_review [edited]`. The issue-comment arm covers only legacy verdicts and the zero-dep fallback poster.
  - A run always posts a **definitive** status (success/failure, never `pending`) as an
    explicit commit status on the resolved PR head SHA, never as the triggering job's own
    check-run. `not_established` (no clean verdict for the current head yet) is a
    fail-closed `failure` that the next verdict post re-fires to `success`.
  - The workflow has two jobs
    (`docs/decisions/0076-gate-evidence-reporter-split-always-settles-required-status.md`,
    amending 0043): `gate-evidence-runner` keeps `cancel-in-progress: true` and posts no
    status; the non-cancelling `gate-evidence-reporter` always settles the required status
    at the final head after a burst of review/comment events.
  - Recovery for a lost/failed run when a correct verdict exists: re-run the round's
    verdict post with a corrected field (the in-place `PUT` fires `edited`), post the next
    round's verdict review, or, where the full toolchain is unavailable, use the zero-dep
    fallback poster's issue comment. An identical same-head rerun is a deliberate no-op and
    does not re-fire. `gh run rerun` replays the stale original event payload and is not a
    native re-fire path.
  - Stuck status at merge-readiness (issue #1935, ADR 0057): when a verdict-post re-fire
    was cancelled by `cancel-in-progress` or evaluated before the verdict was API-visible,
    the required status stays `failure` although a clean current-head verdict exists, and
    the merge stays `UNSTABLE`. The loop excludes `gate-evidence` from its CI wait
    (`LOOP_DERIVED_CI_CHECK_NAMES`), so nothing heals this automatically. Run
    `scripts/github/reconcile-gate-evidence-status.mjs --repo <o/r> --pr <n>`. It reads the
    evidence the way the check does (`detect-checkpoint-evidence --skip-fanout-ledger-check`)
    and, only when the evidence is satisfied but the status is stuck non-green, re-fires
    the run that posted the stale status (`gh run rerun <id>`, id parsed from the status
    `target_url`). It never posts a status itself and re-fires nothing when the evidence is
    not satisfied.
  - There is no `pull_request_review_thread` Actions trigger. A bare "Unresolve
    conversation" UI action with no review or comment does not re-fire the check; the next
    review or comment re-catches it.
  - The check closes the ready/merge bypass for direct API, web UI and raw `gh` calls
    outside the hook **once branch protection on `main` requires it**. Until then it
    reports at pre-merge/verdict points but does **not** block merge. When `gh pr merge` is
    blocked and the `gate-evidence` context is not `success`, the `merge-pr.mjs` error
    names the required check and this recovery.

### Required-context invariant: the status, never the job

<!-- rule: MERGE-PRECOND-REQUIRED-CONTEXT-IS-STATUS -->
`MERGE-PRECOND-REQUIRED-CONTEXT-IS-STATUS`: the `main` branch-protection
required status is the `gate-evidence` commit status and MUST NEVER be either
Gate-evidence job (`gate-evidence-runner` or `gate-evidence-reporter`). Superseded
runs of either job leave `cancelled` check-runs that drive `mergeStateStatus` to
`UNSTABLE`; requiring the always-settling status keeps those cancellations from
blocking a merge. An `UNSTABLE` whose only non-success entries are superseded
Gate-evidence job cancellations, with the `gate-evidence` status `success`, is benign:
`classifyBenignGateEvidenceUnstable` (`@dev-loops/core/loop/copilot-ci-status`) labels
it for `loop info`. No committed branch-ruleset/config-audit surface exists yet; when
one is added, it MUST assert the required contexts include `gate-evidence` and exclude
both `gate-evidence-runner` and `gate-evidence-reporter`.

The server-side check verifies the same visible verdict fields as the client-side
tooling, including the light-mode inline exception
([Gate Review Sub-Loop Contract](./gate-review-sub-loop-contract.md#light-mode-inline-acceptance-under-threshold-micro-prs))
and the [review-proportionality non-overridable floors](./gate-review-sub-loop-contract.md#review-proportionality-dispatch-plan-non-overridable-floors).
It recomputes the risk-path and size-outcome floors from the merge-base diff with plain
`git`/`check-size-budget.mjs` reads, so that re-verify runs even under
`--skip-fanout-ledger-check`. It does **not** re-verify the fan-out findings-log
ledger/provenance layer (`gates.requireFanoutEvidence` / `requireFanoutProvenance`),
which lives in a gitignored, machine-local `tmp/` file under the main worktree (#2315).
That layer remains client-side/self-reported-only.

`--skip-fanout-ledger-check` is a deliberate exception for that machine-local ledger
(`tmp/gate-findings/<slug>/pr-<n>/<gate>-<head>.json`); making CI read it is a non-goal.
The verdict-post refusal in `scripts/github/upsert-checkpoint-verdict.mjs` closes the
local write-skip: a `requireFanoutEvidence` `fanout_fanin` verdict post fails closed
unless the canonical durable ledger for the reviewed head already exists on disk, via
the SAME `ledgerExists` predicate the merge-time check uses.

### Angle-pool / fanout-groups / mandatory-angle config resolves from the PR HEAD, not the invoking checkout (#1972)

The ledger bytes are read from ANY checkout (`resolveLedgerCheckouts`: main plus every
worktree). The config that defines a valid fan-out (the angle pool,
`gates.fanout.groups`, and each gate's mandatory angles;
`resolveGateConfig`/`resolveGateAngleContract`/`resolveFanoutGroups` in
`packages/core/src/config/config.mjs`) resolves from the **PR HEAD commit's committed
`.devloops`**. `buildFanoutEnforcement` in `scripts/github/detect-checkpoint-evidence.mjs`
reads it via `git show <headSha>:.devloops` (same bare/`.yaml`/`.yml`/`.json` precedence as
the disk loader) and re-parses it with `loadDevLoopConfig`'s `devloopsOverride` option.
Extension defaults and `.pi/dev-loop/defaults` still come from the invoking checkout's disk.
When the head commit is not resolvable locally, resolution falls back to the invoking
checkout's own config, never to a looser or skipped check. When the head `.devloops` fails
to parse/validate, `detect-checkpoint-evidence` fails closed with `config_load_failed`
(`CONFIG-LOAD-FAIL-CLOSED`) and `merge-pr` refuses through its `gate_evidence` precondition
with a refusal message that names `config_load_failed`. Neither uses a fallback. A non-conformant
fan-out fails closed under either config.

### Evidence writes and `gh pr merge` MUST be separate tool calls (#1172)

The PreToolUse Bash gate evaluates `gh pr merge` **before** the Bash tool call executes, so a
compound command that writes gate evidence (the findings-log ledger,
`upsert-checkpoint-verdict`) and merges in the same call is blocked and the write never runs.
The block message names this case. Write, verify, then merge alone:

1. Write the gate evidence (findings-log ledger / checkpoint verdict) in its own Bash call.
2. Verify it landed (e.g. `ls tmp/gate-findings/<slug>/pr-<n>/`) in a separate call.
3. Run the sanctioned merge wrapper (`node scripts/github/merge-pr.mjs …`) alone, with no other
   command chained via `&&`/`;`/newline.

## Title markers

`findBlockingTitleMarkers` (`@dev-loops/core/loop/pr-title-markers`) enforces merge-blocking
title markers. `WIP` and `DRAFT` (case-insensitive) block only in one of four constructions:

- bracketed: `[WIP]`, `[draft]`
- parenthesized: `(wip)`, `(DRAFT)`
- colon-suffixed: `WIP: add feature`, `draft: new module`
- standalone (the entire title, nothing else): `WIP`, `draft`

Exemptions and anchoring:

- A hyphen, underscore, or space joining the marker into a compound noun is exempt from every
  construction: `draft-gate`, `draft_gate`, `draft gate`, `wip-branch`.
- The bracket/paren/colon opening delimiter must sit at the start of the title or right after
  whitespace, so `fix(draft): support x`, a path segment, a scoped label, `Fix bug,(draft)`
  and `Fix login(wip)` stay unflagged.
- The colon must close the tag (followed by whitespace or end-of-title), so `draft:latest`
  and `wip:branch` stay unflagged.
- A dash-set-off trailing tag (`Fix login flow — WIP`) stays unflagged.
- `DO NOT MERGE` (case-insensitive) and `🚧` match anywhere in the title. Only whitespace
  joins the words of `DO NOT MERGE`, so hyphen- or underscore-joined spellings such as
  `do-not-merge` or `do_not_merge` do not flag.

This is enforced at two points:

- At the **draft → ready-for-review** transition: `ready-for-review` refuses `gh pr ready` while the
  title carries a marker.
- At the **pre-approval gate boundary and final approval** (for non-draft PRs): the gate-coordination
  state (`detect-pr-gate-coordination-state.mjs`) returns `title_marker_blocked` so a PR un-drafted externally still cannot enter pre-approval or
  reach merge-ready with a marked title.

A marker is allowed only while the PR is still in draft; it must be removed before the PR leaves draft.

## Merge authorization

- Merge authorization MUST be explicit for the active issue/PR scope, OR supplied by a recorded standing authorization (below)
- `"Merge authorized if gates green"` is valid explicit authorization
- Implied approval from prior turns MUST NOT be treated as sufficient; only a recorded standing authorization carries across scopes

### Recorded standing authorization (ADR 0050)

An operator MAY record a standing merge authorization that applies to every PR whose
full gate pipeline passes: clean `draft_gate` and `pre_approval_gate` verdicts at the
current head, zero unresolved review threads, a green gate-evidence audit, and green CI.
A standing authorization is valid only when all of the following hold:

- the repo config sets `autonomy.humanMergeOnly: false` (the config alone authorizes nothing)
- the authorization is recorded in a durable artifact (an accepted decision record naming
  the condition), not only in a chat turn
- the gate pass is complete at the current head; a gate-incomplete PR stays unauthorized

This recorded authorization's current-head condition is stricter than the general
one-time draft transition rule in [PR Lifecycle Contract](pr-lifecycle-contract.md).
The detector accepting an older draft transition record does not establish this
standing authorization; if its condition is unmet, obtain fresh per-scope approval.

Absent a recorded standing authorization, the per-scope explicit rule above governs.
A standing authorization surfaces through the per-run authorization signal
`resolveEffectiveMergeAuthorized`, which satisfies sibling contracts that require
"explicit merge authorization for the active scope".

### `autonomy.humanMergeOnly` — fixed human-only merge (non-overridable)

When a repo sets `autonomy.humanMergeOnly: true` in `.devloops`, merge is a fixed
human action and this authorization step is **non-overridable**:

- `resolveAutonomyStopAt` always includes `merge`, even if `stopAt` is set to `[]`.
- The effective merge authorization fails closed: `resolveEffectiveMergeAuthorized`
  returns `false` regardless of the `mergeAuthorized` envelope flag or an explicit
  "merge" instruction. The lifecycle resolver therefore never advances to the merge
  state and parks at the `pre_approval_gate` human-merge handoff.
- The agent still runs the full mechanical pre-merge evidence check and reports
  merge-ready + gate evidence, then hands off to a human for the GitHub merge action
  (ADR 0007). The wrapper also refuses a human invocation while this config is set;
  do not hand off an unusable wrapper command or change the config to bypass it. Under `humanMergeOnly` the agent
  **never** performs the merge itself — not the wrapper and never a raw `gh pr merge`;
  merge is a human action.

### Size-budget merge gate (issue #1480)

An escalated or T1 PR (the `gates.size` outcome recorded on the `pre_approval_gate`
verdict — see [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md))
needs a **valid human approval** and **zero unresolved CHANGES_REQUESTED** before
merge, regardless of any standing merge authorization above. A Copilot-clean verdict
alone is never sufficient for these PRs.

- The pure decision (`resolveSizeBudgetHumanApprovalRequired`,
  `@dev-loops/core/loop/size-budget-merge-gate`) requires human approval when the
  recorded size-budget `outcome` is `escalate` or `block`, OR the PR touches the T1
  tier (a T1 file is in the diff). A plain `pass` outcome with no T1 slice carries no
  size-imposed requirement.
- "Valid human approval" is the shared, head-pinned resolver the `merge_approval` gate
  uses (`verifyFreshHumanApproval`, `@dev-loops/core/loop/merge-approval`; see the
  **Fresh per-merge approval** bullet above), fed in as `humanApprovalSatisfied`. It
  accepts only the designated approver (the `--human-approved-by <login>` passed to the
  merge wrapper): a genuine `APPROVED` review on the current head SHA, or, on the
  solo-owner path, a head-pinned `approve merge <headSha>` comment. Any other login, a
  Copilot/bot author, or a stale approval never satisfies it.
  `resolveHumanReviewDecision` (same module, `reviewDecision === "APPROVED"`) is only a
  back-compat fallback for the queue-driver caller; the production `merge-pr.mjs` wiring
  (`evaluateMergePreconditions`) always uses the shared resolver.
- **Fail-closed**: absent or unreadable size-budget evidence (a `pre_approval_gate`
  verdict without the `**Size-budget outcome/T1 slice**` fields — see
  `detect-checkpoint-evidence.mjs`), an unreadable T1-touch signal, an unknown review
  decision, or a nonzero/unreadable unresolved-CHANGES_REQUESTED count all require
  human approval — never treated as a silent pass.
- `resolveLifecycleState` (`@dev-loops/core/loop/lifecycle-state`) consults this gate
  IN ADDITION TO `resolveEffectiveMergeAuthorized`: when it is required, the lifecycle
  parks at `pre_approval_gate` instead of advancing to `merge`, even under a standing
  authorization. The agent must not merge such a PR, including via the sanctioned
  wrapper, until valid human approval satisfies it, and it must never run a raw
  `gh pr merge`. `scripts/github/merge-pr.mjs` itself refuses (precondition
  `size_budget_human_approval`) until that approval is present.
- `GATE-COMMENT-SIZE-BUDGET-FIELDS` in the
  [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md) owns the
  populated size fields on a `pre_approval_gate` verdict. A pre-existing verdict posted
  before that field set existed reads back `sizeOutcome`/`sizeTouchesT1` as `null`, which
  fails closed per the bullet above.
- **This gate is also consulted LIVE on the authoritative pre-merge CI path**:
  `buildPreMergeGateCheck` in `scripts/github/detect-checkpoint-evidence.mjs`, which the
  `gate-evidence` required check and `merge-pr.mjs`'s gate-evidence probe both run, reads
  `preApprovalGateMarker.sizeOutcome`/`sizeTouchesT1` (as `touchesT1`) and records a
  pre-merge failure when `resolveSizeBudgetHumanApprovalRequired` requires human
  approval. With no single named approver on that surface, it tries
  `verifyFreshHumanApproval` for every distinct human login in the fetched
  reviews/comments, so the same two approval paths from any one of them satisfy it.

### `approval` — offer to assign a human at the handoff (opt-in)

When a repo sets `approval.enabled: true` in `.devloops`, the loop **offers** to route the
PR to a contributor at the `pre_approval_gate` / `waiting_for_merge_authorization` boundary.
Disabled by default; no candidate sourcing when disabled.

```yaml
approval:
  enabled: true
  candidatesFrom: [codeowners, recent-committers]
  assignees: [alice, bob]
```

At the handoff boundary, resolve and surface candidates:

```sh
node <dev-loops-package-root>/cli/index.mjs gate offer-human-handoff --repo <owner/name> --pr <number>
```

This prints the deduped, ordered candidate list (priority:
`assignees` > `codeowners` for the touched paths (last-match-wins) >
`recent-committers` to those paths, PR author/bots excluded). It assigns no one.

**OFFER-only — the operator confirms the assignee.** On confirmation, run:

```sh
node <dev-loops-package-root>/cli/index.mjs gate offer-human-handoff --repo <owner/name> --pr <number> \
  --assign <login> --request-review <login>
```

which runs `gh pr edit --add-assignee` / `--add-reviewer` for the confirmed
human(s).

## Post-merge

After a confirmed merge, `merge-pr.mjs` runs three steps itself and reports them under `postMerge`: the main-checkout fast-forward below, the branch-keyed worktree removal below, and the repo's `postMerge.actions`. Each step is fail-soft. All three skip with a reason when the main checkout's `origin` is not `--repo`. Run a step manually only as the fallback when its result reports a skip or an error. The actions step can run for up to `POST_MERGE_ACTIONS_TIMEOUT_MS` (900s). Give the command the highest tool timeout the harness allows; the Claude Code Bash tool maximum is 600s. `merge-pr.mjs` writes the stderr line `merge-pr: merged <repo>#<n> ...` before the steps run. A tool timeout after that line means the PR is merged. Rerun the actions step by hand with `scripts/loop/run-post-merge-actions.mjs --repo-root <main checkout> --pr <n>`.

- Fast-forward the main checkout's local `main` to `origin/main` (#1596): resolve the main (primary) checkout via `git worktree list` (first entry) from the current cwd, then run this guarded step-wise sync (best-effort, `|| true`), which merges only when the checkout is on `main` — never on a detached or off-`main` checkout:

  ```sh
  main=<main-checkout>
  ref="$(git -C "$main" fetch origin main && git -C "$main" rev-parse --symbolic-full-name HEAD)" \
    && [ "$ref" = refs/heads/main ] \
    && git -C "$main" merge --ff-only origin/main || true
  ```

  `--symbolic-full-name` is required (never `--abbrev-ref`, which `core.warnAmbiguousRefs` can rename to `heads/main` when a tag shares the branch's short name). The post-merge hooks (Pi `post-merge-update`, Claude `post-tool-use-merge`) run this same step-wise flow automatically (shared via `syncMainCheckout` in `packages/core/src/loop/main-checkout-ff.mjs`); the command above makes it deterministic and copy-pasteable for the dev-loop's own merges. `--ff-only` refuses a diverged main without rewriting history — a diverged main checkout on `main` warns and continues, never blocking. Read-only gate scripts (`probe-ci-status.mjs`, `detect-copilot-loop-state.mjs`, …) run from the main checkout, so a stale local `main` made them execute pre-merge code (re-introducing the CI-wait stall every PR).
  - **`main_checkout_not_on_main` (a detached or non-`main` checkout):** after a successful fetch, a main checkout proven to be detached or on another named branch is never merged, switched, or reset — the flow only reads its ref (plus, for a detached checkout, a short SHA via `git -C <main-checkout> rev-parse --short HEAD`) and, once fetch succeeds, the post-fetch `HEAD..origin/main` behind count. It reports the stable diagnostic kind `main_checkout_not_on_main` at severity `error`, naming the absolute checkout path, the branch or `detached@<short-sha>`, and the decimal behind count. Claude surfaces it as a structured PostToolUse `systemMessage` on stdout (a different channel from the generic stderr warning above) and still exits 0; Pi surfaces it via `ctx.ui.notify(message, "error")`, falling back to an stderr write when no UI is available. Persistence is session-only — the message lives in the current hook output/UI notification, never a file, GitHub comment, or dashboard entry. The action stays non-fatal; reconcile manually: preserve any local-only commits, then check out `main` and fast-forward it to `origin/main` yourself. A fetch failure, an unresolved worktree (`git worktree list` failed, was killed, or didn't parse — Pi falls back to the cwd repo root and still runs the sync there; a `not_on_main` result against that fallback checkout stays the generic warning instead of the error diagnostic, since the fallback may be a linked feature worktree rather than the true main checkout), an unreadable ref, a failed behind-count read, or a diverged `main` checkout all keep their existing best-effort warning/fallback behavior instead.
- Verify all main-push workflows are green at the merge commit (`docs/decisions/0050-agent-merge-on-full-gate-pass.md` names this a load-bearing post-merge duty): `node scripts/github/probe-ci-status.mjs --repo <owner/name> --commit <merge-commit-oid> --timeout-ms <n>` is the sanctioned commit-scoped read — it combines the most-recent 100 GitHub Actions workflow runs for that commit (any failure → `failure`, any run still queued/in_progress → `pending`, otherwise `success`) and block-waits up to `--timeout-ms` for the runs to settle. This replaces an ad hoc `gh run list --commit <oid>` + hand-rolled poll, which bypasses the standard `--jq`/`--silent` output contract.
- Sync the merged item's board Status to Done (issue #1458), from the main checkout:
  `node <dev-loops-package-root>/cli/index.mjs queue sync-status --repo <owner/name> --pr <number> --item <linked-issue> --logical-column done || true`
  (omit `--item` when the merged PR is itself the queue item — an unfilled/empty `--item` falls back to `--pr`; the
  `|| true` masks the residual usage-error exits the same way the archive step's does). `--logical-column done`
  resolves the Done column through `queue.statusColumns`, so a board that renamed Done still converges. Resolves the
  board from `.devloops` (`tracker.board`) relative to `cwd` — there is no `--repo-root` flag — using
  local `gh` auth, so it must run from the main checkout: `merge-pr.mjs` has already removed the merged worktree, so that worktree is no longer a valid cwd.
  Best-effort and NON-FATAL on a parsed invocation: a board that is not configured, an item not on the board, or any
  API failure exits 0 with a JSON result describing the skip instead of failing the merge; a usage/argument error
  still exits 1 and an invalid `--jq` filter exits 2.
- Remove merged worktree (canonical, `WORKTREE-CLEANUP`): `merge-pr.mjs` removes the linked worktree that has the merged head branch checked out at the merged head SHA. The manual fallback is `node scripts/loop/cleanup-worktree.mjs --repo-root <main> (--issue <n> | --pr <n> | --branch <name> [--head-sha <sha>])`.
  See [Worktree usage guidance](./worktree-guidance.md#post-merge-cleanup).
- Archive long-done queue items (operator-induced, NOT a cron): `node scripts/projects/archive-done-items.mjs --repo <owner/name> || true`.
  Runs as part of this post-merge hook. It applies the configured `queue.archiveOlderThanDays` (default `7d`) and archives
  board items whose issue/PR has been closed at least that long. Best-effort: run it as a standard post-merge step but ignore
  any non-zero exit (a successful run that finds nothing to archive exits 0; a board/config-resolution/API error exits
  non-zero, which the `|| true` masks) — a failure here must never block merge completion. See
  [Projects Queue Contract](./projects-queue-contract.md#archiving-completed-items).
- Clean up stale branches
- <!-- rule: MERGE-POSTMERGE-FULL-SHA-REPORT --> `MERGE-POSTMERGE-FULL-SHA-REPORT`: the merge report MUST name the full 40-hex merge commit SHA, never an abbreviated SHA.

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Validation policy](validation-policy.md)
- [Stop conditions](stop-conditions.md)
- [PR Lifecycle Contract](pr-lifecycle-contract.md)
- [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md) — `GATE-COMMENT-VERDICT-VALUES`
- [Contract style guide](contract-style-guide.md)
