import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "bun:test";

import {
  isActionableComment,
  isActionableThread,
  parseReviewThreads,
} from "../src/github/review-threads.mjs";

const fixturePath = path.resolve("packages/core/test/fixtures/github/review-threads/mixed-threads.json");

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("isActionableComment filters bot and empty comments deterministically", () => {
  assert.equal(
    isActionableComment({ body: "Please add a test", author: { login: "reviewer", __typename: "User" } }),
    true,
  );
  assert.equal(
    isActionableComment({ body: "Automated note", author: { login: "copilot[bot]", __typename: "Bot" } }),
    false,
  );
  assert.equal(isActionableComment({ body: "   ", author: { login: "reviewer", __typename: "User" } }), false);
  assert.equal(isActionableComment({ body: "System event", author: null }), false);
});

test("isActionableThread requires an unresolved thread with at least one actionable comment", () => {
  assert.equal(
    isActionableThread({
      isResolved: false,
      comments: { nodes: [{ body: "Needs a test", author: { login: "reviewer", __typename: "User" } }] },
    }),
    true,
  );
  assert.equal(
    isActionableThread({
      isResolved: true,
      comments: { nodes: [{ body: "Needs a test", author: { login: "reviewer", __typename: "User" } }] },
    }),
    false,
  );
});

test("parseReviewThreads normalizes fixture-backed review thread data", async () => {
  const payload = await loadFixture();
  const result = parseReviewThreads(payload);

  assert.deepEqual(result.summary, {
    totalThreads: 3,
    unresolvedThreads: 2,
    actionableThreads: 1,
    actionableComments: 1,
  });

  assert.deepEqual(result.threads, [
    {
      id: "t-1",
      isResolved: false,
      isActionable: true,
      commentIds: ["c-1"],
      commentDatabaseIds: [],
      actionableCommentIds: ["c-1"],
      actionableCommentDatabaseIds: [],
    },
    {
      id: "t-2",
      isResolved: true,
      isActionable: false,
      commentIds: ["c-2"],
      commentDatabaseIds: [],
      actionableCommentIds: [],
      actionableCommentDatabaseIds: [],
    },
    {
      id: "t-3",
      isResolved: false,
      isActionable: false,
      commentIds: ["c-3", "c-4"],
      commentDatabaseIds: [],
      actionableCommentIds: [],
      actionableCommentDatabaseIds: [],
    },
  ]);

  assert.deepEqual(result.comments, [
    {
      id: "c-1",
      databaseId: null,
      threadId: "t-1",
      author: { login: "reviewer", type: "User", isBot: false },
      body: "Please add regression coverage.",
      isActionable: true,
    },
    {
      id: "c-2",
      databaseId: null,
      threadId: "t-2",
      author: { login: "maintainer", type: "User", isBot: false },
      body: "Resolve after the docs update lands.",
      isActionable: false,
    },
    {
      id: "c-3",
      databaseId: null,
      threadId: "t-3",
      author: { login: "copilot-pull-request-reviewer[bot]", type: "Bot", isBot: true },
      body: "Automated summary from Copilot.",
      isActionable: false,
    },
    {
      id: "c-4",
      databaseId: null,
      threadId: "t-3",
      author: { login: "", type: "System", isBot: false },
      body: "Thread metadata event.",
      isActionable: false,
    },
  ]);
});

test("parseReviewThreads preserves numeric review comment database ids for REST follow-up", () => {
  const result = parseReviewThreads({
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
                      id: "PRRC_node_9",
                      databaseId: 9,
                      body: "Please use the matching comment id.",
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
  });

  assert.deepEqual(result.threads, [
    {
      id: "THREAD_123",
      isResolved: false,
      isActionable: true,
      commentIds: ["PRRC_node_9"],
      commentDatabaseIds: ["9"],
      actionableCommentIds: ["PRRC_node_9"],
      actionableCommentDatabaseIds: ["9"],
    },
  ]);

  assert.deepEqual(result.comments, [
    {
      id: "PRRC_node_9",
      databaseId: "9",
      threadId: "THREAD_123",
      author: { login: "reviewer", type: "User", isBot: false },
      body: "Please use the matching comment id.",
      isActionable: true,
    },
  ]);
});

// ── Signal classification tests ──────────────────────────────────────────

import {
  classifyCommentSignal,
  classifyThreadSignal,
  classifyReviewThreadsSignal,
} from "../src/github/review-threads.mjs";

test("classifyCommentSignal: low — empty or whitespace body", () => {
  assert.equal(classifyCommentSignal({ body: "" }), "low");
  assert.equal(classifyCommentSignal({ body: "   " }), "low");
  assert.equal(classifyCommentSignal({}), "low");
});

test("classifyCommentSignal: low — cosmetic nit comments", () => {
  assert.equal(classifyCommentSignal({ body: "nit: extra space" }), "low");
  assert.equal(classifyCommentSignal({ body: "Rename this variable." }), "low");
  assert.equal(classifyCommentSignal({ body: "Spacing is off here." }), "low");
  assert.equal(classifyCommentSignal({ body: "Please add a comment." }), "low");
});

test("classifyCommentSignal: high — bug, security, crash keywords", () => {
  assert.equal(classifyCommentSignal({ body: "This bug causes data loss." }), "high");
  assert.equal(classifyCommentSignal({ body: "There is a security vulnerability here." }), "high");
  assert.equal(classifyCommentSignal({ body: "This will crash on null input." }), "high");
  assert.equal(classifyCommentSignal({ body: "The contract is broken" }), "high");
  assert.equal(classifyCommentSignal({ body: "This silently drops errors." }), "high");
  assert.equal(classifyCommentSignal({ body: "Memory leak in the event handler." }), "high");
});

test("classifyCommentSignal: mid — refactor, design, improvement suggestions", () => {
  assert.equal(classifyCommentSignal({ body: "Consider refactoring this method." }), "mid");
  assert.equal(classifyCommentSignal({ body: "The architecture here could be improved." }), "mid");
  assert.equal(classifyCommentSignal({ body: "I would suggest using a different pattern." }), "mid");
  assert.equal(classifyCommentSignal({ body: "This is duplicated; DRY it up." }), "mid");
});

test("classifyCommentSignal: high keywords take priority over mid keywords", () => {
  assert.equal(classifyCommentSignal({ body: "This bug in the refactored code" }), "high");
});

test("classifyThreadSignal: highest comment signal sets thread signal", () => {
  assert.equal(classifyThreadSignal({ comments: [
    { body: "nit: spacing" }, { body: "This bug causes a crash." },
  ] }), "high");
  assert.equal(classifyThreadSignal({ comments: [
    { body: "nit: spacing" }, { body: "Consider simplifying this." },
  ] }), "mid");
  assert.equal(classifyThreadSignal({ comments: [] }), "low");
});

test("classifyReviewThreadsSignal: filters to Copilot-authored threads", () => {
  const isCopilot = (login) => /^copilot/i.test(login);
  // Use parseReviewThreads-compatible shape: flat comments with threadId, plus threads array
  assert.equal(classifyReviewThreadsSignal({
    threads: [{ id: "thread-1", isResolved: false, isActionable: true }],
    comments: [{ threadId: "thread-1", body: "This bug is critical.", author: { login: "copilot-review[bot]" } }],
  }, isCopilot), "high");
});

test("classifyReviewThreadsSignal: null when no Copilot threads", () => {
  const isCopilot = (login) => /^copilot/i.test(login);
  assert.equal(classifyReviewThreadsSignal({
    threads: [{ id: "thread-1" }],
    comments: [{ threadId: "thread-1", body: "ok", author: { login: "human" } }],
  }, isCopilot), null);
});

test("classifyReviewThreadsSignal: empty result returns null", () => {
  const isCopilot = (login) => /^copilot/i.test(login);
  assert.equal(classifyReviewThreadsSignal({ threads: [], comments: [] }, isCopilot), null);
});
