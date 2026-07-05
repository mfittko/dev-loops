import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  parseUpsertCheckpointVerdictCliArgs,
  renderGateReviewCommentBody,
  summarizeCheckpointVerdictText,
  upsertCheckpointVerdict,
} from "../../scripts/github/upsert-checkpoint-verdict.mjs";
import { claimRunnerOwnership } from "../../scripts/loop/_pr-runner-coordination.mjs";

const scriptPath = path.resolve("scripts/github/upsert-checkpoint-verdict.mjs");

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

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, augmentInlineReason(args), {
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

function buildGateCoordinationEntries({
  repo = "owner/repo",
  pr = 17,
  headSha = "abc1234",
  isDraft = true,
  statusCheckRollup = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }],
  reviews = [],
  reviewThreadsPayload = { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } },
  issueComments = [],
}) {
  return [
    {
      assertArgs: ["pr", "view", String(pr), "--repo", repo, "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
      stdout: JSON.stringify({
        number: pr,
        state: "OPEN",
        isDraft,
        headRefOid: headSha,
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
  headSha = "abc1234",
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

test("parseUpsertCheckpointVerdictCliArgs rejects malformed arguments deterministically", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([]),
    /requires --repo, --pr, --head-sha, --verdict, --findings-summary .* and --next-action/i,
  );

  const parsed = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo",
    "--pr", "17",
    "--gate", "draft_gate",
    "--head-sha", "ABC1234",
    "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
    "--findings-summary", "no issues found",
    "--next-action", "mark ready for review",
    "--inline-reason", "tiny docs change",
  ]);
  assert.equal(parsed.headSha, "abc1234");

  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "not-a-sha",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ]),
    /7-64 character hexadecimal SHA/i,
  );
});

test("parseUpsertCheckpointVerdictCliArgs accepts --findings-file without --findings-summary", () => {
  const parsed = parseUpsertCheckpointVerdictCliArgs([
    "--repo", "owner/repo",
    "--pr", "17",
    "--gate", "draft_gate",
    "--head-sha", "abc1234",
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
    "--head-sha", "abc1234",
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
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force", "--force-reason", "  CI\ncancelled  "]),
    /--force has been removed/,
  );
});

test("parseUpsertCheckpointVerdictCliArgs rejects --force without --force-reason as removed flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force"]),
    /--force has been removed/,
  );
});

test("parseUpsertCheckpointVerdictCliArgs rejects --force-reason without --force as removed flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force-reason", "CI cancelled due to infra"]),
    /--force-reason has been removed/,
  );
});

test("upsertCheckpointVerdict ignores force/forceReason in programmatic API", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-force-programmatic-"));
  try {
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);
    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha: "abc1234",
      verdict: "clean",
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0 },
      findingsSummary: "all good",
      nextAction: "next",
      force: true,
      forceReason: "test",
    }, { env, ghCommand: "gh" });
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    // force metadata no longer included
    assert.equal(result.forced, undefined);
    assert.equal(result.forceReason, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
test("parseUpsertCheckpointVerdictCliArgs rejects --force with blank --force-reason as removed flag", () => {
  assert.throws(
    () => parseUpsertCheckpointVerdictCliArgs(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "merge", "--force", "--force-reason", "\n"]),
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


test("summarizeCheckpointVerdictText preserves long single-line narratives instead of inventing a log summary", () => {
  const narrative = "Passed reviewer note: keep the operator-facing summary readable even when Error and passed appear in the same explanatory sentence, because this is narrative text rather than a multiline validation log. ".repeat(3).trim();
  const summarized = summarizeCheckpointVerdictText(narrative, 140);

  assert.match(summarized, /^Passed reviewer note:/);
  assert.match(summarized, /Error and passed appear/);
  assert.doesNotMatch(summarized, /^validation: passed$/);
  assert.match(summarized, /…\[truncated \d+ chars\]$/);
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

test("upsert-checkpoint-verdict rejects --force on draft_gate create", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-force-draft-"));
  try {
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "Tests pass", "--next-action", "Mark ready for review", "--force", "--force-reason", "CI cancelled due to infrastructure"]);
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
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "pre_approval_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "Tests pass.", "--findings-severity-counts", JSON.stringify({"must-fix":0,"worth-fixing-now":0}), "--next-action", "Approve and merge", "--force", "--force-reason", "CI cancelled due to infrastructure"]);
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.match(error.error, /--force has been removed/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict keeps CI-blocked gate upserts fail-closed", async () => {
  const scenarios = [
    { gate: "draft_gate", isDraft: true, headSha: "abc1234", verdict: "clean", findingsSummary: "Tests pass", nextAction: "Mark ready for review", findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0 } },
    { gate: "pre_approval_gate", isDraft: false, headSha: "abc1234", verdict: "findings_present", findingsSummary: "CI failed", nextAction: "Fix CI and re-run", findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 1 } },
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
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "CI green", "--next-action", "merge", "--force", "--force-reason", "CI cancelled"]);
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
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "Tests pass", "--next-action", "merge", "--force", "--force-reason", "CI cancelled"]);
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
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "pre_approval_gate", "--head-sha", "abc1234", "--verdict", "findings_present", "--findings-summary", "Some issues", "--next-action", "Fix issues", "--force", "--force-reason", "forced"]);
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
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "findings_present", "--findings-summary", "Some issues", "--next-action", "Fix issues", "--force", "--force-reason", "forced"]);
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
    const result = await runNode(["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "n/a", "--next-action", "merge", "--force", "--force-reason", "forced"]);
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Reviewed head SHA:** `abc1234`", "**Next action:** mark ready for review"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: [
          "body=### Gate review: `draft_gate`",
          "## Section A",
          "- item 1",
          "- item 2",
          "**bold note**",
        ],
        assertArgNotContains: [
          "\\n## Section A",
        ],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-102"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: [
          "file content wins",
        ],
        assertArgNotContains: [
          "should be overridden",
        ],
        stdout: '{"id":103,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-103"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
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

test("upsert-checkpoint-verdict omits Blocking severities line on clean verdict", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-clean-no-blocking-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: ["**Verdict:** clean"],
        assertArgNotContains: ["Blocking severities"],
        stdout: '{"id":104,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-104"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "all clear, no issues",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
        stdout: '{"number":266,"state":"OPEN","isDraft":false,"headRefOid":"def56789abcdef","reviews":[],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
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
        stdout: '{"headRefOid":"def56789abcdef"}\n',
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
      "--head-sha", "def56789",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
        stdout: '{"number":543,"state":"OPEN","isDraft":true,"headRefOid":"f7a611b7234af479","reviews":[],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
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
        stdout: '{"headRefOid":"f7a611b7234af479"}\n',
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
      "--head-sha", "f7a611b",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
          headRefOid: "abc1234",
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 91,
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
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          updated_at: "2026-05-31T19:55:00Z",
        }]])}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: [
          "body=### Gate review: `pre_approval_gate`",
          "**Findings summary:** no issues found; Copilot review rounds exhausted (5/2); current head has zero unresolved threads and green or credibly green CI, so pre_approval_gate fallback is allowed without another Copilot re-request.",
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
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
        stdout: '{"number":17,"state":"OPEN","isDraft":false,"headRefOid":"abc1234","reviews":[{"author":{"login":"copilot-pull-request-reviewer"},"state":"COMMENTED","submittedAt":"2026-05-31T20:00:00Z","commit":{"oid":"abc1234"}}],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 91,
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
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          updated_at: "2026-05-31T19:55:00Z",
        }]])}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: [
          "body=### Gate review: `pre_approval_gate`",
          "**Findings summary:** commands: npm test; tests: 46, pass: 46, fail: 0; ci: GitHub CI test passed on the current head.",
        ],
        assertArgNotContains: ["stdout: this raw passing output should not appear"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234`",
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
    });
    // 8 gh calls: pr facts + requested_reviewers + review threads + headRefOid + issue comments + PR reviews + internal-only file check + light-mode facts (baseRefOid,labels) — the repo config enables lightMode, so an inline verdict triggers the #1174 light-fact fetch.
    assert.equal(Number((await readFile(env.GH_COUNTER_PATH, "utf8")).trim()), 8);
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
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
            "**Reviewed head SHA:** `abc1234`",
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234`",
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
            "**Reviewed head SHA:** `def5678`",
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "noop");
    assert.equal(parsed.headSha, "abc1234");
    assert.match(parsed.warning, /different head SHA/i);
    assert.match(parsed.warning, /def5678/);
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234`",
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234`",
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
            "**Reviewed head SHA:** `def5678`",
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
        assertArgContains: ["**Reviewed head SHA:** `abc1234`", "**Findings summary:** fixed the marker for the current head"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "ABC1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      warning: "A gate comment for \`draft_gate\` already exists on a different head SHA \`def5678\` (comment 202). The old comment is stale for the current head.",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abc1234","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234`",
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
            "**Reviewed head SHA:** `abc1234`",
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
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Reviewed head SHA:** `abc1234`", "**Findings summary:** corrected the newer malformed marker"],
        stdout: '{"id":202,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-202"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      currentHeadSha: "abc1234",
      commentId: 202,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-202",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict expands an abbreviated current-head SHA before matching same-head markers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-short-head-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"abcdef1234567890abcdef1234567890abcdef12","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"abcdef1234567890abcdef1234567890abcdef12"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 101,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abcdef1234567890abcdef1234567890abcdef12`",
            "**Verdict:** clean",
            "**Execution mode:** inline_single_agent — single-agent inline review (test)",
            "",
            "**Findings summary:** no issues found",
            "",
            "**Next action:** mark ready for review",
            ].join("\n"),
            html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
            updated_at: "2026-05-30T18:00:00Z",
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
      "--head-sha", "ABCDEF1",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abcdef1234567890abcdef1234567890abcdef12",
      currentHeadSha: "abcdef1234567890abcdef1234567890abcdef12",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#issuecomment-101",
      executionMode: "inline_single_agent",
      inlineReason: "single-agent inline review (test)",
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
    });
    // 8 gh calls: pr facts + requested_reviewers + review threads + headRefOid + issue comments + PR reviews + internal-only file check + light-mode facts (baseRefOid,labels) — the repo config enables lightMode, so an inline verdict triggers the #1174 light-fact fetch.
    assert.equal(Number((await readFile(env.GH_COUNTER_PATH, "utf8")).trim()), 8);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed when the requested head SHA is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-stale-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"def5678","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"def5678"}\n',
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
        stdout: '{"number":17,"state":"OPEN","isDraft":true,"headRefOid":"def5678","reviews":[],"statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS","name":"ci"}]}\n',
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
        stdout: '{"headRefOid":"def5678"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([
          {
            id: 99,
            body: [
            "### Gate review: `draft_gate`",
            "",
            "**Reviewed head SHA:** `abc1234`",
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
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-102"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "def5678",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
    ], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop). Reason: single-agent inline review (test)\n");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, "created");
    assert.equal(parsed.gate, "draft_gate");
    assert.equal(parsed.headSha, "def5678");
    assert.match(parsed.warning, /different head SHA/i);
    assert.match(parsed.warning, /abc1234/);
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
        stdout: '{"number":266,"state":"OPEN","isDraft":false,"headRefOid":"def56789abcdef","reviews":[],"statusCheckRollup":[{"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"}]}\n',
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
        stdout: '{"headRefOid":"def56789abcdef"}\n',
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
      "--head-sha", "def56789",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "reviewed: 2 must-fix, 1 worth-fixing-now",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":2,"worth-fixing-now":1,"defer":0}',
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot set verdict "clean"/);
    assert.match(payload.error, /must-fix/);
    assert.match(payload.error, /worth-fixing-now/);
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
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Verdict:** clean"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":1}',
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
      "--head-sha", "abc1234",
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
    assert.match(payload.error, /must-fix/);
    assert.match(payload.error, /worth-fixing-now/);
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "all clear",
      "--next-action", "mark ready",
      "--findings-severity-counts", '{"must-fix":0,"defer":0}',
    ], { env });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /must include explicit counts for all configured blocking severities/);
    assert.match(payload.error, /worth-fixing-now/);
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
        "**Reviewed head SHA:** `abc1234`",
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
        headSha: "abc1234",
        verdict: "clean",
        findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "defer": 0 },
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
    const headSha = "abc1234";
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
        "**Reviewed head SHA:** `abc1234`",
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
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- resolve PR node id + convert to draft ---
      { assertArgs: ["api", "graphql", "name=repo", "number=17"], stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_node","isDraft":false}}}}\n' },
      { assertArgs: ["api", "graphql", "pullRequestId=PR_node"], stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_node","isDraft":true}}}}\n' },
      // --- coordination pass 2 (isDraft: true → posts normally) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(true) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- post the draft_gate verdict + restore ready ---
      { assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"], stdout: '{"id":900,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-900"}\n' },
      { assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"], stdout: "{}\n" },
    ], { matchMode: "claims", logCalls: true });
    const env = { ...logEnvRaw, DEVLOOPS_RUN_ID: "" };

    const result = await upsertCheckpointVerdict({
      repo: "owner/repo",
      pr: 17,
      gate: "draft_gate",
      headSha,
      verdict: "clean",
      findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "defer": 0 },
      findingsSummary: "no issues found",
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
    // The posted draft_gate comment must carry the fanout_fanin execution mode,
    // proving the caller's mode is preserved across the recursive re-entry.
    assert.ok(/Gate review: `draft_gate`/.test(ghLog), "expected a draft_gate verdict to be posted");
    assert.ok(/\*\*Execution mode:\*\* fanout_fanin/.test(ghLog), "expected fanout_fanin in the posted verdict body");
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
    const headSha = "abc1234";
    const cleanPreApprovalComment = {
      id: 501,
      body: [
        "### Gate review: `pre_approval_gate`",
        "",
        "**Reviewed head SHA:** `abc1234`",
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
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
      { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"], stdout: JSON.stringify([[cleanPreApprovalComment]]) + "\n" },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"], stdout: "src/index.ts\n" },
      // --- resolve PR node id + convert to draft (ONLY ONCE) ---
      { assertArgs: ["api", "graphql", "name=repo", "number=17"], stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_node","isDraft":false}}}}\n' },
      { assertArgs: ["api", "graphql", "pullRequestId=PR_node"], stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_node","isDraft":true}}}}\n' },
      // --- coordination pass 2 (LAGGED read: isDraft STILL false → must NOT recurse) ---
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"], stdout: prFacts(false) },
      { assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"], stdout: '{"users":[],"teams":[]}\n' },
      { assertArgs: ["api", "graphql", "pr=17"], stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n' },
      { assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"], stdout: '{"headRefOid":"abc1234"}\n' },
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
        findingsSeverityCounts: { "must-fix": 0, "worth-fixing-now": 0, "defer": 0 },
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
        headSha: "abc1234",
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
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      issueComments: [staleHeadDraftGateComment],
    }));

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-summary", "no issues found",
      "--next-action", "mark ready for review",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
      headSha: "abc1234",
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
        assertArgs: ["api", "repos/owner/repo/issues/17/comments"],
        stdout: '{"id":200,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-200"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
    assert.equal(payload.commentUrl, "https://github.com/owner/repo/pull/17#issuecomment-200");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict performs stale-runner takeover before gate coordination", async () => {
  // Root cause 1 fix: when a previous run owns the coordination file but is stale,
  // the new run takes over ownership rather than being rejected.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-stale-takeover-"));

  try {
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
        assertArgs: ["api", "repos/owner/repo/issues/17/comments"],
        stdout: '{"id":300,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-300"}\n',
      },
    ], { repeatLastOnOverflow: true });

    // Run with the new run ID — old-run-id owned the file but is stale, so takeover should happen
    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "draft_gate",
      "--head-sha", "abc1234",
      "--verdict", "clean",
      "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
  const base = ["--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234", "--verdict", "clean", "--findings-summary", "ok", "--next-action", "go", "--findings-severity-counts", '{"must-fix":0}'];

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

test("renderGateReviewCommentBody renders the execution-mode line round-trippable by the marker parser", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const inlineBody = renderGateReviewCommentBody({
    gate: "draft_gate", headSha: "abc1234", verdict: "clean", findingsSummary: "none", nextAction: "go",
    executionMode: "inline_single_agent", inlineReason: "quick fix",
  });
  assert.match(inlineBody, /\*\*Execution mode:\*\* inline_single_agent — quick fix/);
  const parsedInline = parseGateReviewCommentMarkerBody(inlineBody);
  assert.equal(parsedInline.executionMode, "inline_single_agent");
  assert.equal(parsedInline.inlineReason, "quick fix");

  const fanoutBody = renderGateReviewCommentBody({
    gate: "draft_gate", headSha: "abc1234", verdict: "clean", findingsSummary: "none", nextAction: "go",
    executionMode: "fanout_fanin",
  });
  assert.match(fanoutBody, /\*\*Execution mode:\*\* fanout_fanin/);
  assert.equal(parseGateReviewCommentMarkerBody(fanoutBody).executionMode, "fanout_fanin");
});

test("renderGateReviewCommentBody renders structured per-angle fan-in findings as a readable multi-line block (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
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
          { severity: "must-fix", summary: "off-by-one in loop bound", file: "src/loop.mjs", line: 42, disposition: "accepted-for-fix" },
          { severity: "worth-fixing-now", summary: "missing null guard" },
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
  assert.match(body, /\n- `correctness` → findings_present\n/);
  assert.match(body, /\n {2}- \[must-fix\] off-by-one in loop bound \(`src\/loop\.mjs:42`\) — _accepted-for-fix_\n/);
  assert.match(body, /\n {2}- \[worth-fixing-now\] missing null guard\n/);
  assert.match(body, /\n- `acceptance-criteria` → clean/);
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
  assert.equal(parsed.headSha, "abc1234");
  assert.equal(parsed.verdict, "findings_present");
  assert.equal(parsed.executionMode, "fanout_fanin");
  assert.equal(parsed.nextAction, "address must-fix findings then re-gate");
  assert.equal(parsed.findingsSummary, "2 angles reviewed; 2 findings (see per-angle breakdown below).");
  assert.equal(parsed.contractComplete, true);
});

test("renderGateReviewCommentBody falls back to free-text findings summary when no structured input is given (#898)", () => {
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "clean",
    findingsSummary: "no issues found",
    nextAction: "mark ready",
    executionMode: "inline_single_agent",
    inlineReason: "single-agent run",
  });
  assert.match(body, /\*\*Findings summary:\*\* no issues found/);
  assert.doesNotMatch(body, /per-angle breakdown below/);
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
  assert.match(body, /\n- `weirdangle` → findings_present\n/);
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

test("renderGateReviewCommentBody renders NESTED per-angle findings input correctly (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
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
  assert.match(body, /\n- `correctness` → findings_present\n/);
  assert.match(body, /\n {2}- \[must-fix\] bad bound \(`x\.mjs:3`\)\n/);
  assert.match(body, /\n- `tests` → clean/);
  assert.match(body, /\*\*Findings summary:\*\* 2 angles reviewed; 1 finding \(see per-angle breakdown below\)\./);
  const parsed = parseGateReviewCommentMarkerBody(body);
  assert.ok(parsed);
  assert.equal(parsed.contractComplete, true);
});

test("renderGateReviewCommentBody groups FLAT per-finding input by angle without dropping findings (#898)", async () => {
  const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
  // This is consolidateFanin's OUTPUT / toFindingsLogShape: a FLAT array where
  // each finding carries its own `.angle` (and `files`, not `file`). Before the
  // fix this shape silently rendered every angle clean (findings dropped).
  const body = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      { severity: "must-fix", angle: "correctness", summary: "off-by-one", files: ["src/loop.mjs"], disposition: "accepted-for-fix" },
      { severity: "worth-fixing-now", angle: "correctness", summary: "missing guard" },
      { severity: "defer", angle: "style", summary: "naming nit" },
      // A finding without an angle must still be rendered (grouped under "general").
      { severity: "must-fix", summary: "no-angle finding" },
    ],
  });
  // Findings are NOT dropped: grouped per angle.
  assert.match(body, /\n- `correctness` → findings_present\n/);
  assert.match(body, /\n {2}- \[must-fix\] off-by-one \(`src\/loop\.mjs`\) — _accepted-for-fix_\n/);
  assert.match(body, /\n {2}- \[worth-fixing-now\] missing guard\n/);
  assert.match(body, /\n- `style` → findings_present\n/);
  assert.match(body, /\n {2}- \[defer\] naming nit\n/);
  assert.match(body, /\n- `general` → findings_present\n/);
  assert.match(body, /\n {2}- \[must-fix\] no-angle finding\n/);
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
        headSha: "abc1234",
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
        headSha: "abc1234",
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
    headSha: "abc1234",
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

test("renderGateReviewCommentBody throws when a non-empty payload mixes recognized and unrecognized items (no silent drop) (Copilot review)", () => {
  // One recognizable per-angle entry plus one unrecognized item. Before the fix
  // the unrecognized item was silently filtered out (findings could be hidden).
  // Now ANY unrecognized item in a non-empty payload throws.
  assert.throws(
    () =>
      renderGateReviewCommentBody({
        gate: "draft_gate",
        headSha: "abc1234",
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
    headSha: "abc1234",
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
  assert.match(body, /\n- `general` → findings_present\n/);
  assert.match(body, /\n {2}- \[must-fix\] angle-less nested finding\n/);
  assert.match(body, /\n {2}- \[worth-fixing-now\] blank-angle nested finding\n/);
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
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--verdict", "findings_present", "--findings-json", findingsPath,
      "--next-action", "fix", "--execution-mode", "fanout_fanin",
    ], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /matches neither recognized shape/);
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
        { angle: "tests", verdict: "clean", findings: [] },
      ]),
      "utf8",
    );
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: [
          "**Execution mode:** fanout_fanin",
          "- `correctness` → findings_present",
          "  - [must-fix] broken edge case (`a.mjs:7`)",
          "- `tests` → clean",
          "**Findings summary:** 2 angles reviewed; 1 finding (see per-angle breakdown below).",
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);
    const result = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234",
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

test("upsert-checkpoint-verdict --findings-json structured verdict carries the gateEvidenceNote on the summary line (parity with free-text, #898)", async () => {
  // Parity check for the Copilot review finding: in structured (--findings-json)
  // mode the `**Findings summary:**` line must also carry coordination's
  // gateEvidenceNote (here the round-exhaustion / pre_approval_gate fallback
  // note), exactly like the free-text appendGateEvidenceNote path. The same PR
  // state as the free-text round-cap test drives coordination to emit the note.
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-findings-json-note-"));
  const roundExhaustionNote = "Copilot review rounds exhausted (5/2); current head has zero unresolved threads and green or credibly green CI, so pre_approval_gate fallback is allowed without another Copilot re-request.";
  try {
    const findingsPath = path.join(tempDir, "findings.json");
    await writeFile(
      findingsPath,
      JSON.stringify([
        {
          angle: "correctness",
          verdict: "findings_present",
          findings: [{ severity: "worth-fixing-now", summary: "minor nit worth noting" }],
        },
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
          headRefOid: "abc1234",
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
        stdout: '{"headRefOid":"abc1234"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 91,
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
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-91",
          updated_at: "2026-05-31T19:55:00Z",
        }]])}\n`,
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: [
          "body=### Gate review: `pre_approval_gate`",
          "**Execution mode:** fanout_fanin",
          "- `correctness` → findings_present",
          // The structured single-line digest carries the gateEvidenceNote.
          `**Findings summary:** 1 angle reviewed; 1 finding (see per-angle breakdown below).; ${roundExhaustionNote}`,
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);

    const result = await runNode([
      "--repo", "owner/repo",
      "--pr", "17",
      "--gate", "pre_approval_gate",
      "--head-sha", "abc1234",
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
    // gateEvidenceNote puts the note on the single-line digest AND the marker
    // parser recovers that exact summary line (parse contract stays intact).
    const { parseGateReviewCommentMarkerBody } = await import("../../scripts/_core-helpers.mjs");
    const expectedSummaryLine = `1 angle reviewed; 1 finding (see per-angle breakdown below).; ${roundExhaustionNote}`;
    const body = renderGateReviewCommentBody({
      gate: "pre_approval_gate",
      headSha: "abc1234",
      verdict: "findings_present",
      findingsSummary: "free-text fallback (ignored in structured mode)",
      nextAction: "address findings then re-gate",
      executionMode: "fanout_fanin",
      gateEvidenceNote: roundExhaustionNote,
      structuredFindings: [
        { angle: "correctness", verdict: "findings_present", findings: [{ severity: "worth-fixing-now", summary: "minor nit worth noting" }] },
      ],
    });
    assert.match(body, /\*\*Findings summary:\*\* 1 angle reviewed; 1 finding \(see per-angle breakdown below\)\.; Copilot review rounds exhausted/);
    // The structured per-angle bullet is unchanged by carrying the note.
    assert.match(body, /\n- `correctness` → findings_present\n/);
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

test("upsert-checkpoint-verdict records executionMode and warns on inline, stays clean on fanout", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-execmode-"));
  try {
    const env = await writeGhStub(tempDir, [
      ...buildGateCoordinationEntries({ isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] }),
      {
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: ["body=### Gate review: `draft_gate`", "**Execution mode:** inline_single_agent — manual single-agent run"],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-101"}\n',
      },
    ]);
    const inline = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
        assertArgs: ["api", "repos/owner/repo/issues/17/comments", "-f"],
        assertArgContains: ["**Execution mode:** fanout_fanin"],
        stdout: '{"id":102,"html_url":"https://github.com/owner/repo/pull/17#issuecomment-102"}\n',
      },
    ]);
    const fanout = await runNode([
      "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234",
      "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
      "--findings-summary", "no issues found", "--next-action", "mark ready for review",
      "--execution-mode", "fanout_fanin",
    ], { env: env2 });
    assert.equal(fanout.code, 0, fanout.stderr);
    assert.equal(fanout.stderr, "");
    assert.equal(JSON.parse(fanout.stdout).executionMode, "fanout_fanin");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict CLI fails closed for inline mode without --inline-reason", async () => {
  // End-to-end argument-error path: a complete call that resolves to the default
  // inline mode but omits --inline-reason exits 1 with a clear argument error
  // (FIX B). runNodeHelper is used directly so no inline reason is auto-appended.
  const args = [
    "--repo", "owner/repo", "--pr", "17", "--gate", "draft_gate", "--head-sha", "abc1234",
    "--verdict", "clean", "--findings-severity-counts", '{"must-fix":0,"worth-fixing-now":0,"defer":0}',
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
