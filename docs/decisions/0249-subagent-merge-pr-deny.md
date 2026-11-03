# 0249. Any subagent is denied `merge-pr.mjs` without `--check`

## Status

Accepted — 2026-11-03 ([issue 2500](https://github.com/mfittko/dev-loops/issues/2500), slice 2).

## Context

The merge is owned by the orchestrator (the main agent). A subagent that runs `scripts/github/merge-pr.mjs` merges a PR without the orchestrator deciding to. The read-only `--check` mode reports merge readiness, the approvalPath and the approveMergeLine, and it is safe for every actor.

The Bash gate already holds inline denials with no registered rule ID, such as the unresolve owner allowlist. They live in the shared module `packages/core/src/loop/bash-gate-decisions.mjs` (see [ADR 0245](0245-one-shared-bash-gate-deny-decision.md)).

## Decision

`decideMergePrOwnerDeny` denies any subagent role (`role` non-null) that runs `merge-pr.mjs` without a `--check` word. The check is structural and token-level: it walks the tokenized command and fires only when a segment's program is `merge-pr.mjs`, directly or as any operand after the launcher `node`, `bun` or `dev-loops-run`, after env assignments and launcher prefixes. It also follows `$(...)` substitutions, `-c`/`eval` payloads and shell heredoc bodies. A mention in an argument, quoted text or comment is not a program word. It uses no word list. Incomplete tokenization fails closed.

`--check` stays open to every actor, and only a bare `--check` word is accepted: a `--check=` word, or a `--check` that follows a dashed word outside the closed boolean-flag list (`--check`, `--stable-release`, `--standing-authorization`, `--lightweight`, `--help`) does not count, because that word is read as a value-taking option. A bare `--check` counts only right after the script word, a non-dashed word or a boolean flag. A boolean flag missing from the list makes the gate deny, which is the fail-closed direction. The top-level session (role null) keeps the script. The deny is inline with `ruleId: null`, so it mints no rule ID. It keys on the role name alone, like the unresolve allowlist, so it is harness-neutral. The dev-loop skill and the workflow handoff contract state the matching prose rule: a coordinator hands back the `--check` result and composes the merge command line from its approvalPath and approveMergeLine, and a brief carries no merge step.

## Consequences

A subagent hands back the `--check` result and the merge command line composed from its approvalPath and approveMergeLine, and the orchestrator runs the merge. The check is a guardrail for cooperative agents: a script written to a file and run later, or a command split across variables, is not followed. Option values of wrappers such as `xargs`, `bunx` and `env -u`, and a script written to a file, are ceilings of the structural check. The token-level check is a guardrail for cooperative agents and not a shell interpreter, so it also accepts these ceilings: a `case` arm whose pattern word starts with `(`, a `f () { ...; }` function header with a space before `()`, `coproc NAME { ...; }`, and a `case` pattern inside `$(...)` that the tokenizer closes at the pattern's `)`. The Claude PreToolUse seam is the only consumer today; Pi wiring is tracked in issue 3033.
