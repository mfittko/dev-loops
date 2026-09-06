import path from "node:path";

import {
  captureStream,
  makeGhMock,
  runIdFreeEnv,
  runNode as runNodeHelper,
  writeJson as writeJsonHelper,
} from "../_helpers.mjs";
import { runCli } from "../../scripts/loop/detect-copilot-loop-state.mjs";
import { formatCliError } from "../../scripts/_core-helpers.mjs";

const scriptPath = path.resolve("scripts/loop/detect-copilot-loop-state.mjs");

export const fixturePath = path.resolve(
  "packages/core/test/fixtures/github/review-threads/mixed-threads.json",
);

export const GH_RUNNER = Symbol("detect-copilot-loop-state-gh-runner");

export const runNode = async (args = [], options = {}) => {
  if (args.includes("--help")) return runNodeHelper(scriptPath, args, options);
  const stdout = captureStream();
  const stderr = captureStream();
  const env = runIdFreeEnv(options.env);
  const runChild = env[GH_RUNNER];
  delete env[GH_RUNNER];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runCli(args, {
      stdout,
      stderr,
      env,
      ghCommand: "gh",
      runChild,
      repoRoot: options.cwd ?? process.cwd(),
    });
    return { code: process.exitCode ?? 0, stdout: stdout.get(), stderr: stderr.get() };
  } catch (error) {
    return { code: 1, stdout: stdout.get(), stderr: `${stderr.get()}${formatCliError(error)}\n` };
  } finally {
    process.exitCode = previousExitCode;
  }
};
export const writeJson = writeJsonHelper;

/**
 * Write a gh stub that matches scripted gh invocations in any order.
 * Each matching entry is claimed at most once via the claims directory.
 * Each entry: { assertArgs?, stdout?, stderr?, exitCode? }
 */
export const writeGhStub = async (_tempDir, entries) => {
  const { runChild: baseRunChild } = makeGhMock(entries, { matchMode: "claims" });
  const runChild = async (command, args, env, stdinText) => {
    const result = await baseRunChild(command, args, env, stdinText);
    return result.code === 97
      ? { ...result, stderr: `unexpected gh args: ${args.join(" ")}\n` }
      : result;
  };
  return { env: { [GH_RUNNER]: runChild } };
};

function makeReviewThreadsPayload(nodes = []) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes,
          },
        },
      },
    },
  };
}

export function makeThread({ id, isResolved = false, comments }) {
  return {
    id,
    isResolved,
    comments: {
      nodes: comments,
    },
  };
}

export function makeComment({ id, body, login = "reviewer", type = "User" }) {
  return {
    id,
    body,
    author: {
      login,
      __typename: type,
    },
  };
}

export async function writeAutoDetectGhStub(
  tempDir,
  {
    repo = "owner/repo",
    pr,
    prView = {},
    requestedReviewers = { users: [], teams: [] },
    reviewThreads = [],
    skipRequestedReviewers = false,
  } = {},
) {
  const entries = [
    {
      assertArgs: ["pr", "view", String(pr), "--repo", repo],
      stdout: `${JSON.stringify({
        headRefOid: "abc123",
        isDraft: false,
        state: "OPEN",
        number: pr,
        reviews: [],
        statusCheckRollup: [],
        ...prView,
      })}
`,
    },
  ];

  if (!skipRequestedReviewers) {
    entries.push({
      assertArgs: ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
      stdout: `${JSON.stringify(requestedReviewers)}
`,
    });
  }

  entries.push({
    assertArgs: ["api", "graphql"],
    stdout: `${JSON.stringify(makeReviewThreadsPayload(reviewThreads))}
`,
  });

  return writeGhStub(tempDir, entries);
}
