# 0112. The gate-coordinator agent joins the agent taxonomy

## Status

Accepted — 2026-09-28 ([issue 2531](https://github.com/mfittko/dev-loops/issues/2531))

Amends [0013](0013-remove-coordinator-middleware.md): it admits one bounded `gate-coordinator` agent between the dev-loop coordinator and the round's `review` and `judge` agents. The rest of ADR 0013 stands.

## Context

ADR 0013 removed the coordinator agent and made the agent hierarchy flat. ADR 0081 later introduced the gate-round capsule, and `GATE-EXEC-GATE-COORDINATOR` requires one fresh gate coordinator per round. The contract named no agent type for that capsule, and its enforcement was documentation only.

Coordinators therefore ran rounds inline or dispatched the gate coordinator as `dev-loop` or `general-purpose`. On PR 2520, seven draft_gate rounds ran inline and the unit coordinator grew from 270K to 587K tokens. On PR 2533, 23 of 30 reviewer and judge prompts carried relay prose instead of the emitted `dispatchPrompt`. Gate coordinators dispatched as `dev-loop` also inherited the dev-loop agent's 1-hour prompt-cache TTL.

## Decision

A dedicated agent definition `agents/gate-coordinator.agent.md` (name `gate-coordinator`) owns exactly one gate round and exits. It dispatches only the round's `review` and `judge` agents, relays each emitted `dispatchPrompt` verbatim, and returns only the typed round result that `GATE-EXEC-GATE-COORDINATOR` lists. It makes no tracked-file edit, verdict comment, ready flip, push, merge or fixer dispatch. It keeps the default prompt-cache TTL.

A Claude Code PreToolUse hook on `Agent|Task` enforces the capsule through the pure decider `decideAgentDispatch`:

- A `dev-loop` caller that dispatches `review` or `judge` is denied with `GATE_COORDINATOR_REQUIRED`.
- A `gate-coordinator` caller that dispatches `review` or `judge` is allowed only when the prompt is exactly the `buildDispatchPointer` text for a ref of the same role. Any other prompt is denied with `GATE_DISPATCH_NOT_VERBATIM`.
- A `gate-coordinator` caller that dispatches any other agent is denied with `GATE_COORDINATOR_DISPATCH_SCOPE`.
- Every other caller, including the main session, is allowed.

The `gate-coordinator` agent also holds the `dev-loop` coordinator's write and verify boundaries. `GATE-EXEC-GATE-COORDINATOR` moves from `doc` to `runtime` enforcement.

The capsule needs its own `agent_type` because the hook payload carries no other caller identity. The hook sees the caller's `agent_type` and the dispatch's `tool_input` only. A gate coordinator dispatched as `dev-loop` is indistinguishable from the unit coordinator, so the guard could not allow the one while it denies the other.

## Consequences

The unit coordinator can no longer run a gate round inline on Claude Code, and reviewer and judge prompts can no longer drift from the emitted work orders. Unlike the coordinator that ADR 0013 removed, this agent is no pass-through broker: it holds a whole round and its bulk reviewer output out of the unit coordinator's context.

A reviewer unit that wrote its sentinel but no artifact cannot be retried with an appended `--same-head-retry` prose. The round recovers by retirement and a fresh round until an emitter retry mode exists.

Pi has no mechanical guard, because the Pi `tool_call` event carries no agent identity. On Pi the agent definition and the contract apply without the hook.

Rejected alternatives:

- Dispatching the gate coordinator as `dev-loop` with a marker in its prompt. The hook cannot see the dispatching prompt of its own caller.
- Dispatching it as `general-purpose`. The guard cannot scope an unnamed agent type without also scoping every other `general-purpose` dispatch.
