# 0289. The gate join resolves its own tmp root, and the retro check reads session transcripts

## Status

Accepted, 2026-11-17 ([issue 3225](https://github.com/mfittko/dev-loops/issues/3225)).

Builds on [ADR 0129](./0129-claude-code-gate-join-is-wait-for-units.md) and [ADR 0193](./0193-retro-check-uses-shared-interpreter-matcher.md). Every decision of those records stays in force, and the records stay unedited.

## Context

Under Claude Code auto mode, the classifier denies gate joins that a subagent runs. `gate wait-for-units` was the only gate step that still refused without a hand-passed `--tmp-root`. A caller that passed a custom root got a `dispatch_reference_mismatch` refusal from the work-order pull that did not say which roots it searched. The retro tooling check read only newline-delimited command lists, so a Claude Code session transcript needed a helper script before the check could read it.

## Decision

1. `gate wait-for-units` resolves its tmp root from the nearest `tmp` ancestor of the plan path, else from `resolveGateArtifactTmpRoot(cwd)`. A missing `--tmp-root` is no longer refused. A `--tmp-root` value that is empty or has surrounding whitespace is refused. `GATE-EXEC-HARNESS-JOIN` in `skills/docs/gate-review-sub-loop-contract.md` states the join with no `--tmp-root`.
2. The `dispatch_reference_mismatch` refusal names the searched tmp roots and the default tmp root. The `pull-work-order` USAGE names the remedy: a caller that passed `--tmp-root` re-runs with no `--tmp-root`.
3. `check-retro-tooling.mjs` accepts one or more Claude Code session transcript paths through the repeatable `--transcript` flag and extracts the Bash commands. The extraction drops a heredoc body only for a lone `cat` or `tee` segment, or for a `git commit` whose one command substitution holds one `cat`. It finds heredocs through `tokenizeShellCommand`. On incomplete tokenization it keeps every line. The deterministic verifier section of `skills/docs/retrospective-checkpoint-contract.md` names this invocation.
4. The gate contract states the classifier no-verdict retry under `GATE-EXEC-BOUNDED-WAIT-CAP`. The coordinator retries the same call with backoff within the 170-second bounded wait, then hands back with `operatorAction` as the runnable remedy (`GATE-EXEC-NO-DEAD-END`).

## Consequences

- A gate join from a subagent needs no hand-passed tmp root. The join finds the sentinels and retirement records under the tmp root that holds the round's plan.
- A pull refusal tells the caller which roots it searched and how to recover.
- A retrospective can check a Claude Code session directly, with no helper script.
- A classifier no-verdict error ends in a retry and then a hand-back with a runnable call, never a dead end.

## Residual risk

The extraction splits a quoted multi-line argument per line, so such an argument can read as extra commands. A heredoc fed to any host other than the listed data hosts keeps its body, so a body line can read as a command. Both cases keep text rather than drop it, so they can add false findings. This PR does not show that a gate join from a Claude Code auto-mode subagent passes with no operator step. Only a live run can show it, and the tracking issue stays open until it does.
