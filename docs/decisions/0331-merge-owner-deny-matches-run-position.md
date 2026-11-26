# 0331. The merge owner deny matches the run position, not the raw text

## Status

Accepted — 2026-11-26 ([issue 3605](https://github.com/mfittko/dev-loops/issues/3605)).

Amends [0297](./0297-subagent-may-run-merge-test-files.md) for the match. ADR 0297 stays unedited.

## Context

ADR 0297 denies a subagent any Bash command whose raw text names the merge script. A read-only command matched too: `grep`, `sed -n`, `git grep` and `git show` of a path that holds the name, and `git show` of the ADR files 0249 and 0297. On 2026-11-26 the deny stopped the issue 3599 pull request four times, and one draft_gate review unit lost all five angles. Reading the file merges nothing.

## Decision

`decideMergePrOwnerDeny` denies a subagent command that runs the merge script. `scriptInvocationRe(basename)` builds the run-position matcher. The unresolve owner rule and the merge owner rule both use it. The run forms are `node <path>`, `bun <path>`, `dev-loops-run [--repo-root <p>] <path>` and the path as the command head, each at the start of the command or after `;`, `&&`, `||`, `|`, `(`, a backtick or a newline, and each with `--check`. The match still strips quote and backslash characters first, so `merge-""pr` stays denied. The exact basename never matches a `.test.mjs` path, so the test-file exemption and `commandMentionsMergePr` are deleted. The role null path is unchanged.

## Consequences

A subagent reads the merge script, its callers and its ADRs with `grep`, `git grep`, `sed -n` and `git show`. Every run form stays denied. The ceiling of ADR 0297 stays: a script name assembled at run time by variable or command substitution is not caught. The new ceiling also leaves these shapes uncaught: the path after a command prefix or keyword (`exec <path>`, `env <path>`, `timeout 60 <path>`, `nohup <path>`, `if <path>; then`, `sh -c '<path>'`), and the path fed to an interpreter by stdin or `$(cat <path>)`. `env node <path>` is caught, because the launcher word `node` matches after any whitespace. A launcher word earlier in an argv list (`grep -n node <path>`) stays denied, unchanged from the unresolve rule. The orchestrator-only rule guards against accidents and is not a sandbox. The orchestrator is the only actor allowed to run the script.
