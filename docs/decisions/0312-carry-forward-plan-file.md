# 0312. Carry-forward plan passed as a file path

## Status

Accepted

## Context

Fan-in (`consolidate-fanin.mjs`) and the fan-out emitter (`emit-fanout-dispatch.mjs`) read the carry-forward plan from `--carry-forward-plan <json>`. A `findings_present` carry puts the carried finding text into that plan. The gate procedure therefore put finding text on the command line, and the PreToolUse Bash hook rejects it ([issue 3415](https://github.com/mfittko/dev-loops/issues/3415)). The resolver already records the plan as the keyed `<gate>-<headSha>.carry-forward-plan.json` artifact.

## Decision

Fan-in and the emitter read the plan from `--carry-forward-plan-file <absolute path>`. The file has the same shape as the inline plan. The gate procedure in `skills/docs/gate-review-sub-loop-contract.md` and `skills/copilot-pr-followup/SKILL.md` passes the keyed plan file path and never inline plan JSON.

`--carry-forward-plan` stays accepted for direct callers. Passing it together with `--carry-forward-plan-file` fails closed with a mutual-exclusion error. An unreadable plan file fails closed with a recovery line that points to `resolve-angle-carry-forward.mjs`. The plan is still the proof for `--carried-angles`, and the shape checks are unchanged.

## Consequences

- Carried finding text stays off the command line and out of the Bash hook.
- The gate procedure has one plan source, the keyed artifact the resolver wrote.
- A caller that passes both flags gets an immediate mutual-exclusion refusal.
