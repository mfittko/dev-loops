# 0138. Gate verdict body visibility follows the judge disposition

## Status

Accepted — 2026-10-11 ([PR 2737](https://github.com/mfittko/dev-loops/pull/2737))

## Context

Amends [0075](./0075-fold-sub-floor-findings-out-of-inline-threads.md): the verdict body folded findings by severity alone. A `low` the judge disposed `act` folded out of sight, and a `medium` the judge rejected stayed visible. Amends [0092](./0092-gate-tools-comment-only-blocker-only-filing.md): a round whose deferral target was the PR posted a second deferral comment on the PR next to the verdict review. Records 0075 and 0092 stay unedited. [Issue 2722](https://github.com/mfittko/dev-loops/issues/2722) asked for a verdict body that shows only what the reader must act on.

## Decision

- A finding is visible in the verdict body when the judge disposed it `act`, or when its severity is in `gates.<gate>.blockCleanOnFindingSeverities`. A finding with no judge disposition keeps the 0075 severity floor. A `question` never folds.
- Every other finding that has no inline thread folds into one collapsed `Details` block, grouped as `Deferred (N)`, `Rejected (N)` and `Not judged (N)`. The `Clean (N)` angle roster moves into the same block. Each folded entry keeps its fingerprint marker. A locatable finding at or above the inline floor keeps its inline thread on a create, whatever its judge disposition; the judge decides body visibility only.
- The renderer-only `Execution mode` and `Blocking severities` lines render inside one HTML comment.
- An inline finding comment shows one short `Problem` and one short `Fix`. Reasoning, evidence and the failing case move into its `Details` block.
- When the deferral target is the PR, no deferral comment is posted. A deferred finding is recorded by its stamped thread marker and reply, or by its folded marker in the verdict body's `Details` block. Only a Deferred-group folded marker carries `issue=<pr>`; a Rejected or Not judged folded entry is recorded by its marker and bullet without an `issue=` pointer.

## Consequences

The visible verdict body holds the visible set (`act`, blocking-severity, `question`, unrecognized-severity and unjudged at-or-above-floor findings), so `Next action` derives from the visible set (act, blocking-severity, question, unrecognized-severity and unjudged findings at or above the floor). Rejected and deferred findings stay one click away and fingerprint-tracked. A PR receives one gate surface per round. A linked spec issue still receives the deferral comment.
