import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { WAIT_CAP_MS, capWait, pendingFields, resolveTimeoutMs } from "../../scripts/lib/timeout-flag.mjs";

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
    assert.equal(pendingFields({ ...base, argv: ["--timeout-ms", "600000", "--a"] }).reissue, "dev-loops gate x --a --timeout 431");
  });
});

describe("resolveTimeoutMs", () => {
  const run = (raw) => {
    const warnings = [];
    return { ms: resolveTimeoutMs(raw, { warn: (m) => warnings.push(m) }), warnings };
  };
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
  test("--timeout-ms warns on stderr and converts", () => {
    const { ms, warnings } = run({ timeoutMs: "1500" });
    assert.equal(ms, 1500);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /deprecated/);
    assert.match(warnings[0], /--timeout 1\.5/);
  });
  test("--timeout-ms rejects non-integers", () => {
    assert.throws(() => run({ timeoutMs: "1.5" }), /--timeout-ms must be/);
  });
  test("rejects values that overflow to a non-finite budget", () => {
    assert.throws(() => run({ timeout: "9".repeat(400) }), /--timeout must be/);
  });
  test("--timeout-ms rejects values that overflow to a non-finite budget", () => {
    assert.throws(() => run({ timeoutMs: "9".repeat(400) }), /--timeout-ms must be/);
  });
  test("both flags fail closed", () => {
    assert.throws(() => run({ timeout: "1", timeoutMs: "1000" }), /mutually exclusive/);
  });
});
