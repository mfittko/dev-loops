import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { derivePlainSpecs, resolvePlainFiles, aggregateExit, buildJobEnv } from "../scripts/run-verify.mjs";

const REPORTER_MARKER = "--test-reporter ./test/failure-summary-reporter.mjs ";
const PLAIN_SCRIPTS = ["test:assets", "test:scripts", "test:core", "test:dev-loop"];
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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

// Coverage proof: the resolved file set is complete, non-empty, and every
// entry is a real .test.mjs on disk. Per-directory floors make a silent drop
// fail here rather than shipping a smaller-than-expected pool.
test("resolvePlainFiles resolves a complete, on-disk file set", async () => {
  const pkg = await loadPkg();
  const files = resolvePlainFiles(pkg, repoRoot);
  assert.ok(files.length > 0, "resolved file set must be non-empty");
  for (const f of files) {
    assert.ok(f.endsWith(".test.mjs"), `not a .test.mjs file: ${f}`);
    assert.ok(fs.existsSync(path.join(repoRoot, f)), `missing on disk: ${f}`);
  }

  // Sorted + deduped.
  assert.deepEqual(files, [...new Set(files)].sort());

  const countUnder = (prefix) => files.filter((f) => f.startsWith(prefix)).length;
  assert.ok(countUnder("test/github/") >= 31, `test/github floor: ${countUnder("test/github/")}`);
  assert.ok(countUnder("test/loop/") >= 60, `test/loop floor: ${countUnder("test/loop/")}`);
  assert.ok(countUnder("test/pages/") >= 1, `test/pages floor: ${countUnder("test/pages/")}`);
  assert.ok(countUnder("packages/core/test/") >= 1, `core floor: ${countUnder("packages/core/test/")}`);

  // The 3 explicit dev-loop files are literal (non-glob) and must survive.
  for (const f of [
    "skills/dev-loop/scripts/dev-mode-context.test.mjs",
    "skills/dev-loop/scripts/render-template.test.mjs",
    "skills/dev-loop/scripts/post-gate-verdict-fallback.test.mjs",
  ]) {
    assert.ok(files.includes(f), `missing dev-loop file: ${f}`);
  }

  // Every pattern from the plain scripts is covered by >=1 resolved real file.
  for (const pattern of derivePlainSpecs(pkg)) {
    if (pattern.includes("*")) {
      const dir = pattern.slice(0, pattern.lastIndexOf("/") + 1);
      assert.ok(countUnder(dir) >= 1, `pattern ${pattern} covered no files`);
    } else {
      assert.ok(files.includes(pattern), `literal pattern dropped: ${pattern}`);
    }
  }
});

test("resolvePlainFiles throws when a glob matches nothing (fail-closed)", () => {
  const scripts = {};
  for (const name of PLAIN_SCRIPTS) {
    scripts[name] = `node --test ${REPORTER_MARKER}real.test.mjs`;
  }
  scripts["test:scripts"] =
    `node --test ${REPORTER_MARKER}test/__nonexistent__/*.test.mjs`;
  assert.throws(
    () => resolvePlainFiles({ scripts }, repoRoot),
    /glob pattern matched no files: test\/__nonexistent__\/\*\.test\.mjs/,
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
