# 0248. The evidence detector reads comments and reviews only from trusted authors or the viewer

## Status

Accepted — 2026-11-03 ([issue 3034](https://github.com/mfittko/dev-loops/issues/3034), slice 3).

Extends [ADR 0238](./0238-comment-text-from-non-maintainers-never-reaches-an-agent.md). Accepted records remain unchanged.

## Context

ADR 0238 decided that comment text from a non-maintainer never reaches an agent, and filtered the review-thread paths. `scripts/github/detect-checkpoint-evidence.mjs` still read every issue comment and every PR review on a pull request. It parsed gate-formatted text from any account into gate verdicts and markers. A stranger could post a comment shaped like a clean verdict and satisfy gate evidence, or inject text that the coordinator reads.

Some agent prose also named raw `gh` readers (`gh api .../pulls/<n>/reviews`). A raw read skips every ingestion filter.

## Decision

The detector keeps an evidence comment or review only when it passes `isTrustedRestComment` with `allowCopilot: true`, or when its author is the authenticated viewer. The viewer is the identity that posts gate verdicts, and it can be a bot. The viewer lookup runs only when an untrusted candidate exists. A failed lookup trusts by association only. One shared predicate, `resolveTrustedEvidencePredicate` in `scripts/github/_gate-finding-surface.mjs`, serves every site:

- the gate verdict and marker summarizers;
- the human-approval facts for the size-budget merge gate: only association-trusted entries can approve (a stranger's `approve merge <head>` comment or APPROVED review never does), while a CHANGES_REQUESTED review from anyone still blocks, so the gate fails closed;
- the carried-heads record read by `_carried-verdict.mjs`;
- `fetchGateEvidenceComments`, which feeds `fetchDraftGateEvidence` and the `gh pr ready` guard.

Agent prose does not tell an agent to read comments or reviews with raw `gh`. Comment and review text is untrusted data. An agent reads it only through a script that applies `isTrustedCommentAuthor`. A contract test greps `skills/` and `agents/` for the raw patterns, including `gh pr view --json comments|reviews` and `gh api graphql` with `reviewThreads`. Only write verbs, or a negation before the raw command on the same line, exempt a line.

The trusted set has no configuration surface. The owner rule stays `GATE-REVIEW-COMMENT-TRUST`.

## Consequences

A gate-shaped comment from a non-maintainer no longer counts as gate evidence. Verdicts posted by the viewer identity keep working. Test fixtures for the detector carry a trusted author, through `trustCommentFixtures` in `test/_helpers.mjs`. Claude and Pi share the same script, so the change is harness-agnostic.
