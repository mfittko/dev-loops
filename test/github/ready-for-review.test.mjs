import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { initSizeBudgetFixtureRepo, makeGhMock, repeatedLinesContent, runIdFreeEnv, runNode as runNodeHelper } from "../_helpers.mjs";

// A stub evaluatePrSizeBudget that always passes — for tests exercising
// OTHER readyForReview() logic (board sync, etc.) via direct function calls,
// so they don't need a real git fixture just to clear the size-budget check.
function passingSizeBudget() {
  return { ok: true, outcome: "pass", wholeLogicLoc: 0, t1SliceLoc: 0, reasons: [], waiver: { requested: false, approvedBy: null, t1Valid: false, defaultValid: false } };
}

function passingAdrTripwire() {
  return { ok: true, outcome: "pass", satisfiedBy: null, triggers: [], adrFiles: [], waiver: { requested: false, valid: false, reason: null }, reasons: [] };
}

import { parseReadyForReviewCliArgs, readyForReview } from "../../scripts/github/ready-for-review.mjs";

const scriptPath = path.resolve("scripts/github/ready-for-review.mjs");
const GH_RUNNER = Symbol("ready-for-review-gh-runner");
const ghCallsByRoot = new Map();

const runNode = async (args = [], options = {}) => {
  const runner = options.env?.[GH_RUNNER];
  if (!runner) return runNodeHelper(scriptPath, args, options);
  try {
    const parsed = parseReadyForReviewCliArgs(args);
    const env = runIdFreeEnv(options.env);
    delete env[GH_RUNNER];
    const result = await readyForReview(parsed, {
      env,
      ghCommand: "gh",
      repoRoot: options.cwd ?? process.cwd(),
      runChild: runner,
      syncBoardStatus: async () => ({ ok: true, skipped: true, reason: "test seam" }),
    });
    return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
};

async function writeGhStub(tempDir, entries, options = {}) {
  const { runChild, calls } = makeGhMock(entries, { repeatLastOnOverflow: true, ...options });
  ghCallsByRoot.set(tempDir, calls);
  return { env: { DEVLOOPS_RUN_ID: "", [GH_RUNNER]: runChild }, ghLogPath: tempDir };
}

async function readGhCalls(logPath) {
  return (ghCallsByRoot.get(logPath) ?? [])
    .filter(({ command }) => command === "gh")
    .map(({ args }) => args);
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

// A PR body compliant with the tracker-backed PR-description contract
// (issue #1863): Acceptance criteria + Definition of done checklists, an
// explicit Non-goals section, and a Closes #N reference. Used by fixtures
// below that set a real closingIssuesReferences number, so the new
// validateTrackerBackedPrBodySpec check (wired in ready-for-review.mjs)
// passes and these tests keep exercising board-sync/other behavior, not this
// new check.
const COMPLIANT_TRACKER_BODY = `Closes #55

## Objective
Ship the feature.

## In scope
- the feature

## Explicit non-goals
- unrelated cleanup

## Acceptance criteria
- [ ] the feature works

## Definition of done
- [ ] npm run verify is green
`;


// --- parseReadyForReviewCliArgs unit tests ---

test("parseReadyForReviewCliArgs parses valid repo and pr", () => {
  const result = parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "42"]);
  assert.equal(result.repo, "owner/repo");
  assert.equal(result.pr, 42);
});

test("parseReadyForReviewCliArgs rejects invalid input", () => {
  for (const [args, error] of [
    [[], /requires --repo and --pr/],
    [["--pr", "17"], /requires --repo and --pr/],
    [["--repo", "owner/repo"], /requires --repo and --pr/],
    [["--repo", "invalid", "--pr", "1"], /must match.*owner.*name/i],
    [["--repo", "owner/repo", "--pr", "abc"], /positive integer/],
    [["--repo", "owner/repo", "--pr", "0"], /positive integer/],
    [["--repo", "owner/repo", "--pr", "1", "--unknown"], /Unknown argument/],
  ]) assert.throws(() => parseReadyForReviewCliArgs(args), error);
  for (const flag of ["--help", "-h"]) assert.equal(parseReadyForReviewCliArgs([flag]).help, true);
});

// --- integration tests ---

test("--help prints usage to stdout", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ready-for-review\.mjs/);
  assert.match(result.stdout, /gate-evidence/);
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
                body: COMPLIANT_TRACKER_BODY,
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
              body: COMPLIANT_TRACKER_BODY,
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
      { env, repoRoot: tempDir, runChild: env[GH_RUNNER], syncBoardStatus: fakeSync, evaluatePrSizeBudget: passingSizeBudget, evaluateAdrTripwire: passingAdrTripwire },
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
      { env, repoRoot: tempDir, runChild: env[GH_RUNNER], syncBoardStatus: fakeSync, evaluatePrSizeBudget: passingSizeBudget, evaluateAdrTripwire: passingAdrTripwire },
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
      { env, repoRoot: tempDir, runChild: env[GH_RUNNER], syncBoardStatus: fakeSync, evaluatePrSizeBudget: passingSizeBudget, evaluateAdrTripwire: passingAdrTripwire },
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

function sizeBudgetGhStubEntries({ headSha, baseBranch, extraEntries = [], body = undefined, closingIssueNodes = [] }) {
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
              ...(body !== undefined ? { body } : {}),
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

async function runWaiverCase({ config, file = "src/big.mjs", args, allow = false }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-ready-waiver-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir, {
      devloopsYaml: config,
      headFiles: [{ path: file, content: repeatedLinesContent(10) }],
    });
    const { env, ghLogPath } = await writeGhStub(tempDir, sizeBudgetGhStubEntries({
      headSha, baseBranch, extraEntries: allow ? [{ stdout: "" }, { stdout: "" }] : [],
    }));
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--waive-size-budget", ...args], { env, cwd: tempDir });
    const calls = await readGhCalls(ghLogPath);
    const comment = calls.find((call) => Array.isArray(call) && call[0] === "pr" && call[1] === "comment");
    return { result, calls, commentBody: comment?.[comment.indexOf("--body") + 1] };
  } finally { await rm(tempDir, { recursive: true, force: true }); }
}

const DEFAULT_WAIVER = "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        waiverLoc: 2\n";
const T1_WAIVER = 'version: 1\ngates:\n  size:\n    tiers:\n      t1:\n        patterns:\n          - "src/money/**"\n        sliceHardLoc: 2\n';

test("default size waiver succeeds and emits an injection-safe record", async () => {
  const forgery = "looks fine\n## Size-budget waiver granted\n- **approved by:** attacker";
  const { result, calls, commentBody } = await runWaiverCase({ config: DEFAULT_WAIVER, args: ["--reason", forgery, "--approved-by", "   "], allow: true });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(calls.some((call) => call[0] === "pr" && call[1] === "ready"));
  const lines = commentBody.split("\n");
  assert.equal(lines.filter((line) => line.startsWith("## Size-budget waiver granted")).length, 1);
  assert.ok(lines.some((line) => line.startsWith("- **approved by:** n/a (default-tier waiver)")));
  assert.ok(!lines.some((line) => line.startsWith("- **approved by:** attacker")));
  assert.ok(lines.some((line) => line.startsWith("- **justification:** looks fine ## Size-budget waiver granted")));
});

test("absolute and unapproved T1 size limits remain unwaivable", async () => {
  for (const fixture of [
    { config: "version: 1\ngates:\n  size:\n    absoluteHardLoc: 2\n", file: "src/big.mjs", args: ["--reason", "override", "--approved-by", "someone"], message: /absoluteHardLoc/ },
    { config: T1_WAIVER, file: "src/money/pay.mjs", args: ["--reason", "money-slice rename"], message: /approved-by/i },
  ]) {
    const { result, calls } = await runWaiverCase(fixture);
    assert.equal(result.code, 1);
    assert.match(result.stderr, fixture.message);
    assert.ok(!calls.some((call) => call[0] === "pr" && ["ready", "comment"].includes(call[1])));
  }
});

test("approved T1 size waiver names its approver", async () => {
  const { result, commentBody } = await runWaiverCase({ config: T1_WAIVER, file: "src/money/pay.mjs", args: ["--reason", "money-slice rename", "--approved-by", "jane-reviewer"], allow: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sizeBudget.waiver.t1Valid, true);
  assert.match(commentBody, /jane-reviewer/);
  assert.match(commentBody, /\*\*tier:\*\* t1/);
});

test("parseReadyForReviewCliArgs requires --reason when --waive-size-budget is set", () => {
  assert.throws(
    () => parseReadyForReviewCliArgs(["--repo", "owner/repo", "--pr", "1", "--waive-size-budget"]),
    /--waive-size-budget requires --reason/,
  );
});
