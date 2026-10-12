# 0142. A PR deferral target posts no deferral comment

## Status

Accepted — 2026-10-12 ([issue 2745](https://github.com/mfittko/dev-loops/issues/2745))

## Context

Amends [0092](./0092-gate-tools-comment-only-blocker-only-filing.md): it decided that the batched deferral comment goes to the linked spec issue or, when there is none, to the PR. On a PR target the comment duplicated records the gate already holds: each deferred thread carries a stamped marker and a resolving reply, and each folded finding carries its own hidden marker in the verdict body.

Amends 0138 (gate verdict body visibility by judge disposition): its Deferred-group marker bullet now also states that the folded marker is the deferral record when the target is the PR. Records 0092 and 0138 stay unedited.

## Decision

- When the deferral comment target is a linked spec issue, `judge-pass.mjs` and `close-gate-findings.mjs` post their ONE batched deferral comment as before.
- When the target is the PR itself, neither tool posts a deferral comment. A threaded deferral is recorded by its thread marker and resolving reply. A folded deferral is recorded by its hidden marker in the verdict body group it renders under (`Deferred`, `Rejected` or `Not judged`).
- Thread markers and Deferred-group markers keep `issue=<pr>` as the re-attachment pointer, and the ledger `followUpIssueNumber` keeps the PR number. A Rejected or Not judged folded marker carries no `issue=` pointer.
- Folded filing selection follows `isVisibleFinding`, so a past-window folded medium joins the round's deferral record.

## Consequences

A PR-targeted round adds no extra comment to the PR. The record of a deferral stays on the finding's own surface. One narrow edge remains: on a PR target a deferral has no surface that survives deletion of its thread or of the verdict body, because the batched comment no longer backs it. Only the ledger under `tmp/` and the re-attachment pointer remain. Linked-issue targets keep the durable batched comment.
