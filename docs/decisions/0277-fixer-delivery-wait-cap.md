# 0277. The fixer delivery wait requests 540 s and re-issues on `pending`

## Status

Accepted — 2026-11-16 ([issue 3099](https://github.com/mfittko/dev-loops/issues/3099)).

Amends [0223](0223-single-child-join-final-on-write-and-notification-fallback.md): the Claude Code notification fallback of the single-child join. Accepted records remain unchanged.

## Context

Claude Code moves a subagent's foreground Bash call to the background after 180 seconds, even with a longer Bash timeout. `GATE-EXEC-BOUNDED-WAIT-CAP` in `skills/docs/gate-review-sub-loop-contract.md` caps each bounded wait call at about 170 seconds (`WAIT_CAP_MS` in `scripts/lib/timeout-flag.mjs`). A capped call returns `outcome: "pending"` with a `reissue` command when requested time remains. The fixer work order from `scripts/loop/emit-fixer-work-order.mjs` still requested a 900 s `wait-pr-checks` wait in step 3 and ran it at most twice. A fixer whose wait the harness moved to the background could fall back to raw `gh pr checks`, which does not exclude `gate-evidence`. A coordinator in the notification fallback could also receive a "waiting on its own background work" notification and treat it as a finished join.

## Decision

The fixer delivery wait in step 3 of the ci-failure order and of the numbered full-phase steps runs `wait-pr-checks` with `--timeout 540`. The 540 s request matches the `wait-pr-checks` request in `skills/docs/copilot-loop-operations.md`, and the 170 s per-call cap splits it across calls. On `outcome: "pending"` (exit 2) the fixer runs the printed `reissue` command unchanged in the foreground and repeats until the outcome is no longer pending. On an exit 2 with any other outcome the fixer runs the original step 3 wait command exactly once more in the foreground. When the harness moves a wait to the background, the fixer runs the last printed `reissue` command, or the original wait command when none was printed, in the foreground. The fixer never reads raw `gh pr checks` and never runs `gh run watch`, because only the wait excludes `gate-evidence`. The red, unsettled, `stuck`, `changed` and error hand-backs are unchanged.

Next to `COORDINATOR-SINGLE-CHILD-JOIN-NOTIFICATION-FALLBACK`, a Claude Code "waiting on its own background work" notification means the child is still in flight and is not a finished join. The coordinator ends its turn again and runs the `--timeout 0` join only after the final completion notification. The Claude Code "report has not been delivered" prompt during that turn end is not a forced hand-back. The dev-loop coordinator answers it with a plain-text pause that names the child by agent id and `joinRef`, and calls no `SubagentHandback` while the child runs (`COORDINATOR-HANDBACK-ONE-REPORT` in `skills/docs/main-agent-contract.md`). Only a hand-back the harness forces, which ends the coordinator's run, is interim and states so under `GATE-EXEC-HARNESS-JOIN`.

## Consequences

- A fixer delivery wait call never blocks longer than the per-call cap, so the harness does not move it to the background.
- A capped call keeps its baseline across re-issues, so a push between two calls is reported and is not absorbed into a fresh baseline.
- The fallback join of ADR 0223 still runs once with `--timeout 0` after the final completion notification. Pi needs no fallback.
- Rejected: adopt `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`. It disables background features that dispatch relies on, and the workflow is harness-agnostic.
