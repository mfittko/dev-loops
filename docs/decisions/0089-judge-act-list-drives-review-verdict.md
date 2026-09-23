# 0089. A non-empty judge act list keeps a gate round from `clean`

## Status

Accepted — 2026-09-23 ([issue 2409](https://github.com/mfittko/dev-loops/issues/2409))

Amends [ADR 0078](./0078-judge-adjudicates-every-finding-on-merits.md): that record makes severity an input to the judge and makes the judge's `act` disposition the decision that a finding must be fixed in this PR. It left the round's review verdict computed from severity alone, so a round could post `clean` while its act list still held findings. This record makes the act list part of the review verdict.

## Context

`.devloops` sets `blockCleanOnFindingSeverities: [high]`. Medium left the blocking set after rounds stopped converging: each fix created new surface for the next round's mediums. The consolidator (`consolidate-fanin.mjs`) computes `overallVerdict` from severity only. A round with only medium and low findings therefore reads `clean` even when the judge disposed one of them `act`. No deterministic check stopped that PR from merging with the act items unfixed; only runner discipline fixed them.

## Decision

- Severity stays a judge input. `blockCleanOnFindingSeverities` stays a floor: the consolidator already makes a round with a finding at a listed severity `findings_present`, whatever the judge disposes for it.
- A non-empty judge act list keeps the round's review verdict from `clean`. `upsert-checkpoint-verdict.mjs` composes the review verdict at post time with `composeReviewVerdict(overallVerdict, findings)` (`packages/core/src/loop/gate-fanin.mjs`): a `clean` severity verdict with any finding disposed `act` becomes `findings_present`. The composition never lowers a verdict. The derived verdict follows the composed value, and an explicit `--verdict clean` over a non-empty act list is refused.
- The ledger's `overallVerdict` stays the consolidator's severity verdict. The ledger is not rewritten; the review verdict is composed when the checkpoint is posted.
- Merge's evidence probe (`detect-checkpoint-evidence.mjs`, which `merge-pr.mjs` calls) refuses a current-head `pre_approval_gate` ledger with open act items and names them and the ledger copy that holds them. The check reads the ledger across checkouts, client-side only. It is skipped under `--skip-fanout-ledger-check`, since the stateless CI gate-evidence runner has no ledger. It runs whether or not `gates.requireFanoutEvidence` is on; without that setting, a missing ledger adds no failure.
- The check fails closed. An existing ledger that no checkout can parse into an object with a `findings` array refuses merge. A `fanout_fanin` `pre_approval_gate` ledger with at least one finding that carries no `judgeDisposition` refuses merge until the ledger is written with `--judge-verdict`. A ledger with zero findings needs no judge. Inline (light-mode) ledgers are exempt from the unjudged check.
- The durable findings log's `judgeDisposition` is the act-list authority for the posted verdict and for merge. A judge that marks a finding spec-authority `finding_conflicts` MUST also dispose it `reject` in `judge-verdict.json`. A mismatch fails closed: merge refuses until the judge reruns.
- A judge `act` overrides the medium fix window and surface-time deferral for the verdict. An act item blocks `clean` until it is fixed or re-judged.
- Convergence comes from the judge. The judge already rejects churn, such as re-raised wording findings about the previous round's fix, which is what broke the old medium-blocks loop.

Rejected: changing which severities are in `blockCleanOnFindingSeverities`; changing the judge's disposition rules (ADR 0051, ADR 0078); rewriting `overallVerdict` in the ledger at judge time, which would make the write-time contradiction check depend on the judge run.
