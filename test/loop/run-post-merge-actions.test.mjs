import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { runPostMergeActions } from "@dev-loops/core/loop/run-post-merge-actions";

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    delay: async (ms) => {
      t += ms;
    },
  };
}

function action(overrides = {}) {
  return {
    name: "action",
    run: "run-command",
    onlyIfChanged: null,
    verify: null,
    timeoutMs: 1000,
    verifyTimeoutMs: 1000,
    verifyIntervalMs: 100,
    ...overrides,
  };
}

describe("runPostMergeActions (#1457)", () => {
  test("runs every action sequentially, in declared order", async () => {
    const calls = [];
    const exec = async (command) => {
      calls.push(command);
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "a", run: "run-a" }), action({ name: "b", run: "run-b" }), action({ name: "c", run: "run-c" })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.deepEqual(calls, ["run-a", "run-b", "run-c"]);
    assert.deepEqual(result.results.map((r) => r.name), ["a", "b", "c"]);
    assert.deepEqual(result.results.map((r) => r.status), ["ok", "ok", "ok"]);
    assert.equal(result.ok, true);
  });

  test("cwd passed to exec is always the resolved main checkout, never re-derived per action", async () => {
    const cwds = [];
    const exec = async (command, { cwd }) => {
      cwds.push(cwd);
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "a" }), action({ name: "b" })];

    await runPostMergeActions({ actions, changedPaths: null, cwd: "/main/checkout" }, { exec, ...makeClock() });

    assert.deepEqual(cwds, ["/main/checkout", "/main/checkout"]);
  });

  test("onlyIfChanged: a matching substring runs the action", async () => {
    const calls = [];
    const exec = async (command) => {
      calls.push(command);
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "restart", run: "make restart", onlyIfChanged: ["src/"] })];

    const result = await runPostMergeActions(
      { actions, changedPaths: ["src/app.js", "README.md"], cwd: "/repo" },
      { exec, ...makeClock() },
    );

    assert.deepEqual(calls, ["make restart"]);
    assert.equal(result.results[0].status, "ok");
  });

  test("onlyIfChanged: no changed path matches — the action is skipped and the reason is recorded", async () => {
    const calls = [];
    const exec = async (command) => {
      calls.push(command);
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "restart", run: "make restart", onlyIfChanged: ["src/"] })];

    const result = await runPostMergeActions(
      { actions, changedPaths: ["README.md", "docs/guide.md"], cwd: "/repo" },
      { exec, ...makeClock() },
    );

    assert.deepEqual(calls, [], "the run command must never execute for a skipped action");
    assert.equal(result.results[0].status, "skipped");
    assert.match(result.results[0].detail, /onlyIfChanged/);
    assert.equal(result.ok, true, "a clean skip is not a failure");
  });

  test("onlyIfChanged: unresolved changed-file list bypasses scoping (runs unscoped) and logs why", async () => {
    const calls = [];
    const logs = [];
    const exec = async (command) => {
      calls.push(command);
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "restart", run: "make restart", onlyIfChanged: ["src/"] })];

    const result = await runPostMergeActions(
      { actions, changedPaths: null, changedPathsUnavailableReason: "no PR number", cwd: "/repo" },
      { exec, log: (msg) => logs.push(msg), ...makeClock() },
    );

    assert.deepEqual(calls, ["make restart"], "onlyIfChanged must not silently skip when scoping is unresolved");
    assert.equal(result.results[0].status, "ok");
    assert.ok(
      logs.some((l) => l.includes("WARNING") && l.includes("no PR number")),
      `expected a warning stating why scoping was bypassed, got: ${JSON.stringify(logs)}`,
    );
  });

  test("an action with no onlyIfChanged always runs, scoping known or not", async () => {
    const calls = [];
    const exec = async (command) => {
      calls.push(command);
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "always", run: "always-run" })];

    await runPostMergeActions({ actions, changedPaths: ["README.md"], cwd: "/repo" }, { exec, ...makeClock() });
    assert.deepEqual(calls, ["always-run"]);
  });

  test("a non-zero exit fails the action but subsequent actions still run", async () => {
    const calls = [];
    const exec = async (command) => {
      calls.push(command);
      if (command === "run-a") return { code: 1, killed: false, stdout: "", stderr: "boom" };
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "a", run: "run-a" }), action({ name: "b", run: "run-b" })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.deepEqual(calls, ["run-a", "run-b"], "action b must still run after action a fails");
    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].detail, /exit code 1/);
    assert.match(result.results[0].detail, /boom/);
    assert.equal(result.results[1].status, "ok");
    assert.equal(result.ok, false, "the overall result is a failure when any action failed");
  });

  test("a killed (timed-out) run reports the action as failed with the timeout named", async () => {
    const exec = async () => ({ code: null, killed: true, stdout: "", stderr: "" });
    const actions = [action({ name: "slow", run: "sleep 999", timeoutMs: 5000 })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].detail, /timed out after 5000ms/);
    assert.equal(result.ok, false);
  });

  test("an exec rejection is treated as a run failure, not an unhandled rejection", async () => {
    const exec = async () => {
      throw new Error("spawn ENOENT");
    };
    const actions = [action({ name: "a" })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].detail, /spawn ENOENT/);
  });

  test("verify: polls until it exits 0, using the injected clock (no real waiting)", async () => {
    let verifyCalls = 0;
    const exec = async (command) => {
      if (command === "run-it") return { code: 0, killed: false, stdout: "", stderr: "" };
      // verify command: fail twice, then succeed
      verifyCalls += 1;
      if (verifyCalls < 3) return { code: 1, killed: false, stdout: "", stderr: "" };
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "svc", run: "run-it", verify: "curl -f /health", verifyTimeoutMs: 10000, verifyIntervalMs: 1000 })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.equal(verifyCalls, 3);
    assert.equal(result.results[0].status, "ok");
  });

  test("verify: exhausting the verify timeout without a 0 exit fails the action", async () => {
    const exec = async (command) => {
      if (command === "run-it") return { code: 0, killed: false, stdout: "", stderr: "" };
      return { code: 1, killed: false, stdout: "", stderr: "" }; // verify never succeeds
    };
    const actions = [action({ name: "svc", run: "run-it", verify: "curl -f /health", verifyTimeoutMs: 3000, verifyIntervalMs: 1000 })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].detail, /verify exhausted after 3000ms/);
    assert.equal(result.ok, false);
  });

  test("verify never runs when the run command itself fails", async () => {
    let verifyCalled = false;
    const exec = async (command) => {
      if (command === "run-it") return { code: 1, killed: false, stdout: "", stderr: "run failed" };
      verifyCalled = true;
      return { code: 0, killed: false, stdout: "", stderr: "" };
    };
    const actions = [action({ name: "svc", run: "run-it", verify: "curl -f /health" })];

    const result = await runPostMergeActions({ actions, changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });

    assert.equal(verifyCalled, false);
    assert.equal(result.results[0].status, "failed");
    assert.match(result.results[0].detail, /run failed/);
  });

  test("exit-code contract: ok is true when every action ran or was skipped cleanly", async () => {
    const exec = async () => ({ code: 0, killed: false, stdout: "", stderr: "" });
    const actions = [
      action({ name: "runs", run: "run-a" }),
      action({ name: "skipped", run: "run-b", onlyIfChanged: ["src/"] }),
    ];

    const result = await runPostMergeActions({ actions, changedPaths: ["README.md"], cwd: "/repo" }, { exec, ...makeClock() });

    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((r) => r.status), ["ok", "skipped"]);
  });

  test("no declared actions is a clean no-op", async () => {
    const exec = async () => {
      throw new Error("must never be called");
    };
    const result = await runPostMergeActions({ actions: [], changedPaths: null, cwd: "/repo" }, { exec, ...makeClock() });
    assert.deepEqual(result, { ok: true, results: [] });
  });
});
