import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "bun:test";
import { WAIT_CAP_MS, capWait, pendingFields, resolveTimeoutMs } from "../../scripts/lib/timeout-flag.mjs";

describe("removed --timeout-ms alias", () => {
  const scripts = {
    "probe-ci-status.mjs": ["scripts/github/probe-ci-status.mjs", ["--repo", "o/r", "--pr", "1"]],
    "probe-copilot-review.mjs": ["scripts/github/probe-copilot-review.mjs", ["--repo", "o/r", "--pr", "1"]],
    "wait-pr-checks.mjs": ["scripts/github/wait-pr-checks.mjs", ["--repo", "o/r", "--pr", "1"]],
    "wait-for-gate-units.mjs": ["scripts/loop/wait-for-gate-units.mjs", ["--emit-plan", "a", "--tmp-root", "t"]],
    "watch-initial-copilot-pr.mjs": ["scripts/loop/watch-initial-copilot-pr.mjs", ["--repo", "o/r", "--issue", "1"]],
  };
  for (const [name, [script, base]] of Object.entries(scripts)) {
    test(`${name} rejects --timeout-ms as an unknown argument`, () => {
      const result = spawnSync(process.execPath, [path.resolve(script), ...base, "--timeout-ms", "1000"], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stdout}${result.stderr}`, /unknown (argument|option).*--timeout-ms/i);
    });
  }
});

describe("capWait / pendingFields (GATE-EXEC-BOUNDED-WAIT-CAP)", () => {
  test("caps one invocation at about 170 s and carries the rest", () => {
    assert.equal(WAIT_CAP_MS, 170_000);
    assert.deepEqual(capWait(600_000), { timeoutMs: 170_000, remainingMs: 430_000 });
  });
  test("a request at or under the cap and 0 are unchanged", () => {
    assert.deepEqual(capWait(170_000), { timeoutMs: 170_000, remainingMs: 0 });
    assert.deepEqual(capWait(30_000), { timeoutMs: 30_000, remainingMs: 0 });
    assert.deepEqual(capWait(0), { timeoutMs: 0, remainingMs: 0 });
  });
  test("pendingFields re-issues the same args with only the remaining --timeout", () => {
    const base = { remainingMs: 430_500, command: "dev-loops gate x" };
    const out = pendingFields({ ...base, argv: ["--repo", "o/r", "--timeout", "600", "--jq", ".a b"] });
    assert.equal(out.outcome, "pending");
    assert.equal(out.remainingTimeoutSeconds, 431);
    assert.equal(out.reissue, "dev-loops gate x --repo o/r --jq '.a b' --timeout 431");
    assert.equal(pendingFields({ ...base, argv: ["--timeout=600", "--a"] }).reissue, "dev-loops gate x --a --timeout 431");
    const carried = pendingFields({ ...base, argv: ["--a", "--baseline-sha", "old", "--timeout", "9"], carry: { "--baseline-sha": "abc", "--stall": null } });
    assert.equal(carried.reissue, "dev-loops gate x --a --baseline-sha abc --timeout 431");
    const inline = pendingFields({ ...base, argv: ["--a", "--baseline-sha=old", "--timeout", "9"], carry: { "--baseline-sha": "abc" } });
    assert.equal(inline.reissue, "dev-loops gate x --a --baseline-sha abc --timeout 431");
    const bare = pendingFields({ ...base, argv: ["--resumed", "--a", "--timeout", "9"], carry: { "--resumed": true } });
    assert.equal(bare.reissue, "dev-loops gate x --a --resumed --timeout 431");
  });
});

describe("resolveTimeoutMs", () => {
  const run = (raw) => ({ ms: resolveTimeoutMs(raw) });
  test("absent flags yield undefined", () => assert.equal(run({}).ms, undefined));
  test("accepts 0, fractions and integers in seconds", () => {
    assert.equal(run({ timeout: "0" }).ms, 0);
    assert.equal(run({ timeout: "0.1" }).ms, 100);
    assert.equal(run({ timeout: "90" }).ms, 90_000);
    assert.equal(run({ timeout: "0.0004" }).ms, 1);
  });
  test("rejects negative, exponent and junk values", () => {
    for (const bad of ["-1", "1e3", "abc", "", "1."]) {
      assert.throws(() => run({ timeout: bad }), /--timeout must be/);
    }
  });
  test("rejects values that overflow to a non-finite budget", () => {
    assert.throws(() => run({ timeout: "9".repeat(400) }), /--timeout must be/);
  });
});
