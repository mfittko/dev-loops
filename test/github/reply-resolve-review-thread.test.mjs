import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";
import { hasCommitShaReference } from "../../scripts/github/reply-resolve-review-thread.mjs";

const scriptPath = path.resolve("scripts/github/reply-resolve-review-thread.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

function createReviewThreadsPayload(threads) {
  return `${JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads,
          },
        },
      },
    },
  })}\n`;
}

const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true, logCalls: true });

test("reply-resolve-review-thread posts a reply then resolves the thread", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-thread-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Fixed in 93cd7f8. Added the missing symlinked-ancestor guard and coverage.\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_123", databaseId: 123 },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/123/replies", "--input", "-"],
        assertStdinIncludes: ['"body":"Fixed in 93cd7f8. Added the missing symlinked-ancestor guard and coverage.\\n"'],
        stdout: '{"id":456,"html_url":"https://github.com/owner/repo/pull/17#discussion_r456"}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "threadId=THREAD_123"],
        stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"THREAD_123","isResolved":true}}}}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      pr: 17,
      commentId: 123,
      threadId: "THREAD_123",
      replyId: 456,
      replyUrl: "https://github.com/owner/repo/pull/17#discussion_r456",
      resolved: true,
    });

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(ghLog.length, 3);
    assert.equal(ghLog[1].includes("--input"), true);
    assert.equal(ghLog[1].some((entry) => entry.startsWith("body=")), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread rejects thin replies without commit SHA or dismissal reason", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-thin-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Acknowledged.\n", "utf8");

  try {
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: { ...process.env, PATH: process.env.PATH } },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Reply body \(13 characters after trimming\) must contain either a commit SHA reference or a dismissal reason/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread rejects pure-numeric tokens that are not commit SHAs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-numeric-sha-"));
  const bodyFile = path.join(tempDir, "reply.md");
  // "1234567" matches the 7-40 hex-char regex but contains no hex letters; must not bypass the check
  await writeFile(bodyFile, "1234567\n", "utf8");

  try {
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: { ...process.env, PATH: process.env.PATH } },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /Reply body \(7 characters after trimming\) must contain either a commit SHA reference/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("hasCommitShaReference unit — hex-with-letters accepted, bare numeric rejected, contextualized numeric accepted", () => {
  // Bare hex tokens with at least one hex letter — the common case
  assert.equal(hasCommitShaReference("Fixed in abc1234."), true);
  assert.equal(hasCommitShaReference("39add8d"), true);
  assert.equal(hasCommitShaReference("0350a214"), true);

  // Bare pure-numeric token — no hex letters, no keyword context: rejected
  assert.equal(hasCommitShaReference("1234567"), false);
  assert.equal(hasCommitShaReference("12345678"), false);

  // Numeric token in explicit commit-reference context — rare-but-valid all-digit SHA form
  assert.equal(hasCommitShaReference("Fixed in 1234567"), true);
  assert.equal(hasCommitShaReference("Commit 1234567"), true);
  assert.equal(hasCommitShaReference("SHA 1234567"), true);
  assert.equal(hasCommitShaReference("https://github.com/owner/repo/commit/1234567"), true);
  assert.equal(hasCommitShaReference("See /commit/1234567 for details"), true);

  // Too short (6 chars) or too long (41 chars) — rejected
  assert.equal(hasCommitShaReference("abc123"), false);
  assert.equal(hasCommitShaReference("a".repeat(41)), false);

  // Empty / whitespace only
  assert.equal(hasCommitShaReference(""), false);
  assert.equal(hasCommitShaReference("   "), false);
});

test("reply-resolve-review-thread rejects malformed arguments and empty body files deterministically", async () => {
  const missing = await runNode(["--repo", "owner/repo"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  const missingParsed = JSON.parse(missing.stderr);
  assert.equal(missingParsed.ok, false);
  assert.match(missingParsed.error, /Missing required option/i);

  const badRepo = await runNode(["--repo", " owner / repo ", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", "x.md"]);
  assert.equal(badRepo.code, 1);
  assert.equal(badRepo.stdout, "");
  const badRepoParsed = JSON.parse(badRepo.stderr);
  assert.equal(badRepoParsed.ok, false);
  assert.match(badRepoParsed.error, /repo|slug|owner/i);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-empty-"));
  const emptyBody = path.join(tempDir, "empty.md");
  await writeFile(emptyBody, "   \n", "utf8");

  try {
    const empty = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--comment-id",
      "123",
      "--thread-id",
      "THREAD_123",
      "--body-file",
      emptyBody,
    ]);
    assert.equal(empty.code, 1);
    assert.equal(empty.stdout, "");
    assert.deepEqual(JSON.parse(empty.stderr), {
      ok: false,
      error: "--body-file must contain non-empty text",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread preserves leading whitespace in the reply body payload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-whitespace-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "  indented line with enough text to pass resolution contract\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_123", databaseId: 123 },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/123/replies", "--input", "-"],
        assertStdinIncludes: ['"body":"  indented line with enough text to pass resolution contract\\n"'],
        stdout: '{"id":456,"html_url":"https://github.com/owner/repo/pull/17#discussion_r456"}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "threadId=THREAD_123"],
        stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"THREAD_123","isResolved":true}}}}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread reports reply and resolve failures deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-failure-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Resolved in 93cd7f8.\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_123", databaseId: 123 },
              ],
            },
          },
        ]),
      },
      {
        stderr: "gh: forbidden\n",
        exitCode: 1,
      },
    ]);

    const replyFailure = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );
    assert.equal(replyFailure.code, 1);
    assert.equal(replyFailure.stdout, "");
    assert.deepEqual(JSON.parse(replyFailure.stderr), {
      ok: false,
      error: "gh command failed: gh: forbidden",
    });

    const ghMissingReplyFields = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_123", databaseId: 123 },
              ],
            },
          },
        ]),
      },
      {
        stdout: '{"id":456}\n',
      },
    ]);

    const missingReplyFields = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: ghMissingReplyFields.env },
    );
    assert.equal(missingReplyFields.code, 1);
    assert.equal(missingReplyFields.stdout, "");
    assert.deepEqual(JSON.parse(missingReplyFields.stderr), {
      ok: false,
      error: "Reply payload from gh did not include both id and html_url",
    });

    const ghResolve = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_123", databaseId: 123 },
              ],
            },
          },
        ]),
      },
      {
        stdout: '{"id":456,"html_url":"https://github.com/owner/repo/pull/17#discussion_r456"}\n',
      },
      {
        stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"THREAD_123","isResolved":false}}}}\n',
      },
    ]);

    const resolveFailure = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: ghResolve.env },
    );
    assert.equal(resolveFailure.code, 1);
    assert.equal(resolveFailure.stdout, "");
    assert.deepEqual(JSON.parse(resolveFailure.stderr), {
      ok: false,
      error: "Review thread did not resolve successfully: THREAD_123",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread fails closed before mutating when comment and thread do not match", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-mismatch-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Fixed in 93cd7f8.\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_999", databaseId: 999 },
              ],
            },
          },
          {
            id: "THREAD_OLD",
            comments: {
              nodes: [
                { id: "PRRC_node_123", databaseId: 123 },
              ],
            },
          },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Review comment 123 does not belong to review thread THREAD_123 on pull request owner/repo#17",
    });

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(ghLog.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread fails closed before mutating when the target thread is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-missing-thread-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Fixed in 93cd7f8.\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_OTHER",
            comments: {
              nodes: [
                { id: "PRRC_node_999", databaseId: 999 },
              ],
            },
          },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Review thread THREAD_123 was not found on pull request owner/repo#17",
    });

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(ghLog.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread fails closed before mutating when the target comment is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-missing-comment-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Fixed in 93cd7f8.\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_123",
            comments: {
              nodes: [
                { id: "PRRC_node_999", databaseId: 999 },
              ],
            },
          },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Review comment 123 was not found on pull request owner/repo#17",
    });

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(ghLog.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-thread fails closed before mutating when the validation snapshot is malformed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-malformed-snapshot-"));
  const bodyFile = path.join(tempDir, "reply.md");
  await writeFile(bodyFile, "Fixed in 93cd7f8.\n", "utf8");

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: '{"data":{"repository":{"pullRequest":{}}}}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--comment-id", "123", "--thread-id", "THREAD_123", "--body-file", bodyFile],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Could not find review threads in payload",
    });

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(ghLog.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
