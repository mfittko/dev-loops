# Skills prose cleanup coverage (variation B)

Tracking issue: [2236](https://github.com/mfittko/dev-loops/issues/2236), independent A/B handoff. This record is variation B. Variation A is [PR 2237](https://github.com/mfittko/dev-loops/pull/2237) on branch `issue-2236`; B never edits A. The issue remains the canonical specification; this file tracks execution only.

## Baseline record

Frozen before any B edit.

| Input | Value |
| --- | --- |
| B base (origin/main at B start) | `66c96ee8361a9dad205de42c3008907596113347` |
| A original baseline (merge-base of `issue-2236` with `main`) | `894a5a59080222cef5a47fc3f4e962824e05bfda` |
| A comparison checkpoint named in the issue | `cc032f923b6942f567761584fd05e1a28f4af8b0` (partial implementation, not a baseline) |
| A head at B start | `eccf273da654d494bcc67cc118dc2ff4caf6cb91` |
| Issue 2236 spec revision | `updatedAt 2026-09-16T08:37:44Z`, `specDigest sha256:7d579da560ad722721fbd795426f87d1a9e80527dfd4ea2d88a9c665671f4e2a` (`scripts/loop/spec-context.mjs`) |
| Toolchain | Bun 1.4.1 (pinned by `bun run verify`) |

## Baseline divergence

`origin/main` advanced from A's baseline to B's base by PR 2233, the v1.0.3 release commits and PR 2234. Within that range the following in-scope files changed (PR 2233, emitter reconciled to ADR 0048):

- `skills/copilot-pr-followup/SKILL.md`
- `skills/docs/gate-review-sub-loop-contract.md`
- their generated `.claude/skills/` projections

A and B therefore start from different revisions of the phase 1 files. Before the A/B comparison, both variants must be reconciled onto an equivalent baseline (A rebased onto B's base, or the comparison run against a common ancestor). This record does not perform that reconciliation.

## File inventory

Pending. B inventories all tracked files under `skills/` in its first slice, with per-file disposition (`pending`, `in progress`, `changed`, `unchanged`, `generated`, `non-prose`, `blocked`), phase and rationale.
