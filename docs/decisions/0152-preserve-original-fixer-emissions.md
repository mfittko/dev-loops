# 0152. Preserve original fixer emissions under an owned lock

## Status

Proposed — accepted on merge of [issue 2790](https://github.com/mfittko/dev-loops/issues/2790).

## Context

Replacing the canonical active fixer plan loses the original delivery bytes needed by
historical completion revalidation. The original prompt and pull receipt must retain
their actual meaning across renderer changes and later emissions.

## Decision

Before reading the active plan, the real emitter exclusively acquires the PR-local
`.fixer-emission.lock`. Preserve the exact raw prior plan at the execution-derived
`<old-execution>/original-fixer-emit-plan.json` before atomic active replacement.
Reuse existing archives only when exact bytes match. Share the narrow original
identity/digest, historical prompt hash, real receipt subject/hash and complete Work
order JSON suffix checks with the existing legacy consumer. Never rerender old prose.
Unpulled snapshots preserve evidence without creating a receipt or authority.

Keep prompt, report, receipt and index bytes unchanged. The original receipt still
names the original canonical plan path; archives never enter pull or grant lookup.
Require exclusive new destinations, singly linked regular evidence and unaliased
ancestors; recheck captured file/directory and source/decision identity before
publication. Hold the lock through active rename and marker write, releasing only
the invocation's owned lock in `finally`.

## Consequences

Current participating emitters serialize and contention refuses. A crashed emitter
leaves its lock for operator investigation: no stale takeover or automatic recovery.
The lock is not compare-and-swap against obsolete emitters that ignore it, nor an
adversarial filesystem guarantee after the final identity check. Frozen old emitters
must remain idle during rollout. This adds no populated completion producer and
does not change current-only Delta or historical native-query boundaries.
Accepted ADRs 0147–0151 remain unchanged.
