import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  SOURCE_MODE,
  STATUS_CLASS,
  TRUST,
} from "../../packages/core/src/loop/run-inspection.mjs";

import {
  runNode,
  withTempDir,
  writeGhStub,
  writeJson,
} from "./inspect-run-test-helpers.mjs";
test("inspect-run CLI: complete snapshot inputs -> partial sourceMode (degraded trust)", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");

    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    });

    await writeJson(reviewerPath, {
      prExists: true,
      prNumber: 55,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      prHeadSha: "abc123",
      reviewRequested: false,
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
    ]);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.schemaVersion, 1);
    assert.deepEqual(output.target, { repo: "owner/repo", pr: 55 });
    assert.equal(output.activeStateFamily, "copilot-pr-outer-loop");
    assert.equal(output.outerAction, output.activeFamilyState);
    assert.ok(["active", "waiting", "blocked", "done", "unknown"].includes(output.statusClass));
    assert.ok(typeof output.needsAttention === "boolean");
    assert.equal(output.sourceMode, "partial");
    assert.equal(output.trust, "degraded");
    assert.ok(typeof output.evidence.summary === "string");
    assert.ok(Array.isArray(output.markers.missing));
    assert.ok(Array.isArray(output.markers.stale));
    assert.ok(Array.isArray(output.markers.conflicts));
    assert.deepEqual(output.loopIterations, {
      available: false,
      source: "github_pr_timeline",
      reason: "requires_live_github_facts",
    });
  });
});

test("inspect-run CLI: mixed live + input coverage can still derive a degraded top-level state", async () => {
  await withTempDir(async (tempDir) => {
    const gh = await writeGhStub(tempDir);
    const copilotPath = path.join(tempDir, "copilot.json");
    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
    ], {
      cwd: tempDir,
      env: gh.env,
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.PARTIAL);
    assert.equal(output.trust, TRUST.DEGRADED);
    assert.equal(output.outerAction, "continue_wait");
    assert.equal(output.activeFamilyState, "continue_wait");
    assert.equal(output.statusClass, STATUS_CLASS.WAITING);
    assert.match(output.evidence.summary, /caller-supplied snapshot inputs|provided to inspection/i);
  });
});

test("inspect-run CLI: successful live detectors still derive authoritative top-level state", async () => {
  await withTempDir(async (tempDir) => {
    const gh = await writeGhStub(tempDir);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
    ], {
      cwd: tempDir,
      env: gh.env,
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.LIVE_DETECTOR_BACKED);
    assert.equal(output.trust, TRUST.AUTHORITATIVE);
    assert.equal(output.outerAction, "continue_wait");
    assert.equal(output.activeFamilyState, "continue_wait");
    assert.equal(output.statusClass, STATUS_CLASS.WAITING);
    assert.equal(output.needsAttention, false);
    assert.equal(output.layers.reviewer.scope.mode, "all_reviewers");
    assert.equal(output.layers.reviewer.scope.reviewerLogin, null);
    assert.deepEqual(output.loopIterations, {
      available: true,
      source: "github_pr_timeline",
      completedCopilotReviewRounds: 1,
      pendingCopilotReviewRounds: 1,
      copilotReviewRequests: 2,
      copilotReviewComments: 2,
      resolvedReviewThreads: 0,
      unresolvedReviewThreads: 0,
      fixCommitsAfterFeedback: 1,
    });
  });
});

test("inspect-run CLI: live PR counts a pending round when the current head differs from the latest Copilot review sha", async () => {
  await withTempDir(async (tempDir) => {
    const ghPath = path.join(tempDir, "gh");
    await writeFile(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
const apiPath = args[0] === "api" ? args.find((arg) => arg.startsWith("repos/")) : null;

if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1] || "";
  if (fields.includes("reviews")) {
    out({
      headRefOid: "newsha",
      isDraft: false,
      state: "OPEN",
      number: 55,
      reviews: [{ id: 40, state: "COMMENTED", author: { login: "copilot-pull-request-reviewer[bot]" }, commit: { oid: "oldsha" } }],
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    });
  } else {
    out({ isDraft: false, state: "OPEN", number: 55, headRefOid: "newsha" });
  }
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/55/requested_reviewers") {
  out({ users: [{ login: "copilot-pull-request-reviewer[bot]" }], teams: [] });
  process.exit(0);
}

if (apiPath === "repos/owner/repo/pulls/55/reviews" || apiPath === "repos/owner/repo/pulls/55/reviews?per_page=100") {
  out([{ id: 40, state: "COMMENTED", user: { login: "copilot-pull-request-reviewer[bot]" }, submitted_at: "2026-05-20T09:00:00Z", commit_id: "oldsha" }]);
  process.exit(0);
}

if (apiPath === "repos/owner/repo/issues/55/timeline?per_page=100") {
  out([{ event: "review_requested", created_at: "2026-05-20T08:55:00Z", requested_reviewer: { login: "copilot-pull-request-reviewer[bot]" } }]);
  process.exit(0);
}

if (apiPath === "repos/owner/repo/pulls/55/comments?per_page=100") {
  out([]);
  process.exit(0);
}

if (apiPath === "repos/owner/repo/commits/newsha/check-runs?per_page=100") {
  out({ check_runs: [] });
  process.exit(0);
}

if (apiPath === "repos/owner/repo/commits/newsha/status?per_page=100") {
  out({ statuses: [] });
  process.exit(0);
}

if (apiPath === "repos/owner/repo/pulls/55/commits?per_page=100") {
  out([{ sha: "newsha", commit: { committer: { date: "2026-05-20T10:30:00Z" } }, author: { login: "author-user" } }]);
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  out({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
process.exit(1);
`,
      "utf8",
    );
    await chmod(ghPath, 0o755);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
    ], {
      cwd: tempDir,
      env: { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.loopIterations.available, true);
    assert.equal(output.loopIterations.completedCopilotReviewRounds, 1);
    assert.equal(output.loopIterations.pendingCopilotReviewRounds, 1);
  });
});

test("inspect-run CLI: truncated sources surface degraded loopIterations metadata", async () => {
  await withTempDir(async (tempDir) => {
    const ghPath = path.join(tempDir, "gh");
    await writeFile(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
const apiPath = args[0] === "api" ? args.find((arg) => arg.startsWith("repos/")) : null;

if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1] || "";
  if (fields.includes("reviews")) {
    out({ headRefOid: "abc123", isDraft: false, state: "OPEN", number: 55, reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] });
  } else {
    out({ isDraft: false, state: "OPEN", number: 55, headRefOid: "abc123" });
  }
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/55/requested_reviewers") {
  out({ users: [{ login: "copilot-pull-request-reviewer[bot]" }], teams: [] });
  process.exit(0);
}
if (apiPath === "repos/owner/repo/pulls/55/reviews" || apiPath === "repos/owner/repo/pulls/55/reviews?per_page=100") {
  out(Array.from({ length: 100 }, (_, index) => ({ id: index + 1, state: "COMMENTED", user: { login: "copilot-pull-request-reviewer[bot]" }, submitted_at: "2026-05-20T09:00:00Z", commit_id: "abc123" })));
  process.exit(0);
}
if (apiPath === "repos/owner/repo/issues/55/timeline?per_page=100") { out([]); process.exit(0); }
if (apiPath === "repos/owner/repo/pulls/55/comments?per_page=100") { out([]); process.exit(0); }
if (apiPath === "repos/owner/repo/pulls/55/commits?per_page=100") { out([]); process.exit(0); }
if (args[0] === "api" && args[1] === "graphql") {
  // Two-page walk: proves the fetcher paginates to completion (the old
  // single-shot code would have stopped after page 1 and, before the
  // pagination change, reported review_threads_has_next_page as degraded).
  if (args.some((a) => a === "after=cursor-1")) {
    out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  } else {
    out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } } });
  }
  process.exit(0);
}
process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
process.exit(1);
`,
      "utf8",
    );
    await chmod(ghPath, 0o755);

    const result = await runNode(["--repo", "owner/repo", "--pr", "55"], {
      cwd: tempDir,
      env: { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.loopIterations.available, true);
    assert.equal(output.loopIterations.degraded, true);
    // review_threads_has_next_page is gone: the thread fetch paginates the full
    // connection, so review threads can no longer be a truncated source.
    assert.deepEqual(output.loopIterations.degradedReasons, ["reviews_page_cap"]);
  });
});

test("inspect-run CLI: live PR with no Copilot review history marks loopIterations unavailable", async () => {
  await withTempDir(async (tempDir) => {
    const ghPath = path.join(tempDir, "gh");
    await writeFile(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));
const apiPath = args[0] === "api" ? args.find((arg) => arg.startsWith("repos/")) : null;

if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1] || "";
  if (fields.includes("reviews")) {
    out({
      headRefOid: "abc123",
      isDraft: false,
      state: "OPEN",
      number: 55,
      reviews: [],
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    });
  } else {
    out({ isDraft: false, state: "OPEN", number: 55, headRefOid: "abc123" });
  }
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/55/requested_reviewers") {
  out({ users: [], teams: [] });
  process.exit(0);
}

if (apiPath === "repos/owner/repo/pulls/55/reviews" || apiPath === "repos/owner/repo/pulls/55/reviews?per_page=100") {
  out([]);
  process.exit(0);
}

if (apiPath === "repos/owner/repo/issues/55/timeline?per_page=100") {
  out([]);
  process.exit(0);
}

if (apiPath === "repos/owner/repo/pulls/55/comments?per_page=100") {
  out([]);
  process.exit(0);
}

if (apiPath === "repos/owner/repo/pulls/55/commits?per_page=100") {
  out([{ sha: "abc123", commit: { committer: { date: "2026-05-20T10:30:00Z" } }, author: { login: "author-user" } }]);
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  out({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
process.exit(1);
`,
      "utf8",
    );
    await chmod(ghPath, 0o755);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
    ], {
      cwd: tempDir,
      env: { ...process.env, PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.loopIterations, {
      available: false,
      source: "github_pr_timeline",
      reason: "no_copilot_review_history",
    });
  });
});

test.skip("inspect-run CLI: reviewer-login narrows live reviewer detection to one reviewer identity", async () => {
  await withTempDir(async (tempDir) => {
    const ghPath = path.join(tempDir, "gh");
    await writeFile(
      ghPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value));

if (args[0] === "pr" && args[1] === "view") {
  const fields = args[args.indexOf("--json") + 1] || "";
  if (fields.includes("reviews")) {
    out({
      headRefOid: "abc123",
      isDraft: false,
      state: "OPEN",
      number: 55,
      reviews: [],
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    });
  } else {
    out({ isDraft: false, state: "OPEN", number: 55, headRefOid: "abc123" });
  }
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/55/requested_reviewers") {
  out({ users: [{ login: "reviewer-user" }], teams: [] });
  process.exit(0);
}

if (args[0] === "api" && args[1] === "repos/owner/repo/pulls/55/reviews") {
  out([{ id: 41, state: "COMMENTED", user: { login: "other-reviewer" }, commit_id: "abc123", html_url: "https://example.test/review/41" }]);
  process.exit(0);
}

if (args[0] === "api" && args[1] === "graphql") {
  out({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  });
  process.exit(0);
}

process.stderr.write("unexpected gh args: " + args.join(" ") + "\\n");
process.exit(1);
`,
      "utf8",
    );
    await chmod(ghPath, 0o755);

    const baseEnv = {
      ...process.env,
      PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    };

    const aggregate = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
    ], {
      cwd: tempDir,
      env: baseEnv,
    });
    assert.equal(aggregate.code, 0, `stderr: ${aggregate.stderr}`);
    const aggregateOutput = JSON.parse(aggregate.stdout);
    assert.equal(aggregateOutput.layers.reviewer.currentState, "submitted_review");
    assert.equal(aggregateOutput.layers.reviewer.scope.mode, "all_reviewers");
    assert.equal(aggregateOutput.layers.reviewer.scope.reviewerLogin, null);

    const scoped = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--reviewer-login", "reviewer-user",
    ], {
      cwd: tempDir,
      env: baseEnv,
    });
    assert.equal(scoped.code, 0, `stderr: ${scoped.stderr}`);
    const scopedOutput = JSON.parse(scoped.stdout);
    assert.equal(scopedOutput.layers.reviewer.currentState, "review_requested");
    assert.equal(scopedOutput.layers.reviewer.scope.mode, "single_reviewer");
    assert.equal(scopedOutput.layers.reviewer.scope.reviewerLogin, "reviewer-user");
  });
});

test("inspect-run CLI: waiting copilot → continue_wait, statusClass waiting", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");

    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      ciStatus: "success",
    });

    await writeJson(reviewerPath, {
      prExists: true,
      prNumber: 55,
      prHeadSha: "abc123",
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
    ]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outerAction, "continue_wait");
    assert.equal(output.statusClass, "waiting");
    assert.equal(output.needsAttention, false);
    assert.equal(output.sourceMode, "partial");
    assert.equal(output.trust, "degraded");
  });
});

test("inspect-run CLI: merged PR → done, statusClass done", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");

    await writeJson(copilotPath, { prExists: true, prNumber: 55, prMerged: true });
    await writeJson(reviewerPath, { prExists: true, prNumber: 55, prMerged: true });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
    ]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.outerAction, "done");
    assert.equal(output.statusClass, "done");
    assert.equal(output.needsAttention, false);
  });
});

test("inspect-run CLI: PR not found → structured output with statusClass unknown", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");

    await writeJson(copilotPath, { prExists: false });
    await writeJson(reviewerPath, { prExists: false });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
    ]);

    // Should succeed (exit 0) with a structured non-misleading output
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.statusClass, "unknown");
    assert.ok(output.outerAction === undefined || output.outerAction === "unknown");
    assert.equal(output.trust, "unavailable");
    assert.equal(output.needsAttention, true);
    assert.match(output.evidence.summary, /not found/i);
    assert.ok(output.markers.missing.some((entry) => /explicit target PR was not found/i.test(entry)));
  });
});

test("inspect-run CLI: no steering file → steering unavailable with no_steering_locator", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");

    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0,
      ciStatus: "success",
    });
    await writeJson(reviewerPath, {
      prExists: true,
      prNumber: 55,
      submittedReviewPresent: true,
      submittedReviewCommitSha: "abc123",
      prHeadSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
    ]);

    assert.equal(result.code, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.layers.steering.status, "unavailable");
    assert.equal(output.layers.steering.reason, "no_steering_locator");
  });
});

test("inspect-run CLI: --steering-state-file given but file missing → no_steering_file", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");
    const steeringPath = path.join(tempDir, "nonexistent-steering.json");

    await writeJson(copilotPath, {
      prExists: true, prNumber: 55,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0, ciStatus: "success",
    });
    await writeJson(reviewerPath, {
      prExists: true, prNumber: 55, prHeadSha: "abc123",
      submittedReviewPresent: true, submittedReviewCommitSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
      "--steering-state-file", steeringPath,
    ]);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.layers.steering.status, "unavailable");
    assert.equal(output.layers.steering.reason, "no_steering_file");
    assert.equal(output.layers.steering.locatorPath, undefined);
  });
});

test("inspect-run CLI: --steering-state-file with mismatched target is unavailable and does not leak steering state", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");
    const steeringPath = path.join(tempDir, "steering.json");

    await writeJson(copilotPath, {
      prExists: true, prNumber: 55,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0, ciStatus: "success",
    });
    await writeJson(reviewerPath, {
      prExists: true, prNumber: 55, prHeadSha: "abc123",
      submittedReviewPresent: true, submittedReviewCommitSha: "abc123",
    });
    await writeJson(steeringPath, {
      runId: "pr-55",
      target: { repo: "other/repo", pr: 55 },
      schemaVersion: 1,
      events: [],
      effectiveStack: [],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 1,
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
      "--steering-state-file", steeringPath,
    ]);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.layers.steering.status, "unavailable");
    assert.equal(output.layers.steering.reason, "mismatched_steering_target");
    assert.equal(output.layers.steering.locatorPath, undefined);
  });
});

test("inspect-run CLI: --steering-state-file with snapshot-mode inputs fails closed for live steering", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");
    const steeringPath = path.join(tempDir, "steering.json");

    await writeJson(copilotPath, {
      prExists: true, prNumber: 55,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0, ciStatus: "success",
    });
    await writeJson(reviewerPath, {
      prExists: true, prNumber: 55, prHeadSha: "abc123",
      submittedReviewPresent: true, submittedReviewCommitSha: "abc123",
    });
    await writeJson(steeringPath, {
      runId: "pr-55",
      target: { repo: "owner/repo", pr: 55 },
      schemaVersion: 1,
      events: [{
        eventId: "evt-001",
        runId: "pr-55",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-18T12:00:00.000Z",
      }],
      effectiveStack: [],
      queuedEvents: [{
        eventId: "evt-001",
        runId: "pr-55",
        kind: "stop_at_next_safe_gate",
        directive: "Stop before next review pass",
        seq: 1,
        applyMode: "immediate",
        submittedAt: "2026-05-18T12:00:00.000Z",
      }],
      resultHistory: [{
        eventId: "evt-001",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "current loop state is not yet an immediate safe point",
        acknowledgedAt: "2026-05-18T12:00:01.000Z",
      }],
      latestResult: {
        eventId: "evt-001",
        seq: 1,
        result: "queued_for_safe_point",
        reason: "current loop state is not yet an immediate safe point",
        acknowledgedAt: "2026-05-18T12:00:01.000Z",
      },
      nextSeq: 2,
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
      "--reviewer-input", reviewerPath,
      "--steering-state-file", steeringPath,
    ]);

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.layers.steering.status, "unavailable");
    assert.equal(output.layers.steering.reason, "live_steering_unavailable_source_mode");
    assert.equal(output.layers.steering.liveSteering.status, "unavailable");
    assert.equal(output.layers.steering.liveSteering.reason, "live_steering_unavailable_source_mode");
    assert.equal(output.layers.steering.locatorPath, undefined);
    assert.equal(output.runId, "pr-55");
    assert.equal("latestAcknowledgement" in output.layers.steering, false);
  });
});

test("inspect-run CLI: --steering-state-file with live authoritative evidence advertises steering availability", async () => {
  await withTempDir(async (tempDir) => {
    const steeringPath = path.join(tempDir, "steering.json");
    const gh = await writeGhStub(tempDir);
    const env = gh.env;
    assert.ok(gh.ghPath.endsWith(path.join(tempDir, "gh")));

    await writeJson(steeringPath, {
      runId: "pr-55",
      target: { repo: "owner/repo", pr: 55 },
      schemaVersion: 1,
      events: [],
      effectiveStack: [],
      queuedEvents: [],
      resultHistory: [],
      latestResult: null,
      nextSeq: 1,
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--steering-state-file", steeringPath,
    ], { env });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.layers.steering.status, "available");
    assert.equal(output.layers.steering.liveSteering.status, "available");
    assert.equal(output.layers.steering.liveSteering.reason, null);
  });
});

test("inspect-run CLI: checkpoint-only repo-qualified path stays advisory and top-level unknown", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json");
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeJson(checkpointPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reviewerScope: "single_reviewer",
      reviewerLogin: "reviewer-user",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 3,
      headSha: "abc123",
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "55"], {
      cwd: tempDir,
      env: { ...process.env, PATH: tempDir },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.CHECKPOINT_ONLY);
    assert.equal(output.outerAction, "unknown");
    assert.equal(output.activeFamilyState, "unknown");
    assert.equal(output.statusClass, STATUS_CLASS.UNKNOWN);
    assert.equal(output.layers.reviewer.scope.mode, "single_reviewer");
    assert.equal(output.layers.reviewer.scope.reviewerLogin, "reviewer-user");
    assert.match(output.evidence.summary, /advisory/i);
    assert.equal(output.evidence.checkpoint[0], path.join("tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json"));
  });
});

test("inspect-run CLI: checkpoint-only selection still picks the targeted repo when two repos share a PR number", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPathA = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo-a", "pr-55", "outer-loop-state.json");
    const checkpointPathB = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo-b", "pr-55", "outer-loop-state.json");
    await mkdir(path.dirname(checkpointPathA), { recursive: true });
    await mkdir(path.dirname(checkpointPathB), { recursive: true });
    await writeJson(checkpointPathA, {
      pr: 55,
      repo: "owner/repo-a",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 3,
      headSha: "abc123",
    });
    await writeJson(checkpointPathB, {
      pr: 55,
      repo: "owner/repo-b",
      outerAction: "stop",
      copilotState: "review_request_unavailable",
      reviewerState: "waiting_for_author_followup",
      reason: "review_unavailable",
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 1,
      headSha: "def456",
    });

    const result = await runNode(["--repo", "owner/repo-b", "--pr", "55"], {
      cwd: tempDir,
      env: { ...process.env, PATH: tempDir },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.CHECKPOINT_ONLY);
    assert.equal(output.evidence.checkpoint[0], path.join("tmp", "copilot-loop", "owner", "repo-b", "pr-55", "outer-loop-state.json"));
    assert.equal(output.outerAction, "unknown");
    assert.equal(output.activeFamilyState, "unknown");
    assert.equal(output.statusClass, STATUS_CLASS.UNKNOWN);
  });
});

test("inspect-run CLI: mixed live + checkpoint fallback stays advisory and top-level unknown", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json");
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeJson(copilotPath, {
      prExists: true,
      prNumber: 55,
      prDraft: false,
      prMerged: false,
      prClosed: false,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      copilotReviewOnCurrentHead: false,
      unresolvedThreadCount: 0,
      actionableThreadCount: 0,
      ciStatus: "success",
      agentFixStatus: null,
    });
    await writeJson(checkpointPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 3,
      headSha: "abc123",
    });

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "55",
      "--copilot-input", copilotPath,
    ], {
      cwd: tempDir,
      env: { ...process.env, PATH: tempDir },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.PARTIAL);
    assert.equal(output.trust, TRUST.DEGRADED);
    assert.equal(output.outerAction, "unknown");
    assert.equal(output.activeFamilyState, "unknown");
    assert.equal(output.statusClass, STATUS_CLASS.UNKNOWN);
    assert.equal(output.layers.copilot.currentState, "waiting_for_copilot_review");
    assert.equal(output.layers.reviewer.currentState, "waiting_for_author_followup");
    assert.equal(output.layers.reviewer.source, "checkpoint");
    assert.match(output.evidence.summary, /insufficient|advisory/i);
  });
});

test("inspect-run CLI: matching legacy checkpoint fallback stays advisory when repo input casing differs", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "pr-55", "outer-loop-state.json");
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeJson(checkpointPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 3,
      headSha: "abc123",
    });

    const result = await runNode(["--repo", "Owner/Repo", "--pr", "55"], {
      cwd: tempDir,
      env: { ...process.env, PATH: tempDir },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.CHECKPOINT_ONLY);
    assert.equal(output.outerAction, "unknown");
    assert.equal(output.activeFamilyState, "unknown");
    assert.equal(output.statusClass, STATUS_CLASS.UNKNOWN);
    assert.equal(output.evidence.checkpoint[0], path.join("tmp", "copilot-loop", "pr-55", "outer-loop-state.json"));
  });
});

test("inspect-run CLI: prefers repo-qualified checkpoint when both new and legacy files exist and keeps top-level unknown", async () => {
  await withTempDir(async (tempDir) => {
    const repoQualifiedPath = path.join(tempDir, "tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json");
    const legacyPath = path.join(tempDir, "tmp", "copilot-loop", "pr-55", "outer-loop-state.json");
    await mkdir(path.dirname(repoQualifiedPath), { recursive: true });
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeJson(repoQualifiedPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 3,
      headSha: "abc123",
    });
    await writeJson(legacyPath, {
      pr: 55,
      repo: "owner/repo",
      outerAction: "stop",
      copilotState: "review_request_unavailable",
      reviewerState: "waiting_for_author_followup",
      reason: "review_unavailable",
      timestamp: "2026-05-16T10:00:00Z",
      waitCycles: 9,
      headSha: "oldsha",
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "55"], {
      cwd: tempDir,
      env: { ...process.env, PATH: tempDir },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.CHECKPOINT_ONLY);
    assert.equal(output.evidence.checkpoint[0], path.join("tmp", "copilot-loop", "owner", "repo", "pr-55", "outer-loop-state.json"));
    assert.equal(output.outerAction, "unknown");
    assert.equal(output.activeFamilyState, "unknown");
    assert.equal(output.statusClass, STATUS_CLASS.UNKNOWN);
  });
});

test("inspect-run CLI: ignores legacy fallback checkpoint when repo does not match target", async () => {
  await withTempDir(async (tempDir) => {
    const checkpointPath = path.join(tempDir, "tmp", "copilot-loop", "pr-55", "outer-loop-state.json");
    await mkdir(path.dirname(checkpointPath), { recursive: true });
    await writeJson(checkpointPath, {
      pr: 55,
      repo: "other/repo",
      outerAction: "continue_wait",
      copilotState: "waiting_for_copilot_review",
      reviewerState: "waiting_for_author_followup",
      reason: null,
      timestamp: "2026-05-17T10:00:00Z",
      waitCycles: 3,
      headSha: "abc123",
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "55"], {
      cwd: tempDir,
      env: { ...process.env, PATH: tempDir },
    });

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    assert.equal(output.sourceMode, SOURCE_MODE.UNAVAILABLE);
    assert.deepEqual(output.evidence.checkpoint, []);
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests: read-only — no checkpoint creation
// ---------------------------------------------------------------------------

test("inspect-run CLI: does not create or update a checkpoint (read-only)", async () => {
  await withTempDir(async (tempDir) => {
    const copilotPath = path.join(tempDir, "copilot.json");
    const reviewerPath = path.join(tempDir, "reviewer.json");

    await writeJson(copilotPath, {
      prExists: true, prNumber: 55,
      copilotReviewRequestStatus: "requested",
      copilotReviewPresent: false,
      unresolvedThreadCount: 0, ciStatus: "success",
    });
    await writeJson(reviewerPath, {
      prExists: true, prNumber: 55, prHeadSha: "abc123",
      submittedReviewPresent: true, submittedReviewCommitSha: "abc123",
    });

    // Run from a dedicated cwd so any tmp writes would be relative to tempDir
    const result = await runNode(
      ["--repo", "owner/repo", "--pr", "55",
       "--copilot-input", copilotPath,
       "--reviewer-input", reviewerPath],
      { cwd: tempDir },
    );

    assert.equal(result.code, 0, `stderr: ${result.stderr}`);

    // The inspector must not have created a checkpoint file
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tempDir);
    const checkpointDirs = entries.filter((e) => e.startsWith("tmp") || e === "outer-loop-state.json");
    assert.deepEqual(checkpointDirs, [], `Unexpected checkpoint entries: ${checkpointDirs.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests: malformed arguments
// ---------------------------------------------------------------------------

test("inspect-run CLI: missing --repo → structured stderr, non-zero exit", async () => {
  const result = await runNode(["--pr", "55"]);
  assert.notEqual(result.code, 0);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert.ok(typeof err.error === "string" && err.error.length > 0);
  assert.ok(typeof err.usage === "string");
});

test("inspect-run CLI: missing --pr → structured stderr, non-zero exit", async () => {
  const result = await runNode(["--repo", "owner/repo"]);
  assert.notEqual(result.code, 0);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert.ok(typeof err.error === "string");
  assert.ok(typeof err.usage === "string");
});

test("inspect-run CLI: unknown flag → structured stderr, non-zero exit", async () => {
  const result = await runNode(["--repo", "owner/repo", "--pr", "55", "--not-a-flag"]);
  assert.notEqual(result.code, 0);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
  assert.ok(err.error.includes("Unknown argument"));
});

test("inspect-run CLI: invalid --pr value → structured stderr, non-zero exit", async () => {
  const result = await runNode(["--repo", "owner/repo", "--pr", "not-a-number"]);
  assert.notEqual(result.code, 0);
  const err = JSON.parse(result.stderr);
  assert.equal(err.ok, false);
});

test("inspect-run CLI: --help → usage text on stdout, exit 0", async () => {
  const result = await runNode(["--help"]);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes("inspect-run.mjs"));
  assert.ok(result.stdout.includes("--repo"));
  assert.ok(result.stdout.includes("--pr"));
});
