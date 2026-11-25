# 0323. The pre-push hook has no push authority

## Status

Accepted — 2026-11-25 ([issue 3579](https://github.com/mfittko/dev-loops/issues/3579), operator decision of 2026-11-25). Supersedes in part ADR 0143, ADR 0213 and ADR 0219 for the hook enforcement of push authority only. Those records stay unchanged.

## Context

A gate fix sequence could reach a state with no sanctioned exit. A `commit_only` fixer committed the fix, and `loop pre-push-delta` sealed `needs_fix` / `fix_and_rereview` because the operator had deferred some items (issue 3577). The pre-push hook then refused the push with `PRE-PUSH-DELTA-PUSH-AUTHORITY`. `gate close-sequence` refused `sequence_live` because the PR head was still the baseline, and only a push moves the PR head. A consumer repository hit this state on 2026-11-25.

## Decision

- The pre-push hook that `renderGuardHook` generates has no push-authority block. It no longer calls `scripts/loop/check-fix-push-authority.mjs` and no longer scans `tmp/gate-delta`. It keeps its default-branch refusal, and `DEVLOOPS_ALLOW_MAIN=1` still bypasses only that refusal.
- `ensure-worktree` rewrites every hook it owns on each run, so a re-run replaces an old hook. An old marker blocks no push.
- The delta review still runs, but it no longer blocks the push. A pushed fix commit moves the remote-tracking ref of the branch past the baseline, which ends the sequence under the existing marker rule. The next full gate round reviews `git diff <base>...HEAD`, which contains the pushed fix commits.
- The rule `PRE-PUSH-DELTA-PUSH-AUTHORITY` keeps its ID, because runtime refusal texts cite it. The delta reviewer and the `commit_only` fixer still MUST NOT push. The full-phase fixer pushes after a clearing delta record. The coordinator pushes the committed fix commit when the sealed delta record cannot clear, which ends the sequence and routes the head to the next full gate round. `resolve-pr-conflicts.mjs` still runs `check-fix-push-authority.mjs` before a base merge.
- The delta chain code (`fix-push-authority.mjs`, the marker writes, `check-pre-push-delta.mjs`, `close-gate-sequence.mjs`) stays for issue 2937 to delete.

## Consequences

A fix commit can reach the PR head before the next round reviews it. This accepted loss is bounded: the next full gate round judges the fix, and the merge gate still applies. No sequence can deadlock on the hook again. The change writes and migrates no state, so reverting it restores the hook block.
