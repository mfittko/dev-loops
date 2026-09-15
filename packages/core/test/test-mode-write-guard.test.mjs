import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  assertGithubWriteStubbedInTestMode,
  isLiveExecutor,
  GH_STUB_ATTESTATION_ENV,
} from "@dev-loops/core/github/test-mode-write-guard";
import { runChild as liveRunChild } from "@dev-loops/core/cli/primitives";
import { createIssue, editIssue, commentIssue } from "@dev-loops/core/github/issue-ops";

// A run seam that must never actually execute: if the guard fails to fire, the
// test fails loudly here instead of reaching a live `gh` call.
const failIfCalled = async () => {
  throw new Error("run seam should not be invoked");
};
// A minimal happy-path stub standing in for an injected DI seam.
const okIssueCreate = async () => ({ code: 0, stdout: "https://github.com/owner/repo/issues/7\n", stderr: "" });
const okEditOrComment = async () => ({ code: 0, stdout: "https://github.com/owner/repo/issues/7#comment\n", stderr: "" });

// ── pure guard unit ────────────────────────────────────────────────────────

test("guard is a no-op outside test mode (never changes production behavior)", () => {
  // liveRunChild + no attestation, but the EXECUTING PROCESS's NODE_ENV is not
  // "test" → no throw. Test mode is decided by processEnv, not env.
  assert.doesNotThrow(() =>
    assertGithubWriteStubbedInTestMode(liveRunChild, "issue create", {
      processEnv: { NODE_ENV: "production" },
    }),
  );
  assert.doesNotThrow(() =>
    assertGithubWriteStubbedInTestMode(undefined, "pr create", { processEnv: {} }),
  );
});

function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: "expected function to throw" });
}

test("guard fails closed: test mode + live executor + no stub attestation", () => {
  const err = captureThrow(() =>
    assertGithubWriteStubbedInTestMode(liveRunChild, "issue create", { processEnv: { NODE_ENV: "test" } }),
  );
  assert.equal(err.code, "GH_WRITE_UNSTUBBED_IN_TEST");
  assert.match(err.message, /issue create/);
  assert.match(err.message, /without an injected stub/);
});

test("guard fails closed for a spawn-only helper (run omitted / null)", () => {
  const err = captureThrow(() =>
    assertGithubWriteStubbedInTestMode(undefined, "pr create", { processEnv: { NODE_ENV: "test" } }),
  );
  assert.equal(err.code, "GH_WRITE_UNSTUBBED_IN_TEST");
});

test("guard passes with an in-process DI stub injected (run !== live executor)", () => {
  assert.doesNotThrow(() =>
    assertGithubWriteStubbedInTestMode(async () => ({}), "issue create", { processEnv: { NODE_ENV: "test" } }),
  );
});

test("guard passes with a process-boundary gh-stub attestation", () => {
  assert.doesNotThrow(() =>
    assertGithubWriteStubbedInTestMode(liveRunChild, "pr create", {
      processEnv: { NODE_ENV: "test" },
      env: { [GH_STUB_ATTESTATION_ENV]: "1" },
    }),
  );
});

// ── fail-open regression (issue 2216) ────────────────────────────────────
// A caller-supplied write-target `env` must NEVER be able to disable the
// guard by simply omitting NODE_ENV. Simulate `createGithubTrackerAdapter`
// passing a sparse env (GH_TOKEN, no NODE_ENV) to the live default `run` —
// the real process IS under test (ambient bun NODE_ENV=test), so the guard
// must still fire even though `env` says nothing about test mode.
test("fail-open closed: sparse caller env without NODE_ENV still guards (createIssue)", async () => {
  await assert.rejects(
    () => createIssue({ repo: "owner/repo", title: "t", body: "b" }, { env: { GH_TOKEN: "x" } }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("isLiveExecutor treats the live runChild and null/undefined as live", () => {
  assert.equal(isLiveExecutor(liveRunChild), true);
  assert.equal(isLiveExecutor(undefined), true);
  assert.equal(isLiveExecutor(null), true);
  assert.equal(isLiveExecutor(async () => ({})), false);
});

// ── AC1/AC3: core write helpers fail closed at the call site (no network) ────
// These run under bun test (NODE_ENV=test). The default `run` is the live seam
// with no attestation, so every write helper must throw BEFORE invoking `run`.
// The repo slug is fake, so even a guard regression cannot mutate a real repo.

test("AC1/AC3 createIssue throws unstubbed in test mode, before any run", async () => {
  await assert.rejects(
    () => createIssue({ repo: "owner/repo", title: "t", body: "b" }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("AC1/AC3 editIssue throws unstubbed in test mode", async () => {
  await assert.rejects(
    () => editIssue({ repo: "owner/repo", issue: 1, title: "t" }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("AC1/AC3 editIssue (close via --state) throws unstubbed in test mode", async () => {
  await assert.rejects(
    () => editIssue({ repo: "owner/repo", issue: 1, state: "closed" }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

test("AC1/AC3 commentIssue throws unstubbed in test mode", async () => {
  await assert.rejects(
    () => commentIssue({ repo: "owner/repo", issue: 1, body: "hi" }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST",
  );
});

// ── AC2: a properly-stubbed call runs unaffected ─────────────────────────────

test("AC2 createIssue with an injected run stub runs normally", async () => {
  const result = await createIssue({ repo: "owner/repo", title: "t", body: "b" }, { run: okIssueCreate });
  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 7);
});

test("AC2 editIssue with an injected run stub runs normally", async () => {
  const result = await editIssue({ repo: "owner/repo", issue: 7, title: "t" }, { run: okEditOrComment });
  assert.equal(result.ok, true);
});

test("AC2 commentIssue with an injected run stub runs normally", async () => {
  const result = await commentIssue({ repo: "owner/repo", issue: 7, body: "hi" }, { run: okEditOrComment });
  assert.equal(result.ok, true);
});

// Guard fires before the run seam even for a non-happy stub sentinel: proves the
// throw is at the guard, not deep in the write.
test("AC3 the run seam is never invoked when the guard fails closed", async () => {
  // Default (live) run + test mode → guard throws; the failIfCalled sentinel is
  // NOT the injected seam here, so we assert the default path throws first.
  await assert.rejects(
    () => createIssue({ repo: "owner/repo", title: "t", body: "b" }),
    (err) => err.code === "GH_WRITE_UNSTUBBED_IN_TEST" && err.message.includes("live GitHub write path"),
  );
  // And when the sentinel IS injected it is a valid (non-live) stub, so the
  // guard passes and the sentinel runs (throwing its own distinct error).
  await assert.rejects(
    () => createIssue({ repo: "owner/repo", title: "t", body: "b" }, { run: failIfCalled }),
    (err) => err.message === "run seam should not be invoked",
  );
});
