# 0060. Immutable spec authority across judge, fixer, and review revalidation

## Status

Accepted — 2026-09-06

## Context

The review/judge/fixer pipeline did not treat the canonical tracker's Acceptance Criteria, Definition of Done, and Non-goals as immutable authority across review, remediation, and re-entry.

The judge's disposition vocabulary was relevance-only (`act`/`defer`/`reject`). A judge could classify a finding or a proposed remediation as relevant by citing one supportive criterion without checking it against the complete spec, so a reviewer finding could become de facto authority over another criterion or a non-goal. Separately, an approval could remain accepted after later content changes because the system did not distinguish the authoritative spec revision from the reviewed implementation revision, and had no criterion-scoped invalidation: carry-forward was angle/file-surface scoped (`gate-carry-forward.mjs`), not approval/criterion scoped.

This is an authority, precedence, provenance, and invalidation gap in shared workflow semantics — it affects Pi, Claude Code, and Codex — not a missing-role or same-agent self-review defect. The independent judge role is required and stays.

This change adds a new contract-doc surface (`skills/docs/spec-authority-contract.md`) with `<!-- rule: -->` markers, which trips the ADR tripwire (`0052`); this record satisfies it.

## Decision

Introduce one canonical shared contract surface, `packages/core/src/loop/spec-authority.mjs` (pure, fail-closed), owning:

1. Two independent revision identities: `specDigest` (a digest of the normalized AC/DoD/Non-goals) and the reviewed implementation revision (`headSha` + `contentDigest`). `specDigest` is `sha256:`-prefixed and is never derived from `headSha`; the two are structurally distinguishable so a head SHA can never stand in for a spec digest (`SPEC-AUTHORITY-REVISION-IDENTITIES`).

2. Whole-spec disposition: for every finding the judge evaluates the finding AND each proposed remediation against the complete criterion set. A decision's `checkedCriteria` must cover every criterion id; a supportive-only/partial citation fails closed (`SPEC-AUTHORITY-WHOLE-SPEC-EVAL`). Exactly one of four named outcomes is selected: `valid_compliant`, `finding_conflicts`, `remediation_conflicts`, `spec_cannot_decide`. Conflict outcomes require explicit `conflictingCriteria` (`SPEC-AUTHORITY-CONFLICT-EVIDENCE`).

3. Autonomous vs last-resort escalation: only `spec_cannot_decide` escalates to a human-spec-decision state; a finding/remediation conflict resolves autonomously (`SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT`). The judge-pass bridge fails closed and stops the loop when any finding needs a human decision, instead of feeding the fixer.

4. Stale-revision fail-closed: each decision pins its own `specDigest`/`headSha`/`contentDigest`; any mismatch against the run's current identities fails closed (`SPEC-AUTHORITY-STALE-REVISION-FAIL-CLOSED`).

5. Revision-scoped invalidation (`resolveCriterionInvalidation`): a human-approved spec change (new `specDigest`) stales every prior-derived approval; a fixer push (same digest) stales only affected criteria, carries an unaffected criterion forward only with positive proof that both its governing spec text and its covered surface are unchanged, and fails closed to fresh review on unknown/unproven impact.

Enforcement is wired into the judge-pass bridge (`scripts/loop/judge-pass.mjs`) as an opt-in gate via `--spec-file` (plus `--content-digest` and `--spec-authority-verdict`), keeping the existing relevance axis (`act`/`defer`/`reject`) intact and backward compatible. The bridge does not merely record the outcomes: it derives the revision identities through `buildRevisionIdentity` on the live path (so the collision/derivation checks run for a real gate), drops every `finding_conflicts` finding from the fixer act list, fails closed on `spec_cannot_decide`, and — with `--prior-approvals`/`--approvals-out` — invokes `resolveCriterionInvalidation` and persists a durable, re-entry-safe approval record.

## Consequences

- Shared deterministic core is the single enforcement authority; harness prompts explain but do not solely enforce, so the three harnesses behave identically by construction.
- The judge now emits a whole-spec authority verdict in addition to its relevance verdict; the judge agent prompt documents the four outcomes and the pinned identities.
- Criterion-scoped invalidation composes with, and does not weaken, the `COPILOT-FOLLOWUP-VERIFY-BEFORE-RESOLVE` / `COPILOT-FOLLOWUP-RESOLVE-AFTER-REPLY` ordering or the fresh-review-context machinery.
- The gate does not broaden into presentation content work, and the separate fixer push/thread-disposition sequencing contract is unchanged.
- Backward compatibility: callers that do not pass `--spec-file` keep the prior judge-pass behavior; new spec-authority enforcement is additive.
- Adoption boundary: this change delivers the enforcement mechanism and its tooling seam. Making the live dev-loop conductor pass `--spec-file`/`--content-digest`/`--spec-authority-verdict` on every gate round by default — so the running auto-loop engages it without an explicit opt-in — is a behavior change to every run and is deferred to a follow-up, to be adopted deliberately rather than switched on implicitly here.
