import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { initSizeBudgetFixtureRepo, makeGhMock, runIdFreeEnv, runNode as runNodeHelper } from "../_helpers.mjs";

import { parseRestoreReadyCliArgs, restoreReady } from "../../scripts/github/restore-ready.mjs";
import { buildFindingMarker } from "../../scripts/github/_gate-finding-surface.mjs";

const scriptPath = path.resolve("scripts/github/restore-ready.mjs");
const GH_RUNNER = Symbol("restore-ready-gh-runner");
const ghCallsByRoot = new Map();

const runNode = async (args = [], options = {}) => {
  const runner = options.env?.[GH_RUNNER];
  if (!runner) return runNodeHelper(scriptPath, args, options);
  try {
    const parsed = parseRestoreReadyCliArgs(args);
    const env = runIdFreeEnv(options.env);
    delete env[GH_RUNNER];
    const result = await restoreReady(parsed, {
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

async function writeGhStub(tempDir, entries) {
  const { runChild, calls } = makeGhMock(entries, { repeatLastOnOverflow: true });
  ghCallsByRoot.set(tempDir, calls);
  return { DEVLOOPS_RUN_ID: "", [GH_RUNNER]: runChild };
}

async function readGhCalls(tempDir) {
  return (ghCallsByRoot.get(tempDir) ?? [])
    .filter(({ command }) => command === "gh")
    .map(({ args }) => args);
}

// Mirrors ready-for-review.test.mjs's gate-evidence stub shape: fetchDraftGateEvidence reads
// issue comments, PR reviews (fail-open), the authenticated login, then review threads.
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

function cleanDraftGateComment(headSha) {
  return {
    body: `Gate review: draft_gate\nReviewed head SHA: ${headSha}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
    id: 101,
    html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
    created_at: "2026-06-05T00:00:00Z",
    updated_at: "2026-06-05T00:00:00Z",
  };
}

// A legacy plain-text verdict that records only the ABBREVIATED head SHA:
// the marker summary (summarizeGateReviewCommentMarkers) requires an EXACT
// headSha match and so never selects this comment (currentHeadClean stays
// false), while the legacy summary's manual startsWith compare still matches
// it (legacyHeadMatch/effectiveHeadClean true). This is the "legacy-only"
// evidence shape restore-ready must refuse on (issue #2355 review fix).
function legacyOnlyDraftGateComment(headSha) {
  return {
    body: `Gate review: draft_gate\nReviewed head SHA: ${headSha.slice(0, 7)}\nVerdict: clean\nFindings summary: no issues found\nNext action: mark ready for review`,
    id: 102,
    html_url: "https://github.com/owner/repo/pull/17#issuecomment-102",
    created_at: "2026-06-05T00:00:00Z",
    updated_at: "2026-06-05T00:00:00Z",
  };
}

function draftPrViewStub({ headSha, baseBranch }) {
  return {
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
  };
}

// --- CLI argument parsing ---

test("parseRestoreReadyCliArgs rejects missing --repo and --pr", () => {
  assert.throws(() => parseRestoreReadyCliArgs([]), /requires --repo and --pr/);
  assert.throws(() => parseRestoreReadyCliArgs(["--pr", "17"]), /requires --repo and --pr/);
  assert.throws(() => parseRestoreReadyCliArgs(["--repo", "owner/repo"]), /requires --repo and --pr/);
});

test("parseRestoreReadyCliArgs rejects unknown arguments", () => {
  assert.throws(() => parseRestoreReadyCliArgs(["--repo", "owner/repo", "--pr", "17", "--bogus"]), /Unknown argument/);
});

test("--help prints usage to stdout", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /restore-ready\.mjs/);
  assert.match(result.stdout, /CI precondition/i);
});

// --- restoreReady() integration ---

test("restores ready when CI is blocking but current-head draft_gate evidence is clean", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-restore-ready-success-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const env = await writeGhStub(tempDir, [
      draftPrViewStub({ headSha, baseBranch }),
      // NOTE: no `gh pr checks` stub — if the CI precondition were not
      // actually skipped, fetchCiStatus would consume THIS entry (the gate
      // evidence comments) instead, and the test would fail on a shape/arg
      // mismatch rather than silently passing.
      { stdout: JSON.stringify([cleanDraftGateComment(headSha)]) },
      ...gateCloseStubs(),
      draftPrViewStub({ headSha, baseBranch }), // pre-ready head recheck
      { stdout: "" }, // gh pr ready
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}. Stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.action, "marked_ready");

    const calls = await readGhCalls(tempDir);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "checks"), "gh pr checks must never be called");
    assert.ok(calls.some((c) => c[0] === "pr" && c[1] === "ready"), "gh pr ready should have been called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses without clean current-head draft_gate evidence, and never calls gh pr ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-restore-ready-no-evidence-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const env = await writeGhStub(tempDir, [
      draftPrViewStub({ headSha, baseBranch }),
      { stdout: "[]" }, // no PR comments = no gate evidence
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no visible clean draft_gate/i);

    const calls = await readGhCalls(tempDir);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses when the PR head moved between the evidence read and gh pr ready, and never calls gh pr ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-restore-ready-head-moved-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    // Guaranteed to differ from the real fixture commit SHA regardless of its
    // actual first hex digit (a hardcoded literal first digit could coincide).
    const movedHeadSha = `${headSha[0] === "0" ? "1" : "0"}${headSha.slice(1)}`;
    const env = await writeGhStub(tempDir, [
      draftPrViewStub({ headSha, baseBranch }),
      { stdout: JSON.stringify([cleanDraftGateComment(headSha)]) },
      ...gateCloseStubs(),
      draftPrViewStub({ headSha: movedHeadSha, baseBranch }), // pre-ready head recheck: head moved
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /head changed/i);

    const calls = await readGhCalls(tempDir);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses on legacy-only (abbreviated-head) evidence, and never calls gh pr ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-restore-ready-legacy-only-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const env = await writeGhStub(tempDir, [
      draftPrViewStub({ headSha, baseBranch }),
      { stdout: JSON.stringify([legacyOnlyDraftGateComment(headSha)]) },
      ...gateCloseStubs(),
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /draft_gate marker/i);

    const calls = await readGhCalls(tempDir);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("refuses when a gate-authored review thread is unresolved", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-restore-ready-unresolved-thread-"));
  try {
    const { headSha, baseBranch } = await initSizeBudgetFixtureRepo(tempDir);
    const env = await writeGhStub(tempDir, [
      draftPrViewStub({ headSha, baseBranch }),
      { stdout: JSON.stringify([cleanDraftGateComment(headSha)]) },
      { stdout: "[]" },
      { assertArgs: ["api", "user"], stdout: `${JSON.stringify({ login: "pi-local-run" })}\n` },
      {
        assertArgs: ["api", "graphql"],
        assertArgContains: ["reviewThreads"],
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      isResolved: false,
                      comments: {
                        nodes: [{
                          author: { login: "pi-local-run" },
                          body: `${buildFindingMarker({ fp: "f".repeat(16), severity: "nice-to-have", angle: "naming", round: 1 })}\n**nice-to-have** (\`naming\`): casing nit`,
                        }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /unresolved gate-authored review thread/i);

    const calls = await readGhCalls(tempDir);
    assert.ok(!calls.some((c) => c[0] === "pr" && c[1] === "ready"), "gh pr ready must not be called");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
