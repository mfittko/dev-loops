# 0246. `scopeDrift.driftedAreas` is optional for `within_scope` judge verdicts

## Status

Accepted — 2026-11-03 ([issue 3051](https://github.com/mfittko/dev-loops/issues/3051)).

## Context

`validateJudgeVerdict` in `packages/core/src/loop/gate-fanin.mjs` required `scopeDrift.driftedAreas` on every judge verdict. A `within_scope` verdict that omitted the field failed closed.

That rejection locked out PR 3043. The judge returned a valid `within_scope` verdict twice, both permitted dispatches were spent on the same validation failure, and the gate had no dispatch left to recover.

A `within_scope` verdict has no drifted areas to list. Requiring an empty array there adds a failure mode and carries no information.

## Decision

`scopeDrift.driftedAreas` is optional when the verdict is `within_scope`, and when it normalizes to `none`. An omitted field defaults to `[]`.

The field stays required for `drift_detected`, as an array of non-empty strings. A present value that is malformed fails closed in every case, including `within_scope`. Only omission gains a default.

This ADR amends no accepted record.

## Consequences

Judge verdicts that omit `driftedAreas` on a `within_scope` verdict now validate. The contract docs and `agents/judge.agent.md` state that the field is optional there and required for `drift_detected`. The judge dispatch cap is unchanged, so a genuinely malformed verdict still consumes a dispatch.
