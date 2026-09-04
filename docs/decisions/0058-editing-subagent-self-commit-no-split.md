# 0058. Editing sub-delegates commit their own work; no edit-here/commit-there split

## Status

Accepted — 2026-09-04 (issue #1936)

## Context

The `SubagentStop` data-loss guard (`decideSubagentStopGuard` / `.claude/hooks/subagent-stop-uncommitted-guard.mjs`, issue #1619) blocks a subagent stop when its worktree under `tmp/worktrees/` has uncommitted changes, so post-merge `cleanup-worktree.mjs --force` cannot destroy uncommitted work. Issue #1925 made it role-aware for read-only roles (`judge`/`review`), whose contract forbids commits.

Issue #1786 added a second exemption, `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT=1`, to sanction a "LOCAL EDITS ONLY: no commit" delegation split: an editing sub-delegate (`developer`/`quality`/`docs`) made edits and reported changed files, leaving the commit to the dispatching orchestrator, which set the env var to exempt the sub-delegate's own stop.

That split hard-deadlocked an editing subagent on the Claude harness. The exemption is an env var the orchestrator must set per dispatch, but the Claude Agent tool exposes no per-dispatch env parameter and shell env does not persist to the hook process. So an editing sub-delegate told "do not commit" without a reachable exemption stopped dirty; the guard demanded a commit; the session permission classifier denied it; the guard re-blocked the exit; only a human interrupt broke the loop (observed on PR #1934, 2026-09-03 fresh-context retro). The split also contradicted `LOCAL-COMMIT-BEFORE-EXIT` (local-implementation step 12), which already mandates a dispatched editing subagent commit before exit.

Issue #1936 offered two mechanisms: (option 1) teach the guard to recognize an orchestrator-owns-commit delegation signal, or (option 2) disallow the edit-here/commit-there split at the contract level.

## Decision

Take option 2. Editing sub-delegates (`developer`/`quality`/`docs`/`fixer`) commit their own work before exit (and push, for tracker-backed sessions). There is no edit-here/commit-there split: an editing sub-delegate is never instructed not to commit, and an orchestrator that wants one consolidated commit performs the edits itself.

Remove the `DEVLOOPS_ORCHESTRATOR_OWNS_COMMIT` env-var exemption and its delegation-split carve-out from the guard, the delegation contract (`skills/local-implementation/SKILL.md`, new rule `LOCAL-DELEGATE-SELF-COMMIT`), and the main-agent contract. The read-only-role exemption (#1925) and the interactive `DEVLOOPS_COMMIT_AUTH_PENDING` exemption (#1619) are unchanged.

Option 1 was rejected: its only mechanical signal is unreachable per-dispatch under the Claude harness (the harness itself is why the deadlock occurred), and any alternative signal (a marker file) leaks its exemption to the next dispatch in the same worktree, weakening data-loss protection. Option 2 needs no exemption at all.

## Consequences

The deadlock is structurally impossible: no editing role is ever told not to commit, so the guard's actionable resolution for a dirty editing exit — commit your own work — is always reachable. Data-loss protection is preserved and strengthened: the guard stays fully enforced for every editing role and becomes the mechanical enforcer of self-commit, rather than something an env var can switch off. The change is a net reduction (removes the env var, its exemption branch, and the contradictory carve-out) and resolves the internal contradiction between the delegation contract and `LOCAL-COMMIT-BEFORE-EXIT`. Consumers (Pi and Claude) that relied on the orchestrator-owns-commit dispatch must adopt the self-commit contract; dev-loop PRs squash-merge, so per-sub-delegate commit granularity is discarded at merge and carries no downside. Pinned by focused hook-contract tests (unit + e2e): the removed flag grants no escape, and every editing role blocks on a dirty exit with the self-commit resolution reason present.
