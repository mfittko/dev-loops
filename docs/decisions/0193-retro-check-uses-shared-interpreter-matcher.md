# 0193. The retrospective tooling check uses the shared inline-interpreter matcher for node

## Status

Accepted — 2026-10-26 ([issue 2943](https://github.com/mfittko/dev-loops/issues/2943))

## Context

The retrospective tooling check (`scripts/loop/check-retro-tooling.mjs`) and the `OPS-NO-INLINE-INTERPRETER` guard each defined which node commands count as inline interpreter use. The two sets could differ, so a retro could flag a command the guard allows, or miss one the guard blocks.

## Decision

- Matcher. For node commands, the retro check calls the exported `commandContainsInlineInterpreter` from `packages/core/src/loop/bash-command-classify.mjs`.
- Set. The retro violation set for node is the guard's set: `-e`, `--eval`, `-p`, stdin `-`, and heredoc, including after interpreter flags.
- Contract. `skills/docs/retrospective-checkpoint-contract.md` names that set.

## Consequences

The retro check and the guard agree on node commands. A change to the guard matcher changes the retro violation set with it. The retro check keeps no separate node pattern list.
