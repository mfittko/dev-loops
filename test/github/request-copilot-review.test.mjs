import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { describe, it } from "node:test";
import { makeGhMock, runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";
import { checkForCopilotComments, parseRequestCliArgs, performCopilotReviewRequest } from "../../scripts/github/request-copilot-review.mjs";
import { writeSuppressionMarker } from "../../scripts/loop/_post-convergence-review-suppression.mjs";

const scriptPath = path.resolve("scripts/github/request-copilot-review.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

// The draft-gate round reset reads BOTH surfaces a verdict can live on: the
// issue-comment stream first, then the PR review stream (the round's single
// visible surface). Every at-cap stub sequence answers the second read too.
const EMPTY_REVIEW_STREAM_ENTRY = {
  assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
  stdout: "[[]]\n",
};

// In-process run: replay the same gh entries via makeGhMock and call the exported
// entry fn directly, so the CLI logic runs without a node subprocess per gh call.
// GH_SEQUENCE_PATH is set by default to preserve the production skip of the
// copilot-comment check (the CLI treats it as the "under stub harness" signal);
// pass `env: {}` to exercise that check end to end. Config is loaded from the
// worktree cwd, matching the no-cwd spawn tests.
async function runInProcess(args, entries, { env = { GH_SEQUENCE_PATH: "1" } } = {}) {
  const { runChild, calls } = makeGhMock(entries, { repeatLastOnOverflow: true });
  const options = parseRequestCliArgs(args);
  const result = await performCopilotReviewRequest(options, { env, ghCommand: "gh", runChild });
  return { result, calls };
}

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true });
  return env;
}

// request-copilot-review.mjs treats env.GH_SEQUENCE_PATH as a "running under the
// stub harness — skip the copilot-comment check" test-mode signal, which shares
// its name with the gh-stub harness's own sequence-file pointer, so the two
// roles collide. Rename the stub's internal pointer so a test can exercise the
// actual copilot-comment-check path end to end while still reusing the shared
// stub-script generator.
async function writeGhStubWithCommentCheck(tempDir, entries) {
  const { env, ghPath } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true });
  const script = await readFile(ghPath, "utf8");
  await writeFile(ghPath, script.replaceAll("process.env.GH_SEQUENCE_PATH", "process.env.TEST_GH_SEQUENCE_PATH"), "utf8");
  const { GH_SEQUENCE_PATH: sequencePath, ...rest } = env;
  return { ...rest, TEST_GH_SEQUENCE_PATH: sequencePath };
}

test("request-copilot-review requests Copilot deterministically and verifies via requested_reviewers", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review recognizes Copilot under the requested reviewer login returned by GitHub", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review reports already-requested without mutating PR state again", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[{"id":"r-1","author":{"login":"copilot-pull-request-reviewer[bot]"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review suppresses same-head clean re-request by default", async () => {
  const { result, calls } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":false,"state":"OPEN","number":17,"headRefOid":"newsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"newsha"}}],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "suppressed_same_head_clean",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      sameHeadCleanConverged: true,
      detail: "Current head already has a clean submitted Copilot review; same-head clean-convergence suppression is always enforced.",
    });
  // 3 gh calls: preflight requested_reviewers + expanded PR view, then only review threads for clean-convergence proof.
  assert.equal(calls.length, 3);
});


test("request-copilot-review treats pending review as already-requested even when a submitted current-head review exists", async () => {
  const { result, calls } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"abc123","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}},{"id":"r-2","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  assert.equal(calls.length, 2);
});

test("request-copilot-review treats a pending Copilot review as already-requested before mutating", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"abc123","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review accepts --force-rerequest-review as a valid flag", async () => {
  // With cap not reached (0 reviews, default cap 5): flag is a no-op; normal flow applies.
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

  assert.equal(result.status, "requested");
});

test("request-copilot-review accepts an immediate Copilot review as proof the request succeeded", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[{"id":"r-2","author":{"login":"copilot-pull-request-reviewer[bot]"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review accepts review-surface presence (prior submitted Copilot review, unchanged after edit) as proof of an in-progress review — #1670 regression", async () => {
  // Reviewer-configured repo where @copilot is a silent no-op: after `pr edit`
  // the requested_reviewers stay empty, the review count does NOT increase (a
  // submitted Copilot review was already present in the before-state), and there
  // is no pending current-head review. The only signal preventing the
  // "did not appear in requested reviewers or fresh/in-progress Copilot reviews"
  // throw is the new reviewPresence.present branch (resolveCopilotReviewPresence).
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
    {
      assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
      stdout: '{"users":[],"teams":[]}\n',
    },
    {
      assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
      stdout: '{"reviews":[{"id":"r-1","author":{"login":"copilot-pull-request-reviewer[bot]"}}]}\n',
    },
    {
      assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
      stdout: "https://github.com/owner/repo/pull/17\n",
    },
    {
      assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
      stdout: '{"users":[],"teams":[]}\n',
    },
    {
      assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
      stdout: '{"reviews":[{"id":"r-1","author":{"login":"copilot-pull-request-reviewer[bot]"}}]}\n',
    },
  ]);

  assert.deepEqual(result, {
    ok: true,
    status: "requested",
    repo: "owner/repo",
    pr: 17,
    reviewer: "Copilot",
  });
});

test("request-copilot-review normalizes known unrequestable/unavailable failures", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stderr: "gh: Reviews may only be requested from collaborators.\n",
        exitCode: 1,
      },
      // post-422: check if Copilot already has a review on current head
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      // post-failure verification: Copilot is still not in requested_reviewers
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      // post-failure verification: no pending Copilot review
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "unavailable",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "gh: Reviews may only be requested from collaborators.",
    });
});

test("request-copilot-review returns already-requested when 422 but Copilot is in requested_reviewers", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      // before: Copilot not in requested_reviewers yet
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      // request: GitHub returns 422
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stderr: "gh: Reviews may only be requested from collaborators.\n",
        exitCode: 1,
      },
      // post-422: check if Copilot already has a review on current head
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      // post-failure verification: Copilot now appears in requested_reviewers
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review returns already-requested when 422 but Copilot has a pending review", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      // before: Copilot not in requested_reviewers
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      // request: GitHub returns 422
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stderr: "gh: Reviews may only be requested from collaborators.\n",
        exitCode: 1,
      },
      // post-422: check if Copilot already has a review on current head — finds pending review
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"abc123","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review does not treat a stale pending Copilot review as already-requested before mutating", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review ignores a stale pending Copilot review after 422 and stays unavailable", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stderr: "gh: Reviews may only be requested from collaborators.\n",
        exitCode: 1,
      },
      // post-422: check if Copilot already has a review on current head — stale review on old head, no match
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "unavailable",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "gh: Reviews may only be requested from collaborators.",
    });
});

test("request-copilot-review wraps invalid gh JSON deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-json-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: "not-json\n",
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Invalid JSON from gh: not-json",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review rejects malformed arguments deterministically", async () => {
  const missingPr = await runNode(["--repo", "owner/repo"]);
  assert.equal(missingPr.code, 1);
  assert.equal(missingPr.stdout, "");
  const missingPrErr = JSON.parse(missingPr.stderr);
  assert.equal(missingPrErr.ok, false);
  assert.equal(missingPrErr.error, "Requesting Copilot review requires both --repo <owner/name> and --pr <number>");
  assert.equal(missingPrErr.hint, "run with --help for usage");

  const zeroPr = await runNode(["--repo", "owner/repo", "--pr", "0"]);
  assert.equal(zeroPr.code, 1);
  assert.equal(zeroPr.stdout, "");
  const zeroPrErr = JSON.parse(zeroPr.stderr);
  assert.equal(zeroPrErr.ok, false);
  assert.equal(zeroPrErr.error, "--pr must be a positive integer");
  assert.equal(zeroPrErr.hint, "run with --help for usage");

  const badRepo = await runNode(["--repo", " owner / repo ", "--pr", "17"]);
  assert.equal(badRepo.code, 1);
  assert.equal(badRepo.stdout, "");
  const badRepoErr = JSON.parse(badRepo.stderr);
  assert.equal(badRepoErr.ok, false);
  assert.equal(badRepoErr.error, "--repo must match <owner/name>");
  assert.equal(badRepoErr.hint, "run with --help for usage");

  const unknown = await runNode(["--repo", "owner/repo", "--pr", "17", "--wat"]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  const unknownErr = JSON.parse(unknown.stderr);
  assert.equal(unknownErr.ok, false);
  assert.equal(unknownErr.error, "Unknown argument: --wat");
  assert.equal(unknownErr.hint, "run with --help for usage");

  const forceWithUnknown = await runNode(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review", "--wat"]);
  assert.equal(forceWithUnknown.code, 1);
  const forceWithUnknownErr = JSON.parse(forceWithUnknown.stderr);
  assert.equal(forceWithUnknownErr.error, "Unknown argument: --wat");
});

test("request-copilot-review --help prints usage and exits 0", async () => {
  const helpLong = await runNode(["--help"]);
  assert.equal(helpLong.code, 0);
  assert.equal(helpLong.stderr, "");
  assert(helpLong.stdout.includes("request-copilot-review.mjs"), `expected script name in help, got: ${helpLong.stdout}`);
  assert(helpLong.stdout.includes("--repo"), `expected --repo in help`);
  assert(helpLong.stdout.includes("--pr"), `expected --pr in help`);

  const helpShort = await runNode(["-h"]);
  assert.equal(helpShort.code, 0);
  assert.equal(helpShort.stderr, "");
  assert.equal(helpShort.stdout, helpLong.stdout);
});

test("checkForCopilotComments blocks when @copilot comment found from non-Copilot author", async () => {
  const { runChild } = makeGhMock([
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({ id: 1001, body: "@copilot Please re-review this PR", user: { login: "human-dev" } }) + "\n",
      },
    ], { repeatLastOnOverflow: true });

  const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { runChild });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.violationCommentIds, [1001]);
});

test("checkForCopilotComments passes when no @copilot comments found", async () => {
  const { runChild } = makeGhMock([
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({ id: 1001, body: "LGTM!", user: { login: "human-dev" } }) + "\n",
      },
    ], { repeatLastOnOverflow: true });

  const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { runChild });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.violationCommentIds, []);
});

test("checkForCopilotComments ignores @copilot in Copilot-authored comments", async () => {
  const { runChild } = makeGhMock([
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({ id: 2001, body: "I see you mentioned @copilot in your message", user: { login: "copilot-pull-request-reviewer[bot]" } }) + "\n",
      },
    ], { repeatLastOnOverflow: true });

  const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { runChild });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.violationCommentIds, []);
});

test("checkForCopilotComments reports all violation comments when multiple found", async () => {
  const { runChild } = makeGhMock([
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: [JSON.stringify({ id: 3001, body: "@copilot review please", user: { login: "dev-a" } }), JSON.stringify({ id: 3002, body: "/copilot re-review", user: { login: "dev-b" } })].join("\n") + "\n",
      },
    ], { repeatLastOnOverflow: true });

  const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { runChild });

  assert.equal(result.blocked, true);
  assert.deepEqual(result.violationCommentIds, [3001, 3002]);
});

test("checkForCopilotComments exempts a summon literal quoted inside an inline code span", async () => {
  const { runChild } = makeGhMock([
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({
          id: 4001,
          body: "Gate finding: quoting the `/copilot` prohibition rule from the anti-summon guard.",
          user: { login: "human-dev" },
        }) + "\n",
      },
    ], { repeatLastOnOverflow: true });

  const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { runChild });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.violationCommentIds, []);
});

test("checkForCopilotComments exempts a summon literal quoted inside a fenced code block", async () => {
  const { runChild } = makeGhMock([
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({
          id: 4002,
          body: "Anti-summon rule excerpt:\n```\n@copilot re-review\n```\nDo not post this literally.",
          user: { login: "human-dev" },
        }) + "\n",
      },
    ], { repeatLastOnOverflow: true });

  const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { runChild });

  assert.equal(result.blocked, false);
  assert.deepEqual(result.violationCommentIds, []);
});

test("request-copilot-review --silent exits 0 only when status is requested", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-silent-requested-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--silent"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review --silent exits non-zero for a non-requested status (honest status semantics)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-silent-non-requested-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":false,"state":"OPEN","number":17,"headRefOid":"newsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"newsha"}}],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

    // suppressed_same_head_clean is not "requested": ok:true in the JSON body
    // must NOT read as a placed request under --silent.
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--silent"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Per-status --silent exit contract: every non-"requested" outcome exits
// non-zero. Stub sequences mirror the corresponding non-silent status tests.
const SILENT_NON_REQUESTED_CASES = {
  "already-requested": {
    args: [],
    entries: [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ],
  },
  unavailable: {
    args: [],
    entries: [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stderr: "gh: Reviews may only be requested from collaborators.\n",
        exitCode: 1,
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ],
  },
  round_cap_reached: {
    args: [],
    entries: [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha5"}}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ],
  },
  no_changes_since_last_review: {
    args: ["--force-rerequest-review"],
    entries: [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"currentsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"currentsha"}}]}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      EMPTY_REVIEW_STREAM_ENTRY,
    ],
  },
  suppressed_draft: {
    args: [],
    entries: [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":true,"state":"OPEN","number":17,"reviews":[]}\n',
      },
    ],
  },
};

for (const [status, { args, entries }] of Object.entries(SILENT_NON_REQUESTED_CASES)) {
  test(`request-copilot-review --silent exits non-zero for status ${status}`, async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `dev-loops-request-copilot-silent-${status.replace(/_/g, "-")}-`));

    try {
      const env = await writeGhStub(tempDir, entries);

      // Confirm the stub sequence actually produces the status under test.
      const plain = await runNode(["--repo", "owner/repo", "--pr", "17", ...args], { env });
      assert.equal(plain.code, 0);
      assert.equal(JSON.parse(plain.stdout).status, status);

      // Rewind the sequential stub for the second (silent) invocation.
      await writeFile(env.GH_COUNTER_PATH, "0\n", "utf8");
      const silent = await runNode(["--repo", "owner/repo", "--pr", "17", ...args, "--silent"], { env });
      assert.equal(silent.code, 1);
      assert.equal(silent.stdout, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}

const BLOCKED_REGRESSION_GH_ENTRIES = [
  {
    assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
    stdout: '{"users":[],"teams":[]}\n',
  },
  {
    assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
    stdout: '{"isDraft":false,"state":"OPEN","number":17,"reviews":[]}\n',
  },
  {
    assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
    // A draft-gate verdict comment quoting the anti-summon rule as bare text
    // (not code-spanned) — the literal live-PR shape that self-deadlocked.
    stdout: JSON.stringify({
      id: 5001,
      body: "Findings summary: violates the /copilot prohibition rule.",
      user: { login: "human-dev" },
    }) + "\n",
  },
];

test("request-copilot-review self-deadlock regression: blocked_by_copilot_comment reports ok:true but is not a placed request", async () => {
  // env: {} (no GH_SEQUENCE_PATH) so the copilot-comment check runs end to end.
  const { result: parsed } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], BLOCKED_REGRESSION_GH_ENTRIES, { env: {} });
  assert.equal(parsed.status, "blocked_by_copilot_comment");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.violationCommentIds, [5001]);
});

test("request-copilot-review self-deadlock regression: --silent exits non-zero for blocked_by_copilot_comment", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-blocked-regression-silent-"));

  try {
    const env = await writeGhStubWithCommentCheck(tempDir, BLOCKED_REGRESSION_GH_ENTRIES);

    // Honest status: ok:true in the JSON body must NOT be read as a placed
    // request. --silent exits non-zero because status !== "requested" — this is
    // the exact contract violated in the live deadlock (two 30-minute watch
    // cycles ran against a request that was never placed).
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--silent"], { env });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review blocks request when PR is in draft state", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":true,"state":"OPEN","number":17,"reviews":[]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "suppressed_draft",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "PR is in draft state; review requests are blocked until the PR is marked ready for review.",
    });
});

test("request-copilot-review does not block request when PR is not draft", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":false,"state":"OPEN","number":17,"reviews":[]}\n',
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":false,"state":"OPEN","number":17,"reviews":[]}\n',
      },
    ]);

  assert.equal(result.status, "requested");
});

test("request-copilot-review draft check takes precedence over round cap", async () => {
  const { result: parsed } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":true,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"def"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"ghi"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"jkl"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"mno"}}]}\n',
      },
    ]);

  assert.equal(parsed.status, "suppressed_draft");
});

test("request-copilot-review returns round_cap_reached when cap is exhausted without force flag", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha5"}}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "round_cap_reached",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      completedRounds: 5,
      maxRounds: 2,
      detail: "Round cap of 2 reached with 5 completed rounds. No further re-requests will be made.",
    });
});

test("request-copilot-review --lightweight enforces the composed cap: light PR at 1 completed round returns round_cap_reached (#1210)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-lightweight-cap-"));

  try {
    // Full cap 5, lightweight cap defaults to 1 -> composed cap = min(1, 5) = 1.
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "",
      "refinement:",
      "  maxCopilotRounds: 5",
      "",
      "localImplementation:",
      "  lightMode:",
      "    enabled: true",
      "    maxFiles: 2",
      "    maxLines: 20",
      "",
    ].join("\n"), "utf8");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--lightweight"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "round_cap_reached");
    assert.equal(parsed.completedRounds, 1);
    assert.equal(parsed.maxRounds, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review refuses immediately when refinement.maxCopilotRounds: 0 (full PR, cap-0 must not be ignored)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-cap-zero-full-"));

  try {
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "",
      "refinement:",
      "  maxCopilotRounds: 0",
      "",
    ].join("\n"), "utf8");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"sha1","isDraft":false,"state":"OPEN","number":17,"reviews":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    // Before the fix, `effectiveCap > 0` was false for cap 0, so maxRounds stayed
    // at the built-in default of 5 and this first-ever request would have gone
    // through as "requested" instead of being refused.
    assert.equal(parsed.status, "round_cap_reached");
    assert.equal(parsed.completedRounds, 0);
    assert.equal(parsed.maxRounds, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review refuses immediately when the composed lightweight cap is 0 (cap-0 must not be ignored, #1210)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-cap-zero-lightweight-"));

  try {
    // refinement.maxCopilotRounds: 0 disables Copilot rounds everywhere,
    // including lightweight, per resolveEffectiveCopilotRoundCap's contract.
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "",
      "refinement:",
      "  maxCopilotRounds: 0",
      "",
      "localImplementation:",
      "  lightMode:",
      "    enabled: true",
      "    maxFiles: 2",
      "    maxLines: 20",
      "",
    ].join("\n"), "utf8");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"sha1","isDraft":false,"state":"OPEN","number":17,"reviews":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--lightweight"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "round_cap_reached");
    assert.equal(parsed.completedRounds, 0);
    assert.equal(parsed.maxRounds, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review --lightweight with an unloadable config falls back to the lightweight default cap of 1 (not the full-PR default of 5) and surfaces the config failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-lightweight-broken-config-"));

  try {
    // Invalid config (fails schema validation) — loadDevLoopConfig() returns
    // errors, not a thrown exception, for this shape.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\nnot_a_real_key: true\n", "utf8");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--lightweight"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    // Before the fix, a config load failure with --lightweight silently kept
    // the built-in full-PR default of 5 instead of failing toward the safer
    // lightweight default of 1.
    assert.equal(parsed.status, "round_cap_reached");
    assert.equal(parsed.completedRounds, 1);
    assert.equal(parsed.maxRounds, 1);
    assert.match(parsed.configWarning, /lightweight default cap of 1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review respects low-signal refinement config before auto re-requesting at round cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-roundcap-low-signal-"));

  try {
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "",
      "refinement:",
      "  maxCopilotRounds: 2",
      "  lowSignal:",
      "    enabled: true",
      "    roundThreshold: 1",
      "    maxComments: 1",
      "",
    ].join("\n"), "utf8");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha5"}}],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "round_cap_reached",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      completedRounds: 5,
      maxRounds: 2,
      detail: "Round cap of 2 reached with 5 completed rounds. No further re-requests will be made.",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review does NOT auto re-request at round cap when new commits land after resolved comments (no illegal over-cap re-request)", async () => {
  const { result: output } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}}],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
    ]);

  // At the cap, a head advance no longer re-opens an automatic Copilot re-request.
  // The round cap is respected; the pre_approval_gate reviews the current head.
  assert.equal(output.ok, true);
  assert.equal(output.status, "round_cap_reached");
  assert.equal(output.reviewer, "Copilot");
});

test("request-copilot-review --force-rerequest-review allows re-request when cap reached and new commits exist", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        // 5 reviews all on older commits; current head is "newsha" (different from last review "sha5")
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha5"}}]}\n',
      },
      {
        // #896: cap reached on the raw count → re-derive with the draft-gate round
        // reset. No clean draft_gate comment here, so the count is unchanged (5).
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        // AC2 convergence carry-forward: delta since the last reviewed head (sha5)
        // touches Copilot's review surface (a code file), so it re-opens the round.
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stdout: JSON.stringify({ status: "ahead", files: [{ filename: "src/foo.mjs", status: "modified" }] }) + "\n",
      },
      {
        assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"],
        stdout: "https://github.com/owner/repo/pull/17\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"newsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha5"}}]}\n',
      },
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
});

test("request-copilot-review --force-rerequest-review refuses when cap reached and no new commits", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        // 5 reviews, last review commit.oid matches current headRefOid ("currentsha")
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"currentsha","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"currentsha"}}]}\n',
      },
      {
        // #896: cap reached on the raw count → re-derive with the draft-gate round
        // reset. No clean draft_gate comment here, so the count is unchanged (5).
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      EMPTY_REVIEW_STREAM_ENTRY,
    ]);

  assert.deepEqual(result, {
      ok: true,
      status: "no_changes_since_last_review",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "No changes since last Copilot review. --force-rerequest-review requires new commits on the PR head.",
      completedRounds: 5,
      maxRounds: 2,
    });
});

test("the draft-gate round reset sees a clean verdict that lives only in the review stream", async () => {
  // The round's verdict is a PR review, not an issue comment. Reading only the
  // issue-comment stream would miss the reset and refuse as cap-reached.
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"bbb2222","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"aaa1111"},"submittedAt":"2026-06-01T00:00:00Z"},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"aaa1111"},"submittedAt":"2026-06-02T00:00:00Z"}]}\n',
      },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: JSON.stringify([[{
          id: 4001,
          state: "COMMENTED",
          submitted_at: "2026-06-03T00:00:00Z",
          body: "Gate review: draft_gate\nReviewed head SHA: aaa1111\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
        }]]) + "\n",
      },
      { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: '{"headRefOid":"bbb2222","reviews":[]}\n' },
    ]);

  // Every counted review predates the review-stream draft-gate verdict, so the
  // reset drops the count below the cap and the request is placed.
  assert.equal(result.status, "requested");
});

// AC2 (#1326): at the round cap, a post-convergence head bump whose delta since the
// last Copilot-reviewed head is a PROVABLE pure doc/prose bump must NOT force a fresh
// blocking Copilot round — even under --force-rerequest-review with new commits.
const fiveCopilotReviewsAt = (headRefOid) =>
  `{"headRefOid":"${headRefOid}","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha1"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha2"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha3"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha4"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"sha5"}}]}\n`;

test("request-copilot-review --force-rerequest-review suppresses a pure doc/prose post-convergence bump instead of forcing a fresh round (#1326)", async () => {
  const { result, calls } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        // Delta since the last reviewed head (sha5) is docs-only → provably outside
        // Copilot's review surface → carry forward, no fresh round.
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stdout: JSON.stringify({ status: "ahead", files: [{ filename: "docs/guide.md", status: "modified" }, { filename: "README.md", status: "modified" }] }) + "\n",
      },
    ]);

  assert.equal(result.status, "suppressed_post_convergence_docs_only");
  assert.equal(result.completedRounds, 5);
  assert.equal(result.maxRounds, 2);
  // No fresh blocking round was placed: `gh pr edit --add-reviewer` never ran.
  assert.equal(calls.some((c) => c.args.includes("edit") && c.args.includes("--add-reviewer")), false);
});

test("request-copilot-review --force-rerequest-review re-opens the round when a doc bump also carries a code file (#1326 preserves the exception)", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        // Mixed delta: a code file alongside a doc file → touches Copilot's surface → re-open.
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stdout: JSON.stringify({ status: "ahead", files: [{ filename: "docs/guide.md", status: "modified" }, { filename: "src/foo.mjs", status: "modified" }] }) + "\n",
      },
      { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
    ]);

  assert.equal(result.status, "requested");
});

test("request-copilot-review --force-rerequest-review fails closed and re-opens when the compare page is at the 300-file cap (possibly truncated) (#1326)", async () => {
  // GitHub's compare API caps `files` at 300 per page. A list AT the cap may be
  // truncated: a code/test/config/CI file beyond position 300 would be invisible.
  // Here the first 300 entries are all docs — trusting this page would wrongly
  // suppress an unreviewed code change past the cap. The guard fails closed → re-open.
  const threeHundredDocs = Array.from({ length: 300 }, (_, i) => ({
    filename: `docs/page-${i}.md`,
    status: "modified",
  }));
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stdout: JSON.stringify({ status: "ahead", files: threeHundredDocs }) + "\n",
      },
      { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
    ]);

  assert.equal(result.status, "requested");
});

test("request-copilot-review --force-rerequest-review fails closed and re-opens when the delta contains a rename into a doc path (#1326)", async () => {
  // A code file renamed into a docs/-shaped destination path must NOT be misread as
  // pure-doc from its destination alone. Any rename/copy row fails the delta closed → re-open.
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stdout: JSON.stringify({ status: "ahead", files: [{ filename: "docs/x.md", status: "renamed" }] }) + "\n",
      },
      { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
    ]);

  assert.equal(result.status, "requested");
});

test("request-copilot-review --force-rerequest-review fails closed and re-opens when the compare call fails (#1326)", async () => {
  // A non-zero gh compare exit leaves the delta unknown — it must never be trusted
  // as pure-doc. The delta lookup returns null → re-open the round.
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stderr: "gh: Not Found\n",
        exitCode: 1,
      },
      { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
    ]);

  assert.equal(result.status, "requested");
});

test("request-copilot-review --force-rerequest-review fails closed and re-opens when the delta is not a provable linear advance (#1326)", async () => {
  const { result } = await runInProcess(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], [
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[[]]\n" },
      EMPTY_REVIEW_STREAM_ENTRY,
      {
        // History was rewritten (rebase/amend): base is not a strict ancestor →
        // status "diverged" → destination-path list is untrustworthy → fail closed → re-open.
        assertArgs: ["api", "repos/owner/repo/compare/sha5...newsha"],
        stdout: JSON.stringify({ status: "diverged", files: [{ filename: "docs/guide.md", status: "modified" }] }) + "\n",
      },
      { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"], stdout: fiveCopilotReviewsAt("newsha") },
    ]);

  assert.equal(result.status, "requested");
});

// Operator-authorized post-convergence suppression marker (#1441): withdraw-
// copilot-review-request.mjs writes this marker, scoped to an exact head, only
// after an explicit operator withdrawal on a head-advanced, provably docs-only
// delta. request-copilot-review.mjs must honor it BELOW the round cap too —
// unlike the AC2 carry-forward check above, which only applies at the cap —
// so a below-cap re-request cannot immediately re-strand the same head.
describe("operator-authorized post-convergence suppression marker (#1441)", () => {
  async function withTempCheckpointDir(fn) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "request-suppression-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("returns suppressed_post_convergence_docs_only BELOW the round cap when the marker matches the current head", async () => {
    await withTempCheckpointDir(async (checkpointDir) => {
      await writeSuppressionMarker(
        { repo: "owner/repo", pr: 17, headSha: "newsha", lastReviewedHeadSha: "oldsha", reason: "pure doc/prose bump", operatorReason: "Copilot declined a converged reword" },
        { checkpointDir },
      );
      const { runChild, calls } = makeGhMock([
        { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
        {
          assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
          stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
        },
        {
          assertArgs: ["api", "repos/owner/repo/compare/oldsha...newsha"],
          stdout: JSON.stringify({ status: "ahead", files: [{ filename: "docs/adr-0041.md", status: "modified" }] }) + "\n",
        },
      ], { repeatLastOnOverflow: true });
      const result = await performCopilotReviewRequest(
        { repo: "owner/repo", pr: 17, checkpointDir },
        { env: { GH_SEQUENCE_PATH: "1" }, ghCommand: "gh", runChild },
      );
      assert.equal(result.status, "suppressed_post_convergence_docs_only");
      assert.equal(calls.some((c) => c.args.includes("--add-reviewer")), false, "no fresh request should be placed");
    });
  });

  it("ignores a marker for a DIFFERENT head — falls through to a normal request", async () => {
    await withTempCheckpointDir(async (checkpointDir) => {
      await writeSuppressionMarker(
        { repo: "owner/repo", pr: 17, headSha: "stalesha", lastReviewedHeadSha: "oldsha", reason: "pure doc/prose bump" },
        { checkpointDir },
      );
      const { runChild, calls } = makeGhMock([
        { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
        {
          assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
          stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
        },
        { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
        { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
        {
          assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
          stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
        },
      ], { repeatLastOnOverflow: true });
      const result = await performCopilotReviewRequest(
        { repo: "owner/repo", pr: 17, checkpointDir },
        { env: { GH_SEQUENCE_PATH: "1" }, ghCommand: "gh", runChild },
      );
      assert.equal(result.status, "requested");
      assert.ok(calls.some((c) => c.args.includes("--add-reviewer")), "a real request must still be placed");
    });
  });

  it("re-verifies live rather than trusting the marker's stored reason — a delta that now touches Copilot's surface still re-requests", async () => {
    await withTempCheckpointDir(async (checkpointDir) => {
      await writeSuppressionMarker(
        { repo: "owner/repo", pr: 17, headSha: "newsha", lastReviewedHeadSha: "oldsha", reason: "pure doc/prose bump (stale claim)" },
        { checkpointDir },
      );
      const { runChild, calls } = makeGhMock([
        { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
        {
          assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
          stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
        },
        {
          // Live re-verification finds a code file in the delta — the marker's
          // stored claim is stale/wrong and must not be trusted blindly.
          assertArgs: ["api", "repos/owner/repo/compare/oldsha...newsha"],
          stdout: JSON.stringify({ status: "ahead", files: [{ filename: "src/foo.mjs", status: "modified" }] }) + "\n",
        },
        { assertArgs: ["pr", "edit", "17", "--repo", "owner/repo", "--add-reviewer", "@copilot"], stdout: "https://github.com/owner/repo/pull/17\n" },
        { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n' },
        {
          assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
          stdout: '{"headRefOid":"newsha","isDraft":false,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"oldsha"}}]}\n',
        },
      ], { repeatLastOnOverflow: true });
      const result = await performCopilotReviewRequest(
        { repo: "owner/repo", pr: 17, checkpointDir },
        { env: { GH_SEQUENCE_PATH: "1" }, ghCommand: "gh", runChild },
      );
      assert.equal(result.status, "requested");
      assert.ok(calls.some((c) => c.args.includes("--add-reviewer")), "a real request must still be placed");
    });
  });
});
