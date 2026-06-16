import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  parseGateReviewCommentMarkerBody,
  parseGateReviewCommentBody,
  summarizeGateReviewCommentMarkers,
  summarizeGateReviewComments,
} from "../../scripts/_core-helpers.mjs";
import {
  parseDetectCheckpointEvidenceCliArgs,
  buildPreMergeGateCheck,
} from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { claimRunnerOwnership } from "../../scripts/loop/_pr-runner-coordination.mjs";

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: {
    ...process.env,
    ...(options.env ?? {}),
    PI_SUBAGENT_RUN_ID: options.env?.PI_SUBAGENT_RUN_ID ?? "",
  },
});

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true });
  return { ...env, PI_SUBAGENT_RUN_ID: "" };
}

test("parseGateReviewCommentBody parses the deterministic visible gate comment format", () => {
  const parsed = parseGateReviewCommentBody([
    "Gate review: `draft_gate`",
    "Reviewed head SHA: `ABC1234`",
    "Verdict: clean",
    "Findings summary: no issues found",
    "Next action: mark ready for review",
  ].join("\n"));

  assert.deepEqual(parsed, {
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "mark ready for review",
  });
});

test("parseGateReviewCommentBody rejects comments missing required contract fields", () => {
  assert.equal(parseGateReviewCommentBody([
    "Gate review: draft_gate",
    "Reviewed head SHA: abc1234",
    "Verdict: clean",
    "Findings summary: no issues found",
  ].join("\n")), null);
});

test("parseGateReviewCommentMarkerBody accepts gate/head markers even when contract fields are partial", () => {
  const parsed = parseGateReviewCommentMarkerBody([
    "Gate review: draft_gate",
    "Reviewed head SHA: abc1234",
    "Verdict: clean",
  ].join("\n"));

  assert.deepEqual(parsed, {
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: null,
    nextAction: null,
    contractComplete: false,
  });
});

test("summarizeGateReviewComments keeps the newest valid comment for each gate", () => {
  const summary = summarizeGateReviewComments([
    {
      id: 10,
      body: [
        "Gate review: draft_gate",
        "Reviewed head SHA: old1234",
        "Verdict: findings_present",
        "Findings summary: fix tests",
        "Next action: stay draft and fix",
      ].join("\n"),
      updated_at: "2026-05-29T20:00:00Z",
    },
    {
      id: 11,
      body: [
        "Gate review: draft_gate",
        "Reviewed head SHA: abc1234",
        "Verdict: clean",
        "Findings summary: no issues found",
        "Next action: mark ready for review",
      ].join("\n"),
      updated_at: "2026-05-29T21:00:00Z",
    },
    {
      id: 12,
      body: [
        "Gate review: pre_approval_gate",
        "Reviewed head SHA: abc1234",
        "Verdict: clean",
        "Findings summary: no issues found",
        "Next action: await final human approval",
      ].join("\n"),
      updated_at: "2026-05-29T22:00:00Z",
    },
  ]);

  assert.equal(summary.draft_gate?.commentId, 11);
  assert.equal(summary.draft_gate?.headSha, "abc1234");
  assert.equal(summary.pre_approval_gate?.commentId, 12);
  assert.equal(summary.pre_approval_gate?.nextAction, "await final human approval");
});

test("summarizeGateReviewCommentMarkers can target the newest marker for the current gate+head pair", () => {
  const summary = summarizeGateReviewCommentMarkers([
    {
      id: 10,
      body: [
        "Gate review: draft_gate",
        "Reviewed head SHA: abc1234",
        "Verdict: clean",
      ].join("\n"),
      updated_at: "2026-05-29T20:00:00Z",
    },
    {
      id: 11,
      body: [
        "Gate review: draft_gate",
        "Reviewed head SHA: def5678",
        "Verdict: clean",
        "Findings summary: later head marker",
        "Next action: rerun gate",
      ].join("\n"),
      updated_at: "2026-05-29T21:00:00Z",
    },
  ], { headSha: "abc1234" });

  assert.equal(summary.draft_gate?.commentId, 10);
  assert.equal(summary.draft_gate?.headSha, "abc1234");
});

test("summarizeGateReviewCommentMarkers keeps newest gate+head marker even if contract fields are malformed", () => {
  const summary = summarizeGateReviewCommentMarkers([
    {
      id: 10,
      body: [
        "Gate review: draft_gate",
        "Reviewed head SHA: abc1234",
        "Verdict: clean",
        "Findings summary: no issues found",
        "Next action: mark ready for review",
      ].join("\n"),
      updated_at: "2026-05-29T20:00:00Z",
    },
    {
      id: 11,
      body: [
        "Gate review: draft_gate",
        "Reviewed head SHA: abc1234",
        "Verdict: clean",
      ].join("\n"),
      updated_at: "2026-05-29T21:00:00Z",
    },
  ]);

  assert.equal(summary.draft_gate?.commentId, 11);
  assert.equal(summary.draft_gate?.headSha, "abc1234");
  assert.equal(summary.draft_gate?.contractComplete, false);
});

test("parseDetectCheckpointEvidenceCliArgs rejects malformed arguments deterministically", () => {
  assert.throws(
    () => parseDetectCheckpointEvidenceCliArgs([]),
    /requires both --repo <owner\/name> and --pr <number>/i,
  );
  assert.throws(
    () => parseDetectCheckpointEvidenceCliArgs(["--repo", "owner/repo", "--pr", "0"]),
    /positive integer/i,
  );
  assert.throws(
    () => parseDetectCheckpointEvidenceCliArgs(["--repo", "bad slug", "--pr", "17"]),
    /match <owner\/name>/i,
  );
  assert.throws(
    () => parseDetectCheckpointEvidenceCliArgs(["--repo", "owner/repo", "--pr", "17", "--require-before-merge"]),
    /--require-before-merge has been removed/i,
  );
});

test("detect-checkpoint-evidence summarizes the newest valid live gate comments and passes pre-merge check", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 41,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: bcd5678",
              "Verdict: findings_present",
              "Findings summary: missing tests",
              "Next action: stay draft and fix",
            ].join("\n"),
            updated_at: "2026-05-29T20:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-41",
          },
          {
            id: 42,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-42",
          },
          {
            id: 43,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-43",
          },
          {
            id: 44,
            body: "not a gate comment",
            updated_at: "2026-05-29T23:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    parsed.staleRunner = { ...parsed.staleRunner, filePath: "<stale-runner-file-path>", activeRun: "<active-run-or-null>", status: parsed.staleRunner.status === "fresh_runner" || parsed.staleRunner.status === "no_owner_record" ? "<stale-status>" : parsed.staleRunner.status };
    assert.deepEqual(parsed, {
      ok: true,
      repo: "owner/repo",
      pr: 17,
      currentHeadSha: "abc1234",
      draftGate: {
        visible: true,
        headSha: "abc1234",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        commentId: 42,
        commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-42",
        updatedAt: "2026-05-29T21:00:00Z",
      },
      preApprovalGate: {
        visible: true,
        headSha: "abc1234",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "await final human approval",
        commentId: 43,
        commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-43",
        updatedAt: "2026-05-29T22:00:00Z",
      },
      draftGateMarker: {
        visible: true,
        headSha: "abc1234",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        contractComplete: true,
        commentId: 42,
        commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-42",
        updatedAt: "2026-05-29T21:00:00Z",
      },
      preApprovalGateMarker: {
        visible: true,
        headSha: "abc1234",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "await final human approval",
        contractComplete: true,
        commentId: 43,
        commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-43",
        updatedAt: "2026-05-29T22:00:00Z",
      },
      draftGateSatisfied: true,
      preMergeGateCheck: {
        ok: true,
        failures: [],
      },
      staleRunner: {
        status: "<stale-status>",
        activeRun: "<active-run-or-null>",
        exitSignals: [],
        staleRunner: null,
        maxAgeMs: 1_800_000,
        filePath: "<stale-runner-file-path>",
      },
      staleRunnerCheck: {
        ok: true,
        failures: [],
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails pre-merge check when only draft gate exists (no pre-approval)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-pages-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          [
            {
              id: 51,
              body: "noise",
              updated_at: "2026-05-29T20:00:00Z",
            },
          ],
          [
            {
              id: 52,
              body: [
                "Gate review: draft_gate",
                "Reviewed head SHA: abc1234",
                "Verdict: clean",
                "Findings summary: no issues found",
                "Next action: mark ready for review",
              ].join("\n"),
              updated_at: "2026-05-29T21:00:00Z",
              html_url: "https://github.com/owner/repo/pull/17#issuecomment-52",
            },
          ],
        ])}\n`,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.deepEqual(payload.preMergeGateCheck.failures, [
      "missing visible clean current-head pre_approval_gate comment",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails pre-merge check when only partial draft gate marker exists (no pre-approval)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-marker-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 61,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-61",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    const failures = payload.preMergeGateCheck.failures;
    assert.ok(failures.some(f => f.includes("draft_gate")),
      `expected draft_gate failure in ${JSON.stringify(failures)}`);
    assert.ok(failures.some(f => f.includes("pre_approval_gate")),
      `expected pre_approval_gate failure in ${JSON.stringify(failures)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-checkpoint-evidence always fails before merge when gate comments are missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-premerge-missing-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.deepEqual(payload.preMergeGateCheck.failures, [
      "missing visible clean draft_gate comment",
      "missing visible clean current-head pre_approval_gate comment",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence always passes pre-merge check with clean draft and current-head pre-approval gate comments", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-premerge-clean-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 70,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: bcd5678",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-70",
          },
          {
            id: 71,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-71",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.preMergeGateCheck.ok, true);
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails pre-merge check when pre-approval gate is for a stale head SHA", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-stale-head-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"feed99999999"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 80,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: abcdef12345",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-80",
          },
          {
            id: 81,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abcdef12345",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-81",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.deepEqual(payload.preMergeGateCheck.failures, [
      "missing visible clean current-head pre_approval_gate comment",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-checkpoint-evidence reports gh failures deterministically", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-fail-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stderr: "boom\n",
        exitCode: 1,
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: true, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /gh command failed: boom/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-checkpoint-evidence fails pre-merge with unresolved review threads via CLI", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-unresolved-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: JSON.stringify([
          {
            id: 90,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: bcd5678",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-90",
          },
          {
            id: 91,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          },
        ]) + "\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { id: "t1", isResolved: true, comments: { nodes: [] } },
            { id: "t2", isResolved: false, comments: { nodes: [] } }
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("unresolved review threads present")),
      "expected unresolved thread failure in " + JSON.stringify(payload.preMergeGateCheck.failures)
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails pre-merge when graphql review-thread fetch fails via CLI", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-graphql-fail-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: JSON.stringify([
          {
            id: 92,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: bcd5678",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-92",
          },
          {
            id: 93,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-93",
          },
        ]) + "\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stderr: "graphql error\n",
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("could not fetch review thread state")),
      "expected fetch failure in " + JSON.stringify(payload.preMergeGateCheck.failures)
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("buildPreMergeGateCheck fails with non-zero unresolved thread count", () => {
  const evidence = {
    currentHeadSha: "abc1234",
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "abc1234" },
  };

  const result = buildPreMergeGateCheck(evidence, 3);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    "unresolved review threads present (3); must resolve all threads before merge",
  ]);
});

test("buildPreMergeGateCheck fails with sentinel -1 (API fetch failure)", () => {
  const evidence = {
    currentHeadSha: "abc1234",
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "abc1234" },
  };

  const result = buildPreMergeGateCheck(evidence, -1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    "could not fetch review thread state from GitHub API; re-run gate evidence check when API connectivity is restored",
  ]);
});

test("buildPreMergeGateCheck passes with zero unresolved threads", () => {
  const evidence = {
    currentHeadSha: "abc1234",
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "abc1234" },
  };

  const result = buildPreMergeGateCheck(evidence, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("detect-checkpoint-evidence fails pre-merge with unresolved human review threads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-human-unresolved-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: JSON.stringify([
          {
            id: 90,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: bcd5678",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-90",
          },
          {
            id: 91,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          },
        ]) + "\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            {
              id: "t-human",
              isResolved: false,
              comments: {
                nodes: [
                  { id: "c-human", databaseId: 5001, body: "human reviewer concern", author: { login: "reviewer", __typename: "User" } },
                ],
              },
            },
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("unresolved review threads present")),
      "expected unresolved thread failure for human-authored thread in " + JSON.stringify(payload.preMergeGateCheck.failures)
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence passes pre-merge when all human review threads are resolved", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-human-resolved-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: JSON.stringify([
          {
            id: 90,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: bcd5678",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            updated_at: "2026-05-29T21:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-90",
          },
          {
            id: 91,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc1234",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: await final human approval",
            ].join("\n"),
            updated_at: "2026-05-29T22:00:00Z",
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          },
        ]) + "\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [
            {
              id: "t-human",
              isResolved: true,
              comments: {
                nodes: [
                  { id: "c-human", databaseId: 5001, body: "human reviewer concern", author: { login: "reviewer", __typename: "User" } },
                ],
              },
            },
          ] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.preMergeGateCheck.ok, true);
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-checkpoint-evidence fails closed when async run no longer owns the PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-ownership-"));

  try {
    await claimRunnerOwnership({ repo: "owner/repo", pr: 17, runId: "run-active", cwd: tempDir });

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], {
      cwd: tempDir,
      env: { ...process.env, PI_SUBAGENT_RUN_ID: "run-stale" },
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.equal(error.error, "ownership_lost");
    assert.equal(error.activeRun.runId, "run-active");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence does not fail closed when async run has no ownership record", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-ownership-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], {
      cwd: tempDir,
      env: { ...env, PI_SUBAGENT_RUN_ID: "run-stale" },
    });

    // With #569, missing ownership is advisory — gate operations should not
    // be blocked when no runner record exists. The command proceeds past
    // ownership and reaches the pre-merge gate check (which fails because
    // no gate comments exist), reporting staleRunner.status: no_owner_record.
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.equal(payload.staleRunner.status, "no_owner_record");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence finds gate comment posted as PR review (root cause 3 fix)", async () => {
  // Root cause 3 fix: gate comments posted via the PR review API (escape-hatch path) must be
  // visible to the evidence checker to prevent duplicate reposts.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-from-pr-review-"));

  try {
    const prReviewGateComment = {
      id: 900,
      body: [
        "### Gate review: `pre_approval_gate`",
        "",
        "**Reviewed head SHA:** `abc1234`",
        "**Verdict:** clean",
        "",
        "**Findings summary:** no issues found",
        "",
        "**Next action:** await final human approval",
      ].join("\n"),
      // PR reviews use submitted_at instead of created_at/updated_at
      submitted_at: "2026-05-30T23:25:00Z",
      html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-900",
    };

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        // Issue comments only contains the draft gate — pre_approval_gate is NOT here
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: JSON.stringify([
          {
            id: 70,
            body: [
              "### Gate review: `draft_gate`",
              "",
              "**Reviewed head SHA:** `abc1234`",
              "**Verdict:** clean",
              "",
              "**Findings summary:** no issues found",
              "",
              "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-70",
            updated_at: "2026-05-30T21:00:00Z",
          },
        ]) + "\n",
      },
      {
        // PR reviews endpoint returns the pre_approval_gate comment posted via escape hatch
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: JSON.stringify([prReviewGateComment]) + "\n",
      },
      {
        assertArgs: ["api", "graphql"],
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } }
        }) + "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    // Pre-merge check must pass because the pre_approval_gate comment was found in PR reviews
    assert.equal(payload.preMergeGateCheck.ok, true, JSON.stringify(payload.preMergeGateCheck));
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
    // The pre-approval gate evidence is visible with the correct head SHA
    assert.equal(payload.preApprovalGate.visible, true);
    assert.equal(payload.preApprovalGate.verdict, "clean");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
