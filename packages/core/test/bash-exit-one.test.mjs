import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendBashExitOneRecord,
  formatBashExitOneRecord,
  normalizeBashExitOneRecord,
  parseCliArgs,
  truncateText,
} from "../src/bash-exit-one.mjs";

test("truncateText truncates long text deterministically", () => {
  assert.equal(truncateText("abcdef", 4), "abcd…[truncated 2 chars]");
  assert.equal(truncateText("abc", 4), "abc");
  assert.equal(truncateText(undefined, 4), undefined);
});

test("normalizeBashExitOneRecord normalizes a valid record", () => {
  const record = normalizeBashExitOneRecord({
    timestamp: "2026-05-12T10:00:00Z",
    phase: "phase-0",
    cwd: "/tmp/project",
    command: "npm test",
    exitCode: 1,
    purpose: "validate current failing test state",
    summary: "tests fail because file-image.ts is missing",
    stdout: "ok",
    stderr: "bad",
  });

  assert.deepEqual(record, {
    timestamp: "2026-05-12T10:00:00Z",
    phase: "phase-0",
    cwd: "/tmp/project",
    command: "npm test",
    exitCode: 1,
    purpose: "validate current failing test state",
    summary: "tests fail because file-image.ts is missing",
    stdout: "ok",
    stderr: "bad",
  });
});

test("normalizeBashExitOneRecord rejects non-1 exit codes", () => {
  assert.throws(
    () =>
      normalizeBashExitOneRecord({
        phase: "phase-0",
        cwd: "/tmp/project",
        command: "npm test",
        exitCode: 2,
        purpose: "x",
        summary: "y",
      }),
    /exitCode must be 1/i,
  );
});

test("formatBashExitOneRecord formats one jsonl line", () => {
  const line = formatBashExitOneRecord({
    timestamp: "2026-05-12T10:00:00Z",
    phase: "phase-0",
    cwd: "/tmp/project",
    command: "npm test",
    exitCode: 1,
    purpose: "validate",
    summary: "failed",
  });

  assert.equal(line.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(line), {
    timestamp: "2026-05-12T10:00:00Z",
    phase: "phase-0",
    cwd: "/tmp/project",
    command: "npm test",
    exitCode: 1,
    purpose: "validate",
    summary: "failed",
  });
});

test("appendBashExitOneRecord appends a normalized record to jsonl", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-core-"));
  const logPath = path.join(tempDir, "bash-exit-1.jsonl");

  try {
    await appendBashExitOneRecord(logPath, {
      timestamp: "2026-05-12T10:00:00Z",
      phase: "phase-0",
      cwd: "/tmp/project",
      command: "npm test",
      exitCode: 1,
      purpose: "validate",
      summary: "failed",
    });

    const content = await readFile(logPath, "utf8");
    const [line] = content.trim().split("\n");

    assert.deepEqual(JSON.parse(line), {
      timestamp: "2026-05-12T10:00:00Z",
      phase: "phase-0",
      cwd: "/tmp/project",
      command: "npm test",
      exitCode: 1,
      purpose: "validate",
      summary: "failed",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseCliArgs parses expected arguments", () => {
  assert.deepEqual(parseCliArgs(["--log", "tmp/x.jsonl", "--record", "{}"]), {
    logPath: "tmp/x.jsonl",
    recordJson: "{}",
  });
});

test("parseCliArgs rejects unknown arguments", () => {
  assert.throws(() => parseCliArgs(["--wat"]), /unknown argument/i);
});
