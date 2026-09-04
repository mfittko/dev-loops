import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "loop", "debt-remediate.mjs");

const uuid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

async function withInputFile(input, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "debt-remediate-contract-"));
  const inputPath = path.join(tmpDir, "signals.json");
  await writeFile(inputPath, JSON.stringify(input));
  try {
    return await fn(inputPath, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function withRawFile(content, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "debt-remediate-raw-"));
  const inputPath = path.join(tmpDir, "signals.json");
  await writeFile(inputPath, content);
  try {
    return await fn(inputPath, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function buildSignal(overrides = {}) {
  return {
    id: uuid(Math.floor(Math.random() * 10000)),
    sourceType: "pr_review_deep_persona",
    signalKind: "spaghetti_branching",
    location: { filePath: "src/auth/login.mjs" },
    severityHint: "high",
    timestamp: "2024-06-03T12:00:00Z",
    confidence: 0.9,
    ...overrides,
  };
}

function runCli(args) {
  return spawnSync((Bun.which("node") ?? "node"), [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("debt-remediate help documents accepted flags and JSON contracts", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Usage:\n  debt-remediate\.mjs --input <path>/);
  assert.match(result.stdout, /--input <path>\s+Path to a JSON file/);
  assert.match(result.stdout, /--repo <owner\/name>\s+Target repository/);
  assert.match(result.stdout, /--dry-run\s+Validate and report/);
});

test("debt-remediate missing --input exits with error", () => {
  const result = runCli([]);
  assert.equal(result.status, 1);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert.match(err.error, /Missing required flag/);
});

test("debt-remediate invalid JSON input exits with error", async () => {
  await withRawFile("this is not json at all {{{", async (inputPath) => {
    const result = runCli(["--input", inputPath]);
    assert.equal(result.status, 1);
    const err = JSON.parse(result.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /not valid JSON/);
  });
});

test("debt-remediate empty array exits with error", async () => {
  await withInputFile([], async (inputPath) => {
    const result = runCli(["--input", inputPath]);
    assert.equal(result.status, 1);
    const err = JSON.parse(result.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /at least one/);
  });
});

test("debt-remediate invalid signal schema exits with validation errors", async () => {
  await withInputFile([{ id: "not-a-uuid" }], async (inputPath) => {
    const result = runCli(["--input", inputPath]);
    assert.equal(result.status, 1);
    const err = JSON.parse(result.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /Signal validation failed/);
    assert.ok(Array.isArray(err.validationErrors));
  });
});

test("debt-remediate dry-run produces report without creating issues", async () => {
  const signals = [
    buildSignal({ id: uuid(1), location: { filePath: "src/auth/login.mjs" } }),
    buildSignal({ id: uuid(2), location: { filePath: "src/auth/login.mjs" } }),
  ];

  await withInputFile(signals, async (inputPath) => {
    const result = runCli(["--input", inputPath, "--dry-run", "--repo", "test/test"]);
    assert.equal(result.status, 0);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.signals, 2);
    assert.ok(report.findings >= 0);
    assert.ok(typeof report.summary === "string");
    assert.ok(report.summary.includes("signals"));
    assert.ok(report.summary.includes("findings"));
  });
});

test("debt-remediate report JSON shape is stable", async () => {
  const signals = [
    buildSignal({ id: uuid(1), location: { filePath: "src/lib/util.mjs" } }),
    buildSignal({ id: uuid(2), location: { filePath: "src/lib/util.mjs" } }),
  ];

  await withInputFile(signals, async (inputPath) => {
    const result = runCli(["--input", inputPath, "--dry-run", "--repo", "test/test"]);
    assert.equal(result.status, 0);

    const report = JSON.parse(result.stdout);
    const topKeys = Object.keys(report).sort();
    assert.ok(topKeys.includes("ok"));
    assert.ok(topKeys.includes("dryRun"));
    assert.ok(topKeys.includes("repo"));
    assert.ok(topKeys.includes("signals"));
    assert.ok(topKeys.includes("findings"));
    assert.ok(topKeys.includes("remediationItems"));
    assert.ok(topKeys.includes("debtEpics"));
    assert.ok(topKeys.includes("deferred"));
    assert.ok(topKeys.includes("watching"));
    assert.ok(topKeys.includes("dismissed"));
    assert.ok(topKeys.includes("issues"));
    assert.ok(topKeys.includes("summary"));
    assert.ok(Array.isArray(report.issues));
  });
});

test("debt-remediate high-scoring same-file signals produce remediation_item", async () => {
  const signals = [
    buildSignal({ id: uuid(1), location: { filePath: "src/lib/util.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(2), location: { filePath: "src/lib/util.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(3), location: { filePath: "src/lib/util.mjs" }, severityHint: "critical" }),
  ];

  await withInputFile(signals, async (inputPath) => {
    const result = runCli(["--input", inputPath, "--dry-run", "--repo", "test/test"]);
    assert.equal(result.status, 0);

    const report = JSON.parse(result.stdout);
    assert.ok(report.remediationItems >= 1, `Expected at least 1 remediation item, got ${report.remediationItems}`);
  });
});

test("debt-remediate multiple distinct findings produce multiple issues in report", async () => {
  const signals = [
    buildSignal({ id: uuid(1), location: { filePath: "src/auth/login.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(2), location: { filePath: "src/auth/login.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(3), location: { filePath: "src/db/query.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(4), location: { filePath: "src/db/query.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(5), location: { filePath: "src/api/routes.mjs" }, severityHint: "critical" }),
    buildSignal({ id: uuid(6), location: { filePath: "src/api/routes.mjs" }, severityHint: "critical" }),
  ];

  await withInputFile(signals, async (inputPath) => {
    const result = runCli(["--input", inputPath, "--dry-run", "--repo", "test/test"]);
    assert.equal(result.status, 0);

    const report = JSON.parse(result.stdout);
    assert.ok(report.remediationItems >= 1, `Expected at least 1 remediation item, got ${report.remediationItems}`);
    assert.ok(Array.isArray(report.issues));
    // Issues array entries only exist for remediation_item outcomes
    assert.equal(report.issues.length, report.remediationItems);
    // Verify each issue entry has the contract shape
    for (const issue of report.issues) {
      assert.ok(typeof issue.findingId === "string");
      assert.ok(typeof issue.created === "boolean");
      if (report.dryRun) {
        assert.equal(issue.created, false);
      }
    }
  });
});

test("debt-remediate non-actionable outcomes produce zero issue entries", async () => {
  // Low-severity signals with info severityHint → score should stay below ITEM_THRESHOLD
  const signals = [
    buildSignal({ id: uuid(1), location: { filePath: "src/misc/notes.txt" }, severityHint: "info" }),
    buildSignal({ id: uuid(2), location: { filePath: "src/misc/notes.txt" }, severityHint: "info" }),
  ];

  await withInputFile(signals, async (inputPath) => {
    const result = runCli(["--input", inputPath, "--dry-run", "--repo", "test/test"]);
    assert.equal(result.status, 0);

    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    // With low-severity info signals on a non-source file, expect 0 remediation items
    assert.equal(report.remediationItems, 0, `Expected 0 remediation items, got ${report.remediationItems}`);
    assert.equal(report.issues.length, 0);
    // Non-actionable outcomes should appear in their respective buckets
    const totalNonActionable = report.deferred + report.watching + report.dismissed + report.debtEpics;
    assert.ok(totalNonActionable >= 1, `Expected some non-actionable outcome, got none`);
  });
});

test("debt-remediate unknown flag exits with error", async () => {
  const signals = [buildSignal()];
  await withInputFile(signals, async (inputPath) => {
    const result = runCli(["--input", inputPath, "--unknown-flag"]);
    assert.equal(result.status, 1);
    const err = JSON.parse(result.stderr);
    assert.equal(err.ok, false);
    assert.match(err.error, /Unknown flag/);
  });
});
