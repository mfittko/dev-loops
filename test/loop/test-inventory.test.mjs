import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverRepositoryTests } from "../../scripts/run-bun-test.mjs";
import { refreshTestTimings } from "../../scripts/refresh-test-timings.mjs";

function inspectTimingCache(profile, inventory) {
  assert.equal(profile?.version, 1);
  assert.ok(profile.files && typeof profile.files === "object" && !Array.isArray(profile.files));
  assert.ok(Object.values(profile.files).every((value) => Number.isInteger(value) && value >= 0));
  assert.match(profile.provenance?.bunVersion ?? "", /^1\.4\./);
  assert.ok(Number.isInteger(profile.provenance?.parallelism) && profile.provenance.parallelism > 0);
  const cached = new Set(Object.keys(profile.files));
  const intended = new Set(inventory);
  return {
    hits: inventory.filter((file) => cached.has(file)),
    misses: inventory.filter((file) => !cached.has(file)),
    stale: [...cached].filter((file) => !intended.has(file)).sort(),
  };
}

test("timing profile is a compatible cache for the current inventory", async () => {
  const profile = await Bun.file(process.env.BUN_TEST_TIMINGS_PATH ?? ".bun-test-timings.json").json();
  inspectTimingCache(profile, await discoverRepositoryTests());
});

test("timing cache tolerates new and stale inventory entries as cache misses", () => {
  const result = inspectTimingCache({
    version: 1,
    files: { "test/present.test.mjs": 12, "test/stale.test.mjs": 34 },
    provenance: { bunVersion: "1.4.1", parallelism: 2 },
  }, ["test/new.test.mjs", "test/present.test.mjs"]);
  assert.deepEqual(result, {
    hits: ["test/present.test.mjs"],
    misses: ["test/new.test.mjs"],
    stale: ["test/stale.test.mjs"],
  });
});

test("timing cache rejects incompatible schema and timing values", () => {
  const provenance = { bunVersion: "1.4.1", parallelism: 1 };
  assert.throws(() => inspectTimingCache({ version: 2, files: {}, provenance }, []));
  assert.throws(() => inspectTimingCache({ version: 1, files: [], provenance }, []));
  assert.throws(() => inspectTimingCache({ version: 1, files: { "test/a.test.mjs": -1 }, provenance }, []));
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
