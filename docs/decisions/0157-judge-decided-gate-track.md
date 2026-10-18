# 0157. The judge may only lower the gate track inside the existing floors

## Status

Proposed

## Context

Size-based light mode cannot lower review for a small additive change that exceeds the configured file and line cap. A 109-line logic change across four files paid full fan-out at both gates. Issue 2070 introduces a judge-decided track. A hand-applied or stale label could otherwise lower review without a judge decision.

## Decision

We add an optional judge track record with schema version 1: `headSha`, `track` (`light`, `reduced` or `full`) and at least one `{ signal, reason }` pair. The effective judge track is lowering only when the record is valid, its `headSha` equals the current head, and exactly one lowering label (`gate:light` or `gate:reduced`) matches the record track. Every other input resolves to `full`, including a label without a record, a record for another head, an invalid record, and two lowering labels.

The judge never changes `mode`, `angles`, `groups` or `floors` from `resolveReviewProportionality`. It adds `track` and `trackReason` only. A risk-path touch, a size-budget outcome that is not a clean pass, an unavailable or unclassifiable diff, and the `gate:full` label keep the track at `full`. A `light` judge track over the light-mode cap degrades to `reduced`. The existing thresholds stay unchanged.

Both gates (`draft` and `preApproval`) receive the same fact. `pre_approval` gains no new inline provenance path. Angle reduction by track is deferred to a later slice.

Rejected: letting a label alone lower the track (fail-open on stale or hand-applied labels), and raising the light-mode cap (a size proxy that does not separate additive from risky changes).

## Consequences

The resolver output gains two fields and the dispatch plan stays identical when no record is supplied. A later slice adds the producer (judge dispatch, record writer, label writer) and the angle reduction. Until then, no run lowers the track.
