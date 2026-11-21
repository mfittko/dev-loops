# 0297. A subagent may run the merge test files, and every run of the merge script stays denied

## Status

Accepted — 2026-11-21 ([issue 3345](https://github.com/mfittko/dev-loops/issues/3345)).

Supersedes [0249](0249-subagent-merge-pr-deny.md).

## Context

[ADR 0249](0249-subagent-merge-pr-deny.md) denies any subagent a Bash command whose raw text contains `merge-pr`. The match also denied the unit tests of the merge script, so a developer or fixer lane on that code could not run `test/github/merge-pr.test.mjs` and had to hand the test run back to the orchestrator.

## Decision

`decideMergePrOwnerDeny` denies any subagent role (`role` non-null) whose Bash command has raw text that contains `merge-pr`. The match is a whole-token test (`/merge-pr\b(?![\w.-]*\.test\.mjs\b)/`) on the raw command after quote and backslash characters are stripped, so `merge-pr.mjs` is denied and `merge-preconditions.md` is not. A merge-pr test-file path such as `test/github/merge-pr.test.mjs` or `merge-pr-act-list.test.mjs` is exempt, so every run of `scripts/github/merge-pr.mjs` stays denied while the unit tests may run. It does not tokenize, so redirections, heredocs, launcher flags and `--check` placement cannot change the outcome, and `--check` is denied with every other form. The top-level session (role null) keeps the script. The deny is inline with `ruleId: null`, so it mints no rule ID. It keys on the role name alone, like the unresolve allowlist, so it is harness-neutral. The dev-loop skill and the workflow handoff contract state the matching prose rule: a coordinator hands back the `await_final_human_approval` result of `loop gate-coordination`, the orchestrator runs `merge-pr.mjs --check` and the merge, and a brief carries no merge step.

## Consequences

The orchestrator is the only actor that runs `merge-pr.mjs`, with or without `--check`. The check is a guardrail for cooperative agents. Its ceiling is a script name assembled at run time, such as a variable or a command substitution that joins `merge-` and `pr`, because the raw text then holds no `merge-pr`. A script written to a file and run later is the same ceiling. A substitution or expansion applied to an exempt test path, such as `f=scripts/github/merge-pr.test.mjs; node ${f/.test/}`, is the same ceiling. The deny does not follow these forms. The match also runs on raw text, so a subagent Bash command that only names `merge-pr` is denied too, such as `git add scripts/github/merge-pr.mjs` or `rg merge-pr`. A developer or fixer lane on merge-pr code cannot run those commands. It uses the Grep and Read tools. Subagents may run the merge-pr test files, because this record exempts a merge-pr test-file path from the match. Every run of `scripts/github/merge-pr.mjs` stays denied for any subagent. The Claude PreToolUse seam is the only consumer today; Pi wiring is tracked in issue 3033.
