# Main-agent delegation contract

How dev-loop work is structured depends on the harness.

**Under the Claude Code harness, the dev-loop runs as a single agent that acts as a delegating
COORDINATOR.** The agent invoked for dev-loop work runs git and PR lifecycle operations, runs the
`dev-loops` CLI (including state-changing `gate` / `pr` / `loop` subcommands), and posts gate
verdicts under the operating session's identity. There is no separate read-only "main agent" and
no mandatory async-subagent dispatch — i.e. no Pi-style main-agent→dev-loop async hop: the dev-loop
agent is invoked directly and owns the work end to end, at that outer level. This is distinct from
the coordinator→worker delegation described next: the same dev-loop agent, now acting as
COORDINATOR one level down, is itself read-only for TRACKED repo files (source, tests, docs) and
MUST delegate every tracked-file implementation edit and verification run to a fresh WORKER
subagent (`developer`/`fixer`/`quality`/`docs`). The coordinator MAY still write EPHEMERAL artifacts
directly — `tmp/`, the scratchpad, and sanctioned ledger paths (the PR body markdown, comment
bodies, dispatch prompts, gate evidence/ledgers under `tmp/gate-findings/`) — because those are
gitignored/non-repo paths, not tracked-file mutations. This coordinator→worker boundary is the
Claude analogue of the absolute main-agent read-only boundary Pi enforces, enforced mechanically
(not by convention) by the same `PreToolUse` Write/Edit guard hook: opt-in via
`DEVLOOPS_COORDINATOR_READONLY=1` (default fail-open), fail-closed once enforced, and
non-bypassable BY THE DISPATCHED COORDINATOR (`agent_type: "dev-loop"`) FOR ITS GUARDED SURFACE — a
tracked-file Write/Edit whose `agent_type` is `dev-loop` is denied; a worker subagent's `agent_type`
is unaffected. This is a mechanically-guarded, targeted denylist, not an airtight sandbox; see
"Guarded surface and deliberate ceilings" below for what it does and does not cover. **The coordinator also
delegates code-verification/build runs** (#2082): it MUST NOT run `bun run verify`/`bun test`/
`vitest`/`npm test`/`npm run test`, and the analogous `build` script across `bun`/`npm`/`yarn`/
`pnpm`, inline — delegate the run to a fresh worker subagent, which reports back a compact
pass/fail plus any failing-test names, or, when checking a pushed commit, prefer CI's structured
conclusion (`scripts/github/probe-ci-status.mjs` / `scripts/github/detect-checkpoint-evidence.mjs`) over a local run. Enforced by the
same opt-in `PreToolUse` Bash gate hook and the same `DEVLOOPS_COORDINATOR_READONLY=1` flag; a
worker subagent's verify/build run is unaffected. The draft-gate `gh pr ready`
guard still applies (harness-agnostic). A separate, stricter main-agent read-only boundary can
also be re-imposed via the same hook — opt-in with `DEVLOOPS_MAIN_AGENT_READONLY=1` (default
fail-open) — for repos that want it.

## Sanctioned tooling

`scripts/loop/sanctioned-commands.mjs` exports `SANCTIONED_COMMANDS`. That module is the owning
index of the sanctioned GitHub-operation surface. It maps each operation to its wrapper script and
lists the raw commands that are forbidden. Read the index for the current list. This section does
not copy it.

The `SANCTIONED_COMMANDS` index marks three operations as orchestrator-owned. A spawned `dev-loop`
subagent routes them to the orchestrator:

- Merge, through `scripts/github/merge-pr.mjs`.
- Board status transitions, through `scripts/projects/sync-item-status.mjs` or `scripts/projects/move-queue-item.mjs`.
- Issue creation, through `scripts/github/create-issue.mjs`.

Known gaps outside this contract's current scope still create issues directly with raw
`gh issue create`. They include the epic-decomposition step in `skills/docs/issue-intake-procedure.md`,
the child-issue creation step in `skills/docs/sub-issue-tree-contract.md`, and the issue-creation
guidance in `AGENTS.md`.

Every `ok: true` result of `dev-loops loop startup` carries an `operatorBriefing` field that points
to the index and to this section.

