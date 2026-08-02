import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildValidationResultsPath } from "../../scripts/github/write-gate-context.mjs";
import {
  parseRunGateValidationCliArgs,
  readPackageScripts,
  stripAnsi,
  validateSuiteNames,
} from "../../scripts/loop/run-gate-validation.mjs";
import { runNode } from "../_helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/loop/run-gate-validation.mjs", import.meta.url));

async function makeFixtureRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "run-gate-validation-"));
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "0.0.0",
      private: true,
      scripts: {
        verify: "node -e \"console.log('verify-ran')\"",
        passing: "node -e \"console.log('passing-ran')\"",
        failing: "node -e \"console.error('boom'); process.exit(2)\"",
      },
    }, null, 2),
    "utf8",
  );
  return repoRoot;
}

// ---------------------------------------------------------------------------
// parseRunGateValidationCliArgs
// ---------------------------------------------------------------------------

test("parseRunGateValidationCliArgs defaults --suite to [verify]", () => {
  const options = parseRunGateValidationCliArgs([
    "--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", "abc1234",
  ]);
  assert.deepEqual(options.suites, ["verify"]);
  assert.equal(options.tmpRoot, "tmp");
});

test("parseRunGateValidationCliArgs collects repeated --suite flags in order", () => {
  const options = parseRunGateValidationCliArgs([
    "--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", "abc1234",
    "--suite", "a", "--suite", "b",
  ]);
  assert.deepEqual(options.suites, ["a", "b"]);
});

test("parseRunGateValidationCliArgs reports missing required arguments", () => {
  assert.throws(() => parseRunGateValidationCliArgs(["--repo", "owner/repo"]), /Missing required/);
});

test("parseRunGateValidationCliArgs rejects a bad --gate", () => {
  assert.throws(() => parseRunGateValidationCliArgs([
    "--repo", "owner/repo", "--pr", "1", "--gate", "bogus", "--head-sha", "abc1234",
  ]), /--gate must be/);
});

test("parseRunGateValidationCliArgs rejects an empty --suite", () => {
  assert.throws(() => parseRunGateValidationCliArgs([
    "--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", "abc1234",
    "--suite", "   ",
  ]), /--suite must not be empty/);
});

// ---------------------------------------------------------------------------
// validateSuiteNames — the trust-boundary guard
// ---------------------------------------------------------------------------

test("validateSuiteNames passes when every suite is a known script key", () => {
  assert.doesNotThrow(() => validateSuiteNames(["verify", "passing"], { verify: "x", passing: "y" }));
});

test("validateSuiteNames throws a named error listing every unknown suite", () => {
  assert.throws(
    () => validateSuiteNames(["verify", "nope", "also-nope"], { verify: "x" }),
    /Unknown validation suite\(s\).*nope, also-nope/,
  );
});

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

test("stripAnsi removes CSI color/style codes", () => {
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m"), "ok");
  assert.equal(stripAnsi("plain text"), "plain text");
});

// ---------------------------------------------------------------------------
// readPackageScripts
// ---------------------------------------------------------------------------

test("readPackageScripts returns the scripts map", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const scripts = await readPackageScripts(repoRoot);
    assert.deepEqual(Object.keys(scripts).sort(), ["failing", "passing", "verify"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

test("default suite (no --suite given) runs only 'verify' and writes the artifact at buildValidationResultsPath", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", "abc1234",
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);

    const artifact = JSON.parse(stdout.trim());
    assert.equal(artifact.suites.length, 1);
    assert.equal(artifact.suites[0].name, "verify");

    const expectedPath = buildValidationResultsPath({
      repo: "owner/repo", pr: 1, gate: "draft_gate", headSha: "abc1234",
    });
    const onDisk = JSON.parse(await readFile(path.resolve(repoRoot, expectedPath), "utf8"));
    assert.deepEqual(onDisk, artifact);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("artifact shape: no outputSha256/durationMs anywhere, and the documented key set exactly", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "2", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--suite", "passing",
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);

    const artifact = JSON.parse(stdout.trim());
    assert.deepEqual(Object.keys(artifact).sort(), [
      "allPassed", "gate", "generatedAt", "headSha", "ok", "pr", "repo", "suites",
    ]);
    assert.deepEqual(Object.keys(artifact.suites[0]).sort(), [
      "command", "exitCode", "name", "outputPath", "outputTail",
    ]);
    assert.equal(JSON.stringify(artifact).includes("outputSha256"), false);
    assert.equal(JSON.stringify(artifact).includes("durationMs"), false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("allPassed is false when a suite exits non-zero; exit code is still 0", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "3", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--suite", "passing", "--suite", "failing",
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);

    const artifact = JSON.parse(stdout.trim());
    assert.equal(artifact.allPassed, false);
    const failing = artifact.suites.find((s) => s.name === "failing");
    assert.equal(failing.exitCode, 2);
    assert.match(failing.outputTail, /boom/);
    const passing = artifact.suites.find((s) => s.name === "passing");
    assert.equal(passing.exitCode, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("unknown --suite exits 1 with a named error and executes NOTHING (no artifact, no log files)", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "4", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--suite", "verify", "--suite", "does-not-exist",
    ], { cwd: repoRoot });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    const err = JSON.parse(stderr.trim());
    assert.equal(err.ok, false);
    assert.match(err.error, /Unknown validation suite\(s\).*does-not-exist/);

    const expectedPath = buildValidationResultsPath({
      repo: "owner/repo", pr: 4, gate: "draft_gate", headSha: "abc1234",
    });
    await assert.rejects(readFile(path.resolve(repoRoot, expectedPath)), /ENOENT/);

    // Even the KNOWN suite ("verify") in the same invocation must not have run:
    // validation happens before ANY suite executes.
    const verifyLogPath = path.resolve(
      repoRoot,
      path.join(path.dirname(expectedPath), "draft_gate-abc1234.validation-verify.log"),
    );
    await assert.rejects(readFile(verifyLogPath), /ENOENT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("per-suite log file is written at the recorded outputPath with the suite's full output", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "5", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--suite", "passing",
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);

    const artifact = JSON.parse(stdout.trim());
    const suite = artifact.suites[0];
    const logContent = await readFile(path.resolve(repoRoot, suite.outputPath), "utf8");
    assert.match(logContent, /passing-ran/);
    // outputTail is the (possibly-truncated) tail of the same content.
    assert.ok(logContent.endsWith(suite.outputTail.length > 0 ? suite.outputTail.trimEnd() + "\n" : ""));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("--jq/--silent behave per the base guarantee", async () => {
  const repoRoot = await makeFixtureRepo();
  try {
    const argv = ["--repo", "owner/repo", "--pr", "6", "--gate", "draft_gate", "--head-sha", "abc1234", "--suite", "passing"];

    const jqResult = await runNode(SCRIPT, [...argv, "--jq", ".allPassed"], { cwd: repoRoot });
    assert.equal(jqResult.code, 0, jqResult.stderr);
    assert.equal(jqResult.stdout.trim(), "true");

    const silentResult = await runNode(SCRIPT, [...argv, "--pr", "7", "--silent"], { cwd: repoRoot });
    assert.equal(silentResult.code, 0);
    assert.equal(silentResult.stdout, "");

    const invalidJq = await runNode(SCRIPT, [...argv, "--pr", "8", "--jq", "bogus!!"], { cwd: repoRoot });
    assert.equal(invalidJq.code, 2);
    assert.equal(invalidJq.stdout, "");
    assert.match(invalidJq.stderr, /--jq/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("--help documents the shared --jq/--silent flags", async () => {
  const { code, stdout } = await runNode(SCRIPT, ["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--jq <filter>/);
  assert.match(stdout, /--silent, -s/);
});
