import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/github/capture-review-threads.mjs");
const fixturePath = path.resolve("packages/core/test/fixtures/github/review-threads/mixed-threads.json");
const { REVIEW_THREADS_QUERY } = await import(pathToFileURL(scriptPath).href);

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true, defaultStdout: "null\n" });

test("capture-review-threads GraphQL query avoids unsupported Bot fields", () => {
  assert.equal(REVIEW_THREADS_QUERY.includes("isBot"), false);
});

test("capture-review-threads emits deterministic JSON for --input", async () => {
  const result = await runNode(["--input", fixturePath]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");

  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.source, {
    type: "input",
    inputPath: fixturePath,
  });
  assert.deepEqual(output.summary, {
    totalThreads: 3,
    unresolvedThreads: 2,
    actionableThreads: 1,
    actionableComments: 1,
  });
  assert.equal(output.threads[0].id, "t-1");
  assert.equal(output.comments[3].id, "c-4");
});

test("capture-review-threads reads review-thread JSON from stdin", async () => {
  const stdin = await readFile(fixturePath, "utf8");
  const result = await runNode([], { stdin });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");

  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.source, { type: "stdin" });
  assert.equal(output.ok, true);
  assert.equal(output.summary.totalThreads, 3);
});

test("capture-review-threads writes identical JSON to --output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-capture-review-threads-"));
  const outputPath = path.join(tempDir, "review-threads.json");

  try {
    const result = await runNode(["--input", fixturePath, "--output", outputPath]);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const stdoutPayload = JSON.parse(result.stdout);
    const filePayload = JSON.parse(await readFile(outputPath, "utf8"));

    assert.deepEqual(filePayload, stdoutPayload);
    assert.equal(stdoutPayload.outputPath, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("capture-review-threads supports live gh capture only with explicit --repo and --pr", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-capture-review-live-"));

  try {
    const fixtureText = await readFile(fixturePath, "utf8");
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: fixtureText,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env: gh.env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.deepEqual(output.source, {
      type: "github",
      repo: "owner/repo",
      pr: 17,
    });
    assert.equal(output.summary.totalThreads, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("capture-review-threads exposes numeric comment database ids in normalized live output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-capture-review-database-id-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "THREAD_123",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            id: "PRRC_node_456",
                            databaseId: 456,
                            body: "Use the numeric comment id for REST follow-up.",
                            author: { login: "reviewer", __typename: "User" },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env: gh.env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.threads, [
      {
        id: "THREAD_123",
        isResolved: false,
        isActionable: true,
        commentIds: ["PRRC_node_456"],
        commentDatabaseIds: ["456"],
        actionableCommentIds: ["PRRC_node_456"],
        actionableCommentDatabaseIds: ["456"],
      },
    ]);
    assert.deepEqual(output.comments, [
      {
        id: "PRRC_node_456",
        databaseId: "456",
        threadId: "THREAD_123",
        author: { login: "reviewer", type: "User", isBot: false },
        body: "Use the numeric comment id for REST follow-up.",
        isActionable: true,
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("capture-review-threads rejects unsafe repo slugs deterministically", async () => {
  for (const repo of ["../repo", "owner/..", "owner\\repo", "./repo"]) {
    const result = await runNode(["--repo", repo, "--pr", "17"]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "--repo must match <owner/name>",
    });
  }
});

test("capture-review-threads rejects malformed live-argument combinations deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.equal(missingPr.stdout, "");
  assert.deepEqual(JSON.parse(missingPr.stderr), {
    ok: false,
    error: "Live GitHub capture requires both --repo <owner/name> and --pr <number>",
  });

  const zeroPr = await runNode(["--repo", "owner/repo", "--pr", "0"]);
  assert.equal(zeroPr.code, 1);
  assert.equal(zeroPr.stdout, "");
  assert.deepEqual(JSON.parse(zeroPr.stderr), {
    ok: false,
    error: "--pr must be a positive integer",
  });

  const mixedSources = await runNode(["--input", fixturePath, "--repo", "owner/repo", "--pr", "17"]);
  assert.equal(mixedSources.code, 1);
  assert.equal(mixedSources.stdout, "");
  assert.deepEqual(JSON.parse(mixedSources.stderr), {
    ok: false,
    error: "Choose exactly one input source: --input <path>, stdin, or live --repo/--pr",
  });
});

test("capture-review-threads reports gh failures deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-capture-review-gh-failure-"));

  try {
    const gh = await writeGhStub(tempDir, [
      {
        stderr: "gh: authentication required\n",
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env: gh.env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "gh command failed: gh: authentication required",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("--unresolved --bodies emits only unresolved threads with joined bodies (fix-loop working set)", async () => {
  const snapshot = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "t-1",
                isResolved: false,
                isOutdated: true,
                path: "src/a.mjs",
                line: 12,
                comments: { nodes: [
                  { id: "c-1", body: "first" },
                  { id: "c-2", body: "second" },
                ] },
              },
              {
                id: "t-2",
                isResolved: true,
                path: "src/b.mjs",
                line: 3,
                comments: { nodes: [{ id: "c-3", body: "resolved" }] },
              },
            ],
          },
        },
      },
    },
  });
  const result = await runNode(["--unresolved", "--bodies"], { stdin: snapshot });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.threads, [
    { threadId: "t-1", path: "src/a.mjs", line: 12, isOutdated: true, bodies: ["first", "second"] },
  ]);
  assert.equal(output.summary.totalThreads, 2);
  assert.equal(output.summary.unresolvedThreads, 1);
  assert.equal(output.comments, undefined, "the working-set view carries no separate comments array");
});

test("--unresolved --bodies with an empty working set emits an empty threads array", async () => {
  const snapshot = JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
  });
  const result = await runNode(["--unresolved", "--bodies"], { stdin: snapshot });

  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.threads, []);
  assert.equal(output.summary.totalThreads, 0);
});

test("a snapshot without path/line/isOutdated degrades to null/null/false in the working-set view", async () => {
  const stdin = await readFile(fixturePath, "utf8");
  const result = await runNode(["--unresolved", "--bodies"], { stdin });

  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.threads.length, 2);
  for (const thread of output.threads) {
    assert.equal(thread.path, null);
    assert.equal(thread.line, null);
    assert.equal(thread.isOutdated, false);
    assert.equal(Array.isArray(thread.bodies), true);
  }
});

test("a lone --unresolved or --bodies flag fails closed, and the default shape is unchanged without them", async () => {
  const stdin = await readFile(fixturePath, "utf8");
  for (const args of [["--unresolved"], ["--bodies"]]) {
    const result = await runNode(args, { stdin });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /only valid together/);
  }

  const plain = await runNode([], { stdin });
  const output = JSON.parse(plain.stdout);
  assert.deepEqual(Object.keys(output).sort(), ["comments", "ok", "source", "summary", "threads"]);
  assert.equal(output.threads.some((thread) => thread.isResolved), true, "default output keeps resolved threads");
});

test("the live GraphQL query fetches the working-set location fields", () => {
  for (const field of ["path", "line", "isOutdated"]) {
    assert.equal(REVIEW_THREADS_QUERY.includes(field), true, `query must fetch ${field}`);
  }
});
