import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { autoDetectSnapshot } from "../../scripts/loop/detect-copilot-loop-state.mjs";
import {
  fixturePath,
  makeComment,
  makeThread,
  runNode,
  writeAutoDetectGhStub,
  writeGhStub,
  writeJson,
} from "./detect-copilot-loop-state-test-helpers.mjs";
test("detect-copilot-loop-state auto-detect returns waiting_for_ci for open PR with no review when checks have not materialized", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-ready-"));

  try {
    // Fixture has unresolved threads, but we use a clean threads response here
    const emptyThreads = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [] },
          },
        },
      },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        // gh pr view
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
      {
        // gh api requested_reviewers
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        // gh api graphql (review threads)
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.prExists, true);
    assert.equal(output.snapshot.prNumber, 17);
    assert.equal(output.snapshot.copilotReviewRequestStatus, "none");
    assert.equal(output.snapshot.copilotReviewPresent, false);
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.snapshot.unresolvedThreadCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-copilot-loop-state auto-detect returns unresolved_feedback_present when threads exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-unresolved-"));
  const fixtureText = await readFile(fixturePath, "utf8");

  try {
    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [{ id: "r-1", author: { login: "copilot-pull-request-reviewer[bot]" } }],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: fixtureText,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    // mixed-threads fixture has 2 unresolved threads (1 actionable from human reviewer)
    assert.equal(output.state, "unresolved_feedback_present");
    assert.equal(output.snapshot.unresolvedThreadCount, 2);
    assert.equal(output.snapshot.actionableThreadCount, 1);
    assert.equal(output.snapshot.copilotReviewPresent, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-copilot-loop-state auto-detect returns waiting_for_copilot_review when Copilot is requested", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-waiting-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          reviews: [],
          statusCheckRollup: [],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_copilot_review");
    assert.equal(output.snapshot.copilotReviewRequestStatus, "requested");
    assert.equal(output.loopDisposition, "pending");
    assert.equal(output.terminal, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-copilot-loop-state auto-detect treats a pending Copilot review as in-progress evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-pending-copilot-review-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "abc123",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "PENDING",
              commit: { oid: "abc123" },
            },
          ],
          statusCheckRollup: [],
        }) + "\n",
      },
      // No requested_reviewers call here: a PENDING Copilot review is already sufficient
      // in-progress evidence, so auto-detect should skip that extra API round-trip.
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_copilot_review");
    assert.equal(output.snapshot.copilotReviewPresent, true);
    assert.equal(output.snapshot.copilotReviewRequestStatus, "requested");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state fails closed from old-head green to new-head pending", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-old-green-new-pending-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-old-submitted",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"IN_PROGRESS","conclusion":null}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.ciStatus, "pending");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state fails closed from old-head green to new-head none", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-old-green-new-none-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-old-submitted",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state promotes zero-suite current-head CI to crediblyGreen when same-head local validation is supplied", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-credibly-green-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-current",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T10:00:00Z",
              commit: { oid: "newsha" },
            },
            {
              id: "r-old",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-06-01T10:00:00Z",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--local-validation-head-sha", "newsha",
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "crediblyGreen");
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.sameHeadCleanConverged, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state accepts case-insensitive local-validation SHA prefixes for crediblyGreen promotion", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-credibly-green-prefix-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "abc123def456",
          reviews: [
            {
              id: "r-current",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T10:00:00Z",
              commit: { oid: "abc123def456" },
            },
            {
              id: "r-old",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-06-01T10:00:00Z",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/abc123def456/check-runs?per_page=100"],
        stdout: '{"check_runs":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/abc123def456/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--local-validation-head-sha", "ABC123D",
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "crediblyGreen");
    assert.equal(output.state, "ready_to_rerequest_review");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state keeps zero-suite current-head CI at none under round cap", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-no-credibly-green-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-current",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T10:00:00Z",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.sameHeadCleanConverged, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-copilot-loop-state routes round-cap clean PRs to round_cap_clean_fallback when only the loop's own gate-evidence check is red (#1358 regression: the exact #1383 deadlock)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-round-cap-gate-evidence-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-1",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T08:00:00Z",
              commit: { oid: "oldsha-1" },
            },
            {
              id: "r-2",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T09:00:00Z",
              commit: { oid: "oldsha-2" },
            },
            {
              id: "r-3",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T10:00:00Z",
              commit: { oid: "oldsha-3" },
            },
            {
              id: "r-4",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T11:00:00Z",
              commit: { oid: "oldsha-4" },
            },
            {
              id: "r-5",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T12:00:00Z",
              commit: { oid: "oldsha-5" },
            },
          ],
          // Mirrors the live #1383 rollup exactly: gate-evidence is the only red
          // check, every other check (including CI test suites) is green.
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "FAILURE", name: "gate-evidence" },
            { status: "COMPLETED", conclusion: "SUCCESS", name: "test-scripts" },
            { status: "COMPLETED", conclusion: "SUCCESS", name: "test-core" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      // fallbackCiStatus is now the literal "success" (#1387: gate-evidence-only
      // red no longer promotes to crediblyGreen), so the current-head refresh
      // DOES fire here (all reviews are off the current head) — mirror the same
      // gate-evidence-red/rest-green shape at the check-runs layer.
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: JSON.stringify({
          check_runs: [
            { status: "COMPLETED", conclusion: "FAILURE", name: "gate-evidence" },
            { status: "COMPLETED", conclusion: "SUCCESS", name: "test-scripts" },
            { status: "COMPLETED", conclusion: "SUCCESS", name: "test-core" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "success");
    assert.deepEqual(output.snapshot.excludedFailureDetails, ["gate-evidence"]);
    // This is the exact #1383 deadlock: at the round cap with clean threads, a
    // red gate-evidence check must fall through to the clean fallback (which can
    // post pre_approval_gate) instead of hard-stopping at ROUND_CAP_REACHED. Its
    // ciStatus is plain "success" (#1387), not an "unconfirmed" crediblyGreen,
    // so it also clears the round-cap-clean-fallback CI-confirmation gate.
    assert.equal(output.state, "round_cap_clean_fallback");
    assert.equal(output.terminal, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state routes round-cap clean PRs to round_cap_clean_fallback when new commits land after resolved comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-round-cap-rerequest-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-1",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T08:00:00Z",
              commit: { oid: "oldsha-1" },
            },
            {
              id: "r-2",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T09:00:00Z",
              commit: { oid: "oldsha-2" },
            },
            {
              id: "r-3",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T10:00:00Z",
              commit: { oid: "oldsha-3" },
            },
            {
              id: "r-4",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T11:00:00Z",
              commit: { oid: "oldsha-4" },
            },
            {
              id: "r-5",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T12:00:00Z",
              commit: { oid: "oldsha-5" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci-old-head"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "success");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    // Head advanced past last review, but the cap forbids another Copilot round, so
    // proceed to the pre_approval_gate fallback instead of an illegal re-request.
    assert.equal(output.state, "round_cap_clean_fallback");
    assert.equal(output.autoRerequestEligible, false);
    assert.equal(output.terminal, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state does not treat malformed zero-suite payloads as explicit empty arrays", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-malformed-zero-suite-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-current",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              submittedAt: "2026-06-02T10:00:00Z",
              commit: { oid: "newsha" },
            },
            {
              id: "r-old",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-06-01T10:00:00Z",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"unexpected":[]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"unexpected":[]}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--local-validation-head-sha", "newsha",
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.state, "waiting_for_ci");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state keeps pending and failure current-head CI ahead of crediblyGreen promotion", async () => {
  for (const scenario of [
    {
      name: "pending",
      checkRuns: '{"check_runs":[{"status":"IN_PROGRESS","conclusion":null}]}\n',
      statuses: '{"statuses":[]}\n',
      expectedCiStatus: "pending",
      expectedState: "waiting_for_ci",
    },
    {
      name: "failure",
      checkRuns: '{"check_runs":[{"status":"COMPLETED","conclusion":"FAILURE","name":"ci-old-head"}]}\n',
      statuses: '{"statuses":[]}\n',
      expectedCiStatus: "failure",
      expectedState: "blocked_needs_user_decision",
    },
  ]) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `dev-loops-detect-credibly-green-${scenario.name}-`));

    try {
      const emptyThreads = JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      });

      const { env } = await writeGhStub(tempDir, [
        {
          assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
          stdout: JSON.stringify({
            isDraft: false,
            state: "OPEN",
            number: 17,
            headRefOid: "newsha",
            reviews: [
              {
                id: "r-current",
                author: { login: "copilot-pull-request-reviewer[bot]" },
                state: "COMMENTED",
                submittedAt: "2026-06-02T10:00:00Z",
                commit: { oid: "newsha" },
              },
              {
                id: "r-old",
                author: { login: "copilot-pull-request-reviewer[bot]" },
                state: "CHANGES_REQUESTED",
                submittedAt: "2026-06-01T10:00:00Z",
                commit: { oid: "oldsha" },
              },
            ],
            statusCheckRollup: [
              { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
            ],
          }) + "\n",
        },
        {
          assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
          stdout: '{"users":[],"teams":[]}\n',
        },
        {
          assertArgs: ["api", "graphql"],
          stdout: emptyThreads + "\n",
        },
        {
          assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
          stdout: scenario.checkRuns,
        },
        {
          assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
          stdout: scenario.statuses,
        },
      ]);

      const result = await runNode([
        "--repo", "owner/repo",
        "--pr", "17",
        "--local-validation-head-sha", "newsha",
      ], { env });

      assert.equal(result.code, 0, `scenario=${scenario.name} stderr=${result.stderr}`);

      const output = JSON.parse(result.stdout);
      assert.equal(output.snapshot.ciStatus, scenario.expectedCiStatus);
      assert.equal(output.state, scenario.expectedState);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});

test("detect-copilot-loop-state auto-detect ignores stale pending Copilot reviews from older commits", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-stale-pending-copilot-review-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "oldsha" },
            },
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "PENDING",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [],
        }) + "\n",
      },
      {
        // Stale pending review must not short-circuit the requested_reviewers probe.
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: `${emptyThreads}\n`,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.copilotReviewPresent, true);
    assert.equal(output.snapshot.copilotReviewRequestStatus, "none");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.autoRerequestEligible, false);
    assert.equal(output.sameHeadCleanConverged, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state refreshes current-head CI for a commented old-head review", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-commented-old-head-new-pending-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"IN_PROGRESS","conclusion":null}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.ciStatus, "pending");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state fails closed from old-head green to new-head success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-old-green-new-success-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.snapshot.ciStatus, "success");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state fails closed from old-head green to new-head failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-old-green-new-failure-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"COMPLETED","conclusion":"FAILURE","name":"ci-old-head"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "blocked_needs_user_decision");
    assert.equal(output.snapshot.ciStatus, "failure");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.deepEqual(output.snapshot.failureDetails, ["ci-old-head"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression: submitted Copilot review on current head exits waiting_for_copilot_review
// ---------------------------------------------------------------------------

test("detect-copilot-loop-state uses head-scoped check-runs when commit status refresh is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-head-check-runs-only-failure-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"COMPLETED","conclusion":"FAILURE","name":"ci-old-head"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stderr: 'gh: unavailable\n',
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "blocked_needs_user_decision");
    assert.equal(output.snapshot.ciStatus, "failure");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state refreshes head-scoped CI probes in parallel for stale-success cases", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-head-refresh-parallel-"));

  try {
    const ghPath = path.join(tempDir, "gh");
    const overlapPath = path.join(tempDir, "overlap-detected");
    await writeFile(
      ghPath,
      `#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
const args = process.argv.slice(2);
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const tempDir = process.env.GH_PARALLEL_TEMP_DIR;
const overlapPath = process.env.GH_PARALLEL_OVERLAP_PATH;

if (args[0] === "pr" && args[1] === "view") {
  write({
    isDraft: false,
    state: "OPEN",
    number: 17,
    headRefOid: "newsha",
    reviews: [
      {
        author: { login: "copilot-pull-request-reviewer[bot]" },
        state: "COMMENTED",
        commit: { oid: "oldsha" }
      }
    ],
    statusCheckRollup: [
      { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" }
    ]
  });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/17/requested_reviewers") {
  write({ users: [], teams: [] });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  write({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
  process.exit(0);
}

if (args[0] === "api" && (args[1] === "repos/owner/repo/commits/newsha/check-runs?per_page=100" || args[1] === "repos/owner/repo/commits/newsha/status?per_page=100")) {
  const endpoint = args[1].includes("check-runs") ? "check-runs" : "status";
  const otherEndpoint = endpoint === "check-runs" ? "status" : "check-runs";
  const markerPath = join(tempDir, endpoint + ".started");
  const otherMarkerPath = join(tempDir, otherEndpoint + ".started");
  writeFileSync(markerPath, "started\\n");
  for (let index = 0; index < 40; index += 1) {
    if (existsSync(otherMarkerPath)) {
      writeFileSync(overlapPath, "detected\\n");
      break;
    }
    await sleep(25);
  }
  await sleep(250);
  if (endpoint === "check-runs") {
    write({ check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
  } else {
    write({ statuses: [] });
  }
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
process.exit(97);
`,
      "utf8",
    );
    await chmod(ghPath, 0o755);

    const env = {
      ...process.env,
      PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
      GH_PARALLEL_TEMP_DIR: tempDir,
      GH_PARALLEL_OVERLAP_PATH: overlapPath,
    };

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.snapshot.ciStatus, "success");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.equal(existsSync(overlapPath), true, "expected head-scoped CI refresh probes to overlap in time");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state keeps cancelled check-runs from being masked by commit-status success", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-cancelled-plus-status-success-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"COMPLETED","conclusion":"CANCELLED"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[{"state":"success"}]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.ciStatus, "none");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state treats cancelled head-scoped check runs as none", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-head-cancelled-none-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"COMPLETED","conclusion":"CANCELLED"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state treats mixed head-scoped failure-plus-pending checks as failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-old-green-new-failure-over-pending-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci-old-head" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: '{"check_runs":[{"status":"IN_PROGRESS","conclusion":null},{"status":"COMPLETED","conclusion":"FAILURE","name":"ci-old-head"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.state, "blocked_needs_user_decision");
    assert.equal(output.snapshot.ciStatus, "failure");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state allows clean convergence when only stale requested_reviewers remains after current-head review", async () => {
  // requested_reviewers can briefly still list Copilot after a submitted
  // current-head review. With no pending current-head review, auto-detect should
  // treat that as settled rather than over-blocking forever.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-review-on-head-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "currentsha",
          reviews: [
            {
              // Copilot submitted a COMMENTED review on the current head
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "currentsha" },
              submittedAt: "2026-01-15T10:30:00Z",
            },
          ],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        // GitHub's requested_reviewers still lists Copilot (stale — not yet cleared)
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        // Timeline: the review_requested event predates the submitted review (stale)
        assertArgs: ["api", "repos/owner/repo/issues/17/timeline", "--paginate", "--jq"],
        stdout: '{"login":"copilot-pull-request-reviewer[bot]","created_at":"2026-01-15T10:00:00Z"}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.snapshot.copilotReviewPresent, true);
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, true);
    assert.equal(output.snapshot.copilotReviewRequestStatus, "none");
    assert.equal(output.autoRerequestEligible, false);
    assert.equal(output.sameHeadCleanConverged, true);
    assert.equal(output.loopDisposition, "clean_converged");
    assert.equal(output.terminal, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state keeps request active when timeline re-request is newer than submitted review", async () => {
  // A deliberate same-head re-request was made AFTER the existing submitted review.
  // The detector must keep the request active (not demote to stale).
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-fresh-rerequest-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "currentsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "currentsha" },
              submittedAt: "2026-01-15T10:30:00Z",
            },
          ],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        // Copilot is in requested_reviewers (genuine re-request)
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[{"login":"copilot-pull-request-reviewer[bot]"}],"teams":[]}\n',
      },
      {
        // Timeline: re-request event is NEWER than the submitted review
        assertArgs: ["api", "repos/owner/repo/issues/17/timeline", "--paginate", "--jq"],
        stdout: '{"login":"copilot-pull-request-reviewer[bot]","created_at":"2026-01-15T11:00:00Z"}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.snapshot.copilotReviewRequestStatus, "requested");
    assert.equal(output.state, "waiting_for_copilot_review");
    assert.equal(output.loopDisposition, "pending");
    assert.equal(output.terminal, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-copilot-loop-state allows clean convergence once current-head request status is settled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-review-on-head-settled-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "currentsha",
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "currentsha" },
            },
          ],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
    ]);

    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "17", "--review-request-status", "none"],
      { env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, true);
    assert.equal(output.snapshot.copilotReviewRequestStatus, "none");
    assert.equal(output.autoRerequestEligible, false);
    assert.equal(output.sameHeadCleanConverged, true);
    assert.equal(output.loopDisposition, "clean_converged");
    assert.equal(output.terminal, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state does not false-block on hidden failed head check-run (#740)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-740-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-old-submitted",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: JSON.stringify({
          check_runs: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
            { status: "COMPLETED", conclusion: "FAILURE", name: "copilot" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    // PR-visible rollup is success, so hidden head-scoped failure must not downgrade.
    assert.notEqual(output.snapshot.ciStatus, "failure");
    assert.notEqual(output.state, "blocked_needs_user_decision");
    // Hidden failure correctly ignored; visible CI is success so no false block
    assert.equal(output.snapshot.ciStatus, "success");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.deepEqual(output.snapshot.excludedFailureDetails, ["copilot"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state downgrades visible success to none when hidden check-run is unsupported completed (#740)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-740-unsupported-completed-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-old-submitted",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: JSON.stringify({
          check_runs: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
            { status: "COMPLETED", conclusion: "CANCELLED", name: "ops" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    // Hidden unsupported-completed check forces downgrade from success to none.
    assert.equal(output.snapshot.ciStatus, "none");
    assert.equal(output.state, "waiting_for_ci");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.deepEqual(output.snapshot.excludedFailureDetails, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-copilot-loop-state preserves success when multiple hidden checks fail (#740)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-auto-740-multi-hidden-failures-"));

  try {
    const emptyThreads = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });

    const { env } = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo"],
        stdout: JSON.stringify({
          isDraft: false,
          state: "OPEN",
          number: 17,
          headRefOid: "newsha",
          reviews: [
            {
              id: "r-old-submitted",
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "CHANGES_REQUESTED",
              commit: { oid: "oldsha" },
            },
          ],
          statusCheckRollup: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: emptyThreads + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/check-runs?per_page=100"],
        stdout: JSON.stringify({
          check_runs: [
            { status: "COMPLETED", conclusion: "SUCCESS", name: "ci" },
            { status: "COMPLETED", conclusion: "FAILURE", name: "copilot" },
            { status: "COMPLETED", conclusion: "FAILURE", name: "lint" },
          ],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/commits/newsha/status?per_page=100"],
        stdout: '{"statuses":[]}\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    // PR-visible rollup is success, so multiple hidden head-scoped failures must not downgrade.
    assert.equal(output.snapshot.ciStatus, "success");
    assert.equal(output.state, "ready_to_rerequest_review");
    assert.equal(output.snapshot.copilotReviewOnCurrentHead, false);
    assert.deepEqual(output.snapshot.excludedFailureDetails, ["copilot", "lint"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
