# 0182. The judge owns every disposition, verdict and next action, and every review surface renders one message

## Status

Accepted — 2026-10-22 ([issue 2903](https://github.com/mfittko/dev-loops/issues/2903))

Amends [ADR 0089](./0089-judge-act-list-drives-review-verdict.md): the review verdict depends only on the judge's dispositions. A non-empty act list gives `findings_present` and an empty act list gives `clean`. The `blockCleanOnFindingSeverities` floor no longer overrides the judge on a judged round.

Amends [ADR 0075](./0075-fold-sub-floor-findings-out-of-inline-threads.md), implemented by the later slices of issue 2903 (the rendering code still folds by severity at this head): severity no longer decides which findings are visible or inline. A finding's judged disposition decides, and severity stays an input to the judge. The safety floor (a rejected `high`, a rejected `question`, or a rejected `threat-model`, `renderer-security` or `input-validation` finding) controls visibility only.

Amends [ADR 0179](./0179-judge-in-standalone-review.md): the sentence that the verdict composition and finding rendering code stay unchanged no longer holds. The interim judge-spec line on the review body is replaced by the summary paragraph of the single rendering contract, implemented by the later slices of issue 2903. Spec precedence, the `pr_scope` kind and the review-gate judge wiring stay as 0179 records them.

Amends [ADR 0142](./0142-pr-target-deferral-posts-no-comment.md): the sentences that a no-stamp thread is recorded by its resolving reply and the ledger entry, and that `close-gate-findings.mjs` stamps `disposition=deferred` only on a thread `isFileableDeferral` files past its fix window, no longer hold. No thread is a no-stamp thread. `isFileableDeferral` reads only the judge disposition, so a thread is stamped and resolved only on a judge `defer`.

Amends [ADR 0144](./0144-reject-close-judge-rejected-medium-and-low-gate-threads.md): the sentences that limit the reject-close pass to a judge-rejected medium or low defect thread no longer hold. `isRejectClosableSeverity` extends reject-close to a judge-rejected nit. A rejected `high` or `question` is still not closed by it.

Amends [ADR 0092](./0092-gate-tools-comment-only-blocker-only-filing.md): the sentence that `close-gate-findings.mjs` posts the severity-based defers no longer holds. It posts a deferral only for a cluster the judge disposed `defer`.

## Context

A standalone review of a consumer pull request raised 27 findings. The posted review contradicted itself. The verdict read `clean` next to 9 medium findings, because a severity floor produced it. Every marker said `deferred` under a "Not judged" heading, because fan-in derived the disposition from severity. Severity decided visibility, so a real low-severity defect was folded away. One root cause rendered as four inline comments. The next action read as "nothing to do" beside the findings.

## Decision

- The judge is the only authority for a finding's disposition (`act`, `defer`, `reject`), for the verdict and for the next action. Severity is an input to the judge. No code path derives a disposition, a verdict, a visibility track or a next action from severity alone.
- Fan-in leaves every finding `unjudged` and keeps its severity as the reviewer's input. The ledger default for a missing disposition is `unjudged`.
- The judge disposes each cluster once, by `clusterId`. One disposition and one rationale apply to every member. The judge authors a `title`, a `detail` and a `fix` for every cluster and a one-sentence `reason` for each `defer` and `reject`. A cluster without those fields fails closed.
- The medium fix window (`gates.<gate>.mediumFixWindow`) and the round number are judge inputs. No path stamps `disposition=deferred` from severity or round. A thread, a folded finding or a body-filed finding is deferred only on a judge `defer`.
- The review verdict is `findings_present` when the act list is not empty and `clean` when it is empty. The machine values stay `clean` and `findings_present`. The one exception is ADR 0168: a converged `draft_gate` may stay `clean` over an all-`low`/`nit` act list.
- The standalone review never resolves the `gate-evidence` angle, because it has no lifecycle gates. The judge rejects a finding whose only claim is a missing section that the repository's PR template does not define, on every spec source.
- Every review surface renders one message in which the headline, counts, sections, inline comments, markers and next action agree. Later slices of the same issue implement that rendering contract and its consistency check.

## Consequences

- A rejected `high` no longer forces `findings_present`. The judge's reason is the record of that decision.
- An unjudged finding is never reported as deferred. It stays open until a judge disposes it.
- A round whose judge fails keeps the fan-in verdict until the rendering slices land.
- The judge work order carries the round and the window, and the judge persona states the cluster prose fields.
