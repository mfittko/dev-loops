import assert from "node:assert/strict";
import test, { after } from "node:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { provisionAndBoot } from "@dev-loops/core/loop/ui-review-provision";
import { loadDevLoopConfig, resolveUiReviewRunRecipe, DEFAULT_DESTRUCTIVE_MIGRATION_PATTERN } from "@dev-loops/core/config";
import { parseUiReviewProvisionCliArgs, ensureOwnNodeModules, inspectMigrations, assertNotPrimary } from "../../scripts/loop/ui-review-provision.mjs";
import { execFileSync } from "node:child_process";

// #1456 fix 2 (+ review hardening): the loop's own worktree namespace lives INSIDE
// the repo root, so the primary-checkout containment check used to reject it.
// assertNotPrimary exempts it — but ONLY when it is a genuinely LISTED linked
// worktree (not any directory that merely contains tmp/worktrees/ in its path).
test("assertNotPrimary: exempts a genuinely-listed linked worktree under the loop namespace", () => {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const wt = path.join(repoRoot, "tmp", "worktrees", `test-1456-guard-${process.pid}`);
  execFileSync("git", ["worktree", "add", "--detach", wt], { cwd: repoRoot, stdio: "ignore" });
  try {
    const r = assertNotPrimary({ worktreePath: wt, repoRoot });
    assert.equal(r.ok, true, "a real listed worktree in the loop namespace is exempted");
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: repoRoot, stdio: "ignore" });
  }
});

test("assertNotPrimary: a tmp/worktrees-looking path that is NOT a listed worktree is not force-exempted (fail closed)", () => {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  // never created as a worktree: it merely LOOKS like the loop namespace. Because
  // it isn't a genuine listed worktree, the exemption does NOT fire, and the
  // containment check correctly rejects it as under the primary checkout — this
  // is the fail-closed property the review flagged.
  const fake = path.join(repoRoot, "tmp", "worktrees", `not-a-real-worktree-${process.pid}`);
  const r = assertNotPrimary({ worktreePath: fake, repoRoot });
  assert.equal(r.ok, false, "a fake (non-listed) tmp/worktrees path is not exempted");
  assert.match(r.message, /primary checkout/);
});

test("assertNotPrimary: still rejects the primary checkout root", () => {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const r = assertNotPrimary({ worktreePath: repoRoot, repoRoot });
  assert.equal(r.ok, false, "the primary checkout is still refused (fail closed)");
  assert.match(r.message, /primary checkout/);
});

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
      // Never fires by default so the probe result decides; the fake clock is
      // driven by the poll interval, not the per-attempt cap.
      probeTimeout: () => new Promise(() => {}),
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

test("parseUiReviewProvisionCliArgs: --ack-destructive-migration=false does NOT ack (fail closed)", () => {
  const base = ["--repo-root", "/r", "--pr", "12"];
  // Bare flag and explicit truthy values ack.
  assert.equal(parseUiReviewProvisionCliArgs([...base, "--ack-destructive-migration"]).ackDestructiveMigration, true);
  assert.equal(parseUiReviewProvisionCliArgs([...base, "--ack-destructive-migration=true"]).ackDestructiveMigration, true);
  // Explicit falsy values must NOT ack — otherwise a destructive migration runs.
  for (const v of ["false", "0", "no"]) {
    assert.equal(parseUiReviewProvisionCliArgs([...base, `--ack-destructive-migration=${v}`]).ackDestructiveMigration, false, v);
  }
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

test("throwing probe fails closed to boot-timeout (does not propagate)", async () => {
  const root = makeFixture(RECIPE_YAML);
  const { seams } = baseSeams(root, {
    probe: async () => {
      throw new Error("probe blew up");
    },
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 8 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /readiness probe timed out after 5000ms/);
  assert.ok(result.findings.some((f) => f.kind === "boot-timeout"));
});

test("hung probe (never resolves) still yields a deterministic boot-timeout", async () => {
  const root = makeFixture(RECIPE_YAML);
  const { seams } = baseSeams(root, {
    probe: () => new Promise(() => {}), // never resolves — would hang without the per-attempt cap
    probeTimeout: () => Promise.resolve(false), // per-attempt budget elapses immediately
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 8 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /readiness probe timed out after 5000ms/);
  assert.ok(result.findings.some((f) => f.kind === "boot-timeout"));
});

test("run recipe cwd escaping the worktree fails closed (no boot)", async () => {
  const root = makeFixture(`version: 1
uiReview:
  run:
    command: "true"
    readyUrl: "http://127.0.0.1:65535/health"
    cwd: "../.."
`);
  let booted = false;
  const { seams } = baseSeams(root, {
    bootApp: async () => { booted = true; return { pid: 1, detail: "spawned" }; },
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 8 }, seams);

  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.stopReason, /cwd escapes the provisioned worktree/);
  assert.ok(result.findings.some((f) => f.kind === "cwd-traversal"));
  assert.equal(booted, false); // never boots outside the worktree
});

test("in-worktree cwd: migrate/boot seams receive the guard-validated absolute cwd (no second derivation)", async () => {
  // A recipe cwd inside the worktree must flow to migrate + boot as the exact
  // absolute path the orchestrator resolved and validated — the seams must not
  // re-join it. This ties the guarded path to the executed path.
  const root = makeFixture(`version: 1
uiReview:
  run:
    command: "true"
    readyUrl: "http://127.0.0.1:65535/health"
    cwd: "app/web"
    migrate:
      statusCommand: "true"
      applyCommand: "true"
`);
  const expectedCwd = path.resolve(root, "app/web");
  const seenCwd = {};
  const { seams } = baseSeams(root, {
    inspectMigrations: async ({ runCwd }) => { seenCwd.inspect = runCwd; return { pending: ["001"], destructive: [], detail: "1 pending" }; },
    applyMigrations: async ({ runCwd }) => { seenCwd.apply = runCwd; return { ok: true, applied: 1, detail: "applied" }; },
    bootApp: async ({ runCwd }) => { seenCwd.boot = runCwd; return { pid: 1, detail: "spawned" }; },
    probe: async () => true,
  });

  const result = await provisionAndBoot({ repoRoot: "/main", pr: 30 }, seams);

  assert.equal(result.ok, true);
  assert.equal(seenCwd.inspect, expectedCwd);
  assert.equal(seenCwd.apply, expectedCwd);
  assert.equal(seenCwd.boot, expectedCwd);
  assert.equal(path.isAbsolute(seenCwd.boot), true);
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

  const result = await inspectMigrations({ recipe, runCwd: worktree });

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

  const result = await inspectMigrations({ recipe, runCwd: worktree });

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
