// Deps-less plugin/marketplace checkout preflight.
//
// A Claude Code plugin marketplace checkout ships `.claude/` (and this `cli/`)
// with no `node_modules` at all — no install hook runs, so `@dev-loops/core` is
// simply not present on disk. Before this fix, that made `cli/index.mjs` itself
// crash on module load (a top-level `import ... from "@dev-loops/core/..."`
// throws `ERR_MODULE_NOT_FOUND` before a single line is printed) — including
// for `dev-loops doctor`, the one command meant to diagnose the problem.
//
// This test builds the smallest possible reproduction of that layout: a
// throwaway directory containing ONLY `cli/index.mjs` + `lib/dev-loops-core.mjs`
// (its one local, always-resolvable dependency) — no `node_modules`, no
// `packages/`, no `scripts/`. `@dev-loops/core` is therefore genuinely
// unresolvable from that tree, the same as in the real marketplace checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CLI_SOURCE = path.join(REPO_ROOT, "cli/index.mjs");

const RUN_ENV = { ...process.env, DEVLOOPS_RUN_ID: "test-run-123" };

function buildDepsLessCheckout() {
  const dir = mkdtempSync(path.join(tmpdir(), "dev-loops-deps-less-"));
  mkdirSync(path.join(dir, "cli"));
  mkdirSync(path.join(dir, "lib"));
  copyFileSync(CLI_SOURCE, path.join(dir, "cli/index.mjs"));
  copyFileSync(path.join(REPO_ROOT, "lib/dev-loops-core.mjs"), path.join(dir, "lib/dev-loops-core.mjs"));
  // Deliberately no node_modules/, no packages/, no scripts/ — @dev-loops/core
  // (and every routed script) is unresolvable from this tree, by construction.
  return dir;
}

function runCli(dir, args) {
  try {
    const stdout = execFileSync("node", [path.join(dir, "cli/index.mjs"), ...args], { encoding: "utf8", env: RUN_ENV });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "" };
  }
}

test("cli/index.mjs has no top-level @dev-loops/core import on the reachable path", () => {
  const source = readFileSync(CLI_SOURCE, "utf8");
  // Match ES module `import ... from "specifier"` statements only — NOT
  // `import.meta.resolve(...)` (the zero-dep probe itself) or a runtime
  // `await import(...)` (a lazy, guarded dynamic import).
  const staticImportLines = source
    .split("\n")
    .filter((line) => /^\s*import\s.*\bfrom\b/.test(line));
  const offenders = staticImportLines.filter((line) => line.includes("@dev-loops/core"));
  assert.deepEqual(offenders, [], "no static top-level import may reference @dev-loops/core");
});

test("a command that needs core prints one friendly line and exits non-zero — not a module-load stack trace", () => {
  const dir = buildDepsLessCheckout();
  try {
    for (const args of [["queue", "add", "--repo", "mfittko/dev-loops", "--item", "1"], ["gates"]]) {
      const result = runCli(dir, args);
      assert.notEqual(result.status, 0, `expected non-zero exit for ${args.join(" ")}`);
      const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
      assert.equal(stderrLines.length, 1, `expected exactly one stderr line for ${args.join(" ")}, got: ${result.stderr}`);
      assert.match(stderrLines[0], /npx dev-loops/);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
      assert.doesNotMatch(result.stderr, /at Object\.|at ModuleLoader|node:internal/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor and help still run in a deps-less checkout and doctor names the condition", () => {
  const dir = buildDepsLessCheckout();
  try {
    const help = runCli(dir, ["help"]);
    assert.equal(help.status, 0);
    assert.equal(help.stderr, "");

    const doctor = runCli(dir, ["doctor"]);
    assert.equal(doctor.status, 0);
    assert.match(doctor.stdout, /@dev-loops\/core resolvable/);
    assert.match(doctor.stdout, /npx dev-loops/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
