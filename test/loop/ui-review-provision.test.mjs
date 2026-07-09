import assert from "node:assert/strict";
import test, { after } from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionAndBoot } from "@dev-loops/core/loop/ui-review-provision";
import { loadDevLoopConfig, resolveUiReviewRunRecipe, DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN } from "@dev-loops/core/config";
import { parseUiReviewProvisionCliArgs, ensureOwnNodeModules, inspectMigrations } from "../../scripts/loop/ui-review-provision.mjs";

// A "fixture project": a temp dir whose .devloops declares a ui-review run
// recipe. The real config resolver reads it; the rest of the IO is injected.
const tempRoots = [];
function makeFixture(devloops) {
  const root = mkdtempSync(path.join(tmpdir(), "ui-prov-"));
  writeFileSync(path.join(root, ".devloops"), devloops);
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
}
);

// Deterministic clock: delay() advances a mutable counter that now() reads, so
// the readiness poll's timeout is exercised without any real sleeping.
function fakeClock() {
  const state = { t: 0 };
  return {
    now: () => state.t,
    delay: (ms) => {
      state.t += ms;
      return Promise.resolve();
    },
  };
}

const RECIPE_YAML = `version: 1
uiReview:
  run:
    command: "true"
    readyUrl: "http://127.0.0.1:65535/health"
    readyTimeoutMs: 5000
    readyIntervalMs: 1000
`;

const RECIPE_WITH_MIGRATE_YAML = `version: 1
uiReview:
  run:
    command: "true"
    readyUrl: "http://127.0.0.1:65535/health"
    readyTimeoutMs: 5000
    readyIntervalMs: 1000
    migrate:
      statusCommand: "true"
      applyCommand: "true"
`;

// Base seams: a provisioned worktree, a clean guard, no dep delta, no migrate,
// a no-op boot. Individual tests override probe/recipe/etc.
function baseSeams(root, overrides = {}) {
  const clock = fakeClock();
  const logs = [];
  return {
    seams: {
      ensureWorktree: async () => ({ path: root, created: true, reused: false }),
      assertNotPrimary: () => ({ ok: true, mainWorktreePath: "/some/main" }),
      detectDepDelta: async () => ({ changed: false, detail: "identical" }),
      installDeps: async () => ({ ok: true, detail: "npm install" }),
      resolveRunRecipe: async (wt) => resolveUiReviewRunRecipe((await loadDevLoopConfig({ repoRoot: wt })).config),
      inspectMigrations: async () => ({ pending: [], destructive: [], detail: "none" }),
      applyMigrations: async () => ({ ok: true, applied: 0, detail: "n/a" }),
      bootApp: async () => ({ pid: 4242, detail: "spawned" }),
      probe: async () => false,
      now: clock.now,
      delay: clock.delay,
      log: (m) => logs.push(m),
      ...overrides,
    },
    logs,
  };
}

test("parseUiReviewProvisionCliArgs: requires --repo-root and --pr", () => {
  assert.throws(() => parseUiReviewProvisionCliArgs(["--pr", "5"]), /repo-root/);
  assert.throws(() => parseUiReviewProvisionCliArgs(["--repo-root", "/r"]), /--pr/);
});

test("parseUiReviewProvisionCliArgs: rejects a non-integer --pr", () => {
  assert.throws(() => parseUiReviewProvisionCliArgs(["--repo-root", "/r", "--pr", "abc"]), /positive integer/);
  assert.throws(() => parseUiReviewProvisionCliArgs(["--repo-root", "/r", "--pr", "0"]), /positive integer/);
});

test("parseUiReviewProvisionCliArgs: parses pr, branch, ack flag", () => {
  const o = parseUiReviewProvisionCliArgs(["--repo-root", "/r", "--pr", "12", "--branch", "b", "--ack-destructive-migration"]);
  assert.equal(o.repoRoot, "/r");
  assert.equal(o.pr, 12);
  assert.equal(o.branch, "b");
  assert.equal(o.ackDestructiveMigration, true);
});

test("readiness-probe success: app becomes ready within the timeout", async () => {
  const root = makeFixture(RECIPE_YAML);
  let calls = 0;
  const { seams, logs } = baseSeams(root, {
    probe: async () => {
      calls += 1;
      return calls >= 2; // not ready on the first poll, ready on the second
    },
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 7 }, seams);

  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);
  assert.equal(result.stopReason, null);
  assert.equal(result.boot.ready, true);
  assert.equal(result.boot.attempts, 2);
  assert.equal(result.worktreePath, root);
  // The install-skipped cap is logged, not silently dropped.
  assert.ok(logs.some((l) => /install skipped/.test(l)));
  assert.ok(logs.some((l) => /app ready/.test(l)));
});

test("boot-timeout stop: probe never succeeds -> stop with a stated reason", async () => {
  const root = makeFixture(RECIPE_YAML);
  const { seams, logs } = baseSeams(root, { probe: async () => false });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 8 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /readiness probe timed out after 5000ms/);
  assert.equal(result.boot.ready, false);
  assert.ok(result.findings.some((f) => f.kind === "boot-timeout"));
  // The boot-timeout cap is logged (no silent truncation).
  assert.ok(logs.some((l) => /boot timeout/.test(l)));
});

test("no run recipe -> fail-closed stop before boot", async () => {
  const root = makeFixture("version: 1\n"); // no uiReview.run
  const { seams } = baseSeams(root);

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 9 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /no run recipe/);
  assert.ok(result.findings.some((f) => f.kind === "run-recipe-missing"));
});

test("destructive migration requires explicit ack (fail closed)", async () => {
  const root = makeFixture(RECIPE_WITH_MIGRATE_YAML);
  const inspectMigrations = async () => ({
    pending: ["DROP TABLE users"],
    destructive: ["DROP TABLE users"],
    detail: "1 destructive",
  });
  let applied = false;

  // Without ack: stops, nothing applied.
  const blocked = await provisionAndBoot(
    { repoRoot: "/main", pr: 10 },
    baseSeams(root, { inspectMigrations, applyMigrations: async () => { applied = true; return { ok: true, applied: 1, detail: "x" }; } }).seams,
  );
  assert.equal(blocked.ok, false);
  assert.equal(applied, false);
  assert.ok(blocked.findings.some((f) => f.kind === "destructive-migration" && f.requiresAck === true));

  // With ack: proceeds past migrations (then boots + is probed).
  let probed = 0;
  const acked = await provisionAndBoot(
    { repoRoot: "/main", pr: 10, ackDestructiveMigration: true },
    baseSeams(root, {
      inspectMigrations,
      applyMigrations: async () => ({ ok: true, applied: 1, detail: "applied" }),
      probe: async () => (++probed >= 1),
    }).seams,
  );
  assert.equal(acked.ok, true);
  assert.equal(acked.migrations.applied, 1);
});

test("dependency-lock delta triggers a scoped install (logged)", async () => {
  const root = makeFixture(RECIPE_YAML);
  let installed = false;
  const { seams, logs } = baseSeams(root, {
    detectDepDelta: async () => ({ changed: true, detail: "package-lock.json differs" }),
    installDeps: async () => { installed = true; return { ok: true, detail: "npm install" }; },
    probe: async () => true,
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 11 }, seams);

  assert.equal(result.ok, true);
  assert.equal(installed, true);
  assert.equal(result.depInstall.installed, true);
  assert.ok(logs.some((l) => /delta detected/.test(l)));
});

test("dependency install failure -> fail-closed stop before boot", async () => {
  const root = makeFixture(RECIPE_YAML);
  let booted = false;
  const { seams } = baseSeams(root, {
    detectDepDelta: async () => ({ changed: true, detail: "differs" }),
    installDeps: async () => ({ ok: false, detail: "npm ERR! boom" }),
    bootApp: async () => { booted = true; return { pid: 1, detail: "spawned" }; },
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 20 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /dependency install failed/);
  assert.ok(result.findings.some((f) => f.kind === "dep-install"));
  assert.equal(booted, false); // never boots after a failed install
});

test("migration apply failure -> fail-closed stop before boot", async () => {
  const root = makeFixture(RECIPE_WITH_MIGRATE_YAML);
  let booted = false;
  const { seams } = baseSeams(root, {
    inspectMigrations: async () => ({ pending: ["001_add_col"], destructive: [], detail: "1 pending" }),
    applyMigrations: async () => ({ ok: false, applied: 0, detail: "apply failed: exit 1" }),
    bootApp: async () => { booted = true; return { pid: 1, detail: "spawned" }; },
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 21 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /migration apply failed/);
  assert.ok(result.findings.some((f) => f.kind === "migration-apply"));
  assert.equal(result.migrations.applied, 0);
  assert.equal(booted, false); // a failed apply never proceeds to boot
});

test("worktree guard: refuses to operate in the primary checkout", async () => {
  const root = makeFixture(RECIPE_YAML);
  let booted = false;
  const { seams } = baseSeams(root, {
    assertNotPrimary: () => ({ ok: false, message: "/repo resolves to the primary checkout" }),
    bootApp: async () => { booted = true; return { pid: 1, detail: "spawned" }; },
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 22 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /primary checkout/);
  assert.ok(result.findings.some((f) => f.kind === "worktree-guard"));
  assert.equal(booted, false);
});

test("ensureOwnNodeModules: materializes a symlinked node_modules without touching the primary", () => {
  // Primary checkout with a real node_modules holding one package.
  const primary = mkdtempSync(path.join(tmpdir(), "ui-prov-primary-"));
  tempRoots.push(primary);
  const primaryNm = path.join(primary, "node_modules");
  mkdirSync(path.join(primaryNm, "left-pad"), { recursive: true });
  writeFileSync(path.join(primaryNm, "left-pad", "index.js"), "module.exports = 1;\n");

  // Worktree whose node_modules is a symlink into the primary (linkOnInit).
  const worktree = mkdtempSync(path.join(tmpdir(), "ui-prov-wt-"));
  tempRoots.push(worktree);
  symlinkSync(primaryNm, path.join(worktree, "node_modules"));

  const materialized = ensureOwnNodeModules(worktree);

  assert.equal(materialized, true);
  // Worktree now owns a real (empty) node_modules — not a symlink.
  const st = lstatSync(path.join(worktree, "node_modules"));
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isDirectory(), true);
  assert.deepEqual(readdirSync(path.join(worktree, "node_modules")), []);
  // The primary's real node_modules is untouched — an install would go here
  // if we had written through the symlink.
  assert.deepEqual(readdirSync(primaryNm), ["left-pad"]);
});

test("inspectMigrations: a failing statusCommand fails closed with a non-empty destructive[]", async () => {
  // The decision seam: if migration state cannot be verified, it must synthesize
  // a destructive finding so the orchestrator blocks (not return destructive: []).
  const worktree = mkdtempSync(path.join(tmpdir(), "ui-prov-migrate-"));
  tempRoots.push(worktree);
  const recipe = { migrate: { statusCommand: "exit 1", applyCommand: "true", destructivePattern: "drop" } };

  const result = await inspectMigrations({ worktreePath: worktree, recipe });

  assert.ok(result.destructive.length > 0);
  assert.match(result.destructive[0], /migration status failed/);
});

test("inspectMigrations: DEFAULT destructive pattern flags a real DROP TABLE line end-to-end", async () => {
  // Positive path: exercise the real regex-match against the shipped default
  // pattern (no destructivePattern override) so a broken default fails the suite
  // instead of failing open (running a destructive migration without ack).
  const worktree = mkdtempSync(path.join(tmpdir(), "ui-prov-migrate-pos-"));
  tempRoots.push(worktree);
  const recipe = {
    migrate: {
      statusCommand: "echo 'DROP TABLE users'",
      applyCommand: "true",
      destructivePattern: DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN,
    },
  };

  const result = await inspectMigrations({ worktreePath: worktree, recipe });

  assert.deepEqual(result.pending, ["DROP TABLE users"]);
  assert.deepEqual(result.destructive, ["DROP TABLE users"]);
});

test("DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN matches known destructive statements", () => {
  const re = new RegExp(DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN, "iu");
  for (const line of ["DROP TABLE users", "TRUNCATE users", "DELETE FROM users"]) {
    assert.ok(re.test(line), `expected default pattern to flag: ${line}`);
  }
  assert.equal(re.test("ADD COLUMN email"), false);
});

test("ensureOwnNodeModules: leaves a real node_modules alone", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "ui-prov-real-"));
  tempRoots.push(worktree);
  mkdirSync(path.join(worktree, "node_modules"));

  assert.equal(ensureOwnNodeModules(worktree), false);
  assert.equal(lstatSync(path.join(worktree, "node_modules")).isDirectory(), true);
});
