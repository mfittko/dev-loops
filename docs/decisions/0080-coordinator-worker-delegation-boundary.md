# 0080. Coordinator→worker delegation boundary under Claude Code

## Status

Accepted — 2026-09-21 ([PR 2326](https://github.com/mfittko/dev-loops/pull/2326))

## Context

Under the Claude Code harness, `skills/docs/main-agent-contract.md` already establishes that the
dev-loop agent runs as a single COORDINATOR at the outer level — there is no separate read-only
main agent and no mandatory async-subagent hop, mirroring the flat structure Pi does not need
either. Left unconstrained, though, that same coordinator can directly `Write`/`Edit` tracked repo
files and run the daily code-verification/build entrypoints (`bun run verify`, `bun test`,
`vitest`, `npm test`, and the `yarn`/`pnpm` equivalents) inline. Both are self-implementation: the
coordinator accumulates the same context-snowball the outer read-only boundary already exists to
avoid one level up — a long-lived coordinator transcript re-absorbing full diffs, file contents,
and verification output defeats the flat-context goal that dispatching fresh, narrowly-scoped
worker subagents (`developer`/`fixer`/`quality`/`docs`/`review`) is meant to deliver (issue
[#2082](https://github.com/mfittko/dev-loops/issues/2082)).

## Decision

Under Claude Code, a dev-loop COORDINATOR (`agent_type: "dev-loop"`) is read-only for TRACKED repo
files and for code-verification/build command entrypoints. It MUST delegate every tracked-file
implementation edit and every verification/build run to a fresh WORKER subagent instead of
performing either itself. The coordinator MAY still write ephemeral artifacts directly — `tmp/`,
the scratchpad, and sanctioned ledger paths (the PR body markdown, comment bodies, dispatch
prompts, gate evidence/ledgers under `tmp/gate-findings/`) — because those are gitignored/non-repo
paths, not tracked-file mutations.

Enforcement is deterministic, not conventional: the existing `PreToolUse` Write/Edit guard hook
(`decideCoordinatorWriteGuard`) and the `PreToolUse` Bash gate hook
(`decideBashGate`/`commandContainsCodeVerificationEntrypoint`), both in
`packages/core/src/claude/hook-decisions.mjs`, deny a tracked-file `Write`/`Edit` or a known
verification/build entrypoint whenever the caller's `agent_type` is the coordinator's own
(`dev-loop`, normalized for the plugin-namespaced `dev-loops:dev-loop` form). A worker subagent's
`agent_type` is unaffected by either check. Both deciders are gated by the same opt-in
`DEVLOOPS_COORDINATOR_READONLY` flag (default fail-open, adopt-safe for a consumer repo); this repo
enables it. Once enabled, the decision is fail-closed and non-bypassable by the coordinator itself
— there is no coordinator-side escape hatch. This mirrors, one level down, the existing absolute
main-agent read-only boundary Pi enforces at the outer level and that `DEVLOOPS_MAIN_AGENT_READONLY`
can re-impose for Claude Code.

The verify-command boundary's denylist is a targeted set of known package-manager/`vitest`
entrypoints (with tolerance for `:`-namespaced sub-scripts, `npx`/`bunx`/`bun x` runners, and a
bounded set of `nice`/`timeout` process-wrapper forms), not a general shell-command classifier.
Harness-agnostic: this is a Claude Code `PreToolUse` hook. Pi never invokes these hooks, so a Pi
run is unaffected — the coordinator→worker boundary is inert there by construction, not by a
harness-conditional carve-out.

We rejected mandating a Pi-style async main-agent→dev-loop hop for Claude Code (out of scope for
this boundary; the outer single-agent structure is unchanged). We rejected making the verify-command
denylist an exhaustive shell-command parser: the goal is to catch the coordinator's routine daily
commands, not to build an airtight sandbox — a coordinator determined to evade the pattern-based
deny is a different, unaddressed threat model.

## Consequences

A dev-loop coordinator run under Claude Code with `DEVLOOPS_COORDINATOR_READONLY` enabled can no
longer accumulate full diffs, file contents, or verification output in its own long-lived context;
that work happens in fresh worker subagent contexts and returns to the coordinator as a compact
report. This is additive to the existing outer-level coordinator structure and does not change gate
semantics, review angles, or human approval/merge authority. The denylist is deliberately not
airtight: uncovered `nice`/`timeout` flag combinations, or a command expressed outside the known
denylist shapes, are a known ceiling rather than a guaranteed sandbox, and the flag stays fail-open
by default so adopting the harness does not retroactively break a repo that has not opted in.
