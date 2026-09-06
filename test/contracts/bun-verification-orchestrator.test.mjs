import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "bun:test";
import { VERIFY_SUITES, runSuite, runVerification } from "../../scripts/verify.mjs";

describe("Bun verification orchestrator", () => {
  test("attempts every canonical suite", async () => {
    const attempted = [];
    const result = await runVerification({ execute: async (suite) => { attempted.push(suite); return 0; } });
    assert.deepEqual(attempted.sort(), [...VERIFY_SUITES].sort());
    assert.deepEqual(VERIFY_SUITES, ["test:all", "test:docs", "test:workflows"]);
    assert.equal(result.ok, true);
  });

  test("waits for every suite and aggregates any nonzero result", async () => {
    const attempted = [];
    const result = await runVerification({
      execute: async (suite) => {
        attempted.push(suite);
        return suite === "test:all" || suite === "test:workflows" ? 7 : 0;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(attempted.length, VERIFY_SUITES.length);
    assert.deepEqual(result.results.filter(({ exitCode }) => exitCode !== 0), [
      { suite: "test:all", exitCode: 7 },
      { suite: "test:workflows", exitCode: 7 },
    ]);
  });

  test("suite spawn errors settle only after the child closes", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let settled = false;
    const resultPromise = runSuite("test:all", {
      spawnImpl: () => child,
      stdout: { write() {} },
      stderr: { write() {} },
    }).then((code) => {
      settled = true;
      return code;
    });

    child.emit("error", new Error("spawn failed"));
    await Promise.resolve();
    assert.equal(settled, false);
    child.emit("close", null);
    assert.equal(await resultPromise, 1);
  });
});
