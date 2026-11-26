# 0331. The merge owner deny matches the run position, not the raw text

## Status

Accepted — 2026-11-26 ([issue 3605](https://github.com/mfittko/dev-loops/issues/3605)).

Amends [0297](./0297-subagent-may-run-merge-test-files.md) for the match. ADR 0297 stays unedited.

## Context

ADR 0297 denies a subagent any Bash command whose raw text names the merge script. A read-only command matched too: `grep`, `sed -n`, `git grep` and `git show` of a path that holds the name, and `git show` of the ADR files 0249 and 0297. On 2026-11-26 the deny stopped the issue 3599 pull request four times, and one draft_gate review unit lost all five angles. Reading the file merges nothing.

## Decision

`decideMergePrOwnerDeny` denies a subagent command that runs the merge script. `scriptInvocationRe(basename)` builds the run-position matcher. The unresolve owner rule and the merge owner rule both use it. The run forms are `node <path>`, `bun <path>`, `dev-loops-run [--repo-root <p>] <path>` and the path as the command head, each at the start of the command or after `;`, `&&`, `||`, `|`, `(`, a backtick or a newline, and each with `--check`. The match still strips quote and backslash characters first, so `merge-""pr` stays denied. The exact basename never matches a `.test.mjs` path, so the test-file exemption and `commandMentionsMergePr` are deleted. The role null path is unchanged.

## Consequences

A subagent reads the merge script, its callers and its ADRs with `grep`, `git grep`, `sed -n` and `git show`. The `node`, `bun`, `dev-loops-run` and command-head run forms stay denied, with or without the `.mjs` extension (`bun scripts/github/<stem>`). A `.test.mjs` path or a longer name never matches. The matcher strips only empty quote pairs and backslashes, so a quoted run path still denies, and a quoted search pattern such as `rg "foo|<name>.mjs"` or `grep -nE "(<name>.mjs|x)"` is allowed: a separator inside quotes is data unless a launcher word follows it. This newly allows a script name that follows a separator inside quotes without a launcher (`bash -c "x; <path>"`, `"$(<path>)"`), which joins the `sh -c` ceiling below. The ceiling of ADR 0297 stays: a script name assembled at run time by variable or command substitution is not caught. A shell glob or brace expansion of the file name (`merge-pr.m*`, `merge-pr.{mjs,}`) is not caught either, because the matcher requires the literal basename. Widening it to the bare stem would also deny `merge-pr.test.mjs` runs. The new ceiling also leaves these shapes uncaught: the path after a command prefix or keyword (`exec <path>`, `env <path>`, `timeout 60 <path>`, `nohup <path>`, `if <path>; then`, `sh -c '<path>'`), the path fed to an interpreter by stdin or `$(cat <path>)`, and other JS runtimes (`deno run <path>`, `tsx <path>`). `env node <path>` is caught, because the launcher word `node` matches after any whitespace. A launcher word earlier in an argv list (`grep -n node <path>`) stays denied, unchanged from the unresolve rule. The orchestrator-only rule guards against accidents and is not a sandbox. The orchestrator is the only actor allowed to run the script.
