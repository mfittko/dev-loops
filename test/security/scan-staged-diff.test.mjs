import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { parseScanStagedDiffCliArgs, runCli } from "../../scripts/security/scan-staged-diff.mjs";
import { runNode } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/security/scan-staged-diff.mjs");

// Fixture literal below is assembled from split fragments at RUNTIME, not
// written whole in this file's SOURCE — see packages/core/test/secret-scan.test.mjs
// for why (this repo's own pre-commit hook scans the diff that commits this
// very file).
function join(...parts) {
  return parts.join("");
}

const BASE_GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: BASE_GIT_ENV });
}

async function initRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "scan-staged-diff-"));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "t@example.test"]);
  git(dir, ["config", "user.name", "Scan Test"]);
  await writeFile(path.join(dir, "seed.txt"), "seed\n");
  git(dir, ["add", "seed.txt"]);
  git(dir, ["commit", "--quiet", "-m", "seed"]);
  return dir;
}

test("parseScanStagedDiffCliArgs: --help returns help flag", () => {
  assert.equal(parseScanStagedDiffCliArgs(["--help"]).help, true);
});

test("parseScanStagedDiffCliArgs: rejects an unknown argument", () => {
  assert.throws(() => parseScanStagedDiffCliArgs(["--nope"]), /Unknown argument/i);
});

test("runCli: a clean staged diff exits 0 with no hits", async () => {
  const dir = await initRepo();
  try {
    await writeFile(path.join(dir, "clean.txt"), "nothing interesting here\n");
    git(dir, ["add", "clean.txt"]);
    const out = { write: () => {} };
    const err = { write: () => {} };
    const result = await runCli([], { stdout: out, stderr: err, cwd: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.hits, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Spawned (not an in-process runCli() import) so the CLI's own
// `process.exitCode = ...` on a hit lands on the CHILD process, not on this
// test file's process — an in-process call here would leak a non-zero
// exitCode into the test runner itself regardless of which assertions pass.
test("runCli (spawned): a staged literal credential blocks and NEVER echoes the value in the payload", async () => {
  const dir = await initRepo();
  const credentialValue = join("ghp_", "B".repeat(20), "c2");
  try {
    await writeFile(path.join(dir, "config.sh"), `export TOKEN="${credentialValue}"\n`);
    git(dir, ["add", "config.sh"]);
    const result = await runNode(scriptPath, [], { cwd: dir, env: BASE_GIT_ENV });
    assert.equal(result.code, 1, `expected exit 1, got stdout: ${result.stdout} stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "secret_scan_hit");
    assert.equal(parsed.hits.length, 1);
    assert.equal(parsed.hits[0].file, "config.sh");
    assert.equal(parsed.hits[0].detectorClass, "literal-credential");
    assert.ok(!result.stdout.includes(credentialValue), "stdout must never contain the matched value");
    assert.ok(!result.stderr.includes(credentialValue), "stderr must never contain the matched value");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli: an internal scanner error (not a git repo) rejects — fail closed", async () => {
  const nonRepoDir = await mkdtemp(path.join(tmpdir(), "scan-staged-diff-not-a-repo-"));
  try {
    const out = { write: () => {} };
    const err = { write: () => {} };
    await assert.rejects(() => runCli([], { stdout: out, stderr: err, cwd: nonRepoDir }));
  } finally {
    await rm(nonRepoDir, { recursive: true, force: true });
  }
});
