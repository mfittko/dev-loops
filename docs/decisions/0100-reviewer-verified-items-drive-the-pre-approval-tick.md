# 0100. Reviewer-verified items drive the pre-approval checkbox tick

## Status

Accepted — 2026-09-28 ([issue #2407](https://github.com/mfittko/dev-loops/issues/2407))

This record amends no ADR. The bodies of ADR 0059, ADR 0078, ADR 0089 and ADR 0095 stay unchanged. No ADR covers the composed checkpoint verdict from issue #2389.

## Context

The composed `pre_approval_gate` checkpoint verdict posts `blocked` while any PR-body Acceptance criteria or Definition of done box is unchecked. The procedure expected the conductor to tick the verified items with `tick-verified-checkboxes.mjs` before the post. On PR #2405 the runner posted first, so a round whose reviewers had verified every item still posted `blocked` with 22 unchecked items and cost one extra round. On PR #2501 the orchestrator ticked every unchecked label by hand, although no artifact mapped an item to a reviewer check.

No artifact recorded per item what a round verified. The per-angle findings artifact, the consolidator, the durable findings ledger and the judge carried no item data. The `**Gate blockers:**` line inlined up to 10 full criterion texts plus a "+N more" suffix, and the verdict-contradiction error reused that text.

## Decision

Reviewer output now drives a gate action. The `acceptance-criteria` and `pr-checklist` angles may emit an optional `verifiedItems` string array: the exact trimmed checklist labels that the reviewer verified at the reviewed head. The emitter appends a fixed instruction to every dispatch unit that carries one of these angles, keyed on angle membership, so whole, cap-split and packed units all carry it. Fan-in rejects a malformed value and rejects the field on any other angle. The consolidator writes the deduplicated union into the `--ledger-out` wrapper; carried-forward angles and the synthetic `pr-checklist` entry contribute nothing. `write-gate-findings-log.mjs` persists the union as a top-level `verifiedItems` field in the head-bound durable ledger, beside `provenance.dispatchUnits`.

For `pre_approval_gate` with `--findings-ledger`, `upsert-checkpoint-verdict.mjs` ticks the ledger's `verifiedItems` before it composes the verdict. The ledger must first pass the fan-out angle-coverage checks, and its provenance must be consistent and record a fresh `acceptance-criteria` or `pr-checklist` review. It ticks the PR body's unchecked AC/DoD items and, when the spec-of-record still has unticked AC items, each linked issue body the coordination load read with unticked AC items. A label outside those unchecked lists is not ticked. The match is exact-label, the tick never unchecks, and each changed body gets one edit. The poster then reloads the refinement artifact, and both the blocker collection and the later `clean` guards read the reloaded artifact. An item that no reviewer listed stays unchecked and blocks. A failed fetch or edit of a body being ticked fails closed, and no verdict is posted. The tick does not run for `draft_gate` or without `--findings-ledger`. On a path with no findings ledger, the operator ticks verified items with `tick-verified-checkboxes.mjs` before posting.

The `**Gate blockers:**` line states the count per blocker kind and no criterion text. A collapsed `<details>` block lists every remaining item, one per line, without a cap. The verdict-contradiction error uses the counts form. The JSON `gateBlockers` shape is unchanged.

The PR-body generator no longer emits a gate-outcome or merge-outcome matrix item as a checkbox. Such an item can only become true after a clean `pre_approval_gate`, and the completeness block refuses a clean verdict while any box is unchecked, so the gate could never close clean. The generator states these items as prose, and the gates and `merge-pr` enforce them.

The completeness-not-truthfulness boundary of ADR 0059 holds. The tick applies only a reviewer's own verification at this head, and verifying that each ticked item is real remains the reviewer's and the judge's responsibility. The composed-verdict rules, the judge act-list composition of ADR 0089, `blockCleanOnFindingSeverities`, dispatch membership, packing, the unit bound and the pairing check of ADR 0095 stay unchanged.

We rejected keeping the tick in the conductor procedure only, because that is the status quo that produced the wasted round. We rejected a per-angle `verifiedItems` map in the ledger, because the tick needs only the union; a map can follow when an audit need appears.

## Consequences

A round whose reviewers verified every item posts `clean` in the same round. A remaining blocker is always an item that no reviewer verified at this head, and the verdict comment lists every such item in a collapsed block. Reviewer artifacts for the two AC angles grow by the verified labels. The emitted work order grows by a bounded constant and stays under `REVIEWER_WORK_ORDER_MAX_BYTES`. `test/github/upsert-checkpoint-verdict.test.mjs`, `test/github/emit-fanout-dispatch.test.mjs`, `packages/core/test/gate-fanin.test.mjs`, `test/loop/consolidate-fanin.test.mjs` and `test/github/write-gate-findings-log.test.mjs` pin the behavior.
