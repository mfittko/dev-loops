# Pre-push review contract

Canonical owner for the `pre-push-reviewer` role and its two bounded modes. Full
mode is the pre-PR review phase: a developer-briefed, fresh-context,
general-purpose review pass that runs before the first push and fixes findings
in-tree. Delta mode (see [Delta mode](#delta-mode)) reviews a gate act-list fix
before its push. Other docs MAY link this contract; they MUST NOT redefine it.
Full mode is unchanged by delta mode. The sections up to Delta mode describe full
mode.

## Phase position

<!-- rule: PRE-PR-BEFORE-FIRST-PUSH -->
`PRE-PR-BEFORE-FIRST-PUSH`: the pre-PR review MUST run after local implementation
is complete and committed, and BEFORE the first push of the branch and before
`node <dev-loops-package-root>/cli/index.mjs pr create`. Its fixes MUST be applied to the working tree, validated
with the narrowest justified check (re-checked after the final round), and
committed (a follow-up commit or an amend of the last implementation commit), so
the branch is pushed once, already cleaned and validated. In the `local-implementation`
loop it sits between the exit-validation commit (implementation-loop step 11,
`LOCAL-COMMIT-BEFORE-EXIT`, whose first push is deferred to here) and PR creation
(implementation-loop step 12). The phase applies to any session that pushes and
opens a PR, whichever route the startup resolver selected: a tracker-backed or
issue-less `--lightweight` (PR-body-as-spec) session on the local route (the review phase and the `pr create` record check both apply), and any
session on a GitHub-first route that creates the branch and PR itself. On the
GitHub-first routes the step sits before the first push and before `create-pr.mjs`
at `OPS-DRAFT-FIRST-PR` in [Copilot Loop Operations](copilot-loop-operations.md).
The guard: after the final round, the implementer MUST write the review record with `node <dev-loops-package-root>/cli/index.mjs loop pre-pr-review --verdict <clean|findings_fixed> --disposition <none|all_applied|rationale_recorded> (--body-file <file> --issue <n> | --no-linked-issue) --self-check-file <file>`, which reads the head from git and is the only writer. `node <dev-loops-package-root>/cli/index.mjs pr create` refuses with the typed error `pre_pr_review_missing` unless a valid record names the head given by `--head` (else the checked-out HEAD), or an ancestor head when every later change touches docs and tests under the repository classify rules. The head is the local branch or `origin/<head>` when only that exists, and a local branch and `origin/<head>` at different commits are refused. Only branch refs (`refs/heads/<head>`, `refs/remotes/origin/<head>`) count; a same-named tag never does. The only exempt path is a plan-doc promotion branch whose whole `base...head` diff is `.md` files under `docs/phases/`; contract and skill prose under `skills/` needs a record. A hand-built record fails its integrity check. The writer also gates on `PRE-PR-STALE-SURFACE-SWEEP` and `PRE-PR-DEVELOPER-SELF-CHECK`.
A session that opens no PR has no pre-PR step: a phase-doc-backed session that
merges locally, a follow-up session on a PR that already exists, or a session on
a Copilot-authored PR.

<!-- rule: PRE-PR-SIZE-CHECK -->
`PRE-PR-SIZE-CHECK`: the pre-PR review MUST run `node <dev-loops-package-root>/cli/index.mjs gate size-budget --base origin/<base>` on the local `base...HEAD` diff. When the whole-PR logic LOC is over the resolved default-tier `softLoc`, the developer MUST split the local branch before any PR exists, unless the branch's plan recorded a `PLAN-SIZE-BAND` split assessment for that slice (`oversizeJustification` on the plan-file path, the grill results comment on the tracker-first path). At or above `waiverLoc` the split stays mandatory. The one enforcement point is `node <dev-loops-package-root>/cli/index.mjs pr create`: before it creates anything, it refuses with `size_split_required_before_pr` at or above the resolved default-tier `waiverLoc`. An `unknown` size does not refuse, because the draft gate stays the authority (`PRE-PR-GATE-STILL-AUTHORITY`). The refusal has no override flag. The one exemption is a spike PR (ADR 0293): `pr create --spike-file <findings.md>` skips the refusal, stamps a no-merge marker in the PR body and keeps the size line advisory, and `pr ready-for-review` and `merge-pr` refuse a PR carrying that marker.

<!-- rule: SIZE-RUNTIME-PIN-ACCOUNTING -->
`SIZE-RUNTIME-PIN-ACCOUNTING`: Under the existing classifier precedence, runtime-pin basenames `.nvmrc`, `.node-version`, `.ruby-version`, `.python-version` and `.tool-versions` stay `unknown` for review invalidation and carry-forward. The size budget MUST match these basenames after separator normalization and exclude their changed lines from both unclassified-source accounting and logic LOC. The independent configured-tier refusal stays in force. A substantially-unclassified refusal MUST name its positive-line unknown contributors, excluding runtime pins, with at most five paths and a `+N more` suffix for the remainder. The size budget also excludes files under `.claude/hooks/_vendor/**` and the generated hook mirrors listed in `HOOK_BUNDLE_TARGETS` from unclassified-source accounting and logic LOC, matching the raw path without separator normalization; the hook mirrors' `packages/core` sources still count.

<!-- rule: PRE-PR-STALE-SURFACE-SWEEP -->
`PRE-PR-STALE-SURFACE-SWEEP`: before dispatching the reviewer, the developer MUST run `node <dev-loops-package-root>/cli/index.mjs loop pre-pr-review --scan [--base <ref>] [--body-file <file> --issue <n> | --no-linked-issue]` and MUST pass its `staleSurfaceHits`, `staleSurfaceTruncated` and `truncatedNeedles` in the review brief. The scan reuses the delta review's stale-surface scan over `base...HEAD` (base default `origin/<resolved base branch>`) and writes nothing. With `--body-file` and `--issue` it also compares the PR body's In scope, Acceptance criteria, Definition of done and Non-goals items with the linked issue body; a PR item missing from the issue and an issue item missing from the PR are hits (PR-side sites are `pr-body/<section>:<n>`, issue-side sites `issue-body/<section>:<n>`), and a PR with no linked issue (PR body as spec) omits both flags. Each `skills/docs/*-contract.md` file changed in `base...HEAD` that no row of the linked issue's valid matrix names in backticks yields a hit at site `issue-body/issue-matrix:<path>` (ADR 0301). A linked issue without a valid AC/DoD matrix yields one `issue-body/issue-matrix` hit, addressed by fixing the issue matrix or skipping that site with a reason. When the linked issue has no In scope section, the In scope comparison is skipped and the other sections are still compared. Any git error fails the scan, and so does an empty scan range (the merge-base of the base and HEAD equals HEAD). The record writer MUST rescan at the current head and refuses unless it gets `--body-file` with `--issue`, or `--no-linked-issue` (PR body is the spec); the two forms are mutually exclusive. It MUST refuse with `pre_pr_stale_surface_unaddressed` while a hit is neither fixed nor skipped with a non-empty reason in `--skips-file` (a JSON array of `{ "site", "reason" }`); a truncated scan needs a skip naming `stale-surface-hits-truncated`. The sweep is not gate evidence (`PRE-PR-NOT-GATE-EVIDENCE`).

<!-- rule: LOCAL-DEV-SIZE-STOP -->
`LOCAL-DEV-SIZE-STOP`: the developer MUST run the same `gate size-budget` check at each local commit. When the whole-PR logic LOC crosses the resolved default-tier `softLoc`, the developer MUST stop and hand back a split point instead of continuing, unless the branch's plan recorded a `PLAN-SIZE-BAND` split assessment for that slice. At or above `waiverLoc` the stop applies in every case.

## The review pass

<!-- rule: PRE-PR-ONE-FRESH-REVIEWER -->
`PRE-PR-ONE-FRESH-REVIEWER`: the developer MUST hand a mandatory REVIEW BRIEF to
exactly ONE fresh-context, general-purpose reviewer per round (a round-two
re-review runs one reviewer too; see `PRE-PR-BOUNDED-TWO-ROUNDS`). The brief is a
developer-authored prompt stating what changed, what to scrutinize, known risks
and tradeoffs, and where the implementation cut corners. The reviewer MUST NOT be
a fixed angle: it reviews holistically per the brief. This is distinct from the
single developer self-check (`LOCAL-DEV-SELF-CHECK-NO-FANOUT`), which the
implementer runs against the plan; the pre-push reviewer MUST be a separate
fresh-context agent. The reviewer returns findings only and MUST NOT edit the
tree; the implementer applies the fixes. The full-mode brief MUST name the
artifact paths the reviewer reads (the full-mode brief carries no `patchPath`)
and the read-only evidence rule (evidence is a file:line or test path:line read
from disk; the reviewer runs no tests or builds), and
MUST NOT prescribe `sed`, a pipe to `head`, or test execution.

The reviewer MUST run with the adversarial-enumeration checklist below.

### Harness-specific dispatch

The reviewer is dispatched per harness, always with the brief as the reviewer's
task and the config-resolved model (see below) passed only when non-null:

- Claude Code: dispatch the built-in `general-purpose` subagent type with the
  brief as its prompt and the resolved model as the Agent `model` parameter.
- Pi: dispatch one fresh subagent with the brief as its task (a general-purpose
  reviewer; the PR-bound `review` gate procedure does not apply). The model stays
  keyed on the `pre-push-reviewer` role.
- Codex: run `node <dev-loops-package-root>/cli/index.mjs gate resolve-role --role pre-push-reviewer --harness codex`
  from the target repo and consume only exit 0. Forward `nativeOverrides`
  unchanged to `collaboration.spawn_agent` with the brief and `fork_turns: "none"`.
  Omit absent fields; config or native rejection stops dispatch without fallback.
  Follow [Generic Codex dispatch](main-agent-contract.md#generic-codex-dispatch)
  for role/setup reads and source-worktree qualification. This is a routine role,
  never a lifecycle fan-out angle.

### Adversarial-enumeration checklist

For any new or changed filesystem, parse, or diff seam the brief MUST direct the
reviewer to enumerate, at minimum:

- errno classes (missing, permission, not-a-directory, already-exists)
- symlink handling for both a file target and a directory target
- rename and move across the seam
- empty input and empty file
- malformed input (for example a malformed heading in a parsed doc)
- path normalization (relative, absolute, `..`, trailing slash)

This list is the floor. A seam with other adversarial surface obliges the brief
to name it too.

## Reviewer model (harness-agnostic, config-resolved)

<!-- rule: PRE-PR-MODEL-CONFIG-RESOLVED -->
`PRE-PR-MODEL-CONFIG-RESOLVED`: on Codex, both modes MUST use the role selector above,
which resolves model and effort together from `models.harnesses.codex.roles` or
`.tiers` with shared `models.roleTiers`; no legacy concrete values are borrowed.
On Claude/Pi the pre-push reviewer's model, in both modes, MUST be resolved
through `resolveRoleModel(config, { role: "pre-push-reviewer", harness })` from
`@dev-loops/core/config`. No model literal is hardcoded in this phase's prose,
tooling, or dispatch. The resolved model MUST be passed to the dispatch only when
it is non-null (the existing tier-at-dispatch contract); a `null` resolution
passes no override and inherits the session model. Operators opt into a concrete
strong model per harness in `.devloops` via `models.tiers.<alias>.<harness>`
mapped through `models.roleTiers.pre-push-reviewer` (or a direct `models.roles`
override). Each harness value MUST be a model token that harness's dispatch
accepts. On the Claude Code harness the Agent-tool `model` enum accepts only
`sonnet|opus|haiku|fable`, so an operator opting into Fable sets `fable` (the
underlying model identity is `claude-fable-5-1`).

## Findings are ephemeral

<!-- rule: PRE-PR-EPHEMERAL-NO-ARTIFACTS -->
`PRE-PR-EPHEMERAL-NO-ARTIFACTS`: the pass MUST be ephemeral. Findings are applied
directly to the working tree and then live and die in the pass. It MUST NOT
create a pull request, a comment, a review thread, or a Copilot round.

## Bounds

<!-- rule: PRE-PR-BOUNDED-TWO-ROUNDS -->
`PRE-PR-BOUNDED-TWO-ROUNDS`: the pass MUST NOT exceed two internal rounds and
MUST NOT run more than one general-purpose reviewer per round; after at most two
rounds the branch is pushed once. It MUST NOT fan out to multiple reviewers. The
round-two re-review verifies the applied fixes with a fresh-context reviewer: the
same reviewer continued when the harness supports agent continuation, otherwise
one new fresh-context dispatch.

## The fan-out gate stays the authority

<!-- rule: PRE-PR-GATE-STILL-AUTHORITY -->
`PRE-PR-GATE-STILL-AUTHORITY`: the pre-PR pass is a cheap pre-filter, not a
replacement for the gate. After the push, the full fresh-context fan-out
`draft_gate` and `pre_approval_gate` lifecycle MUST run unchanged and remains the
authority for merge readiness.

<!-- rule: PRE-PR-NOT-GATE-EVIDENCE -->
`PRE-PR-NOT-GATE-EVIDENCE`: the pre-PR pass is NOT a lifecycle-gate fan-out. It
MUST NOT produce gate evidence: no `resolveGateAngles` run, no fan-in disposition
ledger, no gate verdict comment.

## Delta mode

Delta mode is one fresh holistic review of a gate act-list fix or of a
Copilot-thread fix before that fix is pushed. It checks the cumulative fix delta
against the act items the fix claims to resolve. It resolves the same `pre-push-reviewer`
role and tier as full mode (`PRE-PR-MODEL-CONFIG-RESOLVED`) and uses the same
harness dispatch. There are two delta sources: the gate judge's act list, and
the thread route, which takes the captured set of unresolved review threads
(`capture-review-threads --unresolved --bodies` output, or `list-review-threads --unresolved-only` output, passed with `--threads-file` in
place of `--act-list`, with `--repo` and `--pr`). On the thread route each
unresolved thread is one act item and its `ref` is the `threadId`. With no unresolved thread, the pulled `--fixer-plan`'s operator focus `round` is the one act item (`ref` `operator-focus`), a `commit_only` emission with neither refuses, and the `--phase full` emission passes the same `--operator-focus-file`, so a record reviewed against another round refuses. The
deterministic checks live in `@dev-loops/core/loop/pre-push-delta-review`; the
dev-loop coordinator ran them through the `loop pre-push-delta` command, which slice D2 of issue 2937 removed.

The dev-loop coordinator owns delta mode, because it dispatches the Phase 4
fixer and owns the push. The sequence below is the retired `commit_only` route, which the later slices of issue 2937 delete; a gate fix pass now emits a full order (ADR 0337):

1. The dev-loop coordinator emits a `commit_only` fixer work order from the act
   list with the invocation in
   [gate contract Phase 4](gate-review-sub-loop-contract.md#phase-4--fix) and
   dispatches the printed `dispatchPayload` unchanged (ADR 0106). The fixer
   commits the fix, writes the site coverage record to the work order's outputRef
   and hands back the commit SHA unpushed. The
   coordinator passes that record to the check with `--site-coverage` and the emission's
   canonical `--fixer-plan` on both ACT and THREAD routes, including a no-commit
   handback. Both flags are mandatory for ACT coordinator input and result recording;
   omission of either or both refuses. Every fixer emission
   in delta mode uses the PR head (`headRefOid`), never the local candidate
   head, because the emitter pins the GitHub PR head and the local fix commits
   descend from it.
2. The dev-loop coordinator builds the reviewer input with the retired delta checker
   with both flags above on either route. On the ACT route it requires
   `--findings-log <the reviewed gate round's findings log>`; the thread route takes no
   `--findings-log`. It passes `--pr-head <the full PR head SHA just read from GitHub>` to
   the check. Handle authenticated `no_commit` or `head_moved` outcomes first:
   the matching sequence is closed (the payload's `reason` says the marker is removed and
   the push of HEAD and the full gate round follow) and `nextStep: push_to_gate` routes to the full
   gate path, carrying open threads and their full bodies as the full round's
   hash-bound `--known-findings` input, without a live-head-baseline Delta. An unresolved
   gate-authored thread can still block admission to that round; recovery admission is a
   tracked `known_gap` in the [fix-loop state graph](https://github.com/mfittko/dev-loops/blob/main/docs/fix-loop-state-graph.md). Dispatch no delta reviewer
   and emit no `full` fixer for these closure outcomes. Otherwise dispatch one fresh delta reviewer for the current worktree head,
   briefing it that it MUST NOT push (`PRE-PUSH-DELTA-PUSH-AUTHORITY`); the brief also names `input.patchPath`, `input.evidenceRule` and `input.sealCommand`. The input run takes the absolute result path as `--result-path`, and the brief names that same absolute `--result` path. The delta reviewer writes its `DeltaPrePushReviewResult` (copying `runId` from `input.resultShape` unchanged) to that path with the file-write tool, then seals it with `input.sealCommand`. On Claude Code the coordinator then joins the delta reviewer with `node <dev-loops-package-root>/cli/index.mjs gate wait-for-units --artifact <hand-back path> --after <reference path> [--timeout <seconds>]`, passing the reviewer's `--result` path and, as the reference, the `input.patchPath` file the input run wrote before dispatch (`COORDINATOR-SINGLE-CHILD-JOIN`; a stale `--result` file older than the reference never satisfies the join). That join returns once the result file parses, which can be before the reviewer seals it. Step 3 runs the `--result` check; on `evidence_unsealed` the coordinator waits for the reviewer's hand-back to name the seal output (the completion notification is the sanctioned wait for this one case) and re-runs `--result`, and a second `evidence_unsealed` re-runs the input run with a fresh `--result-path` before re-dispatching the reviewer; that re-run uses one of the three delta invocations (`COORDINATOR-SINGLE-CHILD-JOIN`).
3. The coordinator runs the CLI `--result` check (no `--findings-log`; only the input run
   reads it), and follows its `nextStep`. Both routes again pass `--fixer-plan`
   and `--site-coverage`; the ACT route also passes `--repo <repo> --pr <pr>` to the `--result` and `--handback` runs (the coordinator input run reads the target from `--fixer-plan` when they are absent), so a PR body edit can clear a residue finding with no site. The THREAD route retains `--threads-file`, `--repo`,
   `--pr`, `--baseline`, `--result` and `--invocation`; its result still carries no ACT binding. On `nextStep: fix_and_rereview`,
   it dispatches a fresh fixer again, commit-only, and returns to step 2. It
   emits a new work order with `--delta-result <result>` at the PR head.
   That fixer receives the delta result's `not_resolved` and `cannot_verify` act
   refs with their evidence, plus the result's medium-or-higher `newFindings` and every
   `residueOf` finding at any severity (residue is exempt from the
   medium-or-higher and regression-range limits).
   When the coordinator ends the sequence instead of re-dispatching (for example every remaining `not_resolved` or `cannot_verify` act ref is operator-deferred), it pushes the committed fix commits (`PRE-PUSH-DELTA-PUSH-AUTHORITY`). The push ends the sequence and the next full gate round judges the commits.
   On the thread route the coordinator emits the commit-only re-dispatch with
   `--threads-file` and without `--delta-result`. The emitter attaches the head's
   delta record as the `delta-result` read. The record carries item ref/status
   pairs and the `findings[]` the fixer must act on (medium-or-higher
   `newFindings` without `residueOf`, and open residue); the emitter renders
   them as act items (`deltaFindings`, ADR 0235, `docs/decisions/0235-ci-failure-source-and-delta-findings-intake.md`).
   A CI failure is a fourth fixer-order source (`--ci-file`, full phase only, no delta route).
   On `nextStep: rereview_current_head`, the result is stale for the current
   head; the coordinator returns to step 2 without a fixer.
   When the `--result` check refuses a `locally_clear` result only for unaddressed stale-surface hits, the refusal arrives as `nextStep: fix_and_rereview` when the result is fresh and the invocation is below the bound (`DELTA_MAX_INVOCATIONS`). At the bound the refusal is `bounded_out` with `nextStep: push_to_gate` and step 4 applies, and a stale result follows the `rereview_current_head` rule. The case is identified when every `errors[]` entry starts with the `PRE-PUSH-DELTA-RESULT: locally_clear leaves stale-surface hits unaddressed` text. For that case this rule overrides the `fix_and_rereview` fixer dispatch of the previous sentence: the owner of the next action is the delta reviewer. The coordinator re-dispatches a fresh delta reviewer with a re-review demand to clear each hit with a `newFindings[]` entry that names its file; a skipped `siteCoverage[]` site counts only when the original fixer handback already records it. It then re-runs the `--result` check with the next invocation, keeping the original canonical `fixer-emit-plan.json` as `--fixer-plan` and the original fixer's handback as `--site-coverage`. A keyed `planPath` from a same-head re-emission, and that emission's no-commit handback, never feed step 2 or the no-commit close below. A fixer is dispatched only when the result names a fix to make. When a keyed fixer commits, HEAD moves past the original handback, and the exit is a canonical `commit_only` re-emission without `--delta-result`.
4. On `nextStep: push` (`locally_clear`) or `nextStep: push_to_gate`
   (`bounded_out`), it emits a `full` work order
   and dispatches the fixer to push the candidate and wait for CI. The fixer writes no handoff
   and posts no reply. `verify-fixer-disposition.mjs --repo <owner/repo> --pr <n> --head-sha <sha> --fixer-plan <plan> --construct`
   writes the handoff to the work order's outputRef, and the same command without `--construct` then replies to each
   gate thread with the fixing commit and resolves it after CI settles. On
   `locally_clear`, the verifier resolves each thread. On `bounded_out`, it
   resolves only the threads of act items with status `resolved`. For
   `not_resolved` and `cannot_verify` items, it replies with the residual delta
   status and leaves the thread unresolved. The fixer MUST NOT mark these
   residual threads `tackled`; its handoff disposition records them as
   `deferred`. In a full-phase order, the verifier's `--construct` step writes that
   `deferred` entry and its normal step posts the residual reply. On the thread route the emitter attaches the head's delta record
   as a `delta-result` required read to the work order when a delta record exists for the head (a retired `commit_only` route read), so this residual-thread
   rule applies to thread sources through that read.

   A round in which the `commit_only` fixer makes no commit writes a minimal baseline-headed
   handback at its outputRef. The no-commit close left with the delta checker, so the coordinator
   runs no close step for it. No delta reviewer runs and no delta decision record is
   written, and a full emission is the normal gate fix path. The coordinator then posts each declined or deferred
   thread reply directly with `reply-resolve-review-thread.mjs --disposition rejected|deferred` at the unchanged head. That
   helper refuses only a `fixed` reply, so no full-phase refusal is bypassed. The fixer's handback check does not apply to a
   no-commit handback. When a pushed commit moves the head past the baseline, `gate close-sequence` closes the sequence marker with `HEAD_MOVED`. No marker needs hand deletion.

   After a pushed candidate X is contained by live H, the disposition verifier can
   deliver open threads at H while preserving X's authenticated report and Delta.
   It checks historical root ranges and every intervening commit before delivery.
   A merge of the base branch between X and H passes when `fixerEmitCarryAccepts`
   proves it, X..H holds no PR-own non-merge commit and the site file is
   unchanged (ADR 0330).
   `thread_site_changed` or `thread_site_unverifiable` names the open thread for
   the full `pre_approval_gate` input on a ready PR; on a draft PR it names
   `gate close-sequence`, then the next `draft_gate` round with the thread in
   `--known-findings`. LEFT-side or missing coordinates,
   deleted/binary files and nonlinear history use this conservative fallback.
   Current-head CI and the existing draft boundary still apply. An unresolved
   gate-authored thread can still block admission to that full round; recovery
   admission remains a tracked gap in the [fix-loop state graph](https://github.com/mfittko/dev-loops/blob/main/docs/fix-loop-state-graph.md).
   No carried disposition is a gate verdict.

Each delta review, including a re-review of the current head, consumes one
invocation. The dev-loop coordinator owned the invocation count and passed it to the
retired `loop pre-push-delta --invocation` flag monotonically, starting at 1 for
each sequence.

ACT input retains raw `siteCoverage` unchanged, including kind, reason and test fields;
normalization is only a validation view. Input, `resultShape`, result and decision carry
identical `coverageProtocol: "pulled_commit_only_v1"`, raw semantic `siteCoverageDigest`,
exact `handbackBytesDigest` and `origin: {workOrderRef, workOrderDigest, executionIdentity}`.
The reviewer copies that tuple unchanged. Input and result recording authenticate the
canonical current plan/output, original pull, emitted materialization bytes (against the
plan and pull receipt hashes and the trailing Work order JSON block, with no re-render),
ACT source, branch, baseline and candidate. Result recording recomputes the expected tuple; any
missing, partial or altered binding refuses before the invocation-three fallback.
A matching stale result retains ordinary bounded-out behavior. Membership-only callers
check structure without claiming source authentication; optional completion separately
checks the genuine origin/report bytes against result and decision. Digest-only old
records stay legacy and unchanged. The emitted `--handback` check remains write-free
validation without attestation. THREAD and the reviewer-only route (ADR 0255) carry no ACT binding. See ADR 0150 in the
[decision records](https://github.com/mfittko/dev-loops/tree/main/docs/decisions).

A gate fix pass for a judge act list or for the captured set of unresolved review threads pushes in the full phase, and no delta review runs: the next gate round at the pushed head judges the fix (ADR 0337). The delta rules below describe the code that the later slices of issue 2937 delete.

The decision field list below is the THREAD/legacy base; ACT decisions additionally carry the binding above, except on the reviewer-only route.

The retired delta checker `--result` run recorded its decision as local evidence at `<tmp-root>/gate-delta/<reviewBaselineHead>.json` (`reviewBaselineHead`, `candidateHead`, `actSetId`, `invocation`, `outcome`, `nextStep`, `items: [{ ref, status }]`, `bodySha256` and `bodyTarget` (`{ repo, pr }`) when a residue has no site, the run knows the PR target (`--repo`/`--pr`, or the authenticated `--fixer-plan` target) and the PR body read succeeds, and `findings[]` when non-empty, at most 20 entries with `summary`, `evidence`, `residueOf` and `site` cut at 2000 characters; the last write for a baseline wins). The `--reviewer-only --cover-uncovered` result run records one cover record per verified act ref at `<tmp-root>/gate-cover/<cap-round head>-<hash of the ref>.json` (`capHead`, `ref`, `candidateHead`, `actSetId`, `invocation`, `outcome`, `nextStep`, `status`, and `findings[]` when non-empty: the same capped list a gate-delta record seals, a lifecycle refusal first, then the reviewer's findings, at most 20, which the cover-run stdout prints too) and no baseline record. The run never replaces a gate-delta record or a cover record that is clearing, unsealed, unreadable or at the last invocation (an unsealed or unreadable one is never counted either); the next invocation supersedes only its own sealed non-clearing cover record below the bound, under the sequence lock and only when every cover record of the run still equals the snapshot its checks read (a concurrent write refuses with the input-run rerun and writes nothing) (ADR 0317). The run without `--result` writes only the cumulative patch; the `--handback` run writes nothing. The emitter and the reply wrappers enforce two refusals from the record. `emit-fixer-work-order.mjs` refuses `--phase full` unless a clearing delta decision exists for the PR head: an act-list source needs `--delta-result`, a record for the PR head with `nextStep: push` or `nextStep: push_to_gate` and the result's `actSetId`, and result item ref/status pairs equal to the record's items, a threads source needs a record for the PR head whose decision is `nextStep: push` or `nextStep: push_to_gate` and whose item refs equal the thread ids in the threads file (a record ref that is no thread, or a thread with no record item, refuses), and a record with any other `nextStep` refuses either source. The coordinator emits `--phase commit_only` first, then runs the delta review. A fixed reply (`reply-resolve-review-thread.mjs`, `reply-resolve-review-threads.mjs`, and the `Fixed in commit` reply of `verify-fixer-disposition.mjs`) is refused for a thread that a record marks `not_resolved` or `cannot_verify`, when the fixing commit is the record's `candidateHead` or lies in `reviewBaselineHead..candidateHead`. A thread matches an item by `threadId` or by the fingerprint of its `dev-loops:finding` marker.

<!-- rule: GATE-EXEC-EVIDENCE-SEALED -->
`GATE-EXEC-EVIDENCE-SEALED`: a delta result file that a gate tool consumes MUST be bound to the run that produced it. Other evidence files (findings logs, ledgers, judge decisions, dispositions) stay unsealed until slice 2 of issue 2892. The producer run records `<tmp-root>/evidence-runs/<key>.json` with the expected identity fields (`@dev-loops/core/loop/evidence-seal`); the reviewer seals its file with `scripts/loop/seal-evidence.mjs` (sha256 of the exact bytes); the consumer verifies before use. For a delta result the key is `delta-<reviewBaselineHead>-<candidateHead>-<runId>`, where the input run mints `runId` (16 lowercase hex characters) and returns it in `input.runId` and `input.resultShape`, and the result carries it. Both heads MUST be canonical full lowercase commit SHAs, or the key derivation refuses with `evidence_malformed`. The expected fields are `reviewBaselineHead`, `candidateHead`, `actSetId` and `runId`. The input run requires `--result-path`, and the record holds that path's real path, and sealing any other path refuses with `evidence_foreign_run`. The delta checker `--result` run and `emit-fixer-work-order.mjs --delta-result` MUST refuse with one typed reason: `evidence_malformed`, `evidence_run_missing`, `evidence_unsealed`, `evidence_digest_mismatch` or `evidence_foreign_run`; each verifies the result before it uses any of its fields and digests the exact bytes it parsed. The input run records the newest `runId` per baseline and candidate head pair (`evidence-runs/current-delta-<baseline>-<candidate>.txt`), and a sealed result of a superseded run refuses with `evidence_foreign_run`. `--result-path` MUST be an absolute path. A refusal routes to re-running the producer, never to a manual repair of the file: a re-run of the input run mints a new run id and opens a new unsealed record, and the old seal stays final. A seal is final: sealing an already sealed run refuses with `evidence_foreign_run`, and a consumer path whose real path differs from the sealed real path refuses with `evidence_foreign_run`. `seal-evidence.mjs --kind delta` first runs the sequence-free shape and outcome checks and refuses `evidence_malformed` with nothing sealed, so the reviewer corrects its file and reseals. This rule replaces interim rule 37, which barred hand edits of reviewer evidence.

<!-- rule: PRE-PUSH-DELTA-INPUT-CAP-CHAIN -->
`PRE-PUSH-DELTA-INPUT-CAP-CHAIN`: the delta input accepts a `--findings-log` whose `headSha` differs from the baseline when the baseline is a base-only merge of that head, equals the end of the sealed clearing chain that starts at that head (or at a ledgerless base-only merge of the log head or of a chain end, the ADR 0218 seeding), or is a base-only merge of a chain end. The CLI resolves `--baseline` to a full SHA before the chain walk. On the chain path the baseline and every head the chain visits after the log head (each seeded merge, record candidate head and chain end) MUST have no draft_gate findings log of the PR, because a later full round supersedes the cap-round log. Chain ends and visited heads come from `clearingChainWalk` (the walk behind `clearingChainLastCandidates`, which the fixer emitter uses) and need the log's `repo` and `pr`, which MUST equal the authenticated fixer plan target, or on the reviewer-only route the `--repo` and `--pr` flags (ADR 0255); without either the chain path refuses. An unsealed record, a chain that does not reach the baseline, a merge that is not base-only, on the chain path a log without `repo` or `pr` (it has no chain ends; the base-only merge of the log head needs neither), a log whose `repo` or `pr` differs from the target, and any error or `.devloops` load failure refuse the log. The refusal names the remedy: pass the log recorded at the baseline, or the cap-round log whose sealed clearing chain reaches the baseline. ADR 0225 amends ADR 0218 and ADR 0197 for this seam.

<!-- rule: PRE-PUSH-DELTA-RESULT -->
`PRE-PUSH-DELTA-RESULT`: the reviewer MUST return a `DeltaPrePushReviewResult` bound to the baseline, candidate and act set, with a status and evidence for every claimed act item. The `actSetId` MUST equal the sequence's id, which hashes each act item's ref, angle, severity, file, line and summary (a thread-route item omits the summary, a body excerpt that varies with `--body-max`; the operator-focus item keeps its summary), plus its remediation scope fields (`authorizedRemediation`, `defectClass`, `siteQuery`, `defectKind`, `acceptedForms`, `rejectedForms`, `statedSurfaces`, `siblingRemediations`) when present. Each act item ref appears once, in the act list and in the result. The status MUST be `resolved`, `not_resolved` or `cannot_verify`; `cannot_verify` stays distinct from `not_resolved`. Every `evidence[]` entry, for act items and new findings, MUST be a non-empty string, and each list MUST be non-empty. `widenedReads[]` is required, and empty when nothing was widened; each entry MUST be an object `{ path, reason }` with non-empty strings, never a bare path string. A result with a missing or unknown status is rejected. The status `resolved` requires two conditions: the reported defect is gone, and the applied remedy introduces no new finding of severity medium or higher. Conformance to `authorizedRemediation` alone is not enough; when the remedy itself causes a defect, the reviewer reports it as a `newFindings[]` entry whose evidence cites the remedy text. A result of `locally_clear` MUST be refused while a `staleSurfaceHits[]` entry has neither a `newFindings[]` entry that names its file (as a whole path token: `docs/README.md` and `.claude/skills/x.md` do not name `README.md` and `skills/x.md`) nor a skipped site (with a non-empty `reason`) in `siteCoverage[]` whose site is its bare file, or its file with a `:line` or `:start-end` suffix that covers the hit's line (a skip recorded for another line of the file does not address it); a truncated list (`staleSurfaceTruncated`) is addressed the same way by an entry that names `stale-surface-hits-truncated`; this holds on the act-list route, on the thread route and on the reviewer-only route.

```text
DeltaPrePushReviewResult {  // Complete THREAD shape; an unsealed or runId-less result is refused under GATE-EXEC-EVIDENCE-SEALED.
  reviewBaselineHead, candidateHead, actSetId
  runId  // copied unchanged from input.resultShape
  actionableItems[] { ref, status: resolved | not_resolved | cannot_verify, evidence[] }
  newFindings[] { severity, summary, evidence[], residueOf?, site?, skipReason? }
  widenedReads[] { path, reason }
  outcome: locally_clear | needs_fix | bounded_out
}
```

Plan-bound ACT results (not the reviewer-only route) additionally require top-level `coverageProtocol`, `siteCoverageDigest`,
`handbackBytesDigest` and `origin`, copied unchanged from `input.resultShape` as defined above.
The recorded decision and stdout carry that same ACT-only tuple; THREAD cannot claim it.

Pre-push Delta validation and ordinary commit-only coverage remain strict. After the push, full
completion may retain explicitly skipped residual input forms only under the authenticated
decision/status checks in `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` in the
[Gate Review Sub-Loop Contract](./gate-review-sub-loop-contract.md#finding-threads-and-disposition).
The clearing decision must name the actual pushed candidate even when the third result is
stale. Each ACT member still requires its own strict or explicitly residual coverage. Aggregate
repeated refs and every matching fingerprint on the authenticated root before choosing its single
disposition: all resolved means tackled; any residual means deferred/open without a Fixed reply.
A scalar fingerprint cannot narrow root membership, and distinct roots sharing a fingerprint each
need an entry. This completion exception supplies no lifecycle gate evidence.

After the push is confirmed and CI is green (ADR 0166), the full worker runs
`--construct` for every full-phase order (ACT and THREAD). For optional authenticated typed completion (ADR 0149), it uses
`verify-fixer-disposition.mjs --repo <owner/repo> --pr <n> --head-sha <sha> --fixer-plan <plan> --construct`
before normal verification. Follow the complete source,
prior commit-only provenance, raw coverage identity and live-root checks in
`GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`; retain original Delta baseline A independently of full
authority/live candidate B. Construction writes only its own report and does not finish delivery.
Normal verification and `--check` authenticate that same source. Ordinary ACT/full emission now
requires the immediate genuine commit-only plan/pull/raw report and both complete modern result
and clearing-decision bindings. It preserves raw coverage and fixing F, checks clean committed
candidate B on the authority branch, and retains reviewed A as `authority.reviewBaselineHead`.
CLI/live PR head, Delta and push marker remain A; full order/ref/receipt name B. Locally-clear
results must be fresh B; invocation-three bounded-out results may remain at F while the decision
names B. Missing, partial or historical digest-only evidence refuses before replacement/grant.
Original A retirement is checked using its original execution timestamp before publication and
after awaited capture. Both emitted verifier commands use the absolute emitting script while
cwd remains the authority worktree. The constructor writes exclusively; an authentic existing
report is retried through normal/check, never removed and reconstructed. Legacy deliveries,
pre-push Delta policy and compact dispatch payloads retain their existing behavior. Isolated
mixed-root tests establish command routing, not actual worker qualification or recovery.

Explicit full `operation: complete` requires the authenticated `completesExecution` root `{ executionIdentity, heads[] }` (pull refuses without it, and refuses `stale_dispatch` once the root execution's sequence is closed) and consumes already-reviewed delivery with empty source
selectors, exactly one authenticated ACT/THREAD source and only its own output authority.
Follow `GATE-EXEC-FIXER-DISPOSITION-BOUNDARY`: ACT completion input is mandatory, even when
all optional markers are absent; THREAD reports exactly its pinned IDs, built by `--construct`,
without ACT/history. Preserve bootstrap/hash checks and immutable output; perform no source
validation, stage, commit, push, new Delta or counter reset. Complete task prose overrides
generic guidance and quoted JSON task fields without rewriting that evidence. Consumer
support does not enable emission or qualify a fresh worker: ordinary producers still emit
`fix`, and producer eligibility/publication and runtime proof remain later work.

The explicit `legacyRevalidation.origin: "legacy_revalidated"` consumer exception in
`GATE-EXEC-FIXER-DISPOSITION-BOUNDARY` replaces only unavailable historical coverage hashes
after authenticating the original full archive/prompt/receipt and exact raw prior handback.
Both historical hashes and all modern binding fields must be absent. Partial/current bindings
refuse; the commit-only origin triple remains unchanged. Require the exact historical full
Work order JSON suffix, original/current ACT/Delta bytes and semantic identity, canonical clearing
bytes and fresh unchanged locally-clear candidate. Rerun the single supported literal through
bounded native Git and compare exact stdout bytes and all raw file/form coverage on every mode.
Original evidence stays unchanged. Current sealed authority asserts capture order; later producer
work must perform/prove pre-overwrite capture and optional-worker smoke. See ADR 0151 in the
[decision records](https://github.com/mfittko/dev-loops/tree/main/docs/decisions). This enables no producer or A1 recovery.

<!-- rule: PRE-PUSH-DELTA-PUSH-AUTHORITY -->
`PRE-PUSH-DELTA-PUSH-AUTHORITY`: during a gate fix sequence the delta reviewer and the `commit_only` fixer MUST NOT push; the full-phase fixer pushes the fix commit after a clearing or `bounded_out` delta record (`nextStep: push` or `nextStep: push_to_gate`, step 4 of the delta sequence), and the coordinator pushes the committed fix commits when it ends the sequence instead of re-dispatching a `commit_only` fixer at a sealed `fix_and_rereview` record (step 3, for example when every remaining open act ref is operator-deferred), which ends the sequence and routes the head to the next full gate round. `emit-fixer-work-order.mjs --phase commit_only` starts the sequence and writes the marker `<main worktree>/tmp/gate-delta/<reviewBaselineHead>.sequence`, whatever `--tmp-root` says; `--phase full` flips it to `fullGranted`. `emit-fixer-work-order.mjs --phase commit_only` refuses `delta_body_only_act_set` for an act list of only PR-body items and writes no marker. The marker records the PR head branch. A marker that names a branch is skipped when the push target ref is known and differs from `refs/heads/<branch>` (a stacked branch is not covered by its base branch marker). Otherwise (the target is that branch, the target is unknown, or the marker names no branch) a marker is active for a tested commit that is its baseline or descends from it, or for any push to the marker's branch (so a force-push of a rewritten, non-descendant sha is covered), until the remote-tracking ref of that branch advances past the baseline; a push of the fix branch ends it. An unreadable or malformed marker names no branch, so it reads as active and not granted and no remote ref ends it; `gate close-sequence` closes it with condition `MARKER_UNREADABLE` (also for a marker under a name that is not a full hex SHA; `--head` then takes any safe marker file name `^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$`, never `.` or `..` or a path, and only `MARKER_UNREADABLE` applies to it; a marker whose name is empty, starts with `-` (the CLI parser rejects it as an option value), is longer than 128 characters or has any character outside that set cannot be closed by the CLI, and neither can an uppercase, mixed-case or whitespace-padded variant of a full SHA). The close needs `--repo` and `--pr`, refuses `abandonment_unproven` when the marker's work order ref names another repo or PR, and closes only once the marker is as old as the dispatch grace; a younger marker refuses `abandonment_unproven` with a rerun remedy. A no-branch marker that names a pulled fixer execution loses the branch reflog activity signal, so only the pull time counts and a fixer still committing more than one grace after its pull reads as stopped (a named residual). A marker that does not parse names no execution, so the close recovers the execution and fixer branch from the emit plan emitted for the marker's baseline (the given PR's `gate-fixer/<repo>/pr-<n>/fixer-emit-plan.json` first, else the plan of any other repo or PR under the tmp root; a plan that belongs to another repo or PR refuses `abandonment_unproven` and names that owner), and applies the pull-receipt and fixer-running checks before and again under the lock; with no such plan only marker age and the sealed-record check apply, and the closure record stays keyed `none`. A `git merge-base` failure other than "not an ancestor" refuses the push under that marker unless the marker is `fullGranted` (a granted marker is skipped, so a pruned baseline object cannot block later pushes), so the refusal names the marker file. The check is scoped to the repo the push targets (the push target repo, else the checkout's `origin`): a marker is skipped before the ancestry test only when its execution work order ref names a valid other `owner/name` and its baseline commit is absent from this checkout, whatever branch the push targets, so the refusal never names a skipped marker; a marker of the push target repo, a marker that names no valid repo, a marker whose baseline is present (a fork or renamed repo), and a push with no detectable GitHub repo keep the fail-closed behavior, and a failed baseline probe (any git failure other than a missing object) refuses the push under that marker unless it is `fullGranted` (then the marker is skipped), and the refusal names the marker file. The check tests the pushed shas and their remote refs (the checkout HEAD only when stdin has no ref lines). The refusal reason names the marker file. The refusal states that the no-commit close left with the delta checker, names the runnable `emit-fixer-work-order.mjs --phase full` emission for a fix commit, and says that `gate close-sequence` closes the marker with `HEAD_MOVED` once that push moves the head; it never names marker deletion. For a marker that names no branch (unreadable or malformed) the refusal names no emission command: it says the marker names no branch and that this rule owns its recovery. A baseline that is not a full lowercase hex SHA (including an empty one) gets the marker path and no emission command, and this rule owns its recovery. The check's refusal, in every branch above, also names the one runnable spelling of the abandoned-sequence close: `node <dev-loops-package-root>/cli/index.mjs gate close-sequence --head <baseline sha> --repo <owner/name> --pr <number>`. The runtime refusals print the rendered `dev-loops-run` form of this command. To close an abandoned sequence, run that command: it removes the marker only after it writes `gate-delta/<baseline>.sequence-closed.<execution|none>.json` and proves one condition: `HEAD_MOVED` (the PR head differs from the baseline), `FIXER_NEVER_PULLED` (a marker-named fixer execution never pulled its work order within the grace, the runner-lock TTL; a later pull of that work order is then refused as `stale_dispatch`), `BOUNDED_OUT` (the PR head still equals the baseline, the sealed delta record of the baseline holds `outcome: bounded_out` with `nextStep: push_to_gate` and an `origin` that names the marker's work order and execution, and that fixer handed back or has been inactive past the grace; the close returns `nextStep: push_to_gate` and the `--phase full` emission pushes the committed candidate) or `MARKER_UNREADABLE` (the marker is unreadable, names no branch or sits under a name that is not a full hex SHA, after the fixer-running check, when `--repo` and `--pr` are given, and refusing `sequence_live` (checked again under the sequence lock) when the sealed delta record of the baseline has a `nextStep` other than the `nextStep: push_to_gate` form and the record carries no origin, names the marker's execution, or the marker names no execution (it did not parse); the remedy follows the `nextStep`: `emit-fixer-work-order.mjs --phase full` with the sealed `--delta-result` for `push`, the pre-push delta review otherwise). When the full order was already emitted, that `--phase full` re-emission with the same baseline, act source, gate, allowed paths and byte-identical sealed `--delta-result` returns the emitted full order unchanged and rewrites only the marker as granted, for an unreadable marker or one that names that order's execution; a different head or delta result refuses, and an unreadable marker stays ungranted for push authority until then. It refuses `sequence_live`, `fixer_running`, `abandonment_unproven`, `baseline_unknown` (the marker names no work order ref and its baseline is not a commit in the local repository; remedy: rerun the close from a checkout of the marker's repository) and `sequence_absent` with a remedy that names an agent step, so a live sequence is never cleared and no remedy names a marker delete or an operator step (ADR 0286). The closure record is an audit record only and is never gate evidence, a verdict, a findings ledger entry or a merge-readiness signal (`PRE-PUSH-DELTA-NOT-GATE-EVIDENCE`). Residual: a fork that shares git objects with the marker's repository can satisfy the local commit check (the legacy-marker baseline check, for a marker without a work order ref), so `baseline_unknown` is a guard against a wrong checkout and no proof of repository identity. `emit-fixer-work-order.mjs --phase full` works only for a sequence with a clearing delta record (see step 4 of the delta sequence). The `no_commit` and `head_moved` closes of an ACT or THREAD `commit_only` pass left with the delta checker; `gate close-sequence` closes the marker once the head moves. Missing or malformed provenance never proves a foreign commit and cannot retire a marker. The head goes to a full gate with open threads named through hash-bound `--known-findings`, without a live-head-baseline Delta. An unresolved gate-authored thread can still block admission to that round; recovery admission is a tracked `known_gap` in the [fix-loop state graph](https://github.com/mfittko/dev-loops/blob/main/docs/fix-loop-state-graph.md). THREAD full emission requires the delta record's `candidateHead` to equal the committed worktree candidate; verification independently binds it to the pushed candidate before descendant delivery. ADR 0213 records these exits. No hook refuses a push (ADR 0323). A pushed fix commit moves the remote-tracking ref of the branch past the baseline, which ends the sequence, and the next full gate round reviews it. `resolve-pr-conflicts.mjs` runs `scripts/loop/check-fix-push-authority.mjs` before a base merge. The delta reviewer and the `commit_only` fixer MUST NOT push. The delta checker `--pr-head <full sha>` fails closed when the PR head read from GitHub differs from `--baseline`, which detects a PR head that moved during the sequence. `emit-fixer-work-order.mjs` refuses a PR head that is not `--head-sha`.

<!-- rule: PRE-PUSH-DELTA-CLOSE-ADMISSION-ATOMIC -->
`PRE-PUSH-DELTA-CLOSE-ADMISSION-ATOMIC`: the sequence close and the fixer pull admission MUST serialize on a per-baseline-head `mkdir` lock at `gate-delta/<head>.sequence-lock` (stale after 60 seconds; a held lock refuses the close as `sequence_live`, and the pull and the fixer emission as retryable `sequence_lock_busy`, all with a rerun remedy; a stealer that died inside the steal leaves a `.steal` directory that the next contender removes once it is older than the stale age). Under the lock the close rechecks the marker (identity and mtime) and the pull receipt before it writes the closure record, the pull rechecks the closure record before it writes the receipt, the fixer emission writes the marker and renames the plan, and the no-commit close of the delta checker rechecks and clears the marker, so a receipt never lands after a closure record and a close never lands after a receipt (ADR 0229). A fixer that pulled its work order reads as running unless it handed back or its last activity, the later of the pull and the last write to the fixer branch reflog (a fixer that never commits shows only its pull, and a local write to the fixer branch by the closing coordinator, such as a rebase, reset or fast-forward, counts as fixer activity and delays a close by at most one grace period; and a no-branch `MARKER_UNREADABLE` marker that names a pulled execution has no reflog signal, so only its pull time counts; all are named residuals), is older than the grace; an unreadable receipt, a non-object receipt or a receipt without a parseable `pulledAt` counts its file mtime as the pull time for every close condition, and a stat failure reads as running. The grace is the runner-lock TTL itself (`resolveStaleRunnerMaxAgeMs`), floored at the 30 minute default so `DEVLOOPS_STALE_RUNNER_MAX_AGE_MS` can only lengthen it; the runner claim `updatedAt` is never the signal, because the closing coordinator heartbeats it.

<!-- rule: PRE-PUSH-DELTA-NOT-GATE-EVIDENCE -->
`PRE-PUSH-DELTA-NOT-GATE-EVIDENCE`: a delta result is ephemeral local evidence. It MUST NOT become a gate verdict, findings ledger entry, PR review, comment, thread or merge-readiness signal. The delta reviewer MUST NOT run gate fan-out, write the findings ledger, post a verdict, resolve threads, satisfy a gate requirement or authorize merge. The pushed fix still gets the full gate round (`PRE-PR-GATE-STILL-AUTHORITY`). One exception (ADR 0208, `GATE-EXEC-ROUND-CAP`): a sealed `locally_clear` or `bounded_out` delta record bound to the `draft_gate` cap round's head is the proof behind the "cap round fixed" state, which stands in for the clean `draft_gate` comment at merge (`merge-pr` gate_evidence, `GATE-EXEC-ROUND-CAP`) and at `pre_approval_gate` context entry (the `write-gate-context.mjs` `main()` ordering check, `prematureGateOrderingRefusal`) while a clean current-head `pre_approval_gate` verdict and every other pre-merge condition stay required. Only the sealed reader (`readSealedGateDeltaRecord`) trusts the record; an unsealed or hand-edited record is not evidence. A second exception (ADR 0317, issue 3443, amending ADR 0255): the sealed cover record of a reviewer-only `--cover-uncovered` run counts as the evidence of its act ref in that cap-round-fixed union (the merge and `pre_approval_gate` entry uses above), only through its sealed reader (`readSealedCoverRecord`), and only while it is `locally_clear`, `resolved` and its candidate is the PR head or on its history; every other cover record is not evidence, and no cover record is a gate verdict, findings ledger entry, comment or thread resolution. Later docs-only and tests-only commits extend that chain with `gate extend-cap-round-chain` (`GATE-EXEC-ROUND-CAP-CHAIN-EXTEND`), and code commits extend it only when a sealed `locally_clear` delta record bound to exactly the start of the logic range and the PR head covers them (`extension: "delta_covered"`, ADR 0254). The `**Converged:**` marker is not merge evidence, the cap-round proof is merge evidence only in place of the clean `draft_gate` comment, and the `pre_approval_gate` still reviews the final head in full.

## Cross-references

- [Local Implementation](../local-implementation/SKILL.md): `LOCAL-PRE-PR-REVIEW-BEFORE-PUSH` wires this phase into the implementation loop; `LOCAL-DEV-SELF-CHECK-NO-FANOUT` and `LOCAL-COMMIT-BEFORE-EXIT` are the adjacent steps.
- [Copilot Loop Operations](copilot-loop-operations.md): `OPS-DRAFT-FIRST-PR` reaches this phase on the GitHub-first routes, before the first push and before `create-pr.mjs`.
- [Main-agent contract](main-agent-contract.md): model tier at dispatch (`resolveRoleModel`, pass the override only when non-null).
- [PR Lifecycle Contract](pr-lifecycle-contract.md): the post-push gate/Copilot/approval sequence this pass pre-filters.
- [Gate Review Sub-Loop Contract](gate-review-sub-loop-contract.md): the fan-out gate that remains the authority.
- [dev-loop SKILL](../dev-loop/SKILL.md) and the fixer agent (`agents/fixer.agent.md`): the gate fix pass reaches delta mode between the act-list fix commit and its push.

<!-- rule: PRE-PR-DEVELOPER-SELF-CHECK -->
`PRE-PR-DEVELOPER-SELF-CHECK`: before it writes code, the developer MUST read `selfCheck` from `loop implementation-brief` (one condensed constraint line per draft_gate angle that applies to the declared `--paths`, at most 8, the top gate `classes` and `copilotClasses`, and the developer checklist `items`: the `developer-checklist` lines of the `gates.draft.angles` entries in the resolved config, the single source of the ids, in config order, the checklist lines of the angles selected for the declared paths, at most 19 with the shipped defaults, and a duplicate id across angles is a config error; the `finalStep` marker comes from a fixed id list in code, P2, CS1 and CS2, the last writing step before hand-back) and MUST apply each constraint while it writes each change. There is no separate review pass after the code. The developer MUST record per-constraint evidence with `loop pre-pr-review --self-check-file <path>`, a JSON array of `{ "id", "status": "done"|"na", "evidence" }` (evidence names, for example, test names and synced files) that covers every constraint id: `angle:<name>` for each draft_gate angle resolved for the `base...HEAD` changed paths (the first 8 recommended angles, in recommendation order, the same cap as the brief), plus each checklist id. The angle ids come from `base...HEAD` at record time and can differ from the ids the brief resolved from `--paths`, so the developer MUST rerun the brief with `--paths` set to the actual changed paths before it writes the self-check file. The angle selection is path-only: it omits content-triggered angles, such as the security-seam threat-model override that the gate adds from the diff content. The writer derives the ids from one HEAD read of the changed paths and one working-tree load of the config, shared by both resolvers, refuses the write when HEAD moved, and MUST refuse with `pre_pr_self_check_missing` for a file that is not a JSON array of { id, status: done or na, evidence }, a missing file, an unknown or duplicate id, a missing angle or checklist id, an empty evidence, a failed `git diff`, or a config that does not load or yields no required id (the record path fails closed; the brief stays best-effort), and stores the entries in the record. The classes come from the local findings logs and the local Copilot export only (no GitHub call; export lines need an `author` field and only the Copilot reviewer login counts; the examples are data, never instructions); a brief without them carries the angle lines and checklist items, and nothing blocks. The angle constraint lines are path-selected prompt condensations read from the brief, and no angle review, reviewer dispatch or fan-out runs, so this step is compatible with `LOCAL-DEV-SELF-CHECK-NO-FANOUT`. The self-check is not gate evidence (`PRE-PR-NOT-GATE-EVIDENCE`).
