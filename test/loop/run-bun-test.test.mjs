import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildBunTestArgs,
  resolveBunTestParallelism,
} from "../../scripts/run-bun-test.mjs";

test("run-bun-test defaults local execution to eight workers", () => {
  assert.equal(resolveBunTestParallelism({}), 8);
  assert.deepEqual(buildBunTestArgs(["test/example.test.mjs"], {}), [
    "test",
    "--only-failures",
    "--parallel=8",
    "test/example.test.mjs",
  ]);
});

test("run-bun-test accepts an explicit bounded CI worker override", () => {
  assert.equal(resolveBunTestParallelism({ BUN_TEST_PARALLELISM: "2" }), 2);
  assert.deepEqual(buildBunTestArgs(["--shard=1/4", "test/example.test.mjs"], { BUN_TEST_PARALLELISM: "2" }), [
    "test",
    "--only-failures",
    "--parallel=2",
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
