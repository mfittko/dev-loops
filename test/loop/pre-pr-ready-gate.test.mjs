import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { initSizeBudgetFixtureRepo, makeGhMock, repeatedLinesContent, runIdFreeEnv } from "../_helpers.mjs";

import { parsePrePrReadyGateCliArgs, prePrReadyGate } from "../../scripts/loop/pre-pr-ready-gate.mjs";

const GH_RUNNER = Symbol("pre-pr-ready-gate-gh-runner");

test("pre-pr-ready gate CLI has a real subprocess boundary", () => {
  const result = spawnSync(process.execPath, ["scripts/loop/pre-pr-ready-gate.mjs", "--help"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/u);
});
const runNode = async (args = [], options = {}) => {
  try {
    const parsed = parsePrePrReadyGateCliArgs(args);
    const env = runIdFreeEnv(options.env);
    const runChild = env[GH_RUNNER];
    delete env[GH_RUNNER];
    const result = await prePrReadyGate(parsed, {
      env,
      ghCommand: "gh",
      repoRoot: options.cwd ?? process.cwd(),
      runChild,
    });
    const output = `${JSON.stringify(result)}\n`;
    return result.ok ? { code: 0, stdout: output, stderr: "" } : { code: 1, stdout: "", stderr: output };
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
    };
  }
};

async function writeGhStub(tempDir, entries, options = {}) {
  const { runChild } = makeGhMock(entries, { repeatLastOnOverflow: true, ...options });
  return { env: { DEVLOOPS_RUN_ID: "", [GH_RUNNER]: runChild } };
}
// #1585: fetchDraftGateEvidence now also fetches the authenticated login
// (api user) + review threads (graphql reviewThreads) to assert 0 unresolved
// gate-authored threads. listPrReviews (fail-open) runs between the
// issue-comments read and these calls, so a stub array that has NO explicit
// reviews entry needs an empty-reviews filler (gateCloseStubs); one that
// already stubs reviews appends only the login + threads (gateThreadLoginStubs).
function gateThreadLoginStubs({ login = "pi-local-run", threads = [] } = {}) {
  return [
    { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login })}
` },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } })}
`,
    },
  ];
}
// Use when the stub array has no explicit reviews entry: pads listPrReviews
// (empty reviews, fail-open) before the login + threads reads.
function gateCloseStubs(opts = {}) {
  return [{ stdout: "[]" }, ...gateThreadLoginStubs(opts)];
}

// --- parsePrePrReadyGateCliArgs unit tests ---

test("parsePrePrReadyGateCliArgs requires --repo and --pr", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs([]),
    /requires both --repo.*and --pr/,
  );
});

test("parsePrePrReadyGateCliArgs requires --repo value", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--pr", "17"]),
    /requires both --repo.*and --pr/,
  );
});

test("parsePrePrReadyGateCliArgs requires --pr value", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "owner/repo"]),
    /requires both --repo.*and --pr/,
  );
});

test("parsePrePrReadyGateCliArgs rejects non-numeric --pr", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "owner/repo", "--pr", "abc"]),
    /positive integer/,
  );
});

test("parsePrePrReadyGateCliArgs rejects zero --pr", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "owner/repo", "--pr", "0"]),
    /positive integer/,
  );
});

test("parsePrePrReadyGateCliArgs rejects invalid repo slug", () => {
  assert.throws(
    () => parsePrePrReadyGateCliArgs(["--repo", "invalid", "--pr", "1"]),
    /must match.*owner.*name/i,
  );
});

test("parsePrePrReadyGateCliArgs --help returns help option", () => {
  const result = parsePrePrReadyGateCliArgs(["--help"]);
  assert.equal(result.help, true);
});

test("parsePrePrReadyGateCliArgs parses valid repo and pr", () => {
  const result = parsePrePrReadyGateCliArgs(["--repo", "owner/repo", "--pr", "42"]);
  assert.equal(result.repo, "owner/repo");
  assert.equal(result.pr, 42);
});

// --- Shared test data ---

const HEAD_SHA = "25c3c8d475d6ac73f8a22747677e699553ded138";
const HEAD_SHA_SHORT = HEAD_SHA.slice(0, 7);

function buildPrStateResponse(overrides = {}) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: "PR_123",
          isDraft: true,
          headRefOid: HEAD_SHA,
          state: "OPEN",
          ...overrides,
        },
      },
    },
  };
}

function makeDraftGateComment(commentSha = HEAD_SHA_SHORT, extraFields = true) {
  const lines = [
    "Gate review: draft_gate",
    `Reviewed head SHA: ${commentSha}`,
    "Verdict: clean",
  ];
  if (extraFields) {
    lines.push("Findings summary: no issues found");
    lines.push("Next action: mark ready for review");
  }
  return {
    id: 100,
    body: lines.join("\n"),
    author: { login: "pi-local-run" },
    createdAt: "2026-06-07T00:00:00Z",
    updated_at: "2026-06-07T00:00:00Z",
  };
}

// --- Gate integration tests ---

test("gate passes: draft PR with clean draft_gate comment for current head", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
  assert.equal(parsed.sizeBudget.outcome, "pass");
});

test("gate passes: clean draft verdict lives only in the review stream (single-surface round)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: "[]" }, // issue comments: no verdict on the legacy surface
    {
      stdout: JSON.stringify([
        {
          ...makeDraftGateComment(headSha.slice(0, 7)),
          state: "COMMENTED",
          submitted_at: "2026-06-07T00:00:00Z",
          html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-100",
        },
      ]),
    },
    ...gateThreadLoginStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
});

test("gate passes off a legacy issue-comment verdict when the reviews fetch fails (fail-open)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    { stdout: "", code: 1, stderr: "HTTP 500" }, // reviews fetch fails
    ...gateThreadLoginStubs(),
  ], { repeatLastOnOverflow: false });

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).draftGateSatisfied, true);
});

test("gate blocks: draft PR without draft_gate evidence", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
  assert.match(stderrParsed.error, /No visible clean draft_gate/);
});

test("gate blocks: draft PR with draft_gate for different head SHA", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([makeDraftGateComment("9999999")]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
});

test("gate passes: non-draft PR with visible clean draft_gate (relaxed, any head)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  // Even though the draft_gate comment has a different head SHA,
  // the PR is no longer draft so any visible clean draft_gate is sufficient
  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: false, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment("9999999")]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
});

test("gate blocks: non-draft PR without any clean draft_gate", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: false })) },
    { stdout: JSON.stringify([]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
});

test("gate handles GraphQL API errors gracefully", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: "", code: 1, stderr: "GraphQL API error" },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  // The script catches errors in runCli and writes to stderr
  assert.equal(result.code, 1);
  assert.ok(result.stderr.trim().length > 0, "stderr should have content");
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
});

test("gate handles comment fetch errors gracefully", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-test-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: "", code: 1, stderr: "comments fetch error" },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  assert.ok(result.stderr.trim().length > 0, "stderr should have content");
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
});

// ---------------------------------------------------------------------------
// #1585 / #1584: gate-close requires 0 unresolved gate-authored threads
// ---------------------------------------------------------------------------

import { buildFindingMarker } from "../../scripts/github/_gate-finding-surface.mjs";

// A nice-to-have finding thread authored by the gate's own login, unresolved.
function niceToHaveThreadNode({ fp = "f".repeat(16), commentId = 9001, id = "THREAD_NTH" } = {}) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/naming.mjs",
    line: 4,
    comments: { nodes: [{ id: `gid-${commentId}`, databaseId: commentId, body: `${buildFindingMarker({ fp, severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): casing nit`, author: { login: "pi-local-run", __typename: "User" } }] },
  };
}

function reviewThreadsResponse(nodes) {
  return `${JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } })}\n`;
}

test("#1584 reproduction: a draft_gate with a clean verdict + an unresolved nice-to-have thread CANNOT reach ready-for-review (the bug this issue fixes)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-1584-repro-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  // Clean draft_gate verdict for the current head — BUT a nice-to-have thread
  // is still open (the disposition pass did not run / the fixer did not triage).
  // Before #1585 this guard returned ok (draftGateSatisfied=true) and let the
  // PR go ready with the thread dangling. Now it must block.
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) },
    { stdout: JSON.stringify([makeDraftGateComment(HEAD_SHA_SHORT)]) },
    { stdout: "[]" }, // listPrReviews (fail-open)
    { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "pi-local-run" })}\n` },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: reviewThreadsResponse([niceToHaveThreadNode()]),
    },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.equal(stderrParsed.draftGateSatisfied, false);
  assert.equal(stderrParsed.unresolvedGateThreadCount, 1);
  assert.match(stderrParsed.error, /unresolved gate-authored review thread/i);
  assert.match(stderrParsed.error, /close-gate-findings/);
});

test("#1585 (d) ordering: the fixer sees nice-to-haves BEFORE the disposition pass defers them — a clean verdict + 0 unresolved threads (fixer triaged/deferred) DOES reach ready-for-review", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-1585-clean-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  // The fixer triaged the nice-to-have (fixed or deferred) and the disposition
  // pass closed the thread — 0 unresolved gate-authored threads remain. The
  // gate-close assertion passes and the PR can go ready.
  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    { stdout: "[]" }, // listPrReviews (fail-open)
    { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "pi-local-run" })}\n` },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: reviewThreadsResponse([]), // no unresolved threads
    },
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draftGateSatisfied, true);
  assert.equal(parsed.unresolvedGateThreadCount, 0);
});

// ---------------------------------------------------------------------------
// Fail-closed PR size budget (gates.size) — the same computation
// readyForReview() runs, mirrored on the raw `gh pr ready` hook path. No
// waiver surface here: only ready-for-review.mjs's --waive-size-budget can
// grant one, so these scenarios never need to exercise a waiver.
// ---------------------------------------------------------------------------

test("size budget: escalate outcome still passes the gate (no waiver surface needed) and records the signal", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-size-escalate-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    devloopsYaml: "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        softLoc: 2\n",
    headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sizeBudget.outcome, "escalate");
});

test("size budget: a block outcome (default.waiverLoc, no waiver possible on this path) refuses the raw gh pr ready path", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-size-block-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    devloopsYaml: "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        waiverLoc: 2\n",
    headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /blocked by size budget/i);
  assert.match(stderrParsed.error, /waiverLoc/);
});

test("size budget: an unwaivable block (absoluteHardLoc) refuses the raw gh pr ready path", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-size-unwaivable-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    devloopsYaml: "version: 1\ngates:\n  size:\n    absoluteHardLoc: 2\n",
    headFiles: [{ path: "src/big.mjs", content: repeatedLinesContent(10) }],
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /absoluteHardLoc/);
  assert.match(stderrParsed.error, /no waiver possible/i);
});

test("size budget: fails closed when the PR has no resolvable baseRefName (guard throws before the diff)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-size-nobaseref-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true })) }, // baseRefName omitted
    { stdout: JSON.stringify([makeDraftGateComment(HEAD_SHA_SHORT)]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /Could not resolve PR #42 base branch/i);
});

test("size budget: fails closed when origin/<base> is not locally resolvable (git diff failure)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-size-badbase-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: "totally-unresolvable-base" })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /git diff against --base/i);
});

// ---------------------------------------------------------------------------
// Fail-closed tracker-backed PR-description contract (issue #1863) — mirrors
// the size-budget mirror above: the same validateTrackerBackedPrBodySpec
// check ready-for-review.mjs runs, on the raw `gh pr ready` hook path.
// ---------------------------------------------------------------------------

const COMPLIANT_TRACKER_BODY = `Closes #900

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

test("prBodySpec: a tracker-backed PR whose body fails the PR-description contract blocks the raw gh pr ready path (fail closed, AC1)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-prbody-block-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    {
      stdout: JSON.stringify(buildPrStateResponse({
        isDraft: true,
        headRefOid: headSha,
        baseRefName: baseBranch,
        body: "Closes #900\n\nShips the feature.",
        closingIssuesReferences: { nodes: [{ number: 900 }] },
      })),
    },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /PR-description contract/);
  assert.match(stderrParsed.error, /missing_acceptance_criteria/);
  assert.match(stderrParsed.error, /missing_definition_of_done/);
  assert.match(stderrParsed.error, /missing_explicit_non_goals/);
  assert.equal(stderrParsed.prBodySpec.ok, false);
});

test("prBodySpec: a tracker-backed PR with a fully compliant body passes the raw gh pr ready path (green path, AC6)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-prbody-pass-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    {
      stdout: JSON.stringify(buildPrStateResponse({
        isDraft: true,
        headRefOid: headSha,
        baseRefName: baseBranch,
        body: COMPLIANT_TRACKER_BODY,
        closingIssuesReferences: { nodes: [{ number: 900 }] },
      })),
    },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prBodySpec.ok, true);
});

test("prBodySpec: an issue-less PR (no closing issue reference) skips this check entirely (regression guard — lightweight path unchanged)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-prbody-skip-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir);
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch, body: "no invariants at all" })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prBodySpec, null);
});

test("ADR tripwire: contract-doc touch without ADR or waiver blocks the raw gh pr ready path (#1867)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-adr-block-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    headFiles: [{ path: "skills/docs/new-contract.md", content: "# New contract\n\nSome prose.\n" }],
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /ADR tripwire/i);
  assert.equal(stderrParsed.adrTripwire.outcome, "block");
  assert.ok(stderrParsed.adrTripwire.triggers.some((tr) => tr.type === "contract-doc"));
});

test("ADR tripwire: an added docs/decisions record satisfies a contract-doc touch on the raw path (#1867)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-adr-pass-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    headFiles: [
      { path: "skills/docs/new-contract.md", content: "# New contract\n\nSome prose.\n" },
      { path: "docs/decisions/0052-adr-tripwire-fail-closed.md", content: "# 0052. ADR tripwire\n\n## Status\n\nAccepted — 2026-08-30 (PR)\n\n## Context\n\nContext.\n\n## Decision\n\nDecision.\n\n## Consequences\n\nConsequences.\n" },
    ],
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.adrTripwire.outcome, "pass");
  assert.equal(parsed.adrTripwire.satisfiedBy, "adr");
});

test("ADR tripwire: a body-derived waiver satisfies a gate-config touch on the raw path (#1867)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-adr-waiver-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    headFiles: [{ path: "packages/core/src/config/extension-defaults.yaml", content: "version: 1\n" }],
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch, body: "Body.\nadr-tripwire:allow deliberate gate re-tune, ADR tracked in #1867\nEnd." })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.adrTripwire.outcome, "pass");
  assert.equal(parsed.adrTripwire.satisfiedBy, "waiver");
});

test("size budget: non-empty config errors[] block the raw gh pr ready path fail-closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pre-pr-size-configerr-"));
  onTestFinished(() => rm(tmpDir, { recursive: true, force: true }));

  const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tmpDir, {
    devloopsYaml: "gates:\n  size: [\n", // malformed — invalid YAML/JSON
  });
  const { env } = await writeGhStub(tmpDir, [
    { stdout: JSON.stringify(buildPrStateResponse({ isDraft: true, headRefOid: headSha, baseRefName: baseBranch })) },
    { stdout: JSON.stringify([makeDraftGateComment(headSha.slice(0, 7))]) },
    ...gateCloseStubs(),
  ]);

  const result = await runNode(["--repo", "owner/repo", "--pr", "42"], { cwd: tmpDir, env });

  assert.equal(result.code, 1);
  const stderrParsed = JSON.parse(result.stderr);
  assert.equal(stderrParsed.ok, false);
  assert.match(stderrParsed.error, /config errors/i);
});
