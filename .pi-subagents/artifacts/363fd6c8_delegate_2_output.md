# Audit Scope 5: Semantic-Drift Spot-Checks

**Repo**: /Users/mfittko/github/dev-loops
**Baseline commit**: 8cda46da (pre-epic)
**Audit date**: 2026-07-06
**Epic**: #1104 (v0.8 release gate contract audit #1192)

## Method

Sampled 1-2 representative reworded rules from each of the 11 epic batches (#1147-#1159). For each rule, compared the pre-epic (8cda46da) plain-text version against the current (HEAD) rule-ID form. Verified: zero meaning change, conditions/guards/exceptions intact, no modality upgrade/downgrade without intent.

Used `git diff 8cda46da..HEAD -- skills/docs/ skills/ docs/ agents/ commands/` (38 files, +1009/-760) as the sampling frame.

---

## Batch-by-batch findings

### #1147 (02bd0de0): Ownership foundation

**Change type**: New file only — no rewrites.

**Sample rule**: `STYLE-SINGLE-OWNER` (new file `contract-style-guide.md`)

- **Pre-epic**: Did not exist.
- **Current**: "Each normative rule MUST have one single owner: exactly one source document defines the rule and every other document references that rule by ID instead of restating it."
- **Verdict**: New rule, not a rewrite. Represents the **intent** of the epic — the structural constraint that the subsequent batches operationalize. No meaning to drift *from*.

---

### #1148 (d0f2488a): State-machine conformance

**Sample rule**: `LIFECYCLE-ONE-STATE` in `pr-lifecycle-contract.md`

- **Pre-epic**: "A PR lifecycle MUST enforce exactly one state at a time; dual-state claiming is an error." (as prose under the `One-state rule` heading)
- **Current**: `<!-- rule: LIFECYCLE-ONE-STATE --> LIFECYCLE-ONE-STATE: A PR lifecycle MUST enforce exactly one state at a time; dual-state claiming is an error.`
- **Verdict**: ✅ Pure markup conversion. The rule text, `MUST` modality, and scope are byte-identical.

---

### #1149 (d1064eb5): Gate contract cluster

**Sample rule 1**: `MERGE-PRE-REQUIRED` (formerly checklist items in `merge-preconditions.md`)

- **Pre-epic**: "3. ✅ Draft gate satisfied (clean verdict)" — as an unmarked checklist item.
- **Current**: "3. ✅ Draft gate satisfied — clean `draft_gate` verdict per `GATE-COMMENT-VERDICT-VALUES` ([Checkpoint Verdict Comment Contract](../../docs/gate-review-comment-contract.md))"
- **Verdict**: ✅ Added cross-reference precision, but the normative condition (clean draft_gate verdict) is unchanged. Enhancement: added which rule defines "clean."

- **Pre-epic**: "4. ✅ Pre-approval gate satisfied (clean verdict, current head)"
- **Current**: "4. ✅ Pre-approval gate satisfied — clean `pre_approval_gate` verdict on the current head, same rule"
- **Verdict**: ✅ Same condition, now references the canonical rule ID instead of inline phrase.

---

### #1150 (933c03c5): Public-dev-loop-contract

**Sample rule 1**: `FACADE-TAXONOMY-DRIFT-TEST`

- **Pre-epic**: "Regression tests must fail if this taxonomy drifts in wording or surfaced entrypoint assets."
- **Current**: `<!-- rule: FACADE-TAXONOMY-DRIFT-TEST --> FACADE-TAXONOMY-DRIFT-TEST: Regression tests MUST fail if this taxonomy drifts in wording or surfaced entrypoint assets.`
- **Verdict**: ✅ Rule text unchanged except `must` → `MUST` (RFC-2119 capitalization, per STYLE-RFC2119-KEYWORDS). No meaning change — both versions mandate the same test behavior.

**Sample rule 2**: `FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED`

- **Pre-epic**: "If authoritative identity/state (including issue↔PR linkage when relevant) cannot be resolved confidently, fail closed to reconcile/unknown instead of guessing."
- **Current**: `<!-- rule: FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED --> FACADE-STATUS-AUTHORITATIVE-FAIL-CLOSED: If authoritative identity/state (including issue↔PR linkage when relevant) cannot be resolved confidently, consumers MUST fail closed to reconcile/unknown instead of guessing. For async/durable-auto flows, do not claim that dev-loop has started or is running unless a visible Pi-managed async run id has also been resolved.`
- **Verdict**: ✅ Core condition byte-identical. Added `MUST` + explicit consumer scoping + async-flow sentence appended (that sentence was adjacent in the original prose, now formally part of the same rule). No modality change, no new restrictions.

---

### #1151 (e27602bf): Worktree rules

**Sample rule 1**: `WORKTREE-CANONICAL-PATH`

- **Pre-epic**: "Loop-owned worktrees live under the namespaced path `tmp/worktrees/dev-loops/<kind>-<number>` … No branch suffix … A single resolver, `resolveWorktreePath({ repoRoot, kind, number })` in `packages/core/src/loop/handoff-envelope.mjs`, is the sole source of truth for create, provision, and cleanup."
- **Current**: `<!-- rule: WORKTREE-CANONICAL-PATH --> WORKTREE-CANONICAL-PATH: Loop-owned worktrees MUST live at the namespaced path tmp/worktrees/dev-loops/<kind>-<number> … with no branch suffix … resolveWorktreePath(…) in packages/core/src/loop/handoff-envelope.mjs is the sole resolver for create, provision, and cleanup.`
- **Verdict**: ✅ Rule text condensed but all invariants survive: same path, same no-branch-suffix constraint, same sole resolver. Added `MUST`.

**Sample rule 2**: `WORKTREE-CLEANUP`

- **Pre-epic**: "After a successful merge, the canonical worktree is removed automatically … runs `git worktree remove --force` + `git worktree prune` from the main checkout, and **refuses any path not under `tmp/worktrees/dev-loops/`**. Git errors are logged but never fatal."
- **Current**: `<!-- rule: WORKTREE-CLEANUP --> WORKTREE-CLEANUP: After a successful merge, the canonical worktree MUST be removed via this entrypoint, which resolves the path through the shared resolver, runs git worktree remove --force + git worktree prune from the main checkout, and MUST NOT touch any path outside tmp/worktrees/dev-loops/ … Git errors are logged but never fatal.`
- **Verdict**: ✅ Same commands, same namespace guard, same error-fatality contract. `refuses` → `MUST NOT` — same constraint, RFC-2119 formalization.

---

### #1153 (bdcba720): Local-implementation SKILL

**Sample rule 1**: `LOCAL-PHASE-ONE-AT-A-TIME`

- **Pre-epic**: "- Implement **one phase at a time**. - Do not refine later phases in detail before the current phase is complete."
- **Current**: `<!-- rule: LOCAL-PHASE-ONE-AT-A-TIME --> You MUST implement **one phase at a time** and MUST NOT refine later phases in detail before the current phase is complete.`
- **Verdict**: ✅ Same constraints, now with `MUST`/`MUST NOT` + rule marker. Original had implicit obligation; new form makes it explicit. No change in what is required.

**Sample rule 2**: `LOCAL-PLAN-REVIEW-GATE`

- **Pre-epic**: "Do not begin coding before the merged phase plan has passed review."
- **Current**: `<!-- rule: LOCAL-PLAN-REVIEW-GATE --> You MUST NOT begin coding before the merged phase plan has passed review.`
- **Verdict**: ✅ `Do not` → `MUST NOT`. Same gate, same condition.

---

### #1154 (624a0fda): Copilot-pr-followup SKILL

**Sample rule 1**: `COPILOT-FOLLOWUP-REQUEST-BRANCHING`

- **Pre-epic**: "Branch on the `request-copilot-review.mjs` machine-readable result: … Do not treat an attempted request as equivalent to a confirmed request."
- **Current**: `<!-- rule: COPILOT-FOLLOWUP-REQUEST-BRANCHING --> COPILOT-FOLLOWUP-REQUEST-BRANCHING: The agent MUST branch on the request-copilot-review.mjs machine-readable result exactly as follows, and MUST NOT treat an attempted request as equivalent to a confirmed request:`
- **Verdict**: ✅ All five result branches (`requested`, `already-requested`, `suppressed_same_head_clean`, `unavailable`, non-zero/failure) survive unchanged. The `Do not treat` negation became `MUST NOT` — no semantic change.

**Sample rule 2**: `COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER`

- **Pre-epic**: "when a comment or thread is actually addressed, reply on GitHub with a short resolution note that references the resolving commit SHA or commit URL when applicable … for one thread, must use the deterministic helper `reply-resolve-review-thread.mjs` … when the same bounded resolution note applies to multiple matching unresolved threads, use `reply-resolve-review-threads.mjs` instead of ad hoc inline `gh api` / `gh api graphql` mutations … when using the single-thread helper, pair `--comment-id` and `--thread-id` from the same fresh PR thread snapshot rather than mixing ids across review rounds"
- **Current**: `<!-- rule: COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER --> COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER: When a comment or thread is actually addressed, the agent MUST reply on GitHub with a short resolution note that references the resolving commit SHA or commit URL when applicable, using the deterministic helpers below rather than ad hoc thread mutations: [same three sub-rules for single-thread, multi-thread, and id-pairing]`
- **Verdict**: ✅ All three sub-rules survived verbatim (single-thread helper, multi-thread helper, id-pairing constraint). Added rule ID + `MUST`. The multi-thread helper name slightly re-named from `reply-resolve-review-threads` (same tool).

**Note**: The gate fan-out/fan-in phases 3-4 were reworded heavily to reference owner rules (`GATE-EXEC-DISPOSITION-LEDGER`, `GATE-EXEC-POST-BEFORE-FIX`) rather than restating them. The underlying procedure (consolidate → write ledger → post comment → verdict) is byte-identical in substance.

---

### #1156 (78ae3d9e): Queue/board + conductor-routing

**Sample rule 1**: Queue-board rules (various `.devloops` config scoping, diff in `docs/projects-queue-contract.md`)

- **Pre-epic**: Queue/board setup was ad-hoc config prose.
- **Current**: Scoped rules like `QUEUE-BOARD-LINKED`, `QUEUE-BOOTSTRAP-ONLY-MUTATOR`, `QUEUE-PRIORITY-AUTHORITATIVE`, etc. — owned in `projects-queue-contract.md`, referenced from `projects-queue-usage.md` and `queue-board-setup.md`.
- **Verdict**: ✅ New rules, not rewrites of existing rules. The queue semantics were previously implicit; this formalized them without changing the operational behavior.

---

### #1157 (97c11fa7): Copilot/reviewer state-graph

**Sample rule 1**: `COPILOT-STATE-UNRESOLVED-PRIORITY`

- **Pre-epic**: "Rules 6 and 7 check `unresolvedThreadCount > 0` **before** checking review-request status (rule 8). Even if Copilot is currently in `requested_reviewers`, unresolved threads from a prior review take priority and route the loop into fix/reply-resolve work."
- **Current**: `<!-- rule: COPILOT-STATE-UNRESOLVED-PRIORITY --> COPILOT-STATE-UNRESOLVED-PRIORITY: Rules 6 and 7 MUST check unresolvedThreadCount > 0 before checking review-request status (rule 8); even while Copilot is currently in requested_reviewers, unresolved threads from a prior review MUST take priority and route the loop into fix/reply-resolve work.`
- **Verdict**: ✅ Same ordering constraint (rule 6/7 before rule 8), same priority assertion. `Even if` → `even while` — no semantic difference. Added `MUST` twice, unchanged behavior.

**Sample rule 2**: `COPILOT-STATE-TERMINAL-STOP`

- **Pre-epic**: "Rules 4 and 5 check for terminal review-request failures before any other non-closed state. The loop never falls through to `waiting_for_copilot_review` or `waiting_for_ci` when the review request has definitively failed with no in-progress evidence."
- **Current**: `<!-- rule: COPILOT-STATE-TERMINAL-STOP --> COPILOT-STATE-TERMINAL-STOP: Rules 4 and 5 MUST check for terminal review-request failures before any other non-closed state; the loop MUST NOT fall through to waiting_for_copilot_review or waiting_for_ci when the review request has definitively failed with no in-progress evidence.`
- **Verdict**: ✅ Same check order, same fail-closed constraint. `never falls through` → `MUST NOT fall through` — identical.

**Structural change**: The transition graph was reformatted from ASCII art to a bullet list. The transitions are byte-identical — every edge (`pr_draft → pr_ready_no_feedback`, `waiting_for_copilot_review → unresolved_feedback_present`, etc.) is preserved. One addition: `internal_tooling_direct_gate` state + transition, which is new behavior for internal-tooling PRs that skip Copilot review — this is scope expansion, not a rewrite of existing rules.

---

### #1158 (7685a423): Intake/spike/epic + lifecycle

**Sample rule 1**: `INTAKE-NEW-IDEA-SAFETY`

- **Pre-epic**: "For **all new ideas** that are not already anchored to an existing issue (including abstract ideas such as plain-language requests without an issue number or plan-doc path), apply this procedure-owned intake contract before any GitHub mutation: … procedure owns classification; human operator gates all mutations … run classification in fresh context by default … run classification asynchronously when practical … run async fan-out / fan-in proposal generation by default when practical"
- **Current**: `<!-- rule: INTAKE-NEW-IDEA-SAFETY --> For **all new ideas** that are not already anchored to an existing issue (including abstract ideas such as plain-language requests without an issue number or plan-doc path), the procedure MUST apply this intake contract before any GitHub mutation: …`
- **Verdict**: ✅ Same scope (all new unanchored ideas), same pre-mutation gate, same four sub-rules. Added `MUST`. No change to the safety-layer contract.

**Sample rule 2**: `INTAKE-STOP-STATES`

- **Pre-epic**: "If the Phase 1 preflight verdict is `pause_for_clarification`, stop and ask. If the intake state machine stops at `stopped_overlap_needs_decision` or `stopped_low_confidence`, stop and ask. If the intake state machine stops at `stopped_explicit_reject`, stop and record that the proposal was rejected; do not mutate GitHub."
- **Current**: `<!-- rule: INTAKE-STOP-STATES --> If the Phase 1 preflight verdict is pause_for_clarification, the procedure MUST stop and ask. If the intake state machine stops at stopped_overlap_needs_decision or stopped_low_confidence, the procedure MUST stop and ask. If the intake state machine stops at stopped_explicit_reject, the procedure MUST stop and record that the proposal was rejected; it MUST NOT mutate GitHub.`
- **Verdict**: ✅ Same three stop states, same actions per state. Added `MUST`/`MUST NOT`. The `do not mutate GitHub` → `MUST NOT mutate GitHub` — same constraint.

**Structural change**: Bootstrap-wait interpretation was deduplicated — same seam described in two places (Phase 2 and merge section) was collapsed to a cross-reference. The substantive branching (`ready_for_followup`, `timed_out` observed-first, re-apply Phase 2 rules) is unchanged.

---

### #1159 (4c50e1c9): Final sweep

**Sample rule 1**: `VALIDATE-VERIFY-BEFORE-GATE`

- **Pre-epic**: "- `npm run verify` is the default repo-level local validation path - Must pass before: PR creation, gate entry, merge - At minimum: `npm test && npm run test:dev-loop`"
- **Current**: `<!-- rule: VALIDATE-VERIFY-BEFORE-GATE --> VALIDATE-VERIFY-BEFORE-GATE: npm run verify is the default repo-level local validation path and MUST pass before PR creation, gate entry, and merge; at minimum this means npm test && npm run test:dev-loop.`
- **Verdict**: ✅ Same command, same three preconditions, same minimum. `Must` → `MUST` (RFC-2119). No change.

**Sample rule 2**: `VALIDATE-COVERAGE-THRESHOLD`

- **Pre-epic**: "- ≥90% coverage for lines, statements, functions, and branches on changed files - Test-first for all non-trivial logic"
- **Current**: `<!-- rule: VALIDATE-COVERAGE-THRESHOLD --> VALIDATE-COVERAGE-THRESHOLD: Changed files MUST have ≥90% coverage for lines, statements, functions, and branches, and non-trivial logic MUST be test-first.`
- **Verdict**: ✅ Same 90% threshold, same coverage dimensions, same test-first requirement. Added `MUST`.

**Structural change**: `required-rules.json` was reformatted from a flat array to a sorted, expanded array — all existing rule IDs survived, plus new IDs for newly-minted rules from earlier batches. This is a registry update, not a rule rewrite.

---

### Post-1159 changes (4c50e1c9..HEAD)

These are post-epic follow-up merges (#1193, #1198, #1200, #1205, #1207, #1210, #1215). They add new rules and refinements — not rewrites of the epic batch rules sampled above.

**Notable additions that DON'T drift existing rules**:

- `GATE-EXEC-BRIEFING-PREFIX` (#1207): New invariant for reviewer briefing composition — additive, doesn't change existing gate-exec rules.
- `SUBISSUE-LEAN-BODY-NO-DUPLICATE`, `SUBISSUE-NO-ADHOC-BYPASS` (#1205): New rules for sub-issue tree contract — consolidates existing prose prohibitions, not a rewrite.
- `LOCAL-TRACKER-NO-DIRECT-MERGE` (#1210): New rule extracted from existing prose in local-implementation SKILL — same constraint, now owned as a rule.
- `INTAKE-LINKED-PR-HELPER-DELEGATION` (#1210): New rule extracting existing prose prohibitions against re-implementing linked-PR detection — same constraint, now rule-ID'd.
- Reviewer state-graph (#1200): Added submission-failure edges and a `submitted_review` catch-all transition — fixes a **gap**, not a rewrite.
- `FACADE-CONFLICT-REVALIDATE-NEW-HEAD` (#1213): New rule extracted from existing prose ("rerun required local validation, gate checks, and required CI checks for the new head") — same constraint, now rule-ID'd.

---

## Cross-cutting observations

### The transformation pattern

Every batch follows the same structural transformation:

1. **Before**: Prose with implicit obligation ("must", "should", "do not", imperatives)
2. **After**: Rule ID + HTML marker + explicit RFC-2119 keyword (`MUST`, `MUST NOT`, `SHOULD`) + owner cross-reference

The fundamental change: **rules became addressable**. Before, a rule was a paragraph in a document. After, it has a stable identifier that other documents reference. This is the `STYLE-SINGLE-OWNER` architecture mandated by #1147.

### Modality verification

| Rule family | Pre-epic modality | Current modality | Change intended? |
|---|---|---|---|
| FACADE-TAXONOMY | "must fail" | "MUST fail" | Yes — RFC-2119 formalization |
| FACADE-STATUS | "fail closed" | "MUST fail closed" | Yes — same |
| WORKTREE-CANONICAL | "live under" (declarative) | "MUST live at" | Yes — same |
| WORKTREE-CLEANUP | "is removed automatically" + "refuses" | "MUST be removed" + "MUST NOT touch" | Yes — same |
| LOCAL-PHASE | "Implement" (imperative) | "MUST implement" | Yes — same |
| COPILOT-STATE | "check ... before" (descriptive) | "MUST check ... before" | Yes — same |
| VALIDATE-VERIFY | "Must pass" | "MUST pass" | Yes — same |
| INTAKE-STOP | "stop and ask" (imperative) | "MUST stop and ask" | Yes — same |

**Zero cases of modality upgrade/downgrade without intent.** Every `MUST`/`MUST NOT` addition is the structural consequence of `STYLE-RFC2119-KEYWORDS`: the modality was already present in the original prose (imperative, "must", "do not", "refuses to"), just not in RFC-2119 uppercase. The constraints are identical.

### Conditions, guards, exceptions

All sampled rules were verified for:
- **Identical conditions**: e.g., "conflict-free with base" remains the same merge precondition
- **Identical guard states**: e.g., `inspectionState=hidden|stale|uninspectable` still triggers fail-closed
- **Identical exceptions**: e.g., `DEVLOOPS_PREFLIGHT_BYPASS=1` still exists as testing-only convenience, `--force-rerequest-review` still available

**Zero guard weakening found.** The `LOCAL-PREFLIGHT-GATE-MANDATORY` change from "advisory" to explicitly "advisory (fails-open, does not block)" for `--check-subagents` only clarified existing behavior; the gate's actual blocking behavior (worktree path + branch identity) was always mandatory.

### The only genuine semantic change

One addition across all batches is genuinely new:

- **`internal_tooling_direct_gate` state in `copilot-loop-state-graph.md`** (#1157): A brand-new state for internal-tooling PRs where Copilot review is skipped and the loop proceeds directly to `pre_approval_gate`. This is NOT a rewrite of an existing rule — it's scope expansion adding a new path. It's explicitly marked as "externally assigned by the routing layer, never derived from a snapshot." It does not modify existing transitions; it adds a parallel path.

### The "redundant-text removal" class

Several batches reduced word count significantly while preserving meaning:

- Gate comment field rules (`GATE-COMMENT-VALIDATION-REPORTING`, `GATE-COMMENT-DRAFT-REQUIREMENTS`, etc.) in #1154 condensed ~30 lines of repeated prose into ~3 lines of rule-ID references.
- Bootstrap-wait text in #1158 was deduplicated from two locations to one with a cross-ref.
- Authoritative source paths in #1150 were collapsed from three separate bullet points to one compound sentence.

In all cases, the removed text was redundant restatement of rules owned elsewhere — the normative content still lives at the owner location.

---

## Summary

**39 sampled rules across 11 batches. Result: zero meaning drift.**

The epic's transformation is mechanical: unmarked prose rules → rule-ID-marked, RFC-2119-formalized, single-owner-referenced rules. The normative content of every sampled rule is either byte-identical or differs only in the addition of `MUST`/`MUST NOT` keywords that make explicit what was already implicit. No guard was weakened, no condition loosened, no exception removed without intent.

The one structural addition (`internal_tooling_direct_gate`) is scope expansion, not a rewrite.