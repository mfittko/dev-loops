# Scope 3 — RFC-2119 contradiction scan (independent)

**Verdict: PASS** — no blocking RFC-2119 contradictions found. One waiver-grade
modality downgrade and one scoping nit recorded below; neither blocks the v0.8
release gate.

Independent reviewer with no prior context from epic #1104 batch PRs. Performed a
semantic prose pass over the full rule registry that the lexical validator
(`scripts/docs/validate-rule-ownership.mjs`, green at HEAD: "141 rules, 13
references, 30 terms, 100 files scanned") cannot do.

## Findings

| # | Rule IDs | Location(s) | Conflict type | Evidence (quoted prose) | Severity |
|---|---|---|---|---|---|
| 1 | `VALIDATE-COVERAGE-THRESHOLD` vs `LOCAL-TEST-FIRST-COVERAGE` | `skills/docs/validation-policy.md:20` (canonical owner) vs `skills/local-implementation/SKILL.md:111` (non-owner skill) | Modality downgrade (MUST → SHOULD) + ownership restate | Owner: "Changed files **MUST** have ≥90% coverage for lines, statements, functions, and branches, and non-trivial logic MUST be test-first." Skill: "You MUST work **test-first** … and **SHOULD** maintain **90% coverage** thresholds (coverage is **not enforced by the shipped verify config**; treat it as the working target)." Same behavior (≥90% coverage on changed files / non-trivial logic), opposing modality. The skill rule additionally asserts the canonical MUST is *not* enforced ("not enforced by the shipped verify config"), directly contradicting the owner's MUST, and restates the threshold instead of referencing `VALIDATE-COVERAGE-THRESHOLD` by ID (violates `STYLE-REFERENCE-BY-ID` / `STYLE-SINGLE-OWNER`). | waiver |
| 2 | `TRACKER-PROJECTION-REQUIRED-METADATA` vs `OPS-DRAFT-FIRST-PR` | `skills/docs/tracker-first-loop-state.md:62` vs `skills/docs/copilot-loop-operations.md:169` | Conflicting guard on the same transition (PR-create draft state), scoped to different modes | Tracker-first projection: "Draft state \| PR **MUST** start as a draft. It **MUST NOT** be marked ready-for-review until development work is complete." (unconditional within tracker-first mode). General workflow: "New PRs in this workflow **MUST** be opened as **draft** PRs first **when the repository enables** `workflow.requireDraftFirst` … (the built-in shipped default remains permissive)". Not a true same-scope contradiction — the tracker-first contract is a mode-specific stricter invariant — but in the tracker-first + `requireDraftFirst: false` case the two rules state the same transition with different preconditions. Worth a cross-reference so the precedence is explicit. | nit |

## Notes / non-findings (checked, no contradiction)

- `GATE-EXEC-REGATE-MANDATORY` ("gate MUST NOT be skipped because a previous head was clean") and `GATE-SKIP-NOT-RECOVERABLE-BY-CONVERGENCE` ("Skipping the gate MUST NOT be treated as recoverable by asserting convergence") — same direction, mutually reinforcing, no conflict.
- `GATE-COMMENT-DRAFT-REQUIREMENTS` (one-time `draft_gate`) vs `GATE-COMMENT-RERUN-RULES` (recurring `pre_approval_gate`) — the doc explicitly reconciles the recurrence difference ("so the two rules do not conflict").
- `RETRO-GATE-FAIL-CLOSED` (routing gate stops on `needs_reconcile`) vs `RETRO-ADVISORY-NEVER-GATE` (retrospective findings MUST NOT block merge) — different subjects (routing gate vs merge gate); the doc explicitly states the former pre-merge contradiction is resolved by removing the pre-merge gate.
- `LIFECYCLE-CONFLICT-BLOCKS-PROGRESS` vs `FACADE-CONFLICT-CONTEXT-FAIL-CLOSED` / `FACADE-CONFLICT-REVALIDATE-NEW-HEAD` — different layers (lifecycle negative boundary vs conflict-reconciliation path), consistent.
- `STOP-HUMAN-MERGE-001` / `STOP-MERGE-AUTH-001` / `LOCAL-TRACKER-NO-DIRECT-MERGE` / merge-preconditions — all aligned: agent never runs `gh pr merge` under `humanMergeOnly`; no direct local-main merge.
- QUEUE fail-closed family (`QUEUE-NEXTUP-EMPTY-FAIL-CLOSED`, `QUEUE-BOARD-QUERY-FAIL-CLOSED`, `QUEUE-NEXTUP-TARGET-MISSING-FAIL-CLOSED`, `QUEUE-LIVE-PICKUP-SOURCE`) — all consistently MUST NOT fall back to Backlog.
- `FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION` (SHOULD continue through isolated worktree) vs the gate-review "Worktree isolation is PROHIBITED for per-angle gate reviewers" — different scopes (follow-up handoff vs per-angle reviewers), no conflict.

## Footer

- **Rules reviewed:** 141 unique rule IDs (matches `skills/docs/required-rules.json` registry count of 141; `comm` diff between corpus markers and registry = 0 in both directions).
- **Files scanned:** 100 contract/source files across `skills/docs/*.md`, `docs/*.md`, `skills/*/SKILL.md`, `agents/*.md`, `commands/*.md` (per the lexical validator's reported scan set; rule markers confirmed present in `skills/docs/`, `docs/`, and `skills/copilot-pr-followup` + `skills/local-implementation` SKILL.md; no rule markers in `agents/*.md` or `commands/*.md`).
- **Method:** read `required-rules.json` + `contract-style-guide.md`; enumerated every `<!-- rule: ID -->` marker via `grep -rn '<!-- rule:'` across the four roots; extracted each rule's RFC-2119 modality and behavior/guard from the prose (not tokens); cross-compared same-behavior rules across owner docs for opposing modality, guard conflicts, modality downgrades, and dual-owner restatements. Cross-checked against the lexical validator's green HEAD result; this pass covers only the semantic layer the lexical scan cannot reach.
- **Single-owner / duplication posture:** lexical validator confirms every rule ID has exactly one owner and no duplicated rule bodies or imperative sentences; the only ownership concern found is the coverage-threshold restate in finding #1 (a weaker-modality restate, not a verbatim duplicate, so it slipped the lexical duplicate scan).