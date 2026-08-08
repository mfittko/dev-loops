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

test("buildRetrospectiveCheckpointPayload attaches a normalized identity when provided", () => {
  const now = new Date("2026-08-08T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload(
    { state: "complete", notes: "ok", identity: { repo: " a/b ", prNumber: 5, mergeCommit: " sha1 " } },
    now,
  );
  assert.deepEqual(payload, {
    state: "complete",
    completedAt: "2026-08-08T00:00:00.000Z",
    notes: "ok",
    identity: { repo: "a/b", prNumber: 5, mergeCommit: "sha1" },
  });
});

test("buildRetrospectiveCheckpointPayload drops an invalid identity rather than writing a partial one", () => {
  const now = new Date("2026-08-08T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload(
    { state: "required", identity: { repo: "a/b" } },
    now,
  );
  assert.deepEqual(payload, { state: "required", triggeredAt: "2026-08-08T00:00:00.000Z" });
});

// A validation regression here must never write a live checkpoint into the
// real repo's .pi/ (which would cascade into unrelated resolver tests) — run
// every rejection test from an isolated, throwaway cwd instead of the repo
// root, and assert no checkpoint file was written as a result.
async function withIsolatedCwd(fn) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-negative-"));
  try {
    await fn(tempDir);
    await assert.rejects(readFile(path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json"), "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("checkpoint-contract CLI rejects a partial identity (--repo without --pr/--merge-commit)", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "required", "--repo", "a/b"], { cwd });
    assert.equal(code, 1);
    const parsed = JSON.parse(stderr);
    assert.match(parsed.error, /together/i);
  });
});

test("checkpoint-contract CLI rejects a non-integer --pr", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "required", "--repo", "a/b", "--pr", "abc", "--merge-commit", "sha1"], { cwd });
    assert.equal(code, 1);
    const parsed = JSON.parse(stderr);
    assert.match(parsed.error, /positive integer/i);
  });
});

test("checkpoint-contract CLI rejects malformed --pr values a bare Number() would accept (0x10, 1e3, 12.0)", async () => {
  await withIsolatedCwd(async (cwd) => {
    for (const badPr of ["0x10", "1e3", "12.0"]) {
      const { code, stderr } = await runNode(["--state", "required", "--repo", "a/b", "--pr", badPr, "--merge-commit", "sha1"], { cwd });
      assert.equal(code, 1, `expected rejection for --pr ${badPr}`);
      assert.match(JSON.parse(stderr).error, /positive integer/i);
    }
  });
});

test("checkpoint-contract CLI rejects a whitespace-only --repo instead of silently dropping the identity", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "required", "--repo", "   ", "--pr", "5", "--merge-commit", "sha1"], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /together/i);
  });
});

test("checkpoint-contract CLI rejects a whitespace-only --merge-commit instead of silently dropping the identity", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "required", "--repo", "a/b", "--pr", "5", "--merge-commit", "   "], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /together/i);
  });
});

test("checkpoint-contract CLI rejects identity flags combined with --state none", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "none", "--repo", "a/b", "--pr", "5", "--merge-commit", "sha1"], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /--state none/i);
  });
});

test("checkpoint-contract CLI writes a checkpoint file carrying the cycle identity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-identity-"));
  try {
    const { code, stdout, stderr } = await runNode(
      ["--state", "required", "--repo", "mfittko/dev-loops", "--pr", "1613", "--merge-commit", "abc123"],
      { cwd: tempDir },
    );
    assert.equal(code, 0, stderr);
    const output = JSON.parse(stdout);
    assert.deepEqual(output.checkpoint.identity, { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: "abc123" });
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.deepEqual(checkpoint.identity, { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: "abc123" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
