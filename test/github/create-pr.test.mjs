import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

import { buildCreatePrArgs, detectClosingKeyword, extractClosingIssueNumber } from "../../scripts/github/create-pr.mjs";

const scriptPath = path.resolve("scripts/github/create-pr.mjs");
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

// #1629: linked-PR guard response with NO open linked PR — the happy path a
// closing-keyword create hits first (detectLinkedIssuePr graphql call) before
// the `gh pr create` call.
function graphqlNoLinkedPrPayload() {
  return `${JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  })}\n`;
}

// #1629: linked-PR guard response with ONE open linked PR.
function graphqlSingleLinkedPrPayload({ number, url, state = "OPEN" }) {
  return `${JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                __typename: "ConnectedEvent",
                createdAt: "2026-05-01T10:00:00Z",
                subject: {
                  __typename: "PullRequest",
                  number,
                  state,
                  url,
                  repository: { nameWithOwner: "owner/repo" },
                },
              },
            ],
          },
        },
      },
    },
  })}\n`;
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

// --- extractClosingIssueNumber unit tests (#1626) ---

test("extractClosingIssueNumber returns the issue number from Closes #N", () => {
  assert.equal(extractClosingIssueNumber("Closes #123"), 123);
  assert.equal(extractClosingIssueNumber("Summary. Fixes #456. More."), 456);
});

test("extractClosingIssueNumber returns null when no closing keyword is present", () => {
  assert.equal(extractClosingIssueNumber("some text without keyword"), null);
  assert.equal(extractClosingIssueNumber(null), null);
  assert.equal(extractClosingIssueNumber(""), null);
});

// --- --issue closing-reference enforcement (#1626) ---

test("create-pr --issue <n> with a matching Closes #n succeeds and forwards args without --issue", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-issue-match-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlNoLinkedPrPayload() },
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--issue", "123",
      "--body", "Closes #123",
    ], { env });
    assert.equal(result.code, 0, result.stderr);
    const ghCalls = await readGhCalls(ghLogPath);
    assert.equal(ghCalls.length, 2);
    // --issue is consumed by the wrapper, never forwarded to gh.
    assert.equal(ghCalls.every((call) => call.includes("--issue") === false), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --issue <n> refuses a missing closing reference before invoking gh (#1626)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-issue-missing-"));
  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--issue", "123",
      "--body", "some text without keyword",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /requires a closing reference.*Closes #123/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --issue <n> refuses a mismatched closing reference before invoking gh (#1626)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-issue-mismatch-"));
  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--issue", "123",
      "--body", "Closes #999",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /mismatched closing reference/);
    assert.match(stderrPayload.error, /#999/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --issue refuses a valueless bare --issue token (#1626)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-issue-bare-"));
  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #1",
      "--issue",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /--issue must be a positive integer/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --issue refuses non-numeric / zero / negative values (#1626)", async () => {
  for (const bad of ["abc", "0", "-1", "1.5"]) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-issue-invalid-"));
    try {
      const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
      const result = await runNode([
        "--repo", "owner/repo",
        "--assignee", "@me",
        "--base", "main",
        "--head", "feature",
        "--title", "Add feature",
        "--body", `Closes #1`,
        "--issue", bad,
      ], { env });
      assert.equal(result.code, 1, `expected exit 1 for --issue ${bad}`);
      assert.match(JSON.parse(result.stderr).error, /--issue must be a positive integer/);
      assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
      assert.deepEqual(await readGhCalls(ghLogPath), []);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("create-pr --issue accepts the =inline form", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-issue-inline-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlNoLinkedPrPayload() },
      { stdout: "https://github.com/owner/repo/pull/1\n" },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--issue=42",
      "--body", "Fixes #42",
    ], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readGhCalls(ghLogPath)).every((call) => call.includes("--issue") === false), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- integration tests for closing-keyword warning ---

test("create-pr --body with closing keyword emits no stderr warning", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-body-keyword-ok-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlNoLinkedPrPayload() },
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
    assert.equal((await readGhCalls(ghLogPath)).length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --body without closing keyword emits no warning when --issue is absent (#1626)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-body-no-keyword-"));

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
    // #1626: without --issue the closing keyword is not enforced, so the old
    // advisory warning is gone (a warning is invisible under --jq).
    assert.equal(result.stderr, "");
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --body-file with closing keyword emits no stderr warning", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-bodyfile-keyword-ok-"));

  try {
    const bodyPath = path.join(tempDir, "pr-body.md");
    await writeFile(bodyPath, "Closes #123\n\nSome description here.", "utf8");

    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlNoLinkedPrPayload() },
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
    assert.equal((await readGhCalls(ghLogPath)).length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --body-file without closing keyword emits no warning when --issue is absent (#1626)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-bodyfile-no-keyword-"));

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
    assert.equal(result.stderr, "");
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --body-file with an unreadable file fails closed: nonzero exit, clear error, gh never invoked", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-bodyfile-missing-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, []);

    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body-file", "/nonexistent/path/pr-body.md",
    ], { env });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ok":false/);
    assert.match(result.stderr, /\/nonexistent\/path\/pr-body\.md/);
    assert.equal((await readGhCalls(ghLogPath)).length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- arg-building tests ---

test("buildCreatePrArgs injects --draft when absent", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "--assignee", "@me"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft"],
    },
  );
});

test("buildCreatePrArgs defaults --assignee @me when no assignee is provided (#894)", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "--base", "main", "--head", "feature"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--base", "main", "--head", "feature", "--assignee", "@me", "--draft"],
    },
  );
});

test("buildCreatePrArgs honors an explicit --assignee <login> and does not add a default", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "--assignee", "octocat"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--assignee", "octocat", "--draft"],
    },
  );
});

test("buildCreatePrArgs honors --assignee=<login> form without adding a default", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "--assignee=octocat"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--assignee=octocat", "--draft"],
    },
  );
});

test("buildCreatePrArgs honors the -a short assignee flag and does not inject a conflicting default (#894)", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "-a", "octocat"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "-a", "octocat", "--draft"],
    },
  );
});

test("buildCreatePrArgs avoids adding a duplicate --draft", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--draft", "--repo", "owner/repo", "--assignee", "@me"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--draft", "--repo", "owner/repo", "--assignee", "@me"],
    },
  );
});

test("buildCreatePrArgs rejects --ready before gh is invoked", () => {
  assert.throws(
    () => buildCreatePrArgs(["--repo", "owner/repo", "--ready"]),
    /rejects --ready/i,
  );
});

test("buildCreatePrArgs appends --draft after a false-valued draft token", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "--assignee", "@me", "--draft=false"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft=false", "--draft"],
    },
  );
});

test("buildCreatePrArgs re-appends --draft when a later token disables it", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--draft", "--repo", "owner/repo", "--assignee", "@me", "--draft=false"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--draft", "--repo", "owner/repo", "--assignee", "@me", "--draft=false", "--draft"],
    },
  );
});

test("buildCreatePrArgs treats --draft=true as already supplied", () => {
  assert.deepEqual(
    buildCreatePrArgs(["--repo", "owner/repo", "--assignee", "@me", "--draft=true"]),
    {
      help: false,
      ghArgs: ["pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft=true"],
    },
  );
});

test("create-pr --help short-circuits before --issue validation (#1626)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-help-shortcircuit-"));
  try {
    const { env, counterPath } = await writeGhStub(tempDir, []);
    // --help with a valueless --issue must still print USAGE and exit 0,
    // not throw the --issue validation error.
    const result = await runNode(["--help", "--issue"], { env });
    assert.equal(result.code, 0, `expected exit 0, got ${result.code}. stderr: ${result.stderr}`);
    assert.match(result.stdout, /Canonical PR-creation wrapper around/i);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --help documents draft-only behavior, default self-assign, and --ready rejection", async () => {
  const result = await runNode(["--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Canonical PR-creation wrapper around `gh pr create`/i);
  assert.match(result.stdout, /injects exactly one `--draft` when absent/i);
  assert.match(result.stdout, /defaults `--assignee @me` when no assignee is given/i);
  assert.match(result.stdout, /self-assigned by default/i);
  assert.match(result.stdout, /honors an explicit `--assignee <login>`/i);
  // The help text must not overstate self-assignment as unconditional (it is the
  // default, but an explicit --assignee/-a is honored). (#894 / Copilot review)
  assert.doesNotMatch(result.stdout, /ALWAYS self-assigned/i);
  assert.match(result.stdout, /rejects `--ready` before invoking `gh`/i);
  assert.match(result.stdout, /preserves the underlying `gh pr create` stdout, stderr, and exit code/i);
});

test("create-pr forwards args in order and preserves gh stdout on success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-success-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlNoLinkedPrPayload() },
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
      "--head", "issue-349-create-pr",
      "--title", "Add canonical wrapper",
      "--body-file", bodyPath,
      "positional-token",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    const ghCalls = await readGhCalls(ghLogPath);
    assert.equal(ghCalls.length, 2);
    assert.deepEqual(ghCalls[1], [
      "pr", "create",
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "issue-349-create-pr",
      "--title", "Add canonical wrapper",
      "--body-file", bodyPath,
      "positional-token",
      "--draft",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr defaults --assignee @me end-to-end when no assignee flag is given (#894)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-default-assignee-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlNoLinkedPrPayload() },
      { stdout: "https://github.com/owner/repo/pull/17\n" },
    ]);

    const bodyPath = path.join(tempDir, "pr-body.md");
    await writeFile(bodyPath, "Closes #894\n", "utf8");

    const result = await runNode([
      "--repo", "owner/repo",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body-file", bodyPath,
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const ghCalls = await readGhCalls(ghLogPath);
    assert.equal(ghCalls.length, 2);
    assert.deepEqual(ghCalls[1], [
      "pr", "create",
      "--repo", "owner/repo",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body-file", bodyPath,
      "--assignee", "@me",
      "--draft",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr preserves an existing --draft without adding another copy", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-existing-draft-"));

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

test("create-pr appends --draft after --draft=false so draft-first still wins", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-false-draft-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--assignee", "@me", "--draft=false"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft=false", "--draft",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr re-appends --draft when a later token disables it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-reappend-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode(["--draft", "--repo", "owner/repo", "--assignee", "@me", "--draft=false"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--draft", "--repo", "owner/repo", "--assignee", "@me", "--draft=false", "--draft",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr treats --draft=true as already supplied and avoids a duplicate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-true-draft-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--assignee", "@me", "--draft=true"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/17\n");
    assert.deepEqual(await readGhCalls(ghLogPath), [[
      "pr", "create", "--repo", "owner/repo", "--assignee", "@me", "--draft=true",
    ]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr rejects --ready without invoking gh", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-ready-reject-"));

  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode(["--repo", "owner/repo", "--ready"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /rejects --ready/i);
    assert.equal(stderrPayload.hint, "run with --help for usage");
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr preserves gh stdout, stderr, and exit code on failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-gh-failure-"));

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

// --- #1629: linked-PR duplicate guard (FACADE-LINKED-PR-SINGLE-ARTIFACT) ---

test("create-pr refuses a closing keyword whose issue already has an open linked PR, naming the prior PR (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-linked-refuse-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlSingleLinkedPrPayload({ number: 90, url: "https://github.com/owner/repo/pull/90" }) },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /FACADE-LINKED-PR-SINGLE-ARTIFACT/);
    assert.match(stderrPayload.error, /already has an open linked PR #90/);
    // The create never reached gh: only the one linked-PR probe ran.
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --allow-replacement-pr <prior> matching the open linked PR lets the create through and records intent (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-replacement-allow-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlSingleLinkedPrPayload({ number: 90, url: "https://github.com/owner/repo/pull/90" }) },
      { stdout: "https://github.com/owner/repo/pull/91\n" },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
      "--allow-replacement-pr", "90",
    ], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "https://github.com/owner/repo/pull/91\n");
    assert.match(result.stderr, /replacing linked PR #90/);
    const ghCalls = await readGhCalls(ghLogPath);
    assert.equal(ghCalls.length, 2);
    // --allow-replacement-pr is consumed, never forwarded to gh.
    assert.equal(ghCalls.every((call) => call.includes("--allow-replacement-pr") === false), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr --allow-replacement-pr that does not match the open linked PR is still refused (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-replacement-mismatch-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: graphqlSingleLinkedPrPayload({ number: 90, url: "https://github.com/owner/repo/pull/90" }) },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
      "--allow-replacement-pr", "99",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /FACADE-LINKED-PR-SINGLE-ARTIFACT/);
    assert.equal((await readGhCalls(ghLogPath)).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr rejects a non-integer --allow-replacement-pr value before invoking gh (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-replacement-invalid-"));
  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
      "--allow-replacement-pr", "abc",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /--allow-replacement-pr must be a positive integer/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr fails closed on ambiguity when the linked-PR probe has no --repo (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-no-repo-guard-"));
  try {
    // repo probe cannot run without --repo; the create must not reach gh.
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /FACADE-LINKED-PR-SINGLE-ARTIFACT/);
    assert.match(stderrPayload.error, /--repo owner\/name was not provided/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr fails closed on ambiguity when --repo is empty/whitespace (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-empty-repo-guard-"));
  try {
    // An empty repo slug must be treated as missing, not sent to the network
    // probe and misreported as "API unavailable" (copilot review finding).
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /FACADE-LINKED-PR-SINGLE-ARTIFACT/);
    assert.match(stderrPayload.error, /--repo owner\/name was not provided/);
    assert.doesNotMatch(stderrPayload.error, /API was unavailable/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr refuses a valueless bare --allow-replacement-pr token (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-replacement-bare-"));
  try {
    const { env, counterPath, ghLogPath } = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
      "--allow-replacement-pr",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(JSON.parse(result.stderr).error, /--allow-replacement-pr requires a positive integer/);
    assert.equal((await readFile(counterPath, "utf8")).trim(), "0");
    assert.deepEqual(await readGhCalls(ghLogPath), []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("create-pr fails closed on ambiguity when the GitHub API is unavailable for the linked-PR probe (#1629)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-create-pr-api-down-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: "", stderr: "gh: API down", exitCode: 1 },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--assignee", "@me",
      "--base", "main",
      "--head", "feature",
      "--title", "Add feature",
      "--body", "Closes #85",
    ], { env });
    assert.equal(result.code, 1);
    const stderrPayload = JSON.parse(result.stderr);
    assert.match(stderrPayload.error, /FACADE-LINKED-PR-SINGLE-ARTIFACT/);
    assert.match(stderrPayload.error, /API was unavailable/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
