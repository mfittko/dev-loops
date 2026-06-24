# Main-agent delegation contract

How dev-loop work is structured depends on the harness.

**Under the Claude Code harness, the dev-loop runs as a single agent.** The agent invoked for
dev-loop work performs the steps directly — it reads and writes repository files, runs git and PR
lifecycle operations, runs the `dev-loops` CLI (including state-changing `gate` / `pr` / `loop`
subcommands), and posts gate verdicts under the operating session's identity. There is no separate
read-only "main agent" and no mandatory async-subagent dispatch: the dev-loop agent owns the work
end to end. The draft-gate `gh pr ready` guard still applies (harness-agnostic). A read-only
boundary can be re-imposed optionally via the Write/Edit guard hook — opt-in with
`DEVLOOPS_MAIN_AGENT_READONLY=1` (default fail-open) — for repos that want it.

<!-- pi-only -->
> **Absolute read-only boundary (Pi).** The main agent must never mutate files tracked by the repository.
> All mutations flow through the `dev-loop` async subagent.

## Contract

The main agent is **read-only** for every file tracked by the repository. Every
write, edit, delete, commit, branch, push, and PR lifecycle operation must flow
through the `dev-loop` async subagent.

This contract is a hard rule, not a default or guideline. The main agent must
never rationalize a direct mutation — not because the work is small, not
because "the user said yes," not because it is running from a worktree.

## Main agent owns (allowed)

- Read, inspect, search any repo file
- `git worktree list`, `git status`, `git log` (read-only git). `git fetch` is also allowed (updates local refs but does not touch tracked working-tree files).
- `gh issue view / create / edit / comment / close` (GitHub API, not file mutations)
- `gh pr view / list` (read-only GitHub API)
- Write to `/tmp` or other non-repo paths (e.g., issue body drafts)
- Delegate to the `dev-loop` agent (async, with worktree cwd)
- Report findings, ask questions, get confirmation
- `npm test`, `npm run verify` (read-only validation)

## Main agent must NEVER

- `write`, `edit`, or delete any file tracked by the repo
- `git commit`, `git push`, create branches, create worktrees
- Run state-changing dev-loops CLI subcommands (`gate`, any state-changing `loop` subcommand, `pr` commands — those belong inside `dev-loop`).
- Delegate implementation to any agent other than `dev-loop`

## Dev-loop agent (async) owns

- ALL file mutations in the repo (write, edit, delete)
- ALL git operations (branch, commit, push)
- ALL PR lifecycle (create, draft, review, merge)
- Sub-delegation to developer, fixer, review, quality agents

## Boundary examples

| Operation | Verdict |
|---|---|
| `gh issue create --title "..." --body "..."` | Allowed — mutates GitHub, not files tracked by the repository |
| Write to `/tmp/issue-body.md` | Allowed — outside the repo |
| Write to `packages/core/src/foo.mjs` | **BREACH** — must delegate to `dev-loop` |
| `git status` | Allowed — read-only |
| `git commit -m "..."` | **BREACH** — must delegate to `dev-loop` |
| `subagent dev-loop` | Allowed — correct delegation |
| `subagent fixer` | Allowed only when called from within `dev-loop`; describe the task as part of the message |

## Dev-loop startup

When a user triggers the dev loop, the main agent must immediately dispatch the
`dev-loop` async subagent. The subagent owns the startup resolver, route selection,
and all subsequent implementation steps. The main agent never runs `dev-loops loop startup`
directly.

## Enforcement posture

- Under **Pi**, this contract is enforced by convention and review.
- Under **Claude Code**, the **Edit/Write tool** path is enforced **mechanically** by a
  `PreToolUse` Write/Edit hook (`.claude/hooks/pre-tool-use-write-guard.mjs`, wired via
  `.claude/settings.json` for this repo's own sessions and via `.claude/hooks/hooks.json` for the
  Claude plugin): a Write/Edit whose target is inside the repo working tree and not
  gitignored is **denied** when it originates from the main agent, and allowed only inside the
  `dev-loop` subagent context (detected via the neutral `DEVLOOPS_RUN_ID` run-id contract, or
  the dev-loop `agent_type` — a generic subagent is not authorized).
  Strict enforcement is opt-in via `DEVLOOPS_MAIN_AGENT_READONLY=1` (default fail-open) so
  adopting the harness does not retroactively break a repo's own interactive dev; full run-id
  propagation into the Claude subagent context completes with the headless/agent wiring.
- **Scope of mechanical enforcement:** the hook covers the Edit and Write tools. Bash-driven
  repo mutations the contract also forbids (`git commit`/`git push`/branch creation, in-place
  edits like `sed -i`, shell redirection `> file` / `tee`) run through the Bash tool and remain
  **convention-enforced** for now; the only Bash command the gate hook blocks is the ungated
  `gh pr ready`. Tightening Bash-mutation coverage is possible follow-up.
- A companion `PreToolUse` Bash hook reproduces the `gh pr ready` draft-gate guard.
- A `dev-loop` async subagent should still reject delegation attempts that bypass the contract.

## Non-goals

- Pre-commit hooks (out of scope; the boundary is enforced at the Claude tool layer).
- Changing dev-loop resolver behavior
- Modifying the subagent API itself
<!-- /pi-only -->
