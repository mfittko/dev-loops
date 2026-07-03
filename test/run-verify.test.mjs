import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { derivePlainSpecs, aggregateExit, buildJobEnv } from "../scripts/run-verify.mjs";

const REPORTER_MARKER = "--test-reporter ./test/failure-summary-reporter.mjs ";
const PLAIN_SCRIPTS = ["test:assets", "test:scripts", "test:core", "test:dev-loop"];

async function loadPkg() {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
}

// File-set-unchanged guard: the merged pool must cover exactly the spec args of
// the four plain test:* scripts, independently re-parsed here.
test("derivePlainSpecs equals the union of the plain scripts' spec args", async () => {
  const pkg = await loadPkg();
  const expected = [];
  for (const name of PLAIN_SCRIPTS) {
    const tail = pkg.scripts[name].split(REPORTER_MARKER)[1].trim();
    for (const arg of tail.split(/\s+/)) if (arg) expected.push(arg);
  }
  assert.deepEqual(derivePlainSpecs(pkg), expected);
});

test("derivePlainSpecs throws when a plain script is missing", () => {
  assert.throws(
    () => derivePlainSpecs({ scripts: {} }),
    /missing script test:assets in package\.json/,
  );
});

test("derivePlainSpecs throws when a script omits the reporter marker", () => {
  const scripts = {};
  for (const name of PLAIN_SCRIPTS) scripts[name] = "node --test some.test.mjs";
  assert.throws(
    () => derivePlainSpecs({ scripts }),
    /script test:assets does not use the failure-summary reporter/,
  );
});

test("buildJobEnv disables git fsync when GIT_CONFIG_COUNT is unset", () => {
  const env = buildJobEnv({ PATH: "/bin" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.GIT_CONFIG_COUNT, "2");
  assert.equal(env.GIT_CONFIG_KEY_0, "core.fsync");
  assert.equal(env.GIT_CONFIG_VALUE_0, "none");
});

test("buildJobEnv leaves a caller's existing GIT_CONFIG untouched", () => {
  const base = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" };
  assert.deepEqual(buildJobEnv(base), base);
});

test("aggregateExit is 0 only when every job exits 0", () => {
  assert.equal(aggregateExit([0, 0, 0]), 0);
  assert.equal(aggregateExit([0]), 0);
  assert.equal(aggregateExit([0, 1, 0]), 1);
  assert.equal(aggregateExit([1]), 1);
  assert.equal(aggregateExit([0, 2, 0]), 1);
});
