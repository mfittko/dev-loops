# 0025. Demote the retrospective from merge gate to advisory findings

## Status

Accepted

## Context

The enforced retrospective merge gate ([record 0012](0012-retrospective-enforced-merge-gate.md)) repeatedly deadlocked loops, blocking ordinary product PRs on self-analysis and tooling-audit noise rather than code quality. The shipped `extension-defaults.yaml` had also turned the gate on for every consumer, contradicting the opt-in contract ([issue 841](https://github.com/mfittko/dev-loops/issues/841)), and it was defaulted back off ([PR 845](https://github.com/mfittko/dev-loops/pull/845)) with the internal-tooling requirement temporarily disabled outright. That left the modality question — may self-improvement output ever block delivery? — which was escalated and decided as "Reading B: return-only, no artifact, no retro gate" ([issue 1077](https://github.com/mfittko/dev-loops/issues/1077)), implemented in [PR 1085](https://github.com/mfittko/dev-loops/pull/1085). The affected seams are `packages/core/src/loop/pr-gate-coordination.mjs`, the handoff envelope (`packages/core/src/loop/handoff-envelope.mjs`), and `scripts/loop/check-retro-tooling.mjs`.

## Decision

We commit to the advisory design: the retrospective always runs, and its output never blocks merge or any PR-lifecycle transition. We removed the pre-merge retrospective gate (`evaluateRetrospectiveMergeApproval` and every call site in `pr-gate-coordination.mjs`) together with its config keys `requireRetrospectiveGate` and `requireRetrospectiveInternalTooling` — nothing is left to configure. Findings flow to the conductor through a structured `retrospectiveFindings` field in the handoff envelope, carrying the `check-retro-tooling.mjs` JSON output rather than prose, plus a single advisory PR comment for on-GitHub durability. We rejected Reading A (keeping the checkpoint file as the source of truth for findings and a disk artifact) and rejected keeping the gate merely defaulted off, since a dormant gate invites re-enabling the same deadlock. The startup/resume completion checkpoint (`requireRetrospective`) is retained; only the delivery-blocking modality is gone.

## Consequences

Self-improvement signals still inform the conductor's decisions but can no longer stall shipping, ending a whole class of loop deadlocks where a green PR sat blocked on raw-call classification noise. Contributors who find retrospective machinery with no enforcement teeth — and config keys that vanished from the schema, defaults, and `.devloops` — have this record to explain that gating the retrospective was tried, over-enforced consumers by accident, and was deliberately rejected. Any future proposal to make retrospective findings blocking must supersede this record rather than quietly reintroduce a gate. The trade-off is accepted: an agent can ship despite flagged tooling violations, and correcting that behavior is the conductor's job, not the merge gate's.
