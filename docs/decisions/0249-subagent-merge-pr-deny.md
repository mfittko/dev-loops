# 0249. Any subagent is denied a Bash command that names `merge-pr`

## Status

Accepted — 2026-11-03 ([issue 2500](https://github.com/mfittko/dev-loops/issues/2500), slice 2).

## Context

The merge is owned by the orchestrator (the main agent). A subagent that runs `scripts/github/merge-pr.mjs` merges a PR without the orchestrator deciding to.

The Bash gate already holds inline denials with no registered rule ID, such as the unresolve owner allowlist. They live in the shared module `packages/core/src/loop/bash-gate-decisions.mjs` (see [ADR 0245](0245-one-shared-bash-gate-deny-decision.md)).

## Decision

`decideMergePrOwnerDeny` denies any subagent role (`role` non-null) whose Bash command has raw text that contains `merge-pr`. The match is a plain substring test on the raw command after quote and backslash characters are stripped. It does not tokenize, so redirections, heredocs, launcher flags and `--check` placement cannot change the outcome, and `--check` is denied with every other form. The top-level session (role null) keeps the script. The deny is inline with `ruleId: null`, so it mints no rule ID. It keys on the role name alone, like the unresolve allowlist, so it is harness-neutral. The dev-loop skill and the workflow handoff contract state the matching prose rule: a coordinator hands back the merge-ready evidence, the orchestrator runs `merge-pr.mjs --check` and the merge, and a brief carries no merge step.

## Consequences

The orchestrator is the only actor that runs `merge-pr.mjs`, with or without `--check`. The check is a guardrail for cooperative agents. Its ceiling is a script name assembled at run time, such as a variable or a command substitution that joins `merge-` and `pr`, because the raw text then holds no `merge-pr`. A script written to a file and run later is the same ceiling. The deny does not follow these forms. The Claude PreToolUse seam is the only consumer today; Pi wiring is tracked in issue 3033.
