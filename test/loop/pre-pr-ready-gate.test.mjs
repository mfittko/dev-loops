import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

import { parsePrePrReadyGateCliArgs } from "../../scripts/loop/pre-pr-ready-gate.mjs";

const scriptPath = path.resolve("scripts/loop/pre-pr-ready-gate.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries, options = {}) {
  return writeGhStubHelper(tempDir, entries, {
    repeatLastOnOverflow: true,
    logCalls: true,
    ...options,
  });
}

// --- parsePrePrReadyGateCliArgs unit tests ---

test("parsePrePrReadyGateCliArgs requires --repo and --pr", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs([]),
    /requires both --repo.*and --pr/,
  );
});

test("parsePrePrReadyGateCliArgs requires --repo value", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--pr", "17"]),
    /requires both --repo.*and --pr/,
  );
});

test("parsePrePrReadyGateCliArgs requires --pr value", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "owner/repo"]),
    /requires both --repo.*and --pr/,
  );
});

test("parsePrePrReadyGateCliArgs rejects non-numeric --pr", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "owner/repo", "--pr", "abc"]),
    /positive integer/,
  );
});

test("parsePrePrReadyGateCliArgs rejects zero --pr", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "owner/repo", "--pr", "0"]),
    /positive integer/,
  );
});

test("parsePrePrReadyGateCliArgs rejects invalid repo slug", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "invalid", "--pr", "1"]),
    /must match.*owner.*name/i,
  );
});

test("parsePrePrReadyGateCliArgs --help returns help option", () => {
  const result = parsePrePrReadyGateCliArgs(["--help"]);
  assert.equal(result.help, true);
});

test("parsePrePrReadyGateCliArgs parses valid repo and pr", () => {
  const result = parsePrePrReadyGateCliArgs(["--repo", "owner/repo", "--pr", "42"]);
  assert.equal(result.repo, "owner/repo");
  assert.equal(result.pr, 42);
});

// --- Shared test data ---

const HEAD_SHA = "25c3c8d475d6ac73f8a22747677e699553ded138";
const HEAD_SHA_SHORT = HEAD_SHA.slice(0, 7);

function buildPrStateResponse(overrides = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_123",
          isDraft: true,
          headRefOid: HEAD_SHA,
          state: "OPEN",
          ...overrides,
        },
      },
    },
  };
}

function makeDraftGateComment(commentSha = HEAD_SHA_SHORT, extraFields = true) {
  const lines = [
    "Gate review: draft_gate",
    `Reviewed head SHA: ${commentSha}`,
    "Verdict: clean",
  ];
  if (extraFields) {
    lines.push("Findings summary: no issues found");
    lines.push("Next action: mark ready for review");
  }
  return {
    id: 100,
    body: lines.join("\n"),
    author: { login: "pi-local-run" },
    createdAt: "2026-06-07T00:00:00Z",
    updated_at: "2026-06-07T00:00:00Z",
  };
}

// --- Gate integration tests ---

test("gate passes: draft PR with clean draft_gate comment for current head", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([makeDraftGateComment(HEAD_SHA_SHORT)]) },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
});

test("gate passes: clean draft verdict lives only in the review stream (single-surface round)", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: "[]" }, // issue comments: no verdict on the legacy surface
    {
      stdout: JSON.stringify([
        {
          ...makeDraftGateComment(HEAD_SHA_SHORT),
          state: "COMMENTED",
          submitted_at: "2026-06-07T00:00:00Z",
          html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-100",
        },
      ]),
    },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
});

test("gate passes off a legacy issue-comment verdict when the reviews fetch fails (fail-open)", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([makeDraftGateComment(HEAD_SHA_SHORT)]) },
    { stdout: "", code: 1, stderr: "HTTP 500" }, // reviews fetch fails
  ], { repeatLastOnOverflow: false });

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).draftGateSatisfied, true);
});

test("gate blocks: draft PR without draft_gate evidence", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([]) },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
  assert.match(stderrParsed.error, /No visible clean draft_gate/);
});

test("gate blocks: draft PR with draft_gate for different head SHA", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([makeDraftGateComment("9999999")]) },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
});

test("gate passes: non-draft PR with visible clean draft_gate (relaxed, any head)", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  // Even though the draft_gate comment has a different head SHA,
  // the PR is no longer draft so any visible clean draft_gate is sufficient
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: false })) },
    { stdout: JSON.stringify([makeDraftGateComment("9999999")]) },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
});

test("gate blocks: non-draft PR without any clean draft_gate", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: false })) },
    { stdout: JSON.stringify([]) },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
});

test("gate handles GraphQL API errors gracefully", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: "", code: 1, stderr: "GraphQL API error" },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  // The script catches errors in runCli and writes to stderr
  assert.equal(result.code, 1);
  assert.ok(result.stderr.trim().length > 0, "stderr should have content");
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
});

test("gate handles comment fetch errors gracefully", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: "", code: 1, stderr: "comments fetch error" },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.trim().length > 0, "stderr should have content");
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
});
