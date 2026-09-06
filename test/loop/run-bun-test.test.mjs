import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "bun:test";
import { buildBunTestArgs, childResult, discoverRepositoryTests, resolveBunTestFiles, resolveBunTestParallelism } from "../../scripts/run-bun-test.mjs";

test("launcher applies local and CI parallelism with failure-only shared workers", () => {
  assert.deepEqual(buildBunTestArgs(["example.test.mjs"], {}), ["test", "--only-failures", "--parallel=8", "--no-isolate", "example.test.mjs"]);
  assert.deepEqual(buildBunTestArgs(["--shard=1/4"], { BUN_TEST_PARALLELISM: "2" }), ["test", "--only-failures", "--parallel=2", "--no-isolate", "--shard=1/4"]);
  for (const value of ["0", "-1", "2.5", "many"]) assert.throws(
    () => resolveBunTestParallelism({ BUN_TEST_PARALLELISM: value }),
    /positive integer/,
  );
});

test("launcher expands the complete inventory without consuming Bun flags", async () => {
  const args = await resolveBunTestFiles(["--shard=2/4", "--all"]);
  assert.equal(args[0], "--shard=2/4");
  assert.deepEqual(args.slice(1), await discoverRepositoryTests());
  for (const file of ["test/loop/test-inventory.test.mjs", "packages/core/test/config.test.mjs", "skills/dev-loop/scripts/render-template.test.mjs"]) assert.ok(args.includes(file));
});

test("shared child result waits for close after a spawn error", async () => {
  const child = new EventEmitter();
  let settled = false;
  const result = childResult(child).then((value) => { settled = true; return value; });
  await Promise.resolve();
  const error = new Error("spawn failed");
  child.emit("error", error);
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit("close", -1);
  assert.deepEqual(await result, { code: -1, error });
});
