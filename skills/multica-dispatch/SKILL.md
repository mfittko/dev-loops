---
name: multica-dispatch
description: Multica-native fan-out/fan-in contract behind `dev-loop` when running inside a Multica workspace. Dedicated canonical agents receive bounded work through a root dispatch comment on the existing parent issue (mention-dispatch, replies in-thread) — not Pi's in-process subagent tool. Outside Multica, the ordinary Pi-subagent dispatch is unchanged. Loaded by the synced canonical agents in a Multica workspace.
---

# Multica Dispatch

dev-loops fan-out/fan-in, Multica-native form. Applies **only when running inside
a Multica workspace** (agent run with daemon-injected
`MULTICA_SERVER_URL` / `MULTICA_TOKEN` / `MULTICA_WORKSPACE_ID`). In every other
environment — standalone Pi, Claude Code, CI — fan-out uses the ordinary Pi
`subagent` tool exactly as the dev-loop skill specifies, unchanged.

## Dispatch rule

When this agent, running as the loop orchestrator inside Multica, must fan out
bounded loop work (a review, a refiner pass, a judge verdict, a fix, docs or
quality work), it dispatches to the **dedicated canonical agents** for those
roles — `review`, `refiner`, `judge`, `fixer`, `developer`, `docs`, `quality` —
through a **root dispatch comment on the existing parent issue**, instead of
Pi's in-process `subagent` tool.

- **One child issue per reviewer/dispatch unit is overkill and is NOT the
  default.** The parent issue is the fan-out surface: no new issues are created
  merely because fan-out exists.
- **Resolve each target agent from the live roster at dispatch time**:
  `multica agent list --output json` by name. Never hardcode or persist a
  workspace-specific agent ID in any committed source. Mention-link each agent
  in the dispatch comment (`[@name](mention://agent/<agent-id>)`) — the mention
  is what enqueues the run.
- **Post one root dispatch comment** on the parent issue containing explicit
  mention-links for the distinct dedicated agents the round needs. For each
  mentioned agent, the comment must carry, in order:
  1. **Dispatch unit** — the one bounded task, phrased as a complete
     instruction (not a pointer to the parent's context). Scope, exit condition,
     and validation expectation.
  2. **Reviewed head SHA** — the exact commit SHA the work applies to. The
     worker works from this SHA (checkout/`repo checkout --ref`), not from a
     mutable branch tip, so a later push cannot silently move the target.
  3. **Required prompt/context** — the files to read (the envelope's
     `requiredReads`), the stop rules, and any constraint the parent's handoff
     envelope imposes. Full paths relative to the repo root, never parent-local
     scratchpad paths.
  4. **Expected result shape** — what the worker must deliver and where: a
     reply in the same thread stating verdict/outcome explicitly, with
     changed-file paths, commands run, and validation output.
- **Do not assume the worker shares the parent's worktree or scratchpad.**
  Each worker runs in its own session, on its own checkout. Everything it needs
  must travel in the dispatch comment; everything the parent needs back must
  come out of the worker's thread reply.
- **Parallelism comes from distinct dedicated agents.** If several angles
  belong to the same agent, group them into that agent's single dispatch run or
  accept serialization — never create extra dispatch surface for one agent's
  angles.

## No recursive dev-loop dispatch (provider-independent)

A top-level Multica `dev-loop` run is **already the coordinator**. It MUST NOT
spawn or delegate to another native `dev-loop` child — not via Pi's in-process
`subagent` tool, not via the Claude harness's equivalent child-agent mechanism.
This rule is **provider-independent**: it binds whichever harness (Pi or
Claude Code) is hosting the Multica `dev-loop` agent.

When the startup resolver selects a strategy, route the resolved strategy's
work **directly to the corresponding dedicated Multica agent** (`developer`,
`review`, `refiner`, `judge`, `fixer`, … as applicable) through the durable
Multica dispatch described above. Do NOT add an intermediate nested `dev-loop`
child: the nested entrypoint would re-resolve routing, re-derive an envelope,
and fan out through its own harness dispatch — a recursion the platform's issue
assignment already performs once, and the source of the observed double-loop
behavior.

Native Pi/Claude `dev-loop` child delegation remains ONLY the non-Multica
fallback: outside a Multica workspace (no daemon-injected
`MULTICA_SERVER_URL` / `MULTICA_TOKEN` / `MULTICA_WORKSPACE_ID`), the ordinary
harness dispatch applies exactly as the dev-loop skill specifies.

## Worker reply and receipts

- Each dispatched worker replies **in the same thread** with its result: the
  verdict/outcome stated explicitly, changed-file paths, commands run, and
  validation output. The thread reply is the durable result record.
- The coordinator tracks the **expected receipts** — one per mentioned agent —
  and performs fan-in on the thread. A worker result that does not satisfy the
  expected result shape is a finding to resolve: re-dispatch a bounded fix
  request in the same thread, or surface the gap in the parent's own report.
- Never sleep-poll worker runs. The coordinator reconciles receipts when it is
  next woken or re-derives them from the thread state (`multica issue comment
  list <parent-id> --thread <root> ...`) — the durable record is the join
  point.

## Child-issue fallback (explicit only)

Create a child issue **only** as an explicit fallback when:

- the same agent truly needs multiple concurrent isolated runs (a single
  mention-dispatch cannot carry them), or
- a dispatch unit needs its own durable lifecycle/status (its own
  `in_review`/`blocked` state on the board, its own acceptance barrier).

Never create a child issue merely because fan-out exists. When the fallback is
warranted, the child issue description must carry the full dispatch contract
(dispatch unit, reviewed head SHA, required prompt/context, result contract —
post the result as a comment on the child issue, then set its status), and the
parent performs fan-in by reading each finished child's result.

## Failure handling

- A worker that cannot proceed replies in-thread stating the blocker (and, on
  the child-issue fallback, sets `blocked` on its issue). The coordinator
  treats that as a failed lane, not a pass.
- A worker that finishes without satisfying the expected result shape is a
  finding: re-dispatch a bounded fix request in the same thread (or a fresh
  child issue under the fallback rules) against the same reviewed head SHA, or
  record the failure in the coordinator's gate evidence — never silently pass
  it.
- On any re-dispatch, reuse the durable dispatch contract (fresh comment or
  fresh child issue, fresh head SHA if the parent advanced, full context) — the
  worker never inherits the coordinator's session state.

## Boundary

This skill changes the transport (durable Multica issue threads and mentions
instead of in-process subagents), not the dev-loop policy: bounded tasks, stop
rules, acceptance criteria, and fan-in evidence all remain exactly as the
dev-loop skill and the handoff envelope define them. It never applies outside a
Multica workspace.
