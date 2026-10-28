# 0206. One harness-neutral Bash-gate deny decision, called by Claude Code and Pi

## Status

Accepted — 2026-10-28 ([issue 2965](https://github.com/mfittko/dev-loops/issues/2965))

## Context

The Claude Code PreToolUse Bash gate denied raw `gh pr merge` under `autonomy.humanMergeOnly`, raw waiver body writes, inline interpreters and the actor-independent guard rules. The Pi `tool_call` handler gated only the read-only roles (`judge`, `review`) and returned `{ block: false }` for every other role, including the untagged main agent. [stop-conditions.md](../../skills/docs/stop-conditions.md) scopes `STOP-HUMAN-MERGE-001` to all harnesses and no contract row said "Claude-only", so the gap was fail-open on Pi for a merge-bypass and a waiver-bypass path, and a [cross-harness regression contract](../../skills/docs/cross-harness-regression-contract.md) violation. Issues 2631 and 2701 had both put Pi parity out of scope, so the gap had no home (audit finding F38).

Adding a recorded change to the cross-harness contract trips the ADR tripwire, and two harnesses holding two copies of one deny rule is what created the gap.

## Decision

- The harness-neutral deny decision lives in one module, `packages/core/src/loop/bash-gate-decisions.mjs` (`decideBashGateDeny`). Both adapters call it: the Claude PreToolUse hook through `packages/core/src/claude/hook-decisions.mjs`, and the Pi `tool_call` handler through `extension/readonly-role-gate.ts`. The rule bodies moved into it verbatim — same order, same reason texts — rather than being reimplemented per harness.
- The module is pure: each adapter injects its own facts (repo identity, `humanMergeOnly`, the coordinator opt-in flag, the `gh pr ready` draft-gate probe, the role). The Claude adapter gathers them in `.claude/hooks/pre-tool-use-bash-gate.mjs`; the Pi adapter in `extension/bash-gate-facts.ts`, which revalidates its per-cwd cache against a `stat` signature of the repo's own `.devloops` and `.pi/dev-loop/defaults` variants on every call, so an edit to one of those files is never served stale. The packaged extension-defaults layer the loader always merges and the git remote the slug derives from are outside that signature, and an unresolved (non-repo) cwd is re-probed rather than cached.
- `BASH_GATE_RULES` is the pinned verdict list: every deny rule carries its Pi verdict, and `test/contracts/bash-gate-pi-parity.test.mjs` asserts the contract matrix in [cross-harness-regression-contract.md](../../skills/docs/cross-harness-regression-contract.md) lists exactly those rule IDs in that order with those verdicts, and that every listed ID is still a registered rule. A new deny rule cannot be added without stating its Pi verdict, and a listed rule cannot be dropped silently.
- The judge command restriction and the fixer sanctioned-pull-line / grant-binding boundary stay at the Claude edge: the grant binding is keyed on the Claude hook's `agent_id`, which the Pi `tool_call` payload does not carry. The Pi judge stays bounded by the existing read-only role gate (#2509).
- No new deny rules, and no Codex enforcement — that remains tracked by #1927. `skills/docs/required-rules.json` is unchanged.

Rejected: keeping a second Pi-side copy of the rules (drifts silently, and the drift is a fail-open); gating only the roles Pi already restricted (leaves the main agent's merge path open); moving the judge and fixer role machinery into the shared module (imports Claude-only identity into every harness).

## Consequences

The merge-bypass and waiver-bypass paths are gated on Pi for every role, and a rule that holds on one harness now holds on the other by construction. The cost is one shared module both adapters must feed truthfully: a fact an adapter fails to resolve widens a rule's scope or narrows it, so each adapter's fact resolution needs its own test — `test/extension-pi-bash-gate.test.mjs` drives the real Pi handler and its config reads, not just the decider. Rules that are genuinely Claude-shaped must now be recorded as Claude-edge with a stated reason instead of quietly missing on Pi.
