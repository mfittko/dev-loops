import assert from "node:assert/strict";
import { test } from "bun:test";
import { EventEmitter } from "node:events";
import { setImmediate as waitForImmediate } from "node:timers/promises";

import {
  buildBunTestArgs,
  runBunTest,
  resolveBunTestFiles,
  resolveBunTestParallelism,
} from "../../scripts/run-bun-test.mjs";

test("run-bun-test defaults local execution to eight workers", () => {
  assert.equal(resolveBunTestParallelism({}), 8);
  assert.deepEqual(buildBunTestArgs(["test/example.test.mjs"], {}), [
    "test",
    "--only-failures",
    "--parallel=8",
    "--no-isolate",
    "test/example.test.mjs",
  ]);
});

test("run-bun-test accepts an explicit bounded CI worker override", () => {
  assert.equal(resolveBunTestParallelism({ BUN_TEST_PARALLELISM: "2" }), 2);
  assert.deepEqual(buildBunTestArgs(["--shard=1/4", "test/example.test.mjs"], { BUN_TEST_PARALLELISM: "2" }), [
    "test",
    "--only-failures",
    "--parallel=2",
    "--no-isolate",
    "--shard=1/4",
    "test/example.test.mjs",
  ]);
});

test("run-bun-test rejects invalid worker overrides", () => {
  for (const value of ["0", "-1", "2.5", "many"]) {
    assert.throws(
      () => resolveBunTestParallelism({ BUN_TEST_PARALLELISM: value }),
      /BUN_TEST_PARALLELISM must be a positive integer/,
    );
  }
});

test("run-bun-test expands a canonical suite while preserving Bun flags", async () => {
  const args = await resolveBunTestFiles(["--suite=core", "--shard=2/4"]);

  assert.equal(args[0], "--shard=2/4");
  assert.ok(args.length > 1);
  assert.ok(args.slice(1).every((file) => file.startsWith("packages/core/test/")));
});

test("run-bun-test expands the complete inventory for the all suite", async () => {
  const args = await resolveBunTestFiles(["--suite=all"]);

  assert.equal(args.length, 346);
  assert.ok(args.includes("test/loop/test-inventory.test.mjs"));
  assert.ok(args.includes("packages/core/test/config.test.mjs"));
  assert.ok(args.includes("skills/dev-loop/scripts/render-template.test.mjs"));
});

test("run-bun-test waits for child close after an execution error", async () => {
  const child = new EventEmitter();
  const result = runBunTest(["test/example.test.mjs"], {
    env: {},
    command: "bun",
    spawnImpl: () => child,
  });
  const outcome = result.then(() => "resolved", () => "rejected");

  await Promise.resolve();
  child.emit("error", new Error("spawn failed"));
  assert.equal(await Promise.race([outcome, waitForImmediate().then(() => "pending")]), "pending");

  child.emit("close", -1);
  await assert.rejects(result, /spawn failed/);
});
