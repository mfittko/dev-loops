import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  BUN_TEST_SUITE_NAMES,
  discoverRepositoryTests,
  resolveTestInventory,
} from "../../scripts/test-inventory.mjs";
import { refreshTestTimings } from "../../scripts/refresh-test-timings.mjs";

test("canonical Bun suites cover every repository test exactly once", async () => {
  const inventory = await resolveTestInventory();
  const discovered = await discoverRepositoryTests();

  assert.equal(inventory.length, 346);
  assert.deepEqual(inventory, discovered);
  assert.equal(new Set(inventory).size, inventory.length);
});

test("individual suite inventories compose the complete inventory without overlap", async () => {
  const suites = await Promise.all(
    BUN_TEST_SUITE_NAMES.map(async (suite) => [suite, await resolveTestInventory({ suites: [suite] })]),
  );
  const composed = suites.flatMap(([, files]) => files).sort();

  assert.deepEqual(composed, await resolveTestInventory());
  for (const [suite, files] of suites) {
    assert.ok(files.length > 0, `${suite} must resolve at least one test file`);
  }
});

test("timing profile covers the canonical inventory exactly", async () => {
  const profile = await Bun.file(".bun-test-timings.json").json();
  const profiledFiles = Object.keys(profile.files ?? {}).sort();
  const inventory = await resolveTestInventory();

  assert.equal(profile.version, 1);
  assert.deepEqual(profiledFiles, inventory);
  assert.ok(Object.values(profile.files).every((duration) => Number.isInteger(duration) && duration >= 0));
  assert.match(profile.provenance?.bunVersion ?? "", /^1\.4\./);
  assert.match(profile.provenance?.sourceCommit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(profile.provenance?.parallelism, 8);
  assert.equal(profile.provenance?.method, "complete canonical inventory, one Bun worker queue, --no-isolate, --update-timings");
});

test("unknown suite names fail closed", async () => {
  await assert.rejects(
    resolveTestInventory({ suites: ["missing"] }),
    /Unknown Bun test suite: missing/,
  );
});

test("timing refresh covers the complete inventory and records its provenance after success", async () => {
  const calls = [];
  const writes = [];
  const renames = [];
  const tempPath = ".bun-test-timings.json.tmp-test";
  const profileText = JSON.stringify({ version: 1, files: { "test/example.test.mjs": 7 } });
  const exitCode = await refreshTestTimings({
    env: { BUN_TEST_PARALLELISM: "2" },
    runTests: async (args, options) => {
      calls.push({ args, options });
      return 0;
    },
    readText: async () => profileText,
    writeText: async (file, text, encoding) => {
      writes.push({ file, text, encoding });
    },
    renameFile: async (from, to) => { renames.push({ from, to }); },
    removeFile: async () => {},
    resolveInventory: async () => ["test/example.test.mjs"],
    resolveCommit: async () => "a".repeat(40),
    tempPath,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls[0].args, [`--timings=${tempPath}`, "--update-timings", "--suite=all"]);
  assert.equal(calls[0].options.env.BUN_TEST_PARALLELISM, "2");
  assert.deepEqual(renames, [{ from: tempPath, to: ".bun-test-timings.json" }]);
  const stamped = JSON.parse(writes.at(-1).text);
  assert.equal(stamped.files["test/example.test.mjs"], 7);
  assert.equal(stamped.provenance.sourceCommit, "a".repeat(40));
  assert.equal(stamped.provenance.parallelism, 2);
});

test("timing refresh does not rewrite a profile from a failed run", async () => {
  const writes = [];
  const renames = [];
  const removals = [];
  const exitCode = await refreshTestTimings({
    runTests: async () => 9,
    readText: async () => "{\"version\":1,\"files\":{}}",
    writeText: async (file) => { writes.push(file); },
    renameFile: async (...args) => { renames.push(args); },
    removeFile: async (file) => { removals.push(file); },
    tempPath: ".bun-test-timings.json.tmp-failed-test",
  });

  assert.equal(exitCode, 9);
  assert.deepEqual(writes, [".bun-test-timings.json.tmp-failed-test"]);
  assert.deepEqual(renames, []);
  assert.deepEqual(removals, [".bun-test-timings.json.tmp-failed-test"]);
});
