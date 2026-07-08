---
name: "ui-review"
description: "Internal routed strategy behind `dev-loop` for the UI-review route — the \"prove it in the running app\" review sibling of reviewer/fixer. Scaffold slice only: registers the route, its stop rules, and its acceptance self-validation."
allowed-tools: Read Bash
user-invocable: false
---
<!-- GENERATED from skills/ui-review/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# UI Review (scaffold)

When the public router selects `ui_review`, this route reviews a PR by proving
the change in the running app from an isolated worktree, rather than reading the
diff alone. It is the running-app review sibling of the `reviewer_fixer` route.

The route's handoff envelope carries its stop rules and acceptance
self-validation (defined in `handoff-envelope.mjs`): no product-code writes,
worktree-only, outward review stays pending/draft, and destructive migrations
must be acknowledged before they run.

## Non-goals

No provision/boot/drive/diagnose/report/teardown logic lives in this scaffold
slice. This file only names the route so the router, startup resolver, and
handoff envelope have a first-class entrypoint to bind to.
