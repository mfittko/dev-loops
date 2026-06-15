import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimRunnerOwnership,
  recordExitSignalForRunner,
} from "../../scripts/loop/_pr-runner-coordination.mjs";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/github/detect-checkpoint-evidence.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, {
  ...options,
  env: {
    ...process.env,
    ...(options.env ?? {}),
    PI_SUBAGENT_RUN_ID: options.env?.PI_SUBAGENT_RUN_ID ?? "",
  },
});

async function writeGhStub(tempDir) {
  const { env } = await writeGhStubHelper(tempDir, [
    {
      assertArgs: ["pr", "view", "17", "--repo", "owner/repo", "--json", "headRefOid"],
      stdout: '{"headRefOid":"abc1234"}\n',
    },
    {
      assertArgs: ["api", "repos/owner/repo/issues/17/comments?per_page=100"],
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
        ] } } } }
      }) + "\n",
    },
  ], { repeatLastOnOverflow: true });
  return { ...env, PI_SUBAGENT_RUN_ID: "" };
}

test("detect-checkpoint-evidence fails closed when active runner is stale", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-ckpt-"));

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-stale",
      cwd: tempDir,
      now: "2000-01-01T00:00:00.000Z",
    });

    // Pretend the run is far in the past so detectStaleRunner classifies it as stale.
    const env = await writeGhStub(tempDir);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], {
      cwd: tempDir,
      env: {
        ...env,
        PI_DEV_LOOP_STALE_RUNNER_MAX_AGE_MS: "1000",
      },
    });

    assert.equal(result.code, 1, result.stderr);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "stale_runner");
    assert.equal(payload.status, "stale_runner");
    assert.ok(payload.staleRunnerCheck.failures[0].includes("stale"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence fails closed when active runner has an exit signal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-ckpt-"));

  try {
    await claimRunnerOwnership({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:00:00.000Z",
    });

    await recordExitSignalForRunner({
      repo: "owner/repo",
      pr: 17,
      runId: "run-active",
      cwd: tempDir,
      now: "2026-06-05T08:01:00.000Z",
      reason: "Fresh runner took over",
    });

    const env = await writeGhStub(tempDir);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], {
      cwd: tempDir,
      env,
    });

    assert.equal(result.code, 1, result.stderr);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "exit_signal_recorded");
    assert.equal(payload.status, "exit_signal_recorded");
    assert.ok(payload.staleRunnerCheck.failures[0].includes("exit signal"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("detect-checkpoint-evidence includes staleRunner and staleRunnerCheck in successful output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-stale-runner-ckpt-"));

  try {
    const env = await writeGhStub(tempDir);
    const result = await runNode(["--repo", "owner/repo", "--pr", "17"], {
      cwd: tempDir,
      env,
    });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.staleRunner.status, "no_owner_record");
    assert.equal(payload.staleRunnerCheck.ok, true);
    assert.deepEqual(payload.staleRunnerCheck.failures, []);
    assert.equal(payload.preMergeGateCheck.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
