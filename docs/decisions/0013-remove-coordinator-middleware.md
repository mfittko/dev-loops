# 0013. Remove the coordinator agent as superfluous middleware; main session and conductor delegate directly

## Status

Accepted

## Context

The original proposal-first safety contract ([PR 22](https://github.com/mfittko/dev-loops/pull/22)) put a coordinator agent in front of all mutations and delegation: coordinator-owned new-idea intake, coordinator-gated mutation, and coordinator-brokered routing to worker agents. In practice the layer was pure pass-through middleware — [the intake procedure](../../skills/docs/issue-intake-procedure.md) already classified work, human operators already gated mutations, and every delegation route just hopped through an extra agent session for no gain. Worse, the middleman was untrusted: despite an explicit "do not self-implement" instruction, the coordinator self-implemented 605 lines across 5 files in run `65fefab0` instead of delegating ([issue 480](https://github.com/mfittko/dev-loops/issues/480), removed by [PR 481](https://github.com/mfittko/dev-loops/pull/481)). A sibling assumption fell at the same time: conductor tooling had been built as if a persistent subagent could drive orchestration end-to-end, but subagents have depth limits and cannot block on persistent watch, so the auto-resume language was replaced with main-session re-dispatch ([issue 514](https://github.com/mfittko/dev-loops/issues/514), [PR 515](https://github.com/mfittko/dev-loops/pull/515)).

## Decision

We delete the coordinator agent entirely — a reversal of the established agent taxonomy, not a repair of it. The intake procedure owns classification, human operators gate mutations, refiner RFC escalation targets the parent session or operator rather than a named agent, and the main session plus conductor delegate directly to `developer`/`quality`/`docs` worker agents, with task breakdown and delegation guidance living in the `local-implementation` skill. We also remove the subagent auto-resume assumptions from the contract docs: the main session is the loop driver and subagents are bounded tasks that exit on external wait. We rejected keeping the coordinator and fixing its self-implementation bug — the layer added an agent session for no gain even when behaving — and we rejected building the never-shipped conductor auto-dispatch layer, which cannot work under the subagent execution model. A negative contract test asserts `coordinator.agent.md` does not exist.

## Consequences

The agent hierarchy is flat: all delegation contracts (handoff envelope, one-runner-per-PR, subagent write guards) route main-session-to-worker with no broker layer, which removes one untrusted agent session from every mutation path. Delegation is now a procedural concern encoded in skills rather than a role, so changes to task breakdown land as doc and contract-test edits instead of agent-prompt surgery. The main session carries more responsibility — it drives re-dispatch itself rather than trusting a persistent orchestrator — which the conductor probe-and-dispatch pattern absorbs. Older docs that reference a coordinator are historical, not aspirational, and the negative test keeps the role from quietly returning.
