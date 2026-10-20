# 0173. Render `.pi/agents` at provision time and do not track it

## Status

Accepted — 2026-10-20 ([issue 2865](https://github.com/mfittko/dev-loops/issues/2865))

Amends the `.pi/agents` layout convention from issues 1606 and 1655: this repo tracked `.pi/agents` as a symlink to `../agents`. Those records stay unedited.

## Context

`extension/sync-packaged-agents.ts` replaces the tracked `.pi/agents` symlink with a real directory of Pi-valid rendered agents. The tracked symlink and the renderer fought for one path. Every checkout showed ` D .pi/agents`, gate validation that requires a clean tree refused, and restoring the symlink swapped the rendered set for raw sources whose `search` token Pi children reject.

## Decision

- `.pi/agents` is untracked and listed in `.gitignore`.
- `scripts/loop/provision-worktree.mjs` renders the Pi-valid agent set into `<worktree>/.pi/agents` on create and reuse. Provisioning stays fail-soft. It skips the render and records a `pi-agents-tracked` skip action when `.pi/agents` is tracked in the worktree index, so a tracked path is never replaced.
- Provisioning renders only in a dev-loops checkout: `package.json` names the package `dev-loops` and an `agents/` directory exists.
- The Pi `session_start` handler renders `<project root>/.pi/agents` from the project's own `agents/` when the project root is a dev-loops checkout (same guard), so a fresh clone gets the set. Every other project root keeps the absent-directory no-op. The render is best-effort.
- Render adds and refreshes files. It does not delete agents removed from `agents/`.
- The Pi `tool_call` handler refuses a `subagent` launch with `agent_set_not_rendered` when a file the dev-loops render itself writes into `<project root>/.pi/agents` still declares `search` or `execute`. The check inspects only the `*.agent.md` names found in the packaged agents source directory, so a project's own agent files are never read. An absent directory is allowed, and no global copy is checked. The refusal names the offending path and tokens. The remedy names `provision-worktree.mjs` only in a dev-loops checkout, else it says to re-render with the packaged-agent sync or replace the named file. Operator decision: [issue 2865 comment](https://github.com/mfittko/dev-loops/issues/2865#issuecomment-6299207997).
- `agents/*.agent.md` keeps the neutral source vocabulary. The Claude generator is unchanged.

## Consequences

A fresh clone gets `.pi/agents` at its first Pi session start or at provisioning. Every worktree gets the same rendered set without depending on a session hook. Restoring the symlink is refused loudly instead of failing children with an opaque tool error.
