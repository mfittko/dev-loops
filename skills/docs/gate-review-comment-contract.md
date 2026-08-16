# Checkpoint Verdict Comment Contract

Canonical owner for gate-review **verdict field** rules for the two gate boundaries in
the dev-loop workflow: `draft_gate` and `pre_approval_gate`.

## Purpose

Gate-review verdicts make the workflow auditable and transparent from the PR
conversation alone. A reviewer or maintainer can inspect which gate ran, which head
commit was reviewed, whether it passed cleanly, and whether a result is current for
the latest head — without relying on local or session-only artifacts.

<!-- rule: GATE-COMMENT-SINGLE-SURFACE -->
`GATE-COMMENT-SINGLE-SURFACE`: A gate round produces exactly ONE new visible surface: a single PR
review of type COMMENT, posted by `upsert-checkpoint-verdict.mjs`. Its body carries the required
verdict fields below; with `--findings-ledger`, that same review also carries the round's
findings — locatable ones as its inline comments, the rest body-filed under the verdict fields
(`GATE-EXEC-FINDING-THREADS`, [Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#finding-threads-and-disposition)).
No separate verdict issue comment, no separate findings review, and no deferred-summary comment
is posted. Each finding's text appears exactly once across the round; the body's per-angle
breakdown carries angle, verdict, and finding counts only. Verdict evidence is read from that
review body; a verdict posted as an ISSUE comment still validates and is still corrected on
its own surface (back-compat read).

<!-- rule: GATE-EVIDENCE-AUDIT-TWO-SURFACES -->
`GATE-EVIDENCE-AUDIT-TWO-SURFACES`: any gate-evidence completeness audit or reporting path MUST
scan BOTH verdict surfaces — the PR-review stream (`pulls/<n>/reviews`, the primary surface per
GATE-COMMENT-SINGLE-SURFACE) and the visible issue-comment stream (`issues/<n>/comments`, the
back-compat read). Scanning the issue-comment stream alone reports a legitimately-posted
PR-review verdict as "missing": the post-drive audit that filed #1674 falsely concluded #1614's
round-2 `draft_gate` and `pre_approval_gate` verdicts were unposted because it read only
`issues/1614/comments`, where no verdict body lives (the verdicts existed as PR reviews at the
merged head). The deterministic post-drive audit helper is
`scripts/github/audit-gate-evidence.mjs` — it reads both surfaces through
`fetchGateEvidenceComments` and reports each gate's verdict as visible regardless of which
surface carries it, so a verdict posted only as a PR review is never reported missing. The
sanctioned poster never creates one. Two documented
exceptions exist: the opt-in findings comment (`gates.postFindingsComments`,
`GATE-COMMENT-IDENTITY-DISJOINT` below) adds a sanctioned second visible surface when a repo
opts in, and the zero-dep fallback poster
(`skills/dev-loop/scripts/post-gate-verdict-fallback.mjs`), used only when `@dev-loops/core`
is absent, posts a verdict issue comment the dev-loop skill documents as a degraded
audit-trail artifact.

<!-- rule: GATE-COMMENT-IDENTITY-DISJOINT -->
`GATE-COMMENT-IDENTITY-DISJOINT`: The verdict surface and the opt-in findings comment
(`gates.postFindingsComments`, `post-gate-findings.mjs` — the opt-in exception
`GATE-COMMENT-SINGLE-SURFACE` names) identify "their"
comment by different claim keys, and each tool's upsert MUST NOT ever claim the other's comment.
The verdict is claimed through its parsed verdict fields (gate name plus reviewed head); the
findings comment through its own `dev-loops:gate-findings gate=` marker. Enforced at the claim
seam by machine-artifact filtering plus verdict-body precedence: the marker summarizer treats a
body carrying a known machine-artifact marker token (owned by the artifact filter in
`copilot-helpers.mjs`, delimiter-anchored so no suffixed `<token>-<x>` variant matches) as a
non-candidate UNLESS it also carries the producer-owned verdict body heading — which is how the
round's own review, marker and all, stays claimable while the findings comment (which never
carries that heading) never is. That silent replacement previously destroyed a full round's
visible findings record seconds after it was posted. Within its OWN claim key each tool keys
identity as it needs (the findings comment's marker is deliberately gate-only).

<!-- rule: GATE-COMMENT-SCOPE-ONLY -->
`GATE-COMMENT-SCOPE-ONLY`: This document owns the visible checkpoint verdict evidence contract only.
It does not restate the full PR follow-up procedure; that
remains owned by the relevant workflow skill. The broader family-local PR lifecycle
that consumes this evidence is defined in [PR Lifecycle Contract](./pr-lifecycle-contract.md).

## Scope

This contract covers exactly two gates with distinct lifecycle semantics:

- `draft_gate` — **one-time transition boundary.** Runs right before `gh pr ready`
  (draft → ready-for-review boundary). Once a clean comment exists and the PR leaves
  draft, the gate is permanently satisfied; later head changes must not re-trigger it.
- `pre_approval_gate` — **recurring per-head gate.** Runs right before final approval /
  merge readiness on the current head SHA. A new pass is required for each new head
  after post-draft changes.

## Separate chains per gate

Each gate runs its own independent review chain (`GATE-EXEC-SEPARATE-CHAINS`, owned by
[Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#separate-chains-per-gate)).
This section owns only the comment-visible ledger path per gate:

| Gate | Own disposition ledger path |
|---|---|
| `draft_gate` | `tmp/gate-findings/.../draft_gate-<sha>.json` |
| `pre_approval_gate` | `tmp/gate-findings/.../pre_approval_gate-<sha>.json` |

## Review-angle ownership and non-substitution rules

Each gate's review angles are defined in the project config (`gates.draft.angles` and `gates.preApproval.angles` in `.pi/dev-loop/defaults.yaml`). The reviewer persona for each angle is resolved via `resolveReviewerRole` from the gate's own angle entry, falling back to the built-in persona registry (`packages/core/src/config/config.mjs`). Consumer repos may override an angle's persona/prompt via its own `gates.<gate>.angles[]` entry in their config.

Resolve angles at runtime with `resolveGateAngles(config, "draft")` and `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config`. Do not hardcode angle names in skill procedures or review prompts.

| Gate | Boundary it governs | Review angles | What a clean comment authorizes | What it does **not** authorize |
|---|---|---|---|---|
| `draft_gate` | Draft → ready for review | Resolved from `gates.draft.angles` in config | `gh pr ready` / leaving draft for the reviewed head SHA | final-approval readiness, merge-ready claims, or satisfaction of `pre_approval_gate` |
| `pre_approval_gate` | Final approval / merge readiness | Resolved from `gates.preApproval.angles` in config | approval-ready / final-human-approval readiness for the reviewed head SHA | draft-stage `gh pr ready` decisions for a different gate run |

<!-- rule: GATE-COMMENT-NON-SUBSTITUTION -->
`GATE-COMMENT-NON-SUBSTITUTION`: A clean `draft_gate` comment does **not** satisfy `pre_approval_gate` requirements.
A clean `pre_approval_gate` comment does **not** retroactively replace the required `draft_gate` evidence for leaving draft.

## Required fields

<!-- rule: GATE-COMMENT-REQUIRED-FIELDS -->
`GATE-COMMENT-REQUIRED-FIELDS`: Every gate-review verdict body MUST include:

| Field | Description |
|---|---|
| **Gate name** | `draft_gate` or `pre_approval_gate` |
| **Head SHA reviewed** | The exact commit SHA that was reviewed |
| **Verdict** | `clean`, `findings_present`, or `blocked` |
| **Blocking severities** | (clean verdicts only) Which severity levels must be clean per gate config |
| **Findings summary** | Short truthful audit summary. Use `no issues found` only when the reviewed head needed no corrective change for that gate pass. |
| **Next action** | One of: `stay draft and fix`, `rerun gate`, `mark ready for review`, `await final human approval` |

## Verdict definitions

<!-- rule: GATE-COMMENT-VERDICT-VALUES -->
`GATE-COMMENT-VERDICT-VALUES`: The verdict field MUST be one of the following values, each
with the fixed meaning below:

| Verdict | Meaning |
|---|---|
| `clean` | No findings with a severity in the gate's `blockCleanOnFindingSeverities` remain |
| `findings_present` | The gate found issues at blocking severities; fixes are required before the gate boundary can be crossed |
| `blocked` | The gate could not complete or a hard blocker prevented a verdict |

This rule is enforced at post time, not just documented: `upsert-checkpoint-verdict.mjs`
refuses a `--verdict` that contradicts the consolidated ledger's `overallVerdict`
for the same head and gate (#1616). The consolidator (`consolidate-fanin.mjs`)
already computes `overallVerdict` from this rule's definitions; it threads
through `--ledger-out`'s `{ overallVerdict, findings }` wrapper into the durable
ledger (`write-gate-findings-log.mjs`), and `upsert-checkpoint-verdict.mjs`
reads it and derives the verdict by default (passing no `--verdict` is valid),
accepts a matching explicit value, and refuses a contradiction citing this
rule. No override flag — a round whose verdict genuinely differs from the
computed one is a consolidator bug to fix, not an operator decision to override.

## Disposition ledger

Durable-ledger sequencing and content are owned by `GATE-EXEC-DISPOSITION-LEDGER`
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#disposition-ledger-and-durable-logging)).
The visible PR comment is a summary for auditability; the disposition ledger is the
complete durable record.

Disposing of the ledger's non-blocking findings as inline review threads on the round's own
review is owned by `GATE-EXEC-FINDING-THREADS` and `GATE-EXEC-THREAD-DISPOSITION`
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#finding-threads-and-disposition));
a deferred finding's record is owned by `GATE-EXEC-DEFERRAL-RECORD` there too.

## Readable deterministic format

<!-- rule: GATE-COMMENT-VALIDATION-REPORTING -->
`GATE-COMMENT-VALIDATION-REPORTING`: Keep the visible verdict body compact, deterministic, and
slightly human-friendly (labels like `Gate review`, `Reviewed head SHA`, `Verdict`,
`Blocking severities`, `Findings summary`, `Next action`); gate name and reviewed head SHA
MUST stay deterministically parseable even if label wording changes. Validation reporting
MUST stay concise by default — command names plus pass/fail status, aggregate counts, and
current-head CI/check status, never raw passing log streams. Any included command output
MUST be truncated to a deterministic retained-prefix length (a short truncation marker
suffix is allowed); a failure MUST show only a focused relevant excerpt, not an unbounded
raw log dump. Detailed logs MAY live in local/session artifacts or linked GitHub logs
instead of the visible audit comment. When a pass reached `clean` only after corrective changes, the findings
summary SHOULD briefly say what gap was found, what changed, and why the current head now
satisfies the gate.

## Behavior requirements

Post-before-fix ordering is owned by `GATE-EXEC-POST-BEFORE-FIX`
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger));
it applies to both gate boundaries.

### Draft gate (`draft_gate`) comment requirements

<!-- rule: GATE-COMMENT-DRAFT-REQUIREMENTS -->
`GATE-COMMENT-DRAFT-REQUIREMENTS`: The PR MUST NOT leave draft unless a visible, current-head
`clean` `draft_gate` checkpoint verdict comment exists, per the rules below.

**One-time transition boundary.** `draft_gate` is not a recurring per-head gate — it
records exactly one decision point: the draft → ready-for-review transition. Once a
clean `draft_gate` comment exists on the PR and the PR leaves draft, later head
changes MUST NOT trigger new `draft_gate` comments. Post-draft follow-up relies on
normal review/fix loops and the recurring per-head `pre_approval_gate`.

- **Skip rule:** the skip applies only once the draft→ready transition is already
  recorded — a clean `draft_gate` comment exists on the PR (any head) AND the PR has
  already left draft. In that case, skip the draft gate entirely; do not re-post it on
  later heads. While the PR is still draft, a clean comment for an older head does not
  satisfy the current head — a new head requires a new current-head `draft_gate` comment.
- When the `draft_gate` runs (while the PR is still draft and no clean evidence exists
  for the current head), the PR MUST receive a visible checkpoint verdict comment.
- If the `draft_gate` verdict is `findings_present` or `blocked`, the comment MUST
  state that the PR stays draft and fixes are required before retrying.
- A checkpoint verdict comment for an older head SHA does not satisfy this requirement for
  the current head while the PR is still draft.
- After the PR leaves draft, existing clean `draft_gate` evidence remains valid as a
  one-time transition record — it records that the draft → ready boundary was properly
  crossed. Later head changes do not invalidate this record.
- If a PR is already non-draft and no clean `draft_gate` evidence exists at all (no
  valid checkpoint verdict comment was ever posted), automation MUST fail closed and reconcile
  that missing draft-stage evidence before continuing.

### Pre-approval gate (`pre_approval_gate`) comment requirements

<!-- rule: GATE-COMMENT-PREAPPROVAL-REQUIREMENTS -->
`GATE-COMMENT-PREAPPROVAL-REQUIREMENTS`: Final-approval readiness MUST NOT rely only on
local or hidden artifacts; a visible, current-head `pre_approval_gate` checkpoint verdict
comment is the required auditable evidence, per the rules below.

- When the `pre_approval_gate` runs, the PR MUST receive a visible checkpoint verdict comment.
- If the `pre_approval_gate` verdict is `findings_present` or `blocked`, the comment
  MUST state that follow-up fixes are required before final approval.
- A checkpoint verdict comment for an older head SHA does not satisfy this requirement for
  the current head.

## Rerun rules

<!-- rule: GATE-COMMENT-RERUN-RULES -->
`GATE-COMMENT-RERUN-RULES`: A gate rerun MUST follow the same-head vs. new-head handling
defined below, scoped per gate recurrence (`GATE-COMMENT-SCOPE-ONLY` above): this table
governs the **recurring** `pre_approval_gate`; the **one-time** `draft_gate` is exempt from
the new-head row once its one-time transition record exists (`GATE-COMMENT-DRAFT-REQUIREMENTS`)
so the two rules do not conflict.

| Scenario | Rule |
|---|---|
| Same head SHA rerun | Idempotent behavior: do not post a second visible surface for the same gate+head. An identical rerun posts nothing; if correction is needed, update the existing review's body in place (a legacy verdict issue comment is corrected on its own surface). Inline finding comments are never re-posted — a same-head correction body-files any still-unposted finding, since GitHub exposes no endpoint to add inline comments to a submitted review. |
| New head SHA rerun on the recurring `pre_approval_gate` | A new visible checkpoint verdict review MUST be posted for the new head; the older-head surface remains but does not satisfy readiness for the new head |
| New head SHA change on the one-time `draft_gate` after a clean transition record already exists | No new `draft_gate` verdict is triggered for the new head — the one-time transition boundary already closed (`GATE-COMMENT-DRAFT-REQUIREMENTS`) |

## Fail-closed behavior

<!-- rule: GATE-COMMENT-FAIL-CLOSED -->
`GATE-COMMENT-FAIL-CLOSED`: If the required checkpoint verdict review cannot be posted
(for example due to a GitHub API error, permission restriction, or tooling failure), the
workflow MUST NOT cross the gate boundary:

- do not run `gh pr ready` (for `draft_gate`)
- do not declare final-approval readiness (for `pre_approval_gate`)

The gate boundary is not crossed until both the review verdict is `clean` **and** the
required visible PR review is confirmed posted for the current head SHA.

## Relationship to other contracts

| Contract | Relationship |
|---|---|
| `draft_gate` boundary | Governs the draft → ready-for-review transition in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) Step 7 |
| `pre_approval_gate` boundary | Governs final-approval readiness in [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) Step 7 and the narrowed [Final Approval](../final-approval/SKILL.md) route |
| Local/session artifacts | These remain complementary; the visible PR review is the minimum required auditable surface, not a replacement for all local artifacts |

## See also

- [PR Lifecycle Contract](./pr-lifecycle-contract.md) — broader lifecycle state machine
- [Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md) — execution shape for gate inspection work
- [Copilot PR Follow-up](../copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Final Approval](../final-approval/SKILL.md) — human approval gate route
- [Contract style guide](./contract-style-guide.md) — rule ID and RFC-2119 conventions
