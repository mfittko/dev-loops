import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import { DEFAULT_TEST_PR_BODY, makeGhMock, runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  buildCoordinationEvaluatorInput,
  buildInlineExecutionWarning,
  parseUpsertCheckpointVerdictCliArgs,
  normalizeStructuredFindings,
  renderGateReviewCommentBody,
  summarizeCheckpointVerdictText,
  upsertCheckpointVerdict,
} from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { claimRunnerOwnership } from "../../scripts/loop/_pr-runner-coordination.mjs";
import { buildFanoutEnforcement, evaluateInlineFanoutMode } from "../../scripts/github/detect-checkpoint-evidence.mjs";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { renderFallbackGateReviewCommentBody } from "../../skills/dev-loop/scripts/post-gate-verdict-fallback.mjs";
// #1592: several fixtures below deliberately keep pre-rename severity
// spellings ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.
// The header literal and its matcher are OWNED by packages/core: the shared
// summarizers' machine-artifact filter has to recognize the same line the
// producer renders.
import { GATE_REVIEW_COMMENT_HEADER_RE, isGateMachineArtifactBody, matchGateReviewCommentHeader, parseGateReviewCommentBody, summarizeGateReviewComments } from "@dev-loops/core/github/copilot-helpers";
import { buildFindingMarker, fingerprintFinding } from "../../scripts/github/_gate-finding-surface.mjs";

const scriptPath = path.resolve("scripts/github/upsert-checkpoint-verdict.mjs");

// Hermetic in-process runtime: the cascade (repo-root/ledger/coordination
// resolution) shells read-only `git` metadata reads via execFileSync, which
// bypass the injected runChild. Shadow `git` on PATH with a no-op stub so NO
// real git binary runs during the in-process tests; every read gracefully falls
// back (empty stdout → toplevel resolves to cwd, no worktrees, no coordination
// record). gh calls and the porcelain conflict-status read route through
// makeGhMock's runChild instead (a real subprocess is impossible there).
let gitStubDir = null;
let originalPath = null;
// This repo's own .devloops dogfoods gates.requireFanoutEvidence: true. Most
// tests below exercise behavior orthogonal to fan-out evidence (comment
// rendering, marker updates, blocking-severity checks — one test
// even pins "draft_gate blocks on high only" as a live regression guard on
// this repo's own config) against the ambient repoRoot (process.cwd(), the
// worktree root) on purpose. Rather than substituting a bare fixture config
// that would silently drop that coverage, mirror the real .devloops into an
// isolated repoRoot with ONLY requireFanoutEvidence flipped off — every other
// setting (angle pools, tiers, blocking severities) stays byte-identical to
// what upsertCheckpointVerdict resolves from the real repo. Used as the
// default repoRoot for tests that do not stage their own per-test config.
let fanoutDisabledRepoRoot = null;
before(async () => {
  gitStubDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gitstub-"));
  const gitStubPath = path.join(gitStubDir, "git");
  await writeFile(gitStubPath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(gitStubPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = [gitStubDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

  fanoutDisabledRepoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-fanout-disabled-"));
  const realDevloops = await readFile(path.resolve(".devloops"), "utf8");
  const patched = realDevloops.replace("requireFanoutEvidence: true", "requireFanoutEvidence: false");
  assert.notEqual(patched, realDevloops, "expected to find gates.requireFanoutEvidence: true in the repo's own .devloops to patch for test isolation");
  await writeFile(path.join(fanoutDisabledRepoRoot, ".devloops"), patched, "utf8");
});
after(async () => {
  if (originalPath !== null) process.env.PATH = originalPath;
  if (gitStubDir) await rm(gitStubDir, { recursive: true, force: true });
  if (fanoutDisabledRepoRoot) await rm(fanoutDisabledRepoRoot, { recursive: true, force: true });
});

// Inline mode is the default execution mode and now requires a non-empty
// --inline-reason (see FIX B). For tests that do not explicitly exercise the
// execution-mode flags, auto-append a default inline reason so the existing
// scenarios keep covering their original behavior. Tests that pass their own
// --execution-mode / --inline-reason (or that expect an argument error before
// the parser reaches the inline-reason check) are left untouched.
const DEFAULT_TEST_INLINE_REASON = "single-agent inline review (test)";
const augmentInlineReason = (args) => {
  if (args.includes("--execution-mode") || args.includes("--inline-reason")) {
    return args;
  }
  return [...args, "--inline-reason", DEFAULT_TEST_INLINE_REASON];
};

// Marker key: the local writeGhStub returns an env carrying its gh `entries` so
// runNode can replay them in-process (no gh/CLI subprocess) via makeGhMock.
const GH_MOCK_ENTRIES = Symbol.for("dev-loops.ghMockEntries");

// Run the CLI in-process when gh entries are stashed on the env (the common
// gate-coordination tests), mirroring main()'s output contract so the existing
// { code, stdout, stderr } assertions keep working unchanged: on success stdout
// is the emitResult JSON line and stderr carries any warnings the entry fn wrote
// PLUS the inline-execution warning main() appends; on a thrown error, exit 1
// with the same { ok:false, error } stderr envelope. Falls back to a real CLI
// spawn when no entries are stashed (parse-error / --force smokes with no env,
// and the claims/log-mode boundary tests that build env via writeGhStubHelper).
const runNode = async (args = [], options = {}) => {
  const augmented = augmentInlineReason(args);
  const entries = options.env?.[GH_MOCK_ENTRIES];
  if (!entries) {
    return runNodeHelper(scriptPath, augmented, {
      ...options,
      cwd: options.cwd ?? fanoutDisabledRepoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        DEVLOOPS_RUN_ID: options.env?.DEVLOOPS_RUN_ID ?? "",
      },
    });
  }
  const { runChild, calls } = makeGhMock(entries, { repeatLastOnOverflow: true });
  // gh-only invocation count, for tests that asserted the PATH stub's counter
  // file (git conflict-status reads also route through runChild and are excluded).
  const ghCallCount = () => calls.filter((c) => c.command === "gh").length;
  let options_;
  try {
    options_ = parseUpsertCheckpointVerdictCliArgs(augmented);
  } catch (error) {
    return { code: 1, stdout: "", stderr: `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`, ghCallCount };
  }
  const env = { ...process.env, ...options.env, DEVLOOPS_RUN_ID: options.env?.DEVLOOPS_RUN_ID ?? "" };
  delete env[GH_MOCK_ENTRIES];
  // Mirror the subprocess cwd: tests that stage a per-test .devloops pass
  // { cwd: tempDir }, so config (gate angle contract, rejectForeignAngles) must
  // resolve from there rather than the worktree root. Defaults to
  // fanoutDisabledRepoRoot (the worktree's own config, minus fan-out
  // enforcement) rather than the bare worktree root, so a test that does not
  // care about fan-out evidence is not incidentally subject to it.
  const repoRoot = options.cwd ?? fanoutDisabledRepoRoot;
  // Capture stderr the entry fn writes directly (e.g. foreign-angle warnings) so
  // the assembled stderr matches what the CLI subprocess would have emitted.
  const stderrChunks = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, cb) => {
    stderrChunks.push(String(chunk));
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") done();
    return true;
  };
  try {
    const result = await upsertCheckpointVerdict(options_, { env, ghCommand: "gh", repoRoot, runChild });
    process.stderr.write = originalWrite;
    const inlineWarning = buildInlineExecutionWarning(options_.executionMode, options_.inlineReason);
    if (inlineWarning && !options_.silent) {
      stderrChunks.push(`${inlineWarning}\n`);
    }
    return { code: 0, stdout: `${JSON.stringify(result)}\n`, stderr: stderrChunks.join(""), ghCallCount };
  } catch (error) {
    process.stderr.write = originalWrite;
    return {
      code: 1,
      stdout: "",
      stderr: `${stderrChunks.join("")}${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
      ghCallCount,
    };
  }
};

// In-process gh stub: stash the entries on the returned env under GH_MOCK_ENTRIES
// so runNode replays them via makeGhMock. No PATH gh-stub files are written —
// the CLI logic runs in-process and every gh call is answered from `entries`
// (repeatLastOnOverflow mirrors the former PATH stub's sequential semantics).
async function writeGhStub(_tempDir, entries) {
  return { DEVLOOPS_RUN_ID: "", [GH_MOCK_ENTRIES]: entries };
}

function buildGateCoordinationEntries({
  repo = "owner/repo",
  pr = 17,
  headSha = "abc1234000000000000000000000000000000000",
  isDraft = true,
  statusCheckRollup = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
  reviews = [],
  reviewThreadsPayload = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
  issueComments = [],
  body = DEFAULT_TEST_PR_BODY,
}) {
  return [
    {
      assertArgs: ["pr", "view", String(pr), "--repo", repo, "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
      stdout: JSON.stringify({
        number: pr,
        state: "OPEN",
        isDraft,
        headRefOid: headSha,
        body,
        closingIssuesReferences: [],
        reviews,
        statusCheckRollup,
      }) + "\n",
    },
    {
      assertArgs: ["api", `repos/${repo}/pulls/${pr}/requested_reviewers`],
      stdout: '{"users":[],"teams":[]}\n',
    },
    {
      assertArgs: ["api", "graphql", `pr=${pr}`],
      stdout: JSON.stringify(reviewThreadsPayload) + "\n",
    },
    {
      assertArgs: ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid"],
      stdout: JSON.stringify({ headRefOid: headSha }) + "\n",
    },
    {
      assertArgs: ["api", "--paginate", "--slurp", `repos/${repo}/issues/${pr}/comments?per_page=100`],
      stdout: JSON.stringify(issueComments) + "\n",
    },
  ];
}

function buildGateComment({
  gate = "draft_gate",
  headSha = "abc1234000000000000000000000000000000000",
  verdict = "clean",
  findingsSummary = "no issues found",
  nextAction = "mark ready for review",
  commentId = 101,
  pr = 17,
  updatedAt = "2026-05-30T17:00:00Z",
}) {
  return {
    id: commentId,
    body: [
      `### Gate review: \`${gate}\``,
      "",
      `**Reviewed head SHA:** \`${headSha}\``,
      `**Verdict:** ${verdict}`,
      "",
      `**Findings summary:** ${findingsSummary}`,
      "",
      `**Next action:** ${nextAction}`,
    ].join("\n"),
    html_url: `https://github.com/owner/repo/pull/${pr}#issuecomment-${commentId}`,
    updated_at: updatedAt,
  };
}

// #1472: buildCoordinationEvaluatorInput is the exact function
// upsertCheckpointVerdict calls to assemble evaluatePrGateCoordination's
// input — not a re-implementation. Mutation check: replacing
// `coordinationContext.snapshot?.unresolvedThreadCount ?? null` with a
// hardcoded `null` in that function fails this assertion, unlike a test that
// reproduces the object literal independently.
test("buildCoordinationEvaluatorInput threads unresolvedThreadCount from coordinationContext.snapshot (#1472)", () => {
  const coordinationContext = {
    repo: "owner/repo",
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prData: { isDraft: false, state: "OPEN" },
    interpretation: { state: "round_cap_reached", sameHeadCleanConverged: false },
    disposition: { loopDisposition: "blocked" },
    snapshot: { ciStatus: "success", copilotReviewRoundCount: 2, unresolvedThreadCount: 0, copilotReviewRequestStatus: "none" },
    gateEvidence: {
      draftGate: { visible: true, headSha: "29aa40b7", verdict: "clean" },
      draftGateMarker: { visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true },
      preApprovalGate: { visible: false },
      preApprovalGateMarker: { visible: false },
    },
    refinementArtifact: null,
  };
  const input = buildCoordinationEvaluatorInput({
    coordinationContext,
    maxCopilotRounds: 2,
    draftGateConfig: { requireCi: true },
    preApprovalGateConfig: { requireCi: true },
    reviewMode: null,
  });
  assert.equal(input.unresolvedThreadCount, 0);

  const nonZeroContext = { ...coordinationContext, snapshot: { ...coordinationContext.snapshot, unresolvedThreadCount: 4 } };
  const nonZeroInput = buildCoordinationEvaluatorInput({
    coordinationContext: nonZeroContext,
    maxCopilotRounds: 2,
    draftGateConfig: { requireCi: true },
    preApprovalGateConfig: { requireCi: true },
    reviewMode: null,
  });
  assert.equal(nonZeroInput.unresolvedThreadCount, 4);
});

// #1441: buildCoordinationEvaluatorInput is the exact function
// upsertCheckpointVerdict calls to assemble evaluatePrGateCoordination's
// input for the pre_approval_gate verdict that a stranded head-advanced
// Copilot review request deadlocks — the component whose refusal IS the
// reported deadlock. Mirrors the unresolvedThreadCount threading test above.
test("buildCoordinationEvaluatorInput threads postConvergenceReviewSuppressed from coordinationContext (#1441)", () => {
  const coordinationContext = {
    repo: "owner/repo",
    pr: 1460,
    currentHeadSha: "29aa40b7deadbeef",
    prData: { isDraft: false, state: "OPEN" },
    interpretation: { state: "round_cap_reached", sameHeadCleanConverged: false },
    disposition: { loopDisposition: "blocked" },
    snapshot: { ciStatus: "success", copilotReviewRoundCount: 2, unresolvedThreadCount: 0, copilotReviewRequestStatus: "none" },
    gateEvidence: {
      draftGate: { visible: true, headSha: "29aa40b7", verdict: "clean" },
      draftGateMarker: { visible: true, headSha: "29aa40b7", verdict: "clean", contractComplete: true },
      preApprovalGate: { visible: false },
      preApprovalGateMarker: { visible: false },
    },
    refinementArtifact: null,
    postConvergenceReviewSuppressed: true,
  };
  const input = buildCoordinationEvaluatorInput({
    coordinationContext,
    maxCopilotRounds: 2,
    draftGateConfig: { requireCi: true },
    preApprovalGateConfig: { requireCi: true },
    reviewMode: null,
  });
  assert.equal(input.postConvergenceReviewSuppressed, true);

  const unsuppressedContext = { ...coordinationContext, postConvergenceReviewSuppressed: false };
  const unsuppressedInput = buildCoordinationEvaluatorInput({
    coordinationContext: unsuppressedContext,
    maxCopilotRounds: 2,
    draftGateConfig: { requireCi: true },
    preApprovalGateConfig: { requireCi: true },
    reviewMode: null,
  });
  assert.equal(unsuppressedInput.postConvergenceReviewSuppressed, false);

  // A missing field (an older/unrelated coordinationContext shape) must coerce
  // to false rather than leaking `undefined` into the evaluator input.
  const missingFieldContext = { ...coordinationContext };
  delete missingFieldContext.postConvergenceReviewSuppressed;
  const missingFieldInput = buildCoordinationEvaluatorInput({
    coordinationContext: missingFieldContext,
    maxCopilotRounds: 2,
    draftGateConfig: { requireCi: true },
    preApprovalGateConfig: { requireCi: true },
    reviewMode: null,
  });
  assert.equal(missingFieldInput.postConvergenceReviewSuppressed, false);
});

test("parseUpsertCheckpointVerdictCliArgs rejects malformed arguments deterministically", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([]),
    /requires --repo, --pr, --head-sha, --verdict, --findings-summary .* and --next-action/i,
  );

  const parsed = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo",
    "--pr", "17",
    "--gate", "draft_gate",
    "--head-sha", "ABC1234000000000000000000000000000000000",
    "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
    "--findings-summary", "no issues found",
    "--next-action", "mark ready for review",
    "--inline-reason", "tiny docs change",
  ]);
  assert.equal(parsed.headSha, "abc1234000000000000000000000000000000000");

  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "not-a-sha",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ]),
    /FULL head commit SHA|40 or 64 hex/i,
  );
});

test("parseUpsertCheckpointVerdictCliArgs accepts --findings-file without --findings-summary", () => {
  const parsed = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo",
    "--pr", "17",
    "--gate", "draft_gate",
    "--head-sha", "abc1234000000000000000000000000000000000",
    "--verdict", "findings_present",
    "--findings-file", "/tmp/findings.md",
    "--next-action", "stay draft and fix",
    "--inline-reason", "tiny docs change",
  ]);
  assert.equal(parsed.findingsFile, "/tmp/findings.md");
  assert.equal(parsed.findingsSummary, undefined);
  assert.equal(parsed.verdict, "findings_present");
});

test("parseUpsertCheckpointVerdictCliArgs accepts --findings-file with --findings-summary", () => {
  const parsed = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo",
    "--pr", "17",
    "--gate", "draft_gate",
    "--head-sha", "abc1234000000000000000000000000000000000",
    "--verdict", "findings_present",
    "--findings-summary", "fallback text",
    "--findings-file", "/tmp/findings.md",
    "--next-action", "stay draft and fix",
    "--inline-reason", "tiny docs change",
  ]);
  assert.equal(parsed.findingsFile, "/tmp/findings.md");
  assert.equal(parsed.findingsSummary, "fallback text");
});

test("parseUpsertCheckpointVerdictCliArgs rejects --force as a removed policy flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force", "--force-reason", "  CI\ncancelled  "]),
    /--force has been removed/,
  );
});

test("parseUpsertCheckpointVerdictCliArgs rejects --force without --force-reason as removed flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force"]),
    /--force has been removed/,
  );
});

test("parseUpsertCheckpointVerdictCliArgs rejects --force-reason without --force as removed flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force-reason", "CI cancelled due to infra"]),
    /--force-reason has been removed/,
  );
});

test("upsertCheckpointVerdict ignores force/forceReason in programmatic API", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-force-programmatic-"));
  try {
    const { runChild } = makeGhMock([
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ], { repeatLastOnOverflow: true });
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "clean",
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0 },
      findingsSummary: "all good",
      nextAction: "next",
      force: true,
      forceReason: "test",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: fanoutDisabledRepoRoot });
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    // force metadata no longer included
    assert.equal(result.forced, undefined);
    assert.equal(result.forceReason, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test("upsertCheckpointVerdict refuses draft_gate for a tracker-backed draft PR whose linked issue has no AC/DoD (poster agrees with detector)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-tracker-refinement-missing-"));
  try {
    const { env: logEnvRaw } = await writeGhStubHelper(tempDir, [
      {
        assertArgs: ["pr", "view", "50", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({
          number: 50,
          state: "OPEN",
          isDraft: true,
          headRefOid: "abc1234000000000000000000000000000000000",
          mergeStateStatus: "CLEAN",
          body: "Closes #900\n\nTracker-backed PR; see linked issue for spec.",
          closingIssuesReferences: [{ number: 900 }],
          reviews: [],
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        }) + "\n",
      },
      { assertArgs: ["api", "repos/owner/repo/pulls/50/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=50"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "50", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/50/comments?per_page=100"], stdout: "[]\n" },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/50/reviews?per_page=100"], stdout: "[]\n" },
      // No Acceptance criteria / DoD section — the linked issue fails the refinement check.
      { assertArgs: ["issue", "view", "900", "--repo", "owner/repo", "--json", "body"], stdout: JSON.stringify({ body: "## Problem\n\nProse only, no Acceptance criteria or DoD section at all." }) + "\n" },
      { assertArgs: ["pr", "view", "50", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"], stdout: "src/index.ts\n" },
    ], { matchMode: "claims" });
    const env = { ...logEnvRaw, DEVLOOPS_RUN_ID: "" };

    await assert.rejects(
      () => upsertCheckpointVerdict({
        repo: "owner/repo",
        pr: 50,
        gate: "draft_gate",
        headSha: "abc1234000000000000000000000000000000000",
        verdict: "clean",
        findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
      }, { env, repoRoot: tempDir }),
      /missing_refinement_artifact/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseUpsertCheckpointVerdictCliArgs rejects --force with blank --force-reason as removed flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force", "--force-reason", "\n"]),
    /--force has been removed/,
  );
});

test("summarizeCheckpointVerdictText compacts verbose validation success logs deterministically", () => {
  assert.equal(
    summarizeCheckpointVerdictText([
      "Validation: verbose local logs follow",
      "> npm test",
      "ℹ tests 46",
      "ℹ pass 46",
      "ℹ fail 0",
      "GitHub CI test passed on the current head.",
      "stdout: this raw passing output should not appear in the visible gate comment body.",
    ].join("\n")),
    "commands: npm test; tests: 46, pass: 46, fail: 0; ci: GitHub CI test passed on the current head.",
  );
});

test("summarizeCheckpointVerdictText keeps failing validation to a concise excerpt", () => {
  assert.equal(
    summarizeCheckpointVerdictText([
      "> npm test",
      "ℹ tests 46",
      "ℹ pass 45",
      "ℹ fail 1",
      "✖ test/github/upsert-checkpoint-verdict.test.mjs",
      "AssertionError: Expected values to be strictly equal: 1 !== 2",
      "at TestContext.<anonymous> (/tmp/workspace/mfittko/dev-loops/test/github/upsert-checkpoint-verdict.test.mjs:42:10)",
    ].join("\n")),
    "commands: npm test; tests: 46, pass: 45, fail: 1; failure excerpt: test/github/upsert-checkpoint-verdict.test.mjs",
  );
});


test("a long failure/CI excerpt bounds with a plain ellipsis — never the forbidden truncated-marker — in a posted comment", () => {
  // The digest excerpt is lossy-by-design condensation of captured log output;
  // it bounds (not fails closed) so a long error message never blocks posting a
  // findings verdict — but it must NEVER emit the `…[truncated N chars]` marker,
  // which the posted-comment contract forbids from any posted comment.
  const longFailure = `AssertionError: ${"x".repeat(300)}`;
  const summary = summarizeCheckpointVerdictText([
    "> npm test",
    "ℹ fail 1",
    `✖ ${longFailure}`,
  ].join("\n"));
  assert.doesNotMatch(summary, /\[truncated/, "posted excerpt must not carry the forbidden truncated-marker");
  assert.match(summary, /…/, "over-length excerpt is bounded with a plain ellipsis");
  // The excerpt is bounded (not the full 300 chars) yet the whole summary posts.
  assert.ok(summary.length < longFailure.length, "the long line is condensed, not posted verbatim");
});

test("summarizeCheckpointVerdictText fails closed instead of truncating a long single-line narrative", () => {
  // Pre-fix, this rendered `summarized` ending in a `…[truncated N chars]`
  // marker — audit-trail corruption in a posted gate comment. Content over the
  // limit must now fail closed with an actionable error naming the field/limit.
  const narrative = "Passed reviewer note: keep the operator-facing summary readable even when Error and passed appear in the same explanatory sentence, because this is narrative text rather than a multiline validation log. ".repeat(3).trim();
  assert.throws(
    () => summarizeCheckpointVerdictText(narrative, 140),
    /findings summary exceeds 140 chars \(\d+ chars\)/,
  );
});

test("summarizeCheckpointVerdictText renders at-limit content in full with no truncation marker", () => {
  const narrative = "Passed reviewer note: keep the operator-facing summary readable even when Error and passed appear in the same explanatory sentence, because this is narrative text rather than a multiline validation log. ".repeat(3).trim();
  const atLimit = narrative.slice(0, 140);
  const summarized = summarizeCheckpointVerdictText(atLimit, 140);

  assert.equal(summarized, atLimit.trim());
  assert.doesNotMatch(summarized, /…\[truncated/);
});

test("an over-limit posted-comment arg (--inline-reason) fails closed with the usage payload, like every other arg error", () => {
  // enforcePostedCommentLimit throws via parseError (carrying .usage), not a bare
  // Error — so formatCliError renders the same { ok:false, error, usage } envelope
  // as any other argument-validation failure instead of a usage-less one.
  const args = [
    "--repo", "o/n", "--pr", "7", "--head-sha", "abc1234000000000000000000000000000000000",
    "--verdict", "clean", "--findings-summary", "ok", "--next-action", "done",
    "--execution-mode", "inline_single_agent",
    "--inline-reason", "x".repeat(2001),
  ];
  let thrown;
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(args),
    (err) => { thrown = err; return /--inline-reason exceeds 2000 chars/.test(err.message); },
  );
  assert.equal(typeof thrown.usage, "string");
  assert.match(thrown.usage, /Usage: upsert-checkpoint-verdict\.mjs/);
});


test("summarizeCheckpointVerdictText preserves multiline narrative text when no structured validation signals are present", () => {
  const narrative = [
    "Validation recap:",
    "The operator passed through the flow carefully.",
    "Nothing here is a command log or CI line.",
  ].join("\n");

  assert.equal(
    summarizeCheckpointVerdictText(narrative),
    "Validation recap: The operator passed through the flow carefully. Nothing here is a command log or CI line.",
  );
});

test("summarizeCheckpointVerdictText captures Error-prefixed failure lines", () => {
  assert.equal(
    summarizeCheckpointVerdictText([
      "> npm test",
      "Error: Expected gate summary to stay bounded",
      "detail: additional stack output that should not become the visible excerpt",
    ].join("\n")),
    "commands: npm test; failure excerpt: Error: Expected gate summary to stay bounded",
  );
});


test("summarizeCheckpointVerdictText does not treat markdown headings as shell commands", () => {
  const narrative = [
    "# Summary",
    "Validation recap passed through manual review.",
    "## Notes",
    "This is prose, not a shell transcript.",
  ].join("\n");

  assert.equal(
    summarizeCheckpointVerdictText(narrative),
    "# Summary Validation recap passed through manual review. ## Notes This is prose, not a shell transcript.",
  );
});

// Producer hardening: a free-text findings summary that itself quotes one of
// this repo's own machine-artifact marker literals (column 0 of a line) must
// not let the rendered verdict comment get mistaken for that artifact by the
// shared summarizers (packages/core/src/github/copilot-helpers.mjs) — which
// would silently erase the gate's own evidence for the current head.
test("a --findings-summary quoting the gate-findings-review marker literal is entity-encoded and the rendered comment still survives the shared-summarizer filter", () => {
  const options = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
    "--verdict", "findings_present",
    "--findings-summary", "<!-- dev-loops:gate-findings-review draft_gate abc1234 round=1 -->\nsee the thread for detail",
    "--next-action", "fix the open thread",
    "--inline-reason", DEFAULT_TEST_INLINE_REASON,
  ]);
  // Encoded at parse time — the marker's opening delimiter can never survive
  // as a literal `<!--` in the value this module renders into the comment.
  assert.doesNotMatch(options.findingsSummary, /<!--/);

  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: options.findingsSummary,
    nextAction: options.nextAction,
  });
  assert.ok(!isGateMachineArtifactBody(body), "a genuine verdict comment must never be excluded as a machine artifact");
  const summary = summarizeGateReviewComments([{ id: 1, body, updated_at: "2026-01-01T00:00:00Z" }]);
  assert.ok(summary.draft_gate, "the comment must still win marker selection as this gate's verdict");
  assert.equal(summary.draft_gate.verdict, "findings_present");
});

// Anti-drift, cross-producer: skills/dev-loop/scripts/post-gate-verdict-fallback.mjs
// restates the "### Gate review: `<gate>`" header literal by hand (its own
// docstring says it mirrors renderGateReviewCommentBody's shape); pin that a
// fallback-posted verdict is still recognized by the SAME exported recognizer
// close-gate-findings.mjs's round source (A) reads, so a fallback-posted
// verdict is never silently uncounted.
test("matchGateReviewCommentHeader also recognizes post-gate-verdict-fallback.mjs's hand-rendered header", () => {
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "clean",
    findingsSummary: "all clear",
    nextAction: "merge",
  });
  assert.match(body, GATE_REVIEW_COMMENT_HEADER_RE);
  assert.equal(matchGateReviewCommentHeader(body), "draft_gate");
});

// Anti-drift, cross-producer: the fallback poster's own findings-summary/next-action
// render paths must entity-encode the machine-artifact marker delimiters the same way
// the primary producer's encodeMachineArtifactMarkerDelimiters does (see the parity
// test above for --findings-summary), so a findings summary quoting the marker at
// column 0 cannot make a fallback-posted verdict disappear from the evidence scan.
test("a fallback-rendered comment whose findings summary quotes the gate-findings-review marker literal is entity-encoded and still survives the shared-summarizer filter", () => {
  const body = renderFallbackGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "<!-- dev-loops:gate-findings-review draft_gate abc1234 round=1 -->\nsee the thread for detail",
    nextAction: "fix the open thread",
  });
  assert.ok(!isGateMachineArtifactBody(body), "a genuine fallback-posted verdict must never be excluded as a machine artifact");
  const summary = summarizeGateReviewComments([{ id: 1, body, updated_at: "2026-01-01T00:00:00Z" }]);
  assert.ok(summary.draft_gate, "the fallback comment must still win marker selection as this gate's verdict");
  assert.equal(summary.draft_gate.verdict, "findings_present");
});

test("upsert-checkpoint-verdict rejects --force on draft_gate create", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-force-draft-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "Tests pass", "--next-action", "Mark ready for review", "--force", "--force-reason", "CI cancelled due to infrastructure"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects --force on pre_approval_gate create", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-force-preapproval-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "pre_approval_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "Tests pass.", "--findings-severity-counts", JSON.stringify({"must-fix":0,"worth-fixing-now":0}), "--next-action", "Approve and merge", "--force", "--force-reason", "CI cancelled due to infrastructure"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict keeps CI-blocked gate upserts fail-closed", async () => {
  const scenarios = [
    { gate: "draft_gate", isDraft: true, headSha: "abc1234000000000000000000000000000000000", verdict: "clean", findingsSummary: "Tests pass", nextAction: "Mark ready for review", findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0 } },
    { gate: "pre_approval_gate", isDraft: false, headSha: "abc1234000000000000000000000000000000000", verdict: "findings_present", findingsSummary: "CI failed", nextAction: "Fix CI and re-run", findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 1 } },
  ];
  for (const scenario of scenarios) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `dev-loops-upsert-gate-review-fail-closed-${scenario.gate}-`));
    try {
      const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
        isDraft: scenario.isDraft,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
      }));
      const args = ["--repo", "owner/repo", "--pr", "17", "--gate", scenario.gate, "--head-sha", scenario.headSha, "--verdict", scenario.verdict, "--findings-summary", scenario.findingsSummary, "--next-action", scenario.nextAction];
      if (scenario.findingsSeverityCounts) {
        args.push("--findings-severity-counts", JSON.stringify(scenario.findingsSeverityCounts));
      }
      const result = await runNode(args, { env });
      assert.equal(result.code, 1);
      const payload = JSON.parse(result.stderr);
      assert.match(payload.error, /Cannot enter/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
});
test("upsert-checkpoint-verdict --force rejected before update", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-force-update-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "CI green", "--next-action", "merge", "--force", "--force-reason", "CI cancelled"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict --force rejected before noop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-force-noop-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "Tests pass", "--next-action", "merge", "--force", "--force-reason", "CI cancelled"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects --force for non-CI pre_approval_gate refusal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-force-non-ci-preapproval-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "pre_approval_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "findings_present", "--findings-summary", "Some issues", "--next-action", "Fix issues", "--force", "--force-reason", "forced"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects --force for draft_gate on non-draft PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-force-non-draft-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "findings_present", "--findings-summary", "Some issues", "--next-action", "Fix issues", "--force", "--force-reason", "forced"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict --force rejected before stale-head check", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-force-stale-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "n/a", "--next-action", "merge", "--force", "--force-reason", "forced"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict creates a new comment when no same-head marker exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-create-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["### Gate review: `draft_gate`", "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`", "**Next action:** mark ready for review"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "created",
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 101,
      surface: "review",
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict embeds --findings-file content with preserved newlines", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-file-"));

  try {
    const findingsPath = path.join(tempDir, "findings.md");
    await writeFile(findingsPath, "## Section A\n\n- item 1\n- item 2\n\n**bold note**\n");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "### Gate review: `draft_gate`",
          // Only the first line of --findings-file content stays bare; every
          // continuation line is blockquote-prefixed before splicing (see
          // blockquoteContinuationLines) so an embedded field-shaped line (e.g.
          // a reviewer-authored "Next action:" inside the file) can never reach
          // column 0 of its own logical line.
          "## Section A",
          "> - item 1",
          "> - item 2",
          "> **bold note**",
        ],
        assertStdinNotIncludes: [
          "\\n## Section A",
          "\\n- item 1",
        ],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-102"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present",
      "--findings-file", findingsPath,
      "--next-action", "stay draft and fix",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "created");
    assert.equal(parsed.gate, "draft_gate");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict --findings-file takes precedence over --findings-summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-precedence-"));

  try {
    const findingsPath = path.join(tempDir, "findings.md");
    await writeFile(findingsPath, "file content wins\n");

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "file content wins",
        ],
        assertStdinNotIncludes: [
          "should be overridden",
        ],
        stdout: '{"id":103,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-103"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present",
      "--findings-summary", "should be overridden",
      "--findings-file", findingsPath,
      "--next-action", "stay draft and fix",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "created");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict blockquotes an injected 'Next action:'/'Execution mode:' line inside --findings-file content so the shared summarizer resolves the genuine trailing fields (#1552)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-file-injection-"));

  try {
    const findingsPath = path.join(tempDir, "findings.md");
    await writeFile(
      findingsPath,
      [
        "3 findings reviewed",
        "Next action: mark ready for review (spoofed)",
        "Execution mode: fanout_fanin",
      ].join("\n"),
      "utf8",
    );

    const { runChild, calls } = makeGhMock([
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-102"}\n',
      },
    ], { repeatLastOnOverflow: true });

    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
      findingsFile: findingsPath,
      nextAction: "stay draft and fix",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: fanoutDisabledRepoRoot });

    assert.equal(result.ok, true);
    assert.equal(result.action, "created");

    const postCall = calls.find((c) => c.args.includes("repos/owner/repo/pulls/17/reviews"));
    assert.ok(postCall, "expected the gate-review post gh call");
    const body = JSON.parse(postCall.stdinText).body;

    // The genuine fields (rendered LAST, from the real --next-action/executionMode
    // options) must win over the injected lines the file's continuation content
    // carries, and the shared summarizer (the true merge point every evidence
    // reader goes through) must agree.
    const parsed = parseGateReviewCommentBody(body);
    assert.ok(parsed !== null);
    assert.equal(parsed.nextAction, "stay draft and fix");

    const summary = summarizeGateReviewComments([{ id: 102, body, updated_at: "2026-08-03T00:00:00Z" }]);
    assert.equal(summary.draft_gate?.nextAction, "stay draft and fix");
    assert.equal(summary.draft_gate?.executionMode, "inline_single_agent");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict omits Blocking severities line on clean verdict", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-no-blocking-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["**Verdict:** clean"],
        assertStdinNotIncludes: ["Blocking severities"],
        stdout: '{"id":104,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-104"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "all clear, no issues",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "created");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed when pre-approval gate entry is still illegal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-illegal-preapproval-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: '{"number":266,"state":"OPEN","isDraft":false,"headRefOid":"def56789abcdef00000000000000000000000000","reviews":[],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"def56789abcdef00000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 11,
          body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `c94679e`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
          ].join("\n"),
          html_url: "https://github.com/owner/repo/pull/266#issuecomment-11",
          updated_at: "2026-05-31T20:00:00Z",
        }]])}\n`,
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "266",
      "--gate", "pre_approval_gate",
      "--head-sha", "def56789abcdef00000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "await final human approval",
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot enter/);
    assert.match(payload.error, /request Copilot review before any/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

test("upsert-checkpoint-verdict rejects pre_approval_gate when PR is still draft", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-draft-preapproval-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "543", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 543, state: "OPEN", isDraft: true, headRefOid: "f7a611b7234af479000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/543/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=543"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "543", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"f7a611b7234af479000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/543/comments?per_page=100"],
        stdout: '[]\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "543",
      "--gate", "pre_approval_gate",
      "--head-sha", "f7a611b7234af479000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "await final human approval",
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot enter/);
    assert.match(payload.error, /draft_gate.*is now the legal gate boundary/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
});

test("upsert-checkpoint-verdict appends the round-cap fallback note to pre-approval evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-round-cap-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({
          number: 17,
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc1234000000000000000000000000000000000",
          reviews: [
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:00:00Z", commit: { oid: "1111111111111111111111111111111111111111" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:05:00Z", commit: { oid: "2222222222222222222222222222222222222222" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:10:00Z", commit: { oid: "3333333333333333333333333333333333333333" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:15:00Z", commit: { oid: "4444444444444444444444444444444444444444" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:20:00Z", commit: { oid: "5555555555555555555555555555555555555555" } },
          ],
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 91,
          body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
          ].join("\n"),
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          updated_at: "2026-05-31T19:55:00Z",
        }]])}\n`,
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "### Gate review: `pre_approval_gate`",
          "**Findings summary:** no issues found",
          "**Gate evidence note:** Copilot review rounds exhausted (5/2); current head has zero unresolved threads and green CI, so pre_approval_gate fallback is allowed without another Copilot re-request.",
        ],
        // The evidence note must render on its own labeled line — never spliced
        // with `;` into the findings summary (pre-fix render).
        assertStdinNotIncludes: [
          "**Findings summary:** no issues found; Copilot review rounds exhausted",
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "await final human approval",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "created",
      repo: "owner/repo",
      pr: 17,
      gate: "pre_approval_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 101,
      surface: "review",
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict truncates verbose findings summary before comment creation", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-verbose-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: '{"number":17,"state":"OPEN","isDraft":false,"headRefOid":"abc1234000000000000000000000000000000000","reviews":[{"author":{"login":"copilot-pull-request-reviewer"},"state":"COMMENTED","submittedAt":"2026-05-31T20:00:00Z","commit":{"oid":"abc1234000000000000000000000000000000000"}}],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 91,
          body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
          ].join("\n"),
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          updated_at: "2026-05-31T19:55:00Z",
        }]])}\n`,
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "### Gate review: `pre_approval_gate`",
          "**Findings summary:** commands: npm test; tests: 46, pass: 46, fail: 0; ci: GitHub CI test passed on the current head.",
        ],
        assertArgNotContains: ["stdout: this raw passing output should not appear"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", [
        "Validation: verbose local logs follow",
        "> npm test",
        "ℹ tests 46",
        "ℹ pass 46",
        "ℹ fail 0",
        "GitHub CI test passed on the current head.",
        "stdout: this raw passing output should not appear in the visible gate comment body.",
      ].join("\n"),
      "--next-action", "await final human approval",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "created",
      repo: "owner/repo",
      pr: 17,
      gate: "pre_approval_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 101,
      surface: "review",
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict suppresses duplicate repost when the current same-head comment already matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-noop-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "**Execution mode:** inline_single_agent — single-agent inline review (test)",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T17:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: '{"files":[{"path":"src/index.ts"}]}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "noop",
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 101,
      surface: "issue_comment",
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
    // 8 gh calls: pr facts + requested_reviewers + review threads + headRefOid + issue comments + PR reviews + internal-only file check + light-mode facts (baseRefOid,labels) — the repo config enables lightMode, so an inline verdict triggers the #1174 light-fact fetch.
    assert.equal(result.ghCallCount(), 8);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict renders an idempotent body: the same inputs re-parse to the posted fields and a second same-head call is a noop (#1552)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-idempotent-"));
  const headSha = "abc1234000000000000000000000000000000000";
  const inputs = {
    repo: "owner/repo",
    pr: 17,
    gate: "draft_gate",
    headSha,
    verdict: "clean",
    findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
    findingsSummary: "no issues found",
    nextAction: "mark ready for review",
    executionMode: "inline_single_agent",
    inlineReason: "single-agent inline review (test)",
  };

  try {
    // First call: no prior comment, so it renders + posts fresh.
    const { runChild: runChild1, calls: calls1 } = makeGhMock([
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":103,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-103"}\n',
      },
    ], { repeatLastOnOverflow: true });
    const created = await upsertCheckpointVerdict(inputs, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild: runChild1, repoRoot: fanoutDisabledRepoRoot });
    assert.equal(created.action, "created");

    const postCall = calls1.find((c) => c.args.includes("repos/owner/repo/pulls/17/reviews"));
    const postedBody = JSON.parse(postCall.stdinText).body;

    // Re-parsing the posted body recovers exactly the fields that were rendered
    // in — this is what the same-head noop compare (~1517) relies on.
    const reparsed = parseGateReviewCommentBody(postedBody);
    assert.ok(reparsed !== null);
    assert.equal(reparsed.verdict, inputs.verdict);
    assert.equal(reparsed.findingsSummary, inputs.findingsSummary);
    assert.equal(reparsed.nextAction, inputs.nextAction);
    assert.equal(reparsed.executionMode, inputs.executionMode);
    assert.equal(reparsed.inlineReason, inputs.inlineReason);

    // Rendering the SAME inputs again is byte-identical (deterministic render).
    const { runChild: runChild2, calls: calls2 } = makeGhMock([
      ...buildGateCoordinationEntries({
        isDraft: true,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        issueComments: [{ id: 103, body: postedBody, html_url: "https://github.com/owner/repo/pull/17#issuecomment-103", updated_at: "2026-08-03T00:00:00Z" }],
      }),
    ], { repeatLastOnOverflow: true });
    const second = await upsertCheckpointVerdict(inputs, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild: runChild2, repoRoot: fanoutDisabledRepoRoot });
    assert.equal(second.action, "noop");
    assert.equal(second.commentId, 103);
    // Same-head noop means no create/update comment call fires.
    assert.ok(!calls2.some((c) => c.args.includes("repos/owner/repo/pulls/17/reviews")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict updates (not noop) when only the inline reason changed on the same head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-inline-reason-change-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            // Same verdict/summary/nextAction, but a DIFFERENT inline reason than
            // the incoming request. FIX A: this must force an update, not a noop.
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "**Execution mode:** inline_single_agent — stale prior reason",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T17:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: '{"files":[{"path":"src/index.ts"}]}\n',
      },
      {
        assertArgs: ["api", "-X", "PATCH", "repos/owner/repo/issues/comments/101", "-f"],
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Execution mode:** inline_single_agent — single-agent inline review (test)"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "updated");
    assert.equal(parsed.executionMode, "inline_single_agent");
    assert.equal(parsed.inlineReason, "single-agent inline review (test)");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict noop still warns when a stale comment exists on a different head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-noop-warn-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "**Execution mode:** inline_single_agent — single-agent inline review (test)",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T17:00:00Z",
          },
          {
            id: 202,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `def5678000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** older review",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-202",
            updated_at: "2026-05-30T18:00:00Z",
          },
        ])}\n`,
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "noop");
    assert.equal(parsed.headSha, "abc1234000000000000000000000000000000000");
    assert.match(parsed.warning, /different head SHA/i);
    assert.match(parsed.warning, /def5678000000000000000000000000000000000/);
    assert.match(parsed.warning, /comment 202/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict updates an incomplete same-head marker in place", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-update-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T17:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "-X", "PATCH", "repos/owner/repo/issues/comments/101", "-f"],
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Findings summary:** no issues found"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "updated",
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 101,
      surface: "issue_comment",
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict updates the current same-head marker even when another head has a newer marker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-current-head-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T17:00:00Z",
          },
          {
            id: 202,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `def5678000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** later head marker",
            "",
            "**Next action:** rerun gate",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-202",
            updated_at: "2026-05-30T18:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "-X", "PATCH", "repos/owner/repo/issues/comments/101", "-f"],
        assertArgContains: ["**Reviewed head SHA:** `abc1234000000000000000000000000000000000`", "**Findings summary:** fixed the marker for the current head"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "ABC1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "fixed the marker for the current head",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "updated",
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 101,
      surface: "issue_comment",
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      warning: "A gate comment for \`draft_gate\` already exists on a different head SHA \`def5678000000000000000000000000000000000\` (comment 202). The old comment is stale for the current head.",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict prefers the latest same-head marker when it differs from the older strict summary", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-latest-marker-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** already complete",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T17:00:00Z",
          },
          {
            id: 202,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-202",
            updated_at: "2026-05-30T18:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "-X", "PATCH", "repos/owner/repo/issues/comments/202", "-f"],
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`", "**Findings summary:** corrected the newer malformed marker"],
        stdout: '{"id":202,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-202"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "corrected the newer malformed marker",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "updated",
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      currentHeadSha: "abc1234000000000000000000000000000000000",
      commentId: 202,
      surface: "issue_comment",
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-202",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["high"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed on an abbreviated --head-sha (no more current-head expansion; the primary head-sha must be FULL)", async () => {
  const result = await runNode([
    "--repo", "owner/repo",
    "--pr", "17",
    "--gate", "draft_gate",
    "--head-sha", "ABCDEF1",
    "--verdict", "clean",
    "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
    "--findings-summary", "no issues found",
    "--next-action", "mark ready for review",
  ]);

  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /FULL head commit SHA|40 or 64 hex/i);
});

test("upsert-checkpoint-verdict fails closed when the requested head SHA is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-stale-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "def5678000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"def5678000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not match the current PR head SHA/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict warns when a gate comment exists on a different head SHA", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-warn-stale-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "def5678000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"def5678000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 99,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** previous review",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-99",
            updated_at: "2026-05-30T17:00:00Z",
          },
        ])}\n`,
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-102"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "def5678000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "created");
    assert.equal(parsed.gate, "draft_gate");
    assert.equal(parsed.headSha, "def5678000000000000000000000000000000000");
    assert.match(parsed.warning, /different head SHA/i);
    assert.match(parsed.warning, /abc1234000000000000000000000000000000000/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict treats stale clean draft_gate evidence on a non-draft PR as an idempotent no-op (#891)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-draft-forbidden-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: '{"number":266,"state":"OPEN","isDraft":false,"headRefOid":"def56789abcdef00000000000000000000000000","reviews":[],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"def56789abcdef00000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 11,
          body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `c94679e`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
          ].join("\n"),
          html_url: "https://github.com/owner/repo/pull/266#issuecomment-11",
          updated_at: "2026-05-31T20:00:00Z",
        }]])}\n`,
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "266",
      "--gate", "draft_gate",
      "--head-sha", "def56789abcdef00000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    // The PR already carries clean draft_gate evidence (on an earlier head). The
    // draft gate is a one-time boundary and the pre-merge check accepts any-head
    // clean draft evidence, so re-posting is an idempotent no-op rather than a
    // hard failure. (#891)
    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "noop");
    assert.equal(payload.draftGateAlreadySatisfied, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects clean verdict when unresolved blocking-severity findings remain", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-blocking-"));

  try {
    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "reviewed: 2 must-fix, 1 worth-fixing-now",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":2,"worth-fixing-now":1,"nice-to-have":0}',
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot set verdict "clean"/);
    // draft_gate blocks on high only (medium is recorded but
    // non-blocking here); assert the exact bracketed list so this fails if
    // medium ever becomes blocking again for draft_gate.
    assert.match(payload.error, /blocking severities \[high\]\./);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict allows clean verdict when no blocking-severity findings remain", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-clean-ok-"));

  try {
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({
        isDraft: true,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["### Gate review: `draft_gate`", "**Verdict:** clean"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "0 must-fix; 1 worth-fixing-now recorded (non-blocking), 1 defer",
      "--next-action", "mark ready for review",
      // draft_gate blocks on must-fix only: a non-zero worth-fixing-now count
      // (like the non-zero defer count) must not block a clean verdict.
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":1,"nice-to-have":1}',
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, "created");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});



// The clean-verdict guard trusts --findings-severity-counts alone, so a
// hand-typed all-zero counts object — the exact placeholder the docs warn
// against — must not unblock a clean verdict when --findings-json's own
// per-angle findings carry a blocking severity. Cross-checked directly
// against the parsed findings, independent of what --findings-severity-counts
// claims.
test("upsert-checkpoint-verdict rejects a clean verdict whose --findings-json carries must-fix findings even when --findings-severity-counts is all-zero", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-findings-json-mismatch-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "correctness", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "off-by-one" }] },
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }));

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot set verdict "clean"/);
    assert.match(payload.error, /findings-json.*own per-angle findings show unresolved findings/);
    assert.match(payload.error, /high/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict allows a clean verdict whose --findings-json is genuinely all-clean, matching an all-zero --findings-severity-counts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-findings-json-match-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "correctness", verdict: "clean", findings: [] },
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({
        isDraft: true,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["**Verdict:** clean"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The clean-verdict cross-check's actual boundary is the blockCleanOnFindingSeverities
// filter, not "any findings at all" — a clean verdict whose --findings-json carries
// only NON-blocking (defer) findings is a sanctioned combination and must still be
// allowed. This pins the mid-range case between "must-fix present (reject)" and
// "zero findings (allow)" above.
test("upsert-checkpoint-verdict allows a clean verdict whose --findings-json carries only non-blocking (defer) findings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-findings-json-defer-only-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "correctness", verdict: "findings_present", findings: [{ severity: "nice-to-have", summary: "nice-to-have cleanup" }] },
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({
        isDraft: true,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["**Verdict:** clean"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":1}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The cross-check's "unresolved" boundary is disposition, not bare severity:
// the sub-loop contract's clean criterion is "no findings with a blocking
// severity REMAIN", and "operator_acknowledged"/"disputed" are the sanctioned
// vocabulary (write-gate-findings-log.mjs's VALID_DISPOSITIONS) for a
// blocking-severity finding the fix cycle/operator has already closed out
// without changing its severity. A clean verdict whose only blocking-severity
// --findings-json entry carries that disposition must still be postable.
test("upsert-checkpoint-verdict allows a clean verdict whose only blocking-severity --findings-json finding is operator_acknowledged", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-findings-json-ack-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "known limitation", disposition: "operator_acknowledged" }],
        },
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({
        isDraft: true,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["**Verdict:** clean"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The resolved-disposition set is closed: "deferred" (the value
// consolidateFanin derives for a finding outside ITS OWN blocking-severity
// set, independent of the posting gate's blockCleanOnFindingSeverities) is
// NOT a resolution, and neither is an unrecognized/typo'd string. Either
// must still count as an unresolved blocking finding, or a --gate-less
// fan-in run (or a hand-typed --findings-json) could silently defeat the
// cross-check the same way an all-zero --findings-severity-counts did.
test("upsert-checkpoint-verdict rejects a clean verdict whose only blocking-severity --findings-json finding carries disposition deferred", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-findings-json-deferred-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "off-by-one", disposition: "deferred" }],
        },
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }));

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /own per-angle findings show unresolved findings/);
    assert.match(payload.error, /high/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects a clean verdict whose only blocking-severity --findings-json finding carries an unrecognized disposition", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-findings-json-unknown-disp-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "off-by-one", disposition: "wontfix" }],
        },
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }));

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /own per-angle findings show unresolved findings/);
    assert.match(payload.error, /high/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects clean verdict when --findings-severity-counts is missing and blocking severities are configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-missing-counts-"));

  try {
    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "reviewed",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot set verdict "clean"/);
    assert.match(payload.error, /--findings-severity-counts is required/);
    // The error text embeds a static example payload alongside the
    // config-derived "(blocking: [...])" tail; assert the tail, which is
    // the part that actually reflects draft_gate's configured blocking set
    // (high only — medium would match the example text
    // regardless of what is configured).
    assert.match(payload.error, /\(blocking: \[high\]\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects clean verdict when --findings-severity-counts omits a blocking severity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-missing-key-"));

  try {
    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "all clear",
      "--next-action", "mark ready",
      // draft_gate blocks on high only, so omitting high (not
      // medium) is what exercises "missing a blocking key" here. Legacy
      // spellings as input (backward compat): still normalize correctly.
      "--findings-severity-counts", '{"worth-fixing-now":0,"nice-to-have":0}',
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /must include explicit counts for all configured blocking severities/);
    assert.match(payload.error, /high/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict treats draft_gate as an idempotent no-op when already satisfied (#891)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-already-satisfied-"));

  try {
    // Simulate a non-draft PR with an existing clean draft_gate comment. The draft
    // gate is a one-time boundary already passed; the pre-merge check accepts this
    // evidence, so re-posting must be an idempotent no-op (not a hard error that
    // dead-ends scripted callers). (#891)
    const cleanDraftGateComment = {
      id: 101,
      body: [
        "### Gate review: `draft_gate`",
        "",
        "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
        "**Verdict:** clean",
        "",
        "**Findings summary:** no issues found",
        "",
        "**Next action:** mark ready for review",
      ].join("\n"),
      html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
      updated_at: "2026-05-30T17:00:00Z",
    };

    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: false,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      issueComments: [cleanDraftGateComment],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
    ], { env });

    assert.equal(result.code, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "noop");
    assert.equal(payload.draftGateAlreadySatisfied, true);
    assert.equal(payload.gate, "draft_gate");
    assert.match(payload.reason, /already satisfied/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict does NOT convert a ready PR to draft when reconcile is not the allowed action (#891 narrowing)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-no-self-heal-"));

  try {
    // The self-heal draft→post→ready transition must fire ONLY when coordination
    // allows RECONCILE_DRAFT_GATE — NOT for every ready PR where RUN_DRAFT_GATE is
    // forbidden. Here the PR is ready and the post-draft external review cycle has
    // not started (REQUEST_COPILOT_REVIEW), so the poster must refuse WITHOUT
    // converting the PR to draft. Guards against wrongly drafting blocked /
    // waiting-for-CI / unresolved-feedback / review-pending PRs. (#891, Copilot review)
    const { env: logEnvRaw } = await writeGhStubHelper(tempDir, [
      ...buildGateCoordinationEntries({
        isDraft: false,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        issueComments: [],
      }),
    ], { repeatLastOnOverflow: true, logCalls: true });
    const env = { ...logEnvRaw, DEVLOOPS_RUN_ID: "" };

    await assert.rejects(
      () => upsertCheckpointVerdict({
        repo: "owner/repo",
        pr: 17,
        gate: "draft_gate",
        headSha: "abc1234000000000000000000000000000000000",
        verdict: "clean",
        findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        executionMode: "fanout_fanin",
      }, { env, repoRoot: tempDir }),
      /Cannot enter|post-draft external review|request Copilot review/i,
    );

    // Critical: the PR must NOT have been converted to draft, and must NOT have been
    // re-marked ready — no draft-state toggle may happen in a non-reconcile state.
    const ghLog = await readFile(path.join(tempDir, "gh-log.jsonl"), "utf8");
    assert.ok(!/convertPullRequestToDraft/.test(ghLog), "must not convert the PR to draft");
    assert.ok(!/\["pr","ready"/.test(ghLog.replace(/\s/g, "")), "must not mark the PR ready");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict self-heals a ready PR via draft transition, preserving fanout_fanin (#891)", async () => {
  // POSITIVE regression for the self-heal `postDraftGateViaDraftTransition` path: a
  // converged READY (non-draft) PR with clean current-head pre_approval_gate evidence
  // but NO clean draft_gate evidence yields coordination state RECONCILE_DRAFT_GATE.
  // The poster must convert the PR back to draft, post the draft_gate verdict
  // (preserving executionMode fanout_fanin, NOT collapsing to inline), then re-mark
  // the PR ready, and report draftTransition: true. (#891)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-self-heal-transition-"));

  try {
    const headSha = "abc1234000000000000000000000000000000000";
    // A clean pre_approval_gate comment on the current head — combined with a
    // submitted Copilot review on the current head and zero unresolved threads,
    // this drives interpretation to ready_to_rerequest_review +
    // sameHeadCleanConverged, which evaluatePrGateCoordination resolves to
    // RECONCILE_DRAFT_GATE because no clean draft_gate evidence exists.
    const cleanPreApprovalComment = {
      id: 501,
      body: [
        "### Gate review: `pre_approval_gate`",
        "",
        "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
        "**Verdict:** clean",
        "**Execution mode:** fanout_fanin",
        "",
        "**Findings summary:** no issues found",
        "",
        "**Next action:** await final human approval",
      ].join("\n"),
      html_url: "https://github.com/owner/repo/pull/17#issuecomment-501",
      updated_at: "2026-05-30T17:00:00Z",
    };
    const copilotReviewOnHead = {
      id: 1,
      author: { login: "copilot-pull-request-reviewer" },
      state: "COMMENTED",
      submittedAt: "2026-05-30T16:00:00Z",
      commit: { oid: headSha },
    };
    const prFacts = (isDraft) => JSON.stringify({
      number: 17,
      state: "OPEN",
      isDraft,
      headRefOid: headSha,
      body: DEFAULT_TEST_PR_BODY,
      closingIssuesReferences: [],
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      reviews: [copilotReviewOnHead],
    }) + "\n";

    // Claims-mode (order-independent) matching across the TWO coordination passes:
    // pass 1 sees isDraft:false (yields reconcile); after convertPullRequestToDraft
    // the recursive post re-enters and pass 2 sees isDraft:true (posts normally).
    // Each entry has specific assertArgs so claims selection is unambiguous, and the
    // duplicated coordination calls supply isDraft:false first, then isDraft:true.
    const { env: logEnvRaw, ghLogPath } = await writeGhStubHelper(tempDir, [
      // --- coordination pass 1 (isDraft: false → reconcile) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(false) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- resolve PR node id + convert to draft ---
      { assertArgs: ["api", "graphql", "name=repo", "number=17"], stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_node","isDraft":false}}}}\n' },
      { assertArgs: ["api", "graphql", "pullRequestId=PR_node"], stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_node","isDraft":true}}}}\n' },
      // --- coordination pass 2 (isDraft: true → posts normally) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(true) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- post the draft_gate verdict + restore ready ---
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        // The posted draft_gate review must carry the fanout_fanin execution
        // mode, proving the caller's mode is preserved across the recursive
        // re-entry. The body travels on stdin (`--input -`), so it is pinned
        // here rather than through the args-only gh log below.
        assertStdinIncludes: ["Gate review: `draft_gate`", "**Execution mode:** fanout_fanin"],
        stdout: '{"id":900,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-900"}\n',
      },
      { assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"], stdout: "{}\n" },
    ], { matchMode: "claims", logCalls: true });
    const env = { ...logEnvRaw, DEVLOOPS_RUN_ID: "" };

    // draft_gate configures a mandatory angle (pr-description); a fanout_fanin
    // verdict now requires coverage proof rather than a bare findingsSummary —
    // this test is about the draft-transition self-heal mechanism, not angle
    // coverage, so findingsJson is the minimal covering shape.
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(findingsPath, JSON.stringify([{ angle: "pr-description", verdict: "clean", findings: [] }]), "utf8");
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha,
      verdict: "clean",
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
      findingsJson: findingsPath,
      nextAction: "mark ready for review",
      executionMode: "fanout_fanin",
    }, { env, repoRoot: tempDir });

    // The verdict was posted via the transition, with fanout_fanin preserved.
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    assert.equal(result.gate, "draft_gate");
    assert.equal(result.executionMode, "fanout_fanin");
    assert.equal(result.draftTransition, true);
    assert.equal(result.commentId, 900);

    const ghLog = await readFile(ghLogPath, "utf8");
    // The PR was converted to draft, then re-marked ready (the full transition).
    assert.ok(/convertPullRequestToDraft/.test(ghLog), "expected a convertPullRequestToDraft mutation");
    assert.ok(/\["pr","ready","17"/.test(ghLog.replace(/\s/g, "")), "expected a `pr ready` call to restore the ready state");
    // The posted review itself (event, endpoint, and the fanout_fanin body) is
    // pinned by the review-POST stub entry's assertStdinIncludes above — the gh
    // log records args only, and the body now travels on stdin.
    assert.ok(/pulls\/17\/reviews/.test(ghLog), "expected a draft_gate verdict review to be posted");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed (no unbounded recursion) when the draft-state read lags the conversion mutation (#1020)", async () => {
  // REGRESSION for the #1020 hang: `postDraftGateViaDraftTransition` converts a ready
  // PR to draft, then re-enters upsertCheckpointVerdict to post the draft_gate verdict.
  // If GitHub's draft-state read lags the conversion (isDraft still reads FALSE on
  // re-entry — a race / eventual-consistency), the reconcile branch previously fired
  // AGAIN, re-converting and re-entering without bound → indefinite recursion, eventual
  // Node exit 13 with the error swallowed. The recursion guard must short-circuit the
  // re-entry and surface a CLEAR error instead of recursing. (#1020)
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-draft-race-"));

  try {
    const headSha = "abc1234000000000000000000000000000000000";
    const cleanPreApprovalComment = {
      id: 501,
      body: [
        "### Gate review: `pre_approval_gate`",
        "",
        "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
        "**Verdict:** clean",
        "**Execution mode:** fanout_fanin",
        "",
        "**Findings summary:** no issues found",
        "",
        "**Next action:** await final human approval",
      ].join("\n"),
      html_url: "https://github.com/owner/repo/pull/17#issuecomment-501",
      updated_at: "2026-05-30T17:00:00Z",
    };
    const copilotReviewOnHead = {
      id: 1,
      author: { login: "copilot-pull-request-reviewer" },
      state: "COMMENTED",
      submittedAt: "2026-05-30T16:00:00Z",
      commit: { oid: headSha },
    };
    const prFacts = (isDraft) => JSON.stringify({
      number: 17,
      state: "OPEN",
      isDraft,
      headRefOid: headSha,
      body: DEFAULT_TEST_PR_BODY,
      closingIssuesReferences: [],
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      reviews: [copilotReviewOnHead],
    }) + "\n";

    // Both coordination passes report isDraft:false — pass 2 (the re-entry) simulates
    // the lagged draft-state read. If the guard were absent, the poster would try to
    // convert to draft again and re-enter a THIRD time; providing only ONE convert
    // entry means a recursing implementation would exhaust the stub and fail loudly on
    // the WRONG error. The guard must instead throw the clear #1020 self-heal error
    // BEFORE any second conversion. `pr ready` is provided so a best-effort restore in
    // the catch path (conversion.alreadyDraft !== true) is satisfied.
    const { env: logEnvRaw, ghLogPath } = await writeGhStubHelper(tempDir, [
      // --- coordination pass 1 (isDraft: false → reconcile) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(false) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- resolve PR node id + convert to draft (ONLY ONCE) ---
      { assertArgs: ["api", "graphql", "name=repo", "number=17"], stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_node","isDraft":false}}}}\n' },
      { assertArgs: ["api", "graphql", "pullRequestId=PR_node"], stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_node","isDraft":true}}}}\n' },
      // --- coordination pass 2 (LAGGED read: isDraft STILL false → must NOT recurse) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(false) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- best-effort restore to ready after the guarded failure ---
      { assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"], stdout: "{}\n" },
    ], { matchMode: "claims", logCalls: true });
    const env = { ...logEnvRaw, DEVLOOPS_RUN_ID: "" };

    await assert.rejects(
      () => upsertCheckpointVerdict({
        repo: "owner/repo",
        pr: 17,
        gate: "draft_gate",
        headSha,
        verdict: "clean",
        findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "nice-to-have": 0 },
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        executionMode: "fanout_fanin",
      }, { env, repoRoot: tempDir }),
      (error) => {
        // Clear, actionable message — not a swallowed hang.
        assert.match(error.message, /still reports it as non-draft on re-entry/);
        assert.match(error.message, /Not recursing/);
        return true;
      },
    );

    // Exactly ONE conversion to draft — proving no unbounded re-conversion loop.
    const ghLog = await readFile(ghLogPath, "utf8");
    const conversions = (ghLog.match(/convertPullRequestToDraft/g) || []).length;
    assert.equal(conversions, 1, "expected exactly one convertPullRequestToDraft (no recursion loop)");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict CLI posts the draft_gate self-heal verdict instead of hanging on an unsettled top-level await (#1455)", async () => {
  // REGRESSION for #1455: this must run as a REAL CLI subprocess (real spawn,
  // real `import.meta.url` top-level `await main()`), NOT the in-process
  // makeGhMock harness the local `runNode` helper in this file uses for most
  // tests — the bug only manifests when upsert-checkpoint-verdict.mjs is itself
  // the ESM entry point.
  //
  // Root cause: postDraftGateViaDraftTransition dynamically imported
  // "./reconcile-draft-gate.mjs", which statically imports upsertCheckpointVerdict
  // BACK from this very file — a circular module reference. When this file is the
  // CLI entry point (still suspended on its own top-level `await main()`), that
  // dynamic import of a module which circularly re-imports the still-evaluating
  // entry module deadlocks Node's ESM linker: the import() promise never settles,
  // main() never returns, and the process exits 13 with "Detected unsettled
  // top-level await" — WITHOUT posting the gate verdict comment.
  //
  // Repro shape (exact): a ready (non-draft) PR with NO prior draft_gate marker,
  // clean pre_approval_gate evidence on the current head (drives coordination to
  // RECONCILE_DRAFT_GATE), `--gate draft_gate`, `--execution-mode
  // inline_single_agent`, current head SHA, and a real (non-empty) run id (the
  // production default this file's tests otherwise set to "" — see the `runNode`
  // helper above — which happens to also skip the unrelated verifyComment path).
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-1455-unsettled-await-"));

  try {
    // This test's cwd IS the CLI's repoRoot (real subprocess spawn), so its
    // resolved config is otherwise bare defaults — disable fan-out evidence
    // enforcement explicitly; this repro is about the draft-transition
    // self-heal deadlock, not fan-out evidence.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const headSha = "abc1234000000000000000000000000000000000";
    const cleanPreApprovalComment = {
      id: 501,
      body: [
        "### Gate review: `pre_approval_gate`",
        "",
        `**Reviewed head SHA:** \`${headSha}\``,
        "**Verdict:** clean",
        "**Execution mode:** inline_single_agent",
        "",
        "**Findings summary:** no issues found",
        "",
        "**Next action:** await final human approval",
      ].join("\n"),
      html_url: "https://github.com/owner/repo/pull/17#issuecomment-501",
      updated_at: "2026-05-30T17:00:00Z",
    };
    const copilotReviewOnHead = {
      id: 1,
      author: { login: "copilot-pull-request-reviewer" },
      state: "COMMENTED",
      submittedAt: "2026-05-30T16:00:00Z",
      commit: { oid: headSha },
    };
    const prFacts = (isDraft) => JSON.stringify({
      number: 17,
      state: "OPEN",
      isDraft,
      headRefOid: headSha,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      body: DEFAULT_TEST_PR_BODY,
      title: "Test PR",
      closingIssuesReferences: [],
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      reviews: [copilotReviewOnHead],
    }) + "\n";

    const { env, ghLogPath } = await writeGhStubHelper(tempDir, [
      // --- coordination pass 1 (isDraft: false -> reconcile) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(false) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: JSON.stringify({ headRefOid: headSha }) + "\n" },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"], stdout: "src/index.ts\n" },
      // --- resolve PR node id + convert to draft (the self-heal transition) ---
      { assertArgs: ["api", "graphql", "name=repo", "number=17"], stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_node","isDraft":false}}}}\n' },
      { assertArgs: ["api", "graphql", "pullRequestId=PR_node"], stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_node","isDraft":true}}}}\n' },
      // --- coordination pass 2 (isDraft: true -> posts normally) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(true) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: JSON.stringify({ headRefOid: headSha }) + "\n" },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"], stdout: "src/index.ts\n" },
      // --- post the draft_gate verdict + post-creation verify + restore ready ---
      { assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"], stdout: '{"id":900,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-900"}\n' },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/reviews/900"], stdout: '{"id":900}\n' },
      { assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"], stdout: "{}\n" },
    ], { matchMode: "claims", logCalls: true });
    // A real (non-empty) run id — the production default — activates the
    // post-creation verifyComment call above; it is orthogonal to the deadlock
    // but matches the reported repro shape exactly.
    env.DEVLOOPS_RUN_ID = "test-run-1455-real";

    const result = await runNodeHelper(scriptPath, [
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", headSha,
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--execution-mode", "inline_single_agent",
      "--inline-reason", "single-agent inline review (test)",
    ], { env, cwd: tempDir });

    // Pre-fix this exits 13 with "Detected unsettled top-level await" on stderr
    // and empty stdout (no comment posted). Fixed: exits 0 with the created
    // comment in the JSON envelope.
    assert.equal(result.code, 0, `expected exit 0, got ${result.code}. stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/i);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "created");
    assert.equal(payload.gate, "draft_gate");
    assert.equal(payload.draftTransition, true);
    assert.equal(payload.commentId, 900);

    const ghLog = await readFile(ghLogPath, "utf8");
    assert.ok(/convertPullRequestToDraft/.test(ghLog), "expected a convertPullRequestToDraft mutation");
    assert.ok(/\["pr","ready","17"/.test(ghLog.replace(/\s/g, "")), "expected a `pr ready` call to restore the ready state");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict already-satisfied no-op sources executionMode from the gate marker (#891 review)", async () => {
  // The already-satisfied no-op must source executionMode from the gate MARKER
  // summary (which carries executionMode), not the strict COMMENT summary (which
  // has none and would always collapse to inline_single_agent). Here the existing
  // clean draft_gate evidence is on the current head and was recorded fanout_fanin,
  // so the no-op must report fanout_fanin — not a misleading inline default.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-satisfied-marker-execmode-"));

  try {
    const fanoutDraftGateComment = {
      id: 101,
      body: renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "abc1234000000000000000000000000000000000",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        executionMode: "fanout_fanin",
      }),
      html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
      updated_at: "2026-05-30T17:00:00Z",
    };

    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: false,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      issueComments: [fanoutDraftGateComment],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "noop");
    assert.equal(payload.draftGateAlreadySatisfied, true);
    // Marker-sourced: fanout_fanin preserved, NOT the misleading inline default.
    assert.equal(payload.executionMode, "fanout_fanin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict already-satisfied no-op OMITS executionMode when no current-head marker exists (#891 review)", async () => {
  // When the satisfied clean draft_gate evidence is on a STALE head (the draft gate
  // is a one-time boundary accepted on any head), no current-head marker exists, so
  // the marker summary carries no executionMode. Rather than report a misleading
  // inline_single_agent default, the no-op must OMIT the executionMode field.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-satisfied-no-marker-"));

  try {
    // Clean draft_gate evidence on a DIFFERENT (stale) head than the request's head.
    const staleHeadDraftGateComment = {
      id: 101,
      body: renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "0000aaa",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        executionMode: "fanout_fanin",
      }),
      html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
      updated_at: "2026-05-30T17:00:00Z",
    };

    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: false,
      headSha: "abc1234000000000000000000000000000000000",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      issueComments: [staleHeadDraftGateComment],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "noop");
    assert.equal(payload.draftGateAlreadySatisfied, true);
    // No current-head marker → executionMode omitted (not a misleading default).
    assert.equal("executionMode" in payload, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict skips Copilot convergence requirement for internal-only PRs", async () => {
  // Root cause 2 fix: when all changed files are internal tooling (scripts/docs/tests/config),
  // the Copilot review cycle is suppressed and pre_approval_gate may be posted directly.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-internal-only-"));

  try {
    const cleanDraftGateComment = buildGateComment({
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "clean",
      findingsSummary: "no issues found",
      nextAction: "mark ready for review",
      commentId: 101,
    });

    const env = await writeGhStub(tempDir, [
      // Standard 5 coordination entries (non-draft PR, successful CI, no Copilot reviews, clean draft gate)
      ...buildGateCoordinationEntries({
        isDraft: false,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [],
        issueComments: [cleanDraftGateComment],
      }),
      // Call 6: PR reviews fetch — no gate comment posted as a review
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: "[]\n",
      },
      // Call 7: internal-only file check — all files match scripts/ pattern → internalOnly: true
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "scripts/github/my-internal-script.mjs\n",
      },
      // Call 8: create the pre_approval_gate comment
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":200,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-200"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "await final human approval",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "created");
    assert.equal(payload.gate, "pre_approval_gate");
    assert.equal(payload.commentId, 200);
    assert.equal(payload.commentUrl, "https://github.com/owner/repo/pull/17#pullrequestreview-200");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict performs stale-runner takeover before gate coordination", async () => {
  // Root cause 1 fix: when a previous run owns the coordination file but is stale,
  // the new run takes over ownership rather than being rejected.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-stale-takeover-"));

  try {
    // This test's cwd IS the CLI's repoRoot (real subprocess spawn); disable
    // fan-out evidence enforcement — this test is about stale-runner takeover,
    // not fan-out evidence.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    // Pre-claim ownership with an old timestamp so the runner is considered stale
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "old-run-id",
      cwd: tempDir,
      now: "2020-01-01T00:00:00.000Z",
    });

    const { env: ghEnv } = await writeGhStubHelper(tempDir, [
      // Standard 5 coordination entries: draft PR, no existing gate comments
      ...buildGateCoordinationEntries({
        isDraft: true,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [],
        issueComments: [],
      }),
      // Call 6: PR reviews fetch — no reviews
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: "[]\n",
      },
      // Call 7: internal-only file check — consumer-facing file, reviewMode stays null
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      // Call 8: create the draft_gate comment
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":300,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-300"}\n',
      },
    ], { repeatLastOnOverflow: true });

    // Run with the new run ID — old-run-id owned the file but is stale, so takeover should happen
    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], {
      cwd: tempDir,
      env: { ...ghEnv, DEVLOOPS_RUN_ID: "new-run-id" },
    });

    // The command should succeed (not fail with ownership_lost) because the stale runner was taken over.
    // Without the fix, this would fail: "active run is old-run-id, current run is new-run-id".
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "created");
    assert.equal(payload.gate, "draft_gate");
    assert.equal(payload.commentId, 300);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("parseUpsertCheckpointVerdictCliArgs defaults executionMode and validates the flag", () => {
  const base = ["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "go", "--findings-severity-counts", '{"must-fix":0}'];

  // Inline is the default mode and now REQUIRES --inline-reason: a bare call
  // with neither --execution-mode nor --inline-reason errors (FIX B).
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(base),
    /--inline-reason is required for executionMode inline_single_agent/i,
  );

  // Explicit inline_single_agent without a reason still errors.
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([...base, "--execution-mode", "inline_single_agent"]),
    /--inline-reason is required for executionMode inline_single_agent/i,
  );

  const def = parseUpsertCheckpointVerdictCliArgs([...base, "--inline-reason", "tiny docs change"]);
  assert.equal(def.executionMode, "inline_single_agent");
  assert.equal(def.inlineReason, "tiny docs change");

  const inline = parseUpsertCheckpointVerdictCliArgs([...base, "--execution-mode", "inline_single_agent", "--inline-reason", "tiny docs change"]);
  assert.equal(inline.executionMode, "inline_single_agent");
  assert.equal(inline.inlineReason, "tiny docs change");

  // fanout_fanin does NOT require a reason.
  const fanoutNoReason = parseUpsertCheckpointVerdictCliArgs([...base, "--execution-mode", "fanout_fanin"]);
  assert.equal(fanoutNoReason.executionMode, "fanout_fanin");
  assert.equal(fanoutNoReason.inlineReason, undefined);

  // fanout_fanin drops any inline reason.
  const fanout = parseUpsertCheckpointVerdictCliArgs([...base, "--execution-mode", "fanout_fanin", "--inline-reason", "ignored"]);
  assert.equal(fanout.executionMode, "fanout_fanin");
  assert.equal(fanout.inlineReason, undefined);

  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([...base, "--execution-mode", "bogus"]),
    /--execution-mode must be one of: fanout_fanin, inline_single_agent/i,
  );
});

test("parseUpsertCheckpointVerdictCliArgs fails closed instead of truncating an over-limit --inline-reason (#1388)", () => {
  const base = ["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "go"];
  const overLimitReason = "x".repeat(2001);
  // Pre-fix, this silently truncated to 120 chars with a `…[truncated N chars]`
  // marker spliced into the posted `**Execution mode:**` line.
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([...base, "--inline-reason", overLimitReason]),
    /--inline-reason exceeds 2000 chars \(2001 chars\)/,
  );
});

test("parseUpsertCheckpointVerdictCliArgs accepts an at-limit --inline-reason in full with no truncation marker (#1388)", () => {
  const base = ["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "go"];
  const atLimitReason = "x".repeat(2000);
  const options = parseUpsertCheckpointVerdictCliArgs([...base, "--inline-reason", atLimitReason]);
  assert.equal(options.inlineReason, atLimitReason);
  assert.doesNotMatch(options.inlineReason, /…\[truncated/);
});

test("parseUpsertCheckpointVerdictCliArgs fails closed instead of truncating an over-limit --next-action (#1388)", () => {
  const overLimitNextAction = "x".repeat(2001);
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000", "--verdict", "clean", "--findings-summary", "ok", "--next-action", overLimitNextAction, "--inline-reason", "small change"]),
    /--next-action exceeds 2000 chars \(2001 chars\)/,
  );
});

test("renderGateReviewCommentBody renders the execution-mode line round-trippable by the marker parser", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const inlineBody = renderGateReviewCommentBody({
    gate: "draft_gate", headSha: "abc1234000000000000000000000000000000000", verdict: "clean", findingsSummary: "none", nextAction: "go",
    executionMode: "inline_single_agent", inlineReason: "quick fix",
  });
  assert.match(inlineBody, /\*\*Execution mode:\*\* inline_single_agent — quick fix/);
  const parsedInline = parseGateReviewCommentMarkerBody(inlineBody);
  assert.equal(parsedInline.executionMode, "inline_single_agent");
  assert.equal(parsedInline.inlineReason, "quick fix");

  const fanoutBody = renderGateReviewCommentBody({
    gate: "draft_gate", headSha: "abc1234000000000000000000000000000000000", verdict: "clean", findingsSummary: "none", nextAction: "go",
    executionMode: "fanout_fanin",
  });
  assert.match(fanoutBody, /\*\*Execution mode:\*\* fanout_fanin/);
  assert.equal(parseGateReviewCommentMarkerBody(fanoutBody).executionMode, "fanout_fanin");
});

test("renderGateReviewCommentBody renders structured per-angle fan-in findings as a readable multi-line block (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    // free-text fallback is present but MUST be ignored in favor of structured render
    findingsSummary: "this free-text summary should be replaced by the structured render",
    nextAction: "address must-fix findings then re-gate",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          { severity: "high", summary: "off-by-one in loop bound", file: "src/loop.mjs", line: 42, disposition: "accepted-for-fix" },
          { severity: "medium", summary: "missing null guard" },
        ],
      },
      {
        angle: "acceptance-criteria",
        verdict: "clean",
        findings: [],
      },
    ],
  });

  // Structured block is multi-line with one bullet per angle and nested findings.
  // severity/verdict/disposition render inside backtick code spans (enum
  // labels, never prose — see sanitizeStructuredCodeSpan).
  assert.match(body, /\n- `correctness` → `findings_present`\n/);
  assert.match(body, /\n {2}- \[`high`\] off-by-one in loop bound \(`src\/loop\.mjs:42`\) — _`accepted-for-fix`_\n/);
  assert.match(body, /\n {2}- \[`medium`\] missing null guard\n/);
  assert.match(body, /\n- `acceptance-criteria` → `clean`/);
  // Newlines are preserved (not collapsed to a run-on line).
  assert.ok(body.split("\n").length > 8, "structured body should be multi-line");
  // The free-text summary is NOT rendered; the digest line is used instead.
  assert.doesNotMatch(body, /should be replaced/);
  assert.match(body, /\*\*Findings summary:\*\* 2 angles reviewed; 2 findings \(see per-angle breakdown below\)\./);

  // The structured comment still parses via the marker parser: gate, headSha,
  // verdict, executionMode round-trip, and contractComplete stays true.
  const parsed = parseGateReviewCommentMarkerBody(body);
  assert.ok(parsed, "structured body must parse via the marker parser");
  assert.equal(parsed.gate, "draft_gate");
  assert.equal(parsed.headSha, "abc1234000000000000000000000000000000000");
  assert.equal(parsed.verdict, "findings_present");
  assert.equal(parsed.executionMode, "fanout_fanin");
  assert.equal(parsed.nextAction, "address must-fix findings then re-gate");
  assert.equal(parsed.findingsSummary, "2 angles reviewed; 2 findings (see per-angle breakdown below).");
  assert.equal(parsed.contractComplete, true);
});

test("renderGateReviewCommentBody fails closed instead of truncating a structured findings render over the generous limit (#1388)", () => {
  const findings = [];
  for (let i = 0; i < 60; i += 1) {
    findings.push({ severity: "worth-fixing-now", summary: `finding number ${i} with enough padding text to add up over many entries` });
  }
  assert.throws(
    () => renderGateReviewCommentBody({
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findingsSummary: "fallback",
      nextAction: "address findings then re-gate",
      structuredFindings: [{ angle: "correctness", verdict: "findings_present", findings }],
    }),
    /--findings-json structured findings render exceeds 2000 chars \(\d+ chars\)/,
  );
});

test("renderGateReviewCommentBody falls back to free-text findings summary when no structured input is given (#898)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "mark ready",
    executionMode: "inline_single_agent",
    inlineReason: "single-agent run",
  });
  assert.match(body, /\*\*Findings summary:\*\* no issues found/);
  assert.doesNotMatch(body, /per-angle breakdown below/);
});

test("renderGateReviewCommentBody renders the gate evidence note on its own labeled line, never spliced with `;` into the findings summary (#1388)", () => {
  const body = renderGateReviewCommentBody({
    gate: "pre_approval_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "clean",
    findingsSummary: "no issues found.",
    nextAction: "await final human approval",
    executionMode: "inline_single_agent",
    inlineReason: "single-agent run",
    gateEvidenceNote: "Copilot review rounds exhausted (5/5); proceeding via fallback.",
  });
  assert.match(body, /\*\*Findings summary:\*\* no issues found\.\n/);
  assert.match(body, /\n\*\*Gate evidence note:\*\* Copilot review rounds exhausted \(5\/5\); proceeding via fallback\.\n/);
  // Pre-fix render spliced the note into the summary with `;`, producing
  // double punctuation (`.;`) and hiding the machine-added note as prose.
  assert.doesNotMatch(body, /\*\*Findings summary:\*\*[^\n]*;/);
});

test("renderGateReviewCommentBody omits the gate evidence note line entirely when no note is supplied", () => {
  const body = renderGateReviewCommentBody({
    gate: "pre_approval_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "await final human approval",
  });
  assert.doesNotMatch(body, /Gate evidence note/);
});

test("renderGateReviewCommentBody fails closed instead of truncating a gate evidence note over the generous limit (#1388)", () => {
  const overLimitNote = "x".repeat(2001);
  assert.throws(
    () => renderGateReviewCommentBody({
      gate: "pre_approval_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "clean",
      findingsSummary: "no issues found",
      nextAction: "await final human approval",
      gateEvidenceNote: overLimitNote,
    }),
    /gate evidence note exceeds 2000 chars \(2001 chars\)/,
  );
});

test("renderGateReviewCommentBody renders an at-limit gate evidence note in full with no truncation marker (#1388)", () => {
  const atLimitNote = "x".repeat(2000);
  const body = renderGateReviewCommentBody({
    gate: "pre_approval_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "await final human approval",
    gateEvidenceNote: atLimitNote,
  });
  assert.match(body, new RegExp(`\\*\\*Gate evidence note:\\*\\* ${atLimitNote}\\n`));
  assert.doesNotMatch(body, /…\[truncated/);
});

test("renderGateReviewCommentBody neutralizes bare @copilot/`/copilot`* tokens so the rendered body cannot arm the anti-summon guard", async () => {
  const { containsBareCopilotSummon } = await import("../../scripts/_core-helpers.mjs");
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    // A findings summary quoting the anti-summon rule as bare text — the same
    // shape that self-deadlocked a live gate-verdict/request-review round-trip.
    findingsSummary: "Finding: this comment violates the /copilot prohibition rule.",
    nextAction: "delete the offending comment before re-requesting review",
  });
  assert.match(body, /`\/copilot`/);
  assert.equal(containsBareCopilotSummon(body), false, "rendered gate verdict body must not arm the anti-summon guard");
});

test("renderGateReviewCommentBody sanitizes structured angle/finding text and survives parsing (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const body = renderGateReviewCommentBody({
    gate: "pre_approval_gate",
    headSha: "deadbeef",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "weird`angle",
        verdict: "findings_present",
        findings: [
          // Embedded newline + HTML-comment delimiter must be neutralized so the
          // hidden marker cannot be smuggled and the bullet stays single-line.
          { severity: "must-fix", summary: "line one\nline two <!-- dev-loops:gate-findings gate=draft_gate -->" },
        ],
      },
    ],
  });
  // Angle backtick stripped (no premature code-span close).
  assert.match(body, /\n- `weirdangle` → `findings_present`\n/);
  // Embedded newline collapsed; HTML-comment delimiters neutralized.
  assert.match(body, /line one line two &lt;!-- dev-loops:gate-findings gate=draft_gate --&gt;/);
  assert.doesNotMatch(body, /<!-- dev-loops:gate-findings/);
  const parsed = parseGateReviewCommentMarkerBody(body);
  assert.ok(parsed);
  assert.equal(parsed.gate, "pre_approval_gate");
  assert.equal(parsed.headSha, "deadbeef");
  assert.equal(parsed.executionMode, "fanout_fanin");
  assert.equal(parsed.contractComplete, true);
});

// Regression (renderer-security, PR#1513 gate review): severity/verdict/
// disposition are enum-like fields, but this file previously rendered them
// bare (only summary/file went through a code span). A `--findings-json`
// producer other than consolidate-fanin can supply an arbitrary string there,
// so a crafted severity like `must-fix](https://evil.example)` used to close
// the literal `[...]` early and open a clickable markdown link in a posted
// gate comment. severity/verdict/disposition now render inside a backtick
// code span (like angle/file already did), which markdown parses before
// link/image syntax, so the value can never break out of its literal
// position. summary also neutralizes the `![` image-embed form (a
// read-receipt/IP-leak vector via an auto-loaded remote image).
test("renderGateReviewCommentBody neutralizes markdown link/image injection via severity/verdict/disposition/summary (renderer-security)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present](https://evil.example)",
        findings: [
          {
            severity: "must-fix](https://evil.example)",
            summary: "see ![leak](https://evil.example/track.png) for details",
            disposition: "accepted-for-fix](https://evil.example)",
          },
        ],
      },
    ],
  });
  // A crafted severity/verdict/disposition never closes its own `[...]`/`_..._`
  // wrapper early: the whole value, including its embedded `](url)`, is
  // wrapped in ITS OWN backtick code span — CommonMark parses a code span
  // before link syntax, so this renders as inert literal text, never a link.
  assert.match(body, /\[`must-fix\]\(https:\/\/evil\.example\)`\]/);
  assert.match(body, /→ `findings_present\]\(https:\/\/evil\.example\)`\n/);
  assert.match(body, /_`accepted-for-fix\]\(https:\/\/evil\.example\)`_/);
  // The image-embed form in summary is neutralized (no bare `![`).
  assert.doesNotMatch(body, /!\[leak\]/);
  assert.match(body, /!&#91;leak\]/);
});

// Regression (renderer-security, PR#1513 gate review round 3): a lone backtick
// in `summary` used to shift CommonMark's left-to-right backtick pairing so a
// LATER field on the same line — here `file` — never got its own code span,
// letting its crafted `](url)` combine with `summary`'s `[` into a live
// markdown link. sanitizeStructuredInline now strips backticks from EVERY
// field it sanitizes (summary included), so no field can unbalance another
// field's code span on the same rendered line.
test("renderGateReviewCommentBody strips a backtick from summary so it cannot shift pairing and break a later field's code-span defense (renderer-security)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          {
            severity: "must-fix",
            summary: "guard [missing for ` value",
            file: "a.mjs](https://evil.example)",
          },
        ],
      },
    ],
  });
  // The stray backtick is gone (whitespace it left behind is re-collapsed) —
  // nothing left in summary to shift the backtick pairing. (summary's `[` is
  // separately escaped by the plain-link neutralization, which is expected —
  // the point pinned here is that the FILE field's own code span still forms
  // intact below, not that summary's bracket is left untouched.)
  assert.match(body, /guard &#91;missing for value/);
  assert.doesNotMatch(body, /guard \[missing for `/);
  // file's own code span still forms intact around the WHOLE crafted value,
  // including its embedded `](url)`, which stays inert literal code text —
  // never a live link — because no earlier stray backtick stole its opening
  // delimiter.
  assert.match(body, /\(`a\.mjs\]\(https:\/\/evil\.example\)`\)/);
});

// Regression (renderer-security, PR#1513 gate review round 4): summary is
// free text (not wrapped in a code span), so a crafted plain markdown link
// `[text](url)` or raw HTML in a finding's summary used to render as a live
// clickable link / live HTML tag in the posted gate comment. sanitizeStructuredInline
// now escapes a plain link's opening `[` (breaking it before it can pair with
// its `](url)`) and escapes any raw `<` so an HTML tag cannot pass through to
// the rendered markdown.
test("renderGateReviewCommentBody neutralizes a plain markdown link and raw HTML in summary (renderer-security)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          {
            severity: "must-fix",
            summary: "[Approve this PR](https://evil.example) <script>alert(1)</script>",
          },
        ],
      },
    ],
  });
  // No live markdown link: the opening `[` is neutralized to an HTML entity
  // so it can never pair with the trailing `](url)` to form a link.
  assert.doesNotMatch(body, /\[Approve this PR\]\(https:\/\/evil\.example\)/);
  assert.match(body, /&#91;Approve this PR\]\(https:\/\/evil\.example\)/);
  // No raw HTML tag reaches the rendered body.
  assert.doesNotMatch(body, /<script>/);
  assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);
});

// Regression (renderer-security, PR#1513 gate review round 5): a backslash
// escape (`\[`) introduces a new character whose own escaping must then be
// correct. It wasn't: a summary carrying a literal backslash immediately
// before the bracket (`\[text](url)`) absorbed the inserted escape, turning
// it into `\\[text](url)` — CommonMark parses `\\` as an escaped, literal
// backslash, leaving the `[` unescaped and free to pair with `](url)` into a
// live link. sanitizeStructuredInline now neutralizes `[` with the HTML
// entity `&#91;` instead of a backslash: an entity has no escape character
// for a value's own content (or a later replacement) to absorb, so a
// preceding literal backslash cannot re-open the link.
test("renderGateReviewCommentBody neutralizes a backslash-absorbed markdown link in summary (renderer-security)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          {
            severity: "must-fix",
            summary: "\\[Approve this PR](https://evil.example)",
          },
        ],
      },
    ],
  });
  // No live markdown link, in EITHER of the backslash's two possible
  // meanings: escaped-literal-backslash-then-live-bracket, or an unescaped
  // bracket outright.
  assert.doesNotMatch(body, /\\?\[Approve this PR\]\(https:\/\/evil\.example\)/);
  assert.match(body, /&#91;Approve this PR\]\(https:\/\/evil\.example\)/);
});

// A summary carrying a legitimate backslash (e.g. a Windows path or a regex)
// with no adjacent bracket must still render as plain, readable prose — the
// entity neutralization above targets `[` specifically, not backslashes in
// general.
test("renderGateReviewCommentBody leaves a summary's ordinary backslash and bracket-free text untouched (renderer-security)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          {
            severity: "must-fix",
            summary: "missing null check in C:\\repo\\src\\app.mjs, see regex a\\d+b",
          },
        ],
      },
    ],
  });
  assert.match(body, /missing null check in C:\\repo\\src\\app\.mjs, see regex a\\d\+b/);
});

test("renderGateReviewCommentBody renders NESTED per-angle findings input correctly (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "bad bound", file: "x.mjs", line: 3 }],
      },
      { angle: "tests", verdict: "clean", findings: [] },
    ],
  });
  assert.match(body, /\n- `correctness` → `findings_present`\n/);
  assert.match(body, /\n {2}- \[`high`\] bad bound \(`x\.mjs:3`\)\n/); // "must-fix" input normalizes to canonical "high"
  assert.match(body, /\n- `tests` → `clean`/);
  assert.match(body, /\*\*Findings summary:\*\* 2 angles reviewed; 1 finding \(see per-angle breakdown below\)\./);
  const parsed = parseGateReviewCommentMarkerBody(body);
  assert.ok(parsed);
  assert.equal(parsed.contractComplete, true);
});

// A marker-collapsed fan-in round replaces an angle's real findings with ONE
// synthetic marker finding (consolidate-fanin.mjs), so counting
// `angles[].findings.length` alone would report e.g. "1 finding" for a round
// that actually carries hundreds — wrong by an order of magnitude, and this
// digest line is machine-parsed evidence. When the caller also supplies
// `findingsSeverityCounts` (a fan-in's own true, unbudgeted `severityCounts`),
// the digest must sum THAT instead of the rendered marker count.
test("renderGateReviewCommentBody's Findings summary counts the true totals from findingsSeverityCounts, not the marker-collapsed findingsJson", async () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        // A single marker finding standing in for many real findings.
        findings: [{ severity: "must-fix", summary: "20 finding(s) omitted from this comment (must-fix: 5, worth-fixing-now: 10, defer: 5) — in the disposition ledger", disposition: "accepted-for-fix" }],
      },
      { angle: "tests", verdict: "clean", findings: [] },
    ],
    findingsSeverityCounts: { "must-fix": 5, "worth-fixing-now": 10, defer: 5 },
  });
  assert.match(body, /\*\*Findings summary:\*\* 2 angles reviewed; 20 findings \(see per-angle breakdown below\)\./);
});

// findingsSeverityCounts is a CORRECTION for a marker-collapsed undercount, not
// a replacement: a marker collapse can only ever make findingsJson's own count
// LOWER than the truth, never higher, so the supplied counts must only be
// allowed to RAISE the digest, never lower it. An all-zero or partial counts
// object (e.g. the mandatory gate-comment template's own documented example,
// or a caller that forgot the `defer` key) must not silently replace a real
// per-angle count with "no findings" while the rendered per-angle breakdown
// still lists real findings.
test("renderGateReviewCommentBody's Findings summary keeps the real count when findingsSeverityCounts is all-zero (#1513)", async () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      { angle: "correctness", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "off-by-one" }] },
      { angle: "tests", verdict: "findings_present", findings: [{ severity: "nice-to-have", summary: "naming nit" }] },
    ],
    findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, defer: 0 },
  });
  assert.match(body, /\*\*Findings summary:\*\* 2 angles reviewed; 2 findings \(see per-angle breakdown below\)\./);
});

test("renderGateReviewCommentBody's Findings summary keeps the real count when findingsSeverityCounts omits a severity that has real findings (#1513)", async () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      { angle: "tests", verdict: "findings_present", findings: [{ severity: "nice-to-have", summary: "a" }, { severity: "nice-to-have", summary: "b" }] },
    ],
    // Documented two-key example from --help; carries no "nice-to-have" key at all.
    findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0 },
  });
  assert.match(body, /\*\*Findings summary:\*\* 1 angle reviewed; 2 findings \(see per-angle breakdown below\)\./);
});

test("renderGateReviewCommentBody's Findings summary ignores unrecognized severity keys in findingsSeverityCounts (#1513)", async () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      { angle: "correctness", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "off-by-one" }] },
    ],
    // A typo'd key ("mustfix") and a non-severity key ("total") must not
    // inflate the posted total beyond the true, known-severity sum (1).
    findingsSeverityCounts: { "must-fix": 1, mustfix: 1, total: 2 },
  });
  assert.match(body, /\*\*Findings summary:\*\* 1 angle reviewed; 1 finding \(see per-angle breakdown below\)\./);
});

test("renderGateReviewCommentBody groups FLAT per-finding input by angle without dropping findings (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  // This is consolidateFanin's OUTPUT / toFindingsLogShape: a FLAT array where
  // each finding carries its own `.angle` (and `files`, not `file`). Before the
  // fix this shape silently rendered every angle clean (findings dropped).
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      { severity: "must-fix", angle: "correctness", summary: "off-by-one", files: ["src/loop.mjs"], disposition: "accepted-for-fix" },
      { severity: "worth-fixing-now", angle: "correctness", summary: "missing guard" },
      { severity: "nice-to-have", angle: "style", summary: "naming nit" },
      // A finding without an angle must still be rendered (grouped under "general").
      { severity: "must-fix", summary: "no-angle finding" },
    ],
  });
  // Findings are NOT dropped: grouped per angle. Legacy-spelled input
  // ("must-fix"/"worth-fixing-now"/"nice-to-have") normalizes to the
  // canonical output vocabulary.
  assert.match(body, /\n- `correctness` → `findings_present`\n/);
  assert.match(body, /\n {2}- \[`high`\] off-by-one \(`src\/loop\.mjs`\) — _`accepted-for-fix`_\n/);
  assert.match(body, /\n {2}- \[`medium`\] missing guard\n/);
  assert.match(body, /\n- `style` → `findings_present`\n/);
  assert.match(body, /\n {2}- \[`low`\] naming nit\n/);
  assert.match(body, /\n- `general` → `findings_present`\n/);
  assert.match(body, /\n {2}- \[`high`\] no-angle finding\n/);
  // 3 angles (correctness, style, general), 4 findings total — none dropped.
  assert.match(body, /\*\*Findings summary:\*\* 3 angles reviewed; 4 findings \(see per-angle breakdown below\)\./);
  const parsed = parseGateReviewCommentMarkerBody(body);
  assert.ok(parsed);
  assert.equal(parsed.contractComplete, true);
});

test("renderGateReviewCommentBody throws on a non-empty unrecognizable structured shape (no silent all-clean) (#898)", () => {
  assert.throws(
    () =>
      renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "abc1234000000000000000000000000000000000",
        verdict: "findings_present",
        findingsSummary: "ignored",
        nextAction: "fix",
        executionMode: "fanout_fanin",
        // Items carry neither a nested `findings` array nor a `summary` — neither
        // recognized shape. Must throw, not silently render all-clean.
        structuredFindings: [{ angle: "correctness", note: "oops" }, { foo: "bar" }],
      }),
    /matches neither recognized shape/,
  );
});

test("renderGateReviewCommentBody throws when nested and flat shapes are mixed (#898)", () => {
  assert.throws(
    () =>
      renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "abc1234000000000000000000000000000000000",
        verdict: "findings_present",
        findingsSummary: "ignored",
        nextAction: "fix",
        executionMode: "fanout_fanin",
        structuredFindings: [
          { angle: "a", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "x" }] },
          { severity: "must-fix", angle: "b", summary: "y" },
        ],
      }),
    /mixes per-angle entries .* and flat per-finding entries/,
  );
});

test("renderGateReviewCommentBody sorts unknown/missing severities LAST, never before must-fix (Copilot review)", () => {
  // Findings arrive in an order that, before the fix, would float the unknown
  // severity ABOVE must-fix (indexOf gives unknown rank -1). After the fix the
  // known order (must-fix → worth-fixing-now → defer) leads and unknowns trail.
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          { severity: "speculative", summary: "unknown severity finding" },
          { severity: "must-fix", summary: "critical finding" },
          { severity: "", summary: "missing severity finding" },
          { severity: "worth-fixing-now", summary: "medium finding" },
        ],
      },
    ],
  });
  const order = ["critical finding", "medium finding", "unknown severity finding", "missing severity finding"];
  let cursor = -1;
  for (const summary of order) {
    const idx = body.indexOf(summary);
    assert.ok(idx > cursor, `"${summary}" should appear after the previous entry (must-fix leads, unknowns trail)`);
    cursor = idx;
  }
  // must-fix must NOT appear after the unknown-severity entry.
  assert.ok(
    body.indexOf("critical finding") < body.indexOf("unknown severity finding"),
    "must-fix must sort before an unknown severity, not be hidden below it",
  );
});

// #1592: SEVERITY_ORDER ranks "question" right after "high" (both keep
// gate-close blocked — a high via the fix loop, a question via never
// auto-deferring) — ahead of "medium"/"low" (both eventually defer).
test("renderGateReviewCommentBody sorts a question finding between high and medium (#1592)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [
          { severity: "medium", summary: "medium finding" },
          { severity: "question", summary: "why this approach finding" },
          { severity: "high", summary: "critical finding" },
        ],
      },
    ],
  });
  const order = ["critical finding", "why this approach finding", "medium finding"];
  let cursor = -1;
  for (const summary of order) {
    const idx = body.indexOf(summary);
    assert.ok(idx > cursor, `"${summary}" should appear after the previous entry (high, then question, then medium)`);
    cursor = idx;
  }
});

test("renderGateReviewCommentBody throws when a non-empty payload mixes recognized and unrecognized items (no silent drop) (Copilot review)", () => {
  // One recognizable per-angle entry plus one unrecognized item. Before the fix
  // the unrecognized item was silently filtered out (findings could be hidden).
  // Now ANY unrecognized item in a non-empty payload throws.
  assert.throws(
    () =>
      renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "abc1234000000000000000000000000000000000",
        verdict: "findings_present",
        findingsSummary: "ignored",
        nextAction: "fix",
        executionMode: "fanout_fanin",
        structuredFindings: [
          { angle: "correctness", verdict: "findings_present", findings: [{ severity: "must-fix", summary: "real finding" }] },
          { angle: "style", note: "no findings array and no summary" },
        ],
      }),
    /match neither a per-angle entry .* nor a flat per-finding entry/,
  );
});

test("renderGateReviewCommentBody renders an angle-less NESTED entry under `general` instead of dropping it (Copilot review)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  // A nested entry whose `angle` is missing/blank must NOT be dropped — its
  // findings still matter. It renders under the `general` fallback label, and a
  // non-empty structured payload must NOT silently degrade to the free-text path.
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "this free-text must NOT be rendered when structured findings are present",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        // No angle field at all.
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "angle-less nested finding" }],
      },
      {
        angle: "   ",
        findings: [{ severity: "worth-fixing-now", summary: "blank-angle nested finding" }],
      },
    ],
  });
  // Both angle-less entries render under `general` — findings are NOT dropped.
  // Legacy-spelled input normalizes to the canonical output vocabulary.
  assert.match(body, /\n- `general` → `findings_present`\n/);
  assert.match(body, /\n {2}- \[`high`\] angle-less nested finding\n/);
  assert.match(body, /\n {2}- \[`medium`\] blank-angle nested finding\n/);
  // The structured digest is used; the free-text fallback is NOT rendered.
  assert.match(body, /per-angle breakdown below/);
  assert.doesNotMatch(body, /must NOT be rendered/);
  const parsed = parseGateReviewCommentMarkerBody(body);
  assert.ok(parsed, "structured body must still parse via the marker parser");
  assert.equal(parsed.contractComplete, true);
});

test("upsert-checkpoint-verdict --findings-json rejects an unrecognizable non-empty shape (#898)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-json-bad-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    // Non-empty array whose items match neither shape (no nested findings, no summary).
    await writeFile(findingsPath, JSON.stringify([{ angle: "correctness", note: "oops" }]), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /matches neither recognized shape/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- Angle-coverage enforcement (#1196: mandatory angles + pool membership) ---

test("upsert-checkpoint-verdict rejects a fanout_fanin verdict whose --findings-json is missing the gate's mandatory angle (AC1)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-angle-coverage-missing-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    // draft_gate's configured mandatory angle (pr-description) is absent.
    await writeFile(findingsPath, JSON.stringify([{ angle: "scope", verdict: "clean", findings: [] }]), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing mandatory angle\(s\): pr-description/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects a fanout_fanin verdict whose --findings-json names an angle outside the configured pool (AC2)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-angle-coverage-foreign-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "pr-checklist-matrix", verdict: "clean", findings: [] },
        { angle: "acceptance-criteria", verdict: "clean", findings: [] },
        { angle: "yagni", verdict: "clean", findings: [] },
        { angle: "contradiction-lens", verdict: "clean", findings: [] },
        { angle: "made-up-angle", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({
        isDraft: false,
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", submittedAt: "2026-05-31T20:00:00Z", commit: { oid: "abc1234000000000000000000000000000000000" } }],
      }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "pre_approval_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /outside the configured pool: made-up-angle/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict accepts the fan-in synthetic pr-checklist-matrix angle outside the gate's configured pool (#1494)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-angle-coverage-synthetic-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    // consolidate-fanin --out shape: draft-pool angles plus the synthetic
    // matrix entry its --pr-checklist-matrix clean flag upserts. draft_gate's
    // pool does not list pr-checklist-matrix; the upsert must not reject it.
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "pr-description", verdict: "clean", findings: [] },
        { angle: "scope", verdict: "clean", findings: [] },
        { angle: "pr-checklist-matrix", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc1234000000000000000000000000000000000", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["### Gate review: `draft_gate`", "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`"],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-102"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-json", findingsPath,
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict rejects an angle-less flat finding in fanout mode with a dedicated error (not a confusing `general` pool error)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-angleless-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    // Flat finding without .angle: normalization would bucket it under the
    // synthetic `general` label, which would surface as a foreign-angle error.
    await writeFile(
      findingsPath,
      JSON.stringify([
        { severity: "must-fix", summary: "finding with angle" , angle: "pr-description" },
        { severity: "must-fix", summary: "finding with no angle attribution" },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /lack a non-empty \.angle/);
    assert.doesNotMatch(result.stderr, /outside the configured pool/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict WARNS on stderr (not silence) for a foreign angle when gates.rejectForeignAngles is false", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-angle-warn-"));
  try {
    // Repo config opting into warn mode; extension defaults still supply the
    // draft pool + mandatory pr-description.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  rejectForeignAngles: false\n", "utf8");
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        { angle: "pr-description", verdict: "clean", findings: [] },
        { angle: "totally-made-up", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-json", findingsPath,
      "--next-action", "mark ready for review", "--execution-mode", "fanout_fanin",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /WARNING: .*outside the configured pool: totally-made-up/);
    assert.match(result.stderr, /rejectForeignAngles is false/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict does NOT enforce angle coverage for an inline_single_agent verdict (AC3 exemption)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-angle-coverage-inline-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    // No mandatory angle present at all — must still pass because executionMode
    // is inline_single_agent (angle coverage is a fanout_fanin-only concern).
    await writeFile(findingsPath, JSON.stringify([{ angle: "scope", verdict: "clean", findings: [] }]), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix then re-gate", "--inline-reason", "small change",
    ], { env });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- Withheld-tier coverage: proven from --findings-ledger's provenance,
// not from the comment (which cannot carry per-angle data at this tier) ---

test("upsert-checkpoint-verdict refuses a withheld fanout_fanin verdict whose --findings-ledger provenance is missing the gate's mandatory angle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-withheld-missing-"));
  try {
    const ledgerPath = path.join(tempDir, "ledger.json");
    // Recorded provenance covers "scope" but not draft_gate's mandatory
    // "pr-description" angle.
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findings: [],
      provenance: { distinctReviewers: 1, perAngle: [{ angle: "scope", reviewer: "agent-a" }] },
    }), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-summary", "round too large to render per-angle; see ledger",
      "--findings-ledger", ledgerPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /findings-ledger's provenance is missing mandatory angle\(s\): pr-description/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict refuses a withheld fanout_fanin verdict whose --findings-ledger provenance carries an angle-less entry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-withheld-angleless-"));
  try {
    const ledgerPath = path.join(tempDir, "ledger.json");
    // provenanceConsistencyError accepts this shape (identity present), but
    // the entry attributes its review to no angle; the guard must name that
    // instead of reporting a confusing missing-mandatory-angle error.
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findings: [],
      provenance: { distinctReviewers: 1, perAngle: [{ reviewer: "agent-a" }] },
    }), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-summary", "round too large to render per-angle; see ledger",
      "--findings-ledger", ledgerPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /1 entry lack a non-empty \.angle/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed on a withheld fanout_fanin verdict whose --findings-ledger carries no provenance", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-withheld-no-provenance-"));
  try {
    const ledgerPath = path.join(tempDir, "ledger.json");
    // No `provenance` key at all — nothing to prove coverage against.
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findings: [],
    }), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-summary", "round too large to render per-angle; see ledger",
      "--findings-ledger", ledgerPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /it is invalid \(provenance must be an object\)/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict posts a withheld fanout_fanin verdict whose --findings-ledger carries NO valid provenance on a gate with a pool but no mandatory angle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-withheld-pool-only-vacuous-"));
  try {
    // Same pool-only/no-mandatory config as the foreign-angle refusal below,
    // but the ledger records no provenance at all: with nothing to prove,
    // invalid provenance blocks nothing (vacuous coverage), so the post
    // succeeds instead of demanding proof the gate never obliged.
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  draft:",
      "    angles:",
      "      - name: pr-description",
      "        enabled: false",
      "",
    ].join("\n"), "utf8");
    // Same ledger shape as the covered-provenance positive test below, but
    // with NO provenance key at all — the vacuous-coverage case under test.
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, [BODY_FILED_FINDING]);
    const entries = [
      ...singleSurfaceLeadingEntries(),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":701,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-701"}\n',
      },
    ];
    const { runChild } = makeGhMock(entries);
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsSummary: "round too large to render per-angle; see ledger",
      findingsLedger: ledgerPath,
      nextAction: "fix then re-gate",
      executionMode: "fanout_fanin",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir });
    assert.equal(result.action, "created");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict refuses a withheld fanout_fanin verdict whose --findings-ledger provenance names a foreign angle on a gate with a pool but no mandatory angle", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-withheld-pool-only-foreign-"));
  try {
    // draft_gate's only mandatory angle (pr-description) disabled via a D3
    // merge-by-name override, so mandatoryAngles resolves empty while the
    // pool (scope, coverage, ...) stays non-empty — pinning that the
    // foreign-angle check still runs for a pool-only, no-mandatory gate
    // instead of being skipped along with the mandatory-angle check.
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  draft:",
      "    angles:",
      "      - name: pr-description",
      "        enabled: false",
      "",
    ].join("\n"), "utf8");
    const ledgerPath = path.join(tempDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findings: [],
      provenance: { distinctReviewers: 1, perAngle: [{ angle: "totally-made-up", reviewer: "agent-a" }] },
    }), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-summary", "round too large to render per-angle; see ledger",
      "--findings-ledger", ledgerPath,
      "--next-action", "fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--findings-ledger's provenance for draft_gate names angle\(s\) outside the configured pool: totally-made-up/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict --findings-json renders structured per-angle findings end-to-end (#898)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-json-"));
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "must-fix", summary: "broken edge case", file: "a.mjs", line: 7 }],
        },
        { angle: "coverage", verdict: "clean", findings: [] },
        // draft_gate's configured mandatory angle (gates.draft.mandatoryAngles):
        // a fanout_fanin verdict's structured per-angle results must cover it.
        { angle: "pr-description", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "**Execution mode:** fanout_fanin",
          "- `correctness` → `findings_present`",
          "  - [`high`] broken edge case (`a.mjs:7`)", // "must-fix" input normalizes to canonical "high"
          "- `coverage` → `clean`",
          "**Findings summary:** 3 angles reviewed; 1 finding (see per-angle breakdown below).",
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix must-fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.action, "created");
    assert.equal(out.executionMode, "fanout_fanin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict --findings-json structured verdict renders the gateEvidenceNote on its own labeled line (parity with free-text)", async () => {
  // In structured (--findings-json) mode the coordination gateEvidenceNote (here
  // the round-exhaustion / pre_approval_gate fallback note) renders on its own
  // `**Gate evidence note:**` line — NOT spliced with `;` into the
  // `**Findings summary:**` line — exactly like the free-text path. The same PR
  // state as the free-text round-cap test drives coordination to emit the note.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-json-note-"));
  const roundExhaustionNote = "Copilot review rounds exhausted (5/2); current head has zero unresolved threads and green CI, so pre_approval_gate fallback is allowed without another Copilot re-request.";
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        {
          angle: "dry",
          verdict: "findings_present",
          findings: [{ severity: "worth-fixing-now", summary: "minor nit worth noting" }],
        },
        // pre_approval_gate's configured mandatory angles (gates.preApproval.mandatoryAngles):
        // a fanout_fanin verdict's structured per-angle results must cover them.
        { angle: "pr-checklist-matrix", verdict: "clean", findings: [] },
        { angle: "acceptance-criteria", verdict: "clean", findings: [] },
        { angle: "yagni", verdict: "clean", findings: [] },
        { angle: "contradiction-lens", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({
          number: 17,
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc1234000000000000000000000000000000000",
          reviews: [
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:00:00Z", commit: { oid: "1111111111111111111111111111111111111111" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:05:00Z", commit: { oid: "2222222222222222222222222222222222222222" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:10:00Z", commit: { oid: "3333333333333333333333333333333333333333" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:15:00Z", commit: { oid: "4444444444444444444444444444444444444444" } },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", submittedAt: "2026-05-31T20:20:00Z", commit: { oid: "5555555555555555555555555555555555555555" } },
          ],
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
        }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "pr=17"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc1234000000000000000000000000000000000"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 91,
          body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234000000000000000000000000000000000`",
            "**Verdict:** clean",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
          ].join("\n"),
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          updated_at: "2026-05-31T19:55:00Z",
        }]])}\n`,
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "### Gate review: `pre_approval_gate`",
          "**Execution mode:** fanout_fanin",
          "- `dry` → `findings_present`",
          // The structured single-line digest stays plain; the gateEvidenceNote
          // renders on its own labeled line, not spliced into the digest.
          "**Findings summary:** 5 angles reviewed; 1 finding (see per-angle breakdown below).",
          `**Gate evidence note:** ${roundExhaustionNote}`,
        ],
        assertStdinNotIncludes: [
          `**Findings summary:** 5 angles reviewed; 1 finding (see per-angle breakdown below).; ${roundExhaustionNote}`,
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present",
      "--findings-json", findingsPath,
      "--next-action", "address findings then re-gate",
      "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.action, "created");
    assert.equal(out.executionMode, "fanout_fanin");

    // Unit-level parity + round-trip: rendering a structured body with the same
    // gateEvidenceNote puts the note on its own labeled line (not spliced into
    // the digest), and the marker parser still recovers the plain summary line
    // (parse contract stays intact).
    const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
    const expectedSummaryLine = "1 angle reviewed; 1 finding (see per-angle breakdown below).";
    const body = renderGateReviewCommentBody({
      gate: "pre_approval_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findingsSummary: "free-text fallback (ignored in structured mode)",
      nextAction: "address findings then re-gate",
      executionMode: "fanout_fanin",
      gateEvidenceNote: roundExhaustionNote,
      structuredFindings: [
        { angle: "correctness", verdict: "findings_present", findings: [{ severity: "worth-fixing-now", summary: "minor nit worth noting" }] },
      ],
    });
    assert.match(body, /\*\*Findings summary:\*\* 1 angle reviewed; 1 finding \(see per-angle breakdown below\)\.\n/);
    assert.match(body, /\n\*\*Gate evidence note:\*\* Copilot review rounds exhausted/);
    assert.doesNotMatch(body, /\*\*Findings summary:\*\*[^\n]*; Copilot review rounds exhausted/);
    // The structured per-angle bullet is unchanged by carrying the note.
    assert.match(body, /\n- `correctness` → `findings_present`\n/);
    const parsed = parseGateReviewCommentMarkerBody(body);
    assert.ok(parsed, "structured body with gateEvidenceNote must parse via the marker parser");
    assert.equal(parsed.contractComplete, true);
    assert.equal(parsed.gate, "pre_approval_gate");
    assert.equal(parsed.verdict, "findings_present");
    assert.equal(parsed.findingsSummary, expectedSummaryLine);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// upsertCheckpointVerdict computes effectiveFindingsSummary (the noop
// short-circuit's comparison value) via a SEPARATE buildStructuredFindingsDigest
// call from the one renderGateReviewCommentBody uses to render the posted
// "**Findings summary:**" line. If those two call sites ever drift apart (e.g.
// the second argument at the effectiveFindingsSummary call site is dropped),
// the posted body's digest still shows the raised true total while the noop
// comparison keeps the marker-collapsed undercount, so `existing.findingsSummary`
// (parsed back from the posted body) never equals `effectiveFindingsSummary`
// and every re-invocation on the same head re-edits the gate comment forever.
// Driving upsertCheckpointVerdict end-to-end with a marker-collapsed round
// whose --findings-severity-counts raises the total, then presenting an
// "existing comment" whose body is exactly what a first invocation would have
// posted, pins both call sites to the same digest.
test("upsert-checkpoint-verdict's noop short-circuit stays coupled to the posted digest for a marker-collapsed round with --findings-severity-counts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-digest-noop-"));
  try {
    const structuredFindings = [
      {
        angle: "correctness",
        verdict: "findings_present",
        findings: [{ severity: "must-fix", summary: "20 finding(s) omitted from this comment (must-fix: 5, worth-fixing-now: 10, defer: 5) — in the disposition ledger", disposition: "accepted-for-fix" }],
      },
      { angle: "coverage", verdict: "clean", findings: [] },
      // draft_gate's configured mandatory angle: must be present for a
      // fanout_fanin verdict's angle-coverage check to pass.
      { angle: "pr-description", verdict: "clean", findings: [] },
    ];
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(findingsPath, JSON.stringify(structuredFindings), "utf8");
    const findingsSeverityCounts = { "must-fix": 5, "worth-fixing-now": 10, defer: 5 };

    // The exact body a first invocation would post — the same
    // renderGateReviewCommentBody call upsertCheckpointVerdict drives
    // internally, with the same digest inputs.
    const desiredBody = renderGateReviewCommentBody({
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      verdict: "findings_present",
      findingsSummary: "ignored in structured mode",
      nextAction: "fix",
      executionMode: "fanout_fanin",
      structuredFindings,
      findingsSeverityCounts,
    });

    const env = await writeGhStub(tempDir, buildGateCoordinationEntries({
      isDraft: true,
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      issueComments: [[{
        id: 101,
        body: desiredBody,
        html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
        updated_at: "2026-05-31T20:00:00Z",
      }]],
    }));

    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--findings-severity-counts", JSON.stringify(findingsSeverityCounts),
      "--next-action", "fix", "--execution-mode", "fanout_fanin",
    ], { env });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "noop", `expected noop (digest call sites coupled), got: ${JSON.stringify(payload)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict records executionMode and warns on inline, stays clean on fanout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-execmode-"));
  try {
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["### Gate review: `draft_gate`", "**Execution mode:** inline_single_agent — manual single-agent run"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);
    const inline = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-summary", "no issues found", "--next-action", "mark ready for review",
      "--execution-mode", "inline_single_agent", "--inline-reason", "manual single-agent run",
    ], { env });
    assert.equal(inline.code, 0, inline.stderr);
    assert.match(inline.stderr, /WARNING: gate ran inline_single_agent/);
    const inlineOut = JSON.parse(inline.stdout);
    assert.equal(inlineOut.executionMode, "inline_single_agent");
    assert.equal(inlineOut.inlineReason, "manual single-agent run");

    const env2 = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["**Execution mode:** fanout_fanin"],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-102"}\n',
      },
    ]);
    // draft_gate configures a mandatory angle (pr-description); a fanout_fanin
    // verdict now requires coverage proof (--findings-json here) rather than a
    // bare --findings-summary — this test is about executionMode recording,
    // not angle coverage, so --findings-json is the minimal covering shape.
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(findingsPath, JSON.stringify([{ angle: "pr-description", verdict: "clean", findings: [] }]), "utf8");
    const fanout = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
      "--findings-json", findingsPath, "--next-action", "mark ready for review",
      "--execution-mode", "fanout_fanin",
    ], { env: env2 });
    assert.equal(fanout.code, 0, fanout.stderr);
    assert.equal(fanout.stderr, "");
    assert.equal(JSON.parse(fanout.stdout).executionMode, "fanout_fanin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// --- Post-time fan-out evidence enforcement ---
// gates.requireFanoutEvidence is already enforced reactively at merge time
// (detect-checkpoint-evidence.mjs's buildPreMergeGateCheck). These tests cover
// the PRODUCE-step refusal added to upsert-checkpoint-verdict.mjs: an inline
// verdict for a required gate that does not qualify for the light-mode
// carve-out is refused BEFORE it is ever posted, regardless of verdict value.

test("upsert-checkpoint-verdict refuses to post an inline verdict for a required gate, for every verdict value", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-postgate-refuse-"));
  try {
    // requireFanoutEvidence: true with no localImplementation.lightMode
    // configured at all — no inline verdict can ever qualify (lightMode stays
    // false), so this is the plain "over-threshold" refusal shape.
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");

    for (const verdict of ["clean", "findings_present", "blocked"]) {
      const env = await writeGhStub(tempDir, [
        ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      ]);
      const result = await runNode([
        "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
        "--verdict", verdict, "--findings-summary", "reviewed inline", "--next-action", "fix then re-gate",
        "--execution-mode", "inline_single_agent", "--inline-reason", "over-threshold local change",
      ], { env, cwd: tempDir });
      assert.equal(result.code, 1, `verdict=${verdict}: ${result.stderr}`);
      const payload = JSON.parse(result.stderr);
      assert.equal(payload.ok, false);
      // Mirrors the merge-time rejection wording (detect-checkpoint-evidence.mjs's
      // buildPreMergeGateCheck / evaluateInlineFanoutMode) verbatim, so an operator
      // sees the SAME diagnosis at post time as they would at merge time.
      assert.match(
        payload.error,
        /draft_gate: requireFanoutEvidence is enabled but executionMode is "inline_single_agent" \(expected "fanout_fanin"\); inline gate verdicts are not accepted/,
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict accepts an inline verdict under the light-mode threshold", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-postgate-light-accept-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  requireFanoutEvidence: true",
      "localImplementation:",
      "  lightMode:",
      "    enabled: true",
      "    maxFiles: 5",
      "    maxLines: 50",
      "",
    ].join("\n"), "utf8");

    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      // PR reviews fetch (evidence scan) and the internal-only-file probe both
      // run before enforcePostTimeFanoutMode's own light-facts fetch.
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"], stdout: "[]\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files", "--jq", ".files[].path"], stdout: "src/index.ts\n" },
      // The hermetic `git` PATH stub (see the file-level `before()` hook) always
      // reports an empty diff, so the merge-base scope re-derivation this fetch
      // feeds is always "0 files / 0 lines" — genuinely under ANY positive
      // threshold, exercising the real accept path, not a stubbed shortcut.
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "baseRefOid,labels"], stdout: '{"baseRefOid":"0000000000000000000000000000000000000000","labels":[]}\n' },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":201,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-201"}\n',
      },
    ], { repeatLastOnOverflow: true });
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"high":0}',
      "--findings-summary", "no issues found", "--next-action", "mark ready for review",
      "--execution-mode", "inline_single_agent", "--inline-reason", "micro-PR, under threshold",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "created");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed on an inline verdict when the base ref cannot be resolved (scope un-derivable)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-postgate-scope-underivable-"));
  try {
    // lightMode is enabled, but the light-facts fetch below fails — with no
    // base ref, scope re-derivation is skipped and the light-mode carve-out
    // can never apply, so the post is refused just like the plain
    // over-threshold case (same fail-closed posture as merge time).
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  requireFanoutEvidence: true",
      "localImplementation:",
      "  lightMode:",
      "    enabled: true",
      "    maxFiles: 5",
      "    maxLines: 50",
      "",
    ].join("\n"), "utf8");

    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "baseRefOid,labels"], exitCode: 1, stderr: "gh: rate limited\n" },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"high":0}',
      "--findings-summary", "no issues found", "--next-action", "mark ready for review",
      "--execution-mode", "inline_single_agent", "--inline-reason", "cannot prove scope",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /inline gate verdicts are not accepted/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict accepts a fanout_fanin verdict regardless of requireFanoutEvidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-postgate-fanout-accept-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(findingsPath, JSON.stringify([{ angle: "pr-description", verdict: "clean", findings: [] }]), "utf8");

    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":301,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-301"}\n',
      },
    ], { repeatLastOnOverflow: true });
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"high":0}',
      "--findings-json", findingsPath, "--next-action", "mark ready for review",
      "--execution-mode", "fanout_fanin",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).executionMode, "fanout_fanin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict posts an inline verdict without restriction when requireFanoutEvidence is false", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-postgate-opted-out-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":401,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-401"}\n',
      },
    ], { repeatLastOnOverflow: true });
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "clean", "--findings-severity-counts", '{"high":0}',
      "--findings-summary", "no issues found", "--next-action", "mark ready for review",
      "--execution-mode", "inline_single_agent", "--inline-reason", "opted out of fan-out evidence",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// One shared fixture, driven through BOTH the post-time refusal
// (upsertCheckpointVerdict, via enforcePostTimeFanoutMode) and the merge-time
// rejection (buildFanoutEnforcement + evaluateInlineFanoutMode, exactly as
// buildPreMergeGateCheck calls it) — proving the two boundaries reach the
// SAME verdict from the SAME facts because they share the one predicate.
test("upsert-checkpoint-verdict post-time refusal and detect-checkpoint-evidence merge-time rejection agree on the same fixture", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-postgate-agree-"));
  try {
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: true\n", "utf8");
    const fixture = {
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234000000000000000000000000000000000",
      executionMode: "inline_single_agent",
      inlineReason: "shared fixture: over-threshold local change",
    };

    // Post-time: the verdict does not exist yet — upsertCheckpointVerdict must
    // refuse to record it.
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], headSha: fixture.headSha }),
    ]);
    const postTimeResult = await runNode([
      "--repo", fixture.repo, "--pr", String(fixture.pr), "--gate", fixture.gate, "--head-sha", fixture.headSha,
      "--verdict", "clean", "--findings-summary", "reviewed inline", "--next-action", "fix then re-gate",
      "--execution-mode", fixture.executionMode, "--inline-reason", fixture.inlineReason,
    ], { env, cwd: tempDir });
    assert.equal(postTimeResult.code, 1);
    const postTimeError = JSON.parse(postTimeResult.stderr).error;

    // Merge-time: simulate the SAME verdict as if it HAD been posted (a marker
    // read back off the PR) and ask the exact merge-time predicate the same
    // question, from the same config/fixture facts.
    const { config } = await loadDevLoopConfig({ repoRoot: tempDir });
    const postedMarker = { visible: true, executionMode: fixture.executionMode, inlineReason: fixture.inlineReason, headSha: fixture.headSha };
    const invisibleMarker = { visible: false };
    const mergeTimeEnforcement = await buildFanoutEnforcement({
      repo: fixture.repo,
      pr: fixture.pr,
      currentHeadSha: fixture.headSha,
      draftGateMarker: postedMarker,
      preApprovalGateMarker: invisibleMarker,
      config,
      cwd: tempDir,
      hasFullLabel: false,
      baseRef: null,
    });
    assert.equal(mergeTimeEnforcement.required, true);
    const mergeTimeGate = mergeTimeEnforcement.gates.find((g) => g.name === "draft_gate");
    const mergeTimeError = evaluateInlineFanoutMode(mergeTimeGate, mergeTimeEnforcement);

    assert.ok(mergeTimeError, "expected merge-time to also reject this fixture");
    // Post-time wraps the SAME per-gate message with post-time framing; assert
    // the underlying diagnosis (the merge-time message) is verbatim-contained,
    // not paraphrased or re-derived.
    assert.ok(
      postTimeError.includes(mergeTimeError),
      `expected post-time error to contain the merge-time message verbatim.\npost-time: ${postTimeError}\nmerge-time: ${mergeTimeError}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The documented tier-4 (withheld) posting path: a fanout_fanin round consolidate-fanin
// could not render even at minimum shape has neither --out nor --findings-json available
// (see the sub-loop contract's "Execution mode and fan-out evidence enforcement"), so the
// caller posts with --findings-summary only — no --findings-json. draft_gate configures a
// mandatory angle (pr-description) by default, and this call carries neither --findings-json
// nor --findings-ledger — i.e. no coverage proof at all — so it is now REFUSED fail-closed
// (this used to be the exact reachable bypass: enforcement was a policy obligation on the
// agent, not a mechanism). See the sibling --findings-ledger tests below for the covered
// and refused-for-missing-angle withheld shapes that DO carry proof.
test("upsert-checkpoint-verdict refuses a withheld (tier-4) fanout_fanin round via --findings-summary alone when the gate has a mandatory angle and neither --findings-json nor --findings-ledger is supplied", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-tier4-findings-summary-"));
  try {
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present",
      "--findings-summary", "round withheld: too wide to render even at minimum shape — recorded in the disposition ledger",
      "--next-action", "fix must-fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires coverage proof via --findings-json or --findings-ledger/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict posts a withheld fanout_fanin round via --findings-summary alone when the gate has NO mandatory angle configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-tier4-no-mandatory-"));
  try {
    // draft_gate's only mandatory angle (pr-description) disabled via a D3
    // merge-by-name override, so mandatoryAngles resolves empty and the
    // coverage guard never engages — pinning the escape hatch every
    // no-mandatory-angle consumer repo relies on.
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  draft:",
      "    angles:",
      "      - name: pr-description",
      "        enabled: false",
      "",
    ].join("\n"), "utf8");
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["**Execution mode:** fanout_fanin"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
      "--verdict", "findings_present",
      "--findings-summary", "round withheld: too wide to render even at minimum shape — recorded in the disposition ledger",
      "--next-action", "fix must-fix then re-gate", "--execution-mode", "fanout_fanin",
    ], { env, cwd: tempDir });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.executionMode, "fanout_fanin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict CLI fails closed for inline mode without --inline-reason", async () => {
  // End-to-end argument-error path: a complete call that resolves to the default
  // inline mode but omits --inline-reason exits 1 with a clear argument error
  // (FIX B). runNodeHelper is used directly so no inline reason is auto-appended.
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234000000000000000000000000000000000",
    "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"nice-to-have":0}',
    "--findings-summary", "no issues found", "--next-action", "mark ready for review",
  ];
  const result = await runNodeHelper(scriptPath, args, {
    env: { ...process.env, DEVLOOPS_RUN_ID: "" },
  });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /--inline-reason is required for executionMode inline_single_agent/i);
});

// ---------------------------------------------------------------------------
// Single-surface gate rounds (--findings-ledger)
// ---------------------------------------------------------------------------

const SINGLE_SURFACE_HEAD = "abc1234000000000000000000000000000000000";

// A minimal in-diff patch: new-file lines 1-4 of src/db.mjs are commentable.
const SINGLE_SURFACE_PATCH = ["@@ -1,3 +1,5 @@", " line1", "-old line2", "+new line2", "+new line3", " line4"].join("\n");

async function writeSingleSurfaceLedger(tempDir, findings, overrides = {}) {
  // These tests are about the finding-surface/ledger mechanics, not fan-out
  // evidence, and use a bare tempDir as repoRoot (schema default:
  // requireFanoutEvidence: true) — disable it unless a test already staged
  // its own .devloops (e.g. for angle-pool configuration) before calling this.
  const devloopsPath = path.join(tempDir, ".devloops");
  try {
    await readFile(devloopsPath, "utf8");
  } catch {
    await writeFile(devloopsPath, "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
  }
  const ledgerPath = path.join(tempDir, "ledger.json");
  await writeFile(ledgerPath, JSON.stringify({
    repo: "owner/repo",
    pr: 17,
    gate: "draft_gate",
    headSha: SINGLE_SURFACE_HEAD,
    verdict: "findings_present",
    findings,
    ...overrides,
  }), "utf8");
  return ledgerPath;
}

// The gh calls a --findings-ledger round makes, in order: the coordination
// context + internal-only probe, then the finding-surface reads
// (login, reviews, issue comments, threads, PR files).
function singleSurfaceLeadingEntries({ isDraft = true, issueComments = [], reviews = [], threads = [], files = [{ filename: "src/db.mjs", patch: SINGLE_SURFACE_PATCH }], lightFacts = reviews.length > 0 } = {}) {
  return [
    {
      assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
      stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft, headRefOid: SINGLE_SURFACE_HEAD, body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
    },
    { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
    { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: JSON.stringify({ headRefOid: SINGLE_SURFACE_HEAD }) + "\n" },
    { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify(issueComments) + "\n" },
    { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"], stdout: JSON.stringify(reviews) + "\n" },
    // A visible same-head inline verdict makes detect-checkpoint-evidence fetch
    // the light-mode facts (base ref + labels) before the internal-only probe.
    ...(lightFacts ? [{ assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "baseRefOid,labels"], stdout: '{"baseRefOid":"0000000000000000000000000000000000000000","labels":[]}\n' }] : []),
    { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/db.mjs\n" },
    { assertArgs: ["api", "user"], stdout: '{"login":"gate-bot"}\n' },
    { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"], stdout: JSON.stringify(reviews) + "\n" },
    { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify(issueComments) + "\n" },
    {
      assertArgs: ["api", "graphql"],
      assertArgContains: ["reviewThreads"],
      stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } }) + "\n",
    },
    ...(files === null ? [] : [{ assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/files?per_page=100"], stdout: JSON.stringify(files) + "\n" }]),
  ];
}

const LOCATABLE_FINDING = { severity: "must-fix", angle: "correctness", summary: "SQL injection in the query builder", files: ["src/db.mjs"], line: 2, recommendation: "parameterize it" };
const BODY_FILED_FINDING = { severity: "nice-to-have", angle: "coverage", summary: "inconsistent casing in constants" };

// AC1 + AC2: one review carries the verdict fields, the reduced per-angle
// digest, the body-filed finding, and the locatable finding as an INLINE
// comment — each finding's text appearing exactly once across the round.
test("upsert-checkpoint-verdict --findings-ledger posts ONE review: inline locatable finding, body-filed rest, counts-only digest", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-single-surface-"));
  try {
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, [LOCATABLE_FINDING, BODY_FILED_FINDING]);
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(findingsPath, JSON.stringify([
      { angle: "pr-description", verdict: "clean", findings: [] },
      { angle: "scope", verdict: "clean", findings: [] },
      { angle: "correctness", verdict: "findings_present", findings: [{ severity: "must-fix", summary: LOCATABLE_FINDING.summary, file: "src/db.mjs", line: 2 }] },
      { angle: "coverage", verdict: "findings_present", findings: [{ severity: "nice-to-have", summary: BODY_FILED_FINDING.summary }] },
    ]), "utf8");

    let postedPayload = null;
    const entries = [
      ...singleSurfaceLeadingEntries(),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":701,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-701"}\n',
      },
    ];
    // No repeatLastOnOverflow: `entries` already covers every call the happy
    // path makes, so ANY extra gh call (a second review post above all) exits
    // 97 and fails the run rather than being answered with the same payload.
    const { runChild, calls } = makeGhMock(entries);
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsJson: findingsPath,
      findingsLedger: ledgerPath,
      nextAction: "stay draft and fix",
      executionMode: "fanout_fanin",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir });

    assert.equal(result.action, "created");
    assert.equal(result.surface, "review");
    assert.equal(result.round, 1);
    assert.equal(result.inlineComments, 1);
    assert.equal(result.bodyFiled, 1);
    assert.equal(result.suppressed, 0);

    const postCalls = calls.filter((c) => c.args.includes("repos/owner/repo/pulls/17/reviews") && c.args.includes("POST"));
    assert.equal(postCalls.length, 1);
    postedPayload = JSON.parse(postCalls[0].stdinText);
    assert.equal(postedPayload.event, "COMMENT");
    assert.equal(postedPayload.commit_id, SINGLE_SURFACE_HEAD);

    // The locatable finding is an inline comment on the review, and its text
    // appears there and nowhere else.
    assert.equal(postedPayload.comments.length, 1);
    assert.equal(postedPayload.comments[0].path, "src/db.mjs");
    assert.equal(postedPayload.comments[0].line, 2);
    assert.equal(postedPayload.comments[0].side, "RIGHT");
    assert.match(postedPayload.comments[0].body, /SQL injection in the query builder/);
    assert.doesNotMatch(postedPayload.body, /SQL injection in the query builder/);

    // The body-filed finding's text appears exactly once in the body.
    assert.equal(postedPayload.body.split(BODY_FILED_FINDING.summary).length - 1, 1);

    // The per-angle digest carries angle, verdict and counts only.
    assert.match(postedPayload.body, /^- `correctness` → `findings_present` \(1 finding\)$/m);
    assert.match(postedPayload.body, /^- `coverage` → `findings_present` \(1 finding\)$/m);
    // The gate-scoped round marker rides on the same body.
    assert.match(postedPayload.body, /^<!-- dev-loops:gate-findings-review draft_gate [0-9a-f]{40} round=1 -->$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// AC5: an own-authored thread already carrying the finding's fingerprint drops
// it before posting; a foreign-authored one never does.
test("upsert-checkpoint-verdict --findings-ledger suppresses a finding an OWN-authored thread already covers, but not a foreign one", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-single-surface-suppress-"));
  try {
    const foreignFinding = { severity: "worth-fixing-now", angle: "dry", summary: "duplicated validation logic", files: ["src/utils.mjs"] };
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, [LOCATABLE_FINDING, foreignFinding]);
    const threadFor = (finding, author) => ({
      id: `THREAD_${author}`,
      isResolved: true,
      isOutdated: false,
      path: finding.files[0],
      line: finding.line ?? null,
      comments: { nodes: [{ id: "gid-1", databaseId: 601, body: buildFindingMarker({ fp: fingerprintFinding(finding), severity: finding.severity, angle: finding.angle, round: 1 }), author: { login: author, __typename: "User" } }] },
    });

    const entries = [
      ...singleSurfaceLeadingEntries({ threads: [threadFor(LOCATABLE_FINDING, "gate-bot"), threadFor(foreignFinding, "someone-else")] }),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":702,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-702"}\n',
      },
    ];
    const { runChild, calls } = makeGhMock(entries);
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsSummary: "2 findings",
      findingsLedger: ledgerPath,
      nextAction: "stay draft and fix",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir });

    assert.equal(result.suppressed, 1);
    assert.equal(result.inlineComments, 0);
    assert.equal(result.bodyFiled, 1);
    const postCall = calls.find((c) => c.args.includes("repos/owner/repo/pulls/17/reviews") && c.args.includes("POST"));
    const posted = JSON.parse(postCall.stdinText);
    assert.doesNotMatch(posted.body, /SQL injection in the query builder/);
    assert.match(posted.body, /duplicated validation logic/);
    assert.equal(calls.filter((c) => c.args.includes("POST") && c.args.includes("repos/owner/repo/pulls/17/reviews")).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// AC4: a same-head rerun corrects the existing REVIEW in place. GitHub exposes
// no endpoint to add inline comments to a submitted review, so every
// still-unposted finding is body-filed instead of dropped.
test("upsert-checkpoint-verdict --findings-ledger corrects an existing same-head REVIEW in place, body-filing the findings", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-single-surface-update-"));
  try {
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, [LOCATABLE_FINDING]);
    const existingReview = {
      id: 705,
      submitted_at: "2026-08-03T10:00:00Z",
      html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-705",
      body: renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: SINGLE_SURFACE_HEAD,
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        executionMode: "inline_single_agent",
        inlineReason: "single-agent inline review (test)",
      }),
    };
    const entries = [
      ...singleSurfaceLeadingEntries({ reviews: [existingReview], files: null }),
      {
        assertArgs: ["api", "-X", "PUT", "repos/owner/repo/pulls/17/reviews/705", "--input", "-"],
        assertStdinIncludes: ["**Verdict:** findings_present", "SQL injection in the query builder"],
        stdout: '{"id":705,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-705"}\n',
      },
    ];
    const { runChild, calls } = makeGhMock(entries);
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsSummary: "1 finding",
      findingsLedger: ledgerPath,
      nextAction: "stay draft and fix",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir });

    assert.equal(result.action, "updated");
    assert.equal(result.surface, "review");
    assert.equal(result.commentId, 705);
    // No inline comments on a correction; the locatable finding is body-filed.
    assert.equal(result.inlineComments, 0);
    assert.equal(result.bodyFiled, 1);
    assert.ok(!calls.some((c) => c.args.includes("POST") && c.args.includes("repos/owner/repo/pulls/17/reviews")));
    assert.equal(calls.filter((c) => c.args.includes("PUT") && c.args.includes("repos/owner/repo/pulls/17/reviews/705")).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// AC4: an identical same-head rerun posts nothing at all.
test("upsert-checkpoint-verdict --findings-ledger: an identical same-head rerun is a noop that posts nothing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-single-surface-noop-"));
  try {
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, []);
    const existingReview = {
      id: 706,
      submitted_at: "2026-08-03T10:00:00Z",
      html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-706",
      body: renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: SINGLE_SURFACE_HEAD,
        verdict: "findings_present",
        findingsSummary: "1 finding",
        nextAction: "stay draft and fix",
        executionMode: "inline_single_agent",
        inlineReason: "single-agent inline review (test)",
        round: 1,
        nonLocatableFindings: [],
      }),
    };
    const { runChild, calls } = makeGhMock(singleSurfaceLeadingEntries({ reviews: [existingReview], files: null }), { repeatLastOnOverflow: true });
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsSummary: "1 finding",
      findingsLedger: ledgerPath,
      nextAction: "stay draft and fix",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir });

    assert.equal(result.action, "noop");
    assert.equal(result.surface, "review");
    assert.equal(result.commentId, 706);
    assert.ok(!calls.some((c) => c.args.includes("POST") || c.args.includes("PUT")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The digest collapses findings to severity counts, so a rerun whose ledger
// swapped one finding for another at the same severity keeps every compared
// verdict field byte-identical. The finding surface itself has to break the
// noop, or the new finding would silently never be posted.
test("upsert-checkpoint-verdict --findings-ledger: a same-head rerun with a SWAPPED finding at unchanged verdict fields is NOT a noop", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-single-surface-swap-"));
  try {
    const postedFinding = { severity: "worth-fixing-now", angle: "coverage", summary: "the retry path has no test" };
    const swappedFinding = { severity: "worth-fixing-now", angle: "coverage", summary: "the timeout path has no test" };
    // The already-posted round: its body carries postedFinding's fingerprint,
    // and gate-bot authored it, so a rerun suppresses that finding.
    const existingReview = {
      id: 707,
      user: { login: "gate-bot" },
      submitted_at: "2026-08-03T10:00:00Z",
      html_url: "https://github.com/owner/repo/pull/17#pullrequestreview-707",
      body: renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: SINGLE_SURFACE_HEAD,
        verdict: "findings_present",
        findingsSummary: "1 finding",
        nextAction: "stay draft and fix",
        executionMode: "inline_single_agent",
        inlineReason: "single-agent inline review (test)",
        round: 1,
        nonLocatableFindings: [postedFinding],
      }),
    };
    // Identical across BOTH calls: only the ledger's finding differs.
    const verdictOptions = {
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsSummary: "1 finding",
      nextAction: "stay draft and fix",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      findingsLedger: path.join(tempDir, "ledger.json"),
    };
    const ghOptions = { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", repoRoot: tempDir };

    // Control: the SAME ledger the posted review already carries still noops.
    await writeSingleSurfaceLedger(tempDir, [postedFinding]);
    const control = makeGhMock(singleSurfaceLeadingEntries({ reviews: [existingReview], files: null }));
    const controlResult = await upsertCheckpointVerdict(verdictOptions, { ...ghOptions, runChild: control.runChild });
    assert.equal(controlResult.action, "noop");
    assert.equal(controlResult.suppressed, 1);
    assert.equal(controlResult.bodyFiled, 0);

    // The swap: same verdict/summary/nextAction/mode, a different finding.
    await writeSingleSurfaceLedger(tempDir, [swappedFinding]);
    const { runChild, calls } = makeGhMock([
      ...singleSurfaceLeadingEntries({ reviews: [existingReview], files: null }),
      {
        assertArgs: ["api", "-X", "PUT", "repos/owner/repo/pulls/17/reviews/707", "--input", "-"],
        assertStdinIncludes: [swappedFinding.summary],
        stdout: '{"id":707,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-707"}\n',
      },
    ]);
    const result = await upsertCheckpointVerdict(verdictOptions, { ...ghOptions, runChild });

    assert.equal(result.action, "updated");
    assert.equal(result.bodyFiled, 1);
    assert.equal(result.suppressed, 0);
    assert.equal(calls.filter((c) => c.args.includes("PUT")).length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Fail closed rather than post one round's findings onto another's verdict.
test("upsert-checkpoint-verdict rejects a --findings-ledger written for a different gate/head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-single-surface-mismatch-"));
  try {
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, [], { gate: "pre_approval_gate" });
    const { runChild } = makeGhMock(singleSurfaceLeadingEntries(), { repeatLastOnOverflow: true });
    await assert.rejects(
      () => upsertCheckpointVerdict({
        repo: "owner/repo",
        pr: 17,
        gate: "draft_gate",
        headSha: SINGLE_SURFACE_HEAD,
        verdict: "findings_present",
        findingsSummary: "no findings",
        findingsLedger: ledgerPath,
        nextAction: "stay draft and fix",
        executionMode: "inline_single_agent",
        inlineReason: "single-agent inline review (test)",
      }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir }),
      /refuse to post another round's findings/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Withheld tier (no --findings-json), but --findings-ledger's provenance
// fully covers the gate's mandatory angles: the round posts exactly as a
// covered round would.
test("upsert-checkpoint-verdict posts a withheld fanout_fanin verdict when --findings-ledger's provenance fully covers the gate's mandatory angles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-withheld-covered-"));
  try {
    // Pin draft_gate's mandatory angle explicitly rather than relying on the
    // packaged extension-defaults layer for this empty temp root: this test
    // (unlike its negative siblings above, which resolve config from the
    // worktree's own .devloops via runNode) passes repoRoot: tempDir directly,
    // so without this file a future default change could silently empty
    // mandatoryAngles and this positive assertion would keep passing green
    // while proving nothing.
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  draft:",
      "    angles:",
      "      - name: pr-description",
      "        mandatory: true",
      "",
    ].join("\n"), "utf8");
    const ledgerPath = await writeSingleSurfaceLedger(tempDir, [BODY_FILED_FINDING], {
      provenance: {
        distinctReviewers: 2,
        perAngle: [
          { angle: "pr-description", reviewer: "agent-a" },
          { angle: "coverage", reviewer: "agent-b" },
        ],
      },
    });
    const entries = [
      ...singleSurfaceLeadingEntries(),
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stdout: '{"id":702,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-702"}\n',
      },
    ];
    const { runChild } = makeGhMock(entries);
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: SINGLE_SURFACE_HEAD,
      verdict: "findings_present",
      findingsSummary: "round too large to render per-angle; see ledger",
      findingsLedger: ledgerPath,
      nextAction: "stay draft and fix",
      executionMode: "fanout_fanin",
    }, { env: { ...process.env, DEVLOOPS_RUN_ID: "" }, ghCommand: "gh", runChild, repoRoot: tempDir });

    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    assert.equal(result.bodyFiled, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeStructuredFindings aliases the legacy severity so no posted body renders it", () => {
  const angles = normalizeStructuredFindings([
    { angle: "docs", verdict: "findings_present", findings: [{ severity: "defer", summary: "legacy entry" }] },
  ]);
  assert.equal(angles[0].findings[0].severity, "low"); // "defer" normalizes to canonical "low"
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: angles,
  });
  assert.ok(body.includes("[`low`]"));
  assert.ok(!body.includes("[`defer`]"));
});
