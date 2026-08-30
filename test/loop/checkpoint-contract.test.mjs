import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initGitFixture, runNode as runNodeHelper } from "../_helpers.mjs";
import { buildRetrospectiveCheckpointPayload, resolveCheckpointRepoRoot } from "../../scripts/loop/checkpoint-contract.mjs";

const scriptPath = path.resolve("scripts/loop/checkpoint-contract.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// A well-formed, valid full-40-hex commit oid fixture — every test below that
// is not specifically testing the hex-shape validation itself uses this.
const VALID_SHA = "abcdef0123456789abcdef0123456789abcdef01";

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
    await mkdir(path.join(tempDir, "tmp", "retro"), { recursive: true });
    await writeFile(path.join(tempDir, "tmp", "retro", "transcript.jsonl"), "tool-call record line\n", "utf8");
    const { code, stdout, stderr } = await runNode(
      [
        "--state", "complete", "--notes", "Retrospective documented after merge",
        "--retro-context", "fresh", "--record-source", "tmp/retro/transcript.jsonl",
        "--repo", "mfittko/dev-loops", "--pr", "1613", "--merge-commit", VALID_SHA,
      ],
      { cwd: tempDir },
    );
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.checkpoint.state, "complete");
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.state, "complete");
    assert.equal(checkpoint.notes, "Retrospective documented after merge");
    assert.deepEqual(checkpoint.identity, { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: VALID_SHA });
    assert.deepEqual(checkpoint.provenance, {
      context: "fresh",
      seededFrom: "agent_tool_call_record",
      recordSource: "tmp/retro/transcript.jsonl",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("checkpoint-contract CLI writes skipped checkpoint file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-test-"));
  try {
    const { code, stdout, stderr } = await runNode(
      [
        "--state", "skipped", "--reason", "Doc-only change",
        "--repo", "mfittko/dev-loops", "--pr", "1613", "--merge-commit", VALID_SHA,
      ],
      { cwd: tempDir },
    );
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.checkpoint.state, "skipped");
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(checkpoint.state, "skipped");
    assert.equal(checkpoint.reason, "Doc-only change");
    assert.deepEqual(checkpoint.identity, { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: VALID_SHA });
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
    const { code, stderr } = await runNode(["--state", "required", "--repo", "a/b", "--pr", "abc", "--merge-commit", VALID_SHA], { cwd });
    assert.equal(code, 1);
    const parsed = JSON.parse(stderr);
    assert.match(parsed.error, /positive integer/i);
  });
});

test("checkpoint-contract CLI rejects malformed --pr values a bare Number() would accept (0x10, 1e3, 12.0)", async () => {
  await withIsolatedCwd(async (cwd) => {
    for (const badPr of ["0x10", "1e3", "12.0"]) {
      const { code, stderr } = await runNode(["--state", "required", "--repo", "a/b", "--pr", badPr, "--merge-commit", VALID_SHA], { cwd });
      assert.equal(code, 1, `expected rejection for --pr ${badPr}`);
      assert.match(JSON.parse(stderr).error, /positive integer/i);
    }
  });
});

test("checkpoint-contract CLI rejects a whitespace-only --repo instead of silently dropping the identity", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "required", "--repo", "   ", "--pr", "5", "--merge-commit", VALID_SHA], { cwd });
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
    const { code, stderr } = await runNode(["--state", "none", "--repo", "a/b", "--pr", "5", "--merge-commit", VALID_SHA], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /--state none/i);
  });
});

test("checkpoint-contract CLI writes a checkpoint file carrying the cycle identity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-contract-identity-"));
  try {
    const { code, stdout, stderr } = await runNode(
      ["--state", "required", "--repo", "mfittko/dev-loops", "--pr", "1613", "--merge-commit", VALID_SHA],
      { cwd: tempDir },
    );
    assert.equal(code, 0, stderr);
    const output = JSON.parse(stdout);
    assert.deepEqual(output.checkpoint.identity, { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: VALID_SHA });
    const checkpointPath = path.join(tempDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.deepEqual(checkpoint.identity, { repo: "mfittko/dev-loops", prNumber: 1613, mergeCommit: VALID_SHA });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// `complete`/`skipped` MUST carry an identity (checkpoint-contract-cycle-
// scoping requirement) — without one, a discharge record can never be told
// apart from a stale one, and re-running the identical command could never
// clear a resulting permanently-stale MISSING state.

test("checkpoint-contract CLI rejects --state complete without a cycle identity", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "complete", "--notes", "ok", "--retro-context", "fresh", "--record-source", "tmp/retro/record.jsonl"], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /requires a cycle identity/i);
  });
});

test("checkpoint-contract CLI rejects --state skipped without a cycle identity", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "skipped", "--reason", "trivial"], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /requires a cycle identity/i);
  });
});

test("checkpoint-contract CLI rejects a non-40-hex --merge-commit", async () => {
  await withIsolatedCwd(async (cwd) => {
    for (const badSha of ["abc123", VALID_SHA.slice(0, 39), `${VALID_SHA}a`, "not-hex-at-all-not-hex-at-all-not-hexxx"]) {
      const { code, stderr } = await runNode(
        ["--state", "required", "--repo", "a/b", "--pr", "5", "--merge-commit", badSha],
        { cwd },
      );
      assert.equal(code, 1, `expected rejection for --merge-commit ${badSha}`);
      assert.match(JSON.parse(stderr).error, /40-character commit oid/i);
    }
  });
});

test("checkpoint-contract CLI rejects a malformed --repo shape", async () => {
  await withIsolatedCwd(async (cwd) => {
    for (const badRepo of ["mfittko", "mfittko/dev-loops/extra", "mfittko//dev-loops"]) {
      const { code, stderr } = await runNode(
        ["--state", "required", "--repo", badRepo, "--pr", "5", "--merge-commit", VALID_SHA],
        { cwd },
      );
      assert.equal(code, 1, `expected rejection for --repo ${badRepo}`);
      assert.match(JSON.parse(stderr).error, /owner\/name shape/i);
    }
  });
});

test("checkpoint-contract CLI rejects a whitespace-only --notes for state complete", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "complete", "--notes", "   "], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /notes/i);
  });
});

test("checkpoint-contract CLI rejects a whitespace-only --reason for state skipped", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(["--state", "skipped", "--reason", "   "], { cwd });
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /reason/i);
  });
});

// ---------------------------------------------------------------------------
// Fresh-context provenance (issue #1870) — a `complete` record MUST pin that
// the retrospective was produced by a fresh-context, independent dispatch
// seeded with the full agent/subagent tool-call record. An inline
// (self-authored) retro is rejected outright; so is a complete record with
// no provenance at all.
// ---------------------------------------------------------------------------

test("checkpoint-contract CLI rejects a --record-source that does not resolve to an existing non-empty file", async () => {
  await withIsolatedCwd(async (cwd) => {
    for (const badSource of ["tmp/retro/missing-record.jsonl", "tmp/retro/empty-record.jsonl"]) {
      if (badSource.endsWith("empty-record.jsonl")) {
        await mkdir(path.join(cwd, "tmp", "retro"), { recursive: true });
        await writeFile(path.join(cwd, "tmp", "retro", "empty-record.jsonl"), "", "utf8");
      }
      const { code, stderr } = await runNode(
        ["--state", "complete", "--notes", "ok", "--retro-context", "fresh", "--record-source", badSource, "--repo", "mfittko/dev-loops", "--pr", "5", "--merge-commit", VALID_SHA],
        { cwd },
      );
      assert.equal(code, 1, `expected rejection for --record-source ${badSource}`);
      assert.match(JSON.parse(stderr).error, /existing, non-empty file/i);
    }
  });
});

test("checkpoint-contract CLI rejects --state complete without --retro-context", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(
      ["--state", "complete", "--notes", "ok", "--repo", "mfittko/dev-loops", "--pr", "5", "--merge-commit", VALID_SHA],
      { cwd },
    );
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /--retro-context fresh/i);
  });
});

test("checkpoint-contract CLI rejects an inline (self-authored) retrospective outright", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(
      ["--state", "complete", "--notes", "ok", "--retro-context", "inline", "--record-source", "tmp/retro/record.jsonl", "--repo", "mfittko/dev-loops", "--pr", "5", "--merge-commit", VALID_SHA],
      { cwd },
    );
    assert.equal(code, 1);
    const parsed = JSON.parse(stderr);
    assert.match(parsed.error, /inline/i);
    assert.match(parsed.error, /fails the checkpoint/i);
    // The rejection must not have written a checkpoint file.
    const checkpointPath = path.join(cwd, ".pi", "dev-loop-retrospective-checkpoint.json");
    await assert.rejects(readFile(checkpointPath, "utf8"), { code: "ENOENT" });
  });
});

test("checkpoint-contract CLI rejects an unrecognized --retro-context value", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(
      ["--state", "complete", "--notes", "ok", "--retro-context", "vibes", "--record-source", "tmp/retro/record.jsonl", "--repo", "mfittko/dev-loops", "--pr", "5", "--merge-commit", VALID_SHA],
      { cwd },
    );
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /must be "fresh"/i);
  });
});

test("checkpoint-contract CLI rejects --state complete without --record-source", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(
      ["--state", "complete", "--notes", "ok", "--retro-context", "fresh", "--repo", "mfittko/dev-loops", "--pr", "5", "--merge-commit", VALID_SHA],
      { cwd },
    );
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /--record-source/i);
  });
});

test("checkpoint-contract CLI rejects a whitespace-only --record-source", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(
      ["--state", "complete", "--notes", "ok", "--retro-context", "fresh", "--record-source", "   ", "--repo", "mfittko/dev-loops", "--pr", "5", "--merge-commit", VALID_SHA],
      { cwd },
    );
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /--record-source/i);
  });
});

test("checkpoint-contract CLI rejects provenance flags with a non-complete state", async () => {
  await withIsolatedCwd(async (cwd) => {
    const { code, stderr } = await runNode(
      ["--state", "none", "--retro-context", "fresh", "--record-source", "tmp/retro/record.jsonl"],
      { cwd },
    );
    assert.equal(code, 1);
    assert.match(JSON.parse(stderr).error, /only apply to --state complete/i);
  });
});

test("buildRetrospectiveCheckpointPayload attaches a normalized provenance to complete", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const payload = buildRetrospectiveCheckpointPayload(
    {
      state: "complete",
      notes: "ok",
      provenance: { context: "fresh", seededFrom: "agent_tool_call_record", recordSource: " tmp/retro/record.jsonl " },
    },
    now,
  );
  assert.deepEqual(payload.provenance, { context: "fresh", seededFrom: "agent_tool_call_record", recordSource: "tmp/retro/record.jsonl" });
});

test("buildRetrospectiveCheckpointPayload throws on an invalid provenance instead of writing a partial one", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  // Fail closed at WRITE time: a programmatic caller passing an inline/invalid
  // provenance must not get a silently-dropped (provenance-less) complete
  // record that only fails closed at read time with no write signal.
  assert.throws(
    () => buildRetrospectiveCheckpointPayload(
      { state: "complete", notes: "ok", provenance: { context: "inline", seededFrom: "agent_tool_call_record", recordSource: "x" } },
      now,
    ),
    /Invalid retrospective provenance/,
  );
});

test("buildRetrospectiveCheckpointPayload omits provenance for non-complete states even when provided", () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  // Even an INVALID provenance object is ignored for a non-complete state:
  // provenance is a complete-only field, so a skipped payload neither throws
  // nor records any provenance (the same object would throw for "complete").
  const payload = buildRetrospectiveCheckpointPayload(
    { state: "skipped", reason: "trivial", provenance: { context: "inline", seededFrom: "agent_tool_call_record", recordSource: "tmp/retro/record.jsonl" } },
    now,
  );
  assert.equal(payload.provenance, undefined);
});

// ---------------------------------------------------------------------------
// resolveCheckpointRepoRoot — the write path resolves the MAIN checkout, not
// a cwd-relative path, so a worktree write is never silently discarded when
// that worktree is later removed.
// ---------------------------------------------------------------------------

test("resolveCheckpointRepoRoot: falls back to cwd itself outside any git repo", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-root-non-repo-"));
  try {
    assert.equal(resolveCheckpointRepoRoot(tempDir), tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCheckpointRepoRoot: resolves the main checkout from inside a linked worktree", async () => {
  const mainDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-root-main-"));
  const worktreeParent = await mkdtemp(path.join(os.tmpdir(), "checkpoint-root-wt-parent-"));
  const worktreeDir = path.join(worktreeParent, "linked");
  try {
    initGitFixture(mainDir);
    execFileSync("git", ["worktree", "add", "--quiet", worktreeDir, "-b", "linked-branch"], { cwd: mainDir, stdio: "ignore" });

    // git internally resolves realpaths (e.g. /var vs the macOS /private/var
    // symlink), so both sides are compared through realpathSync.
    const expectedMainRoot = realpathSync(mainDir);
    // Resolved from the MAIN checkout itself: identity.
    assert.equal(realpathSync(resolveCheckpointRepoRoot(mainDir)), expectedMainRoot);
    // Resolved from the LINKED worktree: still the main checkout, never the
    // worktree's own path — this is the fix for the read/write path split.
    assert.equal(realpathSync(resolveCheckpointRepoRoot(worktreeDir)), expectedMainRoot);
  } finally {
    try { execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: mainDir, stdio: "ignore" }); } catch { /* best-effort */ }
    await rm(mainDir, { recursive: true, force: true });
    await rm(worktreeParent, { recursive: true, force: true });
  }
});

test("checkpoint-contract CLI writes to the MAIN checkout when invoked from a linked worktree, not the worktree's own .pi/", async () => {
  const mainDir = await mkdtemp(path.join(os.tmpdir(), "checkpoint-write-main-"));
  const worktreeParent = await mkdtemp(path.join(os.tmpdir(), "checkpoint-write-wt-parent-"));
  const worktreeDir = path.join(worktreeParent, "linked");
  try {
    initGitFixture(mainDir);
    execFileSync("git", ["worktree", "add", "--quiet", worktreeDir, "-b", "linked-branch"], { cwd: mainDir, stdio: "ignore" });

    const { code, stderr } = await runNode(["--state", "required"], { cwd: worktreeDir });
    assert.equal(code, 0, stderr);

    const mainCheckpointPath = path.join(mainDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const worktreeCheckpointPath = path.join(worktreeDir, ".pi", "dev-loop-retrospective-checkpoint.json");
    const mainCheckpoint = JSON.parse(await readFile(mainCheckpointPath, "utf8"));
    assert.equal(mainCheckpoint.state, "required");
    await assert.rejects(readFile(worktreeCheckpointPath, "utf8"));
  } finally {
    try { execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: mainDir, stdio: "ignore" }); } catch { /* best-effort */ }
    await rm(mainDir, { recursive: true, force: true });
    await rm(worktreeParent, { recursive: true, force: true });
  }
});
