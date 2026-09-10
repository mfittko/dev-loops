// #2123: `.claude/bin/dev-loops-run` is the resolver launcher every routed skill/command/agent
// invocation goes through. Hermetic contract: copy the committed launcher into fabricated fixture
// roots (no real npm install, no real dev-loops checkout) and spawn it, exactly as a consumer
// Claude Code runtime would from a shell PATH entry.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const launcherSource = path.join(repoRoot, ".claude/bin/dev-loops-run");

function makeFixtureRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), "dev-loops-run-fixture-"));
  const bin = path.join(dir, "plugincache", "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = path.join(bin, "dev-loops-run");
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o755);
  return { dir, pluginRoot: path.join(dir, "plugincache"), launcher };
}

function writeScript(file, output) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `console.log(${JSON.stringify(output)});\n`);
}

function writeInstalledManifest(pluginRoot, version) {
  const file = path.join(pluginRoot, "node_modules/dev-loops/package.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ name: "dev-loops", version }));
}

function runLauncher(launcher, args, cwd) {
  return spawnSync(process.execPath, [launcher, ...args], { cwd, encoding: "utf8" });
}

test("launcher file: mode is executable, node shebang, no @dev-loops/core import, name matches WRAPPER_LAUNCHER", async () => {
  const { WRAPPER_LAUNCHER } = await import("../../packages/core/src/claude/asset-generation.mjs");
  const content = readFileSync(launcherSource, "utf8");
  assert.match(content, /^#!\/usr\/bin\/env node\n/);
  assert.equal(content.includes("@dev-loops/core"), false, "must not import @dev-loops/core (unresolvable pre-install)");
  assert.equal(path.basename(launcherSource), WRAPPER_LAUNCHER);
  assert.equal(/\bgh\b/.test(content), false, "no raw gh fallback branch anywhere in the launcher source");
});

test("installed-only: resolves and runs the auto-installed package's script, exits 0", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    writeScript(path.join(pluginRoot, "node_modules/dev-loops/scripts/probe.mjs"), "FROM_INSTALLED");

    // cwd outside any checkout ancestry.
    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-consumer-"));
    try {
      const r = runLauncher(launcher, ["scripts/probe.mjs"], consumerCwd);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /FROM_INSTALLED/);
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkout-wins: a live checkout runs over a NEWER installed package, no reinstall on live edit", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    // Installed copy pinned HIGHER than the checkout.
    writeInstalledManifest(pluginRoot, "9.9.9");
    writeScript(path.join(pluginRoot, "node_modules/dev-loops/scripts/probe.mjs"), "FROM_INSTALLED");

    const checkout = path.join(dir, "checkout");
    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "dev-loops", version: "0.0.1-local" }));
    writeScript(path.join(checkout, "scripts/probe.mjs"), "FROM_CHECKOUT_V1");

    const cwd = path.join(checkout, "nested", "subdir");
    mkdirSync(cwd, { recursive: true });

    const r1 = runLauncher(launcher, ["scripts/probe.mjs"], cwd);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /FROM_CHECKOUT_V1/);
    assert.equal(/FROM_INSTALLED/.test(r1.stdout), false, "must not run the newer installed copy");

    // Live edit takes effect immediately, no reinstall.
    writeScript(path.join(checkout, "scripts/probe.mjs"), "FROM_CHECKOUT_V2");
    const r2 = runLauncher(launcher, ["scripts/probe.mjs"], cwd);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stdout, /FROM_CHECKOUT_V2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2123: `isCheckout` requires package.json name === "dev-loops" AND a sibling scripts/ dir.
// A consumer repo commonly has a differently-named package.json + a scripts/ dir; that ancestor
// must NOT be misresolved as a dev-loops checkout — the installed package wins.
test("checkout-detection: an ancestor with a non-`dev-loops` package.json name is not a checkout — installed wins", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    writeScript(path.join(pluginRoot, "node_modules/dev-loops/scripts/probe.mjs"), "FROM_INSTALLED");

    // Foreign ancestor: has a package.json (different name) AND a sibling scripts/ dir.
    const foreign = path.join(dir, "foreign-repo");
    mkdirSync(path.join(foreign, "scripts"), { recursive: true });
    writeFileSync(path.join(foreign, "package.json"), JSON.stringify({ name: "some-consumer-app", version: "2.0.0" }));
    writeScript(path.join(foreign, "scripts/probe.mjs"), "FROM_FOREIGN");
    const cwd = path.join(foreign, "nested");
    mkdirSync(cwd, { recursive: true });

    const r = runLauncher(launcher, ["scripts/probe.mjs"], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FROM_INSTALLED/);
    assert.equal(/FROM_FOREIGN/.test(r.stdout), false, "a non-`dev-loops` ancestor must not be treated as a checkout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2123: a malformed/unreadable ancestor package.json must be swallowed (walk continues) without
// crashing the launcher — the try/catch in `isCheckout` keeps walking up to the installed package.
test("checkout-detection: a malformed ancestor package.json is skipped, not a crash — installed wins", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    writeScript(path.join(pluginRoot, "node_modules/dev-loops/scripts/probe.mjs"), "FROM_INSTALLED");

    const broken = path.join(dir, "broken-repo");
    mkdirSync(path.join(broken, "scripts"), { recursive: true });
    writeFileSync(path.join(broken, "package.json"), "{ this is not valid json ");
    const cwd = path.join(broken, "nested");
    mkdirSync(cwd, { recursive: true });

    const r = runLauncher(launcher, ["scripts/probe.mjs"], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FROM_INSTALLED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hard-stop: neither checkout nor installed resolves — exit 3, stderr names wrapper + script, stdout empty, no gh fallback", () => {
  const { dir, launcher } = makeFixtureRoot();
  try {
    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-empty-"));
    try {
      const r = runLauncher(launcher, ["scripts/github/view-issue.mjs"], consumerCwd);
      assert.equal(r.status, 3);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /dev-loops-run/);
      assert.match(r.stderr, /scripts\/github\/view-issue\.mjs/);
      assert.equal(/\bgh\b/.test(r.stderr), false, "must never fall back to raw gh");
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing script argument: exit 2", () => {
  const { dir, launcher } = makeFixtureRoot();
  try {
    const r = runLauncher(launcher, [], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("propagates the resolved child script's non-zero exit code", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    mkdirSync(path.join(pluginRoot, "node_modules/dev-loops/scripts"), { recursive: true });
    writeFileSync(path.join(pluginRoot, "node_modules/dev-loops/scripts/fail.mjs"), "process.exit(7);\n");
    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-fail-"));
    try {
      const r = runLauncher(launcher, ["scripts/fail.mjs"], consumerCwd);
      assert.equal(r.status, 7);
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
