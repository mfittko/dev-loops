import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Every test/**/*.test.mjs must be matched by at least one package.json
// test:* suite, or it silently drops out of `npm run verify` — a red test
// nobody runs documents an invariant the repo stopped honoring
// (test/core-runtime-boundary.test.mjs sat red and unrun exactly this way).

const repoRoot = new URL("../../", import.meta.url);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(child);
      continue;
    }
    yield child;
  }
}

const globToRegExp = (glob) =>
  new RegExp(
    `^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`,
  );

test("every test/**/*.test.mjs is covered by a package.json test suite", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", repoRoot), "utf8"));
  const patterns = [];
  for (const command of Object.values(pkg.scripts)) {
    for (const token of command.split(/\s+/)) {
      if (/^test\/.*\.test\.mjs$/.test(token)) {
        patterns.push(globToRegExp(token));
      }
    }
  }
  assert.ok(patterns.length > 0, "expected test file tokens in package.json scripts");

  const testRoot = path.join(repoRoot.pathname, "test");
  const orphans = [];
  for await (const file of walk(testRoot)) {
    if (!file.endsWith(".test.mjs")) continue;
    const relative = path.relative(repoRoot.pathname, file);
    if (!patterns.some((pattern) => pattern.test(relative))) {
      orphans.push(relative);
    }
  }

  assert.deepEqual(
    orphans.sort(),
    [],
    "test files not matched by any package.json suite — wire them into a test:* script",
  );
});
