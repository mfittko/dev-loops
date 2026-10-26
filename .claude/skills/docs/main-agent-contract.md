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

Before an initial agent-driven Codex conductor spawn, run the config-only selector
`dev-loops-run cli/index.mjs gate resolve-role --conductor --harness codex`
from the target repository. Consume only exit 0; exit 1 reports config errors and
exit 2 reports invalid selectors/runtime output. Neither permits a spawn. Pass the
returned `nativeOverrides` unchanged as native `collaboration.spawn_agent` fields,
alongside the authorized task/message and `fork_turns: "none"`. The child still
runs startup first; this selector never runs startup in MAIN. With no overrides,
omit `model` and `reasoning_effort`. Native rejection stops that dispatch: report
the harness, conductor target, `.devloops` path and requested values, and correct
the configuration before a new authorized attempt; never retry by dropping a
field or inheriting. Native compatibility is established at launch, not by a
shared model catalog. Do not change the root session or global settings.

Opt-in example (synthetic values; use tokens supported by the native harness):

```yaml
models:
  harnesses:
    codex:
      conductor: { model: example-model, reasoningEffort: medium }
```

Fields merge across config layers; omission preserves a field and explicit null
clears it. The selected conductor object is the only source: legacy Claude/Pi
concrete settings cannot supply Codex model or effort. Codex roles, tiers and
angle overrides remain unsupported schema fields. Requested/emitted settings
are distinct from observed runtime telemetry; unavailable telemetry is unknown,
and child self-report is not proof of an effective model.

For resumed direct/queue entries, emit with `--harness codex` and dispatch the printed
`dispatchPayload` unchanged through `collaboration.spawn_agent`. Its exact fields are
`{task_name: "coordinator_<executionIdentity with hyphens replaced by underscores>",
message: dispatchPrompt, fork_turns: "none"}`, plus non-null native `model` and
`reasoning_effort` overrides from the same config resolver. Resolution errors stop
before materialization; native rejection has the same no-fallback rule. These
optional fields stay outside the semantic work order and its digest. The emitter validates the identity as
`c<digits>-<8 lowercase hex>` and generates a fresh identity for each emission. There is
no cwd argument; native spawn inherits the parent's shell location.

Run the exact pointer first. The pulled order's emitter-owned `codexBootstrap` version 1
provides the module-derived verified `toolchainRoot`, ordered `contracts` and `instructions`,
and `cwd` emission facts (`processCwd`, `repositoryRoot`, `branch`). Each contract has its
fixed repository-relative `path`, verified `absolutePath`, authoritative lowercase SHA-256 `digest`, and
`required: true`. In order, these pin `agents/dev-loop.agent.md`,
`skills/docs/copilot-loop-operations.md` (including Codex runtime setup), and this baseline.
Qualify `shasum` with `command -v shasum`, verify every contract against its `digest` with `shasum -a 256`, then
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

This additive data is authenticated by the existing materialization hash; each contract's
`digest` participates in the shared canonical digest while absolute paths stay local-only.
Contract-byte changes therefore produce a new ref and preserve prior materializations.
Verify bytes only against `digest`; the shared serializer excludes any `sha256` field, which
must never substitute for this semantic pin.
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

## Unit coordinator boundaries (issue 2532)

The orchestrator dispatches one **fresh unit coordinator per phase**, never one coordinator for the
whole cycle. The boundary list is tooling-emitted: the handoff envelope carries `unitBoundaries`
(`handBackAfter` + `resume`, derived from the target and route; see
[Workflow Handoff Contract](workflow-handoff-contract.md#envelope-schema)). The unit hands back at
the **first** boundary that field names: `handBackAfter` is an ordered, first-match list, so a unit
carrying both stops when it opens its draft PR and leaves the verdict boundary to its successor.

On hand-back the orchestrator dispatches the successor by emitting the work order with
`scripts/loop/emit-coordinator-work-order.mjs --input <startup-output path> --harness <claude|pi|codex> --entry <queue|direct>`
and dispatching the printed `dispatchPayload` unchanged. The input is the startup-output path a
coordinator named in its hand-back; the orchestrator still
never runs `loop startup` itself. The successor re-resolves `unitBoundaries.resume`, so its envelope
is resolver output for the current target — **the previous coordinator never writes or summarizes the
next brief**, and no successor field derives from predecessor conversation. Gate state survives
through authoritative state, not through the relay: the successor recovers round count, verdict
evidence and open findings by re-running the detectors at resume.

A child hand-back is a **compact relay packet** only: unit identity, status, `nextAction`, evidence
links (including the startup-output path that unit ran), and an open question if one is needed. On Claude Code the packet also carries the consumed relayed message under `COORDINATOR-HANDBACK-ONE-REPORT`. On Pi a hand-back sent with a child in flight also carries the child list under `GATE-EXEC-HARNESS-JOIN` in [Gate review sub-loop contract](./gate-review-sub-loop-contract.md). No
transcript, tool output or review text. A relay is the dispatch trigger, never the successor's
context.

Budget per unit coordinator: peak context at or below the existing **150K-token cap** (largest
single-response input count, not cumulative traffic); on a Codex root at most 10% empty wakeups,
measured against root turns rather than wait duration. A missing or ambiguous native measurement is
reported as unavailable, never zero. The rule binds the unit coordinator on every harness, so it
stays outside the sections harness-specific mirrors drop.

<!-- rule: COORDINATOR-HANDBACK-ONE-REPORT -->
`COORDINATOR-HANDBACK-ONE-REPORT`: Claude Code only. A pause is a turn end while the dev-loop coordinator's run is not finished, for example while a child it dispatched runs.

- A pause ends the turn with plain text and never calls `SubagentHandback`. The harness "report has not been delivered" prompt after a pause is answered in plain text too.
- An answer to a question typed into the dev-loop coordinator's thread, and a duplicate child wake, are pauses when a child is in flight and the run state did not change (no dispatch, push, gate result or new stop). With no child in flight, the dev-loop coordinator answers and continues its runnable next step in the same turn.
- The one `SubagentHandback` call of a run carries its final report: the hand-back at the first `unitBoundaries.handBackAfter` boundary, `final_approval_ready`, a stop that needs a caller decision, or the route's own terminal completion (for example a headless standalone `review` that has posted its review).
- The dev-loop coordinator never calls `SubagentHandback` while a child is in flight. Every report with a child in flight is a plain-text pause.
- A turn end with no child in flight is never a pause. The dev-loop coordinator never ends silently while its next step is runnable.
- After a refused `SubagentHandback`, the dev-loop coordinator makes no further call in that run and ends the turn with the full report as plain text.
- Every hand-back names the last relayed message it consumed, by first line and arrival time, or states that it consumed none.

<!-- rule: MAIN-AGENT-COORDINATOR-REPORT-READ -->
`MAIN-AGENT-COORDINATOR-REPORT-READ`: Claude Code only. When a coordinator notification says the result is "not repeated here", or the coordinator went idle without a delivered report, the orchestrator reads the last assistant message of the coordinator's output file before it resumes or re-asks it.

- The orchestrator sends all decisions for one block in one message.
- The orchestrator reads the latest hand-back before it re-instructs.
- On the next notification of a reporter that named children in flight, read its output file before acting.

