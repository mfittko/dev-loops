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
      assertArgs: ["pr", "view", String(pr), "--repo", repo, "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
        assertArgs: ["pr", "view", "543", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
    });
    // 7 gh calls: pr facts + requested_reviewers + review threads + headRefOid + issue comments + PR reviews + internal-only file check
    assert.equal(Number((await readFile(env.GH_COUNTER_PATH, "utf8")).trim()), 7);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict noop still warns when a stale comment exists on a different head", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-noop-warn-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
      blockCleanOnFindingSeverities: ["must-fix", "worth-fixing-now"],
    });
    // 7 gh calls: pr facts + requested_reviewers + review threads + headRefOid + issue comments + PR reviews + internal-only file check
    assert.equal(Number((await readFile(env.GH_COUNTER_PATH, "utf8")).trim()), 7);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("upsert-checkpoint-verdict fails closed when the requested head SHA is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-stale-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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

test("upsert-checkpoint-verdict fails closed when draft_gate is forbidden on a non-draft PR", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-draft-forbidden-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "266", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup"],
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

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot enter/);
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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

test("upsert-checkpoint-verdict rejects draft_gate when draftGateAlreadySatisfied is true", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-upsert-gate-review-already-satisfied-"));

  try {
    // Simulate a non-draft PR with an existing clean draft_gate comment
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

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /Cannot enter draft_gate on owner\/repo#17/);
    assert.match(payload.error, /draft gate was already satisfied/);
    assert.match(payload.error, /Do not re-post draft_gate/);
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
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
      env: { ...ghEnv, PI_SUBAGENT_RUN_ID: "new-run-id" },
    });

    // The command should succeed (not fail with ownership_lost) because the stale runner was taken over.
    // Without the fix, this would fail: "active run is old-run-id, current run is new-run-id".
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "WARNING: gate ran inline_single_agent (not via the fan-out/fan-in review sub-loop).\n");
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
  const def = parseUpsertCheckpointVerdictCliArgs(base);
  assert.equal(def.executionMode, "inline_single_agent");
  assert.equal(def.inlineReason, undefined);

  const inline = parseUpsertCheckpointVerdictCliArgs([...base, "--execution-mode", "inline_single_agent", "--inline-reason", "tiny docs change"]);
  assert.equal(inline.executionMode, "inline_single_agent");
  assert.equal(inline.inlineReason, "tiny docs change");

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
