import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/github/stage-reviewer-draft.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

const writeJson = writeJsonHelper;

const writeGhStub = (tempDir, entries) => writeGhStubHelper(tempDir, entries, { logCalls: true });

test("stage-reviewer-draft posts a deterministic pending review and writes local state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-draft-"));

  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    const localStatePath = path.join(tempDir, "local-state.json");

    await writeJson(reviewFile, {
      headSha: "abc123",
      verdict: "REQUEST_CHANGES",
      totalFindings: 2,
      runsMerged: 2,
      inlineComments: [
        { path: "src/app.ts", line: 10, message: "Handle null" },
      ],
      summaryFindings: [
        { message: "Consider the stale draft-review cleanup path", severity: "low" },
      ],
    });

    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        // Exact full-payload match: subsumes the old field-by-field includes and the
        // '"event"' exclusion (a pending review must not carry an event field).
        assertStdinIncludes: [
          JSON.stringify({
            commit_id: "abc123",
            body: [
              "Reviewer-loop draft verdict: REQUEST_CHANGES",
              "Total findings: 2",
              "Review runs merged: 2",
              "",
              "Summary findings:",
              "- [low] Consider the stale draft-review cleanup path",
              "",
            ].join("\n"),
            comments: [
              { path: "src/app.ts", line: 10, body: "Handle null", side: "RIGHT" },
            ],
          }),
        ],
        stdout: '{"id":444,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-444","state":"PENDING","commit_id":"abc123"}\n',
      },
    ]);

    const result = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--review-file",
      reviewFile,
      "--local-state-output",
      localStatePath,
    ], { env: gh.env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      pr: 17,
      reviewId: 444,
      reviewUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-444",
      reviewState: "PENDING",
      commitSha: "abc123",
      localStatePath,
    });

    assert.deepEqual(JSON.parse(await readFile(localStatePath, "utf8")), {
      draftReviewPrepared: true,
      draftReviewPosted: true,
      draftReviewId: 444,
      draftReviewUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-444",
      draftReviewCommitSha: "abc123",
      draftReviewNotificationStatus: "none",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stage-reviewer-draft merges into an existing local state file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-state-merge-"));

  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    const localStatePath = path.join(tempDir, "local-state.json");

    await writeJson(reviewFile, {
      headSha: "abc123",
      verdict: "COMMENT",
      totalFindings: 1,
      runsMerged: 1,
      inlineComments: [],
      summaryFindings: [{ message: "Add reviewer replay docs", severity: "note" }],
    });
    await writeJson(localStatePath, { localPlanningStatus: "complete" });

    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":445,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-445","state":"PENDING","commit_id":"abc123"}\n',
      },
    ]);

    const result = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--review-file",
      reviewFile,
      "--local-state-output",
      localStatePath,
    ], { env: gh.env });

    assert.equal(result.code, 0);

    assert.deepEqual(JSON.parse(await readFile(localStatePath, "utf8")), {
      localPlanningStatus: "complete",
      draftReviewPrepared: true,
      draftReviewPosted: true,
      draftReviewId: 445,
      draftReviewUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-445",
      draftReviewCommitSha: "abc123",
      draftReviewNotificationStatus: "none",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("stage-reviewer-draft reports localStatePath as null when no output path is requested", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-null-local-state-"));

  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    await writeJson(reviewFile, {
      headSha: "abc123",
      verdict: "COMMENT",
      inlineComments: [],
      summaryFindings: [],
    });

    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":446,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-446","state":"PENDING","commit_id":"abc123"}\n',
      },
    ]);

    const result = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--review-file",
      reviewFile,
    ], { env: gh.env });

    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).localStatePath, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stage-reviewer-draft rejects malformed arguments and missing headSha deterministically", async () => {
  const missing = await runNode(["--repo", "owner/repo"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, "");
  assert.deepEqual(JSON.parse(missing.stderr), {
    ok: false,
    error: "Staging a reviewer draft requires --repo <owner/name>, --pr <number>, and --review-file <path>",
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-bad-review-"));
  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    await writeJson(reviewFile, {
      verdict: "COMMENT",
      inlineComments: [],
      summaryFindings: [],
    });

    const bad = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--review-file",
      reviewFile,
    ]);
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, "");
    assert.deepEqual(JSON.parse(bad.stderr), {
      ok: false,
      error: "Merged review payload must include headSha so the pending review is pinned to a commit",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("stage-reviewer-draft reports gh failures deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-gh-fail-"));

  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    await writeJson(reviewFile, {
      headSha: "abc123",
      verdict: "COMMENT",
      inlineComments: [],
      summaryFindings: [],
    });

    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stderr: "boom\n",
        exitCode: 1,
      },
    ]);

    const result = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--review-file",
      reviewFile,
    ], { env: gh.env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "gh command failed: boom",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("stage-reviewer-draft rejects malformed success payloads from gh deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-bad-success-"));

  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    await writeJson(reviewFile, {
      headSha: "abc123",
      verdict: "COMMENT",
      inlineComments: [],
      summaryFindings: [],
    });

    const gh = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":447,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-447","state":"COMMENTED","commit_id":"abc123"}\n',
      },
    ]);

    const result = await runNode([
      "--repo",
      "owner/repo",
      "--pr",
      "17",
      "--review-file",
      reviewFile,
    ], { env: gh.env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      ok: false,
      error: "Draft review payload from gh did not include id, url, PENDING state, and commit_id",
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("#1731: stage-reviewer-draft refuses a review body containing a raw issue/PR id (guard fires before gh POST)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stage-reviewer-guard-"));
  try {
    const reviewFile = path.join(tempDir, "merged-review.json");
    const localStatePath = path.join(tempDir, "local-state.json");

    // The rendered body will carry the raw `#1731` from the summary finding —
    // postDraftReview's guard must refuse BEFORE any gh POST.
    await writeJson(reviewFile, {
      headSha: "abc123",
      verdict: "COMMENT",
      totalFindings: 1,
      runsMerged: 1,
      inlineComments: [],
      summaryFindings: [{ message: "See tracked issue #1731 for the follow-up", severity: "low" }],
    });

    // Zero gh entries: the guard must throw before runChild is ever invoked.
    const gh = await writeGhStub(tempDir, []);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17",
      "--review-file", reviewFile,
      "--local-state-output", localStatePath,
    ], { env: gh.env });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /comment-id-guard refused to emit staged reviewer-draft review body/);
    // The guard fired before the POST, so no local "posted" state was written.
    await assert.rejects(() => readFile(localStatePath, "utf8"), /ENOENT/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
