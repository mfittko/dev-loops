import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

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
      {
        stdout: JSON.stringify([
          {
            body: "Gate review: draft_gate\nReviewed head SHA: abc123def456\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
            id: 101,
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            created_at: "2026-06-05T00:00:00Z",
            updated_at: "2026-06-05T00:00:00Z",
          },
          {
            body: "Gate review: draft_gate\nReviewed head SHA: abc123def456\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
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
      { env },
    );

    assert.equal(result.code, 0, `Expected exit code 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true, `Script returned ok=false: ${result.stderr}`);
    assert.equal(output.action, "marked_ready");
    assert.equal(output.pr, 17);

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
      { stdout: "[]" }, // issue comments: no verdict here
      {
        stdout: JSON.stringify([
          {
            body: "Gate review: draft_gate\nReviewed head SHA: abc123def456\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review",
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
      { env },
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
      { stdout: "", stderr: "HTTP 500", exitCode: 1 }, // reviews fetch fails
      ...gateThreadLoginStubs(),
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17"],
      { env },
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

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
      { env, repoRoot: tempDir, syncBoardStatus: fakeSync },
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
      { env, repoRoot: tempDir, syncBoardStatus: fakeSync },
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
      { env, repoRoot: tempDir, syncBoardStatus: fakeSync },
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
    const fullHeadSha = "abc123def456789012345678901234567890abcd";
    const abbrevHeadSha = "abc123d";
    const { env, ghLogPath } = await writeGhStub(tempDir, [
      {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                id: "PR_abc123",
                isDraft: true,
                headRefOid: fullHeadSha,
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
      { env },
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
