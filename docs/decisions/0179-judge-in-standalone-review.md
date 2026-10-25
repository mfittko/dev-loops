# 0179. The judge runs in the standalone review, with the PR description as a spec source

## Status

Accepted — 2026-10-21 ([issue 2540](https://github.com/mfittko/dev-loops/issues/2540))

Amends [ADR 0060](./0060-immutable-spec-authority.md): the review gate may take its spec from the PR description, either as formal criteria or as scope text, and a spec with no acceptance criteria is valid for that gate when it carries scope.

Amends [ADR 0112](./0112-gate-coordinator-agent-joins-the-agent-taxonomy.md) and [ADR 0116](./0116-dev-loop-keeps-pre-pr-and-delta-review-dispatches.md): the dev-loop agent may dispatch the emitted standalone review-gate judge pointer (`--ref judge:<repo>#<n>:review:`). Lifecycle-gate judge dispatches by the dev-loop agent stay denied with `GATE_COORDINATOR_REQUIRED`.

Leaves unchanged these records and their amendments:

- [ADR 0046](./0046-one-review-surface-per-gate-round.md), amended by [ADR 0092](./0092-gate-tools-comment-only-blocker-only-filing.md).
- [ADR 0051](./0051-net-reduction-disposition-policy.md), amended by [ADR 0078](./0078-judge-adjudicates-every-finding-on-merits.md) and ADR 0092.
- [ADR 0106](./0106-workers-pull-deterministic-work-orders.md), amended by:
  - [ADR 0107](./0107-fixer-mutation-authority-bound-to-pulled-work-order.md).
  - [ADR 0115](./0115-dispatch-pointer-carries-the-execution-identity-alone.md).
- [ADR 0054](./0054-provable-interactivity-review-submit-modes.md). <!-- secret-scan:allow ADR file link, not a credential -->
- [ADR 0089](./0089-judge-act-list-drives-review-verdict.md).

## Context

The standalone `review` gate posted every reviewer finding at the same level and never ran the judge. Human developers who read the review got duplicates, FYI-only comments and out-of-scope findings. The judge tooling already accepts the `review` gate. A PR created outside the dev-loops lifecycle often has a detailed description but no formal acceptance criteria or definition of done, so the lifecycle spec contract cannot filter its findings.

## Decision

- The review procedure runs the judge between the fan-in ledger and the verdict post, on the lifecycle path (`emit-judge-work-order.mjs`, the `judge` agent over pull transport, `judge-pass.mjs --gate review`). A round with zero findings skips the judge.
- Spec precedence on the review gate: the single closing issue when its body passes `requireSpecFromBody` (`issue`); else the PR description when it passes (`pr_body`); else the PR description as scope text (`pr_scope`); else none, and every finding stays visible. Several closing issues are never merged.
- A `pr_scope` spec has `specKind: "pr_scope"` and a `scope` category of verbatim excerpts with criterion ids `scope:<n>`. It carries no fabricated acceptance criteria, completion evidence or non-goals. `computeSpecDigest` covers the scope items. `normalizeSpec` accepts a spec without acceptance criteria only for that kind with a non-empty `scope`.
- `draft_gate` and `pre_approval_gate` keep the strict spec contract. `judge-pass.mjs` refuses a `pr_scope` spec for them.
- On the review gate `judge-pass.mjs` posts no deferral comment and takes no `--out`: the round keeps one visible surface and never feeds a fixer.
- The posted review records the judgment source with `upsert-checkpoint-verdict.mjs --judge-spec-source` and `--judge-unavailable-reason`. A judge failure posts the review unjudged with its reason, and every finding stays visible.

The verdict composition and finding rendering code stay unchanged, and the `gate-evidence` angle rule stays as it is in this record.

## Consequences

- A review of a PR with no formal spec still gets a judge pass against the PR's stated scope.
- The review body gains one judge-spec line. The existing disposition-gated fold applies to judged findings: `reject` and `defer` findings below the blocking severities fold into the Details block, and the verdict follows the judged `act` items. Unjudged posts keep every finding in its normal track.
- The spec-authority code gains one spec kind that only the review gate accepts.
