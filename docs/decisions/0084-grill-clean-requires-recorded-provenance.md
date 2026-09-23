# 0084. Zero-iteration `grill_clean` requires recorded grill provenance, not just shape-clean detection

## Status

Accepted — 2026-09-23 ([issue 2364](https://github.com/mfittko/dev-loops/issues/2364))

Amends [ADR 0029](./0029-refinement-grill-deterministic-subloop.md): that record accepted `detectIssueRefinementArtifact` as the sole is-it-refined source of truth and let a zero-open-gap `detect_gaps` pass resolve straight to `grill_clean` — "an already-refined item reaches `grill_clean` in zero iterations without rewriting the body." It did not distinguish a genuinely already-refined target (one a grill pass previously synthesized and recorded) from a hand-authored matrix that was never grilled at all: both are shape-clean to the same detector, so both short-circuited. This record keeps 0029's detector and iterate-to-clean shape unchanged and adds a second, independent input — recorded provenance — that the zero-gap exit now requires.

## Context

A hand-authored issue can carry a valid AC→DoD matrix and Non-goals section without ever having been grilled. `detectIssueRefinementArtifact` is, by design, a completeness-and-shape check (`skills/docs/artifact-authority-contract.md`): "the mapping's semantic correctness is authored at refinement (loop-grill) … never by the predicate." Because Step 1 of `skills/loop-grill/SKILL.md` keyed its zero-iteration exit on that predicate alone, any shape-clean body — hand-authored or genuinely grilled — reached `grill_clean` with no comment, no rationale, and no semantic review. Measured on a four-issue batch (2026-09-22), three shape-clean issues short-circuited with no artifact produced, while the one run that bypassed the rule (under explicit operator instruction) produced the batch's only real grill pass and its only recorded rationale. The rule that is supposed to guarantee a grill was the only way to skip one.

The working precedent is `skills/docs/retrospective-checkpoint-contract.md`: a `complete` record whose `provenance` does not pin a fresh-context pass resolves to `MISSING` — the checkpoint does not trust its own artifact's shape as proof the work happened. `GRILL-SUBLOOP-RATIONALE-COMMENT` already mandates a durable `🔬 Grill / refinement results` comment for every grill run that fills a gap; this record makes that comment's presence (or absence) the second input the state machine reads.

## Decision

`grill_clean` from the zero-open-gap branch of `detect_gaps` now requires BOTH:

1. No open gaps (unchanged — `detectIssueRefinementArtifact` via `openGapCount === 0`), and
2. Recorded provenance: a `🔬 Grill / refinement results` comment already posted on the target issue or PR (with or without a recorded `bypass: operator-authorized by <handle>` line), OR the target is a `plan` surface.

`normalizeGrillSnapshot` gains two booleans, `provenanceRecorded` and `provenanceBypass`, and a new pure helper, `detectGrillProvenance(comments)`, computes them from the target's actual comments (a results-comment title match, plus an optional bypass-line match within that comment). `interpretRefinementGrillState` resolves the zero-gap branch to `grill_clean` only when `provenanceRecorded` (or `provenanceBypass`) is true or the surface is `plan`; otherwise it stays at `detect_gaps`, because the semantic pass is still owed. Every result now also carries `reason` (`plan_shape_only` | `provenance_recorded` | `provenance_bypass_recorded` | `provenance_missing` | `null`) and `bypass` (boolean), so a caller can tell a genuine zero-iteration exit from a first-run semantic pass.

`detectIssueRefinementArtifact` is unchanged and stays the sole shape/completeness predicate — this record does not add a second refinedness detector. Provenance is a separate, independently recorded fact (did a grill pass actually run and post its comment), never a proxy for semantic correctness.

Every semantic pass — including one that finds zero gaps — now posts the results comment, stating so explicitly ("no gaps were found"). Without this, a genuinely clean hand-authored spec would loop forever at `detect_gaps` (no provenance, no gap to trigger synthesis). A pass that proceeds despite a shape-clean detector, under explicit operator authorization, records that as a `bypass: operator-authorized by <handle>` line in the same comment; a normal pass carries no such line. Only the provenance-recorded zero-iteration `grill_clean` exit skips posting — there is nothing new to report.

Local plan files keep shape-only behavior unchanged: they have no comment surface, so `surface: "plan"` alone satisfies the zero-gap exit, exactly as before this record.

We rejected two alternatives. An HTML marker embedded in the results comment (or the body) as a machine-readable provenance flag: rejected because `GRILL-SUBLOOP-RATIONALE-COMMENT` already mandates the `🔬 Grill / refinement results` title as the artifact's identity, and every existing results comment would need a retroactive re-grill just to gain the marker. Keying provenance on the ephemeral `tmp/issues/issue-<n>/grill/` transcript: rejected because that path is gitignored and session-scoped — it is not a durable, shareable record, and staleness/loss of the tmp directory would silently regress the target to un-provenanced.

## Consequences

A hand-authored, never-grilled spec now gets a real semantic pass instead of a silent no-op, closing the defect the evidence batch exposed. A re-run against a target that already carries a recorded pass still reaches the zero-iteration exit with no new comment and no body rewrite, so idempotency is preserved. Bypassed runs are now distinguishable from normal runs in the durable record, which lets a later audit or retro tell the two apart without re-reading the tmp transcript (gone anyway). The cost is one more read per Step 1 (fetching comments) and one more snapshot input to keep in sync across the detector, its tests, the state-graph doc, and the SKILL.md prose — the same ceremony 0029 already accepted for this sub-loop's frozen-graph idiom.
