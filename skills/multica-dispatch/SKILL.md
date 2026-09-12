---
name: multica-dispatch
description: Multica-native dispatch contract behind `dev-loop` when running inside a Multica workspace. Non-gate work may go to dedicated canonical agents through a root dispatch comment on the existing parent issue. A top-level Multica `dev-loop` remains the gate coordinator and runs the complete gate round with harness-native subagents. Outside Multica, ordinary harness dispatch is unchanged. Loaded by the synced canonical agents in a Multica workspace.
---

# Multica Dispatch

dev-loops fan-out/fan-in, Multica-native form. Applies **only when running inside
a Multica workspace** (agent run with daemon-injected
`MULTICA_SERVER_URL` / `MULTICA_TOKEN` / `MULTICA_WORKSPACE_ID`). In every other
environment — standalone Pi, Claude Code, CI — fan-out uses the ordinary Pi
`subagent` tool exactly as the dev-loop skill specifies, unchanged.

## Dispatch rule

Except for gate-round work (defined below), when this agent must dispatch
bounded work inside Multica, it uses the **dedicated canonical agent** for the
role through a **root dispatch comment on the existing parent issue**.

- **One child issue per reviewer/dispatch unit is overkill and is NOT the
  default.** The parent issue is the fan-out surface: no new issues are created
  merely because fan-out exists. Gate/reviewer fan-out **never** creates
  sub-issues — including when multiple review groups target the same agent.
  A multi-group draft gate therefore emits **zero** `multica issue create`
  operations and zero durable parent-issue dispatches; it stays inside the
  top-level coordinator run.
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
  2. **Reviewed head SHA** — the exact commit SHA the work applies to,
     passed together with the repository and PR number. The head must be
     committed and independently addressable (pushed) before dispatch. The
     worker works from this SHA (checkout/`repo checkout --ref`), not from a
     mutable branch tip, so a later push cannot silently move the target.
  3. **Required prompt/context** — the files to read (the envelope's
     `requiredReads`), the stop rules, and any constraint the parent's handoff
     envelope imposes. Full paths relative to the repo root, never parent-local
     scratchpad paths.
  4. **Expected result shape** — what the worker must deliver and where: a
     reply in the same thread stating verdict/outcome explicitly, with
     changed-file paths, commands run, and validation output.
- **Dispatch context is durable and self-contained.** Everything the worker
  needs must travel in the dispatch comment (or, on the human-requested
  child-issue exception, the child issue description) or an issue attachment —
  a complete instruction, not a pointer into the coordinator's session. Never place a
  coordinator/task absolute worktree path in a dispatch briefing:
  independent Multica runs cannot consume paths inside another task's
  disposable worktree. Before dispatch, ensure the reviewed head is committed
  and independently addressable, and pass repository, PR, and the exact head
  SHA — never a mutable branch tip. Each worker checks out its own
  Multica-managed checkout/worktree at that immutable head (`multica repo
  checkout <url> --ref <sha>`). Recreate deterministic gate-context inputs in
  the worker when cheap; attach only data that cannot be reconstructed.
- **Results return through durable issue surfaces.** Workers reply with
  findings through the issue thread (or issue attachments) — they must never
  write required outputs into the coordinator's `tmp/` tree, which does not
  exist for the worker and dies with the coordinator's worktree. Fan-in
  consumes those durable thread/attachment results after the coordinator is
  re-triggered.
- **Do not assume the worker shares the parent's worktree or scratchpad.**
  Each worker runs in its own session, on its own checkout. The dispatch
  comment is the only shared surface; the thread reply is the only return
  channel.

## Gate rounds stay inside the top-level run

A top-level Multica `dev-loop` run is already the gate coordinator. It executes
the complete gate round itself with Pi- or Claude-native subagents:

1. prepare Phase 1 context/spec evidence, then run the Phase 1.5 primer;
2. consume the contract-emitted grouped dispatch units, without reimplementing
   grouping, and run them in bounded waves using `gates.fanout.maxConcurrent`
   (default `3`);
3. join the findings through the sanctioned fan-in;
4. run the independent, read-only judge as a harness-native child; and
5. run any required fixer and re-gate cycle before closing the gate.

Each reviewer child receives exactly one emitted unit, starts in fresh context,
and cannot delegate further. Judge and fixer children are likewise internal to
the coordinator run. No gate review group, judge, or fixer phase creates a
Multica issue, dispatch comment, mention, durable assignments, or separate
Multica run. Do not specify a model in harness-native child calls: they inherit
the top-level Multica agent's runtime/model configuration, which Multica owns.
This rule is provider-independent and applies to Pi and Claude hosts alike.

After a clean draft gate, preserve the canonical lifecycle: mark the PR ready,
complete the configured Copilot review/fix rounds, then run the pre-approval
gate and stop for human approval. Never jump from draft gate directly to
pre-approval.

## No recursive dev-loop dispatch (provider-independent)

A top-level Multica `dev-loop` run is **already the coordinator**. It MUST NOT
spawn or delegate to another native `dev-loop` child — not via Pi's in-process
`subagent` tool, not via the Claude harness's equivalent child-agent mechanism.
This rule is **provider-independent**: it binds whichever harness (Pi or
Claude Code) is hosting the Multica `dev-loop` agent.

When the startup resolver selects a strategy, execute gate-round work in this
same coordinator run as specified above. Non-gate work may route directly to a
dedicated Multica agent through the durable dispatch described above. Do NOT
add an intermediate nested `dev-loop` child: it would re-resolve routing and
duplicate the coordinator.

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
  point. This is also why the worker must never depend on the coordinator's
  worktree surviving: the coordinator's worktree may be deleted right after
  dispatch, and the worker must still be able to validate its context (repo,
  PR, head SHA, self-contained prompt) and return a result through the thread.
  A dispatch contract on the parent issue is deliberately anonymous with
  respect to concurrent runs: nothing in it may assume a particular worker
  run instance, so serialization or a fresh mention run of the same agent
  satisfies it equally.

## Child-issue exception (human-requested only)

Creating a child issue is allowed **only when a human explicitly requests
work decomposition.** It is not a fallback for freshness, concurrency, stages,
waves, or reviewer groups — ordinary durable dispatch or the coordinator-owned
gate fan-out covers those. When a human does request decomposition, the child issue description
carries the full dispatch contract (dispatch unit, reviewed head SHA,
repository and PR, required prompt/context, result contract — post the result
as a comment on the child issue, then set its status), and the parent performs
fan-in by reading each finished child's result. The child-issue path carries
the same durable-context rules as the mention-dispatch path: no coordinator
worktree paths in the briefing, immutable committed head, self-contained
context (description or attachment), results back through the child issue's
thread/attachments.

## Failure handling

- A worker that cannot proceed replies in-thread stating the blocker (and, on
  the child-issue exception, sets `blocked` on its issue). The coordinator
  treats that as a failed lane, not a pass.
- A worker that finishes without satisfying the expected result shape is a
  finding: re-dispatch a bounded fix request in the same thread (or a fresh
  child issue under the human-requested exception) against the same reviewed
  head SHA, or record the failure in the coordinator's gate evidence — never
  silently pass it.
- On any re-dispatch, reuse the durable dispatch contract (fresh comment or
  fresh child issue when a human requested decomposition, fresh head SHA if the
  parent advanced, full context) — the worker never inherits the coordinator's
  session state.

## Boundary

For non-gate work, this skill changes the transport to durable Multica issue
threads and mentions. For gate rounds, it preserves harness-native subagents
inside the top-level run. It does not change dev-loop policy: bounded tasks,
stop rules, acceptance criteria, and fan-in evidence remain exactly as the
dev-loop skill and handoff envelope define them. It never applies outside a
Multica workspace.
