import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import { detectPrGateCoordinationState, fetchPrFactsWithSettledMergeable, parseGitStatusConflictFiles, extractChangedFiles, deriveUiE2ePassed } from "../../scripts/loop/detect-pr-gate-coordination-state.mjs";
import { PR_CHECKPOINT, PR_CHECKPOINT_ACTION } from "@dev-loops/core/loop/pr-gate-coordination";

const scriptPath = path.resolve("scripts/loop/detect-pr-gate-coordination-state.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: {
    ...process.env,
    ...(options.env ?? {}),
    DEVLOOPS_RUN_ID: options.env?.DEVLOOPS_RUN_ID ?? "",
  },
});

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  // Hermetic guard (#1006): seed a clean local git stub on the same PATH dir so
  // the subprocess CLI's fetchLocalConflictFiles never shells out to the real
  // working tree. Without this, concurrent git activity under parallel
  // `npm run verify` transiently reports unmerged entries and flips these
  // gh-driven suites to conflict_resolution. Tests needing a specific git
  // response (e.g. the conflict-resolution case) overwrite this stub afterward.
  const gitEnv = await writeGitStub(tempDir, { stdout: "" });
  return { ...env, ...gitEnv, DEVLOOPS_RUN_ID: "" };
}

async function writeGitStub(tempDir, { stdout = "", stderr = "", exitCode = 0, assertArgs = [] } = {}) {
  const gitPath = path.join(tempDir, "git");
  const stdoutPath = path.join(tempDir, "git-stdout.txt");

  await writeFile(stdoutPath, stdout, "utf8");
  await writeFile(
    gitPath,
    [
      "#!/usr/bin/env node",
      'import { readFileSync } from "node:fs";',
      'const actual = process.argv.slice(2);',
      'const assertArgs = JSON.parse(process.env.GIT_ASSERT_ARGS || "[]");',
      'for (const expected of assertArgs) {',
      '  if (!actual.includes(expected)) {',
      '    process.stderr.write(`missing expected git arg: ${expected}\nactual: ${actual.join(" ")}\n`);',
      '    process.exit(98);',
      '  }',
      '}',
      'if (process.env.GIT_STDERR) process.stderr.write(process.env.GIT_STDERR);',
      'if (process.env.GIT_STDOUT_PATH) process.stdout.write(readFileSync(process.env.GIT_STDOUT_PATH, "utf8"));',
      'process.exit(Number(process.env.GIT_EXIT_CODE || "0"));',
      '',
    ].join("\n"),
    "utf8",
  );
  await chmod(gitPath, 0o755);

  return {
    GIT_ASSERT_ARGS: JSON.stringify(assertArgs),
    GIT_STDOUT_PATH: stdoutPath,
    GIT_STDERR: stderr,
    GIT_EXIT_CODE: String(exitCode),
  };
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

test("parseGitStatusConflictFiles parses NUL-delimited porcelain output with deterministic paths", () => {
  const parsed = parseGitStatusConflictFiles([
    "UU config.test.mjs",
    "AA extension/README with spaces.md",
    "UU  spaced-at-both-ends.txt ",
    " M ignored.txt",
    "R  old-name.md",
    "new-name.md",
    "",
  ].join("\0"));

  assert.deepEqual(parsed, ["config.test.mjs", "extension/README with spaces.md", " spaced-at-both-ends.txt "]);
});

test("fetchPrFactsWithSettledMergeable re-polls while mergeable is UNKNOWN, then returns the settled value (#980)", async () => {
  const responses = [
    { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
    { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
  ];
  let calls = 0;
  const fetch = async () => responses[calls++];
  const result = await fetchPrFactsWithSettledMergeable(
    { repo: "owner/repo", pr: 1 },
    { fetch, sleep: async () => {}, maxPolls: 5 },
  );
  assert.equal(calls, 3);
  assert.equal(result.mergeable, "MERGEABLE");
});

test("fetchPrFactsWithSettledMergeable stops re-polling at the cap and returns the still-UNKNOWN value (fail closed to recheck) (#980)", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { mergeable: "UNKNOWN" }; };
  const result = await fetchPrFactsWithSettledMergeable(
    { repo: "owner/repo", pr: 1 },
    { fetch, sleep: async () => {}, maxPolls: 2 },
  );
  // initial fetch + 2 re-polls
  assert.equal(calls, 3);
  assert.equal(result.mergeable, "UNKNOWN");
});

test("detect-pr-gate-coordination-state allows post-draft flow for non-draft PRs with clean draft_gate on a different head (one-time boundary)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-state-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "def56789abcdef",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                },
              },
            },
          },
        }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "def56789abcdef" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 11,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: c94679e",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            html_url: "https://example.test/comment/11",
            updated_at: "2026-05-31T20:00:00Z",
          },
        ]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      repo: "owner/repo",
      pr: 266,
      currentHeadSha: "def56789abcdef",
      mergeStateStatus: null,
      conflictFiles: [],
      lifecycleState: "pr_ready_no_feedback",
      loopDisposition: "action_required",
      gateBoundary: "post_draft_external_review",
      draftGate: {
        visible: true,
        markerVisible: false,
        anyVisible: true,
        currentHead: false,
        headSha: "c94679e",
        verdict: "clean",
        findingsSummary: "no issues found",
        nextAction: "mark ready for review",
        contractComplete: false,
        currentHeadClean: false,
        cleanEvidenceExists: true,
      },
      preApprovalGate: {
        visible: false,
        markerVisible: false,
        anyVisible: false,
        currentHead: false,
        headSha: null,
        verdict: null,
        findingsSummary: null,
        nextAction: null,
        contractComplete: false,
        currentHeadClean: false,
        cleanEvidenceExists: false,
      },
      allowedNextActions: ["request_copilot_review"],
      forbiddenActions: [
        "run_draft_gate",
        "mark_ready_for_review",
        "run_pre_approval_gate",
        "declare_merge_ready",
      ],
      nextAction: "request_copilot_review",
      reason: "The PR is ready for review but the post-draft external review cycle has not started yet; request Copilot review before any `pre_approval_gate` entry.",
      draftGateAlreadySatisfied: true,
      copilotReviewRoundCount: 0,
      gateEvidenceRequiredForMerge: true,
      refinementArtifact: {
        status: "unknown",
        linkedIssue: null,
        linkedIssues: [],
        reason: "No deterministically resolvable linked issue (no closingIssuesReferences and no Closes/Fixes/Resolves #n reference in body).",
      },
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state flags draft_gate_needed for non-draft PRs with no draft_gate evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-no-draft-evidence-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "def56789abcdef",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "def56789abcdef" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gateBoundary, "draft_gate_needed");
    assert.equal(parsed.nextAction, "reconcile_draft_gate");
    assert.equal(parsed.draftGateAlreadySatisfied, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state flags draft_gate_needed for converged non-draft PRs with no draft_gate evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-no-draft-evidence-converged-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "def56789abcdef",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "def56789abcdef" },
              submittedAt: "2026-05-31T20:00:00Z",
            },
          ],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "def56789abcdef" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 30,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: def56789abcdef",
              "Verdict: findings_present",
              "Findings summary: lint warnings in 3 files",
              "Next action: fix findings and rerun gate",
            ].join("\n"),
            html_url: "https://example.test/comment/30",
            updated_at: "2026-05-31T20:00:00Z",
          },
        ]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.lifecycleState, "ready_to_rerequest_review");
    assert.equal(parsed.gateBoundary, "draft_gate_needed");
    assert.equal(parsed.nextAction, "reconcile_draft_gate");
    assert.equal(parsed.draftGateAlreadySatisfied, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("detect-pr-gate-coordination-state flags draft_gate_needed when Copilot round cap is exhausted without draft_gate", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-round-cap-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "def56789abcdef",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "1111111111111111111111111111111111111111" },
              submittedAt: "2026-05-31T20:00:00Z",
            },
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "2222222222222222222222222222222222222222" },
              submittedAt: "2026-05-31T20:05:00Z",
            },
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "3333333333333333333333333333333333333333" },
              submittedAt: "2026-05-31T20:10:00Z",
            },
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "4444444444444444444444444444444444444444" },
              submittedAt: "2026-05-31T20:15:00Z",
            },
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "5555555555555555555555555555555555555555" },
              submittedAt: "2026-05-31T20:20:00Z",
            },
          ],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "def56789abcdef" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 31,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: def56789abcdef",
              "Verdict: findings_present",
              "Findings summary: lint warnings in 3 files",
              "Next action: fix findings and rerun gate",
            ].join("\n"),
            html_url: "https://example.test/comment/31",
            updated_at: "2026-05-31T20:00:00Z",
          },
        ]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    // #896: a post-cap clean head (rounds exhausted, zero unresolved threads,
    // green CI) is now correctly interpreted as round_cap_clean_fallback rather
    // than dead-ending at ready_to_rerequest_review. Because this PR still lacks
    // any clean draft_gate evidence, the #579 no-exemptions post-pass keeps the
    // gate boundary at draft_gate_needed (reconcile_draft_gate) — never a
    // rerequest dead-end at the round cap.
    assert.equal(parsed.lifecycleState, "round_cap_clean_fallback");
    assert.equal(parsed.gateBoundary, "draft_gate_needed");
    assert.equal(parsed.nextAction, "reconcile_draft_gate");
    assert.equal(parsed.gateEvidenceNote, null);
    assert.deepEqual(parsed.allowedNextActions, ["reconcile_draft_gate"]);
    assert.ok(parsed.forbiddenActions.includes("run_pre_approval_gate"));
    assert.ok(parsed.forbiddenActions.includes("await_final_human_approval"));
    assert.ok(parsed.forbiddenActions.includes("declare_merge_ready"));
    assert.match(parsed.reason, /no gate exemptions, #579/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state routes a post-cap clean head to pre_approval (round_cap_clean_fallback, #896)", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-896-fallback-"));

  try {
    // Non-draft PR. Copilot reviewed 5 older heads (cap = built-in default 5).
    // Current head "def567" has NO Copilot review, zero unresolved threads, green
    // CI, and a clean draft_gate comment on the SAME current head (so no round
    // reset). The deadlock (#896) would have produced ready_to_rerequest_review +
    // a forbidden pre_approval; the fix routes to round_cap_clean_fallback and
    // permits run_pre_approval_gate.
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "def56789abcdef",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "1111111111111111111111111111111111111111" }, submittedAt: "2026-05-31T20:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "2222222222222222222222222222222222222222" }, submittedAt: "2026-05-31T20:05:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "3333333333333333333333333333333333333333" }, submittedAt: "2026-05-31T20:10:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "4444444444444444444444444444444444444444" }, submittedAt: "2026-05-31T20:15:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "5555555555555555555555555555555555555555" }, submittedAt: "2026-05-31T20:20:00Z" },
          ],
        }),
      },
      { assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"], stdout: jsonLine({ users: [], teams: [] }) },
      { assertArgs: ["api", "graphql", "pr=266"], stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) },
      { assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"], stdout: jsonLine({ headRefOid: "def56789abcdef" }) },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 21,
            body: ["Gate review: draft_gate", "Reviewed head SHA: def56789abcdef", "Verdict: clean", "Findings summary: no issues found", "Next action: mark ready for review"].join("\n"),
            html_url: "https://example.test/comment/21",
            updated_at: "2026-05-31T19:00:00Z",
          },
        ]]),
      },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/266/reviews?per_page=100"], stdout: '[]\n' },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.lifecycleState, "round_cap_clean_fallback");
    // No contract-complete pre_approval marker exists for the post-cap head yet,
    // so the boundary normalizes to pre_approval_gate_needed — but the key point is
    // run_pre_approval_gate is PERMITTED (the #896 deadlock is gone), not a rerequest
    // the round cap forbids.
    assert.equal(parsed.gateBoundary, "pre_approval_gate_needed");
    assert.equal(parsed.nextAction, "run_pre_approval_gate");
    assert.ok(parsed.allowedNextActions.includes("run_pre_approval_gate"));
    assert.ok(!parsed.forbiddenActions.includes("run_pre_approval_gate"));
    // The cap forbids any further Copilot (re-)request — no rerequest dead-end.
    assert.ok(!parsed.allowedNextActions.includes("request_copilot_review"));
    assert.ok(!parsed.allowedNextActions.includes("rerequest_copilot_review"));
    // request-copilot-review and detect agree on the round count (5) and cap.
    assert.equal(parsed.copilotReviewRoundCount, 5);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state auto-detects local-fix-without-reply (#464) when unresolved threads exist on older review commit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-464-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "269", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 269,
          state: "OPEN",
          isDraft: false,
          headRefOid: "abababababababababababababababababababab",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" },
              submittedAt: "2026-06-01T12:00:00Z",
            },
          ],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/269/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=269"],
        stdout: jsonLine({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            id: "comment-1",
                            databaseId: 1001,
                            body: "This needs a fix",
                            author: { login: "copilot-pull-request-reviewer", __typename: "Bot" },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
      {
        assertArgs: ["pr", "view", "269", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "abababababababababababababababababababab" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/269/comments?per_page=100"],
        stdout: jsonLine([
          [
            {
              id: 50,
              body: [
                "Gate review: draft_gate",
                "Reviewed head SHA: abababababababababababababababababababab",
                "Verdict: clean",
                "Findings summary: Initial draft gate.",
                "Next action: Mark ready for review.",
              ].join("\n"),
              html_url: "https://example.test/comment/50",
              updated_at: "2026-06-01T12:00:00Z",
            },
          ],
        ]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "269"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.lifecycleState, "already_fixed_needs_reply_resolve");
    assert.equal(parsed.nextAction, "reply_resolve_review_threads");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detectPrGateCoordinationState tolerates missing local git binary and falls back to GitHub-only facts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-missing-git-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "fedcba987654",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "fedcba987654" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await detectPrGateCoordinationState(
      { repo: "owner/repo", pr: 266 },
      { env, gitCommand: "definitely-missing-git" },
    );

    assert.equal(result.ok, true);
    assert.equal(result.mergeStateStatus, "CLEAN");
    assert.deepEqual(result.conflictFiles, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state preserves non-conflict mergeStateStatus values in helper output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-merge-state-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "fedcba987654",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "fedcba987654" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 21,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: fedcba9",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: request Copilot review",
            ].join("\n"),
            html_url: "https://example.test/comment/21",
            updated_at: "2026-05-31T20:00:00Z",
          },
        ]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gateBoundary, "post_draft_external_review");
    assert.equal(parsed.nextAction, "request_copilot_review");
    assert.equal(parsed.mergeStateStatus, "CLEAN");
    assert.deepEqual(parsed.conflictFiles, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state surfaces conflict_resolution for conflicted PRs and reports conflict files", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-conflict-"));

  try {
    const ghEnv = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "370", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 370,
          state: "OPEN",
          isDraft: false,
          headRefOid: "deadbeef1234",
          mergeStateStatus: "DIRTY",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/370/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=370"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "370", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "deadbeef1234" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/370/comments?per_page=100"],
        stdout: "[]\n",
      },
    ]);
    const gitEnv = await writeGitStub(tempDir, {
      assertArgs: ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=no"],
      stdout: "UU config.test.mjs\0AA extension/README.md\0",
    });

    const result = await runNode(["--repo", "owner/repo", "--pr", "370"], {
      env: { ...ghEnv, ...gitEnv },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gateBoundary, "conflict_resolution");
    assert.equal(parsed.nextAction, "resolve_merge_conflicts");
    assert.equal(parsed.mergeStateStatus, "DIRTY");
    assert.deepEqual(parsed.conflictFiles, ["config.test.mjs", "extension/README.md"]);
    assert.deepEqual(parsed.allowedNextActions, ["resolve_merge_conflicts"]);
    assert(parsed.forbiddenActions.includes("run_pre_approval_gate"));
    assert(parsed.forbiddenActions.includes("await_final_human_approval"));
    assert(parsed.forbiddenActions.includes("declare_merge_ready"));
    assert.match(parsed.reason, /config\.test\.mjs/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.skip("detect-pr-gate-coordination-state with --review-mode internal_only skips Copilot review", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-local-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "267", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 267,
          state: "OPEN",
          isDraft: false,
          headRefOid: "ccc1234567890",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/267/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=267"],
        stdout: jsonLine({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                },
              },
            },
          },
        }),
      },
      {
        assertArgs: ["pr", "view", "267", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "ccc1234567890" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/267/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 12,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: ccc1234567890",
              "Verdict: clean",
              "Findings summary: no issues found",
              "Next action: mark ready for review",
            ].join("\n"),
            html_url: "https://example.test/comment/12",
            updated_at: "2026-05-31T20:00:00Z",
          },
          {
            id: 13,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: ccc1234567890",
              "Verdict: findings_present",
              "Findings summary: lint warnings in 3 files",
              "Next action: fix findings and rerun gate",
            ].join("\n"),
            html_url: "https://example.test/comment/13",
            updated_at: "2026-05-31T20:01:00Z",
          },
        ]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "267", "--review-mode", "internal_only"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gateBoundary, "pre_approval_gate_window");
    assert.equal(parsed.nextAction, "run_pre_approval_gate");
    assert(parsed.forbiddenActions.includes("request_copilot_review"));
    assert(parsed.allowedNextActions.includes("run_pre_approval_gate"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("pre-approval-gate-detector overrides to pre_approval_gate_needed when never entered", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-never-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "268", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 268,
          state: "OPEN",
          isDraft: false,
          headRefOid: "fedcba987654",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "fedcba987654" },
              submittedAt: "2026-05-31T20:01:00Z",
            },
          ],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/268/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=268"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "268", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "fedcba987654" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/268/comments?per_page=100"],
        // Clean draft_gate comment present; no pre_approval_gate comment
        stdout: jsonLine([
          [
            {
              id: 60,
              body: [
                "Gate review: draft_gate",
                "Reviewed head SHA: fedcba987654",
                "Verdict: clean",
                "Findings summary: Draft gate passed.",
                "Next action: Mark ready for review.",
              ].join("\n"),
              html_url: "https://example.test/comment/60",
              updated_at: "2026-05-31T20:00:00Z",
            },
          ],
        ]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "268"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.gateBoundary, "post_draft_external_review");
    assert.equal(parsed.nextAction, "request_copilot_review");
    assert.match(parsed.reason, /No formal Copilot review request found/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state reaches final approval without an approved retrospective checkpoint (#1077 advisory)", async () => {
  // The retrospective merge gate is gone (#1077, Reading B): a green PR with no
  // retrospective checkpoint reaches FINAL_APPROVAL_READY, never retrospective_gate_pending.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-retro-"));

  try {
    await mkdir(path.join(tempDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(
      path.join(tempDir, ".pi", "dev-loop", "settings.yaml"),
      [
        "version: 1",
      ].join("\n"),
      "utf8",
    );

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "271", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 271,
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc9876543210",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            {
              author: { login: "copilot-pull-request-reviewer[bot]" },
              state: "COMMENTED",
              commit: { oid: "abc9876543210" },
              submittedAt: "2026-05-31T20:01:00Z",
            },
          ],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/271/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=271"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "271", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "abc9876543210" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/271/comments?per_page=100"],
        stdout: jsonLine([[
          {
            id: 71,
            body: [
              "Gate review: draft_gate",
              "Reviewed head SHA: abc9876543210",
              "Verdict: clean",
              "Findings summary: draft gate clean.",
              "Next action: mark ready for review",
            ].join("\n"),
            html_url: "https://example.test/comment/71",
            updated_at: "2026-05-31T20:00:00Z",
          },
          {
            id: 72,
            body: [
              "Gate review: pre_approval_gate",
              "Reviewed head SHA: abc9876543210",
              "Verdict: clean",
              "Findings summary: pre-approval gate clean.",
              "Next action: await final human approval",
            ].join("\n"),
            html_url: "https://example.test/comment/72",
            updated_at: "2026-05-31T20:01:00Z",
          },
        ]]),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "271"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    // Advisory (#1077): the retrospective merge gate is gone, so a green PR with
    // no retrospective checkpoint is NEVER blocked as retrospective_gate_pending.
    assert.notEqual(parsed.lifecycleState, "retrospective_gate_pending");
    assert.notEqual(parsed.gateBoundary, "blocked");
    assert.notEqual(parsed.nextAction, "report_blocked");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state fails closed when the PR head changes mid-read", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-head-drift-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: false,
          headRefOid: "aaaaaaa1234567",
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [],
        }),
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"],
        stdout: jsonLine({ users: [], teams: [] }),
      },
      {
        assertArgs: ["api", "graphql", "pr=266"],
        stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      },
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: jsonLine({ headRefOid: "bbbbbbb7654321" }),
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /PR head changed while loading gate coordination facts/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state surfaces linked-issue + refinement via gh pr view", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gate-coord-test-"));
  try {
    const env = await writeGhStub(tmp, [
      // 1) PR facts (draft, with body + closingIssuesReferences)
      {
        stdout: JSON.stringify({
          number: 10,
          state: "OPEN",
          isDraft: true,
          headRefOid: "abc1234567",
          mergeStateStatus: "CLEAN",
          body: "Closes #527\n\nImplements the fix.\n",
          closingIssuesReferences: [{ number: 527 }],
          reviews: [],
          statusCheckRollup: { state: "SUCCESS" },
        }) + "\n",
      },
      // 2) requested reviewers
      { stdout: "{\"users\":[]}\n" },
      // 3) review threads (no comments)
      { stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) },
      // 4) detect-checkpoint-evidence: pr view head SHA
      { stdout: jsonLine({ headRefOid: "abc1234567" }) },
      // 5) detect-checkpoint-evidence: issue comments list
      { stdout: jsonLine([[]]) },
      // 6) issue view for #527 — body has no ACs/DoD
      {
        stdout: JSON.stringify({
          body: "## Problem\n\nProse only.\n\n## Root Cause\n\nBug.\n\n## Fix\n\nChange.\n",
        }) + "\n",
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await detectPrGateCoordinationState(
      { repo: "owner/repo", pr: 10 },
      { env: { ...env, DEVLOOPS_RUN_ID: "" } },
    );
    assert.equal(result.ok, true);
    assert.equal(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
    assert.equal(result.nextAction, PR_CHECKPOINT_ACTION.REPORT_BLOCKED);
    assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.MARK_READY_FOR_REVIEW));
    assert(result.forbiddenActions.includes(PR_CHECKPOINT_ACTION.RUN_DRAFT_GATE));
    assert.match(result.reason, /no refinement artifact/i);
    assert.match(result.reason, /#527/);
    assert.equal(result.refinementArtifact?.status, "missing");
    assert.equal(result.refinementArtifact?.linkedIssue, 527);
    assert.equal(result.refinementArtifact?.finding, "missing_refinement_artifact");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state leaves refinement=present when linked issue has ACs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gate-coord-test-"));
  try {
    const env = await writeGhStub(tmp, [
      {
        stdout: JSON.stringify({
          number: 10,
          state: "OPEN",
          isDraft: true,
          headRefOid: "abc1234567",
          mergeStateStatus: "CLEAN",
          body: "Closes #527\n",
          closingIssuesReferences: [{ number: 527 }],
          reviews: [],
          statusCheckRollup: { state: "SUCCESS" },
        }) + "\n",
      },
      { stdout: "{\"users\":[]}\n" },
      { stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) },
      { stdout: jsonLine({ headRefOid: "abc1234567" }) },
      { stdout: jsonLine([[]]) },
      { stdout: '[]\n' },
      {
        stdout: JSON.stringify({
          body: "## Acceptance criteria\n\n- [ ] First AC\n- [x] Second AC\n",
        }) + "\n",
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await detectPrGateCoordinationState(
      { repo: "owner/repo", pr: 10 },
      { env: { ...env, DEVLOOPS_RUN_ID: "" } },
    );
    assert.equal(result.ok, true);
    assert.notEqual(result.gateBoundary, PR_CHECKPOINT.BLOCKED);
    assert.equal(result.gateBoundary, PR_CHECKPOINT.DRAFT_REVIEW);
    assert.equal(result.refinementArtifact?.status, "present");
    assert.deepEqual(result.refinementArtifact?.acItems, ["First AC", "Second AC"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ── draft gate round-count reset (#560) ──────────────────────────────────

test("detect-pr-gate-coordination-state resets Copilot round count when draft_gate re-passed on different head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-round-reset-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: true,
          headRefOid: "def56789abcdef",
          body: "Closes #527\n\nResets round count.",
          closingIssuesReferences: [{ number: 527 }],
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "aaa1111111111111111111111111111111111111111" }, submittedAt: "2026-05-30T10:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "bbb2222222222222222222222222222222222222222" }, submittedAt: "2026-05-30T11:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "ccc3333333333333333333333333333333333333333" }, submittedAt: "2026-05-30T12:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "ddd4444444444444444444444444444444444444444" }, submittedAt: "2026-06-01T10:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "eee5555555555555555555555555555555555555555" }, submittedAt: "2026-06-01T11:00:00Z" },
          ],
        }),
      },
      { assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"], stdout: jsonLine({ users: [], teams: [] }) },
      { assertArgs: ["api", "graphql", "pr=266"], stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) },
      { assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"], stdout: jsonLine({ headRefOid: "def56789abcdef" }) },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"], stdout: jsonLine([[
        { id: 11, body: ["Gate review: draft_gate", "Reviewed head SHA: aaa1111111111111111111111111111111111111111", "Verdict: clean", "Findings summary: no issues found", "Next action: mark ready for review"].join(String.raw`
`), html_url: "https://example.test/comment/11", updated_at: "2026-05-31T20:00:00Z" }
      ]]) },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/266/reviews?per_page=100"], stdout: '[]\n' },
      // issue view stub for refinement artifact lookup
      {
        assertArgs: ["issue", "view", "527", "--repo", "owner/repo", "--json", "body"],
        stdout: jsonLine({ body: "## Acceptance criteria\n\n- [ ] Round count resets on new head\n- [ ] No reset on same head\n" }),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.draftGate.cleanEvidenceExists, true);
    assert.equal(parsed.draftGate.currentHead, false);
    assert.equal(parsed.draftGate.headSha, "aaa1111111111111111111111111111111111111111");
    assert.equal(parsed.draftGate.verdict, "clean");
    assert.equal(parsed.gateBoundary, "draft_review");
    assert.deepEqual(parsed.allowedNextActions, ["run_draft_gate"]);
    // Round count reset: only 2 reviews after draft gate re-pass count
    assert.equal(parsed.copilotReviewRoundCount, 2,
      "copilotReviewRoundCount should be 2 (only reviews after draft gate re-pass)");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-pr-gate-coordination-state does NOT reset round count when draft_gate is on same head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-pr-gate-same-head-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: jsonLine({
          number: 266,
          state: "OPEN",
          isDraft: true,
          headRefOid: "def56789abcdef",
          body: "Closes #527\n\nResets round count.",
          closingIssuesReferences: [{ number: 527 }],
          statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
          reviews: [
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "aaa1111111111111111111111111111111111111111" }, submittedAt: "2026-05-30T10:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "bbb2222222222222222222222222222222222222222" }, submittedAt: "2026-05-30T11:00:00Z" },
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "ccc3333333333333333333333333333333333333333" }, submittedAt: "2026-05-30T12:00:00Z" },
            // Review after draft gate timestamp: proves no reset still counts this
            { author: { login: "copilot-pull-request-reviewer[bot]" }, state: "COMMENTED", commit: { oid: "ddd4444444444444444444444444444444444444444" }, submittedAt: "2026-06-01T10:00:00Z" },
          ],
        }),
      },
      { assertArgs: ["api", "repos/owner/repo/pulls/266/requested_reviewers"], stdout: jsonLine({ users: [], teams: [] }) },
      { assertArgs: ["api", "graphql", "pr=266"], stdout: jsonLine({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }) },
      { assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "headRefOid"], stdout: jsonLine({ headRefOid: "def56789abcdef" }) },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/266/comments?per_page=100"], stdout: jsonLine([[
        { id: 11, body: ["Gate review: draft_gate", "Reviewed head SHA: def56789abcdef", "Verdict: clean", "Findings summary: no issues found", "Next action: mark ready for review"].join(String.raw`
`), html_url: "https://example.test/comment/11", updated_at: "2026-05-31T20:00:00Z" }
      ]]) },
      // issue view stub for refinement artifact lookup
      {
        assertArgs: ["issue", "view", "527", "--repo", "owner/repo", "--json", "body"],
        stdout: jsonLine({ body: "## Acceptance criteria\n\n- [ ] Round count resets on new head\n- [ ] No reset on same head\n" }),
      },
      {
        assertArgContains: ["api", "--paginate", "--jq", 'event == "review_requested"'],
        stdout: "\n",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "266"], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    // Draft gate head SHA matches current head — no reset triggered
    // (currentHead reflects structured marker detection; loose format
    // is recognized by parseGateReviewCommentMarkerBody via lenient matching)
    assert.equal(parsed.draftGate.verdict, "clean");
    assert.equal(parsed.draftGate.headSha, "def56789abcdef");
    // No reset: all 4 reviews count toward round total (3 before + 1 after draft gate)
    assert.equal(parsed.copilotReviewRoundCount, 4,
      "copilotReviewRoundCount should be 4 (draft gate on same head, no reset)");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// UI e2e auto-scoping detect helpers (#976).
test("extractChangedFiles reads paths from gh pr view --json files", () => {
  assert.deepEqual(
    extractChangedFiles({ files: [{ path: "docs/presentations/x.html" }, { path: "README.md" }, {}] }),
    ["docs/presentations/x.html", "README.md"],
  );
  assert.deepEqual(extractChangedFiles({}), []);
  assert.deepEqual(extractChangedFiles(null), []);
});

test("deriveUiE2ePassed reads UI e2e checks from statusCheckRollup", () => {
  assert.equal(deriveUiE2ePassed({ statusCheckRollup: [] }), null, "no UI e2e check present -> unknown");
  assert.equal(
    deriveUiE2ePassed({ statusCheckRollup: [{ name: "viewer-smoke", conclusion: "SUCCESS" }] }),
    true,
  );
  assert.equal(
    deriveUiE2ePassed({ statusCheckRollup: [{ name: "viewer-smoke", conclusion: "FAILURE" }] }),
    false,
  );
  assert.equal(
    deriveUiE2ePassed({ statusCheckRollup: [{ context: "viewer-smoke", state: "SUCCESS" }] }),
    true,
  );
  // SKIPPED = not applicable to this run (e.g. viewer-smoke when no viewer files changed) — passes.
  assert.equal(
    deriveUiE2ePassed({ statusCheckRollup: [{ name: "viewer-smoke", conclusion: "SKIPPED" }, { name: "deck-smoke", conclusion: "SUCCESS" }] }),
    true,
    "SKIPPED check should not block the gate",
  );
});
