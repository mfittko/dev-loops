import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// #775: headless entry + read-only info smoke. CI exercises the read-only path and the entry's
// --dry-run (the live `claude -p` agent run needs an API key and is out of CI scope).

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const PI_IMPORT_RE = /\b(?:from|import)\s+['"]@earendil-works\/pi-[^'"]+['"]|\bimport\(\s*['"]@earendil-works\/pi-/;

function runNode(scriptRel, args) {
  return spawnSync(process.execPath, [path.join(repoRoot, scriptRel), ...args], { cwd: repoRoot, encoding: "utf8" });
}

test("headless-info-smoke runs the offline read-only status path and exits 0 (no GitHub auth, Pi-free)", () => {
  // Run with GitHub auth env explicitly removed to prove the default smoke is secret-free
  // (hermetic CI verify job has no token); the default path is `dev-loops status` (offline).
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const res = spawnSync(process.execPath, [path.join(repoRoot, "scripts/claude/headless-info-smoke.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dev-loops status:/);
  assert.match(res.stdout, /"ok":true,"smoke":"headless-info"/);
});

test("headless-dev-loop --dry-run prints a claude -p invocation carrying DEVLOOPS_RUN_ID, without spawning claude", () => {
  // PATH cleared of a real `claude` is unnecessary: --dry-run never spawns. Assert the shape.
  const res = runNode("scripts/claude/headless-dev-loop.mjs", ["--issue", "775", "--dry-run"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.command, "claude");
  assert.equal(out.args[0], "-p");
  assert.match(out.args[1], /issue #775/);
  assert.match(out.DEVLOOPS_RUN_ID, /^devloops-/);
});

test("headless-info-smoke --loop-info without a target fails fast (no hidden issue default)", () => {
  const res = runNode("scripts/claude/headless-info-smoke.mjs", ["--loop-info"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--loop-info requires an explicit --issue/);
});

test("headless entry + smoke scripts do not import the Pi SDK", async () => {
  for (const rel of ["scripts/claude/headless-dev-loop.mjs", "scripts/claude/headless-info-smoke.mjs"]) {
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    assert.equal(PI_IMPORT_RE.test(content), false, `${rel} must not import @earendil-works/pi-*`);
  }
});

test("Dockerfile keeps the Pi install (dual-harness smoke preserved)", async () => {
  const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /@earendil-works\/pi-coding-agent/, "Pi CLI install must remain for the Pi Docker smoke");
});
