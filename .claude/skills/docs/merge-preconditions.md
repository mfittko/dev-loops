# Merge preconditions

Canonical owner for merge preconditions across all workflow families.

## Required before merge

1. ✅ CI green on current head (or crediblyGreen via `--local-validation-head-sha`)
2. ✅ Draft gate satisfied (clean verdict)
3. ✅ Pre-approval gate satisfied (clean verdict, current head)
4. ✅ All review threads resolved
5. ✅ Explicit merge authorization from operator
6. ✅ PR body contains `Closes #N` or `Fixes #N`

## Merge authorization

- Must be explicit for the active issue/PR scope
- `"Merge authorized if gates green"` is valid explicit authorization
- Implied approval from prior turns is not sufficient

## Post-merge

- Remove merged worktree: `git worktree remove --force <path> && git worktree prune`
- Clean up stale branches

## Cross-references

- [Confirmation rules](confirmation-rules.md)
- [Validation policy](validation-policy.md)
- [Stop conditions](stop-conditions.md)
