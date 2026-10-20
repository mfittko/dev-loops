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
- The Pi `tool_call` handler refuses a `subagent` launch with `agent_set_not_rendered` when a loaded `.pi/agents/*.agent.md` still declares `search` or `execute`. An absent directory is allowed, so consumer repos keep resolving from `~/.agents`.
- The same refusal covers a raw global copy of a requested dev-loops role that Pi would load: for each role without a project copy, the first of `~/.agents`, `~/.pi/agent/agents`, and the Pi npm and git package copies (Pi load precedence) is checked, and only that file. A raw package copy shadowed by a rendered higher-precedence copy is allowed, because package `agents/` keeps the neutral vocabulary by design. The refusal names the offending path and a remedy per offender class. `agentScope` is read from `options` or the top level: `project` skips the global check, and `user` skips the project set and checks only the first global copy Pi loads. Project-root resolution follows the Pi project walk, as owned by the "Project agent set on Pi" section of `skills/docs/cross-harness-regression-contract.md`.
- `agents/*.agent.md` keeps the neutral source vocabulary. The Claude generator is unchanged.

## Consequences

A fresh clone gets `.pi/agents` at its first Pi session start or at provisioning. Every worktree gets the same rendered set without depending on a session hook. Restoring the symlink is refused loudly instead of failing children with an opaque tool error.
