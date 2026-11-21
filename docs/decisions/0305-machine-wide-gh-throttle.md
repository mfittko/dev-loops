# 0305. Per-checkout gh throttle

## Status

Accepted

## Context

Several dev-loops processes run on one machine and each shells out to `gh`. Parallel lanes together trip the GitHub secondary rate limit, which the single-process pacing in each script cannot see. Some call sites ran `gh` outside the shared runner (`spawn`, `execFile` and `execFileSync`), so a throttle in the shared runner alone left them unpaced.

## Decision

Every `gh` call takes a slot from one throttle before it starts (`packages/core/src/github/gh-throttle.mjs`). Pacing is shared per main checkout. Processes that resolve the same main checkout (the parent of the cwd's git common dir) share one `next-slot` file under its `tmp/gh-throttle/`, guarded by an exclusive-create lock. Separate clones do not share pacing, and a process whose cwd is outside a git checkout fails closed with `GH_THROTTLE_UNAVAILABLE`. The root resolves from the call cwd and is cached per cwd. A lock is stolen when its mtime is stale and the holder pid in its token is gone, or unconditionally when its mtime is older than six lock timeouts (a reused or foreign pid must not block every call), and only when the token is unchanged. A stored slot more than ten minutes ahead (a backward clock step or a corrupt value) counts as no reservation. The horizon covers 60 queued callers at the maximum interval.

The default runner `runChild` paces each `gh` call. Direct call sites use `takeGhSlot({ env })` (async) or `ghExecFileSync` (sync, which runs a short child process in the call's env and cwd to take the slot). An injected runner stays unpaced.

Only a `gh` attested as a stub is unpaced: `GH_STUB_ATTESTATION_ENV` (`DEV_LOOPS_GH_STUB`, exported by `test-mode-write-guard.mjs`), the attestation the test-mode write guard already trusts. A stubbed `gh` makes no API call. `NODE_ENV=test` alone does not skip pacing, because a bypass keyed on a mode that a real run can inherit fails open. A test that spawns the real `gh` path stubs `gh` with `writeGhStub`, sets `queue.ghMinIntervalMs` to 0, or accepts pacing.

The interval is `queue.ghMinIntervalMs`: default 500, maximum 10000 so the 60000 ms sync slot timeout covers several queued slots, `0` disables pacing. The throttle never fails open. A lock that cannot be taken in time, an unreadable state file or an unresolvable main checkout throws `GH_THROTTLE_UNAVAILABLE`. A config load failure falls back to the default interval with one warning per process.

A secondary rate limit backs off once (30 s) and retries, then fails with `RATE_LIMITED`. Only the captured gh stderr counts as the limit signal, never an error message, which carries the whole argv. These paths do that: the default `runChild` and `runCommand` for `gh` (each retakes a slot for its one retry, so direct callers such as `capture-review-threads` and `observe-head-ci` back off), `ghJson` and `ghGraphql` (on the default runner they map the `RATE_LIMITED` of `runChild` to their own prefix and add no second retry; with an injected runner they retry only when given a `backoffMs` or `sleep` seam), `ghExecFileSync`, and the direct async sites that capture gh stderr (`withSecondaryLimitBackoff`: `unresolve-review-thread`, `fetch-head-declared-keys`, `_review-thread-mutations`, `stage-reviewer-draft`, `resolve-pr-conflicts`, `watch-initial-copilot-pr`). These sites are paced only, with no backoff: `create-pr` and `gh run watch` in `run-watch-cycle` (their stderr is inherited or streamed), `scripts/release/verify-release-approval.mjs` (it imports nothing from core) and any injected runner.

## Consequences

- Parallel lanes in one checkout share one request rate, so secondary rate limits become rare.
- Each `gh` call adds up to the interval in latency, and a sync call site adds one short child process.
- A new direct `gh` call site must take a slot, or the throttle is incomplete.
- Tests that reach the real `gh` path are paced unless `gh` is attested as a stub.
