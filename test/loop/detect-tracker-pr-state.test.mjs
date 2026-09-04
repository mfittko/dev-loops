import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { parseDetectTrackerPrCliArgs } from "../../scripts/loop/detect-tracker-pr-state.mjs";

const scriptPath = path.resolve("scripts/loop/detect-tracker-pr-state.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeTempJson(tempDir, name, value) {
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// parseDetectTrackerPrCliArgs
// ---------------------------------------------------------------------------

test("parseDetectTrackerPrCliArgs rejects missing --input", () => {
  assert.throws(() => parseDetectTrackerPrCliArgs([]), /--input .* is required/i);
});

test("parseDetectTrackerPrCliArgs rejects missing value for --input", () => {
  assert.throws(() => parseDetectTrackerPrCliArgs(["--input"]), /Missing value for --input/);
});

test("parseDetectTrackerPrCliArgs rejects unknown arguments", () => {
  assert.throws(() => parseDetectTrackerPrCliArgs(["--unknown"]), /Unknown argument/);
});

test("parseDetectTrackerPrCliArgs parses --input path", () => {
  const options = parseDetectTrackerPrCliArgs(["--input", "snapshot.json"]);
  assert.equal(options.inputPath, "snapshot.json");
  assert.equal(options.help, false);
});

test("parseDetectTrackerPrCliArgs parses --help", () => {
  const options = parseDetectTrackerPrCliArgs(["--help"]);
  assert.equal(options.help, true);
});

test("parseDetectTrackerPrCliArgs parses -h", () => {
  const options = parseDetectTrackerPrCliArgs(["-h"]);
  assert.equal(options.help, true);
});

// ---------------------------------------------------------------------------
// CLI integration: --input mode
// ---------------------------------------------------------------------------

test("detect-tracker-pr-state CLI emits stable output for ready_no_pr state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-1",
      prExists: false,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "ready_no_pr");
    assert.deepEqual(parsed.allowedTransitions, ["draft_pr_open"]);
    assert.equal(parsed.reverseSyncAction, "none");
    assert.ok(typeof parsed.nextAction === "string" && parsed.nextAction.length > 0);
    assert.ok(parsed.snapshot);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits stable output for draft_pr_open state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-2",
      prExists: true,
      prNumber: 10,
      prDraft: true,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "draft_pr_open");
    assert.deepEqual(parsed.allowedTransitions, ["pr_reviewable"]);
    assert.equal(parsed.reverseSyncAction, "set_in_progress");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits stable output for pr_reviewable state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-3",
      prExists: true,
      prNumber: 11,
      prHeadSha: "abc1234",
      prDraft: false,
      prMerged: false,
      prClosed: false,
      draftGateCommentVisible: true,
      draftGateCommentHeadSha: "abc1234",
      draftGateCommentVerdict: "clean",
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "pr_reviewable");
    assert.equal(parsed.reverseSyncAction, "set_reviewable");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits stable output for pr_merged state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-4",
      prExists: true,
      prNumber: 12,
      prMerged: true,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "pr_merged");
    assert.deepEqual(parsed.allowedTransitions, []);
    assert.equal(parsed.reverseSyncAction, "set_done");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits stable output for pr_closed_unmerged state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-5",
      prExists: true,
      prNumber: 13,
      prClosed: true,
      prMerged: false,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "pr_closed_unmerged");
    assert.equal(parsed.reverseSyncAction, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI treats closed draft PR snapshots as pr_closed_unmerged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-5",
      prExists: true,
      prNumber: 13,
      prClosed: true,
      prDraft: true,
      prMerged: false,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "pr_closed_unmerged");
    assert.equal(parsed.reverseSyncAction, "none");
    assert.equal(parsed.snapshot.prDraft, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits stable output for no_tracker_item state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: false,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "no_tracker_item");
    assert.equal(parsed.reverseSyncAction, "none");
    assert.deepEqual(parsed.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI exits 1 with a usage hint for missing --input", async () => {
  const result = await runNode([]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.ok(typeof parsed.error === "string");
  assert.equal(parsed.hint, "run with --help for usage");
});

test("detect-tracker-pr-state CLI exits 1 with error for unknown argument", async () => {
  const result = await runNode(["--bogus"]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.ok(/unknown argument/i.test(parsed.error));
});

test("detect-tracker-pr-state CLI exits 1 when input file does not exist", async () => {
  const result = await runNode(["--input", "/tmp/does-not-exist-at-all.json"]);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stderr.trim());
  assert.equal(parsed.ok, false);
  assert.ok(typeof parsed.error === "string");
});

test("detect-tracker-pr-state CLI exits 1 for invalid JSON in input file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const badPath = path.join(tempDir, "bad.json");
    await writeFile(badPath, "not valid json{{{", "utf8");

    const result = await runNode(["--input", badPath]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.ok(/parse/i.test(parsed.error) || /json/i.test(parsed.error));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI exits 1 when snapshot is an array (invalid object)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const arrayPath = await writeTempJson(tempDir, "array.json", []);

    const result = await runNode(["--input", arrayPath]);
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr.trim());
    assert.equal(parsed.ok, false);
    assert.ok(typeof parsed.error === "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits blocked_needs_user_decision for contradictory snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-X",
      prExists: false,
      prMerged: true,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "blocked_needs_user_decision");
    assert.equal(parsed.reverseSyncAction, "none");
    assert.deepEqual(parsed.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits blocked_needs_user_decision when prNumber is present but prExists is false", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-PARTIAL",
      prExists: false,
      prNumber: 55,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.snapshot.prNumber, 55);
    assert.equal(parsed.snapshot.prExists, false);
    assert.equal(parsed.state, "blocked_needs_user_decision");
    assert.equal(parsed.reverseSyncAction, "none");
    assert.deepEqual(parsed.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits blocked_needs_user_decision for orphan PR snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: false,
      prExists: true,
      prNumber: 42,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "blocked_needs_user_decision");
    assert.equal(parsed.reverseSyncAction, "none");
    assert.deepEqual(parsed.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI emits pr_merged for merged-plus-closed snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "tracker-pr-state-test-"));
  try {
    const snapshotPath = await writeTempJson(tempDir, "snapshot.json", {
      trackerItemExists: true,
      trackerItemId: "PROJ-Y",
      prExists: true,
      prNumber: 77,
      prMerged: true,
      prClosed: true,
    });

    const result = await runNode(["--input", snapshotPath]);
    assert.equal(result.code, 0, `expected exit 0, got: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.state, "pr_merged");
    assert.equal(parsed.reverseSyncAction, "set_done");
    assert.deepEqual(parsed.allowedTransitions, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-tracker-pr-state CLI --help prints usage and exits 0", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0, `expected exit 0, got stderr: ${result.stderr}`);
  assert.ok(result.stdout.includes("--input"), "usage should mention --input");
});
