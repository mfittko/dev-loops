# 0303. Machine-wide gh throttle

## Status

Accepted

## Context

Several dev-loops processes run on one machine and each shells out to `gh`. Parallel lanes together trip the GitHub secondary rate limit, which the single-process pacing in each script cannot see. Some call sites ran `gh` outside the shared runner (`spawn`, `execFile` and `execFileSync`), so a throttle in the shared runner alone left them unpaced.

## Decision

Every `gh` call takes a slot from one machine-wide throttle before it starts (`packages/core/src/github/gh-throttle.mjs`). All processes share one `next-slot` file under the main checkout's `tmp/gh-throttle/`, guarded by an exclusive-create lock. The default runner `runChild` paces each `gh` call. Direct call sites use `takeGhSlot` (async) or `ghExecFileSync` (sync, which runs a short child process to take the slot). An injected runner stays unpaced, and so does a `gh` attested as a stub (`DEV_LOOPS_GH_STUB`) or a process in test mode (`NODE_ENV=test`), because neither sends traffic.

The interval is `queue.ghMinIntervalMs`: default 500, `0` disables pacing. The throttle never fails open. A lock that cannot be taken in time, an unreadable state file or an unresolvable main checkout throws `GH_THROTTLE_UNAVAILABLE`. A config load failure falls back to the default interval with one warning per process. A secondary rate limit backs off once and then fails with `RATE_LIMITED`.

## Consequences

- Parallel lanes share one request rate, so secondary rate limits become rare.
- Each `gh` call adds up to the interval in latency, and a sync call site adds one short child process.
- A new direct `gh` call site must take a slot, or the throttle is incomplete.
- Tests run unpaced. A test of the throttle itself passes an explicit root or sets `NODE_ENV` to another value.
