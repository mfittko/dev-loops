# 0123. The ADR tripwire and size budget surface before the ready flip

## Status

Accepted — 2026-10-06 ([PR 2679](https://github.com/mfittko/dev-loops/pull/2679))

## Context

Amends [0052](./0052-adr-tripwire-fail-closed.md): the tripwire stays fail-closed as 0052 defines it. This record only moves when the result is reported. Record 0052 stays unedited.

The tripwire (and the size budget) surfaced only at the ready flip. A PR could pass several full `draft_gate` rounds and then stop at `mark_ready_for_review`, which cost those rounds and an operator wait. Evidence: PRs 2576, 2597, 2630 and 2661 cited in [issue 2512](https://github.com/mfittko/dev-loops/issues/2512).

## Decision

We add the rule `ADR-TRIPWIRE-EARLY-SURFACE` to `skills/docs/decision-record-contract.md`, implemented in `packages/core/src/loop/pr-gate-coordination.mjs`.

- `pr create` adds `adrTripwire` and `sizeBudget` to its JSON output after the PR exists. A block never refuses creation.
- `loop gate-coordination` reports both fields for a draft PR on every run, from refs that already resolve locally. An unresolvable ref gives outcome `unknown` and no fetch.
- While the current head has no clean `draft_gate` evidence, a block is advisory: `nextAction` stays `run_draft_gate`. A size-budget `escalate` is reported in the draft hand-back only and stops at the ready boundary. The coordinator reports an advisory hit to the operator in its first draft hand-back, before the first `draft_gate` round.
- With clean current-head `draft_gate` evidence, a tripwire block gives `resolve_adr_tripwire`, a waivable size block gives `resolve_size_budget`, and `unknown` or an unwaivable size block gives `report_blocked`. Each forbids `mark_ready_for_review`. A combined block names every decision in one reason.
- On `resolve_adr_tripwire` or `resolve_size_budget` the coordinator stops and hands back. The orchestrator does not resume it while the result still reports that action at the same head and PR body.
- The one exit for `resolve_size_budget` is a size waiver. A size-budget `block` stops; an `escalate` is reported in the hand-back and is enforced at merge by the approve-merge marker (merge-pr size_budget_human_approval). After the operator decides, the orchestrator flips ready at the same head with `pr ready --waive-size-budget --reason <r> [--approved-by <h>]`.

Rejected alternatives: refuse PR creation on a block (blocks legitimate drafts that add the record later), and keep ready-flip-only reporting (the status quo that wasted rounds).

## Consequences

The author learns of a missing decision record or a size overrun at creation or in the first draft run, before gate rounds are spent. Draft rounds proceed unchanged while the block is advisory. The no-resume rule prevents a coordinator loop on an unchanged blocked head. Draft coordination now depends on local refs resolving, and an unresolvable ref reports `unknown`, and the check never fetches.
