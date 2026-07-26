import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper } from "../_helpers.mjs";

import { parseBuildHandoffEnvelopeCliArgs } from "../../scripts/loop/build-handoff-envelope.mjs";

const scriptPath = path.resolve("scripts/loop/build-handoff-envelope.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// Minimal resolver output fixture (from resolve-dev-loop-startup.mjs)
function makeResolverOutput(overrides = {}) {
  return {
    ok: true,
    bundleKind: "resolved",
    selectedStrategy: "issue_intake",
    requiredReads: ["skills/docs/public-dev-loop-contract.md"],
    nextAction: "Normalize the issue, confirm scope",
    canonicalStateSummary: {
      target: { kind: "issue", issue: 42 },
      ownership: "local",
      nextActor: "local",
      status: "active",
      authorization: "authorized",
      executionMode: "bounded_handoff",
      loopState: "issue_intake_start",
    },
    bundle: {
      bundleKind: "resolved",
      activeArtifact: { kind: "issue", issue: 42, pr: null, branch: null, phase: null },
      artifactState: "not_applicable",
      issueLinkageResolution: "resolved_no_open_pr",
      canonicalState: {
        target: { kind: "issue", issue: 42, pr: null, linkedPr: null, branch: null, phase: null },
        ownership: "local",
        nextActor: "local",
        status: "active",
        authorization: "authorized",
      },
      selectedStrategy: "issue_intake",
      executionMode: "bounded_handoff",
      nextAction: "Normalize the issue, confirm scope",
      routeKind: "route",
      selectedGate: "issue_intake",
      waitSemantics: "default",
    },
    ...overrides,
  };
}

async function writeTempJson(tempDir, name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test("parseBuildHandoffEnvelopeCliArgs --help returns help flag", () => {
  const opts = parseBuildHandoffEnvelopeCliArgs(["--help"]);
  assert.equal(opts.help, true);
});

test("parseBuildHandoffEnvelopeCliArgs -h returns help flag", () => {
  const opts = parseBuildHandoffEnvelopeCliArgs(["-h"]);
  assert.equal(opts.help, true);
});

test("parseBuildHandoffEnvelopeCliArgs rejects missing --input", () => {
  assert.throws(
    () => parseBuildHandoffEnvelopeCliArgs([]),
    /--input.*is required/i,
  );
});

test("parseBuildHandoffEnvelopeCliArgs parses --input", () => {
  const opts = parseBuildHandoffEnvelopeCliArgs(["--input", "resolver.json"]);
  assert.equal(opts.help, false);
  assert.equal(opts.inputPath, "resolver.json");
  assert.equal(opts.gateState, undefined);
  assert.equal(opts.overrides, undefined);
  assert.equal(opts.repo, undefined);
});

test("parseBuildHandoffEnvelopeCliArgs parses --gate-state", () => {
  const gs = JSON.stringify({ currentHeadSha: "abc123" });
  const opts = parseBuildHandoffEnvelopeCliArgs(["--input", "r.json", "--gate-state", gs]);
  assert.equal(opts.gateState, gs);
});

test("parseBuildHandoffEnvelopeCliArgs parses --overrides", () => {
  const ov = JSON.stringify({ mergeAuthorized: true });
  const opts = parseBuildHandoffEnvelopeCliArgs(["--input", "r.json", "--overrides", ov]);
  assert.equal(opts.overrides, ov);
});

test("parseBuildHandoffEnvelopeCliArgs parses --repo", () => {
  const opts = parseBuildHandoffEnvelopeCliArgs(["--input", "r.json", "--repo", "owner/name"]);
  assert.equal(opts.repo, "owner/name");
});

test("parseBuildHandoffEnvelopeCliArgs rejects unknown flag", () => {
  assert.throws(
    () => parseBuildHandoffEnvelopeCliArgs(["--input", "r.json", "--unknown"]),
    /Unknown argument/i,
  );
});

test("parseBuildHandoffEnvelopeCliArgs rejects --input with missing value", () => {
  assert.throws(
    () => parseBuildHandoffEnvelopeCliArgs(["--input"]),
    /Missing value for --input/i,
  );
});

// ---------------------------------------------------------------------------
// CLI execution
// ---------------------------------------------------------------------------

test("build-handoff-envelope --help prints usage and exits 0", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /build-handoff-envelope\.mjs/);
  assert.match(result.stdout, /--input/);
  assert.match(result.stdout, /--gate-state/);
  assert.match(result.stdout, /--repo/);
});

test("build-handoff-envelope -h prints usage and exits 0", async () => {
  const result = await runNode(["-h"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--input/);
});

test("build-handoff-envelope exits 1 without --input", async () => {
  const result = await runNode([]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /--input.*is required/i);
  assert.ok(typeof parsed.usage === "string" && parsed.usage.length > 0, "should include usage");
});

test("build-handoff-envelope exits 1 for unknown flag", async () => {
  const result = await runNode(["--bogus"]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
});

test("build-handoff-envelope builds envelope from resolver output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const inputPath = await writeTempJson(tempDir, "resolver.json", makeResolverOutput());

    const result = await runNode(["--input", inputPath, "--repo", "owner/test-repo"]);
    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
    assert.equal(result.stderr, "");

    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.handoffVersion, 1);
    assert.ok(typeof envelope.gateState.derivedAt === "string", "should have derivedAt");
    assert.equal(envelope.target.kind, "issue");
    assert.equal(envelope.target.issue, 42);
    assert.equal(envelope.target.repo, "owner/test-repo");
    assert.ok(Array.isArray(envelope.acceptance.criteria), "should have acceptance.criteria");
    assert.ok(Array.isArray(envelope.stopRules), "should have stopRules");
    assert.ok(typeof envelope.nextAction === "string", "should have nextAction");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope accepts gate state via --gate-state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const inputPath = await writeTempJson(tempDir, "resolver.json", makeResolverOutput());
    const gateState = JSON.stringify({
      currentHeadSha: "deadbeef",
      ciStatus: "success",
      unresolvedThreadCount: 3,
      copilotRoundCount: 2,
    });

    const result = await runNode([
      "--input", inputPath,
      "--repo", "owner/test-repo",
      "--gate-state", gateState,
    ]);
    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.gateState.currentHeadSha, "deadbeef");
    assert.equal(envelope.gateState.ciStatus, "success");
    assert.equal(envelope.gateState.unresolvedThreadCount, 3);
    assert.equal(envelope.gateState.copilotRoundCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope emits error JSON for invalid --input file", async () => {
  const result = await runNode([
    "--input", "/nonexistent/path/to/resolver.json",
    "--repo", "owner/test-repo",
  ]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.ok(typeof parsed.error === "string", "should have error message");
});

test("build-handoff-envelope emits error JSON for malformed JSON input", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const badPath = path.join(tempDir, "bad.json");
    await writeFile(badPath, "not valid json", "utf8");

    const result = await runNode(["--input", badPath, "--repo", "owner/test-repo"]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope passes --overrides into the envelope", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const inputPath = await writeTempJson(tempDir, "resolver.json", makeResolverOutput());
    const overrides = JSON.stringify({ mergeAuthorized: true });

    const result = await runNode([
      "--input", inputPath,
      "--repo", "owner/test-repo",
      "--overrides", overrides,
    ]);
    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());
    // mergeAuthorized=true in overrides should flip stopRules to include merge as authorized
    assert.equal(envelope.stopRules.includes("merge"), true,
      "merge should be in stopRules when mergeAuthorized override is set");
    assert.equal(envelope.target.repo, "owner/test-repo");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope emits flag-specific error for malformed --gate-state JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const inputPath = await writeTempJson(tempDir, "resolver.json", makeResolverOutput());

    const result = await runNode([
      "--input", inputPath,
      "--repo", "owner/test-repo",
      "--gate-state", "not valid json",
    ]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--gate-state/,
      `error should mention --gate-state, got: ${parsed.error}`);
    assert.ok(typeof parsed.usage === "string" && parsed.usage.length > 0,
      "should include usage field for flag-specific parse error");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope emits flag-specific error for malformed --overrides JSON", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const inputPath = await writeTempJson(tempDir, "resolver.json", makeResolverOutput());

    const result = await runNode([
      "--input", inputPath,
      "--repo", "owner/test-repo",
      "--overrides", "not valid json",
    ]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--overrides/,
      `error should mention --overrides, got: ${parsed.error}`);
    assert.ok(typeof parsed.usage === "string" && parsed.usage.length > 0,
      "should include usage field for flag-specific parse error");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope emits actionable error when auto-detected repo slug is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  try {
    const inputPath = await writeTempJson(tempDir, "resolver.json", makeResolverOutput());

    // Run in a temp dir that is inside a git repo but the envelope builder
    // resolves repoRoot; the key is no --repo and no usable origin.
    // We use cwd override via runNodeHelper option but since the script
    // runs as a child process we can set an env to guide.
    const result = await runNode(["--input", inputPath], {
      env: { ...process.env, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent" },
    });
    assert.equal(result.code, 1, `expected exit 1, got ${result.code} stdout:${result.stdout} stderr:${result.stderr}`);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--repo|origin|slug|resolver/i,
      `error should mention --repo or origin, got: ${parsed.error}`);
    assert.ok(typeof parsed.usage === "string" && parsed.usage.length > 0,
      "should include usage field for repo slug parse error");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("build-handoff-envelope auto-detects repo slug from git remote origin", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "build-handoff-envelope-"));
  const repoDir = path.join(tempDir, "repo");
  try {
    await writeFile(path.join(tempDir, "resolver.json"), `${JSON.stringify(makeResolverOutput())}\n`, "utf8");

    // Create a temp git repo with a remote origin
    const { execFileSync } = await import("node:child_process");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/test-repo.git"], { cwd: repoDir, stdio: "ignore" });

    const result = await runNode(["--input", path.join(tempDir, "resolver.json")], { cwd: repoDir });
    assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);

    const envelope = JSON.parse(result.stdout.trim());
    assert.equal(envelope.target.repo, "owner/test-repo",
      `expected owner/test-repo, got ${envelope.target.repo}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
