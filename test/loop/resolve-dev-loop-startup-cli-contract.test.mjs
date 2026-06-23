import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "loop", "resolve-dev-loop-startup.mjs");

async function withInputFile(input, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "resolve-dev-loop-cli-contract-"));
  const inputPath = path.join(tmpDir, "startup-input.json");
  await writeFile(inputPath, JSON.stringify(input));
  try {
    return await fn(inputPath, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test("resolve-dev-loop-startup help documents accepted flags and JSON contracts", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage:\n  resolve-dev-loop-startup\.mjs --issue <number>/);
  assert.match(result.stdout, /--issue <n>\s+Target an issue/);
  assert.match(result.stdout, /--pr <n>\s+Target a PR/);
  assert.match(result.stdout, /--input <path>\s+Path to a JSON file/);
  assert.match(result.stdout, /Exit codes:\n  0  Success\n  1  Argument error, runtime failure, or async-start contract rejection/);
});

test("resolve-dev-loop-startup success stdout keeps documented JSON shape", async () => {
  // Use a complete retrospective so route resolves (not blocked by enforcement).
  await withInputFile({
    currentState: {
      target: { kind: "issue", issue: 429 },
      ownership: "copilot",
      nextActor: "user",
      status: "active",
      authorization: "authorized",
    },
    artifactState: "not_applicable",
    issueLinkageResolution: "resolved_no_open_pr",
    issueReadiness: "ready",
    issueAssignmentState: "unassigned",
    loopState: "active",
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, PI_SUBAGENT_RUN_ID: "test-run-123" },
      // Note: This test assumes no .pi/dev-loop-retrospective-checkpoint.json
      // exists in repoRoot — the explicit retrospectiveCheckpointState in the
      // input ensures deterministic routing regardless.
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");

    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(parsed), [
      "ok",
      "bundleKind",
      "selectedStrategy",
      "requiredReads",
      "nextAction",
      "canonicalStateSummary",
      "bundle",
    ]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.bundleKind, "resolved");
    assert.equal(parsed.selectedStrategy, "issue_intake");
    assert.deepEqual(parsed.requiredReads, [
      "skills/docs/public-dev-loop-contract.md",
      "skills/docs/retrospective-checkpoint-contract.md",
      "skills/copilot-pr-followup/SKILL.md",
      "skills/docs/copilot-loop-operations.md",
      "skills/docs/issue-intake-procedure.md",
    ]);
    assert.deepEqual(Object.keys(parsed.canonicalStateSummary), [
      "target",
      "ownership",
      "nextActor",
      "status",
      "authorization",
      "artifactState",
      "issueLinkageResolution",
      "loopState",
      "routeKind",
      "selectedGate",
      "executionMode",
      "waitSemantics",
      "requiresAsyncDispatch",
    ]);
    assert.equal(parsed.canonicalStateSummary.requiresAsyncDispatch, true);
    assert.equal(parsed.bundle.contractTrace.decision.selectedGate, "issue_intake");
  });
});

test("resolve-dev-loop-startup rejects async-required strategy via stderr contract", async () => {
  // This test verifies the CLI-level async-start contract:
  // without PI_SUBAGENT_RUN_ID or an allowed asyncStartMode setting, an async-required
  // route exits 1 with empty stdout and the rejection object on stderr.
  await withInputFile({
    currentState: {
      target: { kind: "issue", issue: 89, linkedPr: 92 },
      ownership: "copilot",
      nextActor: "copilot",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "open",
    issueLinkageResolution: "resolved_linked_pr",
    loopState: "unresolved_feedback_present",
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      cwd: repoRoot,
      encoding: "utf8",
      // Deliberately omit PI_SUBAGENT_RUN_ID.
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k !== "PI_SUBAGENT_RUN_ID",
        ),
      ),
    });

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);
    assert.equal(result.stdout, "", `expected empty stdout, got: ${result.stdout}`);

    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.asyncStartContract, "rejected");
    assert.ok(parsed.error.includes("async context"));
  });
});

test("resolve-dev-loop-startup honors maintainer-controlled asyncStartMode=allowed from cwd config", async () => {
  await withInputFile({
    currentState: {
      target: { kind: "issue", issue: 89, linkedPr: 92 },
      ownership: "copilot",
      nextActor: "copilot",
      status: "active",
      authorization: "needs_confirmation",
    },
    artifactState: "open",
    issueLinkageResolution: "resolved_linked_pr",
    loopState: "unresolved_feedback_present",
    retrospectiveCheckpointState: "complete",
  }, async (inputPath, tmpDir) => {
    await mkdir(path.join(tmpDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(
      path.join(tmpDir, ".pi", "dev-loop", "settings.yaml"),
      "version: 1\nworkflow:\n  asyncStartMode: allowed\n",
      "utf8",
    );

    const result = spawnSync(process.execPath, [cliPath, "--input", inputPath], {
      cwd: tmpDir,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => k !== "PI_SUBAGENT_RUN_ID",
        ),
      ),
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    if (result.stderr !== "") {
      assert.match(result.stderr, /DEV_LOOP_ROUTING_CONFIG_FALLBACK/);
    }
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.selectedStrategy, "copilot_pr_followup");
  });
});

test("resolve-dev-loop-startup malformed args keep documented stderr JSON shape", () => {
  const result = spawnSync(process.execPath, [cliPath, "--bogus"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const parsed = JSON.parse(result.stderr);
  assert.deepEqual(Object.keys(parsed), ["ok", "error", "usage"]);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "Unknown argument: --bogus");
  assert.match(parsed.usage, /Usage:\n  resolve-dev-loop-startup\.mjs --issue <number>/);
});
