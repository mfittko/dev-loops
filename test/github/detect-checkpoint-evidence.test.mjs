// Determinism (issue #1405). The root cause of the intermittent failures
// here was shared on-disk state, not a fixture-vs-clock comparison: some
// `runNode` calls omitted `cwd`, so the spawned CLI inherited the real
// process cwd and resolved its runner-coordination file via
// `git rev-parse --git-common-dir` — a path SHARED across every worktree
// over this one `.git`. A stale leftover coordination file from another
// run/worktree then flipped stale-runner age assertions. The fix: every
// `runNode` that can reach coordination passes `cwd: tempDir` (a per-test
// mkdtemp dir where `--git-common-dir` fails, so the coordination root
// anchors to the isolated temp dir). Any new spawn that touches
// coordination MUST set `cwd: tempDir`.
//
// Related convention: never read the real wall clock here either — no bare,
// argument-less Date constructor, and no read of the current epoch millis off the Date global. Production seams
// that need "now" (`detectStaleRunner` in scripts/loop/_stale-runner-detection.mjs;
// `claimRunnerOwnership`/`assertRunnerOwnership` in
// scripts/loop/_pr-runner-coordination.mjs) already accept an injected
// `now`; pass a fixed value through it. Enforced mechanically by
// test/github/deterministic-fixture-time.test.mjs.
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
  buildFanoutEnforcement,
  detectCheckpointEvidence,
  deriveEvidenceState,
  EVIDENCE_STATE,
} from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { fetchGithubReviewThreadsPayload } from "../../scripts/github/capture-review-threads.mjs";
import { claimRunnerOwnership } from "../../scripts/loop/_pr-runner-coordination.mjs";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { loadDevLoopConfig } from "@dev-loops/core/config";

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: {
    ...process.env,
    ...(options.env ?? {}),
    DEVLOOPS_RUN_ID: options.env?.DEVLOOPS_RUN_ID ?? "",
  },
});

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true });
  return { ...env, DEVLOOPS_RUN_ID: "" };
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
    executionMode: null,
    inlineReason: null,
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
    executionMode: null,
    inlineReason: null,
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

test("parseDetectCheckpointEvidenceCliArgs defaults skipFanoutLedgerCheck to false and honors --skip-fanout-ledger-check", () => {
  const defaultOpts = parseDetectCheckpointEvidenceCliArgs(["--repo", "owner/repo", "--pr", "17"]);
  assert.equal(defaultOpts.skipFanoutLedgerCheck, false);

  const opts = parseDetectCheckpointEvidenceCliArgs(["--repo", "owner/repo", "--pr", "17", "--skip-fanout-ledger-check"]);
  assert.equal(opts.skipFanoutLedgerCheck, true);
});

test("parseDetectCheckpointEvidenceCliArgs REJECTS --no-skip-fanout-ledger-check (no parseArgs negation; fail closed)", () => {
  // node:util parseArgs does NOT implement `--no-<boolean>` negation (that is a
  // commander/yargs feature). So the negation form must be rejected outright, not
  // silently treated as enabling the skip — the only way to keep full enforcement
  // is to omit the flag. This pins the fail-closed behavior on a security-gate flag.
  assert.throws(
    () => parseDetectCheckpointEvidenceCliArgs(["--repo", "owner/repo", "--pr", "17", "--no-skip-fanout-ledger-check"]),
    /Unknown argument/,
  );
});

// --- gh-less REST/GraphQL fallback (issue #1358, AC4) ---
// A session with no `gh` binary on PATH (spawn ENOENT) must still be able to read
// gate evidence given a GH_TOKEN/GITHUB_TOKEN, via the REST/GraphQL fallback.

function enoentRunChild(command) {
  return async (cmd) => {
    if (cmd === command) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("detectCheckpointEvidence falls back to the REST API when the gh binary is missing (ENOENT) given a token", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gh-less-"));
  const originalFetch = globalThis.fetch;
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const fetchCalls = [];
    globalThis.fetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url).includes("/pulls/17") && !String(url).includes("/reviews")) {
        return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => ({ head: { sha: "abc1234" } }) };
      }
      if (String(url).includes("/issues/17/comments")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          json: async () => ([
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
          ]),
        };
      }
      if (String(url).includes("/pulls/17/reviews")) {
        return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => [] };
      }
      throw new Error(`unexpected fetch call in test: ${url}`);
    };

    const result = await detectCheckpointEvidence(
      { repo: "owner/repo", pr: 17 },
      { env: { GH_TOKEN: "test-token" }, ghCommand: "gh", runChild: enoentRunChild("gh"), cwd: tempDir },
    );

    assert.equal(result.currentHeadSha, "abc1234");
    assert.equal(result.draftGate.verdict, "clean");
    assert.equal(result.preApprovalGate.verdict, "clean");
    assert.ok(fetchCalls.some((u) => u.includes("/pulls/17")), JSON.stringify(fetchCalls));
    assert.ok(fetchCalls.some((u) => u.includes("/issues/17/comments")), JSON.stringify(fetchCalls));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fetchGithubReviewThreadsPayload falls back to the GraphQL REST endpoint when the gh binary is missing (ENOENT)", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const fetchCalls = [];
    globalThis.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => ({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      };
    };

    const payload = await fetchGithubReviewThreadsPayload(
      { repo: "owner/repo", pr: 17 },
      { env: { GITHUB_TOKEN: "test-token" }, ghCommand: "gh", runChild: enoentRunChild("gh") },
    );

    // The fetcher returns the merged raw thread-node array (paginated walk).
    assert.deepEqual(payload, []);
    assert.equal(fetchCalls[0].url, "https://api.github.com/graphql");
    assert.equal(JSON.parse(fetchCalls[0].options.body).variables.pr, 17);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("detectCheckpointEvidence surfaces a real gh error (not ENOENT) instead of silently falling back to REST", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gh-real-error-"));
  try {
    const runChild = async () => ({ code: 1, stdout: "", stderr: "gh: authentication required" });
    await assert.rejects(
      () => detectCheckpointEvidence(
        { repo: "owner/repo", pr: 17 },
        { env: {}, ghCommand: "gh", runChild, cwd: tempDir },
      ),
      /gh command failed/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence summarizes the newest valid live gate comments and passes pre-merge check", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-"));

  try {
    // Enforcement-agnostic test: opt out of the (now default-on) fan-out evidence
    // enforcement so inline clean gate comments pass the pre-merge check.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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
        executionMode: null,
        inlineReason: null,
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
        executionMode: null,
        inlineReason: null,
        contractComplete: true,
        commentId: 43,
        commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-43",
        updatedAt: "2026-05-29T22:00:00Z",
      },
      draftGateSatisfied: true,
      fanoutEnforcement: { required: false, gates: [] },
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
      evidenceState: EVIDENCE_STATE.SATISFIED,
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails pre-merge check when only draft gate exists (no pre-approval)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-checkpoint-evidence-pages-"));

  try {
    // Enforcement-agnostic test (asserts the missing-pre-approval failure). Opt
    // out of the now default-on fan-out evidence enforcement.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.deepEqual(payload.preMergeGateCheck.failures, [
      "missing visible clean current-head pre_approval_gate comment",
    ]);
    assert.equal(payload.evidenceState, EVIDENCE_STATE.NOT_ESTABLISHED);
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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
    // Enforcement-agnostic test (clean inline gate comments). Opt out of the now
    // default-on fan-out evidence enforcement.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.preMergeGateCheck.ok, true);
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
    assert.equal(payload.evidenceState, EVIDENCE_STATE.SATISFIED);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails pre-merge check when pre-approval gate is for a stale head SHA", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-review-stale-head-"));

  try {
    // Hermetic: opt out of default-on fan-out enforcement so this test asserts
    // only the stale-head failure, independent of the repo's .devloops.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Pre-merge gate evidence check failed/i);
    assert.deepEqual(payload.preMergeGateCheck.failures, [
      "missing visible clean current-head pre_approval_gate comment",
    ]);
    // The marker for the old head is simply invisible (filtered by exact head
    // match), so this reads as "no evidence yet for this head" — the normal
    // post-fix-commit gap — not a violation.
    assert.equal(payload.evidenceState, EVIDENCE_STATE.NOT_ESTABLISHED);
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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

function cleanEvidence() {
  return {
    currentHeadSha: "abc1234",
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "abc1234" },
  };
}

test("buildPreMergeGateCheck with no/disabled enforcement descriptor ignores executionMode", () => {
  // No fanoutEnforcement argument (or { required: false }) => enforcement skipped.
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);

  // Explicit not-required descriptor also preserves behavior.
  const result2 = buildPreMergeGateCheck(cleanEvidence(), 0, null, { required: false, gates: [] });
  assert.equal(result2.ok, true);
  assert.deepEqual(result2.failures, []);
});

test("buildPreMergeGateCheck fails closed when requireFanoutEvidence and executionMode is inline_single_agent", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "inline_single_agent", ledgerPath: "tmp/x.json", ledgerExists: true },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("pre_approval_gate") && f.includes("inline_single_agent")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck fails closed when requireFanoutEvidence and ledger is missing", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/gate-findings/o-r/pr-17/pre_approval_gate-abc1234.json", ledgerExists: false },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("no findings-log ledger") && f.includes("pre_approval_gate-abc1234.json")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck passes when requireFanoutEvidence and executionMode is fanout_fanin with ledger present", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      { name: "draft_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/a.json", ledgerExists: true },
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

// --- skipFanoutLedgerCheck: remote-verifier mode (issue #1358) ---
// A stateless remote verifier (the gate-evidence CI check; a gh-less API session)
// never has the gitignored, worktree-local tmp/gate-findings ledger on disk. This
// mode skips ONLY the ledger/provenance/angle-coverage layer, keeping the
// comment-derived executionMode/inlineReason check (and the light-mode inline
// exception) enforced exactly as before.

test("buildPreMergeGateCheck skipFanoutLedgerCheck: PASSES a fanout_fanin verdict with a missing ledger (ledger not remotely verifiable)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/gate-findings/o-r/pr-17/pre_approval_gate-abc1234.json", ledgerExists: false },
    ],
  }, { skipFanoutLedgerCheck: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("buildPreMergeGateCheck skipFanoutLedgerCheck: still FAILS an inline_single_agent verdict that is not light-accepted", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "inline_single_agent", ledgerPath: "tmp/x.json", ledgerExists: false },
    ],
  }, { skipFanoutLedgerCheck: true });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("pre_approval_gate") && f.includes("inline_single_agent")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck skipFanoutLedgerCheck: still respects the light-mode inline exception without requiring a ledger", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "inline_single_agent",
        inlineReason: "docs-only micro change",
        scopeUnderThreshold: true,
        ledgerPath: "tmp/x.json",
        ledgerExists: false,
      },
    ],
  }, { skipFanoutLedgerCheck: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("buildPreMergeGateCheck skipFanoutLedgerCheck: also skips requireFanoutProvenance/angle-coverage failures", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: false, provenance: null, mandatoryAngles: ["scope"], anglePool: ["scope", "safety"] },
    ],
  }, { skipFanoutLedgerCheck: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

// AC1/AC2 "unaffected by the skip flag": --skip-fanout-ledger-check drops ONLY the
// ledger/provenance/angle-coverage layer. The remotely-verifiable preconditions —
// a clean draft_gate and a clean CURRENT-head pre_approval_gate — must still fail
// closed under the flag, so a future refactor that hoisted the skip short-circuit
// above those checks (silently reopening the exact API-driven bypass #1358 closes)
// would flip these assertions instead of leaving every skip test green on clean input.
test("buildPreMergeGateCheck skipFanoutLedgerCheck: still FAILS when the draft_gate verdict is missing", () => {
  const evidence = {
    currentHeadSha: "abc1234",
    draftGate: { visible: false },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "abc1234" },
  };
  const result = buildPreMergeGateCheck(evidence, 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: false },
    ],
  }, { skipFanoutLedgerCheck: true });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("draft_gate")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck skipFanoutLedgerCheck: still FAILS when the pre_approval_gate is for a stale head", () => {
  const evidence = {
    currentHeadSha: "abc1234",
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "stale999" },
  };
  const result = buildPreMergeGateCheck(evidence, 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: false },
    ],
  }, { skipFanoutLedgerCheck: true });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("current-head pre_approval_gate")),
    JSON.stringify(result.failures),
  );
});

// --- Fan-out provenance enforcement (AC2, gates.requireFanoutProvenance) ---

test("buildPreMergeGateCheck with requireProvenance ON passes when ledger records distinctReviewers >= floor", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: { distinctReviewers: 2, perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-b" }] } },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("buildPreMergeGateCheck with requireProvenance ON fails closed when provenance is absent", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: null },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("requireFanoutProvenance") && f.includes("route to conductor")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck with requireProvenance ON fails closed when distinctReviewers < floor", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: { distinctReviewers: 1, perAngle: [{ angle: "scope", reviewer: "review-a" }] } },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("requireFanoutProvenance") && f.includes("got 1")),
    JSON.stringify(result.failures),
  );
});

// --- Reader floor scales with the fresh-angle count (#1431) ---

test("buildPreMergeGateCheck with requireProvenance ON fails closed when distinctReviewers < scaled fresh-angle floor", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        // 3 fresh angles but only 2 distinct reviewer identities — the floor
        // scales to max(FANOUT_PROVENANCE_MIN_REVIEWERS, 3) = 3.
        provenance: {
          distinctReviewers: 2,
          perAngle: [
            { angle: "scope", reviewer: "review-a" },
            { angle: "safety", reviewer: "review-b" },
            { angle: "coverage", reviewer: "review-a" },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("requireFanoutProvenance") && f.includes("need provenance.distinctReviewers >= 3") && f.includes("got 2")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck with requireProvenance ON rejects a PADDED ledger even when the cardinality floor is met", () => {
  // 3 distinct identities >= 3 distinct fresh angles satisfies the cardinality
  // floor, but reviewer "review-a" still covers two fresh angles — the read
  // path must re-validate the per-identity pairing because the ledger is a
  // worktree-local file the write-time floor may never have seen.
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: {
          distinctReviewers: 3,
          perAngle: [
            { angle: "scope", reviewer: "review-a" },
            { angle: "safety", reviewer: "review-a" },
            { angle: "scope", reviewer: "review-b" },
            { angle: "coverage", reviewer: "review-c" },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("one-scoped-reviewer-per-angle") && f.includes('reviewer "review-a"')),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck with requireProvenance ON passes a compliant ledger at the scaled fresh-angle floor", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: {
          distinctReviewers: 3,
          perAngle: [
            { angle: "scope", reviewer: "review-a" },
            { angle: "safety", reviewer: "review-b" },
            { angle: "coverage", reviewer: "review-c" },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck with requireProvenance ON: a carried angle does not inflate the fresh-angle floor", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        // Only 1 fresh angle (scope); safety is carried forward and exempt —
        // the floor stays at the FANOUT_PROVENANCE_MIN_REVIEWERS default (2),
        // not 2 fresh angles.
        provenance: {
          distinctReviewers: 2,
          perAngle: [
            { angle: "scope", reviewer: "review-a" },
            { angle: "safety", reviewer: "review-b", carriedFromHead: "abc1234" },
          ],
        },
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck with requireProvenance OFF (default) adds NO new failure even when provenance is absent (Claude-Code non-regression)", () => {
  // requireProvenance falsy => today's behavior exactly: fanout_fanin + ledger present passes.
  const off = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: null },
    ],
  });
  assert.equal(off.ok, true);
  assert.deepEqual(off.failures, []);

  // Explicit requireProvenance: false is identical.
  const explicitOff = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: false,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true },
    ],
  });
  assert.equal(explicitOff.ok, true);
  assert.deepEqual(explicitOff.failures, []);
});

test("buildPreMergeGateCheck with requireProvenance ON fails closed on the {n, perAngle:[]} loophole (internal inconsistency)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: { distinctReviewers: 2, perAngle: [] } },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("perAngle must be non-empty") && f.includes("route to conductor")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck with requireProvenance ON fails closed when distinctReviewers exceeds recorded identities", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: { distinctReviewers: 3, perAngle: [{ angle: "scope", reviewer: "review-a" }] } },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("exceeds distinct recorded reviewer identities")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck with requireProvenance ON fails closed on a non-integer distinctReviewers (hand-edited ledger)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    gates: [
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: { distinctReviewers: 2.5, perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-b" }] } },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("distinctReviewers must be a non-negative integer")),
    JSON.stringify(result.failures),
  );
});

// --- Angle-coverage enforcement (#1196: mandatory angles + pool membership) ---
// Independent of requireFanoutProvenance: fires whenever a fanout_fanin gate
// recorded ANY internally-consistent provenance.

test("buildPreMergeGateCheck FAILS closed when fan-out provenance is missing a mandatory angle (AC1, merge-evidence time)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "kiss", reviewer: "review-b" }] },
        mandatoryAngles: ["pr-checklist-matrix", "yagni"],
        anglePool: ["dry", "kiss", "pr-checklist-matrix", "yagni"],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("missing mandatory angle(s): pr-checklist-matrix, yagni") && f.includes("route to conductor")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck FAILS closed by default when fan-out provenance names an angle outside the configured pool (AC2)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "made-up-angle", reviewer: "review-b" }] },
        mandatoryAngles: [],
        anglePool: ["dry", "kiss"],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("outside the configured pool: made-up-angle")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck WARNS (does not fail) on a foreign angle when rejectForeignAngles is false", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    rejectForeignAngles: false,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "made-up-angle", reviewer: "review-b" }] },
        mandatoryAngles: [],
        anglePool: ["dry", "kiss"],
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  // Warning mode is not silence: the foreign angle surfaces on the result.
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /outside the configured pool: made-up-angle/);
  assert.match(result.warnings[0], /rejectForeignAngles is false/);
});

test("buildPreMergeGateCheck accepts a delta-suffixed angle as covering its base mandatory angle", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: { distinctReviewers: 2, perAngle: [{ angle: "dry", reviewer: "review-a" }, { angle: "pr-checklist-matrix-delta-at-current-head", reviewer: "review-b" }] },
        mandatoryAngles: ["pr-checklist-matrix"],
        anglePool: ["dry", "kiss", "pr-checklist-matrix"],
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck FAILS closed when mandatory angles are configured but the ledger records no provenance (shadow-ledger bypass)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: null,
        mandatoryAngles: ["pr-checklist-matrix"],
        anglePool: ["dry", "pr-checklist-matrix"],
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("no valid fan-out provenance") && f.includes("route to conductor")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck adds NO failure for absent provenance when the gate configures no mandatory angles", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "fanout_fanin",
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: null,
        mandatoryAngles: [],
        anglePool: ["dry", "kiss"],
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck angle-coverage enforcement is skipped for an inline_single_agent verdict (AC3)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [
      {
        name: "pre_approval_gate",
        executionMode: "inline_single_agent",
        inlineReason: "under_threshold",
        scopeUnderThreshold: true,
        ledgerPath: "tmp/b.json",
        ledgerExists: true,
        provenance: null,
        mandatoryAngles: ["pr-checklist-matrix"],
        anglePool: ["pr-checklist-matrix"],
      },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
});

// --- #1174: light-mode-aware pre-merge acceptance of inline verdicts ---------
// A genuinely under-threshold micro-PR collapses the gate fan-out to a single
// inline check (#1043). buildPreMergeGateCheck accepts that inline verdict ONLY
// when lightMode is on, scope was re-derived under threshold, no gate:full label,
// a ledger exists, and a non-empty inline reason was recorded. Fail closed on any
// missing precondition — non-light inline verdicts stay byte-identically rejected.
function lightGate(overrides = {}) {
  return {
    name: "pre_approval_gate",
    executionMode: "inline_single_agent",
    inlineReason: "under_threshold",
    scopeUnderThreshold: true,
    ledgerPath: "tmp/b.json",
    ledgerExists: true,
    provenance: null,
    ...overrides,
  };
}

test("buildPreMergeGateCheck (#1174) ACCEPTS a light inline verdict under threshold with reason + ledger", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [lightGate()],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
});

test("buildPreMergeGateCheck (#1174) REJECTS a light inline verdict when the ledger is missing (evidence retention still uniform)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [lightGate({ ledgerExists: false, ledgerPath: "tmp/gate-findings/o-r/pr-17/pre_approval_gate-abc1234.json" })],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("no findings-log ledger")), JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck (#1174) REJECTS an over-threshold inline verdict (scope not under threshold)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [lightGate({ scopeUnderThreshold: false })],
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => f.includes("inline_single_agent") && f.includes("requireFanoutEvidence")),
    JSON.stringify(result.failures),
  );
});

test("buildPreMergeGateCheck (#1174) REJECTS an inline verdict when the gate:full label is present", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: true,
    gates: [lightGate()],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("inline_single_agent")), JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck (#1174) REJECTS an inline verdict when lightMode is disabled", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: false,
    hasFullLabel: false,
    gates: [lightGate()],
  });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("inline_single_agent")), JSON.stringify(result.failures));
});

test("buildPreMergeGateCheck (#1174) REJECTS an inline verdict with no recorded inline reason", () => {
  for (const inlineReason of [null, "", "   "]) {
    const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
      required: true,
      lightMode: true,
      hasFullLabel: false,
      gates: [lightGate({ inlineReason })],
    });
    assert.equal(result.ok, false, `inlineReason=${JSON.stringify(inlineReason)}`);
    assert.ok(result.failures.some((f) => f.includes("inline_single_agent")), JSON.stringify(result.failures));
  }
});

test("buildPreMergeGateCheck (#1174) exempts a light inline verdict from requireFanoutProvenance (provenance only enforced for fanout_fanin)", () => {
  const result = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [lightGate({ provenance: null })],
  });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.deepEqual(result.failures, []);
});

test("buildPreMergeGateCheck (#1174) non-regression: fanout gates unaffected by the light keys", () => {
  // A fanout_fanin gate with lightMode on/off and hasFullLabel present must
  // behave exactly as before: ledger present => pass, provenance still enforced.
  const pass = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    lightMode: true,
    hasFullLabel: true,
    gates: [
      { name: "draft_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/a.json", ledgerExists: true },
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true },
    ],
  });
  assert.equal(pass.ok, true, JSON.stringify(pass.failures));
  const provFail = buildPreMergeGateCheck(cleanEvidence(), 0, null, {
    required: true,
    requireProvenance: true,
    lightMode: true,
    hasFullLabel: false,
    gates: [
      { name: "draft_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/a.json", ledgerExists: true, provenance: { distinctReviewers: 2, perAngle: [{ angle: "scope", reviewer: "review-a" }, { angle: "safety", reviewer: "review-b" }] } },
      { name: "pre_approval_gate", executionMode: "fanout_fanin", ledgerPath: "tmp/b.json", ledgerExists: true, provenance: null },
    ],
  });
  assert.equal(provFail.ok, false);
  assert.ok(provFail.failures.some((f) => f.includes("requireFanoutProvenance")), JSON.stringify(provFail.failures));
});

test("buildFanoutEnforcement (#1174) re-derives scope fail-closed and sets scopeUnderThreshold for light inline verdicts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-fanout-light-"));
  try {
    const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    await writeFile(path.join(dir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 3\n    maxLines: 200\n", "utf8");
    await writeFile(path.join(dir, "a.txt"), "one\n", "utf8");
    g("add", "-A");
    g("commit", "-qm", "base");
    const baseRef = g("rev-parse", "HEAD").trim();
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
    g("add", "-A");
    g("commit", "-qm", "head");
    const headSha = g("rev-parse", "HEAD").trim();

    // Ledger for the reviewed head so the light path retains evidence uniformly.
    const ledgerDir = path.join(dir, "tmp", "gate-findings", "owner-repo", "pr-17");
    await mkdir(ledgerDir, { recursive: true });
    for (const gate of ["draft_gate", "pre_approval_gate"]) {
      await writeFile(path.join(ledgerDir, `${gate}-${headSha}.json`), JSON.stringify({ gate, headSha, findings: [] }) + "\n", "utf8");
    }

    const { config } = await loadDevLoopConfig({ repoRoot: dir });
    const marker = (headOverride) => ({ visible: true, headSha: headOverride, executionMode: "inline_single_agent", inlineReason: "under_threshold" });

    const enforcement = await buildFanoutEnforcement({
      repo: "owner/repo",
      pr: 17,
      currentHeadSha: headSha,
      draftGateMarker: marker(headSha),
      preApprovalGateMarker: marker(headSha),
      config,
      cwd: dir,
      hasFullLabel: false,
      baseRef,
    });
    assert.equal(enforcement.required, true);
    assert.equal(enforcement.lightMode, true);
    assert.equal(enforcement.hasFullLabel, false);
    for (const gate of enforcement.gates) {
      assert.equal(gate.scopeUnderThreshold, true, gate.name);
      assert.equal(gate.inlineReason, "under_threshold");
      assert.equal(gate.ledgerExists, true, gate.name);
    }
    const accepted = buildPreMergeGateCheck({
      currentHeadSha: headSha,
      draftGate: { visible: true, verdict: "clean" },
      preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha },
    }, 0, null, enforcement);
    assert.equal(accepted.ok, true, JSON.stringify(accepted.failures));

    // gate:full label forces fan-out: scope is never even measured -> rejected.
    const labelled = await buildFanoutEnforcement({
      repo: "owner/repo",
      pr: 17,
      currentHeadSha: headSha,
      draftGateMarker: marker(headSha),
      preApprovalGateMarker: marker(headSha),
      config,
      cwd: dir,
      hasFullLabel: true,
      baseRef,
    });
    for (const gate of labelled.gates) {
      assert.equal(gate.scopeUnderThreshold, false, gate.name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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
    // Enforcement-agnostic test (resolved human threads). Opt out of the now
    // default-on fan-out evidence enforcement.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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
      env: { ...process.env, DEVLOOPS_RUN_ID: "run-stale" },
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
      env: { ...env, DEVLOOPS_RUN_ID: "run-stale" },
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
    // Enforcement-agnostic test (PR-review gate-comment visibility). Opt out of
    // the now default-on fan-out evidence enforcement.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
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

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

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

test("detect-checkpoint-evidence: a posted gate-findings-review body can never win the newest-gate-marker tie-break (evidence-scan hijack)", async () => {
  // close-gate-findings.mjs's posted findings review always embeds the gate
  // name in its header line, and a finding's own free text can mention the
  // current head sha in "head <sha>" context — exactly what the LENIENT
  // gate-name+hex-token fallback in parseGateReviewCommentFields used to match,
  // making the review win the newest-marker tie-break over a genuine (older, or
  // altogether absent) verdict comment.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-gate-evidence-hijack-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const headSha = "abc1234def5678900000000000000000000000a";
    const hijackReviewBody = [
      "Gate findings — pre_approval_gate round 2 @ abc1234",
      `<!-- dev-loops:gate-findings-review pre_approval_gate ${headSha} round=2 -->`,
      "",
      `> **must-fix** (\`security\`): the sentinel recorded for head ${headSha} is never verified`,
    ].join("\n");
    const env = await writeGhStub(tempDir, [
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: `{"headRefOid":"${headSha}"}\n` },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: "[]\n" },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: `${JSON.stringify([{
          id: 900,
          body: hijackReviewBody,
          submitted_at: "2026-05-30T23:25:00Z",
          html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-900",
        }])}\n`,
      },
      { assertArgs: ["api", "graphql"], stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) + "\n" },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    // With no genuine verdict comment on the PR, pre-approval evidence must
    // remain ABSENT (not_established) — never hijacked into a visible-but-bad
    // marker sourced from the posted findings review.
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.evidenceState, "not_established");
    assert.equal(payload.preMergeGateCheck.ok, false);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("missing visible clean current-head pre_approval_gate comment")),
      JSON.stringify(payload.preMergeGateCheck.failures),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence: a rendered deferred-summary comment can never win the newest-gate-marker tie-break (evidence-scan hijack)", async () => {
  // The deferred-summary comment quotes a gate name and a sha-shaped id in its
  // table rows (thread links, a gate name in a row's Angle/Summary cell) the
  // same way — same hijack surface as the gate-findings-review body, on the
  // issue-comment stream instead of the PR-reviews stream.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-deferred-summary-hijack-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const headSha = "bcd2345ef56789000000000000000000000000b";
    const deferredSummaryBody = [
      "<!-- dev-loops:deferred-summary -->",
      "### Deferred gate findings — PR #17",
      "",
      "| Severity | Angle | Summary | Location | Round | Thread |",
      "| --- | --- | --- | --- | --- | --- |",
      `| worth-fixing-now | pre_approval_gate | quotes head ${headSha} in its own text | — | 2 | — |`,
    ].join("\n");
    const env = await writeGhStub(tempDir, [
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: `{"headRefOid":"${headSha}"}\n` },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([{ id: 55, body: deferredSummaryBody, updated_at: "2026-05-30T23:25:00Z" }])}\n`,
      },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"], stdout: "[]\n" },
      { assertArgs: ["api", "graphql"], stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) + "\n" },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.evidenceState, "not_established");
    assert.equal(payload.preMergeGateCheck.ok, false);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("missing visible clean current-head pre_approval_gate comment")),
      JSON.stringify(payload.preMergeGateCheck.failures),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function gateMarkerComment({ gate, headSha, nextAction, executionMode, inlineReason, id, updatedAt }) {
  const modeLine = inlineReason
    ? `**Execution mode:** ${executionMode} — ${inlineReason}`
    : `**Execution mode:** ${executionMode}`;
  return {
    id,
    updated_at: updatedAt,
    html_url: `https://github.com/owner/repo/pull/17#issuecomment-${id}`,
    body: [
      `### Gate review: \`${gate}\``,
      "",
      `**Reviewed head SHA:** \`${headSha}\``,
      "**Verdict:** clean",
      modeLine,
      "",
      "**Findings summary:** no issues found",
      "",
      `**Next action:** ${nextAction}`,
    ].join("\n"),
  };
}

function fanoutEvidenceGhEntries(executionMode, inlineReason = null) {
  return [
    {
      assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
      stdout: '{"headRefOid":"abc1234"}\n',
    },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
      stdout: `${JSON.stringify([
        gateMarkerComment({ gate: "draft_gate", headSha: "abc1234", nextAction: "mark ready for review", executionMode, inlineReason, id: 42, updatedAt: "2026-05-29T21:00:00Z" }),
        gateMarkerComment({ gate: "pre_approval_gate", headSha: "abc1234", nextAction: "await final human approval", executionMode, inlineReason, id: 43, updatedAt: "2026-05-29T22:00:00Z" }),
      ])}\n`,
    },
    {
      assertArgs: ["api", "graphql"],
      stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) + "\n",
    },
  ];
}

async function writeLedger(tempDir, gate) {
  const dir = path.join(tempDir, "tmp", "gate-findings", "owner-repo", "pr-17");
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  // Provenance covering the shipped extension-defaults mandatory angle for each
  // gate: fanout_fanin ledgers must record it for merge-evidence angle coverage.
  const mandatory = gate === "draft_gate" ? "pr-description" : "pr-checklist-matrix";
  const provenance = {
    distinctReviewers: 2,
    perAngle: [
      { angle: mandatory, reviewer: "review-a" },
      { angle: gate === "draft_gate" ? "scope" : "dry", reviewer: "review-b" },
    ],
  };
  await writeFile(path.join(dir, `${gate}-abc1234.json`), JSON.stringify({ gate, headSha: "abc1234", findings: [], provenance }) + "\n", "utf8");
}

test("detect-checkpoint-evidence surfaces executionMode in gate markers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-execmode-"));
  try {
    // This test exercises executionMode surfacing, not enforcement. Opt out of
    // the (now default-on) fan-out evidence enforcement so inline verdicts are
    // accepted and the surfaced executionMode can be asserted.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const env = await writeGhStub(tempDir, fanoutEvidenceGhEntries("inline_single_agent", "tiny change"));
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.draftGateMarker.executionMode, "inline_single_agent");
    assert.equal(payload.draftGateMarker.inlineReason, "tiny change");
    assert.equal(payload.preApprovalGateMarker.executionMode, "inline_single_agent");
    // requireFanoutEvidence is explicitly false => enforcement off (opt-out).
    assert.equal(payload.fanoutEnforcement.required, false);
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence requireFanoutEvidence=true fails closed for inline_single_agent verdicts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-fanout-inline-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");
    await writeLedger(tempDir, "draft_gate");
    await writeLedger(tempDir, "pre_approval_gate");
    const env = await writeGhStub(tempDir, fanoutEvidenceGhEntries("inline_single_agent"));
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("inline_single_agent") && f.includes("requireFanoutEvidence")),
      JSON.stringify(payload.preMergeGateCheck.failures),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence requireFanoutEvidence=true fails closed when the ledger is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-fanout-noledger-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");
    // No ledger written.
    const env = await writeGhStub(tempDir, fanoutEvidenceGhEntries("fanout_fanin"));
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.ok(
      payload.preMergeGateCheck.failures.some((f) => f.includes("no findings-log ledger")),
      JSON.stringify(payload.preMergeGateCheck.failures),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence disables fan-out enforcement (non-fatal) when config fails to load", async () => {
  // FIX C: loadDevLoopConfig never throws; it returns { config, warnings, errors }.
  // A config that fails schema validation produces a non-empty errors array, which
  // must be treated as config-unavailable => enforcement disabled, NOT a crash.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-badconfig-"));
  try {
    // requireFanoutEvidence must be a boolean; a string value fails validation.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: \"yes\"\n", "utf8");
    const env = await writeGhStub(tempDir, fanoutEvidenceGhEntries("inline_single_agent"));
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    // Enforcement disabled => the gate evidence is otherwise clean => exit 0.
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.fanoutEnforcement.required, false);
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence requireFanoutEvidence=true passes for fanout_fanin with ledger present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-detect-fanout-pass-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");
    await writeLedger(tempDir, "draft_gate");
    await writeLedger(tempDir, "pre_approval_gate");
    const env = await writeGhStub(tempDir, fanoutEvidenceGhEntries("fanout_fanin"));
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.fanoutEnforcement.required, true);
    assert.deepEqual(payload.preMergeGateCheck.failures, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- deriveEvidenceState (state-aware gate-evidence status: satisfied|not_established|violation) ---

test("deriveEvidenceState: both gates clean on the current head is satisfied", () => {
  const evidence = cleanEvidence();
  const preMergeGateCheck = { ok: true, failures: [] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.SATISFIED);
});

test("deriveEvidenceState: no draft_gate comment yet is not_established (draft PR / never run)", () => {
  const evidence = {
    draftGate: { visible: false, verdict: null },
    preApprovalGateMarker: { visible: false, contractComplete: false, verdict: null, headSha: null },
  };
  const preMergeGateCheck = { ok: false, failures: ["missing visible clean draft_gate comment", "missing visible clean current-head pre_approval_gate comment"] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.NOT_ESTABLISHED);
});

test("deriveEvidenceState: no current-head pre_approval_gate comment yet (mid-Copilot-loop / post-fix-commit) is not_established", () => {
  const evidence = {
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: false, contractComplete: false, verdict: null, headSha: null },
  };
  const preMergeGateCheck = { ok: false, failures: ["missing visible clean current-head pre_approval_gate comment"] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.NOT_ESTABLISHED);
});

test("deriveEvidenceState: a blocked/findings_present pre_approval_gate verdict on the current head is a violation", () => {
  const evidence = {
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "blocked", headSha: "abc1234" },
  };
  const preMergeGateCheck = { ok: false, failures: ["missing visible clean current-head pre_approval_gate comment"] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.VIOLATION);
});

test("deriveEvidenceState: a bad (non-clean) draft_gate verdict is a violation, not not_established", () => {
  const evidence = {
    draftGate: { visible: true, verdict: "findings_present" },
    preApprovalGateMarker: { visible: true, contractComplete: true, verdict: "clean", headSha: "abc1234" },
  };
  const preMergeGateCheck = { ok: false, failures: ["missing visible clean draft_gate comment"] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.VIOLATION);
});

test("deriveEvidenceState: a current-head marker with incomplete contract fields is a violation (not absent)", () => {
  const evidence = {
    draftGate: { visible: true, verdict: "clean" },
    preApprovalGateMarker: { visible: true, contractComplete: false, verdict: null, headSha: "abc1234" },
  };
  const preMergeGateCheck = { ok: false, failures: ["missing visible clean current-head pre_approval_gate comment"] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.VIOLATION);
});

test("deriveEvidenceState: both gates clean but an unrelated pre-merge failure (e.g. unresolved threads) is a violation, not satisfied", () => {
  const evidence = cleanEvidence();
  const preMergeGateCheck = { ok: false, failures: ["unresolved review threads present (2); must resolve all threads before merge"] };
  assert.equal(deriveEvidenceState(evidence, preMergeGateCheck), EVIDENCE_STATE.VIOLATION);
});
