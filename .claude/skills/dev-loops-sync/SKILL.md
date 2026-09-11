---
name: "dev-loops-sync"
description: "Provision or refresh the dev-loops agents and skills in a Multica workspace from a detected dev-loops source, driving the `multica` CLI. Idempotent desired-state sync — imports the 7 skills as SKILL.md-only, deletes deprecated carrier skills, pins agents to a runtime, sets DEVLOOPS_HOME, and binds skills to agents. Use when setting up dev-loops in a new workspace or re-syncing after a dev-loops release."
---
<!-- GENERATED from skills/dev-loops-sync/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# dev-loops-sync

Keep a Multica workspace's dev-loops **agents** and **skills** in sync with a
dev-loops **source**, with as few Multica-specific deviations as possible.

## Design invariants

- **Drives the `multica` CLI.** No raw HTTP, no PAT files. In an agent run the
  daemon injects `MULTICA_SERVER_URL` / `MULTICA_TOKEN` / `MULTICA_WORKSPACE_ID`,
  so the CLI authenticates and targets the workspace natively. Standalone, pass
  `--profile` (or `--server-url`) and `--workspace`.
- **Skills are SKILL.md-only.** No bundled tools or contract docs. Everything a
  skill references — `scripts/**`, `../docs/**`, templates — resolves from the
  detected dev-loops source at runtime via `dev-loops-run` (checkout → claude
  plugin → pi). The deprecated `dev-loops-runtime` / `dev-loops-contracts`
  carrier skills are deleted on sync.
- **Source detection: `self` → `local` → `claude` → `pi`.** `self` is this
  script's own checkout (set once it ships inside dev-loops). `local` is a
  best-effort guess (`~/github/dev-loops`) for the common dogfooder layout — it
  is **not** a portable default; set `DEVLOOPS_HOME` or pass `--source` for any
  other checkout location. `claude`/`pi` are the standard install roots. Every
  synced agent carries `DEVLOOPS_HOME` so the resolver finds the checkout even
  when working a non-dev-loops repo (see mfittko/dev-loops#2145).
- **Skill content comes from the `.claude` build**, not the raw `skills/`
  source (which inlines a `<!-- pi-only -->` resolver ladder pointing a Claude
  runtime at a possibly-stale pi install). The sync prefers
  `<source>/.claude/skills`, falling back to `<source>/skills`.
- **One Multica-specific piece: the agent→skill map** (`BIND` in the script).

## Usage

```bash
# In an agent run (workspace + auth from the daemon):
dev-loops-run scripts/multica/dev-loops-sync.mjs

# Standalone, refreshing after a dev-loops release:
dev-loops-run scripts/multica/dev-loops-sync.mjs --pull \
  --profile <profile> --workspace <slug-or-id> [--workspace <slug-or-id> ...]

# Other flags: --source DIR (or DEVLOOPS_HOME), --runtime claude,
#              --server-url URL, --mca PATH
```

`--pull` runs `git -C <checkout> pull --ff-only` before syncing (no-op if the
source is not a checkout) so a scheduled run picks up a new dev-loops release.
Omitted `--source` is auto-detected; omitted `--workspace` uses
`MULTICA_WORKSPACE_ID` (agent context) or prompts.

Idempotent — re-run after a dev-loops release to pull the new skill/agent text.

## What it converges to

- The 7 canonical skills (`copilot-pr-followup, dev-loop, final-approval,
  local-implementation, loop-grill, review, ui-review`), content-only.
- The 8 canonical agents (`dev-loop, developer, docs, fixer, judge, quality,
  refiner, review`), pinned to the chosen runtime, `DEVLOOPS_HOME` set, bound to
  their mapped skills.
- No `dev-loops-runtime` / `dev-loops-contracts` skills.

Squads are intentionally out of scope — they are a Multica-native concern.
