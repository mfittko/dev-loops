# 0338. The size budget counts removed code lines at a configurable discount

## Status

Accepted — 2026-11-28 ([issue 3574](https://github.com/mfittko/dev-loops/issues/3574)).

## Context

The size budget measured a deletion at full weight. A PR that removes a large amount of code reached the soft and waiver thresholds as if it had added that code, although a deletion costs less review effort. The v1.0.13 deslag work deletes a lot of code, so the budget forced splits and waivers on PRs that shrink the repository. Issue 3574 asks for a discount on removed lines.

## Decision

- The key `gates.size.deletionDiscount` (`packages/core/src/config/config.mjs`, `extension-defaults.yaml`) is a number from 0 to 1. The default is 0.25.
- The logic LOC formula is `logicLoc = (addedCode - addedComment) + deletionDiscount * (removedCode - removedComment) + testDiscount * test`.
- The default 0.25 mirrors `testDiscount`. The orchestrator chose it on 2026-11-28 while the operator was away. The operator may change it in config without a code change.

Rejected: a discount of 0 (a deletion still needs review for dangling callers) and a waiver path for large deletions (the discount makes the waiver unnecessary and keeps one budget rule).

## Consequences

`wholeLogicLoc` counts deletions at the discount. It also feeds light-mode eligibility and fan-out tiering, so those two decisions see a deletion-heavy PR as smaller than before. A PR that mixes large additions with large deletions measures higher than a pure deletion of the same total size.
