import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initSizeBudgetFixtureRepo, repeatedLinesContent, runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

// A stub evaluatePrSizeBudget that always passes — for tests exercising
// OTHER readyForReview() logic (board sync, etc.) via direct function calls,
// so they don't need a real git fixture just to clear the size-budget check.
function passingSizeBudget() {
  return { ok: true, outcome: "pass", wholeLogicLoc: 0, t1SliceLoc: 0, reasons: [], waiver: { requested: false, approvedBy: null, t1Valid: false, defaultValid: false } };
}

import { parseReadyForReviewCliArgs, readyForReview } from "../../scripts/github/ready-for-review.mjs";

const scriptPath = path.resolve("scripts/github/ready-for-review.mjs");
const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries, options = {}) {
  return writeGhStubHelper(tempDir, entries, {
    repeatLastOnOverflow: true,
    logCalls: true,
    ...options,
  });
}

async function readGhCalls(logPath) {
  const lines = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}
// #1585: fetchDraftGateEvidence now also fetches the authenticated login
// (api user) + review threads (graphql reviewThreads) to assert 0 unresolved
// gate-authored threads. listPrReviews (fail-open) runs between the
// issue-comments read and these calls, so a stub array that has NO explicit
// reviews entry needs an empty-reviews filler (gateCloseStubs); one that
// already stubs reviews appends only the login + threads (gateThreadLoginStubs).
function gateThreadLoginStubs({ login = "pi-local-run", threads = [] } = {}) {
  return [
    { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login })}\n` },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } })}\n`,
    },
  ];
}
function gateCloseStubs(opts = {}) {
  return [{ stdout: "[]" }, ...gateThreadLoginStubs(opts)];
}


// --- parseReadyForReviewCliArgs unit tests ---

test("parseReadyForReviewCliArgs requires --repo and --pr", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs([]),
    /requires --repo and --pr/,
  );
});

test("parseReadyForReviewCliArgs requires --repo value", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--pr", "17"]),
    /requires --repo and --pr/,
  );
});

test("parseReadyForReviewCliArgs requires --pr value", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "owner/repo"]),
    /requires --repo and --pr/,
  );
});

test("parseReadyForReviewCliArgs parses valid repo and pr", () => {
  const result = parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "42"]);
  assert.equal(result.repo, "owner/repo");
  assert.equal(result.pr, 42);
});

test("parseReadyForReviewCliArgs rejects invalid repo slug", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "invalid", "--pr", "1"]),
    /must match.*owner.*name/i,
  );
});

test("parseReadyForReviewCliArgs rejects non-numeric --pr", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "abc"]),
    /positive integer/,
  );
});

test("parseReadyForReviewCliArgs rejects zero --pr", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "0"]),
    /positive integer/,
  );
});

test("parseReadyForReviewCliArgs --help returns help option", () => {
  const result = parseReadyForReviewCliArgs(["--help"]);
  assert.equal(result.help, true);
});

test("parseReadyForReviewCliArgs -h returns help option", () => {
  const result = parseReadyForReviewCliArgs(["-h"]);
  assert.equal(result.help, true);
});

test("parseReadyForReviewCliArgs rejects unknown flag", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "1", "--unknown"]),
    /Unknown argument/,
  );
});

// --- integration tests ---

test("--help prints usage to stdout", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ready-for-review\.mjs/);
  assert.match(result.stdout, /gate-evidence/);
});

test("rejects --repo without value", async () => {
  const result = await runNode(["--repo"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing value for --repo/i);
});

test("rejects --pr without value", async () => {
  const result = await runNode(["--repo", "owner/repo", "--pr"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing value for --pr/i);
});

test("fails when PR is not in draft state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-not-draft-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: false,
                headRefOid: "abc123def456",
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /not in draft state/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fails when draft_gate evidence is missing (fail-closed)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-no-gate-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: "abc123def456",
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      { stdout: "[]" }, // no PR comments = no gate evidence
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no visible clean draft_gate/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fails when CI is blocked", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-ci-blocked-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: "abc123def456",
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "failure", bucket: "fail" },
        ]),
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocking CI/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("succeeds when draft gate evidence exists and CI is green", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-success-"));

  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: headSha,
                baseRefName: baseBranch,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      {
        stdout: JSON.stringify([
          {
            body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
          {
            body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
            id: 102,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-102",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
        ]),
      },
      ...gateCloseStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0, `Expected exit code 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, `Script returned ok=false: ${result.stderr}`);
    assert.equal(output.action, "marked_ready");
    assert.equal(output.pr, 17);
    assert.equal(output.sizeBudget.outcome, "pass");

    // Verify gh pr ready was called
    const calls = await readGhCalls(ghLogPath);
    const readyCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready");
    assert.ok(readyCall, `gh pr ready should have been called. Calls: ${JSON.stringify(calls)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("succeeds when the clean draft verdict lives only in the review stream (single-surface round)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-review-surface-"));

  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: headSha,
                baseRefName: baseBranch,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      { stdout: "[]" }, // issue comments: no verdict here
      {
        stdout: JSON.stringify([
          {
            body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
            id: 4001,
            state: "COMMENTED",
            submitted_at: "2026-06-05T00:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-4001",
          },
        ]),
      },
      ...gateThreadLoginStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0, `Expected exit code 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, `Script returned ok=false: ${result.stderr}`);
    assert.equal(output.action, "marked_ready");
    const calls = await readGhCalls(ghLogPath);
    const readyCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready");
    assert.ok(readyCall, `gh pr ready should have been called. Calls: ${JSON.stringify(calls)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("still marks ready off an issue-comment verdict when the reviews fetch fails (fail-open)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-reviews-fetch-fail-"));

  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: headSha,
                baseRefName: baseBranch,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      {
        stdout: JSON.stringify([
          {
            body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
        ]),
      },
      { stdout: "", stderr: "HTTP 500", exitCode: 1 }, // reviews fetch fails
      ...gateThreadLoginStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0, `Expected exit code 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.action, "marked_ready");
    const calls = await readGhCalls(ghLogPath);
    assert.ok(calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses to mark ready when PR title contains a WIP marker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-wip-title-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: "abc123def456",
                state: "OPEN",
                mergeStateStatus: "CLEAN",
                title: "[WIP] add authentication flow",
              },
            },
          },
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /title contains merge-blocking marker/i);
    assert.match(result.stderr, /WIP/);

    // gh pr ready must NOT have been called.
    const calls = await readGhCalls(ghLogPath);
    const readyCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready");
    assert.ok(!readyCall, `gh pr ready should not be called for a WIP title. Calls: ${JSON.stringify(calls)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("proceeds when PR title is clean", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-clean-title-"));

  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: headSha,
                baseRefName: baseBranch,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
                title: "Add user authentication flow",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      {
        stdout: JSON.stringify([
          {
            body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
        ]),
      },
      ...gateCloseStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0, `Expected exit code 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.action, "marked_ready");

    const calls = await readGhCalls(ghLogPath);
    const readyCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready");
    assert.ok(readyCall, "gh pr ready should have been called for a clean title");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("--skip-gate-check allows transition without gate evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-skip-gate-"));

  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: "abc123def456",
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      { stdout: "" }, // no gate evidence check (--skip-gate-check)
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env },
    );

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.gateCheckSkipped, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("built-in In-Progress board sync runs after gh pr ready and is NON-FATAL (#1069)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-board-sync-"));

  try {
    // No .devloops in tempDir → board not configured → syncBoardStatus is a
    // clean fail-open skip. Running with cwd: tempDir keeps the board sync from
    // shelling out to gh, but proves the tail runs and marking ready still wins.
    // The real size-budget fixture repo lives at the same cwd (also used as
    // the size-budget diff's local checkout).
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: headSha,
                baseRefName: baseBranch,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
                closingIssuesReferences: { nodes: [{ number: 55 }] },
              },
            },
          },
        }),
      },
      { stdout: JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]) },
      {
        stdout: JSON.stringify([
          {
            body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
        ]),
      },
      ...gateCloseStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.action, "marked_ready");
    // Board sync tail ran and, with no board configured, reported a skip.
    assert.ok(Array.isArray(output.boardSync), "boardSync should be present");
    assert.ok(output.boardSync.length >= 1);
    assert.ok(output.boardSync.every((r) => r.ok === true && r.skipped === true));

    // The closingIssuesReferences selection is issued as part of the PR view query.
    const calls = await readGhCalls(ghLogPath);
    const closingQuery = calls.find(
      (c) => Array.isArray(c) && c.some((a) => typeof a === "string" && a.includes("closingIssuesReferences")),
    );
    assert.ok(closingQuery, `PR view query should request closingIssuesReferences. Calls: ${JSON.stringify(calls)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- readyForReview board-sync tail: injected syncBoardStatus (#1069) ---
//
// Drive readyForReview directly with the gh stub (via injected env/ghCommand)
// plus an injected fake syncBoardStatus so the board tail is observable: the
// move target (closing issue vs PR) and the NON-FATAL swallow are verified.
function preReadyGhStub(tempDir, { closingIssueNodes = [] } = {}) {
  return writeGhStub(tempDir, [
    {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_abc123",
              isDraft: true,
              headRefOid: "abc123def456",
              baseRefName: "main",
              state: "OPEN",
              mergeStateStatus: "CLEAN",
              title: "Add feature",
              closingIssuesReferences: { nodes: closingIssueNodes },
            },
          },
        },
      }),
    },
    { stdout: JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]) },
    {
      stdout: JSON.stringify([
        {
          body: "Gate review: draft_gate\nReviewed head SHA: abc123def456\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
          id: 101,
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
          created_at: "2026-06-05T00:00:00Z",
          updated_at: "2026-06-05T00:00:00Z",
        },
      ]),
    },
    ...gateCloseStubs(),
    { stdout: "" }, // gh pr ready
  ]);
}

test("board tail targets the closing issue (not the PR) when closingIssues present (#1069)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-board-target-"));
  try {
    const { env } = await preReadyGhStub(tempDir, { closingIssueNodes: [{ number: 55 }] });
    const syncCalls = [];
    const fakeSync = async (repo, repoRoot, target, column) => {
      syncCalls.push({ repo, target, column });
      return { ok: true, skipped: false };
    };
    const result = await readyForReview(
      { repo: "owner/repo", pr: 17 },
      { env, repoRoot: tempDir, syncBoardStatus: fakeSync, evaluatePrSizeBudget: passingSizeBudget },
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, "marked_ready");
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].target, 55, "board move should target the closing issue #55, not the PR");
    assert.equal(syncCalls[0].column, "In Progress");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("board tail falls back to the PR number when closingIssues is empty (#1069)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-board-fallback-"));
  try {
    const { env } = await preReadyGhStub(tempDir, { closingIssueNodes: [] });
    const syncCalls = [];
    const fakeSync = async (repo, repoRoot, target, column) => {
      syncCalls.push({ target, column });
      return { ok: true, skipped: false };
    };
    const result = await readyForReview(
      { repo: "owner/repo", pr: 17 },
      { env, repoRoot: tempDir, syncBoardStatus: fakeSync, evaluatePrSizeBudget: passingSizeBudget },
    );
    assert.equal(result.action, "marked_ready");
    assert.equal(syncCalls.length, 1);
    assert.equal(syncCalls[0].target, 17, "with no closing issue the board move targets the PR number");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("board tail is NON-FATAL: a throwing syncBoardStatus never fails marking ready (#1069)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-board-throws-"));
  try {
    const { env } = await preReadyGhStub(tempDir, { closingIssueNodes: [{ number: 55 }] });
    const fakeSync = async () => { throw new Error("board exploded"); };
    const result = await readyForReview(
      { repo: "owner/repo", pr: 17 },
      { env, repoRoot: tempDir, syncBoardStatus: fakeSync, evaluatePrSizeBudget: passingSizeBudget },
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, "marked_ready");
    // The throw is swallowed and recorded as a skip/failure entry.
    assert.ok(Array.isArray(result.boardSync));
    assert.ok(result.boardSync.length >= 1);
    assert.ok(result.boardSync.some((r) => r.skipped === true && /board exploded/.test(r.reason ?? "")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fails when draft_gate marker does not match current head SHA", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-mismatch-head-"));

  try {
    // PR head is a NEW commit pushed after the gate was run
    const currentHeadSha = "bbb456789012";
    // Gate evidence was recorded against the OLD commit
    const gateHeadSha = "abc123def456";
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: currentHeadSha,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      {
        stdout: JSON.stringify([
          {
            body: "Gate review: draft_gate\nReviewed head SHA: " + gateHeadSha + "\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
        ]),
      },
      ...gateCloseStubs(),
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env },
    );

    assert.equal(result.code, 1);
    // Gate evidence exists but marker head SHA differs from PR head
    // Marker head SHA differs from PR head → effectiveHeadClean is false.
    // Error differentiates between "mismatch" (marker visible with different head)
    // and "missing/incomplete" (no marker at all for current head).
    assert.match(result.stderr, /missing or incomplete|does not match current head/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("succeeds when gate comment has abbreviated SHA matching full PR head SHA", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-abbrev-sha-"));

  try {
    // GitHub reports full 40-char SHA; gate comment may record abbreviated 7+ char SHA
    const { headSha: fullHeadSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const abbrevHeadSha = fullHeadSha.slice(0, 7);
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: fullHeadSha,
                baseRefName: baseBranch,
                state: "OPEN",
                mergeStateStatus: "CLEAN",
              },
            },
          },
        }),
      },
      {
        stdout: JSON.stringify([
          { name: "test", state: "success", bucket: "pass" },
        ]),
      },
      {
        stdout: JSON.stringify([
          {
            body: "Gate review: draft_gate\nReviewed head SHA: " + abbrevHeadSha + "\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
        ]),
      },
      ...gateCloseStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.action, "marked_ready");
    assert.equal(output.draftGateSatisfied, true);

    const calls = await readGhCalls(ghLogPath);
    const readyCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready");
    assert.ok(readyCall, "gh pr ready should have been called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// #1585: ready-for-review backstop — 0 unresolved gate-authored threads
// ---------------------------------------------------------------------------

import { buildFindingMarker } from "../../scripts/github/_gate-finding-surface.mjs";

function reviewThreadsResponse(nodes) {
  return `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } })}\n`;
}

function niceToHaveThreadNode() {
  const marker = buildFindingMarker({ fp: "f".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 });
  return {
    id: "THREAD_NTH",
    isResolved: false,
    isOutdated: false,
    path: "src/naming.mjs",
    line: 4,
    comments: { nodes: [{ id: "gid-9001", databaseId: 9001, body: `${marker}\n**nice-to-have** (\`naming\`): casing nit`, author: { login: "pi-local-run", __typename: "User" } }] },
  };
}

test("#1585: ready-for-review refuses to mark ready when an unresolved gate-authored thread remains (the #1584 bug, caught at the ready boundary)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-1585-threads-"));
  try {
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      { stdout: JSON.stringify({ data: { repository: { pullRequest: { id: "PR_abc123", isDraft: true, headRefOid: "abc123def456", state: "OPEN", mergeStateStatus: "CLEAN" } } } }) },
      { stdout: JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]) },
      { stdout: JSON.stringify([{ body: "Gate review: draft_gate\nReviewed head SHA: abc123def456\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review", id: 101, html_url: "x", created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-05T00:00:00Z" }]) },
      { stdout: "[]" }, // listPrReviews (fail-open)
      { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "pi-local-run" })}\n` },
      { assertArgs: ["api", "graphql"], assertArgContains: ["reviewThreads"], stdout: reviewThreadsResponse([niceToHaveThreadNode()]) },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /unresolved gate-authored review thread/i);
    // gh pr ready must NOT have been called.
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"), "gh pr ready should not be called when threads remain unresolved");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("#1585: ready-for-review fails closed (-1) when review-thread state is unreadable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-1585-unreadable-"));
  try {
    const { env } = await writeGhStub(tempDir, [
      { stdout: JSON.stringify({ data: { repository: { pullRequest: { id: "PR_abc123", isDraft: true, headRefOid: "abc123def456", state: "OPEN", mergeStateStatus: "CLEAN" } } } }) },
      { stdout: JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]) },
      { stdout: JSON.stringify([{ body: "Gate review: draft_gate\nReviewed head SHA: abc123def456\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review", id: 101, html_url: "x", created_at: "2026-06-05T00:00:00Z", updated_at: "2026-06-05T00:00:00Z" }]) },
      { stdout: "[]" },
      { assertArgs: ["api", "user"], stdout: "", code: 1, stderr: "HTTP 500" }, // login read fails → -1
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /could not read review-thread state/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fail-closed PR size budget (gates.size) — phase 2 wiring: real git diff +
// config, one gh stub sequence shared by every scenario below (PR view, CI,
// draft_gate evidence, gate-close), so only the size-budget outcome differs
// per test. gh pr ready and gh pr comment are appended per-test depending on
// whether the size check is expected to let the draft exit proceed.
// ---------------------------------------------------------------------------

function sizeBudgetGhStubEntries({ headSha, baseBranch, extraEntries = [] }) {
  return [
    {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_abc123",
              isDraft: true,
              headRefOid: headSha,
              baseRefName: baseBranch,
              state: "OPEN",
              mergeStateStatus: "CLEAN",
            },
          },
        },
      }),
    },
    { stdout: JSON.stringify([{ name: "test", state: "success", bucket: "pass" }]) },
    {
      stdout: JSON.stringify([
        {
          body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
          id: 101,
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
          created_at: "2026-06-05T00:00:00Z",
          updated_at: "2026-06-05T00:00:00Z",
        },
      ]),
    },
    ...gateCloseStubs(),
    ...extraEntries,
  ];
}

test("size budget: escalate outcome allows ready and records the escalation signal on the result", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-escalate-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        softLoc: 2\n",
      headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({
      headSha,
      baseBranch,
      extraEntries: [{ stdout: "" }], // gh pr ready
    }));

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.sizeBudget.outcome, "escalate");
    const calls = await readGhCalls(ghLogPath);
    assert.ok(calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"), "gh pr ready should still be called on escalate");
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "comment"), "no waiver record should be posted when no waiver was requested");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: a waiver-eligible block (default.waiverLoc) with no waiver requested prevents the draft exit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-block-nowaiver-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        waiverLoc: 2\n",
      headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({ headSha, baseBranch }));

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocked by size budget/i);
    assert.match(result.stderr, /waiverLoc/);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called on a block");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: a valid default-tier waiver allows the same over-waiverLoc PR through and posts a minimal waiver record", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-waived-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        waiverLoc: 2\n",
      headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({
      headSha,
      baseBranch,
      extraEntries: [{ stdout: "" }, { stdout: "" }], // gh pr comment (waiver record) + gh pr ready
    }));

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--waive-size-budget", "--reason", "reviewed together as one atomic rename"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.notEqual(output.sizeBudget.outcome, "block");
    assert.equal(output.sizeBudget.waiver.defaultValid, true);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"));
    const commentCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "comment");
    assert.ok(commentCall, "a waiver record comment should have been posted");
    const body = commentCall[commentCall.indexOf("--body") + 1];
    assert.match(body, /Size-budget waiver granted/);
    assert.match(body, /reviewed together as one atomic rename/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: an unwaivable block (absoluteHardLoc) is never bypassed by --waive-size-budget", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-unwaivable-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: "version: 1\ngates:\n  size:\n    absoluteHardLoc: 2\n",
      headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({ headSha, baseBranch }));

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--waive-size-budget", "--reason", "please let this through", "--approved-by", "someone"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocked by size budget/i);
    assert.match(result.stderr, /absoluteHardLoc/);
    assert.match(result.stderr, /no waiver possible/i);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && (c[1] === "ready" || c[1] === "comment")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: a T1-slice waiver without --approved-by is refused", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-t1-noapprover-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: 'version: 1\ngates:\n  size:\n    tiers:\n      t1:\n        patterns:\n          - "src/money/**"\n        sliceHardLoc: 2\n',
      headFiles: [{ path: "src/money/pay.mjs", content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({ headSha, baseBranch }));

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--waive-size-budget", "--reason", "money-slice rename"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocked by size budget/i);
    assert.match(result.stderr, /sliceHardLoc/);
    assert.match(result.stderr, /approved-by/i);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && (c[1] === "ready" || c[1] === "comment")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: a T1-slice waiver WITH --approved-by is honored and names the approver in the record", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-t1-approved-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: 'version: 1\ngates:\n  size:\n    tiers:\n      t1:\n        patterns:\n          - "src/money/**"\n        sliceHardLoc: 2\n',
      headFiles: [{ path: "src/money/pay.mjs", content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({
      headSha,
      baseBranch,
      extraEntries: [{ stdout: "" }, { stdout: "" }], // gh pr comment (waiver record) + gh pr ready
    }));

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--waive-size-budget", "--reason", "money-slice rename", "--approved-by", "jane-reviewer"],
      { env, cwd: tempDir },
    );

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.sizeBudget.waiver.t1Valid, true);
    const calls = await readGhCalls(ghLogPath);
    const commentCall = calls.find((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "comment");
    assert.ok(commentCall, "a waiver record comment should have been posted");
    const body = commentCall[commentCall.indexOf("--body") + 1];
    assert.match(body, /jane-reviewer/);
    assert.match(body, /\*\*tier:\*\* t1/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: non-empty config errors[] block the draft exit fail-closed", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-configerr-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: "gates:\n  size: [\n", // malformed — invalid YAML/JSON
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({ headSha, baseBranch }));

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /blocked by size budget/i);
    assert.match(result.stderr, /config errors/i);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: fails closed when the PR has no resolvable baseRefName (guard throws before the diff)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-nobaseref-"));
  try {
    const headSha = "abc123def456";
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({ headSha, baseBranch: undefined }));

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Could not resolve PR #17 base branch/i);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called when baseRefName cannot be resolved");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("size budget: fails closed when origin/<base> is not locally resolvable (git diff failure)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-size-badbase-"));
  try {
    const { headSha } = await initSizeBudgetFixtureRepo(tempDir);
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({ headSha, baseBranch: "totally-unresolvable-base" }));

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /git diff against --base/i);
    const calls = await readGhCalls(ghLogPath);
    assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called when the base ref cannot be resolved");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseReadyForReviewCliArgs requires --reason when --waive-size-budget is set", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "1", "--waive-size-budget"]),
    /--waive-size-budget requires --reason/,
  );
});
