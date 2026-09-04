import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { VERIFY_SUITES, runVerification } from "../../scripts/verify.mjs";

describe("Bun verification orchestrator", () => {
  test("attempts every canonical suite", async () => {
    const attempted = [];
    const result = await runVerification({ execute: async (suite) => { attempted.push(suite); return 0; } });
    assert.deepEqual(attempted.sort(), [...VERIFY_SUITES].sort());
    assert.equal(result.ok, true);
  });

  test("waits for every suite and aggregates any nonzero result", async () => {
    const attempted = [];
    const result = await runVerification({
      execute: async (suite) => {
        attempted.push(suite);
        return suite === "test:core" || suite === "test:pack" ? 7 : 0;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(attempted.length, VERIFY_SUITES.length);
    assert.deepEqual(result.results.filter(({ exitCode }) => exitCode !== 0), [
      { suite: "test:core", exitCode: 7 },
      { suite: "test:pack", exitCode: 7 },
    ]);
  });
});
