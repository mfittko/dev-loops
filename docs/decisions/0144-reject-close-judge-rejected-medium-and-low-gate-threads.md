# 0144. Reject-close a judge-rejected medium or low gate thread

## Status

Accepted — 2026-10-12 ([issue 2485](https://github.com/mfittko/dev-loops/issues/2485))

## Context

Amends [0088](./0088-answered-judge-rejected-question-reject-close.md): it limited the `close-gate-findings.mjs` reject-close pass to an answered `question` thread. A medium or low defect thread that the judge rejected has no actor that closes it. A `clean` verdict can then leave an open gate thread. The coordination detector routes that state to `address_review_feedback`, `ready-for-review` refuses the ready flip, and the next round's `write-gate-context` stalls. Record 0088 stays unedited.

## Decision

The reject-close pass also closes a gate-authored medium or low defect thread when its judge disposition resolves to `reject` through the existing `resolveJudgeRejection` tiers (current ledger, prior local ledgers, rendered ` — judge: reject` suffix). The thread needs no answer reply, and the close applies inside the medium fix window as well. The reply carries an `Examined on merits:` rationale that names the finding summary and the judge rationale. The pass never stamps `disposition=deferred` and never files the thread to the deferral comment. The disposition pass skips these threads. An ambiguous disposition leaves the thread open ([GATE-EXEC-THREAD-DISPOSITION](../../skills/docs/gate-review-sub-loop-contract.md)). An unparseable summary records a `dispositionFailures` entry and leaves the thread open. A judge-rejected high thread is never closed and stays on the round-cap escalation path. A thread whose judge disposition is `defer`, `act`, or absent keeps the severity path. The question rules of 0088 are unchanged.

`verify-fixer-disposition.mjs` also fails a full-phase handoff that has no disposition entry for an open inline gate thread whose marker fingerprint matches a judge-act item. The error names the thread id.

## Consequences

A `clean` verdict leaves no judge-rejected medium or low gate thread open, and the operator no longer closes it by hand. The reply cites the judge rationale when a ledger holds it, and a generic note when only the rendered suffix survives.
