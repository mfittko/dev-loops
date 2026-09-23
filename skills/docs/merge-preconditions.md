# Merge preconditions

Canonical owner for merge preconditions across all workflow families.

## Conflict-free (mergeable) is a precondition at every gate

A PR that conflicts with its base gets **no `pull_request` CI run** — GitHub can't
compute the merge ref — so the gate silently stalls (green-less with no obvious
cause). Conflict-free is therefore a required gate precondition, checked at **two
seams**: before requesting CI/Copilot, and again before merge.

- `gh pr view --json mergeable,mergeStateStatus` drives it. A `CONFLICTING` /
  `DIRTY` / `BEHIND` PR does **not** pass any gate (`gateBoundary:
  conflict_resolution`, `nextAction: resolve_merge_conflicts`).
- `mergeable` is computed asynchronously, so a freshly-pushed head briefly reads
  `UNKNOWN`. The detect layer **re-polls a bounded number of times**; if it never
  settles, the gate **fails closed to a recheck** (`nextAction: wait_for_ci`) —
  an unsettled merge state is never treated as clean.
- `loop info` surfaces a **Mergeable:** line (mergeStateStatus included) so a
  conflict is diagnosed immediately, never mistaken for missing CI.

### Deterministic auto-resolve (additive CHANGELOG only)

When a PR is behind/`CONFLICTING`, run the conservative resolver before resuming
the gate path:

```sh
node scripts/loop/resolve-pr-conflicts.mjs [--base <branch>] [--push]
```

It merges `origin/<base>` into the PR branch and resolves **only the safe additive
case** — a `CHANGELOG.md` conflict where both sides only ADD list/section entries
(keep BOTH sides, in order) — then runs `bun run test:docs` and (with `--push`)
pushes. **Any other conflicted path, or a non-additive CHANGELOG edit, FAILS
CLOSED** naming the conflicted paths (no silent stall, no guessing — resolve those
by hand). This encodes the exact additive-CHANGELOG resolution the loop has been
doing manually; it is not a general conflict-resolution engine.

## Required before merge

<!-- rule: MERGE-PRECOND-REQUIRED -->
Before merge, ALL of the following MUST hold:

1. ✅ Conflict-free with base (`mergeable: MERGEABLE`; not `CONFLICTING`/`DIRTY`/`BEHIND`/`UNKNOWN`)
2. ✅ CI green (`success`) on current head. `crediblyGreen` (the bounded zero-suite
   `--local-validation-head-sha` exception) never substitutes for this —
   `evaluatePrGateCoordination` fails it closed identically to a real CI failure at
   the pre-approval and final-approval boundaries (#552). It only extends the
   draft-gate wait until CI actually settles green.
3. ✅ Draft gate satisfied — clean `draft_gate` verdict per `GATE-COMMENT-VERDICT-VALUES` ([Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md))
4. ✅ Pre-approval gate satisfied — clean `pre_approval_gate` verdict on the current head, same rule
5. ✅ All review threads resolved
6. ✅ Merge authorization from the operator — explicit for the active scope, or a recorded standing authorization (see [Merge authorization](#merge-authorization))
7. ✅ Closing-reference state matches artifact backing, each arm owned by a different contract: tracker-backed work — PR body contains `Closes #N` or `Fixes #N` (owned by the PR description contract in [copilot-loop-operations.md](copilot-loop-operations.md)); issue-less lightweight (PR-body-as-spec, no backing issue) — the closing reference is absent by design and `node scripts/loop/validate-pr-body-spec.mjs --repo <owner/name> --pr <number> --no-issue` passes clean (owned by `ARTIFACT-LIGHTWEIGHT-BODY-INVARIANTS` in [Artifact Authority Contract](artifact-authority-contract.md)); plan-file promotion (P4) — the PR body carries the committed plan-doc path as the spec-of-record and, being issue-less by design (`buildPromotionPrBody` neutralizes closing keywords), the closing reference MUST NOT be present
8. ✅ PR **title** free of merge-blocking markers — see [Title markers](#title-markers) for the exact constructions that count
9. ✅ Size-budget human-approval requirement satisfied for an escalated/T1 PR — see [Size-budget merge gate](#size-budget-merge-gate-issue-1480)
10. ✅ Copilot convergence on the current head. `evaluateCopilotConvergence` reports one of three states. `current_head_clean`: the latest current-head Copilot review is `🟢 Approval recommended`, has no disposition header, or is `🔵 Needs a closer look`. A `🔵` is conductor-overridable. Item 5 still applies, so a `🔵` merges only with zero unresolved threads. `current_head_findings`: the latest current-head review is `🟡 Changes recommended` or has an unrecognized header, and the merge refuses fail-closed unless a trusted `copilot-body-disposition` record (`COPILOT-STATE-BODY-DISPOSITION-RECORD` in [Copilot Loop State Graph](copilot-loop-state-graph.md)) names that review for the current head. In both of these states the latest submitted Copilot review still decides: when it sits on an earlier commit (Copilot reviewed an older commit after the current head) and the carried-convergence predicate (`COPILOT-STATE-CARRIED-CONVERGENCE`, without its delta condition) does not find it converged, the merge refuses. `no_current_head_review`: no Copilot review exists on the current head. A review on an earlier head is stale and never counts as the current-head verdict. This state passes only through a disposition that `merge-pr` pins to the current head, in this order. `copilot_gate_disabled` applies first when the round cap is 0. `converged_once` applies in the default mode (`refinement.requireCopilotConvergenceAtLatestHead: false`) when the loop's carried-convergence predicate (`COPILOT-STATE-CARRIED-CONVERGENCE`) finds the latest Copilot review converged on an earlier head and no Copilot review is outstanding on the current head. The delta since that head is not checked; `pre_approval_gate` covers the current head (ADR 0090). `round_cap_clean_fallback` applies when the round cap is reached. It is refused when the last review converged and a significant change landed since. `docs_only_suppression` applies only with `refinement.requireCopilotConvergenceAtLatestHead: true`, when the same predicate carries the prior Copilot review across a docs-only or integrate-only delta, and no Copilot review is outstanding on the current head. `copilot_gate_disabled` also applies last when both the loop's detector and the `internalPathPatterns` that `merge-pr` loads classify the PR as internal-only. For a light-dispatched PR, pass `--lightweight` so `merge-pr` composes the lightweight round cap. The merge result records `copilotConvergenceState` and `copilotDisposition`, plus `copilotCarriedConvergence` (`{ source, sourceReviewId, sourceHeadSha, bodyDisposition }`, per `COPILOT-STATE-CARRIED-CONVERGENCE`) for `converged_once` and `docs_only_suppression`, and `copilotBodyDisposition` for a record-cleared current-head finding. A record clears a current-head finding only when it names the review that raised it. Pre-approval entry and merge read the current-head disposition through the same `evaluateCopilotConvergence` evaluator. Gate entry keeps its own absent-review handling.

> Runner-coordination lock: the pre-merge evidence check fails closed on a stale/foreign runner claim for the PR. A completing run releases its claim best-effort at every terminal stop (including the human approval checkpoint), so a merge re-dispatch normally proceeds. The release fires both at Copilot-loop terminal states (`loop handoff`, #1128) and at gate-coordination terminal stops (`detect-pr-gate-coordination-state` — approval checkpoint / merge-ready / done / blocked, #1632), so a run that stops at the approval checkpoint without a Copilot-loop terminal state still releases immediately. If a lock held by a completed/dead run still blocks the merge, take it over explicitly with `node <resolved-skill-scripts>/loop/pr-runner-coordination.mjs takeover --repo <owner/name> --pr <number>`. Never take over a genuinely active (non-stale) run — that fail-closed block is intentional.

> Stranded Copilot review request (human-only): a review requested on a head that already carries Copilot's own clean submitted review is never delivered — Copilot does not re-engage a change it effectively approved — so below the round cap the loop waits indefinitely and `pre_approval_gate` cannot post. (At the cap the loop already routes to `round_cap_clean_fallback`, so the gate is not blocked and there is nothing to unstick.) Withdraw it explicitly with `node <resolved-skill-scripts>/github/withdraw-copilot-review-request.mjs --repo <owner/name> --pr <number> --reason <why>`. It withdraws only when a request is pending (no request is an exit-0 no-op) and refuses outright unless Copilot has already submitted a review and no unresolved threads remain, and it verifies the withdrawal took effect — so prefer it over a raw `gh pr edit --remove-reviewer`, which has none of those guards. This is an operator judgement about a model's behavior: it is deliberately NOT in the sanctioned-command set and an agent must not invoke it.
>
> Head-advanced sibling case (issue 1441): the loop converged, the round's threads were reply-resolved on a NEW head, so `copilotReviewOnCurrentHead` is false. Withdrawing alone would just make the loop re-request Copilot on that head and strand again. The tool covers this too, but only when the delta since Copilot's last SUBMITTED review is provably a pure doc/prose bump. The tool classifies the raw delta with `classifyDeltaSinceLastReview`, which is stricter than the base-relative `resolveConvergenceCarry` that the suppression decisions use: an integrate-only base move that carries for the loop still refuses here. Any code/test/config/CI or unclassifiable delta, a non-linear advance, or an unavailable compare also refuses, exactly as before. On success it records an operator-authorized suppression marker scoped to that exact head (`scripts/loop/_post-convergence-review-suppression.mjs`); `request-copilot-review.mjs` and the gate-coordination state (`detect-pr-gate-coordination-state.mjs`, `evaluatePrGateCoordination`'s `postConvergenceReviewSuppressed` input) both honor that marker, under the `COPILOT-STATE-CARRIED-CONVERGENCE` thread and delta checks in [Copilot Loop State Graph](copilot-loop-state-graph.md), so the round is not forced open again and `pre_approval_gate` can post. Any further push changes the head and invalidates the marker.

## Sanctioned merge wrapper (issue #1939)

The canonical agent-executed merge path is the sanctioned wrapper `scripts/github/merge-pr.mjs`
(`node scripts/github/merge-pr.mjs --repo <owner/name> --pr <n> --human-approved-by <login>`,
squash by default, `--method` configurable). It runs the full precondition list
above fail-closed and refuses with a non-zero, machine-readable reason naming the
specific failing precondition; only when every precondition holds does it perform
the merge and return `{ ok, merged, mergeCommit, approvedBy, mergeClass, approvalVia, ... }`
under the same `--jq`/`--silent` base-CLI contract as the other helpers. It reuses
`detect-checkpoint-evidence` for the draft_gate / current-head pre_approval_gate /
threads / runner-lock / fan-out-provenance set — it does not re-derive it.

- Every merge passes `--human-approved-by <login>`, validated as a real GitHub login
  (not a bare boolean or free text) and stamped on the result and audit trail.
- **humanMergeOnly refuses the wrapper.** When `autonomy.humanMergeOnly` is set, merge is
  a human-only action: the wrapper refuses outright (the agent hands off, and does not run
  even the wrapper), regardless of any fresh approval.
- **Merge class.** A normal **drain** merge is satisfied by a recorded standing
  authorization OR a fresh operator approval. A standing authorization is NOT established by
  config alone (`autonomy.humanMergeOnly: false` authorizes nothing on its own): the
  orchestrator asserts a recorded standing authorization via `--standing-authorization`;
  absent that flag, a drain merge also requires a fresh operator approval. A
  **stable-release** (`--stable-release`), **size-escalated** (`gates.size` outcome
  `escalate`/`block`), or **T1-touching** merge is escalated: a standing
  authorization does NOT satisfy it — a fresh per-merge operator approval is required.
- **Head-pinned.** The merge mutation passes `--match-head-commit <headSha>` so a push
  between the precondition reads and the merge fails closed instead of merging an unchecked
  newer head; the gate-evidence head must also match the checked head, and CI-green reuses
  the loop-safe rollup normalization that excludes the separately-validated `gate-evidence`
  check.
- **Fresh per-merge approval** is verified against an agent-unforgeable, head-pinned
  record, in preference order: a genuine `APPROVED` review by `<login>` on the current
  head SHA (a Copilot/bot review never satisfies it, reusing the prohibition on
  agent-submitted APPROVE reviews), else a head-pinned operator comment marker
  `approve merge <headSha>` authored by `<login>`. It fails closed on a stale
  (earlier-commit), agent/bot-authored, or wrong-login approval, and re-gates on every
  head bump.
- **Stable-release safety.** The wrapper only merges the PR to its base. It NEVER tags
  or publishes and does NOT satisfy the operator-owned stable-release approval gate;
  `--stable-release` only raises the approval requirement.
- Raw `gh pr merge` is forbidden — see `RAW-GH-PR-MERGE-BYPASS` in
  [Anti-patterns](anti-patterns.md). It is a recorded raw-`gh` violation
  (`check-retro-tooling.mjs`), and the PreToolUse Bash gate stays as defense-in-depth.

### Items 3 and 4 apply to every path, not just the dev-loop tooling

Items 3 and 4 (clean `draft_gate` / current-head `pre_approval_gate` verdicts) are
enforced two ways, and both must be closed for the precondition to hold in
practice:

- **Client-side:** the PreToolUse Bash hook blocks an ungated `gh pr ready`, and
  denies a raw `gh pr merge` outright (the sanctioned wrapper `merge-pr.mjs` is the
  only merge path; a raw merge would bypass its approver/merge-class/fresh-approval
  checks), and `detect-checkpoint-evidence.mjs` is what the wrapper calls before merging.
- **Server-side:** the `gate-evidence` status check
  (`.github/workflows/gate-evidence.yml`) re-runs the same verdict check on
  GitHub's own token for every non-draft PR. It is **pre-merge-only** (#1702):
  `synchronize` (a development push) is NOT a trigger, so a dev push never
  starts/leaves a blocking gate-evidence run — the check materializes only at a
  pre-merge/verdict point: PR opened/reopened, `ready_for_review`, a submitted
  or edited review, a standalone review comment, and a created/edited PR issue
  comment that starts with the gate-comment marker (`### Gate review:`) from a
  trusted author (`OWNER`/`MEMBER`/`COLLABORATOR`). A run always posts a
  **definitive** status (success/failure, never `pending`) to the current head's
  resolved SHA, for two reasons: a newly-opened unresolved thread re-evaluates
  the check instead of leaving a SHA-pinned green stale on the thread axis, and
  a clean verdict cannot leave a stale pre-verdict `pending` blocking a
  satisfied PR (#1702) — `not_established` (no clean verdict for the current
  head yet) is a fail-closed `failure` that the next verdict-post re-fires to
  `success`. The verdict is a PR
  REVIEW (`GATE-COMMENT-SINGLE-SURFACE`): a new round's review fires
  `pull_request_review [submitted]`, and a same-head verdict correction (the
  upsert's in-place `PUT`) fires `pull_request_review [edited]`; the
  issue-comment arm covers only legacy verdicts and the zero-dep fallback
  poster. Evaluation always runs the DEFAULT BRANCH's
  detector (trusted code; the resolved PR head SHA is only the status target).
  Recovery for a lost/failed run when the verdict already exists and is
  correct: re-run the round's verdict post with a corrected field (the upsert
  PUTs the review in place and `edited` re-fires the check), post the next
  round's verdict review, or — where the full toolchain is unavailable — the
  zero-dep fallback poster's issue comment re-fires via the issue_comment
  arm. An identical same-head rerun is a deliberate no-op and does not
  re-fire. `gh run rerun` is not a native re-fire path (it replays the stale
  original event payload), but it IS the sanctioned recovery for one specific
  stuck state (issue #1935, ADR 0057): the verdict-post re-fire was CANCELLED by
  the job's `cancel-in-progress` concurrency (a superseding review/comment event
  landed right after it) or evaluated before the just-posted verdict was
  API-visible, so the required status stayed `failure` on the current head even
  though a clean current-head verdict now exists, and no further event re-fired
  it — the merge stays `UNSTABLE`. Because the loop excludes `gate-evidence` from
  its own CI convergence wait (`LOOP_DERIVED_CI_CHECK_NAMES`), nothing heals this
  automatically. `scripts/github/reconcile-gate-evidence-status.mjs --repo <o/r>
  --pr <n>` closes it deterministically at merge-readiness: it reads the
  authoritative evidence the same way this check does
  (`detect-checkpoint-evidence --skip-fanout-ledger-check`) and the current-head
  `gate-evidence` status, and when the evidence is genuinely satisfied but the
  status is stuck non-green it re-fires the run that posted the stale status
  (`gh run rerun <id>`, id parsed from the status `target_url`). The head has not
  moved at merge-readiness, so the replayed payload targets the correct SHA and
  the rerun re-evaluates LIVE (now-satisfied) evidence to `success`. It is
  fail-closed and test-pinned: when the evidence is genuinely NOT satisfied it
  re-fires nothing, so a real "verdict missing" head keeps failing closed. The
  reconcile never posts a status itself — it only re-triggers the trusted-base CI
  run. (There is no `pull_request_review_thread` Actions
  trigger, so thread resolve/unresolve is not itself a re-fire event; a
  newly-appearing unresolved thread arrives via a submitted review or a review
  comment, both of which do re-fire. One narrow residual remains: a bare
  "Unresolve conversation" UI action on an already-resolved thread, with no
  accompanying review or comment, fires only that non-triggerable event and so
  does not re-fire the check — bounded by the maintainer-gated merge, and
  re-caught on the next review or comment.) The `gate-evidence`
  context itself is always an explicit commit status posted to the resolved PR
  head SHA (not the triggering job's own check-run, which for
  review and comment event types would land on the wrong commit — the base
  branch's latest for review events, the default branch's for issue_comment). This is what closes the ready/merge bypass —
  a direct GitHub API call (MCP/REST, web UI, a raw `gh` invocation outside the
  hook) skips the client-side path entirely but still cannot merge without a
  green `gate-evidence` check **once branch protection on `main` requires it**.
  Until an operator adds it to branch protection, the check runs and reports at
  pre-merge/verdict points on every non-draft PR but does **not** yet block
  merge — it is reporting-only in that window. The workflow is two jobs
  (`docs/decisions/0076-gate-evidence-reporter-split-always-settles-required-status.md`,
  amending 0043): `gate-evidence-runner` keeps `cancel-in-progress: true` for
  waste-avoidance but no longer posts the status itself, and a non-cancelling
  `gate-evidence-reporter` job always settles the required check at the final
  head after a burst of review/comment events, closing the gap where the
  LAST-triggered run of a burst was itself cancelled and no run posted a
  status. `merge-pr.mjs` surfaces this transitional-period recovery directly:
  when `gh pr merge` is blocked and the `gate-evidence` context is not
  `success`, its error names the required check and the same recovery —
  complete/re-run the latest Gate-evidence run, or edit the current-head
  verdict comment — instead of only GitHub's generic block message.

### Required-context invariant: the status, never the job

<!-- rule: MERGE-PRECOND-REQUIRED-CONTEXT-IS-STATUS -->
`MERGE-PRECOND-REQUIRED-CONTEXT-IS-STATUS`: the `main` branch-protection
required status is the `gate-evidence` commit status and MUST NEVER be either
Gate-evidence job (`gate-evidence-runner` or `gate-evidence-reporter`). The
detector job keeps `cancel-in-progress` (docs/decisions/0076), so a chatty loop
supersedes and cancels several `gate-evidence-runner` runs; the reporter's group
is non-cancelling so it never kills a RUNNING reporter, but a still-queued
reporter superseded by a newer one is cancelled too. Each cancelled run of either
job leaves its own `cancelled` check-run in the rollup and drives
`mergeStateStatus` to `UNSTABLE`. Requiring the always-settling `gate-evidence`
commit status (which the reporter's surviving RUNNING instance posts
definitively at the final head) — and never a job — keeps those superseded
cancellations from ever permanently blocking a merge. This is why an `UNSTABLE`
whose only non-success entries are superseded Gate-evidence job cancellations
(runner or reporter) is cosmetic noise, not a block, while the `gate-evidence`
status is `success`: `classifyBenignGateEvidenceUnstable`
(`@dev-loops/core/loop/copilot-ci-status`) labels it benign for `loop info` so
an operator is not misled by GitHub's raw `UNSTABLE`. No committed
branch-ruleset/config-audit surface exists in this repo to assert the
required-context set against; when one is added, it MUST assert the required
contexts include `gate-evidence` and exclude both `gate-evidence-runner` and
`gate-evidence-reporter`.

The server-side check verifies the same visible, comment-derived verdict fields
the client-side tooling does (including the light-mode inline exception,
[Gate Review Sub-Loop Contract](./gate-review-sub-loop-contract.md#light-mode-inline-acceptance-under-threshold-micro-prs),
and the [review-proportionality non-overridable floors](./gate-review-sub-loop-contract.md#review-proportionality-dispatch-plan-non-overridable-floors)
layered on top of it — the risk-path and size-outcome floors are recomputed from the
merge-base diff via plain `git`/`check-size-budget.mjs` reads, so this re-verify runs
even under `--skip-fanout-ledger-check`, which only scopes down the machine-local
ledger/provenance layer, not this one). It does
**not** re-verify the deeper fan-out
findings-log ledger/provenance layer (`gates.requireFanoutEvidence` /
`requireFanoutProvenance`): that evidence lives in a gitignored, machine-local
`tmp/` file (under the main worktree, #2315) only the machine that ran the review has on disk, so a stateless CI
runner can never see it. That layer remains client-side/self-reported-only — the
same "not un-forgeable" caveat the sub-loop contract already documents.

`--skip-fanout-ledger-check` is therefore a **deliberate, justified exception**,
not an accidental gap: the fan-out findings-log ledger at
`tmp/gate-findings/<slug>/pr-<n>/<gate>-<head>.json` is inherently machine-local,
so scoping the CI check down to what a stateless runner CAN verify is the only
correct posture. Making CI read the machine-local ledger is a non-goal. The
local write-skip this CI skip cannot cover — a `fanout_fanin` verdict posted
without the durable ledger ever being written — is closed instead at the
**verdict-post refusal** in `scripts/github/upsert-checkpoint-verdict.mjs`: a
`requireFanoutEvidence` `fanout_fanin` verdict-post fails closed unless that
canonical durable ledger for the reviewed head already exists on disk, refusing
at post time (earlier than the local pre-merge hook, `detect-checkpoint-evidence`)
via the SAME `ledgerExists` predicate the merge-time check uses. So the durable
write is unbypassable locally, and CI never claims green on a layer it genuinely
cannot see.

### Angle-pool / fanout-groups / mandatory-angle config resolves from the PR HEAD, not the invoking checkout (#1972)

The ledger BYTES for the layer above (`tmp/gate-findings/<slug>/pr-<n>/<gate>-<head>.json`)
are read from ANY checkout (`resolveLedgerCheckouts` — main plus every worktree),
so a ledger written in the PR's own worktree is found even when the pre-merge
check runs from a different checkout. But the CONFIG that governs what counts
as a valid fan-out — the angle pool, `gates.fanout.groups`, and each gate's
mandatory angles (`resolveGateConfig`/`resolveGateAngleContract`/`resolveFanoutGroups`
in `packages/core/src/config/config.mjs`) — is a separate layer, and it resolves
from the **PR HEAD commit's committed `.devloops`**, not the invoking checkout's
disk file. `buildFanoutEnforcement` in `scripts/github/detect-checkpoint-evidence.mjs`
reads that layer via `git show <headSha>:.devloops` (trying the same
bare/`.yaml`/`.yml`/`.json` precedence the disk loader uses) and re-parses it
with `loadDevLoopConfig`'s `devloopsOverride` option, so a fan-out that ran
conformantly under a PR's own angle rename / regroup / pool edit validates from
ANY checkout — including a pre-merge `main` that predates the change — instead
of false-failing against the invoking checkout's stale angle names. `git`
worktrees of one repo share a single object store, so this works from any
checkout as long as the head commit was fetched into any of them; extension
defaults and `.pi/dev-loop/defaults` still come from the invoking checkout's
disk, only the `.devloops` primary-override layer is re-sourced from the head.

Resolution falls back to the invoking checkout's own config — never to a
looser or skipped check — when the head commit itself isn't resolvable locally
(never fetched anywhere sharing this `.git`) or its `.devloops` fails to
parse/validate; both fallback paths preserve exactly today's (pre-#1972)
enforcement. A genuinely non-conformant fan-out still fails closed under the
resolved config either way — this only changes WHICH config is authoritative
for the angle layer, never whether fan-out evidence/provenance/angle coverage
is enforced.

### Evidence writes and `gh pr merge` MUST be separate tool calls (#1172)

The PreToolUse Bash gate evaluates `gh pr merge` **before** the Bash tool call executes. A compound
command that both writes gate evidence (the findings-log ledger, `upsert-checkpoint-verdict`) and
merges in the same call is blocked at hook-evaluation time — the write never runs. This can look
like the ledger "vanished" between writing and merging; it was never written. The block message
names this when it detects an evidence-writing invocation in the same command string.

Documented pattern — **write, verify, then merge alone**:

1. Write the gate evidence (findings-log ledger / checkpoint verdict) in its own Bash call.
2. Verify it landed (e.g. `ls tmp/gate-findings/<slug>/pr-<n>/`) in a separate call.
3. Run the sanctioned merge wrapper (`node scripts/github/merge-pr.mjs …`) alone, with no other
   command chained via `&&`/`;`/newline; a raw `gh pr merge` is forbidden and, as defense-in-depth,
   still tripped by the same PreToolUse gate.

## Title markers

The PR title is a contract surface, so a merge-blocking marker in the title is enforced
deterministically (`findBlockingTitleMarkers` in `@dev-loops/core/loop/pr-title-markers`), not
just reviewed. `WIP` and `DRAFT` only count as blocking when the title uses one of four
sanctioned constructions — a genuine status claim, not a plain word match:

- bracketed: `[WIP]`, `[draft]`
- parenthesized: `(wip)`, `(DRAFT)`
- colon-suffixed: `WIP: add feature`, `draft: new module`
- standalone (the entire title, nothing else): `WIP`, `draft`

A hyphen, underscore, or space joining the marker word into a compound noun phrase names a
component instead of asserting status, and is exempt from every construction —
`draft-gate`, `draft_gate`, `draft gate`, `wip-branch` never flag; nor does a conventional-commit
scope that happens to share the marker word, e.g. `fix(draft): support x`. `DO NOT MERGE` and `🚧` (anywhere in the title) are matched directly rather than through the
four constructions. Only whitespace joins the words of `DO NOT MERGE`, so hyphen- or
underscore-joined spellings such as `do-not-merge` do not flag — case-insensitive throughout.

A dash-set-off trailing tag (`Fix login flow — WIP`) is deliberately not a construction: no
dash-based rule closes the tag without also reopening the compound-noun false positive for a
different dash character, so it stays unflagged; `WIP:`/`DRAFT:` remains one keystroke away.

The bracket/paren/colon constructions require their opening delimiter to sit at the start of the
title or right after whitespace — never directly after a letter, `/`, or `-`. This anchoring is
what exempts a conventional-commit scope, a path segment, and a scoped label from matching, and it
is also why a marker preceded by other punctuation with no space (`Fix bug,(draft)`,
`Fix login(wip)`) stays unflagged: the anchor is whitespace-only, not punctuation-only. The colon
construction additionally requires the colon to close the tag — followed by whitespace or
end-of-title, never another character — so `draft:latest` and `wip:branch` read as an identifier,
not a status claim.

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

A standing authorization is surfaced through the same per-run authorization signal the
rest of the loop already consumes (`resolveEffectiveMergeAuthorized`); sibling contracts
that require "explicit merge authorization for the active scope" are satisfied by that
signal and need no separate carve-out.

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

This makes human-gated merge an enforced repo invariant, not a per-run default an
explicit instruction can unlock.

### Size-budget merge gate (issue #1480)

An escalated or T1 PR (the `gates.size` outcome recorded on the `pre_approval_gate`
verdict — see [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md))
needs a **valid human approval** and **zero unresolved CHANGES_REQUESTED** before
merge, regardless of any standing merge authorization above. A Copilot-clean verdict
alone is never sufficient for these PRs — pairing with, not replacing, the ordinary
merge-authorization rule.

- The pure decision (`resolveSizeBudgetHumanApprovalRequired`,
  `@dev-loops/core/loop/size-budget-merge-gate`) requires human approval when the
  recorded size-budget `outcome` is `escalate` or `block`, OR the PR touches the T1
  tier (a T1 file is in the diff) — a plain `pass` outcome with no T1 slice carries no
  size-imposed requirement at all.
- "Valid human approval" is the same shared, head-pinned resolver the `merge_approval`
  gate uses (`verifyFreshHumanApproval`, `@dev-loops/core/loop/merge-approval` — see
  the **Fresh per-merge approval** bullet above), fed in as `humanApprovalSatisfied`:
  a genuine `APPROVED` review by the designated approver (the `--human-approved-by
  <login>` passed to the merge wrapper) on the current head SHA, OR — the solo-owner
  path, since GitHub forbids approving your own PR — a head-pinned operator comment
  marker `approve merge <headSha>` authored by that same `<login>`. A review or
  comment from any OTHER login does not satisfy it, and either path already excludes
  a Copilot/bot author and a stale (non-head-SHA) approval, so Copilot's own approval
  can never satisfy this gate.
  `resolveHumanReviewDecision` (same module, `reviewDecision === "APPROVED"`) is
  kept only as a back-compat fallback for the queue-driver caller, which has no
  comment context; the production `merge-pr.mjs` wiring
  (`evaluateMergePreconditions`) always feeds `humanApprovalSatisfied` from the
  shared resolver instead.
- **Fail-closed**: absent or unreadable size-budget evidence (a `pre_approval_gate`
  verdict posted without the `**Size-budget outcome/T1 slice**` fields — see
  `detect-checkpoint-evidence.mjs`), an unreadable T1-touch signal, an unknown review
  decision, or a nonzero/unreadable unresolved-CHANGES_REQUESTED count all require
  human approval — never treated as a silent pass.
- `resolveLifecycleState` (`@dev-loops/core/loop/lifecycle-state`) consults this gate
  IN ADDITION TO `resolveEffectiveMergeAuthorized`: when it is required, the lifecycle
  parks at `pre_approval_gate` (the existing human-approval handoff) instead of
  advancing to `merge`, even under a standing authorization. The agent must not merge
  such a PR — including via the sanctioned wrapper — until valid human approval
  satisfies it (a head-pinned `APPROVED` review OR a head-pinned `approve merge
  <headSha>` operator comment, per the shared resolver above), and it must never run
  a raw `gh pr merge`. The wrapper `scripts/github/merge-pr.mjs`
  itself refuses (precondition `size_budget_human_approval`) until that human approval
  is present.
- **The `pre_approval_gate` verdict carries POPULATED size fields, never null**: the
  gate-verdict procedure in [Copilot PR Followup](../copilot-pr-followup/SKILL.md)
  computes the size budget via `check-size-budget.mjs` and threads its JSON output into
  `upsert-checkpoint-verdict.mjs pre_approval_gate` via `--size-budget-json` as the
  preferred path on every post. `upsert-checkpoint-verdict.mjs` itself never posts a
  `pre_approval_gate` verdict with these fields null: when `--size-budget-json` is
  omitted, it auto-derives the size budget in-process (`evaluatePrSizeBudget` against
  the PR's base ref) or fails closed with an actionable error before posting anything,
  naming `--size-budget-json` as the escape hatch, if the base ref or diff cannot be
  resolved. Only a pre-existing verdict posted before this field set existed reads back
  with `sizeOutcome`/`sizeTouchesT1` `null` — absent size evidence, which fails closed
  per the bullet above.
- **This gate is also consulted LIVE on the authoritative pre-merge CI path**, not only
  inside `evaluateMergePreconditions`/the lifecycle state machine: `buildPreMergeGateCheck`
  in `scripts/github/detect-checkpoint-evidence.mjs` — the function the `gate-evidence`
  required CI check and `merge-pr.mjs`'s own gate-evidence probe both run — reads
  `preApprovalGateMarker.sizeOutcome`/`sizeTouchesT1` (remapping the latter to
  `touchesT1`) and records a pre-merge failure when
  `resolveSizeBudgetHumanApprovalRequired` requires human approval. Because this
  stateless surface has no single named approver (unlike `merge-pr.mjs`'s
  `--human-approved-by`), it derives `humanApprovalSatisfied` by trying
  `verifyFreshHumanApproval` for every distinct human login the fetched reviews/
  comments surface, so EITHER a head-pinned `APPROVED` review OR a head-pinned
  `approve merge <headSha>` comment from any one of them satisfies it — the same two
  paths the named-approver resolver accepts, without inventing a new authorization
  concept.

### `approval` — offer to assign a human at the handoff (opt-in)

When a repo sets `approval.enabled: true` in `.devloops`, the loop
does not just park silently at the human-merge stop — at the
`pre_approval_gate` / `waiting_for_merge_authorization` boundary it **offers**
to route the PR to a contributor (pairs with `autonomy.humanMergeOnly`: when
human-merge is enforced, the handoff names who should take it). Disabled by
default; no candidate sourcing when disabled.

```yaml
approval:
  enabled: true
  candidatesFrom: [codeowners, recent-committers]
  assignees: [alice, bob]
```

At the handoff boundary, resolve and surface candidates:

```sh
dev-loops gate offer-human-handoff --repo <owner/name> --pr <number>
```

This prints the deduped, ordered candidate list (priority:
`assignees` > `codeowners` for the touched paths (last-match-wins) >
`recent-committers` to those paths, PR author/bots excluded). It assigns no one.

**OFFER-only — the operator confirms the assignee** (auto-assigning without
confirmation is a non-goal). On confirmation, perform the action:

```sh
dev-loops gate offer-human-handoff --repo <owner/name> --pr <number> \
  --assign <login> --request-review <login>
```

which runs `gh pr edit --add-assignee` / `--add-reviewer` for the confirmed
human(s).

## Post-merge

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
- Sync the merged item's board Status to Done (issue #1458), run BEFORE worktree removal below:
  `dev-loops queue sync-status --repo <owner/name> --pr <number> --item <linked-issue> --logical-column done || true`
  (omit `--item` when the merged PR is itself the queue item — an unfilled/empty `--item` falls back to `--pr`; the
  `|| true` masks the residual usage-error exits the same way the archive step's does). `--logical-column done`
  resolves the Done column through `queue.statusColumns`, so a board that renamed Done still converges. Resolves the
  board from `.devloops` (`tracker.board`) relative to `cwd` — there is no `--repo-root` flag — using
  local `gh` auth, so it must run from the main checkout: the next step removes the worktree, leaving it with no cwd.
  Best-effort and NON-FATAL on a parsed invocation: a board that is not configured, an item not on the board, or any
  API failure exits 0 with a JSON result describing the skip instead of failing the merge; a usage/argument error
  still exits 1 and an invalid `--jq` filter exits 2.
- Remove merged worktree (canonical, `WORKTREE-CLEANUP`): `node scripts/loop/cleanup-worktree.mjs --repo-root <main> (--issue <n> | --pr <n>)`.
  See [Worktree usage guidance](./worktree-guidance.md#post-merge-cleanup).
- Archive long-done queue items (operator-induced, NOT a cron): `node scripts/projects/archive-done-items.mjs --repo <owner/name> || true`.
  Runs as part of this post-merge hook. It applies the configured `queue.archiveOlderThanDays` (default `7d`) and archives
  board items whose issue/PR has been closed at least that long. Best-effort: run it as a standard post-merge step but ignore
  any non-zero exit (a successful run that finds nothing to archive exits 0; a board/config-resolution/API error exits
  non-zero, which the `|| true` masks) — a failure here must never block merge completion. See
  [Projects Queue Contract](./projects-queue-contract.md#archiving-completed-items).
- Clean up stale branches

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Validation policy](validation-policy.md)
- [Stop conditions](stop-conditions.md)
- [PR Lifecycle Contract](pr-lifecycle-contract.md)
- [Checkpoint Verdict Comment Contract](./gate-review-comment-contract.md) — `GATE-COMMENT-VERDICT-VALUES`
- [Contract style guide](contract-style-guide.md)
