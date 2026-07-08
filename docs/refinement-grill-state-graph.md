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
  - detection found no open gaps (also the already-refined, zero-iteration path)
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

`loadFailed` fails closed from anywhere. `unresolvedGapCount > 0` outranks every non-failure branch: an uncitable gap always drives `needs_human_handoff`, never a fabricated synthesis. The bounded answer input (`answersReady`) is consumed only at `await_answers`; the machine never advances synthesis on its own.

## Detector CLI Contract

`node scripts/loop/detect-refinement-grill-state.mjs` supports:

- `--input <path>` (snapshot interpretation only)
- `--body-file <path> [--surface issue|pr|plan]` (deterministic already-refined / zero-iteration seed)

The `--body-file` mode computes only the deterministic AC-presence signal via `detectIssueRefinementArtifact` (the single is-it-refined source of truth): an already-refined body seeds `grill_clean`, a body missing AC seeds `await_answers`. The full semantic gap detection is the agent-layer bounded input consumed at `await_answers`.

Success output:

- `{ "ok": true, "snapshot": { ... }, "state": "...", "allowedTransitions": [...], "nextAction": "..." }`

Failure output:

- `{ "ok": false, "error": "..." }` on stderr with non-zero exit

## Rules

<!-- rule: GRILL-SUBLOOP-STATE-MACHINE -->
`GRILL-SUBLOOP-STATE-MACHINE`: The refinement/grill sub-loop MUST be modeled as this closed deterministic STATE+TRANSITIONS machine with a detector; iteration lives in the transition graph and the LLM answer/synthesis enters only as a bounded input consumed at the `await_answers` state, never as hidden orchestration in a deterministic coordinator script (keeps OPS-NO-INLINE-INTERPRETER clean).

<!-- rule: GRILL-SUBLOOP-ITERATE-TO-CLEAN -->
`GRILL-SUBLOOP-ITERATE-TO-CLEAN`: The grill MUST iterate detect-gaps -> answer -> synthesize -> re-grill to a fixed point, reusing the existing loop-grill gap detectors and `--auto` citability self-answer (not a parallel mechanism), and MUST reuse `detectIssueRefinementArtifact` as the single is-it-refined source of truth; an already-refined item reaches `grill_clean` in zero iterations without rewriting the body.

<!-- rule: GRILL-SUBLOOP-NO-EMBED-SYNTHESIS -->
`GRILL-SUBLOOP-NO-EMBED-SYNTHESIS`: Grill write-back MUST synthesize only the `## Acceptance criteria`, `## Definition of done`, and `## Non-goals` sections into the issue/PR/plan body (idempotent replace-section) and MUST NOT embed the raw Q&A transcript in the body; the raw transcript is written only to the gitignored, ephemeral `tmp/issues/issue-<n>/grill/` artifact.

<!-- rule: GRILL-SUBLOOP-HONEST-HANDOFF -->
`GRILL-SUBLOOP-HONEST-HANDOFF`: An uncitable gap (only-`inferred`, no codebase/doc/issue citation) MUST drive the machine to the `needs_human_handoff` terminal naming the specific question; interactive runs ask the human, headless/`--auto` runs park the item with the recorded reason, and the loop MUST NOT fabricate an answer to force convergence.
