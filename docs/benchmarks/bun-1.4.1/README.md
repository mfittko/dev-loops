# Bun 1.4.1 migration benchmark

This directory is the durable evidence location for issue
[#1966](https://github.com/mfittko/dev-loops/issues/1966). It compares the npm +
Node baseline with the Bun 1.4.1 candidate without changing dependency versions,
test coverage, product behavior, or machine conditions.

**Evidence status: not yet captured.** No timing result is claimed by this
document. The migration is a no-go until the complete protocol below produces
two independently captured, passing sessions and their raw JSON files are added
under this directory. As of the initial harness commit,
`scripts/benchmarks/run-package-manager.mjs` records only one cold and one warm
install sample per tool and creates both logical verification sessions within a
single process invocation. Those outputs are diagnostic only: they do not
satisfy the required install medians or independent-session evidence.

## Required protocol

Use the same physical machine, power state, operating system, architecture,
dependency graph, and source revisions throughout a comparison. Record the
exact Node, npm, and Bun versions; Bun must report `1.4.1`. Prepare two source
trees: the npm/Node baseline with its authoritative npm lockfile, and the final
Bun candidate with its authoritative `bun.lock`. Do not edit dependencies or
tests between paired runs.

For each independent session:

1. Start from fresh copies of both source trees with no `node_modules`.
2. Use isolated, initially empty npm and Bun caches for cold-install samples.
3. Run one untimed warm-up, then at least seven timed cold-cache clean installs
   for each tool. Restore the same initial cache condition before every cold
   sample.
4. Prime each tool's isolated cache, remove `node_modules`, run one untimed
   warm-up, then at least seven timed warm-cache clean installs for each tool.
   Remove only `node_modules` between warm samples; retain that tool's cache.
5. Compare installed dependency inventories, workspace links, executable shims,
   peer/optional metadata, and lifecycle-script outcomes. Any mismatch is a
   correctness failure, not a timing result.
6. With dependencies already installed, run one untimed full-verification
   warm-up per tool. Then run seven timed pairs, alternating tool order on every
   pair. Capture command, duration, exit code, signal, stdout/stderr location,
   and suite inventory for every run.
7. Save the raw, unrounded observations without deleting failed runs. Analyze
   only after all required samples have been attempted.

Session 2 must be a separate invocation after Session 1 has fully ended. Recheck
and record the environment; use new source copies and new isolated caches. Do
not call two loops in one process, reuse Session 1's temporary directory, or
label two halves of one run as independent sessions.

## Running two independent sessions

The checked-in runner interface is:

```bash
bun scripts/benchmarks/run-package-manager.mjs \
  --npm-source /absolute/path/to/npm-baseline \
  --bun-source /absolute/path/to/bun-candidate \
  --output docs/benchmarks/bun-1.4.1/session-1.raw.json

# End the first invocation, re-establish the recorded machine/power conditions,
# then run again with new isolated copies/caches:
bun scripts/benchmarks/run-package-manager.mjs \
  --npm-source /absolute/path/to/npm-baseline \
  --bun-source /absolute/path/to/bun-candidate \
  --output docs/benchmarks/bun-1.4.1/session-2.raw.json
```

Do not treat these commands as qualifying evidence until the runner emits the
seven install samples per cache condition and one independently captured verify
session per invocation described above. Once the runner satisfies that contract,
analyze each raw artifact with:

```bash
bun scripts/benchmarks/analyze-package-manager.mjs \
  docs/benchmarks/bun-1.4.1/session-1.raw.json
bun scripts/benchmarks/analyze-package-manager.mjs \
  docs/benchmarks/bun-1.4.1/session-2.raw.json
```

Commit the two raw JSON files plus a short `verdict.md` containing environment
details, per-condition medians, per-pair verification results, and analyzer exit
statuses. Keep raw stdout/stderr in referenced files if embedding it would make
the JSON impractical; paths must be repository-relative and resolvable.

## Pass and no-go rules

The result passes only when correctness parity is complete, both sessions exit
cleanly, Bun's warm-cache clean-install median is at most 50% of npm's median,
and in each independent session Bun has the lower full-verification median and
wins at least five of seven interleaved pairs.

The result **must not** be declared passing when any command fails, a suite is
skipped, output is unattributable, dependency inventories differ, source or
power conditions are incomparable, fewer than seven timed samples exist, the
sessions are not independently captured, or a threshold is missed. Do not
increase concurrency, loosen assertions, suppress failures, discard outliers,
or change product behavior to manufacture a speedup. Record the observed result
as no-go and stop before treating Bun as authoritative.
