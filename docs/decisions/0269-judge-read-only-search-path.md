# 0269. The judge gets a read-only search path, and the refusal names Read and the allowed commands

## Status

Proposed

Amends [0106](./0106-workers-pull-deterministic-work-orders.md) for the judge shell boundary: the judge shell runs the pull line, the decision checker and, on Claude Code, read-only search commands. Every other decision of that record stays in force, and the record stays unedited.

Amends [0227](./0227-judge-work-order-output-schema-and-pull-owned-digest-check.md) decision 4: the judge refusal text names `Read` and the allowed search commands, not `Grep` or `Glob`.

## Context

Source: [issue 3092](https://github.com/mfittko/dev-loops/issues/3092).

The judge needs to check a claim in the findings against the code. The two-command boundary left it only `Read`, and the oversize contract docs cost many reads. The refusal told the judge to use `Read/Grep/Glob`, which are not always available. A judge that finds no exit works around the gate.

## Decision

- On Claude Code the judge Bash gate allows `grep -n`, `rg -n`, `git show` and `git diff`. A command passes when it has no shell metacharacter outside quotes, no expansion inside double quotes and no flag that writes or runs a program. `git diff` takes a range such as `origin/main...HEAD` or two revisions, because a worktree diff refreshes the index. Glob characters go inside single quotes. The denied flags are `--output`, `--ext-diff`, `--textconv`, `--pre` and `--hostname-bin`, matched by exact name after quote characters are removed, so `--pretty=...` and `--extended-regexp` pass.
- Every refusal names `Read` with its offset and limit and lists the allowed search commands, so the judge always has an exit.
- The work order states the boundary for both harnesses. On Pi the judge uses its native read, grep and find tools, and the Pi gate is unchanged (#1086).
- The work order carries a Cited rules table: each registered rule ID cited in the findings ledger, with its first text line and owning doc. Heading and HTML comment lines are skipped when taking that line.

| Column | Content |
| --- | --- |
| Rule | The registered rule ID |
| Doc | The file that carries the rule marker |
| Text | The first text line of the rule paragraph |

## Alternatives rejected

A search wrapper script that runs the search for the judge was rejected. It adds a surface to maintain and a second gate to keep in step with the hook. The allowlist reuses the shell the judge already has.

## Consequences

- dev-loops steers and never traps: the judge searches with a bounded set of commands and every refusal names the exit.
- The allowlist is a lexical check and a list of denied flags. A new write flag on one of the four commands needs an addition to the list.
- The Pi judge keeps its shell-free read and search tools, so the two harnesses differ in mechanism and agree in capability.
