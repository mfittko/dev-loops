---
name: multica-dispatch
description: Multica-native fan-out/fan-in contract behind `dev-loop` when running inside a Multica workspace. Dedicated canonical agents receive bounded work through durable Multica child issues and stage barriers — not Pi's in-process subagent tool. Outside Multica, the ordinary Pi-subagent dispatch is unchanged. Loaded by the synced canonical agents in a Multica workspace.
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
quality work), it dispatches to the **dedicated canonical agent** for that role —
`review`, `refiner`, `judge`, `fixer`, `developer`, `docs`, `quality` — through a
**durable Multica child issue**, instead of Pi's in-process `subagent` tool.

- **Resolve the target agent from the live roster at dispatch time**:
  `multica agent list --output json` by name. Never hardcode or persist a
  workspace-specific agent ID in any committed source.
- **Create a child issue** under the parent loop's Multica issue:
  `multica issue create --title "..." --parent <parent-issue-id>
  --assignee-id <agent-id> --status todo --description-file <file>`. `todo`
  starts the assigned agent now; `backlog` parks it for later promotion.
- **Do not assume the child shares the parent's worktree or scratchpad.** The
  child runs in its own session, on its own checkout. Everything it needs must
  travel in the child issue; everything the parent needs back must come out of
  the child issue.

## Durable child contract

The child issue description MUST carry, in order:

1. **Dispatch unit** — the one bounded task, phrased as a complete instruction
   (not a pointer to the parent's context). Scope, exit condition, and
   validation expectation.
2. **Reviewed head SHA** — the exact commit SHA the work applies to. The child
   works from this SHA (checkout/`repo checkout --ref`), not from a mutable
   branch tip, so a later push cannot silently move the target.
3. **Required prompt/context** — the files to read (the envelope's
   `requiredReads`), the stop rules, and any constraint the parent's handoff
   envelope imposes. Full paths relative to the repo root, never parent-local
   scratchpad paths.
4. **Result contract** — what the child must deliver and where: post the result
   as a comment on the child issue (the only channel the parent can reliably
   read), state verdict/outcome explicitly, include changed-file paths, commands
   run, and validation output, then set the child issue status (`in_review` when
   the deliverable awaits acceptance, `blocked` when stuck). The child must not
   assume the parent is watching; the durable record is the hand-off.

## Parallel staging and stage barriers

Group children of one fan-out by `--stage N`:

- **Parallel children** (independent reviews, independent refiners) share one
  stage and are created with `--status todo` — they run concurrently.
- **Dependent children** (a fixer that needs a review's findings) go in a later
  stage, created `--status backlog`.
- The server wakes the parent assignee when a whole stage reaches a terminal
  status (`done`/`cancelled`). On wake, inspect `multica issue children
  <parent-id>` per-stage (`status_category` per child), read each finished
  child's result comment, then promote the next stage:
  `multica issue status <child-id> todo`.
- Never sleep-poll child runs; the stage-completion wake is the join point.
  A sibling set with no explicit stages is one implicit stage — the parent is
  woken once when the last child finishes.

## Fan-in

When a stage barrier closes (or the last child of the implicit stage finishes):

1. Read every child's result comment and status via
   `multica issue children` + `multica issue comment list <child-id> --output json`.
2. Reconcile the results into the parent's gate evidence / verdict exactly as
   the Pi fan-in would: same acceptance criteria, same evidence requirements.
3. Only then promote the next stage or continue the parent loop. A child result
   that does not satisfy the result contract is a finding to resolve — re-dispatch
   a bounded fix child or surface the gap in the parent's own report.

## Failure handling

- A child that cannot proceed sets `blocked` on its issue and posts a comment
   explaining the blocker. The parent treats that as a failed lane, not a pass.
- A child that finishes without satisfying the result contract is a finding:
   re-dispatch a bounded fix child against the same reviewed head SHA, or record
   the failure in the parent's gate evidence — never silently pass it.
- On any re-dispatch, reuse the durable child contract (fresh child issue, fresh
  head SHA if the parent advanced, full context) — the child never inherits the
  parent's session state.
- The parent stays `in_progress` while children are outstanding; it moves on only
  when every dispatched lane has reached a terminal status or produced a resolved
  finding.

## Boundary

This skill changes the transport (durable Multica issues instead of in-process
subagents), not the dev-loop policy: bounded tasks, stop rules, acceptance
criteria, and fan-in evidence all remain exactly as the dev-loop skill and the
handoff envelope define them. It never applies outside a Multica workspace.
