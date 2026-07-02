# Anti-patterns

Canonical owner for anti-pattern guidance across all workflow families.

## Core anti-patterns

1. **Skipping fan-out/fan-in for non-trivial changes**: Do not implement directly without refinement when scope exceeds light-mode thresholds.
2. **Routing review-only work through local_implementation**: Review-only comparison, synthesis, or consolidation must use `refiner` agent, not `dev-loop` + `local_implementation`.
3. **Thin placeholder PR descriptions**: Always include change summary, scope/context, acceptance criteria, definition of done, non-goals, and `Closes #N`.
4. **Merging directly to main without PR**: Use PR-based remote loop when practical.
5. **Duplicate worktree paths**: Check `git worktree list` before creating new worktrees; reuse existing matching worktrees.
6. **Main-checkout mutation**: Reserve main checkout for inspection/control; use `tmp/worktrees/` paths for mutation work.
7. **Spelunking tooling internals instead of using the public surface**: Do not read installed package internals, scan tooling source, or run ad-hoc scripts to understand a tool's behavior. Use the CLI, its `--help` subcommands, and `skills/docs/`. Read tool source only when the task is to inspect or change that tool, or when a concrete failure path is inside it and no public CLI/docs path exists. Once a failure is concrete, search changed files for the exact pattern — don't run duplicate broad searches.
8. **Hand-editing the queue file when a board is configured**: When a GitHub Projects board is configured (`queue.projectNumber`/`queue.boardTitle` in `.devloops`), the board is the authoritative queue MEMBERSHIP and ordering source — not just status. Add work via the board (`dev-loops queue add ... --next-up` to land directly in the normative `Next Up` pickup queue; default lands in Backlog, which is unprioritized intake and never auto-picked), not by hand-editing `.pi/dev-loop-queue.json`; the queue runner reconciles board `Next Up` items into queue entries before each run. See the operator guides under `docs/` (queue board usage/setup) for the workflow.
9. **Hand-rolling a fan-in wait by polling a subagent transcript or parsing tool JSON with `node -e`/`python3`**: When awaiting fan-out reviewers (gate `draft_gate`/`pre_approval_gate` sub-loops, or any Agent-tool fan-out), NEVER tail/parse another agent's JSONL transcript, NEVER use `node -e`/`python3` to parse tool/subagent JSON, and NEVER `sleep`-poll in a shell loop for completion. These improvisations breach the [internal-tooling-only rule (issue #982)](retrospective-checkpoint-contract.md#internal-tooling-only-rule-issue-982--now-advisory) (no `node -e`/`python3` parsing of tool JSON) and the no-shell-polling rule, and a single improvised wait adds a non-empty entry to the advisory `retrospectiveFindings.rawCallViolations` array (issue #1077: reported to the conductor, **never blocking**). **Sanctioned wait:** rely on the harness completion notification, or read each reviewer's findings artifact at its deterministic output path (see [Checkpoint Review Chain Contract](../../docs/gate-review-sub-loop-contract.md) Phase 2), then join via `consolidateFanin` from `@dev-loops/core/loop/gate-fanin` (Phase 3). See also the dev-loop SKILL "Bounded async task contract".

## Light mode exception

Small scoped changes (≤3 files, ≤200 lines) may skip fan-out/fan-in but must still run validation and a single review pass. See [Local Implementation](../local-implementation/SKILL.md) for details.

## Cross-references

- [Structural quality](structural-quality.md)
- [Validation policy](validation-policy.md)
