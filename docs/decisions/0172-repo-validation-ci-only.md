# 0172. This repo validates through current-head CI

## Status

Accepted — 2026-10-20 ([issue 2873](https://github.com/mfittko/dev-loops/issues/2873))

Amends [0137](./0137-validation-modes-and-consumer-configured-commands.md): it said this repo sets `local`. Record 0137 stays unedited.

## Context

Concurrent full local validation runs overload the host and fail gate rounds on timeouts in unrelated tests. Validation inside the gate took 49% of gate-coordinator time over 14 rounds. The operator decided to switch ([comment](https://github.com/mfittko/dev-loops/issues/2873#issuecomment-6291014373)).

## Decision

- This repo sets `validation.mode: ci-only` in `.devloops`.
- `validation.paths` stays unchanged.
- The gate resolution for the PR that makes this change resolves typed `incomplete` (config-source change). Current-head CI is the evidence for that PR.
- The `local` producer machinery from issue 2866 slices 1-5 stays built. The repo may switch back later. No issue is filed for that now.

## Consequences

Gate rounds run no local full suite. Current-head CI supplies full-repository evidence.

Host load drops, and unrelated timeouts stop failing gate rounds.

A red or pending CI check blocks the gate through the existing `ci-only` rules.
