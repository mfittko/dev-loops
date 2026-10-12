# 0141. Delta review changed-line lens and stale-surface check

## Status

Accepted — 2026-10-12 ([issue 2740](https://github.com/mfittko/dev-loops/issues/2740))

Extends: 0094 ([record](./0094-pre-push-reviewer-delta-mode.md)) and 0131 ([record](./0131-pre-push-delta-thread-route-and-decision-record.md)). Both records stay unedited.

## Context

The pre-push delta review checks a fix commit against the act items of one gate round. [ADR 0094](0094-pre-push-reviewer-delta-mode.md) set the delta review. [ADR 0131](0131-pre-push-delta-thread-route-and-decision-record.md) added the thread route and the decision record. Two gaps remain. The surface hints name only the angles of the act items, so a defect that a fix introduces on another angle of the same round gets no lens. A fix that removes or renames a sentence or identifier can also leave stale copies in other tracked files, and no check finds them.

## Decision

- The delta input carries `surfaceHints` as the union of the act items' angles and the angles of the reviewed gate round. The round angles come from `provenance.perAngle` in the findings log that `check-pre-push-delta.mjs --findings-log` reads. The thread route carries the act items' angles only, and the CLI refuses `--findings-log` there. The CLI also refuses a log without `provenance.perAngle` or with a `headSha` other than the baseline.
- The reviewer reviews every changed hunk of the delta range, not only the lines that touch an act item.
- `check-pre-push-delta.mjs` computes `staleSurfaceHits[]` deterministically. It reads the removed sentences and identifiers of the delta range and greps them at the candidate head. A capped hit list sets `staleSurfaceTruncated`, which adds a synthetic hit, and the dropped identifiers ride along as `truncatedNeedles[]`. The git formats are pinned, and a missing commit object fails the check.
- `locally_clear` is refused while a stale-surface hit stays unaddressed. A `newFindings[]` entry that names the hit file, or a skipped `siteCoverage[]` site with a reason, addresses the hit. This holds on the act-list route and the thread route.
- The status `resolved` requires two conditions. The reported defect is gone, and the applied remedy introduces no new finding of severity medium or higher.

This ADR extends ADR 0094 and ADR 0131. It does not amend their bodies.

## Consequences

A fix that leaves a stale copy of a changed sentence or identifier can no longer clear the local review without a finding or a recorded skip reason. The hit list is a grep result, so it can include false positives. The skip reason is the release valve for those. Push authority during a fix sequence is out of scope and has its own issue.
