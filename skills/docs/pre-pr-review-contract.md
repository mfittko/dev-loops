# Pre-push review contract

Canonical owner for the `pre-push-reviewer` role and its two bounded modes. Full
mode is the pre-PR review phase: a developer-briefed, fresh-context,
general-purpose review pass that runs before the first push and fixes findings
in-tree. Delta mode (see [Delta mode](#delta-mode)) reviews a gate act-list fix
before its push. Other docs MAY link this contract; they MUST NOT redefine it.
Full mode is unchanged by delta mode. The sections up to Delta mode describe full
mode.

## Why this phase exists

Almost all dev-loop churn comes from findings that surface INSIDE the gate.
Every in-gate fix costs a head bump, a re-gate, and often a forced Copilot round
plus thread reconciliation. The cheapest place to fix a defect is BEFORE the
first push: no head bump, no PR thread, no Copilot round, nothing to reconcile.

The pre-PR phase shifts one review left, to that cheapest fix point. One premium
review call that catches a defect early avoids a downstream full draft-gate
fan-out (7+ reviewers) plus a Copilot round for each missed finding. That is a
lopsided economic win.

## Phase position

<!-- rule: PRE-PR-BEFORE-FIRST-PUSH -->
`PRE-PR-BEFORE-FIRST-PUSH`: the pre-PR review MUST run after local implementation
is complete and committed, and BEFORE the first push of the branch and before
`dev-loops pr create`. Its fixes MUST be applied to the working tree, validated
with the narrowest justified check (re-checked after the final round), and
committed (a follow-up commit or an amend of the last implementation commit), so
the branch is pushed once, already cleaned and validated. In the `local-implementation`
loop it sits between the exit-validation commit (implementation-loop step 11,
`LOCAL-COMMIT-BEFORE-EXIT`, whose first push is deferred to here) and PR creation
(implementation-loop step 12). The phase applies to any session that pushes and
opens a PR, whichever route the startup resolver selected: a tracker-backed or
issue-less `--lightweight` (PR-body-as-spec) session on the local route, and any
session on a GitHub-first route that creates the branch and PR itself. On the
GitHub-first routes the step sits before the first push and before `create-pr.mjs`
at `OPS-DRAFT-FIRST-PR` in [Copilot Loop Operations](copilot-loop-operations.md).
A session that opens no PR has no pre-PR step: a phase-doc-backed session that
merges locally, a follow-up session on a PR that already exists, or a session on
a Copilot-authored PR.

## The review pass

<!-- rule: PRE-PR-ONE-FRESH-REVIEWER -->
`PRE-PR-ONE-FRESH-REVIEWER`: the developer MUST hand a mandatory REVIEW BRIEF to
exactly ONE fresh-context, general-purpose reviewer per round (a round-two
re-review runs one reviewer too; see `PRE-PR-BOUNDED-TWO-ROUNDS`). The brief is a
developer-authored prompt stating what changed, what to scrutinize, known risks
and tradeoffs, and where the implementation cut corners. The reviewer MUST NOT be
a fixed angle: it reviews holistically per the brief. Fresh context is required,
because the implementer rationalizes their own code and a same-context
self-review is near-worthless. This is distinct from the single developer
self-check (`LOCAL-DEV-SELF-CHECK-NO-FANOUT`), which the implementer runs against
the plan; the pre-push reviewer MUST be a separate fresh-context agent. The
reviewer returns findings only and MUST NOT edit the tree; the implementer
applies the fixes.

The reviewer MUST run with the adversarial-enumeration checklist below so the
strong model reviews systematically, not ad hoc.

### Harness-specific dispatch

The reviewer is dispatched per harness, always with the brief as the reviewer's
task and the config-resolved model (see below) passed only when non-null:

- Claude Code: dispatch the built-in `general-purpose` subagent type with the
  brief as its prompt and the resolved model as the Agent `model` parameter.
- Pi: dispatch one fresh subagent with the brief as its task (a general-purpose
  reviewer; the PR-bound `review` gate procedure does not apply). The model stays
  keyed on the `pre-push-reviewer` role.

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
`PRE-PR-MODEL-CONFIG-RESOLVED`: the pre-push reviewer's model, in both modes, MUST be resolved
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
underlying model identity is `claude-fable-5-1`). The phase works unchanged on
both the Pi and Claude Code harnesses; each harness resolves to its own
configured model or to `null` (default).

## Findings are ephemeral

<!-- rule: PRE-PR-EPHEMERAL-NO-ARTIFACTS -->
`PRE-PR-EPHEMERAL-NO-ARTIFACTS`: the pass MUST be ephemeral. Findings are applied
directly to the working tree and then live and die in the pass. It MUST NOT
create a pull request, a comment, a review thread, or a Copilot round.
Ephemerality is the whole point: the phase must not recreate in-gate churn.

## Bounds

<!-- rule: PRE-PR-BOUNDED-TWO-ROUNDS -->
`PRE-PR-BOUNDED-TWO-ROUNDS`: the pass MUST NOT exceed two internal rounds and
MUST NOT run more than one general-purpose reviewer per round; after at most two
rounds the branch is pushed once. It MUST NOT fan out to multiple reviewers. The
round-two re-review verifies the applied fixes with a fresh-context reviewer: the
same reviewer continued when the harness supports agent continuation, otherwise
one new fresh-context dispatch. Either way the reviewer stays fresh relative to
the implementer, which is the property `PRE-PR-ONE-FRESH-REVIEWER` requires.

## The fan-out gate stays the authority

<!-- rule: PRE-PR-GATE-STILL-AUTHORITY -->
`PRE-PR-GATE-STILL-AUTHORITY`: the pre-PR pass is a cheap pre-filter, not a
replacement for the gate. After the push, the full fresh-context fan-out
`draft_gate` and `pre_approval_gate` lifecycle MUST run unchanged and remains the
authority for merge readiness.

<!-- rule: PRE-PR-NOT-GATE-EVIDENCE -->
`PRE-PR-NOT-GATE-EVIDENCE`: the pre-PR pass is NOT a lifecycle-gate fan-out. It
MUST NOT produce gate evidence: no `resolveGateAngles` run, no fan-in disposition
ledger, no gate verdict comment. It is consistent with
`LOCAL-DEV-SELF-CHECK-NO-FANOUT`, which forbids a pre-pull-request gate fan-out.
The pre-PR pass is one general-purpose reviewer, not the angle set the fan-out
gate uses.

## Delta mode

Delta mode is one fresh holistic review of a gate act-list fix before that fix
is pushed. It checks the cumulative fix delta against the act items the fix
claims to resolve, so a fix-induced regression is caught before it costs another
gate round, CI run and review cycle. It resolves the same `pre-push-reviewer`
role and tier as full mode (`PRE-PR-MODEL-CONFIG-RESOLVED`) and uses the same
harness dispatch. The only delta source is the gate judge's act list. The
deterministic checks live in `@dev-loops/core/loop/pre-push-delta-review`; the
dev-loop coordinator runs them through `dev-loops loop pre-push-delta`.

The dev-loop coordinator owns delta mode, because it dispatches the Phase 4
fixer and owns the push; the gate coordinator has returned by then. The
sequence is:

1. The dev-loop coordinator dispatches the fixer with the act list. The fixer
   commits the fix and hands back the commit SHA unpushed.
2. The dev-loop coordinator dispatches one fresh delta reviewer for the current
   worktree head.
3. On `needs_fix`, it dispatches a fresh fixer again, commit-only, and returns
   to step 2.
4. On `locally_clear` or `bounded_out`, it dispatches the fixer to push, reply
   to each gate thread with the fixing commit, and resolve that thread.

The dev-loop coordinator owns the invocation count and passes it to
`dev-loops loop pre-push-delta --invocation` monotonically, starting at 1 for
each sequence.

<!-- rule: PRE-PUSH-DELTA-TRIGGER -->
`PRE-PUSH-DELTA-TRIGGER`: delta mode MUST run after the gate Phase 4 fixer commits a fix for a judge act list and before that fix is pushed. A push with no act-list fix MUST NOT get a delta review, even when a PR exists. Standalone implementation pushes and the full-mode first push are unaffected.

<!-- rule: PRE-PUSH-DELTA-PINNED-BASELINE -->
`PRE-PUSH-DELTA-PINNED-BASELINE`: every delta sequence MUST bind `reviewBaselineHead..candidateHead`, where `reviewBaselineHead` is the head the gate round reviewed and stays pinned for the whole sequence. A second local fix `C` after candidate `B` MUST be reviewed as `A..C`, never only `B..C`, with the same act-set identity. `reviewBaselineHead` MUST be an ancestor of `candidateHead`; otherwise the delta check fails closed. A new gate round starts a new sequence.

<!-- rule: PRE-PUSH-DELTA-INPUT -->
`PRE-PUSH-DELTA-INPUT`: the reviewer input MUST carry `reviewBaselineHead` and `candidateHead`, the act-item refs with their judge dispositions from the gate findings ledger, the current spec identity, the act items' angle names as surface hints, and the adversarial-enumeration checklist. The reviewer reads the cumulative diff from the worktree; the coordinator MUST NOT inline diff bytes. The input MUST NOT carry sibling reviewer verdicts or "clean" claims. The reviewer MAY widen to surrounding code, spec or prior finding evidence when a concrete dependency requires it, and it MUST record each widened read in `widenedReads[]`.

<!-- rule: PRE-PUSH-DELTA-RESULT -->
`PRE-PUSH-DELTA-RESULT`: the reviewer MUST return a `DeltaPrePushReviewResult` bound to the baseline, candidate and act set, with a status and evidence for every claimed act item. The `actSetId` MUST equal the sequence's id, which hashes each act item's ref, angle, severity, file, line and summary. Each act item ref appears once, in the act list and in the result. The status MUST be `resolved`, `not_resolved` or `cannot_verify`; `cannot_verify` stays distinct from `not_resolved`. Every `evidence[]` entry, for act items and new findings, MUST be a non-empty string, and each list MUST be non-empty. `widenedReads[]` is required, and empty when nothing was widened. A result with a missing or unknown status is rejected.

```text
DeltaPrePushReviewResult {
  reviewBaselineHead, candidateHead, actSetId
  actionableItems[] { ref, status: resolved | not_resolved | cannot_verify, evidence[] }
  newFindings[] { severity, summary, evidence[] }
  widenedReads[] { path, reason }
  outcome: locally_clear | needs_fix | bounded_out
}
```

<!-- rule: PRE-PUSH-DELTA-EXIT-BOUND -->
`PRE-PUSH-DELTA-EXIT-BOUND`: `locally_clear` MUST require every claimed act item `resolved`, none `cannot_verify`, and no new finding of severity medium or higher. Medium or higher means `high`, `question` or `medium`. A sequence MUST NOT exceed three delta review invocations, one fresh reviewer each, with no fan-out. When the third review is not locally clear, the outcome is `bounded_out` with the residual evidence: no fourth review runs, the committed candidate is pushed into the normal gate path, and no success is claimed. At the third review the bound takes precedence over `PRE-PUSH-DELTA-FRESHNESS`: a stale result also ends `bounded_out`, and the current worktree head is pushed into the normal gate path, because `bounded_out` authorizes nothing and claims no success.

<!-- rule: PRE-PUSH-DELTA-FRESHNESS -->
`PRE-PUSH-DELTA-FRESHNESS`: before each invocation the fix MUST be committed and `candidateHead` read from the worktree. A result whose `candidateHead` differs from the current worktree head MUST NOT authorize the push; a head change outside the loop needs a new review against the current candidate.

<!-- rule: PRE-PUSH-DELTA-NOT-GATE-EVIDENCE -->
`PRE-PUSH-DELTA-NOT-GATE-EVIDENCE`: a delta result is ephemeral local evidence. It MUST NOT become a gate verdict, findings ledger entry, PR review, comment, thread or merge-readiness signal. The delta reviewer MUST NOT run gate fan-out, write the findings ledger, post a verdict, resolve threads, satisfy a gate requirement or authorize merge. The pushed fix still gets the full gate round (`PRE-PR-GATE-STILL-AUTHORITY`).

## Cross-references

- [Local Implementation](../local-implementation/SKILL.md): `LOCAL-PRE-PR-REVIEW-BEFORE-PUSH` wires this phase into the implementation loop; `LOCAL-DEV-SELF-CHECK-NO-FANOUT` and `LOCAL-COMMIT-BEFORE-EXIT` are the adjacent steps.
- [Copilot Loop Operations](copilot-loop-operations.md): `OPS-DRAFT-FIRST-PR` reaches this phase on the GitHub-first routes, before the first push and before `create-pr.mjs`.
- [Main-agent contract](main-agent-contract.md): model tier at dispatch (`resolveRoleModel`, pass the override only when non-null).
- [PR Lifecycle Contract](pr-lifecycle-contract.md): the post-push gate/Copilot/approval sequence this pass pre-filters.
- [Gate Review Sub-Loop Contract](gate-review-sub-loop-contract.md): the fan-out gate that remains the authority.
- [dev-loop SKILL](../dev-loop/SKILL.md) and the fixer agent (`agents/fixer.agent.md`): the gate fix pass reaches delta mode between the act-list fix commit and its push.
