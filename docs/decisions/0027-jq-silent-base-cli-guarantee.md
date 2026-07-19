# 0027. Make --jq/--silent a base-CLI guarantee for every JSON-emitting command, enforced by a fail-closed contract test

## Status

Accepted

## Context

Agents consuming dev-loops tool output kept falling back to ad-hoc parsing pipelines — inline `node -e`, `| python3`, awk/grep — because the `--jq`/`--silent` output contract was applied per-script and opt-in, so coverage was inconsistent and the token-economical consumption path could not be relied on. The gap was concrete: some JSON-emitting scripts (e.g. `sync-item-status.mjs`) emitted JSON but rejected `--jq` outright, and the breach was flagged in practice as a contract violation. The shared helper already existed in `scripts/lib/jq-output.mjs` (grown from [issue 981](https://github.com/mfittko/dev-loops/issues/981), subsuming [issue 963](https://github.com/mfittko/dev-loops/issues/963)) but nothing forced new or existing commands onto it. The fix landed 2026-07-04 as [issue 1071](https://github.com/mfittko/dev-loops/issues/1071) via [PR 1141](https://github.com/mfittko/dev-loops/pull/1141) (commit c5104275), with the SKILL's token-economical convention updated to state the guarantee as universal; extending the jq subset's power was tracked separately as [issue 1061](https://github.com/mfittko/dev-loops/issues/1061).

## Decision

We route every JSON-emitting CLI command's output through the shared jq-output helper (`emitResult` in `scripts/lib/jq-output.mjs`), making `--jq` — server-side field extraction via a deliberately bounded jq subset — and `--silent` a universal base-CLI guarantee rather than a per-script feature. We enforce the guarantee fail-closed with a contract test (`test/contracts/jq-output-base-guarantee-contract.test.mjs`) that discovers JSON-emitting direct-CLI scripts by glob plus direct-run-guard heuristics and asserts each one imports the shared helper or appears in a reasoned exclusion map with a concrete, evaluable justification — a new JSON command that skips the helper breaks the build, and the test adds behavioral subprocess spot-checks so the exit-code contract is proven end to end, not just the import. Each migrated script preserves its existing success/error JSON shape and non-jq exit codes. We rejected keeping the contract opt-in (the inconsistency it produced is the problem), and we rejected widening the helper toward full jq power: `group_by`/`reduce` stay out, and anything outside the subset fails closed with a distinct filter-error exit code rather than guessing.

## Consequences

Agents and skills may always pass `--jq`/`--silent` to any operator-facing dev-loops JSON command, which eliminates the need for external parsing pipelines — `node -e`, `python3`, awk/grep pipes are now contract breaches, not workarounds. The migration covered 65+ scripts in one pass, and new commands inherit the flags and exit-code contract for free, but must use the shared helper or carry a reasoned exclusion entry (build/smoke tooling, dashboard servers, dormant adapters, and file-writing scripts are the accepted classes). Fail-soft always-exit-0 scripts force `ok:true` and are flagged inline where they do so. The bounded jq subset keeps filters predictable and fail-closed at the cost of expressiveness: an invalid or unsupported filter exits 2 with a clear error, distinct from a clean predicate-false exit 1.
