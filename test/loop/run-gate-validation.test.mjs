import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  buildValidationArtifact,
} from "../../scripts/loop/run-gate-validation.mjs";
import { initGitFixture, runNode } from "../_helpers.mjs";

const SCRIPT = fileURLToPath(new URL("../../scripts/loop/run-gate-validation.mjs", import.meta.url));

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

// The CLI attests the worktree is checked out at the declared --head-sha before
// running any suite, so the fixture must be a real git repo and every CLI
// invocation must declare that repo's actual HEAD.
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
  initGitFixture(repoRoot, { commit: null });
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "fixture"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  return { repoRoot, headSha };
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

test("validateSuiteNames rejects suite names that are not safe path segments", () => {
  for (const name of ["a/b", "..", "a\\b", ".hidden", "a b"]) {
    assert.throws(
      () => validateSuiteNames([name], { [name]: "x" }),
      /not usable as a log-file path segment/,
      name,
    );
  }
  // The shipped default names stay accepted.
  assert.doesNotThrow(() => validateSuiteNames(["verify", "assets:check", "schema:check", "test.unit"], {
    "verify": "x", "assets:check": "x", "schema:check": "x", "test.unit": "x",
  }));
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
  const { repoRoot } = await makeFixtureRepo();
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
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "1", "--gate", "draft_gate", "--head-sha", headSha,
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);

    const artifact = JSON.parse(stdout.trim());
    assert.equal(artifact.suites.length, 1);
    assert.equal(artifact.suites[0].name, "verify");

    const expectedPath = buildValidationResultsPath({
      repo: "owner/repo", pr: 1, gate: "draft_gate", headSha,
    });
    const onDisk = JSON.parse(await readFile(path.resolve(repoRoot, expectedPath), "utf8"));
    assert.deepEqual(onDisk, artifact);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("artifact shape: no outputSha256/durationMs anywhere, and the documented key set exactly", async () => {
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "2", "--gate", "draft_gate", "--head-sha", headSha,
      "--suite", "passing",
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);

    const artifact = JSON.parse(stdout.trim());
    assert.deepEqual(Object.keys(artifact).sort(), [
      "allPassed", "depState", "gate", "generatedAt", "headSha", "ok", "pr", "repo", "suites",
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
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "3", "--gate", "draft_gate", "--head-sha", headSha,
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
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "4", "--gate", "draft_gate", "--head-sha", headSha,
      "--suite", "verify", "--suite", "does-not-exist",
    ], { cwd: repoRoot });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    // git subprocess warnings (e.g. deprecated-config notices under CI env) may
    // precede the CLI's own JSON error line on stderr; the contract is the LAST line.
    const err = JSON.parse(stderr.trim().split("\n").at(-1));
    assert.equal(err.ok, false);
    assert.match(err.error, /Unknown validation suite\(s\).*does-not-exist/);

    const expectedPath = buildValidationResultsPath({
      repo: "owner/repo", pr: 4, gate: "draft_gate", headSha,
    });
    await assert.rejects(readFile(path.resolve(repoRoot, expectedPath)), /ENOENT/);

    // Even the KNOWN suite ("verify") in the same invocation must not have run:
    // validation happens before ANY suite executes.
    const verifyLogPath = path.resolve(
      repoRoot,
      path.join(path.dirname(expectedPath), `draft_gate-${headSha}.validation-verify.log`),
    );
    await assert.rejects(readFile(verifyLogPath), /ENOENT/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("per-suite log file is written at the recorded outputPath with the suite's full output", async () => {
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "5", "--gate", "draft_gate", "--head-sha", headSha,
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

test("a suite name containing ':' writes its log under a '-'-mapped filename (Windows-safe)", async () => {
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        name: "fixture", version: "0.0.0", private: true,
        scripts: { "verify": "node -e \"console.log('v')\"", "assets:check": "node -e \"console.log('colon-ran')\"" },
      }, null, 2),
      "utf8",
    );
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "10", "--gate", "draft_gate", "--head-sha", headSha,
      "--suite", "assets:check",
    ], { cwd: repoRoot });
    assert.equal(code, 0, stderr);
    const artifact = JSON.parse(stdout.trim());
    const suite = artifact.suites[0];
    // The artifact keeps the real suite name; only the log filename is mapped.
    assert.equal(suite.name, "assets:check");
    assert.ok(suite.outputPath.endsWith(`draft_gate-${headSha}.validation-assets-check.log`), suite.outputPath);
    const logContent = await readFile(path.resolve(repoRoot, suite.outputPath), "utf8");
    assert.match(logContent, /colon-ran/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("--jq/--silent behave per the base guarantee", async () => {
  const { repoRoot, headSha } = await makeFixtureRepo();
  try {
    const argv = ["--repo", "owner/repo", "--pr", "6", "--gate", "draft_gate", "--head-sha", headSha, "--suite", "passing"];

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

test("a --head-sha that does not match the worktree HEAD exits 1 and runs nothing", async () => {
  const { repoRoot } = await makeFixtureRepo();
  try {
    const wrongHead = "0123456789abcdef0123456789abcdef01234567";
    const { code, stdout, stderr } = await runNode(SCRIPT, [
      "--repo", "owner/repo", "--pr", "9", "--gate", "draft_gate", "--head-sha", wrongHead,
      "--suite", "passing",
    ], { cwd: repoRoot });
    assert.equal(code, 1);
    assert.equal(stdout, "");
    // git subprocess warnings (e.g. deprecated-config notices under CI env) may
    // precede the CLI's own JSON error line on stderr; the contract is the LAST line.
    const err = JSON.parse(stderr.trim().split("\n").at(-1));
    assert.equal(err.ok, false);
    assert.match(err.error, /HEAD/);

    const expectedPath = buildValidationResultsPath({
      repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: wrongHead,
    });
    await assert.rejects(readFile(path.resolve(repoRoot, expectedPath)), /ENOENT/);
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

// ---------------------------------------------------------------------------
// Dependency-state stamp (#1627)
// ---------------------------------------------------------------------------

test("buildValidationArtifact: stamps depState synced when installed deps match the lockfile (npm-shaped)", async () => {
  const { repoRoot } = await makeFixtureRepo();
  try {
    await mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
    // npm-realistic: the committed lock carries the root entry + deps; the hidden
    // installed lock omits the root entry (never byte-identical) but matches deps.
    // Host-independent fixture: the "non-host" optional is always a different
    // os/cpu than the runner, and the host optional is always present, so the
    // expected stamp is platform-agnostic (works on linux-x64 CI and darwin-arm64).
    const hostOs = process.platform;
    const hostCpu = process.arch;
    const otherOs = hostOs === "linux" ? "darwin" : "linux";
    const otherCpu = hostCpu === "x64" ? "arm64" : "x64";
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture" },
        "node_modules/a": { version: "1.0.0" },
        [`node_modules/@pkg/${hostOs}-${hostCpu}`]: { version: "1.0.0", os: [hostOs], cpu: [hostCpu], optional: true },
        [`node_modules/@pkg/${otherOs}-${otherCpu}`]: { version: "1.0.0", os: [otherOs], cpu: [otherCpu], optional: true },
      },
    });
    // Only the host-installable optional plus the plain dep exist in the installed tree.
    const installed = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/a": { version: "1.0.0" },
        [`node_modules/@pkg/${hostOs}-${hostCpu}`]: { version: "1.0.0", os: [hostOs], cpu: [hostCpu], optional: true },
      },
    });
    await writeFile(path.join(repoRoot, "package-lock.json"), lock, "utf8");
    await writeFile(path.join(repoRoot, "node_modules", ".package-lock.json"), installed, "utf8");

    const artifact = await buildValidationArtifact(
      { repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", suites: [], tmpRoot: "tmp" },
      { repoRoot },
    );
    assert.equal(artifact.depState.status, "synced");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildValidationArtifact: stamps depState stale when installed deps diverge from the lockfile", async () => {
  const { repoRoot } = await makeFixtureRepo();
  try {
    await mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/a": { version: "2.0.0" } },
    });
    const installed = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/a": { version: "1.0.0" } },
    });
    await writeFile(path.join(repoRoot, "package-lock.json"), lock, "utf8");
    await writeFile(path.join(repoRoot, "node_modules", ".package-lock.json"), installed, "utf8");

    const artifact = await buildValidationArtifact(
      { repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", suites: [], tmpRoot: "tmp" },
      { repoRoot },
    );
    assert.equal(artifact.depState.status, "stale");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildValidationArtifact: stamps depState stale when installed lockfile is absent", async () => {
  const { repoRoot } = await makeFixtureRepo();
  try {
    await writeFile(
      path.join(repoRoot, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: {} }),
      "utf8",
    );
    // No node_modules/.package-lock.json → deps not materialized → stale.
    const artifact = await buildValidationArtifact(
      { repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", suites: [], tmpRoot: "tmp" },
      { repoRoot },
    );
    assert.equal(artifact.depState.status, "stale");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("buildValidationArtifact: stamps depState synced for a linked worktree with no local node_modules (ancestor installed lock matches)", async () => {
  // Mirrors ensure-worktree.mjs's linked layout: the worktree has its own
  // package-lock.json (checked out via git) but no local node_modules — only
  // the ancestor (main checkout) has the installed lock the suites actually
  // ran against.
  const outerRoot = await mkdtemp(path.join(os.tmpdir(), "run-gate-validation-worktree-"));
  try {
    const repoRoot = path.join(outerRoot, "worktree");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(path.join(outerRoot, "node_modules"), { recursive: true });
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "fixture" }, "node_modules/a": { version: "1.0.0" } },
    });
    const installed = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } });
    await writeFile(path.join(repoRoot, "package-lock.json"), lock, "utf8");
    await writeFile(path.join(outerRoot, "node_modules", ".package-lock.json"), installed, "utf8");

    const artifact = await buildValidationArtifact(
      { repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", suites: [], tmpRoot: "tmp" },
      { repoRoot },
    );
    assert.equal(artifact.depState.status, "synced");
  } finally {
    await rm(outerRoot, { recursive: true, force: true });
  }
});

test("buildValidationArtifact: stamps depState stale for a linked worktree when the ancestor's installed deps genuinely diverge", async () => {
  const outerRoot = await mkdtemp(path.join(os.tmpdir(), "run-gate-validation-worktree-"));
  try {
    const repoRoot = path.join(outerRoot, "worktree");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(path.join(outerRoot, "node_modules"), { recursive: true });
    const lock = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: "2.0.0" } } });
    const installed = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } });
    await writeFile(path.join(repoRoot, "package-lock.json"), lock, "utf8");
    await writeFile(path.join(outerRoot, "node_modules", ".package-lock.json"), installed, "utf8");

    const artifact = await buildValidationArtifact(
      { repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", suites: [], tmpRoot: "tmp" },
      { repoRoot },
    );
    assert.equal(artifact.depState.status, "stale");
  } finally {
    await rm(outerRoot, { recursive: true, force: true });
  }
});

test("buildValidationArtifact: stamps depState n-a when there is no package-lock.json", async () => {
  const { repoRoot } = await makeFixtureRepo();
  try {
    await mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
    const artifact = await buildValidationArtifact(
      { repo: "o/r", pr: 1, gate: "draft_gate", headSha: "abc1234", suites: [], tmpRoot: "tmp" },
      { repoRoot },
    );
    assert.equal(artifact.depState.status, "n-a");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
