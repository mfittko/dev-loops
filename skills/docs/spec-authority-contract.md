# Immutable spec-authority contract

Canonical owner for immutable spec authority across the review / judge / fixer / gate / re-entry pipeline. The canonical tracker artifact's Acceptance Criteria, Definition of Done, and Non-goals are the immutable spec authority for a run. Reviewers report evidence and propose remedies; judges decide dispositions; fixers choose and validate implementation. None of those roles may add, remove, weaken, override, silently reinterpret, or replace the canonical spec.

The deterministic enforcement lives in `packages/core/src/loop/spec-authority.mjs`; the judge-pass bridge (`scripts/loop/judge-pass.mjs`) enforces it at the seam between fan-in and the fixer. This document is the normative source; other docs and harness prompts MAY summarize the outcomes and identities for operational guidance, but MUST NOT redefine, weaken, or override the rules defined here.

Adoption: the enforcement is engaged for a run by invoking the judge-pass bridge with `--spec-file` (plus `--content-digest` and the judge's `--spec-authority-verdict`). The live dev-loop conductor passes those on every gate round by default (ADR 0061, `docs/decisions/0061-engage-spec-authority-in-live-conductor.md`): `skills/dev-loop/SKILL.md` Phase 3.5 and `gate-review-sub-loop-contract.md` always run the `scripts/loop/spec-context.mjs` CLI seam to derive the spec/digest identities and always invoke judge-pass with them. This contract defines the mechanism and its tooling seam; ADR 0061 is the adoption decision that turned it on by default.

## Two independent revision identities

Every review, judge, fixer, gate, carry-forward, and re-entry record pins two independent identities plus the exact criteria it covered:

- `specDigest` — a deterministic digest of the normalized authoritative AC/DoD/Non-goals (`computeSpecDigest`). It identifies what the work is required and forbidden to do. It is `sha256:<hex>`.
- reviewed implementation revision — `headSha` (bare hex) plus a `contentDigest` (`sha256:<hex>`) of the implementation/prose actually reviewed. It identifies what the reviewer evaluated.

<!-- rule: SPEC-AUTHORITY-REVISION-IDENTITIES -->
`SPEC-AUTHORITY-REVISION-IDENTITIES`: `specDigest`, `contentDigest`, and `headSha` are distinct identities. `specDigest` MUST NOT be derived from `headSha`, and a new `headSha`/`contentDigest` MUST NOT masquerade as a spec change. `buildRevisionIdentity` fails closed when the identities collide or when a spec digest embeds the head SHA.

## Whole-spec disposition and the four named outcomes

<!-- rule: SPEC-AUTHORITY-WHOLE-SPEC-EVAL -->
`SPEC-AUTHORITY-WHOLE-SPEC-EVAL`: for every finding the judge evaluates the finding AND each proposed remediation against the COMPLETE authoritative AC/DoD/Non-goals identified by `specDigest`. A citation to one supportive criterion is insufficient: a decision's `checkedCriteria` MUST cover every criterion id or it cannot produce a valid disposition (fail closed).

The judge selects exactly one named, machine-readable outcome per finding:

| Outcome | Meaning | Resolution |
|---|---|---|
| `valid_compliant` | finding valid, remediation compliant with the whole spec | authorize the compliant remedy (the fixer may choose among compliant alternatives and must validate the chosen one against the whole spec) |
| `finding_conflicts` | the finding conflicts with an AC/DoD/non-goal | reject the finding autonomously; it cannot trigger a fix, stale an approval, or block a clean verdict merely by existing |
| `remediation_conflicts` | finding valid, but the proposed remediation conflicts with the spec | keep the finding, reject that remedy autonomously, route to a spec-compliant alternative |
| `spec_cannot_decide` | the spec is materially ambiguous, internally contradictory, or progress requires changing/reinterpreting AC/DoD/non-goals | escalate to an explicit human-spec-decision state |

The outcomes are ENFORCED on the fixer act list, not merely recorded: the judge-pass bridge drops every `finding_conflicts` finding from the act list (it cannot authorize a fix even if its relevance disposition was `act`), keeps `remediation_conflicts` findings actionable (the finding is valid; only its proposed remedy is rejected, and the fixer routes to a compliant alternative), and fails the pass closed on any `spec_cannot_decide`. Enforcement lives in shared tooling (`judge-pass.mjs`), engaged for a run by supplying `--spec-file`; a harness prompt never has to re-derive it.

<!-- rule: SPEC-AUTHORITY-CONFLICT-EVIDENCE -->
`SPEC-AUTHORITY-CONFLICT-EVIDENCE`: a `finding_conflicts` or `remediation_conflicts` outcome MUST name a non-empty `conflictingCriteria` set drawn from the spec — autonomous rejection is legitimate only when it names what the finding/remedy conflicts with. A non-conflict outcome MUST NOT carry a conflict list. A `valid_compliant` outcome MUST name an `authorizedRemediation`.

<!-- rule: SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED -->
`SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED`: a decision pins its own `specDigest`, `headSha`, and `contentDigest`; any that is stale or mismatched against the run's current identities fails closed. A decision made against a superseded revision never authorizes a fix or a gate transition at the current one.

## Last-resort human escalation

<!-- rule: SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT -->
`SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT`: only a `spec_cannot_decide` outcome escalates to the human-spec-decision state. A finding/remediation conflict alone does NOT justify escalation when the judge can reject it or route to a compliant alternative. When any finding needs a human spec decision, the judge-pass bridge fails closed and stops the loop at that state instead of feeding the fixer an act list from an undecidable spec.

## Human-only spec change

Only explicit human approval recorded on the canonical tracker artifact may authorize a material spec change or reinterpretation. The approved change produces a NEW `specDigest`; every approval, disposition, fixer authorization, carry-forward decision, and gate result derived from the prior `specDigest` becomes stale and must be re-established against the new revision. `resolveCriterionInvalidation` stales the full prior-approved set when the digest changes.

## Criterion-scoped invalidation (fixer push)

A fixer push records the new `headSha`/`contentDigest` and which previously reviewed criteria its change affects. `resolveCriterionInvalidation` (same `specDigest`):

- stales the approval for each affected criterion — a fresh review pinned to the new implementation revision and current `specDigest` is required before another gate/approval transition;
- carries an unaffected criterion forward ONLY when deterministic positive proof shows both its governing spec text is unchanged AND the implementation/content surface it covers is unchanged;
- fails closed to fresh review on unknown, incomplete, or unproven impact.

The judge-pass bridge is the runtime caller: `--prior-approvals` feeds the previous clean round's durable approval record into `resolveCriterionInvalidation`, and `--approvals-out` persists the new record (revision identities + approved criteria + invalidation result). A deterministic file→criterion producer, `resolveAffectedCriteria` (`--changed-paths` + `--coverage-map`), maps a fixer push's changed paths to the criteria whose declared coverage they intersect; it fails closed to the full prior-approved set (all-stale) on a changed path that matches no criterion's coverage, or when no coverage map is supplied at all. An unaffected criterion carries forward only when `--carry-forward-proof` positively proves both its spec text and covered surface unchanged — unknown impact fails closed to fresh review.

This composes with the fixer push/thread-disposition ordering owned by `skills/copilot-pr-followup/SKILL.md` Step 7 (`COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE`, `COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY`) and the fresh-review-context machinery in `gate-review-sub-loop-contract.md`: after an authorized fixer push, thread reply/resolution and live verification finish before the required fresh review begins. This contract adds authority and invalidation; it does not weaken that ordering, current-head gate evidence, CI, review coverage, approval, or merge-authorization requirements.

## Severity and batching never bypass authority

Low and nit findings receive the same whole-spec finding/remediation comparison before they may join an existing fixer pass. Severity and batching are advisory weight and scheduling; they never exempt a finding from `SPEC-AUTHORITY-WHOLE-SPEC-EVAL`.

## Cross-harness parity

The authority comparison, disposition outcomes, revision identities, invalidation, and re-entry enforcement live in shared deterministic core (`packages/core/src/loop/spec-authority.mjs`), so Pi, Claude Code, and Codex enforce identical behavior by calling the same core. Harness prompts may explain the rule but are never its sole enforcement. See `cross-harness-regression-contract.md`.

## Durable re-entry

The judge's spec-authority verdict artifact and the `--approvals-out` record are durable JSON: a fresh process reconstructs `specDigest`, `headSha`, `contentDigest`, checked/affected criteria, the per-finding outcome, rejected remediations, any pending human decision, and the stale-approval set without prompt memory.
