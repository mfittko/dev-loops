# 0223. The ADR waiver accepts the cap-round proof, and the cap-round chain extends over docs and tests commits

## Status

Accepted, 2026-11-01 ([issue 3010](https://github.com/mfittko/dev-loops/issues/3010)).

## Context

[ADR 0185](./0185-draft-gate-round-cap-and-post-convergence-no-code-commit.md) caps draft_gate rounds. [ADR 0208](./0208-draft-cap-round-fixed-goes-ready.md) lets a cap-round PR leave draft on the cap-round-fixed proof instead of a verdict. [ADR 0218](./0218-slice-a-cap-round-chain-and-single-child-join.md) defined the sealed clearing chain that carries that proof.

Two lockouts follow on a cap-round PR that touches a contract doc. First, `pr waive-adr-tripwire` requires a clean draft_gate or pre_approval_gate verdict, while `ready-for-review.mjs` accepts the proof. The tripwire blocks the ready flip, and the waiver refuses the proof. Second, the ADR commit that resolves the tripwire is a docs-only commit after the cap round. It has no delta record, so the chain does not reach the head. `check-pre-push-delta.mjs` cannot seal a new record because no fixer plan exists.

## Decision

1. Rule `GATE-EXEC-ROUND-CAP-WAIVER-PROOF`: the waiver accepts the cap-round-fixed proof through `resolveCapRoundFixed` from `scripts/github/write-gate-context.mjs`, the predicate `ready-for-review.mjs` uses. The spec digest comes from the cap-round findings ledger (`capRound.log.specAuthority.specDigest`).
2. Rule `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND`: `dev-loops gate extend-cap-round-chain --repo <r> --pr <n>` extends the sealed chain over later commits that classify only as docs or tests, using `classifyFile` and `resolveClassifyRules` as `validatePrePrReview` does. It needs no fixer plan. Any other commit fails closed with `logic_commit_in_range`.
3. Refusals name runnable remedies.

The `contract_doc_not_in_matrix` check and the operator-owned meaning of `adr-tripwire:allow` are unchanged. The cap value and merge preconditions are unchanged.

## Consequences

A cap-round PR resolves the ADR tripwire with sanctioned commands and no operator line. The chain stays fail-closed for logic changes.
