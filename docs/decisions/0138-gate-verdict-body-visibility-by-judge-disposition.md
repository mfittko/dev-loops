# 0138. Gate verdict body visibility follows the judge disposition

## Status

Accepted — 2026-10-11 ([PR 2737](https://github.com/mfittko/dev-loops/pull/2737))

## Context

Amends [0075](./0075-fold-sub-floor-findings-out-of-inline-threads.md): the verdict body folded findings by severity alone. A `low` the judge disposed `act` folded out of sight, and a `medium` the judge rejected stayed visible. Amends [0100](./0100-reviewer-verified-items-drive-the-pre-approval-tick.md): it recorded the remaining gate blocker items in a collapsed `<details>` block. Records 0075 and 0100 stay unedited. [Issue 2722](https://github.com/mfittko/dev-loops/issues/2722) asked for a verdict body that shows only what the reader must act on.

## Decision

- A finding is visible in the verdict body when the judge disposed it `act`, or when its severity is in `gates.<gate>.blockCleanOnFindingSeverities`. A finding with no judge disposition keeps the 0075 severity floor. A `question` never folds.
- Every other finding that has no inline thread folds into one collapsed `Details` block, grouped as `Deferred (N)`, `Rejected (N)` and `Not judged (N)`. The `Clean (N)` angle roster moves into the same block. Each folded entry keeps its fingerprint marker. A locatable finding at or above the inline floor keeps its inline thread on a create, whatever its judge disposition; the judge decides body visibility only.
- Remaining gate blocker items render as a visible list below the `**Gate blockers:**` line, not in a collapsed block.
- The renderer-only `Execution mode` and `Blocking severities` lines render inside one HTML comment.
- An inline finding comment shows one short `Problem` and one short `Fix`. Reasoning, evidence and the failing case move into its `Details` block.
- A Deferred-group folded marker carries `issue=<n>` for its deferral target: the recorded follow-up issue, else the PR. A Rejected or Not judged folded entry carries no `issue=` pointer.

## Consequences

The visible verdict body holds the visible set (`act`, blocking-severity, `question`, unrecognized-severity and unjudged at-or-above-floor findings), so `Next action` derives from the visible set. Rejected and deferred findings stay one click away and fingerprint-tracked.
