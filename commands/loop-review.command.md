---
description: Run a single, standalone code-review pass over a PR (no gate obligations).
argument-hint: <pr>
---
Invoke the `review` skill with `$ARGUMENTS`.

**Usage:** `/dev-loops:loop-review <pr>` (or `/loop-review <pr>` in the dev-loops repo itself)

**Arguments:**
- `<pr>` — the pull request to review, as a number or URL. Required; with no argument the loop cannot resolve a target and stops. `<owner/repo>` resolves from the git remote at invocation, same as the other loop commands.

**What it does:** runs ONE `review`-gate round over the shared draft/pre-approval fan-out/fan-in sub-loop (context-builder, fan-out reviewers over the union of draft's and pre-approval's configured angles, fan-in), then posts the single-surface verdict and stops. `review` is a THIRD gate reachable on any PR — draft or ready — with NO gate obligations of its own: it never blocks a draft→ready transition, never blocks merge, never waits on CI, and never satisfies `draft_gate`/`pre_approval_gate` evidence. See the [Review skill](../skills/review/SKILL.md) for the phase-by-phase contract.

**Stop conditions:** this command NEVER calls the fixer, never flips a PR to ready-for-review, and never moves a board item — a `review` round is a single, complete, terminal pass with no re-gate path. If the operator wants findings fixed, that is a separate, explicit follow-up instruction.
