# Checkpoint Verdict Comment Contract

This document defines the required visible PR-comment contract for the two gate
boundaries in the dev-loop workflow: `draft_gate` and `pre_approval_gate`.

## Purpose

Gate-review PR comments make the workflow auditable and transparent from the PR
conversation alone. A reviewer or maintainer can inspect which gate ran, which head
commit was reviewed, whether it passed cleanly, and whether a result is current for
the latest head — without relying on local or session-only artifacts.

This document owns the visible checkpoint verdict comment evidence contract only. It does
not restate the full PR follow-up procedure; that remains owned by the relevant
workflow skill. The broader family-local PR lifecycle that consumes this evidence
is defined in [PR Lifecycle Contract](../skills/docs/pr-lifecycle-contract.md).

## Scope

This contract covers exactly two gates with distinct lifecycle semantics:

- `draft_gate` — **one-time transition boundary.** Runs right before `gh pr ready`
  (draft → ready-for-review boundary). Once a clean comment exists and the PR leaves
  draft, the gate is permanently satisfied; later head changes must not re-trigger it.
- `pre_approval_gate` — **recurring per-head gate.** Runs right before final approval /
  merge readiness on the current head SHA. A new pass is required for each new head
  after post-draft changes.

## Separate chains per gate

Each gate runs an independent review chain with its own disposition ledger. The chains
are not interchangeable:

| Gate | Own review angles | Own disposition ledger | Own exit conditions |
|---|---|---|---|
| `draft_gate` | Config: `gates.draft.angles` | `tmp/gate-findings/.../draft_gate-<sha>.json` | Clean = no blocking-severity findings for draft→ready |
| `pre_approval_gate` | Config: `gates.preApproval.angles` | `tmp/gate-findings/.../pre_approval_gate-<sha>.json` | Clean = no blocking-severity findings for final approval |

## Review-angle ownership and non-substitution rules

These gates are related but **not interchangeable**.

Each gate's review angles are defined in the project config (`gates.draft.angles` and `gates.preApproval.angles` in `.pi/dev-loop/defaults.yaml`). The reviewer persona for each angle is resolved via `resolveReviewerRole` from the persona registry (`packages/core/src/config/config.mjs`). Consumer repos may override angles and map custom personas via their own config.

Resolve angles at runtime with `resolveGateAngles(config, "draft")` and `resolveGateAngles(config, "preApproval")` from `@dev-loops/core/config`. Do not hardcode angle names in skill procedures or review prompts.

| Gate | Boundary it governs | Review angles | What a clean comment authorizes | What it does **not** authorize |
|---|---|---|---|---|
| `draft_gate` | Draft → ready for review | Resolved from `gates.draft.angles` in config | `gh pr ready` / leaving draft for the reviewed head SHA | final-approval readiness, merge-ready claims, or satisfaction of `pre_approval_gate` |
| `pre_approval_gate` | Final approval / merge readiness | Resolved from `gates.preApproval.angles` in config | approval-ready / final-human-approval readiness for the reviewed head SHA | draft-stage `gh pr ready` decisions for a different gate run |

A clean `draft_gate` comment does **not** satisfy `pre_approval_gate` requirements.
A clean `pre_approval_gate` comment does **not** retroactively replace the required `draft_gate` evidence for leaving draft.

## Required fields

Every gate-review PR comment must include:

| Field | Description |
|---|---|
| **Gate name** | `draft_gate` or `pre_approval_gate` |
| **Head SHA reviewed** | The exact commit SHA that was reviewed |
| **Verdict** | `clean`, `findings_present`, or `blocked` |
| **Blocking severities** | (clean verdicts only) Which severity levels must be clean per gate config |
| **Findings summary** | Short truthful audit summary. Use `no issues found` only when the reviewed head needed no corrective change for that gate pass. |
| **Next action** | One of: `stay draft and fix`, `rerun gate`, `mark ready for review`, `await final human approval` |

## Verdict definitions

| Verdict | Meaning |
|---|---|
| `clean` | No findings with a severity in the gate's `blockCleanOnFindingSeverities` remain |
| `findings_present` | The gate found issues at blocking severities; fixes are required before the gate boundary can be crossed |
| `blocked` | The gate could not complete or a hard blocker prevented a verdict |

## Disposition ledger

Every gate pass writes a durable final-findings log via `write-gate-findings-log.mjs`
before the visible PR comment is posted. The disposition ledger is the source of truth
for what the gate found and what was decided:

- each finding records: severity, review angle, summary, affected files
- resolved findings record the head SHA that resolved them
- the log is written under `tmp/gate-findings/<repo-slug>/pr-<N>/<gate>-<headSha>.json`

The visible PR comment is a summary for auditability; the disposition ledger is the
complete durable record.

## Readable deterministic format

- Keep the visible comment compact and deterministic, but slightly human-friendly:
  prefer labels like `Gate review`, `Reviewed head SHA`, `Verdict`, `Blocking severities`,
  `Findings summary`, and `Next action`.
- Preserve parser stability for gate name and reviewed head SHA; minor label wording is fine as long as those fields remain easy to extract deterministically.
- When a gate pass reached `clean` only after corrective changes on the reviewed head, the findings summary should briefly say what gap was found, what changed, and why the current head now satisfies the gate.
- Validation reporting in visible gate comments must stay concise by default:
  include command names plus pass/fail status, aggregate counts when useful, and
  current-head CI/check status when available — not raw passing log streams.
- Any command output included in the visible comment must be truncated to a
  deterministic retained-prefix length before comment creation; the rendered text may include a short truncation marker suffix.
- When validation fails, include only a focused relevant excerpt rather than an
  unbounded raw log dump; detailed logs may live in local/session artifacts or
  linked GitHub logs instead of the visible audit comment.

## Behavior requirements

**Post-before-fix ordering rule:** Gate-review findings must be posted as a
visible PR comment **before** the fix cycle begins. Fixes must not be applied
until the auditable trail exists on the PR. This applies to both gate boundaries.

### Draft gate (`draft_gate`) comment requirements

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

- When the `pre_approval_gate` runs, the PR must receive a visible checkpoint verdict comment.
- If the `pre_approval_gate` verdict is `findings_present` or `blocked`, the comment
  must state that follow-up fixes are required before final approval.
- Final-approval readiness must not rely only on local or hidden artifacts; the
  visible PR comment is the required auditable evidence.
- A checkpoint verdict comment for an older head SHA does not satisfy this requirement for
  the current head.

## Rerun rules

| Scenario | Rule |
|---|---|
| Same head SHA rerun | Idempotent behavior: do not post a second visible marker for the same gate+head. Reuse/suppress by default; if correction is needed, update/replace the existing marker in place. |
| New head SHA rerun | A new visible checkpoint verdict comment must be posted for the new head; the older-head comment remains but does not satisfy readiness for the new head |

## Fail-closed behavior

If the required checkpoint verdict comment cannot be posted (for example due to a GitHub
API error, permission restriction, or tooling failure), the workflow must not cross
the gate boundary:

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
