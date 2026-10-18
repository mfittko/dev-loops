import { describe, expect, test } from "bun:test";
import { resolveTimeoutMs } from "../../scripts/lib/timeout-flag.mjs";

describe("resolveTimeoutMs", () => {
  const run = (raw) => {
    const warnings = [];
    return { ms: resolveTimeoutMs(raw, { warn: (m) => warnings.push(m) }), warnings };
  };
  test("absent flags yield undefined", () => expect(run({}).ms).toBeUndefined());
  test("accepts 0, fractions and integers in seconds", () => {
    expect(run({ timeout: "0" }).ms).toBe(0);
    expect(run({ timeout: "0.1" }).ms).toBe(100);
    expect(run({ timeout: "90" }).ms).toBe(90_000);
  });
  test("rejects negative, exponent and junk values", () => {
    for (const bad of ["-1", "1e3", "abc", "", "1."]) {
      expect(() => run({ timeout: bad })).toThrow("--timeout must be");
    }
  });
  test("--timeout-ms warns on stderr and converts", () => {
    const { ms, warnings } = run({ timeoutMs: "1500" });
    expect(ms).toBe(1500);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deprecated");
    expect(warnings[0]).toContain("--timeout 1.5");
  });
  test("--timeout-ms rejects non-integers", () => {
    expect(() => run({ timeoutMs: "1.5" })).toThrow("--timeout-ms must be");
  });
  test("both flags fail closed", () => {
    expect(() => run({ timeout: "1", timeoutMs: "1000" })).toThrow("mutually exclusive");
  });
});
