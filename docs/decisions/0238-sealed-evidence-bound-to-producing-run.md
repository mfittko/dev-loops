# 0238. Review evidence files are bound to their producing run by a sealed digest

## Status

Proposed

## Context

Issue [2892](https://github.com/mfittko/dev-loops/issues/2892) reports that a review evidence file is plain JSON on disk. Any agent with write access to the worktree can create or edit one, and a consumer cannot tell a file the producing run wrote from a file someone else wrote or changed afterwards. The delta result that gates a commit-only push is the first such file that a consumer trusts for a push decision. PR [3037](https://github.com/mfittko/dev-loops/pull/3037) carries slice 1.

## Decision

- We bind an evidence file to its producing run through an out-of-band SHA-256. The digest lives in a run record under the main checkout tmp root, `tmp/evidence-runs`, which the worktree and the evidence file do not hold.
- `scripts/loop/seal-evidence.mjs` seals a file once. It reads the file, computes the SHA-256, and writes the digest into the run record. A seal is final: a second seal of the same file refuses.
- Consumers verify the file against the run record before they use it. A failed verification returns one typed reason: `evidence_run_missing` (no run record), `evidence_unsealed` (the run record holds no digest for the file), `evidence_digest_mismatch` (the file differs from the sealed digest), or `evidence_foreign_run` (the file belongs to a different run).
- Slice 1 covers delta results. `loop pre-push-delta` records the producing run on the input run, with a run id it mints and the briefed result path. The delta reviewer seals its result with `seal-evidence.mjs`. `loop pre-push-delta --result` and `emit-fixer-work-order --delta-result` verify the result before they read it.
- Each input run owns its own run record, keyed by both heads and the minted run id. The result carries the run id. A re-run of the producer at the same heads opens a new unsealed record, and the old seal stays final.
- Consumers digest the exact bytes they parsed, and paths compare by real path.
- The rule is `GATE-EXEC-EVIDENCE-SEALED` in `skills/docs/pre-pr-review-contract.md`.

Rejected alternatives:

- Key signing. It needs key storage and rotation that a local agent loop does not have, and the signing key would sit within reach of the same agent.
- Read-only file permissions. The owner of the file can change the mode, so the permission binds nothing.
- Hook-only enforcement. A hook sees tool calls of one harness and misses writes made by other processes or harnesses, which breaks the harness-agnostic requirement.

## Consequences

A consumer detects a forged, edited, or foreign delta result and names the cause. A seal is final, so a reviewer that needs to correct a result starts a new run: the coordinator re-runs the input run, which mints a new run id. The delta reviewer is allowed exactly one mutating command, the seal. Slice 2 stays open under issue 2892: findings logs, ledgers, judge decisions, dispositions, the act list, and the verdict writer.
