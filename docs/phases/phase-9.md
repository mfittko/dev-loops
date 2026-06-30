# Phase 9 durable plan: namespace Claude Code slash commands with `loop-`

## Status

Planning

## Objective

Namespace the six dev-loop Claude Code slash commands with a `loop-` prefix so
their bare names stop colliding with Claude Code built-ins (notably `/status`).

## Why this phase exists now

When the dev-loop command assets are loaded as project commands, bare names like
`/status` shadow or collide with Claude Code built-ins. A `loop-` prefix
disambiguates every command while keeping each a thin wrapper over the public
`dev-loop` intent.

## In scope

- Rename the six command sources: `commands/<name>.command.md` →
  `commands/loop-<name>.command.md` for `start`, `auto`, `continue`, `info`,
  `status`, `start-spike`.
- Update the one in-text cross-reference `/continue #N` → `/loop-continue #N`
  inside `commands/loop-continue.command.md`.
- Regenerate `.claude/commands/loop-*.md` via
  `node scripts/claude/generate-claude-assets.mjs` (old
  `.claude/commands/<name>.md` removed).
- Update `test/contracts/claude-assets-reproducible.test.mjs` to assert the new
  `loop-*` targets.

## Explicit non-goals

- No change to command behavior, routing, or the public `dev-loop` intent each
  command wraps.
- No change to the agent/skill assets, only the six command assets.
- No edits to `docs/articles/*` or `docs/presentations/*` (pre-existing
  unrelated working-tree changes stay out of this loop).

## Acceptance criteria

- All six `commands/loop-<name>.command.md` sources exist; no bare-named source
  remains.
- `.claude/commands/loop-*.md` are regenerated and the no-drift check
  (`generate-claude-assets.mjs --check`) passes.
- The cross-reference inside `loop-continue.command.md` reads `/loop-continue #N`.
- `test/contracts/claude-assets-reproducible.test.mjs` asserts the `loop-*`
  targets and passes.

## Definition of done

- No-drift `--check` is clean.
- `node --test test/contracts/claude-assets-reproducible.test.mjs packages/core/test/claude-asset-generation.test.mjs` passes.
- Branch contains only the in-scope files; the unrelated docs changes are not staged.
- PR opened; review phase run; stop at the human-approval checkpoint.

## Validation approach

Run the generated-asset no-drift `--check` and the two relevant test files.

## Durable decisions

- Commands are namespaced via a `loop-` prefix rather than a directory, keeping
  each command a flat, thin wrapper.

## Open questions

None.

## Links to execution artifacts

- local execution artifacts may exist under `tmp/phases/phase-9/`
