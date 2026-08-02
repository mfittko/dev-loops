import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

import { fetchAllReviewThreads, filterThreads } from "../../scripts/github/list-review-threads.mjs";

const scriptPath = path.resolve("scripts/github/list-review-threads.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);
const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: false });

function threadsPayload({ hasNextPage = false, endCursor = null, nodes }) {
  return `${JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes,
          },
        },
      },
    },
  })}\n`;
}

function threadNode({ id, isResolved = false, isOutdated = false, path: filePath = "src/x.mjs", line = 12, comment }) {
  return {
    id,
    isResolved,
    isOutdated,
    path: filePath,
    line,
    comments: { nodes: comment ? [comment] : [] },
  };
}

function commentNode({ databaseId, body, login }) {
  return { databaseId, body, author: { login } };
}

test("list-review-threads returns the reply-resolve shape for a single page", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: threadsPayload({
          nodes: [
            threadNode({ id: "THREAD_1", isResolved: false, comment: commentNode({ databaseId: 101, body: "please fix", login: "copilot-pull-request-reviewer[bot]" }) }),
            threadNode({ id: "THREAD_2", isResolved: true, comment: commentNode({ databaseId: 102, body: "already resolved", login: "alice" }) }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env: gh.env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.repo, "owner/repo");
    assert.equal(parsed.pr, 17);
    assert.deepEqual(parsed.threads, [
      {
        threadId: "THREAD_1",
        commentId: 101,
        author: "copilot-pull-request-reviewer[bot]",
        body: "please fix",
        isResolved: false,
        isOutdated: false,
        path: "src/x.mjs",
        line: 12,
      },
      {
        threadId: "THREAD_2",
        commentId: 102,
        author: "alice",
        body: "already resolved",
        isResolved: true,
        isOutdated: false,
        path: "src/x.mjs",
        line: 12,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads --unresolved-only filters out resolved threads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-unresolved-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "pr=9"],
        stdout: threadsPayload({
          nodes: [
            threadNode({ id: "THREAD_OPEN", isResolved: false, comment: commentNode({ databaseId: 1, body: "open", login: "bob" }) }),
            threadNode({ id: "THREAD_DONE", isResolved: true, comment: commentNode({ databaseId: 2, body: "done", login: "bob" }) }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "9", "--unresolved-only"], { env: gh.env });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.threads.length, 1);
    assert.equal(parsed.threads[0].threadId, "THREAD_OPEN");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads --author filters by first-comment author (case-insensitive)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-author-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "pr=9"],
        stdout: threadsPayload({
          nodes: [
            threadNode({ id: "THREAD_A", comment: commentNode({ databaseId: 1, body: "a", login: "Alice" }) }),
            threadNode({ id: "THREAD_B", comment: commentNode({ databaseId: 2, body: "b", login: "bob" }) }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "9", "--author", "alice"], { env: gh.env });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.threads.length, 1);
    assert.equal(parsed.threads[0].threadId, "THREAD_A");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads --author all lists threads with a missing/ghost first-comment author", async () => {
  // "all" is a match-everything sentinel: a thread whose first comment is gone
  // (author null) must still list, not be dropped by the author filter.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-all-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "pr=9"],
        stdout: threadsPayload({
          nodes: [
            threadNode({ id: "THREAD_GHOST", comment: null }),
            threadNode({ id: "THREAD_NAMED", comment: commentNode({ databaseId: 1, body: "named", login: "bob" }) }),
          ],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "9", "--author", "all"], { env: gh.env });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.threads.map((t) => t.threadId), ["THREAD_GHOST", "THREAD_NAMED"]);
    assert.equal(parsed.threads[0].author, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads paginates past 100 threads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-page-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "pr=9"],
        stdout: threadsPayload({
          hasNextPage: true,
          endCursor: "cursor-1",
          nodes: [threadNode({ id: "THREAD_PAGE1", comment: commentNode({ databaseId: 1, body: "page1", login: "bob" }) })],
        }),
      },
      {
        assertArgs: ["api", "graphql", "after=cursor-1"],
        stdout: threadsPayload({
          hasNextPage: false,
          endCursor: null,
          nodes: [threadNode({ id: "THREAD_PAGE2", comment: commentNode({ databaseId: 2, body: "page2", login: "bob" }) })],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "9"], { env: gh.env });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.threads.map((t) => t.threadId), ["THREAD_PAGE1", "THREAD_PAGE2"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads excerpts long comment bodies", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-excerpt-"));
  try {
    const longBody = "x".repeat(250);
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "pr=9"],
        stdout: threadsPayload({
          nodes: [threadNode({ id: "THREAD_LONG", comment: commentNode({ databaseId: 1, body: longBody, login: "bob" }) })],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "9"], { env: gh.env });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.threads[0].body.length, 201); // 200 chars + ellipsis
    assert(parsed.threads[0].body.endsWith("…"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads handles a thread with no comments (null commentId/author)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-list-threads-empty-"));
  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "pr=9"],
        stdout: threadsPayload({
          nodes: [threadNode({ id: "THREAD_EMPTY", comment: null })],
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "9"], { env: gh.env });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.threads[0], {
      threadId: "THREAD_EMPTY",
      commentId: null,
      author: null,
      body: "",
      isResolved: false,
      isOutdated: false,
      path: "src/x.mjs",
      line: 12,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("list-review-threads rejects malformed arguments deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.match(JSON.parse(missingPr.stderr).error, /requires both --repo/i);
});

test("list-review-threads --help prints usage and exits 0", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert(result.stdout.includes("list-review-threads.mjs"));
  assert(result.stdout.includes("--unresolved-only"));
});

test("fetchAllReviewThreads + filterThreads compose directly (unit-level)", async () => {
  const calls = [];
  const runChild = async (command, args) => {
    calls.push(args);
    return { code: 0, stdout: threadsPayload({ nodes: [threadNode({ id: "T1", comment: commentNode({ databaseId: 1, body: "hi", login: "copilot" }) })] }), stderr: "" };
  };
  const threads = await fetchAllReviewThreads({ repo: "owner/repo", pr: 5 }, { env: {}, ghCommand: "gh", runChild });
  assert.equal(calls.length, 1);
  assert.equal(threads.length, 1);
  const filtered = filterThreads(threads, { author: "copilot" });
  assert.equal(filtered.length, 1);
  const filteredOut = filterThreads(threads, { author: "someone-else" });
  assert.equal(filteredOut.length, 0);
});

test("fetchAllReviewThreads fails closed on non-advancing and unbounded cursor sequences", async () => {
  const page = (cursor) => ({
    code: 0,
    stderr: "",
    stdout: threadsPayload({ hasNextPage: true, endCursor: cursor, nodes: [] }),
  });

  let calls = 0;
  await assert.rejects(
    () => fetchAllReviewThreads(
      { repo: "owner/repo", pr: 1 },
      { env: {}, runChild: async () => { calls += 1; return page("SAME"); } },
    ),
    /pagination did not advance/,
  );
  assert.equal(calls, 2);

  let cycleCalls = 0;
  await assert.rejects(
    () => fetchAllReviewThreads(
      { repo: "owner/repo", pr: 1 },
      { env: {}, runChild: async () => { cycleCalls += 1; return page(cycleCalls % 2 === 0 ? "A" : "B"); } },
    ),
    /exceeded 100 pages/,
  );
  assert.equal(cycleCalls, 100);
});
