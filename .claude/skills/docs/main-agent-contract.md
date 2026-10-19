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
gate evidence/ledgers under `tmp/gate-findings/`; tracked files of a loop worktree under `tmp/` stay denied). The `PreToolUse` Write/Edit guard hook enforces
this boundary: opt-in via `DEVLOOPS_COORDINATOR_READONLY=1` (default fail-open), fail-closed once
enforced, it denies a tracked-file Write/Edit whose `agent_type` is `dev-loop` or `gate-coordinator`; a worker
subagent's `agent_type` is unaffected. It is a targeted denylist, not an airtight sandbox:
Bash-driven tracked mutations (`git commit`, `sed -i`, `> file`) stay convention-enforced, and
the top-level/inline agent (`agent_type: null`) falls under the main-agent boundary below. On Pi, see
"Guarded surface and deliberate ceilings" below for what it does and does not cover. **The coordinator also
delegates code-verification/build runs** (#2082): it MUST NOT run `bun run verify`/`bun test`/
`vitest`/`npm test`/`npm run test`, and the analogous `build` script across `bun`/`npm`/`yarn`/
`pnpm`, inline — delegate targeted checks to a fresh worker subagent, which reports back a compact
pass/fail plus any failing-test names; request a local full-repository run only through `dev-loops-run cli/index.mjs gate resolve-validation` on a clean commit, or, when checking a pushed commit, prefer CI's structured
conclusion (`scripts/github/probe-ci-status.mjs` / `scripts/github/detect-checkpoint-evidence.mjs`) over a local run. Enforced by the
same opt-in `PreToolUse` Bash gate hook and the same `DEVLOOPS_COORDINATOR_READONLY=1` flag; a
worker subagent's targeted verify/build run is unaffected; a local full-repository run is owned only by `dev-loops-run cli/index.mjs gate resolve-validation` per [Validation Policy](validation-policy.md). The draft-gate `gh pr ready`
guard still applies (harness-agnostic). A separate, stricter main-agent read-only boundary can
also be re-imposed via the same hook — opt-in with `DEVLOOPS_MAIN_AGENT_READONLY=1` (default
fail-open) — for repos that want it.

## Sanctioned tooling

`scripts/loop/sanctioned-commands.mjs` exports `SANCTIONED_COMMANDS`. That module is the owning
index of the sanctioned GitHub-operation surface. It maps each operation to its wrapper script and
lists the raw commands that are forbidden. Read the index for the current list. This section does
not copy it.

The `SANCTIONED_COMMANDS` index marks the orchestrator-owned operations. A spawned `dev-loop`
subagent routes them to the orchestrator:

- Merge, through `scripts/github/merge-pr.mjs`.
- Board status transitions, through `scripts/projects/sync-item-status.mjs` or `scripts/projects/move-queue-item.mjs`.
- Issue creation, through `scripts/github/create-issue.mjs`.
- Board-item removal, through `scripts/projects/remove-queue-item.mjs` (undo of a wrong queue add only).
- ADR tripwire waiver, through `scripts/github/waive-adr-tripwire.mjs` (`dev-loops-run cli/index.mjs pr waive-adr-tripwire`).

Known gaps outside this contract's current scope still create issues directly with raw
`gh issue create`. They include the epic-decomposition step in `skills/docs/issue-intake-procedure.md`,
the child-issue creation step in `skills/docs/sub-issue-tree-contract.md`, and the issue-creation
guidance in `AGENTS.md`.

Every `ok: true` result of `dev-loops-run cli/index.mjs loop startup` carries an `operatorBriefing` field that points
to the index and to this section.

## Filing from runner findings

<!-- rule: MAIN-AGENT-FILING-BLOCKER-ONLY -->
`MAIN-AGENT-FILING-BLOCKER-ONLY`: The orchestrator files a new issue from a runner finding only
when the finding is a blocker, that is, when it blocks a merge or deadlocks a PR. Every other
runner finding goes as a comment on an existing issue or epic. The gate tools follow the same
bar: `judge-pass.mjs` and `close-gate-findings.mjs` never create an issue for a deferred finding
(see `GATE-EXEC-DEFERRAL-RECORD` in the
[Gate review sub-loop contract](gate-review-sub-loop-contract.md)).

## Generic Codex dispatch

Generic `collaboration.spawn_agent` does not automatically load repository role definitions. For ordinary Codex developer, refiner (including artifact-only refiners), docs and coordinator dispatches, provide verified absolute paths to the applicable role definition and [Codex runtime setup](./copilot-loop-operations.md#codex-runtime-setup) in the task. Verify both files exist in the selected source/install before dispatch; require the child to read them before scoped artifact writes, any Git write or targeted verification. Preserve the mandatory initial startup/envelope and exact pull-first protocols; this is read delivery, not new role or mutation authority. Pull-pointer coordinators and fixers retain their exact emitted payloads and learn applicable setup after their bootstrap; never append generic setup to those payloads.

## Codex coordinator dispatch

For resumed direct/queue entries, emit with `--harness codex` and dispatch the printed
`dispatchPayload` unchanged through `collaboration.spawn_agent`. Its exact fields are
`{task_name: "coordinator_<executionIdentity with hyphens replaced by underscores>",
message: dispatchPrompt, fork_turns: "none"}`. The emitter validates the identity as
`c<digits>-<8 lowercase hex>` and generates a fresh identity for each emission. There is
no cwd argument; native spawn inherits the parent's shell location.

Run the exact pointer first. The pulled order's emitter-owned `codexBootstrap` version 1
provides the module-derived verified `toolchainRoot`, ordered `contracts` and `instructions`,
and `cwd` emission facts (`processCwd`, `repositoryRoot`, `branch`). Each contract has its
fixed repository-relative `path`, verified `absolutePath`, exact lowercase `sha256`, and
`required: true`. In order, these pin `agents/dev-loop.agent.md`,
`skills/docs/copilot-loop-operations.md` (including Codex runtime setup), and this baseline.
Qualify `shasum` with `command -v shasum`, verify every contract with `shasum -a 256`, then
fully read all three before scoped artifact writes, Git writes or targeted verification.
Stop on missing/unreadable files, unsupported/malformed metadata, a hash mismatch or uncertainty;
never substitute consumer-cwd role/setup files. Then resolve and read `handoff.requiredReads`
in order from `toolchainRoot`; these relative reads do not have individual byte hashes.

Check actual shell cwd, repository and branch independently. The recorded cwd describes
emission only, not an instruction to move the shell. Verify `handoff.cwd` and branch authority,
then use its valid isolated root explicitly as cwd for continuation. Invalid or conflicting
handoff cwd remains a stop; bootstrap facts never authorize creating/acquiring a worktree.
Preserve nextAction, stopRules, allowedFiles, outputRefs and authority. Record genuine native
runtime provenance per [Codex runtime setup](copilot-loop-operations.md#codex-runtime-setup),
without claiming Claude roles/hooks, and follow [Codex active joins](#codex-active-joins).

This additive data is authenticated by the existing materialization hash; semantic fields
participate in the shared canonical digest while absolute paths and `sha256` stay local-only.
The coordinator renderer is unchanged so the inherited checkout can pull the same complete
JSON. Pi/Claude payloads and orders retain their existing bytes. There is no caller-authored
bootstrap override, new CLI option, permission authority or production-support claim.

## Codex active joins

Under Codex, MAIN remains active after dispatch and uses bounded `collaboration.wait_agent` joins
while authorized child work is outstanding. On completion or a blocker, immediately read and consolidate
the child's handback into the next authorized dispatch or the user result. Do not end the parent turn
solely because a child was spawned. Pi's dispatch-and-return posture below remains Pi-only; Claude's
existing completion join is unchanged.

After five minutes without meaningful progress, flag needs-attention and diagnose native structured status and messages
before redispatch. Distinguish a bounded sanctioned wait from unknown progress; silence or an outstanding
child alone proves neither progress nor a stall. Pi-only `detect-agent-stall` files are not evidence of
Codex liveness. Report an immediate blocker with artifact/head, last completed step, exact reason,
preserved work, owner and next action; keep committed work available for the next authorized actor.

Active joining mitigates an upstream idle-parent wake limitation and costs wait time and tokens;
it does not fix the Codex parent wake mechanism. Public source at commit
[`a9b0815167c27ab13719dd12d13b63e02b70d221`](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/agent/control/completion.rs) <!-- secret-scan:allow Verified public upstream commit reference; not a credential -->
queues completion with `trigger_turn: false`; the corresponding
[`session/handlers.rs`](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/session/handlers.rs) <!-- secret-scan:allow Verified public upstream commit reference; not a credential -->
requires `trigger_turn` or durable sleep to schedule pending work. This is source evidence, not proof
of the installed binary. No watchdog, harness patch or durable-sleep experiment is authorized here.

