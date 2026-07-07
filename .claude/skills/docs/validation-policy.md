# Validation policy

Canonical owner for validation requirements across all workflow families.

## Default validation

<!-- rule: VALIDATE-VERIFY-BEFORE-GATE -->
`VALIDATE-VERIFY-BEFORE-GATE`: `npm run verify` is the default repo-level local validation path and MUST pass before PR creation, gate entry, and merge; at minimum this means `npm test && npm run test:dev-loop`.

## Gate-specific requirements

| Gate | Validation required |
|---|---|
| `draft_gate` | CI green on current head (or `--local-validation-head-sha` if CI absent) |
| `pre_approval_gate` | CI green on current head + resolved review threads + clean re-review |

## Coverage requirements

<!-- rule: VALIDATE-COVERAGE-THRESHOLD -->
`VALIDATE-COVERAGE-THRESHOLD`: Changed files SHOULD maintain ≥90% coverage for lines, statements, functions, and branches (not enforced by the shipped verify config; treat it as the working target), and non-trivial logic MUST be test-first.

## Cross-references

- [Merge preconditions](merge-preconditions.md)
- [Stop conditions](stop-conditions.md)
- [Public Dev Loop Contract](public-dev-loop-contract.md)
