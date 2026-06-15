import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { buildAttemptBudget, buildPollDelayMs, findFreshCopilotActivity, parseWatchCliArgs, watchCopilotReview } from "../../scripts/github/probe-copilot-review.mjs";

const scriptPath = path.resolve("scripts/github/probe-copilot-review.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

function createThread(commentId, login, body, type = "User") {
  return {
    id: `t-${commentId}`,
    isResolved: false,
    comments: {
      nodes: [
        {
          id: commentId,
          body,
          author: {
            login,
            __typename: type,
            isBot: type === "Bot",
          },
        },
      ],
    },
  };
}

function createReview(id, login, body, type = "User") {
  return {
    id,
    body,
    author: {
      login,
      __typename: type,
      isBot: type === "Bot",
    },
  };
}

function createIssueComment(id, login, body, type = "User") {
  return {
    id,
    body,
    author: {
      login,
      __typename: type,
      isBot: type === "Bot",
    },
  };
}

function createActivityPayload({ threads = [], reviews = [], issueComments = [] } = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: threads },
          reviews: { nodes: reviews },
          comments: { nodes: issueComments },
        },
      },
    },
  };
}

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true, defaultStdout: "null\n" });
  return env;
}

function noChangePayload(status, attempts) {
  return {
    ok: true,
    status,
    repo: "owner/repo",
    pr: 17,
    attempts,
    newComments: [],
    newReviews: [],
    newIssueComments: [],
  };
}


test("buildAttemptBudget rounds up non-divisible timeout windows", () => {
  assert.equal(buildAttemptBudget(0, 60_000), 1);
  assert.equal(buildAttemptBudget(250, 100), 3);
  assert.equal(buildAttemptBudget(200, 100), 2);
});

test("buildPollDelayMs schedules polls on the requested watch timeline", () => {
  assert.equal(buildPollDelayMs(1_000, 250, 100, 1, 1_000), 100);
  assert.equal(buildPollDelayMs(1_000, 250, 100, 3, 1_200), 50);
  assert.equal(buildPollDelayMs(1_000, 250, 100, 3, 1_260), 0);
});

test("probe-copilot-review returns idle for a zero-timeout no-change check", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-idle-"));
  const baseline = createActivityPayload();
  try {
    const env = await writeGhStub(tempDir, [{ stdout: JSON.stringify(baseline) + "\n" }]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 5000, timeoutMs: 0 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "idle");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review returns timeout after bounded polling with no fresh Copilot activity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-timeout-"));
  try {
    const payload = createActivityPayload();
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(payload) + "\n" },
      { stdout: JSON.stringify(payload) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 10, timeoutMs: 25 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "timeout");
    assert.equal(result.attempts, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review rounds up attempt budget so non-divisible timeout still covers full window", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-round-up-"));
  try {
    const payload = createActivityPayload();
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(payload) + "\n" },
      { stdout: JSON.stringify(payload) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 10, timeoutMs: 25 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "timeout");
    assert.equal(result.attempts, 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review returns changed for fresh Copilot review-thread comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-thread-"));
  const baseline = createActivityPayload({ threads: [createThread("c-1", "reviewer", "Please add a test.")] });
  const changed = createActivityPayload({
    threads: [
      createThread("c-1", "reviewer", "Please add a test."),
      createThread("c-2", "copilot-pull-request-reviewer[bot]", "Automated Copilot review feedback.", "Bot"),
    ],
  });
  try {
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(baseline) + "\n" },
      { stdout: JSON.stringify(changed) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 1, timeoutMs: 5 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "changed");
    assert.equal(result.newComments.length, 1);
    assert.equal(result.newComments[0].id, "c-2");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review returns changed for fresh Copilot review summaries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-probe-copilot-review-"));
  const baseline = createActivityPayload();
  const changed = createActivityPayload({
    reviews: [createReview("r-1", "copilot-pull-request-reviewer[bot]", "Automated Copilot summary.", "Bot")],
  });
  try {
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(baseline) + "\n" },
      { stdout: JSON.stringify(changed) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 1, timeoutMs: 5 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "changed");
    assert.equal(result.newReviews.length, 1);
    assert.equal(result.newReviews[0].id, "r-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review returns changed for fresh Copilot issue comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-issue-comment-"));
  const baseline = createActivityPayload();
  const changed = createActivityPayload({
    issueComments: [createIssueComment("i-1", "Copilot", "Fresh Copilot issue comment.", "Bot")],
  });
  try {
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(baseline) + "\n" },
      { stdout: JSON.stringify(changed) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 1, timeoutMs: 5 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "changed");
    assert.equal(result.newIssueComments.length, 1);
    assert.equal(result.newIssueComments[0].id, "i-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review ignores fresh non-Copilot activity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-ignore-non-copilot-"));
  const baseline = createActivityPayload();
  const changed = createActivityPayload({
    threads: [createThread("c-1", "reviewer", "Please add a test."), createThread("c-2", "maintainer", "I will handle this comment.")],
    reviews: [createReview("r-1", "maintainer", "Human review summary.")],
    issueComments: [createIssueComment("i-1", "maintainer", "Human issue comment.")],
  });
  try {
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(baseline) + "\n" },
      { stdout: JSON.stringify(changed) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 1, timeoutMs: 1 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "timeout");
    assert.equal(result.attempts, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review ignores lookalike non-Copilot logins", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-watch-copilot-lookalike-"));
  const baseline = createActivityPayload();
  const changed = createActivityPayload({
    threads: [createThread("c-1", "reviewer", "Please add a test."), createThread("c-2", "my-copilot-helper", "This should not count as Copilot.")],
    reviews: [createReview("r-1", "my-copilot-helper", "Still not Copilot.")],
    issueComments: [createIssueComment("i-1", "my-copilot-helper", "Still not Copilot.")],
  });
  try {
    const env = await writeGhStub(tempDir, [
      { stdout: JSON.stringify(baseline) + "\n" },
      { stdout: JSON.stringify(changed) + "\n" },
    ]);
    const result = await watchCopilotReview({ repo: "owner/repo", pr: 17, pollIntervalMs: 1, timeoutMs: 1 }, { env, ghCommand: "gh" });
    assert.equal(result.status, "timeout");
    assert.equal(result.attempts, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("probe-copilot-review rejects malformed arguments deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.match(JSON.parse(missingPr.stderr).error, /requires both --repo/i);
  const invalidTimeout = await runNode(["--repo", "owner/repo", "--pr", "17", "--timeout-ms", "-1"]);
  assert.equal(invalidTimeout.code, 1);
  assert.match(JSON.parse(invalidTimeout.stderr).error, /--timeout-ms has been removed/);
  const invalidInterval = await runNode(["--repo", "owner/repo", "--pr", "17", "--poll-interval-ms", "0"]);
  assert.equal(invalidInterval.code, 1);
  assert.match(JSON.parse(invalidInterval.stderr).error, /--poll-interval-ms has been removed/);
});

test("probe-copilot-review --help prints usage and exits 0", async () => {
  const helpLong = await runNode(["--help"]);
  assert.equal(helpLong.code, 0);
  assert.equal(helpLong.stderr, "");
  assert(helpLong.stdout.includes("probe-copilot-review.mjs"), `expected script name in help, got: ${helpLong.stdout}`);
  assert(helpLong.stdout.includes("--repo"), `expected --repo in help`);
  assert(helpLong.stdout.includes("--pr"), `expected --pr in help`);
  assert(!helpLong.stdout.includes("--poll-interval-ms"), `expected --poll-interval-ms in help`);
  assert(!helpLong.stdout.includes("--timeout-ms"), `expected --timeout-ms in help`);

  const helpShort = await runNode(["-h"]);
  assert.equal(helpShort.code, 0);
  assert.equal(helpShort.stderr, "");
  assert.equal(helpShort.stdout, helpLong.stdout);
});

test("probe-copilot-review uses production-safe defaults (1-minute poll, 30-minute timeout)", () => {
  const options = parseWatchCliArgs(["--repo", "owner/repo", "--pr", "17"]);
  assert.equal(options.pollIntervalMs, 60_000);
  assert.equal(options.timeoutMs, 1_800_000);
});

test("probe-copilot-review trims surrounding whitespace from --repo", () => {
  const options = parseWatchCliArgs(["--repo", " owner/repo ", "--pr", "17"]);
  assert.equal(options.repo, "owner/repo");
});
