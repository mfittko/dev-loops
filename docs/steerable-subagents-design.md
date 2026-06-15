# Steerable async subagents (two-tier operation-class model)

**Status:** draft proposal — not yet implemented.

This document proposes an opt-in mechanism that lets a non-UI async subagent
receive mid-flight steering messages without being interrupted and restarted.
The mechanism is deliberately two-tiered: some operation classes are steerable,
others remain atomic.

Related but distinct: the existing [`docs/steering-contract.md`](./steering-contract.md)
applies to the Copilot PR outer-loop runner; this proposal applies to the
subagent dispatch/transport/runtime layer.

---

## Problem statement

Today, a non-UI async Pi subagent rejects intercom messages while it is busy.
The runtime surface that drops those messages is in `pi-intercom`:

```ts
// ~/.pi/agent/npm/packages/pi-intercom/index.ts
// Lines 669–685 (verify against your local pi-intercom checkout; line numbers drift over time).
if (!activeContext.isIdle()) {
  if (!activeContext.hasUI) {
    // auto-reply that the session is non-interactive, then drop the message.
    return;
  }
  queueIdleMessage(entry);
  return;
}
```

When a user wants to redirect or tighten scope while the subagent is running,
the only available path is:

1. stop the running subagent (interrupt),
2. wait for any lock/branch takeover to recover,
3. start a new dispatch with the new scope,
4. rebuild gate evidence (CI, checks, review context).

Two recent incidents in this repo illustrate the cost:

- **PR #777 lock-takeover incident.** A stale async lock from a non-released run
  took ~10 minutes and a second dispatch to recover. An interrupt+restart cycle
  would have recreated that recovery cost.
- **PR #779 npm-script revision.** Scope expanded mid-flight: the user wanted
  `npm run repo-wiki:*` scripts instead of `node scripts/repo-wiki.mjs ...`.
  The non-steerable path forced an interrupt + restart cycle, losing the
  in-progress gate evidence chain.

For safe operation classes this is unnecessary waste. The transport already
knows how to queue messages (`pendingIdleMessages` and `flushIdleMessages` in
`pi-intercom`, lines 431–635), but it currently drains them only to UI-bearing
sessions.

---

## Goals

- Enable cheap mid-task steering for operation classes where it is safe.
- Reuse the existing `pendingIdleMessages` queue infrastructure instead of
  inventing a parallel transport.
- Preserve atomic semantics for operations that must not be redirected while
  in flight.

## Non-goals

- **Blanket steering** for every kind of subagent work.
- Steering during merges, pushes, lock acquisition, gate-comment posts, or any
  other state-mutating coordination step that must be atomic.
- Replacing the existing interrupt + restart path; it stays as the fallback when
  steering is disabled, unsupported, or declined.
- Implementing full rollback semantics for an aborted checkpoint (flagged for
  follow-up work, not covered here).

---

## Two-tier operation-class matrix

| Operation class | Example work | Steering allowed? | Why |
|---|---|---|---|
| `read` | Research, read-only analysis, code review on an existing PR | **Steerable** | No durable repo state is changed. |
| `pre_flight` | Lint, type-check, unit-test runs (`npm run verify` slices) | **Steerable** | Validation results are ephemeral; can be re-run. |
| `edit` | Planned file edits on a feature branch before commit/push | **Steerable** | Edits are local to the branch and can be revised. |
| `atomic_post` | Posting a gate verdict or checkpoint comment to GitHub | **Atomic** | Mutates durable audit state. Must not be redirected mid-post. |
| `atomic_lock` | Acquiring or releasing a runner/coordination lock | **Atomic** | Lock state must be consistent; an in-flight change is dangerous. |
| `atomic_merge` | Merge, push, force-push, history rewrite | **Atomic** | Mutates shared remote history. Must run to completion or not at all. |

The default for any unclassified operation is **atomic**.

---

## Proposed API (illustrative, not committed syntax)

The shape below is a conversation starter for `pi-subagents` and `pi-intercom`.

### Dispatch-time flags

```ts
subagent({
  // existing fields ...
  steerable: boolean;            // default false (opt-in)
  operationClass: "read" | "pre_flight" | "edit" | "atomic_post" | "atomic_lock" | "atomic_merge";
});
```

- `steerable: true` tells the runtime that the agent is willing to receive
  steering messages at safe interrupt points.
- `operationClass` classifies the work so the runtime can enforce the matrix
  above even when a caller requests `steerable: true`.

### Runtime checkpoint hooks

The subagent runtime would call lifecycle hooks at safe boundaries:

```ts
interface SteerableRuntime {
  preCheckpoint(op: OperationClass): Promise<SteeringMessage[]>;
  postCheckpoint(op: OperationClass): Promise<void>;
}
```

- `preCheckpoint` is invoked when the agent reaches a natural pause.
  It returns any queued steering messages so the agent can incorporate them
  before the next unit of work.
- `postCheckpoint` is invoked after the work unit commits side effects that are
  safe to expose to the operator.

For atomic operation classes the runtime never calls these hooks; it behaves
exactly like today’s non-UI async subagent.

---

## Transport changes in `pi-intercom`

When a session is **both** `steerable: true` **and** non-UI, `handleIncomingMessage`
should no longer auto-reply and drop incoming messages. Instead it should call
`queueIdleMessage(entry)` so the message is held until `flushIdleMessages` finds
an idle, post-checkpoint moment.

Current behavior (lines 669–685, `~/.pi/agent/npm/packages/pi-intercom/index.ts`):

```ts
if (!activeContext.isIdle()) {
  if (!activeContext.hasUI) {
    // auto-reply + drop
    return;
  }
  queueIdleMessage(entry);
  return;
}
```

Desired behavior sketch:

```ts
if (!activeContext.isIdle()) {
  if (activeContext.hasUI || activeContext.isSteerable()) {
    queueIdleMessage(entry);
    return;
  }
  // legacy non-steerable non-UI path: auto-reply + drop
  return;
}
```

Queue delivery infrastructure already exists:

- `pendingIdleMessages: InboundMessageEntry[]` — line 431
- `queueIdleMessage(entry)` — lines 635–638
- `flushIdleMessages(generation)` — lines 617–633

The only new responsibility is to expose the session’s steerability through the
`activeContext` so the transport can branch on it.

---

## Operation-class gating in `dev-loops`

If `pi-subagents` / `pi-intercom` add the runtime hooks, `dev-loops` would map
its routed gates to operation classes.

| Route / phase | Operation class | Notes |
|---|---|---|
| `final_approval` gate | `atomic_post` | Always: vote/verdict posts are audit mutations. |
| `local_implementation` editor-only slice | `edit` | Before commit/push; edits local to feature branch. |
| `local_implementation` tests-only slice | `pre_flight` | Re-running tests is cheap and safe. |
| `copilot_pr_followup` round iteration | `edit` | Per-Copilot-review round, before the next gate post. |

This mapping belongs in the route-specific dispatch code that calls `subagent()`,
so upstream does not need to know about `dev-loops` gates.

---

## Edge cases and open questions

### Message arrives between checkpoints

Queue it. `flushIdleMessages` already retries on `INBOUND_IDLE_RETRY_MS` until the session becomes idle.

### Message conflicts with an in-flight mutation

If the current operation class is atomic, do not deliver the message until the
atomic operation completes and the next steerable operation class begins.
If the message arrives during a steerable `edit` that already changed files,
surface the conflict to the user: the agent can revise subsequent edits, but
what is already committed locally stays committed unless the user chooses to
revert it.

### Rollback on checkpoint abort

Intentionally out of scope for this proposal. A follow-up design should decide
whether `preCheckpoint` can abort and what rollback contract the runtime
provides.

### Other open questions

1. **Who owns the dispatch-side flag?** Should `pi-subagents` declare the
   `steerable` / `operationClass` API, or should `dev-loops` wrap the call and
   re-export a narrower, opinionated surface?
2. **Implicit vs. declared checkpoints.** Should the runtime insert checkpoints
   automatically around operation-class transitions, or should the subagent code
   explicitly call `preCheckpoint` / `postCheckpoint`?
3. **Interactive flag overlap.** `pi-subagents` already has an `interactive`
   boolean in `AgentConfig` (`src/agents/agents.ts:99`, serialized in
   `src/agents/agent-serializer.ts:22,71`). Does `steerable` subsume, extend, or
   sit beside that flag?

---

## Migration

- Opt-in via `steerable: true`.
- Default behavior of `subagent()` is unchanged.
- Existing dispatchers in `dev-loops` and other consumers keep atomic
  behavior unless they explicitly classify their work as steerable.

---

## References

- PR #777 — lock-takeover incident (motivation).
- PR #779 — npm-script revision scope change (motivation).
- `pi-intercom` source: `~/.pi/agent/npm/packages/pi-intercom/index.ts`
  - Rejection/drop block for non-UI busy sessions: lines 669–685.
  - `pendingIdleMessages` declaration: line 431.
  - `flushIdleMessages`: lines 617–633.
  - `queueIdleMessage`: lines 635–638.
- `pi-subagents` source: `~/.pi/agent/npm/node_modules/pi-subagents/`
  - Existing `interactive` field in `AgentConfig`: `src/agents/agents.ts:99`.
  - Existing `interactive` frontmatter serialization: `src/agents/agent-serializer.ts:22,71`.
  - The source tree currently has **no** `steerable`, `checkpoint`, or hook
    runtime implementation.
- Related local contract: [`docs/steering-contract.md`](./steering-contract.md).
