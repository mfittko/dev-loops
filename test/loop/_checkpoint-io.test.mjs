import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { readExistingCheckpoint } from "../../scripts/loop/_checkpoint-io.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempDir(fn) {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-checkpoint-io-test-"));
  try {
    return await fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

const writeJson = writeJsonHelper;

// ---------------------------------------------------------------------------
// readExistingCheckpoint: default path resolution
// ---------------------------------------------------------------------------

test("readExistingCheckpoint: reads from repo-qualified default path", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json");
    const data = { pr: 42, repo: "owner/repo", outerAction: "continue_wait" };
    await writeJson(checkpointPath, data);

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42);

    assert.deepEqual(checkpoint, data);
    assert.equal(filePath, path.join("tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json"));
  });
});

test("readExistingCheckpoint: returns null when no checkpoint exists", async () => {
  await withTempDir(async (tempDir) => {
    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42);

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});

test("readExistingCheckpoint: normalizes repo slug to lowercase when reading preferred path", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json");
    const data = { pr: 42, repo: "owner/repo", outerAction: "done" };
    await writeJson(checkpointPath, data);

    process.chdir(tempDir);
    const { checkpoint } = await readExistingCheckpoint("Owner/Repo", 42);
    assert.deepEqual(checkpoint, data);
  });
});

// ---------------------------------------------------------------------------
// readExistingCheckpoint: legacy path fallback
// ---------------------------------------------------------------------------

test("readExistingCheckpoint: falls back to legacy path when repo+pr match", async () => {
  await withTempDir(async (tempDir) => {
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    const data = { pr: 42, repo: "owner/repo", outerAction: "stop" };
    await writeJson(legacyPath, data);

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42);

    assert.deepEqual(checkpoint, data);
    assert.equal(filePath, path.join("tmp", "copilot-loop", "pr-42", "outer-loop-state.json"));
  });
});

test("readExistingCheckpoint: ignores legacy path when repo does not match", async () => {
  await withTempDir(async (tempDir) => {
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    const data = { pr: 42, repo: "other/repo", outerAction: "stop" };
    await writeJson(legacyPath, data);

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42);

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});

test("readExistingCheckpoint: ignores legacy path when pr does not match", async () => {
  await withTempDir(async (tempDir) => {
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    const data = { pr: 99, repo: "owner/repo", outerAction: "stop" };
    await writeJson(legacyPath, data);

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42);

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});

test("readExistingCheckpoint: prefers repo-qualified path over legacy when both exist", async () => {
  await withTempDir(async (tempDir) => {
    const preferredPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json");
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    const preferredData = { pr: 42, repo: "owner/repo", outerAction: "done" };
    const legacyData = { pr: 42, repo: "owner/repo", outerAction: "continue_wait" };
    await writeJson(preferredPath, preferredData);
    await writeJson(legacyPath, legacyData);

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42);

    assert.deepEqual(checkpoint, preferredData);
    assert.equal(filePath, path.join("tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json"));
  });
});

test("readExistingCheckpoint: normalizes repo when matching legacy checkpoint", async () => {
  await withTempDir(async (tempDir) => {
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    const data = { pr: 42, repo: "owner/repo", outerAction: "stop" };
    await writeJson(legacyPath, data);

    process.chdir(tempDir);
    // Repo passed with different casing → should still match after normalization
    const { checkpoint } = await readExistingCheckpoint("Owner/Repo", 42);
    assert.deepEqual(checkpoint, data);
  });
});

// ---------------------------------------------------------------------------
// readExistingCheckpoint: explicit checkpointDir override
// ---------------------------------------------------------------------------

test("readExistingCheckpoint: reads from explicit checkpointDir when provided", async () => {
  await withTempDir(async (tempDir) => {
    const explicitDir = path.join(tempDir, "custom-checkpoint");
    const checkpointPath = path.join(explicitDir, "outer-loop-state.json");
    const data = { pr: 42, repo: "owner/repo", outerAction: "reenter_copilot_loop" };
    await writeJson(checkpointPath, data);

    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42, { checkpointDir: explicitDir });

    assert.deepEqual(checkpoint, data);
    assert.equal(filePath, checkpointPath);
  });
});

test("readExistingCheckpoint: returns null when explicit checkpointDir file is missing", async () => {
  await withTempDir(async (tempDir) => {
    const explicitDir = path.join(tempDir, "custom-checkpoint");
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42, { checkpointDir: explicitDir });

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});

// ---------------------------------------------------------------------------
// readExistingCheckpoint: error handling
// ---------------------------------------------------------------------------

test("readExistingCheckpoint: failSilently=true returns null on non-ENOENT read error", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json");
    // Write a directory where a file is expected to prevent reading
    await mkdir(checkpointPath, { recursive: true });

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42, { failSilently: true });

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});

test("readExistingCheckpoint: failSilently=false (default) throws on non-ENOENT read error", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-42", "outer-loop-state.json");
    // Write a directory where a file is expected to prevent reading
    await mkdir(checkpointPath, { recursive: true });

    process.chdir(tempDir);
    await assert.rejects(
      () => readExistingCheckpoint("owner/repo", 42),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Failed to read checkpoint"), `Unexpected message: ${err.message}`);
        return true;
      },
    );
  });
});

test("readExistingCheckpoint: explicit checkpointDir failSilently=false throws on non-ENOENT error", async () => {
  await withTempDir(async (tempDir) => {
    // Use a directory as the checkpoint file to cause a non-ENOENT error
    const explicitDir = path.join(tempDir, "checkpoint-dir");
    const fileAsDir = path.join(explicitDir, "outer-loop-state.json");
    await mkdir(fileAsDir, { recursive: true });

    await assert.rejects(
      () => readExistingCheckpoint("owner/repo", 42, { checkpointDir: explicitDir }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Failed to read checkpoint"), `Unexpected message: ${err.message}`);
        return true;
      },
    );
  });
});

test("readExistingCheckpoint: explicit checkpointDir failSilently=true returns null on non-ENOENT error", async () => {
  await withTempDir(async (tempDir) => {
    const explicitDir = path.join(tempDir, "checkpoint-dir");
    const fileAsDir = path.join(explicitDir, "outer-loop-state.json");
    await mkdir(fileAsDir, { recursive: true });

    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42, {
      checkpointDir: explicitDir,
      failSilently: true,
    });

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});


test("readExistingCheckpoint: legacy fallback failSilently=false throws on non-ENOENT error", async () => {
  await withTempDir(async (tempDir) => {
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    await mkdir(legacyPath, { recursive: true });

    process.chdir(tempDir);
    await assert.rejects(
      () => readExistingCheckpoint("owner/repo", 42),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("Failed to read checkpoint"), `Unexpected message: ${err.message}`);
        assert.ok(err.message.includes(path.join("tmp", "copilot-loop", "pr-42", "outer-loop-state.json")));
        return true;
      },
    );
  });
});

test("readExistingCheckpoint: legacy fallback failSilently=true returns null on non-ENOENT error", async () => {
  await withTempDir(async (tempDir) => {
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-42", "outer-loop-state.json");
    await mkdir(legacyPath, { recursive: true });

    process.chdir(tempDir);
    const { checkpoint, filePath } = await readExistingCheckpoint("owner/repo", 42, { failSilently: true });

    assert.equal(checkpoint, null);
    assert.equal(filePath, null);
  });
});
