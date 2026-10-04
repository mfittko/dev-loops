// #2123: `.claude/bin/dev-loops-run` is the resolver launcher every routed skill/command/agent
// invocation goes through. Hermetic contract: copy the committed launcher into fabricated fixture
// roots (no real npm install, no real dev-loops checkout) and spawn it, exactly as a consumer
// Claude Code runtime would from a shell PATH entry.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// The generated startup form is `dev-loops-run cli/index.mjs loop startup`. Inside a checkout it
// must run the checkout's CLI even when an installed package carries the same version; outside a
// checkout it must run the plugin's installed package.
function writeCli(file, label) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `console.log(${JSON.stringify(label)} + " " + process.argv.slice(2).join(" "));\n`);
}

test("generated startup form: a checkout runs its own cli/index.mjs, a consumer runs the installed package", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.5");
    writeCli(path.join(pluginRoot, "node_modules/dev-loops/cli/index.mjs"), "INSTALLED_CLI");

    const checkout = path.join(dir, "checkout");
    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "dev-loops", version: "1.0.5" }));
    writeCli(path.join(checkout, "cli/index.mjs"), "CHECKOUT_CLI");

    const inCheckout = runLauncher(launcher, ["cli/index.mjs", "loop", "startup", "--issue", "7"], checkout);
    assert.equal(inCheckout.status, 0, inCheckout.stderr);
    assert.equal(inCheckout.stdout.trim(), "CHECKOUT_CLI loop startup --issue 7");

    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-consumer-"));
    try {
      const outside = runLauncher(launcher, ["cli/index.mjs", "loop", "startup", "--issue", "7"], consumerCwd);
      assert.equal(outside.status, 0, outside.stderr);
      assert.equal(outside.stdout.trim(), "INSTALLED_CLI loop startup --issue 7");
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("binary-location: a source-checkout binary invoked via a PATH symlink from an unrelated cwd resolves the checkout it lives in", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-loops-run-binloc-"));
  try {
    const checkout = path.join(root, "checkout");
    mkdirSync(path.join(checkout, "scripts"), { recursive: true });
    writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "dev-loops", version: "0.0.1-local" }));
    writeScript(path.join(checkout, "scripts/probe.mjs"), "FROM_BINARY_CHECKOUT");

    const launcherInCheckout = path.join(checkout, ".claude/bin/dev-loops-run");
    mkdirSync(path.dirname(launcherInCheckout), { recursive: true });
    copyFileSync(launcherSource, launcherInCheckout);
    chmodSync(launcherInCheckout, 0o755);

    const pathDir = mkdtempSync(path.join(tmpdir(), "dev-loops-run-pathdir-"));
    const symlink = path.join(pathDir, "dev-loops-run");
    let launcherToRun = launcherInCheckout;
    try {
      symlinkSync(launcherInCheckout, symlink);
      launcherToRun = symlink;
    } catch {
      // Symlinks unavailable in this environment — still exercise the resolution logic by
      // spawning the real binary path directly.
    }

    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-binloc-cwd-"));
    try {
      const r = runLauncher(launcherToRun, ["scripts/probe.mjs"], consumerCwd);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /FROM_BINARY_CHECKOUT/);
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binary-location: CWD-checkout precedence still wins over the binary-location checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "dev-loops-run-precedence-"));
  try {
    // Checkout A: the CWD lives here.
    const checkoutA = path.join(root, "checkout-a");
    mkdirSync(path.join(checkoutA, "scripts"), { recursive: true });
    writeFileSync(path.join(checkoutA, "package.json"), JSON.stringify({ name: "dev-loops", version: "0.0.1-a" }));
    writeScript(path.join(checkoutA, "scripts/probe.mjs"), "FROM_CHECKOUT_A");
    const cwd = path.join(checkoutA, "nested");
    mkdirSync(cwd, { recursive: true });

    // Checkout B: the launcher physically lives here.
    const checkoutB = path.join(root, "checkout-b");
    mkdirSync(path.join(checkoutB, "scripts"), { recursive: true });
    writeFileSync(path.join(checkoutB, "package.json"), JSON.stringify({ name: "dev-loops", version: "0.0.1-b" }));
    writeScript(path.join(checkoutB, "scripts/probe.mjs"), "FROM_CHECKOUT_B");
    const launcherInB = path.join(checkoutB, ".claude/bin/dev-loops-run");
    mkdirSync(path.dirname(launcherInB), { recursive: true });
    copyFileSync(launcherSource, launcherInB);
    chmodSync(launcherInB, 0o755);

    const r = runLauncher(launcherInB, ["scripts/probe.mjs"], cwd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FROM_CHECKOUT_A/);
    assert.equal(/FROM_CHECKOUT_B/.test(r.stdout), false, "CWD checkout must win over the binary-location checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
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

// Path-escape guard: `rel` (argv[2]) is untrusted wrapper-caller input joined against
// `resolvedRoot`. An absolute `rel` or a `../` traversal segment must never reach `path.join` —
// reject before spawn, fail closed with the same exit code as the missing-arg case, and prove the
// escaped script never actually ran (a marker file it would have written stays absent).
test("path-escape guard: an absolute rel is rejected — exit 2, stderr names the wrapper, nothing outside the root runs", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    const marker = path.join(dir, "evil-ran.marker");
    const evil = path.join(dir, "evil.mjs");
    writeFileSync(evil, `import { writeFileSync as w } from "node:fs";\nw(${JSON.stringify(marker)}, "ran");\n`);
    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-escape-abs-"));
    try {
      const r = runLauncher(launcher, [evil], consumerCwd);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /dev-loops-run/);
      assert.match(r.stderr, new RegExp(evil.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(existsSync(marker), false, "escaped script must never run");
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("path-escape guard: a traversing rel is rejected — exit 2, stderr names the wrapper, nothing outside the root runs", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    const marker = path.join(dir, "evil-ran.marker");
    writeFileSync(path.join(dir, "evil.mjs"), `import { writeFileSync as w } from "node:fs";\nw(${JSON.stringify(marker)}, "ran");\n`);
    const consumerCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-escape-trav-"));
    try {
      const r = runLauncher(launcher, ["../../evil.mjs"], consumerCwd);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /dev-loops-run/);
      assert.match(r.stderr, /\.\.\/\.\.\/evil\.mjs/);
      assert.equal(existsSync(marker), false, "escaped script must never run");
    } finally {
      rmSync(consumerCwd, { recursive: true, force: true });
    }
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

// ADR 0117: `--repo-root <checkout>` binds the review-target root. A dev-loops checkout supplies the
// toolchain, and the script always runs with cwd `<checkout>`.
function makeDevLoopsCheckout(dir, label) {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "dev-loops", version: "0.0.1-local" }));
  writeFileSync(
    path.join(dir, "scripts/probe.mjs"),
    `console.log(JSON.stringify({ label: ${JSON.stringify(label)}, script: import.meta.url, cwd: process.cwd() }));\n`,
  );
}

test("--repo-root: run from checkout A, it runs checkout B's script with cwd B", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-loops-run-reporoot-")));
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    makeDevLoopsCheckout(a, "A");
    makeDevLoopsCheckout(b, "B");
    const r = runLauncher(launcherSource, ["--repo-root", b, "scripts/probe.mjs"], a);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.label, "B");
    assert.equal(out.script, pathToFileURL(path.join(b, "scripts/probe.mjs")).href);
    assert.equal(realpathSync(out.cwd), b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--repo-root: checkout B's script resolves @dev-loops/core from B's packages/core", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-loops-run-reporoot-core-")));
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    makeDevLoopsCheckout(a, "A");
    makeDevLoopsCheckout(b, "B");
    const core = path.join(b, "packages/core");
    mkdirSync(core, { recursive: true });
    writeFileSync(path.join(core, "package.json"), JSON.stringify({ name: "@dev-loops/core", type: "module", main: "index.mjs" }));
    writeFileSync(path.join(core, "index.mjs"), `export const where = import.meta.url;\n`);
    mkdirSync(path.join(b, "node_modules/@dev-loops"), { recursive: true });
    symlinkSync(core, path.join(b, "node_modules/@dev-loops/core"));
    writeFileSync(path.join(b, "scripts/core-probe.mjs"), `const { where } = await import("@dev-loops/core");\nconsole.log(where);\n`);
    const r = runLauncher(launcherSource, ["--repo-root", b, "scripts/core-probe.mjs"], a);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), pathToFileURL(path.join(core, "index.mjs")).href);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--repo-root: a non-dev-loops directory keeps the installed toolchain and still sets the cwd", () => {
  const { dir, pluginRoot, launcher } = makeFixtureRoot();
  try {
    writeInstalledManifest(pluginRoot, "1.0.2");
    mkdirSync(path.join(pluginRoot, "node_modules/dev-loops/scripts"), { recursive: true });
    writeFileSync(path.join(pluginRoot, "node_modules/dev-loops/scripts/probe.mjs"), `console.log("FROM_INSTALLED " + process.cwd());\n`);
    const consumer = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-loops-run-reporoot-consumer-")));
    const shellCwd = mkdtempSync(path.join(tmpdir(), "dev-loops-run-reporoot-shell-"));
    try {
      mkdirSync(path.join(consumer, "scripts"), { recursive: true });
      writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "some-consumer-app" }));
      const r = runLauncher(launcher, ["--repo-root", consumer, "scripts/probe.mjs"], shellCwd);
      assert.equal(r.status, 0, r.stderr);
      const [label, cwd] = r.stdout.trim().split(" ");
      assert.equal(label, "FROM_INSTALLED");
      assert.equal(realpathSync(cwd), consumer);
    } finally {
      rmSync(consumer, { recursive: true, force: true });
      rmSync(shellCwd, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repo-root: a missing value or a non-directory exits 2 and names --repo-root", () => {
  const { dir, launcher } = makeFixtureRoot();
  try {
    const file = path.join(dir, "not-a-dir.txt");
    writeFileSync(file, "x");
    for (const args of [["--repo-root"], ["--repo-root", file, "scripts/probe.mjs"], ["--repo-root", path.join(dir, "absent"), "scripts/probe.mjs"]]) {
      const r = runLauncher(launcher, args, dir);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /--repo-root/);
      assert.equal(r.stdout, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--repo-root: a symlink, a relative path, or a trailing slash into a checkout subdirectory walks up from the real path", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-loops-run-reporoot-link-")));
  try {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    makeDevLoopsCheckout(a, "A");
    makeDevLoopsCheckout(b, "B");
    const sub = path.join(b, "sub");
    mkdirSync(sub);
    // The link sits inside checkout A; a lexical walk-up from it would find A.
    symlinkSync(sub, path.join(a, "link"));
    for (const target of [path.join(a, "link"), "link", "link/"]) {
      const r = runLauncher(launcherSource, ["--repo-root", target, "scripts/probe.mjs"], a);
      assert.equal(r.status, 0, `${target}: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.label, "B", target);
      assert.equal(out.cwd, sub, target);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--repo-root: a directory that stats but cannot be entered exits 1 and names the spawn error", () => {
  if (process.getuid?.() === 0) return; // root enters any directory
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dev-loops-run-reporoot-locked-")));
  const locked = path.join(root, "b", "locked");
  try {
    makeDevLoopsCheckout(path.join(root, "b"), "B");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const r = runLauncher(launcherSource, ["--repo-root", locked, "scripts/probe.mjs"], root);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /dev-loops-run: cannot start .*EACCES/);
    assert.equal(r.stdout, "");
  } finally {
    chmodSync(locked, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
