# Anti-patterns

Canonical owner for anti-pattern guidance across all workflow families.

## Core anti-patterns

1. **Skipping fan-out/fan-in for non-trivial changes**: Do not implement directly without refinement when scope exceeds light-mode thresholds.
2. **Routing review-only work through local_implementation**: Review-only comparison, synthesis, or consolidation must use `refiner` agent, not `dev-loop` + `local_implementation`.
3. **Thin placeholder PR descriptions**: Always include change summary, scope/context, acceptance criteria, definition of done, non-goals, and `Closes #N`.
4. **Merging directly to main without PR**: Use PR-based remote loop when practical.
5. **Duplicate worktree paths**: Check `git worktree list` before creating new worktrees; reuse existing matching worktrees.
6. **Main-checkout mutation**: Reserve main checkout for inspection/control; use `tmp/worktrees/` paths for mutation work.

## Light mode exception

Small scoped changes (≤3 files, ≤200 lines) may skip fan-out/fan-in but must still run validation and a single review pass. See [Local Implementation](../local-implementation/SKILL.md) for details.

## Cross-references

- [Structural quality](structural-quality.md)
- [Validation policy](validation-policy.md)
