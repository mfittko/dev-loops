---
description: Run a single, standalone code-review pass over a PR (no gate obligations).
argument-hint: <pr> [--auto]
---
Invoke the `review` skill with `$ARGUMENTS`.

**Usage:** `/dev-loops:loop-review <pr> [--auto]` (or `/loop-review <pr> [--auto]` in the dev-loops repo itself)

**Arguments:**
- `<pr>` — the pull request to review, as a number or URL. Required; with no argument the loop cannot resolve a target and stops. `<owner/repo>` resolves from the git remote at invocation, same as the other loop commands.
- `--auto` — headless/non-interactive (mirrors `/loop-grill`'s `--auto`, `/dev-loops:loop-grill` in a consumer install). Posts the review as `--submit comment` immediately, no prompt. Omit it for an interactive run.

**What it does:** runs ONE `review`-gate round over the shared draft/pre-approval fan-out/fan-in sub-loop (context-builder, fan-out reviewers over the union of draft's and pre-approval's configured angles, fan-in), then posts the single-surface verdict. `review` is a THIRD gate reachable on any PR — draft or ready — with NO gate obligations of its own: it never blocks a draft→ready transition, never blocks merge, never waits on CI, and never satisfies `draft_gate`/`pre_approval_gate` evidence, in EVERY submit mode (see below). See the [Review skill](../skills/review/SKILL.md) for the phase-by-phase contract.

**Submit choice:** an interactive run posts the review `--submit pending` (an author-only draft, invisible until submitted) and then ends with a multiple-choice submit step — **Leave pending (default)**, Submit as Comment, Submit as Request-changes, Submit as Approve, or Discard; Request-changes and Approve state their GitHub branch-protection effect inline. No-dangling guarantee (#1848): every **Submit as** choice submits the EXISTING pending draft in place via `/reviews/<id>/events` (same review id, preserving inline comments) rather than creating a second review, so an interactive Submit leaves exactly one review and no orphaned pending draft; **Discard** deletes the draft (leaving none) and **Leave pending** keeps exactly the one draft. A headless `--auto` run skips the prompt and posts `--submit comment` directly — `approve`/`request-changes` are refused headless (reachable only through the interactive choice), so automation can never auto-approve or auto-block a PR.

**Stop conditions:** this command NEVER calls the fixer, never flips a PR to ready-for-review, and never moves a board item — a `review` round is a single, complete, terminal pass with no re-gate path. If the operator wants findings fixed, that is a separate, explicit follow-up instruction.
