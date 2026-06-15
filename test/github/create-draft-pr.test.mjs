import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

import { buildCreateDraftPrArgs, detectClosingKeyword } from "../../scripts/github/create-draft-pr.mjs";

const scriptPath = path.resolve("scripts/github/create-draft-pr.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries, options = {}) {
  return writeGhStubHelper(tempDir, entries, {
    repeatLastOnOverflow: true,
    logCalls: true,
    ...options,
  });
}

async function readGhCalls(logPath) {
  const lines = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

// --- detectClosingKeyword unit tests ---

test("detectClosingKeyword returns true for Closes #123 in body", () => {
  assert.equal(detectClosingKeyword("Closes #123"), true);
});

test("detectClosingKeyword returns true for Fixes #456 in body", () => {
  assert.equal(detectClosingKeyword("Summary here. Fixes #456. More text."), true);
});

test("detectClosingKeyword returns false when no closing keyword present", () => {
  assert.equal(detectClosingKeyword("some text without keyword"), false);
});

test("detectClosingKeyword returns false for null/empty/invalid input", () => {
  assert.equal(detectClosingKeyword(null), false);
  assert.equal(detectClosingKeyword(undefined), false);
  assert.equal(detectClosingKeyword(""), false);
  assert.equal(detectClosingKeyword(123), false);
});

test("detectClosingKeyword is case-insensitive", () => {
  assert.equal(detectClosingKeyword("closes #789"), true);
  assert.equal(detectClosingKeyword("FIXES #1"), true);
});

test("detectClosingKeyword scans only first MAX_BODY_SCAN_BYTES", () => {
  const prefix = "x".repeat(16 * 1024);
  assert.equal(detectClosingKeyword(prefix + "Closes #999"), false);
});

// --- integration tests for closing-keyword warning ---

test("create-draft-pr --body with closing keyword emits no stderr warning", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-body-keyword-ok-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #123",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/1\n");
    assert.equal(result.stderr, "");
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr --body without closing keyword emits stderr warning but exits 0", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-body-no-keyword-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "some text without keyword",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/1\n");
    assert.match(result.stderr, /Warning: PR body missing `Closes #N` or `Fixes #N`/i);
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr --body-file with closing keyword emits no stderr warning", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-bodyfile-keyword-ok-"));

  try {
    const bodyPath = path.join(tempDir, "pr-body.md");
    await writeFile(bodyPath, "Fixes #456\n\nSome description here.", "utf8");

    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body-file", bodyPath,
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/1\n");
    assert.equal(result.stderr, "");
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr --body-file without closing keyword emits stderr warning but exits 0", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-bodyfile-no-keyword-"));

  try {
    const bodyPath = path.join(tempDir, "pr-body.md");
    await writeFile(bodyPath, "Some description without any closing keyword.", "utf8");

    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body-file", bodyPath,
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/1\n");
    assert.match(result.stderr, /Warning: PR body missing `Closes #N` or `Fixes #N`/i);
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr --body-file with missing file emits stderr warning (non-fatal)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-bodyfile-missing-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body-file", "/nonexistent/path/pr-body.md",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/1\n");
    assert.match(result.stderr, /Warning: PR body missing `Closes #N` or `Fixes #N`/i);
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- existing tests continued ---

test("buildCreateDraftPrArgs injects --draft when absent", () => {
  assert.deepEqual(
    buildCreateDraftPrArgs(["--repo", "owner/repo", "--assignee", "@me"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft"],
    },
  );
});

test("buildCreateDraftPrArgs avoids adding a duplicate --draft", () => {
  assert.deepEqual(
    buildCreateDraftPrArgs(["--draft", "--repo", "owner/repo", "--assignee", "@me"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--draft", "--repo", "owner/repo", "--assignee", "@me"],
    },
  );
});

test("buildCreateDraftPrArgs rejects --ready before gh is invoked", () => {
  assert.throws(
    () => buildCreateDraftPrArgs(["--repo", "owner/repo", "--ready"]),
    /rejects --ready/i,
  );
});

test("buildCreateDraftPrArgs appends --draft after a false-valued draft token", () => {
  assert.deepEqual(
    buildCreateDraftPrArgs(["--repo", "owner/repo", "--draft=false"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--draft=false", "--draft"],
    },
  );
});

test("buildCreateDraftPrArgs re-appends --draft when a later token disables it", () => {
  assert.deepEqual(
    buildCreateDraftPrArgs(["--draft", "--repo", "owner/repo", "--draft=false"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--draft", "--repo", "owner/repo", "--draft=false", "--draft"],
    },
  );
});

test("buildCreateDraftPrArgs treats --draft=true as already supplied", () => {
  assert.deepEqual(
    buildCreateDraftPrArgs(["--repo", "owner/repo", "--draft=true"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--draft=true"],
    },
  );
});

test("create-draft-pr --help documents draft-only behavior and --ready rejection", async () => {
  const result = await runNode(["--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Thin wrapper around `gh pr create`/i);
  assert.match(result.stdout, /injects exactly one `--draft` when absent/i);
  assert.match(result.stdout, /rejects `--ready` before invoking `gh`/i);
  assert.match(result.stdout, /preserves the underlying `gh pr create` stdout, stderr, and exit code/i);
});

test("create-draft-pr forwards args in order and preserves gh stdout on success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-success-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const bodyPath = path.join(tempDir, "pr-body.md");
    await writeFile(bodyPath, "Closes #349\n", "utf8");

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "issue-349-create-draft-pr",
      "--title", "Add draft wrapper",
      "--body-file", bodyPath,
      "positional-token",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create",
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "issue-349-create-draft-pr",
      "--title", "Add draft wrapper",
      "--body-file", bodyPath,
      "positional-token",
      "--draft",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr preserves an existing --draft without adding another copy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-existing-draft-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode([
      "--draft",
      "--repo", "owner/repo",
      "--assignee", "@me",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--draft", "--repo", "owner/repo", "--assignee", "@me",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr appends --draft after --draft=false so draft-first still wins", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-false-draft-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--draft=false"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--repo", "owner/repo", "--draft=false", "--draft",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr re-appends --draft when a later token disables it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-reappend-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode(["--draft", "--repo", "owner/repo", "--draft=false"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--draft", "--repo", "owner/repo", "--draft=false", "--draft",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr treats --draft=true as already supplied and avoids a duplicate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-true-draft-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--draft=true"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--repo", "owner/repo", "--draft=true",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr rejects --ready without invoking gh", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-ready-reject-"));

  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode(["--repo", "owner/repo", "--ready"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /rejects --ready/i);
    assert.match(stderrPayload.usage, /Usage: create-draft-pr\.mjs/i);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-draft-pr preserves gh stdout, stderr, and exit code on failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-draft-pr-gh-failure-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "partial gh stdout\n",
        stderr: "gh create failed\n",
        exitCode: 3,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--assignee", "@me"], { env });

    assert.equal(result.code, 3);
    assert.equal(result.stdout, "partial gh stdout\n");
    assert.equal(result.stderr, "gh create failed\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
