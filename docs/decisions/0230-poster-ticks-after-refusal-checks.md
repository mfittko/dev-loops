# 0230. The checkpoint poster ticks the PR body after every refusal check

## Status

Accepted — 2026-11-02 ([issue 2898](https://github.com/mfittko/dev-loops/issues/2898)).

Amends [0100](0100-reviewer-verified-items-drive-the-pre-approval-tick.md) in one place: the tick order. The rest of 0100 stands. ADR 0100 keeps its text apart from an Amended-by pointer to this record.

## Context

ADR 0100 had the poster tick the ledger's verified items before it composed the verdict. A refusal after the tick (a contradiction, a stale checklist, a failed post) left a changed PR body behind a verdict that never posted.

## Decision

For `pre_approval_gate` with `--findings-ledger`, `upsert-checkpoint-verdict.mjs`:

1. Computes the ticked bodies as a dry run for the ledger's `verifiedItems` before it composes the verdict.
2. Composes the verdict and runs the clean guards on the dry-run bodies. It reloads the refinement artifact from the dry-run bodies and does not reload it after the write.
3. Writes each changed body once, after every refusal check and directly before the post. The write re-applies the tick to the live body with a live-checklist preview. A changed checklist refuses with `The checklist of PR N (or issue N) changed after the gate read it`.
4. Changes no body on a refusal.
5. Leaves a verified label that an open act item names unticked (PR 3003, `CHECKLIST-SCOPE-ONE-MODEL` in `skills/docs/acceptance-criteria-verification.md`).

## Consequences

A refused round leaves the PR body unchanged. The poster does one body write per changed PR, directly before the post.
