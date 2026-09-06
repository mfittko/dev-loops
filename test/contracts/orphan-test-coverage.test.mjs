import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverRepositoryTests } from "../../scripts/run-bun-test.mjs";
import { VERIFY_SUITES } from "../../scripts/verify.mjs";

test("verify reaches the canonical complete-inventory launcher", async () => {
  const scripts = (await Bun.file("package.json").json()).scripts;
  assert.ok(VERIFY_SUITES.includes("test:all"));
  assert.match(scripts["test:all"], /run-bun-test\.mjs[\s\S]*--all/);
  const covered = new Set(await discoverRepositoryTests());
  assert.ok(covered.has("test/dev-loop-init-phase-smoke.test.mjs"));
  assert.ok(covered.has("test/contracts/orphan-test-coverage.test.mjs"));
  assert.ok(!covered.has("test/__fabricated-orphan__.test.mjs"));
});

test("every test/**/*.test.mjs is covered by a verify-reachable suite", async () => {
  const inventory = await discoverRepositoryTests();
  assert.equal(new Set(inventory).size, inventory.length);
});
