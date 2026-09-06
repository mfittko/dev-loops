import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverRepositoryTests } from "../../scripts/run-bun-test.mjs";

// Every test/**/*.test.mjs must be matched by a suite that `npm run verify`
// actually reaches, or it silently drops out of enforcement — a red test
// nobody runs documents an invariant the repo stopped honoring
// (test/core-runtime-boundary.test.mjs sat red and unrun exactly this way).
// Coverage is computed from the scripts transitively reachable from the
// `verify` script only: a token in an unreachable script (e.g. a standalone
// helper suite) does not count as coverage.

test("coverage detection resolves real tokens and rejects unknown files", async () => {
  const covered = new Set(await discoverRepositoryTests());
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
  const inventory = await discoverRepositoryTests();
  assert.equal(new Set(inventory).size, inventory.length);
});
