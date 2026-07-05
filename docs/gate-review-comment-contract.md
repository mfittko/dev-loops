# Checkpoint Verdict Comment Contract

Canonical owner for gate-review **PR comment field** rules for the two gate boundaries in
the dev-loop workflow: `draft_gate` and `pre_approval_gate`.

## Purpose

Gate-review PR comments make the workflow auditable and transparent from the PR
conversation alone. A reviewer or maintainer can inspect which gate ran, which head
commit was reviewed, whether it passed cleanly, and whether a result is current for
the latest head — without relying on local or session-only artifacts.

<!-- rule: GATE-COMMENT-SCOPE-ONLY -->
`GATE-COMMENT-SCOPE-ONLY`: This document owns the visible checkpoint verdict comment evidence contract only.
It does not restate the full PR follow-up procedure; that
remains owned by the relevant workflow skill. The broader family-local PR lifecycle
that consumes this evidence is defined in [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md).

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

Each gate's review angles are defined in the project config (`gates.draft.angles` and `gates.preApproval.angles` in `.pi/dev-loop/defaults.yaml`). The reviewer persona for each angle is resolved via `resolveReviewerRole` from the persona registry (`packages/core/src/config/config.mjs`). Consumer repos may override angles and map custom personas via their own config.

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
`GATE-COMMENT-REQUIRED-FIELDS`: Every gate-review PR comment MUST include:

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
`GATE-COMMENT-VERDICT-VALUES`:

| Verdict | Meaning |
|---|---|
| `clean` | No findings with a severity in the gate's `blockCleanOnFindingSeverities` remain |
| `findings_present` | The gate found issues at blocking severities; fixes are required before the gate boundary can be crossed |
| `blocked` | The gate could not complete or a hard blocker prevented a verdict |

## Disposition ledger

Durable-ledger sequencing and content are owned by `GATE-EXEC-DISPOSITION-LEDGER`
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#disposition-ledger-and-durable-logging)).
The visible PR comment is a summary for auditability; the disposition ledger is the
complete durable record.

## Readable deterministic format

<!-- rule: GATE-COMMENT-VALIDATION-REPORTING -->
`GATE-COMMENT-VALIDATION-REPORTING`: Keep the visible comment compact, deterministic, and
slightly human-friendly (labels like `Gate review`, `Reviewed head SHA`, `Verdict`,
`Blocking severities`, `Findings summary`, `Next action`); gate name and reviewed head SHA
MUST stay deterministically parseable even if label wording changes. Validation reporting
MUST stay concise by default — command names plus pass/fail status, aggregate counts, and
current-head CI/check status, never raw passing log streams. Any included command output
MUST be truncated to a deterministic retained-prefix length (a short truncation marker
suffix is allowed); a failure MUST show only a focused relevant excerpt, not an unbounded
raw log dump. Detailed logs may live in local/session artifacts or linked GitHub logs
instead of the visible audit comment. When a pass reached `clean` only after corrective changes, the findings
summary should briefly say what gap was found, what changed, and why the current head now
satisfies the gate.

## Behavior requirements

Post-before-fix ordering is owned by `GATE-EXEC-POST-BEFORE-FIX`
([Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md#phase-3--consolidation-fan-in-synthesis-and-disposition-ledger));
it applies to both gate boundaries.

### Draft gate (`draft_gate`) comment requirements

<!-- rule: GATE-COMMENT-DRAFT-REQUIREMENTS -->
`GATE-COMMENT-DRAFT-REQUIREMENTS`:

**One-time transition boundary.** `draft_gate` is not a recurring per-head gate — it
records exactly one decision point: the draft → ready-for-review transition. Once a
clean `draft_gate` comment exists on the PR and the PR leaves draft, later head
changes must not trigger new `draft_gate` comments. Post-draft follow-up relies on
normal review/fix loops and the recurring per-head `pre_approval_gate`.

- **Skip rule:** before posting a `draft_gate` comment, check whether a clean `draft_gate`
  comment already exists on the PR (any head). If a clean draft-gate comment exists
  anywhere on the PR, skip the draft gate entirely — the draft→ready transition was
  already recorded. Do not re-post draft gate on new heads. This is a one-time gate.
- When the `draft_gate` runs (while the PR is still draft and no clean evidence exists),
  the PR must receive a visible checkpoint verdict comment.
- If the `draft_gate` verdict is `findings_present` or `blocked`, the comment must
  state that the PR stays draft and fixes are required before retrying.
- The PR must not leave draft (`gh pr ready`) unless a visible `clean` `draft_gate`
  checkpoint verdict comment exists for the current head SHA.
- A checkpoint verdict comment for an older head SHA does not satisfy this requirement for
  the current head while the PR is still draft.
- After the PR leaves draft, existing clean `draft_gate` evidence remains valid as a
  one-time transition record — it records that the draft → ready boundary was properly
  crossed. Later head changes do not invalidate this record.
- If a PR is already non-draft and no clean `draft_gate` evidence exists at all (no
  valid checkpoint verdict comment was ever posted), automation must fail closed and reconcile
  that missing draft-stage evidence before continuing.

### Pre-approval gate (`pre_approval_gate`) comment requirements

<!-- rule: GATE-COMMENT-PREAPPROVAL-REQUIREMENTS -->
`GATE-COMMENT-PREAPPROVAL-REQUIREMENTS`:

- When the `pre_approval_gate` runs, the PR must receive a visible checkpoint verdict comment.
- If the `pre_approval_gate` verdict is `findings_present` or `blocked`, the comment
  must state that follow-up fixes are required before final approval.
- Final-approval readiness must not rely only on local or hidden artifacts; the
  visible PR comment is the required auditable evidence.
- A checkpoint verdict comment for an older head SHA does not satisfy this requirement for
  the current head.

## Rerun rules

<!-- rule: GATE-COMMENT-RERUN-RULES -->
`GATE-COMMENT-RERUN-RULES`:

| Scenario | Rule |
|---|---|
| Same head SHA rerun | Idempotent behavior: do not post a second visible marker for the same gate+head. Reuse/suppress by default; if correction is needed, update/replace the existing marker in place. |
| New head SHA rerun | A new visible checkpoint verdict comment must be posted for the new head; the older-head comment remains but does not satisfy readiness for the new head |

## Fail-closed behavior

<!-- rule: GATE-COMMENT-FAIL-CLOSED -->
`GATE-COMMENT-FAIL-CLOSED`: If the required checkpoint verdict comment cannot be posted
(for example due to a GitHub API error, permission restriction, or tooling failure), the
workflow MUST NOT cross the gate boundary:

- do not run `gh pr ready` (for `draft_gate`)
- do not declare final-approval readiness (for `pre_approval_gate`)

The gate boundary is not crossed until both the review verdict is `clean` **and** the
required visible PR comment is confirmed posted for the current head SHA.

## Relationship to other contracts

| Contract | Relationship |
|---|---|
| `draft_gate` boundary | Governs the draft → ready-for-review transition in [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md) Step 7 |
| `pre_approval_gate` boundary | Governs final-approval readiness in [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md) Step 7 and the narrowed [Final Approval](../skills/final-approval/SKILL.md) route |
| Local/session artifacts | These remain complementary; the visible PR comment is the minimum required auditable surface, not a replacement for all local artifacts |

## See also

- [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md) — broader lifecycle state machine
- [Checkpoint Review Chain Contract](./gate-review-sub-loop-contract.md) — execution shape for gate inspection work
- [Copilot PR Follow-up](../skills/copilot-pr-followup/SKILL.md) — skill that owns gate execution
- [Final Approval](../skills/final-approval/SKILL.md) — human approval gate route
- [Contract style guide](../skills/docs/contract-style-guide.md) — rule ID and RFC-2119 conventions
