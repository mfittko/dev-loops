# 0243. Routed residue reaches the judge through the operator-focus carrier

## Status

Accepted — 2026-11-03 ([PR 3046](https://github.com/mfittko/dev-loops/pull/3046))

## Context

Issue [2971](https://github.com/mfittko/dev-loops/issues/2971) reports that an operator or orchestrator has no sanctioned path to route residue findings to the gate judge. On PR 2838 the residue reached the judge through a hand edit of the ledger. A hand-edited ledger carries no provenance, and the findings-log write cannot tell it from a forged one. The operator-focus carrier (`GATE-EXEC-OPERATOR-FOCUS`) already carries operator input into fan-in. PR [3046](https://github.com/mfittko/dev-loops/pull/3046) carries this slice.

## Decision

- Operator- or orchestrator-routed residue reaches the judge through the existing operator-focus carrier field `residue`. We add no second carrier.
- `scripts/loop/consolidate-fanin.mjs --operator-focus-file` is the only consumer that accepts `residue`.
- Fan-in records each residue entry as a finding under the reserved declared angle `operator-routed-residue`. The ledger `provenance.perAngle` gains an entry for that angle with `source: "operator-focus"` and a 64-hex `operatorFocusDigest`. The digest is an audit stamp. It does not bind the entry to a run; issue [2892](https://github.com/mfittko/dev-loops/issues/2892) slice 2 owns run binding.
- A residue entry without `severity` becomes `medium`.
- Residue requires `--emit-plan`. Fan-in refuses residue without it.
- `write-gate-findings-log.mjs` persists that one perAngle entry. It exempts only an entry on the reserved angle (no `carriedFromHead` and no `reviewer`, `dispatchId`, `model` or `group`) with that source and digest from reviewer pairing, emit-plan unit matching, and the foreign-angle check.
- The carry-forward resolver never carries the angle, so the angle lands in `mustRerun`. Re-routing is explicit at each head.
- The rule is `GATE-EXEC-ROUTED-RESIDUE-INPUT` in `skills/docs/gate-review-sub-loop-contract.md`.

Rejected alternatives:

- Hand-editing the ledger. This is the failure on PR 2838: the edit carries no provenance and bypasses the findings-log checks.
- A second carrier file. It duplicates the operator-focus input path, its sanitizing, and its digest.
- Accepting residue on the fan-out, judge, or fixer emitters. Each extra entry point is another place where residue could bypass fan-in sanitizing and the ledger provenance record.

## Consequences

Routed residue reaches the judge with a recorded source and digest, and a ledger is never hand edited. The carry-forward checks stay unchanged. The operator or orchestrator re-routes residue at each new head, because the resolver does not carry it. A verifiable run binding for the residue entry waits for issue 2892 slice 2.
