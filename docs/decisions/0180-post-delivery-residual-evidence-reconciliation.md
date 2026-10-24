# 0180. Authenticate supplemental residual evidence before consuming it

## Status

Accepted — 2026-10-24 ([parent issue 2917](https://github.com/mfittko/dev-loops/issues/2917), [recording issue 2918](https://github.com/mfittko/dev-loops/issues/2918)).

## Context

A third delta review may exhaust its bound while leaving an evidence gap. Later
supplemental evidence can answer that gap at the unchanged candidate. A clean
gate, coordinator assertion or manually transcribed audit cannot itself assert
that every residual member is resolved. Historical results must remain truthful.

## Decision

Deliver this capability in two independently gated stages. The first authenticates
and records an explicit `residualEvidenceAssessment` from an original, freshly
pulled full draft-gate reviewer result. Existing reviewer widening delivers the
supplemental reads; no new role, transport, context flag or manifest is added.
Authenticate the canonical plan, current round, materialization, output ownership,
role/ref/digest/execution receipt and post-pull result. Require unchanged live
repo/PR/head, invocation-three `bounded_out`/`push_to_gate`, authenticated fixer
delivery, settled green CI and a subsequent valid full draft gate. Bind the
baseline, act set, original result/decision bytes, complete roots and members,
supplemental bytes, explicit positive conclusions and limitations. Preserve all
source bytes in a distinct additive repo/PR/head-scoped record. Missing, stale,
foreign, partial, carried, retired or tampered evidence refuses recording.

The first stage grants no closure authority: no apply action, reply, resolution,
historical-result rewrite, invocation reset, fourth delta or disposition change.
The parent remains open. The second stage will revalidate this same proof and the
live head before using canonical reply/resolve helpers. It will post a truthful
supplemental-evidence reply with an idempotency marker, retry without duplicate
replies and verify live resolution. The disposition consumer will expose the
reconciliation separately while preserving historical deferred dispositions and
all ordinary unresolved-thread guards. Until that stage ships, residuals stay open.

## Consequences

The existing harness-neutral reviewer protocol remains the trust boundary, not
cryptographic isolation against a malicious local writer. Unknown effective
model/effort remains unknown; initial-call evidence does not qualify configured
resumed execution. Each stage must fit the owner's 400 weighted-LOC cap and pass
normal lifecycle gates. No merge, tag, publish or approval authority is added.
