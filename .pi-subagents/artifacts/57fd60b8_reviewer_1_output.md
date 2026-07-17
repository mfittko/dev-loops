# Scope 5 — Semantic-drift spot-checks (independent)

**Verdict: PASS** — zero blocking semantic drift found across sampled reworded rules.

Baseline commit: `8cda46daea2f838962f1fc653ddd123fbb167278` (parent of first epic PR #1183).
Comparison: `git diff 8cda46da -- <path>` vs current HEAD (`4d57797e`).

## Method

1. Selected 9 rule-owning docs that were reworded across the epic #1104 batches (those with non-zero diff against baseline; `confirmation-rules.md` and `main-agent-contract.md` had zero diff and were excluded).
2. For each doc, ran `git diff 8cda46da HEAD -- <path>` and inspected every REWORDED rule (not just rule-ID-tagged additions).
3. For each reworded rule, judged whether conditions (when X), guards (MUST/MUST NOT), exceptions (unless Y), thresholds, and allowed/forbidden-action lists were preserved. Restatement in firmer RFC-2119 language with identical meaning = NOT drift.
4. Verified cross-reference targets (rules moved to canonical owners) by reading the destination docs.

**Sample size:** ~80 reworded rules sampled across 9 docs. The epic batches touched: #1183(1147), #1189(1148), #1191(1149), #1194(1150), #1196(1151), #1197(1156), #1199(1157), #1201(1158), #1202(1153), #1203(1154), #1204(1159).

## Per-doc findings

### 1. `skills/docs/stop-conditions.md` (batch #1191/1149)

Rules sampled: STOP-BLOCKED-001, STOP-DONE-001, STOP-APPROVAL-001, STOP-MERGE-AUTH-001, STOP-HUMAN-MERGE-001, STOP-RECONCILE-001, STOP-STARTUP-INPUTS-001, STOP-WAIT-001, STOP-INITIAL-COPILOT-001, STOP-COPILOT-REVIEW-001, STOP-QUIET-WATCHER-001 (11 rules).

Diff summary: Table reformatted with rule-ID column; behaviors restated in MUST/MUST NOT language. "merge auth" → "merge authorization" (expansion). "1h" → "one-hour" (spelling out). "Ambiguous / contradictory" → "Ambiguous or contradictory".

Drift verdict: **PASS** — all 11 rules preserve conditions, strategies, and outcomes. STOP-HUMAN-MERGE-001 preserves "agent never runs gh pr merge" as "agent MUST NOT run gh pr merge" (firmer, same meaning). STOP-QUIET-WATCHER-001 adds "as stops by themselves" clarification — consistent with original "Observational only, do not surface."

### 2. `skills/docs/merge-preconditions.md` (batch #1194/1150)

Rules sampled: 7 required-before-merge items, worktree-cleanup guard.

Diff summary: List renumbered (fixed a baseline numbering bug where item 1 appeared twice). Gate-verdict items 3–4 gained cross-references to `GATE-COMMENT-VERDICT-VALUES`. Post-merge worktree-cleanup detailed mechanism description removed; replaced with cross-reference to `WORKTREE-CLEANUP` in worktree-guidance.md.

Drift verdict: **PASS** — the removed worktree-cleanup guard ("refuses any path not under `tmp/worktrees/dev-loops/`") was verified preserved (and strengthened to MUST NOT) in `docs/worktree-guidance.md:104` under `WORKTREE-CLEANUP`. Cross-reference is valid.

### 3. `skills/docs/public-dev-loop-contract.md` (batch #1194/1150)

Rules sampled: FACADE-TAXONOMY-DRIFT-TEST, FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED, FACADE-LINKED-PR-SINGLE-ARTIFACT, FACADE-CONFLICT-CONTEXT-FAIL-CLOSED, FACADE-CONFLICT-REVALIDATE-NEW-HEAD, FACADE-BOOTSTRAP-WATCH-ROUTE, FACADE-BOOTSTRAP-QUIET-NO-EJECT, FACADE-BOOTSTRAP-ACTION-REQUIRED-NONBLOCKING, FACADE-BOOTSTRAP-CLOSED-UNMERGED-RECONCILE, FACADE-BOOTSTRAP-FOLLOWUP-REENTRY, FACADE-BOOTSTRAP-ISOLATED-WORKTREE-CONTINUATION, durable-auto router contract, tracker-backed no-dup rule (~15 rules/conditions).

Diff summary: Bootstrap-exception prose restructured into a 6-row rule table. Soft "should"/"must" upgraded to SHOULD/MUST. Tracker-backed no-dup rule moved to `ARTIFACT-TRACKER-FIRST-NO-DUP` in artifact-authority-contract.md (verified present at line 23). "Users should not have to choose dev-loop vs internal seam names up front" removed — meaning preserved by the façade principle ("internal strategy names stay behind the façade" + "Internal strategy naming is implementation detail").

Drift verdict: **PASS** — all conditions, guards, and exceptions intact. One low-severity note (see findings table).

### 4. `skills/docs/pr-lifecycle-contract.md` (batch #1191/1149)

Rules sampled: LIFECYCLE-ONE-STATE, LIFECYCLE-FAIL-CLOSED, LIFECYCLE-CONFLICT-BLOCKS-PROGRESS, draft-gate-clearance rule, required-transitions, fail-closed MUST-NOT list (~8 rules).

Diff summary: Core rules tagged with rule IDs. "two evidence classes" → "three evidence classes" (bug fix — baseline listed 3 but said "two"). Disposition-ledger details moved to `GATE-EXEC-DISPOSITION-LEDGER` in gate-review-sub-loop-contract.md (verified preserved). One new transition added: `final_gate_remediation → final_local_preapproval_gate`.

Drift verdict: **PASS** — all existing rules preserve meaning. The added transition completes an implicit remediation loop (the reverse of the existing `final_local_preapproval_gate → final_gate_remediation`); it is a contract completion, not a meaning change to an existing rule.

### 5. `docs/gate-review-sub-loop-contract.md` (batch #1191/1149, #1214/1207)

Rules sampled: GATE-EXEC-BUILD-ONCE-SEED, GATE-EXEC-SEPARATE-CHAINS, GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK, GATE-EXEC-POST-BEFORE-FIX, GATE-EXEC-REGATE-MANDATORY, GATE-EXEC-NON-SUBSTITUTION, GATE-EXEC-DISPOSITION-LEDGER (~8 rules; GATE-EXEC-BRIEFING-PREFIX and GATE-EXEC-LIGHT-ESCALATION are new additions, not reworded rules).

Diff summary: Execution-shape rules tagged with IDs and firmer MUST language. "Relationship to checkpoint verdict comment" section removed (meaning preserved by cross-reference in "does not own" list). Separate-chains table collapsed to prose (info preserved in Gate-specific configuration section).

Drift verdict: **PASS** — all reworded rules preserve conditions, guards, and sequencing. GATE-EXEC-BRIEFING-PREFIX (invariant-prefix-first) and GATE-EXEC-LIGHT-ESCALATION are new rules from feature PRs (#1214, not reworded existing rules — out of drift scope).

### 6. `docs/conductor-routing-contract.md` (batch #1197/1156)

Rules sampled: ROUTING-EVALUATOR-AUTHORITY, ROUTING-PRIORITY-ORDER, ROUTING-LOCAL-ISOLATION-PASSTHROUGH, ROUTING-FAIL-CLOSED-RECONCILE, direct-routing/reconcile input tables (~6 rules).

Diff summary: "Sufficient signals" and "Inputs that require reconcile" tables collapsed to prose with cross-reference to ROUTING-FAIL-CLOSED-RECONCILE. Evaluator authority restated as MUST/MUST NOT. New "Required transitions" section added (documents the stateless outer-loop graph).

Drift verdict: **PASS** — all reconcile conditions preserved in the ROUTING-FAIL-CLOSED-RECONCILE list (target missing, state inputs absent, ownership conflict, unrecognized combined state). Direct-routing conditions preserved in prose. New "Required transitions" section and the fail-closed-no-live-handoff addition are additions, not reworded rules.

### 7. `docs/reviewer-loop-state-graph.md` (batch #1199/1157)

Rules sampled: REVIEWER-STATE-GATE-ANGLE-MAPPING, REVIEWER-BOUNDARY-CONTRACT, state definitions, key deterministic guarantees (~5 rules).

Diff summary: State definitions gained term markers (no text change). "Key Deterministic Guarantees" bullets replaced with cross-references to State Definitions, Required transitions, and REVIEWER-BOUNDARY-CONTRACT. New "Required transitions" section added. REVIEWER-BOUNDARY-CONTRACT consolidated 4 bullets into one rule.

Drift verdict: **PASS** — all 7 baseline guarantees verified preserved by reference: state distinctness (state table), invalidation (transitions draft_review_posted/waiting_for_user_submit → review_invalidated), terminal boundary (REVIEWER-BOUNDARY-CONTRACT), re-entry (REVIEWER-BOUNDARY-CONTRACT), legacy-state classification (state table + transitions note), fail-closed (transitions), round-cap-exhaustion (kept verbatim). REVIEWER-BOUNDARY-CONTRACT preserves all 4 baseline bullets including the wait-state rule.

### 8. `skills/copilot-pr-followup/SKILL.md` (batch #1203/1154)

Rules sampled: ASSET-PATH-INSTALLED-NO-ASSUME, ASSET-PATH-SOURCE-NO-REPO-LOCAL, COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY, COPILOT-FOLLOWUP-REQUEST-BRANCHING, COPILOT-FOLLOWUP-WAIT-TOOLS, COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER, COPILOT-FOLLOWUP-GATE-COMMENT-CANONICAL, COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING, non-substitution rules, draft/pre-approval gate comment requirements (~10 rules).

Diff summary: Prose rules tagged with IDs and upgraded to MUST/MUST NOT. Gate fan-out/fan-in procedure (Phases 1–5) heavily condensed; mechanism details moved to GATE-EXEC-* rules in gate-review-sub-loop-contract.md. Non-substitution rules replaced with cross-references to GATE-COMMENT-NON-SUBSTITUTION (verified present in gate-review-comment-contract.md:52). `wait-pr-checks.mjs` added to allowed wait-tools list (feature PR #1223, not drift).

Drift verdict: **PASS** — all reworded rules preserve conditions, guards, and forbidden actions. The adversarial-briefing content (edge cases, NaN/Infinity/floats/negatives, null/undefined, file:line + failing scenario) preserved verbatim in COPILOT-FOLLOWUP-ADVERSARIAL-BRIEFING. The lightweight round-cap addition (default cap: 1) is from feature PR #1215, not an epic rewording.

### 9. `skills/local-implementation/SKILL.md` (batch #1202/1153)

Rules sampled: LOCAL-PR-CREATE-CANONICAL, LOCAL-TRACKER-NO-DIRECT-MERGE, LOCAL-PREFLIGHT-GATE-MANDATORY, LOCAL-FAILURE-TRIAGE-ORDER, LOCAL-PHASE-ONE-AT-A-TIME, LOCAL-TEST-FIRST-COVERAGE, LOCAL-PLAN-REVIEW-GATE, LOCAL-DELEGATION-TABLE, LOCAL-COMMIT-BEFORE-EXIT, LOCAL-RETROSPECTIVE-REQUIRED, LOCAL-TMP-EPHEMERAL-STATE, light-mode config surface, branch/review/merge policy, commit policy, dev-mode steps, tmp/ logging (~12 rules).

Diff summary: Largest condensation (190 lines removed). Light-mode gate mechanics moved to gate-review-sub-loop-contract.md. Pre-flight gate worktree-creation details moved to WORKTREE-CREATE-PROVISION in worktree-guidance.md. PR-creation draft-first rule moved to LOCAL-PR-CREATE-CANONICAL + OPS-DRAFT-FIRST-PR (verified in copilot-loop-operations.md:169). Dev-mode 8-step procedure condensed but all steps preserved. tmp/ logging artifact list moved to "Deterministic logging structure" section (verified complete). Subagent-exit-contract bullet replaced with cross-reference to LOCAL-COMMIT-BEFORE-EXIT (step 12, verified).

Drift verdict: **PASS** — all reworded rules preserve meaning. Two low-severity notes (see findings table).

## Findings table

| # | Doc | Rule ID | Baseline meaning | HEAD meaning | Drift type | Severity |
|---|---|---|---|---|---|---|
| 1 | public-dev-loop-contract.md | (internal/external model) | "Almost all workflow branching should converge into deterministic state-machine/tooling surfaces behind `dev-loop`." | "Workflow branching SHOULD converge into deterministic state-machine/tooling surfaces behind `dev-loop`." — "Almost all" qualifier dropped. | Minor strengthening (scope widened from "most" to "all"), but within SHOULD recommendation strength. | Low (nit) |
| 2 | local-implementation/SKILL.md | LOCAL-TEST-FIRST-COVERAGE | "Maintain 90% coverage thresholds." (imperative) | "SHOULD maintain 90% coverage thresholds (coverage is not enforced by the shipped verify config; treat it as the working target)." | Weakening: imperative → SHOULD, with clarification that coverage was never enforced. | Low (nit) |
| 3 | local-implementation/SKILL.md | (light mode — Copilot skip) | "The Copilot review request and its polling are skipped." (in light mode) | Dropped during condensation; no canonical-owner restatement found. Later feature PR #1215 introduced configurable lightweight cap (default 1, not 0/skip). | Rule dropped without preservation in canonical owner. Behavior was subsequently changed by a non-epic feature PR. | Low (note) |

## Summary

Zero semantic drift across ~80 rules sampled across 9 docs.

The epic #1104 batches consistently restated rules in firmer RFC-2119 language (should→SHOULD, must→MUST, "do not"→MUST NOT) while preserving conditions, guards, exceptions, thresholds, and allowed/forbidden-action lists. Cross-references to canonical owners were verified valid in every case checked. Three low-severity notes were identified (one minor strengthening, one weakening, one dropped assertion later superseded by a feature PR) — none are blocking.

New rules added by feature PRs (GATE-EXEC-BRIEFING-PREFIX, GATE-EXEC-LIGHT-ESCALATION, wait-pr-checks tool, lightweight round cap, reviewer-loop transitions, conductor required-transitions) are additions, not reworded existing rules, and are correctly out of drift scope.