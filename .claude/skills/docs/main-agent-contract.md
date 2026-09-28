# Main-agent delegation contract

How dev-loop work is structured depends on the harness.

**Under the Claude Code harness, the dev-loop runs as a single agent that acts as a delegating
COORDINATOR.** The agent invoked for dev-loop work runs git and PR lifecycle operations, runs the
`dev-loops` CLI (including state-changing `gate` / `pr` / `loop` subcommands), and posts gate
verdicts under the operating session's identity. There is no separate read-only "main agent" and
no Pi-style main-agent→dev-loop async hop. As COORDINATOR, the dev-loop agent is read-only for
TRACKED repo files (source, tests, docs) and MUST delegate every tracked-file implementation edit
and targeted verification run to a fresh WORKER subagent (`developer`/`fixer`/`quality`/`docs`).
The coordinator MAY still write EPHEMERAL gitignored/non-repo artifacts directly: `tmp/`, the
scratchpad, and sanctioned ledger paths (the PR body markdown, comment bodies, dispatch prompts,
gate evidence/ledgers under `tmp/gate-findings/`). The `PreToolUse` Write/Edit guard hook enforces
this boundary: opt-in via `DEVLOOPS_COORDINATOR_READONLY=1` (default fail-open), fail-closed once
enforced, it denies a tracked-file Write/Edit whose `agent_type` is `dev-loop` or `gate-coordinator`; a worker
subagent's `agent_type` is unaffected. It is a targeted denylist, not an airtight sandbox:
Bash-driven tracked mutations (`git commit`, `sed -i`, `> file`) stay convention-enforced, and
the top-level/inline agent (`agent_type: null`) falls under the main-agent boundary below. On Pi, see
"Guarded surface and deliberate ceilings" below for what it does and does not cover. **The coordinator also
delegates code-verification/build runs** (#2082): it MUST NOT run `bun run verify`/`bun test`/
`vitest`/`npm test`/`npm run test`, and the analogous `build` script across `bun`/`npm`/`yarn`/
`pnpm`, inline — delegate targeted checks to a fresh worker subagent, which reports back a compact
pass/fail plus any failing-test names; request a local full-repository run only through `dev-loops gate resolve-validation` on a clean commit, or, when checking a pushed commit, prefer CI's structured
conclusion (`scripts/github/probe-ci-status.mjs` / `scripts/github/detect-checkpoint-evidence.mjs`) over a local run. Enforced by the
same opt-in `PreToolUse` Bash gate hook and the same `DEVLOOPS_COORDINATOR_READONLY=1` flag; a
worker subagent's targeted verify/build run is unaffected; a local full-repository run is owned only by `dev-loops gate resolve-validation` per [Validation Policy](validation-policy.md). The draft-gate `gh pr ready`
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

## Filing from runner findings

<!-- rule: MAIN-AGENT-FILING-BLOCKER-ONLY -->
`MAIN-AGENT-FILING-BLOCKER-ONLY`: The orchestrator files a new issue from a runner finding only
when the finding is a blocker, that is, when it blocks a merge or deadlocks a PR. Every other
runner finding goes as a comment on an existing issue or epic. The gate tools follow the same
bar: `judge-pass.mjs` and `close-gate-findings.mjs` never create an issue for a deferred finding
(see `GATE-EXEC-DEFERRAL-RECORD` in the
[Gate review sub-loop contract](gate-review-sub-loop-contract.md)).

