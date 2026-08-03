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
      author: "all",
      message: undefined,
      messageMap: undefined,
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
      messageMap: undefined,
      resolve: true,
    },
  );

  assert.deepEqual(
    parseReplyResolveThreadsCliArgs(["--repo", "owner/repo", "--pr", "17", "--message-map", "tmp/map.json"]),
    {
      help: false,
      repo: "owner/repo",
      pr: 17,
      author: "all",
      message: undefined,
      messageMap: "tmp/map.json",
      resolve: false,
    },
  );
});

test("parseReplyResolveThreadsCliArgs rejects --message and --message-map together", () => {
  assert.throws(
    () => parseReplyResolveThreadsCliArgs(["--repo", "owner/repo", "--pr", "17", "--message", "x", "--message-map", "tmp/map.json"]),
    /--message and --message-map are mutually exclusive/,
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
      ["--repo", "owner/repo", "--pr", "17", "--author", "Copilot", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
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
      author: "all",
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
      author: "all",
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
      author: "all",
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
      author: "all",
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

test("reply-resolve-review-threads defaults to all reviewers and processes mixed human + Copilot threads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-mixed-all-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_101", databaseId: 101, body: "copilot note", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
          {
            id: "THREAD_2",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_201", databaseId: 201, body: "human review note", author: { login: "reviewer", __typename: "User" } },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/101/replies", "--input", "-"],
        stdout: '{"id":1101,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1101"}\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/201/replies", "--input", "-"],
        stdout: '{"id":1102,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1102"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.author, "all");
    assert.equal(parsed.matchedThreadCount, 2);
    assert.equal(parsed.skippedThreadCount, 0);
    assert.deepEqual(parsed.results.map((r) => r.commentId).sort(), [101, 201]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads filters to human-only unresolved threads with explicit --author", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-human-only-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_201", databaseId: 201, body: "human note", author: { login: "reviewer", __typename: "User" } },
              ],
            },
          },
          {
            id: "THREAD_2",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_101", databaseId: 101, body: "copilot note", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/201/replies", "--input", "-"],
        stdout: '{"id":1201,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1201"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--author", "reviewer", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.author, "reviewer");
    assert.equal(parsed.matchedThreadCount, 1);
    assert.equal(parsed.skippedThreadCount, 1);
    assert.deepEqual(parsed.results.map((r) => r.commentId), [201]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads skips resolved human threads by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-human-resolved-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: true,
            comments: {
              nodes: [
                { id: "PRRC_node_201", databaseId: 201, body: "human resolved note", author: { login: "reviewer", __typename: "User" } },
              ],
            },
          },
          {
            id: "THREAD_2",
            isResolved: false,
            comments: {
              nodes: [
                { id: "PRRC_node_101", databaseId: 101, body: "copilot note", author: { login: "Copilot", __typename: "Bot" } },
              ],
            },
          },
        ]),
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/comments/101/replies", "--input", "-"],
        stdout: '{"id":1301,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1301"}\n',
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract."],
      { env: gh.env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.author, "all");
    assert.equal(parsed.matchedThreadCount, 1);
    assert.equal(parsed.skippedThreadCount, 0);
    assert.deepEqual(parsed.results.map((r) => r.commentId), [101]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads terminates on an idle open stdin pipe with no data (no hang)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-no-hang-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          { id: "THREAD_1", isResolved: false, comments: { nodes: [{ id: "PRRC_node_101", databaseId: 101, body: "note", author: { login: "Copilot", __typename: "Bot" } }] } },
          { id: "THREAD_2", isResolved: false, comments: { nodes: [{ id: "PRRC_node_201", databaseId: 201, body: "note", author: { login: "Copilot", __typename: "Bot" } }] } },
        ]),
      },
      { assertArgs: ["repos/owner/repo/pulls/17/comments/101/replies"], stdout: '{"id":1401,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1401"}\n' },
      { assertArgs: ["repos/owner/repo/pulls/17/comments/201/replies"], stdout: '{"id":1402,"html_url":"https://github.com/owner/repo/pull/17#discussion_r1402"}\n' },
    ]);

    // Regression for #1012: with --message set, stdin was probed to detect a
    // conflicting source. A detached/idle pipe never sends EOF nor any data, so
    // the old unbounded read hung forever. With no data, the probe times out,
    // the tool proceeds with --message, and it must terminate cleanly.
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        scriptPath,
        "--repo", "owner/repo", "--pr", "17",
        "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.",
      ], { env: gh.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("reply-resolve-review-threads did not terminate (hang regression #1012)"));
      }, 5000);
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      // Intentionally do NOT write or end stdin: an idle, never-EOF pipe.
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.matchedThreadCount, 2);
    assert.equal(parsed.repliedThreadCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads detects a conflicting stdin source promptly over an open (never-EOF) pipe and terminates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-open-pipe-conflict-"));

  try {
    // No gh calls expected: the conflict is detected before any capture.
    const gh = await writeGhStub(tempDir, []);

    // Regression for #1012: with --message set AND real data on stdin, the
    // conflict must be detected as soon as bytes arrive — without waiting for
    // EOF — and the tool must terminate (fail closed) rather than hang. Here the
    // pipe is never ended, so only prompt (chunk-triggered) detection can pass.
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        scriptPath,
        "--repo", "owner/repo", "--pr", "17",
        "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.",
      ], { env: gh.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("reply-resolve-review-threads did not terminate on open-pipe conflict (regression #1012)"));
      }, 5000);
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      // Write conflicting body but never end the pipe; the conflict must be
      // detected on the first data chunk, before any EOF.
      child.stdin.write("Also from stdin\n");
    });

    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "Choose exactly one message source: --message <text> or stdin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads detects a conflict when a whitespace-only chunk precedes real stdin content over an open pipe", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-ws-then-data-"));

  try {
    // No gh calls expected: the conflict must be detected before any capture.
    const gh = await writeGhStub(tempDir, []);

    // Regression for Copilot round 2: the conflict probe must not settle on a
    // leading whitespace-only chunk (which would falsely proceed with --message).
    // It must keep buffering until non-whitespace arrives, detect the conflict,
    // and terminate — all without waiting for EOF (pipe never ends).
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        scriptPath,
        "--repo", "owner/repo", "--pr", "17",
        "--message", "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract.",
      ], { env: gh.env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("reply-resolve-review-threads did not terminate on whitespace-then-data conflict"));
      }, 5000);
      child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      // First a whitespace-only chunk, then real content — never end the pipe.
      child.stdin.write("   \n");
      setTimeout(() => child.stdin.write("real conflicting body\n"), 50);
    });

    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "Choose exactly one message source: --message <text> or stdin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads --message-map fails closed before any mutation when a matched thread has no map entry and no --message fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-map-coverage-"));

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
    ]);
    const mapPath = path.join(tempDir, "message-map.json");
    await writeJsonHelper(mapPath, { THREAD_1: "Fixed in 93cd7f8 with enough detail to satisfy the resolution contract." });

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message-map", mapPath],
      { env: gh.env },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--message-map is missing an entry for 1 matched thread\(s\)/);
    assert.match(parsed.error, /THREAD_2/);
    assert.equal(parsed.partialProgress, undefined);

    const ghLog = (await readFile(gh.ghLogPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(ghLog.length, 1, "only the capture call should have run; no reply/resolve mutation before coverage validation");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads posts a distinct mapped reply body per thread via --message-map", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-map-distinct-"));

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
        assertStdinIncludes: ['"body":"Fixed the null check in file-a.mjs in 93cd7f8."'],
        stdout: '{"id":2001,"html_url":"https://github.com/owner/repo/pull/17#discussion_r2001"}\n',
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/202/replies"],
        assertStdinIncludes: ['"body":"Fixed the off-by-one in file-b.mjs in 93cd7f8."'],
        stdout: '{"id":2002,"html_url":"https://github.com/owner/repo/pull/17#discussion_r2002"}\n',
      },
    ]);
    const mapPath = path.join(tempDir, "message-map.json");
    await writeJsonHelper(mapPath, {
      THREAD_1: "Fixed the null check in file-a.mjs in 93cd7f8.",
      THREAD_2: "Fixed the off-by-one in file-b.mjs in 93cd7f8.",
    });

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message-map", mapPath],
      { env: gh.env },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.matchedThreadCount, 2);
    assert.equal(parsed.repliedThreadCount, 2);
    assert.deepEqual(parsed.results.map((r) => r.threadId).sort(), ["THREAD_1", "THREAD_2"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reply-resolve-review-threads sanitizes Copilot summon tokens in --message-map bodies exactly like --message", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reply-resolve-threads-map-sanitize-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stdout: createReviewThreadsPayload([
          {
            id: "THREAD_1",
            isResolved: false,
            comments: { nodes: [{ id: "PRRC_node_401", databaseId: 401, body: "note", author: { login: "Copilot", __typename: "Bot" } }] },
          },
        ]),
      },
      {
        assertArgs: ["repos/owner/repo/pulls/17/comments/401/replies"],
        assertStdinIncludes: ['"body":"Addressed `@copilot`\'s note in 93cd7f8."'],
        stdout: '{"id":2301,"html_url":"https://github.com/owner/repo/pull/17#discussion_r2301"}\n',
      },
    ]);
    const mapPath = path.join(tempDir, "message-map.json");
    await writeJsonHelper(mapPath, { THREAD_1: "Addressed @copilot's note in 93cd7f8." });

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--message-map", mapPath],
      { env: gh.env },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
