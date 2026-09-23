# Refinement / Grill State Graph

Canonical owner for the refinement/grill sub-loop state machine.

This document defines the deterministic refinement/grill sub-loop state machine.

## Overview

The refinement loop runs the grill as a closed, deterministic sub-loop: load the target spec, detect gaps, consume a bounded answer input, synthesize sharpened sections into the body, and re-grill to a fixed point. One snapshot of point-in-time facts maps deterministically to exactly one current state plus its legal exits. The iteration lives entirely in the transition graph; the LLM answer and synthesis enter only as a bounded input consumed at the `await_answers` state, never as hidden orchestration inside a deterministic coordinator script.

This sub-loop is invoked by the `loop-grill` skill (`skills/loop-grill/SKILL.md`), which owns the agent-layer gap detection and the answer/synthesis steps. "Is it refined" is decided by the single source of truth, `detectIssueRefinementArtifact` (`packages/core/src/loop/issue-refinement-artifact.mjs`), the same check the enqueue gate uses.

Implementation:

- Pure logic: `packages/core/src/loop/refinement-grill-state.mjs`
- Detector CLI: `scripts/loop/detect-refinement-grill-state.mjs`

## State Definitions

| State | Meaning |
|---|---|
| `load_target` | The target issue/PR/plan body has not been loaded yet |
| `detect_gaps` | Loaded; run the gap detectors on the spec |
| `await_answers` | Answerable gaps are open, awaiting the bounded answer input (auto self-answer or human) |
| `synthesize` | The bounded answer input is present; synthesize AC/DoD/Non-goals into the body |
| `re_grill` | Synthesis applied; re-run gap detection to check for a fixed point |
| `grill_clean` | Grill reached a fixed point; the synthesized spec is clean |
| `needs_human_handoff` | An uncitable gap must be handed off honestly, naming the specific question |
| `blocked_needs_user_decision` | Load/parse failure or other fail-closed stop requiring explicit user direction |

## Required transitions

Terminal states with no outgoing transitions: `grill_clean`, `needs_human_handoff`, `blocked_needs_user_decision`.

- any non-terminal grill state -> `blocked_needs_user_decision`
  - a load/parse or other I/O failure fails closed from any non-terminal state (`load_target`, `detect_gaps`, `await_answers`, `synthesize`, `re_grill`)
- `load_target` -> `detect_gaps`
  - the target body loaded successfully
- `detect_gaps` -> `await_answers`
  - one or more answerable gaps were found
- `detect_gaps` -> `grill_clean`
  - detection found no open gaps AND provenance is recorded — a `plan` surface (shape-only, no comment surface), or a posted `🔬 Grill / refinement results` comment on the target (with or without a recorded bypass line). Zero open gaps with no recorded provenance stays at `detect_gaps`: the semantic pass is still owed, and it records its own provenance, including a zero-gap outcome (ADR 0084, amends ADR 0029).
- `detect_gaps` -> `needs_human_handoff`
  - detection surfaced an uncitable gap
- `await_answers` -> `synthesize`
  - the bounded answer input arrived for every open gap
- `await_answers` -> `needs_human_handoff`
  - an open gap proved uncitable while awaiting answers
- `synthesize` -> `re_grill`
  - AC/DoD/Non-goals were synthesized into the body
- `re_grill` -> `detect_gaps`
  - re-grill surfaced a new answerable gap; iterate
- `re_grill` -> `grill_clean`
  - re-grill found a fixed point
- `re_grill` -> `needs_human_handoff`
  - re-grill surfaced an uncitable gap

## Snapshot Contract

`normalizeGrillSnapshot` canonicalizes this schema:

- target: `surface` (`issue`|`pr`|`plan`), `targetRef`
- load state: `loaded`, `loadFailed`
- detection: `detectRan`, `openGapCount` (answerable gaps still awaiting an answer), `unresolvedGapCount` (uncitable gaps that must hand off)
- bounded answer input: `answersReady`, `synthesized`
- fixed-point signals: `reGrillRan`, `reGrillFixedPoint`
- recorded provenance (ADR 0084): `provenanceRecorded` (a `🔬 Grill / refinement results` comment is posted on the target), `provenanceBypass` (that comment also carries a recorded `bypass: operator-authorized by <handle>` line)

`loadFailed` fails closed from anywhere. `unresolvedGapCount > 0` outranks every non-failure branch: an uncitable gap always drives `needs_human_handoff`, never a fabricated synthesis. The bounded answer input (`answersReady`) is consumed only at `await_answers`; the machine never advances synthesis on its own. `interpretRefinementGrillState` also returns `reason` (a string naming the resolved branch, `null` when not applicable) and `bypass` (boolean); both are populated only for the zero-open-gap `detect_gaps` branch (`plan_shape_only`, `provenance_recorded`, `provenance_bypass_recorded`, or `provenance_missing`) and are `null`/`false` elsewhere.

The pure exported helper `detectGrillProvenance(comments)` returns `{ provenanceRecorded, bypass, bypassBy }` from an array of comments (each a string or an object with a string `body`); a non-array input yields no provenance. `bypassBy` is the matched handle from a recorded bypass line, or `null`. The detector CLI (`--comments-file`) maps this helper's `bypass` key onto the snapshot's `provenanceBypass` — the names differ, so a caller wiring the result by the snapshot's own field names must rename `bypass` to `provenanceBypass`; `bypassBy` has no snapshot counterpart. The ephemeral, gitignored `tmp/issues/issue-<n>/grill/` transcript is never a comment, so it never counts as provenance.

`detectGrillProvenance` trusts the comment's shape, not its author: it matches on the results-comment title alone, with no check against the commenter's GitHub identity, and the `bypass: operator-authorized by <handle>` handle is self-asserted text inside the comment body, never verified against the actual commenter. This is an accepted trust boundary (ADR 0084): provenance is defined as the comment's presence on the target, not its author, so any commenter on the target can currently record provenance or claim a bypass handle.

## Detector CLI Contract

`node scripts/loop/detect-refinement-grill-state.mjs` supports:

- `--input <path>` (snapshot interpretation only)
- `--body-file <path> [--surface issue|pr|plan] [--comments-file <path>]` (deterministic already-refined / zero-iteration seed)

The `--body-file` mode computes the deterministic AC-presence signal via `detectIssueRefinementArtifact` (the single is-it-refined source of truth): an already-refined body with recorded provenance (or a `plan` surface) seeds `grill_clean`; a body missing AC seeds `await_answers`. `--comments-file` (a JSON array of comments, or `{ "comments": [...] }`) feeds `detectGrillProvenance` to populate `provenanceRecorded`/`provenanceBypass`; omitting it means no recorded provenance. Any other JSON shape (wrong type, or an object without a `comments` array) fails closed with `--comments-file must be a JSON array or { "comments": [...] }` rather than silently treating it as no provenance. `--surface` and `--comments-file` both apply only to `--body-file` mode and are rejected alongside `--input`. The full semantic gap detection is the agent-layer bounded input consumed at `await_answers`.

Success output:

- `{ "ok": true, "snapshot": { ... }, "state": "...", "allowedTransitions": [...], "nextAction": "...", "reason": "..."|null, "bypass": false }`

Failure output:

- `{ "ok": false, "error": "..." }` on stderr with non-zero exit

## Rules

<!-- rule: GRILL-SUBLOOP-STATE-MACHINE -->
`GRILL-SUBLOOP-STATE-MACHINE`: The refinement/grill sub-loop MUST be modeled as this closed deterministic STATE+TRANSITIONS machine with a detector; iteration lives in the transition graph and the LLM answer/synthesis enters only as a bounded input consumed at the `await_answers` state, never as hidden orchestration in a deterministic coordinator script (keeps OPS-NO-INLINE-INTERPRETER clean).

<!-- rule: GRILL-SUBLOOP-ITERATE-TO-CLEAN -->
`GRILL-SUBLOOP-ITERATE-TO-CLEAN`: The grill MUST iterate detect-gaps -> answer -> synthesize -> re-grill to a fixed point, reusing the existing loop-grill gap detectors and `--auto` citability self-answer (not a parallel mechanism), and MUST reuse `detectIssueRefinementArtifact` as the single is-it-refined source of truth; an already-refined item with recorded provenance (a posted `🔬 Grill / refinement results` comment, or a `plan` surface, which is shape-only) reaches `grill_clean` in zero iterations without rewriting the body (ADR 0084, amends ADR 0029).

<!-- rule: GRILL-SUBLOOP-NO-EMBED-SYNTHESIS -->
`GRILL-SUBLOOP-NO-EMBED-SYNTHESIS`: Grill write-back MUST synthesize only the `## Acceptance criteria`, `## Definition of done`, and `## Non-goals` sections into the issue/PR/plan body (idempotent replace-section) and MUST NOT embed the raw Q&A transcript in the body; the raw transcript is written only to the gitignored, ephemeral `tmp/issues/issue-<n>/grill/` artifact.

<!-- rule: GRILL-SUBLOOP-HONEST-HANDOFF -->
`GRILL-SUBLOOP-HONEST-HANDOFF`: An uncitable gap (only-`inferred`, no codebase/doc/issue citation) MUST drive the machine to the `needs_human_handoff` terminal naming the specific question; interactive runs ask the human, headless/`--auto` runs park the item with the recorded reason, and the loop MUST NOT fabricate an answer to force convergence.

<!-- rule: GRILL-SUBLOOP-FULL-REWRITE -->
`GRILL-SUBLOOP-FULL-REWRITE`: Tracker-first write-back MUST fully rewrite the issue description into one locked, unambiguous spec — every in-body "suggested / option A or B / TBD" phrasing for a gap the grill decided MUST be resolved to its decided form (rejected alternatives deleted, not left alongside), and now-stale or contradicting prose MUST be removed. The post-grill description carries ONLY normative locked content (context, the decided approach, `## Acceptance criteria`, `## Definition of done`, `## Non-goals`, and a linked refinement doc if present) — never a `Refinement notes` / rationale narrative section.

<!-- rule: GRILL-SUBLOOP-RATIONALE-COMMENT -->
`GRILL-SUBLOOP-RATIONALE-COMMENT`: The refinement rationale (gaps found and filled, the RFC recommendation and rejected alternatives, and decisions taken) MUST be posted as a separate `🔬 Grill / refinement results` comment via `comment-issue.mjs` (never `gh issue comment` directly, never embedded in the description) — the description and the rationale are two distinct artifacts.

<!-- rule: GRILL-SUBLOOP-NO-BARE-HASH -->
`GRILL-SUBLOOP-NO-BARE-HASH`: Neither the rewritten description nor the results comment may use a bare `#<number>` for a non-issue/PR reference (e.g. a defect/item enumeration) — GitHub auto-links it to an unrelated issue/PR. Use `defect N` / `item N` / backticks for enumerations; reserve `#<number>` for a genuine issue/PR cross-reference.
