/**
 * Fail-closed test-mode guard for GitHub WRITE helpers.
 *
 * A GitHub write helper (issue/PR create/edit/close/comment/merge) must never
 * reach a live GitHub write path from a test. The real incident: an unstubbed
 * `bun run verify` drove a dedup test's followUpDraft through
 * applyFollowUpIssues -> ensureFollowUpIssue -> createIssue and FILED A REAL
 * ISSUE against the repo. The DI stub seam existed; the test simply did not
 * thread it, and nothing failed closed to stop the live write.
 *
 * This guard is TEST-MODE ONLY. In production (`NODE_ENV !== "test"`) it is a
 * no-op — it never changes production write behavior (non-goal: no production
 * behavior change; no general network sandbox). It only asserts, when a test is
 * running, that the write is stubbed by one of the two sanctioned seams:
 *
 *   (a) In-process DI seam: the helper's `run`/`runChild` was replaced with a
 *       stub (e.g. `makeGhMock`), so it is no longer the live child-exec seam.
 *   (b) Process-boundary seam: a subprocess test installed a fake `gh` on PATH
 *       (`writeGhStub`) and attests it via `DEV_LOOPS_GH_STUB` in the child env.
 *
 * Anything else in test mode fails closed at the call site, before any network
 * call, with an actionable error naming both seams.
 */

import { runChild as liveRunChild } from "../cli/primitives.mjs";

/**
 * Env var a process-boundary gh stub sets to attest that `gh` itself is a stub
 * (set automatically by the `writeGhStub` test helper). Only consulted in test
 * mode, so it is not a production escape hatch.
 */
export const GH_STUB_ATTESTATION_ENV = "DEV_LOOPS_GH_STUB";

/**
 * True when `run` is the live child-exec seam — i.e. NO in-process DI stub was
 * injected. `null`/`undefined` (a helper with no run seam, e.g. the spawn-based
 * create-pr path) is treated as live too, so it fails closed rather than open.
 * @param {unknown} run
 */
export function isLiveExecutor(run) {
  return run == null || run === liveRunChild;
}

/**
 * Assert a GitHub write is stubbed when running under a test. No-op unless
 * `env.NODE_ENV === "test"`. Throws (code `GH_WRITE_UNSTUBBED_IN_TEST`) when the
 * write would reach the live path with neither sanctioned stub seam present.
 *
 * @param {unknown} run - the helper's `run`/`runChild` seam (omit for spawn-only
 *   helpers with no in-process seam).
 * @param {string} op - human-readable op name, e.g. `"issue create"`.
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
export function assertGithubWriteStubbedInTestMode(run, op, { env = process.env } = {}) {
  if (env?.NODE_ENV !== "test") return; // production / non-test: never guards
  if (!isLiveExecutor(run)) return; // (a) in-process DI stub injected
  if (env?.[GH_STUB_ATTESTATION_ENV]) return; // (b) process-boundary gh stub
  throw Object.assign(
    new Error(
      `GitHub write helper "${op}" was called in test mode without an injected stub — ` +
        `refusing to reach a live GitHub write path (a test must never mutate the real repo). ` +
        `Inject the in-process DI seam (pass { run } / { runChild }, e.g. makeGhMock) or stub gh ` +
        `at the process boundary (writeGhStub, which sets ${GH_STUB_ATTESTATION_ENV}). See issue 2216.`,
    ),
    { code: "GH_WRITE_UNSTUBBED_IN_TEST" },
  );
}
