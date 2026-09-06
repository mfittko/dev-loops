import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverRepositoryTests } from "../../scripts/run-bun-test.mjs";
import { refreshTestTimings } from "../../scripts/refresh-test-timings.mjs";

test("timing profile covers the complete inventory", async () => {
  const profile = await Bun.file(process.env.BUN_TEST_TIMINGS_PATH ?? ".bun-test-timings.json").json();
  assert.equal(profile.version, 1);
  assert.deepEqual(Object.keys(profile.files ?? {}).sort(), await discoverRepositoryTests());
  assert.ok(Object.values(profile.files).every((value) => Number.isInteger(value) && value >= 0));
  assert.match(profile.provenance?.bunVersion ?? "", /^1\.4\./);
  assert.equal(profile.provenance?.parallelism, 8);
});

test("successful timing refresh stamps and atomically promotes an exact profile", async () => {
  const observed = { calls: [], writes: [], renames: [] };
  const options = {
    env: { BUN_TEST_PARALLELISM: "2" }, tempPath: ".timings.tmp",
    runTests: async (...args) => { observed.calls.push(args); return 0; },
    readText: async () => observed.writes[0]?.[1] ?? '{"version":1,"files":{"test/example.test.mjs":7,"test/stale.test.mjs":9}}',
    writeText: async (...args) => { observed.writes.push(args); },
    renameFile: async (...args) => { observed.renames.push(args); }, removeFile: async () => {},
    resolveInventory: async () => ["test/example.test.mjs"], resolveCommit: async () => "a".repeat(40),
  };
  assert.equal(await refreshTestTimings(options), 0);
  assert.deepEqual(observed.calls[0][0], ["--timings=.timings.tmp", "--update-timings", "--all"]);
  assert.equal(observed.calls[0][1].env.BUN_TEST_TIMINGS_PATH, ".timings.tmp");
  assert.deepEqual(observed.renames, [[".timings.tmp", ".bun-test-timings.json"]]);
  assert.equal(JSON.parse(observed.writes.at(-1)[1]).provenance.parallelism, 2);
});

test("failed timing refresh removes its temporary profile without promotion", async () => {
  const renames = [], removals = [];
  assert.equal(await refreshTestTimings({
    runTests: async () => 9, readText: async () => '{"version":1,"files":{}}', writeText: async () => {},
    renameFile: async (...args) => { renames.push(args); }, removeFile: async (file) => { removals.push(file); }, tempPath: ".failed.tmp",
  }), 9);
  assert.deepEqual(renames, []);
  assert.deepEqual(removals, [".failed.tmp"]);
});
