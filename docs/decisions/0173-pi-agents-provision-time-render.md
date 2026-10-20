# 0173. Render `.pi/agents` at provision time and do not track it

## Status

Accepted — 2026-10-20 ([issue 2865](https://github.com/mfittko/dev-loops/issues/2865))

Amends the `.pi/agents` layout convention from issues 1606 and 1655: this repo tracked `.pi/agents` as a symlink to `../agents`. Those records stay unedited.

## Context

`extension/sync-packaged-agents.ts` replaces the tracked `.pi/agents` symlink with a real directory of Pi-valid rendered agents. The tracked symlink and the renderer fought for one path. Every checkout showed ` D .pi/agents`, gate validation that requires a clean tree refused, and restoring the symlink swapped the rendered set for raw sources whose `search` token Pi children reject.

## Decision

- `.pi/agents` is untracked and listed in `.gitignore`.
- `scripts/loop/provision-worktree.mjs` renders the Pi-valid agent set into `<worktree>/.pi/agents` on create and reuse. Provisioning stays fail-soft.
- Provisioning renders only in a dev-loops checkout: `package.json` names the package `dev-loops` and an `agents/` directory exists.
- The main checkout is rendered by the existing session-start sync. Provisioning makes no call there.
- Render adds and refreshes files. It does not delete agents removed from `agents/`.
- The Pi `tool_call` handler refuses a `subagent` launch with `agent_set_not_rendered` when a loaded `.pi/agents/*.agent.md` still declares `search` or `execute`. An absent directory is allowed, so consumer repos keep resolving from `~/.agents`.
- The same refusal covers a stale global copy of a requested dev-loops role (`~/.agents`, `~/.pi/agent/agents`, and the Pi npm and git package copies) that declares `search` or `execute`, because Pi reads those copies and they can win over the project render. The refusal names the offending path, and `options.agentScope: "project"` skips the global check.
- `agents/*.agent.md` keeps the neutral source vocabulary. The Claude generator is unchanged.

## Consequences

A fresh clone has no `.pi/agents` until it is provisioned. Every worktree gets the same rendered set without depending on a session hook. Restoring the symlink is refused loudly instead of failing children with an opaque tool error.
