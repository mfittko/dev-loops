---
name: "dev-loops-sync"
description: "Provision or refresh the dev-loops agents and skills in a Multica workspace from a detected dev-loops source. Idempotent desired-state sync — imports the 7 skills as SKILL.md-only, deletes deprecated carrier skills, pins agents to a runtime, sets DEVLOOPS_HOME, and binds skills to agents. Use when setting up dev-loops in a new Multica workspace or re-syncing after a dev-loops release."
allowed-tools: Read Bash
user-invocable: true
---
<!-- GENERATED from skills/dev-loops-sync/SKILL.md by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate. -->


# dev-loops-sync

Keep a Multica workspace's dev-loops **agents** and **skills** in sync with a
dev-loops **source**, with as few Multica-specific deviations as possible.

## Design invariants

- **Skills are SKILL.md-only.** No bundled tools or contract docs. Everything a
  skill references — `scripts/**`, `../docs/**`, templates — resolves from the
  detected dev-loops source at runtime via `dev-loops-run` (self checkout →
  local checkout → claude plugin → pi). Copying those into Multica is the
  deviation this skill removes; the deprecated `dev-loops-runtime` and
  `dev-loops-contracts` carrier skills are deleted on sync.
- **Source is auto-detected in order: self → local → claude → pi.** First match
  wins: the dev-loops checkout this script ships in (walk up from the script dir
  for a `dev-loops` `package.json` + sibling `scripts/`), then
  `~/github/dev-loops` (checkout), then
  `~/.claude/plugins/cache/dev-loops/dev-loops/<version>`, then
  `~/.pi/agent/npm/node_modules/dev-loops`. Pi is last because it is the most
  likely to lag. Override with `--source` / `DEVLOOPS_HOME`.
- **Skill content comes from the `.claude` build**, not the raw `skills/`
  source — the raw source inlines a `<!-- pi-only -->` resolver ladder that
  points a Claude runtime at a (possibly stale) pi install. The sync prefers
  `<source>/.claude/skills` and falls back to `<source>/skills`.
- **Agents carry `DEVLOOPS_HOME`** (the checkout path) in their per-agent
  `custom_env`, so the resolver can find the live checkout even when the agent
  works a non-dev-loops repo (cwd walk-up misses).
- **One Multica-specific piece: the agent→skill map** (which skills each agent
  gets). It lives in the script's `BIND` constant. Everything else is derived
  from the source.

## Usage

Invoke the script through the standard `node scripts/…` form. In the generated
`.claude` output this is rewritten to go through `dev-loops-run`, which resolves
the live source before running:

```bash
dev-loops-run scripts/multica/dev-loops-sync.mjs \
  --source /abs/path/to/dev-loops \   # optional; auto-detected self>local>claude>pi
  --checkout /abs/path/to/dev-loops \ # optional; DEVLOOPS_HOME for agents (defaults to source when it's a checkout)
  --workspace <slug-or-id> \          # repeatable; prompts/lists if omitted
  --runtime claude \                  # runtime provider to pin agents to (default: claude)
  --api http://localhost:18908 \      # or MULTICA_API
  --pat <token>                       # or MULTICA_PAT, or a ~/.multica/profiles/*/config.json
```

Missing `--source` is auto-detected (or prompted on a TTY). Missing
`--workspace` lists the available workspaces and prompts. The PAT is read from a
Multica profile `config.json` when not passed.

The sync is **idempotent** — re-run it after a dev-loops release to pull the new
skill/agent text. It updates in place, creates what's missing, and removes the
deprecated carrier skills.

## What it converges to

- The 7 canonical skills (`copilot-pr-followup, dev-loop, final-approval,
  local-implementation, loop-grill, review, ui-review`), content-only.
- The 8 canonical agents (`dev-loop, developer, docs, fixer, judge, quality,
  refiner, review`), pinned to the chosen runtime, `DEVLOOPS_HOME` set, bound to
  their mapped skills.
- No `dev-loops-runtime` / `dev-loops-contracts` skills.

Squads are intentionally out of scope — they are a Multica-native concern, not
part of the dev-loops source.
