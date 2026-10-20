# 0174. A named rerun angle forces a carried finding out of carry-forward

## Status

Accepted — 2026-10-20 ([issue 2895](https://github.com/mfittko/dev-loops/issues/2895))

## Context

PR 2891 carried a stale config-drift high through rounds 2 to 5. The judge rejected the finding in consecutive rounds, and code changes had removed its premise. Carry-forward kept the finding alive anyway, and a high blocks a clean verdict.

The only escapes were a hand edit of the ledger or plan, which issue 2892 forbids, or dropping carry-forward for the whole round.

## Decision

- `resolve-angle-carry-forward.mjs` accepts a repeatable `--rerun-angle <angle>`.
- Each named angle must exist in the prior findings-log. The script forces it out of carry-forward into `mustRerun` with the recorded reason `operator_rerun`.
- An unknown name is refused with `unknown_rerun_angle`. The script writes no plan.
- Use the flag when the judge rejected a carried finding in consecutive rounds, or when code changed the finding's premise (rule `GATE-EXEC-RERUN-ANGLE`).
- The flag never changes judge dispositions or verdict semantics. A high still blocks clean.

Rejected alternatives:

- Hand edit of the ledger or plan. Issue 2892 forbids it.
- Dropping carry-forward for the whole round. It discards valid carried findings on every other angle.
- Letting a judge rejection clear a high. It weakens the verdict rule.

## Consequences

An operator can retire a stale carried finding through a deterministic, recorded path.

Every other angle keeps its carry-forward.

The rerun produces fresh findings, and the judge and verdict rules apply to them unchanged.
