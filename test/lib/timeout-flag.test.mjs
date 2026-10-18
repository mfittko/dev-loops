import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { resolveTimeoutMs } from "../../scripts/lib/timeout-flag.mjs";

// node:assert only: a bun:test `expect` makes Bun print an "N expect() calls" line before
// the "Ran N tests" summary, which scripts/run-bun-test.mjs parseBunSummary rejects.
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
  test("both flags fail closed", () => {
    assert.throws(() => run({ timeout: "1", timeoutMs: "1000" }), /mutually exclusive/);
  });
});
