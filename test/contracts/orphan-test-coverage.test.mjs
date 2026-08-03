import assert from "node:assert/strict";
import { glob, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Every test/**/*.test.mjs must be matched by a suite that `npm run verify`
// actually reaches, or it silently drops out of enforcement — a red test
// nobody runs documents an invariant the repo stopped honoring
// (test/core-runtime-boundary.test.mjs sat red and unrun exactly this way).
// Coverage is computed from the scripts transitively reachable from the
// `verify` and `test` scripts only: a token in an unreachable script (e.g. a
// standalone helper suite) does not count as coverage.

const repoRootPath = fileURLToPath(new URL("../../", import.meta.url));

async function coveredTestFiles() {
  const pkg = JSON.parse(await readFile(path.join(repoRootPath, "package.json"), "utf8"));
  const queue = ["verify", "test"];
  const visited = new Set();
  const covered = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (visited.has(name) || !pkg.scripts[name]) continue;
    visited.add(name);
    for (const token of pkg.scripts[name].split(/\s+/)) {
      if (/^test:[\w:-]+$/.test(token)) {
        queue.push(token);
        continue;
      }
      if (/^test\/.*\.test\.mjs$/.test(token)) {
        for await (const match of glob(token, { cwd: repoRootPath })) {
          covered.add(match.split(path.sep).join("/"));
        }
      }
    }
  }
  assert.ok(covered.size > 0, "expected test file tokens in verify-reachable scripts");
  return covered;
}

test("coverage detection resolves real tokens and rejects unknown files", async () => {
  const covered = await coveredTestFiles();
  assert.ok(
    covered.has("test/dev-loop-init-phase-smoke.test.mjs"),
    "explicit test:assets token should be covered",
  );
  assert.ok(
    covered.has("test/contracts/orphan-test-coverage.test.mjs"),
    "glob test:assets token should cover this very file",
  );
  assert.ok(!covered.has("test/__fabricated-orphan__.test.mjs"));
});

test("every test/**/*.test.mjs is covered by a verify-reachable suite", async () => {
  const covered = await coveredTestFiles();
  const orphans = [];
  for (const entry of await readdir(path.join(repoRootPath, "test"), {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
    const relative = path
      .relative(repoRootPath, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join("/");
    if (!covered.has(relative)) {
      orphans.push(relative);
    }
  }

  assert.deepEqual(
    orphans.sort(),
    [],
    "test files not reachable from `npm run verify` — wire them into a reachable test:* script",
  );
});
