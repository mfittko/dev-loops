import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/github/request-copilot-review.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true });
  return env;
}

test("request-copilot-review requests Copilot deterministically and verifies via requested_reviewers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-review-"));

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review recognizes Copilot under the requested reviewer login returned by GitHub", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-login-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review reports already-requested without mutating PR state again", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-already-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"Copilot"}],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[{"id":"r-1","author":{"login":"copilot-pull-request-reviewer[bot]"}}]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review suppresses same-head clean re-request by default", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-suppressed-same-head-clean-"));

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "suppressed_same_head_clean",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      sameHeadCleanConverged: true,
      detail: "Current head already has a clean submitted Copilot review; same-head clean-convergence suppression is always enforced.",
    });
    // 3 gh calls: preflight requested_reviewers + expanded PR view, then only review threads for clean-convergence proof.
    assert.equal(Number((await readFile(env.GH_COUNTER_PATH, "utf8")).trim()), 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("request-copilot-review treats pending review as already-requested even when a submitted current-head review exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-pending-with-submitted-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"abc123","reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}},{"id":"r-2","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}}]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
    assert.equal(Number((await readFile(env.GH_COUNTER_PATH, "utf8")).trim()), 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review treats a pending Copilot review as already-requested before mutating", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-pending-before-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"headRefOid":"abc123","reviews":[{"id":"r-1","state":"PENDING","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc123"}}]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review accepts --force-rerequest-review as a valid flag", async () => {
  // With cap not reached (0 reviews, default cap 5): flag is a no-op; normal flow applies.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-force-noop-"));

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "requested");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review accepts an immediate Copilot review as proof the request succeeded", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-immediate-review-"));

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
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"reviews":[{"id":"r-2","author":{"login":"copilot-pull-request-reviewer[bot]"}}]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review normalizes known unrequestable/unavailable failures", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-unavailable-"));

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "unavailable",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "gh: Reviews may only be requested from collaborators.",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review returns already-requested when 422 but Copilot is in requested_reviewers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-422-in-progress-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review returns already-requested when 422 but Copilot has a pending review", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-422-pending-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "already-requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review does not treat a stale pending Copilot review as already-requested before mutating", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-stale-pending-before-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review ignores a stale pending Copilot review after 422 and stays unavailable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-stale-pending-422-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "unavailable",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "gh: Reviews may only be requested from collaborators.",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
  assert.equal(typeof missingPrErr.usage, "string");
  assert(missingPrErr.usage.length > 0);

  const zeroPr = await runNode(["--repo", "owner/repo", "--pr", "0"]);
  assert.equal(zeroPr.code, 1);
  assert.equal(zeroPr.stdout, "");
  const zeroPrErr = JSON.parse(zeroPr.stderr);
  assert.equal(zeroPrErr.ok, false);
  assert.equal(zeroPrErr.error, "--pr must be a positive integer");
  assert.equal(typeof zeroPrErr.usage, "string");
  assert(zeroPrErr.usage.length > 0);

  const badRepo = await runNode(["--repo", " owner / repo ", "--pr", "17"]);
  assert.equal(badRepo.code, 1);
  assert.equal(badRepo.stdout, "");
  const badRepoErr = JSON.parse(badRepo.stderr);
  assert.equal(badRepoErr.ok, false);
  assert.equal(badRepoErr.error, "--repo must match <owner/name>");
  assert.equal(typeof badRepoErr.usage, "string");
  assert(badRepoErr.usage.length > 0);

  const unknown = await runNode(["--repo", "owner/repo", "--pr", "17", "--wat"]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  const unknownErr = JSON.parse(unknown.stderr);
  assert.equal(unknownErr.ok, false);
  assert.equal(unknownErr.error, "Unknown argument: --wat");
  assert.equal(typeof unknownErr.usage, "string");
  assert(unknownErr.usage.length > 0);

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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-blocked-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({ id: 1001, body: "@copilot Please re-review this PR", user: { login: "human-dev" } }) + "\n",
      },
    ]);

    const { checkForCopilotComments } = await import("../../scripts/github/request-copilot-review.mjs");
    const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { env });

    assert.equal(result.blocked, true);
    assert.deepEqual(result.violationCommentIds, [1001]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("checkForCopilotComments passes when no @copilot comments found", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-noblock-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({ id: 1001, body: "LGTM!", user: { login: "human-dev" } }) + "\n",
      },
    ]);

    const { checkForCopilotComments } = await import("../../scripts/github/request-copilot-review.mjs");
    const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { env });

    assert.equal(result.blocked, false);
    assert.deepEqual(result.violationCommentIds, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("checkForCopilotComments ignores @copilot in Copilot-authored comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-copilot-author-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: JSON.stringify({ id: 2001, body: "I see you mentioned @copilot in your message", user: { login: "copilot-pull-request-reviewer[bot]" } }) + "\n",
      },
    ]);

    const { checkForCopilotComments } = await import("../../scripts/github/request-copilot-review.mjs");
    const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { env });

    assert.equal(result.blocked, false);
    assert.deepEqual(result.violationCommentIds, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("checkForCopilotComments reports all violation comments when multiple found", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-multiviolation-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "--paginate", "--jq", ".[]"],
        stdout: [JSON.stringify({ id: 3001, body: "@copilot review please", user: { login: "dev-a" } }), JSON.stringify({ id: 3002, body: "/copilot re-review", user: { login: "dev-b" } })].join("\n") + "\n",
      },
    ]);

    const { checkForCopilotComments } = await import("../../scripts/github/request-copilot-review.mjs");
    const result = await checkForCopilotComments({ repo: "owner/repo", pr: 17 }, { env });

    assert.equal(result.blocked, true);
    assert.deepEqual(result.violationCommentIds, [3001, 3002]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review blocks request when PR is in draft state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-draft-block-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":true,"state":"OPEN","number":17,"reviews":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "suppressed_draft",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "PR is in draft state; review requests are blocked until the PR is marked ready for review.",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review does not block request when PR is not draft", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-draft-ok-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).status, "requested");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review draft check takes precedence over round cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-draft-roundcap-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid,isDraft,state,number,reviews,statusCheckRollup"],
        stdout: '{"isDraft":true,"state":"OPEN","number":17,"reviews":[{"id":"r-1","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"abc"}},{"id":"r-2","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"def"}},{"id":"r-3","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"ghi"}},{"id":"r-4","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"jkl"}},{"id":"r-5","state":"COMMENTED","author":{"login":"copilot-pull-request-reviewer[bot]"},"commit":{"oid":"mno"}}]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "suppressed_draft");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review returns round_cap_reached when cap is exhausted without force flag", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-roundcap-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

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
      "  stopOnLowSignal: true",
      "  lowSignalRoundThreshold: 1",
      "  lowSignalMaxComments: 1",
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
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-roundcap-no-auto-rerequest-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    // At the cap, a head advance no longer re-opens an automatic Copilot re-request.
    // The round cap is respected; the pre_approval_gate reviews the current head.
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.status, "round_cap_reached");
    assert.equal(output.reviewer, "Copilot");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review --force-rerequest-review allows re-request when cap reached and new commits exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-force-newcommits-"));

  try {
    const env = await writeGhStub(tempDir, [
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "requested",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request-copilot-review --force-rerequest-review refuses when cap reached and no new commits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-request-copilot-force-nochange-"));

  try {
    const env = await writeGhStub(tempDir, [
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
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--force-rerequest-review"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      status: "no_changes_since_last_review",
      repo: "owner/repo",
      pr: 17,
      reviewer: "Copilot",
      detail: "No changes since last Copilot review. --force-rerequest-review requires new commits on the PR head.",
      completedRounds: 5,
      maxRounds: 2,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
