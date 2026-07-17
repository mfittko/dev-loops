---
description: "Review a PR in a UI (running-app) dev loop."
argument-hint: "<pr>"
---
<!-- GENERATED from commands/loop-review-ui.command.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->

Run the `dev-loop` skill with the public intent `review PR $ARGUMENTS in a UI loop`. Resolve authoritative state first, then route through the deterministic internal strategy. Do not pick an internal strategy name yourself.

**Usage:** `/loop-review-ui <pr>`

**Arguments:**
- `<pr>` — the pull request to review, as a number or URL. Required; with no argument the loop cannot resolve a target and stops.

**What it does:** reviews the PR by proving the change in the running app from an isolated worktree, not by reading the diff alone. It resolves state, provisions a worktree for the PR head and boots the app, authenticates and drives the changed UI flows, diagnoses captured failures against the diff, reports, then tears down — the running-app sibling of the standard `review` angle. It needs a per-project run/auth recipe in `.devloops`; see the [UI-Review Run/Auth Recipe Contract](../skills/docs/ui-review-recipe-contract.md).

**Stop conditions (fails closed with a stated reason):** the target is the primary checkout; no run recipe is declared; a run-recipe `cwd` resolves outside the worktree; a destructive dev-DB migration is not acknowledged; the readiness probe times out; the dev-login recipe cannot authenticate; or the live head has advanced since diagnose.

**Review posture:** the PR review is posted **pending/draft by default** — this loop never auto-submits. A confirmed user-facing server error maps to a change request only when submitting is separately authorized. Bounded caps (max screenshots, flows, steps) are enforced and any overflow is logged.
