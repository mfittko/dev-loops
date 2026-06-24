# Validation policy

Canonical owner for validation requirements across all workflow families.

## Default validation

- `npm run verify` is the default repo-level local validation path
- Must pass before: PR creation, gate entry, merge
- At minimum: `npm test && npm run test:dev-loop`

## Gate-specific requirements

| Gate | Validation required |
|---|---|
| `draft_gate` | CI green on current head (or `--local-validation-head-sha` if CI absent) |
| `pre_approval_gate` | CI green on current head + resolved review threads + clean re-review |

## Coverage requirements

- ≥90% coverage for lines, statements, functions, and branches on changed files
- Test-first for all non-trivial logic

## Cross-references

- [Merge preconditions](merge-preconditions.md)
- [Stop conditions](stop-conditions.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
