# Audit: Scope 1 & 2 — Rule Ownership + L2/L3 State-Machine Conformance

**Date:** 2026-07-06
**Epic:** #1104
**Gate:** #1192 (v0.8 release gate contract audit)
**Scope:** 1 (rule ownership), 2 (L2/L3 state-machine conformance)

---

## 1. Rule Ownership Validation

**Command:** `node scripts/docs/validate-rule-ownership.mjs`
**Result:** PASS
**Output:** `Rule ownership validation passed: 141 rules, 13 references, 30 terms, 100 files scanned.`

### Checks verified

| Check | Status | Detail |
|-------|--------|--------|
| Canonical-owner line per normative doc | PASS | All `skills/docs/*.md` normative docs open with a "Canonical owner" declaration (head-of-file verification) |
| No duplicate rule definitions | PASS | 141 unique rule IDs, zero duplicate IDs across files (byId collision scan) |
| Required-rules manifest covers corpus | PASS | All 141 rules defined in source files are listed in `skills/docs/required-rules.json` |
| No unresolved rule references | PASS | 13 cross-doc `rule-ref` references, all resolve to defined rule IDs |
| No duplicate term definitions | PASS | 30 term definitions, zero duplicate key collisions |
| No near-duplicate rule bodies | PASS | Normalized-body dedup scan clean |
| No RFC-2119 modality conflicts | PASS | No MUST/SHOULD/MAY conflict on same normalized subject |
| No duplicate imperative sentences across docs | PASS | Ported from retired `validate-no-duplicate-rules.mjs`; KNOWN_INTENTIONAL_DUPLICATE_SENTENCES skip-list working as designed |

### DoD2: validate-no-duplicate-rules.mjs retirement

**Status:** CONFIRMED RETIRED.

The file `scripts/docs/validate-no-duplicate-rules.mjs` does not exist. Its unique check (duplicate-imperative-sentence scan) is ported into `validate-rule-ownership.mjs` (lines 117–144: `extractImperativeSentences`, `detectDuplicateImperativeSentences`), widened from `skills/` only to all `SOURCE_ROOTS` directories (`skills`, `agents`, `commands`, `docs`).

---

## 2. State-Machine Conformance (L2/L3)

**Command:** `node scripts/docs/validate-state-machine-conformance.mjs`
**Result:** PASS — all 4 machines pass

### Wired machines

| Machine | Doc | Code | L2 | L3 | Safety |
|---------|-----|------|----|----|--------|
| `pr-gate-coordination` | `skills/docs/pr-lifecycle-contract.md` | `packages/core/src/loop/pr-gate-coordination.mjs` | PASS | PASS | PASS |
| `conductor-routing` | `docs/conductor-routing-contract.md` | `packages/core/src/loop/conductor-routing.mjs` | PASS | PASS | PASS |
| `copilot-loop-state` | `docs/copilot-loop-state-graph.md` | `packages/core/src/loop/copilot-loop-state.mjs` | PASS | PASS | PASS |
| `reviewer-loop-state` | `docs/reviewer-loop-state-graph.md` | `packages/core/src/loop/reviewer-loop-state.mjs` | PASS | PASS | PASS |

### L2 (doc ↔ code) detail

- **pr-gate-coordination:** 17 doc transitions. 11 `verified` (actual `evaluatePrGateCoordination` calls), 4 `owned_elsewhere` (copilot inner-loop state progression), 1 `external` (human approval), 1 `owned_elsewhere` (merge decision). Zero `missing`, `divergent`, or `unreferenced` entries.
- **conductor-routing:** All transitions verified via `evaluateConductorRouting` + `getAllowedOuterTransitions`.
- **copilot-loop-state:** Transitions verified via `interpretLoopState` + TRANSITIONS table.
- **reviewer-loop-state:** Transitions verified via `interpretReviewerLoopState` + REVIEWER_TRANSITIONS table.

### L3 (graph invariants) detail

- **Completeness:** All non-terminal states have ≥1 outgoing transition. Zero dead-end states.
- **Liveness:** Every state can reach a terminal state. Zero stuck states.
- **Safety rules:** All 4 machines define per-machine safety predicates:
  - pr-gate-coordination: "no final-approval readiness without both gates clean"
  - conductor-routing: "fail-closed-no-dispatch" (fail-closed states never carry live handoff)
  - copilot-loop-state: "unresolved feedback must land in fix/reply-resolve state"
  - reviewer-loop-state: "local-failure-always-fails-closed"
  - All predicates pass over real observations from L2 checks.

### Known-gap / allowlist entries

**None active.** The only `known_gap` reference in the codebase is a historical comment at line 424: "Fixed by #1190 (previously a tracked known_gap; issue #1148 / epic #1104 comment thread)". No STALE entries exist. All transition entries in the wired machines are either `verified`, `external`, or `owned_elsewhere`.

### Machines not wired

`skills/docs/tracker-first-loop-state.md` describes a state machine ("State machine integration" section with states, transitions, nextAction mapping) and has a code implementation at `packages/core/src/loop/tracker-first-loop-state.mjs` exporting `TRACKER_STATES` and `TRACKER_TRANSITIONS`. However, the doc does **not** have a `## Required transitions` section, so the harness parser (`parseRequiredTransitions`) cannot ingest it. This machine is not registered in `validate-state-machine-conformance.mjs`.

Assessment: The doc references the machine as a state-graph doc but is structured differently (PR-level machine section + loop state machine section) without the `Required transitions` format. Whether this should be wired is a scope decision for the downstream epic — the current conformance harness is complete for the 4 machines it covers, and the tracker-first machine doc predates the harness format (#449 vs. #1148).

---

## 3. Link Validation

**Command:** `node scripts/docs/validate-links.mjs`
**Result:** PASS
**Output:** `Markdown links OK (97 files, 512 links checked).`

All intra-repo markdown links resolve.

---

## Residual notes

- The `validate-rule-ownership.mjs` scan is lexical (header comment confirms). Semantic/behavioral contradictions are deferred to the L2/L3 state machine harness.
- The `validate-state-machine-conformance.mjs` header explicitly documents the registration path: "adding a second machine requires ONLY calling `registerMachine(machine)`". No engine changes needed for new machines.
- `validate-no-duplicate-rules.mjs` retirement is clean — the script is removed and its unique check is ported and widened.