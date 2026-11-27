# 0335. Human-style review submit on the existing poster

## Status

Accepted — 2026-11-27 ([issue 3200](https://github.com/mfittko/dev-loops/issues/3200)).

Extends `GATE-REVIEW-SUBMIT-MODES` in [gate review comment contract](../../skills/docs/gate-review-comment-contract.md). Accepted records remain unchanged.

## Context

The standalone `review` route ends with a submit choice for the mechanical gate report. For a human-authored PR the report is the wrong first impression. Its visible part leads with the gate header, the head SHA, the verdict and a `Next action` line. On an unjudged round that line says the review does not approve or block the PR, so submitting the same body as `APPROVE` contradicts itself. The only workaround, a prose review through `gh pr review`, is refused for every actor under `OPERATOR-OWNED-LINE`, so the operator had to type the approval in the GitHub UI.

## Decision

1. Human-style review is one new flag on the existing poster: `upsert-checkpoint-verdict.mjs --gate review --submit <comment|approve> --human-opener-file <path> --interactive-confirm`. No separate poster script exists.
2. The poster submits the own same-head pending draft in place through `submitPendingReview` with a body override. The review id is kept. No create-review, discard or comment-delete call is made. The event (`COMMENT` or `APPROVE`) is the human's choice. `REQUEST_CHANGES` is not offered.
3. The submitted body is the opener file content, unchanged, followed by the pending draft body, unchanged, inside one collapsed `<details>` block with the summary `dev-loops review details` and a blank line after `</summary>`. The gate header, head SHA, verdict, `Next action` line and every marker sit inside the block, for every event. A `review` verdict is never lifecycle evidence, so the markers stay parseable and marker audits keep working.
4. On `--gate review` a finding takes the inline track only when it counts as `act`: the judge disposed it `act`, or it has no judge disposition. The rule is decided where `resolveFindingSurface` builds the pending draft, after the judge phase, so the draft never holds a `defer` or `reject` inline comment. Those findings are listed in the report body. `draft_gate` and `pre_approval_gate` keep their inline track.
5. The mode never runs headless. `--human-opener-file` requires `--interactive-confirm`, `--submit comment` or `approve`, a non-empty opener file and an own same-head pending draft, and is refused with `--auto`. The final body passes `guardCommentBodyNoIssuePrIds`. Each refusal exits non-zero before any GitHub write and names its recovery.
6. The `dev-loop` agent drafts the opener from the round's `act` findings, and the interactive submit choice lists the human-style option first. The operator accepts the opener, edits it or picks a mechanical mode. The poster takes whatever the file holds.

## Consequences

- An agent can post a readable review on a human-authored PR through a sanctioned writer, with the mechanical report kept in full and collapsed.
- The submit step makes no new GitHub call beyond the existing events call.
- A manual `--inline-reason` review is unjudged and works without an extra branch.
- Revert by removing the flag, the wrapper and the `act` condition in `resolveFindingSurface`.
- Rejected: a separate human-review poster (it duplicates pending-draft resolution and the headless guards, and bypasses `REVIEW-GATE-VERDICT-CANONICAL`), re-rendering the report with counts in a summary line (a second render path for no reader need), dropping only the `Next action` line on `APPROVE` (the header, SHA and verdict stay visible), refusing an unjudged round (a manual review is unjudged and is the main use), prose without markers (it breaks marker audits and the durable record), discarding the draft and creating a fresh review (the review id changes and a window with no or two reviews opens), deleting `defer` and `reject` inline comments at submit time (it needs a comment read, a delete per comment, a fingerprint match and crash-resume, while the create-time rule is one condition) and ordering the submit choice by PR author (it needs an author read for an order the human overrides).
