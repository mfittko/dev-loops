# 0245. The Bash-gate deny rules live in one harness-neutral module

## Status

Accepted — 2026-11-02 ([issue 3032](https://github.com/mfittko/dev-loops/issues/3032), slice 1 of [issue 2965](https://github.com/mfittko/dev-loops/issues/2965)).

## Context

The Bash-gate deny rules — the coordinator verify boundary, the actor-independent guard rules, the human-merge invariant, the unresolve owner allowlist and the raw `gh pr create`/`gh pr ready`/`gh pr merge` refusals — were inline in `decideBashGate` in the Claude Code seam, `packages/core/src/claude/hook-decisions.mjs`. The seam is the Claude `PreToolUse` hook bundle, which cannot import `@dev-loops/core` and so is vendored into `.claude/hooks/_*.mjs` by `scripts/claude/generate-claude-assets.mjs`.

None of those rules keyed on Claude machinery. Every one reads the command string plus a small fact set (role, repo identity, `autonomy.humanMergeOnly`, the coordinator flag, the `gh pr ready` draft-gate probe). Only two Bash-gate rules did key on Claude role machinery: the judge command restriction and the fixer pull-line/grant binding.

The rules having a Claude-only home meant a harness that wanted the same Bash-gate boundary had to reimplement them, and a reimplemented rule drifts from the one the other harness runs.

## Decision

The Bash-gate deny rules move verbatim into `packages/core/src/loop/bash-gate-decisions.mjs` (`decideBashGateDeny`): same evaluation order, same predicates, same reason texts. The Claude seam keeps `decideBashGate` as a wrapper that evaluates its two Claude-only role branches and then delegates, so no Claude verdict changed.

The module is pure and each caller injects the facts. Every required fact is validated: a caller that omits or mistypes one is refused fail-closed instead of getting a permissive default, because a defaulted `humanMergeOnly: false` fails STOP-HUMAN-MERGE-001 open and the omission is invisible at the call site. `readyGate` stays nullable, because `null` is its meaningful "not probed" value.

`BASH_GATE_RULES` pins the registered rule IDs in evaluation order, and `packages/core/test/bash-gate-decisions.test.mjs` asserts that list, each rule's exact reason string and the evaluation order. Three inline denials (the unresolve owner allowlist, the `timeout`-wrapped sanctioned-command deny, the subagent ad-hoc external-write deny) name no registry rule and carry `ruleId: null`, so they stay out of the list rather than minting rule IDs the registry does not own.

The unresolve owner allowlist moves with the rest of the set. It keys on the role name alone, so it is not a Claude-edge rule: the Claude seam just evaluates it first among the shared rules, ahead of its own two role branches, which is the order it has always had.

## Consequences

One body now backs the Bash-gate deny rules, so a second harness can reach it instead of copying it; the two rules that genuinely key on Claude role machinery stay at the Claude edge and are listed as such in `skills/docs/cross-harness-regression-contract.md`. The Claude seam keeps its public surface through re-exports, so `decideBashGate`'s callers and verdicts are unchanged. The cost is one more vendored `_*.mjs` module in the Claude hook bundle and a guard test that must be updated deliberately whenever a rule or a reason text changes.
