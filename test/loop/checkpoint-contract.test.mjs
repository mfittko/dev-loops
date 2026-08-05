import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode as runNodeHelper } from "../_helpers.mjs";
import { buildRetrospectiveCheckpointPayload } from "../../scripts/loop/checkpoint-contract.mjs";

const scriptPath = path.resolve("scripts/loop/checkpoint-contract.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

test("checkpoint-contract CLI requires --state", async () => {
  const { code, stderr } = await runNode([]);
  assert.equal(code, 1);
  const parsed = JSON.parse(stderr);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /Missing required option: --state/i);
});

test("checkpoint-contract CLI rejects invalid --state values", async () => {
  const { code, stderr } = await runNode(["--state", "compleat"]);
  assert.equal(code, 1);
  const parsed = JSON.parse(stderr);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /must be one of/);
  // Short-error contract (formatCliError): a `hint` pointing at --help, never
  // the full usage text inlined into the JSON payload.
  assert.match(parsed.hint, /--help/);
});

test("checkpoint-contract CLI enforces state-specific metadata", async () => {
  const c1 = await runNode(["--state", "complete"]);
  assert.equal(c1.code, 1);
  assert.match(JSON.parse(c1.stderr).error, /notes/i);

  const c2 = await runNode(["--state", "skipped"]);
  assert.equal(c2.code, 1);
  assert.match(JSON.parse(c2.stderr).error, /reason/i);
});

test("buildRetrospectiveCheckpointPayload writes complete payload shape", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload({ state: "complete", notes: "all good" }, now);
  assert.deepEqual(payload, { state: "complete", completedAt: "2026-06-05T00:00:00.000Z", notes: "all good" });
});

test("buildRetrospectiveCheckpointPayload writes skipped payload shape", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload({ state: "skipped", reason: "not needed" }, now);
  assert.deepEqual(payload, { state: "skipped", skippedAt: "2026-06-05T00:00:00.000Z", reason: "not needed" });
});

test("buildRetrospectiveCheckpointPayload writes required payload shape", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload({ state: "required" }, now);
  assert.deepEqual(payload, { state: "required", triggeredAt: "2026-06-05T00:00:00.000Z" });
});

test("buildRetrospectiveCheckpointPayload writes missing payload with triggeredAt timestamp", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload({ state: "missing" }, now);
  assert.deepEqual(payload, { state: "missing", triggeredAt: "2026-06-05T00:00:00.000Z" });
});

test("buildRetrospectiveCheckpointPayload writes none payload without timestamp", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload({ state: "none" }, now);
  assert.deepEqual(payload, { state: "none" });
});

test("checkpoint-contract CLI writes checkpoint file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-test-"));
  try {
    const { code, stdout, stderr } = await runNode(
      ["--state", "complete", "--notes", "Retrospective documented after merge"],
      { cwd: tempDir },
    );
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.checkpoint.state, "complete");
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.state, "complete");
    assert.equal(checkpoint.notes, "Retrospective documented after merge");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("checkpoint-contract CLI writes skipped checkpoint file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-test-"));
  try {
    const { code, stdout, stderr } = await runNode(
      ["--state", "skipped", "--reason", "Doc-only change"],
      { cwd: tempDir },
    );
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.checkpoint.state, "skipped");
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.state, "skipped");
    assert.equal(checkpoint.reason, "Doc-only change");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("checkpoint-contract CLI writes required checkpoint file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-test-"));
  try {
    const { code, stdout, stderr } = await runNode(["--state", "required"], { cwd: tempDir });
    assert.equal(code, 0);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.checkpoint.state, "required");
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.state, "required");
    assert.equal(typeof checkpoint.triggeredAt, "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
