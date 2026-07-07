---
description: "Add an issue/PR to the auto queue, or quick-capture a freeform idea as a grilled issue and queue it."
argument-hint: "<issue-or-pr-number | freeform text>"
---
<!-- GENERATED from commands/loop-enqueue.command.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->

Add work to the dev-loop queue. Parse `$ARGUMENTS` before acting. The project is auto-resolved from `.devloops` — never pass `--project` and never invent a project number. `<owner/repo>` resolves from the git remote at invocation, same as the other loop commands.

1. **Argument parsing (fail-closed):**
   - If `$ARGUMENTS` is empty, print `Error: missing argument — provide an issue/PR number or freeform text.` and stop without mutating anything.
   - If `$ARGUMENTS` is a single integer token, take the **numeric path**. Otherwise take the **freeform path**.

2. **Numeric path (existing issue/PR):**
   - Run `node scripts/projects/add-queue-item.mjs --repo <owner/repo> --item <n>`.
   - The script is idempotent and returns `{ ok, item: { status, alreadyPresent } }`. Report the resulting Status column and whether it was already present, e.g. `#<n> is in "Backlog" (already on the board)` or `#<n> added to "Backlog"`.
   - Exit `3` means the issue/PR was not found (`ITEM_NOT_FOUND` / `CONTENT_NOT_FOUND`): print `Error: issue/PR #<n> not found.` and stop. Do not retry with a guessed project.
   - Exit `4` means the issue targets the pickup (`Next Up`) column without a refinement artifact (`MISSING_REFINEMENT_ARTIFACT`): print the error naming the missing sections and point at `/loop-grill <n> --auto`. In headless/auto contexts pass `--auto` on the `add-queue-item.mjs` call instead, so the item parks in the non-pickup column with a recorded reason rather than failing the run; re-enqueue with `--next-up` after grilling.

3. **Freeform path (quick-capture a new idea):** run these steps in order. This is the
   quick-capture exemption from `INTAKE-NEW-IDEA-SAFETY`
   ([Issue intake procedure](../skills/docs/issue-intake-procedure.md)) — the up-front
   proposal artifact, async classification, and second async mutation pass are deferred in
   favor of the inline confirm→create→grill steps below (it always creates a new issue,
   human-gated).
   1. **Confirm first — no mutation before approval.** Print a one-line preview of the issue to be created (`About to create issue: "<concise title>"`) and STOP for approval. Do not create the issue, grill, or enqueue anything until the human approves.
   2. **Create the issue.** After approval, create a minimal GitHub issue from the text. The repo has no dedicated create-issue wrapper under `scripts/github/`; the sanctioned create path in this codebase is `gh issue create --repo <owner/repo> --assignee @me --title "<concise title>" --body "<freeform text>"` (the same path used by `skills/docs/issue-intake-procedure.md` and permitted by `skills/docs/main-agent-contract.md`). Title = a concise summary of the text; body = the verbatim freeform text.
   3. **Grill it.** Run `/loop-grill <n> --auto` (delegates to the `loop-grill` skill). The skill writes a `## Grill findings` section back into the issue body and flags any unresolved items there, so they are visible before pickup. Do not re-implement grilling.
   4. **Enqueue.** Run `node scripts/projects/add-queue-item.mjs --repo <owner/repo> --item <n>` to add the grill-annotated issue to the board, then report its Status column as in the numeric path. The `strategy: local-first` default is set repo-wide in `.devloops` (`strategy.default: local-first`), so the new issue is already local-first — this repo has no per-issue local-first label or body tag to apply, and you MUST NOT invent one.
