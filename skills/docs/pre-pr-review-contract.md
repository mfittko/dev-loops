# Pre-PR review contract

Canonical owner for the pre-PR review phase: a developer-briefed, fresh-context,
general-purpose review pass that runs before the first push and fixes findings
in-tree. Other docs MAY link this contract; they MUST NOT redefine it.

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
`PRE-PR-BEFORE-FIRST-PUSH`: the pre-PR review runs after local implementation is
complete and committed, and BEFORE the first push of the branch and before
`dev-loops pr create`. Its fixes are applied to the working tree and folded into
the branch, so the branch is pushed once, already cleaned. In the
`local-implementation` loop it sits between the exit-validation commit
(implementation-loop step 11, `LOCAL-COMMIT-BEFORE-EXIT`) and PR creation
(implementation-loop step 12).

## The review pass

<!-- rule: PRE-PR-ONE-FRESH-REVIEWER -->
`PRE-PR-ONE-FRESH-REVIEWER`: the developer hands a mandatory REVIEW BRIEF to ONE
fresh-context, general-purpose reviewer. The brief is a developer-authored prompt
stating what changed, what to scrutinize, known risks and tradeoffs, and where
the implementation cut corners. The reviewer is NOT a fixed angle: it reviews
holistically per the brief. Fresh context is required, because the implementer
rationalizes their own code and a same-context self-review is near-worthless.
This is distinct from the single developer self-check
(`LOCAL-DEV-SELF-CHECK-NO-FANOUT`), which the implementer runs against the plan;
the pre-PR reviewer is a separate fresh-context agent.

The reviewer runs with the adversarial-enumeration checklist below so the strong
model reviews systematically, not ad hoc.

### Adversarial-enumeration checklist

For any new or changed filesystem, parse, or diff seam the brief must direct the
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
`PRE-PR-MODEL-CONFIG-RESOLVED`: the pre-PR reviewer's model is resolved through
`resolveRoleModel(config, { role: "pre-PR-reviewer", harness })` from
`@dev-loops/core/config`. No model literal is hardcoded in this phase's prose,
tooling, or dispatch. The resolved model is passed to the dispatch only when it
is non-null (the existing tier-at-dispatch contract); a `null` resolution passes
no override and inherits the session model. Operators opt into a concrete strong
model per harness in `.devloops` via `models.tiers.<alias>.<harness>` mapped
through `models.roleTiers.pre-PR-reviewer` (or a direct `models.roles` override).
The phase works unchanged on both the Pi and Claude Code harnesses; each harness
resolves to its own configured model or to `null` (default).

## Findings are ephemeral

<!-- rule: PRE-PR-EPHEMERAL-NO-ARTIFACTS -->
`PRE-PR-EPHEMERAL-NO-ARTIFACTS`: the pass is ephemeral. Findings are applied
directly to the working tree and then live and die in the pass. It creates NO
pull request, NO comment, NO review thread, and NO Copilot round. Ephemerality
is the whole point: the phase must not recreate in-gate churn.

## Bounds

<!-- rule: PRE-PR-BOUNDED-TWO-ROUNDS -->
`PRE-PR-BOUNDED-TWO-ROUNDS`: the pass is bounded to ONE general-purpose reviewer
and AT MOST two internal rounds, then the branch is pushed once. It never fans
out to multiple reviewers and never exceeds two rounds before pushing.

## The fan-out gate stays the authority

<!-- rule: PRE-PR-GATE-STILL-AUTHORITY -->
`PRE-PR-GATE-STILL-AUTHORITY`: the pre-PR pass is a cheap pre-filter, not a
replacement for the gate. After the push, the full fresh-context fan-out
`draft_gate` and `pre_approval_gate` lifecycle runs unchanged and remains the
authority for merge readiness.

<!-- rule: PRE-PR-NOT-GATE-EVIDENCE -->
`PRE-PR-NOT-GATE-EVIDENCE`: the pre-PR pass is NOT a lifecycle-gate fan-out. It
produces NO gate evidence: no `resolveGateAngles` run, no fan-in disposition
ledger, no gate verdict comment. It is consistent with
`LOCAL-DEV-SELF-CHECK-NO-FANOUT`, which forbids a pre-pull-request gate fan-out.
The pre-PR pass is one general-purpose reviewer, not the angle set the fan-out
gate uses.
