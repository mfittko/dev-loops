# Copilot instructions — dev-loops

Single entrypoint: `dev-loop`. Prefer GitHub-first path. KISS, SRP, YAGNI.
Work test-first, ≥90% coverage. `npm run verify` for full validation.

## PR body rules

- Use the PR template at `.github/pull_request_template.md`.
- Render acceptance criteria, definition-of-done items, and task lists as real GitHub markdown checkboxes (`- [ ]` / `- [x]`).
- Never wrap checkbox markers like `[x]` in backticks.

## Canonical rule docs (single owner per rule)

Confirmation → `../skills/docs/confirmation-rules.md`
Stop conditions → `../skills/docs/stop-conditions.md`
Anti-patterns → `../skills/docs/anti-patterns.md`
Validation → `../skills/docs/validation-policy.md`
Merge preconditions → `../skills/docs/merge-preconditions.md`
Structural quality → `../skills/docs/structural-quality.md`

## Per-strategy entrypoint briefings (30-50 lines each)

`../skills/docs/entrypoint-strategies.md` — load the per-strategy section for the routed strategy.

## Key helpers

Startup: `node scripts/loop/resolve-dev-loop-startup.mjs`
Create PR (always draft, self-assigned by default): `node scripts/github/create-pr.mjs ...` (`--assignee @me` is the default)
Gate: `node scripts/github/upsert-checkpoint-verdict.mjs`
Branch guard: `node scripts/loop/pre-commit-branch-guard.mjs`

## Contracts

[Public Dev Loop Contract](skills/docs/public-dev-loop-contract.md)
[Worktree Guidance](skills/docs/worktree-guidance.md)
