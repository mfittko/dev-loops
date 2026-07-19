# 0029. Run the refinement grill as a closed deterministic state machine with the LLM as a bounded input

## Status

Accepted — 2026-07-08 ([PR 1278](https://github.com/mfittko/dev-loops/pull/1278))

## Context

Issue/plan refinement is inherently iterative: detect spec gaps, collect answers, synthesize Acceptance criteria / Definition of done / Non-goals into the body, then re-check. Left as free-form agent orchestration, "is it refined" would be undecidable and unreproducible — exactly the drift the repo's state-machine idiom ([ADR 0002](./0002-deterministic-fail-closed-state-machines.md)) exists to prevent, and letting a deterministic coordinator script secretly drive LLM steps would break the `OPS-NO-INLINE-INTERPRETER` boundary. The sub-loop was escalated and accepted via [issue 1267](https://github.com/mfittko/dev-loops/issues/1267) and landed in [PR 1278](https://github.com/mfittko/dev-loops/pull/1278); the canonical graph lives in `docs/refinement-grill-state-graph.md`, the pure logic in `packages/core/src/loop/refinement-grill-state.mjs`, and the detector CLI in `scripts/loop/detect-refinement-grill-state.mjs`.

## Decision

We model the grill as a closed deterministic sub-loop state machine — `load_target → detect_gaps → await_answers → synthesize → re_grill → grill_clean` — mirroring the reviewer/copilot loop-state shape: a frozen state vocabulary, a frozen transitions table, a snapshot normalizer, and a pure interpreter that maps one snapshot to exactly one state plus its legal exits. The LLM's answers and synthesis enter only as a bounded input consumed at `await_answers`, never as hidden orchestration inside a coordinator script. The machine fails closed: any I/O or parse failure exits to `blocked_needs_user_decision`, and an uncitable gap always terminates at `needs_human_handoff` naming the specific question — we rejected fabricating answers to force convergence. We also rejected a parallel gap-detection mechanism and a second refinedness check: the grill reuses the existing loop-grill detectors, and refinement completeness has a single source of truth, `detectIssueRefinementArtifact` in `packages/core/src/loop/issue-refinement-artifact.mjs`, shared verbatim between the grill detector and the enqueue gate.

## Consequences

The core architectural stance — every handoff is an explicit decision on a state graph — now extends to the refinement family, so grill runs are reproducible: one snapshot of point-in-time facts maps to exactly one state, and an already-refined item reaches `grill_clean` in zero iterations without rewriting the body. Because the grill and queue admission share one detector, they can never disagree about what "refined" means, and anyone changing refinement semantics edits exactly one module. The cost is the idiom's usual ceremony: extending the grill (new states, new snapshot facts) means editing the frozen graph, its detector, and the state-graph doc together rather than tweaking prompt prose.
