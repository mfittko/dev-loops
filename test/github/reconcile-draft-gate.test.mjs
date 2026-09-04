// Determinism (issue #1405). The root cause of the intermittent failures
// here was NOT a fixture-vs-clock comparison but shared on-disk state: some
// `runNode` calls omitted `cwd`, so the spawned CLI inherited the real
// process cwd and resolved its runner-coordination file via
// `git rev-parse --git-common-dir` — a path SHARED across every worktree
// over this one `.git`. A stale leftover coordination file from another
// run/worktree then flipped stale-runner age assertions. The fix: every
// `runNode` that can reach coordination passes `cwd: tempDir` (a per-test
// mkdtemp dir where `--git-common-dir` fails, so the coordination root
// anchors to the isolated temp dir). Keep that invariant: any new spawn
// that touches coordination MUST set `cwd: tempDir`.
//
// Related convention: never read the real wall clock here either — no bare,
// argument-less Date constructor, and no read of the current epoch millis off the Date global. A production seam
// that needs "now" (e.g. `claimRunnerOwnership`/`assertRunnerOwnership` in
// scripts/loop/_pr-runner-coordination.mjs) already accepts an injected
// `now`; pass a fixed value through it. Enforced mechanically by
// test/github/deterministic-fixture-time.test.mjs.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { DEFAULT_TEST_PR_BODY, runIdFreeEnv, runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  parseReconcileDraftGateCliArgs,
} from "../../scripts/github/reconcile-draft-gate.mjs";

const scriptPath = path.resolve("scripts/github/reconcile-draft-gate.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: runIdFreeEnv({
    ...(options.env ?? {}),
    DEVLOOPS_RUN_ID: options.env?.DEVLOOPS_RUN_ID ?? "",
  }),
});

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries, { repeatLastOnOverflow: true });
  return { ...env, DEVLOOPS_RUN_ID: "" };
}

// These tests are about the reconcile tool's draft-transition/CI/error
// mechanics, not fan-out evidence — the reconciling post is inline by
// design — and use a bare tempDir as repoRoot (schema default:
// requireFanoutEvidence: true). Disable it so the reconciling post is not
// itself refused as under-qualified inline evidence.
async function disableFanoutEvidence(tempDir) {
  await writeFile(path.join(tempDir, ".devloops"), "version: 1\ngates:\n  requireFanoutEvidence: false\n", "utf8");
}

async function readGhCallCount(tempDir) {
  return Number((await readFile(path.join(tempDir, "gh-counter.txt"), "utf8")).trim() || "0");
}

function draftGateComment({ verdict = "clean", headSha = "abc1234", findingsSummary = "no issues found", nextAction = "mark ready for review" } = {}) {
  return [
    "### Gate review: `draft_gate`",
    "",
    `**Reviewed head SHA:** \`${headSha}\``,
    `**Verdict:** ${verdict}`,
    "",
    `**Findings summary:** ${findingsSummary}`,
    "",
    `**Next action:** ${nextAction}`,
  ].join("\n");
}

// ─── CLI argument parsing ────────────────────────────────────────────

test.skip("parseReconcileDraftGateCliArgs accepts required --repo and --pr arguments", () => {
  const r = parseReconcileDraftGateCliArgs(["--repo", "owner/repo", "--pr", "17"]);
  assert.equal(r.repo, "owner/repo");
  assert.equal(r.pr, 17);
  assert.equal(r.skipChecks, false);
});

test.skip("parseReconcileDraftGateCliArgs accepts --skip-checks flag", () => {
  const r = parseReconcileDraftGateCliArgs(["--repo", "owner/repo", "--pr", "17", "--skip-checks"]);
  assert.equal(r.skipChecks, true);
});

test("parseReconcileDraftGateCliArgs rejects missing --repo", () => {
  assert.throws(() => parseReconcileDraftGateCliArgs(["--pr", "17"]), /requires --repo and --pr/);
});

test("parseReconcileDraftGateCliArgs rejects missing --pr", () => {
  assert.throws(() => parseReconcileDraftGateCliArgs(["--repo", "owner/repo"]), /requires --repo and --pr/);
});

test("parseReconcileDraftGateCliArgs rejects invalid repo slug", () => {
  assert.throws(() => parseReconcileDraftGateCliArgs(["--repo", "bad", "--pr", "17"]));
});

test("parseReconcileDraftGateCliArgs rejects unknown arguments", () => {
  assert.throws(() => parseReconcileDraftGateCliArgs(["--repo", "owner/repo", "--pr", "17", "--bogus"]), /Unknown argument/);
});


test("reconcile-draft-gate --help describes the script as optional manual recovery", async () => {
  const result = await runNode(["--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /optional\/manual recovery/i);
  assert.match(result.stdout, /already non-draft PR/i);
  assert.doesNotMatch(result.stdout, /required draft_gate/i);
});

test("reconcile-draft-gate fails closed when visible draft_gate evidence already exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-visible-evidence-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: `${JSON.stringify([[{
          id: 101,
          html_url: "https://github.com/owner/repo/pull/17#issuecomment-101",
          updated_at: "2026-06-02T10:00:00Z",
          body: draftGateComment({
            verdict: "findings_present",
            findingsSummary: "fix the visible draft-gate findings first",
            nextAction: "stay draft and address findings",
          }),
        }]])}\n`,
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /already has a visible draft_gate comment/i);
    assert.equal(await readGhCallCount(tempDir), 3);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate blocks while CI is still pending", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-pending-ci-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pending","state":"PENDING","name":"verify","workflow":"CI"}]\n',
        exitCode: 8,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr).error;
    assert.match(error, /CI is not green/i);
    assert.match(error, /pending/i);
    assert.equal(await readGhCallCount(tempDir), 4);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate treats failing gh pr checks JSON output as blocked even on exit code 1", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-failing-ci-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"fail","state":"FAILURE","name":"verify","workflow":"CI"}]\n',
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr).error;
    assert.match(error, /CI is not green/i);
    assert.match(error, /verify=fail/i);
    assert.equal(await readGhCallCount(tempDir), 4);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate surfaces gh pr checks stderr when exit code 1 has no JSON payload", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-failing-ci-no-json-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stderr: 'auth failed\n',
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /Failed to check PR #17 CI status: auth failed/i);
    assert.equal(await readGhCallCount(tempDir), 4);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate blocks when no CI checks are reported", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-no-ci-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[]\n',
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /no CI\/check runs were reported/i);
    assert.equal(await readGhCallCount(tempDir), 4);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate skips CI checks when config disables draft requireCi", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-config-skip-ci-"));

  try {
    await mkdir(path.join(tempDir, ".pi", "dev-loop"), { recursive: true });
    await writeFile(path.join(tempDir, ".pi", "dev-loop", "defaults.yaml"), [
      "version: 1",
      "gates:",
      // This is a manual recovery tool test about the requireCi skip, not fan-out
      // evidence — the reconciling post is inline by design, so disable fan-out
      // evidence enforcement to isolate the behavior under test.
      "  requireFanoutEvidence: false",
      "  draft:",
      "    angles:",
      "      - scope",
      "    requireCi: false",
    ].join("\n"));

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":false}}}}\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["pullRequestId=PR_kwDOScHU78000017", "convertPullRequestToDraft"],
        stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc123456789", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["### Gate review: `draft_gate`", "CI optional by config"],
        stdout: '{"id":301,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-301"}\n',
      },
      {
        assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "reconciled",
      repo: "owner/repo",
      pr: 17,
      headSha: "abc123456789",
      currentHeadSha: "abc123456789",
      commentId: 301,
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-301",
    });
    assert.equal(await readGhCallCount(tempDir), 14);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate skips the draft conversion mutation when the PR is already draft", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-already-draft-"));

  try {
    await disableFanoutEvidence(tempDir);
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pass","state":"SUCCESS","name":"verify","workflow":"CI"}]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc123456789", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: ["### Gate review: `draft_gate`"],
        assertArgNotContains: ["convertPullRequestToDraft"],
        stdout: '{"id":201,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-201"}\n',
      },
      {
        assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "reconciled",
      repo: "owner/repo",
      pr: 17,
      headSha: "abc123456789",
      currentHeadSha: "abc123456789",
      commentId: 201,
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-201",
    });
    assert.equal(await readGhCallCount(tempDir), 14);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate does not mark ready when upsert throws and the PR was already draft", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-already-draft-upsert-failure-"));

  try {
    await disableFanoutEvidence(tempDir);
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pass","state":"SUCCESS","name":"verify","workflow":"CI"}]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc123456789", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stderr: 'boom\n',
        exitCode: 1,
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /gh command failed: boom/i);
    assert.equal(await readGhCallCount(tempDir), 13);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate marks the PR ready again if gate-comment upsert throws after converting to draft", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-upsert-failure-"));

  try {
    await disableFanoutEvidence(tempDir);
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pass","state":"SUCCESS","name":"verify","workflow":"CI"}]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":false}}}}\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["pullRequestId=PR_kwDOScHU78000017", "convertPullRequestToDraft"],
        stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc123456789", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        stderr: 'boom\n',
        exitCode: 1,
      },
      {
        assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error, /gh command failed: boom/i);
    assert.equal(await readGhCallCount(tempDir), 15);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-draft-gate converts to draft, posts clean evidence, and marks ready when CI is green", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-success-"));

  try {
    await disableFanoutEvidence(tempDir);
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pass","state":"SUCCESS","name":"verify","workflow":"CI"},{"bucket":"skipping","state":"SKIPPED","name":"viewer-smoke","workflow":"CI"}]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":false}}}}\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["pullRequestId=PR_kwDOScHU78000017", "convertPullRequestToDraft"],
        stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc123456789", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "### Gate review: `draft_gate`",
          "**Reviewed head SHA:** `abc123456789`",
          "**Findings summary:** Reconciled non-draft PR — draft gate auto-reconciled (CI green).",
          "**Next action:** Mark ready for review (auto-reconciled).",
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
      {
        assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "reconciled",
      repo: "owner/repo",
      pr: 17,
      headSha: "abc123456789",
      currentHeadSha: "abc123456789",
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-101",
    });
    assert.equal(await readGhCallCount(tempDir), 15);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The reconcile tool only ever posts an INLINE verdict; over the light-mode
// threshold, upsertCheckpointVerdict's post-time fan-out enforcement now
// refuses that post. This must fail with actionable guidance (not a bare
// "inline gate verdicts are not accepted") AND restore the PR to ready rather
// than stranding it in draft.
test("reconcile-draft-gate refuses a non-light-mode PR with actionable fan-out guidance, and restores ready", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-fanout-refused-"));

  try {
    // requireFanoutEvidence defaults to true, and the shipped default also
    // enables localImplementation.lightMode — explicitly disable lightMode so
    // no inline verdict can ever qualify (this tempDir is not a git repo, so
    // leaving lightMode on would make the post-time check shell out to a real
    // `git diff` that fails loudly against two fake SHAs). Deliberately unlike
    // the success test above (which disables fan-out evidence entirely to
    // isolate the draft-transition/CI mechanics it tests).
    await writeFile(path.join(tempDir, ".devloops"), "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: false\n    maxFiles: 2\n    maxLines: 100\n", "utf8");
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pass","state":"SUCCESS","name":"verify","workflow":"CI"}]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":false}}}}\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["pullRequestId=PR_kwDOScHU78000017", "convertPullRequestToDraft"],
        stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: "abc123456789", body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: '{"headRefOid":"abc123456789"}\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: '[]\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      // Rollback: a refused post must not strand the PR in draft. No POST
      // entry is given at all — an unexpected review post would consume THIS
      // entry instead, fail argument validation, and surface a different
      // error, so its presence here also proves no verdict was ever posted.
      {
        assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    // The underlying reason (the shared merge-time predicate's wording) stays intact...
    assert.match(payload.error, /requireFanoutEvidence is enabled but executionMode is "inline_single_agent"/);
    assert.match(payload.error, /inline gate verdicts are not accepted/);
    // ...and actionable guidance names the real recovery path.
    assert.match(payload.error, /reconcile-draft-gate only completes for a PR under the light-mode threshold/);
    assert.match(payload.error, /--execution-mode fanout_fanin/);
    assert.match(payload.error, /findings-log ledger/);
    // Every staged entry (including the rollback `pr ready`) was consumed —
    // proves the rollback ran and no extra/POST call happened.
    assert.equal(await readGhCallCount(tempDir), 14);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// The HIGH finding from the prior draft_gate round: reconcile-draft-gate's
// documented light-mode recovery path was UNREACHABLE because the programmatic
// upsertCheckpointVerdict call passed neither executionMode nor inlineReason,
// so the candidate marker carried inlineReason:null and evaluateInlineFanoutMode's
// light-mode acceptance clause (non-empty inlineReason) could never hold — a
// genuine 1-file/2-line micro-PR was refused too. This test proves the path is
// now reachable: a PR under the light-mode threshold (real git repo, real
// merge-base scope re-derivation, no gate:full label, lightMode enabled) is
// reconciled successfully — the inline verdict is ACCEPTED at post time.
test("reconcile-draft-gate succeeds for a light-mode under-threshold PR under active requireFanoutEvidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-reconcile-draft-gate-light-success-"));

  try {
    // Real git repo so detectMergeBaseScope's `git diff <base>...<head>` derives
    // a genuine under-threshold scope (1 file, 1 line) — not a synthetic marker.
    const g = (...args) => execFileSync("git", args, { cwd: tempDir, encoding: "utf8" });
    g("init", "-q");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    g("config", "commit.gpgsign", "false");
    await writeFile(path.join(tempDir, ".devloops"), [
      "version: 1",
      "gates:",
      "  requireFanoutEvidence: true",
      "localImplementation:",
      "  lightMode:",
      "    enabled: true",
      "    maxFiles: 3",
      "    maxLines: 200",
    ].join("\n") + "\n", "utf8");
    await writeFile(path.join(tempDir, "a.txt"), "one\n", "utf8");
    g("add", "-A");
    g("commit", "-qm", "base");
    const baseRef = g("rev-parse", "HEAD").trim();
    await writeFile(path.join(tempDir, "a.txt"), "one\ntwo\n", "utf8");
    g("add", "-A");
    g("commit", "-qm", "head");
    const headSha = g("rev-parse", "HEAD").trim();

    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: JSON.stringify({ headRefOid: headSha }) + "\n",
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["pr", "checks", "17", "--repo", "owner/repo", "--json", "bucket,state,name,workflow"],
        stdout: '[{"bucket":"pass","state":"SUCCESS","name":"verify","workflow":"CI"}]\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["owner=owner", "name=repo", "number=17", "pullRequest(number: $number)"],
        stdout: '{"data":{"repository":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":false}}}}\n',
      },
      {
        assertArgs: ["api", "graphql", "-f", "-F"],
        assertArgContains: ["pullRequestId=PR_kwDOScHU78000017", "convertPullRequestToDraft"],
        stdout: '{"data":{"convertPullRequestToDraft":{"pullRequest":{"id":"PR_kwDOScHU78000017","isDraft":true}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "number,state,isDraft,headRefOid,mergeable,mergeStateStatus,body,title,closingIssuesReferences,reviews,statusCheckRollup,files"],
        stdout: JSON.stringify({ number: 17, state: "OPEN", isDraft: true, headRefOid: headSha, body: DEFAULT_TEST_PR_BODY, closingIssuesReferences: [], reviews: [], statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }] }) + "\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/pulls/17/requested_reviewers"],
        stdout: '{"users":[],"teams":[]}\n',
      },
      {
        assertArgs: ["api", "graphql", "--field", "owner=owner", "--field", "name=repo", "--field", "pr=17"],
        assertArgContains: ["reviewThreads(first: 100, after: $after)"],
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}\n',
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
        stdout: JSON.stringify({ headRefOid: headSha }) + "\n",
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/17/comments?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/reviews?per_page=100"],
        stdout: "[]\n",
      },
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "files"],
        stdout: "src/index.ts\n",
      },
      // Post-time light-facts fetch (enforcePostTimeFanoutMode): the real base
      // commit SHA + no gate:full label, so detectMergeBaseScope re-derives the
      // under-threshold scope and the inline verdict is ACCEPTED.
      {
        assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "baseRefOid,labels"],
        stdout: JSON.stringify({ baseRefOid: baseRef, labels: [] }) + "\n",
      },
      {
        assertArgs: ["api", "-X", "POST", "repos/owner/repo/pulls/17/reviews", "--input", "-"],
        assertStdinIncludes: [
          "### Gate review: `draft_gate`",
          `**Reviewed head SHA:** \`${headSha}\``,
          "**Execution mode:** inline_single_agent",
          "**Next action:** Mark ready for review (auto-reconciled).",
        ],
        stdout: '{"id":101,"html_url":"https://github.com/owner/repo/pull/17#pullrequestreview-101"}\n',
      },
      {
        assertArgs: ["pr", "ready", "17", "--repo", "owner/repo"],
        stdout: "",
      },
    ]);

    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], { env, cwd: tempDir });

    assert.equal(result.code, 0, result.stderr);
    // stderr may carry a non-fatal git deprecation warning (e.g.
    // `core.fsyncObjectFiles is deprecated`) from detectMergeBaseScope's real
    // `git diff` under parallel load; assert no error payload leaks instead of
    // asserting strict emptiness.
    assert.ok(!/"ok"\s*:\s*false/.test(result.stderr), result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      action: "reconciled",
      repo: "owner/repo",
      pr: 17,
      headSha,
      currentHeadSha: headSha,
      commentId: 101,
      commentUrl: "https://github.com/owner/repo/pull/17#pullrequestreview-101",
    });
    // Call count is non-deterministic: the post-update comment-verification
    // re-fetch may add 0 (CI) or 2 (local under load) extra gh calls on top of
    // the 16 deterministic calls (3 initial evidence + 1 CI + 2 draft-convert +
    // 7 coordination context + 1 light-facts fetch + 1 POST + 1 ready). Assert a
    // floor so the optional verification path does not flake the test.
    assert.ok(await readGhCallCount(tempDir) >= 16, `expected >= 16 gh calls`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
