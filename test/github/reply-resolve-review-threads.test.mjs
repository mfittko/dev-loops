import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { parseReplyResolveThreadsCliArgs } from "../../scripts/github/reply-resolve-review-threads.mjs";

const scriptPath = path.resolve("scripts/github/reply-resolve-review-threads.mjs");

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

test("parseReplyResolveThreadsCliArgs sets defaults and parses optional flags", () => {
  assert.deepEqual(
    parseReplyResolveThreadsCliArgs(["--repo", "owner/repo", "--pr", "17"]),
    {
      help: false,
      repo: "owner/repo",
      pr: 17,
      author: "Copilot",
      message: undefined,
      resolve: false,
    },
  );

  assert.deepEqual(
    parseReplyResolveThreadsCliArgs(["--repo", "owner/repo", "--pr", "17", "--author", "reviewer-x", "--message", "Fixed in abc1234", "--resolve"]),
    {
      help: false,
      repo: "owner/repo",
      pr: 17,
      author: "reviewer-x",
      message: "Fixed in abc1234",
      resolve: true,
    },
  );
});

test("reply-resolve-review-threads rejects malformed arguments and conflicting or empty message input", async () => {
  const missing = await runNode(["--repo", "owner/repo"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  const missingParsed = JSON.parse(missing.stderr);
  assert.equal(missingParsed.ok, false);
  assert.match(missingParsed.error, /requires both --repo <owner\/name> and --pr <number>/);
  assert.match(missingParsed.usage, /reply-resolve-review-threads\.mjs/);

  const conflicting = await runNode(
    ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the contract"],
    { stdinText: "Also from stdin\n" },
  );
  assert.equal(conflicting.code, 1);
  assert.equal(conflicting.stdout, "");
  const conflictingParsed = JSON.parse(conflicting.stderr);
  assert.equal(conflictingParsed.ok, false);
  assert.equal(conflictingParsed.error, "Choose exactly one message source: --message <text> or stdin");
  assert.match(conflictingParsed.usage, /reply-resolve-review-threads\.mjs/);

  const emptyMessage = await runNode(
    ["--repo", "owner/repo", "--pr", "17", "--message", "   "],
    { stdinText: "" },
  );
  assert.equal(emptyMessage.code, 1);
  assert.equal(emptyMessage.stdout, "");
  const emptyParsed = JSON.parse(emptyMessage.stderr);
  assert.equal(emptyParsed.ok, false);
  assert.equal(emptyParsed.error, "Reply message must contain non-empty text");
  assert.match(emptyParsed.usage, /reply-resolve-review-threads\.mjs/);
});

test("reply-resolve-review-threads replies to matching unresolved threads without resolving by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-reply-only-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_101", databaseId: 101, body: "copilot note", author: { login: "Copilot", __typename: "Bot" } },
                { id: "PRRC_node_102", databaseId: 102, body: "human note", author: { login: "reviewer", __typename: "User" } },
              ],
            },
          },
          {
            id: "THREAD_2",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_201", databaseId: 201, body: "another copilot note", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
          {
            id: "THREAD_3",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_301", databaseId: 301, body: "human only", author: { login: "reviewer", __typename: "User" } },
              ],
            },
          },
          {
            id: "THREAD_4",
            isResolved: true,
            comments: {
              nodes: [
                { id: "PRRC_node_401", databaseId: 401, body: "already done", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/101/replies", "--input", "-"],
        assertStdinIncludes: ['"body":"Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."'],
        stdout: '{"id":501,"html_url":"https://github.com/owner/repo/pull/17#discussion_r501"}\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/201/replies", "--input", "-"],
        assertStdinIncludes: ['"body":"Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."'],
        stdout: '{"id":502,"html_url":"https://github.com/owner/repo/pull/17#discussion_r502"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      pr: 17,
      author: "Copilot",
      resolve: false,
      matchedThreadCount: 2,
      repliedThreadCount: 2,
      resolvedThreadCount: 0,
      skippedThreadCount: 1,
      results: [
        {
          threadId: "THREAD_1",
          commentId: 101,
          replyId: 501,
          replyUrl: "https://github.com/owner/repo/pull/17#discussion_r501",
          resolved: false,
        },
        {
          threadId: "THREAD_2",
          commentId: 201,
          replyId: 502,
          replyUrl: "https://github.com/owner/repo/pull/17#discussion_r502",
          resolved: false,
        },
      ],
    });

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(ghLog.length, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads resolves matched threads and verifies they stay resolved", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-resolve-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_201", databaseId: 201, body: "copilot note", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
          {
            id: "THREAD_2",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_302", databaseId: 302, body: "copilot note 2", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/201/replies"],
        stdout: '{"id":601,"html_url":"https://github.com/owner/repo/pull/17#discussion_r601"}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "threadId=THREAD_1"],
        stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"THREAD_1","isResolved":true}}}}\n',
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/302/replies"],
        stdout: '{"id":602,"html_url":"https://github.com/owner/repo/pull/17#discussion_r602"}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "threadId=THREAD_2"],
        stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"THREAD_2","isResolved":true}}}}\n',
      },
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: true,
            comments: { nodes: [] },
          },
          {
            id: "THREAD_2",
            isResolved: true,
            comments: { nodes: [] },
          },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.", "--resolve"],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      pr: 17,
      author: "Copilot",
      resolve: true,
      matchedThreadCount: 2,
      repliedThreadCount: 2,
      resolvedThreadCount: 2,
      skippedThreadCount: 0,
      results: [
        {
          threadId: "THREAD_1",
          commentId: 201,
          replyId: 601,
          replyUrl: "https://github.com/owner/repo/pull/17#discussion_r601",
          resolved: true,
        },
        {
          threadId: "THREAD_2",
          commentId: 302,
          replyId: 602,
          replyUrl: "https://github.com/owner/repo/pull/17#discussion_r602",
          resolved: true,
        },
      ],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads chooses the newest matching author-authored comment as the reply target", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-newest-comment-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_101", databaseId: 101, body: "older note", author: { login: "Copilot", __typename: "Bot" } },
                { id: "PRRC_node_105", databaseId: 105, body: "reviewer note", author: { login: "reviewer", __typename: "User" } },
                { id: "PRRC_node_109", databaseId: 109, body: "newest note", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/109/replies"],
        stdout: '{"id":701,"html_url":"https://github.com/owner/repo/pull/17#discussion_r701"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.results[0].commentId, 109);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads returns deterministic success when nothing matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-noop-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_DONE",
            isResolved: true,
            comments: {
              nodes: [
                { id: "PRRC_node_901", databaseId: 901, body: "done", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      pr: 17,
      author: "Copilot",
      resolve: false,
      matchedThreadCount: 0,
      repliedThreadCount: 0,
      resolvedThreadCount: 0,
      skippedThreadCount: 0,
      results: [],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads fails closed on malformed capture payloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-bad-payload-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: '{"data":{"repository":{"pullRequest":{"notReviewThreads":[]}}}}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Could not find review threads in payload",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads stops on reply failure and reports partial progress", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-partial-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_101", databaseId: 101, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
          {
            id: "THREAD_2",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_202", databaseId: 202, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/101/replies"],
        stdout: '{"id":801,"html_url":"https://github.com/owner/repo/pull/17#discussion_r801"}\n',
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/202/replies"],
        stderr: 'gh: forbidden\n',
        exitCode: 1,
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "gh command failed: gh: forbidden");
    assert.deepEqual(parsed.partialProgress, {
      repo: "owner/repo",
      pr: 17,
      author: "Copilot",
      resolve: false,
      matchedThreadCount: 2,
      repliedThreadCount: 1,
      resolvedThreadCount: 0,
      skippedThreadCount: 0,
      results: [
        {
          threadId: "THREAD_1",
          commentId: 101,
          replyId: 801,
          replyUrl: "https://github.com/owner/repo/pull/17#discussion_r801",
          resolved: false,
        },
      ],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads fails closed when post-resolve verification still finds targeted unresolved threads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-verify-fail-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_101", databaseId: 101, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/101/replies"],
        stdout: '{"id":901,"html_url":"https://github.com/owner/repo/pull/17#discussion_r901"}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "threadId=THREAD_1"],
        stdout: '{"data":{"resolveReviewThread":{"thread":{"id":"THREAD_1","isResolved":true}}}}\n',
      },
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_101", databaseId: 101, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.", "--resolve"],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "Post-resolve verification failed; targeted thread(s) remain unresolved: THREAD_1");
    assert.deepEqual(parsed.partialProgress, {
      repo: "owner/repo",
      pr: 17,
      author: "Copilot",
      resolve: true,
      matchedThreadCount: 1,
      repliedThreadCount: 1,
      resolvedThreadCount: 1,
      skippedThreadCount: 0,
      results: [
        {
          threadId: "THREAD_1",
          commentId: 101,
          replyId: 901,
          replyUrl: "https://github.com/owner/repo/pull/17#discussion_r901",
          resolved: true,
        },
      ],
      stillUnresolvedThreadIds: ["THREAD_1"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads preserves leading whitespace and newlines from stdin", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-stdin-whitespace-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_101", databaseId: 101, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/101/replies"],
        assertStdinIncludes: ['"body":"\\n  Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.'],
        stdout: '{"id":1001,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1001"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env: gh.env, stdinText: "\n  Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.\n" },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads preserves leading whitespace from --message", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-message-whitespace-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_101", databaseId: 101, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/101/replies"],
        assertStdinIncludes: ['"body":"  Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."'],
        stdout: '{"id":1002,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1002"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "  Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
